import { constants as fsConstants } from 'node:fs';
import { createHash } from 'node:crypto';
import { access, lstat, open, opendir, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const SHELL_LINK_HEADER_SIZE = 0x4c;
const SHELL_LINK_CLSID = Buffer.from('0114020000000000c000000000000046', 'hex');
const MAX_SHORTCUT_BYTES = 1024 * 1024;
const MAX_WARNINGS = 100;
const MAX_CANDIDATES = 100_000;
const MAX_FILES = 1_000_000;
const MAX_DURATION_MS = 60_000;

const FLAGS = Object.freeze({
  hasIdList: 1 << 0,
  hasLinkInfo: 1 << 1,
  hasName: 1 << 2,
  hasRelativePath: 1 << 3,
  hasWorkingDir: 1 << 4,
  hasArguments: 1 << 5,
  hasIconLocation: 1 << 6,
  isUnicode: 1 << 7,
  forceNoLinkInfo: 1 << 8
});

const EXTRA_SIGNATURE = Object.freeze({
  environment: 0xa0000001,
  specialFolder: 0xa0000005,
  knownFolder: 0xa000000b
});
const KNOWN_EXTRA_SIGNATURES = new Set([
  0xa0000001, 0xa0000002, 0xa0000003, 0xa0000004, 0xa0000005, 0xa0000006,
  0xa0000007, 0xa0000008, 0xa0000009, 0xa000000b, 0xa000000c
]);

class RecentTraceError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'RecentTraceError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new RecentTraceError(code, message, details);
}

function requireValue(value, code, message, details = {}) {
  if (!value) fail(code, message, details);
}

function identity(info) {
  return { dev: String(info.dev), ino: String(info.ino) };
}

function validIdentity(value) {
  return value && typeof value.dev === 'string' && /^\d+$/u.test(value.dev)
    && typeof value.ino === 'string' && /^\d+$/u.test(value.ino);
}

function sameIdentity(left, right) {
  return validIdentity(left) && validIdentity(right)
    && left.dev === right.dev && left.ino === right.ino;
}

function samePath(left, right) {
  return path.relative(path.resolve(left), path.resolve(right)) === '';
}

function containedBy(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
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

function recentPath(home) {
  return path.join(path.resolve(home), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Recent');
}

/** Locate only the fixed per-user Windows Recent folder. This does not scan it. */
export async function discoverRecentRoot(home = os.homedir()) {
  requireValue(typeof home === 'string' && home.trim(), 'INVALID_HOME', '사용자 폴더 경로가 필요해요.');
  const selected = recentPath(home);
  try {
    const info = await lstat(selected, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink()) {
      return { path: selected, exists: false, status: 'error', error: { code: 'UNSUPPORTED_ROOT', message: '일반 폴더가 아니어서 확인하지 않았어요.' } };
    }
    await access(selected, fsConstants.R_OK);
    return { path: selected, exists: true, status: 'existing', error: null };
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      return { path: selected, exists: false, status: 'missing', error: null };
    }
    return { path: selected, exists: false, status: 'error', error: { code: error?.code ?? 'RECENT_ROOT_UNAVAILABLE', message: '최근 문서 폴더를 읽을 수 없어요.' } };
  }
}

/** Pin a selected Recent directory to its canonical path and directory identity. */
export async function prepareRecentRoot(location) {
  requireValue((typeof location === 'string' && location.trim())
    || (location && typeof location === 'object' && typeof location.path === 'string' && location.path.trim()),
  'INVALID_ROOT', '최근 문서 검색 위치가 올바르지 않아요.');
  if (typeof location === 'object' && (location.status === 'missing' || location.exists === false && location.status !== 'existing')) return null;
  const selected = path.resolve(typeof location === 'string' ? location : location.path);
  let info;
  try { info = await lstat(selected, { bigint: true }); }
  catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    fail('ROOT_UNAVAILABLE', '최근 문서 폴더를 다시 확인할 수 없어요.', { path: selected, cause: error?.code });
  }
  requireValue(info.isDirectory() && !info.isSymbolicLink(), 'UNSUPPORTED_ROOT',
    '연결 지점이 아닌 일반 폴더만 검색할 수 있어요.', { path: selected });
  let canonical;
  try { canonical = await realpath(selected); }
  catch (error) { fail('ROOT_UNAVAILABLE', '최근 문서 폴더의 실제 위치를 확인할 수 없어요.', { path: selected, cause: error?.code }); }
  let canonicalInfo;
  try { canonicalInfo = await lstat(canonical, { bigint: true }); }
  catch (error) { fail('ROOT_UNAVAILABLE', '최근 문서 폴더를 다시 확인할 수 없어요.', { path: canonical, cause: error?.code }); }
  requireValue(canonicalInfo.isDirectory() && !canonicalInfo.isSymbolicLink()
    && sameIdentity(identity(info), identity(canonicalInfo)), 'UNSUPPORTED_ROOT',
  '연결 지점이 아닌 일반 폴더만 검색할 수 있어요.', { path: selected });
  return { path: canonical, identity: identity(canonicalInfo) };
}

async function validateRoot(root) {
  requireValue(root && typeof root === 'object' && typeof root.path === 'string'
    && root.path.trim() && validIdentity(root.identity), 'INVALID_ROOT', '최근 문서 검색 위치의 식별 정보가 올바르지 않아요.');
  const selected = path.resolve(root.path);
  try {
    const info = await lstat(selected, { bigint: true });
    requireValue(info.isDirectory() && !info.isSymbolicLink(), 'SOURCE_CHANGED',
      '최근 문서 폴더가 바뀌었어요. 다시 검색해주세요.', { path: selected });
    const canonical = await realpath(selected);
    requireValue(samePath(selected, canonical) && sameIdentity(root.identity, identity(info)), 'SOURCE_CHANGED',
      '최근 문서 폴더가 바뀌었어요. 다시 검색해주세요.', { path: selected });
    return { path: canonical, identity: { ...root.identity } };
  } catch (error) {
    if (error instanceof RecentTraceError) throw error;
    fail('SOURCE_CHANGED', '최근 문서 폴더를 다시 확인할 수 없어요. 다시 검색해주세요.', { path: selected, cause: error?.code });
  }
}

function checkedRange(buffer, offset, length, end = buffer.length) {
  return Number.isSafeInteger(offset) && Number.isSafeInteger(length) && offset >= 0 && length >= 0
    && offset <= end && length <= end - offset && end <= buffer.length;
}

function uint16(buffer, offset, end = buffer.length) {
  if (!checkedRange(buffer, offset, 2, end)) fail('MALFORMED_SHORTCUT', '바로 가기 길이가 범위를 벗어났어요.');
  return buffer.readUInt16LE(offset);
}

function uint32(buffer, offset, end = buffer.length) {
  if (!checkedRange(buffer, offset, 4, end)) fail('MALFORMED_SHORTCUT', '바로 가기 오프셋이 범위를 벗어났어요.');
  return buffer.readUInt32LE(offset);
}

function decodeUtf16(bytes) {
  if (bytes.length % 2 !== 0) fail('MALFORMED_SHORTCUT', 'Unicode 문자열 길이가 올바르지 않아요.');
  const value = bytes.toString('utf16le');
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail('MALFORMED_SHORTCUT', 'Unicode 문자열이 손상됐어요.');
    } else if (code >= 0xdc00 && code <= 0xdfff) fail('MALFORMED_SHORTCUT', 'Unicode 문자열이 손상됐어요.');
  }
  return value;
}

function decodeAnsi(bytes) {
  const ascii = bytes.every(value => value >= 0x20 && value <= 0x7e || value === 0x09);
  if (ascii) return { value: bytes.toString('ascii'), encodingLoss: false };
  return { value: new TextDecoder('windows-1252', { fatal: false }).decode(bytes), encodingLoss: true };
}

function nullTerminated(buffer, structureStart, relativeOffset, end, unicode) {
  requireValue(relativeOffset > 0 && relativeOffset < end - structureStart,
    'MALFORMED_SHORTCUT', '바로 가기 문자열 오프셋이 올바르지 않아요.');
  const start = structureStart + relativeOffset;
  if (unicode) {
    let cursor = start;
    while (cursor + 1 < end && buffer.readUInt16LE(cursor) !== 0) cursor += 2;
    requireValue(cursor + 1 < end, 'MALFORMED_SHORTCUT', 'Unicode 문자열이 끝나지 않았어요.');
    return { value: decodeUtf16(buffer.subarray(start, cursor)), encodingLoss: false };
  }
  const zero = buffer.indexOf(0, start);
  requireValue(zero >= start && zero < end, 'MALFORMED_SHORTCUT', 'ANSI 문자열이 끝나지 않았어요.');
  return decodeAnsi(buffer.subarray(start, zero));
}

function localDrivePath(value) {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim().replaceAll('/', '\\');
  if (cleaned.length < 4 || cleaned.length > 32767 || !/^[A-Za-z]:\\/u.test(cleaned)
    || /[\u0000-\u001f]/u.test(cleaned) || cleaned.slice(2).includes(':')) return null;
  const normalized = path.win32.normalize(cleaned);
  return /^[A-Za-z]:\\/u.test(normalized) && !normalized.startsWith('\\\\') ? normalized : null;
}

function isNetworkPath(value) {
  return typeof value === 'string' && /^[\\/]{2}[^\\/]/u.test(value.trim());
}

function joinLinkPath(base, suffix) {
  const validBase = localDrivePath(base);
  if (!validBase) return null;
  const cleanSuffix = typeof suffix === 'string' ? suffix.trim().replaceAll('/', '\\') : '';
  if (!cleanSuffix) return validBase;
  if (isNetworkPath(cleanSuffix) || /^[A-Za-z]:/u.test(cleanSuffix) || cleanSuffix.includes('\0')) return null;
  const relativeSuffix = cleanSuffix.replace(/^\\+/u, '');
  if (!relativeSuffix) return validBase;
  const foldedBase = validBase.toLocaleLowerCase('und');
  const foldedSuffix = relativeSuffix.toLocaleLowerCase('und');
  if (foldedBase === foldedSuffix || foldedBase.endsWith(`\\${foldedSuffix}`)) return validBase;
  return localDrivePath(path.win32.join(validBase, relativeSuffix));
}

function validateVolumeId(buffer, structureStart, relativeOffset, end) {
  requireValue(relativeOffset > 0 && relativeOffset < end - structureStart,
    'MALFORMED_SHORTCUT', 'VolumeID 오프셋이 올바르지 않아요.');
  const start = structureStart + relativeOffset;
  const size = uint32(buffer, start, end);
  requireValue(size >= 0x10 && checkedRange(buffer, start, size, end),
    'MALFORMED_SHORTCUT', 'VolumeID 크기가 올바르지 않아요.');
  const labelOffset = uint32(buffer, start + 12, start + size);
  requireValue(labelOffset >= 0x10 && labelOffset < size,
    'MALFORMED_SHORTCUT', 'VolumeID 레이블 오프셋이 올바르지 않아요.');
  if (labelOffset === 0x14) {
    requireValue(size >= 0x18, 'MALFORMED_SHORTCUT', 'Unicode VolumeID 헤더가 잘렸어요.');
    nullTerminated(buffer, start, uint32(buffer, start + 16, start + size), start + size, true);
  } else {
    nullTerminated(buffer, start, labelOffset, start + size, false);
  }
}

function validateNetworkRelativeLink(buffer, structureStart, relativeOffset, end) {
  requireValue(relativeOffset > 0 && relativeOffset < end - structureStart,
    'MALFORMED_SHORTCUT', '네트워크 링크 오프셋이 올바르지 않아요.');
  const start = structureStart + relativeOffset;
  const size = uint32(buffer, start, end);
  requireValue(size >= 0x14 && checkedRange(buffer, start, size, end),
    'MALFORMED_SHORTCUT', '네트워크 링크 크기가 올바르지 않아요.');
  const blockEnd = start + size;
  const flags = uint32(buffer, start + 4, blockEnd);
  requireValue((flags & ~3) === 0, 'MALFORMED_SHORTCUT', '네트워크 링크 플래그가 올바르지 않아요.');
  const netNameOffset = uint32(buffer, start + 8, blockEnd);
  const deviceNameOffset = uint32(buffer, start + 12, blockEnd);
  requireValue(netNameOffset >= 0x14 && netNameOffset < size,
    'MALFORMED_SHORTCUT', '네트워크 이름 오프셋이 올바르지 않아요.');
  nullTerminated(buffer, start, netNameOffset, blockEnd, false);
  const hasDeviceName = (flags & 1) !== 0;
  requireValue(hasDeviceName ? deviceNameOffset >= 0x14 && deviceNameOffset < size : deviceNameOffset === 0,
    'MALFORMED_SHORTCUT', '장치 이름 오프셋과 플래그가 일치하지 않아요.');
  if (hasDeviceName) nullTerminated(buffer, start, deviceNameOffset, blockEnd, false);
  if (netNameOffset > 0x14) {
    requireValue(size >= 0x1c, 'MALFORMED_SHORTCUT', 'Unicode 네트워크 링크 헤더가 잘렸어요.');
    const netUnicodeOffset = uint32(buffer, start + 20, blockEnd);
    const deviceUnicodeOffset = uint32(buffer, start + 24, blockEnd);
    nullTerminated(buffer, start, netUnicodeOffset, blockEnd, true);
    requireValue(hasDeviceName ? deviceUnicodeOffset > 0 : deviceUnicodeOffset === 0,
      'MALFORMED_SHORTCUT', 'Unicode 장치 이름 오프셋과 플래그가 일치하지 않아요.');
    if (hasDeviceName) nullTerminated(buffer, start, deviceUnicodeOffset, blockEnd, true);
  }
}

function parseLinkInfo(buffer, start) {
  const size = uint32(buffer, start);
  requireValue(size >= 0x1c && checkedRange(buffer, start, size), 'MALFORMED_SHORTCUT', 'LinkInfo 크기가 올바르지 않아요.');
  const end = start + size;
  const headerSize = uint32(buffer, start + 4, end);
  requireValue(headerSize === 0x1c || headerSize >= 0x24, 'MALFORMED_SHORTCUT', 'LinkInfo 헤더 크기가 올바르지 않아요.');
  requireValue(headerSize <= size, 'MALFORMED_SHORTCUT', 'LinkInfo 헤더가 구조 범위를 벗어났어요.');
  const infoFlags = uint32(buffer, start + 8, end);
  requireValue((infoFlags & ~3) === 0, 'MALFORMED_SHORTCUT', 'LinkInfo 플래그가 올바르지 않아요.');
  const volumeOffset = uint32(buffer, start + 12, end);
  const localOffset = uint32(buffer, start + 16, end);
  const networkOffset = uint32(buffer, start + 20, end);
  const suffixOffset = uint32(buffer, start + 24, end);
  const localUnicodeOffset = headerSize >= 0x24 ? uint32(buffer, start + 28, end) : 0;
  const suffixUnicodeOffset = headerSize >= 0x24 ? uint32(buffer, start + 32, end) : 0;
  const hasLocal = (infoFlags & 1) !== 0;
  const hasNetwork = (infoFlags & 2) !== 0;
  requireValue(hasLocal ? volumeOffset >= headerSize && volumeOffset < size : volumeOffset === 0,
    'MALFORMED_SHORTCUT', 'VolumeID 오프셋과 LinkInfo 플래그가 일치하지 않아요.');
  requireValue(hasLocal ? localOffset >= headerSize : localOffset === 0,
    'MALFORMED_SHORTCUT', '로컬 경로 오프셋과 LinkInfo 플래그가 일치하지 않아요.');
  requireValue(hasNetwork ? networkOffset >= headerSize : networkOffset === 0,
    'MALFORMED_SHORTCUT', '네트워크 경로 오프셋과 LinkInfo 플래그가 일치하지 않아요.');
  requireValue(suffixOffset >= headerSize, 'MALFORMED_SHORTCUT', '공통 경로 오프셋이 올바르지 않아요.');
  if (!hasLocal) requireValue(localUnicodeOffset === 0, 'MALFORMED_SHORTCUT', 'Unicode 로컬 경로 플래그가 일치하지 않아요.');
  if (hasLocal) validateVolumeId(buffer, start, volumeOffset, end);
  if (hasNetwork) validateNetworkRelativeLink(buffer, start, networkOffset, end);

  const ansiSuffix = nullTerminated(buffer, start, suffixOffset, end, false);
  let suffix = ansiSuffix;
  let local = null;
  let source = null;
  if (hasLocal) {
    const ansiLocal = nullTerminated(buffer, start, localOffset, end, false);
    local = ansiLocal;
    source = 'link-info-ansi';
    if (headerSize >= 0x24 && localUnicodeOffset) {
      local = nullTerminated(buffer, start, localUnicodeOffset, end, true);
      source = 'link-info-unicode';
    }
  }
  if (headerSize >= 0x24 && suffixUnicodeOffset) suffix = nullTerminated(buffer, start, suffixUnicodeOffset, end, true);
  return {
    cursor: end,
    target: local ? joinLinkPath(local.value, suffix.value) : null,
    source,
    encodingLoss: Boolean(local?.encodingLoss || suffix?.encodingLoss),
    network: hasNetwork
  };
}

function parseStringData(buffer, cursor, flags) {
  const unicode = (flags & FLAGS.isUnicode) !== 0;
  const values = {};
  const fields = [
    ['name', FLAGS.hasName, 260],
    ['relativePath', FLAGS.hasRelativePath, 260],
    ['workingDir', FLAGS.hasWorkingDir, 260],
    ['arguments', FLAGS.hasArguments, 0xffff],
    ['iconLocation', FLAGS.hasIconLocation, 260]
  ];
  let encodingLoss = false;
  for (const [name, flag, maximum] of fields) {
    if ((flags & flag) === 0) continue;
    const count = uint16(buffer, cursor);
    requireValue(count <= maximum, 'MALFORMED_SHORTCUT', `${name} 문자열이 지원 길이를 넘었어요.`);
    cursor += 2;
    const byteLength = count * (unicode ? 2 : 1);
    requireValue(checkedRange(buffer, cursor, byteLength), 'MALFORMED_SHORTCUT', `${name} 문자열이 파일 범위를 벗어났어요.`);
    const decoded = unicode ? { value: decodeUtf16(buffer.subarray(cursor, cursor + byteLength)), encodingLoss: false }
      : decodeAnsi(buffer.subarray(cursor, cursor + byteLength));
    values[name] = decoded.value;
    encodingLoss ||= decoded.encodingLoss;
    cursor += byteLength;
  }
  return { cursor, values, unicode, encodingLoss };
}

function parseExtraData(buffer, cursor) {
  const found = { knownFolder: false, specialFolder: false, environment: false };
  requireValue(cursor < buffer.length, 'MALFORMED_SHORTCUT', 'ExtraData 종료 블록이 없어요.');
  while (cursor < buffer.length) {
    const size = uint32(buffer, cursor);
    if (size < 4) {
      requireValue(cursor + 4 === buffer.length, 'MALFORMED_SHORTCUT', '종료 블록 뒤에 예기치 않은 데이터가 있어요.');
      return found;
    }
    requireValue(size >= 8 && checkedRange(buffer, cursor, size), 'MALFORMED_SHORTCUT', 'ExtraData 블록 크기가 올바르지 않아요.');
    const signature = uint32(buffer, cursor + 4, cursor + size);
    requireValue(KNOWN_EXTRA_SIGNATURES.has(signature), 'UNKNOWN_SHORTCUT_FORMAT', '알 수 없는 ExtraData 블록이에요.');
    if (signature === EXTRA_SIGNATURE.knownFolder) {
      requireValue(size === 0x1c, 'MALFORMED_SHORTCUT', 'KnownFolder 블록 크기가 올바르지 않아요.');
      found.knownFolder = true;
    } else if (signature === EXTRA_SIGNATURE.specialFolder) {
      requireValue(size === 0x10, 'MALFORMED_SHORTCUT', 'SpecialFolder 블록 크기가 올바르지 않아요.');
      found.specialFolder = true;
    } else if (signature === EXTRA_SIGNATURE.environment) {
      requireValue(size === 0x314, 'MALFORMED_SHORTCUT', '환경 경로 블록 크기가 올바르지 않아요.');
      found.environment = true;
    }
    cursor += size;
  }
  return found;
}

function parseShellLink(buffer) {
  requireValue(Buffer.isBuffer(buffer) && buffer.length >= SHELL_LINK_HEADER_SIZE,
    'MALFORMED_SHORTCUT', 'Shell Link 헤더가 잘렸어요.');
  requireValue(uint32(buffer, 0) === SHELL_LINK_HEADER_SIZE
    && buffer.subarray(4, 20).equals(SHELL_LINK_CLSID), 'UNKNOWN_SHORTCUT_FORMAT', '지원하는 Shell Link 형식이 아니에요.');
  const flags = uint32(buffer, 20);
  let cursor = SHELL_LINK_HEADER_SIZE;
  if ((flags & FLAGS.hasIdList) !== 0) {
    const idListSize = uint16(buffer, cursor);
    cursor += 2;
    requireValue(idListSize >= 2 && checkedRange(buffer, cursor, idListSize),
      'MALFORMED_SHORTCUT', 'LinkTargetIDList가 파일 범위를 벗어났어요.');
    requireValue(uint16(buffer, cursor + idListSize - 2) === 0,
      'MALFORMED_SHORTCUT', 'LinkTargetIDList 종료 항목이 없어요.');
    cursor += idListSize;
  }
  let linkInfo = null;
  if ((flags & FLAGS.hasLinkInfo) !== 0) {
    linkInfo = parseLinkInfo(buffer, cursor);
    cursor = linkInfo.cursor;
  }
  const strings = parseStringData(buffer, cursor, flags);
  cursor = strings.cursor;
  const extra = parseExtraData(buffer, cursor);

  let target = (flags & FLAGS.forceNoLinkInfo) === 0 ? linkInfo?.target ?? null : null;
  let source = target ? linkInfo.source : null;
  let confidence = target ? 'absolute-local-drive' : 'unsupported';
  let encodingLoss = Boolean(target ? linkInfo?.encodingLoss : strings.encodingLoss);
  if (target && linkInfo.encodingLoss) {
    target = null;
    source = null;
    confidence = 'unsupported';
    encodingLoss = true;
  }
  if (!target) {
    const relative = strings.values.relativePath;
    const direct = localDrivePath(relative);
    // RELATIVE_PATH is based on the .lnk location, never WORKING_DIR.
    // Resolve it only in candidateFor(), which knows that location.
    target = direct;
    if (target) {
      source = strings.unicode ? 'string-data-unicode' : 'string-data-ansi';
      confidence = 'absolute-local-drive';
      encodingLoss = strings.encodingLoss;
      if (encodingLoss) {
        target = null;
        source = null;
        confidence = 'unsupported';
      }
    }
  }
  const network = Boolean(linkInfo?.network || isNetworkPath(strings.values.relativePath));
  let unsupportedReason = null;
  if (!target && network) unsupportedReason = 'network-target';
  else if (!target && extra.knownFolder) unsupportedReason = 'known-folder';
  else if (!target && extra.specialFolder) unsupportedReason = 'special-folder';
  else if (!target && extra.environment) unsupportedReason = 'environment-path';
  else if (!target && (flags & FLAGS.hasIdList) !== 0) unsupportedReason = 'id-list-only';
  else if (!target) unsupportedReason = 'no-absolute-local-target';
  if (!target && linkInfo?.source === 'link-info-ansi' && linkInfo.encodingLoss
    && unsupportedReason === 'no-absolute-local-target') unsupportedReason = 'ansi-code-page-ambiguous';
  return {
    targetPath: target,
    relativePath: strings.values.relativePath ?? null,
    relativePathUnicode: strings.unicode,
    relativePathEncodingLoss: strings.encodingLoss,
    activationWorkingDirectory: strings.values.workingDir ?? null,
    targetEvidence: {
      source,
      confidence,
      encodingLoss,
      unsupportedReason,
      knownFolderPresent: extra.knownFolder
    }
  };
}

/** Parse already-bounded Shell Link bytes without resolving or accessing a target. */
export function parseRecentShortcut(buffer) {
  requireValue(Buffer.isBuffer(buffer) && buffer.length <= MAX_SHORTCUT_BYTES,
    'INVALID_SHORTCUT_BYTES', '1MiB 이하의 바로 가기 바이트가 필요해요.');
  return parseShellLink(buffer);
}

function shortcutIdentity(info) {
  return {
    dev: String(info.dev), ino: String(info.ino), size: Number(info.size),
    mtimeNs: String(info.mtimeNs ?? BigInt(Math.trunc(Number(info.mtimeMs) * 1_000_000))),
    ctimeNs: String(info.ctimeNs ?? BigInt(Math.trunc(Number(info.ctimeMs) * 1_000_000)))
  };
}

function sameFile(left, right) {
  const a = shortcutIdentity(left);
  const b = shortcutIdentity(right);
  return Object.keys(a).every(key => a[key] === b[key]);
}

function isoDate(milliseconds) {
  const value = Number(milliseconds);
  return Number.isFinite(value) && Math.abs(value) <= 8.64e15 ? new Date(value).toISOString() : null;
}

async function readShortcut(filePath, rootPath, before) {
  requireValue(before.isFile() && !before.isSymbolicLink(), 'UNSUPPORTED_SHORTCUT', '일반 바로 가기 파일이 아니에요.');
  requireValue(Number(before.size) >= SHELL_LINK_HEADER_SIZE && Number(before.size) <= MAX_SHORTCUT_BYTES,
    Number(before.size) > MAX_SHORTCUT_BYTES ? 'SHORTCUT_TOO_LARGE' : 'MALFORMED_SHORTCUT',
    Number(before.size) > MAX_SHORTCUT_BYTES ? '바로 가기 파일이 1MiB 제한을 넘었어요.' : '바로 가기 파일이 너무 짧아요.');
  const canonical = await realpath(filePath);
  requireValue(samePath(filePath, canonical) && containedBy(rootPath, canonical), 'SOURCE_CHANGED', '바로 가기 파일 위치가 바뀌었어요.');
  const noFollow = Number(fsConstants.O_NOFOLLOW ?? 0);
  let handle;
  try { handle = await open(filePath, fsConstants.O_RDONLY | noFollow); }
  catch (error) { fail('SHORTCUT_READ_FAILED', '바로 가기 파일을 열 수 없어요.', { cause: error?.code }); }
  try {
    const opened = await handle.stat({ bigint: true });
    requireValue(opened.isFile() && sameFile(before, opened), 'SOURCE_CHANGED', '바로 가기 파일이 읽기 직전에 바뀌었어요.');
    const bytes = Buffer.allocUnsafe(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      requireValue(bytesRead > 0, 'SOURCE_CHANGED', '바로 가기 파일이 읽는 중 바뀌었어요.');
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    requireValue(sameFile(opened, after), 'SOURCE_CHANGED', '바로 가기 파일이 읽는 중 바뀌었어요.');
    const current = await lstat(filePath, { bigint: true });
    requireValue(current.isFile() && !current.isSymbolicLink() && sameFile(opened, current),
      'SOURCE_CHANGED', '바로 가기 파일 경로가 읽는 중 바뀌었어요.');
    return bytes;
  } finally { await handle.close(); }
}

function candidateFor(filePath, info, parsed) {
  let target = parsed.targetPath;
  let targetEvidence = parsed.targetEvidence;
  if (!target && typeof parsed.relativePath === 'string' && parsed.relativePath
    && !isNetworkPath(parsed.relativePath)
    && (parsed.relativePathUnicode || !parsed.relativePathEncodingLoss)) {
    const shortcutDirectory = localDrivePath(path.win32.dirname(filePath));
    const relativeTarget = shortcutDirectory && !/^[A-Za-z]:/u.test(parsed.relativePath)
      ? localDrivePath(path.win32.resolve(shortcutDirectory, parsed.relativePath)) : null;
    if (relativeTarget) {
      target = relativeTarget;
      targetEvidence = {
        ...targetEvidence,
        source: parsed.relativePathUnicode ? 'relative-path-unicode' : 'relative-path-ansi',
        confidence: 'relative-derived',
        encodingLoss: false,
        unsupportedReason: null
      };
    }
  }
  const shortcutName = path.basename(filePath).replace(/\.lnk$/iu, '');
  const name = target ? path.win32.basename(target) || shortcutName : shortcutName;
  const shortcutModifiedAt = isoDate(info.mtimeMs);
  return {
    id: `recent-link:${createHash('sha256').update(filePath.normalize('NFC')).digest('hex').slice(0, 24)}`,
    source: 'recent-link',
    status: 'metadata-only',
    storage: 'unlocated',
    hasContent: false,
    requiresPreparation: false,
    size: null,
    name,
    originalPath: target,
    path: null,
    deletedAt: null,
    modifiedAt: null,
    deletionConfirmed: false,
    originalIdentityVerified: false,
    shortcutPath: filePath,
    clue: {
      kind: 'recent-link',
      targetPath: target,
      targetEvidence,
      shortcutModifiedAt,
      relationship: 'unknown',
      targetExistence: 'not-checked',
      contentAvailable: false
    }
  };
}

/**
 * Read bounded .lnk metadata directly under a verified Recent folder.
 * Shortcut targets are never opened, statted, resolved, or otherwise accessed.
 */
export async function searchRecentTraces(root, {
  signal, control, onCandidate, onProgress, maxCandidates = 2000, maxFiles = 10000, maxDurationMs = 10000
} = {}) {
  const limits = {
    maxCandidates: integerLimit(maxCandidates, MAX_CANDIDATES, 'maxCandidates'),
    maxFiles: integerLimit(maxFiles, MAX_FILES, 'maxFiles'),
    maxDurationMs: integerLimit(maxDurationMs, MAX_DURATION_MS, 'maxDurationMs')
  };
  cancelled(signal);
  const startedAtMs = Date.now();
  const candidates = [];
  const warnings = [];
  const stats = {
    rootsTotal: root ? 1 : 0, rootsScanned: 0, entriesVisited: 0, filesVisited: 0,
    candidatesFound: 0, symlinksSkipped: 0, nonShortcutSkipped: 0, malformedSkipped: 0,
    unsupportedTargets: 0, bytesRead: 0, warningCount: 0,
    startedAt: new Date(startedAtMs).toISOString(), finishedAt: null, durationMs: null
  };
  let truncated = false;
  let stopReason = null;
  let scanFailures = 0;
  const coverageRoot = {
    path: root?.path ?? null, status: root ? 'pending' : 'missing', entriesVisited: 0,
    filesVisited: 0, candidatesFound: 0, warningCount: 0
  };

  function warning(code, itemPath, message, error = null, incomplete = false) {
    stats.warningCount++;
    coverageRoot.warningCount++;
    if (incomplete) scanFailures++;
    if (warnings.length < MAX_WARNINGS) warnings.push({ code, path: itemPath, message, cause: error?.code ?? error?.details?.cause ?? null });
  }

  function reachedLimit() {
    let reason = null;
    if (candidates.length >= limits.maxCandidates) reason = 'candidate-limit';
    else if (stats.filesVisited >= limits.maxFiles) reason = 'file-limit';
    else if (Date.now() - startedAtMs >= limits.maxDurationMs) reason = 'duration-limit';
    if (!reason) return false;
    truncated = true;
    stopReason = reason;
    const labels = {
      'candidate-limit': ['CANDIDATE_LIMIT', '최근 문서 후보 수 제한에 도달했어요.'],
      'file-limit': ['FILE_LIMIT', '확인할 바로 가기 파일 수 제한에 도달했어요.'],
      'duration-limit': ['DURATION_LIMIT', '최근 문서 검색 시간 제한에 도달했어요.']
    };
    warning(labels[reason][0], root?.path ?? null, labels[reason][1]);
    return true;
  }

  if (root) {
    await checkpoint(control, signal);
    const currentRoot = await validateRoot(root);
    coverageRoot.path = currentRoot.path;
    coverageRoot.status = 'scanning';
    let directory;
    try { directory = await opendir(currentRoot.path); }
    catch (error) { fail('ROOT_UNAVAILABLE', '최근 문서 폴더를 열 수 없어요.', { path: currentRoot.path, cause: error?.code }); }
    try {
      for await (const entry of directory) {
        await checkpoint(control, signal);
        await validateRoot(currentRoot);
        if (reachedLimit()) break;
        stats.entriesVisited++;
        coverageRoot.entriesVisited++;
        if (!/\.lnk$/iu.test(entry.name)) { stats.nonShortcutSkipped++; continue; }
        const entryPath = path.resolve(currentRoot.path, entry.name);
        if (!containedBy(currentRoot.path, entryPath) || samePath(currentRoot.path, entryPath)) {
          warning('ESCAPES_ROOT', entryPath, '최근 문서 검색 범위 밖의 항목을 건너뛰었어요.', null, true);
          continue;
        }
        let info;
        try { info = await lstat(entryPath, { bigint: true }); }
        catch (error) { warning('ENTRY_READ_FAILED', entryPath, '바로 가기 정보를 읽지 못해 건너뛰었어요.', error, true); continue; }
        if (info.isSymbolicLink()) {
          stats.symlinksSkipped++;
          warning('LINK_SKIPPED', entryPath, '파일 시스템 연결 지점은 최근 문서 검색에서 제외했어요.');
          continue;
        }
        if (!info.isFile()) { stats.nonShortcutSkipped++; continue; }
        stats.filesVisited++;
        coverageRoot.filesVisited++;
        try {
          const bytes = await readShortcut(entryPath, currentRoot.path, info);
          stats.bytesRead += bytes.length;
          const parsed = parseShellLink(bytes);
          const candidate = candidateFor(entryPath, info, parsed);
          candidates.push(candidate);
          stats.candidatesFound = candidates.length;
          coverageRoot.candidatesFound++;
          if (candidate.clue.targetEvidence.unsupportedReason) {
            stats.unsupportedTargets++;
            const codes = {
              'network-target': 'UNSUPPORTED_NETWORK_TARGET',
              'known-folder': 'UNSUPPORTED_KNOWN_FOLDER',
              'special-folder': 'UNSUPPORTED_SPECIAL_FOLDER',
              'environment-path': 'UNSUPPORTED_ENVIRONMENT_PATH',
              'ansi-code-page-ambiguous': 'UNSUPPORTED_ANSI_PATH'
            };
            const code = codes[candidate.clue.targetEvidence.unsupportedReason];
            if (code) warning(code, entryPath, '외부 해석 없이 바로 가기 메타데이터만 표시해요.');
          }
          if (typeof onCandidate === 'function') onCandidate(structuredClone(candidate));
        } catch (error) {
          if (error?.code === 'CANCELLED' || error?.code === 'SOURCE_CHANGED') throw error;
          stats.malformedSkipped++;
          warning(error?.code ?? 'SHORTCUT_READ_FAILED', entryPath, '지원하지 않거나 손상된 바로 가기를 건너뛰었어요.', error,
            !['MALFORMED_SHORTCUT', 'UNKNOWN_SHORTCUT_FORMAT', 'SHORTCUT_TOO_LARGE', 'UNSUPPORTED_SHORTCUT'].includes(error?.code));
        }
        if (typeof onProgress === 'function') onProgress({ phase: 'recent-traces', ...stats, currentPath: entryPath, rootPath: currentRoot.path });
        if (reachedLimit()) break;
        if (stats.filesVisited % 32 === 0) await new Promise(resolve => setImmediate(resolve));
      }
    } catch (error) {
      if (error?.code === 'CANCELLED' || error?.code === 'SOURCE_CHANGED') throw error;
      warning('DIRECTORY_READ_FAILED', currentRoot.path, '최근 문서 폴더를 끝까지 읽지 못했어요.', error, true);
    } finally { await directory.close().catch(() => {}); }
    await validateRoot(currentRoot);
    if (!truncated) stats.rootsScanned = 1;
    coverageRoot.status = truncated ? 'truncated' : scanFailures ? 'partial' : 'scanned';
  }

  cancelled(signal);
  const finishedAtMs = Date.now();
  stats.finishedAt = new Date(finishedAtMs).toISOString();
  stats.durationMs = finishedAtMs - startedAtMs;
  const complete = !truncated && scanFailures === 0;
  const coverage = {
    kind: 'recent-traces', root: coverageRoot, rootsTotal: stats.rootsTotal, rootsScanned: stats.rootsScanned,
    entriesVisited: stats.entriesVisited, filesVisited: stats.filesVisited, candidatesFound: stats.candidatesFound,
    limits, stopReason, scope: 'nonrecursive-lnk-only', automaticDestinations: 'unsupported',
    customDestinations: 'unsupported', targetExistenceChecks: 0, complete, truncated
  };
  if (typeof onProgress === 'function') onProgress({ phase: 'complete', ...stats, complete, truncated, stopReason });
  return { candidates, warnings, stats, coverage, complete, truncated };
}

