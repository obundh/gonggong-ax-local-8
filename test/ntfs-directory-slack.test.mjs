import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { parseDirectorySlack } from '../engine/ntfs-directory-slack.mjs';

const DIRECTORY = { recordNumber: 42, sequence: 7, fingerprint: 'caller-metadata', name: '자료' };
const INFO = { clusterSize: 4096, sectorSize: 512 };
const FILETIME_EPOCH_MILLISECONDS = 11644473600000n;

function align8(value) { return (value + 7) & ~7; }
function ref(recordNumber, sequence) { return BigInt(recordNumber) | BigInt(sequence) << 48n; }
function ticks(value) { return (BigInt(Date.parse(value)) + FILETIME_EPOCH_MILLISECONDS) * 10000n; }
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function fileNameKey({ name, parent = DIRECTORY, namespace = 1, size = 1234,
  modifiedAt = '2026-09-25T04:05:06.789Z' } = {}) {
  const encoded = Buffer.from(name, 'utf16le');
  const key = Buffer.alloc(66 + encoded.length);
  key.writeBigUInt64LE(ref(parent.recordNumber, parent.sequence), 0);
  key.writeBigUInt64LE(ticks('2026-09-24T01:02:03.000Z'), 8);
  key.writeBigUInt64LE(modifiedAt === null ? 0n : ticks(modifiedAt), 16);
  key.writeBigUInt64LE(ticks('2026-09-25T04:05:06.000Z'), 24);
  key.writeBigUInt64LE(ticks('2026-09-25T04:05:07.000Z'), 32);
  key.writeBigUInt64LE(BigInt(size), 40);
  key.writeBigUInt64LE(BigInt(size), 48);
  key.writeUInt32LE(0x20, 56);
  key[64] = encoded.length / 2;
  key[65] = namespace;
  encoded.copy(key, 66);
  return key;
}

function indexEntry({ name = '삭제된 문서.txt', recordNumber = 100, sequence = 9, flags = 0, ...keyOptions } = {}) {
  const key = fileNameKey({ name, ...keyOptions });
  const childBytes = flags & 1 ? 8 : 0;
  const bytes = Buffer.alloc(align8(16 + key.length + childBytes));
  bytes.writeBigUInt64LE(ref(recordNumber, sequence), 0);
  bytes.writeUInt16LE(bytes.length, 8);
  bytes.writeUInt16LE(key.length, 10);
  bytes.writeUInt16LE(flags, 12);
  key.copy(bytes, 16);
  if (childBytes) bytes.writeBigUInt64LE(3n, bytes.length - 8);
  return bytes;
}

function lastEntry({ child = false } = {}) {
  const bytes = Buffer.alloc(child ? 24 : 16);
  bytes.writeUInt16LE(bytes.length, 8);
  bytes.writeUInt16LE(child ? 3 : 2, 12);
  if (child) bytes.writeBigUInt64LE(4n, 16);
  return bytes;
}

function rootValue({ active = [indexEntry({ name: '현재 문서.txt', recordNumber: 80 })], slack = Buffer.alloc(0),
  allocatedPadding = 0, trailing = Buffer.alloc(0), nodeFlags = 0 } = {}) {
  const activeBytes = Buffer.concat([...active, lastEntry({ child: Boolean(nodeFlags & 1) })]);
  const allocatedSize = 16 + activeBytes.length + slack.length + allocatedPadding;
  const bytes = Buffer.alloc(16 + allocatedSize + trailing.length);
  bytes.writeUInt32LE(0x30, 0);
  bytes.writeUInt32LE(1, 4);
  bytes.writeUInt32LE(4096, 8);
  bytes[12] = 1;
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt32LE(16 + activeBytes.length, 20);
  bytes.writeUInt32LE(allocatedSize, 24);
  bytes.writeUInt32LE(nodeFlags, 28);
  activeBytes.copy(bytes, 32);
  slack.copy(bytes, 32 + activeBytes.length);
  trailing.copy(bytes, 16 + allocatedSize);
  return bytes;
}

function protectUsa(corrected) {
  const raw = Buffer.from(corrected);
  const usaOffset = 40;
  const usaCount = raw.length / INFO.sectorSize + 1;
  const sequence = 0xa71b;
  raw.writeUInt16LE(usaOffset, 4);
  raw.writeUInt16LE(usaCount, 6);
  raw.writeUInt16LE(sequence, usaOffset);
  for (let index = 1; index < usaCount; index++) {
    const tail = index * INFO.sectorSize - 2;
    raw.writeUInt16LE(corrected.readUInt16LE(tail), usaOffset + index * 2);
    raw.writeUInt16LE(sequence, tail);
  }
  return raw;
}

function indexBlock({ active = [indexEntry({ name: 'A'.repeat(180), recordNumber: 81 })],
  slack = Buffer.alloc(0), vcn = 0, nodeFlags = 0, blockSize = 4096 } = {}) {
  const activeBytes = Buffer.concat([...active, lastEntry({ child: Boolean(nodeFlags & 1) })]);
  const corrected = Buffer.alloc(blockSize);
  const entriesStart = align8(Math.max(64, 40 + (blockSize / INFO.sectorSize + 1) * 2));
  corrected.write('INDX', 0);
  corrected.writeBigUInt64LE(BigInt(vcn), 16);
  corrected.writeUInt32LE(entriesStart - 24, 24);
  corrected.writeUInt32LE(entriesStart - 24 + activeBytes.length, 28);
  corrected.writeUInt32LE(corrected.length - 24, 32);
  corrected.writeUInt32LE(nodeFlags, 36);
  activeBytes.copy(corrected, entriesStart);
  const slackStart = entriesStart + activeBytes.length;
  slack.copy(corrected, slackStart);
  return { raw: protectUsa(corrected), corrected, slackStart };
}

function parseRoot(bytes, options = {}) {
  return parseDirectorySlack({ bytes, kind: 'root', directoryReference: DIRECTORY, info: INFO, ...options });
}

function parseAllocation(bytes, options = {}) {
  return parseDirectorySlack({ bytes, kind: 'allocation', directoryReference: DIRECTORY, info: INFO, ...options });
}

function parseFreedAllocation(bytes, options = {}) {
  return parseDirectorySlack({ bytes, kind: 'freed-allocation', directoryReference: DIRECTORY, info: INFO, ...options });
}

test('parses only the resident $I30 unused tail and reports active entries separately', () => {
  const remnant = indexEntry({ name: '삭제된 회의록.docx', recordNumber: 123, sequence: 11, size: 987654,
    modifiedAt: '2026-09-25T04:05:06.789Z' });
  const bytes = rootValue({ slack: Buffer.concat([Buffer.alloc(8, 0xcc), remnant]), allocatedPadding: 8 });
  const result = parseRoot(bytes);
  assert.equal(result.blockSize, 4096);
  assert.equal(result.activeEntries.length, 1);
  assert.deepEqual(result.activeEntries[0], {
    reference: { recordNumber: 80, sequence: 9 },
    name: '현재 문서.txt', namespace: 1,
    parent: { recordNumber: 42, sequence: 7 },
  });
  assert.equal(result.entries.length, 1);
  assert.deepEqual(result.entries[0], {
    offset: result.slackStart + 8,
    length: remnant.length,
    reference: { recordNumber: 123, sequence: 11 },
    parent: { recordNumber: 42, sequence: 7 },
    name: '삭제된 회의록.docx',
    namespace: 1,
    recordedSize: 987654,
    modifiedAt: '2026-09-25T04:05:06.789Z',
    entrySha256: hash(remnant),
  });
  assert.equal(result.slackEnd, bytes.length);
  assert.equal(result.truncated, false);
});

test('applies and validates INDX USA fixups, exact VCN, and hashes corrected entry bytes', () => {
  const remnant = indexEntry({ name: `${'복구'.repeat(110)}.txt`, recordNumber: 130, sequence: 12, flags: 1,
    namespace: 3, size: 55, modifiedAt: null });
  const fixture = indexBlock({ slack: remnant, vcn: 6 });
  assert.ok(fixture.slackStart < 1022 && fixture.slackStart + remnant.length > 1022,
    'fixture must exercise a sector-tail fixup inside the remnant');
  const result = parseAllocation(fixture.raw, { expectedVcn: 6 });
  assert.equal(result.vcn, 6);
  assert.equal(result.blockSize, 4096);
  assert.equal(result.slackStart, fixture.slackStart);
  assert.equal(result.slackEnd, 4096);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].entrySha256,
    hash(fixture.corrected.subarray(fixture.slackStart, fixture.slackStart + remnant.length)));
  assert.equal(result.entries[0].modifiedAt, null);
  assert.equal(result.entries[0].namespace, 3);
});

test('filters a same-reference same-name active entry but retains a different remnant', () => {
  const active = indexEntry({ name: '동일.txt', recordNumber: 90, sequence: 2 });
  const duplicate = indexEntry({ name: '동일.txt', recordNumber: 90, sequence: 2 });
  const other = indexEntry({ name: '다른.txt', recordNumber: 91, sequence: 2 });
  const result = parseRoot(rootValue({ active: [active], slack: Buffer.concat([duplicate, other]) }));
  assert.deepEqual(result.entries.map(entry => entry.name), ['다른.txt']);
  assert.equal(result.stats.filteredActive, 1);
});

test('never scans active entries or bytes beyond the node allocated bound', () => {
  const outside = indexEntry({ name: '범위밖.txt', recordNumber: 140 });
  const bytes = rootValue({ trailing: outside });
  const result = parseRoot(bytes);
  assert.deepEqual(result.entries, []);
  assert.equal(result.activeEntries[0].name, '현재 문서.txt');
  assert.ok(result.slackEnd < bytes.length);
});

test('skips malformed, unsafe, wrong-parent, bad-UTF16, and boundary fragments without fabricating entries', () => {
  const wrongParent = indexEntry({ name: 'wrong.txt', recordNumber: 150,
    parent: { recordNumber: 41, sequence: 7 } });
  const reservedName = indexEntry({ name: 'CON.txt', recordNumber: 151 });
  const badUtf16 = indexEntry({ name: 'ok.txt', recordNumber: 152 });
  const badNameStart = 16 + 66;
  badUtf16.writeUInt16LE(0xd800, badNameStart);
  const badReserved = indexEntry({ name: 'reserved.txt', recordNumber: 153 });
  badReserved.writeUInt16LE(1, 14);
  const badTime = indexEntry({ name: 'time.txt', recordNumber: 155 });
  badTime.writeBigUInt64LE(0xffffffffffffffffn, 16 + 16);
  const badSize = indexEntry({ name: 'size.txt', recordNumber: 156 });
  badSize.writeBigUInt64LE(0xffffffffffffffffn, 16 + 48);
  const oversized = indexEntry({ name: 'cutoff.txt', recordNumber: 154 });
  const truncated = oversized.subarray(0, oversized.length - 8);
  const slack = Buffer.concat([wrongParent, reservedName, badUtf16, badReserved, badTime, badSize, truncated]);
  const result = parseRoot(rootValue({ slack }));
  assert.deepEqual(result.entries, []);
  assert.ok(result.stats.rejectedSlots > 0);
});

test('rejects malformed active layouts, root geometry, USA tails, and VCN mismatches', () => {
  const active = indexEntry({ name: '현재 문서.txt', recordNumber: 80 });
  const malformedActive = rootValue({ active: [active] });
  malformedActive.writeUInt16LE(0, 32 + active.length + 12);
  assert.throws(() => parseRoot(malformedActive), { code: 'DIR_SLACK_INVALID' });

  const wrongActiveParent = rootValue({ active: [indexEntry({ name: 'active.txt', recordNumber: 82,
    parent: { recordNumber: 41, sequence: 7 } })] });
  assert.throws(() => parseRoot(wrongActiveParent), { code: 'DIR_SLACK_INVALID' });

  const malformedActiveName = indexEntry({ name: 'active.txt', recordNumber: 83 });
  malformedActiveName.writeUInt16LE(0xd800, 16 + 66);
  assert.throws(() => parseRoot(rootValue({ active: [malformedActiveName] })), { code: 'DIR_SLACK_INVALID' });

  const badGeometry = rootValue();
  badGeometry.writeUInt32LE(8192, 8);
  assert.throws(() => parseRoot(badGeometry), { code: 'DIR_SLACK_INVALID' });

  const fixture = indexBlock({ vcn: 2 });
  const badUsa = Buffer.from(fixture.raw);
  badUsa.writeUInt16LE(0, 510);
  assert.throws(() => parseAllocation(badUsa, { expectedVcn: 2 }), { code: 'DIR_SLACK_INVALID' });
  assert.throws(() => parseAllocation(fixture.raw, { expectedVcn: 3 }), { code: 'DIR_SLACK_INVALID' });
  assert.throws(() => parseAllocation(fixture.raw.subarray(0, 4088), { expectedVcn: 2 }),
    { code: 'DIR_SLACK_INVALID' });
});

test('uses an exact bounded result cap and reports only a real sixty-fifth eligible entry as truncation', () => {
  const remnants = Array.from({ length: 65 }, (_, index) =>
    indexEntry({ name: `삭제-${String(index).padStart(2, '0')}.txt`, recordNumber: 200 + index, sequence: 3 }));
  const sixtyFour = parseRoot(rootValue({ slack: Buffer.concat(remnants.slice(0, 64)) }));
  assert.equal(sixtyFour.entries.length, 64);
  assert.equal(sixtyFour.truncated, false);

  const sixtyFive = parseRoot(rootValue({ slack: Buffer.concat(remnants) }));
  assert.equal(sixtyFive.entries.length, 64);
  assert.equal(sixtyFive.truncated, true);
  assert.equal(sixtyFive.stats.truncated, true);

  const limited = parseRoot(rootValue({ slack: Buffer.concat(remnants.slice(0, 3)) }), { maxEntries: 2 });
  assert.equal(limited.entries.length, 2);
  assert.equal(limited.truncated, true);
  assert.throws(() => parseRoot(rootValue(), { maxEntries: 65 }), { code: 'DIR_SLACK_UNSUPPORTED' });
});

test('freed allocation scans former used entries and the unused tail without reporting active entries', () => {
  const formerlyUsed = indexEntry({ name: '예전 사용 항목.txt', recordNumber: 310, sequence: 4 });
  const tail = indexEntry({ name: '남은 꼬리 항목.txt', recordNumber: 311, sequence: 5 });
  const fixture = indexBlock({ active: [formerlyUsed], slack: tail, vcn: 9 });

  const ordinary = parseAllocation(fixture.raw, { expectedVcn: 9 });
  assert.deepEqual(ordinary.entries.map(entry => entry.name), ['남은 꼬리 항목.txt']);
  assert.deepEqual(ordinary.activeEntries.map(entry => entry.name), ['예전 사용 항목.txt']);

  const freed = parseFreedAllocation(fixture.raw, { expectedVcn: 9 });
  assert.deepEqual(freed.entries.map(entry => entry.name), ['예전 사용 항목.txt', '남은 꼬리 항목.txt']);
  assert.deepEqual(freed.activeEntries, []);
  assert.equal(freed.slackStart, fixture.slackStart);
  assert.equal(freed.slackEnd, fixture.corrected.length);
  assert.equal(freed.blockSize, fixture.corrected.length);
  assert.equal(freed.vcn, 9);
  assert.equal(freed.stats.filteredActive, 0);
});

test('freed allocation keeps duplicate remnants because former entries are not active exclusions', () => {
  const former = indexEntry({ name: '중복.txt', recordNumber: 320, sequence: 6 });
  const duplicate = Buffer.from(former);
  const fixture = indexBlock({ active: [former], slack: duplicate, vcn: 10 });
  const result = parseFreedAllocation(fixture.raw, { expectedVcn: 10 });

  assert.deepEqual(result.entries.map(entry => entry.name), ['중복.txt', '중복.txt']);
  assert.equal(result.stats.filteredActive, 0);
  assert.equal(result.truncated, false);
});

test('freed allocation rejects damaged USA, wrong VCN, and malformed active header bounds', () => {
  const fixture = indexBlock({ vcn: 11 });
  const badUsa = Buffer.from(fixture.raw);
  badUsa.writeUInt16LE(0, 510);
  assert.throws(() => parseFreedAllocation(badUsa, { expectedVcn: 11 }), { code: 'DIR_SLACK_INVALID' });
  assert.throws(() => parseFreedAllocation(fixture.raw, { expectedVcn: 12 }), { code: 'DIR_SLACK_INVALID' });

  const malformedBounds = Buffer.from(fixture.corrected);
  malformedBounds.writeUInt32LE(malformedBounds.length, 28);
  assert.throws(() => parseFreedAllocation(protectUsa(malformedBounds), { expectedVcn: 11 }),
    { code: 'DIR_SLACK_INVALID' });
});

test('freed allocation preserves the exact cap and truncates only for a real eligible result', () => {
  const formerEntries = Array.from({ length: 65 }, (_, index) =>
    indexEntry({ name: `F${String(index).padStart(2, '0')}`, recordNumber: 400 + index, sequence: 7 }));

  const sixtyFour = indexBlock({ active: formerEntries.slice(0, 64), vcn: 13, blockSize: 8192 });
  const exact = parseFreedAllocation(sixtyFour.raw, { expectedVcn: 13 });
  assert.equal(exact.entries.length, 64);
  assert.equal(exact.truncated, false);

  const sixtyFive = indexBlock({ active: formerEntries, vcn: 14, blockSize: 8192 });
  const capped = parseFreedAllocation(sixtyFive.raw, { expectedVcn: 14 });
  assert.equal(capped.entries.length, 64);
  assert.equal(capped.truncated, true);
  assert.equal(capped.stats.truncated, true);

  const limited = parseFreedAllocation(sixtyFive.raw, { expectedVcn: 14, maxEntries: 2 });
  assert.equal(limited.entries.length, 2);
  assert.equal(limited.truncated, true);
});
