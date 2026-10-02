import path from 'node:path';
import { chooseRecoveryName } from './recovery-name.mjs';
import { validateRecycleMetadataCandidate } from './recycle-metadata.mjs';
import { validateDirectorySlackClue } from './directory-slack-clue.mjs';

export function normalizeMetadataCandidate(candidate) {
  if (candidate?.source === 'recent-link') return { ...candidate, path: null, size: null, modifiedAt: null,
    deletedAt: null, deletedAtSource: null, status: 'metadata-only', storage: 'unlocated', hasContent: false,
    requiresPreparation: false, originalNameStatus: 'path-clue', originalIdentityVerified: false,
    deletionConfirmed: false, restorationName: null, bodyAssociation: 'not-asserted' };
  if (candidate?.source === 'directory-slack') {
    const entry = validateDirectorySlackClue(candidate);
    return { ...candidate, name: entry?.name ?? '이름 미확인', discoveredName: entry?.name ?? null,
      recordedSize: entry?.recordedSize ?? null, recordedModifiedAt: entry?.modifiedAt ?? null,
      size: null, path: null, originalPath: null, deletedAt: null, deletedAtSource: null, modifiedAt: null,
      status: 'metadata-only', storage: 'unlocated', hasContent: false, requiresPreparation: false,
      originalNameStatus: entry ? 'slack-name-clue' : 'unknown', originalIdentityVerified: false, deletionConfirmed: false,
      restorationName: null, bodyAssociation: 'not-asserted',
      ...(entry ? {} : { directoryName: null, directoryReference: null, reasons: ['폴더 기록 흔적의 근거가 일치하지 않아 이름 정보를 표시하지 않아요.'] }) };
  }
  if (candidate?.source !== 'recycle-metadata') return candidate;
  const info = validateRecycleMetadataCandidate(candidate);
  return { ...candidate, name: info?.name ?? '이름 미확인', originalPath: info?.originalPath ?? null,
    recordedSize: info?.originalSize ?? null, recycledAt: info?.recycledAt ?? null,
    path: null, size: null, modifiedAt: null, deletedAt: null, deletedAtSource: null,
    status: 'metadata-only', storage: 'unlocated', hasContent: false, requiresPreparation: false,
    originalIdentityVerified: false, restorationName: null, bodyAssociation: 'not-asserted',
    originalNameStatus: info ? 'metadata-only-name' : 'unknown',
    ...(info ? {} : { reasons: ['휴지통 정보 단서의 근거가 일치하지 않아 이름·경로를 표시하지 않아요.'] }) };
}

export function candidateSearchName(candidate) {
  const naming = chooseRecoveryName(candidate);
  if (candidate?.source === 'directory-slack') return naming.originalNameStatus === 'slack-name-clue' ? naming.name : '';
  if (candidate?.source === 'recycle-metadata') return naming.originalNameStatus === 'metadata-only-name' ? naming.name : '';
  if (candidate?.source === 'deletion-trace') return naming.name ?? '';
  return naming.originalNameStatus === 'restored-from-history' ? naming.name
    : String(candidate?.name ?? path.basename(String(candidate?.path ?? '')));
}

const DOCUMENT_EXTENSIONS = new Set([
  'csv', 'doc', 'docm', 'docx', 'epub', 'hwp', 'hwpx', 'log', 'md', 'odf',
  'ods', 'odt', 'pages', 'pdf', 'ppt', 'pptm', 'pptx', 'rtf', 'tex', 'tsv',
  'txt', 'xls', 'xlsb', 'xlsm', 'xlsx', 'xml'
]);
const PHOTO_EXTENSIONS = new Set([
  'avif', 'bmp', 'dng', 'gif', 'heic', 'heif', 'jpeg', 'jpg', 'png', 'raw',
  'svg', 'tif', 'tiff', 'webp'
]);
const KINDS = new Set(['all', 'document', 'photo', 'other']);

function normalizedText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase('und')
    .replace(/[\p{Z}\s_.,()[\]{}\-+]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function compactText(value) {
  return normalizedText(value).replace(/\s+/g, '');
}

function comparableName(value) {
  const base = path.basename(String(value ?? ''));
  const extension = path.extname(base);
  return normalizedText(extension ? base.slice(0, -extension.length) : base);
}

function parseOptionalNumber(value, label) {
  if (value === undefined || value === null || value === '') return null;
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number) || number < 0) throw new TypeError(`${label} must be a finite non-negative number`);
  return number;
}

function parseOptionalDate(value, label) {
  if (value === undefined || value === null || value === '') return null;
  const timestamp = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(String(value));
  if (!Number.isFinite(timestamp)) throw new TypeError(`${label} must be a valid date`);
  return timestamp;
}

function normalizeExtensions(value) {
  if (value === undefined || value === null || value === '') return [];
  const values = Array.isArray(value) ? value : String(value).split(/[\s,;]+/);
  const result = [];
  const seen = new Set();
  for (const item of values) {
    const extension = normalizedText(item).replace(/^\.+/, '').replace(/\s+/g, '');
    if (!extension) continue;
    if (!/^[\p{L}\p{N}][\p{L}\p{N}+-]*$/u.test(extension)) throw new TypeError(`invalid extension: ${item}`);
    if (!seen.has(extension)) {
      seen.add(extension);
      result.push(extension);
    }
  }
  return result;
}

export function normalizeFilters(input = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('filters must be an object');
  if (String(input.name ?? '').length > 256 || String(input.pathContains ?? '').length > 1024 || (Array.isArray(input.extensions) && input.extensions.length > 32)) throw new TypeError('검색 조건이 너무 길어요.');
  const kind = input.kind === undefined || input.kind === null || input.kind === '' ? 'all' : normalizedText(input.kind);
  if (!KINDS.has(kind)) throw new TypeError(`unsupported kind: ${input.kind}`);
  const minSize = parseOptionalNumber(input.minSize, 'minSize');
  const maxSize = parseOptionalNumber(input.maxSize, 'maxSize');
  if (minSize !== null && maxSize !== null && minSize > maxSize) throw new RangeError('minSize cannot be greater than maxSize');
  const modifiedAfter = parseOptionalDate(input.modifiedAfter, 'modifiedAfter');
  const modifiedBefore = parseOptionalDate(input.modifiedBefore, 'modifiedBefore');
  if (modifiedAfter !== null && modifiedBefore !== null && modifiedAfter > modifiedBefore) {
    throw new RangeError('modifiedAfter cannot be later than modifiedBefore');
  }
  const deletedAfter = parseOptionalDate(input.deletedAfter, 'deletedAfter');
  const deletedBefore = parseOptionalDate(input.deletedBefore, 'deletedBefore');
  if (deletedAfter !== null && deletedBefore !== null && deletedAfter > deletedBefore) {
    throw new RangeError('deletedAfter cannot be later than deletedBefore');
  }
  if (input.includeUnknownDeletedAt !== undefined && typeof input.includeUnknownDeletedAt !== 'boolean') {
    throw new TypeError('includeUnknownDeletedAt must be a boolean');
  }
  return {
    name: String(input.name ?? '').normalize('NFKC').trim(),
    extensions: normalizeExtensions(input.extensions),
    kind,
    minSize,
    maxSize,
    modifiedAfter,
    modifiedBefore,
    deletedAfter,
    deletedBefore,
    includeUnknownDeletedAt: input.includeUnknownDeletedAt !== false,
    pathContains: String(input.pathContains ?? '').normalize('NFKC').trim()
  };
}

export function classifyFileKind(filename) {
  const extension = path.extname(String(filename ?? '')).slice(1).toLocaleLowerCase('und');
  if (DOCUMENT_EXTENSIONS.has(extension)) return 'document';
  if (PHOTO_EXTENSIONS.has(extension)) return 'photo';
  return 'other';
}

function stripVariantSuffixes(value) {
  let text = value;
  const reasons = [];
  const patterns = [
    ['copy', /(?:\s|^)(?:copy|duplicate|복사본|사본)(?:\s*\d+)?$/u],
    ['final', /(?:\s|^)(?:final|final본|최종|최종본)$/u],
    ['revision', /(?:\s|^)(?:rev(?:ision)?\s*\d+|ver(?:sion)?\s*\d+|v\s*\d+(?:\.\d+)*|수정본|개정본?|\d+차)$/u],
    ['date', /(?:\s|^)(?:19|20)\d{2}(?:\s?\d{1,2}){0,2}$/u],
    ['copy', /\s\d+$/u]
  ];
  let changed = true;
  while (changed && text) {
    changed = false;
    for (const [reason, pattern] of patterns) {
      const next = text.replace(pattern, '').trim();
      if (next !== text) {
        text = next;
        if (!reasons.includes(reason)) reasons.push(reason);
        changed = true;
      }
    }
  }
  return { text, reasons };
}

function graphemes(value) {
  return [...value.normalize('NFD')];
}

function damerauLevenshtein(left, right, cutoff = Infinity) {
  const a = graphemes(left);
  const b = graphemes(right);
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  if (Math.abs(a.length - b.length) > cutoff) return cutoff + 1;
  let previousPrevious = null;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let rowMinimum = i;
    for (let j = 1; j <= b.length; j++) {
      let value = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, previousPrevious[j - 2] + 1);
      }
      current.push(value);
      rowMinimum = Math.min(rowMinimum, value);
    }
    if (rowMinimum > cutoff) return cutoff + 1;
    previousPrevious = previous;
    previous = current;
  }
  return previous[b.length];
}

function bigrams(value) {
  const units = graphemes(value);
  if (units.length < 2) return new Map([[units.join(''), 1]]);
  const result = new Map();
  for (let index = 0; index < units.length - 1; index++) {
    const pair = units[index] + units[index + 1];
    result.set(pair, (result.get(pair) ?? 0) + 1);
  }
  return result;
}

function diceCoefficient(left, right) {
  if (left === right) return 1;
  if (!left || !right) return 0;
  const a = bigrams(left);
  const b = bigrams(right);
  let overlap = 0;
  for (const [pair, count] of a) overlap += Math.min(count, b.get(pair) ?? 0);
  const total = [...a.values()].reduce((sum, value) => sum + value, 0) + [...b.values()].reduce((sum, value) => sum + value, 0);
  return total ? (2 * overlap) / total : 0;
}

function boundedScore(value) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function rankName(query, name) {
  const queryName = comparableName(query);
  const candidateName = comparableName(name);
  if (!queryName || !candidateName) return { score: 0, reasons: ['noAI'] };
  const queryCompact = compactText(queryName);
  const candidateCompact = compactText(candidateName);
  const strippedQuery = stripVariantSuffixes(queryName);
  const strippedCandidate = stripVariantSuffixes(candidateName);
  const strippedQueryCompact = compactText(strippedQuery.text);
  const strippedCandidateCompact = compactText(strippedCandidate.text);
  const variantReasons = [...new Set([...strippedQuery.reasons, ...strippedCandidate.reasons])];

  let score;
  let matchReason;
  if (queryCompact === candidateCompact) {
    score = 100;
    matchReason = 'filenameSimilarity:exact';
  } else if (strippedQueryCompact && strippedQueryCompact === strippedCandidateCompact) {
    score = 96;
    matchReason = 'filenameSimilarity:variant';
  } else if (candidateCompact.includes(queryCompact) || queryCompact.includes(candidateCompact)) {
    const shorter = Math.min(queryCompact.length, candidateCompact.length);
    const longer = Math.max(queryCompact.length, candidateCompact.length);
    score = 78 + 17 * (shorter / longer);
    matchReason = 'filenameSimilarity:contains';
  } else {
    const left = strippedQueryCompact || queryCompact;
    const right = strippedCandidateCompact || candidateCompact;
    const maximum = Math.max(graphemes(left).length, graphemes(right).length);
    const cutoff = Math.max(2, Math.ceil(maximum * 0.45));
    const distance = damerauLevenshtein(left, right, cutoff);
    const editSimilarity = distance > cutoff ? 0 : 1 - distance / maximum;
    const dice = diceCoefficient(left, right);
    const queryTokens = new Set(normalizedText(queryName).split(' ').filter(Boolean));
    const candidateTokens = new Set(normalizedText(candidateName).split(' ').filter(Boolean));
    const sharedTokens = [...queryTokens].filter(token => candidateTokens.has(token)).length;
    const tokenSimilarity = queryTokens.size ? sharedTokens / queryTokens.size : 0;
    score = 100 * Math.max(editSimilarity * 0.8 + dice * 0.2, dice * 0.75 + tokenSimilarity * 0.25);
    matchReason = tokenSimilarity >= 0.5 ? 'filenameSimilarity:tokens' : 'filenameSimilarity:fuzzy';
  }

  const reasons = [matchReason];
  for (const variant of variantReasons) reasons.push(`filenameVariant:${variant}`);
  reasons.push('noAI');
  return { score: boundedScore(score), reasons };
}

export function classifyNameMatch(query, candidate) {
  const requested = String(query ?? '').normalize('NFKC').trim();
  if (!requested) return { kind: 'none', score: 0, reason: '파일명 검색어가 없습니다.' };
  const name = candidateSearchName(candidate).trim();
  if (!name || candidate?.nameIsGenerated === true || /^\$[RI][^\\/]*$/i.test(path.basename(name))) {
    return { kind: 'unknown', score: 0, reason: '원래 파일명을 확인할 수 없어 일치 여부를 판단하지 못했습니다.' };
  }
  const ranked = rankName(requested, name);
  const primaryReason = ranked.reasons.find(reason => reason.startsWith('filenameSimilarity:'));
  const literalName = value => path.basename(value).normalize('NFKC').toLocaleLowerCase('und').replace(/[\p{Z}\s]+/gu, '');
  const queryFull = literalName(requested);
  const candidateFull = literalName(name);
  if (queryFull && queryFull === candidateFull) {
    return { kind: 'exact', score: ranked.score, reason: '대소문자·유니코드·공백을 정규화한 전체 파일명이 정확히 일치합니다.' };
  }
  if (['filenameSimilarity:exact', 'filenameSimilarity:variant', 'filenameSimilarity:contains'].includes(primaryReason)) {
    return { kind: 'partial', score: ranked.score, reason: primaryReason.endsWith(':variant')
      ? '복사본·최종본·버전 표기를 제외하면 파일명이 일치합니다.'
      : primaryReason.endsWith(':exact') ? '확장자를 제외한 파일명이 일치하지만 전체 파일명은 다릅니다.'
      : '확인된 파일명에 검색어가 포함되어 있습니다.' };
  }
  if (ranked.score >= 45) return { kind: 'similar', score: ranked.score, reason: '확인된 파일명이 검색어와 비슷합니다.' };
  return { kind: 'none', score: ranked.score, reason: '확인된 파일명은 검색어와 일치하지 않습니다.' };
}

function candidateTimestamp(candidate) {
  if (candidate?.modifiedAt === null || candidate?.modifiedAt === undefined || candidate.modifiedAt === '') return null;
  const value = typeof candidate.modifiedAt === 'number' ? candidate.modifiedAt : Date.parse(String(candidate.modifiedAt));
  return Number.isFinite(value) ? value : null;
}

function candidateDeletedTimestamp(candidate) {
  const deletedAt = candidate?.deletedAt;
  if (typeof deletedAt !== 'number' && (typeof deletedAt !== 'string' || !deletedAt.trim())) return null;
  const value = typeof deletedAt === 'number' ? new Date(deletedAt).getTime() : Date.parse(deletedAt);
  return Number.isFinite(value) ? value : null;
}

export function matchesCandidate(candidate, filters) {
  if (!candidate || typeof candidate !== 'object') return false;
  candidate = normalizeMetadataCandidate(candidate);
  const normalized = normalizeFilters(filters);
  const name = candidateSearchName(candidate);
  const extension = path.extname(name).slice(1).toLocaleLowerCase('und');
  const kind = candidate.kind ?? classifyFileKind(name);
  const size = candidate.size == null ? NaN : Number(candidate.size);
  if (normalized.name && rankName(normalized.name, name).score < 45) return false;
  if (normalized.extensions.length && !normalized.extensions.includes(extension)) return false;
  if (normalized.kind !== 'all' && kind !== normalized.kind) return false;
  if (normalized.minSize !== null && (!Number.isFinite(size) || size < normalized.minSize)) return false;
  if (normalized.maxSize !== null && (!Number.isFinite(size) || size > normalized.maxSize)) return false;
  if (normalized.modifiedAfter !== null || normalized.modifiedBefore !== null) {
    const modified = candidateTimestamp(candidate);
    if (modified === null) return false;
    if (normalized.modifiedAfter !== null && modified < normalized.modifiedAfter) return false;
    if (normalized.modifiedBefore !== null && modified > normalized.modifiedBefore) return false;
  }
  if (normalized.deletedAfter !== null || normalized.deletedBefore !== null || normalized.includeUnknownDeletedAt === false) {
    const deleted = candidateDeletedTimestamp(candidate);
    if (deleted === null) {
      if (!normalized.includeUnknownDeletedAt) return false;
    } else {
      if (normalized.deletedAfter !== null && deleted < normalized.deletedAfter) return false;
      if (normalized.deletedBefore !== null && deleted > normalized.deletedBefore) return false;
    }
  }
  if (normalized.pathContains && !compactText(candidate.originalPath || candidate.path).includes(compactText(normalized.pathContains))) return false;
  return true;
}

function sortDescription(sort) {
  if (!sort) return null;
  if (typeof sort === 'string') {
    const match = /^(score|name|size|modified|deleted|path)(?:-(asc|desc))?$/.exec(sort);
    if (!match) throw new TypeError(`unsupported sort: ${sort}`);
    return { by: match[1], direction: match[2] ?? (match[1] === 'name' || match[1] === 'path' ? 'asc' : 'desc') };
  }
  if (typeof sort !== 'object' || Array.isArray(sort)) throw new TypeError('sort must be a string or object');
  const by = sort.by ?? 'score';
  const direction = sort.direction ?? (by === 'name' || by === 'path' ? 'asc' : 'desc');
  if (!['score', 'name', 'size', 'modified', 'deleted', 'path'].includes(by) || !['asc', 'desc'].includes(direction)) {
    throw new TypeError('unsupported sort description');
  }
  return { by, direction };
}

function compareValues(left, right, by) {
  if (by === 'path') return normalizedText(left.originalPath || left.path).localeCompare(normalizedText(right.originalPath || right.path), 'ko', { numeric: true });
  if (by === 'name') return normalizedText(candidateSearchName(left)).localeCompare(normalizedText(candidateSearchName(right)), 'ko', { numeric: true });
  if (by === 'modified') return (candidateTimestamp(left) ?? -Infinity) - (candidateTimestamp(right) ?? -Infinity);
  return (Number(left[by]) || 0) - (Number(right[by]) || 0);
}

export function filterCandidates(items, filters = {}, { sort, keepNameMismatches = false } = {}) {
  if (!Array.isArray(items)) throw new TypeError('items must be an array');
  const normalized = normalizeFilters(filters);
  const nonNameFilters = keepNameMismatches ? { ...normalized, name: '' } : normalized;
  let copies = items
    .map(normalizeMetadataCandidate)
    .filter(candidate => matchesCandidate(candidate, nonNameFilters))
    .map((candidate, index) => {
      if (candidate.source === 'deletion-trace') {
        const naming = chooseRecoveryName(candidate);
        candidate = { ...candidate, name: naming.name ?? '이름 미확인', originalNameStatus: naming.originalNameStatus,
          restorationName: naming.evidence ? { name: naming.name, source: naming.source, evidence: naming.evidence } : null };
      }
      const ranked = normalized.name ? rankName(normalized.name, candidateSearchName(candidate)) : { score: Number(candidate.score) || 0, reasons: [...(candidate.reasons ?? [])] };
      const nameMatch = classifyNameMatch(normalized.name, candidate);
      const score = normalized.name ? nameMatch.score : ranked.score;
      const rankReasons = nameMatch.kind === 'unknown' || ['recycle-metadata', 'directory-slack'].includes(candidate.source) ? [] : ranked.reasons;
      return { candidate: { ...candidate, score, reasons: [...new Set([...(candidate.reasons ?? []), ...rankReasons])], nameMatch }, index };
    });
  const description = sortDescription(sort);
  if (description) {
    const direction = description.direction === 'asc' ? 1 : -1;
    copies.sort((left, right) => {
      if (description.by === 'score' && normalized.name) {
        const priority = { exact: 4, partial: 3, similar: 2, unknown: 1, none: 0 };
        const difference = priority[right.candidate.nameMatch.kind] - priority[left.candidate.nameMatch.kind];
        if (difference) return description.direction === 'desc' ? difference : -difference;
      }
      if (description.by === 'deleted') {
        const leftTime = candidateDeletedTimestamp(left.candidate);
        const rightTime = candidateDeletedTimestamp(right.candidate);
        // Unknown deletion times stay last in either direction; modification time is unrelated.
        if (leftTime === null || rightTime === null) {
          if (leftTime !== rightTime) return leftTime === null ? 1 : -1;
          return left.index - right.index;
        }
        return direction * (leftTime - rightTime) || left.index - right.index;
      }
      return direction * compareValues(left.candidate, right.candidate, description.by) || left.index - right.index;
    });
  }
  return copies.map(item => item.candidate);
}
