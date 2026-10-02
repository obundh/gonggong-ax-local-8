import { open, realpath, stat, mkdir, mkdtemp, rename } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { decompressLznt1, Lznt1Error } from './lznt1.mjs';
import { readUsnDeletionEvents, readUsnDeletionTimes } from './usn-journal.mjs';
import { findDirectoryIndexEntries } from './ntfs-directory-index.mjs';
import { verifyRecoveredFile } from './recovery-verification.mjs';
import { chooseRecoveryName, shortenOutputName } from './recovery-name.mjs';
import { captureRecordEvidence, summarizeRecord, recordChangedError as describeRecordChange } from './record-diagnostics.mjs';

// This engine reads only through a regular image handle or a caller-supplied read-only provider. It never opens a raw device itself.
const MAX_READ = 1024 * 1024;
const MAX_WARNINGS = 100;
const MAX_PARENT_DEPTH = 128;
const MAX_CHECKPOINT_ENTRIES = 10000;
const MAX_CHECKPOINT_EXTENSIONS = 10000;
const MAX_ATTRIBUTE_LIST_BYTES = 64 * 1024;
const MAX_ATTRIBUTE_LIST_ENTRIES = 256;
const MAX_EXTENSION_RECORDS = 64;
const MAX_STREAM_RUNS = 65536;
const MAX_COMPRESSION_UNITS = 65536;
const NTFS_COMPRESSION_CLUSTERS = 16;
const NTFS_COMPRESSION_UNIT_SIZE = 64 * 1024;
const ZONE_IDENTIFIER_STREAM = 'Zone.Identifier';
const MAX_ZONE_IDENTIFIER_BYTES = 512;
const EMPTY_NONRESIDENT_LAST_VCN = 0xffffffffffffffffn;

export class RecoveryError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'RecoveryError';
    this.code = code;
    this.details = details;
  }
}

function requireValue(condition, code, message, details) {
  if (!condition) throw new RecoveryError(code, message, details);
}

function recordChangedError(expected, observed, options) {
  const described = describeRecordChange(expected, observed, options);
  return new RecoveryError(described.code, described.message, described.details);
}

// MFT header flags also include SYSTEM (0x4) and VIEW_INDEX (0x8).
// https://github.com/torvalds/linux/blob/master/fs/ntfs3/ntfs.h
// A journal may be an allocated system data file (0x5); view indexes and
// directories must not be interpreted as its $J data stream.
function isLiveDataRecord(record) { return record?.flags === 1 || record?.flags === 5; }

function cancelled(signal) {
  if (signal?.aborted) throw new RecoveryError('CANCELLED', '작업을 취소했어요.');
}

function safeNumber(value, label) {
  requireValue(value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER), 'INVALID_RANGE', `${label}: 지원 범위를 벗어난 위치예요.`);
  return Number(value);
}

function range(offset, length, total, label) {
  requireValue(Number.isSafeInteger(offset) && Number.isSafeInteger(length) && offset >= 0 && length >= 0 && offset <= total && length <= total - offset,
    'INVALID_RANGE', `${label}: 범위를 벗어났어요.`);
}

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function checkpointError(message) {
  throw new RecoveryError('INVALID_CHECKPOINT', message);
}

function u64(buffer, offset, label) {
  return safeNumber(buffer.readBigUInt64LE(offset), label);
}

function signedInteger(buffer, offset, size) {
  let value = 0n;
  for (let i = 0; i < size; i++) value |= BigInt(buffer[offset + i]) << BigInt(8 * i);
  if (buffer[offset + size - 1] & 0x80) value -= 1n << BigInt(size * 8);
  return value;
}

function unsignedInteger(buffer, offset, size) {
  let value = 0n;
  for (let i = 0; i < size; i++) value |= BigInt(buffer[offset + i]) << BigInt(8 * i);
  return value;
}

function fileTime(buffer, offset) {
  const value = buffer.readBigUInt64LE(offset);
  if (!value) return null;
  const ms = Number(value / 10000n - 11644473600000n);
  if (!Number.isSafeInteger(ms) || Math.abs(ms) > 8640000000000000) return null;
  return new Date(ms).toISOString();
}

function reference(value) {
  return { recordNumber: Number(value & 0xffffffffffffn), sequence: Number(value >> 48n) };
}

function parseBoot(buffer, imageSize) {
  requireValue(buffer.subarray(3, 11).toString('ascii') === 'NTFS    ' && buffer[510] === 0x55 && buffer[511] === 0xaa,
    'UNSUPPORTED_FILESYSTEM', '시작 위치가 0인 NTFS 볼륨 이미지가 필요해요. 파티션이 포함된 전체 디스크 이미지는 아직 지원하지 않아요.');
  const sectorSize = buffer.readUInt16LE(11);
  const sectorsPerCluster = buffer[13];
  requireValue([512, 1024, 2048, 4096].includes(sectorSize) && sectorsPerCluster > 0 && sectorsPerCluster <= 128 && (sectorsPerCluster & (sectorsPerCluster - 1)) === 0,
    'INVALID_BOOT', '섹터 또는 클러스터 크기가 올바르지 않아요.');
  const clusterSize = sectorSize * sectorsPerCluster;
  const totalSectors = u64(buffer, 40, '전체 섹터');
  const volumeSize = safeNumber(BigInt(totalSectors) * BigInt(sectorSize), '볼륨 크기');
  requireValue(volumeSize >= clusterSize && volumeSize <= imageSize, 'TRUNCATED_IMAGE', '볼륨 크기보다 이미지 파일이 작거나 볼륨 정보가 잘못됐어요.');
  const clusterCount = Math.floor(volumeSize / clusterSize);
  const mftCluster = u64(buffer, 48, 'MFT 위치');
  const recordCode = buffer.readInt8(64);
  const recordSize = recordCode < 0 ? 2 ** (-recordCode) : recordCode * clusterSize;
  requireValue(Number.isInteger(recordSize) && recordSize >= sectorSize && recordSize <= 65536 && recordSize % sectorSize === 0,
    'INVALID_BOOT', '지원하지 않는 파일 기록 크기예요.');
  range(mftCluster * clusterSize, recordSize, volumeSize, 'MFT 시작');
  return { filesystem: 'NTFS', sourceKind: 'volume-image', sectorSize, clusterSize, clusterCount, volumeSize, recordSize, mftCluster,
    volumeSerial: buffer.readBigUInt64LE(72).toString(16), readOnly: true };
}

function parseRuns(attr, info, { firstVcn, lastVcn, empty = false }) {
  requireValue(empty || lastVcn >= firstVcn, 'INVALID_RUNS', '저장 위치 목록의 VCN 범위가 잘못됐어요.');
  let cursor = attr.readUInt16LE(32);
  requireValue(cursor >= 64 && cursor < attr.length, 'INVALID_RUNS', '저장 위치 목록의 시작이 잘못됐어요.');
  // An empty nonresident stream has no VCNs and its mapping-pairs list is
  // only the required zero terminator (with zero alignment padding).
  if (empty) {
    requireValue(attr.subarray(cursor).every(byte => byte === 0), 'INVALID_RUNS',
      '빈 nonresident 데이터 스트림의 저장 위치 목록이 비어 있지 않아요.');
    return [];
  }
  let lcn = 0n;
  let vcn = firstVcn;
  let ended = false;
  const runs = [];
  while (cursor < attr.length) {
    const header = attr[cursor++];
    if (header === 0) { ended = true; break; }
    const lengthSize = header & 15;
    const offsetSize = header >> 4;
    requireValue(lengthSize >= 1 && lengthSize <= 8 && offsetSize <= 8, 'INVALID_RUNS', '저장 위치 목록의 정수 길이가 잘못됐어요.');
    range(cursor, lengthSize + offsetSize, attr.length, '저장 위치 항목');
    const count = safeNumber(unsignedInteger(attr, cursor, lengthSize), '클러스터 수');
    requireValue(count > 0 && count <= info.clusterCount, 'INVALID_RUNS', '클러스터 수가 잘못됐어요.');
    requireValue(runs.length < MAX_STREAM_RUNS, 'UNSUPPORTED_ATTRIBUTE', '데이터 저장 구간이 65536개를 넘어 지원 범위를 벗어났어요.');
    cursor += lengthSize;
    requireValue(Number.isSafeInteger(vcn + count), 'INVALID_RUNS', '저장 위치 목록이 너무 커요.');
    if (offsetSize === 0) {
      runs.push({ vcn, lcn: null, count, sparse: true });
      vcn += count;
      continue;
    }
    lcn += signedInteger(attr, cursor, offsetSize);
    cursor += offsetSize;
    const start = safeNumber(lcn, '클러스터 위치');
    range(start, count, info.clusterCount, '데이터 구간');
    // LCN 0 includes the boot sector, never accepted as recoverable file data.
    requireValue(start > 0, 'INVALID_RUNS', '부트 영역을 가리키는 파일 데이터는 읽지 않아요.');
    runs.push({ vcn, lcn: start, count, sparse: false });
    vcn += count;
  }
  requireValue(ended && runs.length > 0 && vcn - 1 === lastVcn, 'INVALID_RUNS', '저장 위치 목록의 끝 또는 크기가 맞지 않아요.');
  return runs;
}

function compressionUnits(runs, info) {
  const totalClusters = runs.reduce((sum, run) => sum + run.count, 0);
  requireValue(Number.isSafeInteger(totalClusters), 'UNSUPPORTED_ATTRIBUTE', '압축 스트림의 논리 클러스터 수가 지원 범위를 벗어났어요.');
  requireValue(totalClusters % NTFS_COMPRESSION_CLUSTERS === 0, 'UNSUPPORTED_ATTRIBUTE',
    '완전한 16클러스터 단위가 아닌 압축 저장 위치는 지원하지 않아요.');
  const unitCount = totalClusters / NTFS_COMPRESSION_CLUSTERS;
  requireValue(unitCount <= MAX_COMPRESSION_UNITS, 'UNSUPPORTED_ATTRIBUTE',
    '압축 단위가 65536개를 넘어 지원 범위를 벗어났어요.');
  const units = [];
  let firstRun = 0;
  for (let unitVcn = 0; unitVcn < totalClusters; unitVcn += NTFS_COMPRESSION_CLUSTERS) {
    const unitEnd = unitVcn + NTFS_COMPRESSION_CLUSTERS;
    const parts = [];
    while (firstRun < runs.length && runs[firstRun].vcn + runs[firstRun].count <= unitVcn) firstRun++;
    for (let index = firstRun; index < runs.length; index++) {
      const run = runs[index];
      if (run.vcn >= unitEnd) break;
      const start = Math.max(unitVcn, run.vcn);
      const end = Math.min(unitEnd, run.vcn + run.count);
      if (start >= end) continue;
      parts.push({ vcn: start, count: end - start, sparse: run.sparse,
        lcn: run.sparse ? null : run.lcn + start - run.vcn });
    }
    requireValue(parts.reduce((sum, part) => sum + part.count, 0) === NTFS_COMPRESSION_CLUSTERS,
      'INVALID_ATTRIBUTE', '압축 단위의 저장 위치가 완전하지 않아요.');
    const firstSparse = parts.findIndex(part => part.sparse);
    requireValue(firstSparse < 0 || parts.slice(firstSparse).every(part => part.sparse), 'INVALID_ATTRIBUTE',
      '압축 단위의 희소 꼬리 뒤에 물리 데이터가 있어요.');
    const physicalClusters = parts.filter(part => !part.sparse).reduce((sum, part) => sum + part.count, 0);
    const kind = physicalClusters === 0 ? 'zero' : physicalClusters === NTFS_COMPRESSION_CLUSTERS ? 'raw' : 'compressed';
    units.push({ vcn: unitVcn, parts, physicalClusters, kind });
  }
  return units;
}

function parseAttribute(buffer, info) {
  const type = buffer.readUInt32LE(0);
  const form = buffer[8];
  const nameLength = buffer[9];
  const nameOffset = buffer.readUInt16LE(10);
  const flags = buffer.readUInt16LE(12);
  requireValue(form === 0 || form === 1, 'INVALID_ATTRIBUTE', '알 수 없는 속성 형태예요.');
  const headerSize = form ? 64 : 24;
  requireValue(buffer.length >= headerSize, 'INVALID_ATTRIBUTE', '속성 헤더가 잘렸어요.');
  let name = '';
  if (nameLength) {
    requireValue(nameOffset >= headerSize, 'INVALID_ATTRIBUTE', '속성 이름이 헤더와 겹쳐요.');
    range(nameOffset, nameLength * 2, buffer.length, '속성 이름');
    name = buffer.subarray(nameOffset, nameOffset + nameLength * 2).toString('utf16le');
  }
  const result = { type, name, flags, id: buffer.readUInt16LE(14), resident: !form };
  if (!form) {
    const size = buffer.readUInt32LE(16);
    const offset = buffer.readUInt16LE(20);
    requireValue(offset >= headerSize && (!nameLength || offset >= nameOffset + nameLength * 2), 'INVALID_ATTRIBUTE', '속성 내용이 헤더 또는 이름과 겹쳐요.');
    range(offset, size, buffer.length, '속성 내용');
    result.size = size;
    result.initializedSize = size;
    result.value = Buffer.from(buffer.subarray(offset, offset + size));
  } else {
    result.firstVcn = u64(buffer, 16, '시작 VCN');
    const rawLastVcn = buffer.readBigUInt64LE(24);
    result.size = u64(buffer, 48, '파일 크기');
    result.initializedSize = u64(buffer, 56, '초기화된 크기');
    result.allocatedSize = u64(buffer, 40, '할당 크기');
    try {
      const compressed = flags === 0x0001;
      const sparse = flags === 0x8000;
      requireValue(flags === 0 || compressed || sparse, 'UNSUPPORTED_ATTRIBUTE', '암호화되거나 함께 표시된 특수 속성은 지원하지 않아요.');
      const mappingOffset = buffer.readUInt16LE(32);
      const compressionUnit = buffer[34];
      requireValue(buffer.subarray(35, 40).every(byte => byte === 0), 'INVALID_ATTRIBUTE', '속성 헤더의 예약 영역이 올바르지 않아요.');
      // Windows sparse $J streams may use unit 4 with an extended size header
      // on VCN 0, while their continuation extents use unit 0 / a 64-byte header.
      // Sparse data is never passed to the LZNT1 decoder.
      const extendedSparse = sparse && result.firstVcn === 0 && compressionUnit === 4;
      requireValue(compressed ? buffer.length >= 72 && mappingOffset >= 72 && compressionUnit === 4
        && info.clusterSize === 4096 : extendedSparse ? buffer.length >= 72 && mappingOffset >= 72
          : mappingOffset >= 64 && compressionUnit === 0,
      compressed ? 'UNSUPPORTED_ATTRIBUTE' : 'INVALID_ATTRIBUTE',
      compressed ? '4KiB 클러스터와 16클러스터 단위를 쓰는 NTFS LZNT1만 지원해요.' : '속성 헤더 또는 압축 단위가 잘못됐어요.');
      requireValue(!nameLength || mappingOffset >= nameOffset + nameLength * 2, 'INVALID_ATTRIBUTE', '이름과 저장 위치 목록이 겹쳐요.');
      if (compressed || extendedSparse) requireValue(!nameLength || nameOffset >= 72,
        'INVALID_ATTRIBUTE', '속성 이름이 확장 크기 헤더와 겹쳐요.');
      // NTFS stores the VCN fields as signed values. Windows-created empty
      // nonresident streams can therefore encode their absent final VCN as -1.
      // Accept only the exact zero-length, unflagged form; all other values
      // retain the normal safe-integer and runlist checks below.
      result.emptyNonresident = result.firstVcn === 0 && rawLastVcn === EMPTY_NONRESIDENT_LAST_VCN
        && result.size === 0 && result.initializedSize === 0 && result.allocatedSize === 0 && flags === 0;
      result.lastVcn = result.emptyNonresident ? -1 : safeNumber(rawLastVcn, '끝 VCN');
      result.runs = parseRuns(buffer, info, { ...result, empty: result.emptyNonresident });
      if (result.firstVcn === 0) requireValue(result.initializedSize <= result.size, 'INVALID_ATTRIBUTE', '초기화된 데이터 크기가 파일 크기보다 커요.');
      result.compressed = compressed;
      if (compressed) {
        result.compressedSize = u64(buffer, 64, '압축 크기');
      }
      if (extendedSparse) result.sparsePhysicalSize = u64(buffer, 64, '희소 파일의 실제 할당 크기');
    } catch (error) {
      if (!(error instanceof RecoveryError)) throw error;
      result.problem = { code: error.code, message: error.message };
    }
  }
  if (![0, 0x0001, 0x8000].includes(flags)) result.problem = { code: 'UNSUPPORTED_ATTRIBUTE', message: '암호화되거나 함께 표시된 특수 속성은 지원하지 않아요.' };
  return result;
}

function completeStream(segments, info) {
  requireValue(segments.length >= 1 && segments.every(segment => !segment.resident && !segment.problem), 'INVALID_ATTRIBUTE', '데이터 속성 조각을 검증할 수 없어요.');
  const ordered = [...segments].sort((a, b) => a.firstVcn - b.firstVcn);
  const first = ordered[0];
  requireValue(first.firstVcn === 0, 'INVALID_ATTRIBUTE', '데이터 속성의 첫 VCN이 0이 아니에요.');
  requireValue(!first.emptyNonresident || (ordered.length === 1 && first.lastVcn === -1 && first.runs.length === 0),
    'INVALID_ATTRIBUTE', '빈 nonresident 데이터 스트림은 하나의 빈 기본 조각이어야 해요.');
  for (let index = 0; index < ordered.length; index += 1) {
    const segment = ordered[index];
    requireValue(segment.type === first.type && segment.name === first.name && segment.flags === first.flags
      && segment.compressed === first.compressed, 'INVALID_ATTRIBUTE', '데이터 속성 조각의 형식 또는 표시가 서로 달라요.');
    if (index) requireValue(segment.firstVcn === ordered[index - 1].lastVcn + 1, 'INVALID_ATTRIBUTE', '데이터 속성 조각의 VCN이 이어지지 않아요.');
    if (index) requireValue(segment.size === 0 && segment.initializedSize === 0 && segment.allocatedSize === 0
      && (!segment.compressed || segment.compressedSize === 0)
      && (segment.sparsePhysicalSize == null || segment.sparsePhysicalSize === 0), 'INVALID_ATTRIBUTE', '확장 데이터 조각에 기본 조각 전용 크기 값이 있어요.');
  }
  const runCount = ordered.reduce((sum, segment) => sum + segment.runs.length, 0);
  requireValue(runCount <= MAX_STREAM_RUNS, 'UNSUPPORTED_ATTRIBUTE', '병합된 데이터 저장 구간이 65536개를 넘어 지원 범위를 벗어났어요.');
  const runs = ordered.flatMap(segment => segment.runs);
  const physicalRuns = runs.filter(run => !run.sparse).sort((a, b) => a.lcn - b.lcn);
  for (let index = 1; index < physicalRuns.length; index++) {
    const previous = physicalRuns[index - 1];
    const current = physicalRuns[index];
    requireValue(previous.lcn + previous.count <= current.lcn,
      'INVALID_RUNS', '데이터 속성 조각의 물리 저장 구간이 겹쳐요.');
  }
  const logicalClusters = ordered.at(-1).lastVcn + 1;
  requireValue(Number.isSafeInteger(logicalClusters), 'UNSUPPORTED_ATTRIBUTE', '데이터 스트림의 논리 클러스터 수가 지원 범위를 벗어났어요.');
  const capacity = BigInt(logicalClusters) * BigInt(info.clusterSize);
  const physicalCapacity = runs.filter(run => !run.sparse).reduce((sum, run) => sum + BigInt(run.count) * BigInt(info.clusterSize), 0n);
  const hasSparseRuns = runs.some(run => run.sparse);
  // Compressed attributes keep logical allocation at 0x28 and the actual
  // physical cluster total at 0x40. They need not (and usually do not) match.
  // See ATTRIBUTE_RECORD_HEADER / NTFS3 ATTR_NONRESIDENT.
  const allocationMatches = first.compressed
    ? BigInt(first.allocatedSize) === capacity && BigInt(first.compressedSize) === physicalCapacity
    : first.sparsePhysicalSize != null
    ? BigInt(first.allocatedSize) === capacity && BigInt(first.sparsePhysicalSize) === physicalCapacity
    : BigInt(first.allocatedSize) === physicalCapacity;
  requireValue(first.initializedSize <= first.size && BigInt(first.size) <= capacity && allocationMatches,
    'INVALID_ATTRIBUTE', '파일 크기와 전체 데이터 속성 조각의 크기가 맞지 않아요.');
  requireValue(!hasSparseRuns || first.compressed || Boolean(first.flags & 0x8000), 'INVALID_ATTRIBUTE', '희소 저장 구간에 필요한 속성 표시가 없어요.');
  const stream = { ...first, runs, lastVcn: ordered.at(-1).lastVcn, split: ordered.length > 1 };
  if (first.compressed) {
    stream.compressionUnits = compressionUnits(runs, info);
  }
  return stream;
}

function parseAttributeList(attribute, info) {
  requireValue(attribute.resident && !attribute.problem && attribute.name === '' && attribute.flags === 0,
    'UNSUPPORTED_ATTRIBUTE', '현재는 기본 기록 안의 resident $ATTRIBUTE_LIST만 지원해요.');
  requireValue(attribute.value.length >= 32 && attribute.value.length <= MAX_ATTRIBUTE_LIST_BYTES,
    'UNSUPPORTED_ATTRIBUTE', '$ATTRIBUTE_LIST 크기가 지원 범위를 벗어났어요.');
  const entries = [];
  const unique = new Set();
  let cursor = 0;
  let previous;
  while (cursor < attribute.value.length) {
    requireValue(entries.length < MAX_ATTRIBUTE_LIST_ENTRIES, 'UNSUPPORTED_ATTRIBUTE', '$ATTRIBUTE_LIST 항목이 너무 많아요.');
    range(cursor, 26, attribute.value.length, '$ATTRIBUTE_LIST 항목');
    const type = attribute.value.readUInt32LE(cursor);
    const length = attribute.value.readUInt16LE(cursor + 4);
    const nameLength = attribute.value[cursor + 6];
    const nameOffset = attribute.value[cursor + 7];
    requireValue(type !== 0xffffffff && length >= 32 && length % 8 === 0, 'INVALID_ATTRIBUTE_LIST', '$ATTRIBUTE_LIST 항목 길이가 잘못됐어요.');
    range(cursor, length, attribute.value.length, '$ATTRIBUTE_LIST 항목');
    let name = '';
    if (nameLength) {
      requireValue(nameOffset >= 26 && nameOffset + nameLength * 2 <= length, 'INVALID_ATTRIBUTE_LIST', '$ATTRIBUTE_LIST 이름 범위가 잘못됐어요.');
      name = attribute.value.subarray(cursor + nameOffset, cursor + nameOffset + nameLength * 2).toString('utf16le');
    }
    const lowestVcn = u64(attribute.value, cursor + 8, '$ATTRIBUTE_LIST VCN');
    const segment = reference(attribute.value.readBigUInt64LE(cursor + 16));
    const attributeId = attribute.value.readUInt16LE(cursor + 24);
    requireValue(segment.sequence > 0 && segment.recordNumber < info.recordCount, 'INVALID_ATTRIBUTE_LIST', '$ATTRIBUTE_LIST 파일 참조가 범위를 벗어났어요.');
    const key = `${type}:${name}:${lowestVcn}`;
    requireValue(!unique.has(key), 'INVALID_ATTRIBUTE_LIST', '$ATTRIBUTE_LIST에 중복된 속성 조각이 있어요.');
    unique.add(key);
    const entry = { type, name, lowestVcn, segment, attributeId };
    if (previous) {
      const ordered = previous.type < type || (previous.type === type && (previous.name < name
        || (previous.name === name && previous.lowestVcn < lowestVcn)));
      requireValue(ordered, 'INVALID_ATTRIBUTE_LIST', '$ATTRIBUTE_LIST 항목 순서가 잘못됐어요.');
    }
    entries.push(entry);
    previous = entry;
    cursor += length;
  }
  requireValue(cursor === attribute.value.length, 'INVALID_ATTRIBUTE_LIST', '$ATTRIBUTE_LIST 끝이 항목 경계와 맞지 않아요.');
  return entries;
}

function parseRecord(raw, info, recordNumber) {
  if (raw.every(byte => byte === 0)) return null;
  requireValue(raw.subarray(0, 4).toString('ascii') === 'FILE', 'INVALID_RECORD', 'FILE 서명이 없는 기록이에요.');
  const buffer = Buffer.from(raw);
  const usaOffset = buffer.readUInt16LE(4);
  const usaCount = buffer.readUInt16LE(6);
  requireValue(usaCount === buffer.length / info.sectorSize + 1 && usaOffset >= 42 && usaOffset % 2 === 0,
    'INVALID_FIXUP', '파일 기록의 섹터 검증 정보가 잘못됐어요.');
  range(usaOffset, usaCount * 2, buffer.length, '섹터 검증 배열');
  requireValue(usaOffset + usaCount * 2 <= info.sectorSize - 2, 'INVALID_FIXUP', '섹터 검증 배열이 첫 섹터를 벗어났어요.');
  const updateSequence = buffer.readUInt16LE(usaOffset);
  for (let i = 1; i < usaCount; i++) {
    const tail = i * info.sectorSize - 2;
    requireValue(buffer.readUInt16LE(tail) === updateSequence, 'INVALID_FIXUP', '부분 기록 또는 손상된 섹터가 있어요.');
    buffer.writeUInt16LE(buffer.readUInt16LE(usaOffset + i * 2), tail);
  }
  let offset = buffer.readUInt16LE(20);
  const used = buffer.readUInt32LE(24);
  const allocated = buffer.readUInt32LE(28);
  const sequence = buffer.readUInt16LE(16), flags = buffer.readUInt16LE(22);
  const headerDetails = { recordNumber, sequence, flags };
  requireValue(sequence > 0, 'INVALID_RECORD', '파일 기록의 식별 번호를 확인할 수 없어 해당 기록을 읽지 못했어요.', headerDetails);
  requireValue((flags & ~0x0f) === 0, 'INVALID_RECORD', '지원하지 않는 상태값의 파일 기록이라 해당 기록을 읽지 못했어요.', headerDetails);
  requireValue(allocated === buffer.length && used <= allocated && offset >= usaOffset + usaCount * 2 && offset % 8 === 0 && offset + 4 <= used,
    'INVALID_RECORD', '속성 목록의 경계가 잘못됐어요.');
  const attributes = [];
  let ended = false;
  while (offset + 4 <= used) {
    const type = buffer.readUInt32LE(offset);
    if (type === 0xffffffff) { ended = true; break; }
    range(offset, 16, used, '속성 헤더');
    const length = buffer.readUInt32LE(offset + 4);
    requireValue(length >= 24 && length % 8 === 0, 'INVALID_ATTRIBUTE', '속성 길이가 잘못됐어요.');
    range(offset, length, used, '속성 레코드');
    attributes.push(parseAttribute(buffer.subarray(offset, offset + length), info));
    offset += length;
  }
  requireValue(ended, 'INVALID_RECORD', '속성 목록의 끝이 없어요.');
  const names = attributes.filter(attr => attr.type === 0x30).map(attr => {
    requireValue(attr.resident && !attr.problem && attr.value.length >= 66, 'INVALID_NAME', '파일 이름 속성이 잘못됐어요.');
    const value = attr.value;
    const nameLength = value[64];
    requireValue(nameLength > 0 && value[65] <= 3, 'INVALID_NAME', '파일 이름 길이 또는 종류가 잘못됐어요.');
    range(66, nameLength * 2, value.length, '파일 이름');
    return { name: value.subarray(66, 66 + nameLength * 2).toString('utf16le'), namespace: value[65],
      parent: reference(value.readBigUInt64LE(0)), modifiedAt: fileTime(value, 16), createdAt: fileTime(value, 8), size: u64(value, 48, '이름 기록 크기') };
  }).sort((a, b) => (a.namespace === 2) - (b.namespace === 2));
  const standard = attributes.find(attr => attr.type === 0x10 && attr.resident && !attr.problem && attr.value.length >= 32);
  const record = { recordNumber, sequence: buffer.readUInt16LE(16), flags: buffer.readUInt16LE(22), baseReference: buffer.readBigUInt64LE(32),
    attributes, names, modifiedAt: standard ? fileTime(standard.value, 8) : names[0]?.modifiedAt ?? null,
    fingerprint: createHash('sha256').update(raw).digest('hex') };
  record.recordEvidence = captureRecordEvidence(raw, buffer, record);
  return record;
}

function validateFileStream(record, stream) {
  const standard = record.attributes.find(attr => attr.type === 0x10 && attr.resident && attr.value.length >= 36);
  const fileFlags = standard ? standard.value.readUInt32LE(32) : 0;
  requireValue((fileFlags & (0x400 | 0x4000)) === 0, 'UNSUPPORTED_ATTRIBUTE', '재분석점·암호화 파일은 아직 지원하지 않아요.');
  requireValue(Boolean(fileFlags & 0x800) === Boolean(stream.compressed), 'UNSUPPORTED_ATTRIBUTE', '파일과 데이터 속성의 압축 표시가 맞지 않아요.');
  const sparseStream = !stream.resident && Boolean(stream.flags & 0x8000);
  requireValue(Boolean(fileFlags & 0x200) === sparseStream, 'UNSUPPORTED_ATTRIBUTE', '파일의 희소 표시와 데이터 속성이 맞지 않아요.');
  requireValue(!(stream.compressed && sparseStream), 'UNSUPPORTED_ATTRIBUTE', '압축과 희소 파일 표시가 함께 있는 속성은 지원하지 않아요.');
  return stream;
}

function namedStreamPolicy(record) {
  const named = record.attributes.filter(attribute => attribute.type === 0x80 && attribute.name !== '');
  const supported = !record.attributes.some(attribute => attribute.type === 0x20) && named.length === 1
    && named[0].name === ZONE_IDENTIFIER_STREAM && named[0].resident && named[0].flags === 0
    && !named[0].problem && named[0].size <= MAX_ZONE_IDENTIFIER_BYTES
    && Buffer.isBuffer(named[0].value) && named[0].value.length === named[0].size;
  return {
    mode: 'preserve-supported',
    supportedLayout: 'single-resident-zone-identifier-in-base-record',
    destinationRequirement: 'windows-ntfs-alternate-data-stream',
    maxBytes: MAX_ZONE_IDENTIFIER_BYTES,
    state: named.length === 0 ? 'none' : supported ? 'required' : 'unsupported',
    streams: named.map(attribute => ({
      name: attribute.name,
      size: attribute.size,
      resident: attribute.resident,
      preservation: supported ? 'required' : 'unsupported',
    })),
    limitations: [
      'Only one unflagged resident Zone.Identifier in the base MFT record is supported.',
      'Recovery requires a Windows NTFS destination that can create and verify the exact alternate data stream.',
      'Unknown, duplicate, nonresident, oversized, malformed, or ATTRIBUTE_LIST named streams are unsupported.',
    ],
  };
}

function supplementalStreamsOf(record) {
  const policy = namedStreamPolicy(record);
  if (policy.state === 'none') return { policy, streams: [] };
  const named = record.attributes.filter(attribute => attribute.type === 0x80 && attribute.name !== '');
  requireValue(!record.attributes.some(attribute => attribute.type === 0x20), 'UNSUPPORTED_ATTRIBUTE',
    '$ATTRIBUTE_LIST가 있는 파일의 명명된 데이터 스트림은 아직 지원하지 않아요.');
  requireValue(named.length === 1, 'UNSUPPORTED_ATTRIBUTE', '명명된 데이터 스트림은 하나만 지원해요.');
  const stream = named[0];
  requireValue(stream.name === ZONE_IDENTIFIER_STREAM, 'UNSUPPORTED_ATTRIBUTE',
    'Zone.Identifier 이외의 대체 데이터 스트림은 아직 지원하지 않아요.');
  requireValue(stream.resident, 'UNSUPPORTED_ATTRIBUTE', 'nonresident Zone.Identifier는 아직 지원하지 않아요.');
  requireValue(!stream.problem && stream.flags === 0, 'UNSUPPORTED_ATTRIBUTE', 'Zone.Identifier 속성 형식을 검증할 수 없어요.');
  requireValue(stream.size <= MAX_ZONE_IDENTIFIER_BYTES, 'UNSUPPORTED_ATTRIBUTE',
    `Zone.Identifier가 ${MAX_ZONE_IDENTIFIER_BYTES}바이트 보존 한도를 넘어요.`);
  requireValue(Buffer.isBuffer(stream.value) && stream.value.length === stream.size, 'INVALID_ATTRIBUTE',
    'Zone.Identifier의 resident 데이터 크기가 맞지 않아요.');
  return { policy, streams: [{ name: ZONE_IDENTIFIER_STREAM, stream }] };
}

async function verifySupplementalStream(basePath, supplemental, signal) {
  cancelled(signal);
  const streamPath = `${basePath}:${ZONE_IDENTIFIER_STREAM}`;
  let input;
  try {
    input = await open(streamPath, 'r');
    const info = await input.stat({ bigint: true });
    requireValue(info.isFile() && info.size === BigInt(supplemental.stream.size), 'STREAM_PRESERVATION_FAILED',
      '저장한 Zone.Identifier의 크기를 확인할 수 없어요.');
    const actual = Buffer.alloc(supplemental.stream.size);
    let offset = 0;
    while (offset < actual.length) {
      cancelled(signal);
      const { bytesRead } = await input.read(actual, offset, actual.length - offset, offset);
      requireValue(bytesRead > 0, 'STREAM_PRESERVATION_FAILED', '저장한 Zone.Identifier를 끝까지 확인하지 못했어요.');
      offset += bytesRead;
    }
    requireValue(actual.equals(supplemental.stream.value), 'STREAM_PRESERVATION_FAILED',
      '저장한 Zone.Identifier 바이트가 원본 기록과 달라요.');
  } catch (error) {
    if (error instanceof RecoveryError) throw error;
    throw new RecoveryError('STREAM_PRESERVATION_FAILED', '저장한 Zone.Identifier를 다시 읽어 정확히 확인하지 못했어요.',
      { osCode: error.code });
  } finally {
    if (input) await input.close().catch(() => {});
  }
}

async function writeSupplementalStream(basePath, supplemental, signal) {
  requireValue(process.platform === 'win32', 'STREAM_PRESERVATION_UNSUPPORTED',
    'Zone.Identifier를 보존할 수 있는 Windows NTFS 저장 위치가 필요해요.');
  requireValue(supplemental?.name === ZONE_IDENTIFIER_STREAM && supplemental.stream?.resident
    && supplemental.stream.size <= MAX_ZONE_IDENTIFIER_BYTES, 'STREAM_PRESERVATION_FAILED',
    '검증된 resident Zone.Identifier만 저장할 수 있어요.');
  const streamPath = `${basePath}:${ZONE_IDENTIFIER_STREAM}`;
  let output;
  try {
    output = await open(streamPath, 'wx');
    let written = 0;
    while (written < supplemental.stream.size) {
      cancelled(signal);
      const result = await output.write(supplemental.stream.value, written, supplemental.stream.size - written, written);
      requireValue(result.bytesWritten > 0, 'STREAM_PRESERVATION_FAILED', 'Zone.Identifier를 끝까지 저장하지 못했어요.');
      written += result.bytesWritten;
    }
    await output.sync();
    await output.close();
    output = null;
    await verifySupplementalStream(basePath, supplemental, signal);
  } catch (error) {
    if (output) await output.close().catch(() => {});
    if (error instanceof RecoveryError) throw error;
    throw new RecoveryError('STREAM_PRESERVATION_FAILED', '저장 위치에 Zone.Identifier를 정확히 보존하지 못했어요.',
      { osCode: error.code });
  }
}

function streamOf(record, type, info) {
  requireValue(record && record.baseReference === 0n && !record.attributes.some(attr => attr.type === 0x20), 'UNSUPPORTED_ATTRIBUTE', '확장 속성 목록은 아직 지원하지 않아요.');
  requireValue(!record.attributes.some(attr => attr.type === 0xc0), 'UNSUPPORTED_ATTRIBUTE', '재분석점·링크·클라우드 자리표시자 파일은 아직 지원하지 않아요.');
  const streams = record.attributes.filter(attr => attr.type === type && attr.name === '');
  requireValue(streams.length === 1, 'UNSUPPORTED_ATTRIBUTE', '단일 기본 데이터 속성을 확인할 수 없어요.');
  let stream = streams[0];
  if (stream.problem) throw new RecoveryError(stream.problem.code, stream.problem.message);
  if (!stream.resident) stream = completeStream([stream], info);
  return validateFileStream(record, stream);
}

function namedMetadataStream(record, type, name, info, { required = true } = {}) {
  const streams = record.attributes.filter(attribute => attribute.type === type && attribute.name === name);
  if (!streams.length && !required) return null;
  requireValue(streams.length === 1, 'USN_INDEX_UNSUPPORTED', `단일 ${name || '기본'} 메타데이터 스트림을 확인할 수 없어요.`);
  let stream = streams[0];
  if (stream.problem) throw new RecoveryError(stream.problem.code, stream.problem.message);
  if (!stream.resident) stream = completeStream([stream], info);
  requireValue(!stream.compressed, 'USN_INDEX_UNSUPPORTED', '압축된 디렉터리 인덱스 메타데이터는 지원하지 않아요.');
  return stream;
}

function fileReference(record) {
  return BigInt(record.recordNumber) | (BigInt(record.sequence) << 48n);
}

function sameExtensionProof(actual, expected) {
  return Array.isArray(actual) && Array.isArray(expected) && actual.length === expected.length
    && actual.every((entry, index) => entry.recordNumber === expected[index].recordNumber
      && entry.fingerprint === expected[index].fingerprint);
}

export function safeOutputName(name, recordNumber) {
  let leaf = String(name).normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_').replace(/[. ]+$/g, '').trim();
  if (!leaf || leaf === '.' || leaf === '..') leaf = `record-${recordNumber}`;
  if (/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(leaf)) leaf = `_${leaf}`;
  return shortenOutputName(leaf);
}

class NtfsImage {
  constructor(handle, imagePath, identity, provider = null) {
    this.handle = handle;
    this.imagePath = imagePath;
    this.identity = identity;
    this.provider = provider;
    this.info = null;
    this.busy = false;
    this.closed = false;
    this.scanned = new Map();
    this.scanCheckpoint = null;
    this.journalRecords = [];
  }

  checkpointGeometry() {
    return { recordCount: this.info.recordCount, recordSize: this.info.recordSize, volumeSize: this.info.volumeSize };
  }

  exportCheckpoint() {
    requireValue(this.scanCheckpoint, 'CHECKPOINT_UNAVAILABLE', '내보낼 검색 체크포인트가 없어요.');
    requireValue(this.scanCheckpoint.entries.length <= MAX_CHECKPOINT_ENTRIES, 'CHECKPOINT_LIMIT', '후보가 10000개를 넘어 체크포인트로 내보낼 수 없어요.');
    requireValue(this.scanCheckpoint.entries.reduce((sum, entry) => sum + (entry.extensions?.length ?? 0), 0) <= MAX_CHECKPOINT_EXTENSIONS,
      'CHECKPOINT_LIMIT', '확장 기록 증명이 10000개를 넘어 체크포인트로 내보낼 수 없어요.');
    return {
      version: 1,
      nextRecord: this.scanCheckpoint.nextRecord,
      ...this.checkpointGeometry(),
      malformedRecords: this.scanCheckpoint.malformedRecords,
      warnings: this.scanCheckpoint.warnings.map(item => ({ ...item })),
      entries: this.scanCheckpoint.entries.map(item => ({ ...item,
        ...(item.extensions ? { extensions: item.extensions.map(extension => ({ ...extension })) } : {}) })),
    };
  }

  validateCheckpoint(value) {
    if (!plainObject(value) || value.version !== 1) checkpointError('지원하지 않는 검색 체크포인트예요.');
    const geometry = this.checkpointGeometry();
    for (const key of ['recordCount', 'recordSize', 'volumeSize']) {
      if (!Number.isSafeInteger(value[key]) || value[key] !== geometry[key]) checkpointError('체크포인트의 NTFS 볼륨 구조가 현재 이미지와 맞지 않아요.');
    }
    if (!Number.isSafeInteger(value.nextRecord) || value.nextRecord < 0 || value.nextRecord > geometry.recordCount) checkpointError('체크포인트의 다음 기록 위치가 잘못됐어요.');
    if (!Number.isSafeInteger(value.malformedRecords) || value.malformedRecords < 0 || value.malformedRecords > value.nextRecord) checkpointError('체크포인트의 손상 기록 수가 잘못됐어요.');
    if (!Array.isArray(value.entries) || value.entries.length > MAX_CHECKPOINT_ENTRIES) checkpointError('체크포인트의 후보 기록 수가 잘못됐어요.');
    if (!Array.isArray(value.warnings) || value.warnings.length > MAX_WARNINGS || value.warnings.length > value.malformedRecords) checkpointError('체크포인트의 경고 목록이 잘못됐어요.');
    let previousRecord = -1;
    let extensionCount = 0;
    const entries = value.entries.map(entry => {
      if (!plainObject(entry) || !Number.isSafeInteger(entry.recordNumber) || entry.recordNumber < 16
        || entry.recordNumber >= value.nextRecord || entry.recordNumber <= previousRecord
        || typeof entry.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(entry.fingerprint)) checkpointError('체크포인트의 후보 기록이 잘못됐어요.');
      const extensions = entry.extensions === undefined ? [] : entry.extensions;
      if (!Array.isArray(extensions) || extensions.length > MAX_EXTENSION_RECORDS) checkpointError('체크포인트의 확장 기록 목록이 잘못됐어요.');
      const extensionRecords = new Set();
      const checkedExtensions = extensions.map(extension => {
        if (!plainObject(extension) || !Number.isSafeInteger(extension.recordNumber) || extension.recordNumber < 16
          || extension.recordNumber >= geometry.recordCount || extension.recordNumber === entry.recordNumber
          || extensionRecords.has(extension.recordNumber) || typeof extension.fingerprint !== 'string'
          || !/^[0-9a-f]{64}$/.test(extension.fingerprint)) checkpointError('체크포인트의 확장 기록 증명이 잘못됐어요.');
        extensionRecords.add(extension.recordNumber);
        extensionCount++;
        if (extensionCount > MAX_CHECKPOINT_EXTENSIONS) checkpointError('체크포인트의 확장 기록 증명이 너무 많아요.');
        return { recordNumber: extension.recordNumber, fingerprint: extension.fingerprint };
      });
      previousRecord = entry.recordNumber;
      return { recordNumber: entry.recordNumber, fingerprint: entry.fingerprint, extensions: checkedExtensions };
    });
    const warnings = value.warnings.map(warning => {
      if (!plainObject(warning) || !Number.isSafeInteger(warning.recordNumber) || warning.recordNumber < 0
        || warning.recordNumber >= value.nextRecord || typeof warning.code !== 'string' || warning.code.length < 1 || warning.code.length > 80
        || typeof warning.message !== 'string' || warning.message.length < 1 || warning.message.length > 1000) checkpointError('체크포인트의 경고 항목이 잘못됐어요.');
      return { recordNumber: warning.recordNumber, code: warning.code, message: warning.message };
    });
    return { version: 1, nextRecord: value.nextRecord, ...geometry, malformedRecords: value.malformedRecords, warnings, entries };
  }

  async restoreCheckpoint(value, signal, onCandidate, maxCandidates) {
    const sourceKind = this.provider?.info?.sourceKind;
    requireValue(!this.provider || sourceKind === 'image' || sourceKind === 'volume-image', 'CHECKPOINT_UNSUPPORTED', '원시 볼륨 검색은 다시 시작해야 해요. 이미지 검색만 이어갈 수 있어요.');
    const checkpoint = this.validateCheckpoint(value);
    requireValue(checkpoint.entries.length <= maxCandidates, 'INVALID_LIMIT', '후보 제한이 체크포인트의 기존 후보 수보다 작아요.');
    await this.assertUnchanged();
    const candidates = [];
    const restored = new Map();
    for (const entry of checkpoint.entries) {
      cancelled(signal);
      const record = await this.record(entry.recordNumber, signal);
      requireValue(record && record.flags === 0 && record.baseReference === 0n && record.fingerprint === entry.fingerprint,
        'SOURCE_CHANGED', '체크포인트의 삭제 파일 기록이 현재 이미지와 달라요.');
      requireValue(!(await this.bitmapBit(this.mftBitmap, entry.recordNumber, signal)), 'SOURCE_CHANGED', '체크포인트의 파일 기록 할당 상태가 바뀌었어요.');
      const proof = {};
      const candidate = await this.candidate(record, signal, undefined, proof);
      requireValue(sameExtensionProof(proof.extensions, entry.extensions), 'SOURCE_CHANGED', '체크포인트의 확장 파일 기록이 현재 이미지와 달라요.');
      restored.set(entry.recordNumber, { recordEvidence: summarizeRecord(record), fingerprint: record.fingerprint, extensions: proof.extensions, candidate,
        deletionIdentity: { sequence: record.sequence, names: record.names } });
      candidates.push(candidate);
    }
    await this.assertUnchanged();
    this.scanned = restored;
    this.scanCheckpoint = checkpoint;
    for (const candidate of candidates) onCandidate?.(candidate);
    return candidates;
  }

  async assertUnchanged() {
    requireValue(!this.closed, 'CLOSED', '이미 닫힌 이미지예요.');
    if (this.provider) { await this.provider.assertUnchanged(); return; }
    const current = await this.handle.stat({ bigint: true });
    const named = await stat(this.imagePath, { bigint: true });
    for (const check of [current, named]) {
      requireValue(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => check[key] === this.identity[key]),
        'SOURCE_CHANGED', '이미지가 바뀌었어요. 다시 열고 검색해주세요.');
    }
  }

  async read(offset, length, signal) {
    cancelled(signal);
    range(offset, length, this.info?.volumeSize ?? Number(this.identity.size), '이미지 읽기');
    requireValue(length <= MAX_READ, 'READ_LIMIT', '한 번에 읽을 수 있는 크기를 넘었어요.');
    if (this.provider) {
      const bytes = await this.provider.read(offset, length, { signal });
      requireValue(Buffer.isBuffer(bytes) && bytes.length === length, 'READ_FAILED', '장치의 필요한 바이트를 읽지 못했어요.');
      return bytes;
    }
    const buffer = Buffer.alloc(length);
    let done = 0;
    while (done < length) {
      cancelled(signal);
      const { bytesRead } = await this.handle.read(buffer, done, length - done, offset + done);
      requireValue(bytesRead > 0, 'READ_FAILED', '이미지의 필요한 바이트를 읽지 못했어요.');
      done += bytesRead;
    }
    return buffer;
  }

  async readCompressionUnit(stream, unit, signal) {
    const unitSize = NTFS_COMPRESSION_UNIT_SIZE;
    const unitStart = unit.vcn * this.info.clusterSize;
    const initializedLength = Math.max(0, Math.min(unitSize, stream.initializedSize - unitStart));
    const output = Buffer.alloc(unitSize);
    if (initializedLength === 0 || unit.kind === 'zero') return output;
    const physical = [];
    for (const part of unit.parts) {
      if (part.sparse) continue;
      physical.push(await this.read(part.lcn * this.info.clusterSize, part.count * this.info.clusterSize, signal));
    }
    const packed = Buffer.concat(physical, unit.physicalClusters * this.info.clusterSize);
    if (unit.kind === 'raw') {
      requireValue(packed.length === unitSize, 'INVALID_COMPRESSED_DATA', '압축되지 않은 NTFS 단위의 크기가 맞지 않아요.');
      packed.copy(output, 0, 0, initializedLength);
      return output;
    }
    try {
      const decoded = decompressLznt1(packed, { maxOutput: unitSize });
      requireValue(decoded.length >= initializedLength, 'INVALID_COMPRESSED_DATA', 'LZNT1 해제 데이터가 초기화된 파일 본문보다 짧아요.');
      // The encoded unit can cover bytes beyond ValidDataLength or logical
      // EOF. Only initialized bytes are observable; never expose its tail.
      decoded.copy(output, 0, 0, initializedLength);
      return output;
    } catch (error) {
      if (error instanceof RecoveryError) throw error;
      if (error instanceof Lznt1Error) throw new RecoveryError('INVALID_COMPRESSED_DATA', `LZNT1 데이터를 검증할 수 없어요: ${error.message}`);
      throw error;
    }
  }

  async readCompressedStream(stream, offset, length, signal) {
    const buffer = Buffer.alloc(length);
    if (length === 0 || offset >= stream.initializedSize) return buffer;
    const initializedEnd = Math.min(offset + length, stream.initializedSize);
    const firstUnit = Math.floor(offset / NTFS_COMPRESSION_UNIT_SIZE);
    const lastUnit = Math.floor((initializedEnd - 1) / NTFS_COMPRESSION_UNIT_SIZE);
    for (let index = firstUnit; index <= lastUnit; index += 1) {
      cancelled(signal);
      const unit = stream.compressionUnits[index];
      requireValue(unit && unit.vcn === index * NTFS_COMPRESSION_CLUSTERS, 'INVALID_COMPRESSED_DATA', '압축 단위 색인이 맞지 않아요.');
      const decoded = await this.readCompressionUnit(stream, unit, signal);
      const unitStart = index * NTFS_COMPRESSION_UNIT_SIZE;
      const start = Math.max(offset, unitStart);
      const end = Math.min(initializedEnd, unitStart + NTFS_COMPRESSION_UNIT_SIZE);
      decoded.copy(buffer, start - offset, start - unitStart, end - unitStart);
    }
    return buffer;
  }

  async readStream(stream, offset, length, signal) {
    range(offset, length, stream.size, '파일 데이터 읽기');
    requireValue(length <= MAX_READ, 'READ_LIMIT', '읽기 버퍼 제한을 넘었어요.');
    cancelled(signal);
    if (stream.resident) return Buffer.from(stream.value.subarray(offset, offset + length));
    if (stream.compressed) return this.readCompressedStream(stream, offset, length, signal);
    const buffer = Buffer.alloc(length);
    const initializedEnd = Math.min(offset + length, stream.initializedSize);
    let covered = 0;
    for (const run of stream.runs) {
      const begin = run.vcn * this.info.clusterSize;
      const end = begin + run.count * this.info.clusterSize;
      const intersectionStart = Math.max(offset, begin);
      const intersectionEnd = Math.min(initializedEnd, end);
      if (intersectionStart >= intersectionEnd) continue;
      const count = intersectionEnd - intersectionStart;
      if (!run.sparse) {
        const physicalOffset = run.lcn * this.info.clusterSize + intersectionStart - begin;
        let part;
        try {
          part = await this.read(physicalOffset, count, signal);
        } catch (error) {
          // Preserve cancellation/source-change codes and never fill failed reads with zeros.
          if (error?.code === 'CANCELLED' || error?.code === 'SOURCE_CHANGED') throw error;
          throw new RecoveryError(error instanceof RecoveryError ? error.code : 'READ_FAILED', error?.message ?? '파일 구간을 읽지 못했어요.', {
            ...error?.details, readFailure: {
              logicalOffset: intersectionStart, requestedBytes: count, physicalOffset,
              runVcn: run.vcn, runLcn: run.lcn, extentKind: 'physical',
              cause: error?.code ?? 'READ_FAILED', exactFailedBytesKnown: false,
            },
          });
        }
        part.copy(buffer, intersectionStart - offset);
      }
      covered += count;
    }
    requireValue(covered === Math.max(0, initializedEnd - offset), 'INVALID_RUNS', '초기화된 파일 데이터에 읽을 수 없는 구간이 있어요.');
    return buffer;
  }

  async record(number, signal) {
    requireValue(Number.isSafeInteger(number) && number >= 0 && number < this.info.recordCount, 'INVALID_RECORD_NUMBER', '파일 기록 번호가 범위를 벗어났어요.');
    return parseRecord(await this.readStream(this.mft, number * this.info.recordSize, this.info.recordSize, signal), this.info, number);
  }

  directoryIndexStreams(record) {
    requireValue(record?.flags === 3 && record.baseReference === 0n
      && !record.attributes.some(a => a.type === 0x20 || a.type === 0xc0),
    'DIR_SLACK_UNSUPPORTED', '현재 사용 중인 단순 디렉터리 인덱스만 확인해요.');
    const root = namedMetadataStream(record, 0x90, '$I30', this.info, { required: false });
    if (!root) return null;
    requireValue(root.resident && root.flags === 0, 'DIR_SLACK_UNSUPPORTED', '디렉터리 인덱스 루트 형식을 지원하지 않아요.');
    const allocation = namedMetadataStream(record, 0xa0, '$I30', this.info, { required: false });
    const bitmap = namedMetadataStream(record, 0xb0, '$I30', this.info, { required: false });
    requireValue(Boolean(allocation) === Boolean(bitmap), 'DIR_SLACK_UNSUPPORTED', '인덱스 할당·비트맵 쌍을 확인할 수 없어요.');
    for (const stream of [allocation, bitmap].filter(Boolean)) requireValue(stream.flags === 0
      && !stream.compressed && (stream.resident || stream.initializedSize === stream.size && stream.runs.every(r => !r.sparse)),
    'DIR_SLACK_UNSUPPORTED', '압축·희소·미초기화 인덱스는 아직 확인하지 않아요.');
    requireValue(!allocation?.resident, 'DIR_SLACK_UNSUPPORTED', '외부 인덱스 저장 형식이 잘못됐어요.');
    return { root, allocation, bitmap };
  }

  async bitmapBit(stream, index, signal) {
    const byte = await this.readStream(stream, Math.floor(index / 8), 1, signal);
    return Boolean(byte[0] & (1 << (index % 8)));
  }

  async initialize() {
    this.info = parseBoot(await this.read(0, 512), Number(this.identity.size));
    if (this.provider) this.info.sourceKind = this.provider.info.sourceKind ?? 'volume';
    const first = parseRecord(await this.read(this.info.mftCluster * this.info.clusterSize, this.info.recordSize), this.info, 0);
    requireValue(isLiveDataRecord(first), 'INVALID_MFT', '사용 중인 MFT 기본 기록이 필요해요.');
    this.mft = streamOf(first, 0x80, this.info);
    requireValue(!this.mft.resident && this.mft.size % this.info.recordSize === 0 && this.mft.size >= 16 * this.info.recordSize,
      'INVALID_MFT', 'MFT 크기 또는 데이터 속성이 잘못됐어요.');
    requireValue(this.mft.runs[0].lcn === this.info.mftCluster && this.mft.runs[0].count * this.info.clusterSize >= this.info.recordSize,
      'INVALID_MFT', '부트 정보와 MFT 저장 위치가 맞지 않아요.');
    this.info.recordCount = this.mft.size / this.info.recordSize;
    this.mftBitmap = streamOf(first, 0xb0, this.info);
    requireValue(this.mftBitmap.size >= Math.ceil(this.info.recordCount / 8), 'INVALID_BITMAP', 'MFT 할당 비트맵이 짧아요.');
    const volume = await this.record(3);
    const versions = volume?.attributes.filter(attr => attr.type === 0x70 && attr.name === '');
    requireValue(isLiveDataRecord(volume) && versions?.length === 1 && versions[0].resident && !versions[0].problem && versions[0].value.length >= 12,
      'UNSUPPORTED_VERSION', 'NTFS 버전 기록을 확인할 수 없어요.');
    const major = versions[0].value[8];
    const minor = versions[0].value[9];
    requireValue(major === 3 && (minor === 0 || minor === 1), 'UNSUPPORTED_VERSION', '현재 NTFS 3.0과 3.1 구조만 지원해요.');
    this.info.version = `${major}.${minor}`;
    const bitmapRecord = await this.record(6);
    requireValue(isLiveDataRecord(bitmapRecord), 'INVALID_BITMAP', '사용 중인 볼륨 비트맵 기록이 필요해요.');
    this.volumeBitmap = streamOf(bitmapRecord, 0x80, this.info);
    requireValue(this.volumeBitmap.size >= Math.ceil(this.info.clusterCount / 8), 'INVALID_BITMAP', '볼륨 할당 비트맵이 짧아요.');
    for (const number of [0, 3, 6]) requireValue(await this.bitmapBit(this.mftBitmap, number), 'INVALID_BITMAP', '시스템 기록과 할당 비트맵이 맞지 않아요.');
    await this.assertUnchanged();
  }

  async refreshAllocationMetadata(signal) {
    const first = await this.record(0, signal);
    requireValue(isLiveDataRecord(first), 'SOURCE_CHANGED', 'MFT 기본 기록이 바뀌었어요.');
    const mftBitmap = streamOf(first, 0xb0, this.info);
    requireValue(mftBitmap.size >= Math.ceil(this.info.recordCount / 8), 'SOURCE_CHANGED', 'MFT 할당 비트맵이 바뀌었어요.');
    const bitmapRecord = await this.record(6, signal);
    requireValue(isLiveDataRecord(bitmapRecord), 'SOURCE_CHANGED', '볼륨 비트맵 기록이 바뀌었어요.');
    const volumeBitmap = streamOf(bitmapRecord, 0x80, this.info);
    requireValue(volumeBitmap.size >= Math.ceil(this.info.clusterCount / 8), 'SOURCE_CHANGED', '볼륨 할당 비트맵이 바뀌었어요.');
    return { mftBitmap, volumeBitmap };
  }

  async dataStreamOf(record, signal) {
    const lists = record.attributes.filter(attribute => attribute.type === 0x20);
    if (lists.length === 0) return { stream: streamOf(record, 0x80, this.info), extensions: [] };
    requireValue(record.baseReference === 0n && lists.length === 1, 'UNSUPPORTED_ATTRIBUTE', '단일 기본 기록의 $ATTRIBUTE_LIST만 지원해요.');
    requireValue(!record.attributes.some(attribute => attribute.type === 0xc0), 'UNSUPPORTED_ATTRIBUTE', '재분석점·링크·클라우드 자리표시자 파일은 아직 지원하지 않아요.');
    requireValue(record.attributes.every(attribute => [0x10, 0x20, 0x30, 0x80].includes(attribute.type)),
      'UNSUPPORTED_ATTRIBUTE', '$ATTRIBUTE_LIST 파일의 추가 시스템 속성은 아직 지원하지 않아요.');
    requireValue(!record.attributes.some(attribute => attribute.type === 0x80 && attribute.name !== ''),
      'UNSUPPORTED_ATTRIBUTE', '대체 데이터 스트림이 있는 파일은 아직 지원하지 않아요.');

    const entries = parseAttributeList(lists[0], this.info);
    requireValue(!entries.some(entry => entry.type === 0x20), 'UNSUPPORTED_ATTRIBUTE', '$ATTRIBUTE_LIST 자체를 나열한 구조는 아직 지원하지 않아요.');
    const baseReference = fileReference(record);
    const baseAttributes = record.attributes.filter(attribute => attribute.type !== 0x20);
    const matchedEntries = new Set();
    for (const attribute of baseAttributes) {
      requireValue(!attribute.problem, attribute.problem?.code ?? 'INVALID_ATTRIBUTE', attribute.problem?.message ?? '기본 기록 속성을 검증할 수 없어요.');
      const lowestVcn = attribute.resident ? 0 : attribute.firstVcn;
      const matches = entries.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.type === attribute.type
        && entry.name === attribute.name && entry.lowestVcn === lowestVcn && entry.attributeId === attribute.id
        && entry.segment.recordNumber === record.recordNumber && entry.segment.sequence === record.sequence);
      requireValue(matches.length === 1 && !matchedEntries.has(matches[0].index), 'INVALID_ATTRIBUTE_LIST', '$ATTRIBUTE_LIST와 기본 기록 속성이 정확히 대응하지 않아요.');
      matchedEntries.add(matches[0].index);
    }

    const baseData = baseAttributes.filter(attribute => attribute.type === 0x80 && attribute.name === '');
    requireValue(baseData.length === 1 && !baseData[0].resident, 'UNSUPPORTED_ATTRIBUTE', '분할된 단일 nonresident 기본 데이터 속성만 지원해요.');
    // Sparse extents use the same ownership, VCN and fingerprint proof as
    // ordinary extents. completeStream validates all flags and size totals;
    // readStream zero-fills only declared holes and the uninitialized tail.
    requireValue([0, 0x8000].includes(baseData[0].flags) && !baseData[0].compressed,
      'UNSUPPORTED_ATTRIBUTE', '분할 속성 목록에서는 일반·희소 데이터만 지원해요. 압축 데이터 조각은 아직 지원하지 않아요.');
    const dataEntries = entries.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.type === 0x80 && entry.name === '');
    requireValue(dataEntries.length >= 2, 'UNSUPPORTED_ATTRIBUTE', '$ATTRIBUTE_LIST에 분할된 기본 데이터 조각이 없어요.');
    requireValue(entries.every((entry, index) => matchedEntries.has(index) || (entry.type === 0x80 && entry.name === '')),
      'UNSUPPORTED_ATTRIBUTE', '확장 기록의 데이터 이외 속성은 아직 지원하지 않아요.');

    const segments = [baseData[0]];
    const extensions = [];
    const extensionNumbers = new Set();
    for (const { entry, index } of dataEntries) {
      if (entry.segment.recordNumber === record.recordNumber) {
        requireValue(entry.segment.sequence === record.sequence && entry.attributeId === baseData[0].id
          && entry.lowestVcn === baseData[0].firstVcn && matchedEntries.has(index), 'INVALID_ATTRIBUTE_LIST', '기본 데이터 조각 참조가 중복되거나 맞지 않아요.');
        continue;
      }
      requireValue(entry.segment.recordNumber >= 16 && entry.segment.recordNumber !== record.recordNumber
        && !extensionNumbers.has(entry.segment.recordNumber), 'INVALID_ATTRIBUTE_LIST', '확장 기록 참조가 중복되거나 순환해요.');
      requireValue(extensionNumbers.size < MAX_EXTENSION_RECORDS, 'UNSUPPORTED_ATTRIBUTE', '확장 파일 기록이 너무 많아요.');
      extensionNumbers.add(entry.segment.recordNumber);
      const extension = await this.record(entry.segment.recordNumber, signal);
      requireValue(extension && extension.flags === 0 && extension.sequence === entry.segment.sequence
        && extension.baseReference === baseReference, 'INVALID_ATTRIBUTE_LIST', '확장 기록의 세대 또는 기본 기록 소유권이 맞지 않아요.');
      requireValue(!extension.attributes.some(attribute => attribute.type === 0x20 || attribute.type === 0xc0),
        'UNSUPPORTED_ATTRIBUTE', '중첩 속성 목록 또는 재분석점이 있는 확장 기록은 지원하지 않아요.');
      requireValue(extension.attributes.length === 1 && extension.attributes[0].type === 0x80
        && extension.attributes[0].name === '' && !extension.attributes[0].resident,
      'UNSUPPORTED_ATTRIBUTE', '확장 기록에는 하나의 nonresident 기본 데이터 조각만 있어야 해요.');
      const segment = extension.attributes[0];
      requireValue(!segment.problem && segment.id === entry.attributeId && segment.firstVcn === entry.lowestVcn,
        'INVALID_ATTRIBUTE_LIST', '확장 데이터 조각의 ID 또는 VCN이 목록과 맞지 않아요.');
      segments.push(segment);
      extensions.push({ recordNumber: extension.recordNumber, fingerprint: extension.fingerprint });
      matchedEntries.add(index);
    }
    requireValue(matchedEntries.size === entries.length && segments.length === dataEntries.length,
      'INVALID_ATTRIBUTE_LIST', '$ATTRIBUTE_LIST 항목 일부를 검증하지 못했어요.');
    const stream = validateFileStream(record, completeStream(segments, this.info));
    return { stream, extensions };
  }

  async candidate(record, signal, allocation = { mftBitmap: this.mftBitmap, volumeBitmap: this.volumeBitmap }, proofTarget = null) {
    if (proofTarget) { proofTarget.extensions = []; proofTarget.stream = null; proofTarget.supplementalStreams = []; }
    const fileName = record.names[0];
    const candidate = { id: `ntfs:${record.recordNumber}:${record.sequence}`, recordNumber: record.recordNumber, sequence: record.sequence,
      ...(record.attributes.some(a => a.type === 0x20) ? { splitData: true } : {}),
      name: fileName?.name ?? `record-${record.recordNumber}`, nameIsGenerated: !fileName, size: fileName?.size ?? 0,
      nameReferences: record.names.map(({ name, namespace, parent }) => ({ name, namespace, parent })),
      path: null, pathStatus: 'unknown', deletedAt: null, modifiedAt: record.modifiedAt,
      source: 'deleted-record', storage: 'unsupported', status: 'readable', reasons: [], originalIdentityVerified: false,
      namedStreamPolicy: namedStreamPolicy(record) };
    const naming = chooseRecoveryName(candidate);
    if (naming.originalNameStatus === 'ambiguous') {
      candidate.discoveredName = candidate.name;
      candidate.name = naming.name;
      candidate.pathStatus = 'ambiguous';
      candidate.reasons.push('이름과 경로 후보가 여러 개여서 임시 이름을 사용해요.');
    }
    if (fileName && naming.originalNameStatus !== 'ambiguous') {
      let parent = fileName.parent;
      const names = [fileName.name];
      const visited = new Set([record.recordNumber]);
      for (let depth = 0; depth < MAX_PARENT_DEPTH; depth++) {
        cancelled(signal);
        if (visited.has(parent.recordNumber)) break;
        visited.add(parent.recordNumber);
        let directory;
        try { directory = await this.record(parent.recordNumber, signal); }
        catch (error) { if (error.code === 'CANCELLED') throw error; break; }
        if (!directory || !(directory.flags & 2) || directory.sequence !== parent.sequence) break;
        if (parent.recordNumber === 5) {
          if (!(directory.flags & 1) || !(await this.bitmapBit(allocation.mftBitmap, 5, signal))) break;
          candidate.path = `\\${names.reverse().join('\\')}`;
          candidate.pathStatus = 'known';
          break;
        }
        if (!directory.names[0]) break;
        names.push(directory.names[0].name);
        parent = directory.names[0].parent;
      }
    }
    if (candidate.pathStatus === 'unknown') candidate.reasons.push('원래 폴더 경로를 확인할 수 없어요.');
    try {
      const resolved = await this.dataStreamOf(record, signal);
      const stream = resolved.stream;
      if (proofTarget) { proofTarget.extensions = resolved.extensions; proofTarget.stream = stream; }
      candidate.size = stream.size;
      candidate.storage = stream.resident ? 'resident' : stream.compressed ? 'compressed' : stream.runs.some(run => run.sparse) ? 'sparse' : 'nonresident';
      // Preserve the one bounded trust-marking stream we can prove and export;
      // all other named layouts remain explicit unsupported candidates.
      const supplemental = supplementalStreamsOf(record);
      candidate.namedStreamPolicy = supplemental.policy;
      if (proofTarget) proofTarget.supplementalStreams = supplemental.streams;
      if (await this.bitmapBit(allocation.mftBitmap, record.recordNumber, signal)) {
        candidate.status = 'conflict';
        candidate.reasons.push('삭제 표시와 현재 파일 기록 할당 상태가 충돌해요.');
      }
      for (const extension of resolved.extensions) {
        if (await this.bitmapBit(allocation.mftBitmap, extension.recordNumber, signal)) {
          candidate.status = 'conflict';
          candidate.reasons.push('확장 파일 기록이 현재 다른 용도로 할당돼 있어요.');
          break;
        }
      }
      if (!stream.resident) {
        for (const run of stream.runs) {
          if (run.sparse) continue;
          // Explicitly protect MFT and metadata even if a damaged bitmap calls them free.
          const metadataStreams = [this.mft, allocation.mftBitmap, allocation.volumeBitmap];
          if (metadataStreams.some(meta => !meta.resident && meta.runs.some(part => run.lcn < part.lcn + part.count && part.lcn < run.lcn + run.count))) {
            candidate.status = 'conflict';
            candidate.reasons.push('파일 데이터가 파일시스템 관리 영역과 겹쳐요.');
            break;
          }
          const firstByte = Math.floor(run.lcn / 8);
          const lastByte = Math.floor((run.lcn + run.count - 1) / 8);
          let occupied = false;
          for (let offset = firstByte; offset <= lastByte && !occupied; offset += MAX_READ) {
            cancelled(signal);
            const bytes = await this.readStream(allocation.volumeBitmap, offset, Math.min(MAX_READ, lastByte - offset + 1), signal);
            for (let i = 0; i < bytes.length && !occupied; i++) {
              if (!bytes[i]) continue;
              for (let bit = 0; bit < 8; bit++) {
                const cluster = (offset + i) * 8 + bit;
                if (cluster >= run.lcn && cluster < run.lcn + run.count && (bytes[i] & (1 << bit))) { occupied = true; break; }
              }
            }
          }
          if (occupied) {
            candidate.status = 'conflict';
            candidate.reasons.push('데이터 구간 일부가 현재 다른 용도로 할당돼 있어요.');
            break;
          }
        }
      }
      if (stream.compressed) candidate.reasons.push('16클러스터 NTFS 압축 단위를 검증하고 LZNT1로 해제해요.');
      else if (!stream.resident && stream.runs.some(run => run.sparse)) candidate.reasons.push('희소 구간은 NTFS 메타데이터에 따라 0으로 채워요.');
      if (!stream.resident && stream.initializedSize < stream.size) candidate.reasons.push('초기화되지 않은 파일 꼬리는 NTFS 메타데이터에 따라 0으로 채워요.');
      if (stream.split) candidate.reasons.push('$ATTRIBUTE_LIST의 확장 기록과 분할 데이터 조각을 검증했어요.');
      if (supplemental.streams.length) candidate.reasons.push('resident Zone.Identifier를 복구본에 동일한 바이트로 보존해야 해요.');
    } catch (error) {
      if (!(error instanceof RecoveryError) || error.code === 'CANCELLED') throw error;
      candidate.status = error.code === 'UNSUPPORTED_ATTRIBUTE' ? 'unsupported' : 'conflict';
      candidate.reasons.push(error.message);
    }
    if (candidate.status === 'readable') candidate.reasons.push('읽을 수 있는 저장 구조를 확인했어요. 삭제 전 내용과 동일한지는 확인되지 않았어요.');
    return candidate;
  }

  streamRanges(stream) {
    if (stream.resident) return stream.size ? [{ offset: 0, length: stream.size }] : [];
    return stream.runs.filter(run => !run.sparse).map(run => ({ offset: run.vcn * this.info.clusterSize,
      length: Math.max(0, Math.min(run.count * this.info.clusterSize, stream.initializedSize - run.vcn * this.info.clusterSize)) }))
      .filter(item => item.length > 0);
  }

  bitmapReader(allocation, signal) {
    const caches = new Map();
    return async (kind, index) => {
      const bitmap = allocation[kind];
      requireValue(bitmap && Number.isSafeInteger(index) && index >= 0,
        'USN_CHANGED', '변경 기록 할당 상태를 확인할 수 없어요.');
      const byteIndex = Math.floor(index / 8);
      requireValue(byteIndex < bitmap.size, 'USN_CHANGED', '변경 기록 할당 비트맵 범위를 벗어났어요.');
      const pageOffset = Math.floor(byteIndex / 4096) * 4096;
      const key = `${kind}:${pageOffset}`;
      if (!caches.has(key)) {
        requireValue(caches.size < 128, 'USN_VALIDATION_LIMIT', '변경 기록 할당 상태의 확인 범위 제한에 도달했어요.');
        caches.set(key, await this.readStream(bitmap, pageOffset, Math.min(4096, bitmap.size - pageOffset), signal));
      }
      return Boolean(caches.get(key)[byteIndex - pageOffset] & 1 << index % 8);
    };
  }

  async assertStreamRangeAllocated(stream, offset, length, readBit, signal) {
    if (stream.resident) return;
    for (const run of stream.runs) {
      if (run.sparse) continue;
      const logicalStart = run.vcn * this.info.clusterSize;
      const start = Math.max(offset, logicalStart);
      const end = Math.min(offset + length, logicalStart + run.count * this.info.clusterSize);
      if (start >= end) continue;
      const firstCluster = run.lcn + Math.floor((start - logicalStart) / this.info.clusterSize);
      const lastCluster = run.lcn + Math.ceil((end - logicalStart) / this.info.clusterSize);
      for (let cluster = firstCluster; cluster < lastCluster; cluster++) {
        cancelled(signal);
        requireValue(await readBit('volumeBitmap', cluster), 'USN_CHANGED', '변경 기록 메타데이터의 데이터 구간이 현재 할당되어 있지 않아요.');
      }
    }
  }

  async discoverJournalRecord(signal, control, onProgress) {
    let discoveryRecordsRead = 0;
    const publish = (strategy) => onProgress?.({ stage: 'journal-discovery', discoveryRecordsRead, strategy });
    const root = await this.record(5, signal);
    discoveryRecordsRead++;
    const extend = await this.record(11, signal);
    discoveryRecordsRead++;
    requireValue(root && root.flags === 3 && root.baseReference === 0n && root.sequence > 0
      && extend && extend.flags === 3 && extend.baseReference === 0n && extend.sequence > 0
      && extend.names.some(name => name.name === '$Extend' && name.parent.recordNumber === 5
        && name.parent.sequence === root.sequence)
      && await this.bitmapBit(this.mftBitmap, 5, signal) && await this.bitmapBit(this.mftBitmap, 11, signal),
    'USN_UNAVAILABLE', '$Extend 디렉터리 기록을 확인할 수 없어 삭제 기록 위치를 찾지 못했어요.');
    publish('directory-index');
    const validateJournal = async (reference, discovery) => {
      requireValue(reference.recordNumber >= 16 && reference.recordNumber < this.info.recordCount && reference.sequence > 0,
        'USN_UNAVAILABLE', '변경 기록 파일 참조가 MFT 범위를 벗어났어요.');
      const record = await this.record(reference.recordNumber, signal);
      discoveryRecordsRead++;
      requireValue(isLiveDataRecord(record) && record.sequence === reference.sequence && record.baseReference === 0n
        && record.names.some(name => name.name === '$UsnJrnl' && name.parent.recordNumber === 11
          && name.parent.sequence === extend.sequence)
        && await this.bitmapBit(this.mftBitmap, record.recordNumber, signal),
      'USN_UNAVAILABLE', '변경 기록 파일의 현재 세대와 $Extend 소유권을 확인할 수 없어요.');
      this.journalRecords = [{ recordNumber: record.recordNumber, sequence: record.sequence }];
      publish(discovery.strategy);
      return { record, discovery: { ...discovery, discoveryRecordsRead,
        proofs: [{ recordNumber: root.recordNumber, fingerprint: root.fingerprint },
          { recordNumber: extend.recordNumber, fingerprint: extend.fingerprint }] } };
    };

    try {
      const roots = extend.attributes.filter(attribute => attribute.type === 0x90 && attribute.name === '$I30');
      requireValue(roots.length === 1 && roots[0].resident && !roots[0].problem,
        'USN_INDEX_UNSUPPORTED', '$Extend의 resident $I30 INDEX_ROOT를 확인할 수 없어요.');
      const allocationStream = namedMetadataStream(extend, 0xa0, '$I30', this.info, { required: false });
      const bitmapStream = namedMetadataStream(extend, 0xb0, '$I30', this.info, { required: false });
      const indexReads = [];
      const bitmapReads = [];
      const found = await findDirectoryIndexEntries({ rootValue: roots[0].value, allocationStream, bitmapStream,
        directoryReference: { recordNumber: 11, sequence: extend.sequence }, expectedName: '$UsnJrnl', info: this.info,
        signal, control, readStream: async (stream, offset, length, readSignal) => {
          const bytes = await this.readStream(stream, offset, length, readSignal);
          const proof = { offset, length, sha256: createHash('sha256').update(bytes).digest('hex') };
          (stream === bitmapStream ? bitmapReads : indexReads).push(proof);
          return bytes;
        } });
      const references = new Map(found.matches.map(entry => {
        const value = entry.reference;
        return [`${value.recordNumber}:${value.sequence}`, value];
      }));
      requireValue(references.size === 1, 'USN_UNAVAILABLE', references.size
        ? '$Extend 인덱스에서 변경 기록 파일 참조가 중복돼 위치를 확정하지 못했어요.'
        : '$Extend 인덱스에 변경 기록 파일이 없어요.');
      return validateJournal([...references.values()][0], { strategy: 'directory-index',
        index: { allocationStream, bitmapStream, reads: indexReads, bitmapReads },
        indexNodesRead: found.stats.indexNodesRead, indexBytesRead: found.stats.indexBytesRead });
    } catch (error) {
      if (!['USN_INDEX_UNSUPPORTED', 'USN_INDEX_LIMIT'].includes(error.code)) throw error;
      const cached = new Map(this.journalRecords.map(item => [`${item.recordNumber}:${item.sequence}`, item]));
      if (cached.size === 1) return validateJournal([...cached.values()][0], { strategy: 'scan-cache',
        indexWarning: { code: error.code, message: error.message } });
      if (cached.size > 1) throw new RecoveryError('USN_UNAVAILABLE', '변경 기록 파일 위치가 여러 개라 하나로 확정하지 못했어요.');
      const references = [];
      const end = Math.min(this.info.recordCount, 4096);
      let activeMilliseconds = 0;
      for (let number = 16; number < end; number++) {
        cancelled(signal);
        await control?.checkpoint();
        if (activeMilliseconds >= 1000) break;
        const started = Date.now();
        try {
          const item = await this.record(number, signal);
          discoveryRecordsRead++;
          if (isLiveDataRecord(item) && item.baseReference === 0n && item.names.some(name => name.name === '$UsnJrnl'
            && name.parent.recordNumber === 11 && name.parent.sequence === extend.sequence)
            && await this.bitmapBit(this.mftBitmap, number, signal)) references.push({ recordNumber: number, sequence: item.sequence });
        } catch (recordError) {
          discoveryRecordsRead++;
          if (recordError.code === 'CANCELLED' || recordError.code === 'READ_FAILED') throw recordError;
        } finally { activeMilliseconds += Date.now() - started; }
        if (references.length > 1) break;
        if (number % 128 === 0) publish('bounded-mft-fallback');
      }
      requireValue(references.length === 1, end < this.info.recordCount || activeMilliseconds >= 1000
        ? 'USN_DISCOVERY_LIMIT' : 'USN_UNAVAILABLE',
      end < this.info.recordCount || activeMilliseconds >= 1000
        ? '직접 인덱스를 지원하지 못했고 4096개 미만의 제한된 MFT 확인에서도 변경 기록을 찾지 못했어요.'
        : '사용 가능한 변경 기록 파일을 하나로 확인하지 못했어요.');
      return validateJournal(references[0], { strategy: 'bounded-mft-fallback',
        indexWarning: { code: error.code, message: error.message } });
    }
  }

  async verifyJournalDiscovery(discovery, journalProofs, readProofs, signal, control, allocation) {
    const readBit = this.bitmapReader(allocation, signal);
    for (const proof of [...discovery.proofs, ...journalProofs]) {
      cancelled(signal); await control?.checkpoint();
      const current = await this.record(proof.recordNumber, signal);
      requireValue(current?.fingerprint === proof.fingerprint && await readBit('mftBitmap', proof.recordNumber),
        'USN_CHANGED', '읽는 동안 변경 기록 메타데이터가 바뀌었어요.');
    }
    const index = discovery.index;
    if (index) {
      for (const proof of index.reads) {
        cancelled(signal); await control?.checkpoint();
        await this.assertStreamRangeAllocated(index.allocationStream, proof.offset, proof.length, readBit, signal);
        const bytes = await this.readStream(index.allocationStream, proof.offset, proof.length, signal);
        requireValue(createHash('sha256').update(bytes).digest('hex') === proof.sha256,
          'USN_CHANGED', '읽는 동안 $Extend 디렉터리 인덱스가 바뀌었어요.');
      }
      for (const proof of index.bitmapReads) {
        cancelled(signal); await control?.checkpoint();
        await this.assertStreamRangeAllocated(index.bitmapStream, proof.offset, proof.length, readBit, signal);
        const bytes = await this.readStream(index.bitmapStream, proof.offset, proof.length, signal);
        requireValue(createHash('sha256').update(bytes).digest('hex') === proof.sha256,
          'USN_CHANGED', '읽는 동안 $Extend 디렉터리 인덱스 비트맵이 바뀌었어요.');
      }
    }
    for (const proof of readProofs) {
      cancelled(signal); await control?.checkpoint();
      await this.assertStreamRangeAllocated(proof.stream, proof.offset, proof.length, readBit, signal);
      const bytes = await this.readStream(proof.stream, proof.offset, proof.length, signal);
      requireValue(createHash('sha256').update(bytes).digest('hex') === proof.sha256,
        'USN_CHANGED', '읽는 동안 삭제 변경 기록 내용이 바뀌었어요.');
    }
  }

  async journalStream(record, signal, control) {
    requireValue(isLiveDataRecord(record) && record.baseReference === 0n,
      'USN_UNAVAILABLE', '사용 중인 변경 기록 파일을 확인할 수 없어요.');
    requireValue(!record.attributes.some(attribute => attribute.type === 0xc0), 'USN_UNSUPPORTED', '변경 기록 파일의 재분석점은 지원하지 않아요.');
    const lists = record.attributes.filter(attribute => attribute.type === 0x20);
    requireValue(lists.length <= 1, 'USN_UNSUPPORTED', '변경 기록 파일의 속성 목록이 지원 범위를 벗어났어요.');
    let segments = record.attributes.filter(attribute => attribute.type === 0x80 && attribute.name === '$J');
    const proofs = new Map([[record.recordNumber, { recordNumber: record.recordNumber, fingerprint: record.fingerprint }]]);
    if (lists.length) {
      const entries = parseAttributeList(lists[0], this.info).filter(entry => entry.type === 0x80 && entry.name === '$J');
      requireValue(entries.length > 0 && entries.length <= MAX_EXTENSION_RECORDS, 'USN_UNSUPPORTED', '변경 기록의 데이터 조각이 없거나 너무 많아요.');
      const owner = fileReference(record);
      const resolved = [];
      for (const entry of entries) {
        cancelled(signal);
        await control?.checkpoint();
        const extension = entry.segment.recordNumber === record.recordNumber ? record : await this.record(entry.segment.recordNumber, signal);
        requireValue(isLiveDataRecord(extension) && extension.sequence === entry.segment.sequence
          && (extension === record || extension.baseReference === owner)
          && await this.bitmapBit(this.mftBitmap, extension.recordNumber, signal), 'USN_UNAVAILABLE', '변경 기록의 데이터 조각 소유권을 확인할 수 없어요.');
        if (extension !== record) requireValue(!extension.attributes.some(attribute => attribute.type === 0x20 || attribute.type === 0xc0),
          'USN_UNSUPPORTED', '중첩 속성 목록이 있는 변경 기록은 지원하지 않아요.');
        const matches = extension.attributes.filter(attribute => attribute.type === 0x80 && attribute.name === '$J'
          && attribute.id === entry.attributeId && (attribute.resident ? 0 : attribute.firstVcn) === entry.lowestVcn);
        requireValue(matches.length === 1, 'USN_UNAVAILABLE', '변경 기록의 데이터 조각 참조가 맞지 않아요.');
        proofs.set(extension.recordNumber, { recordNumber: extension.recordNumber, fingerprint: extension.fingerprint });
        resolved.push(matches[0]);
      }
      requireValue(segments.every(segment => resolved.includes(segment)), 'USN_UNAVAILABLE', '변경 기록의 기본 데이터 조각을 검증하지 못했어요.');
      segments = resolved;
    }
    requireValue(segments.length > 0 && segments.every(segment => !segment.problem && [0, 0x8000].includes(segment.flags)),
      'USN_UNSUPPORTED', '변경 기록의 데이터 스트림이 없거나 지원하지 않는 형태예요.');
    const stream = segments.length === 1 && segments[0].resident ? segments[0] : completeStream(segments, this.info);
    return { stream, proofs: [...proofs.values()] };
  }

  // Called only when a caller requests deletion-time ordering. No source is written.
  async readDeletionTimes(candidates, { signal, control, onProgress, maxBytes, maxRecords, maxTimeMs } = {}) {
    requireValue(!this.busy, 'BUSY', '이 이미지에서 다른 작업을 진행 중이에요.');
    requireValue(Array.isArray(candidates) && candidates.length <= 10000, 'INVALID_LIMIT', '삭제 시각 확인 후보는 10000개 이하여야 해요.');
    this.busy = true;
    const unavailable = (code, message) => ({ timestamps: new Map(), warnings: [{ code, message }], complete: false,
      stats: { bytesRead: 0, recordsRead: 0, matchedFiles: 0 } });
    try {
      cancelled(signal);
      await this.assertUnchanged();
      if (candidates.length === 0) return { timestamps: new Map(), warnings: [], complete: true, stats: { bytesRead: 0, recordsRead: 0, matchedFiles: 0 } };
      onProgress?.({ stage: 'journal', bytesRead: 0, recordsRead: 0, matchedFiles: 0 });
      const { record, discovery } = await this.discoverJournalRecord(signal, control, onProgress);
      const { stream, proofs: journalProofs } = await this.journalStream(record, signal, control);
      // Windows increments SequenceNumber when freeing an MFT record. Match the
      // immediately preceding full reference only with this scan's unallocated
      // record proof and retained filename + parent reference. Wrap is ambiguous.
      // https://learn.microsoft.com/en-us/windows/win32/devnotes/file-record-segment-header
      const historicalCandidates = candidates.flatMap(candidate => {
        const proof = this.scanned.get(candidate.recordNumber);
        const identity = proof?.deletionIdentity;
        return proof?.candidate.id === candidate.id && identity?.sequence === candidate.sequence && identity.sequence > 1
          ? [{ id: candidate.id, recordNumber: candidate.recordNumber, sequence: identity.sequence - 1, names: identity.names }]
          : [];
      });
      if (!historicalCandidates.length) return unavailable('USN_IDENTITY_UNAVAILABLE', '삭제 기록의 세대를 확실히 연결하지 못해 삭제 시각은 미상으로 표시해요.');
      const ranges = this.streamRanges(stream);
      if (!ranges.length) return unavailable('USN_UNAVAILABLE', '남아 있는 변경 기록이 없어 삭제 시각은 미상으로 표시해요.');
      const beforeAllocation = await this.refreshAllocationMetadata(signal);
      const bitmapReader = allocation => {
        const caches = new Map();
        return async (kind, index) => {
          const bitmap = allocation[kind];
          const byteIndex = Math.floor(index / 8);
          const pageOffset = Math.floor(byteIndex / 4096) * 4096;
          const key = `${kind}:${pageOffset}`;
          if (!caches.has(key)) {
            requireValue(caches.size < 128, 'USN_VALIDATION_LIMIT', '변경 기록 할당 상태의 확인 범위 제한에 도달했어요.');
            caches.set(key, await this.readStream(bitmap, pageOffset, Math.min(4096, bitmap.size - pageOffset), signal));
          }
          return Boolean(caches.get(key)[byteIndex - pageOffset] & 1 << index % 8);
        };
      };
      const beforeBit = bitmapReader(beforeAllocation);
      for (const proof of journalProofs) requireValue(await beforeBit('mftBitmap', proof.recordNumber),
        'USN_CHANGED', '변경 기록 파일의 할당 상태가 달라졌어요.');
      const assertJournalAllocation = async (offset, length, readBit) => {
        if (stream.resident) return;
        for (const run of stream.runs) {
          if (run.sparse) continue;
          const start = Math.max(offset, run.vcn * this.info.clusterSize);
          const end = Math.min(offset + length, (run.vcn + run.count) * this.info.clusterSize);
          if (start >= end) continue;
          const firstCluster = run.lcn + Math.floor((start - run.vcn * this.info.clusterSize) / this.info.clusterSize);
          const lastCluster = run.lcn + Math.ceil((end - run.vcn * this.info.clusterSize) / this.info.clusterSize);
          for (let cluster = firstCluster; cluster < lastCluster; cluster++) {
            cancelled(signal);
            requireValue(await readBit('volumeBitmap', cluster), 'USN_CHANGED', '변경 기록의 데이터 구간이 현재 할당되어 있지 않아요.');
          }
        }
      };
      const readRanges = [];
      const result = await readUsnDeletionTimes({ candidates: historicalCandidates, ranges, signal, control, onProgress, maxBytes, maxRecords, maxTimeMs,
        read: async (offset, length) => {
          await assertJournalAllocation(offset, length, beforeBit);
          const bytes = await this.readStream(stream, offset, length, signal);
          readRanges.push({ stream, offset, length, sha256: createHash('sha256').update(bytes).digest('hex') });
          return bytes;
        } });
      // A live raw volume may change during the read. Recheck only matched MFT
      // entries and actually read journal ranges; no sparse-region/whole-disk walk.
      const afterAllocation = await this.refreshAllocationMetadata(signal);
      const afterBit = bitmapReader(afterAllocation);
      const historicalById = new Map(historicalCandidates.map(candidate => [candidate.id, candidate]));
      let verificationBytes = 0;
      let verificationMilliseconds = 0;
      for (const [id] of [...result.timestamps].sort((a, b) => Date.parse(b[1]) - Date.parse(a[1]))) {
        cancelled(signal);
        await control?.checkpoint();
        if (verificationBytes + this.info.recordSize > 4 * 1024 * 1024 || verificationMilliseconds >= 3000) {
          result.timestamps.delete(id);
          if (!result.warnings.some(item => item.code === 'USN_VALIDATION_LIMIT')) result.warnings.push({
            code: 'USN_VALIDATION_LIMIT', message: '삭제 기록의 현재 상태 확인 제한에 도달해 일부 시각은 미상으로 표시해요.' });
          result.complete = false;
          continue;
        }
        const started = Date.now();
        const original = historicalById.get(id);
        const proof = this.scanned.get(original.recordNumber);
        const current = await this.record(original.recordNumber, signal);
        verificationBytes += this.info.recordSize;
        if (!current || current.flags !== 0 || current.fingerprint !== proof.fingerprint
          || await afterBit('mftBitmap', original.recordNumber)) {
          result.timestamps.delete(id);
          if (!result.warnings.some(item => item.code === 'USN_CANDIDATE_CHANGED')) result.warnings.push({
            code: 'USN_CANDIDATE_CHANGED', message: '검색 중 파일 기록이 바뀐 후보는 삭제 시각을 미상으로 표시해요.' });
          result.complete = false;
        }
        verificationMilliseconds += Date.now() - started;
      }
      const validationStarted = Date.now();
      await this.verifyJournalDiscovery(discovery, journalProofs, readRanges, signal, control, afterAllocation);
      verificationMilliseconds += Date.now() - validationStarted;
      requireValue(verificationMilliseconds < 3000, 'USN_VALIDATION_LIMIT', '변경 기록의 현재 상태 확인 시간 제한에 도달했어요.');
      result.stats.matchedFiles = result.timestamps.size;
      if (historicalCandidates.length < candidates.length) {
        result.warnings.push({ code: 'USN_IDENTITY_UNAVAILABLE', message: '일부 삭제 기록은 세대를 확실히 연결하지 못해 삭제 시각을 미상으로 표시해요.' });
        result.complete = false;
      }
      await this.assertUnchanged();
      return result;
    } catch (error) {
      if (['CANCELLED', 'SOURCE_CHANGED', 'INVALID_LIMIT'].includes(error.code)) throw error;
      return unavailable(error.code?.startsWith('USN_') ? error.code : 'USN_UNAVAILABLE',
        '변경 기록을 읽거나 검증하지 못해 삭제 시각은 미상으로 표시해요.');
    } finally { this.busy = false; }
  }

  async scanDeletedPeriod({ deletedAfter, deletedBefore, signal, control, onProgress, onCandidate,
    maxCandidates = 10000, maxJournalBytes, maxJournalRecords, maxJournalTimeMs } = {}) {
    requireValue(!this.busy, 'BUSY', '이 이미지에서 다른 작업을 진행 중이에요.');
    requireValue(Number.isInteger(maxCandidates) && maxCandidates >= 1 && maxCandidates <= 100000,
      'INVALID_LIMIT', '후보 제한은 1~100000이어야 해요.');
    const normalizeBound = (value, label) => {
      if (value == null) return null;
      const normalized = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : Number.NaN;
      requireValue(Number.isSafeInteger(normalized) && Math.abs(normalized) <= 8640000000000000,
        'INVALID_DATE_RANGE', `${label}이 올바른 날짜가 아니에요.`);
      return normalized;
    };
    const after = normalizeBound(deletedAfter, '삭제 기간 시작');
    const before = normalizeBound(deletedBefore, '삭제 기간 끝');
    requireValue(after != null || before != null, 'INVALID_DATE_RANGE', '삭제 기간의 시작 또는 끝이 필요해요.');
    requireValue(after == null || before == null || after <= before, 'INVALID_DATE_RANGE', '삭제 기간의 시작이 끝보다 늦어요.');
    const coverage = (extra = {}) => ({ strategy: 'journal-first', deletedAfter: after, deletedBefore: before,
      boundsInclusive: true, retainedJournalOnly: true, allDiskComplete: false, requiresFullScan: true,
      limitations: ['NTFS 변경 저널에 남아 있는 삭제 이벤트만 확인함', '저널 보존 시작 이전 또는 기록 누락 삭제는 전체 MFT 검색이 필요함'],
      limits: { maxJournalBytes: maxJournalBytes ?? 16 * 1024 * 1024,
        maxJournalRecords: maxJournalRecords ?? 250000, maxJournalTimeMs: maxJournalTimeMs ?? 3000,
        maxCandidates, maxIndexNodes: 256, maxIndexBytes: 8 * 1024 * 1024, maxIndexTimeMs: 1000,
        fallbackMftRecords: 4096 }, ...extra });
    const stats = { journalBytesRead: 0, journalRecordsRead: 0, journalEventsMatched: 0,
      discoveryRecordsRead: 0, recordsRead: 0, recordsTotal: 0, candidatesFound: 0, recordsRejected: 0 };
    const unavailable = (error, existingWarnings = []) => {
      this.scanned.clear();
      if (stats.candidatesFound) stats.provisionalCandidates = stats.candidatesFound;
      stats.candidatesFound = 0;
      const code = error?.code?.startsWith?.('USN_') ? error.code : 'USN_UNAVAILABLE';
      const warning = { code, message: error?.message || '변경 기록을 읽거나 검증하지 못해 이 기간의 삭제 파일을 확인하지 못했어요.' };
      const warnings = [...existingWarnings];
      if (!warnings.some(item => item.code === warning.code)) warnings.push(warning);
      return { candidates: [], warnings, stats, complete: false,
        truncated: ['USN_DISCOVERY_LIMIT', 'USN_INDEX_LIMIT', 'USN_VALIDATION_LIMIT'].includes(code),
        coverage: coverage({ journalAvailable: false, journalComplete: false,
          discoveryStrategy: null }) };
    };

    this.busy = true;
    this.scanned.clear();
    this.scanCheckpoint = null;
    this.journalRecords = [];
    try {
      cancelled(signal);
      await this.assertUnchanged();
      let discoveryResult;
      try {
        discoveryResult = await this.discoverJournalRecord(signal, control, event => {
          stats.discoveryRecordsRead = event.discoveryRecordsRead ?? stats.discoveryRecordsRead;
          onProgress?.({ ...event, ...stats });
        });
      } catch (error) {
        if (['CANCELLED', 'SOURCE_CHANGED', 'READ_FAILED', 'INVALID_LIMIT'].includes(error.code)) throw error;
        if (!error.code?.startsWith?.('USN_')) throw error;
        return unavailable(error);
      }
      const { record: journalRecord, discovery } = discoveryResult;
      stats.discoveryRecordsRead = discovery.discoveryRecordsRead;
      let journal;
      try { journal = await this.journalStream(journalRecord, signal, control); }
      catch (error) {
        if (['CANCELLED', 'SOURCE_CHANGED', 'READ_FAILED', 'INVALID_LIMIT'].includes(error.code)) throw error;
        if (!error.code?.startsWith?.('USN_') && !(error instanceof RecoveryError)) throw error;
        return unavailable(error);
      }
      const ranges = this.streamRanges(journal.stream);
      if (!ranges.length) return unavailable(new RecoveryError('USN_UNAVAILABLE', '남아 있는 변경 기록이 없어 이 기간을 빠르게 확인할 수 없어요.'));

      const beforeAllocation = await this.refreshAllocationMetadata(signal);
      const beforeBit = this.bitmapReader(beforeAllocation, signal);
      for (const proof of [...discovery.proofs, ...journal.proofs]) {
        requireValue(await beforeBit('mftBitmap', proof.recordNumber), 'USN_CHANGED', '변경 기록 메타데이터의 할당 상태가 달라졌어요.');
      }
      if (discovery.index) {
        for (const proof of discovery.index.reads) {
          await this.assertStreamRangeAllocated(discovery.index.allocationStream, proof.offset, proof.length, beforeBit, signal);
        }
        for (const proof of discovery.index.bitmapReads) {
          await this.assertStreamRangeAllocated(discovery.index.bitmapStream, proof.offset, proof.length, beforeBit, signal);
        }
      }

      const journalReadProofs = [];
      let eventsResult;
      try {
        eventsResult = await readUsnDeletionEvents({ ranges, deletedAfter: after, deletedBefore: before,
          signal, control, maxBytes: maxJournalBytes, maxRecords: maxJournalRecords,
          maxTimeMs: maxJournalTimeMs,
          onProgress: event => {
            stats.journalBytesRead = event.journalBytesRead ?? event.bytesRead ?? stats.journalBytesRead;
            stats.journalRecordsRead = event.journalRecordsRead ?? event.recordsRead ?? stats.journalRecordsRead;
            stats.journalEventsMatched = event.eventsFound ?? stats.journalEventsMatched;
            onProgress?.({ stage: 'journal', ...stats });
          },
          read: async (offset, length) => {
            await this.assertStreamRangeAllocated(journal.stream, offset, length, beforeBit, signal);
            const bytes = await this.readStream(journal.stream, offset, length, signal);
            journalReadProofs.push({ stream: journal.stream, offset, length,
              sha256: createHash('sha256').update(bytes).digest('hex') });
            return bytes;
          } });
      } catch (error) {
        if (['CANCELLED', 'SOURCE_CHANGED', 'READ_FAILED', 'INVALID_LIMIT', 'INVALID_DATE_RANGE'].includes(error.code)) throw error;
        if (!error.code?.startsWith?.('USN_')) throw error;
        return unavailable(error);
      }
      stats.journalBytesRead = eventsResult.stats.journalBytesRead;
      stats.journalRecordsRead = eventsResult.stats.journalRecordsRead;
      stats.journalEventsMatched = eventsResult.events.length;
      const warnings = eventsResult.warnings.map(item => ({ ...item }));

      const targetEvents = new Map();
      let targetLimitReached = false;
      for (const event of eventsResult.events) {
        if (!Number.isSafeInteger(event.recordNumber) || event.recordNumber < 16 || event.recordNumber >= this.info.recordCount
          || !Number.isSafeInteger(event.sequence) || event.sequence < 1 || event.sequence >= 65535) {
          stats.recordsRejected++;
          continue;
        }
        if (!targetEvents.has(event.recordNumber)) {
          if (targetEvents.size >= maxCandidates) { targetLimitReached = true; continue; }
          targetEvents.set(event.recordNumber, []);
        }
        targetEvents.get(event.recordNumber).push(event);
      }
      if (targetLimitReached && !warnings.some(item => item.code === 'USN_EVENT_LIMIT')) warnings.push({
        code: 'USN_EVENT_LIMIT', message: '기간 안의 삭제 파일 참조가 후보 제한을 넘어 최근 참조만 확인했어요.' });
      stats.recordsTotal = targetEvents.size;
      onProgress?.({ stage: 'period-records', ...stats });
      const provisional = [];
      for (const [recordNumber, recordedEvents] of targetEvents) {
        cancelled(signal); await control?.checkpoint();
        let record;
        try { record = await this.record(recordNumber, signal); }
        catch (error) {
          if (error.code === 'CANCELLED' || error.code === 'READ_FAILED') throw error;
          stats.recordsRead++;
          stats.recordsRejected++;
          if (warnings.length < MAX_WARNINGS) warnings.push({ recordNumber, code: error.code ?? 'INVALID_RECORD', message: error.message });
          onProgress?.({ stage: 'period-records', ...stats });
          continue;
        }
        stats.recordsRead++;
        const matching = record && record.flags === 0 && record.baseReference === 0n
          && !(await beforeBit('mftBitmap', recordNumber))
          ? recordedEvents.filter(event => event.sequence < 65535 && record.sequence === event.sequence + 1
            && record.names.some(name => name.name === event.name
              && name.parent.recordNumber === event.parent.recordNumber && name.parent.sequence === event.parent.sequence))
          : [];
        if (!matching.length) {
          stats.recordsRejected++;
          onProgress?.({ stage: 'period-records', ...stats });
          continue;
        }
        const deletion = matching.reduce((latest, event) => !latest || event.deletedAtMs > latest.deletedAtMs ? event : latest, null);
        try {
          const proof = {};
          const candidate = await this.candidate(record, signal, beforeAllocation, proof);
          provisional.push({ record, proof, deletion, candidate: { ...candidate,
            deletedAt: deletion.deletedAt, deletedAtSource: 'ntfs-usn' } });
          stats.candidatesFound = provisional.length;
        } catch (error) {
          if (error.code === 'CANCELLED' || error.code === 'READ_FAILED') throw error;
          stats.recordsRejected++;
          if (warnings.length < MAX_WARNINGS) warnings.push({ recordNumber, code: error.code ?? 'INVALID_RECORD', message: error.message });
        }
        onProgress?.({ stage: 'period-records', ...stats });
      }

      // Nothing is emitted or entered into scanned until the journal bytes,
      // directory lookup, allocation maps, and every selected record are stable.
      await this.assertUnchanged();
      const afterAllocation = await this.refreshAllocationMetadata(signal);
      try { await this.verifyJournalDiscovery(discovery, journal.proofs, journalReadProofs, signal, control, afterAllocation); }
      catch (error) {
        if (['CANCELLED', 'SOURCE_CHANGED', 'READ_FAILED'].includes(error.code)) throw error;
        if (!error.code?.startsWith?.('USN_')) throw error;
        return unavailable(error, warnings);
      }
      const afterBit = this.bitmapReader(afterAllocation, signal);
      const verified = [];
      const verifiedScanned = new Map();
      for (const selected of provisional) {
        cancelled(signal); await control?.checkpoint();
        const current = await this.record(selected.record.recordNumber, signal);
        requireValue(current && current.flags === 0 && current.baseReference === 0n
          && current.fingerprint === selected.record.fingerprint && !(await afterBit('mftBitmap', current.recordNumber))
          && current.sequence === selected.deletion.sequence + 1 && selected.deletion.sequence < 65535
          && current.names.some(name => name.name === selected.deletion.name
            && name.parent.recordNumber === selected.deletion.parent.recordNumber
            && name.parent.sequence === selected.deletion.parent.sequence),
        'USN_CANDIDATE_CHANGED', '검증 중 삭제 파일 기록의 세대, 이름 또는 부모 참조가 바뀌었어요.');
        const proof = {};
        const currentCandidate = await this.candidate(current, signal, afterAllocation, proof);
        requireValue(sameExtensionProof(proof.extensions, selected.proof.extensions),
          'USN_CANDIDATE_CHANGED', '검증 중 삭제 파일의 확장 기록이 바뀌었어요.');
        const candidate = { ...currentCandidate, deletedAt: selected.deletion.deletedAt, deletedAtSource: 'ntfs-usn' };
        verified.push(candidate);
        verifiedScanned.set(current.recordNumber, { recordEvidence: summarizeRecord(current), fingerprint: current.fingerprint, extensions: proof.extensions, candidate,
          deletionIdentity: { sequence: current.sequence, names: current.names } });
      }
      await this.assertUnchanged();
      this.scanned = verifiedScanned;
      stats.candidatesFound = verified.length;
      for (const candidate of verified) onCandidate?.(candidate);
      onProgress?.({ stage: 'period-records', ...stats });
      const truncated = Boolean(eventsResult.truncated || targetLimitReached);
      return { candidates: verified, warnings, stats,
        complete: eventsResult.complete && warnings.length === 0 && !truncated, truncated,
        coverage: coverage({ journalAvailable: true, journalComplete: eventsResult.complete,
          discoveryStrategy: discovery.strategy, journalRangeBytes: ranges.reduce((sum, item) => sum + item.length, 0) }) };
    } catch (error) {
      this.scanned.clear();
      if (['CANCELLED', 'SOURCE_CHANGED', 'READ_FAILED', 'INVALID_LIMIT', 'INVALID_DATE_RANGE'].includes(error.code)) throw error;
      if (!error.code?.startsWith?.('USN_') && !(error instanceof RecoveryError)) throw error;
      return unavailable(error);
    } finally { this.busy = false; }
  }

  async scanDeleted({ signal, onProgress, onCandidate, control, maxCandidates = 10000, resumeFrom } = {}) {
    requireValue(!this.busy, 'BUSY', '이 이미지에서 다른 작업을 진행 중이에요.');
    requireValue(Number.isInteger(maxCandidates) && maxCandidates >= 1 && maxCandidates <= 100000, 'INVALID_LIMIT', '후보 제한은 1~100000이어야 해요.');
    this.busy = true;
    try {
      cancelled(signal);
      await this.assertUnchanged();
      let candidates;
      if (resumeFrom === undefined) {
        this.scanned.clear();
        this.journalRecords = [];
        this.scanCheckpoint = { version: 1, nextRecord: 0, ...this.checkpointGeometry(), malformedRecords: 0, warnings: [], entries: [] };
        candidates = [];
      } else {
        candidates = await this.restoreCheckpoint(resumeFrom, signal, onCandidate, maxCandidates);
      }
      const warnings = this.scanCheckpoint.warnings.map(item => ({ ...item }));
      const stats = { recordsRead: this.scanCheckpoint.nextRecord, recordsTotal: this.info.recordCount,
        malformedRecords: this.scanCheckpoint.malformedRecords, candidatesFound: candidates.length };
      let truncated = false;
      if (resumeFrom !== undefined) onProgress?.({ stage: 'scan', ...stats, resumed: true });
      for (let number = this.scanCheckpoint.nextRecord; number < this.info.recordCount; number++) {
        cancelled(signal);
        await control?.checkpoint();
        let record;
        let recordIsUnallocated = false;
        let emittedCandidate;
        try {
          record = await this.record(number, signal);
          const allocated = await this.bitmapBit(this.mftBitmap, number, signal);
          requireValue(record !== null || !allocated, 'MFT_BITMAP_MISMATCH', '비어 있는 파일 기록을 사용 중으로 표시하고 있어요.');
          if (record) requireValue(Boolean(record.flags & 1) === allocated, 'MFT_BITMAP_MISMATCH', '파일 기록의 사용 상태와 MFT 할당 비트맵이 맞지 않아요.');
          recordIsUnallocated = record?.flags === 0 && !allocated;
          if (isLiveDataRecord(record) && record.baseReference === 0n && this.journalRecords.length < 2
            && !this.journalRecords.some(item => item.recordNumber === number)
            && record.names.some(name => name.name === '$UsnJrnl' && name.parent.recordNumber === 11)) {
            this.journalRecords.push({ recordNumber: number, sequence: record.sequence });
          }
        }
        catch (error) {
          if (!(error instanceof RecoveryError) || error.code === 'CANCELLED' || error.code === 'READ_FAILED') throw error;
          stats.malformedRecords++;
          if (warnings.length < MAX_WARNINGS) warnings.push({ recordNumber: number, code: error.code, message: error.message });
        }
        if (number >= 16 && record && record.flags === 0 && record.baseReference === 0n) {
          if (candidates.length >= maxCandidates) { truncated = true; break; }
          const proof = {};
          const candidate = await this.candidate(record, signal, undefined, proof);
          this.scanned.set(number, { recordEvidence: summarizeRecord(record), fingerprint: record.fingerprint, extensions: proof.extensions, candidate,
            deletionIdentity: recordIsUnallocated ? { sequence: record.sequence, names: record.names } : null });
          candidates.push(candidate);
          stats.candidatesFound = candidates.length;
          this.scanCheckpoint.entries.push({ recordNumber: number, fingerprint: record.fingerprint, extensions: proof.extensions });
          emittedCandidate = candidate;
        }
        stats.recordsRead++;
        this.scanCheckpoint.nextRecord = number + 1;
        this.scanCheckpoint.malformedRecords = stats.malformedRecords;
        this.scanCheckpoint.warnings = warnings.map(item => ({ ...item }));
        if (emittedCandidate) onCandidate?.(emittedCandidate);
        if (number % 128 === 0 || number + 1 === this.info.recordCount) onProgress?.({ stage: 'scan', ...stats });
      }
      await this.assertUnchanged();
      return { candidates, warnings, stats, complete: !truncated && stats.malformedRecords === 0, truncated,
        limitations: ['검증된 NTFS 3.0/3.1 볼륨 또는 이미지 전용',
          '대체 데이터 스트림은 기본 기록의 512바이트 이하 resident Zone.Identifier 하나만 보존 지원',
          '암호화·그 밖의 대체 데이터 스트림·중첩/비resident 속성 목록은 미지원',
          '원본 내용 동일 여부는 확인하지 않음', '별도 변경 기록이 남은 경우만 삭제 시각 확인 가능'] };
    } finally { this.busy = false; }
  }

  async readCandidateBytes(recordNumber, { maxBytes = 8 * 1024 * 1024, signal, control } = {}) {
    requireValue(!this.busy, 'BUSY', '이 이미지에서 다른 작업을 진행 중이에요.');
    requireValue(Number.isSafeInteger(maxBytes) && maxBytes >= 1024 && maxBytes <= 8 * 1024 * 1024,
      'INVALID_LIMIT', '미리보기 읽기 한도가 잘못됐어요.');
    this.busy = true;
    try {
      cancelled(signal);
      await this.assertUnchanged();
      const previous = this.scanned.get(recordNumber);
      requireValue(previous, 'SCAN_REQUIRED', '먼저 삭제 파일 후보를 검색해주세요.');
      const record = await this.record(recordNumber, signal);
      if (!record || record.flags !== 0 || record.fingerprint !== previous.fingerprint)
        throw recordChangedError(previous, record, { stage: 'preview-prepare' });
      const allocation = await this.refreshAllocationMetadata(signal);
      const proof = {};
      const candidate = await this.candidate(record, signal, allocation, proof);
      requireValue(sameExtensionProof(proof.extensions, previous.extensions ?? []), 'SOURCE_CHANGED', '선택 후 확장 파일 기록이 바뀌었어요. 다시 검색해주세요.');
      requireValue(candidate.status === 'readable' && proof.stream, 'NOT_RECOVERABLE', candidate.reasons.join(' '));
      requireValue(proof.stream.size <= maxBytes, 'PREVIEW_TOO_LARGE', '8MB 이하의 파일만 미리 볼 수 있어요.');
      const bytes = Buffer.alloc(proof.stream.size);
      let offset = 0;
      while (offset < bytes.length) {
        cancelled(signal); await control?.checkpoint();
        const chunk = await this.readStream(proof.stream, offset, Math.min(MAX_READ, bytes.length - offset), signal);
        requireValue(chunk.length > 0, 'READ_FAILED', '파일 내용을 끝까지 읽지 못했어요.');
        chunk.copy(bytes, offset); offset += chunk.length;
      }
      await this.assertUnchanged();
      const after = await this.record(recordNumber, signal);
      if (after?.fingerprint !== record.fingerprint) throw recordChangedError(record, after, { stage: 'preview-readback' });
      const afterAllocation = await this.refreshAllocationMetadata(signal);
      const afterProof = {};
      const afterCandidate = await this.candidate(after, signal, afterAllocation, afterProof);
      requireValue(afterCandidate.status === 'readable' && sameExtensionProof(afterProof.extensions, previous.extensions ?? []),
        'SOURCE_CHANGED', '읽는 동안 데이터 할당 상태 또는 확장 파일 기록이 바뀌었어요.');
      return bytes;
    } finally { this.busy = false; }
  }

  async recover(recordNumber, destinationDirectory, { signal, onProgress, control, outputName } = {}) {
    requireValue(!this.busy, 'BUSY', '이 이미지에서 다른 작업을 진행 중이에요.');
    this.busy = true;
    let partialPath;
    let output;
    let savedPath;
    let saved = false;
    try {
      cancelled(signal);
      await this.assertUnchanged();
      const previous = this.scanned.get(recordNumber);
      requireValue(previous, 'SCAN_REQUIRED', '먼저 삭제 파일 후보를 검색해주세요.');
      const record = await this.record(recordNumber, signal);
      if (!record || record.flags !== 0 || record.fingerprint !== previous.fingerprint)
        throw recordChangedError(previous, record, { stage: 'recover-prepare' });
      const allocation = await this.refreshAllocationMetadata(signal);
      const proof = {};
      const candidate = await this.candidate(record, signal, allocation, proof);
      requireValue(sameExtensionProof(proof.extensions, previous.extensions ?? []), 'SOURCE_CHANGED', '선택 후 확장 파일 기록이 바뀌었어요. 다시 검색해주세요.');
      requireValue(candidate.status === 'readable', 'NOT_RECOVERABLE', candidate.reasons.join(' '));
      const stream = proof.stream;
      requireValue(stream, 'NOT_RECOVERABLE', '검증된 데이터 스트림이 없어요.');
      const supplementalStreams = proof.supplementalStreams ?? [];
      const destination = path.resolve(destinationDirectory);
      requireValue(destination !== this.imagePath, 'UNSAFE_OUTPUT', '이미지 원본에는 저장할 수 없어요.');
      await mkdir(destination, { recursive: true });
      const resolvedDestination = await realpath(destination);
      requireValue((await stat(resolvedDestination)).isDirectory(), 'UNSAFE_OUTPUT', '저장 폴더가 필요해요.');
      cancelled(signal);
      // A fresh per-file directory makes collisions explicit and preserves prior results.
      const folder = await mkdtemp(path.join(resolvedDestination, '.recovery-working-'));
      savedPath = path.join(folder, safeOutputName(outputName ?? candidate.name, recordNumber));
      partialPath = path.join(folder, '.recovery-writing.partial');
      if (savedPath === partialPath) savedPath += '-file';
      output = await open(partialPath, 'wx');
      const digest = createHash('sha256');
      let written = 0;
      while (written < stream.size) {
        cancelled(signal);
        await control?.checkpoint();
        const bytes = await this.readStream(stream, written, Math.min(MAX_READ, stream.size - written), signal);
        let done = 0;
        while (done < bytes.length) {
          cancelled(signal);
          const result = await output.write(bytes, done, bytes.length - done, written + done);
          requireValue(result.bytesWritten > 0, 'WRITE_FAILED', '복구본을 끝까지 저장하지 못했어요.');
          done += result.bytesWritten;
        }
        digest.update(bytes);
        written += bytes.length;
        onProgress?.({ stage: 'recover', bytesWritten: written, bytesTotal: stream.size });
      }
      cancelled(signal);
      await output.sync();
      await output.close();
      output = null;
      for (const supplemental of supplementalStreams) await writeSupplementalStream(partialPath, supplemental, signal);
      const sha256 = digest.digest('hex');
      const verification = await verifyRecoveredFile(partialPath, {
        expectedSize: written, expectedSha256: sha256, fileName: path.basename(savedPath), signal, control, onProgress,
      });
      await this.assertUnchanged();
      const after = await this.record(recordNumber, signal);
      if (after?.fingerprint !== record.fingerprint) throw recordChangedError(record, after, { stage: 'recover-readback' });
      const afterAllocation = await this.refreshAllocationMetadata(signal);
      const afterProof = {};
      const afterCandidate = await this.candidate(after, signal, afterAllocation, afterProof);
      requireValue(afterCandidate.status === 'readable' && sameExtensionProof(afterProof.extensions, previous.extensions ?? []),
        'SOURCE_CHANGED', '읽는 동안 데이터 할당 상태 또는 확장 파일 기록이 바뀌었어요.');
      requireValue(afterProof.supplementalStreams.length === supplementalStreams.length
        && afterProof.supplementalStreams.every((item, index) => item.name === supplementalStreams[index].name
          && item.stream.size === supplementalStreams[index].stream.size
          && item.stream.value.equals(supplementalStreams[index].stream.value)),
      'SOURCE_CHANGED', '읽는 동안 Zone.Identifier가 바뀌었어요.');
      cancelled(signal);
      // All files are owned by this operation in a newly created private directory.
      // Publish the directory with a random name, then atomically rename its partial.
      // This also works on output filesystems without hard-link support.
      const publishedFolder = path.join(resolvedDestination, `recovered-${randomUUID()}`);
      if (supplementalStreams.length) {
        // Rename and verify the complete file while the random working directory
        // is still private. Publishing the directory is then the only visible step.
        await rename(partialPath, savedPath);
        partialPath = savedPath;
        for (const supplemental of supplementalStreams) await verifySupplementalStream(savedPath, supplemental, signal);
        const savedName = path.basename(savedPath);
        await rename(folder, publishedFolder);
        savedPath = path.join(publishedFolder, savedName);
        partialPath = savedPath;
      } else {
        await rename(folder, publishedFolder);
        partialPath = path.join(publishedFolder, path.basename(partialPath));
        savedPath = path.join(publishedFolder, path.basename(savedPath));
        await rename(partialPath, savedPath);
      }
      saved = true;
      return { path: savedPath, status: 'saved', size: written, sha256, ...verification, originalIdentityVerified: false,
        validation: 'output-reread-and-hash-matched; original-content-not-verified', cleanupWarning: null,
        supplementalStreams: supplementalStreams.map(item => ({
          name: item.name, size: item.stream.size, preservation: 'preserved',
        })) };
    } catch (error) {
      if (output) await output.close().catch(() => {});
      if (error instanceof RecoveryError) {
        error.details = { ...error.details, partialPath: saved ? null : partialPath ?? null, savedPath: saved ? savedPath : null };
        throw error;
      }
      throw new RecoveryError(['CANCELLED', 'OUTPUT_VERIFICATION_FAILED'].includes(error.code) ? error.code : error.code === 'ENOSPC' ? 'OUTPUT_FULL' : 'IO_FAILED', error.message,
        { osCode: error.code, partialPath: saved ? null : partialPath ?? null, savedPath: saved ? savedPath : null });
    } finally { this.busy = false; }
  }

  async close() {
    requireValue(!this.busy, 'BUSY', '작업을 멈춘 뒤 이미지를 닫아주세요.');
    if (!this.closed) { await (this.provider ? this.provider.close() : this.handle.close()); this.closed = true; }
  }
}

export async function openNtfsProvider(provider) {
  requireValue(provider && Number.isSafeInteger(provider.info?.size) && provider.info.size >= 512 && typeof provider.read === 'function'
    && typeof provider.assertUnchanged === 'function' && typeof provider.close === 'function', 'INVALID_PROVIDER', '읽기 전용 장치 공급자가 필요해요.');
  const instance = new NtfsImage(null, null, { size: BigInt(provider.info.size) }, provider);
  try { await instance.initialize(); return instance; }
  catch (error) { await provider.close(); throw error; }
}

export async function openNtfsImage(imagePath) {
  requireValue(typeof imagePath === 'string' && imagePath.length > 0 && !/^(?:\\\\[.?]\\|\/\/[.?]\/)/.test(imagePath),
    'IMAGE_ONLY', '일반 볼륨 이미지 파일만 지정할 수 있어요.');
  const resolved = await realpath(imagePath);
  const before = await stat(resolved, { bigint: true });
  requireValue(before.isFile() && before.size >= 512n && before.size <= BigInt(Number.MAX_SAFE_INTEGER), 'IMAGE_ONLY', '일반 NTFS 볼륨 이미지 파일이 필요해요.');
  const handle = await open(resolved, 'r');
  try {
    const identity = await handle.stat({ bigint: true });
    requireValue(identity.isFile() && identity.dev === before.dev && identity.ino === before.ino, 'SOURCE_CHANGED', '이미지를 여는 동안 파일이 바뀌었어요.');
    const instance = new NtfsImage(handle, resolved, identity);
    await instance.initialize();
    return instance;
  } catch (error) { await handle.close(); throw error; }
}
