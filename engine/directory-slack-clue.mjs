import { createHash } from 'node:crypto';
import { parseDirectorySlack } from './ntfs-directory-slack.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const reasons = ['폴더 인덱스의 남는 영역에서 이름 흔적을 찾았어요.', '삭제 여부·원래 경로·본문 위치는 확인하지 못했어요.'];
const fail = () => { throw Object.assign(new Error('폴더 이름 흔적의 근거가 일치하지 않아요.'), { code: 'DIR_SLACK_INVALID' }); };
const ref = value => value && Number.isSafeInteger(value.recordNumber) && value.recordNumber >= 5 && value.recordNumber <= 0xffffffffffff
  && Number.isInteger(value.sequence) && value.sequence >= 1 && value.sequence <= 65535;

function parseEvidence(evidence) {
  const freed = evidence?.kind === 'freed-allocation';
  if (evidence?.version !== (freed ? 2 : 1) || !['root', 'allocation', 'freed-allocation'].includes(evidence.kind) || !ref(evidence.directory)
    || !/^[a-f0-9]{64}$/.test(evidence.directory.fingerprint) || typeof evidence.directory.name !== 'string'
    || evidence.directory.name.length > 255 || /[\u0000-\u001f\u007f]/.test(evidence.directory.name)
    || !Number.isSafeInteger(evidence.streamOffset) || evidence.streamOffset < 0
    || !Number.isSafeInteger(evidence.expectedVcn) || evidence.expectedVcn < 0
    || !Number.isSafeInteger(evidence.entryOffset) || evidence.entryOffset < 0
    || typeof evidence.payloadBase64 !== 'string' || evidence.payloadBase64.length > 87384) fail();
  const bytes = Buffer.from(evidence.payloadBase64, 'base64');
  if (bytes.toString('base64') !== evidence.payloadBase64 || hash(bytes) !== evidence.dataSha256) fail();
  if (evidence.kind === 'root' ? evidence.streamOffset !== 0 || evidence.expectedVcn !== 0
    : evidence.streamOffset !== evidence.expectedVcn * evidence.info?.clusterSize || evidence.streamOffset % bytes.length !== 0) fail();
  if (freed) {
    const block = evidence.streamOffset / bytes.length, bitmap = evidence.indexBitmap;
    if (!Number.isSafeInteger(block) || !bitmap || bitmap.byteOffset !== Math.floor(block / 8)
      || !Number.isInteger(bitmap.value) || bitmap.value < 0 || bitmap.value > 255
      || (bitmap.value & (1 << (block % 8)))) fail();
  }
  const parsed = parseDirectorySlack({ bytes, kind: evidence.kind, directoryReference: evidence.directory,
    info: evidence.info, expectedVcn: evidence.expectedVcn });
  const entry = parsed.entries.find(item => item.offset === evidence.entryOffset);
  if (!entry) fail();
  return entry;
}

export function buildDirectorySlackClue({ bytes, kind, streamOffset = 0, expectedVcn = 0, directory, info, entryOffset, indexBitmap }) {
  const freed = kind === 'freed-allocation';
  const evidence = { version: freed ? 2 : 1, kind, streamOffset, expectedVcn, directory: { recordNumber: directory.recordNumber,
    sequence: directory.sequence, fingerprint: directory.fingerprint, name: directory.name },
    info: { clusterSize: info.clusterSize, sectorSize: info.sectorSize }, entryOffset,
    payloadBase64: bytes.toString('base64'), dataSha256: hash(bytes),
    ...(freed ? { indexBitmap: indexBitmap && { byteOffset: indexBitmap.byteOffset, value: indexBitmap.value } } : {}) };
  const entry = parseEvidence(evidence);
  return { id: `dir-slack:${directory.recordNumber}:${directory.sequence}:${kind}:${streamOffset}:${evidence.dataSha256}:${entryOffset}`,
    source: 'directory-slack', provenance: freed ? 'ntfs-index-freed-buffer' : 'ntfs-index-unused-tail', recordNumber: entry.reference.recordNumber,
    sequence: entry.reference.sequence, name: entry.name, discoveredName: entry.name,
    originalNameStatus: 'slack-name-clue', originalIdentityVerified: false, deletionConfirmed: false,
    status: 'metadata-only', storage: 'unlocated', hasContent: false, requiresPreparation: false,
    size: null, recordedSize: entry.recordedSize, modifiedAt: null, recordedModifiedAt: entry.modifiedAt,
    deletedAt: null, deletedAtSource: null, path: null, originalPath: null, pathStatus: 'unknown',
    directoryReference: { recordNumber: directory.recordNumber, sequence: directory.sequence }, directoryName: directory.name,
    restorationName: null, bodyAssociation: 'not-asserted',
    reasons: freed ? ['사용 해제된 폴더 인덱스 블록에서 이름 흔적을 찾았어요.', reasons[1]] : [...reasons], slackEvidence: evidence };
}

/** Internal consistency only; this is not authentication against coordinated proof forgery. */
export function validateDirectorySlackClue(candidate) {
  try {
    const evidence = candidate?.slackEvidence, entry = parseEvidence(evidence);
    const expected = buildDirectorySlackClue({ bytes: Buffer.from(evidence.payloadBase64, 'base64'), ...evidence });
    const expectedId = candidate.partitionId === undefined ? expected.id : `${candidate.partitionId}/${expected.id}`;
    if (candidate.partitionId !== undefined && (typeof candidate.partitionId !== 'string' || !candidate.partitionId.length
      || candidate.partitionId.length > 128 || /[\/\u0000-\u001f]/.test(candidate.partitionId))) return null;
    if (candidate.id !== expectedId) return null;
    for (const key of Object.keys(expected).filter(k => !['id', 'slackEvidence'].includes(k))) {
      if (JSON.stringify(candidate[key]) !== JSON.stringify(expected[key])) return null;
    }
    return entry;
  } catch { return null; }
}
