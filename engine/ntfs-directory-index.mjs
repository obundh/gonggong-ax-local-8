import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const MAX_INDEX_NODES = 256;
const MAX_INDEX_BYTES = 8 * 1024 * 1024;
const MAX_INDEX_TIME_MS = 1000;

function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
function check(condition, code, message) { if (!condition) fail(code, message); }
function abort(signal) { if (signal?.aborted) fail('CANCELLED', '작업을 취소했어요.'); }
function safeBigInt(value, label) {
  check(value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER), 'USN_INDEX_UNSUPPORTED', `${label}이 지원 범위를 벗어났어요.`);
  return Number(value);
}
function reference(value) {
  return { recordNumber: Number(value & 0xffffffffffffn), sequence: Number(value >> 48n) };
}
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function applyUsa(raw, sectorSize) {
  check(Buffer.isBuffer(raw) && raw.length >= sectorSize && raw.length % sectorSize === 0,
    'USN_INDEX_MALFORMED', '디렉터리 인덱스 블록 크기가 잘못됐어요.');
  check(raw.subarray(0, 4).toString('ascii') === 'INDX', 'USN_INDEX_MALFORMED', 'INDX 서명이 없는 디렉터리 인덱스 블록이에요.');
  const bytes = Buffer.from(raw);
  const usaOffset = bytes.readUInt16LE(4);
  const usaCount = bytes.readUInt16LE(6);
  check(usaCount === bytes.length / sectorSize + 1 && usaOffset >= 40 && usaOffset % 2 === 0
    && usaOffset + usaCount * 2 <= sectorSize - 2, 'USN_INDEX_MALFORMED', '디렉터리 인덱스의 섹터 검증 정보가 잘못됐어요.');
  const updateSequence = bytes.readUInt16LE(usaOffset);
  for (let index = 1; index < usaCount; index++) {
    const tail = index * sectorSize - 2;
    check(bytes.readUInt16LE(tail) === updateSequence, 'USN_INDEX_MALFORMED', '디렉터리 인덱스 블록이 잘렸거나 바뀌었어요.');
    bytes.writeUInt16LE(bytes.readUInt16LE(usaOffset + index * 2), tail);
  }
  return bytes;
}

function parseEntries(bytes, headerOffset, expectedParent) {
  check(headerOffset >= 0 && headerOffset + 16 <= bytes.length, 'USN_INDEX_MALFORMED', '디렉터리 인덱스 헤더가 잘렸어요.');
  const entriesOffset = bytes.readUInt32LE(headerOffset);
  const usedSize = bytes.readUInt32LE(headerOffset + 4);
  const allocatedSize = bytes.readUInt32LE(headerOffset + 8);
  const flags = bytes[headerOffset + 12];
  check(entriesOffset >= 16 && entriesOffset % 8 === 0 && usedSize >= entriesOffset && usedSize <= allocatedSize
    && headerOffset + allocatedSize <= bytes.length && (flags & ~1) === 0,
  'USN_INDEX_MALFORMED', '디렉터리 인덱스 항목 범위가 잘못됐어요.');
  let cursor = headerOffset + entriesOffset;
  const end = headerOffset + usedSize;
  const entries = [];
  const children = [];
  let ended = false;
  while (cursor < end) {
    check(cursor + 16 <= end, 'USN_INDEX_MALFORMED', '디렉터리 인덱스 항목이 잘렸어요.');
    const length = bytes.readUInt16LE(cursor + 8);
    const keyLength = bytes.readUInt16LE(cursor + 10);
    const entryFlags = bytes.readUInt16LE(cursor + 12);
    check(length >= 16 && length % 8 === 0 && cursor + length <= end && (entryFlags & ~3) === 0,
      'USN_INDEX_MALFORMED', '디렉터리 인덱스 항목 길이 또는 표시가 잘못됐어요.');
    const hasChild = Boolean(entryFlags & 1);
    const isLast = Boolean(entryFlags & 2);
    const childBytes = hasChild ? 8 : 0;
    if (hasChild) children.push(safeBigInt(bytes.readBigUInt64LE(cursor + length - 8), '하위 인덱스 VCN'));
    if (!isLast) {
      check(keyLength >= 66 && keyLength % 2 === 0 && 16 + keyLength + childBytes <= length,
        'USN_INDEX_MALFORMED', '디렉터리 인덱스 파일 이름 키가 잘렸어요.');
      const key = cursor + 16;
      const nameLength = bytes[key + 64];
      const namespace = bytes[key + 65];
      check(nameLength > 0 && namespace <= 3 && 66 + nameLength * 2 === keyLength,
        'USN_INDEX_MALFORMED', '디렉터리 인덱스 파일 이름 키가 잘못됐어요.');
      const parent = reference(bytes.readBigUInt64LE(key));
      check(parent.recordNumber === expectedParent.recordNumber && parent.sequence === expectedParent.sequence,
        'USN_INDEX_MALFORMED', '디렉터리 인덱스 항목의 부모 참조가 디렉터리와 맞지 않아요.');
      entries.push({ reference: reference(bytes.readBigUInt64LE(cursor)), parent,
        name: bytes.subarray(key + 66, key + 66 + nameLength * 2).toString('utf16le'), namespace });
    } else {
      check(keyLength === 0, 'USN_INDEX_MALFORMED', '디렉터리 인덱스 끝 항목에 예상하지 못한 키가 있어요.');
      ended = true;
    }
    cursor += length;
    if (isLast) break;
  }
  check(ended && cursor === end, 'USN_INDEX_MALFORMED', '디렉터리 인덱스의 끝이 항목 경계와 맞지 않아요.');
  return { entries, children };
}

/**
 * Resolve exact filename entries from a directory's $I30 B-tree. The caller
 * supplies already parsed streams and a bounded readStream implementation.
 */
export async function findDirectoryIndexEntries({ rootValue, allocationStream = null, bitmapStream = null,
  directoryReference, expectedName, info, readStream, signal, control,
  maxNodes = MAX_INDEX_NODES, maxBytes = MAX_INDEX_BYTES, maxTimeMs = MAX_INDEX_TIME_MS } = {}) {
  check(Buffer.isBuffer(rootValue) && rootValue.length >= 32 && rootValue.length <= 1024 * 1024,
    'USN_INDEX_UNSUPPORTED', 'resident $I30 INDEX_ROOT를 확인할 수 없어요.');
  check(directoryReference && Number.isSafeInteger(directoryReference.recordNumber)
    && Number.isSafeInteger(directoryReference.sequence) && directoryReference.sequence > 0,
  'USN_INDEX_UNSUPPORTED', '디렉터리 파일 참조가 잘못됐어요.');
  check(typeof expectedName === 'string' && expectedName.length > 0 && typeof readStream === 'function',
    'USN_INDEX_UNSUPPORTED', '디렉터리 인덱스 검색 조건이 잘못됐어요.');
  check(Number.isSafeInteger(maxNodes) && maxNodes >= 1 && maxNodes <= MAX_INDEX_NODES
    && Number.isSafeInteger(maxBytes) && maxBytes >= 1024 && maxBytes <= MAX_INDEX_BYTES
    && Number.isSafeInteger(maxTimeMs) && maxTimeMs >= 1 && maxTimeMs <= MAX_INDEX_TIME_MS,
  'INVALID_LIMIT', '디렉터리 인덱스 검색 제한이 잘못됐어요.');
  check(rootValue.readUInt32LE(0) === 0x30 && rootValue.readUInt32LE(4) === 1,
    'USN_INDEX_UNSUPPORTED', '$I30 파일 이름 정렬 인덱스 형식만 지원해요.');
  const blockSize = rootValue.readUInt32LE(8);
  const clusterCode = rootValue.readInt8(12);
  const expectedBlockSize = clusterCode < 0 ? 2 ** (-clusterCode) : clusterCode * info.clusterSize;
  // Child VCNs are cluster-relative in the layout handled here. NTFS also
  // permits index buffers smaller than a cluster, whose addressing unit differs;
  // leave that form to the explicitly bounded fallback instead of misreading it.
  check(Number.isSafeInteger(blockSize) && blockSize >= info.clusterSize && blockSize <= 64 * 1024
    && blockSize % info.sectorSize === 0 && blockSize === expectedBlockSize,
  'USN_INDEX_UNSUPPORTED', '$I30 인덱스 블록 크기를 지원하지 않아요.');

  let activeStart = performance.now();
  let activeElapsed = 0;
  const checkpoint = async () => {
    abort(signal);
    activeElapsed += performance.now() - activeStart;
    await control?.checkpoint();
    abort(signal);
    activeStart = performance.now();
    check(activeElapsed < maxTimeMs, 'USN_INDEX_LIMIT', '디렉터리 인덱스 검색 시간 제한에 도달했어요.');
  };
  const root = parseEntries(rootValue, 16, directoryReference);
  const matches = root.entries.filter(entry => entry.name === expectedName);
  const pending = [...new Set(root.children)];
  const visited = new Set();
  const reads = [];
  const bitmapReads = [];
  let bytesRead = 0;

  if (pending.length) {
    check(allocationStream && !allocationStream.resident && bitmapStream,
      'USN_INDEX_UNSUPPORTED', '$I30 하위 노드의 INDEX_ALLOCATION과 BITMAP을 확인할 수 없어요.');
  }
  while (pending.length) {
    await checkpoint();
    const vcn = pending.shift();
    check(!visited.has(vcn), 'USN_INDEX_MALFORMED', '디렉터리 인덱스 하위 노드가 순환해요.');
    check(visited.size < maxNodes, 'USN_INDEX_LIMIT', '디렉터리 인덱스 노드 수 제한에 도달했어요.');
    visited.add(vcn);
    const offset = safeBigInt(BigInt(vcn) * BigInt(info.clusterSize), '인덱스 블록 위치');
    check(offset % blockSize === 0 && offset + blockSize <= allocationStream.size,
      'USN_INDEX_MALFORMED', '디렉터리 인덱스 하위 블록 위치가 잘못됐어요.');
    check(bytesRead + blockSize <= maxBytes, 'USN_INDEX_LIMIT', '디렉터리 인덱스 읽기 제한에 도달했어요.');
    const blockIndex = offset / blockSize;
    const bitmapOffset = Math.floor(blockIndex / 8);
    check(bitmapOffset < bitmapStream.size, 'USN_INDEX_MALFORMED', '디렉터리 인덱스 비트맵이 너무 짧아요.');
    const bitmapByte = await readStream(bitmapStream, bitmapOffset, 1, signal);
    bitmapReads.push({ offset: bitmapOffset, length: 1, sha256: digest(bitmapByte) });
    check(Boolean(bitmapByte[0] & 1 << blockIndex % 8), 'USN_INDEX_MALFORMED', '할당되지 않은 디렉터리 인덱스 노드를 참조하고 있어요.');
    const raw = await readStream(allocationStream, offset, blockSize, signal);
    bytesRead += raw.length;
    reads.push({ offset, length: raw.length, sha256: digest(raw) });
    const block = applyUsa(raw, info.sectorSize);
    check(safeBigInt(block.readBigUInt64LE(16), 'INDX VCN') === vcn,
      'USN_INDEX_MALFORMED', '디렉터리 인덱스 블록의 VCN이 참조와 맞지 않아요.');
    const parsed = parseEntries(block, 24, directoryReference);
    matches.push(...parsed.entries.filter(entry => entry.name === expectedName));
    for (const child of parsed.children) {
      check(!visited.has(child) && !pending.includes(child), 'USN_INDEX_MALFORMED', '디렉터리 인덱스 하위 노드 참조가 중복되거나 순환해요.');
      pending.push(child);
    }
  }
  await checkpoint();
  return { matches, reads, bitmapReads, stats: { indexNodesRead: visited.size, indexBytesRead: bytesRead,
    activeMilliseconds: Math.round(activeElapsed + performance.now() - activeStart) }, blockSize };
}
