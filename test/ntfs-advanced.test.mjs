import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createFixture, fixtureGeometry as geometry } from './ntfs-fixtures.mjs';
import { openNtfsImage, openNtfsProvider } from '../engine/ntfs-image.mjs';

function recordOffset(number) { return geometry.mftLcn * geometry.clusterSize + number * geometry.fileRecordSize; }
function attributeOffset(bytes, number, type) {
  const begin = recordOffset(number); let offset = begin + bytes.readUInt16LE(begin + 20);
  while (offset + 8 <= begin + geometry.fileRecordSize) {
    const found = bytes.readUInt32LE(offset); assert.notEqual(found, 0xffffffff, 'fixture attribute must exist');
    if (found === type) return offset;
    const length = bytes.readUInt32LE(offset + 4); assert.ok(length >= 24); offset += length;
  }
  assert.fail('fixture attribute not found');
}
function markSparseStandardInformation(bytes, recordNumber) {
  const standard = attributeOffset(bytes, recordNumber, 0x10), value = standard + bytes.readUInt16LE(standard + 20);
  bytes.writeUInt32LE(bytes.readUInt32LE(value + 32) | 0x200, value + 32);
}
function setStandardInformationFlag(bytes, recordNumber, flag) {
  const standard = attributeOffset(bytes, recordNumber, 0x10), value = standard + bytes.readUInt16LE(standard + 20);
  bytes.writeUInt32LE(bytes.readUInt32LE(value + 32) | flag, value + 32);
}
function repeatedACompressionUnit() {
  const chunk = Buffer.from([0x03, 0xb0, 0x02, 0x41, 0xfc, 0x0f]);
  return Buffer.concat([...Array(16).fill(chunk), Buffer.alloc(2)]);
}
function makeCompressedUnit(bytes, { malformedRuns = false, malformedPayload = false, wrongCompressedSize = false } = {}) {
  setStandardInformationFlag(bytes, 37, 0x800);
  const data = attributeOffset(bytes, 37, 0x80), length = bytes.readUInt32LE(data + 4);
  bytes.writeUInt16LE(0x0001, data + 12);
  bytes.writeBigUInt64LE(0n, data + 16);
  bytes.writeBigUInt64LE(15n, data + 24);
  bytes.writeUInt16LE(72, data + 32);
  bytes.writeUInt16LE(4, data + 34);
  bytes.writeBigUInt64LE(65536n, data + 40);
  bytes.writeBigUInt64LE(65536n, data + 48);
  bytes.writeBigUInt64LE(65536n, data + 56);
  bytes.writeBigUInt64LE(BigInt(wrongCompressedSize ? 2 * geometry.clusterSize : geometry.clusterSize), data + 64);
  bytes.fill(0, data + 72, data + length);
  Buffer.from(malformedRuns
    ? [0x01, 0x01, 0x11, 0x0f, 0x32, 0x00]
    : [0x11, 0x01, 0x32, 0x01, 0x0f, 0x00]).copy(bytes, data + 72);
  bytes.fill(0, 50 * geometry.clusterSize, 51 * geometry.clusterSize);
  const compressed = repeatedACompressionUnit();
  compressed.copy(bytes, 50 * geometry.clusterSize);
  if (malformedPayload) bytes[50 * geometry.clusterSize + 4] = 0xff;
  return Buffer.alloc(65536, 0x41);
}
function makeRawCompressionUnit(bytes) {
  const expected = Buffer.alloc(65536);
  for (let index = 0; index < expected.length; index += 1) expected[index] = (index * 37 + 11) & 0xff;
  makeCompressedUnit(bytes);
  const data = attributeOffset(bytes, 37, 0x80), length = bytes.readUInt32LE(data + 4);
  bytes.writeBigUInt64LE(65536n, data + 40);
  bytes.writeBigUInt64LE(65536n, data + 64);
  bytes.fill(0, data + 72, data + length);
  Buffer.from([0x11, 0x10, 0x32, 0x00]).copy(bytes, data + 72);
  expected.copy(bytes, 50 * geometry.clusterSize);
  return expected;
}
function makeMixedSparse(bytes, recordNumber = 37) {
  markSparseStandardInformation(bytes, recordNumber);
  const data = attributeOffset(bytes, recordNumber, 0x80), length = bytes.readUInt32LE(data + 4); assert.ok(length >= 80);
  bytes.writeUInt16LE(0x8000, data + 12); bytes.writeBigUInt64LE(0n, data + 16); bytes.writeBigUInt64LE(2n, data + 24);
  bytes.writeUInt16LE(64, data + 32); bytes.writeUInt16LE(0, data + 34); bytes.writeBigUInt64LE(BigInt(2 * geometry.clusterSize), data + 40);
  bytes.writeBigUInt64LE(BigInt(3 * geometry.clusterSize), data + 48); bytes.writeBigUInt64LE(BigInt(2 * geometry.clusterSize + 100), data + 56);
  bytes.fill(0, data + 64, data + length);
  // physical LCN 50, one sparse cluster, physical LCN 51 (relative +1), then terminator.
  Buffer.from([0x11, 0x01, 0x32, 0x01, 0x01, 0x11, 0x01, 0x01, 0x00]).copy(bytes, data + 64);
  bytes.fill(0x41, 50 * geometry.clusterSize, 51 * geometry.clusterSize);
  bytes.fill(0x42, 51 * geometry.clusterSize, 51 * geometry.clusterSize + 100);
  bytes.fill(0x7f, 51 * geometry.clusterSize + 100, 52 * geometry.clusterSize);
  return Buffer.concat([Buffer.alloc(geometry.clusterSize, 0x41), Buffer.alloc(geometry.clusterSize), Buffer.alloc(100, 0x42), Buffer.alloc(geometry.clusterSize - 100)]);
}
async function isolated(callback) {
  const base = path.resolve(os.tmpdir()), root = await mkdtemp(path.join(base, 'recoverychat-ntfs-advanced-'));
  try { await callback(root); } finally { const relative = path.relative(base, root); assert.ok(relative.startsWith('recoverychat-ntfs-advanced-') && !relative.includes(path.sep)); await rm(root, { recursive: true, force: true }); }
}

test('a metadata-consistent pure sparse file is recovered as deterministic zero bytes', async () => isolated(async root => {
  const fixture = await createFixture(path.join(root, 'fixture')), bytes = await readFile(fixture.imagePath); markSparseStandardInformation(bytes, 38);
  const imagePath = path.join(root, 'sparse.img'); await writeFile(imagePath, bytes); const image = await openNtfsImage(imagePath);
  try {
    const scan = await image.scanDeleted(), candidate = scan.candidates.find(item => item.recordNumber === 38);
    assert.equal(candidate.status, 'readable'); assert.equal(candidate.storage, 'sparse'); assert.ok(candidate.reasons.some(reason => reason.includes('희소')));
    const saved = await image.recover(38, path.join(root, 'output')), recovered = await readFile(saved.path);
    assert.deepEqual(recovered, Buffer.alloc(geometry.clusterSize)); assert.equal(saved.sha256, createHash('sha256').update(recovered).digest('hex'));
  } finally { await image.close(); }
}));

test('mixed physical and sparse runs plus an uninitialized tail preserve data and zero only declared regions', async () => isolated(async root => {
  const fixture = await createFixture(path.join(root, 'fixture')), bytes = await readFile(fixture.imagePath), expected = makeMixedSparse(bytes);
  const imagePath = path.join(root, 'mixed-sparse.img'); await writeFile(imagePath, bytes); const image = await openNtfsImage(imagePath);
  try {
    const scan = await image.scanDeleted(), candidate = scan.candidates.find(item => item.recordNumber === 37);
    assert.equal(candidate.status, 'readable'); assert.equal(candidate.storage, 'sparse'); assert.equal(candidate.size, expected.length);
    assert.ok(candidate.reasons.some(reason => reason.includes('초기화되지 않은')));
    const saved = await image.recover(37, path.join(root, 'output')), recovered = await readFile(saved.path);
    assert.deepEqual(recovered, expected); assert.equal(saved.sha256, createHash('sha256').update(expected).digest('hex'));
    assert.equal(saved.originalIdentityVerified, false);
  } finally { await image.close(); }
}));

test('sparse run flags, allocated size, and virtual run bounds must agree', async () => isolated(async root => {
  const fixture = await createFixture(path.join(root, 'fixture')), base = await readFile(fixture.imagePath);
  for (const [label, mutate] of [
    ['missing-file-flag', bytes => markSparseStandardInformation(bytes, 38)],
    ['wrong-allocated-size', bytes => { makeMixedSparse(bytes); const data = attributeOffset(bytes, 37, 0x80); bytes.writeBigUInt64LE(BigInt(3 * geometry.clusterSize), data + 40); }],
    ['invalid-run-range', bytes => { makeMixedSparse(bytes); const data = attributeOffset(bytes, 37, 0x80); bytes[data + 66] = 0xff; }]
  ]) {
    const bytes = Buffer.from(base); if (label === 'missing-file-flag') { /* base record 38 has sparse data but lacks FILE_ATTRIBUTE_SPARSE_FILE */ } else mutate(bytes);
    const imagePath = path.join(root, `${label}.img`); await writeFile(imagePath, bytes); const image = await openNtfsImage(imagePath);
    try {
      const recordNumber = label === 'missing-file-flag' ? 38 : 37, candidate = (await image.scanDeleted()).candidates.find(item => item.recordNumber === recordNumber);
      assert.notEqual(candidate.status, 'readable'); await assert.rejects(image.recover(recordNumber, path.join(root, `out-${label}`)), { code: 'NOT_RECOVERABLE' });
    } finally { await image.close(); }
  }
}));

test('fresh allocation metadata blocks recovery when a physical sparse run is reallocated after scan', async () => isolated(async root => {
  const fixture = await createFixture(path.join(root, 'fixture')), bytes = await readFile(fixture.imagePath); makeMixedSparse(bytes);
  class MutableProvider {
    constructor(data) { this.bytes = data; this.info = { size: data.length, sectorSize: 512, sourceKind: 'synthetic-live', identity: 'stable-device-fixture' }; }
    async read(offset, length) { return Buffer.from(this.bytes.subarray(offset, offset + length)); }
    async assertUnchanged() {}
    async close() {}
  }
  const provider = new MutableProvider(bytes), image = await openNtfsProvider(provider);
  try {
    const scan = await image.scanDeleted(); assert.equal(scan.candidates.find(item => item.recordNumber === 37).status, 'readable');
    const bitmap = attributeOffset(bytes, 6, 0x80), bitmapValue = bitmap + bytes.readUInt16LE(bitmap + 20); bytes[bitmapValue + Math.floor(50 / 8)] |= 1 << (50 % 8);
    await assert.rejects(image.recover(37, path.join(root, 'output')), { code: 'NOT_RECOVERABLE' });
  } finally { await image.close(); }
}));

test('a complete physical-prefix and sparse-tail compression unit recovers through LZNT1 byte-for-byte', async () => isolated(async root => {
  const fixture = await createFixture(path.join(root, 'fixture')), bytes = await readFile(fixture.imagePath), expected = makeCompressedUnit(bytes);
  const imagePath = path.join(root, 'compressed.img'); await writeFile(imagePath, bytes); const image = await openNtfsImage(imagePath);
  try {
    const candidate = (await image.scanDeleted()).candidates.find(item => item.recordNumber === 37);
    assert.equal(candidate.status, 'readable'); assert.equal(candidate.storage, 'compressed'); assert.equal(candidate.size, expected.length);
    assert.ok(candidate.reasons.some(reason => reason.includes('LZNT1')));
    const saved = await image.recover(37, path.join(root, 'output')), recovered = await readFile(saved.path);
    assert.deepEqual(recovered, expected); assert.equal(saved.sha256, createHash('sha256').update(expected).digest('hex'));
  } finally { await image.close(); }
}));

test('a full physical compression unit is treated as raw data instead of LZNT1', async () => isolated(async root => {
  const fixture = await createFixture(path.join(root, 'fixture')), bytes = await readFile(fixture.imagePath), expected = makeRawCompressionUnit(bytes);
  const imagePath = path.join(root, 'compressed-raw-unit.img'); await writeFile(imagePath, bytes); const image = await openNtfsImage(imagePath);
  try {
    const candidate = (await image.scanDeleted()).candidates.find(item => item.recordNumber === 37);
    assert.equal(candidate.status, 'readable'); assert.equal(candidate.storage, 'compressed');
    const saved = await image.recover(37, path.join(root, 'output')), recovered = await readFile(saved.path);
    assert.deepEqual(recovered, expected); assert.equal(saved.sha256, createHash('sha256').update(expected).digest('hex'));
  } finally { await image.close(); }
}));

test('compressed mappings and encoded content fail closed when their proof is incomplete', async () => isolated(async root => {
  const fixture = await createFixture(path.join(root, 'fixture')), base = await readFile(fixture.imagePath);
  for (const [label, options, expectedStatus] of [
    ['physical-after-sparse', { malformedRuns: true }, 'conflict'],
    ['wrong-compressed-size', { wrongCompressedSize: true }, 'conflict'],
    ['invalid-lznt1', { malformedPayload: true }, 'readable'],
  ]) {
    const bytes = Buffer.from(base); makeCompressedUnit(bytes, options);
    const imagePath = path.join(root, `${label}.img`); await writeFile(imagePath, bytes); const image = await openNtfsImage(imagePath);
    try {
      const candidate = (await image.scanDeleted()).candidates.find(item => item.recordNumber === 37);
      assert.equal(candidate.status, expectedStatus);
      await assert.rejects(image.recover(37, path.join(root, `out-${label}`)),
        error => ['NOT_RECOVERABLE', 'INVALID_COMPRESSED_DATA'].includes(error.code));
    } finally { await image.close(); }
  }
}));
