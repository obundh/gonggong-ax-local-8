import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, open, readFile, realpath, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { RecoveryJobs } from '../engine/job-service.mjs';
import { createFixture } from './ntfs-fixtures.mjs';
import { createHwpFixture } from './hwp-carving-fixture.mjs';

const EVIDENCE = process.env.RECOVERY_DEEP_RESUME_EVIDENCE || 'E:/RecoveryChat-DeepResume-0601-20260927/integration';
const fixedTime = new Date('2026-09-27T00:00:00.000Z');

async function waitFor(events, jobId, type, timeout = 30000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const found = events.find(event => event.jobId === jobId && event.type === type);
    if (found) return found;
    const failure = events.find(event => event.jobId === jobId && event.type === 'error');
    if (failure && type !== 'error') throw Object.assign(new Error(failure.message), failure.error);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Missing ${type} for ${jobId}`);
}

async function makeService(workspace, destination, events) {
  const jobs = new RecoveryJobs({ workspace, onEvent: event => events.push(event), inspect: async target => {
    const canonicalPath = await realpath(target);
    assert.ok([await realpath(workspace), await realpath(destination)].includes(canonicalPath));
    return { canonicalPath, identity: canonicalPath, diskIds: ['fixture-output'], freeSpace: 1e12, fileSystem: 'NTFS' };
  } });
  await jobs.initialize();
  return jobs;
}

test('real image deep scan resumes after restart with verified prior artifacts and cumulative coverage', { timeout: 120000 }, async () => {
  await mkdir(EVIDENCE, { recursive: true });
  const run = await mkdtemp(path.join(EVIDENCE, 'run-'));
  const fixture = await createFixture(path.join(run, 'input'));
  const image = await readFile(fixture.imagePath);
  const hwp = createHwpFixture().bytes;
  const firstOffset = 256 * 1024, secondOffset = 2 * 1024 * 1024;
  hwp.copy(image, firstOffset); hwp.copy(image, secondOffset);
  await writeFile(fixture.imagePath, image);
  await utimes(fixture.imagePath, fixedTime, fixedTime);
  const originalImage = await readFile(fixture.imagePath);
  const workspace = path.join(run, 'workspace'), destination = path.join(run, 'output');
  await mkdir(workspace); await mkdir(destination);

  const firstEvents = [];
  const firstJobs = await makeService(workspace, destination, firstEvents);
  let firstJobId, firstOutput, firstCandidate;
  try {
    const source = await firstJobs.addSource('image', fixture.imagePath);
    const output = await firstJobs.addDestination(destination);
    const started = await firstJobs.start({ sourceId: source.id, destinationId: output.id, mode: 'deep',
      deepScope: 'whole', deepLimits: { maxScanBytes: 1024 * 1024 }, filters: {} });
    firstJobId = started.jobId;
    const done = await waitFor(firstEvents, firstJobId, 'complete');
    assert.equal(done.complete, false);
    assert.equal(done.coverage.stopReason, 'scan-byte-limit');
    firstCandidate = firstJobs.candidates({ jobId: firstJobId, offset: 0, limit: 100 }).items
      .find(candidate => candidate.offset === firstOffset && candidate.format === 'hwp');
    assert.ok(firstCandidate, 'the first pass must publish the earlier carved HWP');
    firstOutput = firstJobs.getJob(firstJobId).outputPath;
    assert.equal(firstCandidate.rootPath, firstOutput);
    await firstJobs.getJob(firstJobId).persistTask;
    assert.equal(firstJobs.history().jobs.find(job => job.id === firstJobId).canContinue, true);
  } finally { await firstJobs.dispose(); }

  const secondEvents = [];
  const secondJobs = await makeService(workspace, destination, secondEvents);
  let secondJobId, secondOutput, secondCandidate;
  try {
    const source = await secondJobs.addSource('image', fixture.imagePath);
    const output = await secondJobs.addDestination(destination);
    const started = await secondJobs.start({ sourceId: source.id, destinationId: output.id, mode: 'deep',
      deepScope: 'whole', resumeId: firstJobId, filters: {} });
    secondJobId = started.jobId;
    const done = await waitFor(secondEvents, secondJobId, 'complete');
    assert.equal(done.complete, true);
    assert.equal(done.coverage.stopReason, 'end-of-ranges');
    assert.equal(done.coverage.unexaminedBytes, 0);
    assert.equal(done.coverage.examinedBytes, done.coverage.selectedBytes);
    assert.ok(done.coverage.scanReadBytes > 1024 * 1024, 'coverage must include both passes');
    const items = secondJobs.candidates({ jobId: secondJobId, offset: 0, limit: 100 }).items;
    assert.equal(new Set(items.map(candidate => candidate.id)).size, items.length, 'restored candidates must not duplicate');
    const restored = items.find(candidate => candidate.id === firstCandidate.id);
    secondCandidate = items.find(candidate => candidate.offset === secondOffset && candidate.format === 'hwp');
    assert.ok(restored); assert.ok(secondCandidate);
    assert.equal(restored.path, firstCandidate.path);
    assert.equal(restored.rootPath, firstOutput);
    secondOutput = secondJobs.getJob(secondJobId).outputPath;
    assert.notEqual(secondOutput, firstOutput);
    assert.equal(secondCandidate.rootPath, secondOutput);
    await secondJobs.getJob(secondJobId).persistTask;
    const saved = JSON.parse(await readFile(path.join(secondOutput, 'job.json'), 'utf8'));
    assert.deepEqual(saved.resumeRoots, [firstOutput, secondOutput]);
    const recovery = await secondJobs.recover({ jobId: secondJobId, ids: [restored.id, secondCandidate.id], destinationId: output.id });
    const recovered = await waitFor(secondEvents, recovery.jobId, 'recover-complete');
    assert.deepEqual(recovered.results.map(item => item.status), ['saved', 'saved']);
    for (const item of recovered.results) assert.deepEqual(await readFile(item.path), hwp, 'old and new staging roots must both save exact verified bytes');
    await assert.rejects(secondJobs.start({ sourceId: source.id, destinationId: output.id, mode: 'deep',
      deepScope: 'unallocated', resumeId: secondJobId, filters: {} }), { code: 'CHECKPOINT_SCOPE_CHANGED' });
  } finally { await secondJobs.dispose(); }

  const artifact = Buffer.from(await readFile(firstCandidate.path));
  artifact[0] ^= 0xff;
  await writeFile(firstCandidate.path, artifact);
  const artifactEvents = [];
  const artifactJobs = await makeService(workspace, destination, artifactEvents);
  try {
    const source = await artifactJobs.addSource('image', fixture.imagePath);
    const output = await artifactJobs.addDestination(destination);
    const started = await artifactJobs.start({ sourceId: source.id, destinationId: output.id, mode: 'deep',
      deepScope: 'whole', resumeId: secondJobId, filters: {} });
    const failure = await waitFor(artifactEvents, started.jobId, 'error');
    assert.equal(failure.error.code, 'CHECKPOINT_ARTIFACT_CHANGED');
  } finally { await artifactJobs.dispose(); }

  const beforeChange = await stat(fixture.imagePath, { bigint: true });
  const handle = await open(fixture.imagePath, 'r+');
  try {
    const byte = Buffer.alloc(1); await handle.read(byte, 0, 1, 3 * 1024 * 1024); byte[0] ^= 0xff;
    await handle.write(byte, 0, 1, 3 * 1024 * 1024); await handle.sync();
  } finally { await handle.close(); }
  await utimes(fixture.imagePath, fixedTime, fixedTime);
  const changedEvents = [];
  const changedJobs = await makeService(workspace, destination, changedEvents);
  try {
    const source = await changedJobs.addSource('image', fixture.imagePath);
    const prior = changedJobs.savedHistory.get(secondJobId);
    assert.equal(changedJobs.sources.get(source.id).identity, prior.sourceIdentity, '4-field history identity is intentionally unchanged');
    assert.notEqual((await stat(fixture.imagePath, { bigint: true })).ctimeNs, beforeChange.ctimeNs);
    const output = await changedJobs.addDestination(destination);
    const started = await changedJobs.start({ sourceId: source.id, destinationId: output.id, mode: 'deep',
      deepScope: 'whole', resumeId: secondJobId, filters: {} });
    const failure = await waitFor(changedEvents, started.jobId, 'error');
    assert.equal(failure.error.code, 'SOURCE_CHANGED');
    assert.notDeepEqual(await readFile(fixture.imagePath), originalImage);
  } finally { await changedJobs.dispose(); }

  await writeFile(path.join(run, 'receipt.json'), JSON.stringify({ firstJobId, secondJobId, firstOutput, secondOutput,
    firstCandidate: { id: firstCandidate.id, path: firstCandidate.path }, secondCandidate: { id: secondCandidate.id, path: secondCandidate.path },
    restartResume: true, cumulativeCoverage: true, duplicateCandidates: false, priorAndNewArtifactsSavedExactly: true, changedArtifactRejected: true,
    changedImageWithRestoredMtimeRejected: true, sourceWasReadOnlyDuringScans: true }, null, 2));
});
