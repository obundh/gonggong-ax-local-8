import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import test, { after, before } from 'node:test';

import { previewBytes, previewFile } from '../engine/file-preview.mjs';

let directory;

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (0xedb88320 & -(value & 1)); }
  return (value ^ 0xffffffff) >>> 0;
}

function u16(value) { const out = Buffer.alloc(2); out.writeUInt16LE(value); return out; }
function u32(value) { const out = Buffer.alloc(4); out.writeUInt32LE(value >>> 0); return out; }

function zip(entries) {
  const locals = []; const central = []; let offset = 0;
  for (const item of entries) {
    const name = Buffer.from(item.name, 'utf8'); const body = Buffer.from(item.body || ''); const crc = item.crc ?? crc32(body);
    const compressedSize = item.compressedSize ?? body.length; const uncompressedSize = item.uncompressedSize ?? body.length;
    const local = Buffer.concat([Buffer.from('504b0304', 'hex'), u16(20), u16(0x800), u16(0), u16(0), u16(0), u32(crc), u32(compressedSize), u32(uncompressedSize), u16(name.length), u16(0), name, body]);
    const directory = Buffer.concat([Buffer.from('504b0102', 'hex'), u16(20), u16(20), u16(0x800), u16(0), u16(0), u16(0), u32(crc), u32(compressedSize), u32(uncompressedSize), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name]);
    locals.push(local); central.push(directory); offset += local.length;
  }
  const body = Buffer.concat(locals); const directory = Buffer.concat(central);
  return Buffer.concat([body, directory, Buffer.from('504b0506', 'hex'), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(directory.length), u32(body.length), u16(0)]);
}

function png(width, height, includeEnd = true) {
  const ihdr = Buffer.alloc(25); ihdr.writeUInt32BE(13, 0); ihdr.write('IHDR', 4); ihdr.writeUInt32BE(width, 8); ihdr.writeUInt32BE(height, 12); ihdr[16] = 8; ihdr[17] = 2;
  return includeEnd ? Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), ihdr, Buffer.from('0000000049454e44ae426082', 'hex')]) : Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), ihdr]);
}

async function file(name, bytes) { const target = path.join(directory, name); await writeFile(target, bytes); return target; }

before(async () => { directory = await mkdtemp(path.join(os.tmpdir(), 'recovery-preview-')); });
after(async () => { await rm(directory, { recursive: true, force: true }); });

test('reads bounded Korean UTF-16 text as inert plain text', async () => {
  const target = await file('memo.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('안전한 복구 미리보기', 'utf16le')]));
  const result = await previewFile(target);
  assert.equal(result.type, 'text');
  assert.equal(result.text, '안전한 복구 미리보기');
  assert.match(result.validation.format, /UTF-16LE/);
  assert.equal(result.validation.originalIdentityVerified, false);
});

test('previews verified provider bytes without requiring a filesystem path', async () => {
  const result = await previewBytes('memory.txt', Buffer.from('메모리 전용 미리보기'));
  assert.equal(result.type, 'text');
  assert.equal(result.text, '메모리 전용 미리보기');
  assert.equal(result.validation.sourceIdentityVerified, true);
  assert.equal(result.validation.originalIdentityVerified, false);
});

test('caps plain text instead of reading an unlimited file', async () => {
  const target = await file('large.txt', '가'.repeat(4_000));
  const result = await previewFile(target, { maxBytes: 1024 });
  assert.equal(result.type, 'text');
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.text, 'utf8') <= 1024);
});

test('verifies only safe raster headers and rejects truncated or oversized images', async () => {
  const valid = await previewFile(await file('photo.png', png(4, 3)));
  assert.equal(valid.type, 'image');
  assert.match(valid.dataUrl, /^data:image\/png;base64,/);
  assert.match(valid.validation.checks.join(' '), /4×3/);
  const truncated = await previewFile(await file('cut.png', png(4, 3, false)));
  assert.equal(truncated.type, 'unsupported');
  assert.equal(truncated.reason, 'IMAGE_HEADER_INVALID');
  const oversized = await previewFile(await file('huge.png', png(5000, 5000)));
  assert.equal(oversized.reason, 'IMAGE_PIXEL_LIMIT');
});

test('rejects SVG and only treats it as inactive unsupported content', async () => {
  const result = await previewFile(await file('danger.svg', '<svg onload="alert(1)"><script>alert(1)</script></svg>'));
  assert.equal(result.type, 'unsupported');
  assert.equal(result.reason, 'ACTIVE_CONTENT_UNSUPPORTED');
});

test('extracts limited PDF text but refuses encrypted PDF markers', async () => {
  const basic = await file('simple.pdf', '%PDF-1.4\n1 0 obj<<>>stream\nBT (안전한 PDF) Tj ET\nendstream\nendobj\n%%EOF');
  const visible = await previewFile(basic);
  assert.equal(visible.type, 'text');
  assert.match(visible.text, /안전한 PDF/);
  const encrypted = await previewFile(await file('locked.pdf', '%PDF-1.7\n1 0 obj<< /Encrypt 2 0 R >>\n%%EOF'));
  assert.equal(encrypted.reason, 'PDF_ENCRYPTED');
});

test('over-limit PDF and HWP are size-limited rather than called damaged or unsupported formats', async () => {
  const largePdf = Buffer.alloc(8 * 1024 * 1024 + 1024, 0x20);
  Buffer.from('%PDF-1.4\n1 0 obj<<>>stream\nBT (text) Tj ET\nendstream\nendobj\n').copy(largePdf);
  Buffer.from('%%EOF').copy(largePdf, largePdf.length - 5);
  assert.equal((await previewFile(await file('oversized.pdf', largePdf))).reason, 'PDF_TOO_LARGE');
  const largeHwp = Buffer.alloc(largePdf.length);
  Buffer.from('d0cf11e0a1b11ae1', 'hex').copy(largeHwp); largeHwp.writeUInt16LE(0xfffe, 28);
  assert.equal((await previewFile(await file('oversized.hwp', largeHwp))).reason, 'HWP_TOO_LARGE');
});

test('extracts known DOCX XML text, verifies CRC, and never executes macro references', async () => {
  const docx = zip([
    { name: 'word/document.xml', body: '<?xml version="1.0"?><w:document><w:t>복구 문서</w:t></w:document>' },
    { name: 'word/vbaProject.bin', body: Buffer.from('not executed') },
  ]);
  const result = await previewFile(await file('macro.docx', docx));
  assert.equal(result.type, 'text');
  assert.match(result.text, /복구 문서/);
  assert.match(result.validation.checks.join(' '), /CRC verified: word\/document.xml/);
  assert.match(result.validation.checks.join(' '), /Macro reference present; never executed/);
});

test('rejects ZIP entry size claims that exceed the bounded extraction limit', async () => {
  const bomb = zip([{ name: 'word/document.xml', body: Buffer.alloc(0), compressedSize: 0, uncompressedSize: 9 * 1024 * 1024 }]);
  const result = await previewFile(await file('bomb.docx', bomb));
  assert.equal(result.type, 'unsupported');
  assert.equal(result.reason, 'ZIP_LIMIT_EXCEEDED');
});

test('PDF preview limits the combined expansion of multiple individually small compressed streams', async () => {
  const content = deflateSync(Buffer.from(`BT (${ 'a'.repeat(700) }) Tj ET`));
  const stream = Buffer.concat([Buffer.from('<< /Filter /FlateDecode >>\nstream\n'), content, Buffer.from('\nendstream\n')]);
  const source = await file('many-compressed.pdf', Buffer.concat([Buffer.from('%PDF-1.4\n'), stream, stream, Buffer.from('%%EOF')]));
  const result = await previewFile(source, { maxBytes: 1024 });
  assert.equal(result.type, 'unsupported');
  assert.equal(result.reason, 'PDF_TOTAL_LIMIT');
});

test('keeps legacy OLE, malformed source identity, and cancellation distinct', async () => {
  const ole = Buffer.alloc(512); Buffer.from('d0cf11e0a1b11ae1', 'hex').copy(ole); ole.writeUInt16LE(0xfffe, 28);
  const oleResult = await previewFile(await file('legacy.doc', ole));
  assert.equal(oleResult.reason, 'OLE_LEGACY_UNSUPPORTED');
  assert.equal((await previewFile(await file('damaged.hwp', ole))).reason, 'HWP_INVALID_STRUCTURE');
  const target = await file('identity.txt', 'identity');
  const changed = await previewFile(target, { expectedIdentity: { size: 999 } });
  assert.equal(changed.reason, 'SOURCE_CHANGED');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(() => previewFile(target, { signal: controller.signal }), (error) => error?.code === 'CANCELLED');
});
