import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  MAX_RECYCLE_METADATA_BYTES,
  buildRecycleMetadataCandidate,
  parseRecycleMetadata,
  validateRecycleMetadataCandidate
} from '../engine/recycle-metadata.mjs';

const FILETIME_EPOCH_MILLISECONDS = 11644473600000n;
const fingerprint = digit => digit.repeat(64);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));

function filetime(value) {
  if (typeof value === 'bigint') return value;
  return (BigInt(Date.parse(value)) + FILETIME_EPOCH_MILLISECONDS) * 10000n;
}

function metadata(originalPath, originalSize = 33, recycledAt = 0n, version = 2) {
  const text = Buffer.from(`${originalPath}\0`, 'utf16le');
  const bytes = Buffer.alloc(version === 1 ? 544 : 28 + text.length);
  bytes.writeBigUInt64LE(BigInt(version), 0);
  bytes.writeBigUInt64LE(BigInt(originalSize), 8);
  bytes.writeBigUInt64LE(filetime(recycledAt), 16);
  if (version === 2) bytes.writeUInt32LE(text.length / 2, 24);
  text.copy(bytes, version === 1 ? 24 : 28);
  return bytes;
}

function attestation({ dos = true } = {}) {
  const sid = { recordNumber: 100, sequence: 7, fingerprint: fingerprint('b'), name: 'S-1-5-21-100-200-300-1001',
    parent: { recordNumber: 90, sequence: 3 } };
  const bin = { recordNumber: 90, sequence: 3, fingerprint: fingerprint('c'), name: '$Recycle.Bin',
    parent: { recordNumber: 5, sequence: 11 } };
  const root = { recordNumber: 5, sequence: 11, fingerprint: fingerprint('d'), name: '.',
    parent: { recordNumber: 5, sequence: 11 } };
  const record = { recordNumber: 42, sequence: 13, fingerprint: fingerprint('a'), name: '$IABC123.HWP',
    nameReferences: [{ name: '$IABC123.HWP', namespace: 3, parent: { recordNumber: 100, sequence: 7 } }] };
  if (dos) record.nameReferences.push({ name: '$IABC~1.HWP', namespace: 2, parent: { recordNumber: 100, sequence: 7 } });
  return { record, directoryEvidence: [sid, bin, root] };
}

function assertInvalid(run) {
  assert.throws(run, error => error?.code === 'RECYCLE_METADATA_INVALID');
}

test('parses exact v1 Korean metadata, zero FILETIME, and zero padding', () => {
  const bytes = metadata('C:\\문서\\지난 보고서.hwp', Number.MAX_SAFE_INTEGER, 0n, 1);
  assert.equal(bytes.length, 544);
  assert.deepEqual(parseRecycleMetadata(bytes), {
    version: 1,
    originalPath: 'C:\\문서\\지난 보고서.hwp',
    name: '지난 보고서.hwp',
    originalSize: Number.MAX_SAFE_INTEGER,
    recycledAt: null
  });
});

test('parses exact v2 Korean metadata at byte and FILETIME bounds', () => {
  const components = [...Array(128).fill('가'.repeat(253)), '나'.repeat(252)];
  const originalPath = `Z:\\${components.join('\\')}`;
  assert.equal(originalPath.length, 32767);
  const maximumFiletime = (FILETIME_EPOCH_MILLISECONDS + 253402300799999n) * 10000n + 9999n;
  const bytes = metadata(originalPath, Number.MAX_SAFE_INTEGER, maximumFiletime);
  assert.equal(bytes.length, MAX_RECYCLE_METADATA_BYTES);
  const parsed = parseRecycleMetadata(bytes);
  assert.equal(parsed.version, 2);
  assert.equal(parsed.originalPath, originalPath);
  assert.equal(parsed.name, '나'.repeat(252));
  assert.equal(parsed.originalSize, Number.MAX_SAFE_INTEGER);
  assert.equal(parsed.recycledAt, '9999-12-31T23:59:59.999Z');
});

test('rejects malformed versions, lengths, terminators, UTF-16, sizes, and FILETIME', () => {
  assertInvalid(() => parseRecycleMetadata(Buffer.alloc(27)));
  const unsupported = metadata('C:\\a.txt'); unsupported.writeBigUInt64LE(3n, 0);
  assertInvalid(() => parseRecycleMetadata(unsupported));
  assertInvalid(() => parseRecycleMetadata(metadata('C:\\a.txt', 1, 0n, 1).subarray(0, 543)));

  const lengthMismatch = metadata('C:\\a.txt'); lengthMismatch.writeUInt32LE(200, 24);
  assertInvalid(() => parseRecycleMetadata(lengthMismatch));
  assertInvalid(() => parseRecycleMetadata(Buffer.concat([metadata('C:\\a.txt'), Buffer.alloc(2)])));
  const missingTerminator = metadata('C:\\a.txt'); missingTerminator.writeUInt16LE(0x41, missingTerminator.length - 2);
  assertInvalid(() => parseRecycleMetadata(missingTerminator));
  assertInvalid(() => parseRecycleMetadata(metadata('C:\\a\0b.txt')));

  const badPadding = metadata('C:\\a.txt', 1, 0n, 1); badPadding[543] = 1;
  assertInvalid(() => parseRecycleMetadata(badPadding));
  const unpaired = metadata('C:\\a.txt'); unpaired.writeUInt16LE(0xd800, 28 + 3 * 2);
  assertInvalid(() => parseRecycleMetadata(unpaired));

  const hugeSize = metadata('C:\\a.txt'); hugeSize.writeBigUInt64LE(BigInt(Number.MAX_SAFE_INTEGER) + 1n, 8);
  assertInvalid(() => parseRecycleMetadata(hugeSize));
  const hugeTime = metadata('C:\\a.txt'); hugeTime.writeBigUInt64LE(0xffffffffffffffffn, 16);
  assertInvalid(() => parseRecycleMetadata(hugeTime));
});

test('rejects unsafe Windows paths, components, ADS, traversal, and reserved leaves', () => {
  const unsafe = [
    '\\\\server\\share\\a.txt',
    '\\\\?\\C:\\a.txt',
    'C:/folder/a.txt',
    'C:\\folder\\..\\a.txt',
    'C:\\folder\\.\\a.txt',
    'C:\\folder\\\\a.txt',
    'C:\\folder\\a.txt:secret',
    'C:\\folder\\CON.txt',
    'C:\\folder\\a.txt.',
    'C:\\folder\\a.txt ',
    'C:\\'
  ];
  for (const originalPath of unsafe) assertInvalid(() => parseRecycleMetadata(metadata(originalPath)));
});

test('builds and validates a self-contained metadata-only candidate with a DOS companion', () => {
  const bytes = metadata('D:\\과거 위치\\기술 동향.hwp', 98765, '2026-09-26T01:02:03.456Z');
  const proof = attestation();
  const candidate = buildRecycleMetadataCandidate({ ...proof, bytes });
  const hash = sha256(bytes);
  assert.equal(candidate.id, `recycle-info:42:13:${hash}`);
  assert.equal(candidate.source, 'recycle-metadata');
  assert.equal(candidate.provenance, 'deleted-recycle-info');
  assert.equal(candidate.name, '기술 동향.hwp');
  assert.equal(candidate.discoveredName, '$IABC123.HWP');
  assert.equal(candidate.recordedSize, 98765);
  assert.equal(candidate.size, null);
  assert.equal(candidate.path, null);
  assert.equal(candidate.hasContent, false);
  assert.equal(candidate.requiresPreparation, false);
  assert.equal(candidate.originalIdentityVerified, false);
  assert.equal(candidate.bodyAssociation, 'not-asserted');
  assert.equal(candidate.metadataEvidence.record.byteLength, bytes.length);
  assert.equal(candidate.metadataEvidence.payloadBase64, bytes.toString('base64'));
  assert.deepEqual(validateRecycleMetadataCandidate(candidate), parseRecycleMetadata(bytes));
});

test('builder rejects ambiguous aliases, generations, fingerprints, and name references', () => {
  const bytes = metadata('C:\\문서\\a.txt');
  const cases = [];
  {
    const proof = attestation(); proof.record.name = '$IABCDE.txt'; cases.push(proof);
  }
  {
    const proof = attestation(); proof.record.sequence = 1; cases.push(proof);
  }
  {
    const proof = attestation(); proof.record.fingerprint = 'g'.repeat(64); cases.push(proof);
  }
  {
    const proof = attestation(); proof.record.nameReferences[0].namespace = 0; cases.push(proof);
  }
  {
    const proof = attestation(); proof.record.nameReferences.push({ name: '$IOTHER1.HWP', namespace: 1,
      parent: { recordNumber: 100, sequence: 7 } }); cases.push(proof);
  }
  {
    const proof = attestation(); proof.record.nameReferences[1].parent.sequence = 8; cases.push(proof);
  }
  for (const proof of cases) assertInvalid(() => buildRecycleMetadataCandidate({ ...proof, bytes }));
});

test('builder requires the exact SID to Recycle.Bin to root structural chain', () => {
  const bytes = metadata('C:\\문서\\a.txt');
  const mutators = [
    proof => { proof.directoryEvidence[0].name = 'not-a-sid'; },
    proof => { proof.directoryEvidence[1].name = '$Other.Bin'; },
    proof => { proof.directoryEvidence[2].recordNumber = 6; proof.directoryEvidence[2].parent.recordNumber = 6; },
    proof => { proof.record.nameReferences[0].parent.sequence = 8; },
    proof => { proof.record.nameReferences[1].parent.sequence = 8; },
    proof => { proof.directoryEvidence[0].parent.recordNumber = 91; },
    proof => { proof.directoryEvidence[1].parent.sequence = 12; },
    proof => { proof.directoryEvidence[2].parent.sequence = 12; }
  ];
  for (const mutate of mutators) {
    const proof = attestation(); mutate(proof);
    assertInvalid(() => buildRecycleMetadataCandidate({ ...proof, bytes }));
  }
});

test('persisted validation rejects noncanonical base64, hash, id, proof, and payload mutations without throwing', () => {
  const bytes = metadata('C:\\문서\\검증.txt', 33, '2026-09-26T00:00:00Z');
  const candidate = buildRecycleMetadataCandidate({ ...attestation(), bytes });
  const mutations = [
    value => { value.metadataEvidence.payloadBase64 += '='; },
    value => { value.metadataEvidence.dataSha256 = fingerprint('e'); },
    value => { value.id += 'x'; },
    value => { value.metadataEvidence.record.byteLength += 2; },
    value => { value.metadataEvidence.record.parent.sequence += 1; },
    value => { value.metadataEvidence.directoryEvidence[0].parent.sequence += 1; },
    value => { value.nameReferences[0].parent.sequence += 1; }
  ];
  for (const mutate of mutations) {
    const value = clone(candidate); mutate(value);
    assert.equal(validateRecycleMetadataCandidate(value), null);
  }
  assert.equal(validateRecycleMetadataCandidate(null), null);
  assert.equal(validateRecycleMetadataCandidate({ metadataEvidence: { payloadBase64: 4 } }), null);

  const changedPayload = clone(candidate);
  const changedBytes = Buffer.from(changedPayload.metadataEvidence.payloadBase64, 'base64');
  changedBytes.writeBigUInt64LE(34n, 8);
  changedPayload.metadataEvidence.payloadBase64 = changedBytes.toString('base64');
  changedPayload.metadataEvidence.dataSha256 = sha256(changedBytes);
  changedPayload.id = `recycle-info:42:13:${changedPayload.metadataEvidence.dataSha256}`;
  assert.equal(validateRecycleMetadataCandidate(changedPayload), null);
});

test('persisted validation cross-checks every metadata and body guard field and accepts a bound partition id', () => {
  const bytes = metadata('E:\\문서\\보존.txt', 100, '2026-09-26T00:00:00Z');
  const candidate = buildRecycleMetadataCandidate({ ...attestation({ dos: false }), bytes });
  const mutations = [
    value => { value.source = 'recycle-bin'; },
    value => { value.provenance = 'other'; },
    value => { value.recordNumber += 1; },
    value => { value.sequence += 1; },
    value => { value.fingerprint = fingerprint('e'); },
    value => { value.name = 'changed.txt'; },
    value => { value.discoveredName = '$IOTHER1.HWP'; },
    value => { value.originalNameStatus = 'verified'; },
    value => { value.size = 100; },
    value => { value.recordedSize = 101; },
    value => { value.originalPath = 'F:\\other.txt'; },
    value => { value.path = 'E:\\$Recycle.Bin\\$RABC123.HWP'; },
    value => { value.pathStatus = 'located'; },
    value => { value.recycledAt = null; },
    value => { value.deletedAt = value.recycledAt; },
    value => { value.deletedAtSource = 'recycle-metadata'; },
    value => { value.status = 'readable'; },
    value => { value.storage = 'allocated'; },
    value => { value.hasContent = true; },
    value => { value.requiresPreparation = true; },
    value => { value.originalIdentityVerified = true; },
    value => { value.restorationName = value.name; },
    value => { value.bodyAssociation = 'same-alias'; },
    value => { value.discoverySources.push('recycle-bin'); },
    value => { value.reasons[0] = '본문을 찾았어요.'; }
  ];
  for (const mutate of mutations) {
    const value = clone(candidate); mutate(value);
    assert.equal(validateRecycleMetadataCandidate(value), null);
  }
  const decorated = { ...candidate, id: `partition-1/${candidate.id}`, partitionId: 'partition-1' };
  assert.deepEqual(validateRecycleMetadataCandidate(decorated), parseRecycleMetadata(bytes));
  assert.equal(validateRecycleMetadataCandidate({ ...decorated, partitionId: 'partition-2' }), null);
});

test('a matching $R alias supplied beside the record never authorizes or locates a body', () => {
  const bytes = metadata('C:\\문서\\본문 없음.hwp', 777);
  const proof = attestation();
  proof.record.sameAliasPayload = { name: '$RABC123.HWP', size: 777, path: 'C:\\$Recycle.Bin\\$RABC123.HWP' };
  const candidate = buildRecycleMetadataCandidate({ ...proof, bytes });
  assert.equal(candidate.discoveredName, '$IABC123.HWP');
  assert.equal(candidate.path, null);
  assert.equal(candidate.size, null);
  assert.equal(candidate.hasContent, false);
  assert.equal(candidate.storage, 'unlocated');
  assert.equal(candidate.bodyAssociation, 'not-asserted');
  assert.ok(!JSON.stringify(candidate).includes('$RABC123'));
  assert.deepEqual(validateRecycleMetadataCandidate(candidate), parseRecycleMetadata(bytes));
});
