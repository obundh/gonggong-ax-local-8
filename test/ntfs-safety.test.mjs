import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { createFixture, fixtureGeometry as geometry } from './ntfs-fixtures.mjs';
import { openNtfsImage } from '../engine/ntfs-image.mjs';

async function isolated(callback) {
  const temporaryRoot = path.resolve(os.tmpdir());
  const root = await mkdtemp(path.join(temporaryRoot, 'recoverychat-safety-'));
  try { await callback(root); }
  finally {
    const relative = path.relative(temporaryRoot, path.resolve(root));
    assert.ok(relative.startsWith('recoverychat-safety-') && !relative.includes(path.sep) && !path.isAbsolute(relative));
    await rm(root, { recursive: true, force: true });
  }
}

function recordOffset(number) { return geometry.mftLcn * geometry.clusterSize + number * geometry.fileRecordSize; }
function attributeOffset(bytes, number, type) {
  const begin = recordOffset(number);
  let offset = begin + bytes.readUInt16LE(begin + 20);
  while (offset < begin + geometry.fileRecordSize) {
    const found = bytes.readUInt32LE(offset);
    assert.notEqual(found, 0xffffffff, 'fixture must include the attribute');
    if (found === type) return offset;
    const length = bytes.readUInt32LE(offset + 4);
    assert.ok(length >= 24);
    offset += length;
  }
  assert.fail('attribute not found');
}

test('a deleted FILE record still allocated in the MFT bitmap is refused', async () => isolated(async root => {
  const fixture = await createFixture(path.join(root, 'fixture'));
  const bytes = await readFile(fixture.imagePath);
  const attr = attributeOffset(bytes, 0, 0xb0);
  const value = attr + bytes.readUInt16LE(attr + 20);
  bytes[value + 3] |= 1; // record 24 remains allocated while its FILE header says deleted.
  await writeFile(fixture.imagePath, bytes);
  const image = await openNtfsImage(fixture.imagePath);
  try {
    const scan = await image.scanDeleted();
    assert.equal(scan.candidates.find(file => file.recordNumber === 24).status, 'conflict');
    assert.equal(scan.complete, false);
    assert.ok(scan.warnings.some(warning => warning.recordNumber === 24 && warning.code === 'MFT_BITMAP_MISMATCH'));
    await assert.rejects(image.recover(24, path.join(root, 'output')), { code: 'NOT_RECOVERABLE' });
  } finally { await image.close(); }
}));

test('allocated empty slots and active records marked free prevent a complete-scan claim', async () => isolated(async root => {
  const fixture = await createFixture(path.join(root, 'fixture'));
  const bytes = await readFile(fixture.imagePath);
  // Remove the fixture's intentional malformed controls so only allocation inconsistencies remain.
  bytes.fill(0, recordOffset(39), recordOffset(41));
  const attr = attributeOffset(bytes, 0, 0xb0);
  const value = attr + bytes.readUInt16LE(attr + 20);
  bytes[value + 5] |= 1 << 3; // 43: allocated but all-zero record.
  bytes[value + 5] &= ~(1 << 2); // 42: active FILE record marked free in bitmap.
  await writeFile(fixture.imagePath, bytes);
  const image = await openNtfsImage(fixture.imagePath);
  try {
    const scan = await image.scanDeleted();
    assert.equal(scan.stats.recordsRead, scan.stats.recordsTotal);
    assert.equal(scan.complete, false);
    assert.equal(scan.stats.malformedRecords, 2);
    assert.deepEqual(scan.warnings.map(warning => [warning.recordNumber, warning.code]), [[42, 'MFT_BITMAP_MISMATCH'], [43, 'MFT_BITMAP_MISMATCH']]);
    assert.ok(!scan.candidates.some(file => [42, 43].includes(file.recordNumber)));
  } finally { await image.close(); }
}));

test('recovery cancellation retains a named partial file and publishes no completed file', async () => isolated(async root => {
  const fixture = await createFixture(path.join(root, 'fixture'));
  const image = await openNtfsImage(fixture.imagePath);
  const signal = new AbortController();
  try {
    await image.scanDeleted();
    let caught;
    try {
      await image.recover(25, path.join(root, 'output'), { signal: signal.signal, onProgress: () => signal.abort() });
    } catch (error) { caught = error; }
    assert.equal(caught?.code, 'CANCELLED');
    assert.equal(caught.details.savedPath, null);
    assert.ok(caught.details.partialPath.endsWith('.partial'));
    assert.deepEqual(await readdir(path.dirname(caught.details.partialPath)), ['.recovery-writing.partial']);
    assert.ok((await readFile(caught.details.partialPath)).length > 0);
    // A cancelled job must release the image for another deliberate operation.
    assert.equal((await image.recover(24, path.join(root, 'retry'))).status, 'saved');
  } finally { await image.close(); }
}));

test('an invalid record sequence or a fixup array outside the first sector is not accepted', async () => isolated(async root => {
  const fixture = await createFixture(path.join(root, 'fixture'));
  const bytes = await readFile(fixture.imagePath);
  bytes.writeUInt16LE(0, recordOffset(24) + 16);
  bytes.writeUInt16LE(512, recordOffset(25) + 4);
  await writeFile(fixture.imagePath, bytes);
  const image = await openNtfsImage(fixture.imagePath);
  try {
    const scan = await image.scanDeleted();
    assert.ok(!scan.candidates.some(file => [24, 25].includes(file.recordNumber)));
    assert.ok(scan.warnings.some(warning => warning.recordNumber === 24));
    assert.ok(scan.warnings.some(warning => warning.recordNumber === 25));
    assert.equal(scan.complete, false);
  } finally { await image.close(); }
}));

test('reparse-point attributes and special file flags are refused instead of published as regular data', async () => isolated(async root => {
  const fixture = await createFixture(path.join(root, 'fixture'));
  const bytes = await readFile(fixture.imagePath);
  const begin = recordOffset(24);
  const oldUsed = bytes.readUInt32LE(begin + 24);
  const next = begin + oldUsed - 4;
  const reparse = Buffer.alloc(32);
  reparse.writeUInt32LE(0xc0, 0);
  reparse.writeUInt32LE(32, 4);
  reparse.writeUInt32LE(8, 16);
  reparse.writeUInt16LE(24, 20);
  reparse.writeUInt32LE(0xa000000c, 24);
  reparse.copy(bytes, next);
  bytes.writeUInt32LE(0xffffffff, next + 32);
  bytes.writeUInt32LE(oldUsed + 32, begin + 24);
  const si = attributeOffset(bytes, 25, 0x10);
  bytes.writeUInt32LE(0x400, si + bytes.readUInt16LE(si + 20) + 32);
  await writeFile(fixture.imagePath, bytes);
  const image = await openNtfsImage(fixture.imagePath);
  try {
    const scan = await image.scanDeleted();
    for (const number of [24, 25]) {
      assert.equal(scan.candidates.find(file => file.recordNumber === number).status, 'unsupported');
      await assert.rejects(image.recover(number, path.join(root, 'output')), { code: 'NOT_RECOVERABLE' });
    }
  } finally { await image.close(); }
}));

test('cancellation between 1MiB chunks stops before reading and writing the whole 2MiB file', async () => isolated(async root => {
  const fixture = await createFixture(path.join(root, 'fixture'));
  const bytes = await readFile(fixture.imagePath);
  const data = attributeOffset(bytes, 25, 0x80);
  const size = 2 * 1024 * 1024;
  bytes.writeBigUInt64LE(511n, data + 24);
  bytes.writeBigUInt64LE(BigInt(size), data + 40);
  bytes.writeBigUInt64LE(BigInt(size), data + 48);
  bytes.writeBigUInt64LE(BigInt(size), data + 56);
  const runs = data + bytes.readUInt16LE(data + 32);
  Buffer.from([0x12, 0x00, 0x02, 0x40, 0x00]).copy(bytes, runs); // 512 clusters at LCN64.
  bytes.fill(0x5a, 64 * geometry.clusterSize, 64 * geometry.clusterSize + size);
  await writeFile(fixture.imagePath, bytes);
  const image = await openNtfsImage(fixture.imagePath);
  const controller = new AbortController();
  try {
    await image.scanDeleted();
    let caught;
    let lastProgress;
    try {
      await image.recover(25, path.join(root, 'output'), {
        signal: controller.signal,
        onProgress: progress => { lastProgress = progress; controller.abort(); }
      });
    } catch (error) { caught = error; }
    assert.equal(caught?.code, 'CANCELLED');
    assert.equal(lastProgress.bytesWritten, 1024 * 1024);
    assert.equal(lastProgress.bytesTotal, size);
    assert.equal((await readFile(caught.details.partialPath)).length, 1024 * 1024);
    assert.deepEqual(await readdir(path.dirname(caught.details.partialPath)), ['.recovery-writing.partial']);
  } finally { await image.close(); }
}));
