import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deflateRawSync, deflateSync } from 'node:zlib';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

import { reconstructPngChunks, salvageDocument } from '../engine/document-salvage.mjs';

let root;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function crc32(bytes) { let value = 0xffffffff; for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (0xedb88320 & -(value & 1)); } return (value ^ 0xffffffff) >>> 0; }
function u16(value) { const out = Buffer.alloc(2); out.writeUInt16LE(value); return out; }
function u32le(value) { const out = Buffer.alloc(4); out.writeUInt32LE(value >>> 0); return out; }
function u32be(value) { const out = Buffer.alloc(4); out.writeUInt32BE(value >>> 0); return out; }

function localEntry(name, body, { method = 0, crc = crc32(body), uncompressedSize = body.length, flags = 0 } = {}) {
  const encoded = Buffer.from(body); const compressed = method === 8 ? deflateRawSync(encoded) : encoded; const nameBytes = Buffer.from(name, 'utf8');
  return Buffer.concat([Buffer.from('504b0304', 'hex'), u16(20), u16(flags | 0x800), u16(method), u16(0), u16(0), u32le(crc), u32le(compressed.length), u32le(uncompressedSize), u16(nameBytes.length), u16(0), nameBytes, compressed]);
}
function damagedDocx(entries) { return Buffer.concat(entries.map(entry => localEntry(entry.name, entry.body, entry.options))); }
function pngChunk(type, body, { crc = crc32(Buffer.concat([Buffer.from(type), body])) } = {}) { return Buffer.concat([u32be(body.length), Buffer.from(type), body, u32be(crc)]); }
function validPngChunks() {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2;
  return { ihdr: pngChunk('IHDR', ihdr), idat: pngChunk('IDAT', deflateSync(Buffer.from([0, 0xaa, 0xbb, 0xcc]))), iend: pngChunk('IEND', Buffer.alloc(0)) };
}
async function target(name, body) { const file = path.join(root, name); await writeFile(file, body); return file; }
async function onlyGenerated(directory) {
  const names = await readdir(directory); assert.equal(names.length, 1); const contained = await readdir(path.join(directory, names[0])); assert.equal(contained.length, 1); return path.join(directory, names[0], contained[0]);
}

before(async () => { root = await mkdtemp(path.join(os.tmpdir(), 'recovery-salvage-')); });
after(async () => { await rm(root, { recursive: true, force: true }); });

test('salvages only CRC-verified damaged DOCX XML into a generated partial text result', async () => {
  const xml = Buffer.from('<?xml version="1.0"?><w:document xmlns:w="urn:test"><w:body><w:t>부분 복구 한글</w:t></w:body></w:document>');
  const source = await target('damaged.docx', damagedDocx([{ name: 'word/document.xml', body: xml, options: { method: 8 } }]));
  const original = await readFile(source); const destination = path.join(root, 'out-document');
  const result = await salvageDocument(source, destination, { sourceKind: 'user-selected' });
  assert.equal(result.status, 'partial'); assert.equal(result.originalIdentityVerified, false); assert.match(result.validation.checks.join(' '), /Central directory absent/);
  const generated = await onlyGenerated(destination); const text = await readFile(generated, 'utf8');
  assert.match(path.basename(generated), /\.salvaged\.txt$/); assert.match(text, /^\[부분 복구 결과\]/); assert.match(text, /부분 복구 한글/);
  assert.equal(result.sha256, sha256(Buffer.from(text))); assert.deepEqual(await readFile(source), original, 'original ZIP is never repaired or changed');
});

test('refuses wrong CRC, oversized declared ZIP entries, macros, external entities, and data descriptors', async () => {
  const xml = Buffer.from('<w:document xmlns:w="urn:test"><w:t>안전</w:t></w:document>');
  const cases = [
    ['wrong-crc.docx', damagedDocx([{ name: 'word/document.xml', body: xml, options: { crc: 7 } }]), 'ZIP_CRC_MISMATCH'],
    ['bomb.docx', damagedDocx([{ name: 'word/document.xml', body: Buffer.alloc(0), options: { uncompressedSize: 65 * 1024 * 1024 } }]), 'ZIP_LIMIT_EXCEEDED'],
    ['macro.docx', damagedDocx([{ name: 'word/document.xml', body: xml }, { name: 'word/vbaProject.bin', body: Buffer.from('never execute') }]), 'MACRO_CONTENT_UNSUPPORTED'],
    ['xxe.docx', damagedDocx([{ name: 'word/document.xml', body: Buffer.from('<!DOCTYPE x [<!ENTITY e SYSTEM "file:///never">]><w:document xmlns:w="urn:test"><w:t>&e;</w:t></w:document>') }]), 'XML_EXTERNAL_ENTITY_UNSUPPORTED'],
    ['descriptor.docx', damagedDocx([{ name: 'word/document.xml', body: xml, options: { flags: 0x08 } }]), 'ZIP_DATA_DESCRIPTOR_UNSUPPORTED'],
  ];
  for (const [name, bytes, code] of cases) {
    const source = await target(name, bytes); await assert.rejects(() => salvageDocument(source, path.join(root, `${name}-out`), { sourceKind: 'user-selected' }), { code });
  }
});

test('cancellation and raw-source authorization are distinct before any result is published', async () => {
  const source = await target('cancel.docx', damagedDocx([{ name: 'word/document.xml', body: Buffer.from('<w:document xmlns:w="urn:test"><w:t>취소</w:t></w:document>') }]));
  await assert.rejects(() => salvageDocument(source, path.join(root, 'raw-out'), {}), { code: 'SOURCE_NOT_AUTHORIZED' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(() => salvageDocument(source, path.join(root, 'cancel-out'), { sourceKind: 'owned-carved', signal: controller.signal }), { code: 'CANCELLED' });
});

test('reconstructs uniquely identifiable shuffled PNG chunks only after CRC and decoded image validation', async () => {
  const chunks = validPngChunks(); const source = await target('fragment.bin', Buffer.concat([Buffer.from('discarded-prefix'), chunks.idat, Buffer.from('noise'), chunks.iend, chunks.ihdr]));
  const original = await readFile(source); const destination = path.join(root, 'out-png');
  const result = await reconstructPngChunks(source, destination, { sourceKind: 'owned-carved' });
  assert.equal(result.status, 'reconstructed'); assert.equal(result.originalIdentityVerified, false); assert.match(result.validation.checks.join(' '), /single IDAT/);
  const generated = await onlyGenerated(destination); const png = await readFile(generated); assert.ok(png.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))); assert.equal(result.sha256, sha256(png));
  assert.deepEqual(await readFile(source), original, 'fragment source remains read-only');
});

test('refuses multiple complete zlib streams, ambiguous image headers and invalid PNG CRCs', async () => {
  const chunks = validPngChunks();
  const ambiguous = await target('ambiguous.bin', Buffer.concat([chunks.ihdr, chunks.idat, chunks.idat, chunks.iend]));
  await assert.rejects(() => reconstructPngChunks(ambiguous, path.join(root, 'ambiguous-out'), { sourceKind: 'owned-carved' }), { code: 'PNG_DEFLATE_FAILED' });
  const headers = await target('headers.bin', Buffer.concat([chunks.ihdr, chunks.ihdr, chunks.idat, chunks.iend]));
  await assert.rejects(() => reconstructPngChunks(headers, path.join(root, 'headers-out'), { sourceKind: 'owned-carved' }), { code: 'PNG_ORDER_AMBIGUOUS' });
  const badIdat = Buffer.from(chunks.idat); badIdat[badIdat.length - 1] ^= 1;
  const badCrc = await target('bad-crc.bin', Buffer.concat([chunks.ihdr, badIdat, chunks.iend]));
  await assert.rejects(() => reconstructPngChunks(badCrc, path.join(root, 'crc-out'), { sourceKind: 'owned-carved' }), { code: 'PNG_CRC_MISMATCH' });
});

test('reassembles three shuffled IDAT fragments into the exact synthetic PNG and enforces a bounded search', async () => {
  const chunks = validPngChunks(), compressed = chunks.idat.subarray(8, -4);
  const split = [compressed.subarray(0, 4), compressed.subarray(4, 8), compressed.subarray(8)].map(body => pngChunk('IDAT', body));
  const sourceBytes = Buffer.concat([split[2], chunks.iend, split[0], chunks.ihdr, split[1]]);
  const source = await target('three-fragments.bin', sourceBytes);
  const result = await reconstructPngChunks(source, path.join(root, 'three-out'), { sourceKind: 'user-selected' });
  const expected = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunks.ihdr, ...split, chunks.iend]);
  assert.deepEqual(await readFile(result.path), expected);
  assert.deepEqual(await readFile(source), sourceBytes);
  assert.match(result.validation.checks.join(' '), /6 distinct orders/);
  const tooMany = await target('seven-fragments.bin', Buffer.concat([chunks.ihdr, ...Array.from({ length: 7 }, () => split[0]), chunks.iend]));
  await assert.rejects(() => reconstructPngChunks(tooMany, path.join(root, 'seven-out'), { sourceKind: 'user-selected' }), { code: 'PNG_SEARCH_LIMIT' });
});
