const MAX_READ_BYTES = 1024 * 1024;
const BITMAP_PAGE_BYTES = 64 * 1024;
const MAX_COALESCE_GAP_BYTES = 64 * 1024;
const MAX_CANDIDATES = 100_000;
const MAX_PARSE_ERROR_IDS = 32;
const MAX_PARSE_ERROR_SAMPLES = 8;
const MAX_NAMES_PER_CANDIDATE = 8;
const ALLOWED_OPTIONS = new Set(['onProgress', 'onCandidate', 'signal', 'previousBitmap', 'control']);
const PARSE_ERROR_CODES = new Set([
  'INVALID_RECORD',
  'INVALID_FIXUP',
  'INVALID_ATTRIBUTE',
  'INVALID_ATTRIBUTE_LIST',
  'INVALID_NAME',
  'INVALID_RANGE',
  'UNSUPPORTED_ATTRIBUTE',
]);

export class BitmapScannerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BitmapScannerError';
    this.code = code;
  }
}

function fail(condition, code, message) {
  if (!condition) throw new BitmapScannerError(code, message);
}

function cancelled(signal) {
  if (signal?.aborted) throw new BitmapScannerError('CANCELLED', 'Bitmap vacancy scan cancelled.');
}

function isBytes(value) {
  return Buffer.isBuffer(value) || value instanceof Uint8Array;
}

function bit(bytes, index) {
  return Boolean(bytes[Math.floor(index / 8)] & (1 << (index & 7)));
}

function candidateFrom(record, number) {
  if (!record || number < 16 || record.flags !== 0 || record.baseReference !== 0n) return null;
  const names = [];
  const seen = new Set();
  for (const item of Array.isArray(record.names) ? record.names : []) {
    if (names.length >= MAX_NAMES_PER_CANDIDATE) break;
    if (typeof item?.name !== 'string' || item.name.length === 0 || seen.has(item.name)) continue;
    seen.add(item.name);
    names.push(item.name);
  }
  if (names.length === 0) return null;

  const candidate = { recordNumber: number, sequence: record.sequence, fingerprint: record.fingerprint, names,
    recordEvidence: record.recordEvidence,
    nameReferences: record.names.slice(0, MAX_NAMES_PER_CANDIDATE).map(item => ({ name: item.name, namespace: item.namespace, parent: { ...item.parent } })) };
  const hasAttributeList = Array.isArray(record.attributes)
    && record.attributes.some(attribute => attribute?.type === 0x20);
  if (hasAttributeList) candidate.splitData = true;
  const data = hasAttributeList || !Array.isArray(record.attributes) ? [] : record.attributes.filter(attribute =>
    attribute?.type === 0x80 && attribute.name === '' && !attribute.problem
      && (attribute.resident || attribute.firstVcn === 0));
  if (data.length === 1 && Number.isSafeInteger(data[0].size) && data[0].size >= 0) candidate.size = data[0].size;
  return candidate;
}

function validate(engine, options) {
  fail(engine && typeof engine === 'object', 'INVALID_ENGINE', 'An initialized NTFS engine is required.');
  fail(options && typeof options === 'object' && !Array.isArray(options), 'INVALID_OPTIONS', 'Scanner options must be an object.');
  for (const key of Object.keys(options)) {
    fail(ALLOWED_OPTIONS.has(key), 'INVALID_OPTIONS', `Unsupported discovery option: ${key}`);
  }
  fail(typeof engine.readStream === 'function' && typeof engine.record === 'function',
    'INVALID_ENGINE', 'The engine must expose readStream() and record().');
  fail(engine.mft && engine.mftBitmap && engine.info, 'INVALID_ENGINE', 'The engine must be initialized.');
  const { recordCount, recordSize } = engine.info;
  fail(Number.isSafeInteger(recordCount) && recordCount >= 0, 'INVALID_GEOMETRY', 'Invalid MFT record count.');
  fail(Number.isSafeInteger(recordSize) && recordSize >= 512 && recordSize <= 65_536,
    'INVALID_GEOMETRY', 'Invalid or unsupported MFT record size.');
  const bitmapBytes = Math.ceil(recordCount / 8);
  fail(Number.isSafeInteger(engine.mftBitmap.size) && engine.mftBitmap.size >= bitmapBytes,
    'INVALID_BITMAP', 'MFT bitmap is shorter than the record geometry.');
  const mftBytes = recordCount * recordSize;
  fail(Number.isSafeInteger(mftBytes), 'INVALID_GEOMETRY', 'MFT geometry exceeds safe integer bounds.');
  fail(Number.isSafeInteger(engine.mft.size) && engine.mft.size >= mftBytes,
    'INVALID_GEOMETRY', 'MFT stream is shorter than the record geometry.');
  return { recordCount, recordSize, bitmapBytes };
}

async function readExact(engine, stream, offset, length, signal, stats) {
  cancelled(signal);
  const value = await engine.readStream(stream, offset, length, signal);
  fail(isBytes(value) && value.byteLength === length, 'SHORT_READ', 'The engine returned a short metadata read.');
  stats.readCalls += 1;
  stats.bytesRead += value.byteLength;
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

/**
 * Experimental metadata-only scanner. It accepts no names or record IDs as
 * discovery input and never resolves paths, reads file content, or recovers data.
 */
export async function scanVacantRecords(engine, options = {}) {
  const { onProgress, onCandidate, signal, previousBitmap, control } = options;
  const { recordCount, recordSize, bitmapBytes } = validate(engine, options);
  fail(onProgress === undefined || typeof onProgress === 'function', 'INVALID_OPTIONS', 'onProgress must be a function.');
  fail(onCandidate === undefined || typeof onCandidate === 'function', 'INVALID_OPTIONS', 'onCandidate must be a function.');
  fail(signal === undefined || (signal && typeof signal === 'object'), 'INVALID_OPTIONS', 'signal must be AbortSignal-like.');
  if (previousBitmap !== undefined) {
    fail(isBytes(previousBitmap) && previousBitmap.byteLength === bitmapBytes,
      'INVALID_PREVIOUS_BITMAP', 'previousBitmap must exactly match the current bitmap geometry.');
  }

  const mode = previousBitmap === undefined ? 'full' : 'delta';
  const stats = {
    mode,
    recordCount,
    bitmapBytes,
    bytesRead: 0,
    readCalls: 0,
    zeroSlots: 0,
    selectedSlots: 0,
    slotsVisited: 0,
    parseErrors: 0,
    parseErrorIds: [],
    parseErrorSamples: [],
    parseErrorIdsTruncated: false,
    candidatesFound: 0,
    candidatesRetained: 0,
    candidatesTruncated: false,
  };
  const candidates = [];
  onProgress?.({ stage: 'bitmap', ...stats });

  const maxGapSlots = Math.max(0, Math.floor(MAX_COALESCE_GAP_BYTES / recordSize));
  let batch = null;
  let lastProgress = 0;

  const processBatch = async () => {
    if (!batch) return;
    cancelled(signal);
    await control?.checkpoint();
    cancelled(signal);
    const startOffset = batch.start * recordSize;
    const length = (batch.end - batch.start + 1) * recordSize;
    fail(length <= MAX_READ_BYTES, 'INTERNAL_LIMIT', 'Coalesced MFT range exceeded 1 MiB.');
    const cache = await readExact(engine, engine.mft, startOffset, length, signal, stats);
    const view = Object.create(engine);
    Object.defineProperty(view, 'readStream', {
      configurable: true,
      value: async (stream, offset, requested, readSignal) => {
        cancelled(readSignal);
        fail(stream === engine.mft && Number.isSafeInteger(offset) && Number.isSafeInteger(requested)
          && offset >= startOffset && requested >= 0 && offset + requested <= startOffset + length,
        'UNEXPECTED_PARSER_READ', 'The record parser requested data outside its cached MFT range.');
        return cache.subarray(offset - startOffset, offset - startOffset + requested);
      },
    });

    for (const number of batch.slots) {
      cancelled(signal);
      if (stats.slotsVisited % 256 === 0) { await control?.checkpoint(); cancelled(signal); }
      stats.slotsVisited += 1;
      try {
        const record = await view.record(number, signal);
        const candidate = candidateFrom(record, number);
        if (candidate) {
          stats.candidatesFound += 1;
          if (candidates.length < MAX_CANDIDATES) { candidates.push(candidate); await onCandidate?.(candidate); }
          else stats.candidatesTruncated = true;
        }
      } catch (error) {
        if (!PARSE_ERROR_CODES.has(error?.code)) throw error;
        stats.parseErrors += 1;
        if (stats.parseErrorIds.length < MAX_PARSE_ERROR_IDS) stats.parseErrorIds.push(number);
        else stats.parseErrorIdsTruncated = true;
        if (stats.parseErrorSamples.length < MAX_PARSE_ERROR_SAMPLES) {
          stats.parseErrorSamples.push({ recordNumber: number, code: error.code, message: String(error.message ?? '') });
        }
      }
    }
    stats.candidatesRetained = candidates.length;
    if (stats.slotsVisited - lastProgress >= 256) {
      lastProgress = stats.slotsVisited;
      onProgress?.({ stage: 'scan', ...stats });
    }
    batch = null;
  };

  for (let pageOffset = 0; pageOffset < bitmapBytes; pageOffset += BITMAP_PAGE_BYTES) {
    await control?.checkpoint(); cancelled(signal);
    const page = await readExact(engine, engine.mftBitmap, pageOffset, Math.min(BITMAP_PAGE_BYTES, bitmapBytes - pageOffset), signal, stats);
    for (let number = pageOffset * 8; number < Math.min(recordCount, (pageOffset + page.length) * 8); number += 1) {
    cancelled(signal);
    const vacant = !bit(page, number - pageOffset * 8);
    if (vacant) stats.zeroSlots += 1;
    const selected = vacant && (previousBitmap === undefined || bit(previousBitmap, number));
    if (!selected) continue;
    stats.selectedSlots += 1;

    if (batch) {
      const gap = number - batch.end - 1;
      const rangeBytes = (number - batch.start + 1) * recordSize;
      if (gap > maxGapSlots || rangeBytes > MAX_READ_BYTES) await processBatch();
    }
    if (!batch) batch = { start: number, end: number, slots: [] };
    batch.end = number;
    batch.slots.push(number);
    }
    await processBatch();
  }
  await processBatch();
  onProgress?.({ stage: 'complete', ...stats });
  return {
    mode,
    complete: !stats.candidatesTruncated && stats.parseErrors === 0,
    candidates,
    stats,
    limitations: [
      'metadata-only diagnostic; no path, content, recovery, or deletion operations',
      mode === 'delta' ? 'delta includes only allocation-bit transitions from 1 to 0' : 'full scan includes every zero MFT allocation bit',
      `candidate retention is capped at ${MAX_CANDIDATES}; parse-error IDs at ${MAX_PARSE_ERROR_IDS}`,
    ],
  };
}
