import { open, realpath, stat } from 'node:fs/promises';
import { RecoveryError } from './ntfs-image.mjs';

export async function openImageBytes(filePath) {
  if (typeof filePath !== 'string' || /^(?:\\\\[.?]\\|\/\/[.?]\/)/.test(filePath)) throw new RecoveryError('IMAGE_ONLY', '일반 이미지 파일이 필요해요.');
  const canonicalPath = await realpath(filePath);
  const initial = await stat(canonicalPath, { bigint: true });
  if (!initial.isFile() || initial.size <= 0n || initial.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new RecoveryError('IMAGE_ONLY', '지원하는 크기의 이미지 파일이 필요해요.');
  const file = await open(canonicalPath, 'r');
  let closed = false;
  const check = async () => {
    if (closed) throw new RecoveryError('CLOSED', '닫힌 원본이에요.');
    const [current, named] = await Promise.all([file.stat({ bigint: true }), stat(canonicalPath, { bigint: true })]);
    if ([current, named].some(value => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(key => value[key] !== initial[key]))) throw new RecoveryError('SOURCE_CHANGED', '이미지 파일이 바뀌었어요. 다시 검색해주세요.');
  };
  try { await check(); } catch (error) { await file.close(); throw error; }
  return {
    info: { size: Number(initial.size), sectorSize: 512, identity: `${initial.dev}:${initial.ino}:${initial.size}:${initial.mtimeNs}`,
      checkpointIdentity: `${initial.dev}:${initial.ino}:${initial.size}:${initial.mtimeNs}:${initial.ctimeNs}`, sourceKind: 'image' },
    assertUnchanged: check,
    async read(offset, length, { signal } = {}) {
      if (signal?.aborted) throw new RecoveryError('CANCELLED', '작업을 취소했어요.');
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || length > 1048576 || offset + length > Number(initial.size)) throw new RecoveryError('INVALID_RANGE', '읽기 범위가 잘못됐어요.');
      const bytes = Buffer.alloc(length);
      let read = 0;
      while (read < length) {
        if (signal?.aborted) throw new RecoveryError('CANCELLED', '작업을 취소했어요.');
        const result = await file.read(bytes, read, length - read, offset + read);
        if (!result.bytesRead) throw new RecoveryError('READ_FAILED', '원본을 끝까지 읽지 못했어요.');
        read += result.bytesRead;
      }
      return bytes;
    },
    async close() { if (!closed) { closed = true; await file.close(); } }
  };
}
