import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

import { assessRecoveredBytes, verifyRecoveredFile } from '../engine/recovery-verification.mjs';

const LARGE_SIZE = 9 * 1024 * 1024;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
let directory;

before(async () => { directory = await mkdtemp(path.join(os.tmpdir(), 'recovery-large-signature-')); });
after(async () => {
  const resolved = path.resolve(directory);
  assert.equal(path.dirname(resolved).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
  assert.ok(path.basename(resolved).startsWith('recovery-large-signature-'));
  await rm(resolved, { recursive: true, force: true });
});

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

test('large image and PDF outputs still report a wrong or zero signature', async t => {
  for (const [name, expectedFormat] of [['zero.png', 'PNG'], ['zero.jpg', 'JPEG'], ['zero.pdf', 'PDF']]) {
    await t.test(name, async () => {
      const bytes = Buffer.alloc(LARGE_SIZE);
      const result = await verify(name, bytes);
      assert.equal(result.integrity.status, 'verified');
      assert.equal(result.integrity.sha256, sha256(bytes));
      assert.equal(result.document.status, 'format-mismatch');
      assert.equal(result.document.reason, 'EXTENSION_SIGNATURE_MISMATCH');
      assert.equal(result.document.expectedFormat, expectedFormat);
      assert.equal(result.document.detectedFormat, 'unknown');
      assert.equal(result.document.originalIdentityVerified, false);

      const direct = await assessRecoveredBytes(name, bytes);
      assert.equal(direct.status, 'format-mismatch');
      assert.equal(direct.reason, 'EXTENSION_SIGNATURE_MISMATCH');
      assert.equal(direct.expectedFormat, expectedFormat);
      assert.equal(direct.detectedFormat, 'unknown');
    });
  }
});

test('large output with the expected signature remains size-limited rather than fully assessed', async () => {
  const bytes = Buffer.alloc(LARGE_SIZE);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes);
  const result = await verify('header-only.png', bytes);
  assert.equal(result.integrity.status, 'verified');
  assert.equal(result.document.status, 'needs-check');
  assert.equal(result.document.reason, 'FILE_TOO_LARGE');
  assert.equal(result.document.format, 'PNG');
  assert.equal(result.document.assessmentLimited, true);
  assert.equal(result.document.originalIdentityVerified, false);

  const direct = await assessRecoveredBytes('header-only.png', bytes);
  assert.equal(direct.status, 'needs-check');
  assert.equal(direct.reason, 'FILE_TOO_LARGE');
  assert.equal(direct.format, 'PNG');
});

test('large OOXML-named OLE output keeps the encrypted Office exception', async () => {
  const bytes = Buffer.alloc(LARGE_SIZE);
  Buffer.from('d0cf11e0a1b11ae1', 'hex').copy(bytes);
  const result = await verify('possibly-encrypted.docx', bytes);
  assert.equal(result.integrity.status, 'verified');
  assert.equal(result.document.status, 'needs-check');
  assert.equal(result.document.reason, 'FILE_TOO_LARGE');
  assert.equal(result.document.format, 'OLE compound document');
  assert.equal(result.document.originalIdentityVerified, false);

  const direct = await assessRecoveredBytes('possibly-encrypted.docx', bytes);
  assert.equal(direct.status, 'needs-check');
  assert.equal(direct.reason, 'FILE_TOO_LARGE');
  assert.equal(direct.format, 'OLE compound document');
});

test('large-file verification still preserves cancellation', async () => {
  const bytes = Buffer.alloc(LARGE_SIZE, 0x61);
  const controller = new AbortController();
  await assert.rejects(
    verify('cancel.png', bytes, {
      signal: controller.signal,
      onProgress(value) { if (value.bytesChecked >= 1024 * 1024) controller.abort(); },
    }),
    error => error?.code === 'CANCELLED',
  );
});
