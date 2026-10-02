const damagedStatuses = new Set(['damaged', 'format-mismatch']);

// Storage readback compares extracted bytes with saved bytes. It does not compare
// either with the deleted original; only a separately supplied baseline can do so.
export function recoveryOutcome(result = {}) {
  const published = result.status === 'saved' && typeof result.path === 'string' && Boolean(result.path);
  const fileWrittenUnverified = !published && typeof result.details?.savedPath === 'string' && Boolean(result.details.savedPath);
  const fileSaved = published || fileWrittenUnverified;
  const damaged = published && damagedStatuses.has(result.document?.status);
  const comparison = result.originalComparison;
  const originalBytesVerified = published && comparison?.source === 'pre-deletion-baseline'
    && comparison.status === 'verified' && /^[0-9a-f]{64}$/i.test(comparison.expectedSha256 ?? '')
    && comparison.expectedSha256.toLowerCase() === String(result.sha256 ?? '').toLowerCase();
  const documentOpenVerified = published && !damaged && result.document?.applicationOpenVerified === true;
  const previewAvailable = published && !damaged && result.document?.status === 'preview-available';
  // Document/preview limits describe assessment coverage, not missing output bytes.
  // Include legacy truncated assessments when opening results from older releases.
  const documentAssessmentLimited = published && (result.document?.assessmentLimited === true
    || result.document?.truncated === true || result.document?.reason === 'FILE_TOO_LARGE');
  const partialContent = fileSaved && result.partial === true;
  const nameRestored = published && result.nameRecovery?.originalNameStatus === 'restored-from-history'
    && result.nameRecovery.adjustedForFilesystem !== true;
  return { fileSaved, fileWrittenUnverified, storageIntegrityVerified: published && result.integrity?.status === 'verified',
    originalBytesVerified, documentOpenVerified, previewAvailable, partialContent, documentAssessmentLimited, nameRestored, damaged,
    kind: !fileSaved ? 'not-saved' : fileWrittenUnverified ? 'written-unverified' : damaged ? 'damaged-data-saved' : originalBytesVerified ? 'original-verified'
      : documentOpenVerified ? 'document-open-verified' : partialContent ? 'partial-content-saved'
        : previewAvailable ? 'preview-checked' : 'saved-unchecked' };
}

export function recoverySummary(results = [], filesTotal = results.length) {
  const outcomes = results.map(recoveryOutcome);
  const count = key => outcomes.filter(item => item[key]).length;
  return { filesProcessed: results.length, filesTotal, filesWritten: count('fileSaved'),
    filesWrittenUnverified: count('fileWrittenUnverified'),
    filesNotSaved: outcomes.filter(item => !item.fileSaved).length,
    originalBytesVerified: count('originalBytesVerified'), documentOpenVerified: count('documentOpenVerified'),
    previewsAvailable: count('previewAvailable'), partialContent: count('partialContent'),
    documentAssessmentsLimited: count('documentAssessmentLimited'),
    damagedFilesWritten: count('damaged'), originalNamesRestored: count('nameRestored') };
}

export function recoveryDiagnosis({ candidate = {}, error, result, stage = 'recover', coverage } = {}) {
  const code = error?.code ?? null;
  const recordChange = error?.details?.recordChange ?? null;
  let category = 'cause-unconfirmed';
  if (recordChange?.classification === 'record-reused') category = 'record-reuse-confirmed';
  else if (error?.details?.outputUnverified) category = 'output-verification-failed';
  else if (code === 'SOURCE_CHANGED') category = 'source-change-observed';
  else if (damagedStatuses.has(result?.document?.status)) category = 'document-damage-observed';
  else if (/^(?:READ_FAILED|IO_FAILED|EIO|EACCES|EPERM|DEVICE_DISCONNECTED|PIPE_)/.test(code ?? '')) category = 'read-or-access-failed';
  else if (/UNSUPPORTED|INVALID_RECORD|INVALID_FIXUP|INVALID_ATTRIBUTE|INVALID_NAME/.test(code ?? '')) category = 'record-interpretation-failed';
  else if (code === 'NOT_RECOVERABLE' && candidate.status === 'unsupported') category = 'record-interpretation-failed';
  else if (code === 'NOT_RECOVERABLE' && ['conflict', 'changed'].includes(candidate.status)) category = 'candidate-refused';
  else if (code === 'CANCELLED') category = 'cancelled';
  else if (result?.status === 'saved') category = 'extracted-bytes-saved';
  return { category, stage: error?.details?.stage ?? stage, code,
    discoverySources: candidate.discoverySources ?? [candidate.source ?? 'unknown'],
    recordNumber: candidate.recordNumber ?? null, sequence: candidate.sequence ?? null,
    recordChange, candidateStatus: candidate.status ?? null, candidateReasons: candidate.reasons ?? [], documentReason: result?.document?.reason ?? null,
    readFailure: error?.details?.readFailure ?? null,
    coverage: coverage ?? null, originalIdentityProven: recoveryOutcome(result).originalBytesVerified,
    physicalErasureProven: false };
}
