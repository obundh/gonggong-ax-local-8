import assert from 'node:assert/strict';
import test from 'node:test';

import { candidateCaptureKey, captureLinkKey, canOfferEarlierCapture } from '../engine/capture-link.mjs';

const fingerprint = 'a'.repeat(64);
const layout = 'b'.repeat(64);
const base = () => ({
  id: 'partition:old/ntfs:24:7',
  name: 'misleading-name.txt',
  partitionId: 'partition:old',
  recordNumber: 24,
  sequence: 7,
  size: 4096,
  fingerprint,
  recordEvidence: { recordNumber: 24, sequence: 7, flags: 0, baseReference: '0', fingerprint, dataLayoutHash: layout },
  deletionEvidence: { fileReference: (24n | 6n << 48n).toString(), deleteUsn: '123456789' },
  preservation: { status: 'captured', documentStatus: 'preview-available', size: 4096,
    sha256: 'c'.repeat(64), capturedAt: '2026-09-26T10:00:00Z', originalIdentityVerified: false },
});

test('capture link keys bind observed deletion and MFT identity, never a name or existing id', () => {
  const candidate = base();
  const key = candidateCaptureKey(candidate);
  assert.ok(key);
  assert.equal(captureLinkKey(candidate), key);
  assert.equal(candidateCaptureKey({ ...candidate, id: 'different-existing-id', name: 'same-looking-name.txt' }), key);

  for (const mutated of [
    { sequence: 8, recordEvidence: { ...candidate.recordEvidence, sequence: 8 } },
    { partitionId: 'partition:other' },
    { fingerprint: 'c'.repeat(64), recordEvidence: { ...candidate.recordEvidence, fingerprint: 'c'.repeat(64) } },
    { recordEvidence: { ...candidate.recordEvidence, dataLayoutHash: 'd'.repeat(64) } },
    { deletionEvidence: { ...candidate.deletionEvidence, deleteUsn: '123456790' } },
    { deletionEvidence: { ...candidate.deletionEvidence, fileReference: (25n | 6n << 48n).toString() } },
    { size: 4097 },
  ]) assert.notEqual(candidateCaptureKey({ ...candidate, ...mutated }), key);
});

test('capture link rejects incomplete, inconsistent, and non-authoritative candidate fields', () => {
  const candidate = base();
  for (const mutated of [
    { partitionId: '' }, { recordNumber: null }, { sequence: 0 }, { size: -1 }, { fingerprint: undefined },
    { recordEvidence: { ...candidate.recordEvidence, fingerprint: 'e'.repeat(64) } },
    { recordEvidence: { ...candidate.recordEvidence, dataLayoutHash: undefined } },
    { recordEvidence: { ...candidate.recordEvidence, flags: 1 } },
    { recordEvidence: { ...candidate.recordEvidence, baseReference: '42' } },
    { deletionEvidence: undefined }, { deletionEvidence: { fileReference: 'not-a-reference', deleteUsn: '1' } },
    { deletionEvidence: { fileReference: candidate.deletionEvidence.fileReference, deleteUsn: '0' } },
  ]) assert.equal(candidateCaptureKey({ ...candidate, ...mutated }), null);
});

test('only an already captured preview can be an explicit earlier-capture option', () => {
  const candidate = base();
  assert.equal(canOfferEarlierCapture(candidate), true);
  // UI/status/preparation decoration cannot change the identity or eligibility.
  const decorated = { ...candidate, id: 'new-scan-storage-id', name: 'renamed-by-ui.txt', status: 'readable',
    requiresPreparation: false, preparationStatus: 'checked', reasons: ['decorated after scan'] };
  assert.equal(candidateCaptureKey(decorated), candidateCaptureKey(candidate));
  assert.equal(canOfferEarlierCapture(decorated), true);
  assert.equal(canOfferEarlierCapture({ ...candidate, preservation: { status: 'captured', documentStatus: 'format-mismatch' } }), false);
  assert.equal(canOfferEarlierCapture({ ...candidate, preservation: { status: 'failed', documentStatus: 'preview-available' } }), false);
  assert.equal(canOfferEarlierCapture({ ...candidate, preservation: { status: 'captured' } }), false);
  for (const changed of [{ sha256: 'x' }, { size: 0 }, { size: 4097 }, { capturedAt: 'invalid' }, { originalIdentityVerified: true }]) {
    assert.equal(canOfferEarlierCapture({ ...candidate, preservation: { ...candidate.preservation, ...changed } }), false);
  }
});

test('split-data candidates cannot reuse a base-record-only key across searches', () => {
  const candidate = { ...base(), splitData: true };
  assert.equal(candidateCaptureKey(candidate), null);
  assert.equal(canOfferEarlierCapture(candidate), false);
  assert.equal(candidateCaptureKey({ ...candidate, status: 'readable', requiresPreparation: false }), null);
});
