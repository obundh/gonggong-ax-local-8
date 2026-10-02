import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RecoveryJobs } from '../engine/job-service.mjs';
import { createNtfsCompressionFixture } from './ntfs-compression-fixture.mjs';

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

for (const scenario of ['uninitialized-poison', 'malformed-decode']) {
  test(`real image worker preserves compressed output boundaries: ${scenario}`, { timeout: 40000 }, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'compression-worker-'));
    const fixture = await createNtfsCompressionFixture(path.join(root, 'fixture'), { scenario });
    const workspace = path.join(root, 'workspace'), destination = path.join(root, 'output'), events = [];
    await mkdir(workspace); await mkdir(destination);
    // Fixed regular image input. Physical destination identity is simulated;
    // the production worker, parser, decompressor, and output verification run.
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
      assert.equal(candidate.storage, 'compressed');
      assert.equal(candidate.status, 'readable');
      const reply = await jobs.recover({ jobId, ids: [candidate.id], destinationId: output.id });
      const complete = await waitFor(events, reply.jobId, 'recover-complete');
      assert.equal(complete.results.length, 1);
      const result = complete.results[0];
      if (scenario === 'uninitialized-poison') {
        assert.equal(result.status, 'saved');
        assert.equal(result.size, fixture.logicalSize);
        assert.equal(sha(await readFile(result.path)), fixture.expectedSHA);
        assert.equal(result.integrity.status, 'verified');
        assert.equal(result.originalIdentityVerified, false);
      } else {
        assert.equal(result.status, 'failed');
        assert.equal(result.code, 'INVALID_COMPRESSED_DATA');
        assert.equal(result.path, undefined);
        assert.equal((await readdir(destination)).some(name => name.startsWith('recovered-')), false);
      }
      assert.equal(sha(await readFile(fixture.imagePath)), fixture.imageSHA);
    } finally { await jobs.dispose(); }
  });
}
