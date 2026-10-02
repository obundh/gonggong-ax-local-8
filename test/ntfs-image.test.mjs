import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

import { openNtfsImage } from '../engine/ntfs-image.mjs';
import { createFixture, fixtureGeometry } from './ntfs-fixtures.mjs';

let suiteDirectory;
let fixture;
let sourceHash;

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function hashFile(filePath) {
  return hash(await readFile(filePath));
}

function findCandidate(scan, recordNumber) {
  return scan.candidates.find((candidate) => candidate.recordNumber === recordNumber);
}

function manifestRecord(recordNumber) {
  return fixture.manifest.files.find((item) => item.recordNumber === recordNumber);
}

async function withImage(callback) {
  const image = await openNtfsImage(fixture.imagePath);
  try {
    return await callback(image);
  } finally {
    await image.close();
  }
}

function isAbort(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR' || error?.code === 'CANCELLED';
}

function hasCode(code) {
  return (error) => error?.code === code;
}

function isInside(directory, target) {
  const relative = path.relative(path.resolve(directory), path.resolve(target));
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

before(async () => {
  suiteDirectory = await mkdtemp(path.join(os.tmpdir(), 'recoverychat-ntfs-'));
  fixture = await createFixture(path.join(suiteDirectory, 'fixture'));
  sourceHash = await hashFile(fixture.imagePath);
});

after(async () => {
  const [resolvedTmp, resolvedSuite] = await Promise.all([
    realpath(os.tmpdir()),
    realpath(suiteDirectory),
  ]);
  const relative = path.relative(resolvedTmp, resolvedSuite);
  assert.ok(relative && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  assert.match(path.basename(resolvedSuite), /^recoverychat-ntfs-/u);
  await rm(resolvedSuite, { recursive: true, force: true });
});

test('fixture is a small, deterministic, explicitly synthetic NTFS 3.1 image', async () => {
  const [image, manifestOnDisk] = await Promise.all([
    readFile(fixture.imagePath),
    readFile(fixture.manifestPath, 'utf8').then(JSON.parse),
  ]);

  assert.equal(image.subarray(3, 11).toString('ascii'), 'NTFS    ');
  assert.equal(image.readUInt16LE(11), fixtureGeometry.bytesPerSector);
  assert.equal(image[13], fixtureGeometry.sectorsPerCluster);
  assert.equal(image.readBigUInt64LE(48), BigInt(fixtureGeometry.mftLcn));
  assert.equal(image.readUInt16LE(510), 0xaa55);
  assert.equal(image.length, fixtureGeometry.totalClusters * fixtureGeometry.clusterSize);
  assert.equal(manifestOnDisk.synthetic, true);
  assert.match(manifestOnDisk.evidenceLimit, /not (?:a )?Windows-formatted volume/i);
  assert.equal(manifestOnDisk.ntfsVersion, '3.1');
  assert.deepEqual(manifestOnDisk.files, fixture.manifest.files);
  await assert.rejects(createFixture(fixture.fixtureDirectory));
  assert.equal(await hashFile(fixture.imagePath), sourceHash);
});

test('rejects missing files and images without a valid NTFS boot sector', async () => {
  const invalidBootPath = path.join(suiteDirectory, 'invalid-boot.img');
  await writeFile(invalidBootPath, Buffer.alloc(512), { flag: 'wx' });
  await assert.rejects(openNtfsImage(path.join(suiteDirectory, 'missing.img')));
  await assert.rejects(openNtfsImage(invalidBootPath));
});

test('opens the image and reports parsed volume information', async () => {
  await withImage(async (image) => {
    assert.ok(image.info && typeof image.info === 'object');
    assert.equal(typeof image.scanDeleted, 'function');
    assert.equal(typeof image.recover, 'function');
    assert.equal(typeof image.close, 'function');
  });
});

test('scan traverses every record and reports malformed records without claiming completeness', async () => {
  await withImage(async (image) => {
    const progress = [];
    const scan = await image.scanDeleted({ onProgress: (event) => progress.push(event) });

    assert.equal(scan.complete, false);
    assert.ok(Array.isArray(scan.candidates));
    assert.ok(Array.isArray(scan.warnings));
    assert.ok(scan.stats && typeof scan.stats === 'object');
    assert.equal(scan.stats.recordsRead, scan.stats.recordsTotal);
    assert.ok(scan.stats.malformedRecords >= 2);
    assert.ok(progress.length > 0, 'a full traversal should publish progress at least once');

    for (const expected of fixture.manifest.files) {
      const candidate = findCandidate(scan, expected.recordNumber);
      assert.ok(candidate, `record ${expected.recordNumber} should be represented`);
      assert.equal(candidate.recordNumber, expected.recordNumber);
      assert.equal(candidate.name, expected.name);
      assert.equal(candidate.size, expected.size);
      assert.equal(candidate.storage, expected.expectedStorage);
      assert.equal(candidate.status, expected.expectedStatus);
      assert.equal(candidate.pathStatus, expected.expectedPathStatus);
      assert.equal(candidate.deletedAt, null);
      assert.ok(candidate.modifiedAt, `record ${expected.recordNumber} should retain modified time`);
      assert.ok(!Number.isNaN(Date.parse(candidate.modifiedAt)));
      assert.ok(Array.isArray(candidate.reasons));
      if (candidate.pathStatus === 'known') assert.equal(typeof candidate.path, 'string');
      else assert.equal(candidate.path, null);
    }
  });
});

test('recovers resident, contiguous, and signed-relative multi-run data byte-for-byte', async () => {
  const destination = path.join(suiteDirectory, 'supported-recovery');
  await mkdir(destination, { recursive: true });

  await withImage(async (image) => {
    await image.scanDeleted();
    for (const recordNumber of [24, 25, 26]) {
      const expected = manifestRecord(recordNumber);
      const progress = [];
      const result = await image.recover(recordNumber, destination, {
        onProgress: (event) => progress.push(event),
      });
      assert.equal(result.status, 'saved');
      assert.equal(result.size, expected.size);
      assert.equal(result.sha256, expected.sha256);
      assert.equal(result.originalIdentityVerified, false);
      assert.equal(await hashFile(result.path), expected.sha256);
      assert.ok(isInside(destination, result.path));
      assert.ok(progress.length > 0, `record ${recordNumber} should publish recovery progress`);
    }
  });

  assert.equal(await hashFile(fixture.imagePath), sourceHash, 'scan/recovery must not alter the image');
});

test('never overwrites an existing destination and never treats the source image as output', async () => {
  const destination = path.join(suiteDirectory, 'collisions');
  await mkdir(destination, { recursive: true });
  const occupied = path.join(destination, manifestRecord(24).name);
  const marker = Buffer.from('existing user file must survive\n');
  await writeFile(occupied, marker);

  await withImage(async (image) => {
    await image.scanDeleted();
    const collisionResult = await image.recover(24, destination);
    assert.notEqual(path.resolve(collisionResult.path), path.resolve(occupied));
    assert.deepEqual(await readFile(occupied), marker);
    assert.equal(await hashFile(collisionResult.path), manifestRecord(24).sha256);

    const repeatedResult = await image.recover(24, destination);
    assert.notEqual(path.resolve(repeatedResult.path), path.resolve(collisionResult.path));
    assert.equal(await hashFile(repeatedResult.path), manifestRecord(24).sha256);

    await assert.rejects(
      image.recover(24, fixture.imagePath),
      hasCode('UNSAFE_OUTPUT'),
    );

    const imageNameResult = await image.recover(26, fixture.fixtureDirectory);
    assert.notEqual(path.resolve(imageNameResult.path), path.resolve(fixture.imagePath));
    assert.equal(await hashFile(imageNameResult.path), manifestRecord(26).sha256);
  });

  assert.equal(await hashFile(fixture.imagePath), sourceHash);
});

test('sanitizes unsafe record names and cannot traverse outside the destination', async () => {
  const destination = path.join(suiteDirectory, 'unsafe-name');
  await mkdir(destination, { recursive: true });

  await withImage(async (image) => {
    await image.scanDeleted();
    const result = await image.recover(27, destination);
    const relative = path.relative(destination, result.path);
    assert.ok(isInside(destination, result.path));
    assert.ok(!relative.split(/[\\/]+/u).includes('..'));
    assert.equal(await hashFile(result.path), manifestRecord(27).sha256);
  });
});

test('invalid USA records and non-file controls are not recoverable candidates', async () => {
  await withImage(async (image) => {
    const scan = await image.scanDeleted();
    const records = new Set(scan.candidates.map((candidate) => candidate.recordNumber));
    assert.equal(records.has(fixture.manifest.controls.invalidUsaRecord), false);
    assert.equal(records.has(fixture.manifest.controls.deletedDirectoryRecord), false);
    assert.equal(records.has(fixture.manifest.controls.activeFileRecord), false);
    assert.ok(scan.warnings.length > 0, 'invalid USA or malformed attributes should produce warnings');
  });
});

test('unsupported layouts and allocated-cluster conflicts are identified and refused', async () => {
  const destination = path.join(suiteDirectory, 'refused');
  await mkdir(destination, { recursive: true });

  await withImage(async (image) => {
    const scan = await image.scanDeleted();
    for (const recordNumber of [34, 35, 36, 37, 38]) {
      const expected = manifestRecord(recordNumber);
      const candidate = findCandidate(scan, recordNumber);
      assert.ok(candidate);
      assert.equal(candidate.status, expected.expectedStatus);
      assert.ok(candidate.reasons.length > 0, `record ${recordNumber} should explain why it is refused`);
      await assert.rejects(image.recover(recordNumber, destination));
    }
  });
});

test('parent sequence mismatch produces an unknown path without hiding readable data', async () => {
  await withImage(async (image) => {
    const scan = await image.scanDeleted();
    const orphan = findCandidate(scan, 33);
    assert.ok(orphan);
    assert.equal(orphan.path, null);
    assert.equal(orphan.pathStatus, 'unknown');
    assert.equal(orphan.status, 'readable');
    assert.equal(orphan.storage, 'resident');
  });
});

test('maxCandidates truncates a scan and marks the result incomplete', async () => {
  await withImage(async (image) => {
    const scan = await image.scanDeleted({ maxCandidates: 2 });
    assert.equal(scan.complete, false);
    assert.equal(scan.candidates.length, 2);
    assert.ok(scan.stats && typeof scan.stats === 'object');
  });
});

test('requires a scan and rejects invalid scan limits and record indexes', async () => {
  const destination = path.join(suiteDirectory, 'invalid-inputs');
  await mkdir(destination, { recursive: true });

  await withImage(async (image) => {
    await assert.rejects(
      image.recover(24, destination),
      hasCode('SCAN_REQUIRED'),
    );
    for (const maxCandidates of [0, -1, 1.5, 100_001]) {
      await assert.rejects(
        image.scanDeleted({ maxCandidates }),
        hasCode('INVALID_LIMIT'),
      );
    }
    await image.scanDeleted();
    await assert.rejects(image.recover(-1, destination));
    await assert.rejects(image.recover(Number.MAX_SAFE_INTEGER, destination));
  });
});

test('refuses recovery after the source image metadata changes', async () => {
  const changedFixture = await createFixture(path.join(suiteDirectory, 'changed-source'));
  const image = await openNtfsImage(changedFixture.imagePath);
  try {
    await image.scanDeleted();
    const before = await stat(changedFixture.imagePath);
    const changedTime = new Date(before.mtimeMs + 2_000);
    await utimes(changedFixture.imagePath, changedTime, changedTime);
    await assert.rejects(
      image.recover(24, path.join(suiteDirectory, 'changed-source-output')),
      hasCode('SOURCE_CHANGED'),
    );
  } finally {
    await image.close();
  }
});

test('pre-cancelled and mid-copy operations stop with cancellation semantics', async () => {
  const destination = path.join(suiteDirectory, 'cancelled');
  await mkdir(destination, { recursive: true });

  await withImage(async (image) => {
    const scanController = new AbortController();
    scanController.abort();
    await assert.rejects(
      image.scanDeleted({ signal: scanController.signal }),
      isAbort,
    );

    await image.scanDeleted();
    const recoveryController = new AbortController();
    recoveryController.abort();
    await assert.rejects(
      image.recover(25, destination, { signal: recoveryController.signal }),
      isAbort,
    );

    const midCopyController = new AbortController();
    let progressEvents = 0;
    await assert.rejects(
      image.recover(25, destination, {
        signal: midCopyController.signal,
        onProgress: () => {
          progressEvents += 1;
          midCopyController.abort();
        },
      }),
      isAbort,
    );
    assert.ok(progressEvents >= 1);
  });
});
