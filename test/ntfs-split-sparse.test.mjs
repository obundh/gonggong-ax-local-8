import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

import { openNtfsImage, openNtfsProvider } from '../engine/ntfs-image.mjs';
import { createFixture, fixtureGeometry as geometry } from './ntfs-fixtures.mjs';
import {
  createSplitSparseFixture,
  splitSparseFixtureScenarios,
} from './ntfs-split-sparse-fixture.mjs';

const VALID_SCENARIOS = Object.freeze([
  'compact',
  'extended',
  'all-sparse-extension',
  'multi-extension-uninitialized',
]);

let suiteDirectory;
let baseFixture;
let fixtureIndex = 0;

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function sha256File(filePath) {
  return sha256(await readFile(filePath));
}

function recordOffset(recordNumber) {
  return geometry.mftLcn * geometry.clusterSize + recordNumber * geometry.fileRecordSize;
}

function recordAttributeOffset(bytes, recordNumber, type) {
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

function extensionFingerprintByte(recordNumber) {
  // Bytes 42-43 in a FILE header are unused by this bounded parser, but the
  // record fingerprint covers them. This isolates freshness from semantics.
  return recordOffset(recordNumber) + 42;
}

async function makeScenario(scenario) {
  assert.ok(splitSparseFixtureScenarios.includes(scenario));
  fixtureIndex += 1;
  return createSplitSparseFixture(
    path.join(suiteDirectory, `${String(fixtureIndex).padStart(2, '0')}-${scenario}`),
    { scenario, base: baseFixture },
  );
}

async function scanFixture(fixture, provider) {
  const image = provider ? await openNtfsProvider(provider) : await openNtfsImage(fixture.imagePath);
  const scan = await image.scanDeleted();
  const candidate = scan.candidates.find(item => item.recordNumber === fixture.recordNumber);
  assert.ok(candidate, `${fixture.scenario} candidate missing`);
  return { image, scan, candidate };
}

async function publishedEntries(directory) {
  try {
    return (await readdir(directory)).filter(name => name.startsWith('recovered-'));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function assertExactRecovery(fixture, { expectedExtensions = fixture.extensionRecordNumbers.length } = {}) {
  const beforeSHA = await sha256File(fixture.imagePath);
  assert.equal(beforeSHA, fixture.imageSHA);
  const { image, candidate } = await scanFixture(fixture);
  try {
    assert.equal(candidate.status, 'readable');
    assert.equal(candidate.storage, 'sparse');
    assert.equal(candidate.size, fixture.logicalSize);
    assert.ok(candidate.reasons.some(reason => reason.includes('희소')));
    assert.ok(candidate.reasons.some(reason => reason.includes('$ATTRIBUTE_LIST')));

    const checkpoint = image.exportCheckpoint();
    const entry = checkpoint.entries.find(item => item.recordNumber === fixture.recordNumber);
    assert.ok(entry);
    assert.equal(entry.extensions.length, expectedExtensions);
    assert.deepEqual(entry.extensions.map(item => item.recordNumber), fixture.extensionRecordNumbers);
    assert.ok(entry.extensions.every(item => /^[0-9a-f]{64}$/u.test(item.fingerprint)));

    const preview = await image.readCandidateBytes(fixture.recordNumber);
    assert.deepEqual(preview, fixture.expectedBytes);
    assert.equal(sha256(preview), fixture.expectedSHA);

    const saved = await image.recover(fixture.recordNumber, path.join(fixture.fixtureDirectory, 'output'));
    const recovered = await readFile(saved.path);
    assert.equal(saved.status, 'saved');
    assert.equal(saved.size, fixture.logicalSize);
    assert.equal(saved.sha256, fixture.expectedSHA);
    assert.deepEqual(recovered, fixture.expectedBytes);
    assert.equal(sha256(recovered), fixture.expectedSHA);
    assert.equal(await sha256File(fixture.imagePath), beforeSHA, 'read-only input image changed');
  } finally {
    await image.close();
  }
}

async function assertRejectedScenario(scenario) {
  const fixture = await makeScenario(scenario);
  const destination = path.join(fixture.fixtureDirectory, 'output');
  const { image, candidate } = await scanFixture(fixture);
  try {
    assert.notEqual(candidate.status, 'readable', scenario);
    await assert.rejects(image.recover(fixture.recordNumber, destination), { code: 'NOT_RECOVERABLE' });
    assert.deepEqual(await publishedEntries(destination), [], scenario);
  } finally {
    await image.close();
  }
}

class MutableImageProvider {
  constructor(bytes) {
    this.bytes = bytes;
    this.shortReadOffset = null;
    this.shortReadArmed = false;
    this.info = {
      size: bytes.length,
      sectorSize: 512,
      sourceKind: 'volume-image',
      identity: 'split-sparse-fixture',
    };
  }

  failNextReadCovering(offset) {
    this.shortReadOffset = offset;
    this.shortReadArmed = true;
  }

  async read(offset, length) {
    if (this.shortReadArmed && offset <= this.shortReadOffset && this.shortReadOffset < offset + length) {
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
  suiteDirectory = await mkdtemp(path.join(temporaryRoot, 'recoverychat-split-sparse-'));
  baseFixture = await createFixture(path.join(suiteDirectory, 'base'));
});

after(async () => {
  const temporaryRoot = path.resolve(process.env.TEMP || process.env.TMP || os.tmpdir());
  const relative = path.relative(temporaryRoot, suiteDirectory);
  assert.ok(relative && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  assert.match(path.basename(suiteDirectory), /^recoverychat-split-sparse-/u);
  await rm(suiteDirectory, { recursive: true, force: true });
});

test('fixture API accepts a base fixture, a base Buffer, or creates its own base image', async () => {
  const baseBytes = await readFile(baseFixture.imagePath);
  const fromBuffer = await createSplitSparseFixture(path.join(suiteDirectory, 'api-buffer'), {
    scenario: 'compact',
    base: baseBytes,
  });
  const owned = await createSplitSparseFixture(path.join(suiteDirectory, 'api-owned'), {
    scenario: 'extended',
  });
  assert.equal(fromBuffer.sourceImageSHA, sha256(baseBytes));
  assert.equal(owned.sourceImageSHA, sha256(await readFile(owned.baseFixture.imagePath)));
  assert.equal(await sha256File(fromBuffer.imagePath), fromBuffer.imageSHA);
  assert.equal(await sha256File(owned.imagePath), owned.imageSHA);
  assert.deepEqual(VALID_SCENARIOS.filter(item => splitSparseFixtureScenarios.includes(item)), VALID_SCENARIOS);
});

test('compact split sparse DATA previews and recovers exact known bytes', async () => {
  const fixture = await makeScenario('compact');
  assert.equal(fixture.compression, 0);
  await assertExactRecovery(fixture);
});

test('extended split sparse DATA proves logical allocation and physical total separately', async () => {
  const fixture = await makeScenario('extended');
  const bytes = await readFile(fixture.imagePath);
  const data = recordAttributeOffset(bytes, fixture.recordNumber, 0x80);
  const logicalCapacity = 6 * geometry.clusterSize;
  const physicalTotal = fixture.physicalRanges.reduce((sum, range) => sum + range.length, 0);
  assert.equal(fixture.compression, 4);
  assert.equal(bytes.readUInt16LE(data + 32), 72);
  assert.equal(bytes.readUInt16LE(data + 34), 4);
  assert.equal(bytes.readBigUInt64LE(data + 40), BigInt(logicalCapacity));
  assert.equal(bytes.readBigUInt64LE(data + 64), BigInt(physicalTotal));
  await assertExactRecovery(fixture);
});

test('an all-sparse continuation is zero-filled without a physical read', async () => {
  const fixture = await makeScenario('all-sparse-extension');
  const extensionStart = 3 * geometry.clusterSize;
  assert.deepEqual(
    fixture.expectedBytes.subarray(extensionStart),
    Buffer.alloc(fixture.logicalSize - extensionStart),
  );
  await assertExactRecovery(fixture);
});

test('two extension records preserve holes and zero a poisoned uninitialized tail', async () => {
  const fixture = await makeScenario('multi-extension-uninitialized');
  assert.deepEqual(fixture.extensionRecordNumbers, [43, 44]);
  assert.ok(fixture.initializedSize < fixture.logicalSize);
  assert.deepEqual(
    fixture.expectedBytes.subarray(fixture.initializedSize),
    Buffer.alloc(fixture.logicalSize - fixture.initializedSize),
  );
  const source = await readFile(fixture.imagePath);
  const tailPhysical = fixture.physicalRanges.find(range => range.firstVcn * geometry.clusterSize < fixture.logicalSize
    && (range.firstVcn + range.clusters) * geometry.clusterSize > fixture.initializedSize);
  assert.ok(tailPhysical);
  assert.ok(source.subarray(tailPhysical.offset, tailPhysical.offset + tailPhysical.length).some(byte => byte !== 0));
  await assertExactRecovery(fixture, { expectedExtensions: 2 });
});

test('split compressed DATA remains refused', async () => {
  await assertRejectedScenario('compressed');
});

test('extension owner, generation, and attribute id must match the list proof', async () => {
  for (const scenario of ['owner-mismatch', 'generation-mismatch', 'attribute-id-mismatch']) {
    await assertRejectedScenario(scenario);
  }
});

test('VCN gaps and overlaps both fail closed', async () => {
  for (const scenario of ['vcn-gap', 'vcn-overlap']) await assertRejectedScenario(scenario);
});

test('physical extents cannot overlap across split records', async () => {
  await assertRejectedScenario('physical-overlap');
});

test('base and continuation size contracts are enforced', async () => {
  for (const scenario of ['base-wrong-size', 'continuation-wrong-size', 'extended-physical-size']) {
    await assertRejectedScenario(scenario);
  }
});

test('base and continuation sparse flags and units must agree', async () => {
  for (const scenario of ['flag-mismatch', 'base-flag-mismatch', 'continuation-unit']) {
    await assertRejectedScenario(scenario);
  }
});

test('the FILE sparse flag must match the split DATA stream', async () => {
  await assertRejectedScenario('missing-file-sparse-flag');
});

test('an ATTRIBUTE_LIST file with a named stream remains unsupported', async () => {
  await assertRejectedScenario('named-stream');
});

test('a physical provider read failure never publishes a recovered file', async () => {
  const fixture = await makeScenario('extended');
  const bytes = await readFile(fixture.imagePath);
  const provider = new MutableImageProvider(bytes);
  const destination = path.join(fixture.fixtureDirectory, 'read-failure');
  const { image, candidate } = await scanFixture(fixture, provider);
  assert.equal(candidate.status, 'readable');
  provider.failNextReadCovering(fixture.physicalRanges[0].offset);
  try {
    let observed;
    await assert.rejects(image.recover(fixture.recordNumber, destination), error => {
      observed = error;
      return error?.code === 'READ_FAILED';
    });
    assert.equal(observed.details.savedPath, null);
    assert.deepEqual(await publishedEntries(destination), []);
  } finally {
    await image.close();
  }
});

test('fresh allocation metadata blocks a reused physical sparse extent', async () => {
  const fixture = await makeScenario('compact');
  const bytes = await readFile(fixture.imagePath);
  const provider = new MutableImageProvider(bytes);
  const destination = path.join(fixture.fixtureDirectory, 'allocation-reuse');
  const { image, candidate } = await scanFixture(fixture, provider);
  assert.equal(candidate.status, 'readable');
  const bitmap = recordAttributeOffset(bytes, 6, 0x80);
  const bitmapValue = bitmap + bytes.readUInt16LE(bitmap + 20);
  const cluster = fixture.physicalRanges[0].lcn;
  bytes[bitmapValue + Math.floor(cluster / 8)] |= 1 << (cluster % 8);
  try {
    await assert.rejects(image.recover(fixture.recordNumber, destination), { code: 'NOT_RECOVERABLE' });
    assert.deepEqual(await publishedEntries(destination), []);
  } finally {
    await image.close();
  }
});

test('recovery and checkpoint resume reject a changed extension fingerprint', async () => {
  const fixture = await makeScenario('extended');
  const bytes = await readFile(fixture.imagePath);
  const provider = new MutableImageProvider(bytes);
  const image = await openNtfsProvider(provider);
  let checkpoint;
  try {
    const candidate = (await image.scanDeleted()).candidates.find(item => item.recordNumber === fixture.recordNumber);
    assert.equal(candidate.status, 'readable');
    checkpoint = image.exportCheckpoint();
    bytes[extensionFingerprintByte(fixture.extensionRecordNumbers[0])] ^= 0x01;
    await assert.rejects(
      image.recover(fixture.recordNumber, path.join(fixture.fixtureDirectory, 'changed-before-copy')),
      { code: 'SOURCE_CHANGED' },
    );
  } finally {
    await image.close();
  }

  const resumed = await openNtfsProvider(new MutableImageProvider(bytes));
  try {
    await assert.rejects(resumed.scanDeleted({ resumeFrom: checkpoint }), { code: 'SOURCE_CHANGED' });
  } finally {
    await resumed.close();
  }
});

test('an extension changed during copying prevents final publication', async () => {
  const fixture = await makeScenario('multi-extension-uninitialized');
  const bytes = await readFile(fixture.imagePath);
  const destination = path.join(fixture.fixtureDirectory, 'changed-during-copy');
  const image = await openNtfsProvider(new MutableImageProvider(bytes));
  try {
    const candidate = (await image.scanDeleted()).candidates.find(item => item.recordNumber === fixture.recordNumber);
    assert.equal(candidate.status, 'readable');
    let changed = false;
    await assert.rejects(image.recover(fixture.recordNumber, destination, {
      control: {
        async checkpoint() {
          if (!changed) {
            changed = true;
            bytes[extensionFingerprintByte(fixture.extensionRecordNumbers[1])] ^= 0x01;
          }
        },
      },
    }), { code: 'SOURCE_CHANGED' });
    assert.equal(changed, true);
    assert.deepEqual(await publishedEntries(destination), []);
  } finally {
    await image.close();
  }
});
