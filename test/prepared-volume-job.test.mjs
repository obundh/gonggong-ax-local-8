import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, realpath, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RecoveryJobs } from '../engine/job-service.mjs';
import { listWindowsDevices, WindowsVolumeSession } from '../engine/windows-device.mjs';

const fixture = [{ id: 'C:', driveLetter: 'C:', diskIds: ['1'], serial: 'prepared-fixture', size: 4096, ready: true, fileSystem: 'NTFS' }];
async function harness(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recovery-prepared-'));
  const counts = { inventory: 0, opens: 0, workers: 0, revoked: 0 };
  const workers = [], payloads = [], replies = [];
  const inventory = async () => { counts.inventory++; return listWindowsDevices({ fixture }); };
  const session = new WindowsVolumeSession({ inventory, helperPath: async () => 'fixture', directFactory: async () => ({
    closed: false, destroy() { this.closed = true; },
    async request(command, fields) {
      if (command === 'hello') return { protocol: 1, sessionReuse: true };
      if (command === 'open') { counts.opens++; return { identity: 'native-prepared', size: 4096, sectorSize: 512, diskIds: fields.expectedDiskIds }; }
      if (command === 'assert') return { unchanged: true, identity: 'native-prepared' };
      if (command === 'release' || command === 'close') return {};
      throw new Error(`unexpected ${command}`);
    }
  }) });
  const revoke = session.revokePreparedOpen.bind(session);
  session.revokePreparedOpen = token => { counts.revoked++; return revoke(token); };
  const jobs = new RecoveryJobs({ workspace: root, inventory, volumeSession: session,
    inspect: async target => ({ canonicalPath: await realpath(target), diskIds: options.sameDisk ? ['1'] : ['9'], identity: 'workspace', freeSpace: 1e12 }),
    workerFactory(_url, { workerData }) {
      counts.workers++;
      if (options.workerFails) throw new Error('worker fixture failed');
      payloads.push(workerData);
      const worker = new EventEmitter();
      worker.postMessage = value => replies.push(value);
      worker.terminate = async () => worker.emit('exit', 0);
      worker.unref = () => {};
      workers.push(worker); return worker;
    }
  });
  t.after(async () => {
    await jobs.dispose();
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(resolved).startsWith('recovery-prepared-'));
    await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await jobs.initialize();
  const source = (await jobs.devices()).devices[0];
  return { root, jobs, session, source, counts, workers, payloads, replies };
}

test('a job preflight and its first worker open use one fresh inventory; later jobs validate again', async t => {
  const h = await harness(t);
  assert.equal(h.counts.inventory, 1);
  for (let index = 0; index < 2; index++) {
    const { jobId } = await h.jobs.start({ sourceId: h.source.id, mode: 'deleted' });
    assert.equal(h.counts.inventory, index + 2);
    const job = h.jobs.getJob(jobId);
    assert.ok(job.volumeBroker.preparedOpen);
    assert.equal(h.payloads[index].preparedOpen, undefined, 'opaque token never crosses into workerData');
    await job.volumeBroker.handle({ type: 'volume-request', requestId: `open-${index}`, command: 'open', args: { preparedOpen: {}, owner: 'forged' } });
    assert.equal(h.replies.at(-1).error, undefined);
    assert.equal(h.counts.inventory, index + 2, 'worker cannot trigger a second inventory or supply its own token');
    assert.equal(job.volumeBroker.preparedOpen, undefined);
    h.workers[index].emit('message', { type: 'complete', complete: true, stats: {}, warnings: [] });
  }
});

test('unsafe workspace revokes preparation without starting any worker or helper', async t => {
  const h = await harness(t, { sameDisk: true });
  await assert.rejects(h.jobs.start({ sourceId: h.source.id, mode: 'deleted' }), { code: 'RUNTIME_ON_SOURCE' });
  assert.equal(h.counts.revoked, 1);
  assert.equal(h.counts.workers, 0);
  assert.equal(h.counts.opens, 0);
  assert.equal((await readdir(h.root)).includes('candidate-jobs'), false);
});

test('worker construction failure revokes its unused prepared open', async t => {
  const h = await harness(t, { workerFails: true });
  await assert.rejects(h.jobs.start({ sourceId: h.source.id, mode: 'deleted' }), /worker fixture failed/);
  assert.equal(h.counts.revoked, 1);
  assert.equal(h.counts.opens, 0);
  assert.equal(h.jobs.jobs.size, 0);
});

test('worker exit before open revokes preparation and never starts the helper', async t => {
  const h = await harness(t);
  const { jobId } = await h.jobs.start({ sourceId: h.source.id, mode: 'deleted' });
  const broker = h.jobs.getJob(jobId).volumeBroker, token = broker.preparedOpen;
  h.workers[0].emit('exit', 0);
  await broker.dispose();
  assert.equal(h.counts.revoked, 1);
  assert.equal(h.counts.opens, 0);
  await assert.rejects(h.session.open(h.jobs.sources.get(h.source.id).device, { preparedOpen: token, owner: jobId }));
  assert.equal(h.counts.opens, 0);
});

test('closing and reopening the worker volume consumes preparation only on the first open', async t => {
  const h = await harness(t);
  const { jobId } = await h.jobs.start({ sourceId: h.source.id, mode: 'deleted' });
  const broker = h.jobs.getJob(jobId).volumeBroker;
  for (const [index, command] of ['open', 'close', 'open'].entries()) {
    await broker.handle({ type: 'volume-request', requestId: `${command}-${index}`, command, args: {} });
    assert.equal(h.replies.at(-1).error, undefined);
  }
  assert.equal(h.counts.inventory, 3);
});

test('custom job inventory differing from the session keeps the original fresh validation route', async t => {
  const h = await harness(t);
  const original = h.jobs.inventory;
  h.jobs.inventory = () => original();
  const { jobId } = await h.jobs.start({ sourceId: h.source.id, mode: 'deleted' });
  const broker = h.jobs.getJob(jobId).volumeBroker;
  assert.equal(broker.preparedOpen, undefined);
  await broker.handle({ type: 'volume-request', requestId: 'open', command: 'open', args: {} });
  assert.equal(h.replies.at(-1).error, undefined);
  assert.equal(h.counts.inventory, 3);
});
