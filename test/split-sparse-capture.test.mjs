import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openNtfsImage } from '../engine/ntfs-image.mjs';
import { scanCombined, prepareCombinedCandidate } from '../engine/combined-recovery.mjs';
import { createSplitSparseFixture } from './ntfs-split-sparse-fixture.mjs';

test('combined discovery and preparation preserve the split-record capture restriction', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'split-sparse-combined-'));
  const fixture = await createSplitSparseFixture(root, { scenario: 'extended' });
  const image = await openNtfsImage(fixture.imagePath);
  try {
    const scan = await scanCombined(image, { strategy: 'vacancy', journalProvider: {} });
    const candidate = scan.candidates.find(c => c.recordNumber === fixture.recordNumber);
    assert.ok(candidate);
    assert.equal(candidate.status, 'unverified');
    assert.equal(candidate.splitData, true);
    const prepared = await prepareCombinedCandidate(image, fixture.recordNumber);
    assert.equal(prepared.status, 'readable');
    assert.equal(prepared.splitData, true);
    assert.deepEqual(await image.readCandidateBytes(fixture.recordNumber), fixture.expectedBytes);
  } finally { await image.close(); }
});
