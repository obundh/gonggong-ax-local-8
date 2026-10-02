import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { deflateSync } from 'node:zlib';

import { carveFiles } from '../engine/carving.mjs';

const MIB = 1024 * 1024;
const TEMP_ROOT = path.resolve('E:\\RecoveryChat-DeepCoverage-0512-20260926\\temp');
const TEMP_PREFIX = 'recoverychat-carving-coverage-';
const COVERAGE_KEYS = [
  'complete', 'examinedBytes', 'examinedRanges', 'outputBytesWritten', 'rangesTruncated',
  'readErrorBytes', 'readErrorRanges', 'scanReadBytes', 'scanScope', 'selectedBytes',
  'stopReason', 'strategy', 'unexaminedBytes', 'version'
].sort();
const STOP_REASONS = new Set([
  'end-of-ranges', 'scan-byte-limit', 'output-byte-limit', 'candidate-limit',
  'cancelled', 'source-changed', 'error'
]);

let crcTable;
function crc32(buffer) {
  crcTable ??= Array.from({ length: 256 }, (_, number) => {
    let value = number;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
    return value >>> 0;
  });
  let value = 0xffffffff;
  for (const byte of buffer) value = (value >>> 8) ^ crcTable[(value ^ byte) & 0xff];
  return (value ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data = Buffer.alloc(0)) {
  const name = Buffer.from(type, 'ascii');
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  name.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
  return chunk;
}

function makePng(payloadBytes = 4) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 2;
  const raw = Buffer.alloc(Math.max(4, payloadBytes), 0x39);
  raw[0] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND')
  ]);
}

function makePdf(extraBytes = 0) {
  return Buffer.concat([
    Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n', 'ascii'),
    Buffer.alloc(extraBytes, 0x20),
    Buffer.from('\n%%EOF\n', 'ascii')
  ]);
}

class BufferProvider {
  constructor(bytes, { failRead, onRead } = {}) {
    this.bytes = Buffer.from(bytes);
    this.info = { size: this.bytes.length, sectorSize: 512, readOnly: true };
    this.failRead = failRead;
    this.onRead = onRead;
    this.reads = [];
    this.assertions = 0;
    this.sourceChanged = false;
  }

  async assertUnchanged() {
    this.assertions += 1;
    if (this.sourceChanged) throw Object.assign(new Error('synthetic source change'), { code: 'ESTALE' });
  }

  async read(offset, length, { signal } = {}) {
    if (signal?.aborted) throw Object.assign(new Error('cancelled'), { code: 'CANCELLED' });
    assert.ok(Number.isSafeInteger(offset) && offset >= 0);
    assert.ok(Number.isSafeInteger(length) && length >= 0 && length <= MIB);
    assert.ok(offset + length <= this.bytes.length);
    const call = { offset, length, number: this.reads.length + 1 };
    this.reads.push(call);
    if (this.failRead?.(call)) throw Object.assign(new Error('synthetic read failure'), { code: 'EIO' });
    const result = Buffer.from(this.bytes.subarray(offset, offset + length));
    await this.onRead?.(call);
    return result;
  }
}

async function isolated(callback) {
  await mkdir(TEMP_ROOT, { recursive: true });
  const root = await mkdtemp(path.join(TEMP_ROOT, TEMP_PREFIX));
  try {
    await callback(root);
  } finally {
    const resolvedRoot = path.resolve(root);
    const relative = path.relative(TEMP_ROOT, resolvedRoot);
    assert.ok(relative.startsWith(TEMP_PREFIX), 'cleanup target has the owned test prefix');
    assert.ok(!path.isAbsolute(relative) && !relative.includes(path.sep), 'cleanup target is one owned temp child');
    await rm(resolvedRoot, { recursive: true, force: true });
  }
}

async function pathExists(target) {
  try { await stat(target); return true; } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function filesBelow(root) {
  if (!(await pathExists(root))) return [];
  const found = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else found.push(target);
    }
  }
  await visit(root);
  return found.sort();
}

function rangeTotal(ranges) {
  return ranges.reduce((sum, range) => sum + range.length, 0);
}

function assertRanges(ranges, expectedTotal, label) {
  assert.ok(Array.isArray(ranges), `${label} is an array`);
  assert.ok(ranges.length <= 1024, `${label} is bounded`);
  let previousEnd = -1;
  for (const range of ranges) {
    assert.ok(Number.isSafeInteger(range.offset) && range.offset >= 0, `${label} offset is safe`);
    assert.ok(Number.isSafeInteger(range.length) && range.length > 0, `${label} length is positive`);
    assert.ok(range.offset >= previousEnd, `${label} is ordered and non-overlapping`);
    previousEnd = range.offset + range.length;
  }
  assert.equal(rangeTotal(ranges), expectedTotal, `${label} sums to its byte total`);
}

function assertCoverage(coverage, expected = {}, { allowPending = false } = {}) {
  assert.deepEqual(Object.keys(coverage).sort(), COVERAGE_KEYS);
  assert.equal(coverage.version, 1);
  assert.equal(coverage.strategy, 'carving');
  assert.ok(['whole-source', 'selected-ranges'].includes(coverage.scanScope));
  assert.ok(STOP_REASONS.has(coverage.stopReason) || (allowPending && coverage.stopReason === null));
  assert.equal(typeof coverage.complete, 'boolean');
  assert.equal(typeof coverage.rangesTruncated, 'boolean');
  for (const key of ['selectedBytes', 'scanReadBytes', 'examinedBytes', 'unexaminedBytes', 'readErrorBytes', 'outputBytesWritten']) {
    assert.ok(Number.isSafeInteger(coverage[key]) && coverage[key] >= 0, `${key} is a non-negative safe integer`);
  }
  assert.equal(coverage.examinedBytes + coverage.unexaminedBytes, coverage.selectedBytes,
    'selected bytes are partitioned into examined and unexamined bytes');
  assert.ok(coverage.readErrorBytes <= coverage.unexaminedBytes, 'read-error bytes remain unexamined');
  assertRanges(coverage.examinedRanges, coverage.examinedBytes, 'examinedRanges');
  assertRanges(coverage.readErrorRanges, coverage.readErrorBytes, 'readErrorRanges');
  for (const [key, value] of Object.entries(expected)) assert.deepEqual(coverage[key], value, key);
}

function assertResultCoverage(result, expected = {}) {
  assertCoverage(result.coverage, expected);
  assert.equal(result.complete, result.coverage.complete);
  assert.equal(result.stats.scanReadBytes, result.coverage.scanReadBytes);
  assert.equal(result.stats.bytesRead, result.coverage.scanReadBytes);
  assert.equal(result.stats.outputBytesWritten, result.coverage.outputBytesWritten);
}

function assertErrorCoverage(error, stopReason) {
  assertCoverage(error?.details?.coverage, { complete: false, stopReason });
  assert.ok(error.details.stats && typeof error.details.stats === 'object');
  assert.equal(error.details.stats.scanReadBytes, error.details.coverage.scanReadBytes);
  assert.equal(error.details.stats.bytesRead, error.details.coverage.scanReadBytes);
  assert.equal(error.details.stats.outputBytesWritten, error.details.coverage.outputBytesWritten);
}

test('rejects malformed scan and output budgets before reading the provider or creating output', async () => isolated(async root => {
  const invalidValues = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '1'];
  for (const option of ['maxScanBytes', 'maxOutputBytes']) {
    for (const value of invalidValues) {
      const provider = new BufferProvider(Buffer.alloc(32));
      const output = path.join(root, `${option}-${String(value).replaceAll('.', '_')}`);
      await assert.rejects(carveFiles(provider, output, { [option]: value }), { code: 'INVALID_ARGUMENT' });
      assert.equal(provider.reads.length, 0);
      assert.equal(provider.assertions, 0);
      assert.equal(await pathExists(output), false);
    }
  }
}));

test('reports exact complete whole-source coverage and attaches it to progress', async () => isolated(async root => {
  const png = makePng();
  const pdf = makePdf(71);
  const bytes = Buffer.concat([Buffer.alloc(13, 0x51), png, Buffer.alloc(17, 0x52), pdf, Buffer.alloc(19, 0x53)]);
  const progress = [];
  const result = await carveFiles(new BufferProvider(bytes), path.join(root, 'output'), {
    onProgress: update => progress.push(update)
  });

  assertResultCoverage(result, {
    scanScope: 'whole-source', selectedBytes: bytes.length, scanReadBytes: bytes.length,
    examinedBytes: bytes.length, unexaminedBytes: 0, readErrorBytes: 0,
    outputBytesWritten: png.length + pdf.length, stopReason: 'end-of-ranges', complete: true,
    examinedRanges: [{ offset: 0, length: bytes.length }], readErrorRanges: [], rangesTruncated: false
  });
  assert.deepEqual(result.candidates.map(candidate => candidate.format), ['png', 'pdf']);
  assert.deepEqual(await readFile(result.candidates[0].path), png);
  assert.deepEqual(await readFile(result.candidates[1].path), pdf);
  assert.ok(progress.length > 0);
  for (const update of progress) assertCoverage(update.coverage, {}, { allowPending: true });
  assert.deepEqual(progress.at(-1).coverage, result.coverage);
}));

test('sums disjoint selected ranges exactly and never joins a signature across an omitted gap', async () => isolated(async root => {
  const splitPng = makePng();
  const pdf = makePdf();
  const bytes = Buffer.alloc(512, 0x61);
  splitPng.subarray(0, 4).copy(bytes, 20);
  splitPng.subarray(4).copy(bytes, 80);
  pdf.copy(bytes, 300);
  const ranges = [
    { offset: 20, length: 4 },
    { offset: 80, length: splitPng.length - 4 },
    { offset: 300, length: pdf.length }
  ];
  const selectedBytes = rangeTotal(ranges);
  const result = await carveFiles(new BufferProvider(bytes), path.join(root, 'output'), { ranges });

  assertResultCoverage(result, {
    scanScope: 'selected-ranges', selectedBytes, scanReadBytes: selectedBytes,
    examinedBytes: selectedBytes, unexaminedBytes: 0, readErrorBytes: 0,
    outputBytesWritten: pdf.length, stopReason: 'end-of-ranges', complete: true,
    examinedRanges: ranges, readErrorRanges: []
  });
  assert.deepEqual(result.candidates.map(candidate => candidate.format), ['pdf']);
  assert.deepEqual(await readFile(result.candidates[0].path), pdf);
}));

test('a first hit near the start with maxCandidates 1 cannot claim the unread MiB was examined', async () => isolated(async root => {
  const png = makePng();
  const bytes = Buffer.alloc(MIB + 257, 0x6a);
  png.copy(bytes, 11);
  const result = await carveFiles(new BufferProvider(bytes), path.join(root, 'output'), { maxCandidates: 1 });

  assertResultCoverage(result, {
    selectedBytes: bytes.length, outputBytesWritten: png.length,
    stopReason: 'candidate-limit', complete: false, rangesTruncated: false
  });
  assert.equal(result.truncated, true, 'truncated remains reserved for the candidate cap');
  assert.equal(result.candidates.length, 1);
  assert.ok(result.coverage.examinedBytes < bytes.length);
  assert.ok(result.coverage.unexaminedBytes > 0);
}));

test('scan-byte budget stops mid-chunk and retains the unresolved seven-byte overlap', async () => isolated(async root => {
  const bytes = Buffer.alloc(4096, 0x43);
  const result = await carveFiles(new BufferProvider(bytes), path.join(root, 'output'), { maxScanBytes: 1000 });

  assertResultCoverage(result, {
    selectedBytes: bytes.length, scanReadBytes: 1000, examinedBytes: 993,
    unexaminedBytes: bytes.length - 993, readErrorBytes: 0, outputBytesWritten: 0,
    stopReason: 'scan-byte-limit', complete: false, examinedRanges: [{ offset: 0, length: 993 }]
  });
  assert.equal(result.truncated, false);
  assert.ok(result.warnings.some(warning => warning.code === 'SCAN_BYTE_LIMIT'));
}));

test('scan budget finds a signature across the MiB boundary while validation may look ahead outside that budget', async () => isolated(async root => {
  const png = makePng(256);
  const prefix = Buffer.alloc(MIB - 4, 0x35);
  const bytes = Buffer.concat([prefix, png, Buffer.alloc(101, 0x36)]);
  const budget = MIB + 32;
  const provider = new BufferProvider(bytes);
  const result = await carveFiles(provider, path.join(root, 'output'), { maxScanBytes: budget });

  assertResultCoverage(result, {
    selectedBytes: bytes.length, scanReadBytes: budget, examinedBytes: budget - 7,
    unexaminedBytes: bytes.length - (budget - 7), outputBytesWritten: png.length,
    stopReason: 'scan-byte-limit', complete: false
  });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].offset, prefix.length);
  assert.deepEqual(await readFile(result.candidates[0].path), png);
  assert.ok(provider.reads.some(read => read.offset + read.length > budget),
    'bounded validation or extraction lookahead can read beyond the scan budget inside the selected range');
}));

test('output budget publishes the fitting artifact and refuses the next artifact before any oversized write', async () => isolated(async root => {
  const png = makePng();
  const pdf = makePdf(4096);
  const bytes = Buffer.concat([png, Buffer.alloc(23, 0x70), pdf]);
  const output = path.join(root, 'output');
  const result = await carveFiles(new BufferProvider(bytes), output, { maxOutputBytes: png.length + 10 });

  assertResultCoverage(result, {
    selectedBytes: bytes.length, outputBytesWritten: png.length,
    stopReason: 'output-byte-limit', complete: false, rangesTruncated: false
  });
  assert.equal(result.truncated, false);
  assert.deepEqual(result.candidates.map(candidate => candidate.format), ['png']);
  assert.deepEqual(await readFile(result.candidates[0].path), png);
  assert.ok(result.warnings.some(warning => warning.code === 'OUTPUT_BYTE_LIMIT'));
  const files = await filesBelow(output);
  assert.deepEqual(files, [result.candidates[0].path]);
  assert.ok(files.every(file => !file.endsWith('.carving-writing.partial')));
}));

test('read-failed bytes are recorded as unexamined and do not disappear from exact totals', async () => isolated(async root => {
  const bytes = Buffer.alloc(2 * MIB + 73, 0x44);
  const provider = new BufferProvider(bytes, {
    failRead: ({ offset, length }) => offset === MIB && length === MIB
  });
  const result = await carveFiles(provider, path.join(root, 'output'));
  const expectedExamined = (MIB - 7) + 73;

  assertResultCoverage(result, {
    selectedBytes: bytes.length, scanReadBytes: MIB + 73, examinedBytes: expectedExamined,
    unexaminedBytes: bytes.length - expectedExamined, readErrorBytes: MIB,
    outputBytesWritten: 0, stopReason: 'end-of-ranges', complete: false,
    examinedRanges: [{ offset: 0, length: MIB - 7 }, { offset: 2 * MIB, length: 73 }],
    readErrorRanges: [{ offset: MIB, length: MIB }]
  });
  assert.ok(result.warnings.some(warning => warning.code === 'READ_FAILED'));
}));

test('cancellation during validation keeps the prior candidate and exposes honest error coverage', async () => isolated(async root => {
  const png = makePng();
  const pdf = makePdf(MIB + 200);
  const pdfOffset = png.length + 29;
  const bytes = Buffer.concat([png, Buffer.alloc(29, 0x37), pdf, Buffer.alloc(97, 0x38)]);
  const controller = new AbortController();
  let firstCandidate;
  const provider = new BufferProvider(bytes, {
    onRead: ({ offset, length }) => {
      if (firstCandidate && offset === pdfOffset && length === 16) controller.abort();
    }
  });
  let caught;
  try {
    await carveFiles(provider, path.join(root, 'output'), {
      signal: controller.signal,
      onCandidate: candidate => { firstCandidate ??= candidate; }
    });
  } catch (error) { caught = error; }

  assert.equal(caught?.code, 'CANCELLED');
  assert.ok(firstCandidate, 'the earlier candidate was published before cancellation');
  assert.deepEqual(await readFile(firstCandidate.path), png);
  assertErrorCoverage(caught, 'cancelled');
  assert.equal(caught.details.coverage.outputBytesWritten, png.length);
  assert.ok(caught.details.coverage.unexaminedBytes > 0);
}));

test('cancellation during extraction counts the actual partial write and preserves prior output', async () => isolated(async root => {
  const png = makePng();
  const pdf = makePdf(2 * MIB);
  const bytes = Buffer.concat([png, Buffer.alloc(31, 0x41), pdf, Buffer.alloc(89, 0x42)]);
  const controller = new AbortController();
  let firstCandidate;
  let caught;
  try {
    await carveFiles(new BufferProvider(bytes), path.join(root, 'output'), {
      signal: controller.signal,
      onCandidate: candidate => { firstCandidate ??= candidate; },
      onProgress: progress => {
        if (firstCandidate && progress.phase === 'extract' && progress.bytesWritten > 0) controller.abort();
      }
    });
  } catch (error) { caught = error; }

  assert.equal(caught?.code, 'CANCELLED');
  assert.ok(firstCandidate);
  assert.deepEqual(await readFile(firstCandidate.path), png);
  assert.ok(caught.details.partialPath.endsWith('.carving-writing.partial'));
  const partial = await readFile(caught.details.partialPath);
  assert.ok(partial.length > 0 && partial.length < pdf.length);
  assertErrorCoverage(caught, 'cancelled');
  assert.equal(caught.details.coverage.outputBytesWritten, png.length + partial.length);
  assert.ok(caught.details.coverage.unexaminedBytes > 0);
}));

test('source change after a published candidate returns coverage for the preserved work', async () => isolated(async root => {
  const png = makePng();
  const pdf = makePdf(2048);
  const bytes = Buffer.concat([png, Buffer.alloc(27, 0x31), pdf, Buffer.alloc(71, 0x32)]);
  const provider = new BufferProvider(bytes);
  let firstCandidate;
  let caught;
  try {
    await carveFiles(provider, path.join(root, 'output'), {
      onCandidate: candidate => {
        if (!firstCandidate) {
          firstCandidate = candidate;
          provider.sourceChanged = true;
        }
      }
    });
  } catch (error) { caught = error; }

  assert.equal(caught?.code, 'SOURCE_CHANGED');
  assert.ok(firstCandidate);
  assert.deepEqual(await readFile(firstCandidate.path), png);
  assert.ok(caught.details.partialPath.endsWith('.carving-writing.partial'));
  assert.deepEqual(await readFile(caught.details.partialPath), pdf);
  assertErrorCoverage(caught, 'source-changed');
  assert.equal(caught.details.coverage.outputBytesWritten, png.length + pdf.length);
  assert.ok(caught.details.coverage.unexaminedBytes > 0);
}));
