import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseRecoveryName } from '../engine/recovery-name.mjs';
import { buildDeletionTraces } from '../engine/deletion-traces.mjs';
import { classifyNameMatch } from '../engine/candidate-filter.mjs';

const origin = { recordNumber: 90, sequence: 4 };
const moved = { recordNumber: 91, sequence: 8 };
const trash = { recordNumber: 500, sequence: 2 };
const alias = '$RABC123.docx';
const event = (usn, reason, name, parent = origin) => ({ recordNumber: 42, sequence: 12, usn: String(usn), reason, name, parent, atMs: 1000 });
function history() {
  return [event(80, 0x1000, '초안.docx'), event(81, 0x2000, '최종 보고서.docx', moved),
    event(90, 0x1, '최종 보고서.docx', moved), event(100, 0x1000, '최종 보고서.docx', moved),
    event(101, 0x2000, alias, trash), event(102, 0x80002000, alias, trash), event(110, 0x80000200, alias, trash)];
}
function item(events = history()) {
  return { recordNumber: 42, sequence: 13, name: alias, source: 'deleted-record',
    nameReferences: [{ name: alias, namespace: 1, parent: trash }], generationEvents: events,
    matchedDeletes: [events.find(e => e.usn === '110')] };
}

test('a continuous name and parent chain restores the immediate pre-trash name, never the earliest draft name', () => {
  const naming = chooseRecoveryName(item());
  assert.equal(naming.name, '최종 보고서.docx');
  assert.equal(naming.originalNameStatus, 'restored-from-history');
  assert.equal(naming.evidence.oldNameUsn, '100');
  assert.equal(naming.evidence.newNameUsn, '101');
  assert.equal(naming.evidence.oldParentFileReference, ((8n << 48n) | 91n).toString());
  assert.equal(chooseRecoveryName(item(history().reverse())).name, naming.name);
});

test('restore from recycle and recycle again uses only the last proven pre-trash name', () => {
  const events = [event(10, 0x1000, '이전 이름.docx'), event(11, 0x2000, '$ROLD123.docx', trash),
    event(20, 0x1000, '$ROLD123.docx', trash), event(21, 0x2000, '돌려놓은 이름.docx'),
    event(30, 0x1000, '돌려놓은 이름.docx'), event(31, 0x2000, '최종 보고서.docx', moved),
    ...history().slice(2)];
  assert.equal(chooseRecoveryName(item(events)).name, '최종 보고서.docx');
});

test('broken, branching, interrupted, ambiguous or reused histories cannot restore a name', () => {
  const base = history();
  const transcripts = [
    base.filter(e => e.usn !== '81'),
    base.map(e => e.usn === '81' ? { ...e, name: '다른 문서.docx' } : e),
    base.map(e => e.usn === '81' ? { ...e, parent: origin } : e),
    base.map(e => e.usn === '100' ? { ...e, parent: { ...moved, sequence: 9 } } : e),
    [{ ...base[0], usn: '79' }, event(80, 0x1, '초안.docx'), ...base.slice(1)],
    base.map(e => e.usn === '81' ? { ...e, sequence: 11 } : e),
    [...base, { ...base[0], name: '충돌.docx' }],
    [...base, event(111, 0x2000, '삭제 뒤 이름.docx')],
    [...base.slice(0, 2), event(85, 0x10000, '최종 보고서.docx', moved), ...base.slice(2)],
    [...base.slice(0, 2), event(85, 0x200, '최종 보고서.docx', moved), ...base.slice(2)],
    base.map(e => e.usn === '90' ? { ...e, name: '다른 이름.docx' } : e),
    base.map(e => e.usn === '81' ? { ...e, reason: 0x3000 } : e),
  ];
  for (const [index, events] of transcripts.entries()) {
    assert.equal(chooseRecoveryName(item(events)).originalNameStatus, 'unknown', `case ${index}`);
  }
});

test('every supplied event and the delete itself must be valid and agree with the matched delete', () => {
  const base = history();
  for (const change of [{ reason: NaN }, { reason: -1 }, { reason: 0x100000000 }, { name: '../bad' }, { parent: null }]) {
    const events = base.map(e => e.usn === '90' ? { ...e, ...change } : e);
    assert.equal(chooseRecoveryName(item(events)).originalNameStatus, 'unknown');
  }
  assert.equal(chooseRecoveryName({ ...item(), generationEvents: base.filter(e => e.usn !== '110') }).originalNameStatus, 'unknown');
  assert.equal(chooseRecoveryName({ ...item(), matchedDeletes: [{ ...base.at(-1), reason: 0x200 }] }).originalNameStatus, 'unknown');
  assert.equal(chooseRecoveryName({ ...item(), sequence: 65536 }).originalNameStatus, 'unknown');
});

test('large or overlong chains remain bounded without silently choosing the last apparent pair', () => {
  const events = [];
  for (let i = 0; i < 65; i++) events.push(event(i * 2, 0x1000, `이름${i}.docx`), event(i * 2 + 1, 0x2000, `이름${i + 1}.docx`));
  events.push(event(200, 0x1000, '이름65.docx'), event(201, 0x2000, alias, trash), event(210, 0x200, alias, trash));
  assert.equal(chooseRecoveryName({ ...item(), generationEvents: events, matchedDeletes: [events.at(-1)] }).originalNameStatus, 'unknown');
  assert.equal(chooseRecoveryName({ ...item(), generationEvents: Array.from({ length: 4097 }, (_, i) => event(i, 0x1, '이름.docx')) }).originalNameStatus, 'unknown');
});

test('a multi-rename orphan remains metadata-only and its persisted final pair must still match its identity', () => {
  const built = buildDeletionTraces({ events: history(), journalId: '77' });
  const trace = JSON.parse(JSON.stringify(built.candidates[0]));
  assert.equal(trace.name, '최종 보고서.docx');
  assert.equal(trace.originalNameStatus, 'history-only');
  assert.equal(trace.hasContent, false);
  assert.equal(trace.storage, 'unlocated');
  assert.equal(trace.size, null);
  assert.equal(trace.traceEvidence.rename.oldNameUsn, '100');
  assert.equal(classifyNameMatch('최종 보고서.docx', trace).kind, 'exact');
  trace.restorationName.evidence.oldParentFileReference = '1';
  assert.notEqual(classifyNameMatch('최종 보고서.docx', trace).kind, 'exact');
  assert.equal(chooseRecoveryName(trace).originalNameStatus, 'unknown');
});
