import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink
} from 'node:fs/promises';
import path from 'node:path';

const IMAGE_FILE = 'image.raw';
const MANIFEST_FILE = 'acquisition.json';
const JOURNAL_FILE = 'acquisition.journal';
const MAX_READER_READ = 1024 * 1024;
const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
const JOURNAL_BUFFER_SIZE = 64 * 1024;
const MAX_JOURNAL_LINE = 16 * 1024;
const TERMINAL_SOURCE_CODES = new Set([
  'SOURCE_CHANGED', 'SOURCE_DISCONNECTED', 'DEVICE_DISCONNECTED', 'SOURCE_UNAVAILABLE',
  'DEVICE_CHANGED', 'GEOMETRY_CHANGED', 'INVALID_GEOMETRY', 'INVALID_READ',
  'LENGTH_QUERY_FAILED', 'GEOMETRY_QUERY_FAILED', 'EXTENTS_QUERY_FAILED', 'IDENTITY_QUERY_FAILED',
  'HELPER_CLOSED', 'HELPER_TIMEOUT', 'HELPER_FAILED', 'HELPER_PROTOCOL', 'HELPER_PROTOCOL_LIMIT',
  'READ_TIMEOUT',
  'CLOSED', 'ENODEV', 'ENXIO', 'ERROR_DEVICE_NOT_CONNECTED'
]);
const STABLE_RESUME_KINDS = new Set(['image', 'file', 'image-file', 'raw-image']);
const UNTRUSTED_OUTPUT_CODES = new Set([
  'OUTPUT_CHANGED', 'UNSAFE_OUTPUT', 'IMAGE_TAMPERED', 'JOURNAL_TAMPERED',
  'OUTPUT_VERIFY_FAILED', 'INVALID_MANIFEST'
]);

export class ImageAcquisitionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ImageAcquisitionError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new ImageAcquisitionError(code, message, details);
}

function errorCode(error, fallback = 'READ_FAILED') {
  return typeof error?.code === 'string' && /^[A-Z0-9_]{1,128}$/.test(error.code) ? error.code : fallback;
}

function abortError() {
  return new ImageAcquisitionError('CANCELLED', 'Image acquisition was cancelled.');
}

function checkAbort(signal) {
  if (signal?.aborted) throw abortError();
}

function isoNow(now) {
  const value = typeof now === 'function' ? now() : now;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) fail('INVALID_OPTION', 'The acquisition clock returned an invalid date.');
  return date.toISOString();
}

function integer(name, value, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail('INVALID_OPTION', `${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function normalizeOptions(options) {
  const readSize = integer('readSize', options.readSize ?? MAX_READER_READ, 4096, MAX_READER_READ);
  const checkpointSize = integer('checkpointSize', options.checkpointSize ?? 16 * MAX_READER_READ, readSize, 256 * MAX_READER_READ);
  if (checkpointSize % readSize !== 0) fail('INVALID_OPTION', 'checkpointSize must be a multiple of readSize.');
  return {
    readSize,
    checkpointSize,
    maxReadAttempts: integer('maxReadAttempts', options.maxReadAttempts ?? 3, 1, 16),
    readTimeoutMs: integer('readTimeoutMs', options.readTimeoutMs ?? 30_000, 10, 300_000),
    retryDelayMs: integer('retryDelayMs', options.retryDelayMs ?? 50, 0, 5_000),
    maxDurationMs: integer('maxDurationMs', options.maxDurationMs ?? 86_400_000, 100, 604_800_000),
    maxErrorRanges: integer('maxErrorRanges', options.maxErrorRanges ?? 4096, 1, 65_536)
  };
}

function normalizePath(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function directoryFingerprint(info) {
  return `${info.dev}:${info.ino}`;
}

async function inspectOutputDirectory(outputDirectory) {
  if (typeof outputDirectory !== 'string' || !path.isAbsolute(outputDirectory)) {
    fail('UNSAFE_OUTPUT', 'outputDirectory must be an existing absolute directory.');
  }
  const resolved = path.resolve(outputDirectory);
  if (normalizePath(resolved) === normalizePath(path.parse(resolved).root)) fail('UNSAFE_OUTPUT', 'A filesystem root cannot be an acquisition directory.');
  const named = await lstat(resolved, { bigint: true }).catch(error => {
    throw new ImageAcquisitionError('UNSAFE_OUTPUT', `The output directory is unavailable: ${error.message}`);
  });
  if (named.isSymbolicLink() || !named.isDirectory()) fail('UNSAFE_OUTPUT', 'The output path must be a real directory, not a link.');
  const canonical = await realpath(resolved);
  if (normalizePath(canonical) !== normalizePath(resolved)) fail('UNSAFE_OUTPUT', 'The output directory resolves to another path.');
  const current = await stat(canonical, { bigint: true });
  return { resolved, canonical, fingerprint: directoryFingerprint(current) };
}

async function assertOutputDirectory(snapshot) {
  const named = await lstat(snapshot.resolved, { bigint: true }).catch(() => null);
  if (!named || named.isSymbolicLink() || !named.isDirectory()) fail('OUTPUT_CHANGED', 'The output directory was removed or replaced.');
  const [canonical, current] = await Promise.all([realpath(snapshot.resolved), stat(snapshot.resolved, { bigint: true })]);
  if (normalizePath(canonical) !== normalizePath(snapshot.canonical) || directoryFingerprint(current) !== snapshot.fingerprint) {
    fail('OUTPUT_CHANGED', 'The output directory was replaced during acquisition.');
  }
}

function pathsFor(directory) {
  return {
    image: path.join(directory, IMAGE_FILE),
    manifest: path.join(directory, MANIFEST_FILE),
    journal: path.join(directory, JOURNAL_FILE)
  };
}

async function assertRegularOwnedFile(filePath, code = 'OUTPUT_CHANGED') {
  const info = await lstat(filePath, { bigint: true }).catch(() => null);
  if (!info || info.isSymbolicLink() || !info.isFile() || info.nlink !== 1n) {
    fail(code, `${path.basename(filePath)} is missing, linked, or was replaced.`);
  }
  return info;
}

async function assertHandleStillNamed(handle, filePath) {
  const [named, opened] = await Promise.all([assertRegularOwnedFile(filePath), handle.stat({ bigint: true })]);
  if (opened.nlink !== 1n || named.dev !== opened.dev || named.ino !== opened.ino) {
    fail('OUTPUT_CHANGED', `${path.basename(filePath)} was linked or replaced during acquisition.`);
  }
  return opened;
}

function sameStableFile(before, after) {
  return ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'nlink'].every(key => before[key] === after[key]);
}

async function assertFileSnapshot(handle, filePath, before) {
  await assertHandleStillNamed(handle, filePath);
  const after = await handle.stat({ bigint: true });
  if (!sameStableFile(before, after)) fail('OUTPUT_CHANGED', `${path.basename(filePath)} changed during verification.`);
}

async function assertPathSnapshot(filePath, before) {
  const after = await assertRegularOwnedFile(filePath);
  if (!sameStableFile(before, after)) fail('OUTPUT_CHANGED', `${path.basename(filePath)} changed during verification.`);
}

function cloneDevice(value) {
  if (value === undefined) return null;
  let text;
  try { text = JSON.stringify(value); } catch { fail('INVALID_SOURCE', 'source.device must be JSON data.'); }
  if (text === undefined || Buffer.byteLength(text) > 64 * 1024) fail('INVALID_SOURCE', 'source.device is too large or invalid.');
  return JSON.parse(text);
}

function validateSource(reader, source) {
  if (!reader || typeof reader.read !== 'function' || typeof reader.assertUnchanged !== 'function') {
    fail('INVALID_READER', 'reader must provide read() and assertUnchanged().');
  }
  const info = reader.info;
  if (!info || !Number.isSafeInteger(info.size) || info.size <= 0) fail('INVALID_READER', 'reader.info.size must be a positive safe integer.');
  if (typeof info.identity !== 'string' || !info.identity || info.identity.length > 4096) fail('INVALID_READER', 'reader.info.identity is invalid.');
  if (typeof info.sourceKind !== 'string' || !info.sourceKind || info.sourceKind.length > 128) fail('INVALID_READER', 'reader.info.sourceKind is required.');
  if (!Number.isSafeInteger(info.sectorSize) || info.sectorSize <= 0 || info.sectorSize > MAX_READER_READ) {
    fail('INVALID_READER', 'reader.info.sectorSize is invalid.');
  }
  if (!source || source.identity !== info.identity || source.kind !== info.sourceKind) {
    fail('SOURCE_MISMATCH', 'The selected source does not match the opened byte reader.');
  }
  if (typeof source.label !== 'string' || !source.label.trim() || source.label.length > 1024) fail('INVALID_SOURCE', 'source.label is required.');
  return {
    identity: info.identity,
    kind: source.kind,
    label: source.label,
    device: cloneDevice(source.device),
    size: info.size,
    sectorSize: info.sectorSize
  };
}

function safeProgress(callback, value) {
  if (typeof callback !== 'function') return;
  try { callback(Object.freeze({ ...value })); } catch { /* UI callbacks do not own acquisition state. */ }
}

async function delay(ms, signal) {
  checkAbort(signal);
  if (!ms) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() { signal?.removeEventListener('abort', cancelled); resolve(); }
    function cancelled() { clearTimeout(timer); signal?.removeEventListener('abort', cancelled); reject(abortError()); }
    signal?.addEventListener('abort', cancelled, { once: true });
    if (signal?.aborted) cancelled();
  });
}

async function timedRead(reader, offset, length, timeoutMs, signal) {
  checkAbort(signal);
  const controller = new AbortController();
  let timedOut = false;
  let rejectTimeout;
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  const onAbort = () => { controller.abort(); rejectAbort(abortError()); };
  signal?.addEventListener('abort', onAbort, { once: true });
  const timeout = new Promise((_, reject) => { rejectTimeout = reject; });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    rejectTimeout(new ImageAcquisitionError('READ_TIMEOUT', `Read at ${offset} timed out.`));
  }, timeoutMs);
  try {
    const value = await Promise.race([
      Promise.resolve().then(() => reader.read(offset, length, { signal: controller.signal })),
      timeout,
      aborted
    ]);
    checkAbort(signal);
    const bytes = Buffer.isBuffer(value) ? value : value instanceof Uint8Array ? Buffer.from(value) : null;
    if (!bytes || bytes.length !== length) {
      throw new ImageAcquisitionError('SHORT_READ', `Reader returned ${bytes?.length ?? 'non-byte'} bytes for a ${length}-byte request.`);
    }
    return bytes;
  } catch (error) {
    if (signal?.aborted) throw abortError();
    if (timedOut && errorCode(error) === 'CANCELLED') throw new ImageAcquisitionError('READ_TIMEOUT', `Read at ${offset} timed out.`);
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

async function readWithRetries(reader, offset, length, settings, signal) {
  let lastError;
  for (let attempt = 1; attempt <= settings.maxReadAttempts; attempt += 1) {
    try { return { bytes: await timedRead(reader, offset, length, settings.readTimeoutMs, signal), attempts: attempt }; }
    catch (error) {
      if (errorCode(error) === 'CANCELLED' || TERMINAL_SOURCE_CODES.has(errorCode(error))) throw error;
      lastError = error;
      if (attempt < settings.maxReadAttempts) await delay(settings.retryDelayMs, signal);
    }
  }
  return { error: lastError, attempts: settings.maxReadAttempts };
}

async function writeFully(handle, bytes, position, testHook) {
  let written = 0;
  try {
    while (written < bytes.length) {
      const result = testHook
        ? await testHook({ handle, buffer: bytes, offset: written, length: bytes.length - written, position: position + written })
        : await handle.write(bytes, written, bytes.length - written, position + written);
      const count = Number(result?.bytesWritten ?? 0);
      if (!Number.isInteger(count) || count <= 0 || count > bytes.length - written) {
        throw new ImageAcquisitionError('SHORT_WRITE', `Output accepted only ${written} of ${bytes.length} bytes.`, { written });
      }
      written += count;
    }
    return written;
  } catch (error) {
    if (error instanceof ImageAcquisitionError && error.code === 'SHORT_WRITE') throw error;
    const wrapped = new ImageAcquisitionError(errorCode(error, 'OUTPUT_WRITE_FAILED'), `Output write failed at ${position + written}: ${error.message}`, { written });
    wrapped.cause = error;
    throw wrapped;
  }
}

async function syncDirectory(directory) {
  let handle;
  try { handle = await open(directory, 'r'); await handle.sync(); } catch { /* Some Windows filesystems do not fsync directories. */ }
  finally { await handle?.close().catch(() => {}); }
}

async function writeManifestAtomic(snapshot, filePaths, manifest, testHook) {
  await assertOutputDirectory(snapshot);
  const existing = await lstat(filePaths.manifest, { bigint: true }).catch(() => null);
  if (existing && (existing.isSymbolicLink() || !existing.isFile() || existing.nlink !== 1n)) fail('OUTPUT_CHANGED', 'acquisition.json was linked or replaced.');
  if (existing) {
    if (existing.size > BigInt(MAX_MANIFEST_BYTES)) fail('OUTPUT_CHANGED', 'The existing acquisition manifest is too large.');
    let previous;
    try { previous = JSON.parse(await readFile(filePaths.manifest, 'utf8')); } catch { fail('OUTPUT_CHANGED', 'The existing acquisition manifest is unreadable.'); }
    if (previous.acquisitionId !== manifest.acquisitionId) fail('OUTPUT_CHANGED', 'The acquisition manifest belongs to another acquisition.');
  }
  const temporary = path.join(snapshot.canonical, `.acquisition-${manifest.acquisitionId}-${randomUUID()}.tmp`);
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  if (bytes.length > MAX_MANIFEST_BYTES) fail('MANIFEST_LIMIT', 'The bounded acquisition manifest is full.');
  let handle;
  try {
    handle = await open(temporary, 'wx');
    await writeFully(handle, bytes, 0, testHook);
    await handle.sync();
    await handle.close();
    handle = null;
    await assertOutputDirectory(snapshot);
    await rename(temporary, filePaths.manifest);
    await syncDirectory(snapshot.canonical);
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {}); // Exact module-owned temporary only.
    // Never turn an existing valid checkpoint into a zero-length or partial
    // manifest merely to record a destination-full error. The caller rolls
    // back the uncommitted image/journal chunk, leaving this prior checkpoint
    // independently verifiable and resumable.
    throw error;
  }
}

function journalCore(sequence, offset, length, sha256, hadReadErrors) {
  return { type: 'chunk', sequence, offset, length, sha256, hadReadErrors: Boolean(hadReadErrors) };
}

function chainedRecord(core, previous) {
  const chainSha256 = createHash('sha256').update(previous).update('\n').update(JSON.stringify(core)).digest('hex');
  return { ...core, previousChainSha256: previous, chainSha256 };
}

function validateRecord(record, expected, previous) {
  if (!record || record.type !== 'chunk' || record.sequence !== expected.sequence || record.offset !== expected.offset ||
      !Number.isSafeInteger(record.length) || record.length <= 0 || !/^[0-9a-f]{64}$/.test(record.sha256 || '') ||
      record.previousChainSha256 !== previous) fail('JOURNAL_TAMPERED', 'The acquisition journal is malformed or discontinuous.');
  const core = journalCore(record.sequence, record.offset, record.length, record.sha256, record.hadReadErrors);
  const expectedChain = chainedRecord(core, previous).chainSha256;
  if (record.chainSha256 !== expectedChain) fail('JOURNAL_TAMPERED', 'The acquisition journal hash chain does not match.');
  return core;
}

async function readJournal(handle, byteLimit, callback) {
  if (!Number.isSafeInteger(byteLimit) || byteLimit < 0) fail('INVALID_MANIFEST', 'The journal byte count is invalid.');
  let position = 0;
  let pending = Buffer.alloc(0);
  while (position < byteLimit) {
    const length = Math.min(JOURNAL_BUFFER_SIZE, byteLimit - position);
    const buffer = Buffer.alloc(length);
    const result = await handle.read(buffer, 0, length, position);
    if (result.bytesRead !== length) fail('JOURNAL_TAMPERED', 'The acquisition journal is shorter than its manifest.');
    position += length;
    pending = pending.length ? Buffer.concat([pending, buffer]) : buffer;
    if (pending.length > MAX_JOURNAL_LINE * 2 && !pending.includes(10)) fail('JOURNAL_TAMPERED', 'The acquisition journal contains an oversized record.');
    let newline;
    while ((newline = pending.indexOf(10)) >= 0) {
      const line = pending.subarray(0, newline);
      pending = pending.subarray(newline + 1);
      if (!line.length || line.length > MAX_JOURNAL_LINE) fail('JOURNAL_TAMPERED', 'The acquisition journal contains an invalid record.');
      let record;
      try { record = JSON.parse(line.toString('utf8')); } catch { fail('JOURNAL_TAMPERED', 'The acquisition journal contains invalid JSON.'); }
      await callback(record);
    }
  }
  if (pending.length) fail('JOURNAL_TAMPERED', 'The committed acquisition journal ends mid-record.');
}

async function hashFileRange(handle, offset, length, readSize, signal, onBytes) {
  const hash = createHash('sha256');
  let position = offset;
  while (position < offset + length) {
    checkAbort(signal);
    const size = Math.min(readSize, offset + length - position);
    const buffer = Buffer.alloc(size);
    const result = await handle.read(buffer, 0, size, position);
    if (result.bytesRead !== size) fail('IMAGE_TAMPERED', 'image.raw is shorter than the committed journal.');
    hash.update(buffer);
    onBytes?.(buffer, position);
    position += size;
  }
  return hash.digest('hex');
}

async function validateResumePrefix({ reader, rawHandle, journalHandle, manifest, settings, signal, onProgress }) {
  if (manifest.readErrors?.length || manifest.readErrorRangeCount) {
    fail('RESUME_PREFIX_UNVERIFIABLE', 'An acquisition with zero-filled read errors cannot be resumed as a same-source image.');
  }
  let sequence = 0;
  let offset = 0;
  let previous = '0'.repeat(64);
  const imageHash = createHash('sha256');
  await readJournal(journalHandle, manifest.checkpoint.journalBytes, async record => {
    const core = validateRecord(record, { sequence, offset }, previous);
    const sourceHash = createHash('sha256');
    const observed = await hashFileRange(rawHandle, core.offset, core.length, settings.readSize, signal, bytes => imageHash.update(bytes));
    if (observed !== core.sha256) fail('IMAGE_TAMPERED', `Output chunk ${sequence} no longer matches its checkpoint hash.`);
    let sourceOffset = core.offset;
    while (sourceOffset < core.offset + core.length) {
      const length = Math.min(settings.readSize, core.offset + core.length - sourceOffset);
      const read = await readWithRetries(reader, sourceOffset, length, settings, signal);
      if (read.error) fail('RESUME_SOURCE_UNREADABLE', `The source prefix cannot be verified at offset ${sourceOffset}.`, { causeCode: errorCode(read.error) });
      sourceHash.update(read.bytes);
      sourceOffset += length;
    }
    if (sourceHash.digest('hex') !== core.sha256) fail('SOURCE_CHANGED', `The source prefix changed in chunk ${sequence}.`);
    previous = record.chainSha256;
    sequence += 1;
    offset += core.length;
    safeProgress(onProgress, { phase: 'resume-verification', bytesProcessed: offset, totalBytes: manifest.source.size });
  });
  if (sequence !== manifest.checkpoint.chunkCount || offset !== manifest.checkpoint.bytesWritten || previous !== manifest.checkpoint.chainSha256) {
    fail('JOURNAL_TAMPERED', 'The journal summary does not match the committed records.');
  }
  return imageHash;
}

function appendReadError(manifest, entry, maximum) {
  const prior = manifest.readErrors.at(-1);
  if (prior && prior.offset + prior.length === entry.offset && prior.code === entry.code && prior.attempts === entry.attempts) {
    prior.length += entry.length;
    prior.lastAt = entry.lastAt;
  } else {
    if (manifest.readErrors.length >= maximum) fail('ERROR_LEDGER_LIMIT', 'The bounded read-error ledger is full; acquisition stopped before omitting an error range.');
    manifest.readErrors.push(entry);
  }
  manifest.readErrorRangeCount = manifest.readErrors.length;
  manifest.zeroFilledBytes += entry.length;
}

function initialManifest(source, settings, now) {
  const createdAt = isoNow(now);
  return {
    schema: 'recoverychat.raw-acquisition',
    version: 1,
    acquisitionId: randomUUID(),
    state: 'running',
    complete: false,
    createdAt,
    startedAt: createdAt,
    finishedAt: null,
    source,
    scope: {
      kind: 'volume-image',
      description: 'Selected volume or existing image bytes; not a whole physical disk image.',
      offset: 0,
      length: source.size,
      wholePhysicalDisk: false,
      includes: ['allocated-space', 'unallocated-space', 'filesystem-slack-within-selected-source'],
      excludes: ['bytes-outside-selected-volume-or-image']
    },
    image: { file: IMAGE_FILE, expectedSize: source.size, bytesWritten: 0, sha256: null, hashAlgorithm: 'SHA-256', readbackVerified: false },
    journal: { file: JOURNAL_FILE, format: 'newline-delimited-json-sha256-chain' },
    checkpoint: { bytesWritten: 0, chunkCount: 0, journalBytes: 0, chainSha256: '0'.repeat(64) },
    settings,
    readErrors: [],
    readErrorRangeCount: 0,
    zeroFilledBytes: 0,
    stopReason: null,
    resumeCount: 0,
    history: [{ event: 'started', at: createdAt }],
    limitations: [
      'A zero-filled read-error range is not evidence of TRIM or proof that the source contained zero bytes.',
      'A live volume can change outside this reader; read-only access does not freeze the filesystem or storage controller.'
    ]
  };
}

function validateManifestShape(manifest) {
  if (!manifest || manifest.schema !== 'recoverychat.raw-acquisition' || manifest.version !== 1 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(manifest.acquisitionId || '') ||
      !manifest.source || !manifest.image || !manifest.checkpoint || !manifest.settings) {
    fail('INVALID_MANIFEST', 'acquisition.json is not a supported acquisition manifest.');
  }
  if (!['running', 'complete', 'partial', 'cancelled', 'error'].includes(manifest.state) || typeof manifest.complete !== 'boolean' ||
      !Number.isSafeInteger(manifest.source.size) || manifest.source.size <= 0 ||
      typeof manifest.source.identity !== 'string' || !manifest.source.identity || manifest.source.identity.length > 4096 ||
      typeof manifest.source.kind !== 'string' || !manifest.source.kind || manifest.source.kind.length > 128 ||
      typeof manifest.source.label !== 'string' || !manifest.source.label || manifest.source.label.length > 1024) {
    fail('INVALID_MANIFEST', 'The manifest source or state is invalid.');
  }
  if (!manifest.scope || manifest.scope.kind !== 'volume-image' || manifest.scope.offset !== 0 ||
      manifest.scope.length !== manifest.source.size || manifest.scope.wholePhysicalDisk !== false ||
      manifest.image.expectedSize !== manifest.source.size ||
      (manifest.image.sha256 !== null && !/^[0-9a-f]{64}$/.test(manifest.image.sha256 || ''))) {
    fail('INVALID_MANIFEST', 'The manifest image scope or hash is invalid.');
  }
  if (manifest.image.file !== IMAGE_FILE || manifest.journal?.file !== JOURNAL_FILE) fail('INVALID_MANIFEST', 'The manifest names unexpected artifact files.');
  if (!Number.isSafeInteger(manifest.checkpoint.bytesWritten) || manifest.checkpoint.bytesWritten < 0 ||
      manifest.checkpoint.bytesWritten > manifest.source.size || manifest.image.bytesWritten !== manifest.checkpoint.bytesWritten ||
      !Number.isSafeInteger(manifest.checkpoint.chunkCount) || manifest.checkpoint.chunkCount < 0 ||
      !Number.isSafeInteger(manifest.checkpoint.journalBytes) || manifest.checkpoint.journalBytes < 0 ||
      !/^[0-9a-f]{64}$/.test(manifest.checkpoint.chainSha256 || '')) fail('INVALID_MANIFEST', 'The manifest checkpoint is invalid.');
  if (!Number.isSafeInteger(manifest.settings.readSize) || manifest.settings.readSize < 4096 || manifest.settings.readSize > MAX_READER_READ ||
      !Number.isSafeInteger(manifest.settings.checkpointSize) || manifest.settings.checkpointSize < manifest.settings.readSize ||
      manifest.settings.checkpointSize > 256 * MAX_READER_READ || manifest.settings.checkpointSize % manifest.settings.readSize !== 0) {
    fail('INVALID_MANIFEST', 'The manifest read geometry is invalid.');
  }
  if (!Array.isArray(manifest.readErrors) || manifest.readErrors.length > 65_536 ||
      !Array.isArray(manifest.history) || manifest.history.length > 128) fail('INVALID_MANIFEST', 'The manifest history is invalid.');
  let priorEnd = 0;
  let zeroFilledBytes = 0;
  for (const entry of manifest.readErrors) {
    if (!Number.isSafeInteger(entry?.offset) || !Number.isSafeInteger(entry?.length) || entry.offset < priorEnd || entry.length <= 0 ||
        entry.offset + entry.length > manifest.checkpoint.bytesWritten || entry.zeroFilled !== true ||
        !Number.isSafeInteger(entry.attempts) || entry.attempts <= 0 || typeof entry.code !== 'string' || !entry.code) {
      fail('INVALID_MANIFEST', 'The read-error ledger is malformed or outside the committed image.');
    }
    priorEnd = entry.offset + entry.length;
    zeroFilledBytes += entry.length;
  }
  if (manifest.readErrorRangeCount !== manifest.readErrors.length || manifest.zeroFilledBytes !== zeroFilledBytes) {
    fail('INVALID_MANIFEST', 'The read-error ledger summary does not match its ranges.');
  }
  return manifest;
}

async function readManifestSnapshot(filePath) {
  await assertRegularOwnedFile(filePath, 'INVALID_MANIFEST');
  const handle = await open(filePath, 'r');
  try {
    const info = await assertHandleStillNamed(handle, filePath);
    if (info.size > BigInt(MAX_MANIFEST_BYTES)) fail('INVALID_MANIFEST', 'acquisition.json exceeds the bounded manifest size.');
    let manifest;
    try { manifest = JSON.parse(await handle.readFile('utf8')); } catch { fail('INVALID_MANIFEST', 'acquisition.json is not valid JSON.'); }
    await assertFileSnapshot(handle, filePath, info);
    return { manifest: validateManifestShape(manifest), info };
  } finally { await handle.close(); }
}

async function assertExpectedEntries(snapshot, acquisitionId = null) {
  const entries = await readdir(snapshot.canonical);
  for (const name of entries) {
    if ([IMAGE_FILE, MANIFEST_FILE, JOURNAL_FILE].includes(name)) continue;
    if (acquisitionId && name.startsWith(`.acquisition-${acquisitionId}-`) && name.endsWith('.tmp')) continue;
    fail('UNSAFE_OUTPUT', `The acquisition directory contains an unexpected entry: ${name}`);
  }
}

function stateForError(error) {
  return errorCode(error) === 'CANCELLED' ? 'cancelled' : 'error';
}

function stopReason(error) {
  return { code: errorCode(error, 'ACQUISITION_FAILED'), message: String(error?.message || 'Acquisition failed.').slice(0, 2048) };
}

async function assertReaderUnchanged(reader) {
  try { await reader.assertUnchanged(); }
  catch (error) {
    if (errorCode(error) === 'CANCELLED') throw error;
    throw new ImageAcquisitionError(errorCode(error, 'SOURCE_CHANGED'), `Source consistency check failed: ${error.message}`);
  }
}

export async function acquireImage(options) {
  const {
    reader, outputDirectory, source, resume = false, signal, onProgress,
    now = () => new Date(), _test = null
  } = options ?? {};
  checkAbort(signal);
  let settings = normalizeOptions(options ?? {});
  const selectedSource = validateSource(reader, source);
  const directory = await inspectOutputDirectory(outputDirectory);
  const filePaths = pathsFor(directory.canonical);
  let manifest;
  let rawHandle;
  let journalHandle;
  let imageHash;
  let committedImageHash;
  let committedReadErrors = [];
  let committedReadErrorRangeCount = 0;
  let committedZeroFilledBytes = 0;
  let currentChunkHash = createHash('sha256');
  let currentChunkOffset = 0;
  let currentChunkLength = 0;
  let currentChunkHadErrors = false;
  let started = Date.now();
  let mutationAdmitted = false;

  async function persist() {
    manifest.image.bytesWritten = manifest.checkpoint.bytesWritten;
    manifest.image.sha256 = imageHash.copy().digest('hex');
    await writeManifestAtomic(directory, filePaths, manifest, _test?.writeManifest);
  }

  async function commitChunk() {
    if (!currentChunkLength) return;
    const previousCheckpoint = { ...manifest.checkpoint };
    const previousImageHash = committedImageHash.copy();
    const previousImageSha256 = manifest.image.sha256;
    const previousReadErrors = committedReadErrors.map(entry => ({ ...entry }));
    const previousReadErrorRangeCount = committedReadErrorRangeCount;
    const previousZeroFilledBytes = committedZeroFilledBytes;
    const [rawInfo, journalInfo] = await Promise.all([
      assertHandleStillNamed(rawHandle, filePaths.image),
      assertHandleStillNamed(journalHandle, filePaths.journal)
    ]);
    if (rawInfo.size !== BigInt(manifest.checkpoint.bytesWritten + currentChunkLength) ||
        journalInfo.size !== BigInt(manifest.checkpoint.journalBytes)) {
      fail('OUTPUT_CHANGED', 'An acquisition artifact changed outside the committed write sequence.');
    }
    try {
      await rawHandle.sync();
      const core = journalCore(manifest.checkpoint.chunkCount, currentChunkOffset, currentChunkLength,
        currentChunkHash.copy().digest('hex'), currentChunkHadErrors);
      const record = chainedRecord(core, manifest.checkpoint.chainSha256);
      const line = Buffer.from(`${JSON.stringify(record)}\n`);
      await writeFully(journalHandle, line, manifest.checkpoint.journalBytes, _test?.writeJournal);
      await journalHandle.sync();
      manifest.checkpoint.bytesWritten += currentChunkLength;
      manifest.checkpoint.chunkCount += 1;
      manifest.checkpoint.journalBytes += line.length;
      manifest.checkpoint.chainSha256 = record.chainSha256;
      await persist();
      committedImageHash = imageHash.copy();
      committedReadErrors = manifest.readErrors.map(entry => ({ ...entry }));
      committedReadErrorRangeCount = manifest.readErrorRangeCount;
      committedZeroFilledBytes = manifest.zeroFilledBytes;
    } catch (error) {
      try {
        await assertOutputDirectory(directory);
        await Promise.all([
          assertHandleStillNamed(rawHandle, filePaths.image),
          assertHandleStillNamed(journalHandle, filePaths.journal)
        ]);
        await rawHandle.truncate(previousCheckpoint.bytesWritten);
        await journalHandle.truncate(previousCheckpoint.journalBytes);
        await Promise.all([rawHandle.sync(), journalHandle.sync()]);
        manifest.checkpoint = previousCheckpoint;
        manifest.image.bytesWritten = previousCheckpoint.bytesWritten;
        manifest.image.sha256 = previousImageSha256;
        imageHash = previousImageHash;
        manifest.readErrors = previousReadErrors;
        manifest.readErrorRangeCount = previousReadErrorRangeCount;
        manifest.zeroFilledBytes = previousZeroFilledBytes;
        committedReadErrors = previousReadErrors.map(entry => ({ ...entry }));
        committedReadErrorRangeCount = previousReadErrorRangeCount;
        committedZeroFilledBytes = previousZeroFilledBytes;
        currentChunkOffset = previousCheckpoint.bytesWritten;
        currentChunkLength = 0;
        currentChunkHadErrors = false;
        currentChunkHash = createHash('sha256');
      } catch (rollbackError) {
        if (rollbackError instanceof ImageAcquisitionError) throw rollbackError;
        const wrapped = new ImageAcquisitionError('CHECKPOINT_ROLLBACK_FAILED', 'The uncommitted acquisition chunk could not be rolled back.', {
          causeCode: errorCode(error), rollbackCode: errorCode(rollbackError, 'OUTPUT_WRITE_FAILED')
        });
        wrapped.cause = rollbackError;
        throw wrapped;
      }
      throw error;
    }
    currentChunkOffset = manifest.checkpoint.bytesWritten;
    currentChunkLength = 0;
    currentChunkHadErrors = false;
    currentChunkHash = createHash('sha256');
  }

  try {
    if (resume) {
      const manifestSnapshot = await readManifestSnapshot(filePaths.manifest);
      manifest = manifestSnapshot.manifest;
      await assertExpectedEntries(directory, manifest.acquisitionId);
      if (!['cancelled', 'error', 'running'].includes(manifest.state)) fail('RESUME_NOT_ALLOWED', `Acquisition state ${manifest.state} cannot be resumed.`);
      if (!STABLE_RESUME_KINDS.has(selectedSource.kind)) fail('LIVE_RESUME_UNSUPPORTED', 'Live-volume acquisition cannot be resumed as a consistent snapshot. Start a separate acquisition.');
      if (manifest.source.identity !== selectedSource.identity || manifest.source.kind !== selectedSource.kind || manifest.source.size !== selectedSource.size) {
        fail('SOURCE_MISMATCH', 'The resume source is not the source recorded by this acquisition.');
      }
      if ((manifest.resumeCount ?? 0) >= 32) fail('RESUME_LIMIT', 'The bounded resume history is full; start a separate acquisition.');
      settings = { ...settings, readSize: manifest.settings.readSize, checkpointSize: manifest.settings.checkpointSize };
      await assertRegularOwnedFile(filePaths.image);
      await assertRegularOwnedFile(filePaths.journal);
      rawHandle = await open(filePaths.image, 'r+');
      journalHandle = await open(filePaths.journal, 'r+');
      const [rawInfo, journalInfo] = await Promise.all([
        assertHandleStillNamed(rawHandle, filePaths.image),
        assertHandleStillNamed(journalHandle, filePaths.journal)
      ]);
      if (rawInfo.size < BigInt(manifest.checkpoint.bytesWritten) || journalInfo.size < BigInt(manifest.checkpoint.journalBytes)) {
        fail('OUTPUT_CHANGED', 'The partial acquisition is shorter than its committed checkpoint.');
      }
      await assertReaderUnchanged(reader);
      const verifiedImageHash = await validateResumePrefix({ reader, rawHandle, journalHandle, manifest, settings, signal, onProgress });
      await Promise.all([
        assertFileSnapshot(rawHandle, filePaths.image, rawInfo),
        assertFileSnapshot(journalHandle, filePaths.journal, journalInfo),
        assertPathSnapshot(filePaths.manifest, manifestSnapshot.info)
      ]);
      imageHash = verifiedImageHash;
      committedImageHash = imageHash.copy();
      committedReadErrors = manifest.readErrors.map(entry => ({ ...entry }));
      committedReadErrorRangeCount = manifest.readErrorRangeCount;
      committedZeroFilledBytes = manifest.zeroFilledBytes;
      mutationAdmitted = true;
      await rawHandle.truncate(manifest.checkpoint.bytesWritten);
      await journalHandle.truncate(manifest.checkpoint.journalBytes);
      await Promise.all([rawHandle.sync(), journalHandle.sync()]);
      const resumedAt = isoNow(now);
      manifest.state = 'running';
      manifest.complete = false;
      manifest.finishedAt = null;
      manifest.stopReason = null;
      manifest.resumeCount = (manifest.resumeCount ?? 0) + 1;
      manifest.history.push({ event: 'resumed', at: resumedAt, fromOffset: manifest.checkpoint.bytesWritten });
      manifest.settings = { ...manifest.settings, ...settings };
      currentChunkOffset = manifest.checkpoint.bytesWritten;
      started = Date.now();
      await persist();
    } else {
      const entries = await readdir(directory.canonical);
      if (entries.length) fail('OUTPUT_NOT_EMPTY', 'A new acquisition requires an empty, uniquely created output directory.');
      manifest = initialManifest(selectedSource, settings, now);
      rawHandle = await open(filePaths.image, 'wx+');
      journalHandle = await open(filePaths.journal, 'wx+');
      imageHash = createHash('sha256');
      committedImageHash = imageHash.copy();
      committedReadErrors = [];
      committedReadErrorRangeCount = 0;
      committedZeroFilledBytes = 0;
      await writeManifestAtomic(directory, filePaths, manifest, _test?.writeManifest);
      await Promise.all([
        assertHandleStillNamed(rawHandle, filePaths.image),
        assertHandleStillNamed(journalHandle, filePaths.journal)
      ]);
      mutationAdmitted = true;
      await assertReaderUnchanged(reader);
    }

    let offset = manifest.checkpoint.bytesWritten;
    safeProgress(onProgress, { phase: 'acquiring', bytesProcessed: offset, totalBytes: selectedSource.size, resumed: Boolean(resume) });
    while (offset < selectedSource.size) {
      checkAbort(signal);
      if (Date.now() - started >= settings.maxDurationMs) fail('TIME_LIMIT', 'The bounded acquisition time limit was reached.');
      await assertOutputDirectory(directory);
      await assertReaderUnchanged(reader);
      const blockEnd = Math.min(selectedSource.size, offset + settings.checkpointSize);
      currentChunkOffset = offset;
      while (offset < blockEnd) {
        checkAbort(signal);
        if (Date.now() - started >= settings.maxDurationMs) fail('TIME_LIMIT', 'The bounded acquisition time limit was reached.');
        const length = Math.min(settings.readSize, blockEnd - offset);
        const result = await readWithRetries(reader, offset, length, settings, signal);
        let bytes;
        let pendingReadError = null;
        if (result.error) {
          const at = isoNow(now);
          pendingReadError = {
            offset, length, code: errorCode(result.error), attempts: result.attempts,
            zeroFilled: true, firstAt: at, lastAt: at
          };
          bytes = Buffer.alloc(length);
        } else bytes = result.bytes;
        try {
          await assertHandleStillNamed(rawHandle, filePaths.image);
          await writeFully(rawHandle, bytes, offset, _test?.writeImage);
        } catch (error) {
          const written = Number(error?.details?.written ?? 0);
          if (written > 0) {
            if (pendingReadError) {
              appendReadError(manifest, { ...pendingReadError, length: written }, settings.maxErrorRanges);
              currentChunkHadErrors = true;
            }
            const partial = bytes.subarray(0, written);
            imageHash.update(partial);
            currentChunkHash.update(partial);
            currentChunkLength += written;
            offset += written;
          }
          throw error;
        }
        if (pendingReadError) {
          appendReadError(manifest, pendingReadError, settings.maxErrorRanges);
          currentChunkHadErrors = true;
        }
        imageHash.update(bytes);
        currentChunkHash.update(bytes);
        currentChunkLength += bytes.length;
        offset += bytes.length;
        safeProgress(onProgress, {
          phase: 'acquiring', bytesProcessed: offset, totalBytes: selectedSource.size,
          readErrorRanges: manifest.readErrors.length, zeroFilledBytes: manifest.zeroFilledBytes
        });
      }
      await commitChunk();
    }
    await assertReaderUnchanged(reader);
    const [readbackRawInfo, readbackJournalInfo, readbackManifestInfo] = await Promise.all([
      assertHandleStillNamed(rawHandle, filePaths.image),
      assertHandleStillNamed(journalHandle, filePaths.journal),
      assertRegularOwnedFile(filePaths.manifest)
    ]);
    if (readbackRawInfo.size !== BigInt(selectedSource.size) || readbackJournalInfo.size !== BigInt(manifest.checkpoint.journalBytes)) {
      fail('OUTPUT_CHANGED', 'An acquisition artifact has an unexpected size before final readback.');
    }
    let verifiedBytes = 0;
    const expectedReadbackHash = imageHash.copy().digest('hex');
    const observedReadbackHash = await hashFileRange(rawHandle, 0, selectedSource.size, settings.readSize, signal, bytes => {
      verifiedBytes += bytes.length;
      safeProgress(onProgress, { phase: 'readback-verification', bytesProcessed: verifiedBytes, totalBytes: selectedSource.size });
    });
    checkAbort(signal);
    if (observedReadbackHash !== expectedReadbackHash) fail('OUTPUT_VERIFY_FAILED', 'The completed output does not match the bytes accepted during acquisition.');
    await Promise.all([
      assertFileSnapshot(rawHandle, filePaths.image, readbackRawInfo),
      assertFileSnapshot(journalHandle, filePaths.journal, readbackJournalInfo),
      assertPathSnapshot(filePaths.manifest, readbackManifestInfo)
    ]);
    manifest.image.readbackVerified = true;
    manifest.state = manifest.readErrors.length ? 'partial' : 'complete';
    manifest.complete = manifest.state === 'complete';
    manifest.finishedAt = isoNow(now);
    manifest.stopReason = manifest.readErrors.length
      ? { code: 'READ_ERRORS_ZERO_FILLED', message: 'The advertised range was written, but one or more unreadable ranges were filled with zeros and recorded.' }
      : null;
    manifest.history.push({ event: manifest.state, at: manifest.finishedAt, bytesWritten: manifest.checkpoint.bytesWritten });
    await persist();
    safeProgress(onProgress, { phase: manifest.state, bytesProcessed: manifest.checkpoint.bytesWritten, totalBytes: selectedSource.size });
    return manifest;
  } catch (error) {
    if (mutationAdmitted && !UNTRUSTED_OUTPUT_CODES.has(errorCode(error)) && manifest && rawHandle && journalHandle) {
      let terminalMutationSafe = true;
      try {
        await assertOutputDirectory(directory);
        await Promise.all([
          assertHandleStillNamed(rawHandle, filePaths.image),
          assertHandleStillNamed(journalHandle, filePaths.journal)
        ]);
        await rawHandle.truncate(manifest.checkpoint.bytesWritten + currentChunkLength);
        await journalHandle.truncate(manifest.checkpoint.journalBytes);
        await commitChunk();
      } catch (commitError) {
        if (UNTRUSTED_OUTPUT_CODES.has(errorCode(commitError))) {
          terminalMutationSafe = false;
          error = commitError;
        } else {
          if (!error || errorCode(error) === 'CANCELLED') error = commitError;
          try {
            await assertOutputDirectory(directory);
            await Promise.all([
              assertHandleStillNamed(rawHandle, filePaths.image),
              assertHandleStillNamed(journalHandle, filePaths.journal)
            ]);
            await rawHandle.truncate(manifest.checkpoint.bytesWritten);
            await journalHandle.truncate(manifest.checkpoint.journalBytes);
            imageHash = createHash('sha256');
            let position = 0;
            while (position < manifest.checkpoint.bytesWritten) {
              const length = Math.min(settings.readSize, manifest.checkpoint.bytesWritten - position);
              const bytes = Buffer.alloc(length);
              const result = await rawHandle.read(bytes, 0, length, position);
              if (result.bytesRead !== length) throw new Error('Committed output prefix is unreadable.');
              imageHash.update(bytes);
              position += length;
            }
            currentChunkLength = 0;
          } catch (rollbackError) {
            terminalMutationSafe = false;
            error = rollbackError;
          }
        }
      }
      if (terminalMutationSafe) {
        manifest.state = stateForError(error);
        manifest.complete = false;
        manifest.finishedAt = isoNow(now);
        manifest.stopReason = stopReason(error);
        manifest.history.push({ event: manifest.state, at: manifest.finishedAt, bytesWritten: manifest.checkpoint.bytesWritten, reason: manifest.stopReason.code });
        try { await persist(); } catch { /* Preserve the original terminal failure. */ }
      }
    }
    if (error instanceof ImageAcquisitionError) throw error;
    throw new ImageAcquisitionError(errorCode(error, 'ACQUISITION_FAILED'), String(error?.message || 'Image acquisition failed.'));
  } finally {
    await rawHandle?.close().catch(() => {});
    await journalHandle?.close().catch(() => {});
  }
}

export async function verifyAcquisition(outputDirectory, options = {}) {
  const { signal, onProgress } = options;
  checkAbort(signal);
  const readSize = integer('readSize', options.readSize ?? MAX_READER_READ, 4096, MAX_READER_READ);
  const directory = await inspectOutputDirectory(outputDirectory);
  const filePaths = pathsFor(directory.canonical);
  const manifestSnapshot = await readManifestSnapshot(filePaths.manifest);
  const manifest = manifestSnapshot.manifest;
  await assertExpectedEntries(directory, manifest.acquisitionId);
  await Promise.all([assertRegularOwnedFile(filePaths.image), assertRegularOwnedFile(filePaths.journal)]);
  const errors = [];
  const rawHandle = await open(filePaths.image, 'r');
  const journalHandle = await open(filePaths.journal, 'r');
  let observedImageSha256 = null;
  let observedSize = 0;
  try {
    const [rawInfo, journalInfo] = await Promise.all([
      assertHandleStillNamed(rawHandle, filePaths.image),
      assertHandleStillNamed(journalHandle, filePaths.journal)
    ]);
    observedSize = rawInfo.size <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(rawInfo.size) : rawInfo.size.toString();
    if (rawInfo.size !== BigInt(manifest.image.bytesWritten)) errors.push({ code: 'IMAGE_SIZE_MISMATCH', expected: manifest.image.bytesWritten, observed: observedSize });
    if (journalInfo.size !== BigInt(manifest.checkpoint.journalBytes)) {
      const observed = journalInfo.size <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(journalInfo.size) : journalInfo.size.toString();
      errors.push({ code: 'JOURNAL_SIZE_MISMATCH', expected: manifest.checkpoint.journalBytes, observed });
    }
    let sequence = 0;
    let offset = 0;
    let previous = '0'.repeat(64);
    let errorRangeIndex = 0;
    const fullHash = createHash('sha256');
    try {
      await readJournal(journalHandle, manifest.checkpoint.journalBytes, async record => {
        const core = validateRecord(record, { sequence, offset }, previous);
        while (errorRangeIndex < manifest.readErrors.length &&
          manifest.readErrors[errorRangeIndex].offset + manifest.readErrors[errorRangeIndex].length <= core.offset) errorRangeIndex += 1;
        const range = manifest.readErrors[errorRangeIndex];
        const overlapsReadError = Boolean(range && range.offset < core.offset + core.length && range.offset + range.length > core.offset);
        if (core.hadReadErrors !== overlapsReadError) errors.push({ code: 'READ_ERROR_LEDGER_MISMATCH', sequence });
        const observed = await hashFileRange(rawHandle, core.offset, core.length, readSize, signal, bytes => fullHash.update(bytes));
        if (observed !== core.sha256) errors.push({ code: 'CHUNK_HASH_MISMATCH', sequence, offset: core.offset, length: core.length });
        previous = record.chainSha256;
        sequence += 1;
        offset += core.length;
        safeProgress(onProgress, { phase: 'verification', bytesProcessed: offset, totalBytes: manifest.image.bytesWritten });
      });
    } catch (error) {
      if (errorCode(error) === 'CANCELLED') throw error;
      errors.push({ code: errorCode(error, 'JOURNAL_INVALID'), message: String(error.message).slice(0, 2048) });
    }
    if (sequence !== manifest.checkpoint.chunkCount || offset !== manifest.checkpoint.bytesWritten || previous !== manifest.checkpoint.chainSha256) {
      errors.push({ code: 'CHECKPOINT_SUMMARY_MISMATCH' });
    }
    if (offset === manifest.image.bytesWritten) observedImageSha256 = fullHash.digest('hex');
    if (manifest.image.sha256 && observedImageSha256 !== manifest.image.sha256) errors.push({ code: 'IMAGE_HASH_MISMATCH', expected: manifest.image.sha256, observed: observedImageSha256 });
    if (manifest.complete && (manifest.state !== 'complete' || manifest.image.bytesWritten !== manifest.source.size || manifest.readErrors.length || manifest.image.readbackVerified !== true)) {
      errors.push({ code: 'FALSE_COMPLETE_STATE' });
    }
    await Promise.all([
      assertFileSnapshot(rawHandle, filePaths.image, rawInfo),
      assertFileSnapshot(journalHandle, filePaths.journal, journalInfo),
      assertPathSnapshot(filePaths.manifest, manifestSnapshot.info)
    ]);
  } finally {
    await rawHandle.close().catch(() => {});
    await journalHandle.close().catch(() => {});
  }
  const valid = errors.length === 0;
  safeProgress(onProgress, { phase: valid ? 'verified' : 'invalid', bytesProcessed: observedSize, totalBytes: manifest.image.bytesWritten });
  return {
    valid,
    complete: valid && manifest.complete === true && manifest.state === 'complete',
    state: manifest.state,
    acquisitionId: manifest.acquisitionId,
    imageFile: IMAGE_FILE,
    manifestFile: MANIFEST_FILE,
    journalFile: JOURNAL_FILE,
    expectedSize: manifest.source.size,
    observedSize,
    expectedImageSha256: manifest.image.sha256,
    observedImageSha256,
    readbackVerifiedAtAcquisition: manifest.image.readbackVerified === true,
    readErrorRanges: manifest.readErrors.length,
    zeroFilledBytes: manifest.zeroFilledBytes,
    errors
  };
}
