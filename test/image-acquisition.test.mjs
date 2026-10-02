import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { closeSync, openSync, writeSync } from 'node:fs';
import { link, mkdtemp, mkdir, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { acquireImage, verifyAcquisition } from '../engine/image-acquisition.mjs';

const TEST_BASE = path.resolve('E:\\RecoveryChat-Stage2-Completion-20260920\\agent-acquisition-temp');

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function fixtureBytes(length = 3 * 1024 * 1024 + 137) {
  const bytes = Buffer.alloc(length);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index * 31 + Math.floor(index / 251)) & 0xff;
  return bytes;
}

class FixtureReader {
  constructor(bytes, { identity = `fixture:${sha256(bytes)}`, sourceKind = 'image', failures = new Map(), shortReads = new Map(), changed = false } = {}) {
    this.bytes = Buffer.from(bytes);
    this.info = { size: bytes.length, identity, sectorSize: 512, sourceKind };
    this.failures = failures;
    this.shortReads = shortReads;
    this.changed = changed;
    this.readCalls = [];
    this.closed = false;
  }

  async read(offset, length, { signal } = {}) {
    assert.ok(length <= 1024 * 1024, 'core must never ask the reader for more than 1 MiB');
    if (signal?.aborted) throw Object.assign(new Error('cancelled'), { code: 'CANCELLED' });
    this.readCalls.push({ offset, length });
    const failuresLeft = this.failures.get(offset) ?? 0;
    if (failuresLeft) {
      if (Number.isFinite(failuresLeft)) this.failures.set(offset, failuresLeft - 1);
      throw Object.assign(new Error(`injected read failure at ${offset}`), { code: 'EIO' });
    }
    const short = this.shortReads.get(offset);
    if (short !== undefined) return Buffer.from(this.bytes.subarray(offset, offset + Math.min(short, length)));
    return Buffer.from(this.bytes.subarray(offset, offset + length));
  }

  async assertUnchanged() {
    if (this.changed) throw Object.assign(new Error('fixture source changed'), { code: 'SOURCE_CHANGED' });
  }

  async close() { this.closed = true; }
}

async function withOwnedDirectory(callback) {
  await mkdir(TEST_BASE, { recursive: true });
  const canonicalBase = await realpath(TEST_BASE);
  assert.equal(path.resolve(canonicalBase).toLowerCase(), TEST_BASE.toLowerCase());
  const root = await mkdtemp(path.join(canonicalBase, 'image-acquisition-'));
  try { return await callback(root); }
  finally {
    const checkedBase = await realpath(TEST_BASE);
    const relative = path.relative(checkedBase, root);
    assert.match(relative, /^image-acquisition-[^\\/]+$/);
    assert.equal(path.dirname(root).toLowerCase(), checkedBase.toLowerCase());
    await rm(root, { recursive: true, force: false });
  }
}

function sourceFor(reader, label = 'known generated image') {
  return { identity: reader.info.identity, kind: reader.info.sourceKind, label };
}

const smallSettings = { readSize: 64 * 1024, checkpointSize: 1024 * 1024, retryDelayMs: 0, readTimeoutMs: 5000 };

test('known generated fixture is streamed, hashed, read back, and scoped as a selected volume image', async () => withOwnedDirectory(async outputDirectory => {
  const bytes = fixtureBytes();
  const reader = new FixtureReader(bytes);
  const progress = [];
  const manifest = await acquireImage({ reader, outputDirectory, source: sourceFor(reader), onProgress: value => progress.push(value), ...smallSettings });

  assert.equal(manifest.state, 'complete');
  assert.equal(manifest.complete, true);
  assert.equal(manifest.image.bytesWritten, bytes.length);
  assert.equal(manifest.image.sha256, sha256(bytes));
  assert.equal(manifest.image.readbackVerified, true);
  assert.equal(manifest.scope.offset, 0);
  assert.equal(manifest.scope.length, bytes.length);
  assert.equal(manifest.scope.wholePhysicalDisk, false);
  assert.deepEqual(manifest.scope.includes, ['allocated-space', 'unallocated-space', 'filesystem-slack-within-selected-source']);
  assert.deepEqual(await readFile(path.join(outputDirectory, 'image.raw')), bytes);
  assert.ok(reader.readCalls.length > 3);
  assert.ok(progress.some(value => value.phase === 'complete'));
  assert.equal(reader.closed, false, 'caller retains reader ownership');

  const verified = await verifyAcquisition(outputDirectory, { readSize: 32 * 1024 });
  assert.equal(verified.valid, true);
  assert.equal(verified.complete, true);
  assert.equal(verified.observedImageSha256, sha256(bytes));
  assert.equal(verified.observedSize, bytes.length);
}));

test('cancellation at the initial progress boundary retains a valid zero-byte checkpoint that can resume', async () => withOwnedDirectory(async outputDirectory => {
  const bytes = fixtureBytes(128 * 1024);
  const first = new FixtureReader(bytes);
  const controller = new AbortController();
  await assert.rejects(acquireImage({
    reader: first, outputDirectory, source: sourceFor(first), signal: controller.signal, ...smallSettings,
    checkpointSize: 128 * 1024,
    onProgress(value) { if (value.phase === 'acquiring' && value.bytesProcessed === 0) controller.abort(); }
  }), { code: 'CANCELLED' });
  const cancelled = JSON.parse(await readFile(path.join(outputDirectory, 'acquisition.json'), 'utf8'));
  assert.equal(cancelled.image.bytesWritten, 0);
  assert.equal(cancelled.image.sha256, sha256(Buffer.alloc(0)));
  assert.equal((await verifyAcquisition(outputDirectory)).valid, true);
  const second = new FixtureReader(bytes, { identity: first.info.identity });
  const resumed = await acquireImage({
    reader: second, outputDirectory, source: sourceFor(second), resume: true, ...smallSettings,
    checkpointSize: 128 * 1024
  });
  assert.equal(resumed.complete, true);
}));

test('source-change detected between checkpoints stops with an error manifest', async () => withOwnedDirectory(async outputDirectory => {
  const bytes = fixtureBytes(2 * 1024 * 1024);
  class ChangingReader extends FixtureReader {
    async assertUnchanged() {
      if (this.readCalls.length >= 16) throw Object.assign(new Error('source changed during acquisition'), { code: 'SOURCE_CHANGED' });
    }
  }
  const reader = new ChangingReader(bytes);
  await assert.rejects(acquireImage({ reader, outputDirectory, source: sourceFor(reader), ...smallSettings }), { code: 'SOURCE_CHANGED' });
  const manifest = JSON.parse(await readFile(path.join(outputDirectory, 'acquisition.json'), 'utf8'));
  assert.equal(manifest.state, 'error');
  assert.equal(manifest.stopReason.code, 'SOURCE_CHANGED');
  assert.equal(manifest.image.bytesWritten, 1024 * 1024);
  assert.equal((await verifyAcquisition(outputDirectory)).valid, true);
}));

for (const terminalCode of [
  'DEVICE_CHANGED', 'HELPER_CLOSED', 'LENGTH_QUERY_FAILED', 'GEOMETRY_QUERY_FAILED',
  'EXTENTS_QUERY_FAILED', 'IDENTITY_QUERY_FAILED'
]) {
  test(`${terminalCode} from a Windows reader stops immediately without retry or zero filler`, async () => withOwnedDirectory(async outputDirectory => {
    const bytes = fixtureBytes(128 * 1024);
    class TerminalReader extends FixtureReader {
      async read(offset, length, options) {
        this.readCalls.push({ offset, length });
        throw Object.assign(new Error(`injected ${terminalCode}`), { code: terminalCode });
      }
    }
    const reader = new TerminalReader(bytes, { sourceKind: 'volume', identity: `volume:${terminalCode}` });
    await assert.rejects(acquireImage({
      reader, outputDirectory, source: sourceFor(reader, 'generated volume fixture'), ...smallSettings,
      checkpointSize: 128 * 1024, maxReadAttempts: 3
    }), { code: terminalCode });
    assert.equal(reader.readCalls.length, 1);
    const manifest = JSON.parse(await readFile(path.join(outputDirectory, 'acquisition.json'), 'utf8'));
    assert.equal(manifest.state, 'error');
    assert.equal(manifest.stopReason.code, terminalCode);
    assert.equal(manifest.readErrors.length, 0);
    assert.equal(manifest.zeroFilledBytes, 0);
    assert.equal(manifest.image.bytesWritten, 0);
    assert.equal((await verifyAcquisition(outputDirectory)).valid, true);
  }));
}

test('a timed-out reader that ignores abort is not retried into overlapping reads', async () => withOwnedDirectory(async outputDirectory => {
  const bytes = fixtureBytes(64 * 1024);
  class IgnoringReader extends FixtureReader {
    async read(offset, length) {
      this.readCalls.push({ offset, length });
      return new Promise(() => {});
    }
  }
  const reader = new IgnoringReader(bytes);
  await assert.rejects(acquireImage({
    reader, outputDirectory, source: sourceFor(reader), ...smallSettings,
    checkpointSize: 64 * 1024, readTimeoutMs: 10, maxReadAttempts: 3
  }), { code: 'READ_TIMEOUT' });
  assert.equal(reader.readCalls.length, 1);
  const manifest = JSON.parse(await readFile(path.join(outputDirectory, 'acquisition.json'), 'utf8'));
  assert.equal(manifest.state, 'error');
  assert.equal(manifest.stopReason.code, 'READ_TIMEOUT');
  assert.equal(manifest.readErrors.length, 0);
  assert.equal((await verifyAcquisition(outputDirectory)).valid, true);
}));

test('cancellation promptly escapes a reader that ignores its abort signal', async () => withOwnedDirectory(async outputDirectory => {
  const bytes = fixtureBytes(64 * 1024);
  let announceStart;
  const started = new Promise(resolve => { announceStart = resolve; });
  class IgnoringReader extends FixtureReader {
    async read(offset, length) {
      this.readCalls.push({ offset, length });
      announceStart();
      return new Promise(() => {});
    }
  }
  const reader = new IgnoringReader(bytes);
  const controller = new AbortController();
  const acquisition = acquireImage({
    reader, outputDirectory, source: sourceFor(reader), signal: controller.signal, ...smallSettings,
    checkpointSize: 64 * 1024, readTimeoutMs: 5000
  });
  await started;
  const cancelledAt = Date.now();
  controller.abort();
  await assert.rejects(acquisition, { code: 'CANCELLED' });
  assert.ok(Date.now() - cancelledAt < 500, 'cancel should not wait for the per-read timeout');
  assert.equal(reader.readCalls.length, 1);
  const manifest = JSON.parse(await readFile(path.join(outputDirectory, 'acquisition.json'), 'utf8'));
  assert.equal(manifest.state, 'cancelled');
  assert.equal(manifest.image.bytesWritten, 0);
  assert.equal((await verifyAcquisition(outputDirectory)).valid, true);
}));

test('read failures retry a bounded count and zero filler remains distinct from real source zeros', async () => withOwnedDirectory(async outputDirectory => {
  const size = 4 * 64 * 1024;
  const bytes = fixtureBytes(size);
  bytes.fill(0, 0, 64 * 1024); // A real readable zero range must not enter the error ledger.
  const failedOffset = 2 * 64 * 1024;
  const reader = new FixtureReader(bytes, { failures: new Map([[failedOffset, Infinity]]) });
  const manifest = await acquireImage({
    reader, outputDirectory, source: sourceFor(reader), ...smallSettings,
    checkpointSize: size, maxReadAttempts: 2
  });

  assert.equal(manifest.state, 'partial');
  assert.equal(manifest.complete, false);
  assert.equal(manifest.readErrors.length, 1);
  assert.deepEqual({ ...manifest.readErrors[0], firstAt: undefined, lastAt: undefined }, {
    offset: failedOffset, length: 64 * 1024, code: 'EIO', attempts: 2,
    zeroFilled: true, firstAt: undefined, lastAt: undefined
  });
  assert.equal(manifest.zeroFilledBytes, 64 * 1024);
  assert.equal(reader.readCalls.filter(call => call.offset === failedOffset).length, 2);
  const image = await readFile(path.join(outputDirectory, 'image.raw'));
  assert.ok(image.subarray(0, 64 * 1024).every(byte => byte === 0));
  assert.ok(image.subarray(failedOffset, failedOffset + 64 * 1024).every(byte => byte === 0));
  assert.equal((await verifyAcquisition(outputDirectory)).valid, true);
  assert.equal((await verifyAcquisition(outputDirectory)).complete, false);
}));

test('cancellation persists a partial checkpoint and stable image input resumes to exact bytes', async () => withOwnedDirectory(async outputDirectory => {
  const bytes = fixtureBytes(3 * 1024 * 1024 + 19);
  const first = new FixtureReader(bytes);
  const controller = new AbortController();
  await assert.rejects(acquireImage({
    reader: first, outputDirectory, source: sourceFor(first), signal: controller.signal, ...smallSettings,
    onProgress(value) { if (value.phase === 'acquiring' && value.bytesProcessed >= 1024 * 1024 + 128 * 1024) controller.abort(); }
  }), { code: 'CANCELLED' });

  const cancelled = JSON.parse(await readFile(path.join(outputDirectory, 'acquisition.json'), 'utf8'));
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.complete, false);
  assert.ok(cancelled.image.bytesWritten >= 1024 * 1024);
  assert.equal((await verifyAcquisition(outputDirectory)).valid, true);

  const resumedReader = new FixtureReader(bytes, { identity: first.info.identity });
  const resumed = await acquireImage({ reader: resumedReader, outputDirectory, source: sourceFor(resumedReader), resume: true, ...smallSettings });
  assert.equal(resumed.state, 'complete');
  assert.equal(resumed.resumeCount, 1);
  assert.equal(resumed.image.sha256, sha256(bytes));
  assert.deepEqual(await readFile(path.join(outputDirectory, 'image.raw')), bytes);
  assert.equal((await verifyAcquisition(outputDirectory)).complete, true);
}));

test('resume rejects a changed committed output chunk', async () => withOwnedDirectory(async outputDirectory => {
  const bytes = fixtureBytes(2 * 1024 * 1024);
  const first = new FixtureReader(bytes);
  const controller = new AbortController();
  await assert.rejects(acquireImage({
    reader: first, outputDirectory, source: sourceFor(first), signal: controller.signal, ...smallSettings,
    onProgress(value) { if (value.bytesProcessed >= 1024 * 1024) controller.abort(); }
  }), { code: 'CANCELLED' });
  const imagePath = path.join(outputDirectory, 'image.raw');
  const changed = await readFile(imagePath);
  changed[7] ^= 0xff;
  await writeFile(imagePath, changed);
  const second = new FixtureReader(bytes, { identity: first.info.identity });
  await assert.rejects(acquireImage({ reader: second, outputDirectory, source: sourceFor(second), resume: true, ...smallSettings }), { code: 'IMAGE_TAMPERED' });
}));

test('resume rejects a hardlinked image.raw without truncating the generated source file', async () => withOwnedDirectory(async root => {
  const outputDirectory = path.join(root, 'acquisition');
  await mkdir(outputDirectory);
  const bytes = fixtureBytes(2 * 1024 * 1024);
  const originalPath = path.join(root, 'generated-source.img');
  await writeFile(originalPath, bytes);
  const originalHash = sha256(bytes);
  const first = new FixtureReader(bytes);
  const controller = new AbortController();
  await assert.rejects(acquireImage({
    reader: first, outputDirectory, source: sourceFor(first), signal: controller.signal, ...smallSettings,
    onProgress(value) { if (value.bytesProcessed >= 1024 * 1024) controller.abort(); }
  }), { code: 'CANCELLED' });
  const manifestPath = path.join(outputDirectory, 'acquisition.json');
  const manifestBefore = await readFile(manifestPath);
  const imagePath = path.join(outputDirectory, 'image.raw');
  await unlink(imagePath); // Exact generated acquisition artifact inside the verified test root.
  await link(originalPath, imagePath);

  const second = new FixtureReader(bytes, { identity: first.info.identity });
  await assert.rejects(acquireImage({
    reader: second, outputDirectory, source: sourceFor(second), resume: true, ...smallSettings
  }), { code: 'OUTPUT_CHANGED' });

  const originalAfter = await readFile(originalPath);
  assert.equal(originalAfter.length, bytes.length);
  assert.equal(sha256(originalAfter), originalHash);
  assert.deepEqual(await readFile(manifestPath), manifestBefore, 'failed resume admission must not rewrite the manifest');
}));

test('resume rereads and rejects a changed source prefix even when claimed identity is unchanged', async () => withOwnedDirectory(async outputDirectory => {
  const bytes = fixtureBytes(2 * 1024 * 1024);
  const first = new FixtureReader(bytes);
  const controller = new AbortController();
  await assert.rejects(acquireImage({
    reader: first, outputDirectory, source: sourceFor(first), signal: controller.signal, ...smallSettings,
    onProgress(value) { if (value.bytesProcessed >= 1024 * 1024) controller.abort(); }
  }), { code: 'CANCELLED' });
  const changedBytes = Buffer.from(bytes);
  changedBytes[99] ^= 0x7f;
  const manifestPath = path.join(outputDirectory, 'acquisition.json');
  const imagePath = path.join(outputDirectory, 'image.raw');
  const manifestBefore = await readFile(manifestPath);
  const imageBefore = await readFile(imagePath);
  const changed = new FixtureReader(changedBytes, { identity: first.info.identity });
  await assert.rejects(acquireImage({ reader: changed, outputDirectory, source: sourceFor(changed), resume: true, ...smallSettings }), { code: 'SOURCE_CHANGED' });
  assert.deepEqual(await readFile(manifestPath), manifestBefore);
  assert.deepEqual(await readFile(imagePath), imageBefore);
}));

test('live-volume resume is explicitly rejected instead of claiming a consistent snapshot', async () => withOwnedDirectory(async outputDirectory => {
  const bytes = fixtureBytes(2 * 1024 * 1024);
  const first = new FixtureReader(bytes, { sourceKind: 'volume', identity: 'volume:fixture-1' });
  const controller = new AbortController();
  await assert.rejects(acquireImage({
    reader: first, outputDirectory, source: sourceFor(first, 'generated volume fixture'), signal: controller.signal, ...smallSettings,
    onProgress(value) { if (value.bytesProcessed >= 1024 * 1024) controller.abort(); }
  }), { code: 'CANCELLED' });
  const second = new FixtureReader(bytes, { sourceKind: 'volume', identity: first.info.identity });
  await assert.rejects(acquireImage({ reader: second, outputDirectory, source: sourceFor(second), resume: true, ...smallSettings }), { code: 'LIVE_RESUME_UNSUPPORTED' });
}));

test('short reads are retried then recorded as zero-filled errors without being skipped', async () => withOwnedDirectory(async outputDirectory => {
  const bytes = fixtureBytes(128 * 1024);
  const reader = new FixtureReader(bytes, { shortReads: new Map([[0, 17]]) });
  const manifest = await acquireImage({
    reader, outputDirectory, source: sourceFor(reader), ...smallSettings,
    checkpointSize: 128 * 1024, maxReadAttempts: 3
  });
  assert.equal(reader.readCalls.filter(call => call.offset === 0).length, 3);
  assert.equal(manifest.readErrors[0].code, 'SHORT_READ');
  assert.equal(manifest.readErrors[0].attempts, 3);
  assert.equal(manifest.image.bytesWritten, bytes.length);
  const output = await readFile(path.join(outputDirectory, 'image.raw'));
  assert.ok(output.subarray(0, 64 * 1024).every(byte => byte === 0));
  assert.deepEqual(output.subarray(64 * 1024), bytes.subarray(64 * 1024));
}));

test('injected output-full failure persists an integrity-verifiable error artifact with no skipped bytes', async () => withOwnedDirectory(async outputDirectory => {
  const bytes = fixtureBytes(128 * 1024);
  const reader = new FixtureReader(bytes);
  let calls = 0;
  const injected = async ({ handle, buffer, offset, length, position }) => {
    calls += 1;
    if (calls === 1) return handle.write(buffer, offset, Math.floor(length / 2), position);
    throw Object.assign(new Error('injected destination full'), { code: 'ENOSPC' });
  };
  await assert.rejects(acquireImage({
    reader, outputDirectory, source: sourceFor(reader), ...smallSettings,
    checkpointSize: 128 * 1024, _test: { writeImage: injected }
  }), { code: 'ENOSPC' });
  const manifest = JSON.parse(await readFile(path.join(outputDirectory, 'acquisition.json'), 'utf8'));
  assert.equal(manifest.state, 'error');
  assert.equal(manifest.stopReason.code, 'ENOSPC');
  assert.equal(manifest.image.bytesWritten, 32 * 1024);
  assert.equal((await verifyAcquisition(outputDirectory)).valid, true);
}));

test('manifest-space exhaustion rolls back the uncommitted chunk without corrupting the last valid checkpoint', async () => withOwnedDirectory(async outputDirectory => {
  const bytes = fixtureBytes(128 * 1024);
  const reader = new FixtureReader(bytes);
  let manifestWrites = 0;
  const writeManifest = async ({ handle, buffer, offset, length, position }) => {
    manifestWrites += 1;
    if (manifestWrites >= 2) throw Object.assign(new Error('injected manifest destination full'), { code: 'ENOSPC' });
    return handle.write(buffer, offset, length, position);
  };

  await assert.rejects(acquireImage({
    reader, outputDirectory, source: sourceFor(reader), ...smallSettings,
    checkpointSize: 128 * 1024, _test: { writeManifest }
  }), { code: 'ENOSPC' });

  const manifest = JSON.parse(await readFile(path.join(outputDirectory, 'acquisition.json'), 'utf8'));
  assert.equal(manifest.state, 'running', 'the original manifest must remain parseable when no replacement can be allocated');
  assert.equal(manifest.checkpoint.bytesWritten, 0);
  assert.equal(manifest.checkpoint.journalBytes, 0);
  assert.equal((await readFile(path.join(outputDirectory, 'image.raw'))).length, 0);
  assert.equal((await readFile(path.join(outputDirectory, 'acquisition.journal'))).length, 0);
  const checkpoint = await verifyAcquisition(outputDirectory);
  assert.equal(checkpoint.valid, true);
  assert.equal(checkpoint.complete, false);

  const resumedReader = new FixtureReader(bytes, { identity: reader.info.identity });
  const resumed = await acquireImage({
    reader: resumedReader, outputDirectory, source: sourceFor(resumedReader), resume: true, ...smallSettings,
    checkpointSize: 128 * 1024
  });
  assert.equal(resumed.complete, true);
  assert.deepEqual(await readFile(path.join(outputDirectory, 'image.raw')), bytes);
  assert.equal((await verifyAcquisition(outputDirectory)).complete, true);
}));

test('a transient manifest ENOSPC after a prior checkpoint rolls back its hash and zero-fill ledger', async () => withOwnedDirectory(async outputDirectory => {
  const checkpointSize = 128 * 1024;
  const bytes = fixtureBytes(2 * checkpointSize);
  const first = new FixtureReader(bytes, { failures: new Map([[checkpointSize, Infinity]]) });
  let manifestWrites = 0;
  const writeManifest = async ({ handle, buffer, offset, length, position }) => {
    manifestWrites += 1;
    if (manifestWrites === 3) throw Object.assign(new Error('injected transient manifest destination full'), { code: 'ENOSPC' });
    return handle.write(buffer, offset, length, position);
  };

  await assert.rejects(acquireImage({
    reader: first, outputDirectory, source: sourceFor(first), ...smallSettings,
    checkpointSize, _test: { writeManifest }
  }), { code: 'ENOSPC' });

  const manifest = JSON.parse(await readFile(path.join(outputDirectory, 'acquisition.json'), 'utf8'));
  assert.equal(manifest.state, 'error');
  assert.equal(manifest.stopReason.code, 'ENOSPC');
  assert.equal(manifest.checkpoint.bytesWritten, checkpointSize);
  assert.equal(manifest.image.sha256, sha256(bytes.subarray(0, checkpointSize)));
  assert.deepEqual(manifest.readErrors, []);
  assert.equal(manifest.readErrorRangeCount, 0);
  assert.equal(manifest.zeroFilledBytes, 0);
  assert.deepEqual(await readFile(path.join(outputDirectory, 'image.raw')), bytes.subarray(0, checkpointSize));
  const checkpoint = await verifyAcquisition(outputDirectory);
  assert.equal(checkpoint.valid, true);
  assert.equal(checkpoint.complete, false);

  const resumedReader = new FixtureReader(bytes, { identity: first.info.identity });
  const resumed = await acquireImage({
    reader: resumedReader, outputDirectory, source: sourceFor(resumedReader), resume: true, ...smallSettings,
    checkpointSize
  });
  assert.equal(resumed.complete, true);
  assert.deepEqual(await readFile(path.join(outputDirectory, 'image.raw')), bytes);
  assert.equal((await verifyAcquisition(outputDirectory)).complete, true);
}));

test('verification reports changed output bytes and new acquisition refuses non-empty directories', async () => withOwnedDirectory(async outputDirectory => {
  await writeFile(path.join(outputDirectory, 'unrelated.txt'), 'must remain');
  const reader = new FixtureReader(fixtureBytes(64 * 1024));
  await assert.rejects(acquireImage({ reader, outputDirectory, source: sourceFor(reader), ...smallSettings, checkpointSize: 64 * 1024 }), { code: 'OUTPUT_NOT_EMPTY' });
  assert.equal(await readFile(path.join(outputDirectory, 'unrelated.txt'), 'utf8'), 'must remain');
}));

test('full verification detects post-acquisition image tampering', async () => withOwnedDirectory(async outputDirectory => {
  const bytes = fixtureBytes(192 * 1024);
  const reader = new FixtureReader(bytes);
  await acquireImage({ reader, outputDirectory, source: sourceFor(reader), ...smallSettings, checkpointSize: 192 * 1024 });
  const imagePath = path.join(outputDirectory, 'image.raw');
  const changed = await readFile(imagePath);
  changed[changed.length - 1] ^= 1;
  await writeFile(imagePath, changed);
  const report = await verifyAcquisition(outputDirectory);
  assert.equal(report.valid, false);
  assert.ok(report.errors.some(error => error.code === 'CHUNK_HASH_MISMATCH'));
  assert.ok(report.errors.some(error => error.code === 'IMAGE_HASH_MISMATCH'));
}));

test('verification rejects an image that changes through the same open handle path while hashing', async () => withOwnedDirectory(async outputDirectory => {
  const bytes = fixtureBytes(3 * 1024 * 1024);
  const reader = new FixtureReader(bytes);
  await acquireImage({ reader, outputDirectory, source: sourceFor(reader), ...smallSettings });
  const imagePath = path.join(outputDirectory, 'image.raw');
  let changed = false;
  await assert.rejects(verifyAcquisition(outputDirectory, {
    readSize: 64 * 1024,
    onProgress(value) {
      if (changed || value.phase !== 'verification' || value.bytesProcessed < 1024 * 1024) return;
      changed = true;
      const descriptor = openSync(imagePath, 'r+');
      try { writeSync(descriptor, Buffer.from([bytes.at(-1) ^ 0xff]), 0, 1, bytes.length - 1); }
      finally { closeSync(descriptor); }
    }
  }), { code: 'OUTPUT_CHANGED' });
  assert.equal(changed, true);
}));
