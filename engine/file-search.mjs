import { access, lstat, mkdir, mkdtemp, open, opendir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { classifyFileKind, matchesCandidate, normalizeFilters, rankName } from './candidate-filter.mjs';
import { shortenOutputName } from './recovery-name.mjs';

const MAX_CANDIDATES = 10_000;
const MAX_WARNINGS = 100;
const MAX_DIRECTORIES = 100_000;
const MAX_IO_CHUNK = 1024 * 1024;
const MAX_INDEX_BYTES = 16 * 1024 * 1024;

export class ExistingFileError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ExistingFileError';
    this.code = code;
    this.details = details;
  }
}

function requireValue(value, code, message, details = {}) {
  if (!value) throw new ExistingFileError(code, message, details);
}

function cancelled(signal) {
  if (signal?.aborted) throw new ExistingFileError('CANCELLED', '작업을 취소했어요.');
}

async function checkpoint(control, signal) {
  cancelled(signal);
  if (typeof control?.checkpoint === 'function') await control.checkpoint();
  cancelled(signal);
}

function containedBy(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function permissionsError(error) {
  return error?.code === 'EACCES' || error?.code === 'EPERM';
}

function isoDate(milliseconds) {
  const value = Number(milliseconds);
  return Number.isFinite(value) && Math.abs(value) <= 8.64e15 ? new Date(value).toISOString() : null;
}

function bigintString(value, fallback = 0) {
  if (typeof value === 'bigint') return value.toString();
  if (Number.isFinite(Number(value))) return String(Math.trunc(Number(value)));
  return String(fallback);
}

function nanoseconds(stats, nsKey, msKey) {
  if (typeof stats[nsKey] === 'bigint') return stats[nsKey].toString();
  return bigintString(Math.trunc(Number(stats[msKey] ?? 0) * 1_000_000));
}

function identityFromStats(stats) {
  return {
    device: bigintString(stats.dev),
    inode: bigintString(stats.ino),
    mode: bigintString(stats.mode),
    size: Number(stats.size),
    modifiedAtNs: nanoseconds(stats, 'mtimeNs', 'mtimeMs'),
    changedAtNs: nanoseconds(stats, 'ctimeNs', 'ctimeMs')
  };
}

function sameIdentity(left, right) {
  return Boolean(left && right
    && String(left.device) === String(right.device)
    && String(left.inode) === String(right.inode)
    && String(left.mode) === String(right.mode)
    && Number(left.size) === Number(right.size)
    && String(left.modifiedAtNs) === String(right.modifiedAtNs)
    && String(left.changedAtNs) === String(right.changedAtNs));
}

function candidateId(filePath) {
  return `existing:${createHash('sha256').update(filePath.normalize('NFC')).digest('hex').slice(0, 24)}`;
}

function candidateFromStats(filePath, rootPath, stats, filters = null) {
  const name = path.basename(filePath);
  const ranked = filters?.name ? rankName(filters.name, name) : { score: 0, reasons: [] };
  return {
    id: candidateId(filePath),
    source: 'existing-file',
    path: filePath,
    rootPath,
    name,
    size: Number(stats.size),
    modifiedAt: isoDate(stats.mtimeMs),
    deletedAt: null,
    status: 'existing',
    kind: classifyFileKind(name),
    score: ranked.score,
    reasons: [...ranked.reasons],
    identity: identityFromStats(stats)
  };
}

function checkedLimit(value, label = 'maxCandidates') {
  requireValue(Number.isInteger(value) && value >= 1 && value <= MAX_CANDIDATES,
    'INVALID_LIMIT', `${label}는 1에서 ${MAX_CANDIDATES} 사이의 정수여야 해요.`);
  return value;
}

function emit(callback, value) {
  if (typeof callback === 'function') callback(value);
}

export async function searchExistingFiles(rootPath, {
  filters = {}, signal, onProgress, onCandidate, maxCandidates = MAX_CANDIDATES, control
} = {}) {
  cancelled(signal);
  const limit = checkedLimit(maxCandidates);
  const normalizedFilters = normalizeFilters(filters);
  requireValue(typeof rootPath === 'string' && rootPath.trim(), 'INVALID_ROOT', '검색할 폴더 경로가 필요해요.');
  const selectedRoot = path.resolve(rootPath);
  let selectedStats;
  try { selectedStats = await lstat(selectedRoot, { bigint: true }); }
  catch (error) { throw new ExistingFileError('ROOT_UNAVAILABLE', '선택한 검색 폴더를 읽을 수 없어요.', { path: selectedRoot, cause: error?.code }); }
  requireValue(!selectedStats.isSymbolicLink(), 'UNSUPPORTED_ROOT', '링크나 연결 지점 자체를 검색 위치로 사용할 수 없어요.', { path: selectedRoot });
  requireValue(selectedStats.isDirectory(), 'INVALID_ROOT', '검색 위치는 폴더여야 해요.', { path: selectedRoot });
  const canonicalRoot = await realpath(selectedRoot);

  const startedAtMs = Date.now();
  const candidates = [];
  const warnings = [];
  const directories = [canonicalRoot];
  const statsResult = {
    directoriesVisited: 0,
    filesVisited: 0,
    candidatesMatched: 0,
    symlinksSkipped: 0,
    permissionErrors: 0,
    readErrors: 0,
    warningCount: 0,
    startedAt: new Date(startedAtMs).toISOString(),
    finishedAt: null,
    durationMs: null
  };
  let truncated = false;
  let operations = 0;

  function warning(code, filePath, message, error) {
    statsResult.warningCount++;
    if (permissionsError(error)) statsResult.permissionErrors++;
    else if (error) statsResult.readErrors++;
    if (warnings.length < MAX_WARNINGS) warnings.push({ code, path: filePath, message, cause: error?.code ?? null });
  }

  search: while (directories.length) {
    await checkpoint(control, signal);
    if (statsResult.directoriesVisited >= MAX_DIRECTORIES) {
      truncated = true;
      warning('DIRECTORY_LIMIT', canonicalRoot, '안전한 폴더 수 제한에 도달해 검색을 멈췄어요.');
      break;
    }
    const directoryPath = directories.pop();
    statsResult.directoriesVisited++;
    let directory;
    try { directory = await opendir(directoryPath); }
    catch (error) {
      warning(permissionsError(error) ? 'DIRECTORY_PERMISSION_DENIED' : 'DIRECTORY_READ_FAILED', directoryPath,
        permissionsError(error) ? '폴더 접근 권한이 없어 건너뛰었어요.' : '폴더를 읽지 못해 건너뛰었어요.', error);
      continue;
    }

    try {
      for await (const entry of directory) {
        cancelled(signal);
        const entryPath = path.resolve(directoryPath, entry.name);
        if (!containedBy(canonicalRoot, entryPath)) {
          warning('ESCAPES_ROOT', entryPath, '선택한 검색 범위 밖의 항목을 건너뛰었어요.');
          continue;
        }
        let entryStats;
        try { entryStats = await lstat(entryPath, { bigint: true }); }
        catch (error) {
          warning(permissionsError(error) ? 'ENTRY_PERMISSION_DENIED' : 'ENTRY_READ_FAILED', entryPath,
            permissionsError(error) ? '항목 접근 권한이 없어 건너뛰었어요.' : '항목 정보를 읽지 못해 건너뛰었어요.', error);
          continue;
        }
        if (entryStats.isSymbolicLink()) {
          statsResult.symlinksSkipped++;
          continue;
        }
        if (entryStats.isDirectory()) {
          let canonicalDirectory;
          try { canonicalDirectory = await realpath(entryPath); }
          catch (error) {
            warning(permissionsError(error) ? 'ENTRY_PERMISSION_DENIED' : 'ENTRY_READ_FAILED', entryPath,
              '폴더의 실제 위치를 확인할 수 없어 건너뛰었어요.', error);
            continue;
          }
          if (!containedBy(canonicalRoot, canonicalDirectory)) {
            warning('ESCAPES_ROOT', entryPath, '선택한 검색 범위 밖으로 이어지는 폴더를 건너뛰었어요.');
            continue;
          }
          directories.push(canonicalDirectory);
        } else if (entryStats.isFile()) {
          statsResult.filesVisited++;
          let canonicalFile;
          try { canonicalFile = await realpath(entryPath); }
          catch (error) {
            warning(permissionsError(error) ? 'ENTRY_PERMISSION_DENIED' : 'ENTRY_READ_FAILED', entryPath,
              '파일의 실제 위치를 확인할 수 없어 건너뛰었어요.', error);
            continue;
          }
          if (!containedBy(canonicalRoot, canonicalFile)) {
            warning('ESCAPES_ROOT', entryPath, '선택한 검색 범위 밖으로 이어지는 파일을 건너뛰었어요.');
            continue;
          }
          const candidate = candidateFromStats(canonicalFile, canonicalRoot, entryStats, normalizedFilters);
          if (matchesCandidate(candidate, normalizedFilters)) {
            candidates.push(candidate);
            statsResult.candidatesMatched++;
            emit(onCandidate, { ...candidate, reasons: [...candidate.reasons], identity: { ...candidate.identity } });
            if (candidates.length >= limit) {
              truncated = true;
              break search;
            }
          }
        }
        operations++;
        if (operations % 64 === 0) {
          emit(onProgress, {
            phase: 'search',
            directoriesVisited: statsResult.directoriesVisited,
            filesVisited: statsResult.filesVisited,
            candidatesFound: candidates.length,
            currentPath: directoryPath
          });
          await checkpoint(control, signal);
          await new Promise(resolve => setImmediate(resolve));
        }
      }
    } catch (error) {
      if (error?.code === 'CANCELLED') throw error;
      warning(permissionsError(error) ? 'DIRECTORY_PERMISSION_DENIED' : 'DIRECTORY_READ_FAILED', directoryPath,
        permissionsError(error) ? '폴더를 끝까지 읽을 권한이 없어요.' : '폴더를 끝까지 읽지 못했어요.', error);
    }
  }

  cancelled(signal);
  const finishedAtMs = Date.now();
  statsResult.finishedAt = new Date(finishedAtMs).toISOString();
  statsResult.durationMs = finishedAtMs - startedAtMs;
  emit(onProgress, {
    phase: 'complete',
    directoriesVisited: statsResult.directoriesVisited,
    filesVisited: statsResult.filesVisited,
    candidatesFound: candidates.length,
    complete: !truncated && statsResult.permissionErrors === 0 && statsResult.readErrors === 0
  });
  return {
    candidates,
    warnings,
    stats: statsResult,
    complete: !truncated && statsResult.permissionErrors === 0 && statsResult.readErrors === 0,
    truncated
  };
}

async function validateExistingCandidate(candidate, { requireStoredIdentity = true } = {}) {
  requireValue(candidate && typeof candidate === 'object', 'INVALID_CANDIDATE', '파일 후보 정보가 필요해요.');
  requireValue(candidate.source === 'existing-file' && candidate.status === 'existing', 'INVALID_CANDIDATE', '현재 남아 있는 파일 후보만 처리할 수 있어요.');
  requireValue(typeof candidate.path === 'string' && typeof candidate.rootPath === 'string', 'INVALID_CANDIDATE', '파일 후보 경로가 올바르지 않아요.');
  const rootPath = path.resolve(candidate.rootPath);
  const filePath = path.resolve(candidate.path);
  requireValue(containedBy(rootPath, filePath), 'PATH_OUTSIDE_ROOT', '파일이 선택한 검색 범위 밖에 있어요.', { path: filePath, rootPath });
  let rootStats;
  let fileStats;
  try {
    [rootStats, fileStats] = await Promise.all([lstat(rootPath, { bigint: true }), lstat(filePath, { bigint: true })]);
  } catch (error) {
    throw new ExistingFileError('SOURCE_UNAVAILABLE', '선택한 파일을 다시 확인할 수 없어요.', { path: filePath, cause: error?.code });
  }
  requireValue(rootStats.isDirectory() && !rootStats.isSymbolicLink(), 'INVALID_ROOT', '검색 위치를 다시 확인할 수 없어요.', { rootPath });
  requireValue(fileStats.isFile() && !fileStats.isSymbolicLink(), 'UNSUPPORTED_SOURCE', '일반 파일만 읽을 수 있어요.', { path: filePath });
  const [canonicalRoot, canonicalFile] = await Promise.all([realpath(rootPath), realpath(filePath)]);
  requireValue(containedBy(canonicalRoot, canonicalFile), 'PATH_OUTSIDE_ROOT', '파일의 실제 위치가 선택한 검색 범위 밖이에요.', { path: canonicalFile, rootPath: canonicalRoot });
  const identity = identityFromStats(fileStats);
  if (requireStoredIdentity) {
    requireValue(candidate.identity && sameIdentity(candidate.identity, identity), 'SOURCE_CHANGED', '검색한 뒤 파일이 변경됐어요. 다시 검색해주세요.', { path: canonicalFile });
  }
  return { rootPath: canonicalRoot, filePath: canonicalFile, stats: fileStats, identity };
}

async function hashOne(candidate, { signal, onProgress, progress, control }) {
  cancelled(signal);
  const validated = await validateExistingCandidate(candidate);
  const handle = await open(validated.filePath, 'r');
  const hash = createHash('sha256');
  let position = 0;
  try {
    const openedIdentity = identityFromStats(await handle.stat({ bigint: true }));
    requireValue(sameIdentity(validated.identity, openedIdentity), 'SOURCE_CHANGED', '읽기 직전에 파일이 변경됐어요.', { path: validated.filePath });
    const buffer = Buffer.allocUnsafe(Math.min(MAX_IO_CHUNK, Math.max(1, Number(validated.stats.size))));
    while (position < Number(validated.stats.size)) {
      await checkpoint(control, signal);
      const length = Math.min(buffer.length, Number(validated.stats.size) - position);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      requireValue(bytesRead > 0, 'SOURCE_CHANGED', '파일 크기가 읽는 중에 달라졌어요.', { path: validated.filePath });
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
      progress.bytesHashed += bytesRead;
      emit(onProgress, { phase: 'hash', currentPath: validated.filePath, fileBytesHashed: position,
        fileBytesTotal: Number(validated.stats.size), bytesHashed: progress.bytesHashed, bytesTotal: progress.bytesTotal });
      await new Promise(resolve => setImmediate(resolve));
    }
    const afterHandleIdentity = identityFromStats(await handle.stat({ bigint: true }));
    requireValue(sameIdentity(validated.identity, afterHandleIdentity), 'SOURCE_CHANGED', '파일이 읽는 중에 변경됐어요.', { path: validated.filePath });
  } finally {
    await handle.close();
  }
  const afterPathStats = await lstat(validated.filePath, { bigint: true });
  requireValue(afterPathStats.isFile() && !afterPathStats.isSymbolicLink()
    && sameIdentity(validated.identity, identityFromStats(afterPathStats)), 'SOURCE_CHANGED', '파일이 읽는 중에 교체되거나 변경됐어요.', { path: validated.filePath });
  return hash.digest('hex');
}

export async function hashDuplicates(candidates, { signal, onProgress, control } = {}) {
  requireValue(Array.isArray(candidates), 'INVALID_CANDIDATES', '파일 후보 목록이 필요해요.');
  requireValue(candidates.length <= MAX_CANDIDATES, 'INVALID_LIMIT', `한 번에 최대 ${MAX_CANDIDATES}개 후보를 비교할 수 있어요.`);
  cancelled(signal);
  const warnings = [];
  const results = [];
  const progress = { bytesHashed: 0, bytesTotal: candidates.reduce((sum, candidate) => sum + Math.max(0, Number(candidate?.size) || 0), 0) };
  for (const candidate of candidates) {
    cancelled(signal);
    try {
      const hash = await hashOne(candidate, { signal, onProgress, progress, control });
      results.push({ candidate: { ...candidate, reasons: [...(candidate.reasons ?? [])], identity: { ...candidate.identity } }, hash });
    } catch (error) {
      if (error?.code === 'CANCELLED') throw error;
      warnings.push({ code: error?.code ?? 'HASH_FAILED', path: candidate?.path ?? null, message: error?.message ?? '파일을 비교하지 못했어요.' });
    }
  }
  const byHash = new Map();
  for (const result of results) {
    if (!byHash.has(result.hash)) byHash.set(result.hash, []);
    byHash.get(result.hash).push(result.candidate);
  }
  const groups = [...byHash.entries()]
    .filter(([, members]) => members.length > 1)
    .map(([hash, members]) => ({ algorithm: 'sha256', hash, size: members[0].size, candidates: members }));
  return {
    groups,
    results,
    warnings,
    stats: { selected: candidates.length, hashed: results.length, failed: warnings.length, bytesHashed: progress.bytesHashed },
    complete: warnings.length === 0
  };
}

function safeOutputName(value) {
  let name = path.basename(String(value ?? '')).normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/^\.+/g, '')
    .replace(/[. ]+$/g, '');
  name = shortenOutputName(name);
  if (!name || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `recovered-${name || 'file'}`;
  return name;
}

export async function existingCandidate(filePath, rootPath = path.dirname(filePath)) {
  const canonical = await realpath(filePath);
  const info = await lstat(canonical, { bigint: true });
  requireValue(info.isFile() && !info.isSymbolicLink(), 'UNSUPPORTED_SOURCE', '일반 파일만 사용할 수 있어요.');
  return candidateFromStats(canonical, await realpath(rootPath), info);
}

export async function copyExistingCandidate(candidate, destination, { signal, onProgress, control } = {}) {
  cancelled(signal);
  requireValue(typeof destination === 'string' && destination.trim(), 'INVALID_DESTINATION', '복사본을 저장할 폴더가 필요해요.');
  const validated = await validateExistingCandidate(candidate);
  const destinationRoot = path.resolve(destination);
  await mkdir(destinationRoot, { recursive: true });
  const destinationStats = await lstat(destinationRoot, { bigint: true });
  requireValue(destinationStats.isDirectory() && !destinationStats.isSymbolicLink(), 'INVALID_DESTINATION', '저장 위치는 일반 폴더여야 해요.');
  const canonicalDestination = await realpath(destinationRoot);
  const privateDirectory = await mkdtemp(path.join(canonicalDestination, '.recoverychat-writing-'));
  requireValue(containedBy(canonicalDestination, privateDirectory), 'INVALID_DESTINATION', '안전한 저장 폴더를 만들지 못했어요.');
  let currentDirectory = privateDirectory;
  let partialPath = path.join(currentDirectory, '.recovery-writing.partial');
  let savedPath = null;
  let sourceHandle;
  let outputHandle;
  let bytesWritten = 0;
  const hash = createHash('sha256');
  try {
    sourceHandle = await open(validated.filePath, 'r');
    const openedIdentity = identityFromStats(await sourceHandle.stat({ bigint: true }));
    requireValue(sameIdentity(validated.identity, openedIdentity), 'SOURCE_CHANGED', '복사 직전에 파일이 변경됐어요.', { path: validated.filePath });
    outputHandle = await open(partialPath, 'wx', 0o600);
    const buffer = Buffer.allocUnsafe(Math.min(MAX_IO_CHUNK, Math.max(1, Number(validated.stats.size))));
    while (bytesWritten < Number(validated.stats.size)) {
      await checkpoint(control, signal);
      const length = Math.min(buffer.length, Number(validated.stats.size) - bytesWritten);
      const { bytesRead } = await sourceHandle.read(buffer, 0, length, bytesWritten);
      requireValue(bytesRead > 0, 'SOURCE_CHANGED', '파일 크기가 복사 중에 달라졌어요.', { path: validated.filePath });
      let offset = 0;
      while (offset < bytesRead) {
        cancelled(signal);
        const result = await outputHandle.write(buffer, offset, bytesRead - offset, bytesWritten + offset);
        requireValue(result.bytesWritten > 0, 'WRITE_FAILED', '복사본을 저장하지 못했어요.');
        offset += result.bytesWritten;
      }
      hash.update(buffer.subarray(0, bytesRead));
      bytesWritten += bytesRead;
      emit(onProgress, { phase: 'copy', sourcePath: validated.filePath, partialPath, bytesWritten, bytesTotal: Number(validated.stats.size) });
      await new Promise(resolve => setImmediate(resolve));
    }
    await outputHandle.sync();
    const afterHandleIdentity = identityFromStats(await sourceHandle.stat({ bigint: true }));
    requireValue(sameIdentity(validated.identity, afterHandleIdentity), 'SOURCE_CHANGED', '파일이 복사 중에 변경됐어요.', { path: validated.filePath });
    await outputHandle.close();
    outputHandle = null;
    await sourceHandle.close();
    sourceHandle = null;
    const afterPathStats = await lstat(validated.filePath, { bigint: true });
    requireValue(afterPathStats.isFile() && !afterPathStats.isSymbolicLink()
      && sameIdentity(validated.identity, identityFromStats(afterPathStats)), 'SOURCE_CHANGED', '파일이 복사 중에 교체되거나 변경됐어요.', { path: validated.filePath });
    await checkpoint(control, signal);
    let publishedDirectory;
    for (let attempt = 0; attempt < 3; attempt++) {
      const proposed = path.join(canonicalDestination, randomUUID());
      try {
        await rename(currentDirectory, proposed);
        publishedDirectory = proposed;
        break;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
      }
    }
    requireValue(publishedDirectory, 'COPY_FAILED', '완료 파일을 위한 새 폴더를 만들지 못했어요.');
    currentDirectory = publishedDirectory;
    partialPath = path.join(currentDirectory, '.recovery-writing.partial');
    savedPath = path.join(currentDirectory, safeOutputName(candidate.name));
    await rename(partialPath, savedPath);
    const sha256 = hash.digest('hex');
    emit(onProgress, { phase: 'complete', sourcePath: validated.filePath, savedPath, bytesWritten, bytesTotal: Number(validated.stats.size) });
    return { path: savedPath, status: 'saved', size: bytesWritten, sha256 };
  } catch (error) {
    try { await outputHandle?.close(); } catch {}
    try { await sourceHandle?.close(); } catch {}
    const details = { ...(error?.details ?? {}), savedPath: null, partialPath, bytesWritten };
    if (error instanceof ExistingFileError) {
      error.details = details;
      throw error;
    }
    throw new ExistingFileError(error?.code === 'EEXIST' ? 'OUTPUT_EXISTS' : 'COPY_FAILED',
      error?.code === 'EEXIST' ? '같은 이름의 완료 파일이 이미 있어 덮어쓰지 않았어요.' : '파일 복사에 실패했어요.',
      { ...details, cause: error?.code });
  }
}

function validIndexCandidate(candidate) {
  return candidate && typeof candidate === 'object'
    && candidate.source === 'existing-file' && candidate.status === 'existing'
    && typeof candidate.path === 'string' && typeof candidate.rootPath === 'string'
    && typeof candidate.name === 'string' && Number.isFinite(Number(candidate.size))
    && candidate.identity && typeof candidate.identity === 'object';
}

export async function writeSearchIndex(indexPath, candidates, { signal } = {}) {
  cancelled(signal);
  requireValue(typeof indexPath === 'string' && indexPath.trim(), 'INVALID_INDEX_PATH', '인덱스를 저장할 경로가 필요해요.');
  requireValue(Array.isArray(candidates) && candidates.length <= MAX_CANDIDATES && candidates.every(validIndexCandidate),
    'INVALID_INDEX', `인덱스에는 최대 ${MAX_CANDIDATES}개의 유효한 현재 파일 후보만 저장할 수 있어요.`);
  const resolved = path.resolve(indexPath);
  await mkdir(path.dirname(resolved), { recursive: true });
  const payload = JSON.stringify({ version: 1, createdAt: new Date().toISOString(), candidates }, null, 2);
  requireValue(Buffer.byteLength(payload) <= MAX_INDEX_BYTES, 'INDEX_TOO_LARGE', '인덱스가 안전한 크기 제한을 넘었어요.');
  const temporary = path.join(path.dirname(resolved), `.${path.basename(resolved)}.${randomUUID()}.partial`);
  try {
    await writeFile(temporary, payload, { encoding: 'utf8', flag: 'wx', mode: 0o600, signal });
    cancelled(signal);
    try { await rename(temporary, resolved); }
    catch (error) {
      if (error?.code !== 'EEXIST' && error?.code !== 'EPERM') throw error;
      await writeFile(resolved, payload, { encoding: 'utf8', flag: 'w', mode: 0o600, signal });
      await unlink(temporary);
    }
  } catch (error) {
    try { await unlink(temporary); } catch {}
    if (signal?.aborted || error?.name === 'AbortError') throw new ExistingFileError('CANCELLED', '작업을 취소했어요.');
    if (error instanceof ExistingFileError) throw error;
    throw new ExistingFileError('INDEX_WRITE_FAILED', '선택한 인덱스 파일을 저장하지 못했어요.', { path: resolved, cause: error?.code });
  }
  return { path: resolved, entries: candidates.length };
}

export async function readSearchIndex(indexPath, { signal, maxCandidates = MAX_CANDIDATES } = {}) {
  cancelled(signal);
  const limit = checkedLimit(maxCandidates);
  requireValue(typeof indexPath === 'string' && indexPath.trim(), 'INVALID_INDEX_PATH', '인덱스 파일 경로가 필요해요.');
  const resolved = path.resolve(indexPath);
  let indexStats;
  try { indexStats = await stat(resolved); }
  catch (error) { throw new ExistingFileError('INDEX_READ_FAILED', '인덱스 파일을 읽지 못했어요.', { path: resolved, cause: error?.code }); }
  requireValue(indexStats.isFile() && indexStats.size <= MAX_INDEX_BYTES, 'INVALID_INDEX', '인덱스 파일이 아니거나 크기 제한을 넘었어요.');
  let parsed;
  try { parsed = JSON.parse(await readFile(resolved, { encoding: 'utf8', signal })); }
  catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') throw new ExistingFileError('CANCELLED', '작업을 취소했어요.');
    throw new ExistingFileError('INVALID_INDEX', '인덱스 형식이 올바르지 않아요.', { path: resolved });
  }
  requireValue(parsed?.version === 1 && Array.isArray(parsed.candidates)
    && parsed.candidates.length <= MAX_CANDIDATES && parsed.candidates.every(validIndexCandidate),
  'INVALID_INDEX', '지원하지 않거나 손상된 인덱스예요.');
  const candidates = [];
  const warnings = [];
  let changed = 0;
  let deleted = 0;
  const removedIds = new Set();
  let truncated = false;
  for (const stored of parsed.candidates) {
    cancelled(signal);
    if (candidates.length >= limit) { truncated = true; break; }
    try {
      const current = await validateExistingCandidate(stored, { requireStoredIdentity: false });
      const refreshed = candidateFromStats(current.filePath, current.rootPath, current.stats);
      if (!sameIdentity(stored.identity, refreshed.identity)) {
        changed++;
        refreshed.reasons = [...new Set([...(stored.reasons ?? []), 'index:changed'])];
        warnings.push({ code: 'INDEX_ENTRY_CHANGED', path: current.filePath, message: '인덱스를 만든 뒤 파일이 변경되어 현재 정보로 갱신했어요.' });
      } else {
        refreshed.score = Number(stored.score) || 0;
        refreshed.reasons = [...(stored.reasons ?? [])];
      }
      candidates.push(refreshed);
    } catch (error) {
      deleted++;
      // Derive the cache key from the represented path, never a supplied index ID.
      removedIds.add(candidateId(path.resolve(stored.path)));
      warnings.push({ code: error?.code === 'SOURCE_UNAVAILABLE' ? 'INDEX_ENTRY_DELETED' : 'INDEX_ENTRY_INVALID',
        path: stored.path, message: error?.code === 'SOURCE_UNAVAILABLE' ? '더 이상 존재하지 않는 파일을 인덱스에서 제외했어요.' : error.message });
    }
    if ((changed + deleted + candidates.length) % 64 === 0) await new Promise(resolve => setImmediate(resolve));
  }
  return {
    candidates,
    removedIds: [...removedIds],
    warnings: warnings.slice(0, MAX_WARNINGS),
    stats: { stored: parsed.candidates.length, reused: candidates.length - changed, changed, deleted, warningCount: warnings.length },
    complete: !truncated,
    truncated
  };
}

export async function findBackupLocations(homeDirectory = os.homedir()) {
  requireValue(typeof homeDirectory === 'string' && homeDirectory.trim(), 'INVALID_HOME', '사용자 폴더 경로가 필요해요.');
  const home = path.resolve(homeDirectory);
  const locations = [
    { app: 'Microsoft Office', name: 'UnsavedFiles', path: path.join(home, 'AppData', 'Local', 'Microsoft', 'Office', 'UnsavedFiles') },
    { app: 'Microsoft Word', name: '자동 복구 폴더', path: path.join(home, 'AppData', 'Roaming', 'Microsoft', 'Word') },
    { app: 'Microsoft Excel', name: '자동 복구 폴더', path: path.join(home, 'AppData', 'Roaming', 'Microsoft', 'Excel') },
    { app: 'Microsoft PowerPoint', name: '자동 복구 폴더', path: path.join(home, 'AppData', 'Roaming', 'Microsoft', 'PowerPoint') }
  ];
  return Promise.all(locations.map(async location => {
    let exists = false;
    try {
      const found = await lstat(location.path);
      exists = found.isDirectory() && !found.isSymbolicLink();
      if (exists) await access(location.path, fsConstants.R_OK);
    } catch { exists = false; }
    return { ...location, exists };
  }));
}
