import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RecoveryJobs } from '../engine/job-service.mjs';
import { normalizeMetadataCandidate } from '../engine/candidate-filter.mjs';
import { chooseRecoveryName } from '../engine/recovery-name.mjs';
import { createWindowsShortcut } from './recent-shortcut-fixture.mjs';

async function waitFor(events, jobId) {
  const start = Date.now();
  while (Date.now() - start < 15000) {
    const event = events.find(e => e.jobId === jobId && ['complete', 'error'].includes(e.type));
    if (event) { assert.notEqual(event.type, 'error', JSON.stringify(event.error)); return event; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw Error('Worker did not complete');
}

test('Windows-created shortcut stays a clue even after its target is moved; worker never recovers it', { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
  const temporary = path.resolve(os.tmpdir()), root = await mkdtemp(path.join(temporary, 'recovery-recent-job-'));
  const recent = path.join(root, 'Recent'), target = path.join(root, '기억할 문서.txt');
  await mkdir(recent); await writeFile(target, 'original test-owned document');
  await createWindowsShortcut(path.join(recent, '기억할 문서.lnk'), target);
  const moved = path.join(root, 'moved.txt'); await rename(target, moved);
  const events = [], jobs = new RecoveryJobs({ workspace: path.join(root, 'workspace'),
    recentInventory: async () => ({ path: recent, exists: true, status: 'existing', error: null }),
    onEvent: e => events.push(e) });
  try {
    await jobs.initialize(); const { source } = await jobs.recentSource();
    await assert.rejects(jobs.start({ sourceId: source.id, mode: 'copies' }), { code: 'SOURCE_KIND' });
    const started = await jobs.start({ sourceId: source.id, mode: 'traces' });
    await waitFor(events, started.jobId);
    const page = jobs.candidates({ jobId: started.jobId, filters: {} });
    assert.equal(page.total, 1);
    const item = page.items[0];
    assert.equal(item.name, '기억할 문서.txt'); assert.equal(item.originalPath.toLowerCase(), target.toLowerCase());
    assert.equal(item.source, 'recent-link'); assert.equal(item.status, 'metadata-only');
    assert.equal(item.hasContent, false); assert.equal(item.originalIdentityVerified, false); assert.equal(item.deletionConfirmed, false);
    assert.equal(item.clue.targetExistence, 'not-checked');
    assert.equal(jobs.getJob(started.jobId).outputPath, null);
    assert.equal((await jobs.preview({ jobId: started.jobId, id: item.id })).type, 'unsupported');
    await assert.rejects(jobs.recover({ jobId: started.jobId, ids: [item.id] }), { code: 'CONTENT_NOT_LOCATED' });
    assert.throws(() => jobs.requestWorker(jobs.getJob(started.jobId), 'load-index'), { code: 'INVALID_MODE' });
    assert.equal(await readFile(moved, 'utf8'), 'original test-owned document');
  } finally {
    await jobs.dispose();
    const relative = path.relative(temporary, root); assert.ok(relative.startsWith('recovery-recent-job-') && !relative.includes(path.sep));
    await rm(root, { recursive: true, force: true });
  }
});

test('recent-link normalization cannot promote a shortcut to recovered content', () => {
  const value = normalizeMetadataCandidate({ source: 'recent-link', name: 'report.pdf', status: 'readable', path: 'C:/report.pdf',
    size: 999, modifiedAt: '2026-09-27', deletedAt: '2026-09-27', hasContent: true, requiresPreparation: true,
    originalIdentityVerified: true, deletionConfirmed: true, restorationName: { name: 'original.pdf' } });
  assert.equal(value.status, 'metadata-only'); assert.equal(value.hasContent, false); assert.equal(value.originalIdentityVerified, false);
  assert.equal(value.path, null); assert.equal(value.size, null); assert.equal(value.modifiedAt, null); assert.equal(value.deletedAt, null);
  assert.equal(value.deletionConfirmed, false); assert.equal(value.restorationName, null);
  assert.equal(chooseRecoveryName(value).originalNameStatus, 'path-clue');
});
