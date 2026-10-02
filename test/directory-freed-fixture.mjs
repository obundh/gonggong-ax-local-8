import { readFile, writeFile } from 'node:fs/promises';
import { createSlackFixture, namedResident, slackBlock, slackEntry, slackName, slackRoot } from './directory-slack-fixture.mjs';
import { fixturePrimitives } from './ntfs-fixtures.mjs';

const { makeFileRecord, nonresidentAttribute, setBitmapBit } = fixturePrimitives;

export const freedUsedName = slackName;
export const freedTailName = '지워진-메모.txt';
export const existingRootName = '기존-루트-단서.docx';

function namedAllocation(blockCount) {
  const original = nonresidentAttribute(0xa0, [{ lcn: 150, clusters: blockCount }], blockCount * 4096, 4);
  const bytes = Buffer.alloc(original.length + 8);
  original.copy(bytes, 0, 0, 64);
  original.copy(bytes, 72, 64);
  bytes.writeUInt32LE(bytes.length, 4);
  bytes[9] = 4;
  bytes.writeUInt16LE(64, 10);
  bytes.writeUInt16LE(72, 32);
  bytes.write('$I30', 64, 'utf16le');
  return bytes;
}

function recordBitmap(image, recordNumber, type) {
  const base = 16384 + recordNumber * 1024;
  let offset = base + image.readUInt16LE(base + 20);
  while (image.readUInt32LE(offset) !== 0xffffffff) {
    if (image.readUInt32LE(offset) === type) {
      const valueOffset = image.readUInt16LE(offset + 20);
      const valueLength = image.readUInt32LE(offset + 16);
      return image.subarray(offset + valueOffset, offset + valueOffset + valueLength);
    }
    offset += image.readUInt32LE(offset + 4);
  }
  throw new Error('fixture bitmap missing');
}

function setBit(bytes, index, value) {
  const mask = 1 << (index % 8);
  if (value) bytes[Math.floor(index / 8)] |= mask;
  else bytes[Math.floor(index / 8)] &= ~mask;
}

function indexBitmap(blockCount, allocatedIndexes) {
  const bytes = Buffer.alloc(Math.ceil(blockCount / 8), 0);
  for (const index of allocatedIndexes) setBit(bytes, index, true);
  return bytes;
}

function replaceDirectoryRecord(image, { blockCount, allocatedIndexes, rootClue, rootDuplicateFreed }) {
  const remnants = [];
  if (rootClue) remnants.push(slackEntry({ name: existingRootName, number: 60, sequence: 4 }));
  if (rootDuplicateFreed) remnants.push(slackEntry({ name: freedUsedName, number: 48, sequence: 7 }));
  const root = slackRoot({
    child: true,
    remnants,
  });
  const attributes = [
    namedResident(0x90, root, 3),
    namedAllocation(blockCount),
    namedResident(0xb0, indexBitmap(blockCount, allocatedIndexes), 5),
  ];
  makeFileRecord({
    recordNumber: 44,
    sequence: 3,
    active: true,
    directory: true,
    name: '자료',
    attributes,
  }).copy(image, 16384 + 44 * 1024);
}

function freedBlock({ index, usedName, tailName, corruptUsa, wrongVcn, entriesPerBlock }) {
  const entries = Array.from({ length: entriesPerBlock }, (_, slot) => slackEntry({
    name: slot === 0 ? usedName : slot === 1 ? tailName : `예전-${index}-${slot}.txt`,
    number: index === 0 && slot < 2 ? 48 + slot : 50 + slot % 10,
    sequence: slot === 1 ? 6 : 7,
  }));
  const block = slackBlock({
    vcn: wrongVcn ? index + 1 : index,
    active: entries.slice(0, 1),
    remnants: entries.slice(1),
  });
  if (corruptUsa) block[510] ^= 1;
  return block;
}

/**
 * Builds an NTFS image where selected $I30 allocation blocks are marked free
 * in the index bitmap while their physical clusters remain allocated. The
 * block deliberately contains both a formerly used entry and an unused-tail
 * entry so discovery must treat the whole freed node as historical evidence.
 */
export async function createFreedIndexFixture(folder, {
  blockCount = 1,
  freedIndexes = [0],
  evidenceIndexes = freedIndexes,
  rootClue = false,
  rootDuplicateFreed = false,
  corruptUsa = false,
  wrongVcn = false,
  volumeAllocated = true,
  currentSameName = false,
  entriesPerBlock = 2,
} = {}) {
  if (!Number.isInteger(entriesPerBlock) || entriesPerBlock < 2 || entriesPerBlock > 32) throw new RangeError('invalid entries per block');
  const base = await createSlackFixture(folder, {
    allocation: true,
    blockCount,
    bitmapAllocated: false,
    currentSameName,
  });
  const image = await readFile(base.imagePath);
  const freed = new Set(freedIndexes);
  const allocatedIndexes = Array.from({ length: blockCount }, (_, index) => index).filter(index => !freed.has(index));
  replaceDirectoryRecord(image, { blockCount, allocatedIndexes, rootClue, rootDuplicateFreed });

  for (const index of evidenceIndexes) {
    if (!Number.isInteger(index) || index < 0 || index >= blockCount) throw new RangeError('invalid evidence index');
    freedBlock({
      index,
      usedName: index === 0 ? freedUsedName : `예전-사용-${index}.txt`,
      tailName: index === 0 ? freedTailName : `예전-꼬리-${index}.txt`,
      corruptUsa,
      wrongVcn,
      entriesPerBlock,
    }).copy(image, (150 + index) * 4096);
  }

  const volume = recordBitmap(image, 6, 0x80);
  for (let index = 0; index < blockCount; index++) setBit(volume, 150 + index, volumeAllocated);
  // Keep the MFT allocation proof explicit after replacing record 44.
  setBitmapBit(recordBitmap(image, 0, 0xb0), 44);
  await writeFile(base.imagePath, image);
  return { ...base, freedIndexes: [...freedIndexes], evidenceIndexes: [...evidenceIndexes] };
}
