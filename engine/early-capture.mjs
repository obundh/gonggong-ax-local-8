import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, open, readFile, realpath, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { RecoveryError, safeOutputName } from './ntfs-image.mjs';
import { chooseRecoveryName } from './recovery-name.mjs';
import { verifyRecoveredFile } from './recovery-verification.mjs';
import { candidateCaptureKey } from './capture-link.mjs';

export const CAPTURE_LIMITS = Object.freeze({ maxFileBytes: 16 * 1024 * 1024,
  maxBytes: 256 * 1024 * 1024, maxAttempts: 64, maxMilliseconds: 20000 });
const extensions = new Set(['.pdf', '.hwp', '.hwpx', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.txt', '.rtf', '.csv', '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp']);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const identity = info => `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}`;
const fail = (code, message) => { throw new RecoveryError(code, message); };
const inside = (root, file) => { const rel = path.relative(root, file); return rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); };
const stop = signal => { if (signal?.aborted) fail('CANCELLED', '작업을 취소했어요.'); };
async function writeSynced(file, bytes, signal) {
  const handle = await open(file, 'wx', 0o600);
  try { await handle.writeFile(bytes, { signal }); await handle.sync(); } finally { await handle.close(); }
}

// This store is enabled only after the job service proves its workspace lives
// on a different physical disk. Discovery never supplies a destination path.
export class EarlyCaptureStore {
  constructor(root, { limits = CAPTURE_LIMITS, signal, control, onProgress } = {}) {
    this.root = path.resolve(root); this.limits = { ...CAPTURE_LIMITS, ...limits };
    for (const [key, value] of Object.entries(this.limits)) {
      if (!Number.isSafeInteger(value) || value < 1 || value > CAPTURE_LIMITS[key]) fail('INVALID_LIMIT', '즉시 확보 한도가 잘못됐어요.');
    }
    this.signal = signal; this.control = control; this.onProgress = onProgress;
    this.entries = new Map(); this.stats = { attempted: 0, captured: 0, failed: 0, skipped: 0,
      bytesCaptured: 0, bytesReserved: 0, elapsedMs: 0, limited: false };
  }
  async initialize() {
    const actual = await realpath(this.root);
    if (actual !== this.root || !(await stat(actual)).isDirectory()) fail('UNSAFE_OUTPUT', '즉시 확보 저장 위치가 바뀌었어요.');
    this.rootIdentity = identity(await stat(this.root, { bigint: true })).split(':').slice(0, 2).join(':');
  }
  async checkRoot() {
    if (await realpath(this.root) !== this.root || identity(await stat(this.root, { bigint: true })).split(':').slice(0, 2).join(':') !== this.rootIdentity) {
      fail('DESTINATION_CHANGED', '즉시 확보 저장 위치가 바뀌었어요.');
    }
  }
  has(id) { return this.entries.has(id); }
  assertLink(id, { key, sha256 } = {}) {
    const entry = this.entries.get(id);
    if (!entry) fail('CAPTURE_MISSING', '이 후보의 이전 확보 본문이 없어요. 다시 검색해주세요.');
    if (!key || entry.candidateKey !== key || entry.output.sha256 !== sha256
      || entry.output.document?.status !== 'preview-available') {
      fail('CAPTURE_LINK_CHANGED', '이전 확보 본문과 파일 기록의 연결을 확인하지 못했어요.');
    }
  }
  async capture(candidate, captureTo) {
    stop(this.signal);
    const naming = chooseRecoveryName(candidate);
    const size = candidate.size;
    if (!extensions.has(path.extname(naming.name).toLowerCase()) || !Number.isSafeInteger(size) || size < 1 || size > this.limits.maxFileBytes) {
      this.stats.skipped++; return null;
    }
    if (this.stats.attempted >= this.limits.maxAttempts || this.stats.bytesReserved + size > this.limits.maxBytes
      || this.stats.elapsedMs >= this.limits.maxMilliseconds) {
      this.stats.skipped++; this.stats.limited = true;
      return { preservation: { status: 'skipped', reason: 'capture-budget' } };
    }
    this.stats.attempted++; this.stats.bytesReserved += size;
    const started = performance.now(), capturedAt = new Date().toISOString();
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), Math.max(1, this.limits.maxMilliseconds - this.stats.elapsedMs));
    const signal = this.signal ? AbortSignal.any([this.signal, timeout.signal]) : timeout.signal;
    const control = { checkpoint: async () => { stop(signal); await this.control?.checkpoint(); stop(signal); } };
    try {
      await this.checkRoot();
      this.onProgress?.({ stage: 'capture', stats: { ...this.stats } });
      const output = await captureTo(this.root, { signal, control, outputName: naming.name });
      stop(signal); await this.checkRoot();
      const actual = await realpath(output.path);
      if (!inside(this.root, actual) || actual !== output.path || output.status !== 'saved'
        || output.size !== size || output.integrity?.status !== 'verified') fail('CAPTURE_UNVERIFIED', '확보한 본문의 저장 상태를 확인하지 못했어요.');
      const streams = [];
      for (const stream of output.supplementalStreams ?? []) {
        if (stream.name !== 'Zone.Identifier' || stream.size > 512) fail('STREAM_PRESERVATION_FAILED', '보조 스트림을 보존할 수 없어요.');
        const bytes = await readFile(`${actual}:Zone.Identifier`, { signal });
        if (bytes.length !== stream.size) fail('STREAM_PRESERVATION_FAILED', '보조 스트림 크기가 바뀌었어요.');
        streams.push({ name: stream.name, bytes });
      }
      this.entries.set(candidate.id, { output, candidateKey: candidateCaptureKey(candidate),
        identity: identity(await stat(actual, { bigint: true })), streams, capturedAt });
      this.stats.captured++; this.stats.bytesCaptured += size;
      return { status: 'readable', storage: 'captured', preservation: { status: 'captured', capturedAt,
        size, sha256: output.sha256, documentStatus: output.document?.status ?? 'not-verified', originalIdentityVerified: false },
      reasons: [...candidate.reasons, '발견 시점의 본문을 별도 디스크에 확보했어요. 정상 문서인지와 원본 동일 여부는 별도 확인이 필요해요.'] };
    } catch (error) {
      if (this.signal?.aborted) throw error;
      this.stats.failed++;
      return { preservation: { status: 'failed', code: timeout.signal.aborted ? 'CAPTURE_TIME_LIMIT' : error.code ?? 'CAPTURE_FAILED',
        message: error.message, capturedAt } };
    } finally { clearTimeout(timer); this.stats.elapsedMs += performance.now() - started; }
  }
  async read(id, { signal } = {}) {
    stop(signal); await this.checkRoot();
    const entry = this.entries.get(id);
    if (!entry) fail('CAPTURE_MISSING', '이 후보의 확보 본문이 없어요.');
    const file = entry.output.path;
    if (await realpath(file) !== file || !inside(this.root, file)) fail('CAPTURE_CHANGED', '확보 본문의 위치가 바뀌었어요.');
    const handle = await open(file, 'r');
    let bytes;
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || identity(before) !== entry.identity) fail('CAPTURE_CHANGED', '확보 본문이 변경됐어요.');
      bytes = Buffer.alloc(entry.output.size);
      let offset = 0;
      while (offset < bytes.length) {
        stop(signal);
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) fail('CAPTURE_CHANGED', '확보 본문을 끝까지 읽지 못했어요.');
        offset += bytesRead;
      }
      if (identity(await handle.stat({ bigint: true })) !== entry.identity) fail('CAPTURE_CHANGED', '확보 본문이 읽는 중 바뀌었어요.');
    } finally { await handle.close(); }
    if (await realpath(file) !== file || identity(await stat(file, { bigint: true })) !== entry.identity
      || digest(bytes) !== entry.output.sha256) fail('CAPTURE_CHANGED', '확보 본문의 해시가 바뀌었어요.');
    for (const stream of entry.streams) {
      if (!(await readFile(`${file}:${stream.name}`, { signal })).equals(stream.bytes)) fail('CAPTURE_CHANGED', '확보 본문의 보조 스트림이 바뀌었어요.');
    }
    stop(signal); return bytes;
  }
  async recover(id, destination, { signal, control, onProgress, outputName } = {}) {
    const bytes = await this.read(id, { signal });
    const entry = this.entries.get(id);
    await control?.checkpoint(); stop(signal);
    const canonical = await realpath(destination);
    const folder = await mkdtemp(path.join(canonical, '.capture-writing-'));
    const file = path.join(folder, safeOutputName(outputName ?? path.basename(entry.output.path), id));
    await writeSynced(file, bytes, signal);
    for (const stream of entry.streams) {
      if (process.platform !== 'win32') fail('STREAM_PRESERVATION_FAILED', '보조 스트림을 보존할 수 있는 Windows 저장 위치가 필요해요.');
      await writeSynced(`${file}:${stream.name}`, stream.bytes, signal);
      if (!(await readFile(`${file}:${stream.name}`, { signal })).equals(stream.bytes)) fail('STREAM_PRESERVATION_FAILED', '저장한 보조 스트림을 확인하지 못했어요.');
    }
    const verification = await verifyRecoveredFile(file, { expectedSize: bytes.length,
      expectedSha256: entry.output.sha256, fileName: path.basename(file), signal, control, onProgress });
    stop(signal);
    const published = path.join(canonical, `recovered-${randomUUID()}`);
    await rename(folder, published);
    return { path: path.join(published, path.basename(file)), status: 'saved', size: bytes.length,
      sha256: entry.output.sha256, ...verification, originalIdentityVerified: false,
      supplementalStreams: entry.output.supplementalStreams ?? [],
      preservation: { source: 'discovery-capture', capturedAt: entry.capturedAt, sha256: entry.output.sha256 },
      validation: 'captured-bytes-reread-and-hash-matched; original-content-not-verified' };
  }
}
