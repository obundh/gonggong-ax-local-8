import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { openNtfsImage } from '../engine/ntfs-image.mjs';
import { scanCombined, prepareCombinedCandidate } from '../engine/combined-recovery.mjs';
import { DirectorySlackCollector } from '../engine/directory-slack-discovery.mjs';
import { validateDirectorySlackClue } from '../engine/directory-slack-clue.mjs';
import { openCandidateStore } from '../engine/candidate-store.mjs';
import { decorateNativeCandidate, prepareNativeCandidate } from '../engine/native-recovery-adapter.mjs';
import { RecoveryJobs } from '../engine/job-service.mjs';
import {
  createFreedIndexFixture,
  existingRootName,
  freedTailName,
  freedUsedName,
} from './directory-freed-fixture.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const freed = candidate => candidate.provenance === 'ntfs-index-freed-buffer';

async function fixture(options) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'dir-freed-'));
  return createFreedIndexFixture(path.join(base, 'fixture'), options);
}

async function collectFreed(engine, options = {}, collectOptions = {}) {
  const collector = new DirectorySlackCollector(engine, { mode: 'freed-index', ...options });
  collector.observe({ recordNumber: 44, sequence: 3 });
  return { candidates: await collector.collect(collectOptions), collector };
}

test('a bitmap-free but volume-allocated INDX node yields its formerly used entry and tail as bounded metadata clues', async () => {
  const input = await fixture();
  const before = sha256(await readFile(input.imagePath));
  const engine = await openNtfsImage(input.imagePath);
  try {
    const { candidates, collector } = await collectFreed(engine);
    assert.deepEqual(candidates.map(candidate => candidate.name).sort(), [freedTailName, freedUsedName].sort());
    assert.equal(collector.stats.blocksRead, 1);
    assert.equal(collector.stats.clues, 2);
    for (const candidate of candidates) {
      assert.equal(candidate.source, 'directory-slack');
      assert.equal(candidate.provenance, 'ntfs-index-freed-buffer');
      assert.equal(candidate.hasContent, false);
      assert.equal(candidate.status, 'metadata-only');
      assert.equal(candidate.storage, 'unlocated');
      assert.equal(candidate.deletionConfirmed, false);
      assert.equal(candidate.bodyAssociation, 'not-asserted');
      assert.equal(candidate.slackEvidence.version, 2);
      assert.equal(candidate.slackEvidence.kind, 'freed-allocation');
      assert.deepEqual(candidate.slackEvidence.indexBitmap, { byteOffset: 0, value: 0 });
      assert.ok(validateDirectorySlackClue(candidate));
    }
    assert.equal(sha256(await readFile(input.imagePath)), before);
  } finally {
    await engine.close();
  }
});

test('a current exact identity is excluded, and index-bitmap or volume-bitmap allocation state is authoritative', async t => {
  await t.test('current exact file', async () => {
    const input = await fixture({ currentSameName: true });
    const engine = await openNtfsImage(input.imagePath);
    try {
      const { candidates } = await collectFreed(engine);
      assert.deepEqual(candidates.map(candidate => candidate.name), [freedTailName]);
    } finally { await engine.close(); }
  });

  await t.test('index bitmap bit one', async () => {
    const input = await fixture({ freedIndexes: [], evidenceIndexes: [0] });
    const engine = await openNtfsImage(input.imagePath);
    try {
      const { candidates, collector } = await collectFreed(engine);
      assert.deepEqual(candidates, []);
      assert.equal(collector.stats.blocksRead, 0);
    } finally { await engine.close(); }
  });

  await t.test('volume bitmap bit zero', async () => {
    const input = await fixture({ volumeAllocated: false });
    const engine = await openNtfsImage(input.imagePath);
    try {
      const { candidates, collector } = await collectFreed(engine);
      assert.deepEqual(candidates, []);
      assert.equal(collector.stats.clues, 0);
      assert.ok(Object.keys(collector.stats.skippedByCode).length > 0);
    } finally { await engine.close(); }
  });
});

test('torn USA, wrong VCN, and an index-bitmap change during proof recheck are rejected', async t => {
  for (const [label, options] of [['torn USA', { corruptUsa: true }], ['wrong VCN', { wrongVcn: true }]]) {
    await t.test(label, async () => {
      const input = await fixture(options);
      const engine = await openNtfsImage(input.imagePath);
      try {
        const { candidates, collector } = await collectFreed(engine);
        assert.deepEqual(candidates, []);
        assert.equal(collector.stats.clues, 0);
        assert.ok(Object.keys(collector.stats.skippedByCode).length > 0);
      } finally { await engine.close(); }
    });
  }

  await t.test('index bitmap mutation', async () => {
    const input = await fixture();
    const engine = await openNtfsImage(input.imagePath);
    try {
      let bitmapReads = 0;
      const original = engine.readStream.bind(engine);
      engine.readStream = async (stream, offset, length, signal) => {
        const bytes = await original(stream, offset, length, signal);
        if (stream.type === 0xb0 && stream.name === '$I30' && ++bitmapReads > 1) {
          const changed = Buffer.from(bytes);
          changed[0] ^= 1;
          return changed;
        }
        return bytes;
      };
      const { candidates, collector } = await collectFreed(engine);
      assert.deepEqual(candidates, []);
      assert.equal(collector.stats.clues, 0);
      assert.ok(Object.keys(collector.stats.skippedByCode).some(code => code.includes('CHANGED')));
    } finally { await engine.close(); }
  });
});

test('the existing allocated-tail result survives a malformed freed node and has separate combined statistics', async () => {
  const input = await fixture({ rootClue: true, corruptUsa: true });
  const engine = await openNtfsImage(input.imagePath);
  try {
    const result = await scanCombined(engine, { strategy: 'vacancy', journalProvider: {} });
    const existing = result.candidates.filter(candidate => candidate.name === existingRootName);
    assert.equal(existing.length, 1);
    assert.equal(existing[0].slackEvidence.version, 1);
    assert.equal(existing[0].provenance, 'ntfs-index-unused-tail');
    assert.equal(result.candidates.some(freed), false);
    assert.equal(result.stats.directorySlack.clues, 1);
    assert.equal(result.stats.directoryFreedIndex.clues, 0);
    assert.ok(Object.keys(result.stats.directoryFreedIndex.skippedByCode).length > 0);
  } finally { await engine.close(); }
});

test('a freed-pass time limit cannot discard the allocated-tail clue collected first', async () => {
  const input = await fixture({ rootClue: true });
  const engine = await openNtfsImage(input.imagePath);
  try {
    let delayed = false;
    const original = engine.readStream.bind(engine);
    engine.readStream = async (stream, offset, length, signal) => {
      if (!delayed && stream.type === 0xa0 && stream.name === '$I30') {
        delayed = true;
        await new Promise(resolve => setTimeout(resolve, 1510));
      }
      return original(stream, offset, length, signal);
    };
    const result = await scanCombined(engine, { strategy: 'vacancy', journalProvider: {} });
    const existing = result.candidates.filter(candidate => candidate.name === existingRootName);
    assert.equal(existing.length, 1);
    assert.equal(existing[0].slackEvidence.version, 1);
    assert.equal(result.candidates.some(freed), false);
    assert.equal(result.stats.directorySlack.clues, 1);
    assert.equal(result.stats.directoryFreedIndex.clues, 0);
    assert.equal(result.stats.directoryFreedIndex.limited, true);
    assert.equal(result.stats.directoryFreedIndex.skippedByCode.DIR_SLACK_LIMIT, 1);
  } finally { await engine.close(); }
});

test('an existing allocated-tail clue wins exact identity deduplication over the same freed-node clue', async () => {
  const input = await fixture({ rootDuplicateFreed: true });
  const engine = await openNtfsImage(input.imagePath);
  try {
    const result = await scanCombined(engine, { strategy: 'vacancy', journalProvider: {} });
    const duplicateIdentity = result.candidates.filter(candidate => candidate.name === freedUsedName
      && candidate.recordNumber === 48 && candidate.sequence === 7);
    assert.equal(duplicateIdentity.length, 1);
    assert.equal(duplicateIdentity[0].slackEvidence.version, 1);
    assert.equal(duplicateIdentity[0].provenance, 'ntfs-index-unused-tail');
    assert.equal(result.candidates.filter(candidate => candidate.name === freedTailName).length, 1);
    assert.equal(result.stats.directoryFreedIndex.duplicateCluesSkipped, 1);
  } finally { await engine.close(); }
});

test('freed-index discovery enforces eight reads, the first 64 positions, a soft time limit, and cancellation', async t => {
  await t.test('eight freed blocks per parent', async () => {
    const indexes = Array.from({ length: 9 }, (_, index) => index);
    const input = await fixture({ blockCount: 9, freedIndexes: indexes, evidenceIndexes: indexes, entriesPerBlock: 16 });
    const engine = await openNtfsImage(input.imagePath);
    try {
      const { candidates, collector } = await collectFreed(engine);
      assert.equal(collector.stats.blocksRead, 8);
      assert.equal(candidates.length, 128);
      assert.equal(collector.stats.limited, true);
      assert.ok(candidates.every(candidate => candidate.slackEvidence.expectedVcn < 8));
      assert.ok(collector.stats.bytesRead <= 4 * 1024 * 1024);
    } finally { await engine.close(); }
  });

  await t.test('first 64 block positions', async () => {
    const input = await fixture({ blockCount: 65, freedIndexes: [63, 64], evidenceIndexes: [63, 64] });
    const engine = await openNtfsImage(input.imagePath);
    try {
      const { candidates, collector } = await collectFreed(engine);
      assert.equal(collector.stats.blocksRead, 1);
      assert.equal(candidates.length, 2);
      assert.ok(candidates.every(candidate => candidate.name.includes('-63.')));
      assert.equal(collector.stats.limited, true);
    } finally { await engine.close(); }
  });

  await t.test('soft elapsed-time limit', async () => {
    const input = await fixture();
    const engine = await openNtfsImage(input.imagePath);
    try {
      const original = engine.readStream.bind(engine);
      engine.readStream = async (stream, offset, length, signal) => {
        if (stream.type === 0xa0 && stream.name === '$I30') await new Promise(resolve => setTimeout(resolve, 5));
        return original(stream, offset, length, signal);
      };
      const { candidates, collector } = await collectFreed(engine, { maxTimeMs: 1 });
      assert.deepEqual(candidates, []);
      assert.equal(collector.stats.limited, true);
      assert.equal(collector.stats.skippedByCode.DIR_SLACK_LIMIT, 1);
    } finally { await engine.close(); }
  });

  await t.test('already cancelled', async () => {
    const input = await fixture();
    const engine = await openNtfsImage(input.imagePath);
    try {
      const aborter = new AbortController();
      aborter.abort();
      const collector = new DirectorySlackCollector(engine, { mode: 'freed-index', signal: aborter.signal });
      collector.observe({ recordNumber: 44, sequence: 3 });
      await assert.rejects(collector.collect(), { code: 'CANCELLED' });
    } finally { await engine.close(); }
  });
});

test('frozen 0.5.8 candidates retain prior fields apart from the explicit split-record guard', async t => {
  const baseline = 'E:/RecoveryChat-Stage4e-20260926/baseline/engine';
  try { await access(path.join(baseline, 'combined-recovery.mjs')); }
  catch { t.skip('frozen 0.5.8 baseline unavailable'); return; }
  const oldCombined = await import(pathToFileURL(path.join(baseline, 'combined-recovery.mjs')));
  const oldNtfs = await import(pathToFileURL(path.join(baseline, 'ntfs-image.mjs')));
  const input = await fixture({ rootClue: true });
  const old = await oldNtfs.openNtfsImage(input.imagePath);
  const current = await openNtfsImage(input.imagePath);
  try {
    const options = { strategy: 'vacancy', journalProvider: {} };
    const before = await oldCombined.scanCombined(old, options);
    const after = await scanCombined(current, options);
    assert.equal(before.candidates.some(candidate => [freedUsedName, freedTailName].includes(candidate.name)), false);
    // The fixture's record 36 contains ATTRIBUTE_LIST. 0.5.18 explicitly marks
    // it to prevent a base-record-only link to a previous search's body.
    const expectedPrior = before.candidates.map(c => c.recordNumber === 36 && c.source === 'deleted-record'
      ? { ...c, splitData: true } : c);
    assert.deepEqual(after.candidates.filter(candidate => !freed(candidate)), expectedPrior);
    assert.deepEqual(after.candidates.filter(freed).map(candidate => candidate.name).sort(), [freedTailName, freedUsedName].sort());
    assert.equal(after.candidates.filter(candidate => candidate.name === existingRootName).length, 1);
    await oldCombined.prepareCombinedCandidate(old, 24);
    await prepareCombinedCandidate(current, 24);
    assert.equal(sha256(await old.readCandidateBytes(24)), sha256(await current.readCandidateBytes(24)));
  } finally {
    await old.close();
    await current.close();
  }
});

test('persisted freed evidence rejects bitmap proof mutation and never gains preview, preparation, or save authority', async () => {
  const input = await fixture();
  const engine = await openNtfsImage(input.imagePath);
  const folder = await mkdtemp(path.join(os.tmpdir(), 'dir-freed-db-'));
  const store = openCandidateStore(path.join(folder, 'candidates.sqlite'));
  try {
    const result = await scanCombined(engine, { strategy: 'vacancy', journalProvider: {} });
    const candidate = decorateNativeCandidate(result.candidates.find(freed), 'p');
    assert.ok(candidate);
    assert.equal(candidate.requiresPreparation, false);
    assert.ok(validateDirectorySlackClue(candidate));
    store.set(candidate.id, candidate);
    const page = store.page({ filters: { name: candidate.name }, sort: 'score-desc' });
    assert.equal(page.total, 1);
    assert.ok(validateDirectorySlackClue(page.items[0]));

    for (const change of [
      clue => clue.slackEvidence.indexBitmap.byteOffset += 1,
      clue => clue.slackEvidence.indexBitmap.value ^= 1,
      clue => clue.slackEvidence.payloadBase64 += 'A',
      clue => clue.status = 'readable',
    ]) {
      const altered = structuredClone(candidate);
      change(altered);
      assert.equal(validateDirectorySlackClue(altered), null);
    }

    await assert.rejects(prepareNativeCandidate(engine, candidate), { code: 'CONTENT_NOT_LOCATED' });
    await assert.rejects(prepareCombinedCandidate(engine, candidate.recordNumber), { code: 'SCAN_REQUIRED' });
    const jobs = new RecoveryJobs({ workspace: folder });
    jobs.getJob = () => ({ candidates: new Map([[candidate.id, { ...candidate, status: 'readable' }]]) });
    await assert.rejects(jobs.recoverReady({ jobId: 'fixture', ids: [candidate.id] }), { code: 'CONTENT_NOT_LOCATED' });
  } finally {
    store.close();
    await engine.close();
  }
});
