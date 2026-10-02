import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openCandidateStore } from '../engine/candidate-store.mjs';
import { createUsnFixture, usnRecord } from './usn-fixture.mjs';
import { openNtfsImage } from '../engine/ntfs-image.mjs';
import { scanNativePartition } from '../engine/native-recovery-adapter.mjs';

test('bounded store batches retain duplicate updates at capacity and survive reopening', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'trace-batch-'));
  const target = path.join(root, 'candidates.sqlite');
  let store = openCandidateStore(target, { maxCandidates: 2 });
  try {
    assert.deepEqual(store.setBatch([{ id: 'a', name: 'first' }, { id: 'a', name: 'updated' }, { id: 'b' }, { id: 'c' }]),
      { imported: 3, skippedByLimit: 1, truncated: true });
    assert.equal(store.size, 2); assert.equal(store.get('a').name, 'updated');
    assert.deepEqual(store.setBatch([{ id: 'a', name: 'last', reference: 9007199254740995n }]),
      { imported: 1, skippedByLimit: 0, truncated: false });
    store.close(); store = openCandidateStore(target, { maxCandidates: 2 });
    assert.equal(store.get('a').reference, 9007199254740995n); assert.equal(store.size, 2);
    assert.throws(() => store.setBatch(Array.from({ length: 257 }, (_, i) => ({ id: String(i) }))), RangeError);
  } finally { store.close(); }
});

test('serialization and mid-transaction failures never commit a partial batch', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'trace-batch-fail-'));
  const store = openCandidateStore(path.join(root, 'candidates.sqlite'));
  try {
    assert.throws(() => store.setBatch([{ id: 'a' }, { id: 'bad', value() {} }]));
    assert.equal(store.size, 0);
    store.db.exec("CREATE TRIGGER reject_bad BEFORE INSERT ON candidates WHEN NEW.id = 'bad' BEGIN SELECT RAISE(ABORT, 'test failure'); END");
    assert.throws(() => store.setBatch([{ id: 'a' }, { id: 'bad' }]), { code: 'CANDIDATE_STORE_FAILED' });
    assert.equal(store.size, 0);
    assert.equal(store.setBatch([{ id: 'valid' }]).imported, 1);
  } finally { store.close(); }
});

test('native adapter publishes body candidates first and metadata in bounded decorated batches without losing rows', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'trace-native-batch-'));
  const fixture = await createUsnFixture(path.join(root, 'fixture'));
  const engine = await openNtfsImage(fixture.imagePath);
  const records = [usnRecord({ recordNumber: 24, sequence: 6, usn: 1100 })];
  for (let i = 0; i < 600; i++) records.push(usnRecord({ recordNumber: 10000 + i, sequence: 2, usn: 1200 + i, name: `lost-${i}.pdf` }));
  const header = Buffer.alloc(8); header.writeBigInt64LE(3000n);
  const provider = { async queryJournal() { return { journalId: '999', firstUsn: '1000', lowestValidUsn: '1000', nextUsn: '3000' }; },
    async readJournal() { return { data: Buffer.concat([header, ...records]) }; } };
  const bodies = [], batches = [], order = [];
  try {
    const result = await scanNativePartition(engine, { route: { strategy: 'journal', journalProvider: provider }, partitionId: 'v',
      onCandidate: c => { bodies.push(c); order.push('body'); },
      onCandidates: batch => { batches.push(batch); order.push('batch'); } });
    assert.equal(bodies.length, 1); assert.deepEqual(batches.map(b => b.length), [256, 256, 88]);
    assert.equal(order[0], 'body');
    assert.equal(new Set(batches.flat().map(c => c.id)).size, 600);
    assert.ok(batches.flat().every(c => c.id.startsWith('v/usn:') && c.partitionId === 'v' && !c.requiresPreparation && !c.hasContent));
    assert.equal(result.candidates.length, 601);
  } finally { await engine.close(); }
});
