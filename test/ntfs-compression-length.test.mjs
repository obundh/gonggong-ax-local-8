import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

import { decompressLznt1 } from '../engine/lznt1.mjs';
import { openNtfsImage, openNtfsProvider } from '../engine/ntfs-image.mjs';
import {
  compressionFixtureScenarios,
  createNativeCompressionBodies,
  createNtfsCompressionFixture,
  nativeCompressionSources,
} from './ntfs-compression-fixture.mjs';
import { createFixture, fixtureGeometry as geometry } from './ntfs-fixtures.mjs';

const UNIT_SIZE = 16 * geometry.clusterSize;
let suiteDirectory;
let baseFixture;
let nativeBodies;
let fixtureIndex = 0;

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function sha256File(filePath) {
  return sha256(await readFile(filePath));
}

async function makeScenario(scenario) {
  assert.ok(compressionFixtureScenarios.includes(scenario));
  fixtureIndex += 1;
  return createNtfsCompressionFixture(
    path.join(suiteDirectory, `${String(fixtureIndex).padStart(2, '0')}-${scenario}`),
    { scenario, base: baseFixture, nativeBodies },
  );
}

async function publishedEntries(directory) {
  try {
    return (await readdir(directory)).filter(name => name.startsWith('recovered-'));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

function recordOffset(recordNumber) {
  return geometry.mftLcn * geometry.clusterSize + recordNumber * geometry.fileRecordSize;
}

function attributeOffset(bytes, recordNumber, type) {
  const begin = recordOffset(recordNumber);
  let cursor = begin + bytes.readUInt16LE(begin + 20);
  while (cursor + 8 <= begin + geometry.fileRecordSize) {
    const found = bytes.readUInt32LE(cursor);
    assert.notEqual(found, 0xffffffff, `attribute ${type.toString(16)} must exist`);
    if (found === type) return cursor;
    const length = bytes.readUInt32LE(cursor + 4);
    assert.ok(length >= 24);
    cursor += length;
  }
  assert.fail(`attribute ${type.toString(16)} not found`);
}

async function scanFixture(fixture, provider) {
  const image = provider
    ? await openNtfsProvider(provider)
    : await openNtfsImage(fixture.imagePath);
  const scan = await image.scanDeleted();
  const candidate = scan.candidates.find(item => item.recordNumber === fixture.recordNumber);
  assert.ok(candidate, `${fixture.scenario} candidate missing`);
  return { image, candidate, scan };
}

async function assertExactRecovery(fixture, { preview = false } = {}) {
  const beforeSHA = await sha256File(fixture.imagePath);
  assert.equal(beforeSHA, fixture.imageSHA);
  const { image, candidate } = await scanFixture(fixture);
  try {
    assert.equal(candidate.status, 'readable');
    assert.equal(candidate.storage, 'compressed');
    assert.equal(candidate.size, fixture.logicalSize);
    if (preview) {
      const previewBytes = await image.readCandidateBytes(candidate.recordNumber);
      assert.deepEqual(previewBytes, fixture.expectedBytes);
    }
    const saved = await image.recover(
      candidate.recordNumber,
      path.join(fixture.fixtureDirectory, 'output'),
    );
    const recovered = await readFile(saved.path);
    assert.equal(saved.status, 'saved');
    assert.equal(saved.size, fixture.expectedBytes.length);
    assert.equal(saved.sha256, fixture.expectedSHA);
    assert.equal(sha256(recovered), fixture.expectedSHA);
    assert.deepEqual(recovered, fixture.expectedBytes);
    assert.equal(saved.originalIdentityVerified, false);
    assert.equal(await sha256File(fixture.imagePath), beforeSHA, 'read-only source image changed');
    return { saved, recovered };
  } finally {
    await image.close();
  }
}

class MemoryProvider {
  constructor(bytes) {
    this.bytes = bytes;
    this.shortReadOffset = null;
    this.shortReadArmed = false;
    this.info = {
      size: bytes.length,
      sectorSize: 512,
      sourceKind: 'volume-image',
      identity: 'synthetic-compression-length-fixture',
    };
  }

  failNextReadCovering(offset) {
    this.shortReadOffset = offset;
    this.shortReadArmed = true;
  }

  async read(offset, length) {
    if (this.shortReadArmed
      && offset <= this.shortReadOffset
      && this.shortReadOffset < offset + length) {
      this.shortReadArmed = false;
      return Buffer.from(this.bytes.subarray(offset, offset + Math.max(0, length - 1)));
    }
    return Buffer.from(this.bytes.subarray(offset, offset + length));
  }

  async assertUnchanged() {}
  async close() {}
}

before(async () => {
  const temporaryRoot = path.resolve(process.env.TEMP || process.env.TMP || os.tmpdir());
  await mkdir(temporaryRoot, { recursive: true });
  suiteDirectory = await mkdtemp(path.join(temporaryRoot, 'recoverychat-compression-length-'));
  baseFixture = await createFixture(path.join(suiteDirectory, 'base'));
  nativeBodies = createNativeCompressionBodies();
});

after(async () => {
  const temporaryRoot = path.resolve(process.env.TEMP || process.env.TMP || os.tmpdir());
  const relative = path.relative(temporaryRoot, suiteDirectory);
  assert.ok(relative && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  assert.match(path.basename(suiteDirectory), /^recoverychat-compression-length-/u);
  await rm(suiteDirectory, { recursive: true, force: true });
});

test('fixture API accepts a createFixture result, a base-image Buffer, or creates its own base', async () => {
  const baseBytes = await readFile(baseFixture.imagePath);
  const fromBuffer = await createNtfsCompressionFixture(
    path.join(suiteDirectory, 'api-base-buffer'),
    { scenario: 'partial-eof', base: baseBytes, nativeBodies },
  );
  const owned = await createNtfsCompressionFixture(
    path.join(suiteDirectory, 'api-owned-base'),
    { scenario: 'sparse-unit', nativeBodies },
  );
  assert.equal(fromBuffer.sourceImageSHA, sha256(baseBytes));
  assert.equal(owned.sourceImageSHA, sha256(await readFile(owned.baseFixture.imagePath)));
  assert.equal(await sha256File(fromBuffer.imagePath), fromBuffer.imageSHA);
  assert.equal(await sha256File(owned.imagePath), owned.imageSHA);
});

test('native 64 KiB LZNT1 fixture separates logical allocation from physical clusters', async () => {
  const fixture = await makeScenario('full-native');
  const bytes = await readFile(fixture.imagePath);
  const data = attributeOffset(bytes, fixture.recordNumber, 0x80);
  const packedOffset = fixture.physicalRanges[0].lcn * geometry.clusterSize;
  const packedLength = fixture.physicalRanges[0].clusters * geometry.clusterSize;
  const decoded = decompressLznt1(bytes.subarray(packedOffset, packedOffset + packedLength), {
    maxOutput: UNIT_SIZE,
  });
  assert.equal(bytes.readBigUInt64LE(data + 40), 65_536n);
  assert.equal(bytes.readBigUInt64LE(data + 64), BigInt(packedLength));
  assert.notEqual(packedLength, UNIT_SIZE, 'native body must exercise compressed physical allocation');
  assert.deepEqual(decoded, nativeCompressionSources().full);
});

test('recovers a complete native-compressed 64 KiB unit exactly', async () => {
  await assertExactRecovery(await makeScenario('full-native'));
});

test('uses logical EOF when a native stream decodes the entire compression unit', async () => {
  const fixture = await makeScenario('partial-eof');
  assert.ok(fixture.logicalSize < UNIT_SIZE);
  await assertExactRecovery(fixture);
});

test('accepts a native stream whose decoded body ends before the 64 KiB unit capacity', async () => {
  const fixture = await makeScenario('short-native');
  assert.equal(fixture.logicalSize, 19_333);
  await assertExactRecovery(fixture);
});

test('copies initialized bytes and zeroes a nonzero decoded tail through declared EOF', async () => {
  const fixture = await makeScenario('uninitialized-poison');
  const { recovered } = await assertExactRecovery(fixture);
  assert.deepEqual(recovered.subarray(fixture.initializedSize), Buffer.alloc(
    fixture.logicalSize - fixture.initializedSize,
  ));
  assert.ok(nativeCompressionSources().poison.subarray(fixture.initializedSize, fixture.logicalSize)
    .some(byte => byte !== 0), 'encoded tail must contain poison rather than accidental zeros');
});

test('recovers a wholly sparse compression unit as exact zero bytes', async () => {
  const fixture = await makeScenario('sparse-unit');
  assert.equal(fixture.physicalAllocatedSize, 0);
  await assertExactRecovery(fixture);
});

test('treats a full 16-cluster compression unit as raw data', async () => {
  const fixture = await makeScenario('raw-unit');
  assert.equal(fixture.physicalAllocatedSize, UNIT_SIZE);
  await assertExactRecovery(fixture);
});

test('preview and recovery preserve distinct data across a compression-unit boundary', async () => {
  const fixture = await makeScenario('multi-unit');
  const { recovered } = await assertExactRecovery(fixture, { preview: true });
  assert.deepEqual(
    recovered.subarray(UNIT_SIZE - 64, UNIT_SIZE + 64),
    fixture.expectedBytes.subarray(UNIT_SIZE - 64, UNIT_SIZE + 64),
  );
  assert.notDeepEqual(
    recovered.subarray(UNIT_SIZE - 64, UNIT_SIZE),
    recovered.subarray(UNIT_SIZE, UNIT_SIZE + 64),
  );
});

test('logical allocation and physical total mismatches both fail closed', async t => {
  for (const scenario of ['bad-logical-allocation', 'bad-physical-total']) {
    await t.test(scenario, async () => {
      const fixture = await makeScenario(scenario);
      const { image, candidate } = await scanFixture(fixture);
      try {
        assert.notEqual(candidate.status, 'readable');
        await assert.rejects(
          image.recover(candidate.recordNumber, path.join(fixture.fixtureDirectory, 'output')),
          { code: 'NOT_RECOVERABLE' },
        );
      } finally {
        await image.close();
      }
    });
  }
});

test('malformed and too-short LZNT1 bodies never publish a completed output', async t => {
  for (const scenario of ['malformed-decode', 'short-decode']) {
    await t.test(scenario, async () => {
      const fixture = await makeScenario(scenario);
      const destination = path.join(fixture.fixtureDirectory, 'output');
      const { image, candidate } = await scanFixture(fixture);
      try {
        assert.equal(candidate.status, 'readable', 'content validation is deferred until body read');
        let observed;
        await assert.rejects(
          image.recover(candidate.recordNumber, destination),
          error => {
            observed = error;
            return error?.code === 'INVALID_COMPRESSED_DATA';
          },
        );
        assert.equal(observed.details.savedPath, null);
        assert.deepEqual(await publishedEntries(destination), []);
      } finally {
        await image.close();
      }
    });
  }
});

test('a real provider short read rejects recovery and publishes no completed file', async () => {
  const fixture = await makeScenario('full-native');
  const bytes = await readFile(fixture.imagePath);
  const provider = new MemoryProvider(bytes);
  const destination = path.join(fixture.fixtureDirectory, 'provider-failure');
  const { image, candidate } = await scanFixture(fixture, provider);
  provider.failNextReadCovering(fixture.physicalRanges[0].lcn * geometry.clusterSize);
  try {
    let observed;
    await assert.rejects(image.recover(candidate.recordNumber, destination), error => {
      observed = error;
      return error?.code === 'READ_FAILED';
    });
    assert.equal(observed.details.savedPath, null);
    assert.deepEqual(await publishedEntries(destination), []);
  } finally {
    await image.close();
  }
});

test('fresh allocation metadata blocks a compressed extent changed after scan', async () => {
  const fixture = await makeScenario('full-native');
  const bytes = await readFile(fixture.imagePath);
  const provider = new MemoryProvider(bytes);
  const destination = path.join(fixture.fixtureDirectory, 'allocation-change');
  const { image, candidate } = await scanFixture(fixture, provider);
  const bitmap = attributeOffset(bytes, 6, 0x80);
  const bitmapValue = bitmap + bytes.readUInt16LE(bitmap + 20);
  const cluster = fixture.physicalRanges[0].lcn;
  bytes[bitmapValue + Math.floor(cluster / 8)] |= 1 << (cluster % 8);
  try {
    await assert.rejects(image.recover(candidate.recordNumber, destination), { code: 'NOT_RECOVERABLE' });
    assert.deepEqual(await publishedEntries(destination), []);
  } finally {
    await image.close();
  }
});

test('cancellation keeps only a partial private file and never publishes success', async () => {
  const fixture = await makeScenario('full-native');
  const destination = path.join(fixture.fixtureDirectory, 'cancelled');
  const { image, candidate } = await scanFixture(fixture);
  const controller = new AbortController();
  try {
    let observed;
    await assert.rejects(image.recover(candidate.recordNumber, destination, {
      signal: controller.signal,
      onProgress(event) {
        if (event.stage === 'recover' && event.bytesWritten > 0) controller.abort();
      },
    }), error => {
      observed = error;
      return error?.code === 'CANCELLED';
    });
    assert.equal(observed.details.savedPath, null);
    assert.ok(observed.details.partialPath.endsWith('.partial'));
    assert.equal((await stat(observed.details.partialPath)).size, fixture.logicalSize);
    assert.deepEqual(await publishedEntries(destination), []);
  } finally {
    await image.close();
  }
});
