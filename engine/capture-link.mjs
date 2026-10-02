// A capture link is deliberately narrower than a candidate id.  Candidate ids
// are presentation/storage handles and can survive a new scan; a saved body may
// only be offered again when the observed NTFS identity still matches.

const HASH = /^[0-9a-f]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const MAX_RECORD_NUMBER = 0xffffffffffff;
const MAX_USN = 0x7fffffffffffffffn;

function decimal(value, maximum) {
  if (typeof value !== 'string' || !DECIMAL.test(value)) return null;
  try {
    const parsed = BigInt(value);
    return parsed <= maximum ? value : null;
  } catch { return null; }
}

function hash(value) {
  return typeof value === 'string' && HASH.test(value) ? value : null;
}

function partition(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 ? value : null;
}

function recordNumber(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_RECORD_NUMBER ? value : null;
}

function sequence(value) {
  return Number.isInteger(value) && value > 0 && value <= 0xffff ? value : null;
}

function size(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function deleteEvidenceOf(candidate) {
  // The producer must retain the exact delete event separately.  Do not infer it
  // from a filename, a generated id, or a current MFT sequence.
  const evidence = candidate?.deletionEvidence;
  if (!evidence || typeof evidence !== 'object') return null;
  const fileReference = decimal(evidence.fileReference, 0xffffffffffffffffn);
  const deleteUsn = decimal(evidence.deleteUsn, MAX_USN);
  return { fileReference, deleteUsn: deleteUsn === '0' ? null : deleteUsn };
}

/**
 * Returns a stable, versioned key for a captured body, or null when any
 * authoritative observed value is absent or inconsistent.  This function is
 * intentionally pure and does not authorize source/device reuse by itself.
 */
export function candidateCaptureKey(candidate) {
  // The current key binds only the base record. Do not link bodies across
  // searches for an ATTRIBUTE_LIST file until all extension proofs are bound.
  // Its normal, same-search capture/preview/save path still validates them.
  if (candidate?.splitData === true) return null;
  const partitionId = partition(candidate?.partitionId);
  const number = recordNumber(candidate?.recordNumber);
  const generation = sequence(candidate?.sequence);
  const observedSize = size(candidate?.size);
  const evidence = candidate?.recordEvidence;
  const deletion = deleteEvidenceOf(candidate);
  if (partitionId === null || number === null || generation === null || observedSize === null
    || !evidence || typeof evidence !== 'object' || !deletion?.fileReference || !deletion.deleteUsn) return null;

  const fingerprint = hash(candidate?.fingerprint);
  const evidenceFingerprint = hash(evidence.fingerprint);
  const dataLayoutHash = hash(evidence.dataLayoutHash);
  if (!fingerprint || !evidenceFingerprint || fingerprint !== evidenceFingerprint || !dataLayoutHash
    || evidence.recordNumber !== number || evidence.sequence !== generation
    || evidence.flags !== 0 || evidence.baseReference !== '0') return null;

  // The deletion reference encodes the MFT record and its deletion generation.
  // Matching its lower 48 bits prevents a valid-looking event from another file
  // becoming an earlier body for this candidate.
  const reference = BigInt(deletion.fileReference);
  if (Number(reference & 0xffffffffffffn) !== number || Number(reference >> 48n) !== generation - 1) return null;

  return JSON.stringify({ version: 1, partitionId, recordNumber: number, sequence: generation,
    rawMftFingerprint: fingerprint, dataLayoutHash, fileReference: deletion.fileReference,
    deleteUsn: deletion.deleteUsn, size: observedSize });
}

// Kept as the concise public spelling for callers that do not need to name the
// candidate source explicitly.
export const captureLinkKey = candidateCaptureKey;

/**
 * An existing capture may be shown as an explicit earlier-capture option only
 * after it has a complete identity key and a preview that was actually made
 * available.  Callers still compare its key with the current candidate and
 * re-check the source/read layer before copying any bytes.
 */
export function canOfferEarlierCapture(candidate) {
  const saved = candidate?.preservation;
  return candidateCaptureKey(candidate) !== null
    && saved?.status === 'captured' && saved.documentStatus === 'preview-available'
    && hash(saved.sha256) !== null && saved.size === candidate.size && saved.size > 0
    && typeof saved.capturedAt === 'string' && Number.isFinite(Date.parse(saved.capturedAt))
    && saved.originalIdentityVerified === false;
}
