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
import { usnRecord } from './usn-fixture.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const inventory = async () => ['C', 'D'].map((letter, index) => ({
  id: `\\\\.\\${letter}:`, label: `Fixture ${letter}:`, driveLetter: `${letter}:`, identity: `fixture-${letter}-v1`,
  diskIds: [String(index + 1)], fileSystem: 'NTFS', ready: true, system: false
}));
const inspect = async target => ({ canonicalPath: await realpath(target), identity: 'test-output-volume', diskIds: ['9'], freeSpace: 1e12, fileSystem: 'NTFS' });

test('real native worker preserves unsupported preparation evidence in the recovery result and export', { timeout: 20000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recovery-volume-session-'));
  let jobs;
  try {
    const fixture = await createFixture(path.join(root, 'fixture'));
    const bytes = await readFile(fixture.imagePath);
    const workspace = path.join(root, 'workspace'), destination = path.join(root, 'destination');
    await Promise.all([mkdir(workspace), mkdir(destination)]);
    const events = [];
    const header = Buffer.alloc(8); header.writeBigInt64LE(2000n);
    const session = { async dispose() {}, async open(device) { return {
      info: { size: bytes.length, sectorSize: 512, identity: device.identity, sourceKind: 'volume' },
      async assertUnchanged() {}, async close() {},
      async read(offset, length) { return Buffer.from(bytes.subarray(offset, offset + length)); },
      async queryJournal() { return { journalId: '99', firstUsn: '1000', lowestValidUsn: '1000', nextUsn: '2000' }; },
      async readJournal() { return { data: Buffer.concat([header, usnRecord({ recordNumber: 36, sequence: 1, name: 'attribute-list.txt', usn: 1100 })]) }; },
    }; } };
    jobs = new RecoveryJobs({ workspace, inventory, inspect, volumeSession: session, onEvent: event => events.push(event) });
    await jobs.initialize();
    const source = (await jobs.devices()).devices[0];
    const { jobId } = await jobs.start({ sourceId: source.id, mode: 'deleted', deletedStrategy: 'auto' });
    await waitFor(events, jobId);
    const candidate = jobs.candidates({ jobId, limit: 100 }).items.find(item => item.recordNumber === 36);
    assert.ok(candidate);
    const output = await jobs.addDestination(destination);
    await jobs.recover({ jobId, ids: [candidate.id], destinationId: output.id });
    const result = (await waitFor(events, jobId, 'recover-complete')).results[0];
    assert.equal(result.code, 'NOT_RECOVERABLE');
    assert.equal(result.diagnostic.category, 'record-interpretation-failed');
    assert.equal(result.diagnostic.candidateStatus, 'unsupported');
    assert.ok(result.diagnostic.candidateReasons.length);
    assert.ok(result.diagnostic.coverage);
    const exported = await jobs.exportResults({ jobId });
    assert.equal(JSON.parse(await readFile(exported.path, 'utf8')).results[0].diagnostic.category, 'record-interpretation-failed');
    assert.equal(hash(await readFile(fixture.imagePath)), hash(bytes));
  } finally { await jobs?.dispose(); await cleanup(root); }
});

async function waitFor(events, jobId, type = 'complete') {
  const expires = Date.now() + 10000;
  while (Date.now() < expires) {
    const failure = events.find(event => event.jobId === jobId && event.type === 'error');
    if (failure) throw Object.assign(new Error(failure.message || failure.error?.message), failure.error);
    const event = events.find(item => item.jobId === jobId && item.type === type);
    if (event) return event;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${type} from ${jobId}`);
}

async function cleanup(root) {
  const resolved = path.resolve(root);
  assert.equal(path.dirname(resolved).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
  assert.ok(path.basename(resolved).startsWith('recovery-volume-session-'));
  await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

test('two real volume workers share the app session and retain the first scan lease for preview and recovery', { timeout: 20000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recovery-volume-session-'));
  const events = [], opens = [], payloads = [], leases = [];
  let jobs, sessionDisposals = 0;
  try {
    const fixture = await createFixture(path.join(root, 'fixture'));
    const bytes = await readFile(fixture.imagePath), before = hash(bytes);
    const workspace = path.join(root, 'workspace'), destination = path.join(root, 'destination');
    await Promise.all([mkdir(workspace), mkdir(destination)]);
    const volumeSession = {
      async open(device, options) {
        opens.push({ device, options });
        const lease = { closes: 0, reads: 0 };
        leases.push(lease);
        return {
          info: { size: bytes.length, sectorSize: 512, identity: device.identity, sourceKind: 'volume' },
          async assertUnchanged() { assert.equal(lease.closes, 0, 'a closed lease must never be used again'); },
          async read(offset, length, { signal } = {}) {
            assert.equal(lease.closes, 0);
            if (signal?.aborted) throw Object.assign(new Error('cancelled'), { code: 'CANCELLED' });
            lease.reads++;
            return Buffer.from(bytes.subarray(offset, offset + length));
          },
          async close() { lease.closes++; }
        };
      },
      async dispose() { sessionDisposals++; }
    };
    jobs = new RecoveryJobs({
      workspace, inventory, inspect, volumeSession, onEvent: event => events.push(event),
      workerFactory: (url, options) => { payloads.push(options.workerData); return new Worker(url, options); }
    });
    await jobs.initialize();
    const sources = (await jobs.devices()).devices;
    const first = await jobs.start({ sourceId: sources[0].id, mode: 'deleted', deletedStrategy: 'full', elevate: true });
    await waitFor(events, first.jobId);
    const original = jobs.candidates({ jobId: first.jobId, limit: 100 }).items.find(item => item.recordNumber === 24);
    assert.ok(original, 'the production volume worker must discover the fixture document');
    const second = await jobs.start({ sourceId: sources[1].id, mode: 'deleted', deletedStrategy: 'full', elevate: true });
    await waitFor(events, second.jobId);
    assert.equal(opens.length, 2, 'each worker gets a lease from the same injected session');
    assert.deepEqual(opens.map(item => item.device.driveLetter), ['C:', 'D:']);
    assert.ok(opens.every(item => item.options.elevate === true));
    assert.ok(payloads.every(data => data.volumeSession === true));
    assert.equal(leases[0].closes, 0, 'finishing another scan must preserve the previous result reader');
    assert.equal(leases[1].closes, 0);

    const readsBefore = leases[0].reads;
    const preview = await jobs.preview({ jobId: first.jobId, id: original.id });
    assert.equal(preview.type, 'text');
    assert.match(preview.text, /회복 연진 테스트 문서/);
    assert.ok(leases[0].reads > readsBefore, 'preview reads through the first job lease');
    assert.equal(opens.length, 2, 'preview reuses the lease without requesting another privileged connection');
    const output = await jobs.addDestination(destination);
    await jobs.recover({ jobId: first.jobId, ids: [original.id], destinationId: output.id });
    const recovered = await waitFor(events, first.jobId, 'recover-complete');
    assert.equal(recovered.results[0].status, 'saved');
    assert.equal(hash(await readFile(recovered.results[0].path)), fixture.manifest.files.find(file => file.recordNumber === 24).sha256);
    assert.equal(opens.length, 2);
    assert.equal(hash(await readFile(fixture.imagePath)), before, 'volume bridge search and recovery must preserve source bytes');
    await jobs.dispose();
    await jobs.dispose();
    assert.equal(sessionDisposals, 1);
    assert.deepEqual(leases.map(lease => lease.closes), [1, 1]);
  } finally { await jobs?.dispose(); await cleanup(root); }
});

test('worker exit during pending volume open retires its late lease while the app session remains available', { timeout: 5000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recovery-volume-session-'));
  const opening = deferred(), entered = deferred();
  let jobs, worker, closes = 0, sessionDisposals = 0;
  try {
    jobs = new RecoveryJobs({
      workspace: root, inventory, inspect,
      volumeSession: { async open() { entered.resolve(); return opening.promise; }, async dispose() { sessionDisposals++; } },
      workerFactory() {
        worker = new EventEmitter();
        worker.postMessage = () => {};
        worker.unref = () => {};
        worker.terminate = async () => { worker.emit('exit', 0); };
        return worker;
      }
    });
    await jobs.initialize();
    const source = (await jobs.devices()).devices[0];
    const started = await jobs.start({ sourceId: source.id, mode: 'deleted', elevate: true });
    worker.emit('message', { type: 'volume-request', requestId: 'opening', command: 'open', args: {} });
    await entered.promise;
    await worker.terminate();
    opening.resolve({ info: { identity: 'late' }, async close() { closes++; } });
    await jobs.getJob(started.jobId).volumeBroker.dispose();
    await tick();
    assert.equal(closes, 1);
    assert.equal(jobs.getJob(started.jobId).status, 'error');
    assert.equal(sessionDisposals, 0, 'one worker exiting must not discard the app-wide permission session');
    await jobs.dispose();
    assert.equal(closes, 1);
    assert.equal(sessionDisposals, 1);
  } finally { opening.resolve({ info: {}, async close() {} }); await jobs?.dispose(); await cleanup(root); }
});

test('the fourth sequential volume scan evicts the oldest worker promptly without discarding the app session', { timeout: 15000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recovery-volume-session-'));
  const events = [], leases = [], workers = [];
  let jobs, sessionDisposals = 0, deadline;
  try {
    const fixture = await createFixture(path.join(root, 'fixture'));
    const bytes = await readFile(fixture.imagePath);
    jobs = new RecoveryJobs({
      workspace: path.join(root, 'workspace'), inventory, inspect, onEvent: event => events.push(event),
      volumeSession: {
        async open(device) {
          const lease = { closes: 0 }; leases.push(lease);
          return {
            info: { size: bytes.length, sectorSize: 512, identity: device.identity, sourceKind: 'volume' },
            async assertUnchanged() { assert.equal(lease.closes, 0); },
            async read(offset, length) { assert.equal(lease.closes, 0); return Buffer.from(bytes.subarray(offset, offset + length)); },
            async close() { lease.closes++; }
          };
        },
        async dispose() { sessionDisposals++; }
      },
      workerFactory(url, options) {
        const worker = new Worker(url, options), exited = deferred();
        worker.once('exit', code => exited.resolve(code));
        workers.push({ worker, exited: exited.promise });
        return worker;
      }
    });
    await jobs.initialize();
    const source = (await jobs.devices()).devices[0];
    const ids = [];
    for (let index = 0; index < 4; index++) {
      const started = await jobs.start({ sourceId: source.id, mode: 'deleted', deletedStrategy: 'full', elevate: true });
      ids.push(started.jobId);
      await waitFor(events, started.jobId);
    }
    const firstExit = await Promise.race([
      workers[0].exited,
      new Promise((resolve, reject) => { deadline = setTimeout(() => reject(new Error('evicted worker waited for a volume RPC timeout instead of exiting')), 2000); })
    ]);
    clearTimeout(deadline);
    assert.equal(firstExit, 0);
    assert.equal(jobs.jobs.has(ids[0]), false);
    assert.equal(jobs.jobs.size, 3);
    assert.equal(leases[0].closes, 1);
    assert.deepEqual(leases.slice(1).map(lease => lease.closes), [0, 0, 0]);
    assert.equal(sessionDisposals, 0);
  } finally { clearTimeout(deadline); await jobs?.dispose(); await cleanup(root); }
  assert.deepEqual(leases.map(lease => lease.closes), [1, 1, 1, 1]);
  assert.equal(sessionDisposals, 1);
});

test('disposing the app while a scan is awaiting inventory prevents any late worker or volume connection', { timeout: 5000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recovery-volume-session-'));
  const checking = deferred(), checked = deferred();
  const devices = await inventory();
  let jobs, starting, deferInventory = false, workerStarts = 0, volumeOpens = 0, sessionDisposals = 0;
  try {
    jobs = new RecoveryJobs({
      workspace: root, inspect,
      inventory: async () => {
        if (deferInventory) { checking.resolve(); return checked.promise; }
        return devices;
      },
      volumeSession: {
        async open() { volumeOpens++; throw new Error('a disposed app must never open a volume'); },
        async dispose() { sessionDisposals++; }
      },
      workerFactory() { workerStarts++; throw new Error('a disposed app must never spawn a worker'); }
    });
    await jobs.initialize();
    const source = (await jobs.devices()).devices[0];
    deferInventory = true;
    starting = jobs.start({ sourceId: source.id, mode: 'deleted', elevate: true });
    const rejected = assert.rejects(starting, { code: 'CANCELLED' });
    await checking.promise;
    assert.equal(jobs.busy(), true);
    await jobs.dispose();
    assert.equal(sessionDisposals, 1);
    checked.resolve(devices);
    await rejected;
    assert.equal(workerStarts, 0);
    assert.equal(volumeOpens, 0);
    assert.equal(jobs.jobs.size, 0);
    assert.equal(jobs.busy(), false);
    await assert.rejects(jobs.start({ sourceId: source.id, mode: 'deleted', elevate: true }), { code: 'CANCELLED' });
    assert.equal(workerStarts, 0);
  } finally {
    checked.resolve(devices);
    await starting?.catch(() => {});
    await jobs?.dispose();
    await cleanup(root);
  }
});
