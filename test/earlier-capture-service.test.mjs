import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { RecoveryJobs } from '../engine/job-service.mjs';
import { readLayerFingerprint } from '../engine/windows-device.mjs';

const fingerprint = 'a'.repeat(64), layout = 'b'.repeat(64), sha256 = 'c'.repeat(64);
const delay = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function volume(physical = 'disk-a') {
  return { id: '\\\\.\\T:', identity: 'volume-a', label: 'fixture volume', diskIds: ['41'], fileSystem: 'NTFS', ready: true,
    partitionOffset: 1048576, partitionNumber: 1, partitionSize: 8 * 1024 * 1024, logicalSectorSize: 512, physicalSectorSize: 4096,
    sourceTopology: 'single-partition-single-disk', physicalDisks: [{ diskId: '41', identity: physical, identityKind: 'unique-id' }] };
}

function binding(device, nativeIdentity = 'native-a') {
  const readLayer = readLayerFingerprint(device);
  return { deviceId: device.id, identity: device.identity, diskIds: [...device.diskIds], readLayerFingerprint: readLayer,
    nativeIdentity, openedKey: JSON.stringify({ identity: device.identity, nativeIdentity, readLayerFingerprint: readLayer }), invalid: false };
}

function candidate(overrides = {}) {
  return { id: 'partition-a/ntfs:24:7', partitionId: 'partition-a', recordNumber: 24, sequence: 7, size: 4096, fingerprint,
    recordEvidence: { recordNumber: 24, sequence: 7, flags: 0, baseReference: '0', fingerprint, dataLayoutHash: layout },
    deletionEvidence: { fileReference: (24n | 6n << 48n).toString(), deleteUsn: '123456789' }, ...overrides };
}

function captured(overrides = {}) {
  return candidate({ preservation: { status: 'captured', documentStatus: 'preview-available', sha256, size: 4096,
    capturedAt: '2026-09-26T12:00:00.000Z', originalIdentityVerified: false }, ...overrides });
}

class FakeWorker extends EventEmitter {
  constructor() { super(); this.sent = []; this.unref = () => {}; this.terminate = async () => 0; }
  postMessage(message) {
    this.sent.push(message);
    if (message.type === 'preview-capture' || message.type === 'preview') queueMicrotask(() => this.emit('message', {
      requestId: message.requestId, result: { type: 'text', text: message.type, id: message.id }
    }));
  }
}

async function fixture({ inventoryOverride } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'earlier-capture-service-'));
  const workspace = path.join(root, 'workspace'), destination = path.join(root, 'destination');
  await Promise.all([mkdir(workspace), mkdir(destination)]);
  const [workspacePath, destinationPath] = await Promise.all([realpath(workspace), realpath(destination)]);
  let currentDevice = volume();
  const inventory = async () => inventoryOverride ? inventoryOverride(() => currentDevice) : [currentDevice];
  const jobs = new RecoveryJobs({ workspace: workspacePath, inventory,
    inspect: async target => ({ canonicalPath: await realpath(target), identity: target === destinationPath ? 'output' : 'runtime',
      diskIds: ['99'], freeSpace: 1e12, fileSystem: 'NTFS' }) });
  await jobs.initialize();
  const output = await jobs.addDestination(destinationPath);
  const makeJob = (id, createdAt, item, worker = new FakeWorker()) => {
    const source = { id: `${id}-source`, kind: 'volume', identity: currentDevice.identity, device: { ...currentDevice,
      diskIds: [...currentDevice.diskIds], physicalDisks: currentDevice.physicalDisks.map(value => ({ ...value })) } };
    const job = { id, source, sourceBinding: binding(source.device), createdAt, status: 'results', complete: true, actionEpoch: 0,
      worker, candidates: new Map([[item.id, item]]), results: [], warnings: [], stats: {}, destinationId: output.id, outputPath: null };
    worker.on('message', event => jobs.receive(job, event)); jobs.jobs.set(id, job); return job;
  };
  return { jobs, output, makeJob, device: () => currentDevice, setDevice: value => { currentDevice = value; }, close: () => jobs.dispose() };
}

test('only an explicit matching prior job can preview or recover its captured body', async () => {
  const f = await fixture();
  try {
    const prior = f.makeJob('prior', '2026-09-26T12:00:00.000Z', captured());
    const current = f.makeJob('current', '2026-09-26T12:01:00.000Z', candidate());
    const listed = f.jobs.candidates({ jobId: current.id, limit: 10 }).items[0];
    assert.deepEqual(listed.earlierCapture, { jobId: prior.id, capturedAt: '2026-09-26T12:00:00.000Z', sha256, size: 4096,
      documentStatus: 'preview-available', originalIdentityVerified: false });

    const preview = await f.jobs.preview({ jobId: current.id, id: listed.id, earlierJobId: prior.id });
    assert.equal(preview.type, 'text'); assert.equal(preview.earlierCapture.jobId, prior.id);
    assert.equal(prior.worker.sent.at(-1).type, 'preview-capture');
    assert.equal(prior.worker.sent.at(-1).requestedFromJobId, current.id);

    const recovered = await f.jobs.recover({ jobId: current.id, ids: [listed.id], destinationId: f.output.id, earlierJobId: prior.id });
    assert.deepEqual(recovered, { jobId: prior.id });
    const request = prior.worker.sent.at(-1);
    assert.equal(request.type, 'recover'); assert.equal(request.captureOnly.requestedFromJobId, current.id);
    assert.equal(request.captureOnly.sha256, sha256); assert.ok(request.captureOnly.key);
    assert.equal(current.worker.sent.length, 0, 'the current worker never receives an implicit fallback request');
  } finally { await f.close(); }
});

test('names and ids do not create a link; source, fingerprint, layout, delete USN, and hashes must match', async () => {
  const f = await fixture();
  try {
    const prior = f.makeJob('prior', '2026-09-26T12:00:00.000Z', captured({ name: 'same.txt' }));
    const current = f.makeJob('current', '2026-09-26T12:01:00.000Z', candidate({ name: 'same.txt' }));
    assert.ok(f.jobs.candidates({ jobId: current.id, limit: 10 }).items[0].earlierCapture);
    for (const changed of [
      candidate({ partitionId: 'partition-b' }),
      candidate({ fingerprint: 'd'.repeat(64), recordEvidence: { recordNumber: 24, sequence: 7, flags: 0, baseReference: '0', fingerprint: 'd'.repeat(64), dataLayoutHash: layout } }),
      candidate({ recordEvidence: { recordNumber: 24, sequence: 7, flags: 0, baseReference: '0', fingerprint, dataLayoutHash: 'e'.repeat(64) } }),
      candidate({ deletionEvidence: { fileReference: (24n | 6n << 48n).toString(), deleteUsn: '123456790' } }),
    ]) {
      current.candidates.set(changed.id, changed);
      assert.equal(f.jobs.candidates({ jobId: current.id, limit: 10 }).items[0].earlierCapture, undefined);
    }
    current.candidates.set(candidate().id, candidate({ preservation: { status: 'captured', sha256, size: 4096 } }));
    assert.equal(f.jobs.candidates({ jobId: current.id, limit: 10 }).items[0].earlierCapture, undefined, 'a good current capture never advertises duplicate bytes');
    await assert.rejects(f.jobs.preview({ jobId: current.id, id: candidate().id, earlierJobId: prior.id }), { code: 'EARLIER_CAPTURE_UNAVAILABLE' });
  } finally { await f.close(); }
});

test('opened native binding and fresh inventory are required, with no offer after drift, eviction, or cancellation', async () => {
  const f = await fixture();
  try {
    const prior = f.makeJob('prior', '2026-09-26T12:00:00.000Z', captured());
    const current = f.makeJob('current', '2026-09-26T12:01:00.000Z', candidate());
    // A provider that lacks read-layer identity remains backward compatible for
    // normal reads, but does not qualify this job for cross-job capture reuse.
    prior.sourceBinding.openedKey = null; prior.sourceBinding.nativeIdentity = null;
    f.jobs.bindOpenedVolume(prior, { identity: prior.source.identity, nativeIdentity: 'native-a' });
    assert.equal(f.jobs.candidates({ jobId: current.id, limit: 10 }).items[0].earlierCapture, undefined);
    prior.sourceBinding = binding(prior.source.device); current.sourceBinding = binding(current.source.device);
    assert.throws(() => f.jobs.bindOpenedVolume(prior, null), { code: 'SOURCE_CHANGED' });
    assert.equal(prior.sourceBinding.invalid, true);
    prior.sourceBinding = binding(prior.source.device);
    f.setDevice(volume('disk-b'));
    await assert.rejects(f.jobs.preview({ jobId: current.id, id: candidate().id, earlierJobId: prior.id }), { code: 'SOURCE_CHANGED' });

    f.setDevice(volume()); prior.evicted = true; prior.workerStopped = true;
    assert.equal(f.jobs.candidates({ jobId: current.id, limit: 10 }).items[0].earlierCapture, undefined);
  } finally { await f.close(); }
});

test('a cancel racing the fresh inventory check prevents the prior worker RPC', async () => {
  const gate = deferred(); let calls = 0;
  const f = await fixture({ inventoryOverride: current => {
    calls++;
    return calls === 1 ? gate.promise : [current()];
  } });
  try {
    const prior = f.makeJob('prior', '2026-09-26T12:00:00.000Z', captured());
    const current = f.makeJob('current', '2026-09-26T12:01:00.000Z', candidate());
    const pending = f.jobs.preview({ jobId: current.id, id: candidate().id, earlierJobId: prior.id });
    const rejected = assert.rejects(pending, { code: 'CANCELLED' });
    await delay();
    await assert.rejects(f.jobs.start({ mode: 'deleted' }), { code: 'BUSY' });
    await assert.rejects(f.jobs.preview({ jobId: prior.id, id: candidate().id }), { code: 'BUSY' });
    await assert.rejects(f.jobs.preview({ jobId: current.id, id: candidate().id }), { code: 'BUSY' });
    assert.equal(calls, 1, 'one inventory snapshot checks the already matched source bindings');
    f.jobs.cancel(prior.id); gate.resolve([f.device()]);
    await rejected;
    assert.equal(prior.worker.sent.some(message => message.type === 'preview-capture'), false);
  } finally { await f.close(); }
});

test('earlier preview cannot overlap another active job and stored offers cannot bypass server matching', async () => {
  const f = await fixture();
  try {
    const prior = f.makeJob('prior', '2026-09-26T12:00:00.000Z', captured());
    const current = f.makeJob('current', '2026-09-26T12:01:00.000Z', candidate());
    const third = f.makeJob('third', '2026-09-26T12:02:00.000Z', candidate());
    third.status = 'scanning';
    await assert.rejects(f.jobs.preview({ jobId: current.id, id: candidate().id, earlierJobId: prior.id }), { code: 'BUSY' });
    third.status = 'complete';
    const stale = candidate({ deletionEvidence: null, earlierCapture: { jobId: prior.id } });
    current.candidates.set(stale.id, stale);
    assert.equal(f.jobs.candidates({ jobId: current.id, limit: 10 }).items[0].earlierCapture, undefined);
    assert.equal(prior.worker.sent.length, 0);
  } finally { await f.close(); }
});

test('cancellation after linked source validation prevents recovery dispatch during destination preparation', async () => {
  const f = await fixture(), gate = deferred();
  try {
    const prior = f.makeJob('prior', '2026-09-26T12:00:00.000Z', captured());
    const current = f.makeJob('current', '2026-09-26T12:01:00.000Z', candidate());
    const validate = f.jobs.validateDestination.bind(f.jobs);
    let validating = false;
    f.jobs.validateDestination = async (...args) => { validating = true; await gate.promise; return validate(...args); };
    const pending = f.jobs.recover({ jobId: current.id, ids: [candidate().id], earlierJobId: prior.id, destinationId: f.output.id });
    const rejected = assert.rejects(pending, { code: 'CANCELLED' });
    while (!validating) await delay();
    f.jobs.cancel(prior.id); gate.resolve(); await rejected;
    assert.equal(prior.worker.sent.some(message => message.type === 'recover'), false);
  } finally { gate.resolve(); await f.close(); }
});

test('job source snapshot survives catalog mutation while admission checks are pending', async () => {
  const f = await fixture(), gate = deferred();
  try {
    const source = (await f.jobs.devices()).devices[0];
    const inspect = f.jobs.inspect;
    f.jobs.inspect = async target => { await gate.promise; return inspect(target); };
    let workerSource;
    f.jobs.workerFactory = (_file, options) => { workerSource = options.workerData.source; return new FakeWorker(); };
    const pending = f.jobs.start({ sourceId: source.id, mode: 'deleted', capture: false });
    await delay();
    const catalog = f.jobs.sources.get(source.id);
    catalog.device = { ...catalog.device, physicalDisks: [{ identityKind: 'unique-id', identity: 'catalog-replaced' }] };
    catalog.identity = 'catalog-replaced';
    gate.resolve(); const result = await pending;
    assert.equal(workerSource.identity, 'volume-a');
    assert.equal(workerSource.device.physicalDisks[0].identity, 'disk-a');
    assert.equal(f.jobs.getJob(result.jobId).source.identity, 'volume-a');
  } finally { gate.resolve(); await f.close(); }
});
