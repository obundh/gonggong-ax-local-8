import assert from 'node:assert/strict';
import test from 'node:test';
import {
  filterCandidates,
  classifyNameMatch,
  matchesCandidate,
  normalizeFilters,
  rankName
} from '../engine/candidate-filter.mjs';

test('filters normalize extensions, bounds, dates, and reject contradictory ranges', () => {
  assert.deepEqual(normalizeFilters({
    name: '  보고서  ', extensions: '.DOCX, hwp docx', kind: 'PHOTO',
    minSize: '10', maxSize: 20, modifiedAfter: '2026-01-01',
    modifiedBefore: new Date('2026-12-31T23:59:59Z'), pathContains: '  회의 자료 '
  }), {
    name: '보고서', extensions: ['docx', 'hwp'], kind: 'photo', minSize: 10, maxSize: 20,
    modifiedAfter: Date.parse('2026-01-01'), modifiedBefore: Date.parse('2026-12-31T23:59:59Z'),
    deletedAfter: null, deletedBefore: null, includeUnknownDeletedAt: true,
    pathContains: '회의 자료'
  });
  assert.throws(() => normalizeFilters({ minSize: 2, maxSize: 1 }), RangeError);
  assert.throws(() => normalizeFilters({ modifiedAfter: 'not-a-date' }), TypeError);
  assert.throws(() => normalizeFilters({ kind: 'video' }), TypeError);
});

test('deletion date filters are inclusive and retain unknown timestamps unless explicitly excluded', () => {
  const items = [
    { id: 'before', name: 'a.txt', deletedAt: '2026-09-09T23:59:59.999Z' },
    { id: 'start', name: 'b.txt', deletedAt: '2026-09-10T00:00:00.000Z' },
    { id: 'end', name: 'c.txt', deletedAt: '2026-09-10T23:59:59.999Z' },
    { id: 'after', name: 'd.txt', deletedAt: '2026-09-11T00:00:00.000Z' },
    { id: 'unknown', name: 'e.txt', deletedAt: null }
  ];
  const range = { deletedAfter: '2026-09-10T00:00:00.000Z', deletedBefore: '2026-09-10T23:59:59.999Z' };
  assert.deepEqual(filterCandidates(items, range).map(item => item.id), ['start', 'end', 'unknown']);
  assert.deepEqual(filterCandidates(items, { ...range, includeUnknownDeletedAt: false }).map(item => item.id), ['start', 'end']);
  assert.deepEqual(filterCandidates(items, { includeUnknownDeletedAt: false }).map(item => item.id), ['before', 'start', 'end', 'after']);
  assert.throws(() => normalizeFilters({ deletedAfter: '2026-09-11', deletedBefore: '2026-09-10' }), RangeError);
  assert.throws(() => normalizeFilters({ includeUnknownDeletedAt: 'false' }), TypeError);
});

test('name-match metadata keeps generated names unknown and known mismatches explicit', () => {
  assert.equal(classifyNameMatch('보고서.txt', { name: '보고서.txt' }).kind, 'exact');
  assert.equal(classifyNameMatch('보고서', { name: '보고서.txt' }).kind, 'partial');
  assert.notEqual(classifyNameMatch('a.pdf', { name: 'a.docx' }).kind, 'exact');
  assert.equal(classifyNameMatch('보고서', { name: '보고서 최종본.docx' }).kind, 'partial');
  assert.equal(classifyNameMatch('결산보고서', { name: '결산보거서.hwp' }).kind, 'similar');
  assert.equal(classifyNameMatch('보고서', { name: '$RABC123.txt', nameIsGenerated: true }).kind, 'unknown');
  assert.equal(classifyNameMatch('보고서', { name: '휴가사진.jpg' }).kind, 'none');
  const kept = filterCandidates([
    { id: 'exact', name: '보고서.txt' }, { id: 'none', name: '휴가사진.jpg' }, { id: 'unknown', name: 'record-1', nameIsGenerated: true }
  ], { name: '보고서.txt' }, { keepNameMismatches: true, sort: 'score-desc' });
  assert.deepEqual(kept.map(item => item.id), ['exact', 'unknown', 'none']);
  assert.deepEqual(kept.map(item => item.nameMatch.kind), ['exact', 'unknown', 'none']);
  assert.notEqual(classifyNameMatch('a-b.pdf', { name: 'ab.pdf' }).kind, 'exact');
  assert.notEqual(classifyNameMatch('a.pdf', { name: 'apdf' }).kind, 'exact');
  assert.deepEqual(filterCandidates([{id:'different-extension',name:'a.docx'},{id:'full-match',name:'a.pdf'}],{name:'a.pdf'},{keepNameMismatches:true,sort:'score-desc'}).map(item=>item.id),['full-match','different-extension']);
});

test('regular filename ranking handles Unicode, separators, Korean typos, and revision suffixes without AI', () => {
  const unicode = rankName('ＡＢＣ 보고서', 'abc_보고서.pdf');
  assert.equal(unicode.score, 100);
  assert.deepEqual(unicode.reasons, ['filenameSimilarity:exact', 'noAI']);

  const revision = rankName('회의 보고서', '회의-보고서_최종본_20260912.docx');
  assert.ok(revision.score >= 90);
  assert.ok(revision.reasons.includes('filenameVariant:final'));
  assert.ok(revision.reasons.includes('filenameVariant:date'));
  assert.ok(revision.reasons.includes('noAI'));

  const typo = rankName('결산보고서', '결산보거서 수정본.hwp');
  assert.ok(typo.score >= 70);
  assert.ok(typo.reasons.includes('filenameSimilarity:fuzzy'));
  assert.ok(typo.reasons.includes('filenameVariant:revision'));
});

test('missing or invalid modification dates cannot pass a date filter', () => {
  const base = { name: '보고서.hwp', path: 'C:\\자료\\보고서.hwp', size: 100, kind: 'document' };
  assert.equal(matchesCandidate({ ...base, modifiedAt: null }, { modifiedAfter: '2026-01-01' }), false);
  assert.equal(matchesCandidate({ ...base, modifiedAt: 'unknown' }, { modifiedBefore: '2026-12-31' }), false);
  assert.equal(matchesCandidate({ ...base, modifiedAt: '2026-06-01T00:00:00Z' }, {
    extensions: ['hwp'], kind: 'document', minSize: 50, maxSize: 150,
    modifiedAfter: '2026-01-01', modifiedBefore: '2026-12-31', pathContains: '자료'
  }), true);
});

test('filterCandidates returns copies, preserves stable order, and applies explicit sorting', () => {
  const items = [
    { id: 'a', name: '회의록 최종본.docx', path: 'C:\\자료\\회의록 최종본.docx', size: 20, modifiedAt: '2026-01-01', kind: 'document', reasons: ['old'] },
    { id: 'b', name: '회의록 복사본.docx', path: 'C:\\자료\\회의록 복사본.docx', size: 10, modifiedAt: '2026-01-02', kind: 'document', reasons: ['old'] },
    { id: 'c', name: '사진.jpg', path: 'C:\\자료\\사진.jpg', size: 5, modifiedAt: '2026-01-03', kind: 'photo', reasons: [] }
  ];
  const stable = filterCandidates(items, { name: '회의록', kind: 'document' });
  assert.deepEqual(stable.map(item => item.id), ['a', 'b']);
  assert.notEqual(stable[0], items[0]);
  assert.deepEqual(items[0].reasons, ['old']);
  assert.ok(stable.every(item => item.reasons.includes('noAI')));

  const sorted = filterCandidates(items, { kind: 'document' }, { sort: 'size-asc' });
  assert.deepEqual(sorted.map(item => item.id), ['b', 'a']);
});

test('recycle candidates filter and sort by their displayed original path', () => {
  const items = [
    { id:'a', source:'recycle-bin', name:'보고서.txt', path:'C:/$Recycle.Bin/$RA', originalPath:'D:/자료/Z/보고서.txt', size:1 },
    { id:'b', source:'recycle-bin', name:'회의록.txt', path:'C:/$Recycle.Bin/$RB', originalPath:'D:/자료/A/회의록.txt', size:1 }
  ];
  assert.deepEqual(filterCandidates(items,{pathContains:'자료/A'}).map(x=>x.id),['b']);
  assert.deepEqual(filterCandidates(items,{}, {sort:'path-asc'}).map(x=>x.id),['b','a']);
  assert.equal(filterCandidates(items,{pathContains:'$Recycle.Bin'}).length,0);
});
