import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { recoveryOutcome, recoverySummary, recoveryDiagnosis } from '../engine/recovery-outcome.mjs';

test('captured mixed-six result counts two stored corrupt documents and zero verified originals', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/mixed6-recovery-status.json', import.meta.url), 'utf8'));
  const summary = recoverySummary(fixture.results, 5);
  assert.equal(summary.filesProcessed, 5);
  assert.equal(summary.filesWritten, 2);
  assert.equal(summary.filesNotSaved, 3);
  assert.equal(summary.damagedFilesWritten, 2);
  assert.equal(summary.originalBytesVerified, 0);
  assert.equal(summary.documentOpenVerified, 0);
  for (const item of fixture.results.filter(item => item.status === 'saved')) {
    assert.equal(recoveryOutcome(item).kind, 'damaged-data-saved');
    assert.equal(recoveryDiagnosis({ result: item }).category, 'document-damage-observed');
    assert.equal(recoveryDiagnosis({ result: item }).physicalErasureProven, false);
  }
});

test('storage readback, preview, opening and pre-deletion original identity remain separate', () => {
  const saved = { status: 'saved', path: 'result.pdf', sha256: 'a'.repeat(64), integrity: { status: 'verified' },
    originalIdentityVerified: true, document: { status: 'preview-available' } };
  const output = recoveryOutcome(saved);
  assert.equal(output.storageIntegrityVerified, true);
  assert.equal(output.previewAvailable, true);
  assert.equal(output.documentOpenVerified, false);
  assert.equal(output.originalBytesVerified, false, 'legacy identity flag is not a pre-deletion baseline');
  assert.equal(recoveryOutcome({ ...saved, originalComparison: { source: 'pre-deletion-baseline', status: 'verified', expectedSha256: saved.sha256 } }).originalBytesVerified, true);
  assert.equal(recoveryOutcome({ ...saved, originalComparison: { source: 'pre-deletion-baseline', status: 'verified', expectedSha256: 'b'.repeat(64) } }).originalBytesVerified, false);
  assert.equal(recoveryOutcome({ ...saved, document: { status: 'format-mismatch', applicationOpenVerified: true } }).documentOpenVerified, false);
  assert.equal(recoveryOutcome({ ...saved, status: 'partial' }).fileSaved, false);
});

test('failure evidence explains its category without turning unreadable bytes into TRIM proof', () => {
  const candidate = { recordNumber: 12, sequence: 4, discoverySources: ['windows-usn'] };
  const coverage = { complete: false, truncated: true };
  const cases = [
    ['SOURCE_CHANGED', 'source-change-observed'], ['READ_FAILED', 'read-or-access-failed'],
    ['UNSUPPORTED_ATTRIBUTE', 'record-interpretation-failed'], ['UNKNOWN_FAILURE', 'cause-unconfirmed'],
  ];
  for (const [code, expected] of cases) {
    const value = recoveryDiagnosis({ candidate, error: { code }, stage: 'prepare-candidate', coverage });
    assert.equal(value.category, expected); assert.equal(value.physicalErasureProven, false);
    assert.equal(value.coverage.truncated, true); assert.equal(value.recordNumber, 12);
    assert.deepEqual(value.discoverySources, ['windows-usn']);
  }
});

test('a published output that fails readback is counted as written but unverified', () => {
  const result = { status: 'failed', code: 'VERIFY_FAILED', details: { savedPath: 'output/document.txt', outputUnverified: true, stage: 'output-verification' } };
  const summary = recoverySummary([result]);
  assert.equal(summary.filesWritten, 1);
  assert.equal(summary.filesWrittenUnverified, 1);
  assert.equal(summary.filesNotSaved, 0);
  assert.equal(summary.originalBytesVerified, 0);
  assert.equal(recoveryOutcome(result).kind, 'written-unverified');
  assert.equal(recoveryOutcome(result).storageIntegrityVerified, false);
  const diagnostic = recoveryDiagnosis({ error: result });
  assert.equal(diagnostic.category, 'output-verification-failed');
  assert.equal(diagnostic.stage, 'output-verification');
  assert.equal(recoverySummary([{ status: 'partial', details: { partialPath: 'output/partial.tmp' } }]).filesNotSaved, 1);
});

test('document assessment and preview limits never imply partially extracted bytes, including legacy results', () => {
  const saved = { status: 'saved', path: 'large.txt', integrity: { status: 'verified' } };
  const limited = [
    { status: 'needs-check', reason: 'FILE_TOO_LARGE', assessmentLimited: true, truncated: false },
    { status: 'needs-check', reason: 'FILE_TOO_LARGE', truncated: true },
    { status: 'preview-available', truncated: true },
  ].map(document => ({ ...saved, document }));
  for (const item of limited) {
    const outcome = recoveryOutcome(item);
    assert.equal(outcome.partialContent, false);
    assert.equal(outcome.documentAssessmentLimited, true);
    assert.equal(outcome.originalBytesVerified, false);
    assert.equal(outcome.documentOpenVerified, false);
    assert.equal(outcome.kind, item.document.status === 'preview-available' ? 'preview-checked' : 'saved-unchecked');
  }
  const partial = { ...limited[0], partial: true };
  assert.equal(recoveryOutcome(partial).kind, 'partial-content-saved');
  const summary = recoverySummary([...limited, partial]);
  assert.equal(summary.partialContent, 1);
  assert.equal(summary.documentAssessmentsLimited, 4);
  assert.equal(summary.originalBytesVerified, 0);
});

test('read failure diagnostics retain the requested range without claiming exact damaged bytes or erasure', () => {
  const readFailure = { logicalOffset: 1048576, requestedBytes: 4096, physicalOffset: 8388608,
    runVcn: 256, runLcn: 2048, extentKind: 'physical', cause: 'EIO', exactFailedBytesKnown: false };
  const diagnostic = recoveryDiagnosis({ error: { code: 'READ_FAILED', details: { readFailure } } });
  assert.deepEqual(diagnostic.readFailure, readFailure);
  assert.equal(diagnostic.category, 'read-or-access-failed');
  assert.equal(diagnostic.physicalErasureProven, false);
});
