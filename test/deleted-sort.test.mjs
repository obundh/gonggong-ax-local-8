import test from 'node:test';
import assert from 'node:assert/strict';
import { filterCandidates } from '../engine/candidate-filter.mjs';

const ids = candidates => candidates.map(candidate => candidate.id);
const item = (id, deletedAt, extra = {}) => ({ id, name: `${id}.txt`, deletedAt, ...extra });

test('deletion sorting orders numeric milliseconds and date strings newest first', () => {
  const candidates = [
    item('middle', '2026-09-12T12:00:00+09:00'),
    item('oldest', 0),
    item('newest', Date.parse('2026-09-13T12:00:00+09:00'))
  ];
  assert.deepEqual(ids(filterCandidates(candidates, {}, { sort: 'deleted-desc' })), ['newest', 'middle', 'oldest']);
  assert.deepEqual(ids(filterCandidates(candidates, {}, { sort: 'deleted' })), ['newest', 'middle', 'oldest']);
  assert.deepEqual(ids(filterCandidates(candidates, {}, { sort: { by: 'deleted' } })), ['newest', 'middle', 'oldest']);
});

test('deletion sorting supports oldest first with string and object descriptions', () => {
  const candidates = [item('newer', 2000), item('older', 1000)];
  for (const sort of ['deleted-asc', { by: 'deleted', direction: 'asc' }]) {
    assert.deepEqual(ids(filterCandidates(candidates, {}, { sort })), ['older', 'newer']);
  }
  assert.deepEqual(ids(filterCandidates(candidates, {}, { sort: { by: 'deleted', direction: 'desc' } })), ['newer', 'older']);
});

test('unknown and invalid deletion times remain last in both directions without using modification time', () => {
  const unknownValues = [undefined, null, '', '   ', 'not a date', NaN, Infinity, -Infinity, 1e20, true, false, {}, new Date(2000)];
  const unknowns = unknownValues.map((value, index) => item(`unknown-${index}`, value, { modifiedAt: '2099-01-01T00:00:00Z' }));
  const candidates = [...unknowns.slice(0, 3), item('newer', 2000), ...unknowns.slice(3), item('older', 1000)];
  assert.deepEqual(ids(filterCandidates(candidates, {}, { sort: 'deleted-desc' })), ['newer', 'older', ...ids(unknowns)]);
  assert.deepEqual(ids(filterCandidates(candidates, {}, { sort: 'deleted-asc' })), ['older', 'newer', ...ids(unknowns)]);
});

test('equal deletion times retain input order independently of score or name', () => {
  const candidates = [
    item('z', '1970-01-01T00:00:02.000Z', { score: 5 }),
    item('a', 2000, { score: 100 }),
    item('m', 2000, { score: 25 })
  ];
  for (const sort of ['deleted-asc', 'deleted-desc']) {
    assert.deepEqual(ids(filterCandidates(candidates, {}, { sort })), ['z', 'a', 'm']);
  }
});

test('deletion sorting preserves caller data and existing filtering and sort behavior', () => {
  const candidates = Object.freeze([
    Object.freeze(item('b', 1000, { reasons: Object.freeze(['original']), modifiedAt: 3000, size: 20 })),
    Object.freeze(item('a', 2000, { reasons: Object.freeze([]), modifiedAt: 1000, size: 10 })),
    Object.freeze({ id: 'photo', name: 'photo.png', deletedAt: 3000, size: 30 })
  ]);
  const before = structuredClone(candidates);
  const result = filterCandidates(candidates, { kind: 'document' }, { sort: 'deleted-desc' });
  assert.deepEqual(ids(result), ['a', 'b']);
  assert.deepEqual(candidates, before);
  assert.notEqual(result[0], candidates[1]);
  assert.notEqual(result[0].reasons, candidates[1].reasons);
  assert.deepEqual(ids(filterCandidates(candidates, { kind: 'document' }, { sort: 'modified-desc' })), ['b', 'a']);
  assert.deepEqual(ids(filterCandidates(candidates, { kind: 'document' }, { sort: 'name-asc' })), ['a', 'b']);
  assert.deepEqual(ids(filterCandidates(candidates, { kind: 'document' }, { sort: 'size-desc' })), ['b', 'a']);
});

test('deletion sort descriptions reject unsupported directions and field names', () => {
  for (const sort of ['deleted-latest', 'deletedAt-desc', { by: 'deleted', direction: 'latest' }, { by: 'deletedAt', direction: 'desc' }]) {
    assert.throws(() => filterCandidates([], {}, { sort }), TypeError);
  }
});
