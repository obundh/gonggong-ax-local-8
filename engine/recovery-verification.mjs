import { createHash } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';

import { previewBytes } from './file-preview.mjs';

const MAX_ASSESS_BYTES = 8 * 1024 * 1024;
const READ_CHUNK_BYTES = 1024 * 1024;
const REPARSE_POINT_ATTRIBUTE = 0x400;
const OLE_SIGNATURE = Buffer.from('d0cf11e0a1b11ae1', 'hex');

const EXPECTED_FORMATS = new Map([
  ['.pdf', { family: 'pdf', label: 'PDF' }],
  ['.docx', { family: 'zip', label: 'DOCX', profile: true }],
  ['.xlsx', { family: 'zip', label: 'XLSX', profile: true }],
  ['.pptx', { family: 'zip', label: 'PPTX', profile: true }],
  ['.hwpx', { family: 'zip', label: 'HWPX', profile: true }],
  ['.zip', { family: 'zip', label: 'ZIP' }],
  ['.hwp', { family: 'ole', label: 'HWP' }],
  ['.doc', { family: 'ole', label: 'DOC' }],
  ['.xls', { family: 'ole', label: 'XLS' }],
  ['.ppt', { family: 'ole', label: 'PPT' }],
  ['.png', { family: 'png', label: 'PNG' }],
  ['.jpg', { family: 'jpeg', label: 'JPEG' }],
  ['.jpeg', { family: 'jpeg', label: 'JPEG' }],
  ['.gif', { family: 'gif', label: 'GIF' }],
  ['.webp', { family: 'webp', label: 'WEBP' }],
]);

const PROTECTED_REASONS = new Set([
  'PDF_ENCRYPTED', 'OLE_ENCRYPTED', 'HWP_PROTECTED_DOCUMENT', 'ZIP_ENCRYPTED_UNSUPPORTED',
]);

const DAMAGED_REASONS = new Set([
  'PDF_DAMAGED', 'PDF_DEFLATE_FAILED', 'ZIP_CRC_MISMATCH', 'ZIP_DAMAGED', 'ZIP_TRUNCATED',
  'ZIP_DEFLATE_FAILED', 'OLE_DAMAGED', 'IMAGE_HEADER_INVALID', 'HWP_INVALID_STRUCTURE',
]);

function cancelled(signal) {
  if (!signal?.aborted) return;
  const error = new Error('복구본 확인을 취소했어요.');
  error.code = 'CANCELLED';
  throw error;
}

function verificationFailed(reason, message, details = {}) {
  const error = new Error(message);
  error.code = 'OUTPUT_VERIFICATION_FAILED';
  error.details = { reason, ...details };
  return error;
}

function isReparsePoint(info) {
  if (info?.fileAttributes === undefined) return false;
  return (Number(info.fileAttributes) & REPARSE_POINT_ATTRIBUTE) !== 0;
}

function identityOf(info) {
  return {
    dev: String(info.dev),
    ino: String(info.ino),
    size: String(info.size),
    mtimeMs: String(info.mtimeMs),
  };
}

function sameIdentity(left, right) {
  if (!left || !right) return false;
  const a = identityOf(left);
  const b = identityOf(right);
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

function requireRegular(info, reason) {
  if (!info?.isFile() || info.isSymbolicLink() || isReparsePoint(info)) {
    throw verificationFailed(reason, '복구본이 일반 파일인지 확인할 수 없어요.');
  }
}

function expectedSizeAsBigInt(value) {
  if (typeof value === 'bigint' && value >= 0n) return value;
  if (Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value)) return BigInt(value);
  throw verificationFailed('EXPECTED_SIZE_INVALID', '예상 파일 크기가 올바르지 않아요.');
}

function expectedHash(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/i.test(value)) {
    throw verificationFailed('EXPECTED_SHA256_INVALID', '예상 SHA-256 값이 올바르지 않아요.');
  }
  return value.toLowerCase();
}

async function checkpoint(control, signal) {
  cancelled(signal);
  if (typeof control?.checkpoint === 'function') await control.checkpoint();
  cancelled(signal);
}

function emit(onProgress, bytesChecked, bytesTotal) {
  if (typeof onProgress === 'function') {
    onProgress(Object.freeze({ stage: 'verify-recovery', bytesChecked, bytesTotal }));
  }
}

function detectedSignature(bytes) {
  if (!bytes?.length) return { family: 'empty', label: 'empty' };
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString('ascii') === '%PDF-') return { family: 'pdf', label: 'PDF' };
  if (bytes.length >= 2 && bytes.subarray(0, 2).toString('ascii') === 'PK') return { family: 'zip', label: 'ZIP' };
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(OLE_SIGNATURE)) return { family: 'ole', label: 'OLE compound document' };
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return { family: 'png', label: 'PNG' };
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return { family: 'jpeg', label: 'JPEG' };
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) return { family: 'gif', label: 'GIF' };
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
    && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return { family: 'webp', label: 'WEBP' };
  if (looksLikePlainText(bytes)) return { family: 'text', label: 'plain text' };
  return { family: 'unknown', label: 'unknown' };
}

function looksLikePlainText(bytes) {
  if (!bytes.length) return false;
  try {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
      new TextDecoder('utf-16le', { fatal: true }).decode(bytes.subarray(2, bytes.length - ((bytes.length - 2) % 2)));
      return true;
    }
    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      if ((bytes.length - 2) % 2) return false;
      const swapped = Buffer.from(bytes.subarray(2));
      for (let index = 0; index < swapped.length; index += 2) [swapped[index], swapped[index + 1]] = [swapped[index + 1], swapped[index]];
      new TextDecoder('utf-16le', { fatal: true }).decode(swapped);
      return true;
    }
    if (bytes.includes(0)) return false;
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return !/[\u0001-\u0008\u000b\u000c\u000e-\u001f]/.test(text);
  } catch {
    return false;
  }
}

function baseDocument(status, format, extra = {}) {
  return {
    status,
    format,
    originalIdentityVerified: false,
    applicationOpenVerified: false,
    ...extra,
  };
}

function expectedFor(fileName) {
  return EXPECTED_FORMATS.get(path.extname(String(fileName ?? '')).toLowerCase()) ?? null;
}

function mismatch(expected, detected, reason = 'EXTENSION_SIGNATURE_MISMATCH') {
  return baseDocument('format-mismatch', detected.label, {
    reason,
    expectedFormat: expected.label,
    detectedFormat: detected.label,
    previewType: null,
    truncated: false,
  });
}

function expectedSignature(fileName, detected) {
  const expected = expectedFor(fileName);
  const possibleEncryptedModernOffice = expected?.profile && detected.family === 'ole';
  const document = expected && expected.family !== detected.family && !possibleEncryptedModernOffice
    ? mismatch(expected, detected)
    : null;
  return { expected, possibleEncryptedModernOffice, document };
}

function reasonFrom(error) {
  return error?.reason ?? error?.code ?? 'PREVIEW_IO_FAILED';
}

export async function assessRecoveredBytes(fileName, bytes, { signal } = {}) {
  cancelled(signal);
  if (!Buffer.isBuffer(bytes)) return baseDocument('needs-check', 'unknown', {
    reason: 'INVALID_PREVIEW_BYTES', previewType: null, truncated: false,
  });
  if (bytes.length === 0) return baseDocument('needs-check', 'empty', {
    reason: 'EMPTY_FILE', previewType: null, truncated: false,
  });
  if (bytes.length > MAX_ASSESS_BYTES) {
    const detected = detectedSignature(bytes.subarray(0, 16));
    return expectedSignature(fileName, detected).document ?? baseDocument('needs-check', detected.label, {
      reason: 'FILE_TOO_LARGE', previewType: null, truncated: false, assessmentLimited: true,
    });
  }

  const detected = detectedSignature(bytes);
  const signature = expectedSignature(fileName, detected);
  if (signature.document) return signature.document;

  let preview;
  try {
    preview = await previewBytes(fileName, bytes, { maxBytes: MAX_ASSESS_BYTES, signal, sourceIdentityVerified: true });
  } catch (error) {
    if (error?.code === 'CANCELLED') throw error;
    preview = { type: 'unsupported', reason: reasonFrom(error) };
  }
  cancelled(signal);

  if (preview?.type === 'text' || preview?.type === 'image') {
    const format = preview.validation?.format ?? detected.label;
    return baseDocument('preview-available', format, {
      detectedFormat: format,
      previewType: preview.type,
      truncated: preview.truncated === true,
      assessmentLimited: preview.truncated === true,
      checks: Array.isArray(preview.validation?.checks) ? [...preview.validation.checks] : [],
    });
  }

  const reason = preview?.reason ?? 'PREVIEW_IO_FAILED';
  if (signature.expected?.profile && reason === 'DOCUMENT_STRUCTURE_UNSUPPORTED') {
    return mismatch(signature.expected, detected, 'DOCUMENT_PROFILE_MISMATCH');
  }
  if (signature.possibleEncryptedModernOffice && !PROTECTED_REASONS.has(reason)) {
    return mismatch(signature.expected, detected, 'DOCUMENT_PROFILE_MISMATCH');
  }
  const format = preview?.validation?.format && preview.validation.format !== 'unknown'
    ? preview.validation.format : detected.label;
  const status = PROTECTED_REASONS.has(reason) ? 'protected'
    : DAMAGED_REASONS.has(reason) ? 'damaged' : 'needs-check';
  return baseDocument(status, format, {
    reason,
    previewType: null,
    truncated: false,
    checks: Array.isArray(preview?.validation?.checks) ? [...preview.validation.checks] : [],
  });
}

export async function verifyRecoveredFile(filePath, {
  expectedSize, expectedSha256, fileName, signal, control, onProgress,
} = {}) {
  cancelled(signal);
  const wantedSize = expectedSizeAsBigInt(expectedSize);
  const wantedHash = expectedHash(expectedSha256);
  const target = path.resolve(String(filePath ?? ''));
  let handle;
  let before;
  let resolved;
  let assessedBytes = null;
  let header = Buffer.alloc(0);
  try {
    const link = await lstat(target, { bigint: true });
    requireRegular(link, 'OUTPUT_NOT_REGULAR_FILE');
    resolved = await realpath(target);
    before = await lstat(resolved, { bigint: true });
    requireRegular(before, 'OUTPUT_REPARSE_POINT');
    if (!sameIdentity(link, before)) {
      throw verificationFailed('OUTPUT_PATH_CHANGED', '복구본 경로가 다른 파일로 이어져요.');
    }
    handle = await open(resolved, 'r');
    const opened = await handle.stat({ bigint: true });
    requireRegular(opened, 'OUTPUT_NOT_REGULAR_FILE');
    if (!sameIdentity(before, opened)) {
      throw verificationFailed('OUTPUT_PATH_CHANGED', '복구본이 확인 직전에 바뀌었어요.');
    }
    if (opened.size !== wantedSize) {
      throw verificationFailed('SIZE_MISMATCH', '복구본 크기가 저장한 크기와 다릅니다.', {
        expectedSize: wantedSize.toString(), actualSize: opened.size.toString(),
      });
    }
    if (opened.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw verificationFailed('FILE_SIZE_UNSUPPORTED', '파일이 너무 커서 안전하게 확인할 수 없어요.');
    }

    const size = Number(opened.size);
    if (size <= MAX_ASSESS_BYTES) assessedBytes = Buffer.alloc(size);
    const io = Buffer.allocUnsafe(Math.max(1, Math.min(READ_CHUNK_BYTES, size || 1)));
    const hash = createHash('sha256');
    let position = 0;
    emit(onProgress, 0, size);
    while (position < size) {
      await checkpoint(control, signal);
      const length = Math.min(io.length, size - position);
      const { bytesRead } = await handle.read(io, 0, length, position);
      if (bytesRead <= 0) {
        throw verificationFailed('READBACK_TRUNCATED', '복구본이 확인 중에 짧아졌어요.', { bytesChecked: position });
      }
      const part = io.subarray(0, bytesRead);
      hash.update(part);
      if (assessedBytes) part.copy(assessedBytes, position);
      if (position === 0) header = Buffer.from(part.subarray(0, 16));
      position += bytesRead;
      emit(onProgress, position, size);
      await new Promise(resolve => setImmediate(resolve));
    }
    await checkpoint(control, signal);

    const afterHandle = await handle.stat({ bigint: true });
    const afterPath = await lstat(target, { bigint: true });
    const afterResolvedPath = await realpath(target);
    const afterResolved = await lstat(afterResolvedPath, { bigint: true });
    requireRegular(afterHandle, 'OUTPUT_CHANGED');
    requireRegular(afterPath, 'OUTPUT_PATH_CHANGED');
    requireRegular(afterResolved, 'OUTPUT_PATH_CHANGED');
    if (afterResolvedPath !== resolved || !sameIdentity(before, afterHandle)
      || !sameIdentity(before, afterPath) || !sameIdentity(before, afterResolved)) {
      throw verificationFailed('OUTPUT_CHANGED', '복구본이 확인 중에 바뀌었어요.');
    }

    const sha256 = hash.digest('hex');
    if (sha256 !== wantedHash) {
      throw verificationFailed('SHA256_MISMATCH', '복구본 내용이 저장한 내용과 다릅니다.', {
        expectedSha256: wantedHash, actualSha256: sha256,
      });
    }

    const assessmentName = fileName ?? path.basename(target);
    const document = assessedBytes
      ? await assessRecoveredBytes(assessmentName, assessedBytes, { signal })
      : (() => {
        const detected = detectedSignature(header);
        return expectedSignature(assessmentName, detected).document ?? baseDocument('needs-check', detected.label, {
          reason: 'FILE_TOO_LARGE', previewType: null, truncated: false, assessmentLimited: true,
        });
      })();
    return {
      integrity: { status: 'verified', sha256, size, identity: identityOf(afterHandle) },
      document,
    };
  } catch (error) {
    if (error?.code === 'CANCELLED' || error?.code === 'OUTPUT_VERIFICATION_FAILED') throw error;
    throw verificationFailed('READBACK_IO_FAILED', '복구본을 다시 읽어 확인하지 못했어요.', { cause: error?.code ?? null });
  } finally {
    await handle?.close().catch(() => {});
  }
}
