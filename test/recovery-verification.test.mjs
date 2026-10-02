import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

import { assessRecoveredBytes, verifyRecoveredFile } from '../engine/recovery-verification.mjs';

let directory;

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
  }
  return (value ^ 0xffffffff) >>> 0;
}

function u16(value) { const out = Buffer.alloc(2); out.writeUInt16LE(value); return out; }
function u32(value) { const out = Buffer.alloc(4); out.writeUInt32LE(value >>> 0); return out; }

function zip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const item of entries) {
    const name = Buffer.from(item.name, 'utf8');
    const body = Buffer.from(item.body ?? '');
    const flags = item.flags ?? 0x800;
    const crc = item.crc ?? crc32(body);
    const compressedSize = item.compressedSize ?? body.length;
    const uncompressedSize = item.uncompressedSize ?? body.length;
    const local = Buffer.concat([
      Buffer.from('504b0304', 'hex'), u16(20), u16(flags), u16(0), u16(0), u16(0),
      u32(crc), u32(compressedSize), u32(uncompressedSize), u16(name.length), u16(0), name, body,
    ]);
    const directoryEntry = Buffer.concat([
      Buffer.from('504b0102', 'hex'), u16(20), u16(20), u16(flags), u16(0), u16(0), u16(0),
      u32(crc), u32(compressedSize), u32(uncompressedSize), u16(name.length), u16(0), u16(0),
      u16(0), u16(0), u32(0), u32(offset), name,
    ]);
    locals.push(local);
    central.push(directoryEntry);
    offset += local.length;
  }
  const body = Buffer.concat(locals);
  const directoryBytes = Buffer.concat(central);
  return Buffer.concat([
    body, directoryBytes, Buffer.from('504b0506', 'hex'), u16(0), u16(0),
    u16(entries.length), u16(entries.length), u32(directoryBytes.length), u32(body.length), u16(0),
  ]);
}

async function verify(name, bytes, options = {}) {
  const target = path.join(directory, name);
  await writeFile(target, bytes);
  return verifyRecoveredFile(target, {
    expectedSize: bytes.length,
    expectedSha256: sha256(bytes),
    fileName: name,
    ...options,
  });
}

before(async () => { directory = await mkdtemp(path.join(os.tmpdir(), 'recovery-verification-')); });
after(async () => { await rm(directory, { recursive: true, force: true }); });

test('streams exact integrity and returns only bounded text assessment metadata', async () => {
  const bytes = Buffer.from('원래 이름으로 복구한 문서');
  const progress = [];
  const result = await verify('회의록.txt', bytes, { onProgress: value => progress.push(value) });

  assert.deepEqual(result.integrity, {
    status: 'verified',
    sha256: sha256(bytes),
    size: bytes.length,
    identity: {
      dev: result.integrity.identity.dev,
      ino: result.integrity.identity.ino,
      size: String(bytes.length),
      mtimeMs: result.integrity.identity.mtimeMs,
    },
  });
  assert.ok(Object.values(result.integrity.identity).every(value => typeof value === 'string'));
  assert.equal(result.document.status, 'preview-available');
  assert.match(result.document.format, /^plain text/);
  assert.equal(result.document.previewType, 'text');
  assert.equal(result.document.truncated, false);
  assert.equal(result.document.originalIdentityVerified, false);
  assert.equal(result.document.applicationOpenVerified, false);
  assert.equal('text' in result.document, false);
  assert.deepEqual(progress.map(({ stage, bytesChecked, bytesTotal }) => ({ stage, bytesChecked, bytesTotal })), [
    { stage: 'verify-recovery', bytesChecked: 0, bytesTotal: bytes.length },
    { stage: 'verify-recovery', bytesChecked: bytes.length, bytesTotal: bytes.length },
  ]);
});

test('assesses bounded PDF and DOCX structure without claiming an application opened them', async () => {
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>stream\nBT (Recovered PDF) Tj ET\nendstream\nendobj\n%%EOF');
  const pdfResult = await verify('report.pdf', pdf);
  assert.equal(pdfResult.document.status, 'preview-available');
  assert.equal(pdfResult.document.format, 'PDF');
  assert.equal(pdfResult.document.applicationOpenVerified, false);

  const docx = zip([{ name: 'word/document.xml', body: '<w:document><w:t>Recovered DOCX</w:t></w:document>' }]);
  const docxResult = await verify('report.docx', docx);
  assert.equal(docxResult.document.status, 'preview-available');
  assert.equal(docxResult.document.format, 'DOCX');
  assert.match(docxResult.document.checks.join(' '), /CRC verified/);
  assert.equal('text' in docxResult.document, false);
});

test('rejects filename/signature and Office ZIP profile mismatches', async () => {
  const fakePdf = await assessRecoveredBytes('renamed.pdf', Buffer.from('this is plain text'));
  assert.equal(fakePdf.status, 'format-mismatch');
  assert.equal(fakePdf.expectedFormat, 'PDF');
  assert.equal(fakePdf.detectedFormat, 'plain text');

  const xlsxNamedDocx = zip([
    { name: 'xl/workbook.xml', body: '<workbook />' },
    { name: 'xl/worksheets/sheet1.xml', body: '<sheetData><v>1</v></sheetData>' },
  ]);
  const office = await assessRecoveredBytes('wrong.docx', xlsxNamedDocx);
  assert.equal(office.status, 'format-mismatch');
  assert.equal(office.reason, 'DOCUMENT_PROFILE_MISMATCH');
  assert.equal(office.expectedFormat, 'DOCX');
});

test('separates damaged CRC, protected ZIP, and safe parser limitations', async () => {
  const damaged = zip([{ name: 'word/document.xml', body: '<w:t>bad crc</w:t>', crc: 0 }]);
  const damagedResult = await assessRecoveredBytes('bad.docx', damaged);
  assert.equal(damagedResult.status, 'damaged');
  assert.equal(damagedResult.reason, 'ZIP_CRC_MISMATCH');

  const encrypted = zip([{ name: 'word/document.xml', body: '<w:t>locked</w:t>', flags: 0x801 }]);
  const protectedResult = await assessRecoveredBytes('locked.docx', encrypted);
  assert.equal(protectedResult.status, 'protected');
  assert.equal(protectedResult.reason, 'ZIP_ENCRYPTED_UNSUPPORTED');

  const officeEncrypted = Buffer.alloc(512);
  Buffer.from('d0cf11e0a1b11ae1', 'hex').copy(officeEncrypted);
  officeEncrypted.writeUInt16LE(0xfffe, 28);
  Buffer.from('EncryptedPackage', 'ascii').copy(officeEncrypted, 64);
  const protectedOffice = await assessRecoveredBytes('locked.docx', officeEncrypted);
  assert.equal(protectedOffice.status, 'protected');
  assert.equal(protectedOffice.reason, 'OLE_ENCRYPTED');

  const limited = zip([{
    name: 'word/document.xml', body: Buffer.alloc(0), compressedSize: 0,
    uncompressedSize: 9 * 1024 * 1024,
  }]);
  const limitedResult = await assessRecoveredBytes('large-claim.docx', limited);
  assert.equal(limitedResult.status, 'needs-check');
  assert.equal(limitedResult.reason, 'ZIP_LIMIT_EXCEEDED');
});

test('labels empty and unknown-extension plain text conservatively', async () => {
  const empty = await verify('empty.txt', Buffer.alloc(0));
  assert.equal(empty.document.status, 'needs-check');
  assert.equal(empty.document.reason, 'EMPTY_FILE');

  const unknown = await verify('recovered.bin', Buffer.from('readable but the original type is unknown'));
  assert.equal(unknown.document.status, 'preview-available');
  assert.match(unknown.document.detectedFormat, /^plain text/);
  assert.equal(unknown.document.originalIdentityVerified, false);
});

test('verifies files over 8 MiB without loading or parsing the whole document', async () => {
  const bytes = Buffer.alloc(8 * 1024 * 1024 + 1, 0x61);
  const checkpoints = [];
  const result = await verify('large.txt', bytes, { control: { async checkpoint() { checkpoints.push(true); } } });
  assert.equal(result.integrity.status, 'verified');
  assert.equal(result.document.status, 'needs-check');
  assert.equal(result.document.reason, 'FILE_TOO_LARGE');
  assert.equal(result.document.truncated, false);
  assert.equal(result.document.assessmentLimited, true);
  assert.ok(checkpoints.length >= 10);
});

test('throws OUTPUT_VERIFICATION_FAILED for changed content and preserves cancellation', async () => {
  const bytes = Buffer.from('changed after the writer hash was recorded');
  const target = path.join(directory, 'changed.txt');
  await writeFile(target, bytes);
  await assert.rejects(
    verifyRecoveredFile(target, {
      expectedSize: bytes.length,
      expectedSha256: sha256(Buffer.from('same length but a different recorded hash!')).slice(0, 64),
      fileName: 'changed.txt',
    }),
    error => error?.code === 'OUTPUT_VERIFICATION_FAILED' && error?.details?.reason === 'SHA256_MISMATCH',
  );

  const cancelBytes = Buffer.alloc(2 * 1024 * 1024, 0x62);
  const cancelTarget = path.join(directory, 'cancel.bin');
  await writeFile(cancelTarget, cancelBytes);
  const controller = new AbortController();
  await assert.rejects(
    verifyRecoveredFile(cancelTarget, {
      expectedSize: cancelBytes.length,
      expectedSha256: sha256(cancelBytes),
      fileName: 'cancel.bin',
      signal: controller.signal,
      onProgress(value) { if (value.bytesChecked >= 1024 * 1024) controller.abort(); },
    }),
    error => error?.code === 'CANCELLED',
  );
});

test('rejects a symlink instead of following it as a recovered output', async t => {
  const bytes = Buffer.from('ordinary target');
  const target = path.join(directory, 'ordinary-target.txt');
  const linked = path.join(directory, 'linked-output.txt');
  await writeFile(target, bytes);
  try {
    await symlink(target, linked, 'file');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) {
      t.skip(`symlink creation unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  await assert.rejects(
    verifyRecoveredFile(linked, {
      expectedSize: bytes.length,
      expectedSha256: sha256(bytes),
      fileName: 'linked-output.txt',
    }),
    error => error?.code === 'OUTPUT_VERIFICATION_FAILED'
      && error?.details?.reason === 'OUTPUT_NOT_REGULAR_FILE',
  );
});
