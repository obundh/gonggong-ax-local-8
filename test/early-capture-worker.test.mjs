import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RecoveryJobs } from '../engine/job-service.mjs';
import { createFixture, fixtureGeometry } from './ntfs-fixtures.mjs';
import { usnRecord } from './usn-fixture.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function waitFor(events, jobId, type) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const failure = events.find(e => e.jobId === jobId && e.type === 'error');
    if (failure) throw new Error(JSON.stringify(failure));
    const result = events.find(e => e.jobId === jobId && e.type === type);
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Missing ${type}`);
}

test('real worker captures before publication; later source reuse only breaks uncaptured recovery', { timeout: 40000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'capture-worker-'));
  const fixture = await createFixture(path.join(root, 'fixture'));
  const original = await readFile(fixture.imagePath);
  const expected = fixture.manifest.files.find(item => item.recordNumber === 24);
  for (const capture of [true, false]) {
    const bytes = Buffer.from(original), events = [];
    let reads = 0, mutated = false;
    const workspace = path.join(root, `workspace-${capture}`), destination = path.join(root, `output-${capture}`);
    await mkdir(workspace); await mkdir(destination);
    const device = { id: '\\\\.\\C:', identity: 'synthetic-live-source', diskIds: ['1'], fileSystem: 'NTFS', ready: true };
    const header = Buffer.alloc(8); header.writeBigInt64LE(2000n);
    const session = { async dispose() {}, async open() { return {
      info: { size: bytes.length, sectorSize: 512, identity: device.identity, sourceKind: 'volume' },
      async assertUnchanged() {}, async close() {},
      async read(offset, length) { reads++; return Buffer.from(bytes.subarray(offset, offset + length)); },
      async queryJournal() { return { journalId: '99', firstUsn: '1000', lowestValidUsn: '1000', nextUsn: '2000' }; },
      async readJournal() { return { data: Buffer.concat([header, usnRecord({ recordNumber: 24, sequence: 6, usn: 1100 })]) }; },
    }; } };
    const jobs = new RecoveryJobs({ workspace, inventory: async () => [device], volumeSession: session,
      inspect: async file => ({ canonicalPath: await realpath(file), identity: 'output', diskIds: ['2'], freeSpace: 1e12, fileSystem: 'NTFS' }),
      onEvent(event) {
        events.push(event);
        if (event.type === 'candidate' && !mutated) {
          mutated = true;
          bytes.writeUInt16LE(30, fixtureGeometry.mftLcn * fixtureGeometry.clusterSize + 24 * fixtureGeometry.fileRecordSize + 16);
        }
      } });
    try {
      await jobs.initialize();
      const source = (await jobs.devices()).devices[0];
      const { jobId } = await jobs.start({ sourceId: source.id, mode: 'deleted', capture });
      const complete = await waitFor(events, jobId, 'complete');
      const candidate = jobs.candidates({ jobId, limit: 100 }).items.find(item => item.recordNumber === 24);
      assert.ok(candidate); assert.equal(mutated, true);
      const readsAfterScan = reads;
      if (capture) {
        assert.equal(candidate.preservation.status, 'captured');
        assert.equal(complete.stats.capture.captured, 1);
        const preview = await jobs.preview({ jobId, id: candidate.id });
        assert.equal(preview.type, 'text');
      }
      const output = await jobs.addDestination(destination);
      await jobs.recover({ jobId, ids: [candidate.id], destinationId: output.id });
      const result = (await waitFor(events, jobId, 'recover-complete')).results[0];
      if (capture) {
        assert.equal(result.status, 'saved');
        assert.equal(result.preservation.source, 'discovery-capture');
        assert.equal(hash(await readFile(result.path)), expected.sha256);
        assert.equal(result.originalIdentityVerified, false);
        assert.equal(result.outcome.originalBytesVerified, false);
        assert.equal(reads, readsAfterScan, 'preview and save use captured bytes without touching the changed source');
      } else assert.equal(result.code, 'SOURCE_CHANGED');
    } finally { await jobs.dispose(); }
  }
  assert.equal(hash(await readFile(fixture.imagePath)), hash(original));
});

test('same physical disk is refused before a capture worker can start', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'capture-source-refusal-'));
  let started = false;
  const device = { id: 'C', identity: 'source', diskIds: ['1'], fileSystem: 'NTFS' };
  const jobs = new RecoveryJobs({ workspace, inventory: async () => [device],
    inspect: async file => ({ canonicalPath: await realpath(file), identity: 'same', diskIds: ['1'] }),
    workerFactory() { started = true; throw new Error('must not start'); } });
  try {
    await jobs.initialize();
    const source = (await jobs.devices()).devices[0];
    await assert.rejects(jobs.start({ sourceId: source.id, mode: 'deleted' }), { code: 'RUNTIME_ON_SOURCE' });
    assert.equal(started, false);
  } finally { await jobs.dispose(); }
});
