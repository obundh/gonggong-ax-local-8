import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { openNtfsImage } from '../engine/ntfs-image.mjs';
import { scanCombined, prepareCombinedCandidate } from '../engine/combined-recovery.mjs';
import { DirectorySlackCollector } from '../engine/directory-slack-discovery.mjs';
import { validateDirectorySlackClue } from '../engine/directory-slack-clue.mjs';
import { filterCandidates, matchesCandidate } from '../engine/candidate-filter.mjs';
import { openCandidateStore } from '../engine/candidate-store.mjs';
import { decorateNativeCandidate, prepareNativeCandidate } from '../engine/native-recovery-adapter.mjs';
import { RecoveryJobs } from '../engine/job-service.mjs';
import { createSlackFixture, sampleSlackClue, slackName } from './directory-slack-fixture.mjs';
const sha = b => createHash('sha256').update(b).digest('hex');
async function fixture(options) { return createSlackFixture(path.join(await mkdtemp(path.join(os.tmpdir(), 'dir-slack-')), 'fixture'), options); }

for (const allocation of [false, true]) test(`actual NTFS ${allocation ? 'allocated INDX' : 'resident root'} produces an independent old-name clue after MFT reuse`, async () => {
  const input = await fixture({ allocation }), before = sha(await readFile(input.imagePath));
  const engine = await openNtfsImage(input.imagePath), captured = [];
  try {
    const result = await scanCombined(engine, { strategy: 'vacancy', journalProvider: {}, onDiscovered: c => captured.push(c) });
    const clues = result.candidates.filter(c => c.source === 'directory-slack'); assert.equal(clues.length, 1);
    const clue = clues[0]; assert.equal(clue.name, slackName); assert.equal(clue.recordNumber, 48); assert.equal(clue.sequence, 7);
    assert.ok(validateDirectorySlackClue(clue)); assert.equal(clue.hasContent, false); assert.equal(clue.deletionConfirmed, false);
    assert.equal(clue.deletedAt, null); assert.equal(clue.modifiedAt, null); assert.equal(clue.recordedModifiedAt, '2026-09-20T03:00:00.000Z');
    assert.equal(clue.size, null); assert.equal(clue.recordedSize, 1234); assert.equal(clue.originalPath, null);
    assert.ok(captured.every(c => c.source !== 'directory-slack')); assert.equal(result.stats.directorySlack.bodyAssociations, 0);
    assert.equal(sha(await readFile(input.imagePath)), before);
    await prepareCombinedCandidate(engine, 24); assert.equal(sha(await engine.readCandidateBytes(24)), input.manifest.files.find(f => f.recordNumber === 24).sha256);
    await assert.rejects(prepareNativeCandidate(engine, decorateNativeCandidate(clue, 'p')), { code: 'CONTENT_NOT_LOCATED' });
  } finally { await engine.close(); }
});

test('reused parent, current exact file, unused index buffer and corrupt USA do not yield allocated-tail clues', async t => {
  for (const options of [{ parentSequence: 4 }, { currentSameName: true }, { allocation: true, bitmapAllocated: false }, { allocation: true, corruptUsa: true }]) {
    await t.test(JSON.stringify(options), async () => {
      const input = await fixture(options), engine = await openNtfsImage(input.imagePath);
      try { const result = await scanCombined(engine, { strategy: 'vacancy', journalProvider: {} }); assert.equal(result.candidates.filter(c => c.provenance === 'ntfs-index-unused-tail').length, 0); }
      finally { await engine.close(); }
    });
  }
});

test('allocated index read mutation is rejected and bounds/cancel never silently expand', async () => {
  const input = await fixture({ allocation: true, blockCount: 2 }), engine = await openNtfsImage(input.imagePath);
  try {
    let reads = 0; const original = engine.readStream.bind(engine);
    engine.readStream = async (stream, offset, length, signal) => {
      const bytes = await original(stream, offset, length, signal);
      if (stream.type === 0xa0 && ++reads > 1) { const changed = Buffer.from(bytes); changed[300] ^= 1; return changed; }
      return bytes;
    };
    const collector = new DirectorySlackCollector(engine, { maxBlocks: 1 }); collector.observe({ recordNumber: 44, sequence: 3 });
    assert.deepEqual(await collector.collect(), []); assert.equal(collector.stats.skippedByCode.DIR_SLACK_PARENT_CHANGED, 1); assert.equal(collector.stats.limited, true);
    engine.readStream = original;
    const cap = new DirectorySlackCollector(engine, { maxBlocks: 1, maxClues: 1 }); cap.observe({ recordNumber: 44, sequence: 3 });
    assert.equal((await cap.collect()).length, 1); assert.equal(cap.stats.blocksRead, 1); assert.equal(cap.stats.limited, true);
    const bytes = new DirectorySlackCollector(engine, { maxBytes: 1 }); bytes.observe({ recordNumber: 44, sequence: 3 });
    assert.equal((await bytes.collect()).length, 0); assert.equal(bytes.stats.limited, true);
    const aborter = new AbortController(); aborter.abort(); const cancelled = new DirectorySlackCollector(engine, { signal: aborter.signal });
    cancelled.observe({ recordNumber: 44, sequence: 3 }); await assert.rejects(cancelled.collect(), { code: 'CANCELLED' });
  } finally { await engine.close(); }
});

test('persisted hints validate through paging and cannot gain deletion time, size or save authority', async () => {
  const clue = decorateNativeCandidate(sampleSlackClue(), 'p'); const folder = await mkdtemp(path.join(os.tmpdir(), 'dir-slack-db-'));
  const store = openCandidateStore(path.join(folder, 'candidates.sqlite'));
  try {
    store.set(clue.id, clue); const page = store.page({ filters: { name: slackName }, sort: 'score-desc' });
    assert.equal(page.total, 1); assert.equal(page.items[0].nameMatch.kind, 'exact'); assert.ok(validateDirectorySlackClue(page.items[0]));
    assert.equal(filterCandidates([clue], { includeUnknownDeletedAt: false }).length, 0);
    assert.equal(matchesCandidate(clue, { minSize: 1 }), false);
    for (const change of [c => c.name = '거짓.pdf', c => c.slackEvidence.entryOffset += 8, c => c.slackEvidence.payloadBase64 += 'A', c => c.status = 'readable', c => c.recordedSize++]) {
      const altered = structuredClone(clue); change(altered); assert.equal(validateDirectorySlackClue(altered), null);
      assert.equal(filterCandidates([altered], {}, { keepNameMismatches: true })[0].name, '이름 미확인');
      assert.equal(matchesCandidate(altered, { name: slackName }), false);
    }
    const jobs = new RecoveryJobs({ workspace: folder }); jobs.getJob = () => ({ candidates: new Map([[clue.id, { ...clue, status: 'readable' }]]) });
    await assert.rejects(jobs.recoverReady({ jobId: 'fixture', ids: [clue.id] }), { code: 'CONTENT_NOT_LOCATED' });
  } finally { store.close(); }
});

test('frozen 0.5.7 and current same-image comparison adds an old-name clue without changing recoverable TXT', async t => {
  const baseline = 'E:/RecoveryChat-Stage4d-20260926/baseline/engine';
  try { await access(path.join(baseline, 'combined-recovery.mjs')); } catch { t.skip('frozen local baseline unavailable'); return; }
  const oldCombined = await import(pathToFileURL(path.join(baseline, 'combined-recovery.mjs'))), oldNtfs = await import(pathToFileURL(path.join(baseline, 'ntfs-image.mjs')));
  const input = await fixture({ allocation: true }), old = await oldNtfs.openNtfsImage(input.imagePath), current = await openNtfsImage(input.imagePath);
  try {
    const options = { strategy: 'vacancy', journalProvider: {} };
    const before = await oldCombined.scanCombined(old, options), after = await scanCombined(current, options);
    assert.equal(before.candidates.filter(c => c.name === slackName).length, 0);
    assert.equal(after.candidates.filter(c => c.name === slackName).length, 1);
    // Only the known ATTRIBUTE_LIST fixture record gains the 0.5.18 link guard.
    const expectedPrior = before.candidates.map(c => c.recordNumber === 36 && c.source === 'deleted-record'
      ? { ...c, splitData: true } : c);
    assert.deepEqual(after.candidates.filter(c => c.source !== 'directory-slack'), expectedPrior);
    await oldCombined.prepareCombinedCandidate(old, 24); await prepareCombinedCandidate(current, 24);
    assert.equal(sha(await old.readCandidateBytes(24)), sha(await current.readCandidateBytes(24)));
  } finally { await old.close(); await current.close(); }
});
