import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

import { openNtfsProvider } from '../engine/ntfs-image.mjs';
import { recoveryOutcome } from '../engine/recovery-outcome.mjs';
import {
  createStage5BodyFixture,
  expectedSHA,
  logicalBytes,
  stage5BodyGeometry as geometry,
  stage5BodyRuns,
} from './stage5-body-fixture.mjs';

const MAX_PROVIDER_READ = 1024 * 1024;
let suiteDirectory;
let fixture;
let fixtureImage;

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function recordOffset(recordNumber) {
  return geometry.mftLcn * geometry.clusterSize + recordNumber * geometry.fileRecordSize;
}

function attributeOffset(bytes, recordNumber, type) {
  const begin = recordOffset(recordNumber);
  let offset = begin + bytes.readUInt16LE(begin + 20);
  while (offset + 8 <= begin + geometry.fileRecordSize) {
    const found = bytes.readUInt32LE(offset);
    assert.notEqual(found, 0xffffffff, `record ${recordNumber} attribute ${type} must exist`);
    if (found === type) return offset;
    const length = bytes.readUInt32LE(offset + 4);
    assert.ok(length >= 24);
    offset += length;
  }
  assert.fail(`record ${recordNumber} attribute ${type} was not found`);
}

function bitmapValueOffset(bytes) {
  const attribute = attributeOffset(bytes, fixture.volumeBitmapRecordNumber, 0x80);
  assert.equal(bytes[attribute + 8], 0);
  return attribute + bytes.readUInt16LE(attribute + 20);
}

function markClusterAllocated(bytes, cluster) {
  const value = bitmapValueOffset(bytes);
  bytes[value + Math.floor(cluster / 8)] |= 1 << (cluster % 8);
}

async function exists(filePath) {
  try { await stat(filePath); return true; } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function publishedEntries(directory) {
  try { return (await readdir(directory)).filter(name => name.startsWith('recovered-')); }
  catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
}

class MemoryProvider {
  constructor(bytes) {
    this.bytes = bytes;
    this.readLengths = [];
    this.failure = null;
    this.info = {
      size: bytes.length,
      sectorSize: 512,
      sourceKind: 'volume-image',
      identity: 'stage5-located-body-fixture',
    };
  }

  failOnce(kind, physicalOffset) {
    this.failure = { kind, physicalOffset, armed: true };
  }

  async read(offset, length) {
    this.readLengths.push(length);
    if (this.failure?.armed
      && offset <= this.failure.physicalOffset
      && this.failure.physicalOffset < offset + length) {
      this.failure.armed = false;
      if (this.failure.kind === 'error') {
        const error = new Error('synthetic provider read failure');
        error.code = 'EIO';
        throw error;
      }
      assert.equal(this.failure.kind, 'short');
      return Buffer.from(this.bytes.subarray(offset, offset + Math.max(0, length - 1)));
    }
    return Buffer.from(this.bytes.subarray(offset, offset + length));
  }

  async assertUnchanged() {}
  async close() {}
}

async function scannedImage(bytes = Buffer.from(fixtureImage)) {
  const provider = new MemoryProvider(bytes);
  const image = await openNtfsProvider(provider);
  const scan = await image.scanDeleted();
  const candidate = scan.candidates.find(item => item.recordNumber === fixture.recordNumber);
  assert.ok(candidate, 'the Stage 5 deleted record must be discoverable');
  assert.equal(candidate.status, 'readable');
  assert.equal(candidate.storage, 'nonresident');
  assert.equal(candidate.size, logicalBytes.length);
  assert.ok(candidate.reasons.some(reason => reason.includes('$ATTRIBUTE_LIST')));
  return { image, provider, candidate };
}

before(async () => {
  const temporaryRoot = path.resolve(process.env.TEMP || process.env.TMP || os.tmpdir());
  await mkdir(temporaryRoot, { recursive: true });
  suiteDirectory = await mkdtemp(path.join(temporaryRoot, 'recoverychat-stage5-body-'));
  fixture = await createStage5BodyFixture(path.join(suiteDirectory, 'fixture'));
  fixtureImage = await readFile(fixture.imagePath);
});

after(async () => {
  const temporaryRoot = path.resolve(process.env.TEMP || process.env.TMP || os.tmpdir());
  const relative = path.relative(temporaryRoot, suiteDirectory);
  assert.ok(relative && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  assert.match(path.basename(suiteDirectory), /^recoverychat-stage5-body-/u);
  await rm(suiteDirectory, { recursive: true, force: true });
});

test('fixture declares a consistent 16 MiB NTFS volume with nonascending fragmented runs and poisoned gaps', () => {
  assert.equal(fixtureImage.length, 16 * 1024 * 1024);
  assert.equal(Number(fixtureImage.readBigUInt64LE(40)) * geometry.bytesPerSector, fixtureImage.length);
  assert.equal(fixtureImage.length, geometry.totalClusters * geometry.clusterSize);
  assert.equal(logicalBytes.length, 9 * 1024 * 1024 + 137);
  assert.notEqual(logicalBytes.length % geometry.clusterSize, 0);
  assert.equal(sha256(logicalBytes), expectedSHA);
  assert.deepEqual(stage5BodyRuns.map(run => run.lcn), [3000, 100, 2200, 1000]);
  // Distinct data in every fragment makes a wrong order observable, even away from the header.
  const fragmentHeads = stage5BodyRuns.map(run => sha256(logicalBytes.subarray(
    run.vcn * geometry.clusterSize + 64, run.vcn * geometry.clusterSize + 64 + 4096)));
  assert.equal(new Set(fragmentHeads).size, stage5BodyRuns.length);

  const bitmap = bitmapValueOffset(fixtureImage);
  for (const run of stage5BodyRuns) {
    assert.equal(Boolean(fixtureImage[bitmap + Math.floor(run.lcn / 8)] & (1 << (run.lcn % 8))), false);
  }
  assert.equal(fixtureImage[900 * geometry.clusterSize], geometry.poisonByte, 'a physical gap must not resemble data');
  const finalRun = stage5BodyRuns.at(-1);
  const precedingCapacity = stage5BodyRuns.slice(0, -1)
    .reduce((sum, run) => sum + run.clusters * geometry.clusterSize, 0);
  const eofInFinalRun = logicalBytes.length - precedingCapacity;
  assert.equal(fixtureImage[finalRun.lcn * geometry.clusterSize + eofInFinalRun], geometry.tailPoisonByte);
});

test('recovers a fragmented file over 8 MiB exactly, never overwrites repeated saves, and keeps provider reads bounded', async () => {
  const { image, provider, candidate } = await scannedImage();
  const destination = path.join(suiteDirectory, 'complete-output');
  try {
    await assert.rejects(
      image.readCandidateBytes(candidate.recordNumber),
      error => error?.code === 'PREVIEW_TOO_LARGE',
    );
    assert.equal(candidate.status, 'readable', 'a preview limit must not relabel the file as unreadable');

    const first = await image.recover(candidate.recordNumber, destination);
    const firstBytes = await readFile(first.path);
    assert.equal(first.status, 'saved');
    assert.equal(first.size, logicalBytes.length);
    assert.equal(first.sha256, expectedSHA);
    assert.equal(sha256(firstBytes), expectedSHA);
    assert.deepEqual(firstBytes, logicalBytes);
    assert.equal(first.integrity.status, 'verified');
    assert.equal(first.document.status, 'needs-check');
    assert.equal(first.document.reason, 'FILE_TOO_LARGE');
    assert.equal(first.document.assessmentLimited, true);
    assert.equal(first.document.truncated, false);

    const outcome = recoveryOutcome(first);
    assert.equal(outcome.kind, 'saved-unchecked');
    assert.equal(outcome.partialContent, false);
    assert.equal(outcome.documentAssessmentLimited, true);
    assert.equal(outcome.originalBytesVerified, false);

    const second = await image.recover(candidate.recordNumber, destination);
    assert.notEqual(second.path, first.path);
    assert.equal(sha256(await readFile(second.path)), expectedSHA);
    assert.equal(sha256(await readFile(first.path)), expectedSHA, 'the earlier result must remain unchanged');
    assert.ok(provider.readLengths.includes(MAX_PROVIDER_READ));
    assert.ok(Math.max(...provider.readLengths) <= MAX_PROVIDER_READ);
  } finally {
    await image.close();
  }
});

test('a declared uninitialized tail is zero-filled even when its physical backing is dirty', async () => {
  const tailBytes = 211;
  const dirtyFixture = await createStage5BodyFixture(
    path.join(suiteDirectory, 'uninitialized-tail-fixture'),
    { uninitializedTailBytes: tailBytes },
  );
  const bytes = await readFile(dirtyFixture.imagePath);
  const finalRun = dirtyFixture.runs.at(-1);
  const priorCapacity = dirtyFixture.runs.slice(0, -1)
    .reduce((sum, run) => sum + run.clusters * geometry.clusterSize, 0);
  const physicalTailStart = finalRun.lcn * geometry.clusterSize + dirtyFixture.initializedSize - priorCapacity;
  assert.equal(bytes[physicalTailStart], geometry.tailPoisonByte);

  const provider = new MemoryProvider(bytes);
  const image = await openNtfsProvider(provider);
  try {
    const scan = await image.scanDeleted();
    const candidate = scan.candidates.find(item => item.recordNumber === dirtyFixture.recordNumber);
    assert.equal(candidate.status, 'readable');
    assert.ok(candidate.reasons.some(reason => reason.includes('초기화되지 않은')));
    const result = await image.recover(candidate.recordNumber, path.join(suiteDirectory, 'uninitialized-output'));
    const recovered = await readFile(result.path);
    assert.equal(result.size, dirtyFixture.logicalSize);
    assert.equal(result.sha256, dirtyFixture.expectedSHA);
    assert.deepEqual(recovered, dirtyFixture.expectedBytes);
    assert.deepEqual(recovered.subarray(-tailBytes), Buffer.alloc(tailBytes));
  } finally {
    await image.close();
  }
});

test('provider errors and short reads retain bounded range evidence and never publish success', async t => {
  for (const run of stage5BodyRuns.slice(0, 2)) for (const kind of ['error', 'short']) {
    await t.test(`${kind} at VCN ${run.vcn}`, async () => {
      const physicalOffset = run.lcn * geometry.clusterSize;
      const logicalOffset = run.vcn * geometry.clusterSize;
      const completedBytes = Math.floor(logicalOffset / MAX_PROVIDER_READ) * MAX_PROVIDER_READ;
      const { image, provider, candidate } = await scannedImage();
      const destination = path.join(suiteDirectory, `fault-${kind}-${run.vcn}`);
      provider.failOnce(kind, physicalOffset);
      try {
        let observed;
        await assert.rejects(image.recover(candidate.recordNumber, destination), error => {
          observed = error;
          return error?.code === 'READ_FAILED';
        });
        assert.equal(observed.details.savedPath, null);
        assert.ok(observed.details.partialPath);
        assert.equal(await exists(observed.details.partialPath), true);
        assert.deepEqual(await readFile(observed.details.partialPath), logicalBytes.subarray(0, completedBytes));
        assert.deepEqual(observed.details.readFailure, {
          logicalOffset,
          requestedBytes: MAX_PROVIDER_READ - (logicalOffset - completedBytes),
          physicalOffset,
          runVcn: run.vcn,
          runLcn: run.lcn,
          extentKind: 'physical',
          cause: kind === 'error' ? 'EIO' : 'READ_FAILED',
          exactFailedBytesKnown: false,
        });
        assert.deepEqual(await publishedEntries(destination), []);
        assert.ok(Math.max(...provider.readLengths) <= MAX_PROVIDER_READ);
      } finally {
        await image.close();
      }
    });
  }
});

test('cancellation after a copied chunk leaves a partial file and never publishes a completed result', async () => {
  const { image, candidate } = await scannedImage();
  const destination = path.join(suiteDirectory, 'cancel-output');
  const controller = new AbortController();
  try {
    let observed;
    await assert.rejects(image.recover(candidate.recordNumber, destination, {
      signal: controller.signal,
      onProgress(event) {
        if (event.stage === 'recover' && event.bytesWritten >= MAX_PROVIDER_READ) controller.abort();
      },
    }), error => {
      observed = error;
      return error?.code === 'CANCELLED';
    });
    assert.equal(observed.details.savedPath, null);
    assert.ok(observed.details.partialPath);
    assert.equal((await stat(observed.details.partialPath)).size, MAX_PROVIDER_READ);
    assert.equal(observed.details.readFailure, undefined);
    assert.deepEqual(await publishedEntries(destination), []);
  } finally {
    await image.close();
  }
});

test('fresh allocation metadata and a changed extension reference both fail closed before publication', async t => {
  await t.test('data reallocation', async () => {
    const bytes = Buffer.from(fixtureImage);
    const { image, candidate } = await scannedImage(bytes);
    const destination = path.join(suiteDirectory, 'reallocated-output');
    try {
      markClusterAllocated(bytes, stage5BodyRuns[0].lcn);
      await assert.rejects(image.recover(candidate.recordNumber, destination), error => {
        assert.equal(error?.details?.readFailure, undefined);
        return error?.code === 'NOT_RECOVERABLE' && error?.details?.savedPath == null;
      });
      assert.deepEqual(await publishedEntries(destination), []);
    } finally {
      await image.close();
    }
  });

  await t.test('extension reference changed', async () => {
    const bytes = Buffer.from(fixtureImage);
    const { image, candidate } = await scannedImage(bytes);
    const destination = path.join(suiteDirectory, 'extension-changed-output');
    try {
      bytes[fixture.extensionFingerprintByteOffset] ^= 0x01;
      await assert.rejects(image.recover(candidate.recordNumber, destination), error => {
        assert.equal(error?.details?.readFailure, undefined);
        return error?.code === 'SOURCE_CHANGED' && error?.details?.savedPath == null;
      });
      assert.deepEqual(await publishedEntries(destination), []);
    } finally {
      await image.close();
    }
  });
});

test('only an actual partial recovery result is classified as partial content', () => {
  const outcome = recoveryOutcome({
    status: 'saved',
    path: 'synthetic-result.bin',
    partial: true,
    document: { status: 'needs-check', reason: 'FILE_TOO_LARGE', assessmentLimited: true, truncated: false },
  });
  assert.equal(outcome.partialContent, true);
  assert.equal(outcome.documentAssessmentLimited, true);
  assert.equal(outcome.kind, 'partial-content-saved');
});
