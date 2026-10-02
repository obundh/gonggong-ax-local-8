import { lstat, realpath, open, opendir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { listWindowsDevices } from './windows-device.mjs';
import { copyExistingCandidate, ExistingFileError } from './file-search.mjs';
import { classifyFileKind } from './candidate-filter.mjs';

const MAX_METADATA = 65564;
const MAX_ENTRIES = 20000;
const MAX_ROOTS = 26;
const SID = /^S-1-(?:\d+-){1,14}\d+$/;
const fail = (code, message) => { throw new ExistingFileError(code, message); };
const requireValue = (value, code, message) => { if (!value) fail(code, message); };
const within = (root, target) => { const relative = path.relative(root, target); return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)); };
const equalPath = (left, right) => path.relative(left, right) === '';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const identity = value => ({ device: String(value.dev), inode: String(value.ino), mode: String(value.mode), size: Number(value.size), modifiedAtNs: String(value.mtimeNs), changedAtNs: String(value.ctimeNs) });
const sameIdentity = (left, right) => left && right && Object.keys(left).every(key => left[key] === right[key]);
const sameDirectory = (left, right) => left && right && ['device', 'inode', 'mode'].every(key => left[key] === right[key]);
async function checkpoint(options) { if (options.signal?.aborted) fail('CANCELLED', '작업을 취소했어요.'); await options.control?.checkpoint(); if (options.signal?.aborted) fail('CANCELLED', '작업을 취소했어요.'); }

function powershell(script, environment = {}, signal) {
  requireValue(process.platform === 'win32', 'WINDOWS_ONLY', '휴지통 목록은 Windows에서 사용할 수 있어요.');
  const encoded = Buffer.from("$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false);\n" + script, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    { windowsHide: true, timeout: 20000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8', signal, env: { ...process.env, ...environment } },
    (error, stdout) => error ? reject(new ExistingFileError(signal?.aborted ? 'CANCELLED' : 'RECYCLE_UNAVAILABLE', '휴지통의 Windows 파일 속성을 확인하지 못했어요.')) : resolve(stdout.trim())));
}

async function rejectReparse(paths, signal) {
  if (process.platform !== 'win32') return;
  const output = await powershell("$paths=ConvertFrom-Json $env:RECOVERYCHAT_RECYCLE_PATHS; foreach($p in $paths) { if (([int][System.IO.File]::GetAttributes($p) -band 1024) -ne 0) { throw 'Reparse point'; } }; 'ok'", { RECOVERYCHAT_RECYCLE_PATHS: JSON.stringify(paths) }, signal);
  requireValue(output === 'ok', 'UNSUPPORTED_SOURCE', '연결 지점이나 재분석 파일은 처리하지 않아요.');
}

async function checkedRoot(root) {
  const selected = path.resolve(typeof root === 'string' ? root : root?.path ?? '');
  requireValue(typeof root === 'string' ? root.trim() : typeof root?.path === 'string' && root.path.trim(), 'INVALID_ROOT', '휴지통 검색 위치가 잘못됐어요.');
  const info = await lstat(selected, { bigint: true });
  requireValue(info.isDirectory() && !info.isSymbolicLink(), 'UNSUPPORTED_ROOT', '휴지통 위치는 연결 지점이 아닌 폴더여야 해요.');
  const canonical = await realpath(selected);
  requireValue(equalPath(selected, canonical), 'UNSUPPORTED_ROOT', '휴지통의 실제 위치가 바뀌었어요.');
  const current = identity(info);
  if (root.identity) requireValue(sameDirectory(root.identity, current), 'SOURCE_CHANGED', '휴지통 폴더가 검색 후 바뀌었어요.');
  return { ...(typeof root === 'object' ? root : {}), path: canonical, identity: current };
}

export async function discoverRecycleRoots({ signal, inventory = listWindowsDevices, getSid } = {}) {
  const sid = getSid ? await getSid() : await powershell('[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value', {}, signal);
  requireValue(SID.test(sid), 'RECYCLE_UNAVAILABLE', '현재 사용자의 휴지통을 확인하지 못했어요.');
  const devices = await inventory();
  const roots = [], warnings = [], seen = new Set();
  for (const device of devices) {
    await checkpoint({ signal });
    if (!/^[a-z]:$/i.test(device.driveLetter ?? '') || seen.has(device.driveLetter.toUpperCase())) continue;
    seen.add(device.driveLetter.toUpperCase());
    if (device.ready === false) { warnings.push({ code: 'RECYCLE_DEVICE_NOT_READY', message: `${device.driveLetter} 장치가 준비되지 않아 확인하지 못했어요.` }); continue; }
    const selected = path.win32.join(`${device.driveLetter}\\`, '$Recycle.Bin', sid);
    try {
      const root = await checkedRoot({ path: selected });
      await rejectReparse([path.dirname(root.path), root.path], signal);
      roots.push({ ...root, driveLetter: device.driveLetter, deviceIdentity: device.identity, label: `${device.driveLetter} 휴지통` });
    } catch (error) { if (error.code === 'CANCELLED') throw error; if (error.code !== 'ENOENT') warnings.push({ code: error.code ?? 'RECYCLE_UNAVAILABLE', message: `${device.driveLetter} 휴지통 일부를 읽을 수 없어요.` }); }
  }
  return { roots, warnings };
}

// $I v1/v2 field layout: https://github.com/danielmarschall/recyclebinunit/blob/master/FORMAT.md
function parseMetadata(bytes) {
  requireValue(bytes.length >= 26 && bytes.length <= MAX_METADATA, 'RECYCLE_METADATA_INVALID', '휴지통 정보 파일 크기가 잘못됐어요.');
  const version = bytes.readBigUInt64LE(0);
  let start, units;
  if (version === 1n) { requireValue(bytes.length === 544, 'RECYCLE_METADATA_INVALID', '휴지통 v1 정보 파일이 잘렸어요.'); start = 24; units = 260; }
  else if (version === 2n) { requireValue(bytes.length >= 30, 'RECYCLE_METADATA_INVALID', '휴지통 v2 정보 파일이 잘렸어요.'); start = 28; units = bytes.readUInt32LE(24); requireValue(units >= 2 && units <= 32768 && start + units * 2 === bytes.length, 'RECYCLE_METADATA_INVALID', '휴지통 원래 경로 길이가 잘못됐어요.'); }
  else fail('RECYCLE_METADATA_UNSUPPORTED', '지원하지 않는 휴지통 정보 형식이에요.');
  const text = bytes.subarray(start, start + units * 2).toString('utf16le');
  const end = text.indexOf('\0');
  requireValue(end > 0 && (version === 1n || end === units - 1), 'RECYCLE_METADATA_INVALID', '휴지통 원래 경로의 끝을 확인하지 못했어요.');
  const originalPath = text.slice(0, end);
  const name = path.win32.basename(originalPath);
  requireValue(/^[A-Za-z]:\\/.test(originalPath) && name && !originalPath.split(/[\\/]/).some(part => part === '.' || part === '..')
    && !/[\x00-\x1f]/.test(originalPath), 'RECYCLE_METADATA_INVALID', '휴지통 원래 파일 경로가 잘못됐어요.');
  const size = bytes.readBigUInt64LE(8);
  requireValue(size <= BigInt(Number.MAX_SAFE_INTEGER), 'RECYCLE_METADATA_INVALID', '휴지통 파일 크기가 지원 범위를 벗어났어요.');
  const ticks = bytes.readBigUInt64LE(16);
  const milliseconds = Number(ticks / 10000n - 11644473600000n);
  const deletedAt = ticks > 0n && Number.isSafeInteger(milliseconds) && Math.abs(milliseconds) <= 8640000000000000 ? new Date(milliseconds).toISOString() : null;
  return { originalPath, name, size: Number(size), deletedAt };
}

async function readMetadata(file, root, expected, signal) {
  await checkpoint({ signal });
  requireValue(equalPath(path.dirname(file), root.path) && /^\$I[^\\/]+$/i.test(path.basename(file)), 'INVALID_CANDIDATE', '휴지통 정보 파일 위치가 잘못됐어요.');
  const before = await lstat(file, { bigint: true });
  requireValue(before.isFile() && !before.isSymbolicLink() && before.size <= BigInt(MAX_METADATA), 'RECYCLE_METADATA_INVALID', '휴지통 정보 파일은 제한된 크기의 일반 파일이어야 해요.');
  const beforeIdentity = identity(before);
  if (expected) requireValue(sameIdentity(expected.identity, beforeIdentity), 'SOURCE_CHANGED', '휴지통 정보가 검색 후 바뀌었어요.');
  const handle = await open(file, 'r');
  let bytes;
  try {
    requireValue(sameIdentity(beforeIdentity, identity(await handle.stat({ bigint: true }))), 'SOURCE_CHANGED', '휴지통 정보 파일이 바뀌었어요.');
    bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) { await checkpoint({ signal }); const result = await handle.read(bytes, offset, bytes.length - offset, offset); requireValue(result.bytesRead > 0, 'SOURCE_CHANGED', '휴지통 정보 파일이 잘렸어요.'); offset += result.bytesRead; }
    requireValue(sameIdentity(beforeIdentity, identity(await handle.stat({ bigint: true }))), 'SOURCE_CHANGED', '읽는 동안 휴지통 정보가 바뀌었어요.');
  } finally { await handle.close(); }
  const after = await lstat(file, { bigint: true });
  requireValue(after.isFile() && !after.isSymbolicLink() && sameIdentity(beforeIdentity, identity(after)), 'SOURCE_CHANGED', '휴지통 정보 파일이 교체됐어요.');
  const hash = digest(bytes);
  if (expected) requireValue(expected.sha256 === hash, 'SOURCE_CHANGED', '휴지통 정보 내용이 바뀌었어요.');
  return { ...parseMetadata(bytes), metadata: { path: file, identity: beforeIdentity, sha256: hash } };
}

async function windowsReparseNames(root, signal) {
  if (process.platform !== 'win32') return new Set();
  const script = "$p=$env:RECOVERYCHAT_RECYCLE_ROOT; if (([int][System.IO.File]::GetAttributes($p) -band 1024) -ne 0) { throw 'Reparse root'; }; $count=0; $names=@(foreach($entry in [System.IO.Directory]::EnumerateFileSystemEntries($p)) { if (++$count -gt 20000) { break; }; if (([int][System.IO.File]::GetAttributes($entry) -band 1024) -ne 0) { [System.IO.Path]::GetFileName($entry) } }); ConvertTo-Json -Compress -InputObject @{names=$names; limited=($count -gt 20000)}";
  const data = JSON.parse(await powershell(script, { RECOVERYCHAT_RECYCLE_ROOT: root.path }, signal));
  requireValue(!data.limited, 'RECYCLE_ENTRY_LIMIT', '휴지통 항목 수 제한을 넘어 일부를 확인하지 못했어요.');
  return new Set(data.names.map(name => name.toLowerCase()));
}

export async function searchRecycleBin(roots, options = {}) {
  requireValue(Array.isArray(roots) && roots.length <= MAX_ROOTS, 'INVALID_ROOT', '휴지통 검색 위치가 너무 많거나 잘못됐어요.');
  const maxCandidates = options.maxCandidates ?? 10000;
  requireValue(Number.isInteger(maxCandidates) && maxCandidates > 0 && maxCandidates <= 10000, 'INVALID_LIMIT', '휴지통 후보 제한은 1~10000개여야 해요.');
  const candidates = [], warnings = [], stats = { rootsTotal: roots.length, rootsScanned: 0, entriesRead: 0, candidatesFound: 0 };
  let truncated = false;
  const warning = (code, message) => { if (warnings.length < 100) warnings.push({ code, message }); };
  for (const selected of roots) {
    await checkpoint(options);
    if (truncated) break;
    try {
      const root = await checkedRoot(selected);
      const reparses = await windowsReparseNames(root, options.signal);
      const directory = await opendir(root.path);
      for await (const entry of directory) {
        await checkpoint(options);
        stats.entriesRead++;
        if (stats.entriesRead > MAX_ENTRIES) { truncated = true; warning('RECYCLE_ENTRY_LIMIT', '휴지통 항목 수 제한에 도달해 일부 항목만 표시해요.'); break; }
        if (!/^\$I[^\\/]+$/i.test(entry.name)) continue;
        if (candidates.length >= maxCandidates) { truncated = true; warning('CANDIDATE_LIMIT', '휴지통 후보 수 제한에 도달해 일부 항목만 표시해요.'); break; }
        try {
          const payloadName = '$R' + entry.name.slice(2);
          requireValue(!reparses.has(entry.name.toLowerCase()) && !reparses.has(payloadName.toLowerCase()), 'RECYCLE_REPARSE_SKIPPED', '연결 지점이나 재분석 항목은 제외했어요.');
          const info = await readMetadata(path.join(root.path, entry.name), root, null, options.signal);
          const payload = path.join(root.path, payloadName);
          const file = await lstat(payload, { bigint: true });
          requireValue(!file.isSymbolicLink() && (file.isFile() || file.isDirectory()), 'RECYCLE_REPARSE_SKIPPED', '일반 파일이나 폴더가 아닌 휴지통 항목은 제외했어요.');
          requireValue(equalPath(await realpath(payload), payload), 'RECYCLE_REPARSE_SKIPPED', '휴지통 파일의 실제 위치가 달라 제외했어요.');
          const folder = file.isDirectory();
          const readable = !folder && info.size === Number(file.size);
          const candidate = { id: `recycle:${digest(Buffer.from(payload)).slice(0, 24)}`, source: 'recycle-bin', path: payload, rootPath: root.path, recycleRoot: root,
            name: info.name, originalPath: info.originalPath, size: Number(file.size), originalSize: info.size, modifiedAt: new Date(Number(file.mtimeMs)).toISOString(),
            deletedAt: info.deletedAt, deletedAtSource: 'recycle-metadata', kind: folder ? 'other' : classifyFileKind(info.name), isDirectory: folder,
            status: readable ? 'readable' : 'unsupported', reasons: folder ? ['폴더 항목은 목록만 표시해요. Windows 휴지통에서 복원할 수 있어요.'] : readable ? ['휴지통에 남아 있는 파일을 새 복사본으로 저장해요.'] : ['휴지통 정보와 실제 파일 크기가 달라 저장하지 않아요.'],
            identity: identity(file), recycleMetadata: info.metadata };
          candidates.push(candidate); stats.candidatesFound = candidates.length; options.onCandidate?.(candidate);
          if (!info.deletedAt) warning('RECYCLE_TIME_UNKNOWN', '삭제 시각을 확인하지 못한 항목도 목록에 표시해요.');
        } catch (error) { if (error.code === 'CANCELLED') throw error; warning(error.code ?? 'RECYCLE_ENTRY_UNAVAILABLE', '휴지통 항목 일부가 변경됐거나 읽을 수 없어 제외했어요.'); }
        options.onProgress?.({ stage: 'recycle', ...stats });
      }
      await checkedRoot(root); stats.rootsScanned++;
    } catch (error) { if (error.code === 'CANCELLED') throw error; warning(error.code ?? 'RECYCLE_UNAVAILABLE', error.message || '휴지통 일부를 읽지 못했어요.'); }
  }
  await checkpoint(options);
  candidates.sort((a, b) => (b.deletedAt ? Date.parse(b.deletedAt) : -Infinity) - (a.deletedAt ? Date.parse(a.deletedAt) : -Infinity));
  options.onProgress?.({ stage: 'recycle', ...stats });
  return { candidates, stats, warnings, complete: !truncated && warnings.length === 0, truncated };
}

export async function recoverRecycleCandidate(candidate, destination, options = {}) {
  requireValue(candidate?.source === 'recycle-bin' && candidate.status === 'readable' && candidate.recycleMetadata && candidate.recycleRoot,
    'INVALID_CANDIDATE', '저장할 수 있는 휴지통 파일을 선택해주세요.');
  requireValue(typeof destination === 'string' && destination.trim(), 'INVALID_DESTINATION', '저장할 폴더를 선택해주세요.');
  const root = await checkedRoot(candidate.recycleRoot);
  requireValue(equalPath(candidate.rootPath, root.path) && equalPath(path.dirname(candidate.path), root.path)
    && path.basename(candidate.path).toLowerCase() === ('$R' + path.basename(candidate.recycleMetadata.path).slice(2)).toLowerCase(), 'INVALID_CANDIDATE', '휴지통 파일 쌍이 맞지 않아요.');
  const output = await realpath(destination);
  requireValue(!within(root.path, output), 'UNSAFE_OUTPUT', '휴지통 밖의 저장 폴더를 선택해주세요.');
  await rejectReparse([root.path, candidate.path, candidate.recycleMetadata.path], options.signal);
  const verify = async () => {
    await checkpoint(options); await checkedRoot(root);
    const metadata = await readMetadata(candidate.recycleMetadata.path, root, candidate.recycleMetadata, options.signal);
    requireValue(metadata.name === candidate.name && metadata.originalPath === candidate.originalPath && metadata.size === candidate.size,
      'SOURCE_CHANGED', '휴지통의 파일 정보가 검색 후 바뀌었어요.');
  };
  await verify();
  return copyExistingCandidate({ ...candidate, source: 'existing-file', status: 'existing' }, output,
    { ...options, control: { checkpoint: verify } });
}

export async function readRecycleCandidateBytes(candidate, { maxBytes = 8 * 1024 * 1024, signal, control } = {}) {
  requireValue(candidate?.source === 'recycle-bin' && candidate.status === 'readable' && candidate.recycleMetadata && candidate.recycleRoot,
    'INVALID_CANDIDATE', '내용을 확인할 수 있는 휴지통 파일을 선택해주세요.');
  requireValue(Number.isSafeInteger(maxBytes) && maxBytes >= 1024 && maxBytes <= 8 * 1024 * 1024,
    'INVALID_LIMIT', '미리보기 읽기 한도가 잘못됐어요.');
  requireValue(Number.isSafeInteger(candidate.size) && candidate.size <= maxBytes, 'PREVIEW_TOO_LARGE', '8MB 이하의 파일만 미리 볼 수 있어요.');
  const root = await checkedRoot(candidate.recycleRoot);
  requireValue(equalPath(candidate.rootPath, root.path) && equalPath(path.dirname(candidate.path), root.path)
    && path.basename(candidate.path).toLowerCase() === ('$R' + path.basename(candidate.recycleMetadata.path).slice(2)).toLowerCase(),
  'INVALID_CANDIDATE', '휴지통 파일 쌍이 맞지 않아요.');
  await rejectReparse([root.path, candidate.path, candidate.recycleMetadata.path], signal);
  const metadata = await readMetadata(candidate.recycleMetadata.path, root, candidate.recycleMetadata, signal);
  requireValue(metadata.name === candidate.name && metadata.originalPath === candidate.originalPath && metadata.size === candidate.size,
    'SOURCE_CHANGED', '휴지통의 파일 정보가 검색 후 바뀌었어요.');
  const before = await lstat(candidate.path, { bigint: true });
  const beforeIdentity = identity(before);
  requireValue(before.isFile() && !before.isSymbolicLink() && sameIdentity(candidate.identity, beforeIdentity),
    'SOURCE_CHANGED', '휴지통 파일이 검색 후 바뀌었어요.');
  const handle = await open(candidate.path, 'r');
  const bytes = Buffer.alloc(candidate.size);
  try {
    requireValue(sameIdentity(beforeIdentity, identity(await handle.stat({ bigint: true }))), 'SOURCE_CHANGED', '휴지통 파일이 바뀌었어요.');
    let offset = 0;
    while (offset < bytes.length) {
      await checkpoint({ signal, control });
      const result = await handle.read(bytes, offset, Math.min(1024 * 1024, bytes.length - offset), offset);
      requireValue(result.bytesRead > 0, 'SOURCE_CHANGED', '휴지통 파일이 읽는 동안 잘렸어요.');
      offset += result.bytesRead;
    }
    requireValue(sameIdentity(beforeIdentity, identity(await handle.stat({ bigint: true }))), 'SOURCE_CHANGED', '읽는 동안 휴지통 파일이 바뀌었어요.');
  } finally { await handle.close(); }
  const after = await lstat(candidate.path, { bigint: true });
  requireValue(after.isFile() && !after.isSymbolicLink() && sameIdentity(beforeIdentity, identity(after)), 'SOURCE_CHANGED', '휴지통 파일이 교체됐어요.');
  return bytes;
}
