import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { RecoveryJobs } from '../engine/job-service.mjs';
import { createUsnFixture } from './usn-fixture.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function files(root) {
  const result = [];
  for (const item of await readdir(root, { withFileTypes: true })) {
    if (item.isDirectory()) result.push(...(await files(path.join(root, item.name))).map(name => path.join(item.name, name)));
    else result.push(item.name);
  }
  return result.sort();
}
function waitEvent(events, predicate) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const item = events.find(predicate);
      if (item) return resolve(item);
      if (Date.now() - started > 15000) return reject(new Error('Worker event timeout'));
      setTimeout(tick, 10);
    };
    tick();
  });
}
const inspect = async target => ({ canonicalPath: await realpath(target), identity: path.resolve(target), diskIds: ['output'], freeSpace: 1e12, fileSystem: 'NTFS' });

test('deleted listing uses a per-job candidate store and asks for recovery output only afterward', { timeout: 25000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rc-list-first-'));
  let jobs;
  try {
    const fixture = await createUsnFixture(path.join(root, 'source'));
    const beforeHash = hash(await readFile(fixture.imagePath));
    const workspace = path.join(root, 'workspace'); const output = path.join(root, 'output');
    await Promise.all([mkdir(workspace), mkdir(output)]);
    const events = [];
    jobs = new RecoveryJobs({ workspace, inspect, onEvent: event => events.push(event) });
    await jobs.initialize();
    const source = await jobs.addSource('image', fixture.imagePath);
    const { jobId } = await jobs.start({ sourceId: source.id, mode: 'deleted', recent: true, filters: {} });
    await waitEvent(events, event => event.jobId === jobId && event.type === 'complete');
    const job = jobs.getJob(jobId);
    const page = jobs.candidates({ jobId, sort: 'deleted-desc', limit: 100 });
    const selected = page.items.find(item => item.recordNumber === 24);
    assert.ok(selected); assert.equal(page.items[0].recordNumber, 25);
    assert.equal(job.outputPath, null); assert.equal(jobs.resultPath({ jobId }), null);
    assert.equal(jobs.savedHistory.size, 1); assert.equal(jobs.history().jobs[0].inMemory, false);
    assert.equal(events.some(event => event.type === 'checkpoint'), false);
    const preview = await jobs.preview({ jobId, id: selected.id });
    assert.equal(preview.type, 'text');
    assert.match(preview.text, /회복 연진 테스트 문서/);
    await assert.rejects(jobs.recover({ jobId, ids: [selected.id] }), { code: 'OUTPUT_REQUIRED' });
    await assert.rejects(jobs.exportResults({ jobId }), { code: 'OUTPUT_REQUIRED' });
    assert.throws(() => jobs.requestWorker(job, 'save-index'), { code: 'OUTPUT_REQUIRED' });
    assert.deepEqual((await jobs.cleanup({ jobId })).files, []);
    assert.ok((await files(workspace)).some(file => file.endsWith('candidates.sqlite')));
    assert.equal(hash(await readFile(fixture.imagePath)), beforeHash, 'candidate metadata writes must not change the selected image');
    const destination = await jobs.addDestination(output);
    await jobs.recover({ jobId, ids: [selected.id], destinationId: destination.id });
    const saved = await waitEvent(events, event => event.jobId === jobId && event.type === 'recover-complete');
    await job.persistQueue;
    assert.equal(saved.results[0].status, 'saved');
    assert.equal(hash(await readFile(saved.results[0].path)), fixture.manifest.files.find(item => item.recordNumber === 24).sha256);
    assert.ok(job.outputPath.startsWith(output + path.sep));
    assert.equal((await jobs.preview({ jobId, id: selected.id })).type, 'text');
    assert.equal(hash(await readFile(fixture.imagePath)), beforeHash);
    assert.ok((await files(workspace)).includes('history.json'));
  } finally { await jobs?.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('metadata-only volume admission validates candidate storage and actual restore keeps disk and identity guards', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rc-list-first-'));
  let jobs;
  try {
    const workspace = path.join(root, 'workspace'), output = path.join(root, 'output');
    await Promise.all([mkdir(workspace), mkdir(output)]);
    const device = { id: 'SYNTHETIC-NOT-A-REAL-VOLUME', identity: 'source-v1', diskIds: ['source'], label: 'synthetic', ready: true };
    let inspections = 0; let data; let outputDisk = 'source'; let runtimeDisk = 'runtime';
    const worker = new EventEmitter(); worker.postMessage = () => {}; worker.terminate = async () => 0; worker.unref = () => {};
    jobs = new RecoveryJobs({ workspace, inventory: async () => [device],
      inspect: async target => { inspections++; return { ...await inspect(target), diskIds: [path.resolve(target) === workspace ? runtimeDisk : outputDisk] }; },
      workerFactory: (url, options) => { data = options.workerData; return worker; } });
    await jobs.initialize();
    const source = (await jobs.devices()).devices[0];
    const { jobId } = await jobs.start({ sourceId: source.id, mode: 'deleted', filters: {} });
    assert.equal(inspections, 1); assert.equal(data.outputPath, null);
    assert.ok((await files(workspace)).some(file => file.endsWith('candidates.sqlite')));
    const job = jobs.getJob(jobId); job.status = 'results'; job.candidates.set('candidate', { id: 'candidate', size: 10 });
    await assert.rejects(jobs.recover({ jobId, ids: ['candidate'] }), { code: 'OUTPUT_REQUIRED' });
    const destination = await jobs.addDestination(output);
    await assert.rejects(jobs.recover({ jobId, ids: ['candidate'], destinationId: destination.id }), { code: 'SAME_PHYSICAL_DISK' });
    outputDisk = 'different';
    runtimeDisk = 'source';
    await assert.rejects(jobs.recover({ jobId, ids: ['candidate'], destinationId: destination.id }), { code: 'RUNTIME_ON_SOURCE' });
    runtimeDisk = 'runtime'; device.identity = 'changed';
    await assert.rejects(jobs.recover({ jobId, ids: ['candidate'], destinationId: destination.id }), { code: 'SOURCE_CHANGED' });
    assert.ok((await files(workspace)).some(file => file.endsWith('candidates.sqlite'))); assert.deepEqual(await files(output), []);
    await assert.rejects(jobs.start({ sourceId: source.id, mode: 'deleted' }), { code: 'SOURCE_CHANGED' });
    device.identity = 'source-v1';
    await assert.rejects(jobs.start({ sourceId: source.id, mode: 'deep' }), { code: 'OUTPUT_REQUIRED' });
  } finally { await jobs?.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('recycle Worker lists metadata without output, carries access warnings, and copies only after destination selection', { timeout: 25000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rc-list-first-'));
  let jobs;
  try {
    const recycle = path.join(root, '$Recycle.Bin', 'S-1-5-21-100-200-300-1001');
    const workspace = path.join(root, 'workspace'); const output = path.join(root, 'output');
    await Promise.all([mkdir(recycle, { recursive: true }), mkdir(workspace), mkdir(output)]);
    const originalPath = 'C:\\Users\\Synthetic\\Documents\\latest.txt';
    const payload = Buffer.from('Synthetic recycle recovery payload\n');
    const encoded = Buffer.from(originalPath + '\0', 'utf16le');
    const metadata = Buffer.alloc(28 + encoded.length);
    metadata.writeBigUInt64LE(2n, 0); metadata.writeBigUInt64LE(BigInt(payload.length), 8);
    metadata.writeBigUInt64LE((BigInt(Date.parse('2026-09-13T05:00:00.000Z')) + 11644473600000n) * 10000n, 16);
    metadata.writeUInt32LE(encoded.length / 2, 24); encoded.copy(metadata, 28);
    await Promise.all([writeFile(path.join(recycle, '$IABC123.txt'), metadata), writeFile(path.join(recycle, '$RABC123.txt'), payload)]);
    const events = [];
    jobs = new RecoveryJobs({ workspace, inspect, onEvent: event => events.push(event),
      recycleInventory: async () => ({ roots: [{ path: await realpath(recycle) }],
        warnings: [{ code: 'RECYCLE_VOLUME_UNAVAILABLE', message: 'Synthetic inaccessible volume warning' }] }) });
    await jobs.initialize();
    const source = await jobs.recycleSource();
    assert.equal(source.kind, 'recycle');
    const { jobId } = await jobs.start({ sourceId: source.id, mode: 'recycle', recent: true, filters: {} });
    const completed = await waitEvent(events, event => event.jobId === jobId && ['complete', 'error'].includes(event.type));
    assert.equal(completed.type, 'complete', JSON.stringify(completed));
    assert.equal(completed.complete, false); assert.ok(completed.warnings.some(item => item.code === 'RECYCLE_VOLUME_UNAVAILABLE'));
    const page = jobs.candidates({ jobId, sort: 'deleted-desc' });
    assert.equal(page.items.length, 1); assert.equal(page.items[0].name, 'latest.txt');
    assert.equal(page.items[0].originalPath, originalPath); assert.equal(page.items[0].deletedAtSource, 'recycle-metadata');
    assert.equal(page.items[0].deletedAtKind, 'recycle-bin-entry');
    assert.equal(jobs.getJob(jobId).recent, true); assert.equal(jobs.getJob(jobId).outputPath, null);
    const preview = await jobs.preview({ jobId, id: page.items[0].id });
    assert.equal(preview.type, 'text'); assert.equal(preview.text.trim(), payload.toString().trim());
    assert.deepEqual(await readFile(path.join(recycle, '$RABC123.txt')), payload);
    assert.deepEqual(await readFile(path.join(recycle, '$IABC123.txt')), metadata);
    assert.ok((await files(workspace)).some(file => file.endsWith('candidates.sqlite')));
    const insideRoot = await jobs.addDestination(recycle);
    await assert.rejects(jobs.recover({ jobId, ids: [page.items[0].id], destinationId: insideRoot.id }), { code: 'UNSAFE_OUTPUT' });
    assert.deepEqual(await readFile(path.join(recycle, '$RABC123.txt')), payload);
    const destination = await jobs.addDestination(output);
    await jobs.recover({ jobId, ids: [page.items[0].id], destinationId: destination.id });
    const saved = await waitEvent(events, event => event.jobId === jobId && event.type === 'recover-complete');
    assert.equal(saved.results[0].status, 'saved', JSON.stringify(saved));
    assert.deepEqual(await readFile(saved.results[0].path), payload);
    assert.deepEqual(await readFile(path.join(recycle, '$RABC123.txt')), payload, 'Recycle original must remain allocated and unchanged');
    assert.deepEqual(await readFile(path.join(recycle, '$IABC123.txt')), metadata);
  } finally { await jobs?.dispose(); await rm(root, { recursive: true, force: true }); }
});
