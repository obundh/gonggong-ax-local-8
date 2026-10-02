import { lstat, mkdir, mkdtemp, open, realpath, rename } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { createCarvingCoverage } from './carving-coverage.mjs';
import { carvingSourceIdentity, restoreCarvingCheckpoint, CHECKPOINT_MAX_BYTES } from './carving-checkpoint.mjs';
import { existingCandidate } from './file-search.mjs';
import { linearizedPdfExtent } from './pdf-extent.mjs';
import { validateHwpExtent } from './hwp-carving.mjs';

const MAX_READ = 1024 * 1024;
const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_CANDIDATES = 10_000;
const MAX_WARNINGS = 100;
const SIGNATURE_OVERLAP = 7;

const SIGNATURES = [
  { format: 'png', bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  { format: 'pdf', bytes: Buffer.from('%PDF-', 'ascii') },
  { format: 'zip', bytes: Buffer.from([0x50, 0x4b, 0x03, 0x04]) },
  { format: 'jpeg', bytes: Buffer.from([0xff, 0xd8, 0xff]) },
  { format: 'hwp', bytes: Buffer.from('d0cf11e0a1b11ae1', 'hex') }
];

export class CarvingError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CarvingError';
    this.code = code;
    this.details = details;
  }
}

function requireValue(value, code, message, details = {}) {
  if (!value) throw new CarvingError(code, message, details);
}

function cancelled(signal, details = {}) {
  if (signal?.aborted) throw new CarvingError('CANCELLED', '작업을 취소했어요.', details);
}

async function checkpoint(control, signal, details = {}) {
  cancelled(signal, details);
  if (typeof control?.checkpoint === 'function') await control.checkpoint();
  cancelled(signal, details);
}

function containedBy(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function checkedInteger(value, minimum, maximum, label) {
  requireValue(Number.isSafeInteger(value) && value >= minimum && value <= maximum,
    'INVALID_ARGUMENT', `${label} 값이 지원 범위를 벗어났어요.`);
  return value;
}

function sourceSize(provider) {
  const size = Number(provider?.info?.size);
  requireValue(provider && typeof provider.read === 'function' && typeof provider.assertUnchanged === 'function',
    'INVALID_PROVIDER', '읽기 전용 데이터 공급자가 필요해요.');
  return checkedInteger(size, 0, Number.MAX_SAFE_INTEGER, '원본 크기');
}

function normalizeRanges(input, size, startOffset) {
  const start = checkedInteger(startOffset, 0, size, '시작 위치');
  const source = input === undefined
    ? [{ offset: start, length: size - start }]
    : input;
  requireValue(Array.isArray(source) && source.length > 0, 'INVALID_RANGES', '검색 범위 목록이 필요해요.');
  const ranges = source.map((range, index) => {
    requireValue(range && typeof range === 'object', 'INVALID_RANGES', `${index + 1}번째 검색 범위가 올바르지 않아요.`);
    const offset = checkedInteger(Number(range.offset), 0, size, '검색 위치');
    const length = checkedInteger(Number(range.length), 0, size - offset, '검색 길이');
    const clippedStart = Math.max(start, offset);
    return { offset: clippedStart, length: Math.max(0, offset + length - clippedStart) };
  }).filter(range => range.length > 0).sort((left, right) => left.offset - right.offset);
  const merged = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.offset <= previous.offset + previous.length) {
      previous.length = Math.max(previous.offset + previous.length, range.offset + range.length) - previous.offset;
    } else merged.push({ ...range });
  }
  return merged;
}

async function assertSource(provider) {
  try { await provider.assertUnchanged(); }
  catch (error) {
    if (error instanceof CarvingError) throw error;
    throw new CarvingError('SOURCE_CHANGED', '검색 중 원본 데이터가 변경됐어요.', { cause: error?.code });
  }
}

async function readExact(provider, offset, length, { signal, counters, coverage, phase = 'extract', control } = {}) {
  requireValue(Number.isSafeInteger(offset) && Number.isSafeInteger(length) && offset >= 0 && length >= 0
    && offset <= Number(provider.info.size) && length <= Number(provider.info.size) - offset,
  'SOURCE_BOUNDS', '원본 범위를 벗어난 읽기를 거절했어요.', { offset, length });
  const chunks = [];
  let read = 0;
  while (read < length) {
    await checkpoint(control, signal);
    const wanted = Math.min(MAX_READ, length - read);
    let chunk;
    try { chunk = await provider.read(offset + read, wanted, { signal }); }
    catch (error) {
      if (signal?.aborted || error?.code === 'CANCELLED' || error?.name === 'AbortError') {
        throw new CarvingError('CANCELLED', '작업을 취소했어요.', { offset: offset + read });
      }
      throw new CarvingError('READ_FAILED', '원본 데이터를 읽지 못했어요.', { offset: offset + read, length: wanted, cause: error?.code });
    }
    requireValue(Buffer.isBuffer(chunk) && chunk.length === wanted, 'READ_FAILED', '데이터 공급자가 요청한 길이만큼 반환하지 않았어요.',
      { offset: offset + read, expected: wanted, actual: chunk?.length ?? null });
    chunks.push(chunk);
    read += chunk.length;
    if (counters) {
      if (phase === 'scan') {
        counters.bytesRead += chunk.length;
        counters.scanReadBytes += chunk.length;
        coverage?.recordScanRead(chunk.length);
      }
      else counters.extractionBytesRead += chunk.length;
    }
  }
  return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, length);
}

class SourceCursor {
  constructor(provider, start, limit, options) {
    this.provider = provider;
    this.start = start;
    this.position = start;
    this.limit = limit;
    this.options = options;
    this.buffer = Buffer.alloc(0);
    this.bufferOffset = start;
  }

  get relative() { return this.position - this.start; }

  async ensure(count = 1) {
    if (this.position + count > this.limit) return false;
    if (this.position >= this.bufferOffset && this.position + count <= this.bufferOffset + this.buffer.length) return true;
    const length = Math.min(MAX_READ, this.limit - this.position);
    this.buffer = await readExact(this.provider, this.position, length, this.options);
    this.bufferOffset = this.position;
    return count <= this.buffer.length;
  }

  async byte() {
    if (!(await this.ensure(1))) return null;
    return this.buffer[this.position++ - this.bufferOffset];
  }

  async bytes(count) {
    if (count === 0) return Buffer.alloc(0);
    if (count <= MAX_READ && await this.ensure(count)) {
      const offset = this.position - this.bufferOffset;
      this.position += count;
      return this.buffer.subarray(offset, offset + count);
    }
    if (this.position + count > this.limit) return null;
    const result = await readExact(this.provider, this.position, count, this.options);
    this.position += count;
    this.buffer = Buffer.alloc(0);
    this.bufferOffset = this.position;
    return result;
  }

  async skip(count) {
    if (!Number.isSafeInteger(count) || count < 0 || this.position + count > this.limit) return false;
    this.position += count;
    return true;
  }
}

let crcTable;
function crc32Start() { return 0xffffffff; }
function crc32Update(crc, buffer) {
  if (!crcTable) {
    crcTable = Array.from({ length: 256 }, (_, number) => {
      let value = number;
      for (let bit = 0; bit < 8; bit++) value = (value & 1) ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
      return value >>> 0;
    });
  }
  let value = crc >>> 0;
  for (const byte of buffer) value = (value >>> 8) ^ crcTable[(value ^ byte) & 0xff];
  return value >>> 0;
}
function crc32Finish(crc) { return (crc ^ 0xffffffff) >>> 0; }

async function validatePng(provider, offset, limit, options) {
  const cursor = new SourceCursor(provider, offset, limit, options);
  const signature = await cursor.bytes(8);
  if (!signature?.equals(SIGNATURES[0].bytes)) return { state: 'invalid', reason: 'PNG 서명이 올바르지 않아요.' };
  let chunks = 0;
  let sawImageData = false;
  let validatedEnd = 8;
  while (cursor.relative < limit - offset) {
    const header = await cursor.bytes(8);
    if (!header) return chunks > 0 ? { state: 'partial', length: limit - offset, reason: 'PNG 청크 헤더가 잘렸어요.' } : { state: 'invalid' };
    const length = header.readUInt32BE(0);
    const type = header.subarray(4, 8);
    if (!/^[A-Za-z]{4}$/.test(type.toString('ascii'))) return { state: chunks ? 'partial' : 'invalid', length: validatedEnd, reason: 'PNG 청크 종류가 올바르지 않아요.' };
    if (chunks === 0 && (type.toString('ascii') !== 'IHDR' || length !== 13)) return { state: 'invalid', reason: 'PNG IHDR 구조가 올바르지 않아요.' };
    if (length > options.maxFileBytes || cursor.relative + length + 4 > options.maxFileBytes) {
      return { state: 'limit', reason: 'PNG 청크가 파일별 크기 제한을 넘었어요.' };
    }
    if (cursor.position + length + 4 > limit) return { state: 'partial', length: Math.min(limit - offset, options.maxFileBytes), reason: 'PNG 청크 데이터가 잘렸어요.' };
    let crc = crc32Update(crc32Start(), type);
    let remaining = length;
    const firstPayload = chunks === 0 ? [] : null;
    while (remaining) {
      const part = await cursor.bytes(Math.min(MAX_READ, remaining));
      if (!part) return { state: 'partial', length: cursor.relative, reason: 'PNG 청크 데이터가 잘렸어요.' };
      crc = crc32Update(crc, part);
      if (firstPayload) firstPayload.push(part);
      remaining -= part.length;
    }
    const expected = await cursor.bytes(4);
    if (!expected) return { state: 'partial', length: cursor.relative, reason: 'PNG CRC가 잘렸어요.' };
    if (crc32Finish(crc) !== expected.readUInt32BE(0)) {
      return { state: chunks ? 'partial' : 'invalid', length: validatedEnd, reason: 'PNG CRC가 맞지 않아요.' };
    }
    if (chunks === 0) {
      const ihdr = Buffer.concat(firstPayload, length);
      if (ihdr.readUInt32BE(0) === 0 || ihdr.readUInt32BE(4) === 0 || ![1, 2, 4, 8, 16].includes(ihdr[8])) {
        return { state: 'invalid', reason: 'PNG 이미지 크기 또는 비트 깊이가 올바르지 않아요.' };
      }
    }
    if (type.toString('ascii') === 'IDAT') sawImageData = true;
    chunks++;
    validatedEnd = cursor.relative;
    if (type.toString('ascii') === 'IEND') {
      if (length !== 0 || !sawImageData) return { state: 'partial', length: validatedEnd, reason: 'PNG 이미지 데이터 또는 IEND 구조가 올바르지 않아요.' };
      return { state: 'complete', length: validatedEnd, extension: 'png', kind: 'photo', validation: 'png-chunks-crc' };
    }
  }
  return { state: 'partial', length: validatedEnd, reason: 'PNG IEND를 찾지 못했어요.' };
}

function standaloneJpegMarker(marker) {
  return marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7);
}

async function validateJpeg(provider, offset, limit, options) {
  const cursor = new SourceCursor(provider, offset, limit, options);
  const start = await cursor.bytes(2);
  if (!start || start[0] !== 0xff || start[1] !== 0xd8) return { state: 'invalid' };
  let sawFrame = false;
  let sawScan = false;
  let marker = null;
  while (cursor.relative < options.maxFileBytes) {
    if (marker === null) {
      let prefix;
      do { prefix = await cursor.byte(); } while (prefix !== null && prefix !== 0xff);
      if (prefix === null) return sawScan ? { state: 'partial', length: cursor.relative, reason: 'JPEG 끝 표시가 없어요.' } : { state: 'invalid' };
      do { marker = await cursor.byte(); } while (marker === 0xff);
      if (marker === null) return sawScan ? { state: 'partial', length: cursor.relative, reason: 'JPEG 표시가 잘렸어요.' } : { state: 'invalid' };
    }
    if (marker === 0xd9) {
      if (!sawFrame || !sawScan) return { state: 'invalid', reason: 'JPEG 프레임 또는 스캔 구조가 없어요.' };
      return { state: 'complete', length: cursor.relative, extension: 'jpg', kind: 'photo', validation: 'jpeg-markers-eoi' };
    }
    if (standaloneJpegMarker(marker)) { marker = null; continue; }
    const sizeBytes = await cursor.bytes(2);
    if (!sizeBytes) return sawFrame ? { state: 'partial', length: cursor.relative, reason: 'JPEG 구간 길이가 잘렸어요.' } : { state: 'invalid' };
    const segmentLength = sizeBytes.readUInt16BE(0);
    if (segmentLength < 2 || cursor.relative + segmentLength - 2 > options.maxFileBytes) {
      return sawFrame ? { state: 'partial', length: cursor.relative, reason: 'JPEG 구간 길이가 올바르지 않아요.' } : { state: 'invalid' };
    }
    if (cursor.position + segmentLength - 2 > limit) return sawFrame ? { state: 'partial', length: limit - offset, reason: 'JPEG 구간 데이터가 잘렸어요.' } : { state: 'invalid' };
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) sawFrame = true;
    const isScan = marker === 0xda;
    await cursor.skip(segmentLength - 2);
    marker = null;
    if (!isScan) continue;
    sawScan = true;
    while (cursor.relative < options.maxFileBytes) {
      const byte = await cursor.byte();
      if (byte === null) return { state: 'partial', length: cursor.relative, reason: 'JPEG 끝 표시가 없어요.' };
      if (byte !== 0xff) continue;
      let next;
      do { next = await cursor.byte(); } while (next === 0xff);
      if (next === null) return { state: 'partial', length: cursor.relative, reason: 'JPEG 끝 표시가 잘렸어요.' };
      if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) continue;
      marker = next;
      break;
    }
  }
  return { state: 'limit', reason: 'JPEG가 파일별 크기 제한 안에서 끝나지 않았어요.' };
}

function containsAscii(buffer, expression) {
  return expression.test(buffer.toString('latin1'));
}

async function validatePdf(provider, offset, limit, options) {
  const headerLength = Math.min(16, limit - offset);
  const header = await readExact(provider, offset, headerLength, options);
  if (!/^%PDF-\d\.\d(?:\r?\n|\r)/.test(header.toString('latin1'))) return { state: 'invalid', reason: 'PDF 머리말이 올바르지 않아요.' };
  const linearized = await linearizedPdfExtent(
    (relative, length) => readExact(provider, offset + relative, length, options), limit - offset, options.maxFileBytes);
  if (linearized) return linearized;
  let position = offset;
  let tail = Buffer.alloc(0);
  let sawObject = false;
  let sawEndObject = false;
  const scanEnd = Math.min(limit, offset + options.maxFileBytes);
  while (position < scanEnd) {
    const length = Math.min(MAX_READ, scanEnd - position);
    const chunk = await readExact(provider, position, length, options);
    const combined = tail.length ? Buffer.concat([tail, chunk]) : chunk;
    sawObject ||= containsAscii(combined, /(?:^|[\r\n\s])\d+\s+\d+\s+obj(?:[\r\n\s<])/);
    sawEndObject ||= combined.includes(Buffer.from('endobj', 'ascii'));
    let searchAt = 0;
    while (true) {
      const found = combined.indexOf(Buffer.from('%%EOF', 'ascii'), searchAt);
      if (found < 0) break;
      const absoluteEnd = position - tail.length + found + 5;
      if (sawObject && sawEndObject) {
        let extent = absoluteEnd - offset;
        const trailingLength = Math.min(2, limit - absoluteEnd);
        if (trailingLength) {
          const trailing = await readExact(provider, absoluteEnd, trailingLength, options);
          if (trailing[0] === 0x0d) extent++;
          if (trailing[0] === 0x0a || (trailing[0] === 0x0d && trailing[1] === 0x0a)) extent++;
        }
        return { state: 'complete', length: extent, extension: 'pdf', kind: 'document', validation: 'pdf-header-object-eof' };
      }
      searchAt = found + 1;
    }
    tail = combined.subarray(Math.max(0, combined.length - 64));
    position += chunk.length;
  }
  if (sawObject && sawEndObject) {
    return scanEnd === limit
      ? { state: 'partial', length: scanEnd - offset, reason: 'PDF 끝 표시를 찾지 못했어요.' }
      : { state: 'limit', reason: 'PDF가 파일별 크기 제한 안에서 끝나지 않았어요.' };
  }
  return { state: 'invalid', reason: 'PDF 기본 객체 구조를 확인하지 못했어요.' };
}

function decodeZipName(buffer, utf8) {
  return buffer.toString(utf8 ? 'utf8' : 'latin1').replace(/\\/g, '/');
}

async function validateCentralDirectory(provider, archiveOffset, eocdOffset, eocd, options) {
  const disk = eocd.readUInt16LE(4);
  const centralDisk = eocd.readUInt16LE(6);
  const diskEntries = eocd.readUInt16LE(8);
  const totalEntries = eocd.readUInt16LE(10);
  const centralSize = eocd.readUInt32LE(12);
  const centralOffset = eocd.readUInt32LE(16);
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== totalEntries) return { state: 'unsupported', reason: '여러 디스크로 나뉜 ZIP은 지원하지 않아요.' };
  if (totalEntries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) return { state: 'unsupported', reason: 'ZIP64 구조는 이 단계에서 지원하지 않아요.' };
  if (centralOffset + centralSize !== eocdOffset - archiveOffset || centralSize > options.maxFileBytes) return { state: 'invalid', reason: 'ZIP 중앙 디렉터리 범위가 맞지 않아요.' };
  const central = await readExact(provider, archiveOffset + centralOffset, centralSize, options);
  const names = [];
  const localRanges = [];
  let cursor = 0;
  let expandedBytes = 0;
  let compressedBytes = 0;
  for (let index = 0; index < totalEntries; index++) {
    if (cursor + 46 > central.length || central.readUInt32LE(cursor) !== 0x02014b50) return { state: 'invalid', reason: 'ZIP 중앙 디렉터리 항목이 올바르지 않아요.' };
    const flags = central.readUInt16LE(cursor + 8);
    const method = central.readUInt16LE(cursor + 10);
    const compressed = central.readUInt32LE(cursor + 20);
    const expanded = central.readUInt32LE(cursor + 24);
    const nameLength = central.readUInt16LE(cursor + 28);
    const extraLength = central.readUInt16LE(cursor + 30);
    const commentLength = central.readUInt16LE(cursor + 32);
    const localOffset = central.readUInt32LE(cursor + 42);
    const entryLength = 46 + nameLength + extraLength + commentLength;
    if (cursor + entryLength > central.length || localOffset >= centralOffset) return { state: 'invalid', reason: 'ZIP 항목 범위가 올바르지 않아요.' };
    if (flags & 0x01) return { state: 'unsupported', reason: '암호화된 ZIP 내용은 자동 검사하지 않아요.' };
    if (![0, 8].includes(method)) return { state: 'unsupported', reason: '현재 구조 검사에서 지원하지 않는 ZIP 압축 방식이에요.' };
    const localHeader = await readExact(provider, archiveOffset + localOffset, 30, options);
    if (localHeader.readUInt32LE(0) !== 0x04034b50 || localHeader.readUInt16LE(8) !== method) {
      return { state: 'invalid', reason: 'ZIP 로컬 항목 위치가 올바르지 않아요.' };
    }
    const localNameLength = localHeader.readUInt16LE(26);
    const localExtraLength = localHeader.readUInt16LE(28);
    const localEnd = localOffset + 30 + localNameLength + localExtraLength + compressed;
    if (localEnd > centralOffset) return { state: 'invalid', reason: 'ZIP 로컬 항목 데이터가 중앙 디렉터리와 겹쳐요.' };
    for (const range of localRanges) {
      if (localOffset < range.end && range.start < localEnd) return { state: 'invalid', reason: 'ZIP 로컬 항목 데이터가 서로 겹쳐요.' };
    }
    localRanges.push({ start: localOffset, end: localEnd });
    const centralName = central.subarray(cursor + 46, cursor + 46 + nameLength);
    if (localNameLength !== nameLength) return { state: 'invalid', reason: 'ZIP 로컬 파일 이름 길이가 맞지 않아요.' };
    const localName = await readExact(provider, archiveOffset + localOffset + 30, localNameLength, options);
    if (!localName.equals(centralName)) return { state: 'invalid', reason: 'ZIP 로컬 파일 이름이 중앙 디렉터리와 맞지 않아요.' };
    names.push(decodeZipName(centralName, Boolean(flags & 0x0800)));
    expandedBytes += expanded;
    compressedBytes += compressed;
    if (!Number.isSafeInteger(expandedBytes) || expandedBytes > Math.min(512 * 1024 * 1024, options.maxFileBytes * 16)
      || (compressedBytes > 0 && expandedBytes / compressedBytes > 1000)) {
      return { state: 'unsupported', reason: '압축 해제 크기가 안전한 검사 제한을 넘는 ZIP이에요.' };
    }
    cursor += entryLength;
  }
  if (cursor !== central.length) return { state: 'invalid', reason: 'ZIP 중앙 디렉터리 크기가 맞지 않아요.' };
  return { state: 'complete', names };
}

function classifyZip(names) {
  const normalized = new Set(names.map(name => name.normalize('NFC')));
  if (normalized.has('[Content_Types].xml') && normalized.has('word/document.xml')) return { extension: 'docx', kind: 'document', validation: 'zip-central-directory-docx' };
  if (normalized.has('[Content_Types].xml') && normalized.has('xl/workbook.xml')) return { extension: 'xlsx', kind: 'document', validation: 'zip-central-directory-xlsx' };
  if (normalized.has('[Content_Types].xml') && normalized.has('ppt/presentation.xml')) return { extension: 'pptx', kind: 'document', validation: 'zip-central-directory-pptx' };
  if (normalized.has('Contents/content.hpf') && (normalized.has('version.xml') || normalized.has('mimetype'))) return { extension: 'hwpx', kind: 'document', validation: 'zip-central-directory-hwpx' };
  return { extension: 'zip', kind: 'other', validation: 'zip-central-directory' };
}

async function validateZip(provider, offset, limit, options) {
  const local = await readExact(provider, offset, Math.min(30, limit - offset), options);
  if (local.length < 30 || local.readUInt32LE(0) !== 0x04034b50) return { state: 'invalid' };
  const versionNeeded = local.readUInt16LE(4);
  const flags = local.readUInt16LE(6);
  const method = local.readUInt16LE(8);
  const firstNameLength = local.readUInt16LE(26);
  const firstExtraLength = local.readUInt16LE(28);
  if (versionNeeded < 10 || versionNeeded > 63 || ![0, 8].includes(method) || (flags & 0x01) || firstNameLength === 0) {
    return { state: 'invalid', reason: 'ZIP 첫 항목 구조가 올바르지 않아요.' };
  }
  if (30 + firstNameLength + firstExtraLength > options.maxFileBytes || offset + 30 + firstNameLength + firstExtraLength > limit) {
    return { state: 'partial', length: Math.min(limit - offset, options.maxFileBytes), reason: 'ZIP 첫 항목 헤더가 잘렸어요.' };
  }
  let position = offset;
  let tail = Buffer.alloc(0);
  const scanEnd = Math.min(limit, offset + options.maxFileBytes);
  while (position < scanEnd) {
    const length = Math.min(MAX_READ, scanEnd - position);
    const chunk = await readExact(provider, position, length, options);
    const combined = tail.length ? Buffer.concat([tail, chunk]) : chunk;
    let searchAt = 0;
    while (true) {
      const found = combined.indexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]), searchAt);
      if (found < 0) break;
      const absolute = position - tail.length + found;
      if (absolute + 22 <= limit) {
        const eocd = await readExact(provider, absolute, 22, options);
        const commentLength = eocd.readUInt16LE(20);
        const end = absolute + 22 + commentLength;
        if (end <= limit && end - offset <= options.maxFileBytes) {
          const central = await validateCentralDirectory(provider, offset, absolute, eocd, options);
          if (central.state === 'complete') {
            const classification = classifyZip(central.names);
            return { state: 'complete', length: end - offset, ...classification, entryNames: central.names };
          }
          if (central.state === 'unsupported') return central;
        }
      }
      searchAt = found + 1;
    }
    tail = combined.subarray(Math.max(0, combined.length - 21));
    position += chunk.length;
  }
  return scanEnd === limit
    ? { state: 'partial', length: scanEnd - offset, reason: 'ZIP 중앙 디렉터리와 끝 표시를 확인하지 못했어요.' }
    : { state: 'limit', reason: 'ZIP가 파일별 크기 제한 안에서 끝나지 않았어요.' };
}

async function validateFormat(format, provider, offset, rangeEnd, options) {
  const limit = Math.min(rangeEnd, offset + options.maxFileBytes);
  if (format === 'hwp') {
    return validateHwpExtent((relative, length) => {
      requireValue(Number.isSafeInteger(relative) && relative >= 0 && Number.isSafeInteger(length) && length >= 0
        && relative <= limit - offset && length <= limit - offset - relative,
      'SOURCE_BOUNDS', 'HWP 구조가 선택한 검색 범위를 벗어났어요.');
      return readExact(provider, offset + relative, length, options);
    }, rangeEnd - offset, options.maxFileBytes);
  }
  const result = format === 'png' ? await validatePng(provider, offset, limit, options)
    : format === 'jpeg' ? await validateJpeg(provider, offset, limit, options)
      : format === 'pdf' ? await validatePdf(provider, offset, limit, options)
        : await validateZip(provider, offset, limit, options);
  if (result.state === 'partial' && limit < rangeEnd && result.length >= options.maxFileBytes) {
    return { state: 'limit', reason: `${format.toUpperCase()}가 파일별 크기 제한 안에서 끝나지 않았어요.` };
  }
  return result;
}

async function writeArtifact(provider, outputRoot, offset, validation, options) {
  const workingDirectory = await mkdtemp(path.join(outputRoot, '.carving-writing-'));
  requireValue(containedBy(outputRoot, workingDirectory), 'INVALID_OUTPUT', '안전한 임시 출력 폴더를 만들지 못했어요.');
  let currentDirectory = workingDirectory;
  let partialPath = path.join(currentDirectory, '.carving-writing.partial');
  let outputHandle;
  let written = 0;
  let actualWritten = 0;
  const artifactHash = createHash('sha256');
  try {
    outputHandle = await open(partialPath, 'wx', 0o600);
    while (written < validation.length) {
      await checkpoint(options.control, options.signal, { partialPath, bytesWritten: written });
      const length = Math.min(MAX_READ, validation.length - written);
      const chunk = await readExact(provider, offset + written, length, options);
      let chunkOffset = 0;
      while (chunkOffset < chunk.length) {
        cancelled(options.signal, { partialPath, bytesWritten: written + chunkOffset });
        const result = await outputHandle.write(chunk, chunkOffset, chunk.length - chunkOffset, written + chunkOffset);
        requireValue(result.bytesWritten > 0, 'WRITE_FAILED', '추출 파일을 저장하지 못했어요.');
        chunkOffset += result.bytesWritten;
        actualWritten += result.bytesWritten;
        options.recordOutputBytes?.(result.bytesWritten);
      }
      written += chunk.length;
      artifactHash.update(chunk);
      if (typeof options.onProgress === 'function') options.onProgress({ phase: 'extract', offset, bytesWritten: written, bytesTotal: validation.length, partialPath });
      await new Promise(resolve => setImmediate(resolve));
    }
    await outputHandle.sync();
    await outputHandle.close();
    outputHandle = null;
    if (validation.extension === 'hwp') {
      // Recheck the bytes actually saved before publishing a readable candidate.
      // Matching container metadata is not an original-body hash or an app-open check.
      const saved = await open(partialPath, 'r');
      try {
        const verified = await validateHwpExtent(async (relative, length) => {
          await checkpoint(options.control, options.signal);
          requireValue(Number.isSafeInteger(relative) && relative >= 0 && Number.isSafeInteger(length) && length >= 0
            && length <= MAX_READ && relative <= written && length <= written - relative,
          'OUTPUT_VERIFICATION_FAILED', '저장한 HWP의 구조 범위가 맞지 않아요.');
          const bytes = Buffer.alloc(length);
          let received = 0;
          while (received < length) {
            await checkpoint(options.control, options.signal);
            const result = await saved.read(bytes, received, length - received, relative + received);
            requireValue(result.bytesRead > 0, 'OUTPUT_VERIFICATION_FAILED', '저장한 HWP를 끝까지 다시 읽지 못했어요.');
            received += result.bytesRead;
          }
          return bytes;
        }, written, options.maxFileBytes);
        requireValue(verified.state === 'complete' && verified.length === written
          && typeof validation.structuralSha256 === 'string'
          && verified.structuralSha256 === validation.structuralSha256,
        'OUTPUT_VERIFICATION_FAILED', '추출하는 동안 HWP 저장 구조가 달라졌거나 손상됐어요.');
      } finally { await saved.close(); }
    }
    await assertSource(provider);
    let publishedDirectory;
    for (let attempt = 0; attempt < 3; attempt++) {
      const proposed = path.join(outputRoot, randomUUID());
      try {
        await rename(currentDirectory, proposed);
        publishedDirectory = proposed;
        break;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
      }
    }
    requireValue(publishedDirectory, 'WRITE_FAILED', '추출 파일의 새 출력 폴더를 만들지 못했어요.');
    currentDirectory = publishedDirectory;
    partialPath = path.join(currentDirectory, '.carving-writing.partial');
    const generatedName = `carved-${offset.toString(16).padStart(12, '0')}.${validation.extension}${validation.state === 'partial' ? '.partial' : ''}`;
    const savedPath = path.join(currentDirectory, generatedName);
    await rename(partialPath, savedPath);
    return { path: savedPath, size: written, sha256: artifactHash.digest('hex'), identity: (await existingCandidate(savedPath, outputRoot)).identity };
  } catch (error) {
    try { await outputHandle?.close(); } catch {}
    if (error instanceof CarvingError) {
      error.details = { ...(error.details ?? {}), partialPath, bytesWritten: actualWritten };
      throw error;
    }
    throw new CarvingError('WRITE_FAILED', '추출 파일을 저장하지 못했어요.', { partialPath, bytesWritten: actualWritten, cause: error?.code });
  }
}

function findHits(buffer, baseOffset, rangeStart, rangeEnd) {
  const hits = [];
  for (const signature of SIGNATURES) {
    let position = 0;
    while (position <= buffer.length - signature.bytes.length) {
      const found = buffer.indexOf(signature.bytes, position);
      if (found < 0) break;
      const offset = baseOffset + found;
      if (offset >= rangeStart && offset + signature.bytes.length <= rangeEnd) {
        requireValue(hits.length < 16384, 'SIGNATURE_LIMIT', '한 구간에 파일 시작 표식이 지나치게 많아 검색을 중단했어요.');
        hits.push({ offset, format: signature.format });
      }
      position = found + 1;
    }
  }
  return hits.sort((left, right) => left.offset - right.offset || left.format.localeCompare(right.format));
}

function candidateFromArtifact(hit, validation, artifact, outputRoot) {
  return {
    id: `carved:${hit.format}:${hit.offset.toString(16).padStart(16, '0')}`,
    source: 'carved',
    path: artifact.path,
    identity: artifact.identity,
    rootPath: outputRoot,
    name: path.basename(artifact.path),
    nameIsGenerated: true,
    size: artifact.size,
    modifiedAt: null,
    deletedAt: null,
    status: validation.state === 'complete' ? 'readable' : 'partial',
    kind: validation.kind,
    format: validation.extension,
    offset: hit.offset,
    score: 0,
    ...(hit.format === 'hwp' ? {
      originalIdentityVerified: false, applicationOpenVerified: false, originalLengthKnown: false,
      bodyAssociation: 'not-asserted',
      structuralValidation: {
        scope: validation.validationScope, sha256: validation.structuralSha256,
        savedOutputRechecked: true, fullDocumentValidated: false,
      },
    } : {}),
    reasons: validation.state === 'complete'
      ? [`signature:${hit.format}`, `structure:${validation.validation}`, 'name:generated',
        ...(hit.format === 'hwp' ? ['HWP 저장 구조를 확인했어요. 원래 이름·파일 끝·문서 내용과 정상 열림은 별도 확인이 필요해요.'] : [])]
      : [`signature:${hit.format}`, 'validation:truncated', 'name:generated']
  };
}

export async function carveFiles(provider, outputDirectory, {
  signal, control, onProgress, onCandidate, maxCandidates = MAX_CANDIDATES,
  ranges, startOffset = 0, maxFileBytes = DEFAULT_MAX_FILE_BYTES,
  maxScanBytes, maxOutputBytes, resumeFrom, resumeRoots = [], onCheckpoint
} = {}) {
  cancelled(signal);
  const size = sourceSize(provider);
  checkedInteger(maxCandidates, 1, MAX_CANDIDATES, '후보 수 제한');
  checkedInteger(maxFileBytes, 1, DEFAULT_MAX_FILE_BYTES, '파일 크기 제한');
  const scanBudget = maxScanBytes === undefined
    ? Number.MAX_SAFE_INTEGER
    : checkedInteger(maxScanBytes, 1, Number.MAX_SAFE_INTEGER, '검색 바이트 제한');
  const outputBudget = maxOutputBytes === undefined
    ? Number.MAX_SAFE_INTEGER
    : checkedInteger(maxOutputBytes, 1, Number.MAX_SAFE_INTEGER, '출력 바이트 제한');
  requireValue(typeof outputDirectory === 'string' && outputDirectory.trim(), 'INVALID_OUTPUT', '추출 파일을 저장할 폴더가 필요해요.');
  const scanRanges = normalizeRanges(ranges, size, Number(startOffset));
  const outputRoot = path.resolve(outputDirectory);
  await mkdir(outputRoot, { recursive: true });
  const outputStats = await lstat(outputRoot);
  requireValue(outputStats.isDirectory() && !outputStats.isSymbolicLink(), 'INVALID_OUTPUT', '출력 위치는 일반 폴더여야 해요.');
  const canonicalOutput = await realpath(outputRoot);
  await assertSource(provider);

  const selection = { ranges: scanRanges, maxFileBytes };
  const restored = resumeFrom ? await restoreCarvingCheckpoint(resumeFrom, {
    provider, selection, resumeRoots, maxCandidates, signal, control
  }) : null;
  const artifacts = restored ? structuredClone(restored.candidates) : [];
  const candidates = artifacts.map(entry => entry.candidate);
  const warnings = restored ? structuredClone(restored.warnings).filter(warning => !['SCAN_BYTE_LIMIT', 'OUTPUT_BYTE_LIMIT'].includes(warning.code)) : [];
  const seenHits = new Set();
  const covered = restored?.covered ?? [];
  const scanScope = ranges === undefined ? 'whole-source' : 'selected-ranges';
  const coverage = createCarvingCoverage({ scanScope, selectedRanges: scanRanges, restoredState: restored?.coverageState });
  const counters = {
    bytesRead: 0,
    bytesTotal: scanRanges.reduce((sum, range) => sum + range.length, 0),
    scanReadBytes: 0,
    extractionBytesRead: restored?.counters.extractionBytesRead ?? 0,
    outputBytesWritten: 0,
    candidatesFound: candidates.length,
    signaturesFound: restored?.counters.signaturesFound ?? 0,
    readErrors: restored?.counters.readErrors ?? 0,
    warningCount: restored?.counters.warningCount ?? 0,
    scanScope
  };
  let truncated = false;
  let incomplete = restored?.incomplete ?? false;
  let stopReason = null;
  let scanBegun = false;
  let cursor = restored?.cursor ?? scanRanges[0]?.offset ?? size;
  const priorScanBytes = coverage.scanReadBytes;
  const priorOutputBytes = coverage.outputBytesWritten;
  let checkpointAt = 0;

  function saveCheckpoint(force = false) {
    const identity = carvingSourceIdentity(provider);
    if (!identity || typeof onCheckpoint !== 'function' || (!force && Date.now() - checkpointAt < 5000)) return;
    const value = { version: 1, kind: 'carving', sourceIdentity: identity, sourceSize: size,
      selection, cursor, coverageState: coverage.exportState(), counters: statsSnapshot(),
      candidates: artifacts, covered, warnings, incomplete };
    requireValue(Buffer.byteLength(JSON.stringify(value)) <= CHECKPOINT_MAX_BYTES, 'CHECKPOINT_LIMIT',
      '이어 검사 기록이 저장 한도를 넘었어요. 이전 저장 지점과 추출 파일은 보존됩니다.');
    onCheckpoint(structuredClone(value));
    checkpointAt = Date.now();
  }

  function statsSnapshot() {
    return {
      ...counters,
      bytesRead: coverage.scanReadBytes,
      scanReadBytes: coverage.scanReadBytes,
      outputBytesWritten: coverage.outputBytesWritten
    };
  }

  function coverageSnapshot(reason = stopReason, complete = false) {
    return coverage.snapshot({ stopReason: reason, complete });
  }

  function emitProgress(event, reason = null, complete = false) {
    if (typeof onProgress === 'function') onProgress({ ...event, coverage: coverageSnapshot(reason, complete) });
  }

  function warn(code, offset, message, details = {}, force = false) {
    counters.warningCount++;
    if (code === 'READ_FAILED') counters.readErrors++;
    const warning = { code, offset, message, ...details };
    if (warnings.length < MAX_WARNINGS) warnings.push(warning);
    else if (force) warnings[MAX_WARNINGS - 1] = warning;
  }

  function errorWithCoverage(error) {
    const reason = error?.code === 'CANCELLED' ? 'cancelled'
      : error?.code === 'SOURCE_CHANGED' ? 'source-changed' : 'error';
    const details = {
      ...(error?.details && typeof error.details === 'object' ? error.details : {}),
      coverage: coverageSnapshot(reason, false),
      stats: statsSnapshot()
    };
    if (error && typeof error === 'object') {
      error.details = details;
      return error;
    }
    return new CarvingError('CARVING_FAILED', '파일 조각 검색을 마치지 못했어요.', details);
  }

  try {
    scanBegun = true;
    for (const candidate of candidates) onCandidate?.(structuredClone(candidate));
    saveCheckpoint(true);
    scan: for (const range of scanRanges) {
      const rangeEnd = range.offset + range.length;
      if (rangeEnd <= cursor) continue;
      let position = Math.max(range.offset, cursor);
      cursor = position;
      let tail = Buffer.alloc(0);
      while (position < rangeEnd) {
        await checkpoint(control, signal);
        if (candidates.length >= maxCandidates) {
          truncated = true;
          stopReason = 'candidate-limit';
          break scan;
        }
        const remainingScanBytes = scanBudget - (coverage.scanReadBytes - priorScanBytes);
        if (remainingScanBytes === 0) {
          stopReason = 'scan-byte-limit';
          warn('SCAN_BYTE_LIMIT', position, '설정한 검색 바이트 한도에 도달했어요.', { maxScanBytes: scanBudget }, true);
          break scan;
        }
        const length = Math.min(MAX_READ, rangeEnd - position, remainingScanBytes);
        let chunk;
        try {
          chunk = await readExact(provider, position, length, { signal, control, counters, coverage, phase: 'scan' });
        } catch (error) {
          if (error?.code === 'CANCELLED') throw error;
          incomplete = true;
          coverage.markReadError(position, length);
          warn('READ_FAILED', position, error.message, { length, cause: error?.details?.cause ?? null });
          position += length;
          cursor = position;
          tail = Buffer.alloc(0);
          saveCheckpoint();
          continue;
        }
        const chunkEnd = position + chunk.length;
        const combined = tail.length ? Buffer.concat([tail, chunk]) : chunk;
        const combinedStart = position - tail.length;
        const safeEnd = chunkEnd === rangeEnd ? chunkEnd : Math.max(combinedStart, chunkEnd - SIGNATURE_OVERLAP);
        let handledThrough = combinedStart;
        const markHandledTo = target => {
          const end = Math.min(target, safeEnd);
          if (end > handledThrough) {
            coverage.markExamined(handledThrough, end - handledThrough);
            handledThrough = end;
            cursor = Math.max(cursor, end);
          }
        };
        const hits = findHits(combined, combinedStart, range.offset, rangeEnd);
        for (const hit of hits) {
          // Defer starts in the overlap until the next chunk owns them. A saved
          // cursor can then restart without losing or duplicating such a file.
          if (hit.offset >= safeEnd) continue;
          markHandledTo(hit.offset);
          const hitKey = `${hit.format}:${hit.offset}`;
          const covering = covered.find(area => hit.offset >= area.start && hit.offset < area.end);
          if (seenHits.has(hitKey) || covering) {
            markHandledTo(hit.offset + 1);
            continue;
          }
          seenHits.add(hitKey);
          counters.signaturesFound++;
          let validation;
          try {
            validation = await validateFormat(hit.format, provider, hit.offset, rangeEnd, {
              signal, control, counters, phase: 'extract', maxFileBytes
            });
          } catch (error) {
            if (error?.code === 'CANCELLED') throw error;
            incomplete = true;
            warn(error?.code ?? 'VALIDATION_FAILED', hit.offset, error?.message ?? '파일 구조를 확인하지 못했어요.');
            markHandledTo(hit.offset + 1);
            continue;
          }
          if (validation.state === 'invalid') {
            markHandledTo(hit.offset + 1);
            continue;
          }
          if (validation.state === 'unsupported' || validation.state === 'limit') {
            incomplete = true;
            warn(validation.state === 'limit' ? 'FILE_LIMIT' : 'UNSUPPORTED_STRUCTURE', hit.offset, validation.reason);
            markHandledTo(hit.offset + 1);
            continue;
          }
          if (!Number.isSafeInteger(validation.length) || validation.length <= 0 || validation.length > maxFileBytes
            || hit.offset + validation.length > rangeEnd) {
            incomplete = true;
            warn('INVALID_EXTENT', hit.offset, '검증된 파일 범위가 안전한 제한을 벗어났어요.');
            markHandledTo(hit.offset + 1);
            continue;
          }
          if (validation.state === 'partial') {
            incomplete = true;
            validation.extension = hit.format === 'jpeg' ? 'jpg' : hit.format;
            validation.kind = hit.format === 'png' || hit.format === 'jpeg' ? 'photo' : hit.format === 'pdf' ? 'document' : 'other';
            warn('TRUNCATED_FILE', hit.offset, validation.reason, { length: validation.length });
          }
          const remainingOutputBytes = outputBudget - (coverage.outputBytesWritten - priorOutputBytes);
          if (validation.length > remainingOutputBytes) {
            stopReason = 'output-byte-limit';
            warn('OUTPUT_BYTE_LIMIT', hit.offset, '설정한 출력 바이트 한도로 이 후보를 저장할 수 없어요.', {
              maxOutputBytes: outputBudget, candidateBytes: validation.length, remainingOutputBytes
            }, true);
            break scan;
          }
          let artifact;
          try {
            artifact = await writeArtifact(provider, canonicalOutput, hit.offset, validation, {
              signal, control,
              onProgress: event => emitProgress({ ...event, candidatesFound: candidates.length }),
              counters, phase: 'extract', maxFileBytes,
              recordOutputBytes: bytes => {
                coverage.recordOutputWrite(bytes);
                counters.outputBytesWritten = coverage.outputBytesWritten;
              }
            });
          } catch (error) {
            if (error?.code === 'CANCELLED' || error?.code === 'SOURCE_CHANGED') throw error;
            incomplete = true;
            warn(error?.code ?? 'WRITE_FAILED', hit.offset, error?.message ?? '추출 파일을 저장하지 못했어요.', { partialPath: error?.details?.partialPath ?? null });
            markHandledTo(hit.offset + 1);
            continue;
          }
          const candidate = candidateFromArtifact(hit, validation, artifact, canonicalOutput);
          candidates.push(candidate);
          artifacts.push({ candidate, sha256: artifact.sha256 });
          counters.candidatesFound++;
          const coveredEnd = hit.offset + validation.length;
          covered.push({ start: hit.offset, end: coveredEnd });
          markHandledTo(hit.offset + 1);
          if (typeof onCandidate === 'function') onCandidate({ ...candidate, reasons: [...candidate.reasons] });
          if (candidates.length >= maxCandidates) {
            truncated = true;
            stopReason = 'candidate-limit';
            break scan;
          }
        }
        position = chunkEnd;
        markHandledTo(safeEnd);
        seenHits.clear(); // Only the short overlap can repeat; published extents stay in bounded `covered`.
        tail = combined.subarray(Math.max(0, combined.length - SIGNATURE_OVERLAP));
        emitProgress({ phase: 'scan', bytesRead: coverage.scanReadBytes,
          bytesTotal: counters.bytesTotal, candidatesFound: candidates.length, currentOffset: position });
        saveCheckpoint();
        await new Promise(resolve => setImmediate(resolve));
      }
    }
    stopReason ??= 'end-of-ranges';
    await assertSource(provider);
    const complete = stopReason === 'end-of-ranges' && !truncated && !incomplete
      && coverageSnapshot().unexaminedBytes === 0 && coverageSnapshot().readErrorBytes === 0;
    const finalCoverage = coverageSnapshot(stopReason, complete);
    saveCheckpoint(true);
    emitProgress({ phase: 'complete', bytesRead: coverage.scanReadBytes,
      bytesTotal: counters.bytesTotal, candidatesFound: candidates.length, complete }, stopReason, complete);
    return { candidates, warnings, stats: statsSnapshot(), coverage: finalCoverage, complete, truncated };
  } catch (error) {
    // A source-change invalidates the run; retain the last prior verified checkpoint.
    // Cancellation checkpoints use the last fully handled signature position.
    if (error?.code !== 'SOURCE_CHANGED' && error?.code !== 'CHECKPOINT_LIMIT') saveCheckpoint(true);
    if (scanBegun) throw errorWithCoverage(error);
    throw error;
  }
}
