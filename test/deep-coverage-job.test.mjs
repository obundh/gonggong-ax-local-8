import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RecoveryJobs } from '../engine/job-service.mjs';
import { createFixture } from './ntfs-fixtures.mjs';
import { createHwpFixture } from './hwp-carving-fixture.mjs';

async function wait(events, id, type) {
  const until = Date.now() + 20000;
  while (Date.now() < until) {
    const bad = events.find(e => e.jobId === id && e.type === 'error');
    if (bad) throw Error(JSON.stringify(bad));
    const found = events.find(e => e.jobId === id && e.type === type);
    if (found) return found;
    await new Promise(r => setTimeout(r, 10));
  }
  throw Error(`Missing ${type}`);
}

test('real deep worker enforces byte and output bounds and persists unexamined coverage', { timeout: 60000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'deep-coverage-job-'));
  const fixture = await createFixture(path.join(root, 'input'));
  const image = await readFile(fixture.imagePath), hwp = createHwpFixture().bytes;
  hwp.copy(image, 100 * 4096); await writeFile(fixture.imagePath, image);
  const workspace = path.join(root, 'workspace'), destination = path.join(root, 'output');
  await mkdir(workspace); await mkdir(destination);
  const events = [];
  const jobs = new RecoveryJobs({ workspace, onEvent: e => events.push(e), inspect: async target => {
    const canonicalPath = await realpath(target);
    assert.ok([workspace, destination].includes(canonicalPath));
    return { canonicalPath, identity: canonicalPath, diskIds: ['fixture-output'], freeSpace: 1e12, fileSystem: 'NTFS' };
  } });
  try {
    await jobs.initialize();
    const source = await jobs.addSource('image', fixture.imagePath), output = await jobs.addDestination(destination);
    const base = { sourceId: source.id, destinationId: output.id, mode: 'deep', deepScope: 'unallocated', filters: {} };
    await assert.rejects(jobs.start({ ...base, deepLimits: { maxScanBytes: -1 } }), { code: 'INVALID_DEEP_LIMITS' });
    assert.equal(jobs.jobs.size, 0);
    const scan = await jobs.start({ ...base, deepLimits: { maxScanBytes: 128 * 1024 } });
    const done = await wait(events, scan.jobId, 'complete');
    assert.equal(done.complete, false);
    assert.equal(done.truncated, false);
    assert.equal(done.coverage.stopReason, 'scan-byte-limit');
    assert.equal(done.coverage.scanScope, 'verified-unallocated');
    assert.ok(done.coverage.scanReadBytes <= 128 * 1024);
    assert.ok(done.coverage.examinedBytes < done.coverage.selectedBytes);
    assert.equal(done.coverage.examinedBytes + done.coverage.unexaminedBytes, done.coverage.selectedBytes);
    assert.ok(!done.warnings.some(w => w.code === 'CANDIDATE_LIMIT'));
    const job = jobs.getJob(scan.jobId); await job.persistTask;
    const saved = JSON.parse(await readFile(path.join(job.outputPath, 'job.json'), 'utf8'));
    assert.deepEqual(saved.coverage, done.coverage);
    assert.deepEqual(saved.deepLimits, { maxScanBytes: 128 * 1024 });
    const second = await jobs.start({ ...base, deepLimits: { maxOutputBytes: hwp.length - 1 } });
    const bounded = await wait(events, second.jobId, 'complete');
    assert.equal(bounded.coverage.stopReason, 'output-byte-limit');
    assert.equal(bounded.complete, false);
    assert.equal(bounded.coverage.outputBytesWritten, 0);
    assert.equal(jobs.candidates({ jobId: second.jobId }).items.filter(c => c.format === 'hwp').length, 0);
    assert.deepEqual(await readFile(fixture.imagePath), image);
  } finally { await jobs.dispose(); }
});
