// Deliberately fabricated metadata; never reads or edits a real volume.
import { readFile, writeFile } from 'node:fs/promises';
import { createFixture, fixtureGeometry } from './ntfs-fixtures.mjs';

const align = value => Math.ceil(value / 8) * 8;
export function usnRecord({ recordNumber = 24, sequence = 7, deletedAt = '2026-09-12T10:00:00.000Z',
  reason = 0x80000200, name = '삭제된-문서.txt', major = 2, usn = 0 } = {}) {
  const encoded = Buffer.from(name, 'utf16le');
  const bytes = Buffer.alloc(align(60 + encoded.length));
  bytes.writeUInt32LE(bytes.length, 0); bytes.writeUInt16LE(major, 4);
  bytes.writeBigUInt64LE(BigInt(recordNumber) | BigInt(sequence) << 48n, 8);
  bytes.writeBigUInt64LE(5n | 1n << 48n, 16);
  bytes.writeBigInt64LE(BigInt(usn), 24);
  bytes.writeBigInt64LE(deletedAt === null ? 0n : (BigInt(Date.parse(deletedAt)) + 11644473600000n) * 10000n, 32);
  bytes.writeUInt32LE(reason >>> 0, 40); bytes.writeUInt32LE(0x20, 52);
  bytes.writeUInt16LE(encoded.length, 56); bytes.writeUInt16LE(60, 58); encoded.copy(bytes, 60);
  return bytes;
}
export function journalRecords(records, offset = 0) {
  return Buffer.concat(records.map(source => {
    const bytes = Buffer.from(source);
    if (bytes.length >= 32) bytes.writeBigInt64LE(BigInt(offset), 24);
    offset += bytes.length;
    return bytes;
  }));
}
function resident(type, value, id = 0, name = '') {
  const encodedName = Buffer.from(name, 'utf16le');
  const valueOffset = align(24 + encodedName.length);
  const bytes = Buffer.alloc(align(valueOffset + value.length));
  bytes.writeUInt32LE(type, 0); bytes.writeUInt32LE(bytes.length, 4);
  bytes[9] = encodedName.length / 2; bytes.writeUInt16LE(encodedName.length ? 24 : 0, 10);
  bytes.writeUInt16LE(id, 14); bytes.writeUInt32LE(value.length, 16); bytes.writeUInt16LE(valueOffset, 20);
  encodedName.copy(bytes, 24); value.copy(bytes, valueOffset); return bytes;
}
function unsignedBytes(value) {
  let number = BigInt(value); const output = [];
  do { output.push(Number(number & 0xffn)); number >>= 8n; } while (number);
  return Buffer.from(output);
}
function signedBytes(value) {
  let size = 1;
  while (value < -(2 ** (size * 8 - 1)) || value > 2 ** (size * 8 - 1) - 1) size++;
  let number = BigInt(value); if (number < 0) number += 1n << BigInt(size * 8);
  const output = Buffer.alloc(size);
  for (let index = 0; index < size; index++) { output[index] = Number(number & 0xffn); number >>= 8n; }
  return output;
}
function nonresident(type, name, runs, dataSize, { initializedSize = dataSize, allocatedSize, flags = 0, id = 1,
  firstVcn = 0, compressionUnit = 0, physicalSize, extendedHeader = physicalSize !== undefined } = {}) {
  const encodedName = Buffer.from(name, 'utf16le');
  const nameOffset = extendedHeader ? 72 : 64;
  const mappingOffset = align(nameOffset + encodedName.length);
  const parts = [];
  let previousLcn = 0;
  let clusterCount = 0;
  let physicalClusters = 0;
  for (const run of runs) {
    const length = unsignedBytes(run.clusters);
    clusterCount += run.clusters;
    if (run.lcn == null) parts.push(Buffer.from([length.length]), length);
    else {
      const relative = signedBytes(run.lcn - previousLcn);
      parts.push(Buffer.from([(relative.length << 4) | length.length]), length, relative);
      previousLcn = run.lcn; physicalClusters += run.clusters;
    }
  }
  parts.push(Buffer.from([0]));
  const mapping = Buffer.concat(parts);
  const bytes = Buffer.alloc(align(mappingOffset + mapping.length));
  bytes.writeUInt32LE(type, 0); bytes.writeUInt32LE(bytes.length, 4); bytes[8] = 1;
  bytes[9] = encodedName.length / 2; bytes.writeUInt16LE(encodedName.length ? nameOffset : 0, 10);
  bytes.writeUInt16LE(flags, 12); bytes.writeUInt16LE(id, 14);
  bytes.writeBigUInt64LE(BigInt(firstVcn), 16); bytes.writeBigUInt64LE(BigInt(firstVcn + clusterCount - 1), 24);
  bytes.writeUInt16LE(mappingOffset, 32); bytes.writeUInt16LE(compressionUnit, 34);
  bytes.writeBigUInt64LE(BigInt(allocatedSize ?? physicalClusters * 4096), 40);
  bytes.writeBigUInt64LE(BigInt(dataSize), 48); bytes.writeBigUInt64LE(BigInt(initializedSize), 56);
  if (extendedHeader) bytes.writeBigUInt64LE(BigInt(physicalSize ?? physicalClusters * 4096), 64);
  encodedName.copy(bytes, nameOffset); mapping.copy(bytes, mappingOffset);
  return bytes;
}
function attributeListEntry({ type, name, lowestVcn, recordNumber, sequence, attributeId }) {
  const encodedName = Buffer.from(name, 'utf16le');
  const bytes = Buffer.alloc(align(26 + encodedName.length));
  bytes.writeUInt32LE(type, 0); bytes.writeUInt16LE(bytes.length, 4);
  bytes[6] = encodedName.length / 2; bytes[7] = encodedName.length ? 26 : 0;
  bytes.writeBigUInt64LE(BigInt(lowestVcn), 8);
  bytes.writeBigUInt64LE(BigInt(recordNumber) | BigInt(sequence) << 48n, 16);
  bytes.writeUInt16LE(attributeId, 24); encodedName.copy(bytes, 26);
  return bytes;
}
function fileNameKey(name, parent = 11, parentSequence = 1) {
  const encoded = Buffer.from(name, 'utf16le');
  const key = Buffer.alloc(66 + encoded.length);
  key.writeBigUInt64LE(BigInt(parent) | BigInt(parentSequence) << 48n, 0);
  key[64] = encoded.length / 2; key[65] = 1; encoded.copy(key, 66);
  return key;
}
function indexEntry({ name, recordNumber, sequence = 1, parent = 11, parentSequence = 1 }) {
  const key = fileNameKey(name, parent, parentSequence);
  const bytes = Buffer.alloc(align(16 + key.length));
  bytes.writeBigUInt64LE(BigInt(recordNumber) | BigInt(sequence) << 48n, 0);
  bytes.writeUInt16LE(bytes.length, 8); bytes.writeUInt16LE(key.length, 10); key.copy(bytes, 16);
  return bytes;
}
function lastIndexEntry(childVcn = null) {
  const bytes = Buffer.alloc(childVcn == null ? 16 : 24);
  bytes.writeUInt16LE(bytes.length, 8); bytes.writeUInt16LE(childVcn == null ? 2 : 3, 12);
  if (childVcn != null) bytes.writeBigUInt64LE(BigInt(childVcn), bytes.length - 8);
  return bytes;
}
function indexRoot(entries, { childVcn = null } = {}) {
  const all = Buffer.concat([...entries, lastIndexEntry(childVcn)]);
  const value = Buffer.alloc(32 + all.length);
  value.writeUInt32LE(0x30, 0); value.writeUInt32LE(1, 4); value.writeUInt32LE(4096, 8); value[12] = 1;
  value.writeUInt32LE(16, 16); value.writeUInt32LE(16 + all.length, 20);
  value.writeUInt32LE(value.length - 16, 24); value[28] = childVcn == null ? 0 : 1;
  all.copy(value, 32); return value;
}
function indexBlock(entries, vcn = 0) {
  const all = Buffer.concat([...entries, lastIndexEntry()]);
  const bytes = Buffer.alloc(4096);
  bytes.write('INDX'); bytes.writeUInt16LE(40, 4); bytes.writeUInt16LE(9, 6); bytes.writeBigUInt64LE(BigInt(vcn), 16);
  bytes.writeUInt32LE(40, 24); bytes.writeUInt32LE(40 + all.length, 28); bytes.writeUInt32LE(bytes.length - 24, 32);
  all.copy(bytes, 64); return applyIndexFixups(bytes);
}
function applyIndexFixups(bytes) {
  const offset = bytes.readUInt16LE(4); bytes.writeUInt16LE(0xb72c, offset);
  for (let index = 1; index <= 8; index++) {
    bytes.writeUInt16LE(bytes.readUInt16LE(index * 512 - 2), offset + index * 2);
    bytes.writeUInt16LE(0xb72c, index * 512 - 2);
  }
  return bytes;
}
function record(name, parent, directory, attributes = [], { flags = directory ? 3 : 1, sequence = 1,
  baseReference = 0n, includeName = true } = {}) {
  const bytes = Buffer.alloc(1024);
  bytes.write('FILE'); bytes.writeUInt16LE(48, 4); bytes.writeUInt16LE(3, 6);
  bytes.writeUInt16LE(sequence, 16); bytes.writeUInt16LE(56, 20); bytes.writeUInt16LE(flags, 22);
  bytes.writeUInt32LE(1024, 28); bytes.writeBigUInt64LE(BigInt(baseReference), 32);
  const nameValue = Buffer.alloc(66 + name.length * 2);
  nameValue.writeBigUInt64LE(BigInt(parent) | 1n << 48n); nameValue[64] = name.length; nameValue[65] = 1;
  Buffer.from(name, 'utf16le').copy(nameValue, 66);
  let cursor = 56;
  for (const attribute of [...(includeName ? [resident(0x30, nameValue)] : []), ...attributes]) { attribute.copy(bytes, cursor); cursor += attribute.length; }
  bytes.writeUInt32LE(0xffffffff, cursor); bytes.writeUInt32LE(cursor + 4, 24);
  return applyFixups(bytes);
}
function applyFixups(bytes) {
  const offset = bytes.readUInt16LE(4);
  bytes.writeUInt16LE(0xa71b, offset);
  for (let index = 1; index <= 2; index++) {
    bytes.writeUInt16LE(bytes.readUInt16LE(index * 512 - 2), offset + index * 2);
    bytes.writeUInt16LE(0xa71b, index * 512 - 2);
  }
  return bytes;
}
function updateBitmap(image, recordNumber, type, bits) {
  const base = fixtureGeometry.mftLcn * fixtureGeometry.clusterSize + recordNumber * 1024;
  const bytes = Buffer.from(image.subarray(base, base + 1024));
  const usa = bytes.readUInt16LE(4);
  for (let index = 1; index <= 2; index++) bytes.writeUInt16LE(bytes.readUInt16LE(usa + index * 2), index * 512 - 2);
  let cursor = bytes.readUInt16LE(20);
  while (bytes.readUInt32LE(cursor) !== 0xffffffff) {
    if (bytes.readUInt32LE(cursor) === type) {
      const value = cursor + bytes.readUInt16LE(cursor + 20);
      for (const bit of bits) bytes[value + Math.floor(bit / 8)] |= 1 << bit % 8;
      applyFixups(bytes).copy(image, base); return;
    }
    cursor += bytes.readUInt32LE(cursor + 4);
  }
  throw new Error('Synthetic bitmap attribute missing');
}

export async function createUsnFixture(directory, { journalBytes, indexAllocation = false, journalFlags = 5 } = {}) {
  const fixture = await createFixture(directory);
  const image = await readFile(fixture.imagePath);
  const journal = journalBytes ?? journalRecords([
    // Freeing increments the header sequence; the journal uses its prior live reference.
    usnRecord({ deletedAt: '2026-09-13T02:00:00.000Z', recordNumber: 25, sequence: 3, name: 'contiguous.bin' }),
    usnRecord({ deletedAt: '2026-09-12T10:00:00.000Z', sequence: 6 }),
    usnRecord({ deletedAt: '2026-09-13T03:00:00.000Z', sequence: 7 }),
  ], 8 * 4096);
  if (journal.length > 4096) throw new Error('Synthetic journal payload limit');
  const stream = Buffer.alloc(80);
  stream.writeUInt32LE(0x80, 0); stream.writeUInt32LE(80, 4); stream[8] = 1; stream[9] = 2;
  stream.writeUInt16LE(64, 10); stream.writeUInt16LE(0x8000, 12); stream.writeUInt16LE(1, 14);
  stream.writeBigUInt64LE(8n, 24); stream.writeUInt16LE(72, 32);
  stream.writeBigUInt64LE(4096n, 40); stream.writeBigUInt64LE(BigInt(8 * 4096 + journal.length), 48);
  stream.writeBigUInt64LE(BigInt(8 * 4096 + journal.length), 56);
  Buffer.from('$J', 'utf16le').copy(stream, 64);
  Buffer.from([0x01, 8, 0x11, 1, 90, 0]).copy(stream, 72);
  const mft = fixtureGeometry.mftLcn * fixtureGeometry.clusterSize;
  const journalIndexEntry = indexEntry({ name: '$UsnJrnl', recordNumber: 43, sequence: 1 });
  const extendAttributes = indexAllocation
    ? [resident(0x90, indexRoot([], { childVcn: 0 }), 1, '$I30'),
      nonresident(0xa0, '$I30', [{ lcn: 91, clusters: 1 }], 4096, { id: 2 }),
      resident(0xb0, Buffer.from([1]), 3, '$I30')]
    : [resident(0x90, indexRoot([journalIndexEntry]), 1, '$I30')];
  record('$Extend', 5, true, extendAttributes).copy(image, mft + 11 * 1024);
  record('$UsnJrnl', 11, false, [stream], { flags: journalFlags }).copy(image, mft + 43 * 1024);
  updateBitmap(image, 0, 0xb0, [11, 43]); updateBitmap(image, 6, 0x80, indexAllocation ? [90, 91] : [90]);
  journal.copy(image, 90 * 4096);
  if (indexAllocation) indexBlock([journalIndexEntry]).copy(image, 91 * 4096);
  await writeFile(fixture.imagePath, image);
  return { ...fixture, deletionTimes: new Map([
    ['ntfs:24:7', '2026-09-12T10:00:00.000Z'], ['ntfs:25:4', '2026-09-13T02:00:00.000Z'],
  ]) };
}

export async function createSplitSparseUsnFixture(directory, {
  physicalSize,
  extendedBaseHeader = true,
  compressionUnit = 4,
  reservedByte35 = 0,
  noHole = false,
} = {}) {
  const fixture = await createFixture(directory);
  const image = await readFile(fixture.imagePath);
  const mft = fixtureGeometry.mftLcn * fixtureGeometry.clusterSize;
  const baseRecordNumber = 43;
  const firstExtension = { recordNumber: 44, sequence: 2, firstVcn: 0 };
  const secondExtension = { recordNumber: 45, sequence: 3, firstVcn: 9 };
  const owner = BigInt(baseRecordNumber) | 1n << 48n;
  const firstJournal = journalRecords([
    usnRecord({ deletedAt: '2026-09-12T10:00:00.000Z', recordNumber: 24, sequence: 6 }),
  ], 8 * 4096);
  const secondJournal = journalRecords([
    usnRecord({ deletedAt: '2026-09-13T02:00:00.000Z', recordNumber: 25, sequence: 3, name: 'contiguous.bin' }),
  ], 9 * 4096);
  const dataSize = 9 * 4096 + secondJournal.length;
  const expectedPhysicalSize = physicalSize ?? (noHole ? 10 * 4096 : 2 * 4096);
  const list = Buffer.concat([firstExtension, secondExtension].map(item => attributeListEntry({
    type: 0x80, name: '$J', lowestVcn: item.firstVcn, recordNumber: item.recordNumber,
    sequence: item.sequence, attributeId: 1,
  })));
  const firstRuns = noHole ? [{ lcn: 82, clusters: 9 }] : [{ lcn: null, clusters: 8 }, { lcn: 90, clusters: 1 }];
  const firstSegment = nonresident(0x80, '$J', firstRuns, dataSize, {
    initializedSize: dataSize, allocatedSize: 10 * 4096, physicalSize: expectedPhysicalSize, flags: 0x8000, id: 1,
    compressionUnit, extendedHeader: extendedBaseHeader,
  });
  firstSegment[35] = reservedByte35;
  const secondSegment = nonresident(0x80, '$J', [{ lcn: 91, clusters: 1 }], 0, {
    initializedSize: 0, allocatedSize: 0, flags: 0x8000, id: 1, firstVcn: 9,
  });
  const journalReference = indexEntry({ name: '$UsnJrnl', recordNumber: baseRecordNumber, sequence: 1 });
  record('$Extend', 5, true, [resident(0x90, indexRoot([journalReference]), 1, '$I30')])
    .copy(image, mft + 11 * 1024);
  record('$UsnJrnl', 11, false, [resident(0x20, list, 2)], { flags: 5 }).copy(image, mft + baseRecordNumber * 1024);
  record('', 0, false, [firstSegment], { flags: 1, sequence: firstExtension.sequence,
    baseReference: owner, includeName: false }).copy(image, mft + firstExtension.recordNumber * 1024);
  record('', 0, false, [secondSegment], { flags: 1, sequence: secondExtension.sequence,
    baseReference: owner, includeName: false }).copy(image, mft + secondExtension.recordNumber * 1024);
  updateBitmap(image, 0, 0xb0, [11, baseRecordNumber, firstExtension.recordNumber, secondExtension.recordNumber]);
  updateBitmap(image, 6, 0x80, noHole ? Array.from({ length: 10 }, (_, index) => 82 + index) : [90, 91]);
  firstJournal.copy(image, 90 * 4096);
  secondJournal.copy(image, 91 * 4096);
  await writeFile(fixture.imagePath, image);
  return { ...fixture, journal: { baseRecordNumber, extensions: [firstExtension, secondExtension], dataSize,
    physicalSize: expectedPhysicalSize, logicalAllocatedSize: 10 * 4096 }, deletionTimes: new Map([
    ['ntfs:24:7', '2026-09-12T10:00:00.000Z'], ['ntfs:25:4', '2026-09-13T02:00:00.000Z'],
  ]) };
}

export async function createLargeMftUsnFixture(directory, { journalFlags = 5 } = {}) {
  const fixture = await createFixture(directory);
  const original = await readFile(fixture.imagePath);
  const clusterSize = 4096;
  const clusterCount = 4096;
  const recordCount = 8192;
  const journalRecordNumber = 5000;
  const image = Buffer.alloc(clusterCount * clusterSize);
  original.copy(image);
  image.writeBigUInt64LE(BigInt(clusterCount * 8), 40);

  const mftBitmap = Buffer.alloc(recordCount / 8);
  for (const bit of [0, 3, 5, 6, 11, journalRecordNumber]) mftBitmap[Math.floor(bit / 8)] |= 1 << bit % 8;
  const volumeBitmap = Buffer.alloc(clusterCount / 8);
  for (let cluster = 0; cluster <= 2052; cluster++) volumeBitmap[Math.floor(cluster / 8)] |= 1 << cluster % 8;
  volumeBitmap[Math.floor(3000 / 8)] |= 1 << 3000 % 8;

  const mftData = nonresident(0x80, '', [{ lcn: 4, clusters: 2048 }], recordCount * 1024, {
    initializedSize: recordCount * 1024, allocatedSize: 2048 * clusterSize, id: 2 });
  const mftBitmapStream = nonresident(0xb0, '', [{ lcn: 2052, clusters: 1 }], mftBitmap.length, {
    initializedSize: mftBitmap.length, allocatedSize: clusterSize, id: 3 });
  const mftOffset = 4 * clusterSize;
  record('$MFT', 5, false, [mftData, mftBitmapStream]).copy(image, mftOffset);
  record('$Bitmap', 5, false, [resident(0x80, volumeBitmap, 2)]).copy(image, mftOffset + 6 * 1024);
  const journalReference = indexEntry({ name: '$UsnJrnl', recordNumber: journalRecordNumber, sequence: 1 });
  record('$Extend', 5, true, [resident(0x90, indexRoot([journalReference]), 1, '$I30')])
    .copy(image, mftOffset + 11 * 1024);

  const journal = journalRecords([
    usnRecord({ deletedAt: '2026-09-12T10:00:00.000Z', recordNumber: 24, sequence: 6 }),
  ], 8 * clusterSize);
  const journalData = nonresident(0x80, '$J', [{ lcn: null, clusters: 8 }, { lcn: 3000, clusters: 1 }],
    8 * clusterSize + journal.length, { initializedSize: 8 * clusterSize + journal.length,
      allocatedSize: clusterSize, flags: 0x8000, id: 1 });
  record('$UsnJrnl', 11, false, [journalData], { flags: journalFlags }).copy(image, mftOffset + journalRecordNumber * 1024);
  mftBitmap.copy(image, 2052 * clusterSize);
  journal.copy(image, 3000 * clusterSize);
  await writeFile(fixture.imagePath, image);
  return { ...fixture, recordCount, journalRecordNumber, imageSize: image.length };
}

// A virtual sparse backing store: the NTFS MFT itself is a valid contiguous
// 3.1-million-record stream, while the fixture only retains byte ranges that a
// journal-first search is allowed to touch. No multi-gigabyte test file is made.
export async function createSparseHugeMftProviderFixture(directory, { journalFlags = 5 } = {}) {
  const fixture = await createFixture(directory);
  const base = await readFile(fixture.imagePath);
  const clusterSize = 4096;
  const clusterCount = 800000;
  const recordCount = 3100000;
  const mftCluster = 4;
  const mftClusters = recordCount / 4;
  const mftBitmapLcn = 775004;
  const volumeBitmapLcn = 775100;
  const journalLcn = 775200;
  const journalRecordNumber = 3000000;
  const imageSize = clusterCount * clusterSize;
  const mftBitmap = Buffer.alloc(Math.ceil(recordCount / 8));
  for (const bit of [0, 3, 5, 6, 11, journalRecordNumber]) mftBitmap[Math.floor(bit / 8)] |= 1 << bit % 8;
  const volumeBitmap = Buffer.alloc(Math.ceil(clusterCount / 8));
  for (let cluster = 0; cluster < mftCluster + mftClusters; cluster++) {
    volumeBitmap[Math.floor(cluster / 8)] |= 1 << cluster % 8;
  }
  const mftBitmapClusters = Math.ceil(mftBitmap.length / clusterSize);
  const volumeBitmapClusters = Math.ceil(volumeBitmap.length / clusterSize);
  for (let cluster = mftBitmapLcn; cluster < mftBitmapLcn + mftBitmapClusters; cluster++) {
    volumeBitmap[Math.floor(cluster / 8)] |= 1 << cluster % 8;
  }
  for (let cluster = volumeBitmapLcn; cluster < volumeBitmapLcn + volumeBitmapClusters; cluster++) {
    volumeBitmap[Math.floor(cluster / 8)] |= 1 << cluster % 8;
  }
  volumeBitmap[Math.floor(journalLcn / 8)] |= 1 << journalLcn % 8;

  const boot = Buffer.from(base.subarray(0, 512));
  boot.writeBigUInt64LE(BigInt(clusterCount * 8), 40);
  const mftData = nonresident(0x80, '', [{ lcn: mftCluster, clusters: mftClusters }], recordCount * 1024, {
    initializedSize: recordCount * 1024, allocatedSize: mftClusters * clusterSize, id: 2 });
  const mftBitmapStream = nonresident(0xb0, '', [{ lcn: mftBitmapLcn, clusters: mftBitmapClusters }], mftBitmap.length, {
    initializedSize: mftBitmap.length, allocatedSize: mftBitmapClusters * clusterSize, id: 3 });
  const volumeBitmapStream = nonresident(0x80, '', [{ lcn: volumeBitmapLcn, clusters: volumeBitmapClusters }], volumeBitmap.length, {
    initializedSize: volumeBitmap.length, allocatedSize: volumeBitmapClusters * clusterSize, id: 2 });
  const journalReference = indexEntry({ name: '$UsnJrnl', recordNumber: journalRecordNumber, sequence: 1 });
  const journal = journalRecords([
    usnRecord({ deletedAt: '2026-09-12T10:00:00.000Z', recordNumber: 24, sequence: 6 }),
  ], 8 * clusterSize);
  const journalStream = nonresident(0x80, '$J', [{ lcn: null, clusters: 8 }, { lcn: journalLcn, clusters: 1 }],
    8 * clusterSize + journal.length, { initializedSize: 8 * clusterSize + journal.length,
      allocatedSize: clusterSize, flags: 0x8000, id: 1 });
  const physicalMft = mftCluster * clusterSize;
  const segments = [
    { offset: 0, bytes: boot },
    { offset: physicalMft, bytes: record('$MFT', 5, false, [mftData, mftBitmapStream]) },
    { offset: physicalMft + 3 * 1024, bytes: Buffer.from(base.subarray(physicalMft + 3 * 1024, physicalMft + 4 * 1024)) },
    { offset: physicalMft + 5 * 1024, bytes: Buffer.from(base.subarray(physicalMft + 5 * 1024, physicalMft + 6 * 1024)) },
    { offset: physicalMft + 6 * 1024, bytes: record('$Bitmap', 5, false, [volumeBitmapStream]) },
    { offset: physicalMft + 11 * 1024, bytes: record('$Extend', 5, true,
      [resident(0x90, indexRoot([journalReference]), 1, '$I30')]) },
    { offset: physicalMft + 24 * 1024, bytes: Buffer.from(base.subarray(physicalMft + 24 * 1024, physicalMft + 25 * 1024)) },
    { offset: physicalMft + journalRecordNumber * 1024, bytes: record('$UsnJrnl', 11, false, [journalStream], { flags: journalFlags }) },
    { offset: mftBitmapLcn * clusterSize, bytes: mftBitmap },
    { offset: volumeBitmapLcn * clusterSize, bytes: volumeBitmap },
    { offset: journalLcn * clusterSize, bytes: journal },
  ];
  const reads = [];
  let closed = false;
  const provider = {
    info: { size: imageSize, sourceKind: 'volume' },
    assertUnchanged: async () => { if (closed) throw Object.assign(new Error('closed fixture'), { code: 'SOURCE_CHANGED' }); },
    close: async () => { closed = true; },
    read: async (offset, length) => {
      if (closed || offset < 0 || length < 0 || offset + length > imageSize) {
        throw Object.assign(new Error('virtual fixture read outside range'), { code: 'READ_FAILED' });
      }
      const output = Buffer.alloc(length);
      reads.push({ offset, length });
      for (const segment of segments) {
        const start = Math.max(offset, segment.offset);
        const end = Math.min(offset + length, segment.offset + segment.bytes.length);
        if (start < end) segment.bytes.copy(output, start - offset, start - segment.offset, end - segment.offset);
      }
      return output;
    },
  };
  return { ...fixture, provider, reads, recordCount, journalRecordNumber, imageSize };
}
