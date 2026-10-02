import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { fixturePrimitives } from './ntfs-fixtures.mjs';

const BYTES_PER_SECTOR = 512;
const SECTORS_PER_CLUSTER = 8;
const CLUSTER_SIZE = BYTES_PER_SECTOR * SECTORS_PER_CLUSTER;
const FILE_RECORD_SIZE = 1024;
const TOTAL_CLUSTERS = 4096;
const IMAGE_SIZE = TOTAL_CLUSTERS * CLUSTER_SIZE;
const MFT_LCN = 4;
const MFT_RECORD_COUNT = 64;
const MFT_CLUSTER_COUNT = MFT_RECORD_COUNT * FILE_RECORD_SIZE / CLUSTER_SIZE;
const ROOT_RECORD = 5;
const TARGET_RECORD = 24;
const TARGET_SEQUENCE = 7;
const EXTENSION_RECORD = 43;
const EXTENSION_SEQUENCE = 11;
const LOGICAL_SIZE = 9 * 1024 * 1024 + 137;
const POISON_BYTE = 0xcc;
const TAIL_POISON_BYTE = 0xa5;

const ATTRIBUTE = Object.freeze({
  STANDARD_INFORMATION: 0x10,
  ATTRIBUTE_LIST: 0x20,
  FILE_NAME: 0x30,
  VOLUME_INFORMATION: 0x70,
  DATA: 0x80,
  BITMAP: 0xb0,
});

const { makeFileRecord, nonresidentAttribute, residentAttribute, setBitmapBit } = fixturePrimitives;

export const stage5BodyRuns = Object.freeze([
  Object.freeze({ vcn: 0, lcn: 3000, clusters: 600, segment: 'base' }),
  Object.freeze({ vcn: 600, lcn: 100, clusters: 600, segment: 'base' }),
  Object.freeze({ vcn: 1200, lcn: 2200, clusters: 600, segment: 'extension' }),
  Object.freeze({ vcn: 1800, lcn: 1000, clusters: 505, segment: 'extension' }),
]);

function deterministicLogicalBytes(length) {
  const bytes = Buffer.allocUnsafe(length);
  for (let index = 0; index < length; index += 1) {
    bytes[index] = (Math.imul(index, 131) + Math.imul(index >>> 8, 17)
      + Math.imul(index >>> 16, 73) + Math.imul(index >>> 24, 101) + 29) & 0xff;
  }
  Buffer.from('RecoveryChat Stage 5 located-body fixture\n', 'utf8').copy(bytes, 0);
  return bytes;
}

export const logicalBytes = deterministicLogicalBytes(LOGICAL_SIZE);
export const expectedSHA = createHash('sha256').update(logicalBytes).digest('hex');

function align8(value) { return (value + 7) & ~7; }

function fileReference(recordNumber, sequence) {
  return BigInt(recordNumber) | (BigInt(sequence) << 48n);
}

function unsignedLittleEndian(value) {
  let encoded = BigInt(value);
  let size = 1;
  while (encoded >= (1n << BigInt(size * 8))) size += 1;
  const bytes = Buffer.alloc(size);
  for (let index = 0; index < size; index += 1) {
    bytes[index] = Number(encoded & 0xffn);
    encoded >>= 8n;
  }
  return bytes;
}

function signedLittleEndian(value) {
  let size = 1;
  while (value < -(2 ** (size * 8 - 1)) || value > 2 ** (size * 8 - 1) - 1) size += 1;
  let encoded = BigInt(value);
  if (encoded < 0) encoded += 1n << BigInt(size * 8);
  const bytes = Buffer.alloc(size);
  for (let index = 0; index < size; index += 1) {
    bytes[index] = Number(encoded & 0xffn);
    encoded >>= 8n;
  }
  return bytes;
}

function mappingPairs(runs) {
  const parts = [];
  let previousLcn = 0;
  for (const run of runs) {
    const count = unsignedLittleEndian(run.clusters);
    const delta = signedLittleEndian(run.lcn - previousLcn);
    parts.push(Buffer.from([(delta.length << 4) | count.length]), count, delta);
    previousLcn = run.lcn;
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

function nonresidentSegment({ id, firstVcn, runs, allocatedSize, dataSize, initializedSize }) {
  const pairs = mappingPairs(runs);
  const length = align8(64 + pairs.length);
  const attribute = Buffer.alloc(length);
  const clusters = runs.reduce((sum, run) => sum + run.clusters, 0);
  attribute.writeUInt32LE(ATTRIBUTE.DATA, 0);
  attribute.writeUInt32LE(length, 4);
  attribute[8] = 1;
  attribute.writeUInt16LE(id, 14);
  attribute.writeBigUInt64LE(BigInt(firstVcn), 16);
  attribute.writeBigUInt64LE(BigInt(firstVcn + clusters - 1), 24);
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

function volumeInformation() {
  const value = Buffer.alloc(12);
  value[8] = 3;
  value[9] = 1;
  return value;
}

function fileNameValue(name, allocatedSize, dataSize) {
  const encoded = Buffer.from(name, 'utf16le');
  const value = Buffer.alloc(66 + encoded.length);
  value.writeBigUInt64LE(fileReference(ROOT_RECORD, 1), 0);
  value.writeBigUInt64LE(BigInt(allocatedSize), 40);
  value.writeBigUInt64LE(BigInt(dataSize), 48);
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
  const record = Buffer.alloc(FILE_RECORD_SIZE);
  const usaOffset = 0x30;
  const firstAttributeOffset = 0x38;
  record.write('FILE', 0, 4, 'ascii');
  record.writeUInt16LE(usaOffset, 4);
  record.writeUInt16LE(3, 6);
  record.writeUInt16LE(sequence, 16);
  record.writeUInt16LE(1, 18);
  record.writeUInt16LE(firstAttributeOffset, 20);
  record.writeUInt16LE(0, 22);
  record.writeUInt32LE(FILE_RECORD_SIZE, 28);
  record.writeBigUInt64LE(baseReference, 32);
  record.writeUInt16LE(attributes.length + 1, 40);
  record.writeUInt32LE(recordNumber, 44);
  let cursor = firstAttributeOffset;
  for (const attribute of attributes) {
    assert.ok(cursor + attribute.length + 8 <= record.length - 2, 'fixture record attributes must fit');
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

function makeBootSector() {
  const boot = Buffer.alloc(BYTES_PER_SECTOR);
  boot.set([0xeb, 0x52, 0x90], 0);
  boot.write('NTFS    ', 3, 8, 'ascii');
  boot.writeUInt16LE(BYTES_PER_SECTOR, 11);
  boot[13] = SECTORS_PER_CLUSTER;
  boot[21] = 0xf8;
  boot.writeUInt16LE(63, 24);
  boot.writeUInt16LE(255, 26);
  boot.writeBigUInt64LE(BigInt(IMAGE_SIZE / BYTES_PER_SECTOR), 40);
  boot.writeBigUInt64LE(BigInt(MFT_LCN), 48);
  boot.writeBigUInt64LE(BigInt(TOTAL_CLUSTERS - 1), 56);
  boot.writeInt8(-10, 64);
  boot.writeInt8(1, 68);
  boot.writeBigUInt64LE(0x535441474535424fn, 72);
  boot[510] = 0x55;
  boot[511] = 0xaa;
  return boot;
}

function recordOffset(recordNumber) {
  return MFT_LCN * CLUSTER_SIZE + recordNumber * FILE_RECORD_SIZE;
}

function writeLogicalRuns(image) {
  let logicalOffset = 0;
  for (const run of stage5BodyRuns) {
    const physicalOffset = run.lcn * CLUSTER_SIZE;
    const physicalLength = run.clusters * CLUSTER_SIZE;
    image.fill(TAIL_POISON_BYTE, physicalOffset, physicalOffset + physicalLength);
    const logicalLength = Math.min(physicalLength, logicalBytes.length - logicalOffset);
    if (logicalLength > 0) {
      logicalBytes.copy(image, physicalOffset, logicalOffset, logicalOffset + logicalLength);
      logicalOffset += logicalLength;
    }
  }
  assert.equal(logicalOffset, logicalBytes.length);
}

export async function createStage5BodyFixture(directory, { uninitializedTailBytes = 0 } = {}) {
  assert.ok(Number.isSafeInteger(uninitializedTailBytes)
    && uninitializedTailBytes >= 0 && uninitializedTailBytes < CLUSTER_SIZE);
  const fixtureDirectory = path.resolve(directory);
  const imagePath = path.join(fixtureDirectory, 'stage5-located-body.img');
  await mkdir(path.dirname(fixtureDirectory), { recursive: true });
  await mkdir(fixtureDirectory);

  const image = Buffer.alloc(IMAGE_SIZE, POISON_BYTE);
  image.fill(0, MFT_LCN * CLUSTER_SIZE, (MFT_LCN + MFT_CLUSTER_COUNT) * CLUSTER_SIZE);
  makeBootSector().copy(image, 0);

  const volumeBitmap = Buffer.alloc(Math.ceil(TOTAL_CLUSTERS / 8));
  for (let cluster = 0; cluster < MFT_LCN + MFT_CLUSTER_COUNT; cluster += 1) setBitmapBit(volumeBitmap, cluster);
  const mftBitmap = Buffer.alloc(Math.ceil(MFT_RECORD_COUNT / 8));
  for (const recordNumber of [0, 3, 5, 6]) setBitmapBit(mftBitmap, recordNumber);

  const totalAllocated = stage5BodyRuns.reduce((sum, run) => sum + run.clusters, 0) * CLUSTER_SIZE;
  const baseRuns = stage5BodyRuns.filter(run => run.segment === 'base');
  const extensionRuns = stage5BodyRuns.filter(run => run.segment === 'extension');
  const extensionFirstVcn = extensionRuns[0].vcn;
  const list = Buffer.concat([
    attributeListEntry(ATTRIBUTE.STANDARD_INFORMATION, 0, TARGET_RECORD, TARGET_SEQUENCE, 0),
    attributeListEntry(ATTRIBUTE.FILE_NAME, 0, TARGET_RECORD, TARGET_SEQUENCE, 1),
    attributeListEntry(ATTRIBUTE.DATA, 0, TARGET_RECORD, TARGET_SEQUENCE, 3),
    attributeListEntry(ATTRIBUTE.DATA, extensionFirstVcn, EXTENSION_RECORD, EXTENSION_SEQUENCE, 4),
  ]);

  const records = new Map([
    [0, makeFileRecord({
      recordNumber: 0,
      sequence: 1,
      active: true,
      name: '$MFT',
      attributes: [
        nonresidentAttribute(ATTRIBUTE.DATA, [{ lcn: MFT_LCN, clusters: MFT_CLUSTER_COUNT }], MFT_RECORD_COUNT * FILE_RECORD_SIZE, 2),
        residentAttribute(ATTRIBUTE.BITMAP, mftBitmap, 3),
      ],
    })],
    [3, makeFileRecord({
      recordNumber: 3,
      sequence: 1,
      active: true,
      name: '$Volume',
      attributes: [residentAttribute(ATTRIBUTE.VOLUME_INFORMATION, volumeInformation(), 2)],
    })],
    [5, makeFileRecord({
      recordNumber: 5,
      sequence: 1,
      active: true,
      directory: true,
      name: '.',
      parentRecord: ROOT_RECORD,
      parentSequence: 1,
    })],
    [6, makeFileRecord({
      recordNumber: 6,
      sequence: 1,
      active: true,
      name: '$Bitmap',
      attributes: [residentAttribute(ATTRIBUTE.DATA, volumeBitmap, 2)],
    })],
    [TARGET_RECORD, makeRecord({
      recordNumber: TARGET_RECORD,
      sequence: TARGET_SEQUENCE,
      attributes: [
        residentAttribute(ATTRIBUTE.STANDARD_INFORMATION, standardInformation(), 0),
        residentAttribute(ATTRIBUTE.ATTRIBUTE_LIST, list, 2),
        residentAttribute(ATTRIBUTE.FILE_NAME, fileNameValue('stage5-large.txt', totalAllocated, logicalBytes.length), 1),
        nonresidentSegment({
          id: 3,
          firstVcn: 0,
          runs: baseRuns,
          allocatedSize: totalAllocated,
          dataSize: logicalBytes.length,
          initializedSize: logicalBytes.length - uninitializedTailBytes,
        }),
      ],
    })],
    [EXTENSION_RECORD, makeRecord({
      recordNumber: EXTENSION_RECORD,
      sequence: EXTENSION_SEQUENCE,
      baseReference: fileReference(TARGET_RECORD, TARGET_SEQUENCE),
      attributes: [nonresidentSegment({
        id: 4,
        firstVcn: extensionFirstVcn,
        runs: extensionRuns,
        allocatedSize: 0,
        dataSize: 0,
        initializedSize: 0,
      })],
    })],
  ]);

  for (const [recordNumber, record] of records) record.copy(image, recordOffset(recordNumber));
  writeLogicalRuns(image);
  if (uninitializedTailBytes > 0) {
    const finalRun = stage5BodyRuns.at(-1);
    const precedingCapacity = stage5BodyRuns.slice(0, -1)
      .reduce((sum, run) => sum + run.clusters * CLUSTER_SIZE, 0);
    const dirtyTailStart = finalRun.lcn * CLUSTER_SIZE
      + logicalBytes.length - uninitializedTailBytes - precedingCapacity;
    image.fill(TAIL_POISON_BYTE, dirtyTailStart, dirtyTailStart + uninitializedTailBytes);
  }
  await writeFile(imagePath, image, { flag: 'wx' });

  const expectedBytes = uninitializedTailBytes === 0
    ? logicalBytes
    : Buffer.concat([
      logicalBytes.subarray(0, logicalBytes.length - uninitializedTailBytes),
      Buffer.alloc(uninitializedTailBytes),
    ]);
  const fixtureExpectedSHA = createHash('sha256').update(expectedBytes).digest('hex');

  return {
    fixtureDirectory,
    imagePath,
    recordNumber: TARGET_RECORD,
    extensionRecordNumber: EXTENSION_RECORD,
    extensionFingerprintByteOffset: recordOffset(EXTENSION_RECORD) + 36,
    volumeBitmapRecordNumber: 6,
    runs: stage5BodyRuns,
    logicalSize: logicalBytes.length,
    initializedSize: logicalBytes.length - uninitializedTailBytes,
    expectedBytes,
    expectedSHA: fixtureExpectedSHA,
  };
}

export const stage5BodyGeometry = Object.freeze({
  bytesPerSector: BYTES_PER_SECTOR,
  sectorsPerCluster: SECTORS_PER_CLUSTER,
  clusterSize: CLUSTER_SIZE,
  fileRecordSize: FILE_RECORD_SIZE,
  totalClusters: TOTAL_CLUSTERS,
  imageSize: IMAGE_SIZE,
  mftLcn: MFT_LCN,
  mftRecordCount: MFT_RECORD_COUNT,
  poisonByte: POISON_BYTE,
  tailPoisonByte: TAIL_POISON_BYTE,
});
