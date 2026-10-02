import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import test, { before } from 'node:test';

import { scanCombined, prepareCombinedCandidate } from '../engine/combined-recovery.mjs';
import { EarlyCaptureStore } from '../engine/early-capture.mjs';
import { openNtfsImage } from '../engine/ntfs-image.mjs';
import { scanNativePartition } from '../engine/native-recovery-adapter.mjs';
import { createUsnFixture, usnRecord } from './usn-fixture.mjs';

const testTemp = process.env.RECOVERY_CAPTURE_TEST_TEMP ?? path.join(os.tmpdir(), 'recovery-capture-tests');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

before(async () => {
  process.env.TEMP = testTemp;
  process.env.TMP = testTemp;
  await mkdir(testTemp, { recursive: true });
});

async function directory(label) {
  return mkdtemp(path.join(testTemp, `${label}-`));
}

async function initializedStore(root, options = {}) {
  const captureRoot = path.join(root, 'capture');
  await mkdir(captureRoot);
  const store = new EarlyCaptureStore(captureRoot, options);
  await store.initialize();
  return store;
}

function candidate(overrides = {}) {
  return { id: 'capture:1', recordNumber: 24, sequence: 7, name: '원래 이름.txt', size: 5,
    reasons: ['synthetic candidate'], ...overrides };
}

function journalProvider(records = [usnRecord({ recordNumber: 24, sequence: 6, usn: 1200 })]) {
  const head = Buffer.alloc(8);
  head.writeBigInt64LE(2000n);
  return {
    async queryJournal() { return { journalId: 'capture-fixture', firstUsn: '1000', lowestValidUsn: '1000', nextUsn: '2000' }; },
    async readJournal() { return { data: Buffer.concat([head, ...records]) }; },
  };
}

async function writeCapture(bytes, destination, { outputName }) {
  const file = path.join(destination, outputName);
  await writeFile(file, bytes, { flag: 'wx' });
  return { path: file, status: 'saved', size: bytes.length, sha256: sha256(bytes),
    integrity: { status: 'verified' }, document: { status: 'not-verified' } };
}

test('capture budgets skip later candidates, failures remain per-candidate, and cancellation is explicit', async () => {
  const root = await directory('capture-limits');
  const store = await initializedStore(root, { limits: { maxFileBytes: 8, maxBytes: 5, maxAttempts: 1, maxMilliseconds: 1000 } });
  const first = candidate();
  const firstResult = await store.capture(first, (destination, options) => writeCapture(Buffer.from('first'), destination, options));
  assert.equal(firstResult.preservation.status, 'captured');

  let called = false;
  const limited = await store.capture(candidate({ id: 'capture:2' }), async () => { called = true; });
  assert.equal(limited.preservation.status, 'skipped');
  assert.equal(limited.preservation.reason, 'capture-budget');
  assert.equal(called, false);
  assert.equal(store.stats.captured, 1);
  assert.equal(store.stats.skipped, 1);
  assert.equal(store.stats.limited, true);

  const failureRoot = await directory('capture-failure');
  const failing = await initializedStore(failureRoot, { limits: { maxFileBytes: 8, maxBytes: 16, maxAttempts: 2, maxMilliseconds: 1000 } });
  const failed = await failing.capture(candidate({ id: 'capture:failed' }), async () => {
    throw Object.assign(new Error('synthetic read failure'), { code: 'READ_FAILED' });
  });
  assert.equal(failed.preservation.status, 'failed');
  assert.equal(failed.preservation.code, 'READ_FAILED');
  const afterFailure = await failing.capture(candidate({ id: 'capture:after-failure' }),
    (destination, options) => writeCapture(Buffer.from('after'), destination, options));
  assert.equal(afterFailure.preservation.status, 'captured');
  assert.equal(failing.stats.failed, 1);
  assert.equal(failing.stats.captured, 1);

  const controller = new AbortController();
  const cancelled = await initializedStore(await directory('capture-cancel'), { signal: controller.signal,
    limits: { maxFileBytes: 8, maxBytes: 16, maxAttempts: 2, maxMilliseconds: 1000 } });
  controller.abort();
  await assert.rejects(cancelled.capture(candidate(), async () => { throw new Error('must not read'); }), { code: 'CANCELLED' });
  assert.equal(cancelled.stats.attempted, 0);
});

test('a saved capture detects later tampering and keeps the chosen recovery name', async () => {
  const root = await directory('capture-tamper');
  const store = await initializedStore(root, { limits: { maxFileBytes: 8, maxBytes: 16, maxAttempts: 2, maxMilliseconds: 1000 } });
  const item = candidate({ id: 'capture:naming' });
  await store.capture(item, (destination, options) => writeCapture(Buffer.from('hello'), destination, options));

  const outputDirectory = path.join(root, 'recovered');
  await mkdir(outputDirectory);
  const recovered = await store.recover(item.id, outputDirectory);
  assert.equal(path.basename(recovered.path), '원래 이름.txt');
  assert.equal(recovered.originalIdentityVerified, false);
  assert.equal(recovered.preservation.source, 'discovery-capture');
  assert.equal(sha256(await readFile(recovered.path)), sha256(Buffer.from('hello')));

  const saved = store.entries.get(item.id).output.path;
  await writeFile(saved, Buffer.from('HELLO'));
  await assert.rejects(store.read(item.id), { code: 'CAPTURE_CHANGED' });
});

test('captured Zone.Identifier is preserved on export and later stream mutation is rejected', { skip: process.platform !== 'win32' }, async () => {
  const root = await directory('capture-zone');
  const store = await initializedStore(root);
  const zone = Buffer.from('[ZoneTransfer]\r\nZoneId=3\r\n');
  const item = candidate();
  await store.capture(item, async (destination, options) => {
    const output = await writeCapture(Buffer.from('hello'), destination, options);
    await writeFile(`${output.path}:Zone.Identifier`, zone, { flag: 'wx' });
    return { ...output, supplementalStreams: [{ name: 'Zone.Identifier', size: zone.length, preservation: 'preserved' }] };
  });
  assert.equal(store.has(item.id), true);
  const outputRoot = path.join(root, 'output'); await mkdir(outputRoot);
  const output = await store.recover(item.id, outputRoot);
  assert.deepEqual(await readFile(`${output.path}:Zone.Identifier`), zone);
  await writeFile(`${store.entries.get(item.id).output.path}:Zone.Identifier`, Buffer.from('changed'));
  await assert.rejects(store.read(item.id), { code: 'CAPTURE_CHANGED' });
});

test('scanCombined awaits discovery capture before record reuse and recovers the captured snapshot', async () => {
  const root = await directory('combined-snapshot');
  const fixture = await createUsnFixture(path.join(root, 'fixture'));
  const originalImageHash = sha256(await readFile(fixture.imagePath));
  const engine = await openNtfsImage(fixture.imagePath);
  const store = await initializedStore(root, { limits: { maxFileBytes: 16 * 1024 * 1024, maxBytes: 32 * 1024 * 1024, maxAttempts: 4, maxMilliseconds: 5000 } });
  try {
    const order = [];
    let discovered;
    const scan = await scanCombined(engine, { strategy: 'journal', journalProvider: journalProvider(),
      onDiscovered: async (item, captureTo) => {
        discovered = item;
        order.push('capture-start');
        const preservation = await store.capture(item, captureTo);
        assert.equal(preservation.preservation.status, 'captured');
        order.push('capture-finished');
        Object.assign(item, preservation);
      },
      onCandidate: async () => { order.push('published'); } });

    assert.deepEqual(order, ['capture-start', 'capture-finished', 'published']);
    assert.equal(scan.candidates.length, 1);
    assert.equal(scan.candidates[0].storage, 'captured');
    assert.equal(store.has(discovered.id), true);

    const originalRecord = engine.record.bind(engine);
    engine.record = async (recordNumber, signal) => recordNumber === 24
      ? { ...(await originalRecord(recordNumber, signal)), fingerprint: 'later-record-reuse' }
      : originalRecord(recordNumber, signal);
    await assert.rejects(prepareCombinedCandidate(engine, 24), { code: 'SOURCE_CHANGED' });

    const recoveredDirectory = path.join(root, 'recovered');
    await mkdir(recoveredDirectory);
    const recovered = await store.recover(discovered.id, recoveredDirectory);
    const expected = fixture.manifest.files.find(file => file.recordNumber === 24);
    assert.equal(sha256(await readFile(recovered.path)), expected.sha256);
    assert.equal(recovered.originalIdentityVerified, false);
    assert.equal(recovered.preservation.source, 'discovery-capture');
    assert.equal(sha256(await readFile(fixture.imagePath)), originalImageHash);
  } finally {
    await engine.close();
  }
});

test('native adapter decorates the discovered id before passing it to the capture store', async () => {
  const root = await directory('native-adapter');
  const fixture = await createUsnFixture(path.join(root, 'fixture'));
  const engine = await openNtfsImage(fixture.imagePath);
  const store = await initializedStore(root, { limits: { maxFileBytes: 16 * 1024 * 1024, maxBytes: 32 * 1024 * 1024, maxAttempts: 4, maxMilliseconds: 5000 } });
  try {
    const emitted = [];
    const result = await scanNativePartition(engine, { partitionId: 'volume-7', route: { strategy: 'journal', journalProvider: journalProvider() },
      onDiscovered: (item, captureTo) => store.capture(item, captureTo),
      onCandidate: item => emitted.push(item) });
    const capturedId = 'volume-7/ntfs:24:7';
    assert.equal(store.has(capturedId), true);
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].id, capturedId);
    assert.equal(emitted[0].storage, 'captured');
    assert.equal(result.candidates[0].storage, 'captured');
  } finally {
    await engine.close();
  }
});

test('a capture failure in scanCombined is recorded without aborting the scan result', async () => {
  const root = await directory('combined-failure');
  const fixture = await createUsnFixture(path.join(root, 'fixture'));
  const engine = await openNtfsImage(fixture.imagePath);
  const store = await initializedStore(root, { limits: { maxFileBytes: 16 * 1024 * 1024, maxBytes: 32 * 1024 * 1024, maxAttempts: 4, maxMilliseconds: 5000 } });
  try {
    let published = 0;
    const result = await scanCombined(engine, { strategy: 'journal', journalProvider: journalProvider(),
      onDiscovered: async item => {
        const preservation = await store.capture(item, async () => {
          throw Object.assign(new Error('synthetic capture read failed'), { code: 'READ_FAILED' });
        });
        Object.assign(item, preservation);
      },
      onCandidate: () => { published++; } });
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].preservation.status, 'failed');
    assert.equal(result.candidates[0].preservation.code, 'READ_FAILED');
    assert.equal(store.stats.failed, 1);
    assert.equal(published, 1);
  } finally {
    await engine.close();
  }
});
