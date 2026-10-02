import { shortenOutputName } from './recovery-name.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, open, realpath, rename, stat } from 'node:fs/promises';
import path from 'node:path';

const MAX_READ = 1024 * 1024;
const MAX_DIRECTORIES = 1024;
const MAX_ENTRIES = 1_000_000;
const MAX_CHAIN = 4_000_000;
const MAX_METADATA_BYTES = 32 * 1024 * 1024;

export class FatVolumeError extends Error {
  constructor(code, message, details = {}) {
    super(message); this.name = 'FatVolumeError'; this.code = code; this.details = details;
  }
}

function requireValue(value, code, message) { if (!value) throw new FatVolumeError(code, message); }
function cancelled(signal) { if (signal?.aborted) throw new FatVolumeError('CANCELLED', '작업을 취소했어요.'); }
function safeNumber(value, label) {
  const number = typeof value === 'bigint' ? Number(value) : Number(value);
  requireValue(Number.isSafeInteger(number) && number >= 0, 'INVALID_BOOT', `${label} 범위가 잘못됐어요.`); return number;
}
function powerOfTwo(value) { return value > 0 && (value & (value - 1)) === 0; }
function ranges(offset, length, limit, label) {
  requireValue(Number.isSafeInteger(offset) && Number.isSafeInteger(length) && offset >= 0 && length >= 0 && offset <= limit - length,
    'OUT_OF_BOUNDS', `${label} 범위가 볼륨을 벗어났어요.`);
}
function unicodeValid(text) {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0 || code === 0xffff) continue;
    if (code >= 0xd800 && code <= 0xdbff) { if (++i >= text.length || text.charCodeAt(i) < 0xdc00 || text.charCodeAt(i) > 0xdfff) return false; }
    else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
function validFatName(text) { return unicodeValid(text) && text.length > 0 && !/[\u0000-\u001f"*\/:<>?\\|]/.test(text); }
function cleanUnicode(text) { return text.replace(/[\u0000\uffff]+$/g, '').normalize('NFC'); }
function safeName(name, number) {
  let leaf = String(name).normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_').replace(/[. ]+$/g, '').trim();
  if (!leaf || leaf === '.' || leaf === '..') leaf = `record-${number}`;
  if (/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(leaf)) leaf = `_${leaf}`;
  leaf = shortenOutputName(leaf);
  return leaf.replace(/[. ]+$/g, '') || `record-${number}`;
}

function fatTime(entry) {
  const time = entry.readUInt16LE(22), date = entry.readUInt16LE(24);
  if (!date) return null;
  const year = 1980 + (date >> 9), month = (date >> 5) & 15, day = date & 31;
  const hour = time >> 11, minute = (time >> 5) & 63, second = (time & 31) * 2;
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second)).toISOString();
}
function exfatTime(value) {
  if (!value) return null;
  const time = value & 0xffff, date = value >>> 16;
  const year = 1980 + (date >> 9), month = (date >> 5) & 15, day = date & 31;
  const hour = time >> 11, minute = (time >> 5) & 63, second = (time & 31) * 2;
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second)).toISOString();
}
function fingerprint(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function sameRecoveryProof(left, right) {
  return Boolean(left && right && left.candidate.status === 'readable' && right.candidate.status === 'readable' &&
    left.fingerprint === right.fingerprint && left.size === right.size && left.clusters.length === right.clusters.length &&
    left.clusters.every((cluster, index) => cluster === right.clusters[index]));
}

function parseFatBoot(boot, providerSize) {
  requireValue(boot.readUInt16LE(510) === 0xaa55, 'INVALID_BOOT', 'FAT 부트 서명이 없어요.');
  const bytesPerSector = boot.readUInt16LE(11), sectorsPerCluster = boot[13], reservedSectors = boot.readUInt16LE(14), fats = boot[16];
  const rootEntries = boot.readUInt16LE(17), totalSectors = boot.readUInt16LE(19) || boot.readUInt32LE(32);
  const fatSectors = boot.readUInt16LE(22) || boot.readUInt32LE(36);
  requireValue(powerOfTwo(bytesPerSector) && bytesPerSector >= 512 && bytesPerSector <= 4096 && powerOfTwo(sectorsPerCluster) && sectorsPerCluster <= 128,
    'INVALID_BOOT', 'FAT 섹터 또는 클러스터 크기가 잘못됐어요.');
  requireValue(reservedSectors > 0 && (fats === 1 || fats === 2) && fatSectors > 0 && totalSectors > 0, 'INVALID_BOOT', 'FAT 영역 정보가 잘못됐어요.');
  const rootSectors = Math.ceil(rootEntries * 32 / bytesPerSector);
  const firstDataSector = reservedSectors + fats * fatSectors + rootSectors;
  requireValue(firstDataSector < totalSectors, 'INVALID_BOOT', 'FAT 데이터 영역이 없어요.');
  const clusterCount = Math.floor((totalSectors - firstDataSector) / sectorsPerCluster);
  const fatType = clusterCount < 4085 ? 'FAT12' : clusterCount < 65525 ? 'FAT16' : 'FAT32';
  const fatCapacity = Math.floor(fatSectors * bytesPerSector * 8 / ({ FAT12: 12, FAT16: 16, FAT32: 32 }[fatType]));
  requireValue(clusterCount >= 1 && fatCapacity >= clusterCount + 2, 'INVALID_BOOT', 'FAT 테이블이 클러스터 수보다 작아요.');
  if (fatType === 'FAT32') requireValue(rootEntries === 0 && boot.readUInt16LE(22) === 0, 'INVALID_BOOT', 'FAT32 루트 디렉터리 정보가 잘못됐어요.');
  else requireValue(rootEntries > 0 && boot.readUInt16LE(22) > 0, 'INVALID_BOOT', 'FAT12/16 루트 디렉터리 정보가 잘못됐어요.');
  const volumeSize = totalSectors * bytesPerSector;
  requireValue(Number.isSafeInteger(volumeSize) && volumeSize <= providerSize, 'INVALID_BOOT', 'FAT 볼륨 길이가 공급자 범위를 벗어났어요.');
  const rootCluster = fatType === 'FAT32' ? boot.readUInt32LE(44) & 0x0fffffff : 0;
  let activeFat = 0, mirroringEnabled = fatType !== 'FAT32';
  if (fatType === 'FAT32') {
    requireValue(rootCluster >= 2 && rootCluster < clusterCount + 2 && boot.readUInt16LE(42) === 0, 'INVALID_BOOT', 'FAT32 루트 클러스터 또는 버전이 잘못됐어요.');
    const flags = boot.readUInt16LE(40); mirroringEnabled = !(flags & 0x80); if (!mirroringEnabled) activeFat = flags & 0x0f;
    requireValue(activeFat < fats, 'INVALID_BOOT', 'FAT32 활성 FAT 번호가 잘못됐어요.');
  }
  return { type: fatType, bytesPerSector, sectorSize: bytesPerSector, sectorsPerCluster, clusterSize: bytesPerSector * sectorsPerCluster,
    reservedSectors, fats, fatSectors, rootEntries, rootSectors, firstDataSector, clusterCount, rootCluster, volumeSize,
    activeFat, mirroringEnabled, fatBaseOffset: reservedSectors * bytesPerSector,
    fatOffset: (reservedSectors + activeFat * fatSectors) * bytesPerSector, rootOffset: (reservedSectors + fats * fatSectors) * bytesPerSector };
}

function exfatBootChecksum(region, sectorSize) {
  let checksum = 0;
  for (let index = 0; index < 11 * sectorSize; index++) {
    if (index === 106 || index === 107 || index === 112) continue;
    checksum = (((checksum & 1) ? 0x80000000 : 0) + (checksum >>> 1) + region[index]) >>> 0;
  }
  return checksum;
}
function parseExfatBoot(region, providerSize) {
  requireValue(region.subarray(3, 11).toString('ascii') === 'EXFAT   ' && region.readUInt16LE(510) === 0xaa55, 'INVALID_BOOT', 'exFAT 부트 서명이 없어요.');
  requireValue(region.subarray(11, 64).every(byte => byte === 0), 'INVALID_BOOT', 'exFAT 예약 부트 영역이 잘못됐어요.');
  const sectorShift = region[108], clusterShift = region[109], fats = region[110];
  requireValue(sectorShift >= 9 && sectorShift <= 12 && clusterShift <= 25 - sectorShift && (fats === 1 || fats === 2), 'INVALID_BOOT', 'exFAT 섹터 또는 FAT 수가 잘못됐어요.');
  const bytesPerSector = 2 ** sectorShift, sectorsPerCluster = 2 ** clusterShift, clusterSize = bytesPerSector * sectorsPerCluster;
  requireValue(region.length >= 12 * bytesPerSector, 'INVALID_BOOT', 'exFAT 부트 영역이 짧아요.');
  const volumeSectors = safeNumber(region.readBigUInt64LE(72), 'exFAT 볼륨'), fatOffsetSectors = region.readUInt32LE(80), fatSectors = region.readUInt32LE(84);
  const heapOffsetSectors = region.readUInt32LE(88), clusterCount = region.readUInt32LE(92), rootCluster = region.readUInt32LE(96);
  const volumeSize = volumeSectors * bytesPerSector;
  requireValue(volumeSectors >= 24 && Number.isSafeInteger(volumeSize) && volumeSize <= providerSize && fatOffsetSectors >= 24 && fatSectors > 0 &&
    heapOffsetSectors >= fatOffsetSectors + fats * fatSectors && clusterCount > 0 && rootCluster >= 2 && rootCluster < clusterCount + 2 &&
    heapOffsetSectors + clusterCount * sectorsPerCluster <= volumeSectors, 'INVALID_BOOT', 'exFAT 영역 경계가 잘못됐어요.');
  requireValue(fatSectors * bytesPerSector >= (clusterCount + 2) * 4, 'INVALID_BOOT', 'exFAT FAT 영역이 너무 작아요.');
  const expected = exfatBootChecksum(region, bytesPerSector);
  for (let offset = 11 * bytesPerSector; offset < 12 * bytesPerSector; offset += 4)
    requireValue(region.readUInt32LE(offset) === expected, 'INVALID_BOOT_CHECKSUM', 'exFAT 부트 체크섬이 맞지 않아요.');
  const activeFat = fats === 2 ? region.readUInt16LE(106) & 1 : 0;
  return { type: 'exFAT', bytesPerSector, sectorSize: bytesPerSector, sectorsPerCluster, clusterSize, fats, activeFat, mirroringEnabled: false, fatSectors,
    fatOffset: (fatOffsetSectors + activeFat * fatSectors) * bytesPerSector, heapOffset: heapOffsetSectors * bytesPerSector, clusterCount, rootCluster, volumeSize };
}

function entrySetChecksum(entries, restoreInUse) {
  let checksum = 0;
  for (let index = 0; index < entries.length; index++) {
    if (index === 2 || index === 3) continue;
    let value = entries[index];
    if (restoreInUse && index % 32 === 0) value |= 0x80;
    checksum = ((((checksum & 1) ? 0x8000 : 0) + (checksum >>> 1) + value) & 0xffff);
  }
  return checksum;
}
function lfnChecksum(shortName) {
  let sum = 0;
  for (const value of shortName) sum = (((sum & 1) ? 0x80 : 0) + (sum >> 1) + value) & 0xff;
  return sum;
}
function lfnPart(entry) {
  const units = [];
  for (const [offset, count] of [[1, 5], [14, 6], [28, 2]]) for (let i = 0; i < count; i++) units.push(entry.readUInt16LE(offset + i * 2));
  return String.fromCharCode(...units);
}
function shortName(entry, deleted) {
  const base = Buffer.from(entry.subarray(0, 8)), ext = Buffer.from(entry.subarray(8, 11));
  if (deleted) base[0] = 0x3f;
  const decode = bytes => bytes.toString('latin1').replace(/ +$/g, '');
  return `${decode(base)}${decode(ext) ? `.${decode(ext)}` : ''}`;
}

class FatVolume {
  constructor(provider) { this.provider = provider; this.info = null; this.busy = false; this.closed = false; this.records = new Map(); }
  rememberRecord(id, value) {
    const remembered = this.rememberedClusters ?? 0;
    if (remembered + value.clusters.length > MAX_CHAIN) {
      value = { ...value, candidate: Object.freeze({ ...value.candidate, status: 'unsupported',
        reasons: Object.freeze([...value.candidate.reasons, 'SCAN_METADATA_LIMIT']) }), clusters: [] };
    } else this.rememberedClusters = remembered + value.clusters.length;
    this.records.set(id, value);
    return value.candidate;
  }
  async read(offset, length, signal) {
    cancelled(signal); ranges(offset, length, this.info?.size ?? this.provider.info.size, '읽기');
    requireValue(length <= MAX_READ, 'READ_LIMIT', '한 번에 읽는 범위가 1 MiB를 넘어요.');
    const bytes = await this.provider.read(offset, length, { signal });
    requireValue(Buffer.isBuffer(bytes) && bytes.length === length, 'READ_FAILED', '공급자가 요청한 바이트를 모두 읽지 못했어요.'); return bytes;
  }
  clusterOffset(cluster) {
    requireValue(Number.isInteger(cluster) && cluster >= 2 && cluster < this.info.clusterCount + 2, 'INVALID_CLUSTER', '클러스터 번호가 범위를 벗어났어요.');
    return this.info.type === 'exFAT' ? this.info.heapOffset + (cluster - 2) * this.info.clusterSize :
      (this.info.firstDataSector + (cluster - 2) * this.info.sectorsPerCluster) * this.info.bytesPerSector;
  }
  async fatEntry(cluster, signal) {
    const type = this.info.type;
    let relativeOffset, width;
    if (type === 'FAT12') {
      relativeOffset = Math.floor(cluster * 3 / 2); width = 2;
    } else {
      width = type === 'FAT16' ? 2 : 4; relativeOffset = cluster * width;
    }
    const decode = bytes => type === 'FAT12' ? (cluster & 1 ? bytes.readUInt16LE(0) >> 4 : bytes.readUInt16LE(0) & 0xfff) :
      width === 2 ? bytes.readUInt16LE(0) : bytes.readUInt32LE(0) & 0x0fffffff;
    const value = decode(await this.read(this.info.fatOffset + relativeOffset, width, signal));
    if (this.info.mirroringEnabled && this.info.fats > 1) {
      const fatBytes = this.info.fatSectors * this.info.bytesPerSector;
      for (let copy = 0; copy < this.info.fats; copy++) {
        if (copy === this.info.activeFat) continue;
        const mirrored = decode(await this.read(this.info.fatBaseOffset + copy * fatBytes + relativeOffset, width, signal));
        requireValue(mirrored === value, 'FAT_MIRROR_MISMATCH', '미러 FAT의 할당 정보가 서로 달라요.');
      }
    }
    return value;
  }
  isEoc(value) { return this.info.type === 'FAT12' ? value >= 0xff8 : this.info.type === 'FAT16' ? value >= 0xfff8 : value >= 0x0ffffff8; }
  async chain(first, signal, expectedClusters = null) {
    const result = [], seen = new Set(); let cluster = first;
    while (true) {
      cancelled(signal); requireValue(cluster >= 2 && cluster < this.info.clusterCount + 2, 'INVALID_CHAIN', '클러스터 체인이 범위를 벗어났어요.');
      requireValue(!seen.has(cluster) && result.length < MAX_CHAIN, 'CHAIN_LOOP', '클러스터 체인이 반복되거나 제한을 넘었어요.');
      seen.add(cluster); result.push(cluster);
      if (expectedClusters != null && result.length > expectedClusters) throw new FatVolumeError('INVALID_CHAIN', '클러스터 체인이 파일 크기보다 길어요.');
      const next = await this.fatEntry(cluster, signal);
      if (this.isEoc(next)) break;
      requireValue(next >= 2, 'AMBIGUOUS_CHAIN', '삭제된 클러스터 체인이 남아 있지 않아요.'); cluster = next;
    }
    if (expectedClusters != null) requireValue(result.length === expectedClusters, 'INVALID_CHAIN', '클러스터 체인 길이가 파일 크기와 맞지 않아요.');
    return result;
  }
  async readClusters(clusters, length, signal) {
    requireValue(length <= MAX_METADATA_BYTES, 'METADATA_LIMIT', '메타데이터가 32 MiB 처리 한도를 넘어요.');
    const output = Buffer.alloc(length); let written = 0;
    for (const cluster of clusters) {
      const count = Math.min(this.info.clusterSize, length - written); if (count <= 0) break;
      const bytes = await this.read(this.clusterOffset(cluster), count, signal); bytes.copy(output, written); written += count;
    }
    requireValue(written === length, 'INVALID_CHAIN', '클러스터 목록이 데이터보다 짧아요.'); return output;
  }
  async directoryChunks(descriptor, signal) {
    if (descriptor.fixed) return [{ bytes: await this.read(this.info.rootOffset, this.info.rootSectors * this.info.bytesPerSector, signal), offset: this.info.rootOffset }];
    if (descriptor.contiguous) requireValue(Number.isSafeInteger(descriptor.clusterCount) && descriptor.clusterCount > 0 && descriptor.clusterCount <= MAX_CHAIN && descriptor.clusterCount * this.info.clusterSize <= MAX_METADATA_BYTES, 'DIRECTORY_LIMIT', '디렉터리가 메모리 처리 한도를 넘어요.');
    const clusters = descriptor.contiguous ? Array.from({ length: descriptor.clusterCount }, (_, i) => descriptor.firstCluster + i) : await this.chain(descriptor.firstCluster, signal);
    requireValue(clusters.length * this.info.clusterSize <= MAX_METADATA_BYTES, 'DIRECTORY_LIMIT', '디렉터리가 32 MiB 처리 한도를 넘어요.');
    const result = [];
    for (const cluster of clusters) result.push({ bytes: await this.read(this.clusterOffset(cluster), this.info.clusterSize, signal), offset: this.clusterOffset(cluster) });
    return result;
  }
  async exfatBitmap(signal) {
    const chunks = await this.directoryChunks({ firstCluster: this.info.rootCluster }, signal);
    for (const chunk of chunks) for (let at = 0; at + 32 <= chunk.bytes.length; at += 32) {
      const entry = chunk.bytes.subarray(at, at + 32); if (entry[0] === 0) break;
      if (entry[0] === 0x81 && (entry[1] & 1) === this.info.activeFat) {
        const firstCluster = entry.readUInt32LE(20), length = safeNumber(entry.readBigUInt64LE(24), '할당 비트맵');
        requireValue(length >= Math.ceil(this.info.clusterCount / 8) && length <= Math.ceil(this.info.clusterCount / 8) + this.info.clusterSize,
          'INVALID_BITMAP', 'exFAT 할당 비트맵 길이가 잘못됐어요.');
        const clusters = await this.chain(firstCluster, signal, Math.ceil(length / this.info.clusterSize));
        return this.readClusters(clusters, length, signal);
      }
    }
    throw new FatVolumeError('INVALID_BITMAP', 'exFAT 할당 비트맵을 찾지 못했어요.');
  }
  async clustersFree(clusters, bitmap, signal) {
    for (const cluster of clusters) {
      cancelled(signal);
      if (bitmap) { const bit = cluster - 2; if (bitmap[Math.floor(bit / 8)] & (1 << (bit % 8))) return false; }
      else if ((await this.fatEntry(cluster, signal)) !== 0) return false;
    }
    return true;
  }
  makeCandidate(base, recordNumber, state) {
    const candidate = Object.freeze({ id: base.id, recordNumber, name: base.name, size: base.size, path: base.path, pathStatus: base.pathStatus,
      modifiedAt: base.modifiedAt, deletedAt: null, source: 'deleted-record', status: state.status, reasons: Object.freeze(state.reasons), kind: base.kind || 'file' });
    return candidate;
  }
  async scanClassic({ signal, control, onProgress, onCandidate, maxCandidates }, warnings, stats) {
    const candidates = [], queue = [{ fixed: this.info.type !== 'FAT32', firstCluster: this.info.rootCluster, path: '\\' }], seenDirs = new Set();
    while (queue.length && candidates.length < maxCandidates) {
      cancelled(signal); await control?.checkpoint();
      requireValue(stats.directoriesRead < MAX_DIRECTORIES, 'DIRECTORY_LIMIT', '디렉터리 탐색 제한을 넘었어요.');
      const directory = queue.shift(), dirKey = directory.fixed ? 'root' : String(directory.firstCluster);
      if (seenDirs.has(dirKey)) { warnings.push({ code: 'DIRECTORY_LOOP', path: directory.path }); continue; }
      seenDirs.add(dirKey); stats.directoriesRead++;
      let chunks;
      try { chunks = await this.directoryChunks(directory, signal); }
      catch (error) { warnings.push({ code: error.code || 'DIRECTORY_READ_FAILED', path: directory.path }); continue; }
      let lfn = [], ended = false;
      for (const chunk of chunks) {
        if (ended) break;
        for (let at = 0; at + 32 <= chunk.bytes.length; at += 32) {
        cancelled(signal); if (++stats.entriesRead > MAX_ENTRIES) throw new FatVolumeError('ENTRY_LIMIT', '디렉터리 항목 제한을 넘었어요.');
        const entry = chunk.bytes.subarray(at, at + 32), first = entry[0], attr = entry[11];
        if (first === 0) { ended = true; break; }
        if (attr === 0x0f) { lfn.push(Buffer.from(entry)); continue; }
        const deleted = first === 0xe5, isDirectory = Boolean(attr & 0x10), volumeLabel = Boolean(attr & 0x08);
        let name = shortName(entry, deleted), nameEvidence = null;
        if (lfn.length) {
          const checksums = new Set(lfn.map(part => part[13]));
          const longName = cleanUnicode(lfn.slice().reverse().map(lfnPart).join(''));
          const trial = Buffer.from(entry.subarray(0, 11)); let matches = 0;
          for (let value = 1; value <= 255; value++) { trial[0] = value; if (checksums.size === 1 && lfnChecksum(trial) === lfn[0][13]) matches++; }
          if (validFatName(longName) && matches > 0) { name = longName; nameEvidence = matches === 1 ? 'LONG_NAME_CHECKSUM_VERIFIED' : 'LONG_NAME_CHECKSUM_PARTIAL'; }
          else warnings.push({ code: 'INVALID_LONG_NAME', offset: chunk.offset + at });
        }
        lfn = [];
        const cluster = ((entry.readUInt16LE(20) << 16) | entry.readUInt16LE(26)) >>> 0, size = entry.readUInt32LE(28);
        if (!deleted && isDirectory && !volumeLabel && name !== '.' && name !== '..' && cluster >= 2)
          queue.push({ firstCluster: cluster, path: `${directory.path}${name}\\` });
        if (!deleted || volumeLabel || isDirectory) continue;
        const id = `${this.info.type.toLowerCase()}:${chunk.offset + at}`;
        const base = { id, name, size, path: `${directory.path}${name}`, pathStatus: 'known-parent', modifiedAt: fatTime(entry), kind: 'file' };
        let state, clusters = [];
        if (size === 0) state = { status: 'readable', reasons: ['EMPTY_FILE_RECORD'] };
        else if (cluster < 2 || cluster >= this.info.clusterCount + 2) state = { status: 'unsupported', reasons: ['INVALID_START_CLUSTER'] };
        else if (size <= this.info.clusterSize) {
          clusters = [cluster];
          try { state = await this.clustersFree(clusters, null, signal) ? { status: 'readable', reasons: ['SINGLE_FREE_CLUSTER'] } : { status: 'conflict', reasons: ['CLUSTER_ALLOCATED'] }; }
          catch (error) { clusters = []; state = { status: 'unsupported', reasons: [error.code || 'ALLOCATION_CHECK_FAILED'] }; }
        } else {
          try {
            clusters = await this.chain(cluster, signal, Math.ceil(size / this.info.clusterSize));
            state = { status: 'conflict', reasons: ['CLUSTER_CHAIN_STILL_ALLOCATED'] };
          } catch (error) { clusters = []; state = { status: 'unsupported', reasons: [error.code || 'AMBIGUOUS_DELETED_CLUSTER_CHAIN', 'CONTIGUOUS_HEURISTIC_REFUSED'] }; }
        }
        if (nameEvidence) state.reasons.push(nameEvidence);
        if (state.status !== 'readable') clusters = [];
        let candidate = this.makeCandidate(base, stats.candidatesFound, state); const rawFingerprint = fingerprint(entry);
        candidate = this.rememberRecord(id, { candidate, fingerprint: rawFingerprint, clusters, size });
        candidates.push(candidate); stats.candidatesFound++; onCandidate?.(candidate); onProgress?.({ stage: 'scan', ...stats });
        if (candidates.length >= maxCandidates) break;
        }
      }
      if (ended) continue;
    }
    return candidates;
  }
  async scanExfat({ signal, control, onProgress, onCandidate, maxCandidates }, warnings, stats) {
    const bitmap = await this.exfatBitmap(signal), candidates = [], queue = [{ firstCluster: this.info.rootCluster, path: '\\' }], seenDirs = new Set();
    while (queue.length && candidates.length < maxCandidates) {
      cancelled(signal); await control?.checkpoint();
      requireValue(stats.directoriesRead < MAX_DIRECTORIES, 'DIRECTORY_LIMIT', '디렉터리 탐색 제한을 넘었어요.');
      const directory = queue.shift();
      if (seenDirs.has(directory.firstCluster)) { warnings.push({ code: 'DIRECTORY_LOOP', path: directory.path }); continue; }
      seenDirs.add(directory.firstCluster); stats.directoriesRead++;
      let chunks;
      try { chunks = await this.directoryChunks(directory, signal); }
      catch (error) { warnings.push({ code: error.code || 'DIRECTORY_READ_FAILED', path: directory.path }); continue; }
      let ended = false, chunkIndex = 0, at = 0;
      const take = length => {
        const parts = []; let remaining = length, index = chunkIndex, offset = at;
        while (remaining > 0 && index < chunks.length) {
          const item = chunks[index], count = Math.min(remaining, item.bytes.length - offset);
          if (count > 0) { parts.push(item.bytes.subarray(offset, offset + count)); remaining -= count; offset += count; }
          if (offset === item.bytes.length) { index++; offset = 0; }
        }
        return remaining === 0 ? { bytes: Buffer.concat(parts, length), chunkIndex: index, at: offset } : null;
      };
      while (!ended && chunkIndex < chunks.length) {
        const chunk = chunks[chunkIndex];
        if (at + 32 > chunk.bytes.length) { chunkIndex++; at = 0; continue; }
        cancelled(signal); if (++stats.entriesRead > MAX_ENTRIES) throw new FatVolumeError('ENTRY_LIMIT', '디렉터리 항목 제한을 넘었어요.');
        const type = chunk.bytes[at]; if (type === 0) { ended = true; break; }
        if ((type & 0x7f) !== 0x05) { at += 32; continue; }
        const primary = chunk.bytes.subarray(at, at + 32), secondaryCount = primary[1], byteLength = (secondaryCount + 1) * 32;
        const setResult = secondaryCount >= 2 ? take(byteLength) : null;
        if (!setResult) { warnings.push({ code: 'INVALID_ENTRY_SET', offset: chunk.offset + at }); at += 32; continue; }
        const set = setResult.bytes, next = () => { chunkIndex = setResult.chunkIndex; at = setResult.at; };
        const inactive = !(type & 0x80), checksum = primary.readUInt16LE(2);
        const checksumOk = entrySetChecksum(set, inactive) === checksum;
        if (!checksumOk) { warnings.push({ code: 'INVALID_ENTRY_CHECKSUM', offset: chunk.offset + at }); next(); continue; }
        const entries = Array.from({ length: secondaryCount }, (_, i) => set.subarray((i + 1) * 32, (i + 2) * 32));
        if (entries.some(entry => Boolean(entry[0] & 0x80) === inactive)) { warnings.push({ code: 'PARTIAL_DELETION_SET', offset: chunk.offset + at }); next(); continue; }
        const stream = entries[0];
        if ((stream[0] & 0x7f) !== 0x40) { warnings.push({ code: 'MISSING_STREAM_ENTRY', offset: chunk.offset + at }); next(); continue; }
        const nameLength = stream[3], requiredNames = Math.ceil(nameLength / 15);
        const layoutOk = set.length === byteLength && entries.length === requiredNames + 1 &&
          entries.slice(1).every(entry => (entry[0] & 0x7f) === 0x41);
        if (!layoutOk) { warnings.push({ code: 'UNSUPPORTED_ENTRY_SET_LAYOUT', offset: chunk.offset + at }); next(); continue; }
        const fullName = cleanUnicode(entries.slice(1).map(entry => entry.subarray(2, 32).toString('utf16le')).join('').slice(0, nameLength));
        if (nameLength === 0 || !validFatName(fullName)) { warnings.push({ code: 'INVALID_FILE_NAME', offset: chunk.offset + at }); next(); continue; }
        const isDirectory = Boolean(primary.readUInt16LE(4) & 0x10), firstCluster = stream.readUInt32LE(20), size = safeNumber(stream.readBigUInt64LE(24), 'exFAT 파일'),
          validSize = safeNumber(stream.readBigUInt64LE(8), 'exFAT 유효 데이터'), noFatChain = Boolean(stream[1] & 0x02);
        if (!inactive && isDirectory && firstCluster >= 2) queue.push({ firstCluster, path: `${directory.path}${fullName}\\`, contiguous: noFatChain, clusterCount: Math.ceil(size / this.info.clusterSize) });
        if (!inactive || isDirectory) { next(); continue; }
        const id = `exfat:${chunk.offset + at}`, needed = Math.ceil(size / this.info.clusterSize); let clusters = [], state;
        if (validSize > size) state = { status: 'unsupported', reasons: ['INVALID_VALID_DATA_LENGTH'] };
        else if (validSize !== size) state = { status: 'unsupported', reasons: ['UNINITIALIZED_DATA_TAIL_REFUSED'] };
        else if (size === 0) state = { status: 'readable', reasons: ['EMPTY_FILE_RECORD', 'ENTRY_SET_CHECKSUM_VERIFIED'] };
        else if (firstCluster < 2 || firstCluster + (noFatChain ? needed : 1) > this.info.clusterCount + 2) state = { status: 'unsupported', reasons: ['INVALID_START_CLUSTER'] };
        else if (needed > MAX_CHAIN - (this.rememberedClusters ?? 0)) state = { status: 'unsupported', reasons: ['SCAN_METADATA_LIMIT'] };
        else {
          try { clusters = noFatChain ? Array.from({ length: needed }, (_, i) => firstCluster + i) : await this.chain(firstCluster, signal, needed); }
          catch (error) { state = { status: 'unsupported', reasons: [error.code || 'AMBIGUOUS_DELETED_CLUSTER_CHAIN'] }; }
          if (!state) state = await this.clustersFree(clusters, bitmap, signal) ?
            { status: 'readable', reasons: [noFatChain ? 'NO_FAT_CHAIN_CONTIGUOUS_EXTENT' : 'FAT_CHAIN_VERIFIED', 'CLUSTERS_FREE', 'ENTRY_SET_CHECKSUM_VERIFIED'] } :
            { status: 'conflict', reasons: ['CLUSTER_ALLOCATED', 'ENTRY_SET_CHECKSUM_VERIFIED'] };
        }
        if (state.status !== 'readable') clusters = [];
        const base = { id, name: fullName, size, path: `${directory.path}${fullName}`, pathStatus: 'known-parent', modifiedAt: exfatTime(primary.readUInt32LE(12)), kind: 'file' };
        let candidate = this.makeCandidate(base, stats.candidatesFound, state);
        candidate = this.rememberRecord(id, { candidate, fingerprint: fingerprint(set), clusters, size });
        candidates.push(candidate); stats.candidatesFound++; onCandidate?.(candidate); onProgress?.({ stage: 'scan', ...stats }); next();
        if (candidates.length >= maxCandidates) break;
      }
    }
    return candidates;
  }
  async scanInternal(options, remember = true) {
    const maxCandidates = options.maxCandidates ?? 10000;
    requireValue(Number.isInteger(maxCandidates) && maxCandidates > 0 && maxCandidates <= 100000, 'INVALID_LIMIT', '후보 제한이 잘못됐어요.');
    if (remember) this.records.clear();
    const prior = this.records; if (!remember) this.records = new Map();
    const warnings = [], stats = { directoriesRead: 0, entriesRead: 0, candidatesFound: 0, warningCount: 0 };
    this.rememberedClusters = 0;
    Object.defineProperty(warnings, 'push', { value: (...items) => { stats.warningCount += items.length; return Array.prototype.push.apply(warnings, items.slice(0, Math.max(0, 100 - warnings.length))); } });
    try {
      const candidates = this.info.type === 'exFAT' ? await this.scanExfat({ ...options, maxCandidates }, warnings, stats) : await this.scanClassic({ ...options, maxCandidates }, warnings, stats);
      return { candidates, warnings, stats, complete: candidates.length < maxCandidates && warnings.length === 0 };
    } finally { if (!remember) { const fresh = this.records; this.records = prior; this.freshRecords = fresh; } }
  }
  async scanDeleted(options = {}) {
    requireValue(!this.closed, 'CLOSED', '이미 닫힌 볼륨이에요.'); requireValue(!this.busy, 'BUSY', '다른 작업이 진행 중이에요.'); this.busy = true;
    try { cancelled(options.signal); await this.provider.assertUnchanged(); const result = await this.scanInternal(options, true); await this.provider.assertUnchanged(); return result; }
    finally { this.busy = false; }
  }
  async readCandidateBytes(recordIdOrNumber, { maxBytes = 8 * 1024 * 1024, signal, control } = {}) {
    requireValue(!this.closed, 'CLOSED', '이미 닫힌 볼륨이에요.'); requireValue(!this.busy, 'BUSY', '다른 작업이 진행 중이에요.');
    requireValue(Number.isSafeInteger(maxBytes) && maxBytes >= 1024 && maxBytes <= 8 * 1024 * 1024,
      'INVALID_LIMIT', '미리보기 읽기 한도가 잘못됐어요.');
    this.busy = true;
    try {
      cancelled(signal); await this.provider.assertUnchanged();
      const previous = typeof recordIdOrNumber === 'number' ? [...this.records.values()].find(record => record.candidate.recordNumber === recordIdOrNumber) : this.records.get(String(recordIdOrNumber));
      requireValue(previous, 'SCAN_REQUIRED', '먼저 삭제 파일 후보를 검색해주세요.');
      requireValue(previous.candidate.status === 'readable', 'NOT_RECOVERABLE', previous.candidate.reasons.join(' '));
      requireValue(previous.size <= maxBytes, 'PREVIEW_TOO_LARGE', '8MB 이하의 파일만 미리 볼 수 있어요.');
      await this.scanInternal({ signal, control, maxCandidates: 100000 }, false);
      const fresh = this.freshRecords.get(previous.candidate.id);
      requireValue(sameRecoveryProof(previous, fresh), 'SOURCE_CHANGED', '선택한 삭제 기록이나 데이터 범위가 바뀌었어요.');
      const bytes = Buffer.alloc(fresh.size); let offset = 0;
      for (const cluster of fresh.clusters) {
        cancelled(signal); await control?.checkpoint();
        const count = Math.min(this.info.clusterSize, fresh.size - offset);
        const chunk = await this.read(this.clusterOffset(cluster), count, signal); chunk.copy(bytes, offset); offset += chunk.length;
      }
      requireValue(offset === fresh.size, 'INVALID_CHAIN', '미리 볼 클러스터가 파일 크기와 맞지 않아요.');
      await this.provider.assertUnchanged();
      await this.scanInternal({ signal, control, maxCandidates: 100000 }, false);
      requireValue(sameRecoveryProof(fresh, this.freshRecords.get(previous.candidate.id)), 'SOURCE_CHANGED', '읽는 동안 삭제 기록이나 데이터 범위가 바뀌었어요.');
      return bytes;
    } finally { this.busy = false; }
  }
  async recover(recordIdOrNumber, destinationDirectory, { signal, control, onProgress } = {}) {
    requireValue(!this.closed, 'CLOSED', '이미 닫힌 볼륨이에요.'); requireValue(!this.busy, 'BUSY', '다른 작업이 진행 중이에요.'); this.busy = true;
    let output, partialPath, savedPath, saved = false;
    try {
      cancelled(signal); await this.provider.assertUnchanged();
      const previous = typeof recordIdOrNumber === 'number' ? [...this.records.values()].find(record => record.candidate.recordNumber === recordIdOrNumber) : this.records.get(String(recordIdOrNumber));
      requireValue(previous, 'SCAN_REQUIRED', '먼저 삭제 파일 후보를 검색해주세요.');
      requireValue(previous.candidate.status === 'readable', 'NOT_RECOVERABLE', previous.candidate.reasons.join(' '));
      await this.scanInternal({ signal, control, maxCandidates: 100000 }, false);
      const fresh = this.freshRecords.get(previous.candidate.id);
      requireValue(sameRecoveryProof(previous, fresh), 'SOURCE_CHANGED', '선택한 삭제 기록이나 데이터 범위가 바뀌었어요.');
      const destination = path.resolve(destinationDirectory); await mkdir(destination, { recursive: true }); const resolved = await realpath(destination);
      requireValue((await stat(resolved)).isDirectory(), 'UNSAFE_OUTPUT', '저장 폴더가 필요해요.');
      const folder = await mkdtemp(path.join(resolved, '.recovery-working-'), { encoding: 'utf8' });
      partialPath = path.join(folder, '.recovery-writing.partial'); savedPath = path.join(folder, safeName(fresh.candidate.name, fresh.candidate.recordNumber));
      if (savedPath === partialPath) savedPath += '-file'; output = await open(partialPath, 'wx', 0o600);
      const digest = createHash('sha256'); let written = 0;
      for (const cluster of fresh.clusters) {
        cancelled(signal); await control?.checkpoint();
        const count = Math.min(this.info.clusterSize, fresh.size - written), bytes = await this.read(this.clusterOffset(cluster), count, signal);
        let done = 0; while (done < bytes.length) { const result = await output.write(bytes, done, bytes.length - done, written + done); requireValue(result.bytesWritten > 0, 'WRITE_FAILED', '복구본 저장이 중단됐어요.'); done += result.bytesWritten; }
        digest.update(bytes); written += bytes.length; onProgress?.({ stage: 'recover', bytesWritten: written, bytesTotal: fresh.size });
      }
      requireValue(written === fresh.size, 'INVALID_CHAIN', '복구할 클러스터가 파일 크기와 맞지 않아요.');
      cancelled(signal);
      await output.sync(); await output.close(); output = null; await this.provider.assertUnchanged();
      await this.scanInternal({ signal, control, maxCandidates: 100000 }, false);
      const after = this.freshRecords.get(previous.candidate.id);
      requireValue(sameRecoveryProof(fresh, after), 'SOURCE_CHANGED', '복구 중 삭제 기록이나 데이터 범위가 바뀌었어요.');
      const published = path.join(resolved, `recovered-${randomUUID()}`); await rename(folder, published);
      partialPath = path.join(published, path.basename(partialPath)); savedPath = path.join(published, path.basename(savedPath)); await rename(partialPath, savedPath); saved = true;
      return { path: savedPath, status: 'saved', size: written, sha256: digest.digest('hex'), originalIdentityVerified: false };
    } catch (error) {
      if (output) await output.close().catch(() => {});
      if (error instanceof FatVolumeError) { error.details = { ...error.details, partialPath: saved ? null : partialPath ?? null, savedPath: saved ? savedPath : null }; throw error; }
      throw new FatVolumeError(error.code === 'ENOSPC' ? 'OUTPUT_FULL' : 'IO_FAILED', error.message, { partialPath: saved ? null : partialPath ?? null, savedPath: saved ? savedPath : null });
    } finally { this.busy = false; }
  }
  async close() { requireValue(!this.busy, 'BUSY', '작업을 마친 뒤 닫아주세요.'); if (!this.closed) { this.closed = true; await this.provider.close(); } }
}

export async function openFatProvider(provider) {
  requireValue(provider && Number.isSafeInteger(provider.info?.size) && provider.info.size >= 512 && Number.isSafeInteger(provider.info?.sectorSize) &&
    typeof provider.read === 'function' && typeof provider.assertUnchanged === 'function' && typeof provider.close === 'function',
  'INVALID_PROVIDER', '정확한 읽기와 변경 확인을 제공하는 읽기 전용 공급자가 필요해요.');
  const volume = new FatVolume(provider);
  try {
    const boot = await volume.read(0, 512);
    let parsed;
    if (boot.subarray(3, 11).toString('ascii') === 'EXFAT   ') {
      const sectorSize = 2 ** boot[108]; requireValue(sectorSize >= 512 && sectorSize <= 4096, 'INVALID_BOOT', 'exFAT 섹터 크기가 잘못됐어요.');
      parsed = parseExfatBoot(await volume.read(0, 12 * sectorSize), provider.info.size);
    } else {
      requireValue(boot.subarray(3, 11).toString('ascii') !== 'NTFS    ', 'UNSUPPORTED_FILE_SYSTEM', 'NTFS 볼륨은 NTFS 공급자로 열어야 해요.');
      parsed = parseFatBoot(boot, provider.info.size);
    }
    volume.info = Object.freeze({ ...parsed, size: parsed.volumeSize, fileSystem: parsed.type, sourceKind: provider.info.sourceKind || 'provider', identity: provider.info.identity });
    await provider.assertUnchanged(); return volume;
  } catch (error) { await provider.close().catch(() => {}); throw error; }
}
