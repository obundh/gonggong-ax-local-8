import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, realpath, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { inflateRawSync, inflateSync } from 'node:zlib';

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const MAX_XML_PARTS = 32;
const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');
const PNG_TYPES = new Set(['IHDR', 'IDAT', 'IEND']);

export class SalvageError extends Error {
  constructor(code, message = code, details = {}) {
    super(message);
    this.name = 'SalvageError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) { throw new SalvageError(code, message, details); }
function cancelled(signal) { if (signal?.aborted) fail('CANCELLED', '작업을 취소했어요.'); }
async function checkpoint(control, signal) { cancelled(signal); if (typeof control?.checkpoint === 'function') await control.checkpoint(); cancelled(signal); }
function emit(onProgress, value) { if (typeof onProgress === 'function') onProgress(Object.freeze({ ...value })); }

function checkedLimit(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > DEFAULT_MAX_BYTES) fail('INVALID_LIMIT', '복구 읽기 제한이 올바르지 않아요.');
  return value;
}

function sourceAllowed(sourceKind) {
  if (!['user-selected', 'owned-carved'].includes(sourceKind)) fail('SOURCE_NOT_AUTHORIZED', '사용자가 선택했거나 이 앱이 소유한 조각 파일만 처리할 수 있어요.');
}

function offlinePlaceholder(info) { return info?.fileAttributes !== undefined && (Number(info.fileAttributes) & 0x1000) !== 0; }
function identity(info) {
  return { dev: String(info.dev), ino: String(info.ino), size: String(info.size), mtimeNs: String(info.mtimeNs ?? Math.trunc(Number(info.mtimeMs) * 1_000_000)), ctimeNs: String(info.ctimeNs ?? Math.trunc(Number(info.ctimeMs) * 1_000_000)) };
}
function sameIdentity(left, right) { return left && right && ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => String(left[key]) === String(right[key])); }

async function openStableSource(filePath, { sourceKind, maxBytes, signal }) {
  sourceAllowed(sourceKind); cancelled(signal);
  let link;
  try { link = await lstat(filePath, { bigint: true }); } catch { fail('SOURCE_UNAVAILABLE', '원본 파일을 열 수 없어요.'); }
  if (link.isSymbolicLink()) fail('SOURCE_SYMLINK_UNSUPPORTED', '바로가기나 링크 파일은 처리하지 않아요.');
  if (!link.isFile()) fail('SOURCE_NOT_REGULAR_FILE', '일반 파일만 처리할 수 있어요.');
  if (offlinePlaceholder(link)) fail('CLOUD_FILE_NOT_DOWNLOADED', '클라우드에만 있는 파일은 먼저 내려받아야 해요.');
  if (link.size > BigInt(maxBytes)) fail('SOURCE_LIMIT_EXCEEDED', '파일이 제한된 안전 복구 크기를 넘어요.');
  let resolved;
  try { resolved = await realpath(filePath); } catch { fail('SOURCE_UNAVAILABLE', '원본 파일의 실제 위치를 확인할 수 없어요.'); }
  const before = await lstat(resolved, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) fail('SOURCE_NOT_REGULAR_FILE', '일반 파일만 처리할 수 있어요.');
  if (offlinePlaceholder(before)) fail('CLOUD_FILE_NOT_DOWNLOADED', '클라우드에만 있는 파일은 먼저 내려받아야 해요.');
  const stable = identity(before);
  if (!sameIdentity(identity(link), stable)) fail('SOURCE_CHANGED', '파일을 여는 중 원본이 바뀌었어요.');
  const handle = await open(resolved, 'r');
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameIdentity(stable, identity(opened))) fail('SOURCE_CHANGED', '파일을 여는 중 원본이 바뀌었어요.');
    return { handle, resolved, stable, size: Number(opened.size) };
  } catch (error) { await handle.close(); throw error; }
}

async function assertStable(source, signal) {
  cancelled(signal);
  const [opened, current] = await Promise.all([source.handle.stat({ bigint: true }), stat(source.resolved, { bigint: true })]);
  if (!opened.isFile() || !current.isFile() || !sameIdentity(source.stable, identity(opened)) || !sameIdentity(source.stable, identity(current))) fail('SOURCE_CHANGED', '읽는 중 원본이 바뀌었어요.');
}

async function readSource(source, { signal, control, onProgress }) {
  const bytes = Buffer.alloc(source.size); let offset = 0;
  while (offset < bytes.length) {
    await checkpoint(control, signal);
    const length = Math.min(1024 * 1024, bytes.length - offset);
    const { bytesRead } = await source.handle.read(bytes, offset, length, offset);
    if (!bytesRead) fail('SOURCE_CHANGED', '읽는 중 파일 길이가 바뀌었어요.');
    offset += bytesRead;
    emit(onProgress, { phase: 'read', bytesRead: offset, bytesTotal: bytes.length });
    await new Promise(resolve => setImmediate(resolve));
  }
  await assertStable(source, signal);
  return bytes;
}

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (0xedb88320 & -(value & 1)); }
  return (value ^ 0xffffffff) >>> 0;
}

function decodeZipName(bytes, flags) {
  if (!(flags & 0x800) && bytes.some(byte => byte > 0x7f)) fail('ZIP_NAME_ENCODING_UNSUPPORTED', '지원하지 않는 ZIP 파일 이름 인코딩이에요.');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail('ZIP_NAME_ENCODING_UNSUPPORTED', '지원하지 않는 ZIP 파일 이름 인코딩이에요.'); }
}

function safeZipName(name) {
  return name && !/[\\:\u0000-\u001f]/.test(name) && !name.startsWith('/') && !name.split('/').some(part => part === '..' || part === '.' || !part);
}

function parseDamagedLocalZip(bytes, maxBytes) {
  if (bytes.includes(Buffer.from('504b0102', 'hex')) || bytes.includes(Buffer.from('504b0506', 'hex'))) fail('ZIP_CENTRAL_DIRECTORY_PRESENT', '완전한 ZIP은 손상 복구 경로에서 처리하지 않아요.');
  const entries = new Map(); let offset = 0; let stopped = null;
  // Only declared, sequential boundaries are trusted. Never search past damage
  // for a signature that could belong to embedded data or another document.
  const stopAtDamage = () => {
    if (!entries.size) fail('ZIP_LOCAL_ENTRIES_NOT_FOUND', '선언된 ZIP 로컬 항목을 찾지 못했어요.');
    stopped = { offset, code: 'ZIP_LOCAL_ENTRY_TRUNCATED' };
  };
  while (offset < bytes.length) {
    if (entries.size >= 512) fail('ZIP_ENTRY_LIMIT', 'ZIP 항목 수가 안전 제한을 넘어요.');
    if (offset + 30 > bytes.length || bytes.readUInt32LE(offset) !== 0x04034b50) { stopAtDamage(); break; }
    const flags = bytes.readUInt16LE(offset + 6); const method = bytes.readUInt16LE(offset + 8); const crc = bytes.readUInt32LE(offset + 14);
    const compressedSize = bytes.readUInt32LE(offset + 18); const uncompressedSize = bytes.readUInt32LE(offset + 22);
    const nameLength = bytes.readUInt16LE(offset + 26); const extraLength = bytes.readUInt16LE(offset + 28);
    if (flags & 0x2041) fail('ZIP_ENCRYPTED_UNSUPPORTED', '암호화된 ZIP 항목은 처리하지 않아요.');
    if (flags & 0x08) fail('ZIP_DATA_DESCRIPTOR_UNSUPPORTED', '크기를 선언하지 않은 ZIP 항목은 처리하지 않아요.');
    if (flags & ~0x806) fail('ZIP_FLAGS_UNSUPPORTED', '지원하지 않는 ZIP 플래그가 있어요.');
    if (![0, 8].includes(method)) fail('ZIP_COMPRESSION_UNSUPPORTED', '지원하지 않는 ZIP 압축 방식이에요.');
    if (compressedSize > maxBytes || uncompressedSize > maxBytes || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) fail('ZIP_LIMIT_EXCEEDED', 'ZIP 항목 크기가 제한을 넘어요.');
    const headerEnd = offset + 30 + nameLength + extraLength; const end = headerEnd + compressedSize;
    if (headerEnd > bytes.length) { stopAtDamage(); break; }
    const name = decodeZipName(bytes.subarray(offset + 30, offset + 30 + nameLength), flags);
    if (!safeZipName(name) || entries.has(name)) fail('ZIP_DAMAGED', 'ZIP 항목 이름이나 구조가 올바르지 않아요.');
    if (macroOrActiveContent(new Map([[name, null]]))) fail('MACRO_CONTENT_UNSUPPORTED', '매크로나 스크립트가 포함된 문서는 처리하지 않아요.');
    if (end > bytes.length) { stopAtDamage(); break; }
    entries.set(name, { name, method, crc, compressedSize, uncompressedSize, body: bytes.subarray(headerEnd, end) });
    offset = end;
  }
  if (!entries.size) fail('ZIP_LOCAL_ENTRIES_NOT_FOUND', '선언된 ZIP 로컬 항목을 찾지 못했어요.');
  return { entries, coverage: { mode: 'sequential-local-zip', sourceBytes: bytes.length,
    parsedBytes: offset, unexaminedBytes: bytes.length - offset, stop: stopped, entriesParsed: entries.size } };
}

function extractZipEntry(entry, maxBytes) {
  let plain;
  try {
    if (entry.method === 0) plain = Buffer.from(entry.body);
    else {
      const decoded = inflateRawSync(entry.body, { maxOutputLength: Math.max(1, Math.min(maxBytes, entry.uncompressedSize)), info: true });
      if (decoded.engine.bytesWritten !== entry.compressedSize) fail('ZIP_DEFLATE_FAILED', 'ZIP 압축 경계가 선언된 크기와 달라요.');
      plain = decoded.buffer;
    }
  }
  catch { fail('ZIP_DEFLATE_FAILED', 'ZIP 압축 데이터를 안전하게 풀 수 없어요.'); }
  if (plain.length !== entry.uncompressedSize || crc32(plain) !== entry.crc) fail('ZIP_CRC_MISMATCH', `ZIP CRC가 맞지 않아요: ${entry.name}`);
  return plain;
}

function decodeEntities(value) {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (all, entity) => {
    if (entity === 'amp') return '&'; if (entity === 'lt') return '<'; if (entity === 'gt') return '>';
    if (entity === 'quot') return '"'; if (entity === 'apos') return "'";
    const code = entity.startsWith('#x') ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
    if (!Number.isInteger(code) || code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) fail('XML_INVALID_ENTITY', 'XML 문자 참조가 올바르지 않아요.');
    return String.fromCodePoint(code);
  });
}

function appendXmlText(target, value) {
  if (value.includes('<') || /&(?!#x[0-9a-fA-F]+;|#\d+;|amp;|lt;|gt;|quot;|apos;)/.test(value)) fail('XML_INVALID', 'XML 텍스트가 올바르지 않아요.');
  const text = decodeEntities(value).replace(/\s+/g, ' ').trim(); if (text) target.push(text);
}

function validatedXmlText(bytes, maxChars) {
  let xml;
  try { xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail('XML_ENCODING_UNSUPPORTED', 'UTF-8 XML만 제한적으로 처리할 수 있어요.'); }
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) fail('XML_EXTERNAL_ENTITY_UNSUPPORTED', '외부 엔터티가 있는 XML은 처리하지 않아요.');
  const tag = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)]]>|<\?xml\s+[^?]*\?>|<([A-Za-z_][\w:.-]*)(?:\s+(?:[A-Za-z_:][\w:.-]*\s*=\s*(?:"[^"<&]*"|'[^'<&]*')))*\s*(\/?)>|<\/([A-Za-z_][\w:.-]*)\s*>/g;
  const stack = []; const text = []; let cursor = 0; let roots = 0; let match;
  while ((match = tag.exec(xml))) {
    const gap = xml.slice(cursor, match.index); cursor = tag.lastIndex;
    if (!stack.length && gap.trim()) fail('XML_INVALID', 'XML 루트 밖에 텍스트가 있어요.');
    if (stack.length) appendXmlText(text, gap);
    if (match[1] !== undefined) { if (!stack.length) fail('XML_INVALID', 'XML 루트 밖의 CDATA는 처리하지 않아요.'); appendXmlText(text, match[1]); continue; }
    if (match[2]) {
      if (!stack.length && roots) fail('XML_INVALID', 'XML 루트 요소가 둘 이상이에요.');
      if (match[3]) { if (!stack.length) roots += 1; } else stack.push(match[2]);
      continue;
    }
    if (match[4]) { if (stack.pop() !== match[4]) fail('XML_INVALID', 'XML 태그가 서로 맞지 않아요.'); if (!stack.length) roots += 1; }
  }
  const tail = xml.slice(cursor);
  if (!stack.length && tail.trim()) fail('XML_INVALID', 'XML 루트 밖에 텍스트가 있어요.');
  if (stack.length) appendXmlText(text, tail);
  if (stack.length || roots !== 1) fail('XML_INVALID', 'XML 구조가 완전하지 않아요.');
  const joined = text.join(' ').replace(/\s+/g, ' ').trim();
  return { text: joined.slice(0, maxChars), truncated: joined.length > maxChars };
}

function documentProfile(extension, entries) {
  const names = [...entries.keys()];
  if (extension === '.docx' && entries.has('word/document.xml')) return { format: 'DOCX', parts: ['word/document.xml'] };
  if (extension === '.xlsx' && entries.has('xl/workbook.xml')) return { format: 'XLSX', parts: names.filter(name => name === 'xl/sharedStrings.xml' || /^xl\/worksheets\/[^/]+\.xml$/i.test(name)) };
  if (extension === '.pptx' && entries.has('ppt/presentation.xml')) return { format: 'PPTX', parts: names.filter(name => /^ppt\/slides\/slide\d+\.xml$/i.test(name)) };
  if (extension === '.hwpx' && entries.has('[Content_Types].xml')) return { format: 'HWPX', parts: names.filter(name => /^Contents\/section\d+\.xml$/i.test(name)) };
  return null;
}

function macroOrActiveContent(entries) {
  return [...entries.keys()].some(name => /(?:^|\/)(?:vbaProject\.bin|vbaData\.xml|macros?\/|scripts?\/)/i.test(name));
}

function safeOutputName(sourcePath, suffix) {
  let name = path.basename(sourcePath).normalize('NFKC').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/^\.+/g, '').slice(0, 150);
  if (!name) name = 'recovered';
  return `${name}${suffix}`;
}

async function privateOutput(destination) {
  await mkdir(destination, { recursive: true });
  const link = await lstat(destination, { bigint: true });
  if (!link.isDirectory() || link.isSymbolicLink()) fail('DESTINATION_INVALID', '저장 위치는 링크가 아닌 일반 폴더여야 해요.');
  const root = await realpath(destination); const again = await lstat(root, { bigint: true });
  if (!again.isDirectory() || again.isSymbolicLink()) fail('DESTINATION_INVALID', '저장 위치를 안전하게 확인할 수 없어요.');
  const pending = await mkdtemp(path.join(root, '.recoverychat-salvage-writing-'));
  return { root, pending };
}

async function publishText(destination, sourcePath, content, source, { signal, control, onProgress, kind }) {
  const output = await privateOutput(destination); let published = null; let partial = path.join(output.pending, '.writing.partial');
  try {
    await checkpoint(control, signal);
    const bytes = Buffer.from(content, 'utf8'); const handle = await open(partial, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await assertStable(source, signal);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const next = path.join(output.root, randomUUID());
      try { await rename(output.pending, next); published = next; break; } catch (error) { if (error?.code !== 'EEXIST') throw error; }
    }
    if (!published) fail('OUTPUT_EXISTS', '새 복구 결과 폴더를 만들 수 없어요.');
    partial = path.join(published, '.writing.partial'); const saved = path.join(published, safeOutputName(sourcePath, '.salvaged.txt'));
    await rename(partial, saved);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    emit(onProgress, { phase: 'complete', kind, path: saved, bytesWritten: bytes.length });
    return { path: saved, sha256, size: bytes.length };
  } catch (error) { if (!published) await rm(output.pending, { recursive: true, force: true }).catch(() => {}); throw error; }
}

async function publishPng(destination, sourcePath, content, source, options) {
  const output = await privateOutput(destination); let published = null; let partial = path.join(output.pending, '.writing.partial');
  try {
    await checkpoint(options.control, options.signal);
    const handle = await open(partial, 'wx', 0o600);
    try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
    await assertStable(source, options.signal);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const next = path.join(output.root, randomUUID());
      try { await rename(output.pending, next); published = next; break; } catch (error) { if (error?.code !== 'EEXIST') throw error; }
    }
    if (!published) fail('OUTPUT_EXISTS', '새 복구 결과 폴더를 만들 수 없어요.');
    partial = path.join(published, '.writing.partial'); const saved = path.join(published, safeOutputName(sourcePath, '.reconstructed.png'));
    await rename(partial, saved);
    const sha256 = createHash('sha256').update(content).digest('hex');
    emit(options.onProgress, { phase: 'complete', kind: 'png', path: saved, bytesWritten: content.length });
    return { path: saved, sha256, size: content.length };
  } catch (error) { if (!published) await rm(output.pending, { recursive: true, force: true }).catch(() => {}); throw error; }
}

export async function salvageDocument(filePath, destination, { signal, control, onProgress, maxBytes = DEFAULT_MAX_BYTES, sourceKind } = {}) {
  const limit = checkedLimit(maxBytes); const source = await openStableSource(filePath, { sourceKind, maxBytes: limit, signal });
  try {
    const bytes = await readSource(source, { signal, control, onProgress }); await checkpoint(control, signal);
    const extension = path.extname(source.resolved).toLowerCase(); if (!['.docx', '.xlsx', '.pptx', '.hwpx'].includes(extension)) fail('DOCUMENT_TYPE_UNSUPPORTED', '손상 복구는 DOCX, XLSX, PPTX, HWPX만 지원해요.');
    const { entries, coverage } = parseDamagedLocalZip(bytes, limit); if (macroOrActiveContent(entries)) fail('MACRO_CONTENT_UNSUPPORTED', '매크로나 스크립트가 포함된 문서는 처리하지 않아요.');
    const profile = documentProfile(extension, entries); if (!profile || !profile.parts.length) fail('DOCUMENT_STRUCTURE_UNSUPPORTED', '문서의 알려진 텍스트 XML 구조를 확인하지 못했어요.');
    const parts = [], extractedParts = [], skippedParts = [];
    const skippable = new Set(['ZIP_CRC_MISMATCH', 'ZIP_DEFLATE_FAILED', 'XML_INVALID', 'XML_INVALID_ENTITY', 'XML_ENCODING_UNSUPPORTED']);
    let truncated = Boolean(coverage.stop), decodedBytes = 0, attemptedParts = 0, firstFailure = null;
    for (const [index, name] of profile.parts.entries()) {
      await checkpoint(control, signal);
      const entry = entries.get(name);
      if (index >= MAX_XML_PARTS || entry.uncompressedSize > limit - decodedBytes) {
        skippedParts.push({ name, code: index >= MAX_XML_PARTS ? 'XML_PART_LIMIT' : 'XML_DECODE_BUDGET' });
        truncated = true; continue;
      }
      attemptedParts++; decodedBytes += entry.uncompressedSize;
      try {
        const plain = extractZipEntry(entry, limit);
        const parsed = validatedXmlText(plain, limit);
        if (/\b(?:vbaProject|macroEnabled)\b/i.test(parsed.text)) fail('MACRO_CONTENT_UNSUPPORTED', '매크로 참조가 있는 문서는 처리하지 않아요.');
        if (!parsed.text) { skippedParts.push({ name, code: 'DOCUMENT_TEXT_NOT_FOUND' }); continue; }
        parts.push(`[${name}]\n${parsed.text}`);
        extractedParts.push({ name, sha256: createHash('sha256').update(plain).digest('hex'), bytes: plain.length });
        truncated ||= parsed.truncated;
      } catch (error) {
        if (!skippable.has(error.code)) throw error;
        firstFailure ??= error; skippedParts.push({ name, code: error.code }); truncated = true;
      }
      emit(onProgress, { phase: 'extract', format: profile.format, entriesExtracted: parts.length, entry: name });
    }
    Object.assign(coverage, { selectedParts: profile.parts.length, attemptedParts, extractedParts: parts.length, skippedParts, decodedBytes });
    if (!parts.length) {
      const failure = firstFailure ?? new SalvageError('DOCUMENT_TEXT_NOT_FOUND', '검증된 XML 텍스트를 찾지 못했어요.');
      failure.details = { ...failure.details, coverage }; throw failure;
    }
    const content = [`[부분 복구 결과]`, `원본 파일: ${path.basename(source.resolved)}`, `이 텍스트는 손상된 ZIP의 검증된 XML 일부에서 추출했습니다. 원본 문서 구조, 서식, 매크로, 연결, 첨부 파일은 복구하지 않았습니다.`,
      `텍스트 추출: ${parts.length}/${profile.parts.length}개 항목 · 추출하지 못한 항목: ${skippedParts.length}개`,
      `구조 미검사: ${coverage.unexaminedBytes}바이트${coverage.stop ? ` · 중단 위치: ${coverage.stop.offset} · ${coverage.stop.code}` : ''}`,
      '알려진 경계 안의 선택 항목만 검사했습니다. 미검사 영역의 내용과 활성 콘텐츠 유무는 확인하지 않았습니다.',
      ...skippedParts.map(item => `[미추출] ${item.name}: ${item.code}`), '', parts.join('\n\n')].join('\n');
    const saved = await publishText(destination, source.resolved, content, source, { signal, control, onProgress, kind: 'document' });
    return { status: 'partial', ...saved, truncated, coverage, extractedParts,
      sourceSha256: createHash('sha256').update(bytes).digest('hex'), originalIdentityVerified: false,
      validation: { format: profile.format, checks: ['Central directory absent; declared local ZIP entries used', 'Compressed size and CRC verified for extracted XML', 'Validated XML text only; no macro, link, or embedded content executed', 'No resynchronization after a damaged local entry; unknown content remains unexamined'] } };
  } finally { await source.handle.close(); }
}

async function pngChunks(bytes, maxBytes, options) {
  const chunks = []; let offset = 0;
  while (offset + 12 <= bytes.length) {
    if ((offset & 0xffff) === 0) { await checkpoint(options.control, options.signal); await new Promise(resolve => setImmediate(resolve)); }
    if (chunks.length >= 512) fail('PNG_CHUNK_LIMIT', 'PNG 조각 수가 안전 제한을 넘어요.');
    const length = bytes.readUInt32BE(offset); const type = bytes.subarray(offset + 4, offset + 8).toString('ascii'); const end = offset + 12 + length;
    if (!PNG_TYPES.has(type) || length > maxBytes || end > bytes.length) { offset += 1; continue; }
    const body = bytes.subarray(offset + 8, offset + 8 + length); const stored = bytes.readUInt32BE(offset + 8 + length);
    if (crc32(Buffer.concat([Buffer.from(type, 'ascii'), body])) !== stored) fail('PNG_CRC_MISMATCH', `PNG 조각 CRC가 맞지 않아요: ${type}`);
    chunks.push({ type, body: Buffer.from(body), raw: Buffer.from(bytes.subarray(offset, end)) }); offset = end;
  }
  return chunks;
}

function validatePngStructure(ihdr, idat, iend, maxBytes) {
  if (ihdr.body.length !== 13 || iend.body.length !== 0) fail('PNG_STRUCTURE_INVALID', 'PNG 조각 구조가 올바르지 않아요.');
  const width = ihdr.body.readUInt32BE(0); const height = ihdr.body.readUInt32BE(4); const bitDepth = ihdr.body[8]; const colorType = ihdr.body[9];
  if (!width || !height || width * height > 16 * 1024 * 1024) fail('PNG_PIXEL_LIMIT', 'PNG 이미지 크기가 제한을 넘어요.');
  if (bitDepth !== 8 || ![0, 2, 4, 6].includes(colorType) || ihdr.body[10] !== 0 || ihdr.body[11] !== 0 || ihdr.body[12] !== 0) fail('PNG_FORMAT_UNSUPPORTED', '팔레트를 쓰지 않는 비인터레이스 8비트 PNG만 제한적으로 재구성해요.');
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 })[colorType]; const expected = height * (1 + width * channels);
  if (!Number.isSafeInteger(expected) || expected > maxBytes) fail('PNG_LIMIT_EXCEEDED', 'PNG 압축 해제 크기가 제한을 넘어요.');
  let decoded; try {
    const result = inflateSync(idat.body, { maxOutputLength: expected, info: true });
    if (result.engine.bytesWritten !== idat.body.length) fail('PNG_DEFLATE_FAILED', 'PNG 압축 스트림 뒤에 해석되지 않은 데이터가 있어요.');
    decoded = result.buffer;
  } catch { fail('PNG_DEFLATE_FAILED', 'PNG 이미지 데이터를 검증할 수 없어요.'); }
  if (decoded.length !== expected || decoded.some((byte, index) => index % (1 + width * channels) === 0 && byte > 4)) fail('PNG_DECODE_INVALID', 'PNG 이미지 행 데이터를 검증하지 못했어요.');
  return { width, height, colorType };
}

async function orderPngData(ihdr, chunks, iend, limit, options) {
  if (chunks.length === 1) return { order: chunks, info: validatePngStructure(ihdr, chunks[0], iend, limit), attempts: 1 };
  if (chunks.length > 6) fail('PNG_SEARCH_LIMIT', 'IDAT 조각은 최대 6개까지 순서를 확인해요.');
  if (ihdr.body.length !== 13 || iend.body.length) fail('PNG_STRUCTURE_INVALID', 'PNG 조각 구조가 올바르지 않아요.');
  const width = ihdr.body.readUInt32BE(0), height = ihdr.body.readUInt32BE(4), channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 })[ihdr.body[9]];
  if (!channels || ihdr.body[8] !== 8 || ihdr.body[10] || ihdr.body[11] || ihdr.body[12]) fail('PNG_FORMAT_UNSUPPORTED', '팔레트를 쓰지 않는 비인터레이스 8비트 PNG만 제한적으로 재구성해요.');
  const decodedBytes = height * (1 + width * channels), compressedBytes = chunks.reduce((n, chunk) => n + chunk.body.length, 0);
  if (!width || !height || width * height > 16 * 1024 * 1024 || decodedBytes > limit) fail('PNG_LIMIT_EXCEEDED', 'PNG 이미지 크기가 제한을 넘어요.');
  const keys = chunks.map(chunk => createHash('sha256').update(chunk.body).digest('hex'));
  let found, attempts = 0, budget = 0; const started = Date.now();
  async function visit(order, remaining) {
    await checkpoint(options.control, options.signal);
    if (!remaining.length) {
      attempts++; budget += decodedBytes + compressedBytes;
      if (attempts > 720 || budget > 256 * 1024 * 1024 || Date.now() - started > 10_000) fail('PNG_SEARCH_LIMIT', '조각 순서 확인의 시간·처리량 제한에 도달했어요. 확인되지 않은 결과는 저장하지 않습니다.');
      if (attempts % 8 === 0) { emit(options.onProgress, { phase: 'reconstruct', ordersChecked: attempts }); await new Promise(resolve => setImmediate(resolve)); }
      let info;
      try { info = validatePngStructure(ihdr, { body: Buffer.concat(order.map(chunk => chunk.body)) }, iend, limit); }
      catch (error) { if (['PNG_DEFLATE_FAILED', 'PNG_DECODE_INVALID'].includes(error.code)) return; throw error; }
      if (found) fail('PNG_ORDER_AMBIGUOUS', '유효한 PNG 조각 순서가 둘 이상이라 하나를 임의로 저장하지 않아요.');
      found = { order: [...order], info }; return;
    }
    const seen = new Set();
    for (const index of remaining) {
      if (seen.has(keys[index])) continue; seen.add(keys[index]);
      await visit([...order, chunks[index]], remaining.filter(value => value !== index));
    }
  }
  await visit([], chunks.map((_, index) => index));
  if (!found) fail('PNG_DEFLATE_FAILED', '모든 조각을 사용하는 유효한 PNG 압축 스트림을 찾지 못했어요.');
  return { ...found, attempts };
}

export async function reconstructPngChunks(filePath, destination, options = {}) {
  const limit = checkedLimit(options.maxBytes ?? DEFAULT_MAX_BYTES); const source = await openStableSource(filePath, { sourceKind: options.sourceKind, maxBytes: limit, signal: options.signal });
  try {
    const bytes = await readSource(source, options); await checkpoint(options.control, options.signal);
    const chunks = await pngChunks(bytes, limit, options); const byType = type => chunks.filter(chunk => chunk.type === type);
    const ihdr = byType('IHDR'); const idat = byType('IDAT'); const iend = byType('IEND');
    if (!ihdr.length || !idat.length || !iend.length) fail('PNG_CHUNKS_MISSING', '재구성에 필요한 IHDR, IDAT, IEND 조각이 모두 필요해요.');
    if (ihdr.length !== 1 || iend.length !== 1) fail('PNG_ORDER_AMBIGUOUS', '여러 이미지의 PNG 머리말·끝 조각을 안전하게 구별할 수 없어요.');
    const { order, info, attempts } = await orderPngData(ihdr[0], idat, iend[0], limit, options);
    const output = Buffer.concat([PNG_SIGNATURE, ihdr[0].raw, ...order.map(chunk => chunk.raw), iend[0].raw]);
    const saved = await publishPng(destination, source.resolved, output, source, options);
    return { status: 'reconstructed', ...saved, originalIdentityVerified: false, validation: { format: 'PNG', checks: [`Unique IHDR, ${idat.length === 1 ? 'single IDAT' : `${idat.length} IDAT chunks in a uniquely validated order`} and IEND CRC verified`, `${attempts} distinct orders checked; complete zlib input consumption verified`, `Decoded ${info.width}×${info.height} non-interlaced image data`, 'Reconstructed structure only; this does not prove it matches the original PNG'] } };
  } finally { await source.handle.close(); }
}
