import test from 'node:test';
import assert from 'node:assert/strict';
import { RecoveryJobs } from '../engine/job-service.mjs';
import { decorateNativeCandidate, prepareNativeCandidate } from '../engine/native-recovery-adapter.mjs';

test('a journal trace sharing a record number with a current file cannot enter preparation or recovery', async () => {
  const trace = decorateNativeCandidate({ id: 'usn:1:24:6:100', source: 'deletion-trace', recordNumber: 24,
    sequence: 6, status: 'metadata-only', size: null, hasContent: false }, 'p');
  assert.equal(trace.preparationKind, null); assert.equal(trace.requiresPreparation, false);
  await assert.rejects(prepareNativeCandidate({}, trace, { prepare: () => { throw Error('must not touch current record'); } }), { code: 'CONTENT_NOT_LOCATED' });
  let destinationChecks = 0, messages = 0;
  const job = { id: 'j', candidates: new Map([[trace.id, trace]]), source: { kind: 'volume' }, status: 'results',
    worker: { postMessage() { messages++; } } };
  const context = { getJob: () => job, async validateDestination() { destinationChecks++; throw Error('must not create output'); } };
  await assert.rejects(RecoveryJobs.prototype.recoverReady.call(context, { jobId: 'j', ids: [trace.id], destinationId: 'any' }), { code: 'CONTENT_NOT_LOCATED' });
  assert.equal(destinationChecks, 0); assert.equal(messages, 0); assert.equal(job.status, 'results');
});
