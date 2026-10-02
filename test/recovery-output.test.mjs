import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openNtfsImage, safeOutputName } from '../engine/ntfs-image.mjs';
import { createFixture } from './ntfs-fixtures.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('long document names keep the extension and complete Unicode characters', () => {
  for (const extension of ['.docx', '.hwp', '.hwpx', '.PDF']) {
    for (const length of [181, 195, 255]) {
      const original = '가'.repeat(length - extension.length) + extension;
      const saved = safeOutputName(original, 24);
      assert.equal(saved.length, 180);
      assert.equal(path.extname(saved), extension);
    }
    const emoji = safeOutputName('🗃'.repeat(100) + extension, 24);
    assert.equal(emoji.isWellFormed(), true);
    assert.equal(path.extname(emoji), extension);
    assert.ok(emoji.length <= 180);
  }
});

test('NTFS restores byte-identical output under a bounded basename without overwriting earlier output', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recovery-output-'));
  const fixture = await createFixture(path.join(root, 'fixture'));
  const sourceHash = hash(await readFile(fixture.imagePath));
  const image = await openNtfsImage(fixture.imagePath);
  try {
    await image.scanDeleted();
    const output = path.join(root, 'output');
    const first = await image.recover(24, output, { outputName: '원래 문서.txt' });
    const second = await image.recover(24, output, { outputName: '원래 문서.txt' });
    const unsafe = await image.recover(24, output, { outputName: '../CON:secret.txt' });
    for (const result of [first, second, unsafe]) {
      assert.equal(hash(await readFile(result.path)), fixture.manifest.files.find(f => f.recordNumber === 24).sha256);
      assert.equal(result.integrity.status, 'verified');
      assert.equal(result.document.status, 'preview-available');
      assert.equal(result.originalIdentityVerified, false);
      const relative = path.relative(output, result.path);
      assert.equal(relative.startsWith('..'), false);
      assert.equal(path.isAbsolute(relative), false);
      assert.doesNotMatch(path.basename(result.path), /[\\/:]/);
    }
    assert.equal(path.basename(first.path), '원래 문서.txt');
    assert.notEqual(first.path, second.path);
    assert.equal(hash(await readFile(fixture.imagePath)), sourceHash);
  } finally { await image.close(); }
});

test('cancellation during output verification never publishes a completed NTFS file', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recovery-output-cancel-'));
  const fixture = await createFixture(path.join(root, 'fixture'));
  const image = await openNtfsImage(fixture.imagePath);
  try {
    await image.scanDeleted();
    const controller = new AbortController(), output = path.join(root, 'output');
    await assert.rejects(image.recover(25, output, {
      signal: controller.signal,
      onProgress(event) { if (event.stage === 'verify-recovery') controller.abort(); },
    }), error => error.code === 'CANCELLED' && error.details.partialPath && !error.details.savedPath);
    assert.equal((await readdir(output)).some(name => name.startsWith('recovered-')), false);
  } finally { await image.close(); }
});
