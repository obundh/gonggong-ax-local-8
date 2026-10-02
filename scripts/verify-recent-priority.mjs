// Fixed-image comparison only: never opens a real drive or deletes user files.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createPriorityFixture, targetNumber, hash } from '../test/recent-priority-fixture.mjs';

const [baselineDirectory, currentDirectory, outputDirectory] = process.argv.slice(2);
if (!baselineDirectory || !currentDirectory || !outputDirectory) throw Error('Supply baseline engine, current engine and fresh output directory');
const output = path.resolve(outputDirectory); await mkdir(output);
const fixture = await createPriorityFixture(path.join(output, 'fixture'));
const versions = [];
for (const [label, directory] of [['baseline', baselineDirectory], ['current', currentDirectory]]) {
  const root = path.resolve(directory), load = file => import(pathToFileURL(path.join(root, file)));
  const { scanCombined } = await load('combined-recovery.mjs');
  const { openNtfsImage } = await load('ntfs-image.mjs');
  const { EarlyCaptureStore } = await load('early-capture.mjs');
  versions.push({ label, scanCombined, openNtfsImage, EarlyCaptureStore,
    engineSha256: hash(await readFile(path.join(root, 'combined-recovery.mjs'))) });
}
const rows = [];
for (let trial = 1; trial <= 3; trial++) {
  for (const v of trial % 2 ? versions : [...versions].reverse()) {
    const folder = path.join(output, `${v.label}-${trial}`); await mkdir(folder);
    const engine = await v.openNtfsImage(fixture.imagePath), store = new v.EarlyCaptureStore(folder);
    await store.initialize(); const order = []; let targetSeenMs = null;
    const start = performance.now();
    try {
      const result = await v.scanCombined(engine, { strategy: 'vacancy', journalProvider: fixture.journal,
        onDiscovered: async (candidate, captureTo) => {
          order.push(candidate.recordNumber);
          if (candidate.recordNumber === targetNumber) targetSeenMs = performance.now() - start;
          Object.assign(candidate, await store.capture(candidate, captureTo));
        } });
      const scanMs = performance.now() - start;
      const frozen = JSON.stringify(result, (_k, val) => typeof val === 'bigint' ? String(val) : val, 2);
      await writeFile(path.join(folder, 'candidates.json'), frozen, { flag: 'wx' });
      // Original bytes and hashes are used only after the scan result is frozen.
      const exact = [];
      for (const original of fixture.originals) {
        const candidate = result.candidates.find(c => c.recordNumber === original.recordNumber && c.source === 'deleted-record');
        if (candidate && store.has(candidate.id)) {
          const bytes = await store.read(candidate.id);
          assert.equal(hash(bytes), original.sha256); assert.equal(bytes.length, original.size);
          exact.push(original.recordNumber);
        }
      }
      assert.equal(result.stats.vacancy.selectedSlots, result.stats.vacancy.slotsVisited);
      assert.equal(result.candidates.filter(c => c.source === 'deleted-record').length, 71);
      assert.equal(hash(await readFile(fixture.imagePath)), fixture.imageSha256);
      const row = { trial, version: v.label, engineSha256: v.engineSha256, scanMs, targetSeenMs,
        targetOrder: order.indexOf(targetNumber) + 1, targetExact: exact.includes(targetNumber),
        exactCount: exact.length, denominator: 71, capture: store.stats, priority: result.stats.recentPriority ?? null,
        candidateIds: result.candidates.map(c => c.id).sort(), candidateFreezeSha256: hash(Buffer.from(frozen)),
        frozenBeforeScoring: true, sourceUnchanged: true };
      rows.push(row); await writeFile(path.join(folder, 'score.json'), JSON.stringify(row, null, 2), { flag: 'wx' });
      console.log(JSON.stringify({ trial, version: v.label, targetOrder: row.targetOrder, targetExact: row.targetExact, exactCount: row.exactCount, scanMs }));
    } finally { await engine.close(); }
  }
}
for (let trial = 1; trial <= 3; trial++) {
  const old = rows.find(r => r.trial === trial && r.version === 'baseline'), current = rows.find(r => r.trial === trial && r.version === 'current');
  assert.deepEqual(old.candidateIds, current.candidateIds);
  assert.equal(old.targetOrder, 71); assert.equal(old.targetExact, false);
  assert.equal(current.targetOrder, 1); assert.equal(current.targetExact, true);
  assert.equal(old.exactCount, 64); assert.equal(current.exactCount, 64);
}
await writeFile(path.join(output, 'comparison.json'), JSON.stringify({ rows, imageSha256: fixture.imageSha256,
  scope: 'Synthetic intact resident TXT files on one fixed NTFS image. Serial, cache-influenced. Not an SSD deletion trial or a general recovery-rate gain.',
  conclusion: 'Same 71 candidates and 64 exact captures; newest target is prioritized instead of an old target. Latest target exact 0/3 -> 3/3.' }, null, 2), { flag: 'wx' });
