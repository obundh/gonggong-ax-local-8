import { createHash } from 'node:crypto';

const MAX_INPUT_BYTES = 64 * 1024;
const MAX_ENTRIES = 64;
const MAX_RECORD_NUMBER = 0xffffffffffff;
const MAX_SEQUENCE = 0xffff;
const FILETIME_EPOCH_MILLISECONDS = 11644473600000n;
const MAX_FILETIME_MILLISECONDS = 253402300799999n;

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function requireValue(condition, message) {
  if (!condition) fail('DIR_SLACK_INVALID', message);
}

function requireSupported(condition, message) {
  if (!condition) fail('DIR_SLACK_UNSUPPORTED', message);
}

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validReferenceInput(value) {
  return plainObject(value) && Object.hasOwn(value, 'recordNumber') && Object.hasOwn(value, 'sequence')
    && Number.isSafeInteger(value.recordNumber) && value.recordNumber >= 0 && value.recordNumber <= MAX_RECORD_NUMBER
    && Number.isInteger(value.sequence) && value.sequence >= 1 && value.sequence <= MAX_SEQUENCE;
}

function reference(value) {
  return {
    recordNumber: Number(value & 0xffffffffffffn),
    sequence: Number(value >> 48n),
  };
}

function sameReference(left, right) {
  return left.recordNumber === right.recordNumber && left.sequence === right.sequence;
}

function validEntryReference(value, minimumRecordNumber) {
  return value.recordNumber >= minimumRecordNumber && value.recordNumber <= MAX_RECORD_NUMBER
    && value.sequence >= 1 && value.sequence <= MAX_SEQUENCE;
}

function wellFormedUtf16(bytes, start, units) {
  for (let index = 0; index < units; index++) {
    const unit = bytes.readUInt16LE(start + index * 2);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (++index >= units) return false;
      const low = bytes.readUInt16LE(start + index * 2);
      if (low < 0xdc00 || low > 0xdfff) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

function safeWindowsLeaf(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 255 || value !== value.normalize('NFC')) return false;
  if (value === '.' || value === '..' || /[<>:"/\\|?*\u0000-\u001f\u007f]/.test(value) || /[. ]$/.test(value)) return false;
  return !/^(con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\.|$)/i.test(value);
}

function align8(value) {
  return (value + 7) & ~7;
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function filetime(ticks) {
  if (ticks === 0n) return null;
  const milliseconds = ticks / 10000n - FILETIME_EPOCH_MILLISECONDS;
  if (milliseconds < -FILETIME_EPOCH_MILLISECONDS || milliseconds > MAX_FILETIME_MILLISECONDS) return undefined;
  try { return new Date(Number(milliseconds)).toISOString(); }
  catch { return undefined; }
}

function validateInfo(info) {
  requireSupported(plainObject(info), 'NTFS 섹터와 클러스터 정보가 필요해요.');
  const { clusterSize, sectorSize } = info;
  requireSupported(Number.isInteger(sectorSize) && [512, 1024, 2048, 4096].includes(sectorSize)
    && Number.isInteger(clusterSize) && clusterSize >= sectorSize && clusterSize <= 64 * 1024
    && clusterSize % sectorSize === 0 && (clusterSize & (clusterSize - 1)) === 0,
  '지원하지 않는 NTFS 섹터 또는 클러스터 크기예요.');
}

function applyUsa(raw, sectorSize) {
  requireValue(raw.length >= sectorSize && raw.length <= MAX_INPUT_BYTES && raw.length % sectorSize === 0,
    'INDX 블록 크기가 잘못됐어요.');
  requireValue(raw.subarray(0, 4).toString('ascii') === 'INDX', 'INDX 서명이 없어요.');
  const bytes = Buffer.from(raw);
  const usaOffset = bytes.readUInt16LE(4);
  const usaCount = bytes.readUInt16LE(6);
  requireValue(usaCount === bytes.length / sectorSize + 1 && usaOffset >= 40 && usaOffset % 2 === 0
    && usaOffset + usaCount * 2 <= sectorSize - 2,
  'INDX 섹터 검증 배열이 잘못됐어요.');
  const updateSequence = bytes.readUInt16LE(usaOffset);
  for (let index = 1; index < usaCount; index++) {
    const tail = index * sectorSize - 2;
    requireValue(bytes.readUInt16LE(tail) === updateSequence, 'INDX 섹터 검증 값이 맞지 않아요.');
    bytes.writeUInt16LE(bytes.readUInt16LE(usaOffset + index * 2), tail);
  }
  return { bytes, usaEnd: usaOffset + usaCount * 2 };
}

function decodeActiveEntry(bytes, offset, end, directoryReference, nodeHasChildren) {
  requireValue(offset + 16 <= end, '활성 인덱스 항목 머리글이 잘렸어요.');
  const length = bytes.readUInt16LE(offset + 8);
  const keyLength = bytes.readUInt16LE(offset + 10);
  const flags = bytes.readUInt16LE(offset + 12);
  const reserved = bytes.readUInt16LE(offset + 14);
  requireValue(length >= 16 && length % 8 === 0 && offset + length <= end && (flags & ~3) === 0 && reserved === 0,
    '활성 인덱스 항목 범위 또는 표시가 잘못됐어요.');
  const hasChild = Boolean(flags & 1);
  const isLast = Boolean(flags & 2);
  requireValue(hasChild === nodeHasChildren, '활성 인덱스의 하위 노드 표시가 일치하지 않아요.');
  const childBytes = hasChild ? 8 : 0;
  if (isLast) {
    requireValue(keyLength === 0 && length === 16 + childBytes, '활성 인덱스 끝 항목이 잘못됐어요.');
    return { length, isLast, entry: null };
  }
  requireValue(keyLength >= 68 && keyLength % 2 === 0 && length === align8(16 + keyLength + childBytes),
    '활성 인덱스 파일 이름 키 길이가 잘못됐어요.');
  const key = offset + 16;
  const nameLength = bytes[key + 64];
  const namespace = bytes[key + 65];
  requireValue(nameLength > 0 && namespace <= 3 && keyLength === 66 + nameLength * 2
    && wellFormedUtf16(bytes, key + 66, nameLength),
  '활성 인덱스 파일 이름 키가 잘못됐어요.');
  const itemReference = reference(bytes.readBigUInt64LE(offset));
  const parent = reference(bytes.readBigUInt64LE(key));
  requireValue(validEntryReference(itemReference, 0) && sameReference(parent, directoryReference),
    '활성 인덱스 파일 참조가 잘못됐어요.');
  return {
    length,
    isLast,
    entry: {
      reference: itemReference,
      name: bytes.subarray(key + 66, key + 66 + nameLength * 2).toString('utf16le'),
      namespace,
      parent,
    },
  };
}

function parseNode(bytes, headerOffset, directoryReference, minimumEntriesOffset = headerOffset + 16) {
  requireValue(headerOffset >= 0 && headerOffset + 16 <= bytes.length, '인덱스 노드 머리글이 잘렸어요.');
  const entriesOffset = bytes.readUInt32LE(headerOffset);
  const usedSize = bytes.readUInt32LE(headerOffset + 4);
  const allocatedSize = bytes.readUInt32LE(headerOffset + 8);
  const flags = bytes.readUInt32LE(headerOffset + 12);
  requireValue(entriesOffset >= 16 && entriesOffset % 8 === 0 && usedSize >= entriesOffset
    && usedSize <= allocatedSize && headerOffset + allocatedSize <= bytes.length && flags <= 1,
  '인덱스 노드 범위 또는 표시가 잘못됐어요.');
  const entriesStart = headerOffset + entriesOffset;
  requireValue(entriesStart >= minimumEntriesOffset, '인덱스 항목이 보호된 머리글과 겹쳐요.');
  const activeEnd = headerOffset + usedSize;
  const activeEntries = [];
  let cursor = entriesStart;
  let ended = false;
  while (cursor < activeEnd) {
    const parsed = decodeActiveEntry(bytes, cursor, activeEnd, directoryReference, Boolean(flags & 1));
    if (parsed.entry) activeEntries.push(parsed.entry);
    cursor += parsed.length;
    if (parsed.isLast) { ended = true; break; }
  }
  requireValue(ended && cursor === activeEnd, '활성 인덱스가 정확한 항목 경계에서 끝나지 않아요.');
  return {
    activeEntries,
    entriesStart,
    slackStart: activeEnd,
    slackEnd: headerOffset + allocatedSize,
  };
}

function candidateAt(bytes, offset, end, directoryReference) {
  if (offset + 16 > end) return null;
  const length = bytes.readUInt16LE(offset + 8);
  const keyLength = bytes.readUInt16LE(offset + 10);
  const flags = bytes.readUInt16LE(offset + 12);
  const reserved = bytes.readUInt16LE(offset + 14);
  if (length < 88 || length % 8 !== 0 || offset + length > end || (flags !== 0 && flags !== 1) || reserved !== 0) return null;
  const childBytes = flags === 1 ? 8 : 0;
  if (keyLength < 68 || keyLength % 2 !== 0 || length !== align8(16 + keyLength + childBytes)) return null;
  const key = offset + 16;
  const nameLength = bytes[key + 64];
  const namespace = bytes[key + 65];
  if (nameLength < 1 || (namespace !== 1 && namespace !== 3) || keyLength !== 66 + nameLength * 2
    || !wellFormedUtf16(bytes, key + 66, nameLength)) return null;
  const itemReference = reference(bytes.readBigUInt64LE(offset));
  const parent = reference(bytes.readBigUInt64LE(key));
  if (!validEntryReference(itemReference, 16) || !sameReference(parent, directoryReference)) return null;
  const name = bytes.subarray(key + 66, key + 66 + nameLength * 2).toString('utf16le');
  if (!safeWindowsLeaf(name)) return null;
  const allocatedSize = bytes.readBigUInt64LE(key + 40);
  const sizeValue = bytes.readBigUInt64LE(key + 48);
  if (allocatedSize > BigInt(Number.MAX_SAFE_INTEGER) || sizeValue > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  for (const timeOffset of [8, 24, 32]) {
    if (filetime(bytes.readBigUInt64LE(key + timeOffset)) === undefined) return null;
  }
  const modifiedAt = filetime(bytes.readBigUInt64LE(key + 16));
  if (modifiedAt === undefined) return null;
  if (childBytes && bytes.readBigUInt64LE(offset + length - 8) > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return {
    offset,
    length,
    reference: itemReference,
    parent,
    name,
    namespace,
    recordedSize: Number(sizeValue),
    modifiedAt,
    entrySha256: digest(bytes.subarray(offset, offset + length)),
  };
}

/**
 * Parse filename-shaped remnants only from the unused tail of one already
 * bounded $I30 INDEX_ROOT value or one raw allocated INDX block.
 */
export function parseDirectorySlack({ bytes, kind, directoryReference, info, expectedVcn = 0, maxEntries = MAX_ENTRIES } = {}) {
  requireSupported(Buffer.isBuffer(bytes), '디렉터리 인덱스 바이트는 Buffer여야 해요.');
  requireSupported(kind === 'root' || kind === 'allocation' || kind === 'freed-allocation',
    '지원하지 않는 디렉터리 인덱스 종류예요.');
  requireSupported(validReferenceInput(directoryReference), '디렉터리 파일 참조가 잘못됐어요.');
  validateInfo(info);
  requireSupported(Number.isInteger(maxEntries) && maxEntries >= 1 && maxEntries <= MAX_ENTRIES,
    '디렉터리 slack 항목 제한이 잘못됐어요.');
  requireSupported(bytes.length >= 32 && bytes.length <= MAX_INPUT_BYTES, '디렉터리 인덱스 크기를 지원하지 않아요.');

  let corrected = bytes;
  let blockSize;
  let parsed;
  let vcn = null;
  if (kind === 'root') {
    requireValue(bytes.readUInt32LE(0) === 0x30 && bytes.readUInt32LE(4) === 1,
      '$I30 파일 이름 정렬 INDEX_ROOT가 아니에요.');
    blockSize = bytes.readUInt32LE(8);
    const clusterCode = bytes.readInt8(12);
    const expectedBlockSize = clusterCode < 0 ? 2 ** (-clusterCode) : clusterCode * info.clusterSize;
    requireValue(bytes[13] === 0 && bytes[14] === 0 && bytes[15] === 0 && clusterCode !== 0
      && Number.isSafeInteger(expectedBlockSize) && blockSize === expectedBlockSize
      && blockSize >= info.clusterSize && blockSize <= 64 * 1024 && blockSize % info.sectorSize === 0,
    '$I30 INDEX_ROOT 블록 구조를 지원하지 않아요.');
    parsed = parseNode(corrected, 16, directoryReference);
  } else {
    requireSupported(Number.isSafeInteger(expectedVcn) && expectedVcn >= 0, '예상 INDX VCN이 잘못됐어요.');
    requireValue(bytes.length >= info.clusterSize && bytes.length % info.clusterSize === 0,
      'INDX 블록 크기가 클러스터 구조와 맞지 않아요.');
    blockSize = bytes.length;
    const fixed = applyUsa(bytes, info.sectorSize);
    corrected = fixed.bytes;
    const rawVcn = corrected.readBigUInt64LE(16);
    requireValue(rawVcn <= BigInt(Number.MAX_SAFE_INTEGER) && rawVcn === BigInt(expectedVcn), 'INDX VCN이 예상 위치와 맞지 않아요.');
    vcn = Number(rawVcn);
    parsed = parseNode(corrected, 24, directoryReference, fixed.usaEnd);
  }

  const freedAllocation = kind === 'freed-allocation';
  const reportedActiveEntries = freedAllocation ? [] : parsed.activeEntries;
  const activeKeys = new Set(reportedActiveEntries.map(entry =>
    `${entry.reference.recordNumber}:${entry.reference.sequence}:${entry.name}`));
  const entries = [];
  let cursor = freedAllocation ? parsed.entriesStart : parsed.slackStart;
  let slotsScanned = 0;
  let rejectedSlots = 0;
  let filteredActive = 0;
  let truncated = false;
  while (cursor + 16 <= parsed.slackEnd) {
    slotsScanned++;
    const candidate = candidateAt(corrected, cursor, parsed.slackEnd, directoryReference);
    if (!candidate) {
      rejectedSlots++;
      cursor += 8;
      continue;
    }
    const key = `${candidate.reference.recordNumber}:${candidate.reference.sequence}:${candidate.name}`;
    if (activeKeys.has(key)) filteredActive++;
    else if (entries.length < maxEntries) entries.push(candidate);
    else truncated = true;
    cursor += candidate.length;
  }

  return {
    entries,
    slackStart: parsed.slackStart,
    slackEnd: parsed.slackEnd,
    blockSize,
    activeEntries: reportedActiveEntries,
    truncated,
    ...(vcn === null ? {} : { vcn }),
    stats: {
      slotsScanned,
      rejectedSlots,
      filteredActive,
      truncated,
    },
  };
}
