import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { openNtfsImage } from '../engine/ntfs-image.mjs';
import { scanCombined, prepareCombinedCandidate } from '../engine/combined-recovery.mjs';
import { readNativeJournal, parseNativeUsnBatch } from '../engine/native-usn.mjs';
import { createUsnFixture, usnRecord } from './usn-fixture.mjs';

const hash = b => createHash('sha256').update(b).digest('hex');
function batch(records, next) { const head = Buffer.alloc(8); head.writeBigInt64LE(BigInt(next)); return Buffer.concat([head, ...records]); }
function journal({ gap = false, badIdentity = false } = {}) {
  let calls = 0;
  return {
    async queryJournal() { return { journalId: '999', firstUsn: '1000', lowestValidUsn: '1000', nextUsn: '2000' }; },
    async readJournal() {
      if (++calls > 1) { if (gap) throw Object.assign(new Error('retained range lost'), { code: 'USN_ENTRY_DELETED' }); return { data: batch([], 2000) }; }
      return { data: batch([
        usnRecord({ recordNumber: 24, sequence: 6, reason: 0x1000, name: '원래-문서.txt', usn: 1100 }),
        usnRecord({ recordNumber: 24, sequence: badIdentity ? 7 : 6, usn: 1200 }),
        usnRecord({ recordNumber: 25, sequence: 3, name: 'contiguous.bin', usn: 1300 }),
      ], gap ? 1500 : 2000) };
    },
  };
}
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rc-combinations-'));
  const fixture = await createUsnFixture(path.join(root, 'fixture'));
  return { root, fixture, engine: await openNtfsImage(fixture.imagePath) };
}

test('three combinations discover and recover the same resident and nonresident originals', async () => {
  const { root, fixture, engine } = await setup();
  try {
    const baseline = hash(await readFile(fixture.imagePath)), report = [];
    for (const strategy of ['journal', 'vacancy', 'combined']) {
      const scan = await scanCombined(engine, { strategy, journalProvider: journal() });
      assert.equal(scan.candidates.filter(c => [24, 25].includes(c.recordNumber)).length, 2);
      assert.ok(scan.candidates.every(c => c.status === 'unverified'));
      assert.equal(engine.scanned.size, 0, 'discovery alone does not authorize existing byte reader');
      const outputs = [];
      for (const number of [24, 25]) {
        const prepared = await prepareCombinedCandidate(engine, number);
        assert.equal(prepared.status, 'readable');
        const output = await engine.recover(number, path.join(root, strategy));
        const bytes = await readFile(output.path), expected = fixture.manifest.files.find(f => f.recordNumber === number);
        assert.equal(hash(bytes), expected.sha256);
        outputs.push({ recordNumber: number, exactHash: true, bytes: bytes.length });
      }
      report.push({ strategy, candidates: scan.candidates.length, dated: scan.stats.datedCandidates, stats: scan.stats, outputs });
    }
    assert.equal(hash(await readFile(fixture.imagePath)), baseline);
    console.log(JSON.stringify({ syntheticCombinations: report, sourceUnchanged: true, evidence: 'fabricated NTFS image, not a Windows volume' }));
  } finally { await engine.close(); }
});

test('journal gap retains earlier events and combined path retains independent undated records', async () => {
  const { engine } = await setup();
  try {
    const result = await scanCombined(engine, { journalProvider: journal({ gap: true }), deletedAfter: '2026-09-12T00:00:00Z' });
    assert.equal(result.coverage.journalComplete, false);
    assert.ok(result.candidates.find(c => c.recordNumber === 24)?.deletedAt);
    assert.ok(result.candidates.find(c => c.recordNumber === 26)?.dateMatch === 'unknown');
    assert.ok(result.warnings.some(w => w.code === 'USN_ENTRY_DELETED'));
    await prepareCombinedCandidate(engine, 24);
    assert.match((await engine.readCandidateBytes(24)).toString(), /문서/);
  } finally { await engine.close(); }
});

test('missing journal does not suppress vacant records or fabricate their deletion dates', async () => {
  const { engine } = await setup();
  try {
    const result = await scanCombined(engine, { journalProvider: {}, deletedAfter: '2026-09-12T00:00:00Z' });
    assert.ok(result.candidates.some(c => c.recordNumber === 24));
    assert.ok(result.candidates.every(c => c.deletedAt === null && c.dateMatch === 'unknown'));
    assert.equal(result.complete, false);
  } finally { await engine.close(); }
});

test('wrong generation cannot supply a date or rename hint, and record reuse blocks selected recovery', async () => {
  const { engine } = await setup();
  try {
    const result = await scanCombined(engine, { journalProvider: journal({ badIdentity: true }) });
    const candidate = result.candidates.find(c => c.recordNumber === 24 && c.source === 'deleted-record');
    assert.equal(candidate.deletedAt, null); assert.deepEqual(candidate.previousNameHints, []);
    const trace = result.candidates.find(c => c.recordNumber === 24 && c.source === 'deletion-trace');
    assert.equal(trace.status, 'metadata-only'); assert.notEqual(trace.sequence + 1, candidate.sequence);
    assert.equal(trace.hasContent, false);
    const original = engine.record.bind(engine);
    engine.record = async (...args) => { const r = await original(...args); return args[0] === 24 ? { ...r, fingerprint: 'reused' } : r; };
    await assert.rejects(prepareCombinedCandidate(engine, 24), { code: 'SOURCE_CHANGED' });
    assert.equal(engine.scanned.size, 0);
  } finally { await engine.close(); }
});

test('candidate cap is explicit while vacancy scan still visits the complete fixed bitmap range', async () => {
  const { engine } = await setup();
  try {
    const result = await scanCombined(engine, { journalProvider: journal(), maxCandidates: 1 });
    assert.equal(result.candidates.length, 1); assert.equal(result.truncated, true); assert.equal(result.complete, false);
    assert.equal(result.stats.vacancy.slotsVisited, result.stats.vacancy.selectedSlots);
  } finally { await engine.close(); }
});

test('native response parser accepts filtered USN gaps but rejects malformed records and backward continuations', () => {
  const valid = batch([usnRecord({ usn: 1200 }), usnRecord({ usn: 1800 })], 2000);
  assert.equal(parseNativeUsnBatch(valid, { startUsn: '1000', endUsn: '1500' }).events.length, 1);
  assert.throws(() => parseNativeUsnBatch(valid.subarray(0, valid.length - 1), { startUsn: '1000', endUsn: '2000' }), { code: 'USN_PROTOCOL' });
  assert.throws(() => parseNativeUsnBatch(batch([], 999), { startUsn: '1000', endUsn: '2000' }), { code: 'USN_PROTOCOL' });
});

test('completed fixed-bound read survives normal later appends; cancellation and budgets stay explicit', async () => {
  let queries = 0;
  const provider = journal(), query = provider.queryJournal;
  provider.queryJournal = async () => { queries++; return query(); };
  const result = await readNativeJournal(provider);
  assert.equal(result.complete, true); assert.equal(queries, 1);
  const limited = await readNativeJournal(journal(), { maxEvents: 1 });
  assert.equal(limited.events.length, 1); assert.equal(limited.complete, false);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readNativeJournal(journal(), { signal: controller.signal }), { code: 'CANCELLED' });
});

test('journal candidate verification visits newest deletions first instead of sorting only the final list', async () => {
  const { engine } = await setup();
  try {
    const provider = {
      async queryJournal() { return { journalId: '22', firstUsn: '1000', lowestValidUsn: '1000', nextUsn: '3000' }; },
      async readJournal() { return { data: batch([
        usnRecord({ recordNumber: 24, sequence: 6, name: '삭제된-문서.txt', deletedAt: '2026-09-12T08:00:00.000Z', usn: 1200 }),
        usnRecord({ recordNumber: 25, sequence: 3, name: 'contiguous.bin', deletedAt: '2026-09-12T09:00:00.000Z', usn: 2200 }),
      ], 3000) }; },
    };
    const visits = [], original = engine.record.bind(engine);
    engine.record = async (number, signal) => { visits.push(number); return original(number, signal); };
    const published = [], result = await scanCombined(engine, { strategy: 'journal', journalProvider: provider,
      onCandidate: candidate => published.push(candidate.recordNumber) });
    assert.deepEqual(visits.filter(number => number === 24 || number === 25), [25, 24]);
    assert.deepEqual(published, [25, 24]);
    assert.deepEqual(result.candidates.map(candidate => candidate.recordNumber), [25, 24]);
    assert.ok(result.candidates.find(candidate => candidate.recordNumber === 24).nameReferences.every(reference => Number.isInteger(reference.namespace)));
  } finally { await engine.close(); }
});

test('combined scan and preparation preserve a canonical recycle name beside its same-parent DOS namespace alias', async () => {
  const { engine } = await setup();
  try {
    const parent = { recordNumber: 5, sequence: 1 };
    const original = engine.record.bind(engine);
    engine.record = async (number, signal) => {
      const record = await original(number, signal);
      return number === 24 ? { ...record, names: [
        { name: '$RSPA2FG.docx', namespace: 1, parent },
        { name: '$RSPA2~1.DOC', namespace: 2, parent },
      ] } : record;
    };
    const provider = {
      async queryJournal() { return { journalId: '23', firstUsn: '1000', lowestValidUsn: '1000', nextUsn: '2000' }; },
      async readJournal() { return { data: batch([
        usnRecord({ recordNumber: 24, sequence: 6, reason: 0x1000, name: '독립 평가.docx', usn: 1100 }),
        usnRecord({ recordNumber: 24, sequence: 6, reason: 0x2000, name: '$RSPA2FG.docx', usn: 1200 }),
        usnRecord({ recordNumber: 24, sequence: 6, reason: 0x200, name: '$RSPA2FG.docx', usn: 1300 }),
      ], 2000) }; },
    };
    const result = await scanCombined(engine, { strategy: 'journal', journalProvider: provider });
    const discovered = result.candidates.find(candidate => candidate.recordNumber === 24);
    assert.deepEqual(discovered.nameReferences.map(reference => [reference.name, reference.namespace]), [
      ['$RSPA2FG.docx', 1], ['$RSPA2~1.DOC', 2],
    ]);
    assert.equal(discovered.restorationName.name, '독립 평가.docx');
    const prepared = await prepareCombinedCandidate(engine, 24);
    assert.equal(prepared.status, 'readable');
    assert.deepEqual(engine.scanned.get(24).recordEvidence.names.map(reference => [reference.name, reference.namespace]), [
      ['$RSPA2FG.docx', 1], ['$RSPA2~1.DOC', 2],
    ]);
    assert.equal(discovered.restorationName.name, '독립 평가.docx');
  } finally { await engine.close(); }
});

test('recent period reads a bounded journal tail and measures the physically skipped USN span', async () => {
  const starts = [], after = '2026-09-12T00:00:00.000Z';
  const provider = {
    async queryJournal() { return { journalId: '31', firstUsn: '0', lowestValidUsn: '0', nextUsn: '10000000' }; },
    async readJournal({ startUsn }) {
      starts.push(startUsn);
      return { data: batch([
        usnRecord({ recordNumber: 24, deletedAt: '2026-09-11T23:59:59.999Z', usn: 9999100 }),
        usnRecord({ recordNumber: 25, deletedAt: '2026-09-12T08:00:00.000Z', usn: 9999200 }),
      ], 10000000) };
    },
  };
  const result = await readNativeJournal(provider, { deletedAfter: after, recentTailUsn: 1000 });
  assert.deepEqual(starts, ['9999000']);
  assert.equal(result.complete, false);
  assert.equal(result.stats.physicallyReduced, true);
  assert.equal(result.stats.fullJournalComplete, false);
  assert.equal(result.stats.periodCoverage, 'observed-boundary-partial');
  assert.equal(result.stats.periodFilterMode, 'source-range-and-event-filter');
  assert.equal(result.stats.timeDirectedHeuristic, true);
  assert.equal(result.stats.fullRetainedFallbackAvailable, true);
  assert.equal(result.stats.retainedUsnSpan, '10000000');
  assert.equal(result.stats.visitedUsnSpan, '1000');
  assert.equal(result.stats.skippedUsnSpan, '9999000');
  assert.ok(result.warnings.some(warning => warning.code === 'USN_TIME_DIRECTED_PARTIAL'));

  starts.length = 0;
  const full = await readNativeJournal(provider, { deletedAfter: after, recentTailUsn: 1000, periodReadStrategy: 'full-retained' });
  assert.deepEqual(starts, ['0']);
  assert.equal(full.stats.physicallyReduced, false);
  assert.equal(full.stats.fullJournalComplete, true);
  assert.equal(full.stats.periodFilterMode, 'event-filter-after-full-retained-read');
  assert.equal(full.stats.fullRetainedFallbackAvailable, false);
});

test('unknown journal times fall back to the full retained range and report filter-after-read limitations', async () => {
  const starts = [];
  const provider = {
    async queryJournal() { return { journalId: '32', firstUsn: '0', lowestValidUsn: '0', nextUsn: '4000' }; },
    async readJournal({ startUsn }) {
      starts.push(startUsn); const start = Number(startUsn);
      const records = [usnRecord({ recordNumber: 24 + starts.length, deletedAt: null, usn: start + 100 })];
      if (start < 3000) records.push(usnRecord({ recordNumber: 28, deletedAt: null, usn: 3100 }));
      return { data: batch(records, 4000) };
    },
  };
  const result = await readNativeJournal(provider, { deletedAfter: '2026-09-12T00:00:00.000Z', recentTailUsn: 1000 });
  assert.deepEqual(starts, ['3000', '2000', '0']);
  assert.equal(result.complete, false);
  assert.equal(result.stats.physicallyReduced, false);
  assert.equal(result.stats.fullJournalComplete, true);
  assert.equal(result.stats.sourceReadMode, 'full-retained-fallback');
  assert.equal(result.stats.periodCoverage, 'timestamps-unavailable');
  assert.equal(result.stats.periodFilterMode, 'event-filter-after-full-retained-read');
  assert.equal(result.stats.overreadBatches, 2);
  assert.equal(result.stats.overreadEventsDiscarded, 2);
  assert.deepEqual(result.events.map(event => event.usn), ['100', '2100', '3100']);
  assert.ok(result.warnings.some(warning => warning.code === 'USN_TIME_RANGE_UNSUPPORTED'));
});

test('no-period latest-first mode starts at the journal tail and honestly reports unread retained history', async () => {
  const requests = [];
  const provider = {
    async queryJournal() { return { journalId: '34', firstUsn: '0', lowestValidUsn: '0', nextUsn: '10000000' }; },
    async readJournal(request) {
      requests.push(request);
      return { data: batch([usnRecord({ recordNumber: 25, deletedAt: null, usn: 9999100 })], 10000000) };
    },
  };
  const result = await readNativeJournal(provider, { latestFirst: true, recentTailUsn: 1000, maxBytes: 65536 });
  assert.equal(requests[0].startUsn, '9999000');
  assert.equal(requests[0].maxBytes, 65536);
  assert.equal(result.complete, false);
  assert.equal(result.stats.sourceReadMode, 'latest-tail-bounded');
  assert.equal(result.stats.latestCoverage, 'latest-tail-partial');
  assert.equal(result.stats.physicallyReduced, true);
  assert.ok(result.warnings.some(warning => warning.code === 'USN_LATEST_TAIL_PARTIAL'));
});

test('journal loss during tail expansion keeps new events but marks requested-period coverage unknown', async () => {
  const starts = [];
  const provider = {
    async queryJournal() { return { journalId: '33', firstUsn: '0', lowestValidUsn: '0', nextUsn: '4000' }; },
    async readJournal({ startUsn }) {
      starts.push(startUsn);
      if (starts.length > 1) throw Object.assign(new Error('journal rolled while reading'), { code: 'USN_ENTRY_DELETED' });
      return { data: batch([usnRecord({ recordNumber: 25, deletedAt: '2026-09-12T08:00:00.000Z', usn: 3100 })], 4000) };
    },
  };
  const result = await readNativeJournal(provider, { deletedAfter: '2026-09-12T00:00:00.000Z', recentTailUsn: 1000 });
  assert.deepEqual(starts, ['3000', '2000']);
  assert.equal(result.events.length, 1);
  assert.equal(result.complete, false);
  assert.equal(result.stats.physicallyReduced, true);
  assert.equal(result.stats.fullJournalComplete, false);
  assert.equal(result.stats.periodCoverage, 'journal-lost-during-read');
  assert.ok(result.warnings.some(warning => warning.code === 'USN_ENTRY_DELETED'));
});

test('a retained journal that starts after the requested period reports possible rollover instead of complete coverage', async () => {
  const provider = {
    async queryJournal() { return { journalId: '35', firstUsn: '1000', lowestValidUsn: '1000', nextUsn: '2000' }; },
    async readJournal() { return { data: batch([
      usnRecord({ recordNumber: 25, deletedAt: '2026-09-13T08:00:00.000Z', usn: 1100 }),
    ], 2000) }; },
  };
  const result = await readNativeJournal(provider, { deletedAfter: '2026-09-12T00:00:00.000Z' });
  assert.equal(result.complete, false);
  assert.equal(result.stats.fullJournalComplete, true);
  assert.equal(result.stats.periodCoverage, 'retained-history-exhausted');
  assert.ok(result.warnings.some(warning => warning.code === 'USN_RETAINED_RANGE_LIMIT'));
});

test('an invalid estimated tail cursor retries the retained boundary and finds older and newer records', async () => {
  const starts = [];
  const provider = {
    async queryJournal() { return { journalId: '41', firstUsn: '1000', lowestValidUsn: '1000', nextUsn: '5000' }; },
    async readJournal(request) {
      starts.push(request);
      if (request.startUsn === '4000') throw Object.assign(new Error('invalid seek cursor'), { code: 'JOURNAL_INVALID_PARAMETER' });
      assert.equal(request.startUsn, '1000');
      return { data: batch([
        usnRecord({ recordNumber: 24, usn: 1100, deletedAt: '2026-09-11T23:00:00.000Z' }),
        usnRecord({ recordNumber: 25, usn: 4200, deletedAt: '2026-09-12T08:00:00.000Z' }),
      ], 5000) };
    },
  };
  const result = await readNativeJournal(provider, { deletedAfter: '2026-09-12T00:00:00.000Z', recentTailUsn: 1000 });
  assert.deepEqual(starts.map(x => x.startUsn), ['4000', '1000']);
  assert.ok(starts.every(x => x.journalId === '41'));
  assert.deepEqual(result.events.map(x => x.recordNumber), [24, 25]);
  assert.equal(result.complete, true);
  assert.equal(result.stats.fullJournalComplete, true);
  assert.equal(result.stats.physicallyReduced, false);
  assert.equal(result.stats.sourceReadMode, 'full-retained-cursor-fallback');
  assert.equal(result.stats.invalidCursorFallbacks, 1);
});

test('invalid backward expansion retains already read events, deduplicates, and uses the remaining budget', async () => {
  const starts = [];
  const provider = {
    async queryJournal() { return { journalId: '42', firstUsn: '0', lowestValidUsn: '0', nextUsn: '4000' }; },
    async readJournal(request) {
      starts.push(request);
      if (request.startUsn === '2000') throw Object.assign(new Error('invalid seek cursor'), { code: 'JOURNAL_INVALID_PARAMETER' });
      if (request.startUsn === '3000') return { data: batch([usnRecord({ recordNumber: 25, usn: 3100 })], 4000) };
      return { data: batch([
        usnRecord({ recordNumber: 24, usn: 100, deletedAt: '2026-09-10T00:00:00.000Z' }),
        usnRecord({ recordNumber: 25, usn: 3100 }),
      ], 4000) };
    },
  };
  const result = await readNativeJournal(provider, { deletedAfter: '2026-09-12T00:00:00.000Z', recentTailUsn: 1000, maxBytes: 100000 });
  assert.deepEqual(starts.map(x => x.startUsn), ['3000', '2000', '0']);
  assert.ok(starts[2].maxBytes < starts[0].maxBytes);
  assert.deepEqual(result.events.map(x => x.usn), ['100', '3100']);
  assert.equal(result.stats.fullJournalComplete, true);
  assert.equal(result.stats.invalidCursorFallbacks, 1);
});

test('cursor fallback is single shot and does not hide read, generation or caller-cursor failures', async () => {
  for (const [code, options, expectedReads] of [
    ['JOURNAL_INVALID_PARAMETER', { latestFirst: true, recentTailUsn: 1000 }, 2],
    ['JOURNAL_READ_FAILED', { latestFirst: true, recentTailUsn: 1000 }, 1],
    ['JOURNAL_ENTRY_DELETED', { latestFirst: true, recentTailUsn: 1000 }, 1],
    ['JOURNAL_INVALID_PARAMETER', { startUsn: '3000' }, 1],
  ]) {
    let calls = 0;
    const result = await readNativeJournal({
      async queryJournal() { return { journalId: '43', firstUsn: '0', lowestValidUsn: '0', nextUsn: '4000' }; },
      async readJournal() { calls++; throw Object.assign(new Error('failed'), { code }); },
    }, options);
    assert.equal(calls, expectedReads);
    assert.equal(result.complete, false);
    assert.equal(result.stats.fullJournalComplete, false);
    assert.ok(result.warnings.some(w => w.code === code));
  }
});

test('cancellation and exhausted budgets remain terminal during cursor fallback', async () => {
  const controller = new AbortController(); let calls = 0;
  const provider = {
    async queryJournal() { return { journalId: '44', firstUsn: '0', lowestValidUsn: '0', nextUsn: '4000' }; },
    async readJournal() { calls++; controller.abort(); throw Object.assign(new Error('invalid'), { code: 'JOURNAL_INVALID_PARAMETER' }); },
  };
  await assert.rejects(readNativeJournal(provider, { latestFirst: true, recentTailUsn: 1000, signal: controller.signal }), { code: 'CANCELLED' });
  assert.equal(calls, 1);
  calls = 0;
  const limited = await readNativeJournal(provider, { latestFirst: true, recentTailUsn: 1000, maxBytes: 65535 });
  assert.equal(calls, 0);
  assert.equal(limited.complete, false);
  assert.ok(limited.warnings.some(w => w.code === 'USN_BUDGET_LIMIT'));
});
