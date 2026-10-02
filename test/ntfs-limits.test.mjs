import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createFixture, fixtureGeometry as geometry } from './ntfs-fixtures.mjs';
import { openNtfsProvider } from '../engine/ntfs-image.mjs';

const OVERSIZED_COMPRESSION_UNITS = 65537;
const LOGICAL_CLUSTERS = OVERSIZED_COMPRESSION_UNITS * 16;
const VIRTUAL_VOLUME_SIZE = LOGICAL_CLUSTERS * geometry.clusterSize;

function align8(value) { return (value + 7) & ~7; }

function unsignedLittleEndian(value) {
  let current = BigInt(value);
  let size = 1;
  while (current >= (1n << BigInt(size * 8))) size++;
  const bytes = Buffer.alloc(size);
  for (let index = 0; index < size; index++) {
    bytes[index] = Number(current & 0xffn);
    current >>= 8n;
  }
  return bytes;
}

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

function nonresidentAttribute({ type = 0x80, id, clusters, lcn = null, dataSize, initializedSize = dataSize,
  allocatedSize = lcn == null ? 0 : clusters * geometry.clusterSize, compressed = false }) {
  const count = unsignedLittleEndian(clusters);
  const mappingPairs = lcn == null
    ? Buffer.concat([Buffer.from([count.length]), count, Buffer.from([0])])
    : Buffer.concat([Buffer.from([(1 << 4) | count.length]), count, Buffer.from([lcn, 0])]);
  const headerSize = compressed ? 72 : 64;
  const length = align8(headerSize + mappingPairs.length);
  const attribute = Buffer.alloc(length);
  attribute.writeUInt32LE(type, 0);
  attribute.writeUInt32LE(length, 4);
  attribute[8] = 1;
  attribute.writeUInt16LE(compressed ? 1 : 0, 12);
  attribute.writeUInt16LE(id, 14);
  attribute.writeBigUInt64LE(0n, 16);
  attribute.writeBigUInt64LE(BigInt(clusters - 1), 24);
  attribute.writeUInt16LE(headerSize, 32);
  attribute.writeUInt16LE(compressed ? 4 : 0, 34);
  attribute.writeBigUInt64LE(BigInt(compressed ? clusters * geometry.clusterSize : allocatedSize), 40);
  attribute.writeBigUInt64LE(BigInt(dataSize), 48);
  attribute.writeBigUInt64LE(BigInt(initializedSize), 56);
  if (compressed) attribute.writeBigUInt64LE(BigInt(allocatedSize), 64);
  mappingPairs.copy(attribute, headerSize);
  return attribute;
}

function makeRecord({ recordNumber, sequence = 1, active = false, attributes }) {
  const record = Buffer.alloc(geometry.fileRecordSize);
  const usaOffset = 0x30;
  const firstAttributeOffset = 0x38;
  record.write('FILE', 0, 4, 'ascii');
  record.writeUInt16LE(usaOffset, 4);
  record.writeUInt16LE(3, 6);
  record.writeUInt16LE(sequence, 16);
  record.writeUInt16LE(1, 18);
  record.writeUInt16LE(firstAttributeOffset, 20);
  record.writeUInt16LE(active ? 1 : 0, 22);
  record.writeUInt32LE(record.length, 28);
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
  const updateSequence = 0xe000 + recordNumber;
  record.writeUInt16LE(updateSequence, usaOffset);
  record.writeUInt16LE(record.readUInt16LE(510), usaOffset + 2);
  record.writeUInt16LE(record.readUInt16LE(1022), usaOffset + 4);
  record.writeUInt16LE(updateSequence, 510);
  record.writeUInt16LE(updateSequence, 1022);
  return record;
}

function recordOffset(recordNumber) {
  return geometry.mftLcn * geometry.clusterSize + recordNumber * geometry.fileRecordSize;
}

function installOversizedCompressedMetadata(bytes) {
  bytes.writeBigUInt64LE(BigInt(VIRTUAL_VOLUME_SIZE / geometry.bytesPerSector), 40);

  const bitmapBytes = Math.ceil(LOGICAL_CLUSTERS / 8);
  const bitmapClusters = Math.ceil(bitmapBytes / geometry.clusterSize);
  const bitmapRecord = makeRecord({
    recordNumber: 6,
    active: true,
    attributes: [nonresidentAttribute({
      id: 2,
      clusters: bitmapClusters,
      lcn: 100,
      dataSize: bitmapBytes,
      initializedSize: bitmapBytes,
    })],
  });
  bitmapRecord.copy(bytes, recordOffset(6));

  const standard = Buffer.alloc(72);
  standard.writeUInt32LE(0x800, 32);
  const oversizedRecord = makeRecord({
    recordNumber: 37,
    sequence: 2,
    attributes: [
      residentAttribute(0x10, standard, 0),
      nonresidentAttribute({
        id: 2,
        clusters: LOGICAL_CLUSTERS,
        dataSize: VIRTUAL_VOLUME_SIZE,
        initializedSize: 0,
        compressed: true,
      }),
    ],
  });
  oversizedRecord.copy(bytes, recordOffset(37));
}

class SparseVirtualProvider {
  constructor(prefix) {
    this.prefix = prefix;
    this.totalBytesRead = 0;
    this.maxRead = 0;
    this.info = {
      size: VIRTUAL_VOLUME_SIZE,
      sectorSize: geometry.bytesPerSector,
      sourceKind: 'volume-image',
      identity: 'oversized-compression-metadata-fixture',
    };
  }

  async read(offset, length) {
    this.totalBytesRead += length;
    this.maxRead = Math.max(this.maxRead, length);
    const output = Buffer.alloc(length);
    if (offset < this.prefix.length) {
      this.prefix.copy(output, 0, offset, Math.min(this.prefix.length, offset + length));
    }
    return output;
  }

  async assertUnchanged() {}
  async close() {}
}

async function isolated(callback) {
  const base = path.resolve(os.tmpdir());
  const root = await mkdtemp(path.join(base, 'recoverychat-ntfs-limits-'));
  try { await callback(root); } finally {
    const relative = path.relative(base, root);
    assert.ok(relative.startsWith('recoverychat-ntfs-limits-') && !relative.includes(path.sep));
    await rm(root, { recursive: true, force: true });
  }
}

test('oversized compressed metadata is typed unsupported before compression-unit allocation or large reads', async () => isolated(async root => {
  const fixture = await createFixture(path.join(root, 'fixture'));
  const bytes = await readFile(fixture.imagePath);
  installOversizedCompressedMetadata(bytes);
  const provider = new SparseVirtualProvider(bytes);
  const image = await openNtfsProvider(provider);
  try {
    const candidate = (await image.scanDeleted()).candidates.find(item => item.recordNumber === 37);
    assert.equal(candidate.status, 'unsupported');
    assert.ok(candidate.reasons.some(reason => reason.includes('65536')));
    assert.ok(provider.maxRead <= 1024 * 1024);
    assert.ok(provider.totalBytesRead < 4 * 1024 * 1024);
    await assert.rejects(image.recover(37, path.join(root, 'output')), { code: 'NOT_RECOVERABLE' });
  } finally { await image.close(); }
}));
