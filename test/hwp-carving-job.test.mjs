import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { RecoveryJobs } from '../engine/job-service.mjs';
import { createFixture } from './ntfs-fixtures.mjs';
import { createHwpFixture } from './hwp-carving-fixture.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function waitFor(events, jobId, type) {
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    const failure = events.find(e => e.jobId === jobId && e.type === 'error');
    if (failure) throw Error(JSON.stringify(failure));
    const result = events.find(e => e.jobId === jobId && e.type === type);
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw Error(`Missing ${type}`);
}

test('real deep worker finds nameless HWP inside verified free ranges, previews, persists and saves exact bytes', { timeout: 60000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recovery-hwp-job-'));
  const ntfs = await createFixture(path.join(root, 'fixture'));
  const hwp = createHwpFixture().bytes;
  const image = await readFile(ntfs.imagePath);
  hwp.copy(image, 100 * 4096);
  await writeFile(ntfs.imagePath, image);
  const workspace = path.join(root, 'workspace'), destination = path.join(root, 'destination');
  await mkdir(workspace); await mkdir(destination);
  const events = [];
  // Destination metadata is a fixture; source parsing, workers, candidate storage,
  // byte extraction, preview and selected recovery are real production paths.
  const jobs = new RecoveryJobs({ workspace, onEvent: e => events.push(e), inspect: async target => {
    const canonicalPath = await realpath(target);
    assert.ok([workspace, destination].includes(canonicalPath));
    return { canonicalPath, identity: canonicalPath, diskIds: ['fixture-output'], freeSpace: 1e12, fileSystem: 'NTFS' };
  } });
  try {
    await jobs.initialize();
    const source = await jobs.addSource('image', ntfs.imagePath);
    const output = await jobs.addDestination(destination);
    const started = await jobs.start({ sourceId: source.id, destinationId: output.id, mode: 'deep', deepScope: 'unallocated', filters: {} });
    await waitFor(events, started.jobId, 'complete');
    assert.equal(jobs.getJob(started.jobId).stats.scanScope, 'verified-unallocated');
    const candidates = jobs.candidates({ jobId: started.jobId, limit: 100 }).items;
    const found = candidates.filter(c => c.format === 'hwp');
    assert.equal(found.length, 1);
    const candidate = found[0];
    assert.equal(candidate.source, 'carved');
    assert.equal(candidate.originalIdentityVerified, false);
    assert.equal(candidate.originalLengthKnown, false);
    assert.equal(candidate.structuralValidation.savedOutputRechecked, true);
    assert.equal(candidate.structuralValidation.fullDocumentValidated, false);
    assert.match(candidate.name, /^carved-.*\.hwp$/);
    assert.equal(sha(await readFile(candidate.path)), sha(hwp));
    const preview = await jobs.preview({ jobId: started.jobId, id: candidate.id });
    assert.equal(preview.type, 'text');
    assert.equal(preview.truncated, true);
    const recovery = await jobs.recover({ jobId: started.jobId, ids: [candidate.id], destinationId: output.id });
    const completed = await waitFor(events, recovery.jobId, 'recover-complete');
    assert.equal(completed.results.length, 1);
    const saved = completed.results[0];
    assert.equal(saved.status, 'saved');
    assert.equal(sha(await readFile(saved.path)), sha(hwp));
    assert.equal(saved.document.applicationOpenVerified, false);
    assert.equal(saved.document.originalIdentityVerified, false);
    assert.equal(sha(await readFile(ntfs.imagePath)), sha(image));
  } finally { await jobs.dispose(); }
});
