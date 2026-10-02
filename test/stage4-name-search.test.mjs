import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { candidateSearchName, filterCandidates } from '../engine/candidate-filter.mjs';
import { openCandidateStore } from '../engine/candidate-store.mjs';
import { buildDeletionTraces } from '../engine/deletion-traces.mjs';
import { chooseRecoveryName } from '../engine/recovery-name.mjs';

const parent = { recordNumber: 5, sequence: 2 };
const candidate = { id: 'known', recordNumber: 42, sequence: 13, name: '$RABC123.pdf', size: 120,
  nameReferences: [{ name: '$RABC123.pdf', namespace: 3, parent }],
  restorationName: { name: '회의 자료.pdf', source: 'windows-usn-rename-pair', evidence: {
    fileReference: ((12n << 48n) | 42n).toString(), oldNameUsn: '100', newNameUsn: '101', deleteUsn: '110',
    oldParentFileReference: ((1n << 48n) | 6n).toString(), recycleParentFileReference: ((2n << 48n) | 5n).toString(),
  } }, source: 'deleted-record' };

test('verified restored name is searchable without replacing the raw recycle identity', async () => {
  assert.equal(candidateSearchName(candidate), '회의 자료.pdf');
  const [found] = filterCandidates([candidate], { name: '회의 자료.pdf' });
  assert.equal(found.nameMatch.kind, 'exact'); assert.equal(found.name, '$RABC123.pdf');
  const root = await mkdtemp(path.join(os.tmpdir(), 'stage4-name-'));
  const store = openCandidateStore(path.join(root, 'candidates.sqlite'));
  try {
    store.set(candidate.id, candidate);
    const page = store.page({ filters: { name: '회의 자료.pdf' }, sort: 'name-asc', limit: 10 });
    assert.equal(page.total, 1); assert.equal(page.items[0].nameMatch.kind, 'exact');
  } finally { store.close(); }
});

test('unproven rename hints never become an exact match and unknown size stays unknown', () => {
  const unproven = { ...candidate, restorationName: { name: '회의 자료.pdf' }, previousNameHints: ['회의 자료.pdf'] };
  assert.equal(candidateSearchName(unproven), '$RABC123.pdf');
  assert.equal(filterCandidates([unproven], { name: '회의 자료.pdf' }).length, 0);
  assert.equal(filterCandidates([{ name: '회의 자료.pdf', size: null }], { maxSize: 1 }).length, 0);
});

test('historical trace proof survives SQLite and rejects mismatched names and identities in display and search', async () => {
  const events = [[100, 0x1000, '회의 자료.pdf'], [101, 0x2000, '$RABC123.pdf'], [110, 0x200, '$RABC123.pdf']]
    .map(([usn, reason, name]) => ({ recordNumber: 42, sequence: 12, usn: String(usn), reason, name, parent, atMs: 1000 }));
  const trace = buildDeletionTraces({ events, journalId: '77' }).candidates[0];
  assert.equal(chooseRecoveryName(trace).originalNameStatus, 'history-only');
  assert.equal(candidateSearchName(trace), '회의 자료.pdf');
  const root = await mkdtemp(path.join(os.tmpdir(), 'trace-proof-'));
  const store = openCandidateStore(path.join(root, 'candidates.sqlite'));
  try {
    store.setBatch([trace]);
    assert.equal(candidateSearchName(store.get(trace.id)), '회의 자료.pdf');
    assert.equal(store.page({ filters: { name: '회의 자료.pdf' } }).items[0].nameMatch.kind, 'exact');
    const variants = [
      { ...trace, name: 'forged.docx', restorationName: { ...trace.restorationName, name: 'forged.docx' } },
      { ...trace, sequence: 13 }, { ...trace, recordNumber: 43 },
      { ...trace, traceEvidence: { ...trace.traceEvidence, journalId: '88' } },
      { ...trace, traceEvidence: { ...trace.traceEvidence, deleteUsn: '111' } },
      { ...trace, traceEvidence: { ...trace.traceEvidence, deletedParentFileReference: '10' } },
      { ...trace, restorationName: { ...trace.restorationName, evidence: { ...trace.restorationName.evidence, oldNameUsn: '111' } } },
    ];
    for (const changed of variants) {
      assert.equal(candidateSearchName(changed), '$RABC123.pdf');
      const [listed] = filterCandidates([changed], { name: 'forged.docx' }, { keepNameMismatches: true });
      assert.equal(listed.name, '$RABC123.pdf'); assert.equal(listed.restorationName, null);
      assert.equal(listed.nameMatch.kind, 'unknown');
    }
  } finally { store.close(); }
});
