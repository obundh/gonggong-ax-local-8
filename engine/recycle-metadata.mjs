import { createHash } from 'node:crypto';

export const MAX_RECYCLE_METADATA_BYTES = 65564;

const MAX_RECORD_NUMBER = 0xffffffffffff;
const MAX_SEQUENCE = 0xffff;
const FILETIME_EPOCH_MILLISECONDS = 11644473600000n;
const MAX_FILETIME_MILLISECONDS = 253402300799999n;
const SID = /^S-1-(?:\d+-){1,14}\d+$/;
const FINGERPRINT = /^[0-9a-f]{64}$/i;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const REASONS = Object.freeze([
  '삭제된 휴지통 정보에서 원래 이름과 경로만 확인했어요.',
  '원본 본문의 위치나 연결은 확인하지 않았어요.'
]);

function invalid(message = '휴지통 메타데이터가 올바르지 않아요.') {
  throw Object.assign(new Error(message), { code: 'RECYCLE_METADATA_INVALID' });
}

function requireValue(condition, message) {
  if (!condition) invalid(message);
}

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, keys) {
  return plainObject(value) && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
}

function validReference(value, minimumSequence = 1) {
  return exactKeys(value, ['recordNumber', 'sequence'])
    && Number.isSafeInteger(value.recordNumber) && value.recordNumber >= 0 && value.recordNumber <= MAX_RECORD_NUMBER
    && Number.isInteger(value.sequence) && value.sequence >= minimumSequence && value.sequence <= MAX_SEQUENCE;
}

function sameReference(left, right) {
  return plainObject(left) && plainObject(right)
    && Number.isSafeInteger(left.recordNumber) && left.recordNumber >= 0 && left.recordNumber <= MAX_RECORD_NUMBER
    && Number.isSafeInteger(right.recordNumber) && right.recordNumber >= 0 && right.recordNumber <= MAX_RECORD_NUMBER
    && Number.isInteger(left.sequence) && left.sequence >= 1 && left.sequence <= MAX_SEQUENCE
    && Number.isInteger(right.sequence) && right.sequence >= 1 && right.sequence <= MAX_SEQUENCE
    && left.recordNumber === right.recordNumber && left.sequence === right.sequence;
}

function safeWindowsLeaf(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 255 || value !== value.normalize('NFC')) return false;
  if (value === '.' || value === '..' || /[<>:"/\\|?*\u0000-\u001f\u007f]/.test(value) || /[. ]$/.test(value)) return false;
  return !/^(con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\.|$)/i.test(value);
}

function recycleInfoAlias(value) {
  return safeWindowsLeaf(value) && /^\$I[A-Z0-9]{6}(?:\.[^.]+)?$/i.test(value);
}

function wellFormedUtf16(bytes, start, units) {
  for (let index = 0; index < units; index++) {
    const unit = bytes.readUInt16LE(start + index * 2);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (++index >= units) return false;
      const low = bytes.readUInt16LE(start + index * 2);
      if (low < 0xdc00 || low > 0xdfff) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

function safeDrivePath(value) {
  if (typeof value !== 'string' || !/^[A-Za-z]:\\/.test(value) || value.includes('/')) return false;
  const components = value.slice(3).split('\\');
  return components.length > 0 && components.every(safeWindowsLeaf);
}

function recycledAtFromFiletime(ticks) {
  if (ticks === 0n) return null;
  const milliseconds = ticks / 10000n - FILETIME_EPOCH_MILLISECONDS;
  requireValue(milliseconds >= -FILETIME_EPOCH_MILLISECONDS && milliseconds <= MAX_FILETIME_MILLISECONDS,
    '휴지통 삭제 시각이 지원 범위를 벗어났어요.');
  try { return new Date(Number(milliseconds)).toISOString(); }
  catch { invalid('휴지통 삭제 시각이 올바르지 않아요.'); }
}

/**
 * Parse one already-bounded Windows $I payload. This function establishes only
 * what the payload says; it does not locate or associate an $R body.
 */
export function parseRecycleMetadata(bytes) {
  requireValue(Buffer.isBuffer(bytes), '휴지통 메타데이터는 Buffer여야 해요.');
  requireValue(bytes.length >= 28 && bytes.length <= MAX_RECYCLE_METADATA_BYTES,
    '휴지통 메타데이터 크기가 잘못됐어요.');

  const rawVersion = bytes.readBigUInt64LE(0);
  let version, start, units, terminator;
  if (rawVersion === 1n) {
    requireValue(bytes.length === 544, '휴지통 v1 메타데이터 길이가 잘못됐어요.');
    version = 1; start = 24; units = 260;
    terminator = -1;
    for (let index = 0; index < units; index++) {
      if (bytes.readUInt16LE(start + index * 2) === 0) { terminator = index; break; }
    }
    requireValue(terminator > 0, '휴지통 원래 경로의 끝이 없어요.');
    for (let index = terminator + 1; index < units; index++) {
      requireValue(bytes.readUInt16LE(start + index * 2) === 0, '휴지통 v1 경로 뒤 채움 영역이 올바르지 않아요.');
    }
  } else if (rawVersion === 2n) {
    version = 2; start = 28;
    units = bytes.readUInt32LE(24);
    requireValue(units >= 2 && units <= 32768 && bytes.length === start + units * 2,
      '휴지통 v2 원래 경로 길이가 잘못됐어요.');
    terminator = units - 1;
    requireValue(bytes.readUInt16LE(start + terminator * 2) === 0, '휴지통 원래 경로의 끝이 없어요.');
    for (let index = 0; index < terminator; index++) {
      requireValue(bytes.readUInt16LE(start + index * 2) !== 0, '휴지통 원래 경로에 중간 종료 문자가 있어요.');
    }
  } else {
    invalid('지원하지 않는 휴지통 메타데이터 버전이에요.');
  }

  requireValue(wellFormedUtf16(bytes, start, terminator), '휴지통 원래 경로의 UTF-16 인코딩이 잘못됐어요.');
  const originalPath = bytes.subarray(start, start + terminator * 2).toString('utf16le');
  requireValue(safeDrivePath(originalPath), '휴지통 원래 경로가 안전한 절대 Windows 경로가 아니에요.');
  const name = originalPath.slice(originalPath.lastIndexOf('\\') + 1);

  const rawSize = bytes.readBigUInt64LE(8);
  requireValue(rawSize <= BigInt(Number.MAX_SAFE_INTEGER), '휴지통 원래 파일 크기가 지원 범위를 벗어났어요.');
  const recycledAt = recycledAtFromFiletime(bytes.readBigUInt64LE(16));
  return { version, originalPath, name, originalSize: Number(rawSize), recycledAt };
}

function validateNameReferences(record) {
  if (!Array.isArray(record?.nameReferences) || record.nameReferences.length < 1 || record.nameReferences.length > 2) return null;
  const references = record.nameReferences;
  if (!references.every(reference => exactKeys(reference, ['name', 'namespace', 'parent'])
    && safeWindowsLeaf(reference.name) && Number.isInteger(reference.namespace) && validReference(reference.parent))) return null;
  const canonical = references.filter(reference => reference.name === record.name && (reference.namespace === 1 || reference.namespace === 3));
  if (canonical.length !== 1 || !recycleInfoAlias(record.name)) return null;
  const selected = canonical[0];
  for (const reference of references) {
    if (reference === selected) continue;
    if (reference.namespace !== 2 || !sameReference(reference.parent, selected.parent)
      || reference.name.toLocaleLowerCase('en-US') === selected.name.toLocaleLowerCase('en-US')) return null;
  }
  return selected;
}

function validDirectoryEntry(value) {
  return exactKeys(value, ['recordNumber', 'sequence', 'fingerprint', 'name', 'parent'])
    && Number.isSafeInteger(value.recordNumber) && value.recordNumber >= 0 && value.recordNumber <= MAX_RECORD_NUMBER
    && Number.isInteger(value.sequence) && value.sequence >= 1 && value.sequence <= MAX_SEQUENCE
    && FINGERPRINT.test(value.fingerprint) && typeof value.name === 'string' && validReference(value.parent);
}

function validateDirectoryChain(record, directoryEvidence) {
  if (!Array.isArray(directoryEvidence) || directoryEvidence.length !== 3) return false;
  const [sidDirectory, binDirectory, rootDirectory] = directoryEvidence;
  if (!validDirectoryEntry(sidDirectory) || !validDirectoryEntry(binDirectory) || !validDirectoryEntry(rootDirectory)) return false;
  if (sidDirectory.recordNumber < 16 || binDirectory.recordNumber < 16
    || new Set([record.recordNumber, sidDirectory.recordNumber, binDirectory.recordNumber, rootDirectory.recordNumber]).size !== 4) return false;
  if (!SID.test(sidDirectory.name) || !/^\$Recycle\.Bin$/i.test(binDirectory.name)) return false;
  if (rootDirectory.recordNumber !== 5 || rootDirectory.name !== '.'
    || !sameReference(rootDirectory.parent, { recordNumber: 5, sequence: rootDirectory.sequence })) return false;
  return sameReference(record.parent, sidDirectory)
    && sameReference(sidDirectory.parent, binDirectory)
    && sameReference(binDirectory.parent, rootDirectory);
}

function normalizeAttestation(record, directoryEvidence) {
  requireValue(plainObject(record)
    && Number.isSafeInteger(record.recordNumber) && record.recordNumber >= 16 && record.recordNumber <= MAX_RECORD_NUMBER
    && Number.isInteger(record.sequence) && record.sequence >= 2 && record.sequence <= MAX_SEQUENCE
    && FINGERPRINT.test(record.fingerprint), '삭제된 휴지통 정보 기록의 식별 증명이 잘못됐어요.');
  const canonical = validateNameReferences(record);
  requireValue(canonical, '삭제된 휴지통 정보 기록의 이름 증명이 모호해요.');
  const normalizedRecord = {
    recordNumber: record.recordNumber,
    sequence: record.sequence,
    fingerprint: record.fingerprint,
    name: record.name,
    parent: { recordNumber: canonical.parent.recordNumber, sequence: canonical.parent.sequence }
  };
  requireValue(validateDirectoryChain(normalizedRecord, directoryEvidence), '휴지통 디렉터리 증명 연결이 잘못됐어요.');
  return { record: normalizedRecord,
    nameReferences: record.nameReferences.map(reference => ({ name: reference.name, namespace: reference.namespace,
      parent: { recordNumber: reference.parent.recordNumber, sequence: reference.parent.sequence } })),
    directoryEvidence: directoryEvidence.map(entry => ({ recordNumber: entry.recordNumber, sequence: entry.sequence,
      fingerprint: entry.fingerprint, name: entry.name,
      parent: { recordNumber: entry.parent.recordNumber, sequence: entry.parent.sequence } })) };
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function buildRecycleMetadataCandidate(input = {}) {
  requireValue(plainObject(input), '삭제된 휴지통 정보 후보 입력이 잘못됐어요.');
  const { record, bytes, directoryEvidence } = input;
  const parsed = parseRecycleMetadata(bytes);
  const proof = normalizeAttestation(record, directoryEvidence);
  const dataSha256 = digest(bytes);
  const rawId = `recycle-info:${proof.record.recordNumber}:${proof.record.sequence}:${dataSha256}`;
  return {
    id: rawId,
    source: 'recycle-metadata',
    provenance: 'deleted-recycle-info',
    recordNumber: proof.record.recordNumber,
    sequence: proof.record.sequence,
    fingerprint: proof.record.fingerprint,
    name: parsed.name,
    discoveredName: proof.record.name,
    nameReferences: proof.nameReferences,
    originalNameStatus: 'metadata-only-name',
    size: null,
    recordedSize: parsed.originalSize,
    originalPath: parsed.originalPath,
    path: null,
    pathStatus: 'metadata-only',
    recycledAt: parsed.recycledAt,
    deletedAt: null,
    deletedAtSource: null,
    status: 'metadata-only',
    storage: 'unlocated',
    hasContent: false,
    requiresPreparation: false,
    originalIdentityVerified: false,
    restorationName: null,
    bodyAssociation: 'not-asserted',
    discoverySources: ['deleted-recycle-info'],
    reasons: [...REASONS],
    metadataEvidence: {
      version: 1,
      record: { ...proof.record, parent: { ...proof.record.parent }, byteLength: bytes.length },
      directoryEvidence: proof.directoryEvidence,
      payloadBase64: bytes.toString('base64'),
      dataSha256
    }
  };
}

function sameNameReferences(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => {
    const other = right[index];
    return exactKeys(item, ['name', 'namespace', 'parent']) && exactKeys(other, ['name', 'namespace', 'parent'])
      && item.name === other.name && item.namespace === other.namespace && sameReference(item.parent, other.parent);
  });
}

function sameDirectoryEvidence(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => {
    const other = right[index];
    return validDirectoryEntry(item) && validDirectoryEntry(other)
      && item.recordNumber === other.recordNumber && item.sequence === other.sequence
      && item.fingerprint === other.fingerprint && item.name === other.name && sameReference(item.parent, other.parent);
  });
}

function canonicalBase64(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4 * Math.ceil(MAX_RECYCLE_METADATA_BYTES / 3)
    || value.length % 4 !== 0 || !BASE64.test(value)) return null;
  const bytes = Buffer.from(value, 'base64');
  return bytes.length <= MAX_RECYCLE_METADATA_BYTES && bytes.toString('base64') === value ? bytes : null;
}

function expectedCandidateId(candidate, rawId) {
  if (candidate.id === rawId) return candidate.partitionId === undefined;
  return typeof candidate.partitionId === 'string' && candidate.partitionId.length > 0 && candidate.partitionId.length <= 128
    && !/[\/\u0000-\u001f\u007f]/.test(candidate.partitionId) && candidate.id === `${candidate.partitionId}/${rawId}`;
}

/**
 * Re-check a persisted metadata-only candidate. This detects accidental or
 * partial changes; it is not authentication against coordinated proof edits.
 */
export function validateRecycleMetadataCandidate(candidate) {
  try {
    if (!plainObject(candidate) || !exactKeys(candidate.metadataEvidence,
      ['version', 'record', 'directoryEvidence', 'payloadBase64', 'dataSha256'])) return null;
    const evidence = candidate.metadataEvidence;
    if (evidence.version !== 1 || !FINGERPRINT.test(evidence.dataSha256)) return null;
    const bytes = canonicalBase64(evidence.payloadBase64);
    if (!bytes || digest(bytes) !== evidence.dataSha256) return null;
    const parsed = parseRecycleMetadata(bytes);

    if (!exactKeys(evidence.record, ['recordNumber', 'sequence', 'fingerprint', 'name', 'parent', 'byteLength'])
      || evidence.record.byteLength !== bytes.length) return null;
    const record = { recordNumber: evidence.record.recordNumber, sequence: evidence.record.sequence,
      fingerprint: evidence.record.fingerprint, name: evidence.record.name,
      nameReferences: candidate.nameReferences };
    const proof = normalizeAttestation(record, evidence.directoryEvidence);
    if (!sameReference(proof.record.parent, evidence.record.parent)
      || !sameNameReferences(proof.nameReferences, candidate.nameReferences)
      || !sameDirectoryEvidence(proof.directoryEvidence, evidence.directoryEvidence)) return null;

    const rawId = `recycle-info:${proof.record.recordNumber}:${proof.record.sequence}:${evidence.dataSha256}`;
    if (!expectedCandidateId(candidate, rawId)
      || candidate.source !== 'recycle-metadata' || candidate.provenance !== 'deleted-recycle-info'
      || candidate.recordNumber !== proof.record.recordNumber || candidate.sequence !== proof.record.sequence
      || candidate.fingerprint !== proof.record.fingerprint || candidate.name !== parsed.name
      || candidate.discoveredName !== proof.record.name || candidate.originalNameStatus !== 'metadata-only-name'
      || candidate.size !== null || candidate.recordedSize !== parsed.originalSize
      || candidate.originalPath !== parsed.originalPath || candidate.path !== null || candidate.pathStatus !== 'metadata-only'
      || candidate.recycledAt !== parsed.recycledAt || candidate.deletedAt !== null || candidate.deletedAtSource !== null
      || candidate.status !== 'metadata-only' || candidate.storage !== 'unlocated' || candidate.hasContent !== false
      || candidate.requiresPreparation !== false || candidate.originalIdentityVerified !== false
      || candidate.restorationName !== null || candidate.bodyAssociation !== 'not-asserted'
      || !Array.isArray(candidate.discoverySources) || candidate.discoverySources.length !== 1
      || candidate.discoverySources[0] !== 'deleted-recycle-info'
      || !Array.isArray(candidate.reasons) || candidate.reasons.length !== REASONS.length
      || !candidate.reasons.every((reason, index) => reason === REASONS[index])) return null;
    return parsed;
  } catch {
    return null;
  }
}
