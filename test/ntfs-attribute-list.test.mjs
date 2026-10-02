import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createFixture, fixtureGeometry as geometry } from './ntfs-fixtures.mjs';
import { openNtfsImage, openNtfsProvider } from '../engine/ntfs-image.mjs';

const BASE_RECORD = 36;
const EXTENSION_RECORD = 43;
const BASE_SEQUENCE = 2;
const EXTENSION_SEQUENCE = 7;
const FIRST_DATA_LCN = 60;
const SECOND_DATA_LCN = 61;
const DATA_SIZE = 6000;
const EXPECTED_SHA256 = '930b40add0321bde8c895208a448a8f18118b85676723eef3c756ea68a646337';

function align8(value) { return (value + 7) & ~7; }
function recordOffset(number) { return geometry.mftLcn * geometry.clusterSize + number * geometry.fileRecordSize; }
function fileReference(recordNumber, sequence) { return BigInt(recordNumber) | (BigInt(sequence) << 48n); }
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function residentAttribute(type, value, id) {
  const length = align8(24 + value.length);
  const attribute = Buffer.alloc(length);
  attribute.writeUInt32LE(type, 0);
  attribute.writeUInt32LE(length, 4);
  attribute.writeUInt16LE(id, 14);
  attribute.writeUInt32LE(value.length, 16);
  attribute.writeUInt16LE(24, 20);
  value.copy(attribute, 24);
  return attribute;
}

function mappingPairs(lcn) {
  assert.ok(lcn > 0 && lcn < 128);
  return Buffer.from([0x11, 0x01, lcn, 0x00]);
}

function nonresidentData({ id, firstVcn, lcn, allocatedSize, dataSize, initializedSize }) {
  const pairs = mappingPairs(lcn);
  const length = align8(64 + pairs.length);
  const attribute = Buffer.alloc(length);
  attribute.writeUInt32LE(0x80, 0);
  attribute.writeUInt32LE(length, 4);
  attribute[8] = 1;
  attribute.writeUInt16LE(id, 14);
  attribute.writeBigUInt64LE(BigInt(firstVcn), 16);
  attribute.writeBigUInt64LE(BigInt(firstVcn), 24);
  attribute.writeUInt16LE(64, 32);
  attribute.writeBigUInt64LE(BigInt(allocatedSize), 40);
  attribute.writeBigUInt64LE(BigInt(dataSize), 48);
  attribute.writeBigUInt64LE(BigInt(initializedSize), 56);
  pairs.copy(attribute, 64);
  return attribute;
}

function standardInformation() {
  const value = Buffer.alloc(72);
  value.writeUInt32LE(0x20, 32);
  return value;
}

function fileNameValue(name) {
  const encoded = Buffer.from(name, 'utf16le');
  const value = Buffer.alloc(66 + encoded.length);
  value.writeBigUInt64LE(fileReference(5, 1), 0);
  value.writeBigUInt64LE(BigInt(2 * geometry.clusterSize), 40);
  value.writeBigUInt64LE(BigInt(DATA_SIZE), 48);
  value.writeUInt32LE(0x20, 56);
  value[64] = encoded.length / 2;
  value[65] = 1;
  encoded.copy(value, 66);
  return value;
}

function attributeListEntry(type, lowestVcn, recordNumber, sequence, attributeId) {
  const entry = Buffer.alloc(32);
  entry.writeUInt32LE(type, 0);
  entry.writeUInt16LE(entry.length, 4);
  entry.writeBigUInt64LE(BigInt(lowestVcn), 8);
  entry.writeBigUInt64LE(fileReference(recordNumber, sequence), 16);
  entry.writeUInt16LE(attributeId, 24);
  return entry;
}

function makeRecord({ recordNumber, sequence, baseReference = 0n, attributes }) {
  const record = Buffer.alloc(geometry.fileRecordSize);
  const usaOffset = 0x30;
  const firstAttributeOffset = 0x38;
  record.write('FILE', 0, 4, 'ascii');
  record.writeUInt16LE(usaOffset, 4);
  record.writeUInt16LE(3, 6);
  record.writeUInt16LE(sequence, 16);
  record.writeUInt16LE(1, 18);
  record.writeUInt16LE(firstAttributeOffset, 20);
  record.writeUInt16LE(0, 22);
  record.writeUInt32LE(geometry.fileRecordSize, 28);
  record.writeBigUInt64LE(baseReference, 32);
  record.writeUInt16LE(attributes.length + 1, 40);
  record.writeUInt32LE(recordNumber, 44);
  let cursor = firstAttributeOffset;
  for (const attribute of attributes) {
    assert.ok(cursor + attribute.length + 8 <= record.length - 2);
    attribute.copy(record, cursor);
    cursor += attribute.length;
  }
  record.writeUInt32LE(0xffffffff, cursor);
  cursor += 4;
  record.writeUInt32LE(cursor, 24);

  const updateSequence = 0xd000 + recordNumber;
  record.writeUInt16LE(updateSequence, usaOffset);
  record.writeUInt16LE(record.readUInt16LE(510), usaOffset + 2);
  record.writeUInt16LE(record.readUInt16LE(1022), usaOffset + 4);
  record.writeUInt16LE(updateSequence, 510);
  record.writeUInt16LE(updateSequence, 1022);
  return record;
}

function installSplitFile(bytes, {
  ownerRecord = BASE_RECORD,
  listedSequence = EXTENSION_SEQUENCE,
  listedAttributeId = 4,
  extensionFirstVcn = 1,
  extensionLcn = SECOND_DATA_LCN,
} = {}) {
  const list = Buffer.concat([
    attributeListEntry(0x10, 0, BASE_RECORD, BASE_SEQUENCE, 0),
    attributeListEntry(0x30, 0, BASE_RECORD, BASE_SEQUENCE, 1),
    attributeListEntry(0x80, 0, BASE_RECORD, BASE_SEQUENCE, 3),
    attributeListEntry(0x80, extensionFirstVcn, EXTENSION_RECORD, listedSequence, listedAttributeId),
  ]);
  const base = makeRecord({
    recordNumber: BASE_RECORD,
    sequence: BASE_SEQUENCE,
    attributes: [
      residentAttribute(0x10, standardInformation(), 0),
      residentAttribute(0x20, list, 2),
      residentAttribute(0x30, fileNameValue('split-data.bin'), 1),
      nonresidentData({
        id: 3,
        firstVcn: 0,
        lcn: FIRST_DATA_LCN,
        allocatedSize: 2 * geometry.clusterSize,
        dataSize: DATA_SIZE,
        initializedSize: DATA_SIZE,
      }),
    ],
  });
  const extension = makeRecord({
    recordNumber: EXTENSION_RECORD,
    sequence: EXTENSION_SEQUENCE,
    baseReference: fileReference(ownerRecord, BASE_SEQUENCE),
    attributes: [nonresidentData({
      id: 4,
      firstVcn: extensionFirstVcn,
      lcn: extensionLcn,
      allocatedSize: 0,
      dataSize: 0,
      initializedSize: 0,
    })],
  });
  base.copy(bytes, recordOffset(BASE_RECORD));
  extension.copy(bytes, recordOffset(EXTENSION_RECORD));

  const first = Buffer.alloc(geometry.clusterSize);
  const second = Buffer.alloc(geometry.clusterSize);
  for (let index = 0; index < first.length; index += 1) first[index] = (index * 17 + 3) & 0xff;
  for (let index = 0; index < second.length; index += 1) second[index] = (index * 29 + 7) & 0xff;
  first.copy(bytes, FIRST_DATA_LCN * geometry.clusterSize);
  second.copy(bytes, SECOND_DATA_LCN * geometry.clusterSize);
  return Buffer.concat([first, second]).subarray(0, DATA_SIZE);
}

function extensionIgnoredHeaderByteOffset(bytes) {
  const begin = recordOffset(EXTENSION_RECORD);
  return begin + bytes.readUInt16LE(begin + 20) + 36;
}

async function isolated(callback) {
  const base = path.resolve(os.tmpdir());
  const root = await mkdtemp(path.join(base, 'recoverychat-ntfs-attribute-list-'));
  try { await callback(root); } finally {
    const relative = path.relative(base, root);
    assert.ok(relative.startsWith('recoverychat-ntfs-attribute-list-') && !relative.includes(path.sep));
    await rm(root, { recursive: true, force: true });
  }
}

class MutableImageProvider {
  constructor(bytes) {
    this.bytes = bytes;
    this.info = { size: bytes.length, sectorSize: 512, sourceKind: 'volume-image', identity: 'split-attribute-list-fixture' };
  }
  async read(offset, length) { return Buffer.from(this.bytes.subarray(offset, offset + length)); }
  async assertUnchanged() {}
  async close() {}
}

test('resident ATTRIBUTE_LIST resolves a split unnamed DATA stream and recovers exact bytes', async () => isolated(async root => {
  const fixture = await createFixture(path.join(root, 'fixture'));
  const bytes = await readFile(fixture.imagePath);
  const expected = installSplitFile(bytes);
  const provider = new MutableImageProvider(bytes);
  const image = await openNtfsProvider(provider);
  try {
    const scan = await image.scanDeleted();
    const candidate = scan.candidates.find(item => item.recordNumber === BASE_RECORD);
    assert.equal(candidate.status, 'readable');
    assert.equal(candidate.storage, 'nonresident');
    assert.equal(candidate.size, expected.length);
    assert.ok(candidate.reasons.some(reason => reason.includes('$ATTRIBUTE_LIST')));

    const checkpoint = image.exportCheckpoint();
    const entry = checkpoint.entries.find(item => item.recordNumber === BASE_RECORD);
    assert.equal(entry.extensions.length, 1);
    assert.equal(entry.extensions[0].recordNumber, EXTENSION_RECORD);
    assert.match(entry.extensions[0].fingerprint, /^[0-9a-f]{64}$/);

    const saved = await image.recover(BASE_RECORD, path.join(root, 'recovered'));
    const recovered = await readFile(saved.path);
    assert.deepEqual(recovered, expected);
    assert.equal(sha256(expected), EXPECTED_SHA256);
    assert.equal(saved.sha256, EXPECTED_SHA256);
  } finally { await image.close(); }
}));

test('mismatched ownership, sequence, attribute id, VCN continuity, and physical overlap fail closed', async () => isolated(async root => {
  const fixture = await createFixture(path.join(root, 'fixture'));
  const original = await readFile(fixture.imagePath);
  const variants = [
    ['ownership', { ownerRecord: 35 }],
    ['sequence', { listedSequence: EXTENSION_SEQUENCE + 1 }],
    ['attribute-id', { listedAttributeId: 9 }],
    ['vcn-gap', { extensionFirstVcn: 2 }],
    ['physical-overlap', { extensionLcn: FIRST_DATA_LCN }],
  ];
  for (const [label, options] of variants) {
    const bytes = Buffer.from(original);
    installSplitFile(bytes, options);
    const image = await openNtfsProvider(new MutableImageProvider(bytes));
    try {
      const candidate = (await image.scanDeleted()).candidates.find(item => item.recordNumber === BASE_RECORD);
      assert.ok(candidate);
      assert.notEqual(candidate.status, 'readable', label);
      await assert.rejects(image.recover(BASE_RECORD, path.join(root, `out-${label}`)), { code: 'NOT_RECOVERABLE' });
    } finally { await image.close(); }
  }
}));

test('recovery and checkpoint resume both reject a changed extension-record fingerprint', async () => isolated(async root => {
  const fixture = await createFixture(path.join(root, 'fixture'));
  const bytes = await readFile(fixture.imagePath);
  installSplitFile(bytes);
  const provider = new MutableImageProvider(bytes);
  const image = await openNtfsProvider(provider);
  let checkpoint;
  try {
    const candidate = (await image.scanDeleted()).candidates.find(item => item.recordNumber === BASE_RECORD);
    assert.equal(candidate.status, 'readable');
    checkpoint = image.exportCheckpoint();
    bytes[extensionIgnoredHeaderByteOffset(bytes)] ^= 0x01;
    await assert.rejects(image.recover(BASE_RECORD, path.join(root, 'changed-recovery')), { code: 'SOURCE_CHANGED' });
  } finally { await image.close(); }

  const resumed = await openNtfsProvider(new MutableImageProvider(bytes));
  try {
    await assert.rejects(resumed.scanDeleted({ resumeFrom: checkpoint }), { code: 'SOURCE_CHANGED' });
  } finally { await resumed.close(); }
}));

test('an extension record changed during copying prevents final publication', async () => isolated(async root => {
  const fixture = await createFixture(path.join(root, 'fixture'));
  const bytes = await readFile(fixture.imagePath);
  installSplitFile(bytes);
  const image = await openNtfsProvider(new MutableImageProvider(bytes));
  try {
    assert.equal((await image.scanDeleted()).candidates.find(item => item.recordNumber === BASE_RECORD).status, 'readable');
    let changed = false;
    await assert.rejects(image.recover(BASE_RECORD, path.join(root, 'changed-during-copy'), { control: { async checkpoint() {
      if (!changed) {
        changed = true;
        bytes[extensionIgnoredHeaderByteOffset(bytes)] ^= 0x01;
      }
    } } }), { code: 'SOURCE_CHANGED' });
    assert.equal(changed, true);
  } finally { await image.close(); }
}));
