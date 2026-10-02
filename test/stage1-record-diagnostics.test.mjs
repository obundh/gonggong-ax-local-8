import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { compareRecordEvidence, recordChangedError } from '../engine/record-diagnostics.mjs';
import { openNtfsProvider } from '../engine/ntfs-image.mjs';
import { createFixture, fixtureGeometry as geometry } from './ntfs-fixtures.mjs';

async function source(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recovery-record-evidence-'));
  const fixture = await createFixture(path.join(root, 'fixture'));
  const bytes = Buffer.from(await readFile(fixture.imagePath));
  const provider = { info: { size: bytes.length, sectorSize: geometry.sectorSize ?? 512 },
    async read(offset, length) { return Buffer.from(bytes.subarray(offset, offset + length)); },
    async assertUnchanged() {}, async close() {} };
  const engine = await openNtfsProvider(provider);
  t.after(() => engine.close());
  return { engine, bytes, offset: geometry.mftLcn * geometry.clusterSize + 24 * geometry.fileRecordSize };
}

test('raw LSN/slack changes preserve identity but remain refused and diagnosable', async t => {
  const { engine, bytes, offset } = await source(t);
  await engine.scanDeleted();
  const before = await engine.record(24);
  bytes.writeBigUInt64LE(bytes.readBigUInt64LE(offset + 8) + 1n, offset + 8);
  const used = bytes.readUInt32LE(offset + 24);
  assert.ok(used + 8 < geometry.fileRecordSize - 2);
  bytes[offset + used + 4] ^= 1;
  const after = await engine.record(24);
  const change = compareRecordEvidence(before, after);
  assert.equal(change.classification, 'same-generation-record-changed');
  assert.ok(change.changes.includes('logSequence')); assert.ok(change.changes.includes('slackHash'));
  assert.equal(change.changes.includes('dataLayoutHash'), false);
  await assert.rejects(engine.readCandidateBytes(24), error => {
    assert.equal(error.code, 'SOURCE_CHANGED');
    assert.equal(error.details.recordChange.classification, 'same-generation-record-changed');
    assert.equal(error.details.recordChange.expected.sequence, error.details.recordChange.observed.sequence);
    assert.equal(error.details.recordChange.physicalErasureProven, false);
    return true;
  });
});

test('generation plus allocated state proves record reuse, not erased document contents', async t => {
  const { engine, bytes, offset } = await source(t);
  const before = await engine.record(24);
  bytes.writeUInt16LE(before.sequence + 2, offset + 16);
  bytes.writeUInt16LE(1, offset + 22);
  const after = await engine.record(24);
  const error = recordChangedError(before, after, { stage: 'prepare-candidate' });
  assert.equal(error.details.recordChange.classification, 'record-reused');
  assert.equal(error.details.recordChange.physicalErasureProven, false);
  assert.equal(error.details.recordChange.expected.sequence, before.sequence);
  assert.equal(error.details.recordChange.observed.flags, 1);
  assert.doesNotMatch(JSON.stringify(error.details), /"value":|"data":\[/, 'resident body bytes are not logged');
});

test('generation-only differences do not automatically prove slot reuse', () => {
  const before = { recordNumber: 24, sequence: 7, flags: 0, fingerprint: 'old', names: [] };
  const value = compareRecordEvidence(before, { ...before, sequence: 8, fingerprint: 'new' });
  assert.equal(value.classification, 'record-generation-changed');
  assert.equal(compareRecordEvidence(before, null).classification, 'record-missing');
});
