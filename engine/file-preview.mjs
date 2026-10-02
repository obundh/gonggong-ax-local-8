import { lstat, open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { inflateRawSync, inflateSync } from 'node:zlib';
import { previewHwp } from './hwp-preview.mjs';

const DEFAULT_MAX = 8 * 1024 * 1024;
const MAX_DIRECTORY = 512 * 1024;
const MAX_ENTRIES = 128;
const MAX_PIXELS = 16 * 1024 * 1024;
const OLE_SIGNATURE = Buffer.from('d0cf11e0a1b11ae1', 'hex');
const IMAGE_MIME = { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

class PreviewFailure extends Error {
  constructor(reason, message = reason) { super(message); this.reason = reason; }
}

function cancelled(signal) {
  if (signal?.aborted) {
    const error = new Error('미리보기를 취소했어요.');
    error.code = 'CANCELLED';
    throw error;
  }
}

function validation(format = 'unknown', checks = [], originalIdentityVerified = false) {
  return { format, checks, sourceIdentityVerified: originalIdentityVerified, originalIdentityVerified: false };
}

function unsupported(reason, format = 'unknown', checks = [], originalIdentityVerified = false) {
  return { type: 'unsupported', reason, validation: validation(format, checks, originalIdentityVerified) };
}

function safeNumber(value, reason = 'FILE_TOO_LARGE') {
  if (typeof value === 'bigint') {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new PreviewFailure(reason);
    return Number(value);
  }
  if (!Number.isSafeInteger(value) || value < 0) throw new PreviewFailure(reason);
  return value;
}

function sameIdentity(a, b) {
  return a && b && String(a.dev) === String(b.dev) && String(a.ino) === String(b.ino)
    && String(a.size) === String(b.size) && Number(a.mtimeMs) === Number(b.mtimeMs);
}

function expectedMatches(expected, actual) {
  if (!expected || typeof expected !== 'object') return false;
  return ['dev', 'ino', 'size', 'mtimeMs'].every((key) => expected[key] === undefined
    || String(expected[key]) === String(actual[key]));
}

function offlinePlaceholder(info) {
  // Node exposes fileAttributes on some Windows builds. FILE_ATTRIBUTE_OFFLINE is 0x1000.
  return info?.fileAttributes !== undefined && (Number(info.fileAttributes) & 0x1000) !== 0;
}

async function openStableRegularFile(filePath, expectedIdentity, signal) {
  cancelled(signal);
  let link;
  try { link = await lstat(filePath, { bigint: true }); }
  catch { throw new PreviewFailure('SOURCE_UNAVAILABLE'); }
  if (link.isSymbolicLink()) throw new PreviewFailure('SOURCE_SYMLINK_UNSUPPORTED');
  if (!link.isFile()) throw new PreviewFailure('SOURCE_NOT_REGULAR_FILE');
  if (offlinePlaceholder(link)) throw new PreviewFailure('CLOUD_FILE_NOT_DOWNLOADED');
  let resolved;
  try { resolved = await realpath(filePath); }
  catch { throw new PreviewFailure('SOURCE_UNAVAILABLE'); }
  const before = await lstat(resolved, { bigint: true });
  if (!before.isFile() || offlinePlaceholder(before)) throw new PreviewFailure(before.isFile() ? 'CLOUD_FILE_NOT_DOWNLOADED' : 'SOURCE_NOT_REGULAR_FILE');
  if (!sameIdentity(link, before)) throw new PreviewFailure('SOURCE_CHANGED');
  if (expectedIdentity && !expectedMatches(expectedIdentity, before)) throw new PreviewFailure('SOURCE_CHANGED');
  const handle = await open(resolved, 'r');
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameIdentity(before, opened)) throw new PreviewFailure('SOURCE_CHANGED');
    return { handle, resolved, identity: opened, expectedVerified: Boolean(expectedIdentity) };
  } catch (error) { await handle.close(); throw error; }
}

async function assertStillStable(source, signal) {
  cancelled(signal);
  const [opened, current] = await Promise.all([source.handle.stat({ bigint: true }), stat(source.resolved, { bigint: true })]);
  if (!sameIdentity(source.identity, opened) || !sameIdentity(source.identity, current)) throw new PreviewFailure('SOURCE_CHANGED');
}

async function readAt(handle, position, length, signal) {
  cancelled(signal);
  if (!Number.isSafeInteger(position) || !Number.isSafeInteger(length) || position < 0 || length < 0) throw new PreviewFailure('DAMAGED_FILE');
  const out = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    cancelled(signal);
    const { bytesRead } = await handle.read(out, offset, length - offset, position + offset);
    if (!bytesRead) break;
    offset += bytesRead;
  }
  return out.subarray(0, offset);
}

async function readBounded(source, maxBytes, signal) {
  const size = safeNumber(source.identity.size);
  return readAt(source.handle, 0, Math.min(size, maxBytes), signal);
}

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
  }
  return (value ^ 0xffffffff) >>> 0;
}

function decodeName(bytes, flags) {
  if (flags & 0x800) return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return [...bytes].map((byte) => byte < 128 ? String.fromCharCode(byte) : '?').join('');
}

async function parseZip(source, maxBytes, signal) {
  const size = safeNumber(source.identity.size);
  if (size < 22) throw new PreviewFailure('ZIP_TRUNCATED');
  const tail = await readAt(source.handle, Math.max(0, size - 65_557), Math.min(size, 65_557), signal);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0 || eocd + 22 > tail.length) throw new PreviewFailure('ZIP_TRUNCATED');
  const disk = tail.readUInt16LE(eocd + 4); const directoryDisk = tail.readUInt16LE(eocd + 6);
  const entriesOnDisk = tail.readUInt16LE(eocd + 8); const entries = tail.readUInt16LE(eocd + 10);
  const directorySize = tail.readUInt32LE(eocd + 12); const directoryOffset = tail.readUInt32LE(eocd + 16);
  if (disk || directoryDisk || entriesOnDisk !== entries) throw new PreviewFailure('ZIP_MULTIDISK_UNSUPPORTED');
  if (entries === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) throw new PreviewFailure('ZIP64_UNSUPPORTED');
  if (!entries) throw new PreviewFailure('ZIP_EMPTY');
  if (entries > MAX_ENTRIES || directorySize > MAX_DIRECTORY || directoryOffset > size || directorySize > size - directoryOffset) throw new PreviewFailure('ZIP_LIMIT_EXCEEDED');
  const directory = await readAt(source.handle, directoryOffset, directorySize, signal);
  if (directory.length !== directorySize) throw new PreviewFailure('ZIP_TRUNCATED');
  const out = new Map(); let offset = 0;
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > directory.length || directory.readUInt32LE(offset) !== 0x02014b50) throw new PreviewFailure('ZIP_DAMAGED');
    const flags = directory.readUInt16LE(offset + 8); const method = directory.readUInt16LE(offset + 10);
    const crc = directory.readUInt32LE(offset + 16); const compressedSize = directory.readUInt32LE(offset + 20); const uncompressedSize = directory.readUInt32LE(offset + 24);
    const nameLength = directory.readUInt16LE(offset + 28); const extraLength = directory.readUInt16LE(offset + 30); const commentLength = directory.readUInt16LE(offset + 32);
    const entryDisk = directory.readUInt16LE(offset + 34); const localOffset = directory.readUInt32LE(offset + 42);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (end > directory.length || entryDisk || (flags & 0x2041) !== 0) throw new PreviewFailure((flags & 0x2041) !== 0 ? 'ZIP_ENCRYPTED_UNSUPPORTED' : 'ZIP_DAMAGED');
    if (![0, 8].includes(method) || compressedSize > maxBytes || uncompressedSize > maxBytes || localOffset > size) throw new PreviewFailure(![0, 8].includes(method) ? 'ZIP_COMPRESSION_UNSUPPORTED' : 'ZIP_LIMIT_EXCEEDED');
    let name;
    try { name = decodeName(directory.subarray(offset + 46, offset + 46 + nameLength), flags); }
    catch { throw new PreviewFailure('ZIP_NAME_ENCODING_UNSUPPORTED'); }
    if (!name || name.includes('\u0000') || out.has(name)) throw new PreviewFailure('ZIP_DAMAGED');
    out.set(name, { name, flags, method, crc, compressedSize, uncompressedSize, localOffset });
    offset = end;
  }
  if (offset !== directory.length) throw new PreviewFailure('ZIP_DAMAGED');
  return out;
}

async function zipEntry(source, entry, maxBytes, signal) {
  const local = await readAt(source.handle, entry.localOffset, 30, signal);
  if (local.length !== 30 || local.readUInt32LE(0) !== 0x04034b50) throw new PreviewFailure('ZIP_DAMAGED');
  const flags = local.readUInt16LE(6); const method = local.readUInt16LE(8); const nameLength = local.readUInt16LE(26); const extraLength = local.readUInt16LE(28);
  if (flags !== entry.flags || method !== entry.method) throw new PreviewFailure('ZIP_DAMAGED');
  const start = entry.localOffset + 30 + nameLength + extraLength;
  const sourceSize = safeNumber(source.identity.size);
  if (start > sourceSize || entry.compressedSize > sourceSize - start) throw new PreviewFailure('ZIP_TRUNCATED');
  const compressed = await readAt(source.handle, start, entry.compressedSize, signal);
  if (compressed.length !== entry.compressedSize) throw new PreviewFailure('ZIP_TRUNCATED');
  let bytes;
  try { bytes = entry.method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: Math.min(maxBytes, entry.uncompressedSize) }); }
  catch { throw new PreviewFailure('ZIP_DEFLATE_FAILED'); }
  if (bytes.length !== entry.uncompressedSize || crc32(bytes) !== entry.crc) throw new PreviewFailure('ZIP_CRC_MISMATCH');
  return bytes;
}

function unescapeXml(text) {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, entity) => {
    if (entity === 'amp') return '&'; if (entity === 'lt') return '<'; if (entity === 'gt') return '>';
    if (entity === 'quot') return '"'; if (entity === 'apos') return "'";
    const code = entity.startsWith('#x') ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
    return Number.isInteger(code) && code >= 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '�';
  });
}

function xmlText(bytes, maxChars) {
  let raw;
  try { raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new PreviewFailure('XML_ENCODING_UNSUPPORTED'); }
  if (/<!DOCTYPE|<!ENTITY/i.test(raw)) throw new PreviewFailure('XML_EXTERNAL_ENTITY_UNSUPPORTED');
  const text = unescapeXml(raw.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<!\[CDATA\[([\s\S]*?)]]>/g, '$1').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
  return text.length > maxChars ? { text: text.slice(0, maxChars), truncated: true } : { text, truncated: false };
}

function documentProfile(extension, entries) {
  const names = [...entries.keys()];
  if (extension === '.docx') return names.includes('word/document.xml') ? { format: 'DOCX', parts: ['word/document.xml'] } : null;
  if (extension === '.xlsx') return names.includes('xl/workbook.xml') ? { format: 'XLSX', parts: names.filter((name) => name === 'xl/sharedStrings.xml' || /^xl\/worksheets\/[^/]+\.xml$/i.test(name)) } : null;
  if (extension === '.pptx') return names.includes('ppt/presentation.xml') ? { format: 'PPTX', parts: names.filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name)) } : null;
  if (extension === '.hwpx') return names.includes('[Content_Types].xml') ? { format: 'HWPX', parts: names.filter((name) => /^Contents\/section\d+\.xml$/i.test(name)) } : null;
  return null;
}

async function previewZipDocument(source, extension, maxBytes, signal, identityVerified) {
  const entries = await parseZip(source, maxBytes, signal); const profile = documentProfile(extension, entries);
  if (!profile) throw new PreviewFailure(extension === '.zip' ? 'ZIP_CONTAINER_UNSUPPORTED' : 'DOCUMENT_STRUCTURE_UNSUPPORTED');
  const macro = [...entries.keys()].some((name) => /(?:^|\/)vbaProject\.bin$/i.test(name));
  if (!profile.parts.length) throw new PreviewFailure('DOCUMENT_TEXT_NOT_FOUND');
  const chunks = []; const checks = ['ZIP central directory verified']; let truncated = false;
  for (const name of profile.parts.slice(0, 20)) {
    cancelled(signal);
    const entry = entries.get(name); const bytes = await zipEntry(source, entry, maxBytes, signal); const parsed = xmlText(bytes, Math.max(0, maxBytes - chunks.join('\n').length));
    if (parsed.text) chunks.push(parsed.text); truncated ||= parsed.truncated; checks.push(`CRC verified: ${name}`);
    if (chunks.join('\n').length >= maxBytes) { truncated = true; break; }
  }
  if (!chunks.length) throw new PreviewFailure('DOCUMENT_TEXT_NOT_FOUND');
  if (macro) checks.push('Macro reference present; never executed');
  checks.push('Known XML text only; layout, macros, links and embedded files are not previewed');
  return { type: 'text', text: chunks.join('\n').slice(0, maxBytes), truncated, validation: validation(profile.format, checks, identityVerified) };
}

function pngInfo(bytes) {
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) || bytes.readUInt32BE(8) !== 13 || bytes.subarray(12, 16).toString('ascii') !== 'IHDR' || !bytes.subarray(-12).equals(Buffer.from('0000000049454e44ae426082', 'hex'))) throw new PreviewFailure('IMAGE_HEADER_INVALID');
  return { format: 'png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function jpegInfo(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.subarray(-2).readUInt16BE(0) !== 0xffd9) throw new PreviewFailure('IMAGE_HEADER_INVALID');
  let offset = 2;
  while (offset + 9 <= bytes.length) {
    if (bytes[offset] !== 0xff) throw new PreviewFailure('IMAGE_HEADER_INVALID'); while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++]; if (marker === 0xd9 || marker === 0xda) break;
    if (offset + 2 > bytes.length) break; const length = bytes.readUInt16BE(offset); if (length < 2 || offset + length > bytes.length) throw new PreviewFailure('IMAGE_HEADER_INVALID');
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) return { format: 'jpeg', height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) };
    offset += length;
  }
  throw new PreviewFailure('IMAGE_DIMENSIONS_UNSUPPORTED');
}

function gifInfo(bytes) { if (bytes.length < 14 || !/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii')) || bytes.at(-1) !== 0x3b) throw new PreviewFailure('IMAGE_HEADER_INVALID'); return { format: 'gif', width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) }; }

function webpInfo(bytes) {
  if (bytes.length < 20 || bytes.subarray(0, 4).toString('ascii') !== 'RIFF' || bytes.subarray(8, 12).toString('ascii') !== 'WEBP' || bytes.readUInt32LE(4) + 8 !== bytes.length) throw new PreviewFailure('IMAGE_HEADER_INVALID');
  const tag = bytes.subarray(12, 16).toString('ascii'); if (tag === 'VP8X' && bytes.length >= 30) return { format: 'webp', width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
  if (tag === 'VP8 ' && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 1 && bytes[25] === 0x2a) return { format: 'webp', width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  if (tag === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) { const value = bytes.readUInt32LE(21); return { format: 'webp', width: 1 + (value & 0x3fff), height: 1 + ((value >>> 14) & 0x3fff) }; }
  throw new PreviewFailure('IMAGE_DIMENSIONS_UNSUPPORTED');
}

function imagePreview(bytes, identityVerified) {
  const info = bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ? pngInfo(bytes)
    : bytes[0] === 0xff && bytes[1] === 0xd8 ? jpegInfo(bytes)
      : bytes.subarray(0, 3).toString('ascii') === 'GIF' ? gifInfo(bytes) : webpInfo(bytes);
  if (!info.width || !info.height || info.width * info.height > MAX_PIXELS) throw new PreviewFailure('IMAGE_PIXEL_LIMIT');
  return { type: 'image', dataUrl: `data:${IMAGE_MIME[info.format]};base64,${bytes.toString('base64')}`, validation: validation(info.format.toUpperCase(), [`Header verified: ${info.width}×${info.height}`, 'Pixel count within 16 MP limit'], identityVerified) };
}

function decodeText(bytes, size, maxBytes, identityVerified) {
  let encoding = 'UTF-8'; let content = bytes; let decoder;
  try {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) { encoding = 'UTF-16LE'; content = bytes.subarray(2, bytes.length - ((bytes.length - 2) % 2)); decoder = new TextDecoder('utf-16le', { fatal: true }); }
    else if (bytes[0] === 0xfe && bytes[1] === 0xff) { encoding = 'UTF-16BE'; content = Buffer.from(bytes.subarray(2, bytes.length - ((bytes.length - 2) % 2))); for (let i = 0; i < content.length; i += 2) [content[i], content[i + 1]] = [content[i + 1], content[i]]; decoder = new TextDecoder('utf-16le', { fatal: true }); }
    else {
      if (bytes.includes(0)) throw new PreviewFailure('BINARY_CONTENT_UNSUPPORTED'); decoder = new TextDecoder('utf-8', { fatal: true });
      if (size > maxBytes) {
        let decoded;
        for (let trim = 0; trim <= 3 && trim < content.length; trim += 1) {
          try { decoded = decoder.decode(content.subarray(0, content.length - trim)); break; } catch { /* trim an incomplete UTF-8 tail only */ }
        }
        if (decoded === undefined) throw new PreviewFailure('TEXT_ENCODING_UNSUPPORTED');
        const text = decoded.replace(/^\uFEFF/, '');
        if (/^\s*<(?:!doctype\s+html|html\b|svg\b)/i.test(text)) throw new PreviewFailure('ACTIVE_CONTENT_UNSUPPORTED');
        return { type: 'text', text, truncated: true, validation: validation(`plain text (${encoding})`, ['Encoding verified; rendered as plain text'], identityVerified) };
      }
    }
    const text = decoder.decode(content).replace(/^\uFEFF/, '');
    if (/^\s*<(?:!doctype\s+html|html\b|svg\b)/i.test(text)) throw new PreviewFailure('ACTIVE_CONTENT_UNSUPPORTED');
    return { type: 'text', text, truncated: size > maxBytes, validation: validation(`plain text (${encoding})`, ['Encoding verified; rendered as plain text'], identityVerified) };
  } catch (error) { if (error instanceof PreviewFailure) throw error; throw new PreviewFailure('TEXT_ENCODING_UNSUPPORTED'); }
}

function pdfText(bytes, maxBytes, identityVerified) {
  const latin = bytes.toString('latin1'); const checks = [];
  if (!latin.startsWith('%PDF-') || !latin.includes('%%EOF')) throw new PreviewFailure('PDF_DAMAGED');
  checks.push('PDF header and EOF marker verified'); if (/\/Encrypt\b/.test(latin)) throw new PreviewFailure('PDF_ENCRYPTED');
  const content = []; const stream = /<<([\s\S]{0,4096}?)>>\s*stream\r?\n/g; let match, streams = 0, decodedTotal = 0;
  while ((match = stream.exec(latin))) {
    if (++streams > MAX_ENTRIES) throw new PreviewFailure('PDF_STREAM_LIMIT');
    const end = latin.indexOf('endstream', stream.lastIndex); if (end < 0) throw new PreviewFailure('PDF_DAMAGED');
    let body = bytes.subarray(stream.lastIndex, end); if (body.length > maxBytes) throw new PreviewFailure('PDF_STREAM_LIMIT');
    if (/\/FlateDecode\b/.test(match[1])) { try { body = inflateSync(body, { maxOutputLength: maxBytes }); } catch { throw new PreviewFailure('PDF_DEFLATE_FAILED'); } }
    else if (/\/Filter\b/.test(match[1])) { stream.lastIndex = end + 9; continue; }
    decodedTotal += body.length;
    if (decodedTotal > maxBytes) throw new PreviewFailure('PDF_TOTAL_LIMIT');
    const page = body.toString('latin1').match(/BT([\s\S]*?)ET/g) || [];
    for (const block of page) for (const item of block.matchAll(/\((?:\\.|[^\\)])*\)/g)) {
      const literal = item[0].slice(1, -1).replace(/\\([()\\])/g, '$1').replace(/\\n/g, '\n');
      try { content.push(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(literal, 'latin1'))); }
      catch { content.push(literal); }
    }
    stream.lastIndex = end + 9;
  }
  const text = content.join(' ').replace(/\s+/g, ' ').trim(); if (!text) throw new PreviewFailure('PDF_TEXT_NOT_FOUND');
  checks.push('Limited text operators extracted; no PDF viewer, script or external content was run');
  return { type: 'text', text: text.slice(0, maxBytes), truncated: text.length > maxBytes, validation: validation('PDF', checks, identityVerified) };
}

export async function previewFile(filePath, { maxBytes = DEFAULT_MAX, signal, expectedIdentity } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > DEFAULT_MAX) return unsupported('INVALID_PREVIEW_LIMIT');
  let source;
  try {
    source = await openStableRegularFile(filePath, expectedIdentity, signal);
    const size = safeNumber(source.identity.size); const extension = path.extname(source.resolved).toLowerCase();
    const header = await readBounded(source, Math.min(size, maxBytes), signal);
    if (header.subarray(0, 2).equals(Buffer.from('PK'))) {
      const result = await previewZipDocument(source, extension, maxBytes, signal, source.expectedVerified); await assertStillStable(source, signal); return result;
    }
    if (header.subarray(0, 8).equals(OLE_SIGNATURE) || ['.hwp', '.doc', '.xls', '.ppt'].includes(extension)) {
      if (extension === '.hwp' && size > maxBytes) throw new PreviewFailure('HWP_TOO_LARGE');
      if (!header.subarray(0, 8).equals(OLE_SIGNATURE) || header.length < 512 || header.readUInt16LE(28) !== 0xfffe) throw new PreviewFailure('OLE_DAMAGED');
      if (header.includes(Buffer.from('EncryptedPackage', 'ascii'))) throw new PreviewFailure('OLE_ENCRYPTED');
      if (extension === '.hwp' && size <= maxBytes) { const result = previewHwp(header); await assertStillStable(source, signal); return result; }
      throw new PreviewFailure('OLE_LEGACY_UNSUPPORTED');
    }
    let result;
    if (header.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) || (header[0] === 0xff && header[1] === 0xd8) || header.subarray(0, 3).toString('ascii') === 'GIF' || header.subarray(0, 4).toString('ascii') === 'RIFF') {
      if (size > maxBytes) throw new PreviewFailure('IMAGE_TOO_LARGE'); result = imagePreview(header, source.expectedVerified);
    } else if (header.subarray(0, 5).toString('ascii') === '%PDF-') {
      if (size > maxBytes) throw new PreviewFailure('PDF_TOO_LARGE');
      result = pdfText(header, maxBytes, source.expectedVerified);
    }
    else result = decodeText(header, size, maxBytes, source.expectedVerified);
    await assertStillStable(source, signal); return result;
  } catch (error) {
    if (error?.code === 'CANCELLED') throw error;
    return unsupported(error instanceof PreviewFailure ? error.reason : 'PREVIEW_IO_FAILED');
  } finally { await source?.handle?.close().catch(() => {}); }
}

export async function previewBytes(fileName, bytes, { maxBytes = DEFAULT_MAX, signal, sourceIdentityVerified = true } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > DEFAULT_MAX) return unsupported('INVALID_PREVIEW_LIMIT');
  if (!Buffer.isBuffer(bytes)) return unsupported('INVALID_PREVIEW_BYTES');
  if (bytes.length > maxBytes) return unsupported('FILE_TOO_LARGE');
  cancelled(signal);
  const source = {
    resolved: String(fileName ?? ''),
    identity: { size: BigInt(bytes.length) },
    expectedVerified: sourceIdentityVerified === true,
    handle: {
      async read(target, targetOffset, length, position) {
        cancelled(signal);
        const available = Math.max(0, Math.min(length, bytes.length - position));
        if (available) bytes.copy(target, targetOffset, position, position + available);
        return { bytesRead: available, buffer: target };
      }
    }
  };
  try {
    const size = bytes.length; const extension = path.extname(source.resolved).toLowerCase();
    const header = await readBounded(source, Math.min(size, maxBytes), signal);
    if (header.subarray(0, 2).equals(Buffer.from('PK'))) return previewZipDocument(source, extension, maxBytes, signal, source.expectedVerified);
    if (header.subarray(0, 8).equals(OLE_SIGNATURE) || ['.hwp', '.doc', '.xls', '.ppt'].includes(extension)) {
      if (extension === '.hwp' && size > maxBytes) throw new PreviewFailure('HWP_TOO_LARGE');
      if (!header.subarray(0, 8).equals(OLE_SIGNATURE) || header.length < 512 || header.readUInt16LE(28) !== 0xfffe) throw new PreviewFailure('OLE_DAMAGED');
      if (header.includes(Buffer.from('EncryptedPackage', 'ascii'))) throw new PreviewFailure('OLE_ENCRYPTED');
      if (extension === '.hwp') return previewHwp(header);
      throw new PreviewFailure('OLE_LEGACY_UNSUPPORTED');
    }
    if (header.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) || (header[0] === 0xff && header[1] === 0xd8) || header.subarray(0, 3).toString('ascii') === 'GIF' || header.subarray(0, 4).toString('ascii') === 'RIFF') {
      return imagePreview(header, source.expectedVerified);
    }
    if (header.subarray(0, 5).toString('ascii') === '%PDF-') return pdfText(header, maxBytes, source.expectedVerified);
    return decodeText(header, size, maxBytes, source.expectedVerified);
  } catch (error) {
    if (error?.code === 'CANCELLED') throw error;
    return unsupported(error instanceof PreviewFailure ? error.reason : 'PREVIEW_IO_FAILED');
  }
}
