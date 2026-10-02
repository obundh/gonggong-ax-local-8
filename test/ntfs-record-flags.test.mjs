import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openNtfsImage, openNtfsProvider } from '../engine/ntfs-image.mjs';
import { createFixture, fixtureGeometry as geometry } from './ntfs-fixtures.mjs';
import { createSplitSparseUsnFixture, createUsnFixture } from './usn-fixture.mjs';

const PERIOD = { deletedAfter: '2026-09-12T00:00:00.000Z', deletedBefore: '2026-09-13T23:59:59.999Z' };
const JOURNAL_RECORD = 43;
const prefix = 'recoverychat-record-flags-';
const recordOffset = number => geometry.mftLcn * geometry.clusterSize + number * geometry.fileRecordSize;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function isolated(run) {
  const temporaryBase = path.resolve(os.tmpdir());
  const root = await mkdtemp(path.join(temporaryBase, prefix));
  let engine;
  try {
    const fixture = await run.prepare(path.join(root, 'fixture'));
    engine = await openNtfsImage(fixture.imagePath);
    await run.verify(engine, fixture, root);
  } finally {
    await engine?.close();
    const resolved = path.resolve(root);
    const relative = path.relative(temporaryBase, resolved);
    assert.ok(relative.startsWith(prefix) && !relative.includes(path.sep) && !path.isAbsolute(relative));
    await rm(resolved, { recursive: true, force: true });
  }
}

function attributeOffset(bytes, recordNumber, type) {
  const begin = recordOffset(recordNumber);
  let cursor = begin + bytes.readUInt16LE(begin + 20);
  const used = begin + bytes.readUInt32LE(begin + 24);
  while (cursor + 8 <= used && bytes.readUInt32LE(cursor) !== 0xffffffff) {
    if (bytes.readUInt32LE(cursor) === type) return cursor;
    const length = bytes.readUInt32LE(cursor + 4);
    assert.ok(length >= 24 && cursor + length <= used, 'fixture attribute walk remains bounded');
    cursor += length;
  }
  assert.fail(`fixture record ${recordNumber} must contain attribute ${type}`);
}

async function mutateFixture(directory, mutate, options) {
  const fixture = await createUsnFixture(directory, options);
  const bytes = await readFile(fixture.imagePath);
  mutate(bytes);
  await writeFile(fixture.imagePath, bytes);
  return fixture;
}

test('a system data $UsnJrnl supports period preview and full-scan deletion-time enrichment', async () => {
  await isolated({
    prepare: createUsnFixture,
    async verify(engine, fixture) {
      assert.equal((await engine.record(JOURNAL_RECORD)).flags, 5);
      const period = await engine.scanDeletedPeriod(PERIOD);
      assert.deepEqual(period.candidates.map(item => item.id), ['ntfs:24:7', 'ntfs:25:4']);
      assert.ok(period.candidates.every(item => item.deletedAtSource === 'ntfs-usn'));
      const preview = await engine.readCandidateBytes(24, { maxBytes: 8192 });
      assert.match((Buffer.isBuffer(preview) ? preview : preview.bytes).toString('utf8'), /회복 연진 테스트 문서/);

      const full = await engine.scanDeleted();
      assert.ok(!full.candidates.some(item => item.recordNumber === JOURNAL_RECORD));
      const times = await engine.readDeletionTimes(full.candidates);
      assert.deepEqual(times.timestamps, new Map([...fixture.deletionTimes].reverse()));
      assert.equal(times.complete, true, JSON.stringify(times.warnings));
    },
  });
});

test('the legacy live-data flag remains compatible with journal discovery', async () => {
  await isolated({
    prepare: directory => createUsnFixture(directory, { journalFlags: 1 }),
    async verify(engine) {
      assert.equal((await engine.record(JOURNAL_RECORD)).flags, 1);
      const result = await engine.scanDeletedPeriod(PERIOD);
      assert.deepEqual(result.candidates.map(item => item.id), ['ntfs:24:7', 'ntfs:25:4']);
    },
  });
});

test('view and system-view records parse but never become ordinary deleted candidates', async () => {
  await isolated({
    prepare: directory => mutateFixture(directory, bytes => {
      for (const [number, flags] of [[24, 4], [25, 8], [26, 12]]) bytes.writeUInt16LE(flags, recordOffset(number) + 22);
    }),
    async verify(engine, _fixture, root) {
      for (const [number, flags] of [[24, 4], [25, 8], [26, 12]]) assert.equal((await engine.record(number)).flags, flags);
      const result = await engine.scanDeleted();
      assert.ok(!result.candidates.some(item => [24, 25, 26, JOURNAL_RECORD].includes(item.recordNumber)));
      await assert.rejects(engine.readCandidateBytes(24, { maxBytes: 1024 }), { code: 'SCAN_REQUIRED' });
      await assert.rejects(engine.recover(25, path.join(root, 'unpublished')), { code: 'SCAN_REQUIRED' });
    },
  });
});

test('preview and recovery recheck that a selected record is still an ordinary deleted file', async () => {
  await isolated({
    prepare: createFixture,
    async verify(_engine, fixture, root) {
      const bytes = await readFile(fixture.imagePath);
      const provider = {
        info: { size: bytes.length, sourceKind: 'volume-image' },
        assertUnchanged: async () => {},
        close: async () => {},
        read: async (offset, length) => Buffer.from(bytes.subarray(offset, offset + length)),
      };
      const mutable = await openNtfsProvider(provider);
      try {
        const scan = await mutable.scanDeleted();
        assert.ok(scan.candidates.some(item => item.recordNumber === 24));
        assert.ok(scan.candidates.some(item => item.recordNumber === 25));
        bytes.writeUInt16LE(4, recordOffset(24) + 22);
        await assert.rejects(mutable.readCandidateBytes(24, { maxBytes: 8192 }), { code: 'SOURCE_CHANGED' });
        bytes.writeUInt16LE(0, recordOffset(24) + 22);
        bytes.writeUInt16LE(8, recordOffset(25) + 22);
        await assert.rejects(mutable.recover(25, path.join(root, 'unpublished')), { code: 'SOURCE_CHANGED' });
      } finally {
        await mutable.close();
      }
    },
  });
});

test('unknown header bits and a zero sequence fail with numeric record details', async () => {
  await isolated({
    prepare: directory => mutateFixture(directory, bytes => {
      bytes.writeUInt16LE(16, recordOffset(24) + 22);
      bytes.writeUInt16LE(0, recordOffset(25) + 16);
    }),
    async verify(engine) {
      await assert.rejects(engine.record(24), error => {
        assert.equal(error.code, 'INVALID_RECORD');
        assert.deepEqual(error.details, { recordNumber: 24, sequence: 7, flags: 16 });
        return true;
      });
      await assert.rejects(engine.record(25), error => {
        assert.equal(error.code, 'INVALID_RECORD');
        assert.deepEqual(error.details, { recordNumber: 25, sequence: 0, flags: 0 });
        return true;
      });
      const scan = await engine.scanDeleted();
      assert.ok([24, 25].every(number => scan.warnings.some(item => item.recordNumber === number && item.code === 'INVALID_RECORD')));
      assert.ok(!scan.candidates.some(item => [24, 25].includes(item.recordNumber)));
    },
  });
});

test('system-data flags cannot bypass journal parent, generation, or MFT-allocation proofs', async () => {
  const variants = [
    ['parent', bytes => {
      const name = attributeOffset(bytes, JOURNAL_RECORD, 0x30);
      const value = name + bytes.readUInt16LE(name + 20);
      bytes.writeBigUInt64LE(11n | (2n << 48n), value);
    }],
    ['generation', bytes => bytes.writeUInt16LE(2, recordOffset(JOURNAL_RECORD) + 16)],
    ['allocation', bytes => {
      const bitmap = attributeOffset(bytes, 0, 0xb0);
      const value = bitmap + bytes.readUInt16LE(bitmap + 20);
      bytes[value + Math.floor(JOURNAL_RECORD / 8)] &= ~(1 << (JOURNAL_RECORD % 8));
    }],
  ];
  for (const [label, mutate] of variants) {
    await isolated({
      prepare: directory => mutateFixture(directory, mutate),
      async verify(engine) {
        assert.equal((await engine.record(JOURNAL_RECORD)).flags, 5, label);
        const result = await engine.scanDeletedPeriod(PERIOD);
        assert.equal(result.complete, false, label);
        assert.equal(result.candidates.length, 0, label);
        assert.ok(result.warnings.some(item => item.code === 'USN_UNAVAILABLE'), `${label}: ${JSON.stringify(result.warnings)}`);
      },
    });
  }
});

test('a Windows-shaped split sparse journal assembles both extents for period lookup and preview', async () => {
  await isolated({
    prepare: createSplitSparseUsnFixture,
    async verify(engine, fixture) {
      const base = await engine.record(fixture.journal.baseRecordNumber);
      assert.equal(base.flags, 5);
      const [firstRef, secondRef] = fixture.journal.extensions;
      const first = await engine.record(firstRef.recordNumber);
      const second = await engine.record(secondRef.recordNumber);
      const owner = BigInt(fixture.journal.baseRecordNumber) | 1n << 48n;
      assert.deepEqual([first.flags, first.sequence, first.baseReference], [1, firstRef.sequence, owner]);
      assert.deepEqual([second.flags, second.sequence, second.baseReference], [1, secondRef.sequence, owner]);
      const firstData = first.attributes.find(item => item.type === 0x80 && item.name === '$J');
      const secondData = second.attributes.find(item => item.type === 0x80 && item.name === '$J');
      assert.deepEqual([firstData.firstVcn, firstData.lastVcn, firstData.allocatedSize, firstData.sparsePhysicalSize],
        [0, 8, fixture.journal.logicalAllocatedSize, fixture.journal.physicalSize]);
      assert.deepEqual([secondData.firstVcn, secondData.lastVcn, secondData.size,
        secondData.initializedSize, secondData.allocatedSize], [9, 9, 0, 0, 0]);

      const result = await engine.scanDeletedPeriod(PERIOD);
      assert.deepEqual(result.candidates.map(item => item.id), ['ntfs:25:4', 'ntfs:24:7']);
      assert.equal(result.stats.journalRecordsRead, 2);
      const preview = await engine.readCandidateBytes(25, { maxBytes: 8192 });
      const expected = fixture.manifest.files.find(item => item.recordNumber === 25);
      assert.equal(sha256(preview), expected.sha256);
    },
  });
});

test('split sparse journals reject inconsistent sizes, units, and extended-header bytes', async () => {
  const variants = [
    ['physical-size', { physicalSize: 4096 }, false],
    ['extended-header', { extendedBaseHeader: false }, true],
    ['compression-unit', { compressionUnit: 3 }, true],
    ['reserved-header', { reservedByte35: 1 }, true],
  ];
  for (const [label, options, attributeProblem] of variants) {
    await isolated({
      prepare: directory => createSplitSparseUsnFixture(directory, options),
      async verify(engine, fixture) {
        const first = await engine.record(fixture.journal.extensions[0].recordNumber);
        const data = first.attributes.find(item => item.type === 0x80 && item.name === '$J');
        assert.equal(Boolean(data.problem), attributeProblem, label);
        const result = await engine.scanDeletedPeriod(PERIOD);
        assert.equal(result.complete, false, label);
        assert.equal(result.candidates.length, 0, label);
        assert.ok(result.warnings.some(item => ['USN_UNAVAILABLE', 'USN_UNSUPPORTED'].includes(item.code)),
          `${label}: ${JSON.stringify(result.warnings)}`);
      },
    });
  }
});

test('an extended sparse journal with no hole is accepted when logical and physical capacities agree', async () => {
  await isolated({
    prepare: directory => createSplitSparseUsnFixture(directory, { noHole: true }),
    async verify(engine, fixture) {
      assert.equal(fixture.journal.logicalAllocatedSize, fixture.journal.physicalSize);
      const result = await engine.scanDeletedPeriod(PERIOD);
      assert.deepEqual(result.candidates.map(item => item.id), ['ntfs:25:4', 'ntfs:24:7']);
      assert.equal(result.stats.journalRecordsRead, 2);
    },
  });
});
