import { access, lstat, opendir, realpath } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { matchesCandidate, normalizeFilters } from './candidate-filter.mjs';
import { ExistingFileError, existingCandidate } from './file-search.mjs';

const MAX_ROOTS = 8;
const MAX_WARNINGS = 100;
const MAX_CANDIDATES = 10_000;
const MAX_FILES = 1_000_000;
const MAX_DIRECTORIES = 100_000;
const MAX_DURATION_MS = 60_000;

const DOCUMENT_EXTENSIONS = new Set([
  'csv', 'doc', 'docm', 'docx', 'epub', 'hwp', 'hwpx', 'log', 'md', 'odf',
  'ods', 'odt', 'pages', 'pdf', 'ppt', 'pptm', 'pptx', 'rtf', 'tex', 'tsv',
  'txt', 'xls', 'xlsb', 'xlsm', 'xlsx', 'xml'
]);
const AUTOSAVE_EXTENSIONS = new Set(['asd', 'wbk', 'tmp', 'bak', 'xar']);

function fail(code, message, details = {}) {
  throw new ExistingFileError(code, message, details);
}

function requireValue(value, code, message, details = {}) {
  if (!value) fail(code, message, details);
}

function containedBy(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function samePath(left, right) {
  return path.relative(path.resolve(left), path.resolve(right)) === '';
}

function rootIdentity(stats) {
  return { dev: String(stats.dev), ino: String(stats.ino) };
}

function validIdentity(identity) {
  return identity && typeof identity.dev === 'string' && /^\d+$/.test(identity.dev)
    && typeof identity.ino === 'string' && /^\d+$/.test(identity.ino);
}

function sameIdentity(left, right) {
  return validIdentity(left) && validIdentity(right)
    && left.dev === right.dev && left.ino === right.ino;
}

function cancelled(signal) {
  if (signal?.aborted) fail('CANCELLED', '작업을 취소했어요.');
}

async function checkpoint(control, signal) {
  cancelled(signal);
  if (typeof control?.checkpoint === 'function') await control.checkpoint();
  cancelled(signal);
}

function integerLimit(value, maximum, name) {
  requireValue(Number.isInteger(value) && value >= 1 && value <= maximum,
    'INVALID_LIMIT', `${name} 제한이 올바르지 않아요.`, { name, maximum });
  return value;
}

function officeLocations(home) {
  return [
    { app: 'Microsoft Office', name: 'UnsavedFiles', path: path.join(home, 'AppData', 'Local', 'Microsoft', 'Office', 'UnsavedFiles') },
    { app: 'Microsoft Word', name: '자동 복구 폴더', path: path.join(home, 'AppData', 'Roaming', 'Microsoft', 'Word') },
    { app: 'Microsoft Excel', name: '자동 복구 폴더', path: path.join(home, 'AppData', 'Roaming', 'Microsoft', 'Excel') },
    { app: 'Microsoft PowerPoint', name: '자동 복구 폴더', path: path.join(home, 'AppData', 'Roaming', 'Microsoft', 'PowerPoint') }
  ];
}

export async function discoverAutosaveLocations(home = os.homedir()) {
  requireValue(typeof home === 'string' && home.trim(), 'INVALID_HOME', '사용자 폴더 경로가 필요해요.');
  const resolvedHome = path.resolve(home);
  return Promise.all(officeLocations(resolvedHome).map(async location => {
    try {
      const info = await lstat(location.path, { bigint: true });
      if (!info.isDirectory() || info.isSymbolicLink()) {
        return { ...location, exists: false, status: 'error', error: { code: 'UNSUPPORTED_ROOT', message: '일반 폴더가 아니어서 확인하지 않았어요.' } };
      }
      await access(location.path, fsConstants.R_OK);
      return { ...location, exists: true, status: 'existing', error: null };
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
        return { ...location, exists: false, status: 'missing', error: null };
      }
      return { ...location, exists: false, status: 'error', error: { code: error?.code ?? 'AUTOSAVE_ROOT_UNAVAILABLE', message: '자동 저장 폴더를 읽을 수 없어요.' } };
    }
  }));
}

async function prepareOne(location) {
  requireValue(location && typeof location === 'object' && typeof location.path === 'string' && location.path.trim(),
    'INVALID_ROOT', '자동 저장 검색 위치가 올바르지 않아요.');
  const selected = path.resolve(location.path);
  let info;
  try { info = await lstat(selected, { bigint: true }); }
  catch (error) { fail('ROOT_UNAVAILABLE', '자동 저장 폴더를 다시 확인할 수 없어요.', { path: selected, cause: error?.code }); }
  requireValue(info.isDirectory() && !info.isSymbolicLink(), 'UNSUPPORTED_ROOT', '연결 지점이 아닌 일반 폴더만 검색할 수 있어요.', { path: selected });
  let canonical;
  try { canonical = await realpath(selected); }
  catch (error) { fail('ROOT_UNAVAILABLE', '자동 저장 폴더의 실제 위치를 확인할 수 없어요.', { path: selected, cause: error?.code }); }
  return {
    path: canonical,
    app: String(location.app ?? 'Microsoft Office'),
    name: String(location.name ?? path.basename(canonical)),
    identity: rootIdentity(info)
  };
}

export async function prepareAutosaveRoots(locations) {
  requireValue(Array.isArray(locations) && locations.length <= MAX_ROOTS, 'INVALID_ROOT', `자동 저장 검색 위치는 최대 ${MAX_ROOTS}개까지 사용할 수 있어요.`);
  const roots = [];
  const paths = new Set();
  const identities = new Set();
  for (const location of locations) {
    if (location?.status === 'missing' || location?.status === 'error' || location?.exists === false) continue;
    const root = await prepareOne(location);
    requireValue(validIdentity(root.identity), 'INVALID_ROOT', '자동 저장 폴더 식별 정보가 올바르지 않아요.', { path: root.path });
    const pathKey = process.platform === 'win32' ? root.path.toLocaleLowerCase('und') : root.path;
    const identityKey = `${root.identity.dev}:${root.identity.ino}`;
    if (paths.has(pathKey) || identities.has(identityKey)) continue;
    paths.add(pathKey);
    identities.add(identityKey);
    roots.push(root);
  }
  return roots;
}

async function validateOneRoot(root) {
  requireValue(root && typeof root === 'object' && typeof root.path === 'string' && root.path.trim() && validIdentity(root.identity),
    'INVALID_ROOT', '자동 저장 검색 위치의 식별 정보가 올바르지 않아요.');
  const selected = path.resolve(root.path);
  try {
    const info = await lstat(selected, { bigint: true });
    requireValue(info.isDirectory() && !info.isSymbolicLink(), 'SOURCE_CHANGED', '자동 저장 폴더가 바뀌었어요. 다시 검색해주세요.', { path: selected });
    const canonical = await realpath(selected);
    requireValue(samePath(selected, canonical) && sameIdentity(root.identity, rootIdentity(info)),
      'SOURCE_CHANGED', '자동 저장 폴더가 바뀌었어요. 다시 검색해주세요.', { path: selected });
    return { ...root, path: canonical, identity: { ...root.identity } };
  } catch (error) {
    if (error instanceof ExistingFileError) throw error;
    fail('SOURCE_CHANGED', '자동 저장 폴더를 다시 확인할 수 없어요. 다시 검색해주세요.', { path: selected, cause: error?.code });
  }
}

export async function validateAutosaveRoots(roots) {
  requireValue(Array.isArray(roots) && roots.length <= MAX_ROOTS, 'INVALID_ROOT', `자동 저장 검색 위치는 최대 ${MAX_ROOTS}개까지 사용할 수 있어요.`);
  const validated = [];
  const seen = new Set();
  for (const root of roots) {
    const current = await validateOneRoot(root);
    const key = `${current.identity.dev}:${current.identity.ino}`;
    if (!seen.has(key)) { seen.add(key); validated.push(current); }
  }
  return validated;
}

function eligibleName(name) {
  if (!name || /^~\$/u.test(name)) return false;
  const extension = path.extname(name).slice(1).toLocaleLowerCase('und');
  return extension === '' || DOCUMENT_EXTENSIONS.has(extension) || AUTOSAVE_EXTENSIONS.has(extension);
}

function autosaveMetadata(root) {
  return {
    app: root.app,
    name: root.name,
    rootPath: root.path,
    rootIdentity: { ...root.identity },
    relationship: 'unknown',
    source: 'office-default-location'
  };
}

export async function assertAutosaveCandidate(candidate) {
  requireValue(candidate && typeof candidate === 'object' && candidate.source === 'existing-file' && candidate.status === 'existing',
    'INVALID_CANDIDATE', '현재 남아 있는 자동 저장 파일 후보만 처리할 수 있어요.');
  requireValue(typeof candidate.path === 'string' && typeof candidate.rootPath === 'string'
    && candidate.autosave && typeof candidate.autosave === 'object', 'INVALID_CANDIDATE', '자동 저장 파일 후보 정보가 올바르지 않아요.');
  const provenance = candidate.autosave;
  requireValue(provenance.relationship === 'unknown' && provenance.source === 'office-default-location'
    && typeof provenance.rootPath === 'string' && samePath(candidate.rootPath, provenance.rootPath)
    && validIdentity(provenance.rootIdentity), 'INVALID_CANDIDATE', '자동 저장 파일 후보의 출처 정보가 올바르지 않아요.');
  const root = await validateOneRoot({ path: provenance.rootPath, app: provenance.app, name: provenance.name, identity: provenance.rootIdentity });
  const filePath = path.resolve(candidate.path);
  requireValue(containedBy(root.path, filePath) && !samePath(root.path, filePath),
    'PATH_OUTSIDE_ROOT', '자동 저장 파일이 확인된 검색 폴더 밖에 있어요.', { path: filePath, rootPath: root.path });
  let fileInfo;
  let canonicalFile;
  try {
    fileInfo = await lstat(filePath, { bigint: true });
    requireValue(fileInfo.isFile() && !fileInfo.isSymbolicLink(), 'SOURCE_CHANGED',
      '자동 저장 파일이 검색 후 바뀌었어요. 다시 검색해주세요.', { path: filePath });
    canonicalFile = await realpath(filePath);
  } catch (error) {
    if (error instanceof ExistingFileError) throw error;
    fail('SOURCE_CHANGED', '자동 저장 파일을 다시 확인할 수 없어요. 다시 검색해주세요.', { path: filePath, cause: error?.code });
  }
  requireValue(samePath(filePath, canonicalFile) && containedBy(root.path, canonicalFile), 'SOURCE_CHANGED',
    '자동 저장 파일의 실제 위치가 검색한 폴더 밖으로 바뀌었어요. 다시 검색해주세요.',
    { path: filePath, canonicalPath: canonicalFile, rootPath: root.path });
  return candidate;
}

export async function searchAutosaveRoots(roots, {
  signal, control, onCandidate, onProgress, maxCandidates = 2000, maxFiles = 20000,
  maxDirectories = 2048, maxDurationMs = 10000, filters = {}
} = {}) {
  requireValue(Array.isArray(roots) && roots.length <= MAX_ROOTS, 'INVALID_ROOT', `자동 저장 검색 위치는 최대 ${MAX_ROOTS}개까지 사용할 수 있어요.`);
  const limits = {
    maxCandidates: integerLimit(maxCandidates, MAX_CANDIDATES, 'maxCandidates'),
    maxFiles: integerLimit(maxFiles, MAX_FILES, 'maxFiles'),
    maxDirectories: integerLimit(maxDirectories, MAX_DIRECTORIES, 'maxDirectories'),
    maxDurationMs: integerLimit(maxDurationMs, MAX_DURATION_MS, 'maxDurationMs')
  };
  const normalizedFilters = normalizeFilters(filters);
  cancelled(signal);
  const startedAtMs = Date.now();
  const candidates = [];
  const warnings = [];
  const seenCandidates = new Set();
  const stats = {
    rootsTotal: roots.length,
    rootsScanned: 0,
    directoriesVisited: 0,
    filesVisited: 0,
    candidatesFound: 0,
    symlinksSkipped: 0,
    ineligibleFilesSkipped: 0,
    warningCount: 0,
    startedAt: new Date(startedAtMs).toISOString(),
    finishedAt: null,
    durationMs: null
  };
  const coverageRoots = roots.map(root => ({
    path: root?.path ?? null, app: root?.app ?? null, name: root?.name ?? null,
    status: 'pending', directoriesVisited: 0, filesVisited: 0, candidatesFound: 0, warningCount: 0
  }));
  let truncated = false;
  let stopReason = null;
  let scanFailures = 0;
  let operations = 0;
  let activeRoot = null;

  function warning(code, itemPath, message, error, rootCoverage, incomplete = false) {
    stats.warningCount++;
    if (rootCoverage) rootCoverage.warningCount++;
    if (incomplete) scanFailures++;
    if (warnings.length < MAX_WARNINGS) warnings.push({ code, path: itemPath, message, cause: error?.code ?? null });
  }

  function limitReached(rootCoverage) {
    let reason = null;
    if (candidates.length >= limits.maxCandidates) reason = 'candidate-limit';
    else if (stats.filesVisited >= limits.maxFiles) reason = 'file-limit';
    else if (stats.directoriesVisited >= limits.maxDirectories) reason = 'directory-limit';
    else if (Date.now() - startedAtMs >= limits.maxDurationMs) reason = 'duration-limit';
    if (!reason) return false;
    truncated = true;
    stopReason = reason;
    const labels = {
      'candidate-limit': ['CANDIDATE_LIMIT', '자동 저장 파일 후보 수 제한에 도달했어요.'],
      'file-limit': ['FILE_LIMIT', '확인할 파일 수 제한에 도달했어요.'],
      'directory-limit': ['DIRECTORY_LIMIT', '확인할 폴더 수 제한에 도달했어요.'],
      'duration-limit': ['DURATION_LIMIT', '자동 저장 검색 시간 제한에 도달했어요.']
    };
    warning(labels[reason][0], rootCoverage?.path ?? null, labels[reason][1], null, rootCoverage, false);
    return true;
  }

  rootLoop: for (let rootIndex = 0; rootIndex < roots.length; rootIndex++) {
    const rootCoverage = coverageRoots[rootIndex];
    await checkpoint(control, signal);
    if (limitReached(rootCoverage)) break;
    const root = await validateOneRoot(roots[rootIndex]);
    activeRoot = root;
    rootCoverage.path = root.path;
    rootCoverage.status = 'scanning';
    const failuresBeforeRoot = scanFailures;
    const directories = [root.path];
    while (directories.length) {
      await checkpoint(control, signal);
      if (limitReached(rootCoverage)) break rootLoop;
      const directoryPath = directories.pop();
      stats.directoriesVisited++;
      rootCoverage.directoriesVisited++;
      try {
        const queuedInfo = await lstat(directoryPath, { bigint: true });
        if (!queuedInfo.isDirectory() || queuedInfo.isSymbolicLink()) {
          if (queuedInfo.isSymbolicLink()) stats.symlinksSkipped++;
          warning('LINK_SKIPPED', directoryPath, '대기 중 바뀐 연결 지점은 자동 저장 검색에서 제외했어요.', null, rootCoverage, true);
          continue;
        }
        const canonicalDirectory = await realpath(directoryPath);
        if (!samePath(directoryPath, canonicalDirectory) || !containedBy(root.path, canonicalDirectory)) {
          stats.symlinksSkipped++;
          warning('LINK_SKIPPED', directoryPath, '대기 중 검색 범위 밖으로 바뀐 폴더를 제외했어요.', null, rootCoverage, true);
          continue;
        }
      } catch (error) {
        warning(error?.code === 'EACCES' || error?.code === 'EPERM' ? 'DIRECTORY_PERMISSION_DENIED' : 'DIRECTORY_READ_FAILED',
          directoryPath, '대기 중인 자동 저장 폴더를 다시 확인하지 못해 건너뛰었어요.', error, rootCoverage, true);
        continue;
      }
      let directory;
      try { directory = await opendir(directoryPath); }
      catch (error) {
        warning(error?.code === 'EACCES' || error?.code === 'EPERM' ? 'DIRECTORY_PERMISSION_DENIED' : 'DIRECTORY_READ_FAILED',
          directoryPath, '자동 저장 폴더 일부를 읽지 못해 건너뛰었어요.', error, rootCoverage, true);
        continue;
      }
      try {
        for await (const entry of directory) {
          await checkpoint(control, signal);
          if (limitReached(rootCoverage)) break rootLoop;
          const entryPath = path.resolve(directoryPath, entry.name);
          if (!containedBy(root.path, entryPath)) {
            warning('ESCAPES_ROOT', entryPath, '자동 저장 검색 범위 밖의 항목을 건너뛰었어요.', null, rootCoverage, true);
            continue;
          }
          let info;
          try { info = await lstat(entryPath, { bigint: true }); }
          catch (error) {
            warning(error?.code === 'EACCES' || error?.code === 'EPERM' ? 'ENTRY_PERMISSION_DENIED' : 'ENTRY_READ_FAILED',
              entryPath, '자동 저장 항목 정보를 읽지 못해 건너뛰었어요.', error, rootCoverage, true);
            continue;
          }
          if (info.isSymbolicLink()) {
            stats.symlinksSkipped++;
            warning('LINK_SKIPPED', entryPath, '연결 지점은 자동 저장 검색에서 제외했어요.', null, rootCoverage, false);
            continue;
          }
          if (info.isDirectory()) {
            let canonicalDirectory;
            try { canonicalDirectory = await realpath(entryPath); }
            catch (error) {
              warning('DIRECTORY_READ_FAILED', entryPath, '폴더의 실제 위치를 확인하지 못해 건너뛰었어요.', error, rootCoverage, true);
              continue;
            }
            if (!containedBy(root.path, canonicalDirectory) || !samePath(entryPath, canonicalDirectory)) {
              stats.symlinksSkipped++;
              warning('LINK_SKIPPED', entryPath, '검색 범위 밖으로 이어지는 연결 지점을 제외했어요.', null, rootCoverage, false);
              continue;
            }
            directories.push(canonicalDirectory);
          } else if (info.isFile()) {
            stats.filesVisited++;
            rootCoverage.filesVisited++;
            if (!eligibleName(entry.name)) {
              stats.ineligibleFilesSkipped++;
            } else {
              try {
                const candidate = await existingCandidate(entryPath, root.path);
                if (!samePath(entryPath, candidate.path) || !containedBy(root.path, candidate.path)) {
                  warning(containedBy(root.path, candidate.path) ? 'LINK_SKIPPED' : 'ESCAPES_ROOT', entryPath,
                    '실제 파일 위치가 확인한 자동 저장 경로와 달라 제외했어요.', null, rootCoverage, true);
                } else if (!seenCandidates.has(candidate.id)) {
                  candidate.kind = 'document';
                  candidate.autosave = autosaveMetadata(root);
                  if (matchesCandidate(candidate, normalizedFilters)) {
                    seenCandidates.add(candidate.id);
                    candidates.push(candidate);
                    stats.candidatesFound = candidates.length;
                    rootCoverage.candidatesFound++;
                    if (typeof onCandidate === 'function') onCandidate({ ...candidate, identity: { ...candidate.identity }, autosave: { ...candidate.autosave, rootIdentity: { ...candidate.autosave.rootIdentity } } });
                  }
                }
              } catch (error) {
                if (error?.code === 'CANCELLED') throw error;
                warning(error?.code ?? 'ENTRY_READ_FAILED', entryPath, '자동 저장 파일을 안전하게 확인하지 못해 제외했어요.', error, rootCoverage, true);
              }
            }
          }
          operations++;
          if (operations % 32 === 0) {
            if (typeof onProgress === 'function') onProgress({ phase: 'autosave', ...stats, currentPath: directoryPath, rootPath: root.path });
            await new Promise(resolve => setImmediate(resolve));
          }
        }
      } catch (error) {
        if (error?.code === 'CANCELLED') throw error;
        warning(error?.code === 'EACCES' || error?.code === 'EPERM' ? 'DIRECTORY_PERMISSION_DENIED' : 'DIRECTORY_READ_FAILED',
          directoryPath, '자동 저장 폴더를 끝까지 읽지 못했어요.', error, rootCoverage, true);
      }
    }
    await validateOneRoot(root);
    activeRoot = null;
    rootCoverage.status = scanFailures > failuresBeforeRoot ? 'partial' : 'scanned';
    stats.rootsScanned++;
  }

  if (activeRoot) await validateOneRoot(activeRoot);
  cancelled(signal);
  const finishedAtMs = Date.now();
  stats.finishedAt = new Date(finishedAtMs).toISOString();
  stats.durationMs = finishedAtMs - startedAtMs;
  for (const item of coverageRoots) {
    if (item.status === 'scanning') item.status = truncated ? 'truncated' : 'partial';
    else if (item.status === 'pending') item.status = truncated ? 'not-scanned' : 'partial';
  }
  const complete = !truncated && scanFailures === 0 && stats.rootsScanned === roots.length;
  const coverage = {
    kind: 'autosave',
    roots: coverageRoots,
    rootsTotal: stats.rootsTotal,
    rootsScanned: stats.rootsScanned,
    directoriesVisited: stats.directoriesVisited,
    filesVisited: stats.filesVisited,
    candidatesFound: stats.candidatesFound,
    limits,
    stopReason,
    complete,
    truncated
  };
  if (typeof onProgress === 'function') onProgress({ phase: 'complete', ...stats, complete, truncated, stopReason });
  return { candidates, warnings, stats, complete, truncated, coverage };
}
