import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { carveFiles } from '../engine/carving.mjs';
import { openImageBytes } from '../engine/byte-source.mjs';
import { existingCandidate } from '../engine/file-search.mjs';

const MIB = 1024 * 1024;
const ROOT = path.resolve(process.env.RECOVERY_RESUME_TEST_ROOT ?? 'E:/RecoveryChat-DeepResume-0601-20260927/temp');
const pdf = (label, length = 0) => Buffer.concat([Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Label (${label}) >>\nendobj\n`), Buffer.alloc(length, 32), Buffer.from('\n%%EOF\n')]);
async function fixture(callback, { size = 4 * MIB, entries = [[32, pdf('first')], [MIB - 2, pdf('boundary')], [3 * MIB + 12, pdf('last')]] } = {}) {
  await mkdir(ROOT, { recursive: true });
  const root = await mkdtemp(path.join(ROOT, 'checkpoint-'));
  const bytes = Buffer.alloc(size);
  for (const [offset, file] of entries) file.copy(bytes, offset);
  const imagePath = path.join(root, 'source.raw');
  await writeFile(imagePath, bytes);
  const run = async (name, options = {}, wrap) => {
    const provider = await openImageBytes(imagePath);
    let saved;
    const reads = [];
    const original = provider.read.bind(provider);
    provider.read = async (...args) => { reads.push({ offset: args[0], length: args[1] }); return original(...args); };
    wrap?.(provider);
    try {
      const result = await carveFiles(provider, path.join(root, name), { ...options, onCheckpoint(value) { saved = value; options.onCheckpoint?.(value); } });
      return { ...result, saved, reads };
    } catch (error) {
      error.saved = saved;
      error.reads = reads;
      throw error;
    } finally { await provider.close(); }
  };
  try { await callback({ root, imagePath, bytes, entries, run }); }
  finally {
    const relative = path.relative(ROOT, path.resolve(root));
    assert.ok(relative.startsWith('checkpoint-') && !relative.includes(path.sep) && !path.isAbsolute(relative));
    await rm(root, { recursive: true, force: true });
  }
}

test('scan limit resumes across a split signature without rereading the prefix or duplicating candidates', async () => fixture(async ({ root, run, entries, bytes }) => {
  const first = await run('first', { maxScanBytes: MIB });
  assert.equal(first.complete, false);
  assert.equal(first.saved.cursor, MIB - 7);
  assert.equal(first.candidates.length, 1);
  const emitted = [];
  const resumed = await run('second', { resumeFrom: JSON.parse(JSON.stringify(first.saved)), resumeRoots: [path.join(root, 'first')], onCandidate: value => emitted.push(value) });
  assert.equal(resumed.complete, true);
  assert.equal(resumed.candidates.length, 3);
  assert.equal(new Set(emitted.map(c => c.id)).size, 3);
  assert.equal(resumed.reads[0].offset, MIB - 7);
  assert.equal(resumed.coverage.examinedBytes, bytes.length);
  assert.equal(resumed.coverage.unexaminedBytes, 0);
  assert.equal(resumed.coverage.scanReadBytes, bytes.length + 7);
  assert.equal(resumed.candidates[0].path, first.candidates[0].path);
  for (const [offset, expected] of entries) assert.deepEqual(await readFile(resumed.candidates.find(c => c.offset === offset).path), expected);
}));

test('output limit retries the unsaved hit with a fresh per-pass output budget', async () => fixture(async ({ root, run, entries }) => {
  const first = await run('first', { maxOutputBytes: entries[0][1].length });
  assert.equal(first.coverage.stopReason, 'output-byte-limit');
  assert.equal(first.saved.cursor, entries[1][0]);
  const resumed = await run('second', { resumeFrom: first.saved, resumeRoots: [path.join(root, 'first')], maxOutputBytes: entries[1][1].length + entries[2][1].length });
  assert.equal(resumed.complete, true);
  assert.equal(resumed.candidates.length, 3);
  assert.equal(resumed.coverage.outputBytesWritten, entries.reduce((n, entry) => n + entry[1].length, 0));
}));

test('cancel while writing retains partial bytes but retries the pending file on restart', async () => fixture(async ({ root, run, entries }) => {
  const abort = new AbortController();
  let interrupted;
  await assert.rejects(run('first', { signal: abort.signal, onProgress(event) { if (event.phase === 'extract' && event.offset === entries[1][0]) abort.abort(); } }), error => {
    interrupted = error;
    return error.code === 'CANCELLED';
  });
  assert.equal(interrupted.saved.candidates.length, 1);
  assert.equal(interrupted.saved.cursor, entries[1][0]);
  const resumed = await run('second', { resumeFrom: interrupted.saved, resumeRoots: [path.join(root, 'first')] });
  assert.equal(resumed.complete, true);
  assert.equal(resumed.candidates.length, 2);
  assert.deepEqual(await readFile(resumed.candidates[1].path), entries[1][1]);
  assert.ok(resumed.coverage.outputBytesWritten > entries.reduce((n, entry) => n + entry[1].length, 0), 'partial writes remain in cumulative accounting');
}, { entries: [[32, pdf('first')], [MIB + 20, pdf('large', 2 * MIB)]], size: 5 * MIB }));

test('changed image, changed selection, and native-volume resume are rejected before a source read', async () => fixture(async ({ root, run, imagePath, bytes }) => {
  const first = await run('first', { maxScanBytes: MIB });
  const options = { resumeFrom: first.saved, resumeRoots: [path.join(root, 'first')] };
  await assert.rejects(run('scope', { ...options, ranges: [{ offset: 0, length: 2 * MIB }] }), error => error.code === 'CHECKPOINT_SCOPE_CHANGED' && error.reads.length === 0);
  await assert.rejects(run('volume', options, provider => { provider.info.sourceKind = 'volume'; }), error => error.code === 'SOURCE_CHANGED' && error.reads.length === 0);
  bytes[400] = 1;
  await writeFile(imagePath, bytes);
  await assert.rejects(run('changed', options), error => error.code === 'SOURCE_CHANGED' && error.reads.length === 0);
}));

test('missing, altered, and untrusted prior artifacts fail closed without publishing old candidates', async () => fixture(async ({ root, run }) => {
  const first = await run('first', { maxScanBytes: MIB });
  const options = { resumeFrom: first.saved, resumeRoots: [path.join(root, 'first')], onCandidate() { assert.fail('invalid prior candidate published'); } };
  await assert.rejects(run('untrusted', { ...options, resumeRoots: [] }), { code: 'CHECKPOINT_ARTIFACT_CHANGED' });
  const file = first.candidates[0].path;
  const altered = await readFile(file);
  altered[10] ^= 1;
  await writeFile(file, altered);
  // Even matching current file metadata cannot replace the original content digest.
  first.saved.candidates[0].candidate.identity = (await existingCandidate(file, path.join(root, 'first'))).identity;
  await assert.rejects(run('altered', options), { code: 'CHECKPOINT_ARTIFACT_CHANGED' });
  await rm(file);
  await assert.rejects(run('missing', options), { code: 'CHECKPOINT_ARTIFACT_CHANGED' });
}));

test('candidate cap remains global across continuation and prevents false completion', async () => fixture(async ({ root, run }) => {
  const first = await run('first', { maxCandidates: 1 });
  const resumed = await run('second', { maxCandidates: 1, resumeFrom: first.saved, resumeRoots: [path.join(root, 'first')] });
  assert.equal(resumed.candidates.length, 1);
  assert.equal(resumed.complete, false);
  assert.equal(resumed.coverage.stopReason, 'candidate-limit');
  assert.equal(resumed.reads.length, 0);
}));

test('read errors remain unexamined across resume and cannot become completed coverage', async () => fixture(async ({ root, run }) => {
  const first = await run('first', { maxScanBytes: MIB }, provider => {
    const read = provider.read;
    let failed = false;
    provider.read = async (...args) => { if (!failed) { failed = true; throw Object.assign(new Error('synthetic read failure'), { code: 'EIO' }); } return read(...args); };
  });
  const resumed = await run('second', { resumeFrom: first.saved, resumeRoots: [path.join(root, 'first')] });
  assert.equal(resumed.complete, false);
  assert.equal(resumed.coverage.readErrorBytes, MIB);
  assert.ok(resumed.coverage.unexaminedBytes >= MIB);
}));

test('checkpoint preserves all disjoint intervals beyond public UI range truncation', async () => fixture(async ({ root, run }) => {
  const ranges = Array.from({ length: 1100 }, (_, i) => ({ offset: i * 32, length: 16 }));
  const first = await run('first', { ranges, maxScanBytes: 1050 * 16 });
  assert.equal(first.coverage.rangesTruncated, true);
  assert.equal(first.saved.coverageState.examinedRanges.length, 1050);
  const resumed = await run('second', { ranges, resumeFrom: first.saved, resumeRoots: [path.join(root, 'first')] });
  assert.equal(resumed.complete, true);
  assert.equal(resumed.coverage.examinedBytes, 1100 * 16);
  assert.equal(resumed.coverage.unexaminedBytes, 0);
}, { entries: [], size: 40000 }));

test('multiple fresh output folders carry prior artifacts and cumulative coverage over three runs', async () => fixture(async ({ root, run, bytes }) => {
  const first = await run('first', { maxScanBytes: MIB });
  const second = await run('second', { maxScanBytes: MIB, resumeFrom: first.saved, resumeRoots: [path.join(root, 'first')] });
  const third = await run('third', { resumeFrom: second.saved, resumeRoots: ['first', 'second'].map(name => path.join(root, name)) });
  assert.equal(third.complete, true);
  assert.equal(third.candidates.length, 3);
  assert.equal(third.coverage.scanReadBytes, bytes.length + 14);
}));
