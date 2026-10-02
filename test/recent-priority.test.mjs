import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scanCombined, RECENT_PRIORITY_LIMITS } from '../engine/combined-recovery.mjs';
import { openNtfsImage } from '../engine/ntfs-image.mjs';
import { EarlyCaptureStore } from '../engine/early-capture.mjs';
import { createPriorityFixture, targetNumber, hash } from './recent-priority-fixture.mjs';

async function setup(options) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recent-priority-'));
  const fixture = await createPriorityFixture(path.join(root, 'fixture'), options);
  return { root, fixture, engine: await openNtfsImage(fixture.imagePath) };
}

test('newest high record is captured before 70 old slots consume the 64-attempt budget; full vacancy scan remains', async () => {
  const { root, fixture, engine } = await setup();
  const captureRoot = path.join(root, 'captured'); await mkdir(captureRoot);
  const store = new EarlyCaptureStore(captureRoot); await store.initialize();
  const order = [];
  try {
    const result = await scanCombined(engine, { strategy: 'vacancy', journalProvider: fixture.journal,
      onDiscovered: async (candidate, captureTo) => {
        order.push(candidate.recordNumber); Object.assign(candidate, await store.capture(candidate, captureTo));
      } });
    assert.equal(order[0], targetNumber);
    assert.equal(order.filter(n => n === targetNumber).length, 1);
    assert.ok(result.stats.recentPriority.recordsRead <= RECENT_PRIORITY_LIMITS.maxRecords);
    assert.ok(['record-limit', 'time-limit'].includes(result.stats.recentPriority.stopReason));
    assert.equal(result.stats.vacancy.selectedSlots, result.stats.vacancy.slotsVisited);
    assert.equal(result.candidates.filter(c => c.source === 'deleted-record').length, 71);
    assert.equal(new Set(result.candidates.map(c => c.id)).size, result.candidates.length);
    assert.equal(store.stats.attempted, 64); assert.equal(store.stats.limited, true);
    const target = result.candidates.find(c => c.recordNumber === targetNumber);
    assert.equal(target.preservation.status, 'captured');
    assert.deepEqual(target.discoverySources, ['windows-usn', 'mft-vacancy']);
    const saved = await store.recover(target.id, root);
    assert.equal(hash(await readFile(saved.path)), fixture.originals.find(f => f.recordNumber === targetNumber).sha256);
    assert.equal(saved.originalIdentityVerified, false);
    assert.equal(hash(await readFile(fixture.imagePath)), fixture.imageSha256);
  } finally { await engine.close(); }
});

for (const variant of ['wrong-generation', 'wrong-name', 'wrong-parent', 'allocated', 'unknown-time']) {
  test(`${variant} cannot enter the recent priority pass`, async () => {
    const { fixture, engine } = await setup({ variant, count: 3 });
    const priority = []; let phase = '';
    try {
      const result = await scanCombined(engine, { strategy: 'vacancy', journalProvider: fixture.journal,
        onProgress: p => { phase = p.stage; }, onDiscovered: c => { if (phase === 'recent-priority') priority.push(c.recordNumber); } });
      assert.ok(!priority.includes(targetNumber));
      assert.equal(result.stats.vacancy.selectedSlots, result.stats.vacancy.slotsVisited);
      if (variant === 'allocated') assert.ok(!result.candidates.some(c => c.source === 'deleted-record' && c.recordNumber === targetNumber));
      if (variant === 'unknown-time') {
        assert.equal(result.stats.recentPriority.targetsAvailable, 3);
        assert.ok(result.candidates.some(c => c.recordNumber === targetNumber && c.source === 'deleted-record' && c.deletedAt === null));
      }
      assert.equal(hash(await readFile(fixture.imagePath)), fixture.imageSha256);
    } finally { await engine.close(); }
  });
}

test('date window limits the priority pass without skipping the remaining bitmap', async () => {
  const { fixture, engine } = await setup({ count: 3 });
  try {
    const result = await scanCombined(engine, { strategy: 'vacancy', journalProvider: fixture.journal,
      deletedAfter: '2026-09-26T00:00:00Z', onDiscovered() {}, maxCandidates: 1 });
    assert.equal(result.stats.recentPriority.targetsAvailable, 1);
    assert.equal(result.stats.recentPriority.recordsRead, 1);
    assert.equal(result.candidates[0].recordNumber, targetNumber);
    assert.equal(result.stats.vacancy.selectedSlots, result.stats.vacancy.slotsVisited);
  } finally { await engine.close(); }
});

test('record and candidate limits end only the priority pass, not full vacancy coverage', async () => {
  for (const maxCandidates of [100000, 1]) {
    const { fixture, engine } = await setup({ count: 180 });
    try {
      const result = await scanCombined(engine, { strategy: 'vacancy', journalProvider: fixture.journal,
        onDiscovered() {}, maxCandidates });
      assert.equal(result.stats.recentPriority.stopReason, maxCandidates === 1 ? 'candidate-limit' : 'record-limit');
      assert.equal(result.stats.recentPriority.recordsRead, maxCandidates === 1 ? 1 : 64);
      assert.equal(result.stats.vacancy.selectedSlots, result.stats.vacancy.slotsVisited);
      assert.equal(result.candidates.length, maxCandidates === 1 ? 1 : 181);
      if (maxCandidates === 1) { assert.equal(result.truncated, true); assert.equal(result.complete, false); }
    } finally { await engine.close(); }
  }
});

test('missing journal and disabled capture keep the old full vacancy path with explicit priority status', async () => {
  for (const missing of [true, false]) {
    const { fixture, engine } = await setup({ count: 3 });
    try {
      const result = await scanCombined(engine, { strategy: 'vacancy', journalProvider: missing ? {} : fixture.journal,
        ...(missing ? { onDiscovered() {} } : {}) });
      assert.equal(result.stats.recentPriority.enabled, false);
      assert.equal(result.stats.recentPriority.reason, missing ? 'journal-unavailable' : 'capture-disabled');
      assert.equal(result.stats.recentPriority.recordsRead, 0);
      assert.equal(result.stats.vacancy.selectedSlots, result.stats.vacancy.slotsVisited);
      assert.equal(result.candidates.filter(c => c.source === 'deleted-record').length, 4);
    } finally { await engine.close(); }
  }
});

test('priority cancellation releases the busy lock without starting the remaining bitmap scan', async () => {
  const { fixture, engine } = await setup({ count: 3 }), controller = new AbortController();
  let bitmapStarted = false;
  try {
    await assert.rejects(scanCombined(engine, { strategy: 'vacancy', journalProvider: fixture.journal, signal: controller.signal,
      onProgress: p => { if (p.stage === 'bitmap') bitmapStarted = true; }, onDiscovered() { controller.abort(); } }), { code: 'CANCELLED' });
    assert.equal(bitmapStarted, false); assert.equal(engine.busy, false);
  } finally { await engine.close(); }
});

test('cooperative time bound stops priority between reads, then finishes vacancy enumeration', async () => {
  const { fixture, engine } = await setup({ count: 3 });
  let first = true;
  try {
    const result = await scanCombined(engine, { strategy: 'vacancy', journalProvider: fixture.journal,
      async onDiscovered() { if (first) { first = false; await new Promise(r => setTimeout(r, RECENT_PRIORITY_LIMITS.maxMilliseconds + 20)); } } });
    assert.equal(result.stats.recentPriority.recordsRead, 1);
    assert.equal(result.stats.recentPriority.stopReason, 'time-limit');
    assert.equal(result.stats.vacancy.selectedSlots, result.stats.vacancy.slotsVisited);
    assert.equal(result.candidates.filter(c => c.source === 'deleted-record').length, 4);
  } finally { await engine.close(); }
});
