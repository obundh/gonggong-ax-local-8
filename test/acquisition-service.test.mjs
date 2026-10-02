import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, open } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { RecoveryJobs } from '../engine/job-service.mjs';
import { openImageBytes } from '../engine/byte-source.mjs';
import { verifyAcquisition } from '../engine/image-acquisition.mjs';
import { createFixture } from './ntfs-fixtures.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const waitFor = async condition => { const end = Date.now() + 15000; while (!condition()) { if (Date.now() > end) throw new Error('condition timed out'); await new Promise(resolve => setTimeout(resolve, 10)); } };
async function fixture(options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stage2-acquisition-service-'));
  const input = await createFixture(path.join(root, 'input'));
  const workspace = path.join(root, 'workspace'), destination = path.join(root, 'destination');
  await Promise.all([mkdir(workspace), mkdir(destination)]);
  const events = [];
  const inspect = async target => ({ canonicalPath: await realpath(target), identity: 'fixture-volume-9', diskIds: ['9'], freeSpace: 1e12, fileSystem: 'NTFS' });
  const jobs = new RecoveryJobs({ workspace, inspect, inventory: async () => [], onEvent: event => events.push(event), ...options });
  await jobs.initialize();
  return { root, input, workspace, destination, jobs, events, inspect };
}

test('collection runs exclusively, preserves the fixed source, and verified image feeds the actual recovery engine', async () => {
  const f = await fixture();
  try {
    const original = hash(await readFile(f.input.imagePath));
    const source = await f.jobs.addSource('image', f.input.imagePath), destination = await f.jobs.addDestination(f.destination);
    const collection = await f.jobs.acquisitions.start({ sourceId: source.id, destinationId: destination.id });
    assert.equal(f.jobs.busy(), true);
    await assert.rejects(f.jobs.start({ sourceId: source.id, mode: 'deleted' }), { code: 'BUSY' });
    const result = await f.jobs.acquisitions.active.done;
    assert.equal(result.status, 'complete');
    assert.equal(result.summary.sha256, original);
    assert.equal(hash(await readFile(f.input.imagePath)), original);
    assert.equal(hash(await readFile(path.join(result.outputDirectory, 'image.raw'))), original);
    const acquired = await f.jobs.acquisitions.useImage(collection.id);
    const scan = await f.jobs.start({ sourceId: acquired.id, mode: 'deleted' });
    await waitFor(() => f.events.some(event => event.jobId === scan.jobId && ['complete', 'error'].includes(event.type)));
    assert.equal(f.events.find(event => event.jobId === scan.jobId && event.type === 'error'), undefined);
    assert.ok(f.jobs.candidates({ jobId: scan.jobId, limit: 100 }).total > 0);
    const image = await open(path.join(result.outputDirectory, 'image.raw'), 'r+');
    try { await image.write(Buffer.from([99]), 0, 1, 2000); } finally { await image.close(); }
    await assert.rejects(f.jobs.acquisitions.useImage(collection.id));
    assert.equal(f.jobs.acquisitions.list().items[0].canUse, false);
  } finally { await f.jobs.dispose(); }
});

test('cancelled acquisition retains an index and resumes only against the same fixed image after restart', async () => {
  let firstRead = true, jobs;
  const f = await fixture({ acquisitionOptions: { openImage: async file => {
    const reader = await openImageBytes(file);
    return { ...reader, async read(offset, length, options) {
      const bytes = await reader.read(offset, length, options);
      if (firstRead) { firstRead = false; jobs.acquisitions.cancel(jobs.acquisitions.active.record.id); }
      return bytes;
    } };
  } } }); jobs = f.jobs;
  let restarted;
  try {
    const source = await jobs.addSource('image', f.input.imagePath), destination = await jobs.addDestination(f.destination);
    const first = await jobs.acquisitions.start({ sourceId: source.id, destinationId: destination.id });
    const result = await jobs.acquisitions.active.done;
    assert.equal(result.status, 'cancelled'); assert.equal(result.canUse, false);
    await jobs.dispose();
    restarted = new RecoveryJobs({ workspace: f.workspace, inspect: f.inspect, inventory: async () => [] });
    await restarted.initialize();
    assert.equal(restarted.acquisitions.list().items[0].canResume, true);
    const selected = await restarted.addSource('image', f.input.imagePath);
    await restarted.acquisitions.start({ sourceId: selected.id, resumeId: first.id });
    assert.equal((await restarted.acquisitions.active.done).status, 'complete');
  } finally { await jobs.dispose(); await restarted?.dispose(); }
});

test('physical source/output collision is rejected before opening a volume helper', async () => {
  let opened = 0;
  const device = { id: 'C:', identity: 'volume-C', label: 'Fixture C:', kind: 'volume', ready: true, diskIds: ['9'], size: 4194304, partitionSize: 4194304, fileSystem: 'NTFS' };
  const f = await fixture({ inventory: async () => [device], volumeSession: { async open() { opened++; throw new Error('must not open'); }, async dispose() {} } });
  try {
    const source = (await f.jobs.devices()).devices[0], destination = await f.jobs.addDestination(f.destination);
    await assert.rejects(f.jobs.acquisitions.start({ sourceId: source.id, destinationId: destination.id }), { code: 'SAME_PHYSICAL_DISK' });
    assert.equal(opened, 0); assert.equal(f.jobs.busy(), false);
  } finally { await f.jobs.dispose(); }
});

test('a file replaced after successful hash verification is not adopted as the verified image', async () => {
  const f = await fixture({ acquisitionOptions: { verify: async (directory, options) => {
    const verified = await verifyAcquisition(directory, options);
    const file = await open(path.join(directory, 'image.raw'), 'r+');
    try { await file.write(Buffer.from('changed after verification'), 0, 26, 8192); } finally { await file.close(); }
    return verified;
  } } });
  try {
    const source = await f.jobs.addSource('image', f.input.imagePath), destination = await f.jobs.addDestination(f.destination);
    const result = await f.jobs.acquisitions.start({ sourceId: source.id, destinationId: destination.id });
    await f.jobs.acquisitions.active.done;
    const beforeCount = f.jobs.sources.size;
    await assert.rejects(f.jobs.acquisitions.useImage(result.id), { code: 'IMAGE_CHANGED' });
    assert.equal(f.jobs.sources.size, beforeCount);
    assert.equal(f.jobs.acquisitions.list().items[0].canUse, false);
  } finally { await f.jobs.dispose(); }
});

test('cancelling before a checkpoint exists does not offer a broken resume action', async () => {
  const f = await fixture();
  try {
    const source = await f.jobs.addSource('image', f.input.imagePath), destination = await f.jobs.addDestination(f.destination);
    const started = await f.jobs.acquisitions.start({ sourceId: source.id, destinationId: destination.id });
    f.jobs.acquisitions.cancel(started.id);
    const result = await f.jobs.acquisitions.active.done;
    assert.equal(result.status, 'cancelled'); assert.equal(result.canResume, false); assert.equal(result.canUse, false);
  } finally { await f.jobs.dispose(); }
});

test('cancelling a read-only verification leaves the completed image available for another verification', async () => {
  let jobs, cancelOnce = true;
  const f = await fixture({ acquisitionOptions: { verify: async (directory, options) => {
    if (cancelOnce) { cancelOnce = false; jobs.acquisitions.cancel(jobs.acquisitions.active.record.id); }
    return verifyAcquisition(directory, options);
  } } }); jobs = f.jobs;
  try {
    const source = await jobs.addSource('image', f.input.imagePath), destination = await jobs.addDestination(f.destination);
    const started = await jobs.acquisitions.start({ sourceId: source.id, destinationId: destination.id });
    await jobs.acquisitions.active.done;
    await assert.rejects(jobs.acquisitions.useImage(started.id), { code: 'CANCELLED' });
    assert.equal(jobs.busy(), false);
    assert.equal(jobs.acquisitions.list().items[0].status, 'complete');
    assert.equal(jobs.acquisitions.list().items[0].canUse, true);
    assert.equal((await jobs.acquisitions.useImage(started.id)).kind, 'image');
  } finally { await jobs.dispose(); }
});
