// Independent known-byte fixture constructors adapted from the existing parser unit fixtures.
import assert from 'node:assert/strict';
import { fixtureGeometry as geometry } from './ntfs-fixtures.mjs';
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

const BASE_RECORD = 36;
const EXTENSION_RECORD = 43;
const BASE_SEQUENCE = 2;
const EXTENSION_SEQUENCE = 7;
const FIRST_DATA_LCN = 60;
const SECOND_DATA_LCN = 61;
const DATA_SIZE = 6000;
const EXPECTED_SHA256 = '930b40add0321bde8c895208a448a8f18118b85676723eef3c756ea68a646337';

function align8(value) { return (value + 7) & ~7; }
function fileReference(recordNumber, sequence) { return BigInt(recordNumber) | (BigInt(sequence) << 48n); }

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


export { makeCompressedUnit, makeMixedSparse, installSplitFile, attributeOffset };
