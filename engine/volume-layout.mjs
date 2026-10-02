import { createHash } from 'node:crypto';
import { openNtfsProvider } from './ntfs-image.mjs';

const MAX_READ = 1024 * 1024;
const MAX_GPT_ARRAY = 32 * 1024 * 1024;
const MAX_GPT_ENTRIES = 16384;
const MAX_RANGES = 1_000_000;
const DEFAULT_SEARCH = 64 * 1024 * 1024;
const approved = new WeakMap();

export class VolumeLayoutError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'VolumeLayoutError'; this.code = code; this.details = details; }
}
function requireValue(value, code, message) { if (!value) throw new VolumeLayoutError(code, message); }
function cancelled(signal) { if (signal?.aborted) throw new VolumeLayoutError('CANCELLED', '작업을 취소했어요.'); }
function power2(value) { return value > 0 && (value & (value - 1)) === 0; }
function number64(buffer, offset, label) {
  const value = buffer.readBigUInt64LE(offset); requireValue(value <= BigInt(Number.MAX_SAFE_INTEGER), 'INVALID_LAYOUT', `${label} 값이 안전한 범위를 넘어요.`); return Number(value);
}
function inRange(offset, length, size, code = 'OUT_OF_BOUNDS') {
  requireValue(Number.isSafeInteger(offset) && Number.isSafeInteger(length) && offset >= 0 && length >= 0 && offset <= size - length, code, '읽기 범위가 공급자 경계를 벗어났어요.');
}
async function read(provider, offset, length, signal) {
  cancelled(signal); inRange(offset, length, provider.info.size); requireValue(length <= MAX_READ, 'READ_LIMIT', '한 번에 읽는 범위가 1 MiB를 넘어요.');
  const bytes = await provider.read(offset, length, { signal }); requireValue(Buffer.isBuffer(bytes) && bytes.length === length, 'READ_FAILED', '공급자가 요청한 바이트를 모두 반환하지 않았어요.'); return bytes;
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  return table;
})();
export function crc32(buffer) { let crc = 0xffffffff; for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }

function exfatChecksum(region, sectorSize) {
  let sum = 0;
  for (let index = 0; index < 11 * sectorSize; index++) {
    if (index === 106 || index === 107 || index === 112) continue;
    sum = (((sum & 1) ? 0x80000000 : 0) + (sum >>> 1) + region[index]) >>> 0;
  }
  return sum;
}
function validateClassicBoot(boot, available) {
  if (boot.length < 512 || boot.readUInt16LE(510) !== 0xaa55) return null;
  const bps = boot.readUInt16LE(11), spc = boot[13], reserved = boot.readUInt16LE(14), fats = boot[16], rootEntries = boot.readUInt16LE(17);
  const total = boot.readUInt16LE(19) || boot.readUInt32LE(32), fatSectors = boot.readUInt16LE(22) || boot.readUInt32LE(36);
  const jumpValid = boot[0] === 0xe9 || (boot[0] === 0xeb && boot[2] === 0x90), media = boot[21];
  if (!jumpValid || media < 0xf0 || !power2(bps) || bps < 512 || bps > 4096 || !power2(spc) || spc > 128 || reserved < 1 || ![1, 2].includes(fats) || !total || !fatSectors) return null;
  const rootSectors = Math.ceil(rootEntries * 32 / bps), firstData = reserved + fats * fatSectors + rootSectors;
  if (firstData >= total || total * bps > available) return null;
  const clusters = Math.floor((total - firstData) / spc), kind = clusters < 4085 ? 'FAT12' : clusters < 65525 ? 'FAT16' : 'FAT32';
  const capacity = Math.floor(fatSectors * bps * 8 / ({ FAT12: 12, FAT16: 16, FAT32: 32 }[kind]));
  if (clusters < 1 || capacity < clusters + 2 || (kind === 'FAT32' ? rootEntries !== 0 || boot.readUInt16LE(22) !== 0 || boot.readUInt16LE(42) !== 0 : rootEntries === 0 || boot.readUInt16LE(22) === 0)) return null;
  let activeFat = 0, mirroringEnabled = kind !== 'FAT32';
  if (kind === 'FAT32') {
    const flags = boot.readUInt16LE(40); mirroringEnabled = !(flags & 0x80); if (!mirroringEnabled) activeFat = flags & 15;
  }
  if (activeFat >= fats) return null;
  const rootCluster = kind === 'FAT32' ? boot.readUInt32LE(44) & 0x0fffffff : 0;
  if (kind === 'FAT32' && (rootCluster < 2 || rootCluster >= clusters + 2)) return null;
  return { bootKind: kind, volumeSize: total * bps, sectorSize: bps, clusterSize: bps * spc, sectorsPerCluster: spc, clusterCount: clusters,
    fats, activeFat, mirroringEnabled, fatBaseOffset: reserved * bps,
    fatOffset: (reserved + activeFat * fatSectors) * bps, fatSectors, firstDataOffset: firstData * bps, rootCluster, media };
}
async function validateBoot(provider, offset, available, signal) {
  if (available < 512) return null;
  const boot = await read(provider, offset, 512, signal), oem = boot.subarray(3, 11).toString('ascii');
  if (oem === 'NTFS    ') {
    const bps = boot.readUInt16LE(11), spc = boot[13], total = number64(boot, 40, 'NTFS 볼륨 섹터'), mft = number64(boot, 48, 'NTFS MFT 클러스터');
    if (boot.readUInt16LE(510) !== 0xaa55 || !power2(bps) || bps < 512 || bps > 4096 || !power2(spc) || spc > 128 || !total || total * bps > available || mft >= Math.floor(total / spc)) return null;
    return { bootKind: 'NTFS', volumeSize: total * bps, sectorSize: bps, clusterSize: bps * spc };
  }
  if (oem === 'EXFAT   ') {
    const sectorShift = boot[108], clusterShift = boot[109];
    if (sectorShift < 9 || sectorShift > 12 || clusterShift > 25 - sectorShift) return null;
    const bps = 2 ** sectorShift; if (available < 12 * bps) return null;
    const region = await read(provider, offset, 12 * bps, signal);
    if (region.readUInt16LE(510) !== 0xaa55 || !region.subarray(11, 64).every(byte => byte === 0)) return null;
    const total = number64(region, 72, 'exFAT 볼륨 섹터'), fatOffset = region.readUInt32LE(80), fatLength = region.readUInt32LE(84), heap = region.readUInt32LE(88), clusters = region.readUInt32LE(92), root = region.readUInt32LE(96), fats = region[110];
    if (![1, 2].includes(fats) || total * bps > available || fatOffset < 24 || !fatLength || heap < fatOffset + fats * fatLength || !clusters || root < 2 || root >= clusters + 2 || heap + clusters * 2 ** clusterShift > total) return null;
    const expected = exfatChecksum(region, bps); for (let at = 11 * bps; at < 12 * bps; at += 4) if (region.readUInt32LE(at) !== expected) return null;
    const activeFat = fats === 2 ? region.readUInt16LE(106) & 1 : 0;
    return { bootKind: 'exFAT', volumeSize: total * bps, sectorSize: bps, clusterSize: bps * 2 ** clusterShift, sectorsPerCluster: 2 ** clusterShift,
      clusterCount: clusters, fatOffset: (fatOffset + activeFat * fatLength) * bps, fatSectors: fatLength, heapOffset: heap * bps, rootCluster: root, activeFat };
  }
  const classic = validateClassicBoot(boot, available);
  if (!classic || (await read(provider, offset + classic.fatOffset, 1, signal))[0] !== classic.media) return null;
  return classic;
}

function guid(buffer, offset) {
  const p1 = buffer.readUInt32LE(offset).toString(16).padStart(8, '0'), p2 = buffer.readUInt16LE(offset + 4).toString(16).padStart(4, '0'), p3 = buffer.readUInt16LE(offset + 6).toString(16).padStart(4, '0');
  return `${p1}-${p2}-${p3}-${buffer.subarray(offset + 8, offset + 10).toString('hex')}-${buffer.subarray(offset + 10, offset + 16).toString('hex')}`;
}
function identity(parent, offset, size, type) { return `partition:${createHash('sha256').update(JSON.stringify([parent.info.identity, offset, size, type])).digest('hex')}`; }
function descriptor(parent, values) {
  return Object.freeze({ ...values, id: identity(parent, values.offset, values.size, values.partitionType), identity: identity(parent, values.offset, values.size, values.partitionType) });
}
async function readLarge(provider, offset, length, signal, onProgress) {
  const chunks = []; let done = 0;
  while (done < length) { const count = Math.min(MAX_READ, length - done); chunks.push(await read(provider, offset + done, count, signal)); done += count; onProgress?.({ stage: 'layout', bytesRead: done, bytesTotal: length }); }
  return Buffer.concat(chunks);
}
function validateGptHeader(header, sectorSize, expectedLba, totalLbas) {
  requireValue(header.subarray(0, 8).toString('ascii') === 'EFI PART', 'INVALID_GPT', 'GPT 헤더 서명이 없어요.');
  const headerSize = header.readUInt32LE(12), stored = header.readUInt32LE(16);
  requireValue(header.readUInt32LE(8) === 0x00010000 && headerSize >= 92 && headerSize <= sectorSize && header.readUInt32LE(20) === 0, 'INVALID_GPT', 'GPT 헤더 버전 또는 크기가 잘못됐어요.');
  const copy = Buffer.from(header.subarray(0, headerSize)); copy.writeUInt32LE(0, 16); requireValue(crc32(copy) === stored, 'INVALID_GPT_CRC', 'GPT 헤더 CRC32가 맞지 않아요.');
  const my = number64(header, 24, 'GPT 현재 LBA'), alternate = number64(header, 32, 'GPT 백업 LBA'), first = number64(header, 40, 'GPT 첫 사용 LBA'), last = number64(header, 48, 'GPT 마지막 사용 LBA');
  const entriesLba = number64(header, 72, 'GPT 엔트리 LBA'), count = header.readUInt32LE(80), entrySize = header.readUInt32LE(84);
  requireValue(my === expectedLba && alternate < totalLbas && alternate !== my && first <= last && last < totalLbas && count > 0 && count <= MAX_GPT_ENTRIES && entrySize >= 128 && entrySize % 128 === 0 && power2(entrySize / 128), 'INVALID_GPT', 'GPT LBA 또는 엔트리 규격이 잘못됐어요.');
  const arrayBytes = count * entrySize; requireValue(Number.isSafeInteger(arrayBytes) && arrayBytes <= MAX_GPT_ARRAY && entriesLba < totalLbas && entriesLba * sectorSize <= totalLbas * sectorSize - arrayBytes, 'INVALID_GPT', 'GPT 엔트리 배열 범위가 잘못됐어요.');
  return { my, alternate, first, last, entriesLba, count, entrySize, arrayBytes, arrayCrc: header.readUInt32LE(88), diskGuid: guid(header, 56) };
}

async function inspectPartitions(provider, entries, scheme, signal, warnings) {
  const volumes = [], intervals = [];
  for (const entry of entries) {
    if (entry.size <= 0 || entry.offset < 0 || entry.offset > provider.info.size - entry.size) throw new VolumeLayoutError('INVALID_PARTITION_BOUNDS', '파티션이 디스크 범위를 벗어났어요.');
    if (intervals.some(other => entry.offset < other.end && other.start < entry.offset + entry.size)) throw new VolumeLayoutError('OVERLAPPING_PARTITIONS', '파티션 범위가 서로 겹쳐요.');
    intervals.push({ start: entry.offset, end: entry.offset + entry.size });
    const boot = await validateBoot(provider, entry.offset, entry.size, signal);
    if (!boot) { warnings.push({ code: 'UNSUPPORTED_PARTITION', index: entry.index, partitionType: entry.partitionType }); continue; }
    volumes.push(descriptor(provider, { index: entry.index, offset: entry.offset, size: entry.size, sectorSize: boot.sectorSize, scheme, partitionType: entry.partitionType,
      bootKind: boot.bootKind, trusted: true, volumeSize: boot.volumeSize }));
  }
  return volumes;
}

async function embeddedSearch(provider, options, known, signal, control, onProgress) {
  if (!options.searchEmbeddedBoot) return [];
  const sectorSize = provider.info.sectorSize, requested = typeof options.searchEmbeddedBoot === 'object' ? options.searchEmbeddedBoot.maxBytes : DEFAULT_SEARCH;
  requireValue(Number.isSafeInteger(requested) && requested >= sectorSize && requested <= 256 * 1024 * 1024, 'INVALID_SEARCH_LIMIT', '임베디드 부트 검색 제한은 256 MiB 이하여야 해요.');
  const limit = Math.min(provider.info.size, requested), found = [], chunkSize = Math.floor(MAX_READ / sectorSize) * sectorSize;
  for (let base = 0; base < limit; base += chunkSize) {
    cancelled(signal); await control?.checkpoint(); const count = Math.min(chunkSize, limit - base), bytes = await read(provider, base, count, signal);
    for (let at = 0; at + 512 <= bytes.length; at += sectorSize) {
      const offset = base + at; if (known.some(item => item.offset === offset)) continue;
      const oem = bytes.subarray(at + 3, at + 11).toString('ascii');
      if (oem !== 'NTFS    ' && oem !== 'EXFAT   ' && bytes.readUInt16LE(at + 510) !== 0xaa55) continue;
      const boot = await validateBoot(provider, offset, provider.info.size - offset, signal); if (!boot) continue;
      found.push(descriptor(provider, { index: null, offset, size: boot.volumeSize, sectorSize: boot.sectorSize, scheme: 'embedded-search', partitionType: null,
        bootKind: boot.bootKind, trusted: false, volumeSize: boot.volumeSize }));
      if (found.length >= 128) return found;
    }
    onProgress?.({ stage: 'embedded-boot-search', bytesRead: Math.min(base + count, limit), bytesTotal: limit });
  }
  return found;
}

export async function discoverVolumes(provider, options = {}) {
  requireValue(provider && Number.isSafeInteger(provider.info?.size) && provider.info.size >= 512 && power2(provider.info?.sectorSize) && provider.info.sectorSize >= 512 && provider.info.sectorSize <= 4096 && typeof provider.read === 'function' && typeof provider.assertUnchanged === 'function', 'INVALID_PROVIDER', '디스크 또는 볼륨 읽기 공급자가 필요해요.');
  const { signal, control, onProgress } = options; cancelled(signal); await provider.assertUnchanged();
  const sectorSize = provider.info.sectorSize, first = await read(provider, 0, sectorSize, signal), warnings = []; let scheme = 'none', volumes = [];
  const direct = await validateBoot(provider, 0, provider.info.size, signal);
  if (direct) { scheme = 'volume'; volumes = [descriptor(provider, { index: 0, offset: 0, size: direct.volumeSize, sectorSize: direct.sectorSize, scheme, partitionType: null, bootKind: direct.bootKind, trusted: true, volumeSize: direct.volumeSize })]; }
  else if (first.readUInt16LE(510) === 0xaa55) {
    const mbr = [];
    for (let index = 0; index < 4; index++) {
      const at = 446 + index * 16, status = first[at], type = first[at + 4], start = first.readUInt32LE(at + 8), sectors = first.readUInt32LE(at + 12);
      requireValue(status === 0 || status === 0x80, 'INVALID_MBR', 'MBR 부팅 상태 바이트가 잘못됐어요.');
      if (!type && !start && !sectors) continue;
      requireValue(type && start && sectors, 'INVALID_MBR', 'MBR 파티션 엔트리가 불완전해요.');
      if ([0x05, 0x0f, 0x85].includes(type)) { warnings.push({ code: 'EXTENDED_MBR_UNSUPPORTED', index }); continue; }
      mbr.push({ index, type, start, sectors });
    }
    if (mbr.some(entry => entry.type === 0xee)) {
      requireValue(mbr.every(entry => entry.type === 0xee), 'HYBRID_MBR_UNSUPPORTED', '하이브리드 MBR/GPT 배치는 안전하게 선택할 수 없어요.');
      requireValue(provider.info.size % sectorSize === 0, 'INVALID_GPT', 'GPT 디스크 길이가 논리 섹터에 맞지 않아요.');
      scheme = 'gpt'; const totalLbas = Math.floor(provider.info.size / sectorSize), primaryBytes = await read(provider, sectorSize, sectorSize, signal);
      const header = validateGptHeader(primaryBytes, sectorSize, 1, totalLbas), array = await readLarge(provider, header.entriesLba * sectorSize, header.arrayBytes, signal, onProgress);
      requireValue(header.alternate === totalLbas - 1 && header.entriesLba >= 2 && header.entriesLba * sectorSize + header.arrayBytes <= header.first * sectorSize,
        'INVALID_GPT', 'GPT 기본 테이블 위치가 규격 범위를 벗어났어요.');
      requireValue(crc32(array) === header.arrayCrc, 'INVALID_GPT_ARRAY_CRC', 'GPT 파티션 배열 CRC32가 맞지 않아요.');
      const backupBytes = await read(provider, header.alternate * sectorSize, sectorSize, signal), backup = validateGptHeader(backupBytes, sectorSize, header.alternate, totalLbas);
      requireValue(backup.alternate === 1 && backup.diskGuid === header.diskGuid, 'INVALID_GPT_BACKUP', 'GPT 백업 헤더가 기본 헤더와 연결되지 않아요.');
      requireValue(backup.entriesLba > backup.last && backup.entriesLba * sectorSize + backup.arrayBytes <= backup.my * sectorSize,
        'INVALID_GPT_BACKUP', 'GPT 백업 배열 위치가 규격 범위를 벗어났어요.');
      const backupArray = await readLarge(provider, backup.entriesLba * sectorSize, backup.arrayBytes, signal, onProgress);
      requireValue(crc32(backupArray) === backup.arrayCrc && backup.arrayCrc === header.arrayCrc && backupArray.equals(array),
        'INVALID_GPT_BACKUP_ARRAY', 'GPT 백업 파티션 배열이 기본 배열과 일치하지 않아요.');
      const entries = [];
      for (let index = 0; index < header.count; index++) {
        const at = index * header.entrySize, type = guid(array, at); if (type === '00000000-0000-0000-0000-000000000000') continue;
        const start = number64(array, at + 32, 'GPT 시작 LBA'), end = number64(array, at + 40, 'GPT 끝 LBA');
        requireValue(start >= header.first && end >= start && end <= header.last, 'INVALID_PARTITION_BOUNDS', 'GPT 파티션이 사용 가능 범위를 벗어났어요.');
        entries.push({ index, offset: start * sectorSize, size: (end - start + 1) * sectorSize, partitionType: type });
      }
      volumes = await inspectPartitions(provider, entries, scheme, signal, warnings);
    } else {
      scheme = 'mbr'; const entries = mbr.map(entry => ({ index: entry.index, offset: entry.start * sectorSize, size: entry.sectors * sectorSize, partitionType: `mbr:${entry.type.toString(16).padStart(2, '0')}` }));
      volumes = await inspectPartitions(provider, entries, scheme, signal, warnings);
    }
  }
  const recoveryCandidates = await embeddedSearch(provider, options, volumes, signal, control, onProgress);
  await provider.assertUnchanged();
  const table = new Map([...volumes, ...recoveryCandidates].map(item => [item.id, item])); approved.set(provider, table);
  return Object.freeze({ scheme, volumes: Object.freeze(volumes), recoveryCandidates: Object.freeze(recoveryCandidates), warnings: Object.freeze(warnings), complete: warnings.length === 0 });
}

export function openPartitionBytes(provider, selected) {
  const known = approved.get(provider)?.get(selected?.id);
  const fields = ['id', 'identity', 'offset', 'size', 'sectorSize', 'scheme', 'partitionType', 'bootKind', 'trusted'];
  requireValue(known && fields.every(field => known[field] === selected[field]), 'PARTITION_NOT_DISCOVERED', '현재 디스크 검색 결과에서 파티션을 선택해야 해요.');
  selected = known;
  requireValue(selected.trusted, 'UNTRUSTED_PARTITION', '손실 테이블 검색 후보는 검증된 파티션으로 승격하기 전에는 열 수 없어요.');
  let closed = false;
  return {
    info: Object.freeze({ size: selected.size, sectorSize: selected.sectorSize, sourceKind: provider.info.sourceKind, identity: provider.info.identity, offset: selected.offset, partitionIdentity: selected.identity }),
    async read(offset, length, { signal } = {}) { requireValue(!closed, 'CLOSED', '파티션 공급자가 닫혔어요.'); inRange(offset, length, selected.size); return read(provider, selected.offset + offset, length, signal); },
    async assertUnchanged() { requireValue(!closed, 'CLOSED', '파티션 공급자가 닫혔어요.'); return provider.assertUnchanged(); },
    async close() { closed = true; }
  };
}

function addFree(ranges, offset, length) {
  if (!length) return;
  const previous = ranges[ranges.length - 1]; if (previous && previous.offset + previous.length === offset) previous.length += length;
  else { requireValue(ranges.length < MAX_RANGES, 'RANGE_LIMIT_EXCEEDED', '미할당 구간 수가 안전 제한을 넘었어요.'); ranges.push({ offset, length }); }
}
function tableReader(provider, base, size, signal) {
  let cacheStart = -1, cache = null;
  return async (offset, length) => {
    if (!cache || offset < cacheStart || offset + length > cacheStart + cache.length) {
      cacheStart = Math.floor(offset / 65536) * 65536; const count = Math.min(65536, size - cacheStart); cache = await read(provider, base + cacheStart, count, signal);
    }
    return cache.subarray(offset - cacheStart, offset - cacheStart + length);
  };
}
async function fatFreeRanges(provider, boot, signal, control, onProgress) {
  const fatBytes = boot.fatSectors * boot.sectorSize, ranges = [], get = tableReader(provider, boot.fatOffset, fatBytes, signal);
  const mirrors = boot.mirroringEnabled && boot.fats > 1 ? Array.from({ length: boot.fats }, (_, copy) =>
    copy === boot.activeFat ? null : tableReader(provider, boot.fatBaseOffset + copy * fatBytes, fatBytes, signal)) : [];
  for (let cluster = 2; cluster < boot.clusterCount + 2; cluster++) {
    cancelled(signal); if ((cluster & 0xffff) === 0) { await control?.checkpoint(); onProgress?.({ stage: 'allocation-map', clustersRead: cluster - 2, clustersTotal: boot.clusterCount }); }
    let value;
    const width = boot.bootKind === 'FAT12' ? 2 : boot.bootKind === 'FAT16' ? 2 : 4;
    const at = boot.bootKind === 'FAT12' ? Math.floor(cluster * 3 / 2) : cluster * width;
    const decode = bytes => boot.bootKind === 'FAT12' ? (cluster & 1 ? bytes.readUInt16LE(0) >> 4 : bytes.readUInt16LE(0) & 0xfff) :
      width === 2 ? bytes.readUInt16LE(0) : bytes.readUInt32LE(0) & 0x0fffffff;
    value = decode(await get(at, width));
    for (const mirror of mirrors) if (mirror) requireValue(decode(await mirror(at, width)) === value, 'FAT_MIRROR_MISMATCH', '미러 FAT의 할당 정보가 서로 달라요.');
    if (value === 0) addFree(ranges, boot.firstDataOffset + (cluster - 2) * boot.clusterSize, boot.clusterSize);
  }
  return ranges;
}
async function exfatFatEntry(provider, boot, cluster, signal) { return (await read(provider, boot.fatOffset + cluster * 4, 4, signal)).readUInt32LE(0); }
async function exfatChain(provider, boot, first, signal) {
  const result = [], seen = new Set(); let cluster = first;
  while (true) { requireValue(cluster >= 2 && cluster < boot.clusterCount + 2 && !seen.has(cluster) && result.length <= boot.clusterCount, 'INVALID_ALLOCATION_MAP', 'exFAT 메타데이터 체인이 잘못됐어요.'); seen.add(cluster); result.push(cluster); const next = await exfatFatEntry(provider, boot, cluster, signal); if (next >= 0xfffffff8) break; cluster = next; }
  return result;
}
async function exfatFreeRanges(provider, boot, signal, control, onProgress) {
  const root = await exfatChain(provider, boot, boot.rootCluster, signal); let bitmapEntry;
  for (const cluster of root) {
    const bytes = await readLarge(provider, boot.heapOffset + (cluster - 2) * boot.clusterSize, boot.clusterSize, signal);
    for (let at = 0; at + 32 <= bytes.length; at += 32) { if (bytes[at] === 0) break; if (bytes[at] === 0x81 && (bytes[at + 1] & 1) === boot.activeFat) { bitmapEntry = Buffer.from(bytes.subarray(at, at + 32)); break; } }
    if (bitmapEntry) break;
  }
  requireValue(bitmapEntry, 'INVALID_ALLOCATION_MAP', 'exFAT 할당 비트맵 엔트리를 찾지 못했어요.');
  const first = bitmapEntry.readUInt32LE(20), length = number64(bitmapEntry, 24, 'exFAT 할당 비트맵'), required = Math.ceil(boot.clusterCount / 8); requireValue(length >= required, 'INVALID_ALLOCATION_MAP', 'exFAT 할당 비트맵이 짧아요.');
  const chain = await exfatChain(provider, boot, first, signal); requireValue(chain.length * boot.clusterSize >= length, 'INVALID_ALLOCATION_MAP', 'exFAT 할당 비트맵 체인이 짧아요.');
  const ranges = []; let bitmapOffset = 0, clusterIndex = 0;
  for (const cluster of chain) {
    const count = Math.min(boot.clusterSize, required - bitmapOffset); if (!count) break;
    const bytes = await readLarge(provider, boot.heapOffset + (cluster - 2) * boot.clusterSize, count, signal);
    for (const value of bytes) for (let bit = 0; bit < 8 && clusterIndex < boot.clusterCount; bit++, clusterIndex++) {
      cancelled(signal); if ((clusterIndex & 0xffff) === 0) { await control?.checkpoint(); onProgress?.({ stage: 'allocation-map', clustersRead: clusterIndex, clustersTotal: boot.clusterCount }); }
      if (!(value & (1 << bit))) addFree(ranges, boot.heapOffset + clusterIndex * boot.clusterSize, boot.clusterSize);
    }
    bitmapOffset += count;
  }
  requireValue(clusterIndex === boot.clusterCount, 'INVALID_ALLOCATION_MAP', 'exFAT 할당 비트맵을 끝까지 읽지 못했어요.');
  return ranges;
}
async function ntfsFreeRanges(provider, signal, control, onProgress) {
  const nonOwning = { info: provider.info, read: provider.read.bind(provider), assertUnchanged: provider.assertUnchanged.bind(provider), close: async () => {} };
  const image = await openNtfsProvider(nonOwning);
  try {
    requireValue(image.volumeBitmap && Number.isSafeInteger(image.info?.clusterCount) && Number.isSafeInteger(image.info?.clusterSize) && typeof image.readStream === 'function', 'NTFS_BITMAP_INTERFACE_UNAVAILABLE', 'NTFS 엔진의 볼륨 비트맵 인터페이스를 사용할 수 없어요.');
    const ranges = [], bytesTotal = Math.ceil(image.info.clusterCount / 8);
    for (let byteOffset = 0; byteOffset < bytesTotal; byteOffset += MAX_READ) {
      cancelled(signal); await control?.checkpoint(); const count = Math.min(MAX_READ, bytesTotal - byteOffset), bytes = await image.readStream(image.volumeBitmap, byteOffset, count, signal);
      for (let i = 0; i < bytes.length; i++) for (let bit = 0; bit < 8; bit++) { const cluster = (byteOffset + i) * 8 + bit; if (cluster >= image.info.clusterCount) break; if (!(bytes[i] & (1 << bit))) addFree(ranges, cluster * image.info.clusterSize, image.info.clusterSize); }
      onProgress?.({ stage: 'allocation-map', bytesRead: byteOffset + count, bytesTotal });
    }
    return ranges;
  } finally { await image.close(); }
}

export async function getUnallocatedRanges(provider, { signal, control, onProgress } = {}) {
  requireValue(provider && Number.isSafeInteger(provider.info?.size) && provider.info.size >= 512, 'INVALID_PROVIDER', '볼륨 공급자가 필요해요.');
  let boot;
  try {
    await provider.assertUnchanged(); boot = await validateBoot(provider, 0, provider.info.size, signal);
    if (!boot) return { supported: false, ranges: [], fileSystem: null, complete: false, reason: 'UNSUPPORTED_FILE_SYSTEM', requiresWholeSourceChoice: true };
    let ranges;
    if (boot.bootKind === 'NTFS') ranges = await ntfsFreeRanges(provider, signal, control, onProgress);
    else if (boot.bootKind === 'exFAT') ranges = await exfatFreeRanges(provider, boot, signal, control, onProgress);
    else ranges = await fatFreeRanges(provider, boot, signal, control, onProgress);
    await provider.assertUnchanged(); return { supported: true, ranges: Object.freeze(ranges.map(Object.freeze)), fileSystem: boot.bootKind, complete: true, requiresWholeSourceChoice: false };
  } catch (error) {
    if (error.code === 'CANCELLED') throw error;
    return { supported: false, ranges: [], fileSystem: boot?.bootKind ?? null, complete: false, reason: error.code || 'ALLOCATION_MAP_FAILED', requiresWholeSourceChoice: true };
  }
}
