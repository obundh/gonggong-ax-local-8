import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Worker } from 'node:worker_threads';

import { RecoveryJobs } from '../engine/job-service.mjs';
import { createFixture } from './ntfs-fixtures.mjs';
import { createUsnFixture, journalRecords, usnRecord } from './usn-fixture.mjs';

const SEPTEMBER_12 = Date.parse('2026-09-12T00:00:00.000Z');
const SEPTEMBER_12_END = Date.parse('2026-09-12T23:59:59.999Z');
const SEPTEMBER_13 = Date.parse('2026-09-13T00:00:00.000Z');
const SEPTEMBER_13_END = Date.parse('2026-09-13T23:59:59.999Z');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const twoDayJournal = () => journalRecords([
  usnRecord({ deletedAt: '2026-09-13T02:00:00.000Z', recordNumber: 25, sequence: 3, name: 'contiguous.bin' }),
  usnRecord({ deletedAt: '2026-09-12T10:00:00.000Z', recordNumber: 24, sequence: 6, name: '삭제된-문서.txt' })
], 8 * 4096);

function inspectFixturePath(target) {
  return realpath(target).then(canonicalPath => ({
    canonicalPath,
    identity: canonicalPath,
    diskIds: ['period-test-output'],
    freeSpace: 1e12,
    fileSystem: 'NTFS'
  }));
}

function eventWaiter(events) {
  return async function waitFor(jobId, type = 'complete', timeout = 20_000) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const failure = events.find(event => event.jobId === jobId && event.type === 'error');
      if (failure) throw Object.assign(new Error(failure.message || failure.error?.message), failure.error);
      const event = events.find(item => item.jobId === jobId && item.type === type);
      if (event) return event;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for ${type} from ${jobId}`);
  };
}

function realWorkerCapture(payloads) {
  return (url, options) => {
    payloads.push(options.workerData);
    return new Worker(url, options);
  };
}

async function cleanupTemp(root, prefix) {
  const target = path.resolve(root);
  assert.equal(path.dirname(target).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
  assert.ok(path.basename(target).startsWith(prefix));
  await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

test('bounded journal-first jobs return only the selected dates and keep preview/recovery compatible', { timeout: 40_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recovery-period-job-'));
  const events = [];
  const workerPayloads = [];
  let jobs;
  try {
    const fixture = await createUsnFixture(path.join(root, 'fixture'), { journalBytes: twoDayJournal() });
    const sourceBefore = hash(await readFile(fixture.imagePath));
    const workspace = path.join(root, 'workspace');
    const destination = path.join(root, 'destination');
    await Promise.all([mkdir(workspace), mkdir(destination)]);
    jobs = new RecoveryJobs({
      workspace,
      inspect: inspectFixturePath,
      workerFactory: realWorkerCapture(workerPayloads),
      onEvent: event => events.push(event)
    });
    await jobs.initialize();
    const source = await jobs.addSource('image', fixture.imagePath);
    const output = await jobs.addDestination(destination);
    const waitFor = eventWaiter(events);

    const today = await jobs.start({
      sourceId: source.id,
      mode: 'deleted',
      filters: {
        deletedAfter: '2026-09-13T00:00:00.000Z',
        deletedBefore: '2026-09-13T23:59:59.999Z',
        includeUnknownDeletedAt: false
      }
    });
    const todayComplete = await waitFor(today.jobId);
    const todayCandidates = jobs.candidates({ jobId: today.jobId, limit: 100 });
    assert.deepEqual(todayCandidates.items.map(item => item.name), ['contiguous.bin']);
    assert.equal(todayCandidates.items[0].deletedAt, fixture.deletionTimes.get('ntfs:25:4'));
    assert.equal(todayCandidates.items[0].deletedAtSource, 'ntfs-usn');
    assert.equal(todayComplete.coverage.strategy, 'journal-first');
    assert.equal(todayComplete.coverage.requiresFullScan, true);
    assert.equal(todayComplete.coverage.deletedAfter, SEPTEMBER_13);
    assert.equal(todayComplete.coverage.deletedBefore, SEPTEMBER_13_END);
    assert.equal(todayComplete.stats.recordsTotal, 1, 'period stats count the one event target, not the fixture MFT');
    assert.equal(todayComplete.stats.recordsRead, 1);
    assert.ok(todayComplete.stats.recordsTotal < fixture.manifest.geometry.mftRecordCount);
    assert.ok(events.some(event => event.jobId === today.jobId && event.type === 'progress' && event.stage === 'journal'));
    assert.ok(events.some(event => event.jobId === today.jobId && event.type === 'progress'
      && event.stage === 'period-records' && event.stats.recordsTotal === 1));
    assert.ok(!events.some(event => event.jobId === today.jobId && event.type === 'progress'
      && event.stats?.recordsTotal === fixture.manifest.geometry.mftRecordCount), 'the bounded job never reports a global MFT walk');

    const week = await jobs.start({
      sourceId: source.id,
      destinationId: output.id,
      mode: 'deleted',
      filters: {
        deletedAfter: '2026-09-12T00:00:00.000Z',
        deletedBefore: '2026-09-13T23:59:59.999Z',
        includeUnknownDeletedAt: false
      }
    });
    const weekComplete = await waitFor(week.jobId);
    const weekCandidates = jobs.candidates({ jobId: week.jobId, sort: 'deleted-desc', limit: 100 });
    assert.deepEqual(weekCandidates.items.map(item => item.name), ['contiguous.bin', '삭제된-문서.txt']);
    assert.deepEqual(weekCandidates.items.map(item => item.deletedAt), [
      fixture.deletionTimes.get('ntfs:25:4'),
      fixture.deletionTimes.get('ntfs:24:7')
    ]);
    assert.equal(weekComplete.stats.recordsTotal, 2, 'the wider period still reads only its two target records');
    assert.equal(weekComplete.stats.recordsRead, 2);
    assert.equal(weekComplete.coverage.strategy, 'journal-first');
    assert.equal(weekComplete.coverage.partitions.length, 1);
    assert.equal(weekCandidates.coverage.strategy, 'journal-first');

    assert.equal(workerPayloads.length, 2);
    assert.equal(workerPayloads[0].deletedStrategy, 'auto');
    assert.equal(workerPayloads[0].filters.deletedAfter, SEPTEMBER_13);
    assert.equal(workerPayloads[0].filters.deletedBefore, SEPTEMBER_13_END);
    assert.equal(workerPayloads[0].resumeCheckpoint, undefined);
    assert.equal(workerPayloads[1].deletedStrategy, 'auto');
    assert.equal(workerPayloads[1].filters.deletedAfter, SEPTEMBER_12);
    assert.equal(workerPayloads[1].filters.deletedBefore, SEPTEMBER_13_END);

    const document = weekCandidates.items.find(item => item.recordNumber === 24);
    const preview = await jobs.preview({ jobId: week.jobId, id: document.id });
    assert.equal(preview.type, 'text');
    assert.match(preview.text, /회복 연진 테스트 문서/);
    const recovery = await jobs.recover({ jobId: week.jobId, ids: [document.id], destinationId: output.id });
    const saved = await waitFor(recovery.jobId, 'recover-complete');
    assert.equal(saved.results[0].status, 'saved');
    assert.equal(hash(await readFile(saved.results[0].path)), fixture.manifest.files.find(item => item.recordNumber === 24).sha256);
    assert.equal(hash(await readFile(fixture.imagePath)), sourceBefore, 'period search, preview, and recovery leave the source unchanged');
  } finally {
    await jobs?.dispose();
    await cleanupTemp(root, 'recovery-period-job-');
  }
});

test('a bounded search with no retained USN journal stays partial and never falls back to the MFT', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recovery-period-missing-usn-'));
  const events = [];
  const payloads = [];
  let jobs;
  try {
    const fixture = await createFixture(path.join(root, 'fixture'));
    jobs = new RecoveryJobs({
      workspace: path.join(root, 'workspace'),
      inspect: inspectFixturePath,
      workerFactory: realWorkerCapture(payloads),
      onEvent: event => events.push(event)
    });
    await jobs.initialize();
    const source = await jobs.addSource('image', fixture.imagePath);
    const started = await jobs.start({
      sourceId: source.id,
      mode: 'deleted',
      filters: { deletedAfter: SEPTEMBER_12, deletedBefore: SEPTEMBER_13_END, includeUnknownDeletedAt: true }
    });
    const complete = await eventWaiter(events)(started.jobId);
    const listed = jobs.candidates({ jobId: started.jobId, limit: 100 });
    assert.equal(listed.total, 0);
    assert.equal(listed.scannedTotal, 0);
    assert.equal(complete.complete, false);
    assert.equal(complete.coverage.strategy, 'journal-first');
    assert.equal(complete.coverage.requiresFullScan, true);
    assert.equal(complete.stats.recordsTotal, 0);
    assert.equal(complete.stats.recordsRead, 0);
    assert.ok(complete.warnings.some(warning => /^USN_|^PERIOD_SEARCH_/.test(warning.code)), 'the missing journal is reported');
    assert.equal(payloads[0].deletedStrategy, 'auto');
    assert.ok(!events.some(event => event.jobId === started.jobId && event.stage === 'scan'
      && event.stats?.recordsTotal === fixture.manifest.geometry.mftRecordCount), 'no full-record progress is emitted');
  } finally {
    await jobs?.dispose();
    await cleanupTemp(root, 'recovery-period-missing-usn-');
  }
});

test('explicit full search retains unknown-time records and publishes full-record coverage everywhere', { timeout: 35_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recovery-period-full-'));
  const events = [];
  const payloads = [];
  let jobs;
  try {
    const fixture = await createUsnFixture(path.join(root, 'fixture'));
    jobs = new RecoveryJobs({
      workspace: path.join(root, 'workspace'),
      inspect: inspectFixturePath,
      workerFactory: realWorkerCapture(payloads),
      onEvent: event => events.push(event)
    });
    await jobs.initialize();
    const source = await jobs.addSource('image', fixture.imagePath);
    const started = await jobs.start({
      sourceId: source.id,
      mode: 'deleted',
      deletedStrategy: 'full',
      recent: true,
      filters: { deletedAfter: SEPTEMBER_12, deletedBefore: SEPTEMBER_13_END, includeUnknownDeletedAt: true }
    });
    const complete = await eventWaiter(events)(started.jobId);
    const listed = jobs.candidates({ jobId: started.jobId, limit: 100 });
    assert.equal(listed.total, fixture.manifest.files.length);
    assert.equal(listed.scannedTotal, fixture.manifest.files.length);
    assert.equal(listed.unknownDeletedTimeTotal, fixture.manifest.files.length - 2);
    assert.equal(complete.coverage.strategy, 'full-records');
    assert.equal(complete.coverage.requiresFullScan, false);
    assert.equal(complete.coverage.deletedAfter, SEPTEMBER_12);
    assert.equal(complete.coverage.deletedBefore, SEPTEMBER_13_END);
    assert.equal(complete.stats.recordsTotal, fixture.manifest.geometry.mftRecordCount);
    assert.equal(payloads[0].deletedStrategy, 'full');
    assert.equal(payloads[0].filters.includeUnknownDeletedAt, true);
    assert.equal(jobs.candidates({ jobId: started.jobId, limit: 100 }).coverage.strategy, 'full-records');
    assert.equal(jobs.state().jobs.find(job => job.id === started.jobId).coverage.strategy, 'full-records');
    assert.equal(jobs.history().jobs.find(job => job.id === started.jobId).deletedStrategy, 'full');
  } finally {
    await jobs?.dispose();
    await cleanupTemp(root, 'recovery-period-full-');
  }
});

test('strategy and date validation happen before worker launch, while bounded restart ignores a legacy full-scan checkpoint', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recovery-period-validation-'));
  let jobs;
  try {
    const fixture = await createUsnFixture(path.join(root, 'fixture'));
    const payloads = [];
    const workers = [];
    const workerFactory = (_url, options) => {
      payloads.push(options.workerData);
      const worker = new EventEmitter();
      worker.postMessage = () => {};
      worker.terminate = async () => 0;
      worker.unref = () => {};
      workers.push(worker);
      return worker;
    };
    jobs = new RecoveryJobs({ workspace: path.join(root, 'workspace'), inspect: inspectFixturePath, workerFactory });
    await jobs.initialize();
    const source = await jobs.addSource('image', fixture.imagePath);
    await assert.rejects(jobs.start({ sourceId: source.id, mode: 'deleted', deletedStrategy: 'fastest', filters: {} }), { code: 'INVALID_STRATEGY' });
    await assert.rejects(jobs.start({
      sourceId: source.id,
      mode: 'deleted',
      filters: { deletedAfter: '2026-09-14T00:00:00Z', deletedBefore: '2026-09-13T23:59:59Z' }
    }), RangeError);
    assert.equal(payloads.length, 0);

    const sourceState = jobs.sources.get(source.id);
    jobs.savedHistory.set('legacy-full-job', {
      id: 'legacy-full-job',
      sourceIdentity: sourceState.identity,
      sourceKind: sourceState.kind,
      checkpointHash: 'not-a-real-checkpoint',
      outputPath: path.join(root, 'missing-legacy-job')
    });
    const restarted = await jobs.start({
      sourceId: source.id,
      mode: 'deleted',
      resumeId: 'legacy-full-job',
      filters: {
        deletedAfter: '2026-09-12T10:00:00.000Z',
        deletedBefore: '2026-09-12T10:00:00.000Z',
        includeUnknownDeletedAt: false
      }
    });
    assert.equal(restarted.coverage.strategy, 'journal-first');
    assert.equal(payloads.length, 1);
    assert.equal(payloads[0].resumeCheckpoint, undefined);
    assert.equal(payloads[0].filters.deletedAfter, Date.parse('2026-09-12T10:00:00.000Z'));
    assert.equal(payloads[0].filters.deletedBefore, Date.parse('2026-09-12T10:00:00.000Z'), 'equal inclusive boundaries are preserved');
  } finally {
    await jobs?.dispose();
    await cleanupTemp(root, 'recovery-period-validation-');
  }
});
