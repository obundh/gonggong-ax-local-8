import { validateRecycleMetadataCandidate } from './recycle-metadata.mjs';
import { validateDirectorySlackClue } from './directory-slack-clue.mjs';

const USN_REASON_FILE_DELETE = 0x00000200;
const USN_REASON_RENAME_OLD_NAME = 0x00001000;
const USN_REASON_RENAME_NEW_NAME = 0x00002000;
const USN_REASON_CLOSE = 0x80000000;
const USN_REASON_HARD_LINK_CHANGE = 0x00010000;
const MAX_NAME_HISTORY_EVENTS = 4096;
const MAX_NAME_HISTORY_PAIRS = 64;

function parentKey(parent) {
  if (!Number.isSafeInteger(parent?.recordNumber) || parent.recordNumber < 0 || parent.recordNumber > 0xffffffffffff
    || !Number.isInteger(parent?.sequence) || parent.sequence < 0 || parent.sequence > 0xffff) return null;
  return `${parent.recordNumber}:${parent.sequence}`;
}

function fileReference(recordNumber, sequence) {
  if (!Number.isSafeInteger(recordNumber) || recordNumber < 0 || recordNumber > 0xffffffffffff
    || !Number.isInteger(sequence) || sequence < 0 || sequence > 0xffff) return null;
  return (BigInt(recordNumber) | BigInt(sequence) << 48n).toString();
}

function validFileReference(value) {
  try { return typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value) && BigInt(value) <= 0xffffffffffffffffn; }
  catch { return false; }
}

function usnOf(event) {
  try {
    if (typeof event?.usn !== 'string' || !/^(0|[1-9][0-9]*)$/.test(event.usn)) return null;
    const usn = BigInt(event.usn);
    return usn <= 0x7fffffffffffffffn ? usn : null;
  } catch { return null; }
}

function safeWindowsLeaf(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 255 || value !== value.normalize('NFC')) return false;
  if (value === '.' || value === '..' || /[<>:"/\\|?*\u0000-\u001f\u007f]/.test(value) || /[. ]$/.test(value)) return false;
  return !/^(con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\.|$)/i.test(value);
}

function recycleAlias(name) {
  return safeWindowsLeaf(name) && /^\$R[A-Z0-9]{6}(?:\.[A-Z0-9]{1,16})?$/i.test(name);
}

function uniqueRecordNames(candidate) {
  const references = Array.isArray(candidate?.nameReferences) ? candidate.nameReferences : [];
  const unique = new Map();
  for (const reference of references) {
    const parent = parentKey(reference?.parent);
    if (typeof reference?.name !== 'string' || !parent) return [];
    const namespace = reference?.namespace;
    // Older, already-sanitized candidates did not retain the namespace. Keep a
    // single such name usable, but never use it to collapse two names. New NTFS
    // records must identify the namespace so that a DOS 8.3 companion is not
    // mistaken for a hard link.
    if (namespace !== undefined && (!Number.isInteger(namespace) || namespace < 0 || namespace > 3)) return [];
    unique.set(`${namespace ?? 'unknown'}\u0000${reference.name}\u0000${parent}`, reference);
  }
  return [...unique.values()];
}

function canonicalRecordName(candidate, discoveredName, allowPosix = false) {
  const references = uniqueRecordNames(candidate);
  const hasNamespace = references.some(reference => reference.namespace !== undefined);
  const canonical = references.filter(reference => reference.name === discoveredName
    && (hasNamespace ? reference.namespace === 1 || reference.namespace === 3 || allowPosix && reference.namespace === 0 : true));
  if (canonical.length !== 1) return null;
  const selected = canonical[0];
  const selectedParent = parentKey(selected.parent);
  if (!selectedParent) return null;

  for (const reference of references) {
    if (reference === selected) continue;
    // A FILE_NAME namespace of DOS is a second spelling of the same directory
    // entry. It is not another name choice, provided it remains under the same
    // parent. Any other entry (including POSIX, an unknown legacy namespace, or
    // another Win32 name) could be a hard link or conflicting metadata.
    if (!hasNamespace || reference.namespace !== 2 || parentKey(reference.parent) !== selectedParent) return null;
  }
  return selected;
}

function unknown(discoveredName) {
  return { name: discoveredName, originalNameStatus: 'unknown', source: null, discoveredName };
}

// NTFS can publish the same name transition again when the handle is closed.
// Accept only the immediate CLOSE form of the preceding event: it must retain
// the exact reason bits, name, and parent.  The caller has already tied every
// event to the same record generation, so this cannot join two generations.
function accumulatedCloseDuplicate(previous, next) {
  if (!previous || !next) return false;
  const previousReason = Number(previous.event.reason) >>> 0;
  const nextReason = Number(next.event.reason) >>> 0;
  return !(previousReason & USN_REASON_CLOSE) && !!(nextReason & USN_REASON_CLOSE)
    && nextReason === (previousReason | USN_REASON_CLOSE) >>> 0
    && previous.event.name === next.event.name
    && parentKey(previous.event.parent) !== null
    && parentKey(previous.event.parent) === parentKey(next.event.parent);
}

function sameLink(left, right) {
  return left.name === right.name && parentKey(left.parent) === parentKey(right.parent);
}

// Validate the retained history as one continuous name/parent chain. Earlier
// renames (including a restore followed by another recycle) must not make a
// later, unambiguous pre-trash name disappear. A gap or branch remains unknown.
function finalRenamePair(events) {
  let current = null, lastPair = null, pairs = 0;
  for (let index = 0; index < events.length; index++) {
    const item = events[index], reason = item.event.reason;
    const rename = reason & (USN_REASON_RENAME_OLD_NAME | USN_REASON_RENAME_NEW_NAME);
    if (!rename) {
      if (current && !sameLink(current, item.event)) return null;
      current ??= item.event;
      continue;
    }
    const next = events[index + 1];
    if (rename !== USN_REASON_RENAME_OLD_NAME || !next
      || (next.event.reason & (USN_REASON_RENAME_OLD_NAME | USN_REASON_RENAME_NEW_NAME)) !== USN_REASON_RENAME_NEW_NAME
      || current && !sameLink(current, item.event) || ++pairs > MAX_NAME_HISTORY_PAIRS) return null;
    lastPair = [item, next]; current = next.event; index++;
  }
  return lastPair;
}

function deriveFromJournal(candidate, discoveredName) {
  if (!recycleAlias(discoveredName)) return null;
  const recordNumber = candidate?.recordNumber;
  const currentSequence = candidate?.sequence;
  if (!Number.isSafeInteger(recordNumber) || !Number.isInteger(currentSequence) || currentSequence < 2 || currentSequence > 0xffff) return null;
  const journalSequence = currentSequence - 1;
  const identity = fileReference(recordNumber, journalSequence);
  const currentName = canonicalRecordName(candidate, discoveredName);
  if (!identity || !currentName) return null;
  const currentParent = parentKey(currentName.parent);

  const deletes = Array.isArray(candidate?.matchedDeletes) ? candidate.matchedDeletes : [];
  if (deletes.length !== 1) return null;
  const deletion = deletes[0], deleteUsn = usnOf(deletion), deleteReason = Number(deletion.reason);
  if (deleteUsn === null || deletion.recordNumber !== recordNumber || deletion.sequence !== journalSequence
    || !(deleteReason & USN_REASON_FILE_DELETE)
    || deleteReason & (USN_REASON_RENAME_OLD_NAME | USN_REASON_RENAME_NEW_NAME) || deletion.name !== discoveredName
    || parentKey(deletion.parent) !== currentParent) return null;

  const supplied = Array.isArray(candidate?.generationEvents) ? candidate.generationEvents : [];
  if (!supplied.length || supplied.length > MAX_NAME_HISTORY_EVENTS) return null;
  const events = [];
  const seenUsns = new Set();
  for (const event of supplied) {
    const usn = usnOf(event);
    if (usn === null || event.recordNumber !== recordNumber || event.sequence !== journalSequence || seenUsns.has(event.usn)
      || !safeWindowsLeaf(event.name) || !parentKey(event.parent)
      || !Number.isInteger(event.reason) || event.reason < 0 || event.reason > 0xffffffff
      || event.reason & USN_REASON_HARD_LINK_CHANGE || usn > deleteUsn) {
      return null;
    }
    seenUsns.add(event.usn);
    events.push({ event, usn });
  }
  events.sort((a, b) => a.usn < b.usn ? -1 : a.usn > b.usn ? 1 : 0);
  const normalizedEvents = [];
  for (const [index, item] of events.entries()) {
    if (!accumulatedCloseDuplicate(events[index - 1], item)) normalizedEvents.push(item);
  }
  const historyDeletes = normalizedEvents.filter(({ event }) => event.reason & USN_REASON_FILE_DELETE);
  if (historyDeletes.length !== 1 || historyDeletes[0].usn !== deleteUsn
    || historyDeletes[0].event.reason !== deletion.reason || !sameLink(historyDeletes[0].event, deletion)) return null;
  if (events.some(({ event, usn }) => usn >= deleteUsn
    && event.reason & (USN_REASON_RENAME_OLD_NAME | USN_REASON_RENAME_NEW_NAME))) return null;
  const beforeDelete = normalizedEvents.filter(item => item.usn < deleteUsn);
  const pair = finalRenamePair(beforeDelete);
  if (!pair) return null;
  const [oldItem, newItem] = pair;
  if (newItem.event.name !== discoveredName
    || parentKey(newItem.event.parent) !== currentParent) return null;

  const originalName = oldItem.event.name;
  if (!safeWindowsLeaf(originalName) || /^\$R/i.test(originalName) || originalName === discoveredName
    || !parentKey(oldItem.event.parent)) return null;

  return {
    name: originalName,
    originalNameStatus: 'restored-from-history',
    source: 'windows-usn-rename-pair',
    discoveredName,
    evidence: {
      fileReference: identity,
      oldNameUsn: oldItem.event.usn,
      newNameUsn: newItem.event.usn,
      deleteUsn: deletion.usn,
      oldParentFileReference: fileReference(oldItem.event.parent.recordNumber, oldItem.event.parent.sequence),
      recycleParentFileReference: fileReference(currentName.parent.recordNumber, currentName.parent.sequence),
    },
  };
}

function persistedRestoration(candidate, discoveredName) {
  const restoration = candidate?.restorationName, evidence = restoration?.evidence;
  if (!recycleAlias(discoveredName) || restoration?.source !== 'windows-usn-rename-pair'
    || !safeWindowsLeaf(restoration?.name) || /^\$R/i.test(restoration.name) || !evidence) return null;
  const oldUsn = usnOf({ usn: evidence.oldNameUsn }), newUsn = usnOf({ usn: evidence.newNameUsn });
  const deleteUsn = usnOf({ usn: evidence.deleteUsn });
  if (oldUsn === null || newUsn === null || deleteUsn === null || oldUsn >= newUsn || newUsn >= deleteUsn) return null;
  if (!validFileReference(evidence.oldParentFileReference)) return null;
  const identity = fileReference(candidate?.recordNumber, Number(candidate?.sequence) - 1);
  if (!identity || evidence.fileReference !== identity) return null;
  const currentName = canonicalRecordName(candidate, discoveredName);
  if (!currentName || evidence.recycleParentFileReference !== fileReference(currentName.parent.recordNumber, currentName.parent.sequence)) return null;
  return { name: restoration.name, originalNameStatus: 'restored-from-history', source: restoration.source,
    discoveredName, evidence: { ...evidence } };
}

function deletionTraceName(candidate) {
  const trace = candidate.traceEvidence;
  const discoveredName = safeWindowsLeaf(candidate.discoveredName) ? candidate.discoveredName : null;
  const fallback = unknown(discoveredName);
  const identity = fileReference(candidate.recordNumber, candidate.sequence);
  if (!identity || !Number.isInteger(candidate.sequence) || candidate.sequence < 1
    || trace?.fileReference !== identity || trace.deletedName !== discoveredName
    || !validFileReference(trace.journalId) || trace.journalId.length > 20
    || usnOf({ usn: trace.deleteUsn }) === null) return fallback;
  const rawId = `usn:${trace.journalId}:${candidate.recordNumber}:${candidate.sequence}:${trace.deleteUsn}`;
  if (candidate.id !== rawId && candidate.id !== `${candidate.partitionId}/${rawId}`) return fallback;
  const restoration = candidate.restorationName, proof = trace.rename, evidence = restoration?.evidence;
  if (!recycleAlias(discoveredName)) return { ...fallback, name: discoveredName, originalNameStatus: 'history-only', source: 'windows-usn-delete' };
  if (!proof || !evidence || restoration.source !== 'windows-usn-rename-pair'
    || !safeWindowsLeaf(proof.originalName) || /^\$R/i.test(proof.originalName)
    || restoration.name !== proof.originalName || candidate.name !== proof.originalName) return fallback;
  const oldUsn = usnOf({ usn: proof.oldNameUsn }), newUsn = usnOf({ usn: proof.newNameUsn });
  const deleteUsn = usnOf({ usn: trace.deleteUsn });
  if (oldUsn === null || newUsn === null || oldUsn >= newUsn || newUsn >= deleteUsn
    || proof.fileReference !== identity || proof.deleteUsn !== trace.deleteUsn
    || !validFileReference(proof.oldParentFileReference)
    || !validFileReference(trace.deletedParentFileReference)
    || proof.recycleParentFileReference !== trace.deletedParentFileReference) return fallback;
  for (const key of ['fileReference', 'oldNameUsn', 'newNameUsn', 'deleteUsn', 'oldParentFileReference', 'recycleParentFileReference']) {
    if (evidence[key] !== proof[key]) return fallback;
  }
  return { name: proof.originalName, discoveredName, originalNameStatus: 'history-only', source: restoration.source, evidence: { ...evidence } };
}

/**
 * Selects the recovery basename. Raw USN events are accepted only during scan;
 * later prepared candidates carry the already checked, self-consistent proof in
 * `restorationName`, which is validated again before use.
 */
export function chooseRecoveryName(candidate) {
  if (candidate?.source === 'recent-link') return { name: candidate.name || '이름 미확인',
    originalNameStatus: 'path-clue', source: 'recent-link', restored: false,
    reason: '바로가기에 남은 이름·경로 단서이며 원본이나 삭제 여부는 확인하지 않았어요.' };
  if (candidate?.source === 'directory-slack') {
    const entry = validateDirectorySlackClue(candidate);
    return entry ? { name: entry.name, discoveredName: entry.name, originalNameStatus: 'slack-name-clue', source: candidate.provenance }
      : unknown(null);
  }
  if (candidate?.source === 'recycle-metadata') {
    const info = validateRecycleMetadataCandidate(candidate);
    return info ? { name: info.name, discoveredName: candidate.discoveredName,
      originalNameStatus: 'metadata-only-name', source: 'deleted-recycle-info' }
      : unknown(candidate.discoveredName ?? null);
  }
  if (candidate?.source === 'deletion-trace') return deletionTraceName(candidate);
  const discoveredName = typeof candidate?.discoveredName === 'string' ? candidate.discoveredName
    : typeof candidate?.name === 'string' ? candidate.name : null;
  if (!discoveredName) return unknown(discoveredName);
  const restored = persistedRestoration(candidate, discoveredName) ?? deriveFromJournal(candidate, discoveredName);
  if (restored) return restored;
  if (!safeWindowsLeaf(discoveredName) || /^\$R/i.test(discoveredName)
    || candidate?.nameIsGenerated === true || candidate?.source === 'carved') return unknown(discoveredName);
  if (Array.isArray(candidate?.nameReferences) && candidate.nameReferences.length
    && !canonicalRecordName(candidate, discoveredName, true)) {
    const alternatives = candidate.nameReferences.map(item => ({ name: item.name, namespace: item.namespace, parent: item.parent }));
    const suffixes = alternatives.map(item => safeWindowsLeaf(item.name) ? /\.[a-z0-9]{1,16}$/i.exec(item.name)?.[0]?.toLowerCase() : null);
    const extension = suffixes[0] && suffixes.every(value => value === suffixes[0]) ? suffixes[0] : '.bin';
    const record = Number.isSafeInteger(candidate.recordNumber) ? String(candidate.recordNumber) : 'unknown';
    return { name: `recovered-record-${record}${extension}`, originalNameStatus: 'ambiguous', source: 'generated-name', discoveredName, alternatives };
  }
  return { name: discoveredName, originalNameStatus: 'record-name', source: 'file-record', discoveredName };
}
// Input must already be a sanitized basename. Preserve ordinary document suffixes
// while keeping the component bounded and avoiding half of a UTF-16 surrogate pair.
export function shortenOutputName(leaf) {
  if (leaf.length <= 180) return leaf;
  const dot = leaf.lastIndexOf('.');
  const suffix = dot > 0 ? leaf.slice(dot) : '';
  const extension = suffix.length <= 32 ? suffix : '';
  let stem = leaf.slice(0, 180 - extension.length);
  if (/[\uD800-\uDBFF]$/.test(stem)) stem = stem.slice(0, -1);
  return stem.replace(/[. ]+$/g, '') + extension;
}
