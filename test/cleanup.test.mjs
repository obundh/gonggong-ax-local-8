import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RecoveryJobs } from '../engine/job-service.mjs';

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'recovery-cleanup-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outputPath = path.join(root, 'job'), resultPath = path.join(root, 'results');
  await mkdir(outputPath); await mkdir(resultPath);
  const jobs = new RecoveryJobs({ workspace: root });
  const job = { id: 'cleanup', outputPath, resultPath, status: 'complete', results: [], candidates: new Map() };
  jobs.jobs.set(job.id, job);
  return { jobs, job, outputPath, resultPath };
}

test('cleanup removes only reviewed owned temporary files across staging and results, retaining completed .tmp/.partial files', async t => {
  const { jobs, job, outputPath, resultPath } = await fixture(t);
  const pending = path.join(resultPath, '.recovery-working-test'); await mkdir(pending);
  const temporary = path.join(pending, '.recovery-writing.partial'); await writeFile(temporary, 'unfinished');
  const preview = path.join(outputPath, 'previews'); await mkdir(preview); await writeFile(path.join(preview, 'preview.txt'), 'preview');
  const saved = [path.join(resultPath, 'important.tmp'), path.join(resultPath, 'document.partial')];
  for (const file of saved) await writeFile(file, 'completed original filename');
  const review = await jobs.cleanup({ jobId: job.id });
  assert.equal(review.files.length, 2);
  await assert.rejects(jobs.cleanup({ jobId: job.id, confirmed: true }), { code: 'CLEANUP_REVIEW_REQUIRED' });
  const later = path.join(pending, '.carving-writing.partial'); await writeFile(later, 'created after review');
  await jobs.cleanup({ jobId: job.id, confirmed: true, reviewId: review.reviewId });
  await assert.rejects(readFile(temporary), { code: 'ENOENT' });
  assert.equal(await readFile(later, 'utf8'), 'created after review');
  for (const file of saved) assert.equal(await readFile(file, 'utf8'), 'completed original filename');
});

test('cleanup rejects changed reviewed bytes before deleting any files, and blocks active preview work', async t => {
  const { jobs, job, outputPath } = await fixture(t);
  const preview = path.join(outputPath, 'previews'); await mkdir(preview);
  const file = path.join(preview, 'preview.txt'); await writeFile(file, 'before');
  const review = await jobs.cleanup({ jobId: job.id });
  await writeFile(file, 'changed after review');
  await assert.rejects(jobs.cleanup({ jobId: job.id, confirmed: true, reviewId: review.reviewId }), { code: 'CLEANUP_CHANGED' });
  assert.equal(await readFile(file, 'utf8'), 'changed after review');
  job.rpcActive = true;
  await assert.rejects(jobs.cleanup({ jobId: job.id }), { code: 'BUSY' });
});
