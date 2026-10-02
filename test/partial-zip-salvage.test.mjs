import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

import { salvageDocument } from '../engine/document-salvage.mjs';
import {
  brokenLocalHeader,
  centralDirectoryMarker,
  corruptCrc,
  damagedZip,
  fixtureText,
  localZipEntry,
  textXml,
} from './partial-zip-fixture.mjs';

let root;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

before(async () => { root = await mkdtemp(path.join(os.tmpdir(), 'recoverychat-partial-zip-')); });
after(async () => { await rm(root, { recursive: true, force: true }); });

async function source(name, bytes) {
  const file = path.join(root, name);
  await writeFile(file, bytes, { flag: 'w' });
  return file;
}

async function savedText(destination) {
  const resultDirectories = await readdir(destination, { withFileTypes: true });
  assert.equal(resultDirectories.length, 1, 'partial text publishes one result directory');
  assert.ok(resultDirectories[0].isDirectory());
  const files = await readdir(path.join(destination, resultDirectories[0].name));
  assert.equal(files.length, 1, 'result directory contains only the generated text');
  assert.match(files[0], /\.salvaged\.txt$/u);
  return readFile(path.join(destination, resultDirectories[0].name, files[0]), 'utf8');
}

async function assertNoPublishedResult(destination) {
  try {
    const entries = await readdir(destination, { withFileTypes: true });
    assert.ok(entries.every(entry => entry.name.startsWith('.recoverychat-salvage-writing-')),
      'only private staging may remain after a refused salvage');
  } catch (error) { assert.equal(error.code, 'ENOENT'); }
}

function assertCoverage(result, { sourceBytes, parsedBytes, stopCode, selected, extracted, skipped = 0 }) {
  assert.equal(result.status, 'partial');
  assert.equal(result.originalIdentityVerified, false);
  for (const key of [
    'attemptedParts', 'entriesParsed', 'extractedParts', 'mode', 'parsedBytes', 'selectedParts',
    'skippedParts', 'sourceBytes', 'stop', 'unexaminedBytes',
  ]) assert.ok(Object.hasOwn(result.coverage, key), `coverage.${key} is required`);
  assert.equal(result.coverage.mode, 'sequential-local-zip');
  assert.equal(result.coverage.sourceBytes, sourceBytes);
  assert.equal(result.coverage.parsedBytes, parsedBytes);
  assert.equal(result.coverage.unexaminedBytes, sourceBytes - parsedBytes);
  assert.equal(result.coverage.stop?.code ?? null, stopCode);
  assert.equal(result.coverage.selectedParts, selected);
  assert.equal(result.coverage.extractedParts, extracted);
  assert.equal(result.coverage.skippedParts.length, skipped);
  assert.equal(result.extractedParts.length, extracted);
  for (const part of result.extractedParts) {
    assert.match(part.name, /\.xml$/u);
    assert.match(part.sha256, /^[0-9a-f]{64}$/u);
    assert.ok(Number.isSafeInteger(part.bytes) && part.bytes > 0);
  }
}

test('keeps verified DOCX XML before a garbage tail and records the unexamined tail', async () => {
  const valid = localZipEntry('word/document.xml', textXml(fixtureText.docx));
  const tail = Buffer.from('not-a-local-header-after-verified-entry', 'utf8');
  const bytes = damagedZip([valid], tail);
  const file = await source('prefix-garbage.docx', bytes);
  const destination = path.join(root, 'prefix-garbage-output');
  const result = await salvageDocument(file, destination, { sourceKind: 'user-selected' });
  assertCoverage(result, { sourceBytes: bytes.length, parsedBytes: valid.length, stopCode: 'ZIP_LOCAL_ENTRY_TRUNCATED', selected: 1, extracted: 1 });
  assert.equal(result.coverage.stop.offset, valid.length);
  assert.equal(result.coverage.entriesParsed, 1);
  assert.equal(result.truncated, true, 'a structural stop makes this a bounded partial extraction');
  const output = await savedText(destination);
  assert.match(output, /word\/document\.xml/u);
  assert.match(output, new RegExp(fixtureText.docx, 'u'));
  assert.equal(result.extractedParts[0].sha256, sha256(textXml(fixtureText.docx)));
  assert.equal(sha256(await readFile(file)), sha256(bytes), 'source stays unchanged');
});

test('stops after a complete prefix when a later local entry body is cut, without trusting a decoy after it', async () => {
  const good = localZipEntry('word/document.xml', textXml(fixtureText.docx));
  const broken = brokenLocalHeader({ declaredBodyBytes: 1024 * 1024 });
  const decoy = localZipEntry('word/after-damage.xml', textXml(fixtureText.decoy));
  const bytes = damagedZip([good, broken, decoy]);
  const file = await source('body-cut.docx', bytes);
  const result = await salvageDocument(file, path.join(root, 'body-cut-output'), { sourceKind: 'owned-carved' });
  assertCoverage(result, { sourceBytes: bytes.length, parsedBytes: good.length, stopCode: 'ZIP_LOCAL_ENTRY_TRUNCATED', selected: 1, extracted: 1 });
  const output = await savedText(path.join(root, 'body-cut-output'));
  assert.match(output, new RegExp(fixtureText.docx, 'u'));
  assert.doesNotMatch(output, new RegExp(fixtureText.decoy, 'u'), 'no resynchronization beyond the first damage');
});

test('extracts independently valid selected siblings and reports CRC failures for XLSX, PPTX, and HWPX', async () => {
  const cases = [
    ['mixed.xlsx', [
      localZipEntry('xl/workbook.xml', textXml('workbook', 'workbook')),
      localZipEntry('xl/worksheets/sheet1.xml', textXml(fixtureText.xlsxGood, 'worksheet')),
      corruptCrc(localZipEntry('xl/worksheets/sheet2.xml', textXml(fixtureText.xlsxBad, 'worksheet'))),
    ], fixtureText.xlsxGood, fixtureText.xlsxBad],
    ['mixed.pptx', [
      localZipEntry('ppt/presentation.xml', textXml('presentation', 'p:presentation')),
      localZipEntry('ppt/slides/slide1.xml', textXml(fixtureText.pptxGood, 'p:sld')),
      corruptCrc(localZipEntry('ppt/slides/slide2.xml', textXml(fixtureText.pptxBad, 'p:sld'))),
    ], fixtureText.pptxGood, fixtureText.pptxBad],
    ['mixed.hwpx', [
      localZipEntry('[Content_Types].xml', textXml('types', 'Types')),
      localZipEntry('Contents/section0.xml', textXml(fixtureText.hwpxGood, 'hp:section')),
      corruptCrc(localZipEntry('Contents/section1.xml', textXml(fixtureText.hwpxBad, 'hp:section'))),
    ], fixtureText.hwpxGood, fixtureText.hwpxBad],
  ];
  for (const [name, entries, expected, excluded] of cases) {
    const bytes = damagedZip(entries);
    const destination = path.join(root, `${name}-output`);
    const result = await salvageDocument(await source(name, bytes), destination, { sourceKind: 'user-selected' });
    assertCoverage(result, { sourceBytes: bytes.length, parsedBytes: bytes.length, stopCode: null, selected: 2, extracted: 1, skipped: 1 });
    assert.equal(result.coverage.stop, null);
    assert.equal(result.coverage.skippedParts[0].code, 'ZIP_CRC_MISMATCH');
    const output = await savedText(destination);
    assert.match(output, new RegExp(expected, 'u'));
    assert.doesNotMatch(output, new RegExp(excluded, 'u'));
  }
});

test('does not publish text when every selected XML is invalid', async () => {
  const bad = corruptCrc(localZipEntry('word/document.xml', textXml('should-not-publish')));
  const file = await source('all-bad.docx', damagedZip([bad]));
  const destination = path.join(root, 'all-bad-output');
  await assert.rejects(() => salvageDocument(file, destination, { sourceKind: 'user-selected' }), { code: 'ZIP_CRC_MISMATCH' });
  await assertNoPublishedResult(destination);
});

test('refuses unsafe ZIP structures and active-content signals rather than treating them as partial recovery', async () => {
  const valid = localZipEntry('word/document.xml', textXml('safe'));
  const xxe = localZipEntry('word/document.xml', Buffer.from('<!DOCTYPE x [<!ENTITY e SYSTEM "file:///never">]><w:document xmlns:w="urn:x"><w:t>&e;</w:t></w:document>'));
  const cases = [
    ['encrypted.docx', damagedZip([localZipEntry('word/document.xml', textXml('x'), { flags: 1 })]), 'ZIP_ENCRYPTED_UNSUPPORTED'],
    ['descriptor.docx', damagedZip([localZipEntry('word/document.xml', textXml('x'), { flags: 0x08 })]), 'ZIP_DATA_DESCRIPTOR_UNSUPPORTED'],
    ['duplicate.docx', damagedZip([valid, localZipEntry('word/document.xml', textXml('dup'))]), 'ZIP_DAMAGED'],
    ['unsafe.docx', damagedZip([localZipEntry('../word/document.xml', textXml('x'))]), 'ZIP_DAMAGED'],
    ['macro.docx', damagedZip([valid, localZipEntry('word/vbaProject.bin', Buffer.from('never execute'))]), 'MACRO_CONTENT_UNSUPPORTED'],
    ['xxe.docx', damagedZip([xxe]), 'XML_EXTERNAL_ENTITY_UNSUPPORTED'],
    ['complete.docx', damagedZip([valid], centralDirectoryMarker()), 'ZIP_CENTRAL_DIRECTORY_PRESENT'],
  ];
  for (const [name, bytes, code] of cases) {
    const destination = path.join(root, `${name}-output`);
    const file = await source(name, bytes);
    await assert.rejects(() => salvageDocument(file, destination, { sourceKind: 'user-selected' }), { code });
    await assertNoPublishedResult(destination);
  }
});

test('records XML part-limit skips and maintains the decoded-byte budget without generating omitted text', async () => {
  const entries = [localZipEntry('xl/workbook.xml', textXml('workbook', 'workbook'))];
  for (let index = 0; index < 34; index += 1) entries.push(localZipEntry(`xl/worksheets/sheet${index}.xml`, textXml(`limit-${index}`, 'worksheet')));
  const bytes = damagedZip(entries);
  const destination = path.join(root, 'part-limit-output');
  const result = await salvageDocument(await source('part-limit.xlsx', bytes), destination, { sourceKind: 'user-selected' });
  assert.equal(result.truncated, true);
  assert.ok(result.coverage.skippedParts.some(item => item.code === 'XML_PART_LIMIT'));
  const output = await savedText(destination);
  assert.match(output, /limit-0/u);
  assert.doesNotMatch(output, /limit-33/u);
});

test('cancellation and source mutation publish no completed partial text', async () => {
  const bytes = damagedZip([localZipEntry('word/document.xml', textXml('cancel'))]);
  const cancelled = new AbortController();
  cancelled.abort();
  const cancelDestination = path.join(root, 'cancel-output');
  const cancelledSource = await source('cancel.docx', bytes);
  await assert.rejects(() => salvageDocument(cancelledSource, cancelDestination, {
    sourceKind: 'owned-carved', signal: cancelled.signal,
  }), { code: 'CANCELLED' });
  await assertNoPublishedResult(cancelDestination);

  const changed = await source('source-change.docx', bytes);
  const changedDestination = path.join(root, 'source-change-output');
  let mutated = false;
  await assert.rejects(() => salvageDocument(changed, changedDestination, {
    sourceKind: 'owned-carved',
    control: { checkpoint: async () => {
      if (!mutated) { mutated = true; await writeFile(changed, Buffer.concat([bytes, Buffer.from('changed')])); }
    } },
  }), { code: 'SOURCE_CHANGED' });
  assert.equal(mutated, true);
  await assertNoPublishedResult(changedDestination);
  assert.ok((await stat(changed)).size > BigInt(bytes.length));
});

test('skips malformed XML, trailing compressed bytes and failed inflate while keeping a verified sibling', async () => {
  const prefix = [localZipEntry('ppt/presentation.xml', textXml('marker')),
    localZipEntry('ppt/slides/slide1.xml', textXml('surviving-text'))];
  const trailing = localZipEntry('ppt/slides/slide2.xml', textXml('must-not-leak'));
  trailing.writeUInt32LE(trailing.readUInt32LE(18) + 1, 18);
  const badDeflate = localZipEntry('ppt/slides/slide2.xml', textXml('must-not-leak'));
  badDeflate.fill(0xff, 30 + badDeflate.readUInt16LE(26));
  const variants = [
    [localZipEntry('ppt/slides/slide2.xml', Buffer.from('<a>bad</b>')), 'XML_INVALID'],
    [Buffer.concat([trailing, Buffer.from([0])]), 'ZIP_DEFLATE_FAILED'],
    [badDeflate, 'ZIP_DEFLATE_FAILED'],
    [localZipEntry('ppt/slides/slide2.xml', Buffer.from([0xff])), 'XML_ENCODING_UNSUPPORTED'],
  ];
  for (const [index, [bad, code]] of variants.entries()) {
    const file = await source(`invalid-part-${index}.pptx`, damagedZip([...prefix, bad]));
    const result = await salvageDocument(file, path.join(root, `invalid-part-${index}-out`), { sourceKind: 'user-selected' });
    assert.equal(result.coverage.extractedParts, 1);
    assert.equal(result.coverage.skippedParts[0].code, code);
    const output = await readFile(result.path, 'utf8');
    assert.match(output, /surviving-text/); assert.doesNotMatch(output, /must-not-leak/);
  }
});

test('charges cumulative decoded size before reading a later compressed XML', async () => {
  const xml = textXml('budget-text' + ' '.repeat(650));
  const bytes = damagedZip([localZipEntry('ppt/presentation.xml', textXml('marker')),
    ...[1, 2, 3].map(n => localZipEntry(`ppt/slides/slide${n}.xml`, xml))]);
  assert.ok(bytes.length < 1024); assert.ok(xml.length < 1024);
  const result = await salvageDocument(await source('decoded-budget.pptx', bytes), path.join(root, 'decoded-budget-out'),
    { sourceKind: 'user-selected', maxBytes: 1024 });
  assert.equal(result.coverage.attemptedParts, 1);
  assert.equal(result.coverage.decodedBytes, xml.length);
  assert.equal(result.coverage.skippedParts.length, 2);
  assert.ok(result.coverage.skippedParts.every(p => p.code === 'XML_DECODE_BUDGET'));
  assert.equal(result.truncated, true);
});
