import { lstat, open, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { existingCandidate } from './file-search.mjs';

export const CHECKPOINT_MAX_BYTES = 16 * 1024 * 1024;
const safe = value => Number.isSafeInteger(value) && value >= 0;
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const inside = (root, file) => { const rel = path.relative(root, file); return rel && !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`); };
function ensure(value, code = 'INVALID_CHECKPOINT', message = '저장된 정밀 검색 기록을 확인할 수 없어요. 새 검색을 시작해주세요.') {
  if (!value) throw Object.assign(new Error(message), { code });
}
export function carvingSourceIdentity(provider) {
  return provider?.info?.sourceKind === 'image'
    ? provider.info.checkpointIdentity ?? provider.info.identity ?? null : null;
}

export async function restoreCarvingCheckpoint(value, { provider, selection, resumeRoots, maxCandidates, signal, control }) {
  ensure(value && value.version === 1 && value.kind === 'carving');
  ensure(Buffer.byteLength(JSON.stringify(value)) <= CHECKPOINT_MAX_BYTES);
  ensure(carvingSourceIdentity(provider) && value.sourceIdentity === carvingSourceIdentity(provider)
    && value.sourceSize === provider.info.size, 'SOURCE_CHANGED', '이어 검사할 이미지가 이전 원본과 달라졌어요. 새 검색을 시작해주세요.');
  ensure(JSON.stringify(value.selection) === JSON.stringify(selection), 'CHECKPOINT_SCOPE_CHANGED', '검색 범위나 파일 크기 설정이 달라졌어요. 새 검색을 시작해주세요.');
  ensure(safe(value.cursor) && value.cursor <= value.sourceSize && typeof value.incomplete === 'boolean');
  const ranges = selection.ranges;
  const withinRange = (offset, length) => safe(offset) && safe(length) && length > 0
    && ranges.some(range => offset >= range.offset && offset + length <= range.offset + range.length);
  const state = value.coverageState;
  ensure(state && safe(state.scanReadBytes) && safe(state.outputBytesWritten));
  for (const key of ['examinedRanges', 'readErrorRanges']) {
    ensure(Array.isArray(state[key]));
    let end = -1;
    for (const range of state[key]) {
      ensure(withinRange(range.offset, range.length) && range.offset >= end && range.offset + range.length <= value.cursor);
      end = range.offset + range.length;
    }
  }
  ensure(state.scanReadBytes >= state.examinedRanges.reduce((sum, range) => sum + range.length, 0));
  ensure(value.counters && ['extractionBytesRead', 'signaturesFound', 'candidatesFound', 'readErrors', 'warningCount']
    .every(key => safe(value.counters[key])));
  ensure(Array.isArray(value.candidates) && value.candidates.length <= maxCandidates && value.candidates.length <= 10000
    && value.candidates.length === value.counters.candidatesFound);
  ensure(Array.isArray(value.warnings) && value.warnings.length <= 100);
  ensure(Array.isArray(resumeRoots) && resumeRoots.length <= 128);
  const allowed = [];
  const ids = new Set();
  const covered = [];
  try {
    for (const root of resumeRoots) {
      ensure(typeof root === 'string');
      const info = await lstat(root);
      ensure(info.isDirectory() && !info.isSymbolicLink(), 'CHECKPOINT_ARTIFACT_CHANGED');
      const canonical = await realpath(root);
      ensure(samePath(canonical, path.resolve(root)), 'CHECKPOINT_ARTIFACT_CHANGED');
      allowed.push(canonical);
    }
    for (const entry of value.candidates) {
      if (signal?.aborted) throw Object.assign(new Error('작업을 취소했어요.'), { code: 'CANCELLED' });
      await control?.checkpoint?.();
      const candidate = entry?.candidate;
      ensure(candidate?.source === 'carved' && candidate.nameIsGenerated === true
        && typeof candidate.path === 'string' && typeof candidate.rootPath === 'string'
        && typeof candidate.id === 'string' && !ids.has(candidate.id)
        && /^[a-f0-9]{64}$/.test(entry.sha256) && Array.isArray(candidate.reasons)
        && withinRange(candidate.offset, candidate.size) && candidate.offset < value.cursor
        && candidate.size <= selection.maxFileBytes, 'CHECKPOINT_ARTIFACT_CHANGED');
      ensure(allowed.some(root => samePath(root, candidate.rootPath)) && inside(candidate.rootPath, candidate.path), 'CHECKPOINT_ARTIFACT_CHANGED');
      const info = await lstat(candidate.path);
      ensure(info.isFile() && !info.isSymbolicLink() && info.size === candidate.size
        && samePath(await realpath(candidate.path), path.resolve(candidate.path)), 'CHECKPOINT_ARTIFACT_CHANGED');
      const before = await existingCandidate(candidate.path, candidate.rootPath);
      ensure(JSON.stringify(before.identity) === JSON.stringify(candidate.identity), 'CHECKPOINT_ARTIFACT_CHANGED');
      const file = await open(candidate.path, 'r');
      const hash = createHash('sha256');
      try {
        const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, candidate.size));
        let offset = 0;
        while (offset < candidate.size) {
          if (signal?.aborted) throw Object.assign(new Error('작업을 취소했어요.'), { code: 'CANCELLED' });
          await control?.checkpoint?.();
          const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, candidate.size - offset), offset);
          ensure(bytesRead > 0, 'CHECKPOINT_ARTIFACT_CHANGED');
          hash.update(buffer.subarray(0, bytesRead));
          offset += bytesRead;
        }
        ensure(hash.digest('hex') === entry.sha256, 'CHECKPOINT_ARTIFACT_CHANGED');
      } finally { await file.close(); }
      const after = await existingCandidate(candidate.path, candidate.rootPath);
      ensure(JSON.stringify(after.identity) === JSON.stringify(candidate.identity), 'CHECKPOINT_ARTIFACT_CHANGED');
      ids.add(candidate.id);
      covered.push({ start: candidate.offset, end: candidate.offset + candidate.size });
    }
  } catch (error) {
    if (error?.code === 'CANCELLED') throw error;
    throw Object.assign(new Error('이전 추출 파일이 없어졌거나 변경됐어요. 기존 결과는 보존하고 새 검색을 시작해주세요.'), { code: 'CHECKPOINT_ARTIFACT_CHANGED' });
  }
  ensure(state.outputBytesWritten >= value.candidates.reduce((sum, entry) => sum + entry.candidate.size, 0));
  await provider.assertUnchanged();
  return { ...value, covered };
}
