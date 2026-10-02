import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createFixture } from './ntfs-fixtures.mjs';
import { crc32, discoverVolumes, getUnallocatedRanges, openPartitionBytes } from '../engine/volume-layout.mjs';

class BufferProvider {
  constructor(bytes, sourceKind = 'synthetic-image') {
    this.bytes = bytes; this.closed = false; this.closeCount = 0;
    this.original = createHash('sha256').update(bytes).digest('hex');
    this.info = { size: bytes.length, sectorSize: 512, sourceKind, identity: `fixture:${this.original}` };
  }
  async read(offset, length, { signal } = {}) {
    if (signal?.aborted) { const error = new Error('cancelled'); error.code = 'CANCELLED'; throw error; }
    assert.ok(length <= 1024 * 1024 && offset >= 0 && offset + length <= this.bytes.length);
    return Buffer.from(this.bytes.subarray(offset, offset + length));
  }
  async assertUnchanged() { assert.equal(createHash('sha256').update(this.bytes).digest('hex'), this.original); }
  async close() { this.closeCount++; this.closed = true; }
}

function classicFat(kind = 'FAT12', { fats = 1, mirroringEnabled = true, activeFat = 0, mirrorConflict = false } = {}) {
  const bps = 512, fat32 = kind === 'FAT32', fat12 = kind === 'FAT12', clusters = fat32 ? 65530 : kind === 'FAT16' ? 5000 : 100,
    rootEntries = fat32 ? 0 : 32, reserved = fat32 ? 32 : 1;
  const fatSectors = fat32 ? Math.ceil((clusters + 2) * 4 / bps) : kind === 'FAT16' ? Math.ceil((clusters + 2) * 2 / bps) : 1,
    rootSectors = Math.ceil(rootEntries * 32 / bps), total = reserved + fats * fatSectors + rootSectors + clusters;
  const bytes = Buffer.alloc(total * bps); bytes[0] = 0xeb; bytes[1] = 0x3c; bytes[2] = 0x90; Buffer.from('MSDOS5.0').copy(bytes, 3);
  bytes.writeUInt16LE(bps, 11); bytes[13] = 1; bytes.writeUInt16LE(reserved, 14); bytes[16] = fats; bytes.writeUInt16LE(rootEntries, 17);
  if (total <= 0xffff) bytes.writeUInt16LE(total, 19); else bytes.writeUInt32LE(total, 32); bytes[21] = 0xf8;
  if (fat32) { bytes.writeUInt32LE(fatSectors, 36); bytes.writeUInt16LE(mirroringEnabled ? 0 : 0x80 | activeFat, 40); bytes.writeUInt32LE(2, 44); }
  else bytes.writeUInt16LE(fatSectors, 22); bytes.writeUInt16LE(0xaa55, 510);
  const fatOffsets = Array.from({ length: fats }, (_, index) => (reserved + index * fatSectors) * bps);
  for (const fatOffset of fatOffsets) {
    if (fat12) { bytes[fatOffset] = 0xf8; bytes[fatOffset + 1] = 0xff; bytes[fatOffset + 2] = 0xff; }
    else if (fat32) { bytes.writeUInt32LE(0x0ffffff8, fatOffset); bytes.writeUInt32LE(0x0fffffff, fatOffset + 4); bytes.writeUInt32LE(0x0fffffff, fatOffset + 8); }
    else { bytes.writeUInt16LE(0xfff8, fatOffset); bytes.writeUInt16LE(0xffff, fatOffset + 2); }
  }
  const conflicting = fatOffsets[activeFat === 0 ? 1 : 0];
  if (mirrorConflict) {
    if (fat12) bytes.writeUInt16LE(0xfff0, conflicting + 4);
    else if (fat32) bytes.writeUInt32LE(0x0fffffff, conflicting + 12);
    else bytes.writeUInt16LE(0xffff, conflicting + 6);
  }
  const firstDataOffset = (reserved + fats * fatSectors + rootSectors) * bps;
  return { bytes, firstDataOffset, firstCandidateOffset: firstDataOffset + (fat32 ? 512 : 0), clusters };
}
function exfatImage({ fats = 1, activeFat = 0, inactiveConflict = false } = {}) {
  const fatSector = 24, fatSectors = 2, heapSector = fatSector + fats * fatSectors, clusters = 128, sectors = heapSector + clusters, bytes = Buffer.alloc(sectors * 512);
  bytes[0] = 0xeb; bytes[1] = 0x76; bytes[2] = 0x90; Buffer.from('EXFAT   ').copy(bytes, 3); bytes.writeBigUInt64LE(BigInt(sectors), 72);
  bytes.writeUInt32LE(fatSector, 80); bytes.writeUInt32LE(fatSectors, 84); bytes.writeUInt32LE(heapSector, 88); bytes.writeUInt32LE(clusters, 92); bytes.writeUInt32LE(2, 96);
  bytes.writeUInt16LE(0x100, 104); bytes.writeUInt16LE(activeFat, 106); bytes[108] = 9; bytes[109] = 0; bytes[110] = fats; bytes.writeUInt16LE(0xaa55, 510);
  let checksum = 0; for (let index = 0; index < 11 * 512; index++) { if ([106, 107, 112].includes(index)) continue; checksum = (((checksum & 1) ? 0x80000000 : 0) + (checksum >>> 1) + bytes[index]) >>> 0; }
  for (let at = 11 * 512; at < 12 * 512; at += 4) bytes.writeUInt32LE(checksum, at);
  const fatOffsets = Array.from({ length: fats }, (_, index) => (fatSector + index * fatSectors) * 512);
  for (const fat of fatOffsets) { bytes.writeUInt32LE(0xfffffff8, fat); bytes.writeUInt32LE(0xffffffff, fat + 4); bytes.writeUInt32LE(0xffffffff, fat + 8); bytes.writeUInt32LE(0xffffffff, fat + 12); }
  if (inactiveConflict) bytes.writeUInt32LE(2, fatOffsets[activeFat === 0 ? 1 : 0] + 8);
  const root = heapSector * 512, bitmap = root + 512; bytes[root] = 0x81; bytes[root + 1] = activeFat; bytes.writeUInt32LE(3, root + 20); bytes.writeBigUInt64LE(16n, root + 24); bytes[bitmap] = 0b11;
  return { bytes, firstFreeOffset: heapSector * 512 + 2 * 512, freeLength: 126 * 512 };
}
function mbrDisk(parts) {
  const last = Math.max(...parts.map(part => part.start + Math.ceil(part.bytes.length / 512))), disk = Buffer.alloc((last + 128) * 512); disk.writeUInt16LE(0xaa55, 510);
  parts.forEach((part, index) => { const at = 446 + index * 16; disk[at + 4] = part.type ?? 0x06; disk.writeUInt32LE(part.start, at + 8); disk.writeUInt32LE(Math.ceil(part.bytes.length / 512), at + 12); part.bytes.copy(disk, part.start * 512); });
  return disk;
}
function writeGuid(buffer, offset, text) {
  const [a, b, c, d, e] = text.split('-'); buffer.writeUInt32LE(Number.parseInt(a, 16), offset); buffer.writeUInt16LE(Number.parseInt(b, 16), offset + 4); buffer.writeUInt16LE(Number.parseInt(c, 16), offset + 6);
  Buffer.from(d + e, 'hex').copy(buffer, offset + 8);
}
function gptDisk(partitionBytes) {
  const sectors = 10000, disk = Buffer.alloc(sectors * 512), entries = Buffer.alloc(128 * 128), start = 2048, partitionSectors = Math.ceil(partitionBytes.length / 512), end = start + partitionSectors - 1;
  disk.writeUInt16LE(0xaa55, 510); disk[450] = 0xee; disk.writeUInt32LE(1, 454); disk.writeUInt32LE(sectors - 1, 458);
  writeGuid(entries, 0, 'ebd0a0a2-b9e5-4433-87c0-68b6b72699c7'); writeGuid(entries, 16, '11111111-2222-3333-4444-555555555555'); entries.writeBigUInt64LE(BigInt(start), 32); entries.writeBigUInt64LE(BigInt(end), 40);
  const arrayCrc = crc32(entries), diskGuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'; entries.copy(disk, 2 * 512); entries.copy(disk, (sectors - 33) * 512); partitionBytes.copy(disk, start * 512);
  const header = (my, alternate, entriesLba) => {
    const h = Buffer.alloc(512); Buffer.from('EFI PART').copy(h); h.writeUInt32LE(0x10000, 8); h.writeUInt32LE(92, 12); h.writeBigUInt64LE(BigInt(my), 24); h.writeBigUInt64LE(BigInt(alternate), 32);
    h.writeBigUInt64LE(34n, 40); h.writeBigUInt64LE(BigInt(sectors - 34), 48); writeGuid(h, 56, diskGuid); h.writeBigUInt64LE(BigInt(entriesLba), 72); h.writeUInt32LE(128, 80); h.writeUInt32LE(128, 84); h.writeUInt32LE(arrayCrc, 88);
    const copy = Buffer.from(h.subarray(0, 92)); copy.writeUInt32LE(0, 16); h.writeUInt32LE(crc32(copy), 16); return h;
  };
  header(1, sectors - 1, 2).copy(disk, 512); header(sectors - 1, 1, sectors - 33).copy(disk, (sectors - 1) * 512); return disk;
}
async function isolated(callback) {
  const base = path.resolve(os.tmpdir()), root = await mkdtemp(path.join(base, 'recoverychat-layout-'));
  try { await callback(root); } finally { const relative = path.relative(base, root); assert.ok(relative.startsWith('recoverychat-layout-') && !relative.includes(path.sep)); await rm(root, { recursive: true, force: true }); }
}

test('a standalone FAT volume is discovered without inventing a partition table', async () => {
  const provider = new BufferProvider(classicFat('FAT16').bytes), result = await discoverVolumes(provider);
  assert.equal(result.scheme, 'volume'); assert.equal(result.volumes.length, 1); assert.equal(result.volumes[0].bootKind, 'FAT16'); assert.equal(result.volumes[0].offset, 0); assert.equal(result.volumes[0].trusted, true);
});

test('MBR partitions are bounded and sibling child providers close independently', async () => {
  const first = classicFat('FAT12'), second = classicFat('FAT16'), provider = new BufferProvider(mbrDisk([{ start: 128, bytes: first.bytes, type: 1 }, { start: 512, bytes: second.bytes, type: 6 }]));
  const result = await discoverVolumes(provider); assert.equal(result.scheme, 'mbr'); assert.equal(result.volumes.length, 2);
  const childA = openPartitionBytes(provider, structuredClone(result.volumes[0])), childB = openPartitionBytes(provider, result.volumes[1]); await childA.close();
  assert.equal((await childB.read(3, 8)).toString('ascii'), 'MSDOS5.0'); assert.equal(provider.closeCount, 0); await childB.close(); assert.equal(provider.closeCount, 0);
});

test('GPT primary and backup headers and entry arrays are CRC-checked', async () => {
  const disk = gptDisk(classicFat('FAT12').bytes), provider = new BufferProvider(disk), result = await discoverVolumes(provider);
  assert.equal(result.scheme, 'gpt'); assert.equal(result.volumes.length, 1); assert.equal(result.volumes[0].bootKind, 'FAT12');
  const corruptHeader = Buffer.from(disk); corruptHeader[512 + 24] ^= 1; await assert.rejects(discoverVolumes(new BufferProvider(corruptHeader)), { code: 'INVALID_GPT_CRC' });
  const corruptArray = Buffer.from(disk); corruptArray[2 * 512 + 40] ^= 1; await assert.rejects(discoverVolumes(new BufferProvider(corruptArray)), { code: 'INVALID_GPT_ARRAY_CRC' });
  const corruptBackup = Buffer.from(disk); corruptBackup[(10000 - 33) * 512 + 40] ^= 1; await assert.rejects(discoverVolumes(new BufferProvider(corruptBackup)), { code: 'INVALID_GPT_BACKUP_ARRAY' });
});

test('lost-table boot search is bounded, opt-in, untrusted, and not directly openable', async () => {
  const volume = classicFat('FAT12').bytes, disk = Buffer.alloc(1024 * 1024); volume.copy(disk, 128 * 512); const provider = new BufferProvider(disk);
  const ordinary = await discoverVolumes(provider); assert.equal(ordinary.recoveryCandidates.length, 0);
  const searched = await discoverVolumes(provider, { searchEmbeddedBoot: { maxBytes: 1024 * 1024 } }); assert.equal(searched.recoveryCandidates.length, 1); assert.equal(searched.recoveryCandidates[0].trusted, false);
  assert.throws(() => openPartitionBytes(provider, searched.recoveryCandidates[0]), { code: 'UNTRUSTED_PARTITION' });
});

test('FAT16 and exFAT allocation metadata produce exact coalesced free ranges', async () => {
  const fat = classicFat('FAT16'), fatResult = await getUnallocatedRanges(new BufferProvider(fat.bytes)); assert.equal(fatResult.supported, true); assert.deepEqual(fatResult.ranges, [{ offset: fat.firstDataOffset, length: fat.clusters * 512 }]);
  const exfat = exfatImage(), exfatResult = await getUnallocatedRanges(new BufferProvider(exfat.bytes)); assert.equal(exfatResult.supported, true); assert.deepEqual(exfatResult.ranges, [{ offset: exfat.firstFreeOffset, length: exfat.freeLength }]);
});

test('NTFS unallocated ranges come from the existing validated $Bitmap interface', async () => isolated(async root => {
  const fixture = await createFixture(path.join(root, 'fixture')), bytes = await readFile(fixture.imagePath), result = await getUnallocatedRanges(new BufferProvider(bytes));
  assert.equal(result.supported, true); assert.equal(result.fileSystem, 'NTFS'); assert.equal(result.complete, true); assert.ok(result.ranges.length > 0); assert.equal(result.requiresWholeSourceChoice, false);
}));

test('invalid MBR bounds fail closed and cancellation stops embedded search', async () => {
  const disk = Buffer.alloc(4096); disk.writeUInt16LE(0xaa55, 510); disk[450] = 6; disk.writeUInt32LE(7, 454); disk.writeUInt32LE(100, 458);
  await assert.rejects(discoverVolumes(new BufferProvider(disk)), { code: 'INVALID_PARTITION_BOUNDS' });
  const controller = new AbortController(); controller.abort(); await assert.rejects(discoverVolumes(new BufferProvider(Buffer.alloc(4096)), { searchEmbeddedBoot: true, signal: controller.signal }), { code: 'CANCELLED' });
});

test('unknown allocation metadata returns no partial ranges and requires a whole-source choice', async () => {
  const result = await getUnallocatedRanges(new BufferProvider(Buffer.alloc(4096)));
  assert.deepEqual(result, { supported: false, ranges: [], fileSystem: null, complete: false, reason: 'UNSUPPORTED_FILE_SYSTEM', requiresWholeSourceChoice: true });
});

test('mirrored FAT disagreements return no verified unallocated ranges', async () => {
  for (const kind of ['FAT12', 'FAT16', 'FAT32']) {
    const fixture = classicFat(kind, { fats: 2, mirrorConflict: true }), result = await getUnallocatedRanges(new BufferProvider(fixture.bytes));
    assert.deepEqual(result.ranges, []); assert.equal(result.supported, false); assert.equal(result.complete, false); assert.equal(result.reason, 'FAT_MIRROR_MISMATCH');
  }
});

test('FAT32 non-mirrored mode reads only its selected active FAT', async () => {
  const fixture = classicFat('FAT32', { fats: 2, mirroringEnabled: false, activeFat: 1, mirrorConflict: true });
  const result = await getUnallocatedRanges(new BufferProvider(fixture.bytes));
  assert.equal(result.supported, true); assert.equal(result.complete, true);
  assert.ok(result.ranges.some(range => range.offset <= fixture.firstCandidateOffset && fixture.firstCandidateOffset < range.offset + range.length));
});

test('exFAT two-FAT mode follows only the volume-flag-selected active FAT', async () => {
  const fixture = exfatImage({ fats: 2, activeFat: 1, inactiveConflict: true }), result = await getUnallocatedRanges(new BufferProvider(fixture.bytes));
  assert.equal(result.supported, true); assert.equal(result.complete, true); assert.equal(result.fileSystem, 'exFAT');
  assert.deepEqual(result.ranges, [{ offset: fixture.firstFreeOffset, length: fixture.freeLength }]);
});
