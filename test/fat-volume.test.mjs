import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openFatProvider } from '../engine/fat-volume.mjs';

class BufferProvider {
  constructor(bytes, sourceKind = 'synthetic-image') {
    this.bytes = bytes;
    this.original = createHash('sha256').update(bytes).digest('hex');
    this.info = { size: bytes.length, sectorSize: 512, sourceKind, identity: `fixture:${this.original}` };
    this.closed = false;
  }
  async read(offset, length, { signal } = {}) {
    if (signal?.aborted) { const error = new Error('cancelled'); error.code = 'CANCELLED'; throw error; }
    assert.ok(length <= 1024 * 1024); assert.ok(offset >= 0 && offset + length <= this.bytes.length);
    return Buffer.from(this.bytes.subarray(offset, offset + length));
  }
  async assertUnchanged() {
    assert.equal(createHash('sha256').update(this.bytes).digest('hex'), this.original);
  }
  async close() { this.closed = true; }
}

class StableDeviceMutableProvider extends BufferProvider {
  async assertUnchanged() {}
}

function fatEntry16(bytes, fatOffset, cluster, value) { bytes.writeUInt16LE(value, fatOffset + cluster * 2); }
function fatEntry32(bytes, fatOffset, cluster, value) { bytes.writeUInt32LE(value, fatOffset + cluster * 4); }
function fatEntry12(bytes, fatOffset, cluster, value) {
  const at = fatOffset + Math.floor(cluster * 3 / 2), pair = bytes.readUInt16LE(at);
  bytes.writeUInt16LE(cluster & 1 ? (pair & 0x000f) | ((value & 0x0fff) << 4) : (pair & 0xf000) | (value & 0x0fff), at);
}
function deletedShortEntry(target, name, cluster, size) {
  target.fill(0); Buffer.from(name.padEnd(11, ' '), 'ascii').copy(target, 0, 0, 11); target[0] = 0xe5; target[11] = 0x20;
  target.writeUInt16LE((cluster >>> 16) & 0xffff, 20); target.writeUInt16LE(cluster & 0xffff, 26); target.writeUInt32LE(size, 28);
  target.writeUInt16LE((2026 - 1980) << 9 | 9 << 5 | 12, 24);
}
function classicFixture(type = 'FAT16', { allocated = false, rootLoop = false, fats = 1, mirroringEnabled = true, activeFat = 0, mirrorConflict = false } = {}) {
  const bps = 512, spc = 1;
  const fat32 = type === 'FAT32', fat12 = type === 'FAT12';
  const clusters = fat32 ? 65530 : fat12 ? 100 : 5000;
  const reserved = fat32 ? 32 : 1, rootEntries = fat32 ? 0 : 32, rootSectors = Math.ceil(rootEntries * 32 / bps);
  const fatSectors = fat32 ? Math.ceil((clusters + 2) * 4 / bps) : fat12 ? 1 : Math.ceil((clusters + 2) * 2 / bps);
  const total = reserved + fats * fatSectors + rootSectors + clusters, bytes = Buffer.alloc(total * bps);
  bytes[0] = 0xeb; bytes[1] = 0x3c; bytes[2] = 0x90; Buffer.from('MSDOS5.0').copy(bytes, 3);
  bytes.writeUInt16LE(bps, 11); bytes[13] = spc; bytes.writeUInt16LE(reserved, 14); bytes[16] = fats; bytes.writeUInt16LE(rootEntries, 17);
  if (total <= 0xffff) bytes.writeUInt16LE(total, 19); else bytes.writeUInt32LE(total, 32);
  if (fat32) { bytes.writeUInt32LE(fatSectors, 36); bytes.writeUInt16LE(mirroringEnabled ? 0 : 0x80 | activeFat, 40); bytes.writeUInt32LE(2, 44); Buffer.from('FAT32   ').copy(bytes, 82); }
  else { bytes.writeUInt16LE(fatSectors, 22); Buffer.from(type.padEnd(8), 'ascii').copy(bytes, 54); }
  bytes.writeUInt16LE(0xaa55, 510);
  const fatOffsets = Array.from({ length: fats }, (_, index) => (reserved + index * fatSectors) * bps), fatOffset = fatOffsets[activeFat],
    rootOffset = (reserved + fats * fatSectors) * bps;
  for (const copyOffset of fatOffsets) {
    if (fat32) { fatEntry32(bytes, copyOffset, 0, 0x0ffffff8); fatEntry32(bytes, copyOffset, 1, 0x0fffffff); fatEntry32(bytes, copyOffset, 2, rootLoop ? 2 : 0x0fffffff); }
    else if (fat12) { bytes[copyOffset] = 0xf8; bytes[copyOffset + 1] = 0xff; bytes[copyOffset + 2] = 0xff; }
    else { fatEntry16(bytes, copyOffset, 0, 0xfff8); fatEntry16(bytes, copyOffset, 1, 0xffff); }
  }
  const firstDataSector = reserved + fats * fatSectors + rootSectors;
  const directoryOffset = fat32 ? firstDataSector * bps : rootOffset;
  const payload = Buffer.from(`${type} independently known original bytes`, 'utf8');
  deletedShortEntry(bytes.subarray(directoryOffset, directoryOffset + 32), 'TEST    TXT', 3, payload.length);
  const dataOffset = (firstDataSector + 1) * bps; payload.copy(bytes, dataOffset);
  const setEntry = (offset, value) => fat32 ? fatEntry32(bytes, offset, 3, value) : fat12 ? fatEntry12(bytes, offset, 3, value) : fatEntry16(bytes, offset, 3, value);
  if (allocated) setEntry(fatOffset, fat32 ? 0x0fffffff : fat12 ? 0x0fff : 0xffff);
  if (mirrorConflict) setEntry(fatOffsets[activeFat === 0 ? 1 : 0], fat32 ? 0x0fffffff : fat12 ? 0x0fff : 0xffff);
  return { bytes, payload, fatOffset, fatOffsets, directoryOffset };
}

function exfatChecksum(region) {
  let checksum = 0;
  for (let index = 0; index < 11 * 512; index++) {
    if (index === 106 || index === 107 || index === 112) continue;
    checksum = (((checksum & 1) ? 0x80000000 : 0) + (checksum >>> 1) + region[index]) >>> 0;
  }
  return checksum;
}
function setChecksum(set) {
  let checksum = 0;
  for (let index = 0; index < set.length; index++) {
    if (index === 2 || index === 3) continue;
    let value = set[index]; if (index % 32 === 0) value |= 0x80;
    checksum = ((((checksum & 1) ? 0x8000 : 0) + (checksum >>> 1) + value) & 0xffff);
  }
  return checksum;
}
function exfatFixture({ allocated = false, badChecksum = false, fats = 1, activeFat = 0, inactiveConflict = false, noFatChain = true } = {}) {
  const fatOffsetSector = 24, fatSectors = 2, heapSector = fatOffsetSector + fats * fatSectors, clusters = 128, sectors = heapSector + clusters;
  const bytes = Buffer.alloc(sectors * 512); bytes[0] = 0xeb; bytes[1] = 0x76; bytes[2] = 0x90; Buffer.from('EXFAT   ').copy(bytes, 3);
  bytes.writeBigUInt64LE(0n, 64); bytes.writeBigUInt64LE(BigInt(sectors), 72); bytes.writeUInt32LE(fatOffsetSector, 80); bytes.writeUInt32LE(fatSectors, 84);
  bytes.writeUInt32LE(heapSector, 88); bytes.writeUInt32LE(clusters, 92); bytes.writeUInt32LE(2, 96); bytes.writeUInt32LE(0x12345678, 100);
  bytes.writeUInt16LE(0x0100, 104); bytes.writeUInt16LE(activeFat, 106); bytes[108] = 9; bytes[109] = 0; bytes[110] = fats; bytes.writeUInt16LE(0xaa55, 510);
  const checksum = exfatChecksum(bytes); for (let at = 11 * 512; at < 12 * 512; at += 4) bytes.writeUInt32LE(badChecksum ? checksum ^ 1 : checksum, at);
  const fatOffsets = Array.from({ length: fats }, (_, index) => (fatOffsetSector + index * fatSectors) * 512), fatOffset = fatOffsets[activeFat];
  for (const copyOffset of fatOffsets) { fatEntry32(bytes, copyOffset, 0, 0xfffffff8); fatEntry32(bytes, copyOffset, 1, 0xffffffff); fatEntry32(bytes, copyOffset, 2, 0xffffffff); fatEntry32(bytes, copyOffset, 3, 0xffffffff); }
  if (inactiveConflict) fatEntry32(bytes, fatOffsets[activeFat === 0 ? 1 : 0], 2, 2);
  const root = heapSector * 512, bitmap = root + 512, file = root + 2 * 512;
  bytes[root] = 0x81; bytes[root + 1] = activeFat; bytes.writeUInt32LE(3, root + 20); bytes.writeBigUInt64LE(16n, root + 24);
  bytes[bitmap] = 0b00000011 | (allocated ? 0b00000100 : 0); // root and bitmap allocated; first file cluster is bit 2.
  const payload = Buffer.alloc(700); Buffer.from('exFAT independently known original bytes').copy(payload); payload.fill(0x5a, 44);
  payload.copy(bytes, file);
  const set = bytes.subarray(root + 32, root + 160), name = '삭제자료-복구-exfat.bin';
  set[0] = 0x05; set[1] = 3; set.writeUInt16LE(0x20, 4);
  set[32] = 0x40; set[33] = noFatChain ? 0x02 : 0; set[35] = name.length; set.writeBigUInt64LE(BigInt(payload.length), 40); set.writeUInt32LE(4, 52); set.writeBigUInt64LE(BigInt(payload.length), 56);
  set[64] = 0x41; Buffer.from(name.slice(0, 15), 'utf16le').copy(set, 66);
  set[96] = 0x41; Buffer.from(name.slice(15), 'utf16le').copy(set, 98); set.writeUInt16LE(setChecksum(set), 2);
  if (!noFatChain) { fatEntry32(bytes, fatOffset, 4, 5); fatEntry32(bytes, fatOffset, 5, 0xffffffff); fatEntry32(bytes, fatOffset, 6, 0xffffffff); }
  return { bytes, payload, setOffset: root + 32, bitmapOffset: bitmap, fatOffset };
}

function exfatBoundaryFixture() {
  const sectors = 158, fatOffsetSector = 24, fatSectors = 2, heapSector = 26, clusters = 132;
  const bytes = Buffer.alloc(sectors * 512); bytes[0] = 0xeb; bytes[1] = 0x76; bytes[2] = 0x90; Buffer.from('EXFAT   ').copy(bytes, 3);
  bytes.writeBigUInt64LE(BigInt(sectors), 72); bytes.writeUInt32LE(fatOffsetSector, 80); bytes.writeUInt32LE(fatSectors, 84);
  bytes.writeUInt32LE(heapSector, 88); bytes.writeUInt32LE(clusters, 92); bytes.writeUInt32LE(2, 96); bytes.writeUInt16LE(0x0100, 104);
  bytes[108] = 9; bytes[109] = 0; bytes[110] = 1; bytes.writeUInt16LE(0xaa55, 510);
  const checksum = exfatChecksum(bytes); for (let at = 11 * 512; at < 12 * 512; at += 4) bytes.writeUInt32LE(checksum, at);
  const fat = fatOffsetSector * 512; fatEntry32(bytes, fat, 0, 0xfffffff8); fatEntry32(bytes, fat, 1, 0xffffffff);
  fatEntry32(bytes, fat, 2, 4); fatEntry32(bytes, fat, 3, 0xffffffff); fatEntry32(bytes, fat, 4, 0xffffffff);
  const root = heapSector * 512, bitmap = root + 512, continuation = root + 2 * 512, file = root + 3 * 512;
  bytes[root] = 0x81; bytes.writeUInt32LE(3, root + 20); bytes.writeBigUInt64LE(17n, root + 24); bytes[bitmap] = 0b00000111;
  for (let at = 32; at < 480; at += 32) bytes[root + at] = 0x01;
  const name = 'boundary-entry.bin', payload = Buffer.alloc(700, 0x5c), set = Buffer.alloc(128);
  Buffer.from('cross-cluster exFAT record').copy(payload); set[0] = 0x05; set[1] = 3; set.writeUInt16LE(0x20, 4);
  set[32] = 0x40; set[33] = 0x02; set[35] = name.length; set.writeBigUInt64LE(BigInt(payload.length), 40); set.writeUInt32LE(5, 52); set.writeBigUInt64LE(BigInt(payload.length), 56);
  set[64] = 0x41; Buffer.from(name.slice(0, 15), 'utf16le').copy(set, 66); set[96] = 0x41; Buffer.from(name.slice(15), 'utf16le').copy(set, 98);
  set.writeUInt16LE(setChecksum(set), 2); set.subarray(0, 32).copy(bytes, root + 480); set.subarray(32).copy(bytes, continuation); payload.copy(bytes, file);
  return { bytes, payload };
}

class AggregateLimitProvider {
  constructor() {
    this.clusterCount = 4_300_000; this.fatSector = 24; this.fatSectors = Math.ceil((this.clusterCount + 2) * 4 / 512);
    this.heapSector = this.fatSector + this.fatSectors; this.sectors = this.heapSector + this.clusterCount;
    this.boot = Buffer.alloc(12 * 512); this.boot[0] = 0xeb; this.boot[1] = 0x76; this.boot[2] = 0x90; Buffer.from('EXFAT   ').copy(this.boot, 3);
    this.boot.writeBigUInt64LE(BigInt(this.sectors), 72); this.boot.writeUInt32LE(this.fatSector, 80); this.boot.writeUInt32LE(this.fatSectors, 84);
    this.boot.writeUInt32LE(this.heapSector, 88); this.boot.writeUInt32LE(this.clusterCount, 92); this.boot.writeUInt32LE(2, 96);
    this.boot.writeUInt16LE(0x0100, 104); this.boot[108] = 9; this.boot[109] = 0; this.boot[110] = 1; this.boot.writeUInt16LE(0xaa55, 510);
    const checksum = exfatChecksum(this.boot); for (let at = 11 * 512; at < 12 * 512; at += 4) this.boot.writeUInt32LE(checksum, at);
    this.bitmapLength = Math.ceil(this.clusterCount / 8); this.bitmapClusters = Math.ceil(this.bitmapLength / 512); this.root = Buffer.alloc(512);
    this.root[0] = 0x81; this.root.writeUInt32LE(3, 20); this.root.writeBigUInt64LE(BigInt(this.bitmapLength), 24);
    this.addFileSet(32, 'A', 1100, 2_100_000); this.addFileSet(128, 'B', 2_101_200, 2_100_000);
    this.info = { size: this.sectors * 512, sectorSize: 512, sourceKind: 'sparse-synthetic', identity: 'aggregate-cluster-limit' };
  }
  addFileSet(at, name, firstCluster, clusters) {
    const set = this.root.subarray(at, at + 96); set[0] = 0x05; set[1] = 2; set.writeUInt16LE(0x20, 4);
    set[32] = 0x40; set[33] = 0x02; set[35] = name.length; set.writeBigUInt64LE(BigInt(clusters * 512), 40);
    set.writeUInt32LE(firstCluster, 52); set.writeBigUInt64LE(BigInt(clusters * 512), 56); set[64] = 0x41; Buffer.from(name, 'utf16le').copy(set, 66);
    set.writeUInt16LE(setChecksum(set), 2);
  }
  async read(offset, length) {
    if (offset < this.boot.length) return Buffer.from(this.boot.subarray(offset, offset + length));
    const fatStart = this.fatSector * 512, fatEnd = fatStart + this.fatSectors * 512;
    if (offset >= fatStart && offset + length <= fatEnd) {
      const output = Buffer.alloc(length), bitmapLast = 3 + this.bitmapClusters - 1;
      for (let at = 0; at < length; at += 4) {
        const cluster = (offset - fatStart + at) / 4;
        const value = cluster === 2 || cluster === bitmapLast ? 0xffffffff : cluster >= 3 && cluster < bitmapLast ? cluster + 1 : 0;
        output.writeUInt32LE(value, at);
      }
      return output;
    }
    if (offset === this.heapSector * 512 && length === 512) return Buffer.from(this.root);
    return Buffer.alloc(length);
  }
  async assertUnchanged() {}
  async close() {}
}

async function isolated(callback) {
  const base = path.resolve(os.tmpdir()), root = await mkdtemp(path.join(base, 'recoverychat-fat-'));
  try { await callback(root); } finally {
    const relative = path.relative(base, root); assert.ok(relative.startsWith('recoverychat-fat-') && !relative.includes(path.sep)); await rm(root, { recursive: true, force: true });
  }
}

for (const type of ['FAT12', 'FAT16', 'FAT32']) test(`${type} finds and recovers a proven single free-cluster deleted file`, async () => isolated(async destination => {
  const fixture = classicFixture(type), volume = await openFatProvider(new BufferProvider(fixture.bytes));
  try {
    assert.equal(volume.info.fileSystem, type);
    const scan = await volume.scanDeleted(); assert.equal(scan.candidates.length, 1); assert.equal(scan.candidates[0].status, 'readable');
    assert.equal(scan.candidates[0].name, '?EST.TXT'); assert.equal(scan.candidates[0].deletedAt, null);
    assert.deepEqual(await volume.readCandidateBytes(scan.candidates[0].id), fixture.payload);
    const saved = await volume.recover(scan.candidates[0].id, destination);
    assert.equal(saved.originalIdentityVerified, false); assert.equal(saved.sha256, createHash('sha256').update(fixture.payload).digest('hex'));
    assert.deepEqual(await readFile(saved.path), fixture.payload);
  } finally { await volume.close(); }
}));

test('exFAT validates the inactive entry-set checksum and recovers a free NoFatChain extent', async () => isolated(async destination => {
  const fixture = exfatFixture(), volume = await openFatProvider(new BufferProvider(fixture.bytes));
  try {
    const scan = await volume.scanDeleted(); assert.equal(scan.complete, true); assert.equal(scan.candidates[0].name, '삭제자료-복구-exfat.bin');
    assert.equal(scan.candidates[0].status, 'readable'); assert.ok(scan.candidates[0].reasons.includes('NO_FAT_CHAIN_CONTIGUOUS_EXTENT'));
    assert.deepEqual(await volume.readCandidateBytes(0), fixture.payload);
    const saved = await volume.recover(0, destination); assert.deepEqual(await readFile(saved.path), fixture.payload);
    assert.equal(saved.sha256, createHash('sha256').update(fixture.payload).digest('hex'));
  } finally { await volume.close(); }
}));

test('exFAT rejects duplicate, reordered, and unsupported secondary entries even with valid checksums', async () => {
  const cases = [
    {
      name: 'duplicate stream', warning: 'UNSUPPORTED_ENTRY_SET_LAYOUT', mutate(set) {
        const original = Buffer.from(set.subarray(0, 128)); set.fill(0); original.copy(set); set[1] = 4; original.subarray(32, 64).copy(set, 128);
      }
    },
    {
      name: 'reordered stream', warning: 'MISSING_STREAM_ENTRY', mutate(set) {
        const stream = Buffer.from(set.subarray(32, 64)), firstName = Buffer.from(set.subarray(64, 96));
        firstName.copy(set, 32); stream.copy(set, 64);
      }
    },
    {
      name: 'unknown critical secondary', warning: 'UNSUPPORTED_ENTRY_SET_LAYOUT', mutate(set) {
        set[1] = 4; set[128] = 0x42;
      }
    }
  ];
  for (const item of cases) {
    const fixture = exfatFixture(), set = fixture.bytes.subarray(fixture.setOffset, fixture.setOffset + 160);
    item.mutate(set); set.writeUInt16LE(0, 2); set.writeUInt16LE(setChecksum(set.subarray(0, (set[1] + 1) * 32)), 2);
    const volume = await openFatProvider(new BufferProvider(fixture.bytes));
    try {
      const scan = await volume.scanDeleted();
      assert.equal(scan.candidates.length, 0, item.name); assert.ok(scan.warnings.some(warning => warning.code === item.warning), item.name);
    } finally { await volume.close(); }
  }
});

test('recovery rejects a changed ordered FAT chain before creating output on a stable device', async () => isolated(async root => {
  const fixture = exfatFixture({ noFatChain: false }), provider = new StableDeviceMutableProvider(fixture.bytes), volume = await openFatProvider(provider);
  const destination = path.join(root, 'before-copy');
  try {
    await volume.scanDeleted(); fatEntry32(provider.bytes, fixture.fatOffset, 4, 6);
    let caught; try { await volume.recover(0, destination); } catch (error) { caught = error; }
    assert.equal(caught?.code, 'SOURCE_CHANGED'); assert.equal(caught.details.partialPath, null); assert.equal(caught.details.savedPath, null);
    await assert.rejects(readdir(destination), { code: 'ENOENT' });
  } finally { await volume.close(); }
}));

test('recovery keeps only a private partial when the ordered FAT chain changes during copy', async () => isolated(async root => {
  const fixture = exfatFixture({ noFatChain: false }), provider = new StableDeviceMutableProvider(fixture.bytes), volume = await openFatProvider(provider);
  const destination = path.join(root, 'during-copy'); let mutated = false;
  try {
    await volume.scanDeleted(); let caught;
    try {
      await volume.recover(0, destination, { onProgress(progress) {
        if (!mutated && progress.bytesWritten === 512) { mutated = true; fatEntry32(provider.bytes, fixture.fatOffset, 4, 6); }
      } });
    } catch (error) { caught = error; }
    assert.equal(mutated, true); assert.equal(caught?.code, 'SOURCE_CHANGED'); assert.equal(caught.details.savedPath, null);
    assert.match(caught.details.partialPath, /\.recovery-writing\.partial$/);
    assert.equal((await readFile(caught.details.partialPath)).length, fixture.payload.length);
    assert.deepEqual(await readdir(path.dirname(caught.details.partialPath)), ['.recovery-writing.partial']);
    const destinationEntries = await readdir(destination); assert.equal(destinationEntries.length, 1); assert.match(destinationEntries[0], /^\.recovery-working-/);
  } finally { await volume.close(); }
}));

test('allocated clusters are conflicts and are never recovered', async () => {
  for (const fixture of [classicFixture('FAT16', { allocated: true }), exfatFixture({ allocated: true })]) {
    const volume = await openFatProvider(new BufferProvider(fixture.bytes));
    try { const scan = await volume.scanDeleted(); assert.equal(scan.candidates[0].status, 'conflict'); await assert.rejects(volume.recover(0, os.tmpdir()), { code: 'NOT_RECOVERABLE' }); }
    finally { await volume.close(); }
  }
});

test('multi-cluster classic FAT files with cleared links refuse the contiguous heuristic', async () => {
  const fixture = classicFixture('FAT16'); fixture.bytes.writeUInt32LE(700, fixture.directoryOffset + 28);
  const provider = new BufferProvider(fixture.bytes), volume = await openFatProvider(provider);
  try { const scan = await volume.scanDeleted(); assert.equal(scan.candidates[0].status, 'unsupported'); assert.ok(scan.candidates[0].reasons.includes('CONTIGUOUS_HEURISTIC_REFUSED')); }
  finally { await volume.close(); }
});

test('bad boot bounds, exFAT boot checksum, and FAT32 directory loops are contained', async () => {
  const badBounds = classicFixture('FAT16'); badBounds.bytes.writeUInt16LE(0xffff, 19);
  await assert.rejects(openFatProvider(new BufferProvider(badBounds.bytes)), { code: 'INVALID_BOOT' });
  await assert.rejects(openFatProvider(new BufferProvider(exfatFixture({ badChecksum: true }).bytes)), { code: 'INVALID_BOOT_CHECKSUM' });
  const looped = classicFixture('FAT32', { rootLoop: true }), volume = await openFatProvider(new BufferProvider(looped.bytes));
  try { const scan = await volume.scanDeleted(); assert.equal(scan.complete, false); assert.ok(scan.warnings.some(warning => warning.code === 'CHAIN_LOOP')); }
  finally { await volume.close(); }
});

test('cancellation during a two-cluster recovery preserves only a private partial file', async () => isolated(async destination => {
  const fixture = exfatFixture(), volume = await openFatProvider(new BufferProvider(fixture.bytes)), controller = new AbortController();
  try {
    await volume.scanDeleted(); let caught;
    try { await volume.recover(0, destination, { signal: controller.signal, onProgress: () => controller.abort() }); } catch (error) { caught = error; }
    assert.equal(caught?.code, 'CANCELLED'); assert.equal(caught.details.savedPath, null); assert.match(caught.details.partialPath, /\.recovery-writing\.partial$/);
  } finally { await volume.close(); }
}));

test('mirrored classic FAT disagreements never produce readable deleted candidates', async () => {
  for (const type of ['FAT12', 'FAT16', 'FAT32']) {
    const fixture = classicFixture(type, { fats: 2, mirrorConflict: true }), volume = await openFatProvider(new BufferProvider(fixture.bytes));
    try {
      const scan = await volume.scanDeleted(); assert.equal(scan.candidates.length, 1); assert.equal(scan.candidates[0].status, 'unsupported');
      assert.ok(scan.candidates[0].reasons.includes('FAT_MIRROR_MISMATCH'));
    } finally { await volume.close(); }
  }
});

test('FAT32 with mirroring disabled obeys only the selected active FAT', async () => {
  const fixture = classicFixture('FAT32', { fats: 2, mirroringEnabled: false, activeFat: 1, mirrorConflict: true });
  const volume = await openFatProvider(new BufferProvider(fixture.bytes));
  try { const scan = await volume.scanDeleted(); assert.equal(scan.candidates[0].status, 'readable'); }
  finally { await volume.close(); }
});

test('exFAT two-FAT mode obeys its selected active FAT without mirror comparison', async () => {
  const fixture = exfatFixture({ fats: 2, activeFat: 1, inactiveConflict: true }), volume = await openFatProvider(new BufferProvider(fixture.bytes));
  try { const scan = await volume.scanDeleted(); assert.equal(scan.complete, true); assert.equal(scan.candidates[0].status, 'readable'); }
  finally { await volume.close(); }
});

test('exFAT entry sets spanning adjacent directory clusters are recovered', async () => isolated(async destination => {
  const fixture = exfatBoundaryFixture(), volume = await openFatProvider(new BufferProvider(fixture.bytes));
  try {
    const scan = await volume.scanDeleted(); assert.equal(scan.complete, true); assert.equal(scan.candidates.length, 1); assert.equal(scan.candidates[0].name, 'boundary-entry.bin');
    const saved = await volume.recover(scan.candidates[0].id, destination); assert.deepEqual(await readFile(saved.path), fixture.payload);
  } finally { await volume.close(); }
}));

test('aggregate remembered-cluster cap yields an immutable unsupported candidate instead of throwing', async () => {
  const volume = await openFatProvider(new AggregateLimitProvider());
  try {
    const scan = await volume.scanDeleted({ maxCandidates: 10 }); assert.equal(scan.candidates.length, 2);
    assert.deepEqual(scan.candidates.map(candidate => candidate.status), ['readable', 'unsupported']);
    assert.ok(scan.candidates[1].reasons.includes('SCAN_METADATA_LIMIT')); assert.ok(Object.isFrozen(scan.candidates[1])); assert.ok(Object.isFrozen(scan.candidates[1].reasons));
  } finally { await volume.close(); }
});
