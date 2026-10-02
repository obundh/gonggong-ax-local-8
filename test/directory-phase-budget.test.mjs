import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  allocatedTailNames,
  createDirectoryPhaseBudgetFixture,
  freedIndexNames,
} from './directory-phase-budget-fixture.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const currentEngineRoot = path.resolve(here, '..', 'engine');
const selectedEngineRoot = path.resolve(process.env.RECOVERY_ENGINE_ROOT ?? currentEngineRoot);
const frozenEngineRoot = 'E:/RecoveryChat-Reinforcement-0510-20260926/baseline/engine';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const isFreed = candidate => candidate.provenance === 'ntfs-index-freed-buffer';

async function loadEngine(root) {
  const [ntfs, combined] = await Promise.all([
    import(pathToFileURL(path.join(root, 'ntfs-image.mjs')).href),
    import(pathToFileURL(path.join(root, 'combined-recovery.mjs')).href),
  ]);
  return { ...ntfs, ...combined };
}

const selected = await loadEngine(selectedEngineRoot);

async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'dir-phase-budget-'));
  return createDirectoryPhaseBudgetFixture(path.join(base, 'fixture'));
}

async function scan(modules, imagePath, maxCandidates = 100000) {
  const engine = await modules.openNtfsImage(imagePath);
  try {
    const result = await modules.scanCombined(engine, {
      strategy: 'vacancy',
      journalProvider: {},
      maxCandidates,
    });
    return { engine, result };
  } catch (error) {
    await engine.close();
    throw error;
  }
}

test('allocated-tail saturation preserves every prior result while an independent freed pass adds unique clues', async t => {
  try { await access(path.join(frozenEngineRoot, 'combined-recovery.mjs')); }
  catch { t.skip('frozen 0.5.9 baseline unavailable'); return; }

  const frozen = await loadEngine(frozenEngineRoot);
  const input = await fixture();
  const sourceBefore = sha256(await readFile(input.imagePath));
  const oldScan = await scan(frozen, input.imagePath);
  const newScan = await scan(selected, input.imagePath);

  try {
    const before = oldScan.result;
    const after = newScan.result;
    const expectedBody = input.manifest.files.find(item => item.recordNumber === 24);
    const oldBody = before.candidates.find(candidate => candidate.recordNumber === 24 && candidate.source === 'deleted-record');
    const newBody = after.candidates.find(candidate => candidate.recordNumber === 24 && candidate.source === 'deleted-record');

    assert.equal(before.stats.directorySlack.clues, 128);
    assert.equal(before.stats.directoryFreedIndex.clues, 0, 'the frozen engine demonstrates the shared-budget starvation');
    assert.equal(after.stats.directorySlack.clues, 128);
    assert.equal(after.stats.directoryFreedIndex.clues, freedIndexNames.length);
    assert.equal(after.stats.directoryFreedIndex.directoriesInspected > 0, true);
    assert.equal(after.stats.directoryFreedIndex.blocksRead, 8);
    assert.equal(after.stats.directoryFreedIndex.clueLimit, 128);
    assert.notEqual(after.stats.directoryFreedIndex.execution, 'skipped');
    assert.equal(after.stats.directoryFreedIndex.skippedReason, null);
    assert.equal(after.coverage.directoryClueLimitPerPass, 128);
    assert.equal(after.coverage.directoryClueCombinedLimit, 256);
    assert.equal(after.stats.directorySlack.clues + after.stats.directoryFreedIndex.clues, 256);

    // Only the known ATTRIBUTE_LIST fixture record gains the 0.5.18 link guard.
    const expectedPrior = before.candidates.map(c => c.recordNumber === 36 && c.source === 'deleted-record'
      ? { ...c, splitData: true } : c);
    assert.deepEqual(
      after.candidates.filter(candidate => !isFreed(candidate)),
      expectedPrior,
      'the independent pass preserves prior candidates apart from the explicit split-record guard',
    );
    assert.deepEqual(
      after.candidates.filter(candidate => allocatedTailNames.includes(candidate.name)).map(candidate => candidate.name).sort(),
      [...allocatedTailNames].sort(),
    );
    assert.deepEqual(
      after.candidates.filter(isFreed).map(candidate => candidate.name).sort(),
      [...freedIndexNames].sort(),
    );
    assert.deepEqual(newBody, oldBody);
    assert.equal(newBody.status, 'unverified');

    const oldPrepared = await frozen.prepareCombinedCandidate(oldScan.engine, 24);
    const newPrepared = await selected.prepareCombinedCandidate(newScan.engine, 24);
    assert.equal(oldPrepared.status, 'readable');
    assert.equal(newPrepared.status, 'readable');
    assert.equal(sha256(await oldScan.engine.readCandidateBytes(24)), expectedBody.sha256);
    assert.equal(sha256(await newScan.engine.readCandidateBytes(24)), expectedBody.sha256);
    assert.equal(sha256(await readFile(input.imagePath)), sourceBefore, 'the input image stays byte-for-byte unchanged');
  } finally {
    await oldScan.engine.close();
    await newScan.engine.close();
  }
});

test('the global candidate cap explicitly skips a no-room freed pass and applies only the actual remaining room', async () => {
  const input = await fixture();
  const sourceBefore = sha256(await readFile(input.imagePath));
  const full = await scan(selected, input.imagePath);
  const bodyCount = full.result.candidates.filter(candidate => candidate.source === 'deleted-record').length;
  const noRoomLimit = bodyCount + allocatedTailNames.length;
  await full.engine.close();

  const noRoom = await scan(selected, input.imagePath, noRoomLimit);
  const twoSpaces = await scan(selected, input.imagePath, noRoomLimit + 2);
  try {
    assert.equal(noRoom.result.candidates.length, noRoomLimit);
    assert.equal(noRoom.result.stats.directorySlack.clues, 128);
    assert.equal(noRoom.result.stats.directoryFreedIndex.clues, 0);
    assert.equal(noRoom.result.stats.directoryFreedIndex.directoriesInspected, 0);
    assert.equal(noRoom.result.stats.directoryFreedIndex.clueLimit, 0);
    assert.equal(noRoom.result.stats.directoryFreedIndex.execution, 'skipped');
    assert.equal(noRoom.result.stats.directoryFreedIndex.skippedReason, 'global-candidate-limit');
    assert.equal(noRoom.result.coverage.directoryFreedIndexExecution, 'skipped');
    assert.equal(noRoom.result.coverage.directoryFreedIndexSkippedReason, 'global-candidate-limit');
    assert.equal(noRoom.result.candidates.some(isFreed), false);

    assert.equal(twoSpaces.result.candidates.length, noRoomLimit + 2);
    assert.equal(twoSpaces.result.candidates.length <= noRoomLimit + 2, true);
    assert.equal(twoSpaces.result.stats.directorySlack.clues, 128);
    assert.equal(twoSpaces.result.stats.directoryFreedIndex.clues, 2);
    assert.equal(twoSpaces.result.stats.directoryFreedIndex.clueLimit, 2);
    assert.equal(twoSpaces.result.stats.directoryFreedIndex.directoriesInspected > 0, true);
    assert.equal(twoSpaces.result.stats.directoryFreedIndex.blocksRead, 8);
    assert.equal(twoSpaces.result.stats.directoryFreedIndex.execution, 'limited');
    assert.equal(twoSpaces.result.stats.directoryFreedIndex.skippedReason, null);
    assert.deepEqual(
      twoSpaces.result.candidates.filter(isFreed).map(candidate => candidate.name),
      freedIndexNames.slice(0, 2),
    );
    assert.equal(sha256(await readFile(input.imagePath)), sourceBefore, 'bounded scans do not alter the image');
  } finally {
    await noRoom.engine.close();
    await twoSpaces.engine.close();
  }
});
