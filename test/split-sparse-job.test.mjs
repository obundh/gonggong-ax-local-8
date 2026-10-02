import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RecoveryJobs } from '../engine/job-service.mjs';
import { createSplitSparseFixture } from './ntfs-split-sparse-fixture.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function waitFor(events, jobId, type) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const failure = events.find(e => e.jobId === jobId && e.type === 'error');
    if (failure) throw new Error(JSON.stringify(failure));
    const found = events.find(e => e.jobId === jobId && e.type === type);
    if (found) return found;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Missing ${type}`);
}

for (const scenario of ['extended', 'multi-extension-uninitialized']) {
  test(`real image worker saves exact split sparse bytes: ${scenario}`, { timeout: 30000 }, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'split-sparse-worker-'));
    const fixture = await createSplitSparseFixture(path.join(root, 'fixture'), { scenario });
    const workspace = path.join(root, 'workspace'), destination = path.join(root, 'output'), events = [];
    await mkdir(workspace); await mkdir(destination);
    // Regular synthetic image; the output device inventory is simulated.
    // The real worker/parser/body writer and output verification execute.
    const jobs = new RecoveryJobs({ workspace, onEvent: e => events.push(e),
      inspect: async p => ({ canonicalPath: await realpath(p), identity: 'synthetic-output',
        diskIds: ['test-output'], freeSpace: 1e12, fileSystem: 'NTFS' }) });
    await jobs.initialize();
    try {
      const source = await jobs.addSource('image', fixture.imagePath);
      const output = await jobs.addDestination(destination);
      const { jobId } = await jobs.start({ sourceId: source.id, mode: 'deleted' });
      await waitFor(events, jobId, 'complete');
      const candidate = jobs.candidates({ jobId, limit: 100 }).items.find(c => c.recordNumber === fixture.recordNumber);
      assert.ok(candidate);
      assert.equal(candidate.storage, 'sparse');
      assert.equal(candidate.status, 'readable');
      assert.equal(candidate.splitData, true);
      assert.ok(candidate.reasons.some(r => r.includes('$ATTRIBUTE_LIST')));
      const reply = await jobs.recover({ jobId, ids: [candidate.id], destinationId: output.id });
      const complete = await waitFor(events, reply.jobId, 'recover-complete');
      assert.equal(complete.results.length, 1);
      const result = complete.results[0];
      assert.equal(result.status, 'saved');
      assert.equal(result.size, fixture.logicalSize);
      assert.equal(sha(await readFile(result.path)), fixture.expectedSHA);
      assert.deepEqual(await readFile(result.path), fixture.expectedBytes);
      assert.equal(result.integrity.status, 'verified');
      assert.equal(result.originalIdentityVerified, false);
      assert.equal(await jobs.recoveredPath({ jobId, id: candidate.id }), result.path);
      assert.equal(sha(await readFile(fixture.imagePath)), fixture.imageSHA);
    } finally { await jobs.dispose(); }
  });
}
