import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { openNtfsImage } from '../engine/ntfs-image.mjs';
import { createFixture, fixtureGeometry as geometry } from './ntfs-fixtures.mjs';

const EMPTY_LAST_VCN = 0xffffffffffffffffn;

function recordOffset(number) { return geometry.mftLcn * geometry.clusterSize + number * geometry.fileRecordSize; }

function dataAttributeOffset(bytes, number) {
  const start = recordOffset(number);
  let offset = start + bytes.readUInt16LE(start + 20);
  while (offset + 8 <= start + geometry.fileRecordSize) {
    const type = bytes.readUInt32LE(offset);
    assert.notEqual(type, 0xffffffff, 'fixture record must contain $DATA');
    if (type === 0x80) return offset;
    const length = bytes.readUInt32LE(offset + 4);
    assert.ok(length >= 24 && offset + length <= start + geometry.fileRecordSize);
    offset += length;
  }
  assert.fail('fixture record has no $DATA attribute');
}

function installEmptyNonresidentSentinel(bytes, recordNumber = 25) {
  const attribute = dataAttributeOffset(bytes, recordNumber);
  const length = bytes.readUInt32LE(attribute + 4);
  assert.ok(length >= 72, 'fixture needs room for a nonresident mapping-pairs terminator');
  bytes.writeUInt16LE(0, attribute + 12);
  bytes.writeBigUInt64LE(0n, attribute + 16);
  bytes.writeBigUInt64LE(EMPTY_LAST_VCN, attribute + 24);
  bytes.writeUInt16LE(64, attribute + 32);
  bytes.writeUInt16LE(0, attribute + 34);
  bytes.writeBigUInt64LE(0n, attribute + 40);
  bytes.writeBigUInt64LE(0n, attribute + 48);
  bytes.writeBigUInt64LE(0n, attribute + 56);
  bytes.fill(0, attribute + 64, attribute + length);
  return attribute;
}

async function isolated(callback) {
  const base = path.resolve(os.tmpdir());
  const root = await mkdtemp(path.join(base, 'recoverychat-ntfs-empty-nonresident-'));
  try { await callback(root); } finally {
    const relative = path.relative(base, root);
    assert.ok(relative.startsWith('recoverychat-ntfs-empty-nonresident-') && !relative.includes(path.sep));
    await rm(root, { recursive: true, force: true });
  }
}

async function mutatedFixture(root, mutate) {
  const fixture = await createFixture(path.join(root, 'fixture'));
  const bytes = await readFile(fixture.imagePath);
  mutate(bytes);
  await writeFile(fixture.imagePath, bytes);
  return fixture;
}

test('accepts only the zero-size, empty-runlist nonresident -1 LastVCN sentinel', async () => isolated(async root => {
  const fixture = await mutatedFixture(root, bytes => installEmptyNonresidentSentinel(bytes));
  const image = await openNtfsImage(fixture.imagePath);
  try {
    const scan = await image.scanDeleted();
    const candidate = scan.candidates.find(item => item.recordNumber === 25);
    assert.equal(candidate?.status, 'readable');
    assert.equal(candidate?.storage, 'nonresident');
    assert.equal(candidate?.size, 0);
    assert.deepEqual(await image.readCandidateBytes(25), Buffer.alloc(0));

    const recovered = await image.recover(25, path.join(root, 'recovered'));
    assert.equal(recovered.status, 'saved');
    assert.equal(recovered.size, 0);
    assert.equal(recovered.sha256, createHash('sha256').update(Buffer.alloc(0)).digest('hex'));
    assert.equal((await readFile(recovered.path)).length, 0);
  } finally { await image.close(); }
}));

test('fails closed for malformed uses of the nonresident -1 LastVCN value', async () => isolated(async root => {
  const variants = [
    ['nonzero-size', (bytes, attribute) => bytes.writeBigUInt64LE(1n, attribute + 48)],
    ['nonzero-allocated-size', (bytes, attribute) => bytes.writeBigUInt64LE(BigInt(geometry.clusterSize), attribute + 40)],
    ['nonzero-initialized-size', (bytes, attribute) => bytes.writeBigUInt64LE(1n, attribute + 56)],
    ['sparse-flag', (bytes, attribute) => bytes.writeUInt16LE(0x8000, attribute + 12)],
    ['nonempty-runlist', (bytes, attribute) => { bytes[attribute + 64] = 0x11; bytes[attribute + 65] = 1; bytes[attribute + 66] = 20; }],
    ['nonzero-after-terminator', (bytes, attribute) => { bytes[attribute + 65] = 1; }],
  ];
  for (const [label, mutate] of variants) {
    const fixture = await mutatedFixture(path.join(root, label), bytes => {
      const attribute = installEmptyNonresidentSentinel(bytes);
      mutate(bytes, attribute);
    });
    const image = await openNtfsImage(fixture.imagePath);
    try {
      const scan = await image.scanDeleted();
      const candidate = scan.candidates.find(item => item.recordNumber === 25);
      assert.equal(candidate?.status, 'conflict', `${label} must not become recoverable`);
      await assert.rejects(image.readCandidateBytes(25), { code: 'NOT_RECOVERABLE' });
      await assert.rejects(image.recover(25, path.join(root, label, 'output')), { code: 'NOT_RECOVERABLE' });
    } finally { await image.close(); }
  }
}));
