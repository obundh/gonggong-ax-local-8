import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { RecoveryJobs } from '../engine/job-service.mjs';
import { openNtfsProvider } from '../engine/ntfs-image.mjs';
import { discoverVolumes, openPartitionBytes } from '../engine/volume-layout.mjs';
import { prepareCombinedCandidate } from '../engine/combined-recovery.mjs';
import { decorateNativeCandidate, markPreparationFailure, nativePartitionStrategy,
  prepareNativeCandidate, scanNativePartition } from '../engine/native-recovery-adapter.mjs';
import { createUsnFixture, usnRecord } from './usn-fixture.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function nativeBatch(records, next = 2000) {
  const header = Buffer.alloc(8); header.writeBigInt64LE(BigInt(next));
  return Buffer.concat([header, ...records]);
}
function fakeNativeReader(bytes, records, { unavailable = false } = {}) {
  let journalRead = false;
  return {
    info: Object.freeze({ size: bytes.length, sectorSize: 512, sourceKind: 'volume', identity: digest(bytes) }),
    async read(offset, length) { return Buffer.from(bytes.subarray(offset, offset + length)); },
    async assertUnchanged() {},
    async close() {},
    async queryJournal() {
      if (unavailable) throw Object.assign(new Error('fixture journal unavailable'), { code: 'USN_UNAVAILABLE' });
      return { journalId: '99', firstUsn: '1000', lowestValidUsn: '1000', nextUsn: '2000' };
    },
    async readJournal() {
      if (journalRead) return { data: nativeBatch([], 2000) };
      journalRead = true; return { data: nativeBatch(records, 2000) };
    }
  };
}
async function syntheticNativeVolume(root, records, options) {
  const fixture = await createUsnFixture(path.join(root, `fixture-${randomUUID()}`));
  const source = await readFile(fixture.imagePath);
  const reader = fakeNativeReader(source, records, options);
  const layout = await discoverVolumes(reader);
  const partition = layout.volumes[0];
  const engine = await openNtfsProvider(openPartitionBytes(reader, partition));
  return { fixture, source, reader, layout, partition, engine };
}

test('native journal and vacancy routes both require preparation and preserve source bytes through exact recovery', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recovery-native-adapter-'));
  const records = [
    usnRecord({ recordNumber: 24, sequence: 6, reason: 0x1000, name: '원래-문서.txt', usn: 1100 }),
    usnRecord({ recordNumber: 24, sequence: 6, name: '삭제된-문서.txt', usn: 1200 })
  ];
  for (const strategy of ['journal', 'vacancy']) {
    const context = await syntheticNativeVolume(root, records);
    try {
      const route = nativePartitionStrategy({ sourceKind: 'volume', deletedStrategy: strategy === 'journal' ? 'auto' : 'vacancy',
        layout: context.layout, partition: context.partition, reader: context.reader });
      assert.equal(route.strategy, strategy);
      const published = [];
      const scan = await scanNativePartition(context.engine, { route, partitionId: context.partition.id,
        onCandidate: candidate => published.push(candidate) });
      const candidate = published.find(item => item.recordNumber === 24);
      assert.ok(candidate); assert.equal(candidate.status, 'unverified'); assert.equal(candidate.requiresPreparation, true);
      assert.equal(candidate.deletedAtSource, 'windows-usn'); assert.deepEqual(candidate.previousNameHints, ['원래-문서.txt']);
      assert.equal(context.engine.scanned.size, 0);

      let preparations = 0;
      const prepare = async (...args) => { preparations++; return prepareCombinedCandidate(...args); };
      const forPreview = await prepareNativeCandidate(context.engine, candidate, { prepare });
      assert.equal(forPreview.id, candidate.id); assert.equal(forPreview.partitionId, candidate.partitionId);
      assert.equal(forPreview.status, 'readable'); assert.equal(forPreview.requiresPreparation, false);
      assert.equal(forPreview.deletedAt, candidate.deletedAt); assert.deepEqual(forPreview.previousNameHints, candidate.previousNameHints);
      const preview = await context.engine.readCandidateBytes(candidate.recordNumber);
      assert.match(preview.toString(), /회복 연진 테스트 문서/);

      const forRecovery = await prepareNativeCandidate(context.engine, forPreview, { prepare });
      assert.equal(preparations, 2, 'the same published candidate is prepared again for recovery');
      const saved = await context.engine.recover(forRecovery.recordNumber, path.join(root, `output-${strategy}`));
      const expected = context.fixture.manifest.files.find(file => file.recordNumber === 24);
      assert.equal(digest(await readFile(saved.path)), expected.sha256);
      assert.equal(digest(await readFile(context.fixture.imagePath)), digest(context.source));
      assert.equal(scan.coverage.allDiskComplete, false);
    } finally { await context.engine.close(); await context.reader.close(); }
  }
});

test('native journal with an unknown timestamp stays unknown, and an unavailable journal never falls back to vacancy or full MFT scan', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recovery-native-unknown-'));
  const unknown = await syntheticNativeVolume(root, [
    usnRecord({ recordNumber: 24, sequence: 6, deletedAt: null, name: '삭제된-문서.txt', usn: 1200 })
  ]);
  try {
    const route = nativePartitionStrategy({ sourceKind: 'volume', deletedStrategy: 'auto', layout: unknown.layout,
      partition: unknown.partition, reader: unknown.reader });
    const scan = await scanNativePartition(unknown.engine, { route, partitionId: unknown.partition.id });
    const candidate = scan.candidates.find(item => item.recordNumber === 24);
    assert.ok(candidate); assert.equal(candidate.deletedAt, null); assert.equal(candidate.dateMatch, 'not-requested');
    assert.equal(scan.stats.vacancy, undefined); assert.equal(unknown.engine.scanned.size, 0);
  } finally { await unknown.engine.close(); await unknown.reader.close(); }

  const unavailable = await syntheticNativeVolume(root, [], { unavailable: true });
  try {
    const route = nativePartitionStrategy({ sourceKind: 'volume', deletedStrategy: 'auto', layout: unavailable.layout,
      partition: unavailable.partition, reader: unavailable.reader });
    const scan = await scanNativePartition(unavailable.engine, { route, partitionId: unavailable.partition.id });
    assert.equal(scan.complete, false); assert.equal(scan.candidates.length, 0);
    assert.equal(scan.stats.recordsRead, 0); assert.equal(scan.stats.vacancy, undefined);
    assert.ok(scan.warnings.some(warning => warning.code === 'USN_UNAVAILABLE'));
  } finally { await unavailable.engine.close(); await unavailable.reader.close(); }
});

test('changed native records become a non-saveable conflict and partition journal binding rejects mismatches', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recovery-native-changed-'));
  const context = await syntheticNativeVolume(root, [
    usnRecord({ recordNumber: 24, sequence: 6, name: '삭제된-문서.txt', usn: 1200 })
  ]);
  try {
    const route = nativePartitionStrategy({ sourceKind: 'volume', deletedStrategy: 'auto', layout: context.layout,
      partition: context.partition, reader: context.reader });
    const published = [];
    await scanNativePartition(context.engine, { route, partitionId: context.partition.id, onCandidate: item => published.push(item) });
    const candidate = published.find(item => item.recordNumber === 24);
    const original = context.engine.record.bind(context.engine);
    context.engine.record = async (...args) => {
      const record = await original(...args);
      return args[0] === 24 ? { ...record, fingerprint: 'changed-after-discovery' } : record;
    };
    let failure;
    try { await prepareNativeCandidate(context.engine, candidate); } catch (error) { failure = error; }
    assert.equal(failure?.code, 'SOURCE_CHANGED');
    const preparedBeforeRace = { ...candidate, status: 'readable', requiresPreparation: false, preparationStatus: 'checked' };
    const stale = markPreparationFailure(preparedBeforeRace, failure);
    assert.equal(stale.status, 'conflict'); assert.equal(stale.requiresPreparation, false);
    assert.equal(markPreparationFailure(stale, failure).reasons.filter(reason => reason === failure.message).length, 1);

    const oneSectorTail = { ...context.reader, info: { ...context.reader.info, size: context.reader.info.size + 512 } };
    const acceptedTail = nativePartitionStrategy({ sourceKind: 'volume', deletedStrategy: 'auto', layout: context.layout,
      partition: context.partition, reader: oneSectorTail });
    assert.equal(acceptedTail.strategy, 'journal', 'the observed one-sector Windows length tail remains bound to the direct volume');

    const mismatched = nativePartitionStrategy({ sourceKind: 'volume', deletedStrategy: 'auto', layout: context.layout,
      partition: { ...context.partition, size: context.partition.size - 1024 }, reader: context.reader });
    assert.equal(mismatched.reason, 'NATIVE_VOLUME_MISMATCH'); assert.equal(mismatched.journalProvider, undefined);
    for (const [layout, partition, reader] of [
      [context.layout, { ...context.partition, offset: 512, size: context.partition.size - 512 }, context.reader],
      [{ ...context.layout, volumes: [context.partition, context.partition] }, context.partition, context.reader],
      [context.layout, { ...context.partition, trusted: false }, context.reader],
      [context.layout, context.partition, { ...context.reader, info: { ...context.reader.info, sectorSize: 4096 } }]
    ]) {
      const rejected = nativePartitionStrategy({ sourceKind: 'volume', deletedStrategy: 'auto', layout, partition, reader });
      assert.equal(rejected.reason, 'NATIVE_VOLUME_MISMATCH');
    }
  } finally { await context.engine.close(); await context.reader.close(); }
});

test('job service publishes native strategies before launch and labels windows USN dates as final deletion records', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recovery-native-service-'));
  const workspace = path.join(root, 'workspace'); await mkdir(workspace);
  const device = { id: '\\\\.\\C:', label: 'fixture C:', driveLetter: 'C:', identity: 'native-fixture', fileSystem: 'NTFS',
    system: true, ready: true, reason: null, diskIds: ['0'], size: 1024 * 1024, sectorSize: 512 };
  const payloads = [], workers = [];
  const workerFactory = (_url, options) => {
    payloads.push(options.workerData);
    const worker = new EventEmitter(); worker.postMessage = () => {}; worker.unref = () => {}; worker.terminate = async () => 0;
    workers.push(worker); return worker;
  };
  const jobs = new RecoveryJobs({ workspace, inventory: async () => [device], workerFactory });
  await jobs.initialize();
  try {
    const sourceId = (await jobs.devices()).devices[0].id;
    const first = await jobs.start({ sourceId, mode: 'deleted', deletedStrategy: 'auto', filters: {} });
    assert.equal(first.coverage.strategy, 'native-journal'); assert.equal(first.coverage.requiresVacancyScan, true);
    assert.equal(first.coverage.requiresFullScan, true); assert.equal(payloads[0].deletedStrategy, 'auto');
    workers[0].emit('message', { type: 'candidate', candidate: { ...decorateNativeCandidate({ id: 'ntfs:24:7', name: '문서.txt',
      recordNumber: 24, sequence: 7, deletedAt: '2026-09-13T00:00:00.000Z', deletedAtSource: 'windows-usn' }, 'partition-1'),
      nameMatch: { kind: 'unknown' } } });
    workers[0].emit('message', { type: 'complete', complete: true, warnings: [], coverage: first.coverage, stats: {} });
    const listed = jobs.candidates({ jobId: first.jobId, limit: 10 });
    assert.equal(listed.items[0].deletedAtKind, 'final-delete-record');
    assert.equal(listed.items[0].deletedAtLabel, '최종 삭제 기록 시각');

    const second = await jobs.start({ sourceId, mode: 'deleted', deletedStrategy: 'vacancy', filters: {} });
    assert.equal(second.coverage.strategy, 'mft-vacancy'); assert.equal(second.coverage.requiresVacancyScan, false);
    assert.equal(payloads[1].deletedStrategy, 'vacancy');
  } finally { await jobs.dispose(); }
});
