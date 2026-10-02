import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import fsPromises, { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { openNtfsImage } from '../engine/ntfs-image.mjs';
import { createFixture, fixtureGeometry as geometry } from './ntfs-fixtures.mjs';

const ZONE_NAME = 'Zone.Identifier';
const ZONE_LIMIT = 512;

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function align8(value) { return (value + 7) & ~7; }
function recordOffset(number) { return geometry.mftLcn * geometry.clusterSize + number * geometry.fileRecordSize; }

function decodeRecord(image, number) {
  const begin = recordOffset(number);
  const record = Buffer.from(image.subarray(begin, begin + geometry.fileRecordSize));
  const usaOffset = record.readUInt16LE(4);
  const usaCount = record.readUInt16LE(6);
  const sequence = record.readUInt16LE(usaOffset);
  for (let index = 1; index < usaCount; index += 1) {
    const tail = index * geometry.bytesPerSector - 2;
    assert.equal(record.readUInt16LE(tail), sequence);
    record.writeUInt16LE(record.readUInt16LE(usaOffset + index * 2), tail);
  }
  return { begin, record, usaOffset, usaCount, sequence };
}

function encodeRecord(image, decoded) {
  for (let index = 1; index < decoded.usaCount; index += 1) {
    const tail = index * geometry.bytesPerSector - 2;
    decoded.record.writeUInt16LE(decoded.record.readUInt16LE(tail), decoded.usaOffset + index * 2);
    decoded.record.writeUInt16LE(decoded.sequence, tail);
  }
  decoded.record.copy(image, decoded.begin);
}

function namedResidentData(name, value, id = 9, flags = 0) {
  const encodedName = Buffer.from(name, 'utf16le');
  const valueOffset = align8(24 + encodedName.length);
  const length = align8(valueOffset + value.length);
  const attribute = Buffer.alloc(length);
  attribute.writeUInt32LE(0x80, 0);
  attribute.writeUInt32LE(length, 4);
  attribute[9] = encodedName.length / 2;
  attribute.writeUInt16LE(24, 10);
  attribute.writeUInt16LE(flags, 12);
  attribute.writeUInt16LE(id, 14);
  attribute.writeUInt32LE(value.length, 16);
  attribute.writeUInt16LE(valueOffset, 20);
  encodedName.copy(attribute, 24);
  value.copy(attribute, valueOffset);
  return attribute;
}

function namedNonresidentData(name, id = 9) {
  const encodedName = Buffer.from(name, 'utf16le');
  const mappingOffset = align8(64 + encodedName.length);
  const runList = Buffer.from([0x11, 0x01, 0x3c, 0x00]);
  const length = align8(mappingOffset + runList.length);
  const attribute = Buffer.alloc(length);
  attribute.writeUInt32LE(0x80, 0);
  attribute.writeUInt32LE(length, 4);
  attribute[8] = 1;
  attribute[9] = encodedName.length / 2;
  attribute.writeUInt16LE(64, 10);
  attribute.writeUInt16LE(id, 14);
  attribute.writeBigUInt64LE(0n, 16);
  attribute.writeBigUInt64LE(0n, 24);
  attribute.writeUInt16LE(mappingOffset, 32);
  attribute.writeBigUInt64LE(BigInt(geometry.clusterSize), 40);
  attribute.writeBigUInt64LE(64n, 48);
  attribute.writeBigUInt64LE(64n, 56);
  encodedName.copy(attribute, 64);
  runList.copy(attribute, mappingOffset);
  return attribute;
}

function appendAttribute(image, number, attribute) {
  const decoded = decodeRecord(image, number);
  const record = decoded.record;
  let cursor = record.readUInt16LE(20);
  while (record.readUInt32LE(cursor) !== 0xffffffff) {
    const length = record.readUInt32LE(cursor + 4);
    assert.ok(length >= 24 && length % 8 === 0);
    cursor += length;
  }
  assert.ok(cursor + attribute.length + 4 <= record.length - 2, 'test attribute must fit the MFT record');
  attribute.copy(record, cursor);
  cursor += attribute.length;
  record.writeUInt32LE(0xffffffff, cursor);
  cursor += 4;
  record.writeUInt32LE(cursor, 24);
  encodeRecord(image, decoded);
}

async function zoneFixture(root, { recordNumber = 24, attribute } = {}) {
  const fixture = await createFixture(path.join(root, 'fixture'));
  const image = await readFile(fixture.imagePath);
  appendAttribute(image, recordNumber, attribute);
  await writeFile(fixture.imagePath, image);
  return fixture;
}

async function isolated(callback) {
  const base = path.resolve(os.tmpdir());
  const root = await mkdtemp(path.join(base, 'recoverychat-zone-'));
  try { return await callback(root); }
  finally {
    const relative = path.relative(base, root);
    assert.ok(relative.startsWith('recoverychat-zone-') && !relative.includes(path.sep) && !path.isAbsolute(relative));
    await rm(root, { recursive: true, force: true });
  }
}

test('resident Zone.Identifier remains previewable and is preserved byte-for-byte before publication',
  { skip: process.platform !== 'win32' }, async () => isolated(async root => {
    const zone = Buffer.from('[ZoneTransfer]\r\nZoneId=3\r\nReferrerUrl=https://example.test/source\r\n', 'utf8');
    const fixture = await zoneFixture(root, { attribute: namedResidentData(ZONE_NAME, zone) });
    const sourceBefore = sha256(await readFile(fixture.imagePath));
    const expected = fixture.manifest.files.find(item => item.recordNumber === 24);
    const image = await openNtfsImage(fixture.imagePath);
    try {
      const scan = await image.scanDeleted();
      const candidate = scan.candidates.find(item => item.recordNumber === 24);
      assert.equal(candidate.status, 'readable');
      assert.deepEqual(candidate.namedStreamPolicy, {
        mode: 'preserve-supported',
        supportedLayout: 'single-resident-zone-identifier-in-base-record',
        destinationRequirement: 'windows-ntfs-alternate-data-stream',
        maxBytes: ZONE_LIMIT,
        state: 'required',
        streams: [{ name: ZONE_NAME, size: zone.length, resident: true, preservation: 'required' }],
        limitations: [
          'Only one unflagged resident Zone.Identifier in the base MFT record is supported.',
          'Recovery requires a Windows NTFS destination that can create and verify the exact alternate data stream.',
          'Unknown, duplicate, nonresident, oversized, malformed, or ATTRIBUTE_LIST named streams are unsupported.',
        ],
      });
      const preview = await image.readCandidateBytes(24, { maxBytes: 8192 });
      assert.equal(sha256(preview), expected.sha256, 'preview remains the unnamed main stream');
      const result = await image.recover(24, path.join(root, 'output'));
      assert.equal(result.sha256, expected.sha256, 'the main-stream recovery hash is unchanged');
      assert.equal(sha256(await readFile(result.path)), expected.sha256);
      assert.deepEqual(result.supplementalStreams,
        [{ name: ZONE_NAME, size: zone.length, preservation: 'preserved' }]);
      assert.deepEqual(await readFile(`${result.path}:${ZONE_NAME}`), zone);
      assert.equal(sha256(await readFile(fixture.imagePath)), sourceBefore, 'scan, preview, ADS preservation and recovery are read-only');
    } finally { await image.close(); }
  }));

test('Zone.Identifier support does not weaken allocation conflicts or record fingerprint checks', async () => isolated(async root => {
  const zone = Buffer.from('[ZoneTransfer]\r\nZoneId=3\r\n', 'utf8');
  const fixture = await zoneFixture(root, { recordNumber: 34, attribute: namedResidentData(ZONE_NAME, zone) });
  const fixtureBytes = await readFile(fixture.imagePath);
  appendAttribute(fixtureBytes, 24, namedResidentData(ZONE_NAME, zone));
  await writeFile(fixture.imagePath, fixtureBytes);
  const image = await openNtfsImage(fixture.imagePath);
  try {
    const scan = await image.scanDeleted();
    const conflict = scan.candidates.find(item => item.recordNumber === 34);
    assert.equal(conflict.namedStreamPolicy.state, 'required');
    assert.equal(conflict.status, 'conflict');
    await assert.rejects(image.recover(34, path.join(root, 'conflict-output')), { code: 'NOT_RECOVERABLE' });

    const selected = scan.candidates.find(item => item.recordNumber === 24);
    assert.equal(selected.status, 'readable');
    assert.equal(selected.namedStreamPolicy.state, 'required');
    const originalRecord = image.record.bind(image);
    let selectedReads = 0;
    image.record = async (number, signal) => {
      const record = await originalRecord(number, signal);
      if (number !== 24 || !record || ++selectedReads === 1) return record;
      const attributes = record.attributes.map(attribute => attribute.type === 0x80 && attribute.name === ZONE_NAME
        ? { ...attribute, value: Buffer.from(attribute.value).fill(0x58) } : attribute);
      return { ...record, attributes, fingerprint: '0'.repeat(64) };
    };
    await assert.rejects(image.recover(24, path.join(root, 'mutated-output')), { code: 'SOURCE_CHANGED' });
    assert.ok(selectedReads >= 2, 'the Zone-bearing record changes only after its main stream was copied');
    assert.equal((await readdir(path.join(root, 'mutated-output'))).some(name => name.startsWith('recovered-')), false);
  } finally { await image.close(); }
}));

test('ADS creation or readback failure leaves only private staging and publishes no completed recovery',
  { skip: process.platform !== 'win32' }, async () => {
    for (const failure of ['create', 'readback']) {
      await isolated(async root => {
        const zone = Buffer.from('[ZoneTransfer]\r\nZoneId=3\r\n', 'utf8');
        const fixture = await zoneFixture(root, { attribute: namedResidentData(ZONE_NAME, zone) });
        const image = await openNtfsImage(fixture.imagePath);
        const output = path.join(root, 'output');
        const originalOpen = fsPromises.open;
        try {
          await image.scanDeleted();
          fsPromises.open = async (target, flags, ...args) => {
            const ads = String(target).endsWith(`:${ZONE_NAME}`);
            if (ads && ((failure === 'create' && flags === 'wx') || (failure === 'readback' && flags === 'r'))) {
              const error = new Error(`injected ADS ${failure} failure`);
              error.code = failure === 'create' ? 'EACCES' : 'EIO';
              throw error;
            }
            return originalOpen.call(fsPromises, target, flags, ...args);
          };
          syncBuiltinESMExports();
          await assert.rejects(image.recover(24, output), error => {
            assert.equal(error.code, 'STREAM_PRESERVATION_FAILED');
            assert.equal(error.details.savedPath, null);
            return true;
          });
          const entries = await readdir(output, { withFileTypes: true });
          assert.equal(entries.some(entry => entry.name.startsWith('recovered-')), false,
            `${failure} failure must not publish a recovered directory`);
          assert.ok(entries.every(entry => entry.name.startsWith('.recovery-working-')),
            `${failure} failure may retain only private recovery staging`);
        } finally {
          fsPromises.open = originalOpen;
          syncBuiltinESMExports();
          await image.close();
        }
      });
    }
  });

test('unknown, nonresident, malformed, oversized, and ATTRIBUTE_LIST named streams remain unsupported', async () => {
  const cases = [
    ['unknown', 24, namedResidentData('Other.Stream', Buffer.from('do not drop'))],
    ['nonresident-zone', 24, namedNonresidentData(ZONE_NAME)],
    ['flagged-zone', 24, namedResidentData(ZONE_NAME, Buffer.from('[ZoneTransfer]\r\nZoneId=3\r\n'), 9, 0x4000)],
    ['oversized-zone', 24, namedResidentData(ZONE_NAME, Buffer.alloc(ZONE_LIMIT + 1, 0x5a))],
    ['attribute-list-zone', 36, namedResidentData(ZONE_NAME, Buffer.from('[ZoneTransfer]\r\nZoneId=3\r\n'))],
  ];
  for (const [label, recordNumber, attribute] of cases) {
    await isolated(async root => {
      const fixture = await zoneFixture(root, { recordNumber, attribute });
      const image = await openNtfsImage(fixture.imagePath);
      try {
        const scan = await image.scanDeleted();
        const candidate = scan.candidates.find(item => item.recordNumber === recordNumber);
        assert.ok(candidate, `${label} should remain visible as an explicit candidate`);
        assert.equal(candidate.status, 'unsupported', `${label} must not become recoverable`);
        assert.equal(candidate.namedStreamPolicy.state, 'unsupported');
        assert.ok(candidate.namedStreamPolicy.streams.every(item => item.preservation === 'unsupported'));
        await assert.rejects(image.readCandidateBytes(recordNumber, { maxBytes: 8192 }), { code: 'NOT_RECOVERABLE' });
        await assert.rejects(image.recover(recordNumber, path.join(root, 'output')), { code: 'NOT_RECOVERABLE' });
      } finally { await image.close(); }
    });
  }
});
