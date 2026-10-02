import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { discoverRecycleRoots, searchRecycleBin, recoverRecycleCandidate } from '../engine/recycle-bin.mjs';

async function isolated(run) {
  const temporary = path.resolve(os.tmpdir());
  const root = await mkdtemp(path.join(temporary, 'recoverychat-recycle-test-'));
  const bin = path.join(root, 'bin'), output = path.join(root, 'output');
  await mkdir(bin); await mkdir(output);
  try { await run({ root, bin, output }); }
  finally { const relative = path.relative(temporary, root); assert.ok(relative.startsWith('recoverychat-recycle-test-') && !relative.includes(path.sep)); await rm(root, { recursive: true, force: true }); }
}

function metadata(originalPath, size, date, version = 2) {
  const text = Buffer.from(originalPath + '\0', 'utf16le');
  const bytes = Buffer.alloc(version === 1 ? 544 : 28 + text.length);
  bytes.writeBigUInt64LE(BigInt(version), 0); bytes.writeBigUInt64LE(BigInt(size), 8);
  bytes.writeBigUInt64LE(date ? (BigInt(Date.parse(date)) + 11644473600000n) * 10000n : 0n, 16);
  if (version === 2) bytes.writeUInt32LE(text.length / 2, 24);
  text.copy(bytes, version === 1 ? 24 : 28);
  return bytes;
}

async function pair(bin, suffix, originalPath, content, date, version = 2) {
  const payload = path.join(bin, '$R' + suffix), index = path.join(bin, '$I' + suffix);
  await writeFile(payload, content); await writeFile(index, metadata(originalPath, Buffer.byteLength(content), date, version));
  return { payload, index };
}

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('Recycle Bin v1/v2 use actual metadata dates, newest first; unknown stays last without scan writes', async () => isolated(async ({ bin, output }) => {
  const entries = [
    await pair(bin, 'OLDER1.txt', 'C:\\문서\\어제.txt', 'older', '2026-09-12T00:00:00Z', 1),
    await pair(bin, 'NEWER2.txt', 'D:\\자료\\오늘.txt', 'newer', '2026-09-13T00:00:00Z'),
    await pair(bin, 'NO_DATE.txt', 'C:\\문서\\시각 미상.txt', 'unknown', null)
  ];
  const before = await Promise.all(entries.flatMap(entry => [entry.index, entry.payload]).map(async file => hash(await readFile(file))));
  const result = await searchRecycleBin([{ path: bin }]);
  assert.deepEqual(result.candidates.map(candidate => candidate.name), ['오늘.txt', '어제.txt', '시각 미상.txt']);
  assert.equal(result.candidates[0].deletedAt, '2026-09-13T00:00:00.000Z');
  assert.equal(result.candidates[0].deletedAtSource, 'recycle-metadata');
  assert.equal(result.candidates[0].originalPath, 'D:\\자료\\오늘.txt');
  assert.equal(result.candidates[2].deletedAt, null);
  assert.equal(result.complete, false); assert.ok(result.warnings.some(item => item.code === 'RECYCLE_TIME_UNKNOWN'));
  assert.deepEqual(await readdir(output), []);
  assert.deepEqual(await Promise.all(entries.flatMap(entry => [entry.index, entry.payload]).map(async file => hash(await readFile(file)))), before);
}));

test('Recycle Bin copies under original filename on the same disk without removing or overwriting originals', async () => isolated(async ({ bin, output }) => {
  const entry = await pair(bin, 'ABCDEF.txt', 'C:\\문서\\예산 보고서.txt', 'safe content', '2026-09-13T00:00:00Z');
  const infoBefore = await readFile(entry.index), sourceBefore = await readFile(entry.payload);
  const result = await searchRecycleBin([{ path: bin }]);
  assert.equal(result.complete, true);
  const first = await recoverRecycleCandidate(result.candidates[0], output);
  const second = await recoverRecycleCandidate(result.candidates[0], output);
  assert.equal(first.status, 'saved'); assert.equal(path.basename(first.path), '예산 보고서.txt');
  assert.notEqual(first.path, second.path);
  assert.equal(await readFile(first.path, 'utf8'), 'safe content');
  assert.deepEqual(await readFile(entry.index), infoBefore); assert.deepEqual(await readFile(entry.payload), sourceBefore);
}));

test('Recycle Bin candidate rejects changed metadata before any destination write', async () => isolated(async ({ bin, output }) => {
  const entry = await pair(bin, 'CHANGE.txt', 'C:\\문서\\first.txt', 'payload', '2026-09-13T00:00:00Z');
  const { candidates } = await searchRecycleBin([{ path: bin }]);
  await writeFile(entry.index, metadata('C:\\문서\\other.txt', 7, '2026-09-13T00:00:00Z'));
  await assert.rejects(recoverRecycleCandidate(candidates[0], output), { code: 'SOURCE_CHANGED' });
  assert.deepEqual(await readdir(output), []);
}));

test('Recycle Bin candidate rejects changed payload and saving inside the scanned bin', async () => isolated(async ({ bin, output }) => {
  const entry = await pair(bin, 'PAYLOAD.txt', 'C:\\문서\\source.txt', 'original', '2026-09-13T00:00:00Z');
  const { candidates } = await searchRecycleBin([{ path: bin }]);
  await assert.rejects(recoverRecycleCandidate(candidates[0], bin), { code: 'UNSAFE_OUTPUT' });
  await writeFile(entry.payload, 'replaced');
  await assert.rejects(recoverRecycleCandidate(candidates[0], output), { code: 'SOURCE_CHANGED' });
  assert.deepEqual(await readdir(output), []);
}));

test('Recycle Bin folder and mismatched-size entries remain visible as unsupported', async () => isolated(async ({ bin, output }) => {
  await mkdir(path.join(bin, '$RFOLDER'));
  await writeFile(path.join(bin, '$IFOLDER'), metadata('C:\\문서\\폴더', 300, '2026-09-13T00:00:00Z'));
  await pair(bin, 'SIZE.txt', 'C:\\문서\\different.txt', 'abc', '2026-09-12T00:00:00Z');
  await writeFile(path.join(bin, '$ISIZE.txt'), metadata('C:\\문서\\different.txt', 99, '2026-09-12T00:00:00Z'));
  const { candidates } = await searchRecycleBin([{ path: bin }]);
  assert.equal(candidates.length, 2); assert.ok(candidates.every(item => item.status === 'unsupported'));
  assert.ok(candidates.find(item => item.name === '폴더').isDirectory);
  await assert.rejects(recoverRecycleCandidate(candidates[0], output), { code: 'INVALID_CANDIDATE' });
}));

test('Recycle Bin malformed metadata, unsupported versions, absent pair are explicit partial scan', async () => isolated(async ({ bin }) => {
  await pair(bin, 'VALID.txt', 'C:\\문서\\valid.txt', 'valid', '2026-09-13T00:00:00Z');
  await writeFile(path.join(bin, '$ISHORT.txt'), Buffer.alloc(8));
  const unsupported = metadata('C:\\a.txt', 1, null); unsupported.writeBigUInt64LE(3n); await writeFile(path.join(bin, '$IFUTURE.txt'), unsupported);
  await writeFile(path.join(bin, '$IMISSING.txt'), metadata('C:\\lost.txt', 1, null));
  const result = await searchRecycleBin([{ path: bin }]);
  assert.deepEqual(result.candidates.map(item => item.name), ['valid.txt']);
  assert.equal(result.complete, false); assert.equal(result.warnings.length, 3);
}));

test('Recycle Bin candidate and cancellation limits are honored', async () => isolated(async ({ bin }) => {
  await pair(bin, 'FIRST.txt', 'C:\\문서\\first.txt', 'a', '2026-09-13T00:00:00Z');
  await pair(bin, 'SECOND.txt', 'C:\\문서\\second.txt', 'b', '2026-09-12T00:00:00Z');
  const result = await searchRecycleBin([{ path: bin }], { maxCandidates: 1 });
  assert.equal(result.candidates.length, 1); assert.equal(result.truncated, true); assert.equal(result.complete, false);
  const controller = new AbortController();
  await assert.rejects(searchRecycleBin([{ path: bin }], { signal: controller.signal, onCandidate: () => controller.abort() }), { code: 'CANCELLED' });
  await assert.rejects(searchRecycleBin([{ path: bin }], { maxCandidates: 10001 }), { code: 'INVALID_LIMIT' });
}));

test('Recycle Bin metadata mutation during copy cannot publish a completed file', async () => isolated(async ({ bin, output }) => {
  const entry = await pair(bin, 'DURING.bin', 'C:\\문서\\during.bin', Buffer.alloc(2 * 1024 * 1024, 7), '2026-09-13T00:00:00Z');
  const { candidates } = await searchRecycleBin([{ path: bin }]);
  let changed = false;
  await assert.rejects(recoverRecycleCandidate(candidates[0], output, { onProgress: event => { if (!changed && event.phase === 'copy') { changed = true; appendFileSync(entry.index, Buffer.from([0])); } } }), { code: 'SOURCE_CHANGED' });
  const dirs = await readdir(output, { withFileTypes: true });
  for (const dir of dirs) assert.ok((await readdir(path.join(output, dir.name))).every(name => name === '.recovery-writing.partial'));
}));

test('Recycle Bin directory junction payload is skipped and discovery rejects a non-SID', async t => isolated(async ({ root, bin }) => {
  const outside = path.join(root, 'outside'); await mkdir(outside); await writeFile(path.join(outside, 'private.txt'), 'private');
  try { await symlink(outside, path.join(bin, '$RJUNCTION'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('Junction creation unavailable'); throw error; }
  await writeFile(path.join(bin, '$IJUNCTION'), metadata('C:\\문서\\junction', 0, '2026-09-13T00:00:00Z'));
  const result = await searchRecycleBin([{ path: bin }]);
  assert.equal(result.candidates.length, 0); assert.equal(result.complete, false);
  await assert.rejects(discoverRecycleRoots({ getSid: async () => '../other-user', inventory: async () => [] }), { code: 'RECYCLE_UNAVAILABLE' });
}));
