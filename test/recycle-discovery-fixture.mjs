import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createFixture, fixtureGeometry, fixturePrimitives } from './ntfs-fixtures.mjs';

const MFT_LCN = 4;
const ATTRIBUTE_DATA = 0x80;
const ATTRIBUTE_BITMAP = 0xb0;
const { makeFileRecord, residentAttribute, setBitmapBit } = fixturePrimitives;

export const RECYCLE_RECORDS = Object.freeze({ bin: 44, sid: 45, info: 46, body: 47 });
export const RECYCLE_NAMES = Object.freeze({ info: '$IABC123.TXT', body: '$RABC123.TXT' });
export const ORIGINAL_PATH = 'C:\\문서\\원래-이름.txt';
export const RECYCLED_AT = '2026-09-26T01:02:03.456Z';
export const BODY_BYTES = Buffer.from('independent recycled body\n', 'utf8');

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const filetime = value => (BigInt(Date.parse(value)) + 11644473600000n) * 10000n;

export function recycleV2Payload({ originalPath = ORIGINAL_PATH, originalSize = BODY_BYTES.length,
  recycledAt = RECYCLED_AT, version = 2 } = {}) {
  const text = Buffer.from(`${originalPath}\0`, 'utf16le');
  const bytes = Buffer.alloc(28 + text.length);
  bytes.writeBigUInt64LE(BigInt(version), 0);
  bytes.writeBigUInt64LE(BigInt(originalSize), 8);
  bytes.writeBigUInt64LE(filetime(recycledAt), 16);
  bytes.writeUInt32LE(text.length / 2, 24);
  text.copy(bytes, 28);
  return bytes;
}

function setActiveMftBits(image, numbers) {
  const recordOffset = MFT_LCN * fixtureGeometry.clusterSize;
  let cursor = recordOffset + image.readUInt16LE(recordOffset + 20);
  while (cursor + 8 <= recordOffset + fixtureGeometry.fileRecordSize) {
    const type = image.readUInt32LE(cursor);
    if (type === 0xffffffff) break;
    const length = image.readUInt32LE(cursor + 4);
    if (length < 24 || cursor + length > recordOffset + fixtureGeometry.fileRecordSize) throw new Error('invalid fixture MFT record');
    if (type === ATTRIBUTE_BITMAP && image[cursor + 8] === 0) {
      const valueLength = image.readUInt32LE(cursor + 16);
      const valueOffset = image.readUInt16LE(cursor + 20);
      const bitmap = image.subarray(cursor + valueOffset, cursor + valueOffset + valueLength);
      for (const number of numbers) setBitmapBit(bitmap, number);
      return;
    }
    cursor += length;
  }
  throw new Error('fixture MFT bitmap not found');
}

function putRecord(image, number, record) {
  const offset = MFT_LCN * fixtureGeometry.clusterSize + number * fixtureGeometry.fileRecordSize;
  record.copy(image, offset);
}

export async function createRecycleDiscoveryFixture(directory, {
  sidName = 'S-1-5-21-100-200-300-1001', infoParentSequence = 5, payload = recycleV2Payload(), includeBody = true
} = {}) {
  const fixture = await createFixture(directory);
  const image = await readFile(fixture.imagePath);
  const record24Offset = MFT_LCN * fixtureGeometry.clusterSize + 24 * fixtureGeometry.fileRecordSize;
  const originalRecord24 = Buffer.from(image.subarray(record24Offset, record24Offset + fixtureGeometry.fileRecordSize));

  setActiveMftBits(image, [RECYCLE_RECORDS.bin, RECYCLE_RECORDS.sid]);
  putRecord(image, RECYCLE_RECORDS.bin, makeFileRecord({
    recordNumber: RECYCLE_RECORDS.bin, sequence: 4, active: true, directory: true,
    name: '$Recycle.Bin', parentRecord: 5, parentSequence: 1
  }));
  putRecord(image, RECYCLE_RECORDS.sid, makeFileRecord({
    recordNumber: RECYCLE_RECORDS.sid, sequence: 5, active: true, directory: true,
    name: sidName, parentRecord: RECYCLE_RECORDS.bin, parentSequence: 4
  }));
  putRecord(image, RECYCLE_RECORDS.info, makeFileRecord({
    recordNumber: RECYCLE_RECORDS.info, sequence: 6, name: RECYCLE_NAMES.info,
    parentRecord: RECYCLE_RECORDS.sid, parentSequence: infoParentSequence,
    attributes: [residentAttribute(ATTRIBUTE_DATA, payload, 2)]
  }));
  if (includeBody) {
    putRecord(image, RECYCLE_RECORDS.body, makeFileRecord({
      recordNumber: RECYCLE_RECORDS.body, sequence: 7, name: RECYCLE_NAMES.body,
      parentRecord: RECYCLE_RECORDS.sid, parentSequence: 5,
      attributes: [residentAttribute(ATTRIBUTE_DATA, BODY_BYTES, 2)]
    }));
  }

  const afterRecord24 = image.subarray(record24Offset, record24Offset + fixtureGeometry.fileRecordSize);
  if (!afterRecord24.equals(originalRecord24)) throw new Error('fixture augmentation changed baseline record 24');
  await writeFile(fixture.imagePath, image);
  return { ...fixture, payload, sourceHash: hash(image), originalRecord24Hash: hash(originalRecord24) };
}
