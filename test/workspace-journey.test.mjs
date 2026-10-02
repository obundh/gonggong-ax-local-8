import test from 'node:test';
import assert from 'node:assert/strict';
import { createJourneyModel, readinessContext, readinessContextMatches } from '../ui/workspace.mjs';

test('readiness expires when an automatic next source changes without a dropdown change', () => {
  const source = { id: 'disk-a', path: 'C:' };
  const state = { viewMode: 'program', source, destination: { id: 'output', path: 'E:/recovery' } };
  const checked = readinessContext(state, 'auto', source);
  assert.equal(readinessContextMatches(checked, state, 'auto'), true);
  assert.equal(readinessContextMatches(checked, { ...state, source: { id: 'disk-b', path: 'D:' } }, 'auto'), false);
  assert.equal(readinessContextMatches(checked, { ...state, source: null }, 'auto'), false);
  assert.equal(readinessContextMatches(checked, state, 'disk-b'), false);
});

test('readiness expires when output ID or path changes and never follows a mutable object', () => {
  const state = { viewMode: 'program', source: { id: 'disk-a' }, destination: { id: 'output-a', path: 'E:/recovery' } };
  const checked = readinessContext(state, 'auto');
  assert.equal(readinessContextMatches(checked, { ...state, destination: { id: 'output-b', path: 'E:/recovery' } }, 'auto'), false);
  state.destination.path = 'C:/recovery';
  assert.equal(readinessContextMatches(checked, state, 'auto'), false);
  assert.equal(readinessContextMatches(checked, { ...state, destination: null }, 'auto'), false);
});

test('journal read failure stays incomplete and unexecuted deep search stays untouched', () => {
  const model = createJourneyModel();
  const state = { source: { id: 'disk-a' }, jobId: 'journal', mode: 'deleted' };
  model.start(state, 100);
  model.event({ jobId: 'journal', type: 'complete', complete: false, warnings: [{ code: 'JOURNAL_READ_FAILED' }] }, state, 200);
  const snapshot = model.snapshot();
  assert.equal(snapshot.entries.records.status, 'attention');
  assert.equal(snapshot.entries.deep, undefined);
  assert.equal(snapshot.entries.content, undefined);
  model.event({ jobId: 'another-job', type: 'complete', complete: true }, state, 300);
  assert.equal(model.snapshot().entries.records.finishedAt, 200);
});

test('saved damaged bytes are never counted as original recovery, even with verified readback', () => {
  const model = createJourneyModel(), state = { source: { id: 'disk-a' }, jobId: 'records', mode: 'deleted' };
  model.start(state, 0);
  model.event({ jobId: 'records', type: 'complete', complete: true }, state, 10);
  model.event({ jobId: 'records', type: 'recover-progress' }, state, 20);
  model.event({ jobId: 'records', type: 'paused' }, state, 30);
  assert.equal(model.snapshot().entries.content.status, 'paused');
  model.event({ jobId: 'records', type: 'recover-complete', results: [{ status: 'saved', path: 'E:/out.pdf', integrity: { status: 'verified' }, document: { status: 'damaged' } }] }, state, 40);
  assert.equal(model.snapshot().entries.content.status, 'attention');
  assert.match(model.snapshot().entries.content.label, /저장 1개 · 원본 일치 0개/);
  assert.equal(model.snapshot().entries.records.status, 'done');
});

test('same-source next search retains prior observations; a different source starts a separate journey', () => {
  const model = createJourneyModel(), first = { source: { id: 'disk-a' }, jobId: 'one', mode: 'deleted' };
  model.start(first, 0); model.event({ jobId: 'one', type: 'complete', complete: false }, first, 10);
  const second = { ...first, mode: 'deep', jobId: 'two' };
  model.start(second, 20);
  assert.equal(model.snapshot().entries.records.status, 'attention');
  assert.equal(model.snapshot().entries.deep.status, 'running');
  model.event({ jobId: 'two', type: 'cancelled' }, second, 30);
  assert.equal(model.snapshot().entries.deep.status, 'cancelled');
  model.start({ ...second, source: { id: 'disk-b' }, jobId: 'three' }, 40);
  assert.equal(model.snapshot().entries.records, undefined);
  model.reset(); assert.deepEqual(model.snapshot().entries, {});
});
