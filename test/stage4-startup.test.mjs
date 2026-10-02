import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, realpath, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RecoveryJobs } from '../engine/job-service.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const device = { id: 'SYNTHETIC', identity: 'v1', diskIds: ['source'], ready: true, fileSystem: 'NTFS' };

for (const scenario of ['success', 'source-changed', 'workspace-failed', 'disposed']) {
  test(`storage preflight overlaps independent checks and gates all writes: ${scenario}`, { timeout: 10000 }, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'stage4-startup-'));
    const sourceGate = deferred(), workspaceGate = deferred();
    let calls = [], workers = 0, jobs;
    try {
      jobs = new RecoveryJobs({ workspace: root,
        inventory: () => { calls.push('source'); return sourceGate.promise; },
        inspect: () => { calls.push('workspace'); return workspaceGate.promise; },
        volumeSession: { async dispose() {} },
        workerFactory() { workers++; const worker = new EventEmitter(); worker.postMessage = () => {}; worker.unref = () => {}; worker.terminate = async () => 0; return worker; },
      });
      await jobs.initialize();
      jobs.sources.set('s', { id: 's', kind: 'volume', device, identity: 'v1' });
      const before = await readdir(root);
      const starting = jobs.start({ sourceId: 's', mode: 'deleted' });
      // Attach immediately: a rejection in either check must never become an
      // unhandled rejection while the independent check is still pending.
      const settled = starting.then(value => ({ value }), error => ({ error }));
      await tick();
      assert.deepEqual(calls, ['source', 'workspace']);
      assert.equal(workers, 0);
      assert.deepEqual(await readdir(root), before);
      if (scenario === 'disposed') await jobs.dispose();
      sourceGate.resolve(scenario === 'source-changed' ? [] : [device]);
      await tick();
      assert.equal(workers, 0, 'source check alone cannot authorize job writes');
      assert.deepEqual(await readdir(root), before);
      if (scenario === 'workspace-failed') workspaceGate.reject(Object.assign(new Error('workspace offline'), { code: 'EACCES' }));
      else workspaceGate.resolve({ canonicalPath: await realpath(root), identity: 'output', diskIds: ['other'], freeSpace: 1e12 });
      const result = await settled;
      if (scenario === 'success') {
        assert.ok(result.value.jobId); assert.equal(workers, 1);
        const job = jobs.getJob(result.value.jobId);
        assert.ok(job.preflight.sourceMs >= 0 && job.preflight.workspaceMs >= 0);
        assert.ok(job.preflight.elapsedMs >= Math.max(job.preflight.sourceMs, job.preflight.workspaceMs));
      } else {
        assert.equal(result.error?.code, { 'source-changed': 'SOURCE_CHANGED', 'workspace-failed': 'EACCES', disposed: 'CANCELLED' }[scenario]);
        assert.equal(workers, 0); assert.deepEqual(await readdir(root), before);
      }
    } finally {
      sourceGate.resolve([]); workspaceGate.resolve({ diskIds: [] }); await jobs?.dispose();
      assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
      assert.ok(path.basename(root).startsWith('stage4-startup-'));
      await rm(root, { recursive: true, force: true });
    }
  });
}
