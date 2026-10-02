import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { linearizedPdfExtent } from '../engine/pdf-extent.mjs';
import { carveFiles } from '../engine/carving.mjs';

function fixture() {
  const bytes = Buffer.alloc(1024, 0x20);
  bytes.write('%PDF-1.6\n8 0 obj\n<</Linearized 1/L 001024/O 9/E 400/N 1/T 700/H [300 20]>>\nendobj\n');
  bytes.write('xref\n8 2\n0000000009 00000 n\n0000000250 00000 n\ntrailer<</Size 10>>\nstartxref\n0\n%%EOF\n', 128);
  bytes.write('9 0 obj<</Type/Page>>endobj\n', 250);
  bytes.write('10 0 obj<</Length 0>>stream\n\nendstream\nendobj\n', 300);
  bytes.write('xref\n0 1\n', 691);
  bytes.write('0000000000 65535 f\ntrailer<</Size 10>>\n', 700);
  const footer = '\nstartxref\n128\n%%EOF\n';
  bytes.write(footer, bytes.length - footer.length);
  return bytes;
}

async function check(bytes, { available = bytes.length, cap = 64 * 1024 * 1024 } = {}) {
  return linearizedPdfExtent(async (offset, length) => {
    assert.ok(offset >= 0 && length >= 0 && offset + length <= available, 'never read outside selected range');
    assert.ok(length <= 4096, 'extent checks stay bounded');
    return bytes.subarray(offset, offset + length);
  }, available, cap);
}

test('linearized PDF extent includes body after internal EOF', async () => {
  const result = await check(fixture());
  assert.equal(result.state, 'complete');
  assert.equal(result.length, 1024);
});

test('carving keeps complete linearized bytes and adjacent PDF separate', async () => {
  const original = fixture(), other = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF\n');
  const bytes = Buffer.concat([original, other]);
  const temporary = path.resolve(os.tmpdir());
  const root = await mkdtemp(path.join(temporary, 'recoverychat-pdf-extent-'));
  try {
    const result = await carveFiles({ info: { size: bytes.length }, assertUnchanged: async () => {},
      read: async (offset, length) => bytes.subarray(offset, offset + length) }, path.join(root, 'outputs'));
    assert.equal(result.candidates.length, 2);
    assert.deepEqual(await readFile(result.candidates[0].path), original);
    assert.deepEqual(await readFile(result.candidates[1].path), other);
    assert.equal(result.candidates[0].nameIsGenerated, true);
  } finally {
    assert.ok(path.dirname(root) === temporary && path.basename(root).startsWith('recoverychat-pdf-extent-'));
    await rm(root, { recursive: true, force: true });
  }
});

test('PDF comment, literal, hex string and nested dictionary are not linearization keys', async () => {
  const bytes = Buffer.from('%PDF-1.4\n% /Linearized 1/L 99999\n1 0 obj<</Info (escaped \\) /Linearized 1 /L 999999) /Hex <1234> /Nested <</Linearized 1>> /Ref 2 0 R>>endobj\n%%EOF\n');
  assert.equal(await check(bytes), null);
});

test('escaped PDF names are parsed as actual dictionary keys', async () => {
  const bytes = fixture();
  const header = '%PDF-1.6\n8 0 obj<</Lineariz#65d 1/L 001024/O 9/E 400/N 1/T 700/H [300 20]>>endobj\n';
  bytes.fill(0x20, 0, 128); bytes.write(header);
  assert.equal((await check(bytes)).length, bytes.length);
});

test('corrupt or unsupported linearization is never silently reduced to first EOF', async t => {
  const cases = {
    'zero length': b => b.write('000000', b.indexOf('/L ') + 3),
    'outside range': b => b.write('002048', b.indexOf('/L ') + 3),
    'bad final footer': b => b.write('BROKEN', b.length - 7),
    'bad first xref': b => b.write('junk', 128),
    'bad main xref': b => b.write('junk', 700),
    'indirect length': b => { b.fill(0x20, 0, 128); b.write('%PDF-1.6\n8 0 obj<</Linearized 1/L 1 0 R/O 9/E 400/N 1/T 700/H [300 20]>>endobj\n'); },
    'duplicate length': b => { b.fill(0x20, 0, 128); b.write('%PDF-1.6\n8 0 obj<</Linearized 1/L 1024/L 1024/O 9/E 400/N 1/T 700/H [300 20]>>endobj\n'); },
    'unsafe integer': b => { b.fill(0x20, 0, 128); b.write('%PDF-1.6\n8 0 obj<</Linearized 1/L 9007199254740992/O 9/E 400/N 1/T 700/H [300 20]>>endobj\n'); },
  };
  for (const [name, mutate] of Object.entries(cases)) await t.test(name, async () => {
    const bytes = fixture(); mutate(bytes);
    assert.notEqual((await check(bytes)).state, 'complete');
  });
  assert.equal((await check(fixture(), { available: 900 })).state, 'unsupported');
  assert.equal((await check(fixture(), { cap: 900 })).state, 'limit');
});

test('recognizable appended revision invalidates old linearized length', async () => {
  for (const extra of ['\n11 0 obj<</Type/Page>>endobj\n', '\n% incremental save\nxref\n0 1\n']) {
    const result = await check(Buffer.concat([fixture(), Buffer.from(extra)]));
    assert.equal(result.state, 'unsupported');
  }
});
