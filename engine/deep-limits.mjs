import { RecoveryError } from './ntfs-image.mjs';

// Undefined preserves full search. Explicit bounds are checked before a worker
// starts or any extraction files are created.
export function normalizeDeepLimits(value) {
  if (value === undefined) return {};
  const allowed = new Set(['maxScanBytes', 'maxOutputBytes']);
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !allowed.has(key))) {
    throw new RecoveryError('INVALID_DEEP_LIMITS', '정밀 검색 제한 값이 올바르지 않아요.');
  }
  const result = {};
  for (const key of allowed) if (Object.hasOwn(value, key)) {
    if (!Number.isSafeInteger(value[key]) || value[key] <= 0) {
      throw new RecoveryError('INVALID_DEEP_LIMITS', '검색·추출 한도는 0보다 큰 정수 바이트여야 해요.');
    }
    result[key] = value[key];
  }
  return result;
}
