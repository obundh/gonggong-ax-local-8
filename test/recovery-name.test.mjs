import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chooseRecoveryName } from '../engine/recovery-name.mjs';
import { prepareCombinedCandidate, scanCombined } from '../engine/combined-recovery.mjs';
import { decorateNativeCandidate, mergePreparedCandidate, prepareNativeCandidate } from '../engine/native-recovery-adapter.mjs';
import { openNtfsImage } from '../engine/ntfs-image.mjs';
import { fixtureGeometry } from './ntfs-fixtures.mjs';
import { createUsnFixture, usnRecord } from './usn-fixture.mjs';

const parent = { recordNumber: 500, sequence: 2 };
const originalParent = { recordNumber: 90, sequence: 4 };
function event(usn, reason, name, eventParent = parent, sequence = 12) {
  return { recordNumber: 42, sequence, name, parent: eventParent, reason, usn: String(usn) };
}
function candidate(overrides = {}) {
  const oldName = event(100, 0x1000, '회의 자료.docx', originalParent);
  const newName = event(101, 0x2000, '$RABC123.docx');
  const deletion = event(110, 0x200, '$RABC123.docx');
  return { recordNumber: 42, sequence: 13, name: '$RABC123.docx',
    nameReferences: [{ name: '$RABC123.docx', parent }], generationEvents: [oldName, newName, deletion],
    matchedDeletes: [deletion], ...overrides };
}

test('a single adjacent OLD/NEW pair to the deleted recycle alias restores the original basename', () => {
  assert.deepEqual(chooseRecoveryName(candidate()), {
    name: '회의 자료.docx', originalNameStatus: 'restored-from-history', source: 'windows-usn-rename-pair',
    discoveredName: '$RABC123.docx', evidence: {
      fileReference: ((12n << 48n) | 42n).toString(), oldNameUsn: '100', newNameUsn: '101', deleteUsn: '110',
      oldParentFileReference: ((4n << 48n) | 90n).toString(),
      recycleParentFileReference: ((2n << 48n) | 500n).toString(),
    }
  });
});

test('the observed accumulated CLOSE transcript still restores only its exact recycle rename', () => {
  const recycleParent = { recordNumber: 112737, sequence: 2 };
  const sourceParent = { recordNumber: 9131, sequence: 35 };
  const transcript = [
    { recordNumber: 71929, sequence: 54, name: '기술동향2026.hwp', parent: sourceParent, reason: 0x1000, usn: '61196285424' },
    { recordNumber: 71929, sequence: 54, name: '$R4DV0VA.hwp', parent: recycleParent, reason: 0x2000, usn: '61196285512' },
    { recordNumber: 71929, sequence: 54, name: '$R4DV0VA.hwp', parent: recycleParent, reason: 0x80002000, usn: '61196285600' },
    { recordNumber: 71929, sequence: 54, name: '$R4DV0VA.hwp', parent: recycleParent, reason: 0x80000200, usn: '61196315768' },
  ];
  const recovered = chooseRecoveryName({
    recordNumber: 71929, sequence: 55, name: '$R4DV0VA.hwp',
    nameReferences: [{ name: '$R4DV0VA.hwp', parent: recycleParent }],
    generationEvents: transcript, matchedDeletes: [transcript[3]],
  });
  assert.equal(recovered.name, '기술동향2026.hwp');
  assert.equal(recovered.originalNameStatus, 'restored-from-history');
  assert.equal(recovered.evidence.newNameUsn, '61196285512');
});

test('CLOSE normalization rejects a distinct, interrupted, reused, or parentless rename event', () => {
  const item = candidate();
  const [oldName, newName, deletion] = item.generationEvents;
  const close = { ...newName, reason: 0x80002000, usn: '102' };
  const invalidTranscripts = [
    [oldName, newName, { ...close, name: '$RZZZ999.docx' }, deletion],
    [oldName, newName, { ...close, parent: originalParent }, deletion],
    [oldName, newName, event(102, 0x1, '$RABC123.docx'), { ...close, usn: '103' }, deletion],
    [oldName, newName, { ...close, sequence: 11 }, deletion],
    [oldName, newName, close, { ...close, usn: '103' }, deletion],
    [{ ...oldName, parent: { recordNumber: 90 } }, newName, close, deletion],
  ];
  for (const generationEvents of invalidTranscripts) {
    assert.equal(chooseRecoveryName({ ...item, generationEvents }).originalNameStatus, 'unknown');
  }
});

test('an orphan OLD event remains unknown and a normal MFT name remains the record name', () => {
  const item = candidate();
  assert.deepEqual(chooseRecoveryName({ ...item, generationEvents: [item.generationEvents[0], item.generationEvents[2]] }), {
    name: '$RABC123.docx', originalNameStatus: 'unknown', source: null, discoveredName: '$RABC123.docx'
  });
  assert.deepEqual(chooseRecoveryName({ name: '현재 문서.hwp' }), {
    name: '현재 문서.hwp', originalNameStatus: 'record-name', source: 'file-record', discoveredName: '현재 문서.hwp'
  });
  assert.equal(chooseRecoveryName({ name: 'record-42', nameIsGenerated: true }).originalNameStatus, 'unknown');
  assert.equal(chooseRecoveryName({ name: 'carved-42.pdf', source: 'carved' }).originalNameStatus, 'unknown');
});

test('a reused generation cannot contribute rename evidence', () => {
  const item = candidate();
  const wrong = item.generationEvents.map(entry => ({ ...entry, sequence: 11 }));
  assert.equal(chooseRecoveryName({ ...item, generationEvents: wrong }).originalNameStatus, 'unknown');
  assert.equal(chooseRecoveryName({ ...item, matchedDeletes: [{ ...item.matchedDeletes[0], sequence: 11 }] }).originalNameStatus, 'unknown');
});

test('ordinary hardlink names use a neutral output while a same-parent DOS alias keeps its long name', () => {
  const first = { name: '보고서.txt', namespace: 1, parent };
  const second = { name: '다른 문서.txt', namespace: 0, parent: originalParent };
  for (const references of [[first, second], [second, first]]) {
    const result = chooseRecoveryName({ recordNumber: 42, name: references[0].name, nameReferences: references });
    assert.equal(result.originalNameStatus, 'ambiguous');
    assert.equal(result.name, 'recovered-record-42.txt');
    assert.equal(result.alternatives.length, 2);
  }
  const valid = chooseRecoveryName({ name: first.name, nameReferences: [first, { name: 'REPORT~1.TXT', namespace: 2, parent }] });
  assert.equal(valid.name, first.name);
  assert.equal(valid.originalNameStatus, 'record-name');
  assert.equal(chooseRecoveryName({ name: second.name, nameReferences: [second] }).originalNameStatus, 'record-name');
});

test('a real NTFS image with two hardlink names saves exact bytes under a neutral name', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recovery-hardlink-name-'));
  const fixture = await createUsnFixture(path.join(root, 'fixture'));
  const bytes = await readFile(fixture.imagePath);
  const start = fixtureGeometry.mftLcn * fixtureGeometry.clusterSize + 24 * fixtureGeometry.fileRecordSize;
  const raw = bytes.subarray(start, start + fixtureGeometry.fileRecordSize);
  const fixed = Buffer.from(raw), usa = raw.readUInt16LE(4), usaCount = raw.readUInt16LE(6);
  for (let i = 1; i < usaCount; i++) fixed.writeUInt16LE(raw.readUInt16LE(usa + 2 * i), i * 512 - 2);
  let attribute = fixed.readUInt16LE(20);
  while (fixed.readUInt32LE(attribute) !== 0x30) attribute += fixed.readUInt32LE(attribute + 4);
  const length = fixed.readUInt32LE(attribute + 4), used = fixed.readUInt32LE(24);
  assert.ok(used + length < fixed.length);
  const duplicate = Buffer.from(fixed.subarray(attribute, attribute + length));
  duplicate.writeUInt16LE(8, 14);
  const value = duplicate.readUInt16LE(20);
  duplicate[value + 65] = 1;
  duplicate.writeUInt16LE('다'.charCodeAt(0), value + 66);
  fixed.copy(fixed, attribute + length, attribute, used);
  duplicate.copy(fixed, attribute);
  fixed.writeUInt32LE(used + length, 24);
  fixed.writeUInt16LE(9, 40);
  for (let i = 1; i < usaCount; i++) {
    fixed.writeUInt16LE(fixed.readUInt16LE(i * 512 - 2), usa + 2 * i);
    fixed.writeUInt16LE(fixed.readUInt16LE(usa), i * 512 - 2);
  }
  fixed.copy(raw);
  await writeFile(fixture.imagePath, bytes);
  const engine = await openNtfsImage(fixture.imagePath);
  try {
    const scan = await engine.scanDeleted();
    const found = scan.candidates.find(item => item.recordNumber === 24);
    assert.equal(found.nameReferences.length, 2);
    assert.equal(found.pathStatus, 'ambiguous');
    assert.equal(found.path, null);
    assert.equal(found.name, 'recovered-record-24.txt');
    const restored = await engine.recover(24, path.join(root, 'output'));
    assert.equal(path.basename(restored.path), 'recovered-record-24.txt');
    assert.equal(createHash('sha256').update(await readFile(restored.path)).digest('hex'), fixture.manifest.files.find(file => file.recordNumber === 24).sha256);
  } finally { await engine.close(); }
});

test('multiple record names, delete matches, or disconnected rename pairs are treated as ambiguous', () => {
  const item = candidate();
  assert.equal(chooseRecoveryName({ ...item, nameReferences: [...item.nameReferences,
    { name: 'hardlink.docx', parent: originalParent }] }).originalNameStatus, 'unknown');
  assert.equal(chooseRecoveryName({ ...item, matchedDeletes: [...item.matchedDeletes, { ...item.matchedDeletes[0], usn: '111' }] }).originalNameStatus, 'unknown');
  assert.equal(chooseRecoveryName({ ...item, generationEvents: [
    event(90, 0x1000, '초안.docx', originalParent), event(91, 0x2000, '다른 자료.docx', originalParent), ...item.generationEvents
  ] }).originalNameStatus, 'unknown');
});

test('a same-parent DOS 8.3 companion does not hide the canonical recycle alias', () => {
  const item = candidate({
    name: '$RSPA2FG.docx',
    nameReferences: [
      { name: '$RSPA2FG.docx', namespace: 1, parent },
      { name: '$RSPA2~1.DOC', namespace: 2, parent },
    ],
    generationEvents: [
      event(100, 0x1000, 'independent-assessment.md', originalParent),
      event(101, 0x2000, '$RSPA2FG.docx'),
      event(110, 0x200, '$RSPA2FG.docx'),
    ],
    matchedDeletes: [event(110, 0x200, '$RSPA2FG.docx')],
  });
  assert.equal(chooseRecoveryName(item).name, 'independent-assessment.md');
  assert.equal(chooseRecoveryName(item).originalNameStatus, 'restored-from-history');
});

test('DOS companions require namespace and a shared parent; hints never substitute for rename proof', () => {
  const item = candidate({
    name: '$RSPA2FG.docx',
    nameReferences: [
      { name: '$RSPA2FG.docx', namespace: 1, parent },
      { name: '$RSPA2~1.DOC', namespace: 2, parent },
    ],
    generationEvents: [],
    matchedDeletes: [event(110, 0x200, '$RSPA2FG.docx')],
    previousNameHints: ['independent-assessment.md'],
  });
  assert.equal(chooseRecoveryName(item).originalNameStatus, 'unknown');
  const proven = candidate({
    name: '$RSPA2FG.docx',
    nameReferences: [
      { name: '$RSPA2FG.docx', namespace: 1, parent },
      { name: '$RSPA2~1.DOC', namespace: 2, parent },
    ],
    generationEvents: [
      event(100, 0x1000, 'independent-assessment.md', originalParent),
      event(101, 0x2000, '$RSPA2FG.docx'),
      event(110, 0x200, '$RSPA2FG.docx'),
    ],
    matchedDeletes: [event(110, 0x200, '$RSPA2FG.docx')],
  });
  const persisted = chooseRecoveryName(proven);
  assert.equal(chooseRecoveryName({ ...proven, generationEvents: [], matchedDeletes: [], restorationName: persisted }).name,
    'independent-assessment.md');
  assert.equal(chooseRecoveryName({ ...proven, nameReferences: [
    { name: '$RSPA2FG.docx', namespace: 1, parent },
    { name: '$RSPA2~1.DOC', namespace: 2, parent: originalParent },
  ] }).originalNameStatus, 'unknown');
  assert.equal(chooseRecoveryName({ ...proven, nameReferences: [
    { name: '$RSPA2FG.docx', namespace: 1, parent },
    { name: '$RSPA2~1.DOC', parent },
  ] }).originalNameStatus, 'unknown');
  assert.equal(chooseRecoveryName({ ...proven, nameReferences: [
    { name: '$RSPA2FG.docx', parent },
    { name: '$RSPA2~1.DOC', namespace: 2, parent },
  ] }).originalNameStatus, 'unknown');
  assert.equal(chooseRecoveryName({ ...proven, nameReferences: [
    { name: '$RSPA2FG.docx', namespace: 1, parent },
    { name: 'hardlink.docx', namespace: 1, parent },
  ] }).originalNameStatus, 'unknown');
});

test('intervening events, reversed pairs, and parent/name mismatches do not form proof', () => {
  const item = candidate();
  assert.equal(chooseRecoveryName({ ...item, generationEvents: [item.generationEvents[0],
    event(101, 0x1, '회의 자료.docx', originalParent), { ...item.generationEvents[1], usn: '102' }, item.generationEvents[2]] }).originalNameStatus, 'unknown');
  assert.equal(chooseRecoveryName({ ...item, generationEvents: [
    { ...item.generationEvents[0], usn: '102' }, item.generationEvents[1], item.generationEvents[2]
  ] }).originalNameStatus, 'unknown');
  assert.equal(chooseRecoveryName({ ...item, generationEvents: [item.generationEvents[0],
    { ...item.generationEvents[1], parent: originalParent }, item.generationEvents[2]] }).originalNameStatus, 'unknown');
  assert.equal(chooseRecoveryName({ ...item, generationEvents: [item.generationEvents[0],
    { ...item.generationEvents[1], name: '$RZZZ999.docx' }, item.generationEvents[2]] }).originalNameStatus, 'unknown');
});

test('unsafe or noncanonical evidence names never become a recovery name', () => {
  for (const unsafe of ['..', 'folder\\escape.docx', 'report.docx:evil', 'CON.txt', 'trailing. ', '$RABC123.docx']) {
    const item = candidate();
    item.generationEvents = [{ ...item.generationEvents[0], name: unsafe }, ...item.generationEvents.slice(1)];
    assert.equal(chooseRecoveryName(item).originalNameStatus, 'unknown', unsafe);
  }
  assert.equal(chooseRecoveryName({ name: 'folder/escape.docx' }).originalNameStatus, 'unknown');
  assert.equal(chooseRecoveryName(candidate({ name: '$RTOOLONG1.docx',
    nameReferences: [{ name: '$RTOOLONG1.docx', parent }] })).originalNameStatus, 'unknown');
});

test('combined discovery publishes and preparation merge preserves only the proven restoration name', async () => {
  const header = Buffer.alloc(8); header.writeBigInt64LE(2000n);
  let reads = 0;
  const journalProvider = {
    async queryJournal() { return { journalId: '1', firstUsn: '1000', lowestValidUsn: '1000', nextUsn: '2000' }; },
    async readJournal() {
      if (reads++) return { data: header };
      return { data: Buffer.concat([header,
        usnRecord({ recordNumber: 42, sequence: 12, reason: 0x1000, name: '원본 보고서.docx', usn: 1100 }),
        usnRecord({ recordNumber: 42, sequence: 12, reason: 0x2000, name: '$RABC123.docx', usn: 1200 }),
        usnRecord({ recordNumber: 42, sequence: 12, reason: 0x80002000, name: '$RABC123.docx', usn: 1250 }),
        usnRecord({ recordNumber: 42, sequence: 12, reason: 0x200, name: '$RABC123.docx', usn: 1300 }),
      ]) };
    }
  };
  const mftName = { name: '$RABC123.docx', parent: { recordNumber: 5, sequence: 1 } };
  const record = { recordNumber: 42, sequence: 13, fingerprint: 'fixture', flags: 0, baseReference: 0n,
    names: [mftName], attributes: [{ type: 0x80, name: '', resident: true, size: 10 }] };
  const engine = { info: { recordCount: 100 }, busy: false, scanned: new Map(), scanCheckpoint: null, mftBitmap: {},
    async assertUnchanged() {}, async record() { return record; }, async bitmapBit() { return false; } };
  const result = await scanCombined(engine, { strategy: 'journal', journalProvider });
  const discovered = result.candidates[0];
  assert.equal(discovered.name, '$RABC123.docx');
  assert.deepEqual(discovered.restorationName, {
    name: '원본 보고서.docx', source: 'windows-usn-rename-pair', evidence: {
      fileReference: ((12n << 48n) | 42n).toString(), oldNameUsn: '1100', newNameUsn: '1200', deleteUsn: '1300',
      oldParentFileReference: ((1n << 48n) | 5n).toString(),
      recycleParentFileReference: ((1n << 48n) | 5n).toString(),
    }
  });
  const merged = mergePreparedCandidate(discovered, { ...discovered, name: 'prepared.bin', status: 'readable', restorationName: null });
  assert.deepEqual(merged.restorationName, discovered.restorationName);
  assert.equal(merged.name, '$RABC123.docx');
  assert.equal(chooseRecoveryName(merged).name, '원본 보고서.docx');
  const tampered = { ...merged, restorationName: { ...merged.restorationName,
    evidence: { ...merged.restorationName.evidence, recycleParentFileReference: '1' } } };
  assert.equal(chooseRecoveryName(tampered).originalNameStatus, 'unknown');
});

test('native synthetic NTFS restores exact bytes under the paired pre-trash basename', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recovery-name-native-'));
  const fixture = await createUsnFixture(path.join(root, 'fixture'));
  const image = await readFile(fixture.imagePath);
  const recordStart = fixtureGeometry.mftLcn * fixtureGeometry.clusterSize + 24 * fixtureGeometry.fileRecordSize;
  const recordEnd = recordStart + fixtureGeometry.fileRecordSize;
  const oldRecordName = Buffer.from('삭제된-문서.txt', 'utf16le');
  const alias = '$RABC123';
  const nameAt = image.indexOf(oldRecordName, recordStart);
  assert.ok(nameAt >= recordStart && nameAt + oldRecordName.length <= recordEnd, 'fixture MFT filename must be found');
  image[nameAt - 2] = alias.length;
  image.fill(0, nameAt, nameAt + oldRecordName.length);
  Buffer.from(alias, 'utf16le').copy(image, nameAt);
  await writeFile(fixture.imagePath, image);
  const sourceHash = createHash('sha256').update(image).digest('hex');

  const header = Buffer.alloc(8); header.writeBigInt64LE(2000n);
  let reads = 0;
  let recoveryName = '원래-문서.txt';
  const journalProvider = {
    async queryJournal() { return { journalId: '7', firstUsn: '1000', lowestValidUsn: '1000', nextUsn: '2000' }; },
    async readJournal() {
      if (reads++) return { data: header };
      return { data: Buffer.concat([header,
        usnRecord({ recordNumber: 24, sequence: 6, reason: 0x1000, name: recoveryName, usn: 1100 }),
        usnRecord({ recordNumber: 24, sequence: 6, reason: 0x2000, name: alias, usn: 1200 }),
        usnRecord({ recordNumber: 24, sequence: 6, reason: 0x200, name: alias, usn: 1300 }),
      ]) };
    }
  };

  const engine = await openNtfsImage(fixture.imagePath);
  try {
    for (const originalName of ['원래-문서.txt', '가'.repeat(181 - 5) + '.docx', '나'.repeat(195 - 4) + '.hwp', '다'.repeat(255 - 5) + '.docx']) {
      recoveryName = originalName; reads = 0;
      const scan = await scanCombined(engine, { strategy: 'journal', journalProvider });
      const discovered = decorateNativeCandidate(scan.candidates.find(item => item.recordNumber === 24), 'fixture-partition');
      assert.equal(discovered.name, alias);
      const prepared = await prepareNativeCandidate(engine, discovered, { prepare: prepareCombinedCandidate });
      const naming = chooseRecoveryName(prepared);
      assert.equal(naming.name, originalName);
      assert.equal(naming.originalNameStatus, 'restored-from-history');
      const output = await engine.recover(24, path.join(root, 'output'), { outputName: naming.name });
      assert.equal(path.extname(output.path), path.extname(originalName));
      assert.ok(path.basename(output.path).length <= 180);
      assert.equal(path.basename(output.path) !== naming.name, originalName.length > 180);
      if (originalName.length <= 180) assert.equal(path.basename(output.path), originalName);
      const expected = fixture.manifest.files.find(file => file.recordNumber === 24);
      assert.equal(createHash('sha256').update(await readFile(output.path)).digest('hex'), expected.sha256);
      assert.equal(createHash('sha256').update(await readFile(fixture.imagePath)).digest('hex'), sourceHash);
    }
  } finally { await engine.close(); }
});
