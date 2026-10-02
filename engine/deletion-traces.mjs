import { chooseRecoveryName } from './recovery-name.mjs';

const FILE_DELETE = 0x00000200;
const DIRECTORY = 0x00000010;
const MAX_EVENTS = 500000;
const MAX_TRACES = 100000;
const MAX_RECORD = 0xffffffffffff;
const MAX_SEQUENCE = 0xffff;
const MAX_USN = 0x7fffffffffffffffn;
const MAX_JOURNAL_ID = 0xffffffffffffffffn;

function decimal(value, maximum) {
  if (typeof value !== 'string' || value.length > 20 || !/^(0|[1-9][0-9]*)$/.test(value)) return null;
  try {
    const parsed = BigInt(value);
    return parsed <= maximum ? parsed : null;
  } catch { return null; }
}

function leaf(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 255 && value === value.normalize('NFC')
    && value !== '.' && value !== '..' && !/[<>:"/\\|?*\u0000-\u001f\u007f]/.test(value) && !/[. ]$/.test(value)
    && !/^(con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\.|$)/i.test(value);
}

function eventIdentity(event) { return `${event.recordNumber}:${event.sequence}:${event.usn}`; }
function generationIdentity(event) { return `${event.recordNumber}:${event.sequence}`; }
function fileReference(event) { return (BigInt(event.recordNumber) | BigInt(event.sequence) << 48n).toString(); }

function dateOf(event) {
  if (Number.isSafeInteger(event?.atMs) && Math.abs(event.atMs) <= 8640000000000000) return event.atMs;
  if (typeof event?.at === 'string') {
    const parsed = Date.parse(event.at);
    if (Number.isSafeInteger(parsed) && Math.abs(parsed) <= 8640000000000000) return parsed;
  }
  return null;
}

function bound(value) {
  if (value == null) return { value: null, valid: true };
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  return { value: Number.isSafeInteger(parsed) && Math.abs(parsed) <= 8640000000000000 ? parsed : null,
    valid: Number.isSafeInteger(parsed) && Math.abs(parsed) <= 8640000000000000 };
}

function normalize(event) {
  if (!event || typeof event !== 'object' || !Number.isSafeInteger(event.recordNumber) || event.recordNumber < 0 || event.recordNumber > MAX_RECORD
    || !Number.isInteger(event.sequence) || event.sequence < 1 || event.sequence > MAX_SEQUENCE
    || !leaf(event.name) || decimal(event.usn, MAX_USN) === null || !Number.isInteger(event.reason) || event.reason < 0 || event.reason > 0xffffffff) return null;
  const parent = event.parent;
  if (!Number.isSafeInteger(parent?.recordNumber) || parent.recordNumber < 0 || parent.recordNumber > MAX_RECORD
    || !Number.isInteger(parent?.sequence) || parent.sequence < 0 || parent.sequence > MAX_SEQUENCE) return null;
  return { recordNumber: event.recordNumber, sequence: event.sequence, parent: { recordNumber: parent.recordNumber, sequence: parent.sequence },
    name: event.name, usn: event.usn, reason: event.reason >>> 0, atMs: dateOf(event) };
}

function eventFingerprint(event) {
  return `${generationIdentity(event)}:${event.parent.recordNumber}:${event.parent.sequence}:${event.name}:${event.reason}:${event.atMs ?? 'unknown'}`;
}

function traceObservation(observations, recordNumber) {
  if (!(observations instanceof Map)) return null;
  const item = observations.get(recordNumber) ?? observations.get(String(recordNumber));
  if (!item || typeof item !== 'object') return null;
  const observation = {};
  for (const key of ['sequence', 'flags', 'baseReference', 'fingerprint', 'reason', 'observedAt', 'stage']) {
    const value = item[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) observation[key] = value;
  }
  return Object.keys(observation).length ? observation : null;
}

function isMatched(matched, event, journalId) {
  if (!(matched instanceof Set)) return false;
  // Callers supply this exact identity after a content-bearing candidate has
  // already been accepted. Names, record numbers, and generations alone are
  // deliberately insufficient to suppress an independent deletion trace.
  return matched.has(eventIdentity(event)) || matched.has(`usn:${journalId}:${eventIdentity(event)}`);
}

function restoreName(deleteEvent, generationEvents) {
  // chooseRecoveryName validates the adjacent rename proof. sequence + 1 is
  // only an adapter for its current-record model; never wrap a USN sequence.
  if (deleteEvent.sequence >= MAX_SEQUENCE) return null;
  const naming = chooseRecoveryName({
    recordNumber: deleteEvent.recordNumber,
    sequence: deleteEvent.sequence + 1,
    name: deleteEvent.name,
    discoveredName: deleteEvent.name,
    nameReferences: [{ name: deleteEvent.name, namespace: 3, parent: deleteEvent.parent }],
    generationEvents,
    matchedDeletes: [deleteEvent],
  });
  return naming?.originalNameStatus === 'restored-from-history' && naming.source === 'windows-usn-rename-pair' ? naming : null;
}

/**
 * Builds metadata-only deletion traces for USN identities whose current MFT
 * record could not yield a content candidate. A trace contains no runs, bytes,
 * or MFT-name assertion; it is an auditable hand-off to a later deep search.
 */
export function buildDeletionTraces({ events, journalId, after = null, before = null, matchedIdentities = new Set(), observations = new Map(), maxTraces = MAX_TRACES } = {}) {
  const start = bound(after), end = bound(before);
  const stats = { eventsProvided: Array.isArray(events) ? events.length : 0, eventsConsidered: 0, eventsInvalid: 0, directoriesSkipped: 0,
    datesOutOfRange: 0, unknownDates: 0, duplicateUsns: 0, conflictingUsns: 0, ambiguousDeletes: 0, matchedSuppressed: 0,
    tracesBuilt: 0, maxEvents: MAX_EVENTS, maxTraces: null, invalidJournalId: false, invalidDateRange: false, inputTruncated: false };
  if (decimal(journalId, MAX_JOURNAL_ID) === null) {
    stats.invalidJournalId = true;
    return { candidates: [], truncated: false, stats };
  }
  if (!start.valid || !end.valid || start.value !== null && end.value !== null && start.value > end.value) {
    stats.invalidDateRange = true;
    return { candidates: [], truncated: false, stats };
  }
  const requestedLimit = Number.isSafeInteger(maxTraces) ? maxTraces : 0;
  const limit = Math.min(MAX_TRACES, Math.max(1, requestedLimit || MAX_TRACES));
  stats.maxTraces = limit;
  if (!Array.isArray(events)) return { candidates: [], truncated: false, stats };

  const byGeneration = new Map(), usnEvents = new Map(), conflictingGenerations = new Set();
  const supplied = events.slice(0, MAX_EVENTS);
  stats.inputTruncated = events.length > supplied.length;
  for (const raw of supplied) {
    stats.eventsConsidered++;
    const event = normalize(raw);
    if (!event) { stats.eventsInvalid++; continue; }
    if (raw.fileAttributes !== undefined && !Number.isInteger(raw.fileAttributes)) { stats.eventsInvalid++; continue; }
    if (Number.isInteger(raw.fileAttributes) && (raw.fileAttributes & DIRECTORY)) { stats.directoriesSkipped++; continue; }
    if (event.atMs === null) stats.unknownDates++;
    const knownUsn = usnEvents.get(event.usn), fingerprint = eventFingerprint(event);
    if (knownUsn) {
      stats.duplicateUsns++;
      if (knownUsn.fingerprint !== fingerprint) {
        stats.conflictingUsns++;
        conflictingGenerations.add(knownUsn.generation);
        conflictingGenerations.add(generationIdentity(event));
      }
      continue;
    }
    usnEvents.set(event.usn, { fingerprint, generation: generationIdentity(event) });
    const key = generationIdentity(event);
    const group = byGeneration.get(key) ?? [];
    group.push(event); byGeneration.set(key, group);
  }

  const traces = [];
  for (const [generation, group] of byGeneration) {
    if (conflictingGenerations.has(generation)) continue;
    const deletes = group.filter(event => event.reason & FILE_DELETE);
    if (deletes.length !== 1) { if (deletes.length > 1) stats.ambiguousDeletes++; continue; }
    const deletion = deletes[0];
    // The date window selects deletions. Earlier retained rename events are
    // still needed to identify files that sat in the recycle bin for days.
    if (deletion.atMs !== null && (start.value !== null && deletion.atMs < start.value
      || end.value !== null && deletion.atMs > end.value)) { stats.datesOutOfRange++; continue; }
    if (isMatched(matchedIdentities, deletion, journalId)) { stats.matchedSuppressed++; continue; }
    traces.push({ deletion, group });
  }
  traces.sort((left, right) => (right.deletion.atMs ?? -Infinity) - (left.deletion.atMs ?? -Infinity)
    || (BigInt(right.deletion.usn) > BigInt(left.deletion.usn) ? 1 : BigInt(right.deletion.usn) < BigInt(left.deletion.usn) ? -1 : 0));

  const candidates = [];
  for (const { deletion, group } of traces) {
    if (candidates.length >= limit) break;
    const naming = restoreName(deletion, group);
    const observation = traceObservation(observations, deletion.recordNumber);
    const deletedAt = deletion.atMs === null ? null : new Date(deletion.atMs).toISOString();
    const traceEvidence = { fileReference: fileReference(deletion), journalId, deleteUsn: deletion.usn, deletedName: deletion.name,
      deletedParentFileReference: fileReference(deletion.parent) };
    if (naming?.evidence) traceEvidence.rename = { ...naming.evidence, originalName: naming.name };
    if (observation) traceEvidence.currentRecordObservation = observation;
    candidates.push({
      id: `usn:${journalId}:${deletion.recordNumber}:${deletion.sequence}:${deletion.usn}`,
      recordNumber: deletion.recordNumber,
      sequence: deletion.sequence,
      name: naming?.name ?? deletion.name,
      discoveredName: deletion.name,
      source: 'deletion-trace', provenance: 'windows-usn', status: 'metadata-only', storage: 'unlocated', hasContent: false,
      requiresPreparation: false, size: null, path: null, pathStatus: 'unknown', nameIsGenerated: false,
      originalIdentityVerified: false, originalNameStatus: naming ? 'history-only' : 'unknown',
      restorationName: naming ? { name: naming.name, source: naming.source, evidence: { ...naming.evidence } } : null,
      previousNameHints: naming ? [naming.name] : [], deletedAt, deletedAtSource: 'windows-usn',
      dateMatch: start.value === null && end.value === null ? 'not-requested' : deletedAt === null ? 'unknown' : 'matched',
      discoverySources: ['windows-usn'], traceEvidence,
      reasons: observation
        ? ['삭제 변경 이력은 남아 있지만 현재 기록 관측만으로 본문 저장 위치를 확인할 수 없어요.', '검색 중 확인한 파일 관리 기록이며, 물리적 소거나 본문 상태를 증명하지 않아요.']
        : ['삭제 변경 이력은 남아 있지만 현재 MFT 기록에서 본문 저장 위치를 확인하지 못했어요.', '이 항목에는 저장하거나 열 수 있는 본문이 없어요.'],
    });
  }
  stats.tracesBuilt = candidates.length;
  return { candidates, truncated: stats.inputTruncated || traces.length > candidates.length, stats };
}
