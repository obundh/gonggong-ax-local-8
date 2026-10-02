import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createFixture, fixtureGeometry as geometry } from './ntfs-fixtures.mjs';
import { openNtfsImage, openNtfsProvider } from '../engine/ntfs-image.mjs';

async function isolated(callback) {
  const base = path.resolve(os.tmpdir()), root = await mkdtemp(path.join(base, 'recoverychat-ntfs-checkpoint-'));
  try { await callback(root); } finally {
    const relative = path.relative(base, root);
    assert.ok(relative.startsWith('recoverychat-ntfs-checkpoint-') && !relative.includes(path.sep));
    await rm(root, { recursive: true, force: true });
  }
}

async function cancelScanAt(image, callNumber) {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(image.scanDeleted({ signal: controller.signal, control: { async checkpoint() {
    calls += 1;
    if (calls === callNumber) controller.abort();
  } } }), { code: 'CANCELLED' });
}

function residentDataOffset(bytes, recordNumber) {
  const begin = geometry.mftLcn * geometry.clusterSize + recordNumber * geometry.fileRecordSize;
  let offset = begin + bytes.readUInt16LE(begin + 20);
  while (offset + 24 <= begin + geometry.fileRecordSize) {
    const type = bytes.readUInt32LE(offset);
    assert.notEqual(type, 0xffffffff);
    const length = bytes.readUInt32LE(offset + 4);
    assert.ok(length >= 24);
    if (type === 0x80 && bytes[offset + 8] === 0) return offset + bytes.readUInt16LE(offset + 20);
    offset += length;
  }
  assert.fail('resident data attribute not found');
}

test('cancelled image scan exports pure-data progress and resumes with exact candidates and prior warnings', async () => isolated(async root => {
  const fixture = await createFixture(path.join(root, 'fixture'));
  const image = await openNtfsImage(fixture.imagePath);
  let baseline;
  let saved;
  let savedBefore;
  let checkpoint;
  try {
    baseline = await image.scanDeleted();
    saved = await image.recover(24, path.join(root, 'recovered-before-resume'));
    savedBefore = await readFile(saved.path);

    await cancelScanAt(image, 50);
    checkpoint = image.exportCheckpoint();
    assert.equal(checkpoint.version, 1);
    assert.equal(checkpoint.nextRecord, 49);
    assert.equal(checkpoint.recordCount, geometry.mftRecordCount);
    assert.equal(checkpoint.recordSize, geometry.fileRecordSize);
    assert.equal(checkpoint.volumeSize, geometry.totalClusters * geometry.clusterSize);
    assert.ok(checkpoint.malformedRecords > 0);
    assert.ok(checkpoint.warnings.length > 0 && checkpoint.warnings.length <= 100);
    assert.ok(checkpoint.entries.length <= 10000);
    assert.doesNotThrow(() => JSON.stringify(checkpoint));

  } finally { await image.close(); }

  const resumedImage = await openNtfsImage(fixture.imagePath);
  try {
    const emitted = [], progress = [];
    const resumed = await resumedImage.scanDeleted({ resumeFrom: JSON.parse(JSON.stringify(checkpoint)),
      onCandidate: candidate => emitted.push(candidate.id), onProgress: value => progress.push(value) });
    assert.deepEqual(resumed.candidates.map(candidate => candidate.id), baseline.candidates.map(candidate => candidate.id));
    assert.deepEqual(emitted, baseline.candidates.map(candidate => candidate.id));
    assert.deepEqual(resumed.warnings, baseline.warnings);
    assert.deepEqual(resumed.stats, baseline.stats);
    assert.equal(resumed.complete, false);
    assert.equal(resumed.truncated, false);
    assert.equal(progress[0].resumed, true);
    assert.equal(progress[0].recordsRead, checkpoint.nextRecord);
    assert.deepEqual(await readFile(saved.path), savedBefore);
  } finally { await resumedImage.close(); }
}));

test('resume rejects changed candidate fingerprints and malformed or forged checkpoint structure', async () => isolated(async root => {
  const fixture = await createFixture(path.join(root, 'fixture'));
  const first = await openNtfsImage(fixture.imagePath);
  let checkpoint;
  try { await cancelScanAt(first, 35); checkpoint = first.exportCheckpoint(); } finally { await first.close(); }
  assert.ok(checkpoint.entries.some(entry => entry.recordNumber === 24));

  const bytes = await readFile(fixture.imagePath);
  bytes[residentDataOffset(bytes, 24)] ^= 0x5a;
  await writeFile(fixture.imagePath, bytes);
  const changed = await openNtfsImage(fixture.imagePath);
  try {
    await assert.rejects(changed.scanDeleted({ resumeFrom: checkpoint }), { code: 'SOURCE_CHANGED' });
    const wrongGeometry = { ...checkpoint, recordSize: checkpoint.recordSize * 2 };
    await assert.rejects(changed.scanDeleted({ resumeFrom: wrongGeometry }), { code: 'INVALID_CHECKPOINT' });
    const duplicate = { ...checkpoint, entries: [checkpoint.entries[0], checkpoint.entries[0]] };
    await assert.rejects(changed.scanDeleted({ resumeFrom: duplicate }), { code: 'INVALID_CHECKPOINT' });
    const outOfRange = { ...checkpoint, nextRecord: checkpoint.recordCount + 1 };
    await assert.rejects(changed.scanDeleted({ resumeFrom: outOfRange }), { code: 'INVALID_CHECKPOINT' });
  } finally { await changed.close(); }
}));

test('raw-volume providers can export cancellation state but cannot resume it', async () => isolated(async root => {
  const fixture = await createFixture(path.join(root, 'fixture')), bytes = await readFile(fixture.imagePath);
  class RawProvider {
    constructor(data) { this.bytes = data; this.info = { size: data.length, sectorSize: 512, sourceKind: 'windows-volume', identity: 'raw-checkpoint-fixture' }; }
    async read(offset, length) { return Buffer.from(this.bytes.subarray(offset, offset + length)); }
    async assertUnchanged() {}
    async close() {}
  }
  const image = await openNtfsProvider(new RawProvider(bytes));
  try {
    await cancelScanAt(image, 20);
    const checkpoint = image.exportCheckpoint();
    await assert.rejects(image.scanDeleted({ resumeFrom: checkpoint }), { code: 'CHECKPOINT_UNSUPPORTED' });
  } finally { await image.close(); }
}));
