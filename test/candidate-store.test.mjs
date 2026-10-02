import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { openCandidateStore, setBoundedCandidate, mergeCandidateBatch, MAX_JOB_CANDIDATES } from '../engine/candidate-store.mjs';
import { RecoveryJobs } from '../engine/job-service.mjs';
import { createFixture } from './ntfs-fixtures.mjs';

test('repeated index batches remain bounded and known-file updates survive capacity', () => {
  const store = new Map();
  const add = candidate => setBoundedCandidate(store, candidate);
  const batch = Array.from({ length: MAX_JOB_CANDIDATES }, (_, index) => ({ id: `first-${index}`, name: '문서.txt' }));
  assert.deepEqual(mergeCandidateBatch(batch, add), { imported: 10000, skippedByLimit: 0, truncated: false });
  for (let index = 0; index < 3; index++) {
    assert.deepEqual(mergeCandidateBatch(batch.map(c => ({ ...c, id: `next-${index}-${c.id}` })), add), { imported: 0, skippedByLimit: 10000, truncated: true });
    assert.equal(store.size, 10000);
  }
  assert.deepEqual(mergeCandidateBatch([{ ...batch[0], semanticScore: 95 }], add), { imported: 1, skippedByLimit: 0, truncated: false });
  assert.equal(store.get('first-0').semanticScore, 95);
});

test('main candidate cache receives semantic updates at capacity and records truncated imports', async () => {
  const jobs = new RecoveryJobs({ workspace: os.tmpdir() });
  jobs.persist = async () => {};
  const job = { id: 'bounded', candidates: new Map(), complete: true, warnings: [] };
  for (let i = 0; i < 10000; i++) jobs.receive(job, { type: 'candidate', candidate: { id: String(i) } });
  jobs.receive(job, { type: 'candidate', candidate: { id: 'overflow' } });
  jobs.receive(job, { type: 'candidate', candidate: { id: '0', semanticScore: 99 } });
  assert.equal(job.candidates.size, 10000);
  assert.equal(job.candidates.get('0').semanticScore, 99);
  jobs.receive(job, { type: 'candidate-limit', message: 'limit' });
  await job.persistTask;
  assert.equal(job.complete, false);
  assert.equal(job.warnings[0].code, 'CANDIDATE_LIMIT');
});

test('disk candidate store keeps, updates, filters and reopens candidates beyond 10,000 with BigInts intact', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recovery-candidate-store-'));
  const storePath = path.join(root, 'candidates.sqlite');
  let store = openCandidateStore(storePath);
  try {
    for (let index = 0; index < 10025; index++) {
      const special = index === 10020;
      assert.equal(store.set(`candidate-${index}`, { id: `candidate-${index}`,
        name: special ? '10천 이후 정답.docx' : `일반-${String(index).padStart(5, '0')}.txt`,
        kind: special ? 'document' : 'text', size: index, recordReference: special ? 9007199254740995n : BigInt(index),
        deletedAt: index % 2 ? null : new Date(1700000000000 + index).toISOString(), source: 'deleted-record' }), true);
    }
    assert.equal(store.size, 10025);
    const afterTenThousand = store.page({ offset: 10000, limit: 25 });
    assert.equal(afterTenThousand.items.length, 25);
    assert.equal(afterTenThousand.items[20].id, 'candidate-10020');
    assert.equal(afterTenThousand.hasMore, false);
    assert.equal(afterTenThousand.nextOffset, null);

    const filtered = store.page({ offset: 0, limit: 5, filters: { extensions: ['docx'], name: '정답' }, sort: 'score-desc' });
    assert.equal(filtered.total, 1);
    assert.equal(filtered.items[0].id, 'candidate-10020');
    assert.equal(filtered.items[0].recordReference, 9007199254740995n);
    assert.equal(filtered.unknownDeletedTimeTotal, 0);
    assert.equal(path.dirname(store.pageStorePath), root, 'page scratch stays beside the validated per-job store');
    assert.equal(store.db.prepare('PRAGMA temp_store').get().temp_store, 2);
    assert.equal(store.pageDb.prepare('PRAGMA temp_store').get().temp_store, 2);
    const queryPlan = store.pageDb.prepare('EXPLAIN QUERY PLAN SELECT data FROM page_results ORDER BY match_rank DESC, score DESC, sequence ASC LIMIT 5 OFFSET 0').all();
    assert.ok(queryPlan.some(row => /page_match_desc/.test(row.detail)));
    assert.ok(queryPlan.every(row => !/TEMP B-TREE/.test(row.detail)));

    assert.equal(store.set('candidate-10020', { ...store.get('candidate-10020'), semanticScore: 99, status: 'readable' }), true);
    assert.equal(store.size, 10025, 'an update must not allocate another row');
    store.close();
    store = openCandidateStore(storePath);
    const reopened = store.get('candidate-10020');
    assert.equal(reopened.semanticScore, 99);
    assert.equal(reopened.status, 'readable');
    assert.equal(reopened.recordReference, 9007199254740995n);
  } finally {
    store?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('filtered pages reuse one materialization and invalidate for local and worker-connection mutations', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recovery-candidate-page-cache-'));
  const storePath = path.join(root, 'candidates.sqlite');
  let store = openCandidateStore(storePath);
  let workerStore;
  let otherReader;
  const dateFilter = { deletedAfter: '2024-01-01T00:00:00.000Z' };
  try {
    store.setBatch([
      { id: 'a', name: 'alpha.txt', deletedAt: '2024-01-02T00:00:00.000Z' },
      { id: 'b', name: 'bravo.txt', deletedAt: '2024-01-03T00:00:00.000Z' },
      { id: 'old', name: 'old.txt', deletedAt: '2023-12-01T00:00:00.000Z' },
      { id: 'unknown', name: 'unknown.txt', deletedAt: null }
    ]);

    const first = store.page({ filters: dateFilter, sort: 'deleted-asc', offset: 0, limit: 1 });
    assert.deepEqual(first.items.map(item => item.id), ['a']);
    assert.equal(first.total, 3);
    assert.equal(first.scannedTotal, 4);
    assert.equal(first.unknownDeletedTimeTotal, 1);
    const afterFirstBuild = Number(store.pageDb.prepare('SELECT total_changes() AS total').get().total);

    const next = store.page({ filters: dateFilter, sort: 'deleted-asc', offset: 1, limit: 1 });
    assert.deepEqual(next.items.map(item => item.id), ['b']);
    assert.equal(Number(store.pageDb.prepare('SELECT total_changes() AS total').get().total), afterFirstBuild,
      'moving to the next page must not rebuild the matching rows');

    const differentlySorted = store.page({ filters: dateFilter, sort: 'name-desc', offset: 0, limit: 3 });
    assert.deepEqual(differentlySorted.items.map(item => item.id), ['unknown', 'b', 'a']);
    assert.equal(Number(store.pageDb.prepare('SELECT total_changes() AS total').get().total), afterFirstBuild,
      'sorting the same matching rows must not rebuild them');

    otherReader = openCandidateStore(storePath);
    const candidateVersionBeforeOtherReader = store.dataVersion();
    const scratchVersionBeforeOtherReader = Number(store.pageDb.prepare('PRAGMA data_version').get().data_version);
    const otherFilter = otherReader.page({ filters: { name: 'bravo.txt' }, limit: 10 });
    assert.deepEqual(otherFilter.items.map(item => item.id), ['b']);
    assert.equal(store.dataVersion(), candidateVersionBeforeOtherReader,
      'materializing through another reader must not change the candidate database');
    assert.notEqual(Number(store.pageDb.prepare('PRAGMA data_version').get().data_version), scratchVersionBeforeOtherReader);
    const afterOtherReader = store.page({ filters: dateFilter, sort: 'deleted-asc', offset: 0, limit: 3 });
    assert.deepEqual(afterOtherReader.items.map(item => item.id), ['a', 'b', 'unknown'],
      'the first reader must rebuild after another reader replaces shared scratch rows');
    assert.equal(afterOtherReader.total, 3);

    // Preserve the filter API's truthy semantics without aliasing a strict query.
    const truthyName = store.page({ filters: { ...dateFilter, name: 'alpha.txt' }, keepNameMismatches: 1, limit: 10 });
    assert.equal(truthyName.total, 3);
    const strictName = store.page({ filters: { ...dateFilter, name: 'alpha.txt' }, keepNameMismatches: false, limit: 10 });
    assert.deepEqual(strictName.items.map(item => item.id), ['a']);
    assert.equal(strictName.items[0].score, 100);
    assert.equal(strictName.items[0].nameMatch.kind, 'exact');
    assert.deepEqual(strictName.matchCounts, { exact: 1, partial: 0, similar: 0, unknown: 0, none: 0 });
    const afterStrictNameBuild = Number(store.pageDb.prepare('SELECT total_changes() AS total').get().total);
    const inclusiveName = store.page({ filters: { ...dateFilter, name: 'alpha.txt' }, keepNameMismatches: true, limit: 10 });
    assert.equal(inclusiveName.total, 3);
    assert.deepEqual(inclusiveName.matchCounts, { exact: 1, partial: 0, similar: 0, unknown: 0, none: 2 });
    assert.ok(Number(store.pageDb.prepare('SELECT total_changes() AS total').get().total) > afterStrictNameBuild,
      'keepNameMismatches must select a separate materialization');

    store.set('local', { id: 'local', name: 'local.txt', deletedAt: '2024-01-04T00:00:00.000Z' });
    const afterLocalWrite = store.page({ filters: dateFilter, sort: 'deleted-asc', limit: 10 });
    assert.equal(afterLocalWrite.total, 4);
    assert.ok(afterLocalWrite.items.some(item => item.id === 'local'));
    const afterLocalBuild = Number(store.pageDb.prepare('SELECT total_changes() AS total').get().total);
    assert.ok(afterLocalBuild > afterFirstBuild);

    workerStore = openCandidateStore(storePath);
    workerStore.setBatch([{ id: 'worker', name: 'worker.txt', deletedAt: '2024-01-05T00:00:00.000Z' }]);
    const afterWorkerWrite = store.page({ filters: dateFilter, sort: 'deleted-asc', limit: 10 });
    assert.equal(afterWorkerWrite.total, 5);
    assert.ok(afterWorkerWrite.items.some(item => item.id === 'worker'));
    const afterWorkerBuild = Number(store.pageDb.prepare('SELECT total_changes() AS total').get().total);
    assert.ok(afterWorkerBuild > afterLocalBuild, 'a commit from the worker connection must invalidate the cache');

    workerStore.delete('b');
    const afterWorkerDelete = store.page({ filters: dateFilter, sort: 'deleted-asc', limit: 10 });
    assert.equal(afterWorkerDelete.total, 4);
    assert.ok(!afterWorkerDelete.items.some(item => item.id === 'b'));

    store.close();
    store = openCandidateStore(storePath);
    const reopened = store.page({ filters: dateFilter, sort: 'deleted-asc', limit: 10 });
    assert.equal(reopened.total, 4);
    assert.ok(Number(store.pageDb.prepare('SELECT total_changes() AS total').get().total) > 0,
      'a reopened store must validate and rebuild persisted scratch rows');

    store.clear();
    const afterClear = store.page({ filters: dateFilter, sort: 'deleted-asc', limit: 10 });
    assert.equal(afterClear.total, 0);
    assert.equal(afterClear.scannedTotal, 0);
  } finally {
    otherReader?.close();
    workerStore?.close();
    store?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('candidate store opening failures are explicit', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recovery-candidate-failure-'));
  try {
    assert.throws(() => openCandidateStore(root), error => error?.code === 'CANDIDATE_STORE_FAILED');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('job service latches a candidate storage failure instead of accepting a later completion', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recovery-candidate-latch-'));
  const events = [];
  const jobs = new RecoveryJobs({ workspace: root, onEvent: event => events.push(event) });
  jobs.persist = async () => {};
  const candidates = openCandidateStore(path.join(root, 'closed.sqlite'));
  candidates.close();
  const sent = [];
  const job = { id: 'store-failure', candidates, candidateLimit: 100000, status: 'scanning', complete: false,
    warnings: [], worker: { postMessage: message => sent.push(message) } };
  try {
    jobs.receive(job, { type: 'candidate', candidate: { id: 'lost', name: 'lost.txt' } });
    jobs.receive(job, { type: 'complete', complete: true, warnings: [], stats: {} });
    assert.equal(job.status, 'error');
    assert.equal(job.error.code, 'CANDIDATE_STORE_FAILED');
    assert.equal(job.complete, false);
    assert.deepEqual(sent, [{ type: 'cancel' }]);
    assert.equal(events.filter(event => event.type === 'error').length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('job service pages and selects a disk-stored candidate after the 10,000th row', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recovery-candidate-job-'));
  const workspace = path.join(root, 'workspace');
  const destination = path.join(root, 'destination');
  const image = path.join(root, 'source.img');
  await Promise.all([mkdir(workspace), mkdir(destination), writeFile(image, Buffer.alloc(512))]);
  const [runtimePath, destinationPath] = await Promise.all([realpath(workspace), realpath(destination)]);
  const sent = [];
  let worker;
  const jobs = new RecoveryJobs({ workspace: runtimePath,
    inspect: async target => ({ canonicalPath: await realpath(target), identity: `fixture:${await realpath(target)}`,
      diskIds: ['destination-disk'], freeSpace: 1e12, fileSystem: 'NTFS' }),
    workerFactory: () => {
      worker = new EventEmitter(); worker.postMessage = message => sent.push(message); worker.unref = () => {};
      worker.terminate = async () => 0; return worker;
    } });
  await jobs.initialize();
  try {
    const source = await jobs.addSource('image', image);
    const started = await jobs.start({ sourceId: source.id, mode: 'deleted', filters: {} });
    const job = jobs.getJob(started.jobId);
    const workerStore = openCandidateStore(job.candidateStorePath);
    try {
      for (let index = 0; index < 10005; index++) workerStore.set(`native-${index}`, {
        id: `native-${index}`, name: `삭제후보-${String(index).padStart(5, '0')}.txt`, source: 'deleted-record',
        recordNumber: index + 16, recordReference: index === 10004 ? 9007199254740995n : BigInt(index + 16),
        size: index + 1, status: 'unverified'
      });
    } finally { workerStore.close(); }
    worker.emit('message', { type: 'complete', complete: true, warnings: [], stats: { candidatesFound: 10005 } });

    const page = jobs.candidates({ jobId: started.jobId, offset: 10000, limit: 5 });
    assert.deepEqual(page.items.map(item => item.id), ['native-10000', 'native-10001', 'native-10002', 'native-10003', 'native-10004']);
    assert.equal(page.total, 10005);
    assert.equal(page.scannedTotal, 10005);
    assert.equal(page.storage, 'disk');
    assert.equal(page.candidateLimit, 100000);

    const output = await jobs.addDestination(destinationPath);
    await jobs.recover({ jobId: started.jobId, ids: ['native-10004'], destinationId: output.id });
    const recoveryRequest = sent.find(message => message.type === 'recover');
    assert.deepEqual(recoveryRequest.ids, ['native-10004']);
    const exported = await jobs.exportResults({ jobId: started.jobId });
    const parsed = JSON.parse(await readFile(exported.path, 'utf8'));
    assert.equal(parsed.candidates.length, 10005);
    assert.equal(parsed.candidates[10004].id, 'native-10004');
    assert.equal(parsed.candidates[10004].recordReference, '9007199254740995');
  } finally {
    await jobs.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('real image worker recovers exact fixture bytes for a candidate moved beyond row 10,000', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recovery-candidate-real-worker-'));
  const workspace = path.join(root, 'workspace');
  const destination = path.join(root, 'destination');
  await Promise.all([mkdir(workspace), mkdir(destination)]);
  const fixture = await createFixture(path.join(root, 'fixture'));
  const events = [];
  const jobs = new RecoveryJobs({ workspace, onEvent: event => events.push(event),
    inspect: async target => ({ canonicalPath: await realpath(target), identity: `fixture:${await realpath(target)}`,
      diskIds: ['destination-disk'], freeSpace: 1e12, fileSystem: 'NTFS' }) });
  const waitFor = async type => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const event = events.find(item => item.type === type);
      if (event) return event;
      const failure = events.find(item => item.type === 'error');
      if (failure) throw Object.assign(new Error(failure.message), failure.error);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`timed out waiting for ${type}`);
  };
  try {
    await jobs.initialize();
    const source = await jobs.addSource('image', fixture.imagePath);
    const started = await jobs.start({ sourceId: source.id, mode: 'deleted', filters: {} });
    const completed = await waitFor('complete');
    assert.equal(completed.stats.candidateLimit, 100000);
    assert.equal(completed.stats.candidateStorage, 'disk');
    const job = jobs.getJob(started.jobId);
    const original = [...job.candidates.values()].find(candidate => candidate.recordNumber === 24);
    assert.ok(original);
    job.candidates.delete(original.id);
    for (let index = job.candidates.size; index < 10004; index++) job.candidates.set(`filler-${index}`, {
      id: `filler-${index}`, name: `검증용-${String(index).padStart(5, '0')}.txt`, source: 'deleted-record',
      recordNumber: 200000 + index, size: 1, status: 'unverified'
    });
    job.candidates.set(original.id, original);
    const page = jobs.candidates({ jobId: started.jobId, offset: 10000, limit: 5 });
    assert.equal(page.items.at(-1).id, original.id);

    const output = await jobs.addDestination(destination);
    await jobs.recover({ jobId: started.jobId, ids: [original.id], destinationId: output.id });
    const recovered = await waitFor('recover-complete');
    assert.equal(recovered.results[0].status, 'saved');
    const expected = fixture.manifest.files.find(file => file.recordNumber === 24);
    const actualHash = createHash('sha256').update(await readFile(recovered.results[0].path)).digest('hex');
    assert.equal(actualHash, expected.sha256);
  } finally {
    await jobs.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
