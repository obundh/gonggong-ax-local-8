import { readFile, writeFile } from 'node:fs/promises';
import { createFixture, fixturePrimitives } from './ntfs-fixtures.mjs';
import { buildDirectorySlackClue } from '../engine/directory-slack-clue.mjs';
const { makeFileRecord, nonresidentAttribute, residentAttribute, setBitmapBit } = fixturePrimitives;
const align = value => Math.ceil(value / 8) * 8;
const reference = (number, sequence) => BigInt(number) | BigInt(sequence) << 48n;
export const slackName = '옛-보고서.pdf';
export function slackEntry({ name = slackName, number = 48, sequence = 7, parent = 44, parentSequence = 3 } = {}) {
  const text = Buffer.from(name, 'utf16le'), key = Buffer.alloc(66 + text.length);
  key.writeBigUInt64LE(reference(parent, parentSequence));
  const date = (BigInt(Date.parse('2026-09-20T03:00:00Z')) + 11644473600000n) * 10000n;
  for (const offset of [8, 16, 24, 32]) key.writeBigUInt64LE(date, offset);
  key.writeBigUInt64LE(4096n, 40); key.writeBigUInt64LE(1234n, 48); key.writeUInt32LE(0x20, 56);
  key[64] = text.length / 2; key[65] = 1; text.copy(key, 66);
  const entry = Buffer.alloc(align(16 + key.length)); entry.writeBigUInt64LE(reference(number, sequence));
  entry.writeUInt16LE(entry.length, 8); entry.writeUInt16LE(key.length, 10); key.copy(entry, 16); return entry;
}
export function slackRoot({ remnants = [slackEntry()], active = [], child = false } = {}) {
  const end = Buffer.alloc(child ? 24 : 16); end.writeUInt16LE(end.length, 8); end.writeUInt16LE(child ? 3 : 2, 12);
  const used = Buffer.concat([...active, end]), tail = Buffer.concat(remnants), bytes = Buffer.alloc(32 + used.length + tail.length);
  bytes.writeUInt32LE(0x30); bytes.writeUInt32LE(1, 4); bytes.writeUInt32LE(4096, 8); bytes[12] = 1;
  bytes.writeUInt32LE(16, 16); bytes.writeUInt32LE(16 + used.length, 20); bytes.writeUInt32LE(bytes.length - 16, 24); bytes[28] = child ? 1 : 0;
  used.copy(bytes, 32); tail.copy(bytes, 32 + used.length); return bytes;
}
export function slackBlock({ remnants = [slackEntry()], active = [], vcn = 0 } = {}) {
  const end = Buffer.alloc(16); end.writeUInt16LE(16, 8); end.writeUInt16LE(2, 12);
  const used = Buffer.concat([...active, end]), bytes = Buffer.alloc(4096);
  bytes.write('INDX'); bytes.writeUInt16LE(40, 4); bytes.writeUInt16LE(9, 6); bytes.writeBigUInt64LE(BigInt(vcn), 16);
  bytes.writeUInt32LE(40, 24); bytes.writeUInt32LE(40 + used.length, 28); bytes.writeUInt32LE(4096 - 24, 32);
  used.copy(bytes, 64); Buffer.concat(remnants).copy(bytes, 64 + used.length);
  bytes.writeUInt16LE(0xbeef, 40);
  for (let n = 1; n <= 8; n++) { bytes.writeUInt16LE(bytes.readUInt16LE(n * 512 - 2), 40 + n * 2); bytes.writeUInt16LE(0xbeef, n * 512 - 2); }
  return bytes;
}
export function namedResident(type, value, id) {
  const bytes = Buffer.alloc(align(32 + value.length)); bytes.writeUInt32LE(type); bytes.writeUInt32LE(bytes.length, 4);
  bytes[9] = 4; bytes.writeUInt16LE(24, 10); bytes.writeUInt16LE(id, 14); bytes.writeUInt32LE(value.length, 16); bytes.writeUInt16LE(32, 20);
  bytes.write('$I30', 24, 'utf16le'); value.copy(bytes, 32); return bytes;
}
function namedAllocation(blockCount) {
  const original = nonresidentAttribute(0xa0, [{ lcn: 150, clusters: blockCount }], blockCount * 4096, 4);
  const bytes = Buffer.alloc(original.length + 8); original.copy(bytes, 0, 0, 64); original.copy(bytes, 72, 64);
  bytes.writeUInt32LE(bytes.length, 4); bytes[9] = 4; bytes.writeUInt16LE(64, 10); bytes.writeUInt16LE(72, 32); bytes.write('$I30', 64, 'utf16le'); return bytes;
}
function bitmap(image, record, type) {
  const base = 16384 + record * 1024; let at = base + image.readUInt16LE(base + 20);
  while (image.readUInt32LE(at) !== 0xffffffff) {
    if (image.readUInt32LE(at) === type) return image.subarray(at + image.readUInt16LE(at + 20), at + image.readUInt16LE(at + 20) + image.readUInt32LE(at + 16));
    at += image.readUInt32LE(at + 4);
  }
  throw Error('fixture bitmap missing');
}
export async function createSlackFixture(folder, { allocation = false, blockCount = 1, parentSequence = 3, currentSameName = false, corruptUsa = false, bitmapAllocated = true } = {}) {
  const fixture = await createFixture(folder), image = await readFile(fixture.imagePath);
  const rootValue = slackRoot(allocation ? { remnants: [], child: true } : {});
  const attributes = [namedResident(0x90, rootValue, 3)];
  if (allocation) {
    const indexBitmap = Buffer.alloc(Math.ceil(blockCount / 8), bitmapAllocated ? 0xff : 0);
    attributes.push(namedAllocation(blockCount), namedResident(0xb0, indexBitmap, 5));
    for (let n = 0; n < blockCount; n++) {
      const block = slackBlock({ vcn: n }); if (corruptUsa && n === 0) block[510] ^= 1;
      block.copy(image, (150 + n) * 4096); setBitmapBit(bitmap(image, 6, 0x80), 150 + n);
    }
  }
  makeFileRecord({ recordNumber: 44, sequence: parentSequence, active: true, directory: true, name: '자료', attributes }).copy(image, 16384 + 44 * 1024);
  makeFileRecord({ recordNumber: 47, sequence: 2, name: '먼저-찾은-단서.txt', parentRecord: 44, parentSequence: 3,
    attributes: [residentAttribute(0x80, Buffer.from('separate body'), 2)] }).copy(image, 16384 + 47 * 1024);
  makeFileRecord({ recordNumber: 48, sequence: currentSameName ? 7 : 9, active: true, name: currentSameName ? slackName : '새-현재파일.txt',
    parentRecord: 44, parentSequence, attributes: [residentAttribute(0x80, Buffer.from('unrelated live data'), 2)] }).copy(image, 16384 + 48 * 1024);
  for (const n of [44, 48]) setBitmapBit(bitmap(image, 0, 0xb0), n);
  await writeFile(fixture.imagePath, image); return fixture;
}
export function sampleSlackClue() {
  const bytes = slackRoot();
  return buildDirectorySlackClue({ bytes, kind: 'root', entryOffset: 48, directory: { recordNumber: 44, sequence: 3, fingerprint: 'a'.repeat(64), name: '자료' }, info: { clusterSize: 4096, sectorSize: 512 } });
}
