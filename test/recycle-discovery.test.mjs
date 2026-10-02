import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { DeletedRecycleInfoCollector } from '../engine/deleted-recycle-discovery.mjs';
import { MAX_RECYCLE_METADATA_BYTES } from '../engine/recycle-metadata.mjs';
import { scanCombined, prepareCombinedCandidate } from '../engine/combined-recovery.mjs';
import { openNtfsImage } from '../engine/ntfs-image.mjs';
import {
  BODY_BYTES, ORIGINAL_PATH, RECYCLED_AT, RECYCLE_NAMES, RECYCLE_RECORDS,
  createRecycleDiscoveryFixture, recycleV2Payload
} from './recycle-discovery-fixture.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const emptyJournal = {};
const fingerprint = digit => digit.repeat(64);
const baselineRecord24 = image => image.subarray(4 * 4096 + 24 * 1024, 4 * 4096 + 25 * 1024);

async function fixture(label, options) {
  const root = await mkdtemp(path.join(os.tmpdir(), `recycle-discovery-${label}-`));
  return createRecycleDiscoveryFixture(path.join(root, 'fixture'), options);
}

test('vacancy scan publishes an independent metadata-only $I artifact without associating the matching $R body', async () => {
  const source = await fixture('integration');
  const before = hash(await readFile(source.imagePath));
  const engine = await openNtfsImage(source.imagePath);
  const discovered = [], published = [];
  try {
    const result = await scanCombined(engine, { strategy: 'vacancy', journalProvider: emptyJournal,
      onDiscovered: candidate => { discovered.push(candidate.recordNumber); },
      onCandidate: candidate => { published.push(candidate.recordNumber); } });
    const info = result.candidates.find(candidate => candidate.recordNumber === RECYCLE_RECORDS.info);
    const body = result.candidates.find(candidate => candidate.recordNumber === RECYCLE_RECORDS.body);

    assert.ok(info, 'deleted $I metadata is independently published');
    assert.equal(info.source, 'recycle-metadata');
    assert.equal(info.provenance, 'deleted-recycle-info');
    assert.equal(info.name, '원래-이름.txt');
    assert.equal(info.originalPath, ORIGINAL_PATH);
    assert.equal(info.recordedSize, BODY_BYTES.length);
    assert.equal(info.recycledAt, RECYCLED_AT);
    assert.equal(info.deletedAt, null);
    assert.equal(info.deletedAtSource, null);
    assert.equal(info.path, null);
    assert.equal(info.size, null);
    assert.equal(info.hasContent, false);
    assert.equal(info.requiresPreparation, false);
    assert.equal(info.bodyAssociation, 'not-asserted');
    assert.ok(!discovered.includes(RECYCLE_RECORDS.info), '$I does not receive an early capture callback');
    assert.ok(published.includes(RECYCLE_RECORDS.info));

    assert.ok(body, 'matching $R remains its own ordinary deleted record');
    assert.equal(body.source, 'deleted-record');
    assert.equal(body.name, RECYCLE_NAMES.body);
    assert.equal(body.discoveredName, RECYCLE_NAMES.body);
    assert.equal(body.originalPath, undefined);
    assert.equal(body.bodyAssociation, undefined);
    assert.equal(body.deletedAt, null);
    assert.ok(discovered.includes(RECYCLE_RECORDS.body));
    assert.ok(!JSON.stringify(body).includes('원래-이름.txt'));

    assert.deepEqual(result.stats.recycleMetadata, {
      inspected: 1, artifacts: 1, bytesRead: source.payload.length, skipped: 0, limited: false,
      skippedByCode: {}, maxArtifacts: 128, maxBytes: 8 * 1024 * 1024,
      existingDiscoveriesOnly: true, bodyAssociations: 0
    });
    assert.equal(result.coverage.recycleMetadataExistingDiscoveriesOnly, true);
    assert.equal(result.coverage.recycleMetadataBodyAssociations, 0);
    const afterImage = await readFile(source.imagePath);
    assert.equal(hash(afterImage), before, 'scan leaves the exact source image unchanged');
    assert.equal(hash(baselineRecord24(afterImage)), source.originalRecord24Hash, 'baseline deleted TXT record is byte exact');
    assert.equal(before, source.sourceHash);
  } finally { await engine.close(); }
});

test('wrong parent generation, non-SID directory, and invalid payload are rejected without metadata claims', async t => {
  const cases = [
    { name: 'wrong-parent-sequence', options: { infoParentSequence: 6 }, code: 'RECYCLE_METADATA_LOCATION' },
    { name: 'non-sid-directory', options: { sidName: 'ordinary-user-folder' }, code: 'RECYCLE_METADATA_LOCATION' },
    { name: 'invalid-payload', options: { payload: recycleV2Payload({ version: 3 }) }, code: 'RECYCLE_METADATA_INVALID' }
  ];
  for (const item of cases) await t.test(item.name, async () => {
    const source = await fixture(item.name, { ...item.options, includeBody: false });
    const engine = await openNtfsImage(source.imagePath);
    try {
      const result = await scanCombined(engine, { strategy: 'vacancy', journalProvider: emptyJournal });
      const candidate = result.candidates.find(value => value.recordNumber === RECYCLE_RECORDS.info);
      assert.ok(candidate, 'the ordinary vacancy candidate remains visible');
      assert.equal(candidate.source, 'deleted-record');
      assert.equal(candidate.name, RECYCLE_NAMES.info);
      assert.equal(candidate.originalPath, undefined);
      assert.equal(candidate.bodyAssociation, undefined);
      assert.equal(result.stats.recycleMetadata.inspected, 1);
      assert.equal(result.stats.recycleMetadata.artifacts, 0);
      assert.equal(result.stats.recycleMetadata.skipped, 1);
      assert.equal(result.stats.recycleMetadata.skippedByCode[item.code], 1);
    } finally { await engine.close(); }
  });
});

function mockEvidence() {
  const info = { recordNumber: 46, sequence: 6, fingerprint: fingerprint('a'), flags: 0, baseReference: 0n,
    attributes: [], names: [{ name: RECYCLE_NAMES.info, namespace: 1, parent: { recordNumber: 45, sequence: 5 } }] };
  const sid = { recordNumber: 45, sequence: 5, fingerprint: fingerprint('b'), flags: 3, baseReference: 0n,
    attributes: [], names: [{ name: 'S-1-5-21-100-200-300-1001', namespace: 1, parent: { recordNumber: 44, sequence: 4 } }] };
  const bin = { recordNumber: 44, sequence: 4, fingerprint: fingerprint('c'), flags: 3, baseReference: 0n,
    attributes: [], names: [{ name: '$Recycle.Bin', namespace: 1, parent: { recordNumber: 5, sequence: 1 } }] };
  const root = { recordNumber: 5, sequence: 1, fingerprint: fingerprint('d'), flags: 3, baseReference: 0n,
    attributes: [], names: [{ name: '.', namespace: 1, parent: { recordNumber: 5, sequence: 1 } }] };
  const discovered = { recordNumber: info.recordNumber, sequence: info.sequence, fingerprint: info.fingerprint,
    nameReferences: info.names.map(value => ({ name: value.name, namespace: value.namespace, parent: { ...value.parent } })) };
  return { info, sid, bin, root, discovered };
}

function mockEngine(records, mutate) {
  const calls = new Map();
  return { info: { recordCount: 64 }, mftBitmap: {},
    async record(number) {
      const count = (calls.get(number) ?? 0) + 1; calls.set(number, count);
      const record = records.get(number);
      return mutate?.(number, count, record) ?? record;
    },
    async bitmapBit(_stream, number) { return number === RECYCLE_RECORDS.bin || number === RECYCLE_RECORDS.sid || number === 5; }
  };
}

test('collector rejects record and directory read races after reading bytes', async t => {
  for (const mode of ['record', 'directory']) await t.test(mode, async () => {
    const evidence = mockEvidence();
    const records = new Map([[46, evidence.info], [45, evidence.sid], [44, evidence.bin], [5, evidence.root]]);
    let reads = 0;
    const engine = mockEngine(records, (number, count, record) => {
      if (mode === 'record' && number === 46 && count === 2) return { ...record, fingerprint: fingerprint('e') };
      if (mode === 'directory' && number === 45 && count === 2) return { ...record, fingerprint: fingerprint('e') };
      return record;
    });
    const collector = new DeletedRecycleInfoCollector(engine, {
      readBytes: async () => { reads++; return recycleV2Payload(); }
    });
    assert.equal(await collector.inspect(evidence.discovered), null);
    assert.equal(reads, 1, 'race is detected by the post-read attestation');
    assert.equal(collector.stats.artifacts, 0);
    assert.equal(collector.stats.skipped, 1);
    assert.equal(collector.stats.skippedByCode.SOURCE_CHANGED, 1);
  });
});

test('collector enforces construction bounds, artifact budget, byte budget, and cancellation', async () => {
  const evidence = mockEvidence();
  const records = new Map([[46, evidence.info], [45, evidence.sid], [44, evidence.bin], [5, evidence.root]]);
  const engine = mockEngine(records);
  assert.throws(() => new DeletedRecycleInfoCollector(engine, { readBytes() {}, maxArtifacts: 0 }), TypeError);
  assert.throws(() => new DeletedRecycleInfoCollector(engine, { readBytes() {}, maxBytes: MAX_RECYCLE_METADATA_BYTES - 1 }), TypeError);

  let reads = 0;
  const collector = new DeletedRecycleInfoCollector(engine, { maxArtifacts: 1, maxBytes: MAX_RECYCLE_METADATA_BYTES,
    readBytes: async () => { reads++; return recycleV2Payload(); } });
  assert.ok(await collector.inspect(evidence.discovered));
  assert.equal(await collector.inspect(evidence.discovered), null);
  assert.equal(reads, 1);
  assert.equal(collector.stats.inspected, 1);
  assert.equal(collector.stats.artifacts, 1);
  assert.equal(collector.stats.limited, true);

  const byteLimited = new DeletedRecycleInfoCollector(engine, { maxArtifacts: 2, maxBytes: MAX_RECYCLE_METADATA_BYTES,
    readBytes: async () => recycleV2Payload() });
  assert.ok(await byteLimited.inspect(evidence.discovered));
  assert.equal(await byteLimited.inspect(evidence.discovered), null);
  assert.equal(byteLimited.stats.inspected, 1, 'byte reservation stops reading before the attempt limit');
  assert.equal(byteLimited.stats.limited, true);

  const controller = new AbortController(); controller.abort();
  const cancelled = new DeletedRecycleInfoCollector(engine, { signal: controller.signal,
    readBytes: async () => { throw new Error('must not read'); } });
  await assert.rejects(cancelled.inspect(evidence.discovered), error => error?.code === 'CANCELLED');
  assert.equal(cancelled.stats.inspected, 0);
});

test('the same image yields new metadata evidence while baseline record 24 and TXT bytes stay exact', async t => {
  const source = await fixture('baseline-comparison');
  const baselineRoot = 'E:\\RecoveryChat-Stage4c-20260926\\baseline';
  try { await access(path.join(baselineRoot, 'engine', 'combined-recovery.mjs')); }
  catch { t.skip('external frozen baseline is unavailable'); return; }
  const baselineCombined = await import(pathToFileURL(path.join(baselineRoot, 'engine', 'combined-recovery.mjs')).href);
  const baselineNtfs = await import(pathToFileURL(path.join(baselineRoot, 'engine', 'ntfs-image.mjs')).href);
  const oldEngine = await baselineNtfs.openNtfsImage(source.imagePath);
  const newEngine = await openNtfsImage(source.imagePath);
  const sourceBefore = hash(await readFile(source.imagePath));
  try {
    const oldResult = await baselineCombined.scanCombined(oldEngine, { strategy: 'vacancy', journalProvider: emptyJournal });
    const newResult = await scanCombined(newEngine, { strategy: 'vacancy', journalProvider: emptyJournal });
    const oldInfo = oldResult.candidates.find(value => value.recordNumber === RECYCLE_RECORDS.info);
    const newInfo = newResult.candidates.find(value => value.recordNumber === RECYCLE_RECORDS.info);
    assert.equal(oldInfo.source, 'deleted-record');
    assert.equal(oldInfo.name, RECYCLE_NAMES.info);
    assert.equal(oldInfo.originalPath, undefined);
    assert.equal(newInfo.source, 'recycle-metadata');
    assert.equal(newInfo.originalPath, ORIGINAL_PATH);

    const oldTxt = oldResult.candidates.find(value => value.recordNumber === 24);
    const newTxt = newResult.candidates.find(value => value.recordNumber === 24);
    assert.deepEqual(newTxt, oldTxt, 'unrelated baseline candidate remains byte-for-byte equivalent as data');
    await baselineCombined.prepareCombinedCandidate(oldEngine, 24);
    await prepareCombinedCandidate(newEngine, 24);
    const [oldBytes, newBytes] = await Promise.all([oldEngine.readCandidateBytes(24), newEngine.readCandidateBytes(24)]);
    assert.ok(oldBytes.equals(newBytes));
    assert.equal(hash(oldBytes), source.manifest.files.find(value => value.recordNumber === 24).sha256);
    assert.equal(hash(await readFile(source.imagePath)), sourceBefore);
  } finally { await oldEngine.close(); await newEngine.close(); }
});
