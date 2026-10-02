import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { openNtfsImage, openNtfsProvider } from '../engine/ntfs-image.mjs';
import { readUsnDeletionTimes } from '../engine/usn-journal.mjs';
import { createFixture } from './ntfs-fixtures.mjs';
import { createUsnFixture, usnRecord, journalRecords } from './usn-fixture.mjs';

const candidate = { id: 'ntfs:24:7', recordNumber: 24, sequence: 7 };
const newer = '2026-09-13T02:00:00.000Z';
const older = '2026-09-12T10:00:00.000Z';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function scan(bytes, options = {}) {
  return readUsnDeletionTimes({ read: async (offset, length) => bytes.subarray(offset, offset + length),
    ranges: [{ offset: 0, length: bytes.length }], candidates: [candidate], ...options });
}

test('USN deletion timestamps use full record sequence and latest event independently of stream order', async () => {
  const result = await scan(journalRecords([usnRecord({ deletedAt: newer }), usnRecord({ deletedAt: older }),
    usnRecord({ sequence: 8, deletedAt: '2026-09-13T03:00:00.000Z' }), usnRecord({ reason: 0x100, deletedAt: '2026-09-13T04:00:00.000Z' })]));
  assert.equal(result.timestamps.get(candidate.id), newer); assert.equal(result.complete, true); assert.equal(result.stats.recordsRead, 4);
});
test('USN absent timestamps, unrelated records and unsupported versions cannot become deletion dates', async () => {
  const result = await scan(journalRecords([usnRecord({ deletedAt: null }), usnRecord({ recordNumber: 25 }), usnRecord({ major: 3 })]));
  assert.equal(result.timestamps.size, 0); assert.equal(result.complete, false);
  assert.ok(result.warnings.some(item => item.code === 'USN_UNSUPPORTED_VERSION'));
});
test('USN truncated or oversized records are skipped without fabricated timestamps', async () => {
  const huge = Buffer.alloc(64); huge.writeUInt32LE(0xfffffff8); huge.writeUInt16LE(2, 4);
  const result = await scan(Buffer.concat([huge, usnRecord().subarray(0, 64)]));
  assert.equal(result.timestamps.size, 0); assert.equal(result.complete, false);
  assert.ok(result.warnings.some(item => item.code === 'USN_MALFORMED'));
  assert.ok(result.warnings.some(item => item.code === 'USN_TRUNCATED'));
});
test('USN bounded tail reads allocated ranges only and reports omitted history', async () => {
  const first = usnRecord({ deletedAt: older }); const last = usnRecord({ deletedAt: newer });
  const journal = journalRecords([first, last], 1024 ** 3);
  const calls = [];
  const result = await readUsnDeletionTimes({ ranges: [{ offset: 1024 ** 3, length: first.length + last.length }],
    read: async (offset, length) => { calls.push([offset, length]); return journal.subarray(offset - 1024 ** 3, offset - 1024 ** 3 + length); },
    candidates: [candidate], maxBytes: last.length });
  assert.equal(result.timestamps.get(candidate.id), newer);
  assert.deepEqual(calls, [[1024 ** 3 + first.length, last.length]]);
  assert.ok(result.warnings.some(item => item.code === 'USN_RANGE_LIMIT'));
});
test('USN record bound and abort checkpoint are enforced', async () => {
  const bytes = journalRecords([usnRecord({ deletedAt: older }), usnRecord({ deletedAt: newer })]);
  const result = await scan(bytes, { maxRecords: 1 });
  assert.equal(result.timestamps.get(candidate.id), older);
  assert.ok(result.warnings.some(item => item.code === 'USN_RECORD_LIMIT'));
  const controller = new AbortController();
  await assert.rejects(scan(bytes, { signal: controller.signal, control: { checkpoint: async () => controller.abort() } }), { code: 'CANCELLED' });
});
test('USN active time bound reports partial work after a slow read', async () => {
  const bytes = usnRecord();
  const result = await scan(bytes, { maxTimeMs: 1,
    read: async (offset, length) => { await new Promise(resolve => setTimeout(resolve, 10)); return bytes.subarray(offset, offset + length); } });
  assert.equal(result.complete, false); assert.equal(result.timestamps.size, 0);
  assert.ok(result.warnings.some(item => item.code === 'USN_TIME_LIMIT'));
});
test('USN record across a read chunk boundary is parsed once', async () => {
  const prefix = Buffer.alloc(1024 * 1024 - 40); const record = usnRecord({ usn: prefix.length });
  const result = await scan(Buffer.concat([prefix, record]));
  assert.equal(result.timestamps.get(candidate.id), older); assert.equal(result.stats.recordsRead, 1);
});
test('NTFS actual reader enriches a synthetic sparse named journal and leaves source bytes unchanged', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'rc-usn-test-'));
  let engine;
  try {
    const fixture = await createUsnFixture(path.join(temporary, 'journal'));
    const before = hash(await readFile(fixture.imagePath));
    engine = await openNtfsImage(fixture.imagePath);
    const result = await engine.scanDeleted();
    const times = await engine.readDeletionTimes(result.candidates);
    assert.equal(times.complete, true, JSON.stringify(times.warnings));
    assert.deepEqual(times.timestamps, new Map([...fixture.deletionTimes].reverse()));
    assert.ok(result.candidates.every(item => item.deletedAt === null));
    assert.ok(times.stats.bytesRead < 4096, 'Sparse prefix must not be read');
    assert.equal(hash(await readFile(fixture.imagePath)), before);
    await engine.close(); engine = null;
    const resumedEngine = await openNtfsImage(fixture.imagePath); engine = resumedEngine;
    await resumedEngine.scanDeleted(); resumedEngine.journalRecords = [];
    const fallback = await resumedEngine.readDeletionTimes(result.candidates);
    assert.deepEqual(fallback.timestamps, times.timestamps, 'Bounded fallback discovery must work when the journal was before a checkpoint');
  } finally { await engine?.close(); await rm(temporary, { recursive: true, force: true }); }
});
test('USN tail resynchronization rejects a plausible embedded record with a wrong logical USN', async () => {
  const outer = usnRecord({ name: 'X'.repeat(100), reason: 0x100 });
  usnRecord({ deletedAt: newer }).copy(outer, 64);
  const real = usnRecord({ deletedAt: older, usn: outer.length });
  const bytes = Buffer.concat([outer, real]);
  const result = await scan(bytes, { ranges: [{ offset: 64, length: bytes.length - 64 }] });
  assert.equal(result.timestamps.get(candidate.id), older);
  assert.ok(result.warnings.some(item => item.code === 'USN_MALFORMED'));
});
test('USN historical correlation requires retained exact name and full parent reference', async () => {
  const identity = { ...candidate, names: [{ name: '삭제된-문서.txt', parent: { recordNumber: 5, sequence: 1 } }] };
  const wrongParent = usnRecord({ deletedAt: newer }); wrongParent.writeBigUInt64LE(5n | 2n << 48n, 16);
  const bytes = journalRecords([usnRecord({ name: 'a-different-file.txt', deletedAt: newer }), wrongParent, usnRecord({ deletedAt: older })]);
  const result = await scan(bytes, { candidates: [identity] });
  assert.equal(result.timestamps.get(candidate.id), older);
});
test('NTFS missing change journal is nonfatal and explicitly leaves deletion times unknown', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'rc-usn-test-'));
  let engine;
  try {
    const fixture = await createFixture(path.join(temporary, 'no-journal'));
    engine = await openNtfsImage(fixture.imagePath);
    const times = await engine.readDeletionTimes([candidate]);
    assert.equal(times.complete, false); assert.equal(times.timestamps.size, 0);
    assert.equal(times.warnings[0].code, 'USN_UNAVAILABLE');
  } finally { await engine?.close(); await rm(temporary, { recursive: true, force: true }); }
});
test('NTFS ambiguous freed sequence wrap is left unknown instead of matching an old generation', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'rc-usn-test-'));
  let engine;
  try {
    const fixture = await createUsnFixture(path.join(temporary, 'wrap'), {
      journalBytes: journalRecords([usnRecord({ sequence: 65535 })], 8 * 4096),
    });
    const bytes = await readFile(fixture.imagePath);
    bytes.writeUInt16LE(1, 4 * 4096 + 24 * 1024 + 16);
    await writeFile(fixture.imagePath, bytes);
    engine = await openNtfsImage(fixture.imagePath);
    const scan = await engine.scanDeleted();
    const times = await engine.readDeletionTimes(scan.candidates.filter(item => item.recordNumber === 24));
    assert.equal(times.timestamps.size, 0); assert.equal(times.complete, false);
    assert.equal(times.warnings[0].code, 'USN_IDENTITY_UNAVAILABLE');
  } finally { await engine?.close(); await rm(temporary, { recursive: true, force: true }); }
});
test('NTFS live provider rechecks candidate generation, journal fingerprint, and allocated read ranges', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'rc-usn-test-'));
  let engine;
  try {
    const fixture = await createUsnFixture(path.join(temporary, 'changing'));
    const original = await readFile(fixture.imagePath);
    for (const change of ['candidate', 'journal', 'allocation']) {
      const bytes = Buffer.from(original);
      let changed = false;
      const provider = { info: { size: bytes.length, sourceKind: 'volume' }, assertUnchanged: async () => {}, close: async () => {},
        read: async (offset, length) => {
          const result = Buffer.from(bytes.subarray(offset, offset + length));
          if (offset === 90 * 4096 && !changed) {
            changed = true;
            if (change === 'candidate') bytes.writeUInt16LE(8, 4 * 4096 + 24 * 1024 + 16);
            if (change === 'journal') bytes.writeUInt16LE(2, 4 * 4096 + 43 * 1024 + 16);
            if (change === 'allocation') {
              const base = 4 * 4096 + 6 * 1024;
              let cursor = base + bytes.readUInt16LE(base + 20);
              while (bytes.readUInt32LE(cursor) !== 0x80) cursor += bytes.readUInt32LE(cursor + 4);
              const value = cursor + bytes.readUInt16LE(cursor + 20);
              bytes[value + Math.floor(90 / 8)] &= ~(1 << 90 % 8);
            }
          }
          return result;
        } };
      engine = await openNtfsProvider(provider);
      const scan = await engine.scanDeleted();
      const times = await engine.readDeletionTimes(scan.candidates);
      assert.ok(changed);
      assert.equal(times.timestamps.has('ntfs:24:7'), false, change);
      assert.equal(times.complete, false, change);
      if (change === 'candidate') assert.equal(times.timestamps.get('ntfs:25:4'), newer);
      else { assert.equal(times.timestamps.size, 0, change); assert.equal(times.warnings[0].code, 'USN_CHANGED', change); }
      await engine.close(); engine = null;
    }
  } finally { await engine?.close(); await rm(temporary, { recursive: true, force: true }); }
});
