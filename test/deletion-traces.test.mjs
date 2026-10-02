import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDeletionTraces } from '../engine/deletion-traces.mjs';

const sourceParent = { recordNumber: 90, sequence: 4 };
const recycleParent = { recordNumber: 500, sequence: 2 };
function event({ recordNumber = 42, sequence = 12, usn, reason, name, parent = recycleParent, atMs = 1000, fileAttributes } = {}) {
  return { recordNumber, sequence, usn: String(usn), reason, name, parent, atMs, ...(fileAttributes === undefined ? {} : { fileAttributes }) };
}
function deletion(overrides = {}) { return event({ usn: 110, reason: 0x200, name: '$RABC123.docx', ...overrides }); }
function trace(events, overrides = {}) {
  return buildDeletionTraces({ events, journalId: '77', ...overrides });
}

test('a reused current MFT generation remains a metadata-only USN trace without content or replacement sequence', () => {
  const result = trace([deletion()], { observations: new Map([[42, { sequence: 13, flags: 1, fingerprint: 'post-scan' }]]) });
  assert.equal(result.candidates.length, 1);
  const candidate = result.candidates[0];
  assert.equal(candidate.id, 'usn:77:42:12:110');
  assert.equal(candidate.recordNumber, 42);
  assert.equal(candidate.sequence, 12);
  assert.equal(candidate.source, 'deletion-trace');
  assert.equal(candidate.status, 'metadata-only');
  assert.equal(candidate.storage, 'unlocated');
  assert.equal(candidate.hasContent, false);
  assert.equal(candidate.requiresPreparation, false);
  assert.equal(candidate.size, null);
  assert.equal(candidate.originalIdentityVerified, false);
  assert.equal(candidate.name, '$RABC123.docx');
  assert.equal(candidate.traceEvidence.currentRecordObservation.sequence, 13);
  assert.equal(candidate.traceEvidence.deleteUsn, '110');
  assert.equal(candidate.traceEvidence.fileReference, ((12n << 48n) | 42n).toString());
});

test('only one exact adjacent same-generation rename proof restores a history-only name', () => {
  const result = trace([
    event({ usn: 100, reason: 0x1000, name: '원래 보고서.docx', parent: sourceParent }),
    event({ usn: 101, reason: 0x2000, name: '$RABC123.docx' }),
    deletion(),
  ]);
  const candidate = result.candidates[0];
  assert.equal(candidate.name, '원래 보고서.docx');
  assert.equal(candidate.originalNameStatus, 'history-only');
  assert.equal(candidate.restorationName.source, 'windows-usn-rename-pair');
  assert.equal(candidate.traceEvidence.rename.oldNameUsn, '100');
  assert.deepEqual(candidate.previousNameHints, ['원래 보고서.docx']);
  assert.equal(candidate.hasContent, false);
});

test('same basename across a different generation and ambiguous rename pairs never create history proof', () => {
  const crossGeneration = trace([
    event({ sequence: 11, usn: 100, reason: 0x1000, name: '다른 문서.docx', parent: sourceParent }),
    event({ sequence: 11, usn: 101, reason: 0x2000, name: '$RABC123.docx' }),
    deletion(),
  ]).candidates[0];
  assert.equal(crossGeneration.name, '$RABC123.docx');
  assert.equal(crossGeneration.originalNameStatus, 'unknown');

  const ambiguous = trace([
    event({ usn: 90, reason: 0x1000, name: '초안.docx', parent: sourceParent }),
    event({ usn: 91, reason: 0x2000, name: '$RABC123.docx' }),
    event({ usn: 100, reason: 0x1000, name: '원래 보고서.docx', parent: sourceParent }),
    event({ usn: 101, reason: 0x2000, name: '$RABC123.docx' }),
    deletion(),
  ]).candidates[0];
  assert.equal(ambiguous.originalNameStatus, 'unknown');
});

test('directory events are excluded and missing dates are retained as unknown without a false date match', () => {
  const result = trace([
    deletion({ recordNumber: 9, sequence: 2, usn: 10, name: 'folder', fileAttributes: 0x10 }),
    deletion({ recordNumber: 10, sequence: 3, usn: 11, name: 'date-unknown.txt', atMs: null }),
  ], { after: '1970-01-01T00:00:01.000Z', before: '1970-01-01T00:00:02.000Z' });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].name, 'date-unknown.txt');
  assert.equal(result.candidates[0].deletedAt, null);
  assert.equal(result.candidates[0].dateMatch, 'unknown');
  assert.equal(result.stats.directoriesSkipped, 1);
  assert.equal(result.stats.unknownDates, 1);
});

test('bounded newest-first output does not silently discard a valid deletion, and exact content identities suppress only themselves', () => {
  const events = [
    deletion({ recordNumber: 1, sequence: 2, usn: 10, name: 'old.txt', atMs: 1000 }),
    deletion({ recordNumber: 2, sequence: 2, usn: 20, name: 'new.txt', atMs: 3000 }),
    deletion({ recordNumber: 3, sequence: 2, usn: 30, name: 'middle.txt', atMs: 2000 }),
  ];
  const limited = trace(events, { maxTraces: 2 });
  assert.deepEqual(limited.candidates.map(item => item.name), ['new.txt', 'middle.txt']);
  assert.equal(limited.truncated, true);
  assert.equal(limited.stats.maxTraces, 2);

  const suppressed = trace(events, { matchedIdentities: new Set(['2:2:20']) });
  assert.deepEqual(suppressed.candidates.map(item => item.name), ['middle.txt', 'old.txt']);
  assert.equal(suppressed.stats.matchedSuppressed, 1);
});

test('conflicting duplicate USNs and sequence maximum do not create an incorrect trace name', () => {
  const conflict = trace([
    deletion({ usn: 110 }),
    deletion({ usn: 110, name: 'different.docx' }),
  ]);
  assert.equal(conflict.candidates.length, 0);
  assert.equal(conflict.stats.conflictingUsns, 1);

  const maximumSequence = trace([
    event({ sequence: 0xffff, usn: 100, reason: 0x1000, name: '원래 보고서.docx', parent: sourceParent }),
    event({ sequence: 0xffff, usn: 101, reason: 0x2000, name: '$RABC123.docx' }),
    deletion({ sequence: 0xffff, usn: 110 }),
  ]).candidates[0];
  assert.equal(maximumSequence.sequence, 0xffff);
  assert.equal(maximumSequence.originalNameStatus, 'unknown');
});

test('malformed journal and date inputs are rejected without producing broad unfiltered traces', () => {
  const events = [deletion()];
  const badJournal = buildDeletionTraces({ events, journalId: '77x' });
  assert.equal(badJournal.candidates.length, 0);
  assert.equal(badJournal.stats.invalidJournalId, true);
  const badDate = trace(events, { after: 'not-a-date' });
  assert.equal(badDate.candidates.length, 0);
  assert.equal(badDate.stats.invalidDateRange, true);
});

test('deletion date filtering retains an older recycle rename as name evidence', () => {
  const result = trace([
    event({ usn: 100, reason: 0x1000, name: '어제 휴지통으로.docx', parent: sourceParent, atMs: 500 }),
    event({ usn: 101, reason: 0x2000, name: '$RABC123.docx', atMs: 501 }),
    deletion({ atMs: 1500 }),
  ], { after: 1000, before: 2000 });
  assert.equal(result.candidates[0].name, '어제 휴지통으로.docx');
  assert.equal(result.candidates[0].deletedAt, new Date(1500).toISOString());
  assert.equal(result.candidates[0].originalNameStatus, 'history-only');
});
