import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RecoveryJobs } from '../engine/job-service.mjs';
import { createUsnFixture } from './usn-fixture.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('recent search carries real journal dates through Worker, pagination, preview and recovery', { timeout: 25000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rc-recent-job-'));
  let jobs;
  try {
    const fixture = await createUsnFixture(path.join(root, 'image'));
    const before = hash(await readFile(fixture.imagePath));
    const workspace = path.join(root, 'workspace');
    const destination = path.join(root, 'destination');
    await Promise.all([mkdir(workspace), mkdir(destination)]);
    let receive;
    const events = [];
    jobs = new RecoveryJobs({ workspace, onEvent: event => { events.push(event); receive?.(event); },
      inspect: async target => ({ canonicalPath: await realpath(target), identity: path.resolve(target), diskIds: ['fixture-output'], freeSpace: 1e12, fileSystem: 'NTFS' }) });
    await jobs.initialize();
    const source = await jobs.addSource('image', fixture.imagePath);
    const output = await jobs.addDestination(destination);
    async function until(type, start) {
      let timer;
      const completion = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Missing Worker event: ' + type)), 15000);
        receive = event => {
          if (event.type === 'error') reject(new Error(event.message));
          else if (event.type === type) resolve(event);
        };
      });
      try { await start(); return await completion; }
      finally { clearTimeout(timer); receive = null; }
    }
    let started;
    const completion = await until('complete', async () => { started = await jobs.start({ sourceId: source.id, destinationId: output.id, mode: 'deleted', recent: true, filters: {} }); });
    const first = jobs.candidates({ jobId: started.jobId, sort: 'deleted-desc', limit: 2 });
    assert.deepEqual(first.items.map(item => item.recordNumber), [25, 24]);
    for (const item of first.items) {
      assert.equal(item.deletedAt, fixture.deletionTimes.get(`ntfs:${item.recordNumber}:${item.sequence}`));
      assert.equal(item.deletedAtSource, 'ntfs-usn');
    }
    assert.equal(completion.stats.deletionTimesKnown, 2);
    const rest = jobs.candidates({ jobId: started.jobId, sort: 'deleted-desc', offset: 2, limit: 100 });
    assert.ok(rest.items.length > 0 && rest.items.every(item => item.deletedAt === null));
    assert.ok(events.some(event => event.type === 'progress' && event.stage === 'journal'));
    assert.equal(jobs.history().jobs.find(job => job.id === started.jobId).recent, true);
    const candidate = first.items.find(item => item.recordNumber === 24);
    const preview = await jobs.preview({ jobId: started.jobId, id: candidate.id });
    assert.equal(preview.type, 'text');
    const saved = await until('recover-complete', () => jobs.recover({ jobId: started.jobId, ids: [candidate.id], destinationId: output.id }));
    assert.equal(saved.results[0].status, 'saved');
    assert.equal(hash(await readFile(saved.results[0].path)), fixture.manifest.files.find(item => item.recordNumber === 24).sha256);
    assert.equal(hash(await readFile(fixture.imagePath)), before);
  } finally { await jobs?.dispose(); await rm(root, { recursive: true, force: true }); }
});
