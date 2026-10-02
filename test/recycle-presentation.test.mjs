import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { metadataClue } from './recycle-presentation-fixture.mjs';
import { validateRecycleMetadataCandidate } from '../engine/recycle-metadata.mjs';
import { filterCandidates, matchesCandidate } from '../engine/candidate-filter.mjs';
import { openCandidateStore } from '../engine/candidate-store.mjs';
import { decorateNativeCandidate, prepareNativeCandidate } from '../engine/native-recovery-adapter.mjs';
import { RecoveryJobs } from '../engine/job-service.mjs';

test('metadata clues keep their proof through naming, SQLite paging and native decoration', async () => {
  const clue = decorateNativeCandidate(metadataClue(), 'ntfs-0');
  const folder = await mkdtemp(path.join(os.tmpdir(), 'recycle-presentation-'));
  const store = openCandidateStore(path.join(folder, 'candidates.sqlite'));
  try {
    store.set(clue.id, clue);
    for (const sort of ['score-desc', 'name-asc', 'path-desc']) {
      const page = store.page({ filters: { name: clue.name }, sort });
      assert.equal(page.total, 1); assert.equal(page.items[0].nameMatch.kind, 'exact');
      assert.ok(validateRecycleMetadataCandidate(page.items[0]));
      assert.equal(page.unknownDeletedTimeTotal, 1);
    }
    assert.equal(filterCandidates([clue], { deletedAfter: '2026-09-24', includeUnknownDeletedAt: false }).length, 0);
    assert.equal(filterCandidates([clue], { minSize: 1 }).length, 0, 'recorded size is not located body size');
  } finally { store.close(); }
});

test('corrupt persisted metadata loses trusted name, historical path, time and size', () => {
  for (const field of ['name', 'originalPath', 'recycledAt', 'recordedSize', 'status', 'requiresPreparation']) {
    const clue = metadataClue(); clue[field] = 'tampered';
    assert.equal(matchesCandidate(clue, { pathContains: '자료' }), false);
    assert.equal(matchesCandidate(clue, { name: '예산 회의' }), false);
    const shown = filterCandidates([clue], {}, { keepNameMismatches: true })[0];
    assert.equal(shown.name, '이름 미확인'); assert.equal(shown.originalPath, null);
    assert.equal(shown.recycledAt, null); assert.equal(shown.recordedSize, null);
    assert.equal(shown.status, 'metadata-only'); assert.equal(shown.hasContent, false);
  }
});

test('service and native preparation refuse metadata-only clues even if status is altered', async () => {
  const clue = { ...metadataClue(), status: 'readable', hasContent: true };
  await assert.rejects(prepareNativeCandidate(null, clue), { code: 'CONTENT_NOT_LOCATED' });
  const jobs = new RecoveryJobs({ workspace: os.tmpdir() });
  jobs.getJob = () => ({ candidates: new Map([[clue.id, clue]]) });
  jobs.validateDestination = () => { throw new Error('must not open destination'); };
  await assert.rejects(jobs.recoverReady({ jobId: 'fixture', ids: [clue.id] }), { code: 'CONTENT_NOT_LOCATED' });
});
