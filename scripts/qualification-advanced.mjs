// Creates fixed positive/negative images; originals and positions go only to the scorer.
import { mkdir, readFile, writeFile, open } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createFixture } from '../test/ntfs-fixtures.mjs';
import { makeCompressedUnit, makeMixedSparse, installSplitFile, attributeOffset } from '../test/ntfs-qualification-primitives.mjs';

if (!process.argv[2]) throw Error('new output directory required');
const root = path.resolve(process.argv[2]);
await mkdir(root); await mkdir(path.join(root, 'inputs')); await mkdir(path.join(root, 'oracle'));
const template = await createFixture(path.join(root, 'template'));
const base = await readFile(template.imagePath);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const plans = [], cases = [];
for (const kind of ['compressed', 'sparse', 'attribute-list']) for (const corrupt of [false, true]) {
  const bytes = Buffer.from(base), id = `advanced-${kind}-${corrupt ? 'invalid' : 'valid'}`;
  let original;
  if (kind === 'compressed') original = makeCompressedUnit(bytes, { malformedPayload: corrupt });
  if (kind === 'sparse') {
    original = makeMixedSparse(bytes);
    if (corrupt) bytes.writeBigUInt64LE(4096n, attributeOffset(bytes, 37, 0x80) + 40);
  }
  if (kind === 'attribute-list') original = installSplitFile(bytes, corrupt ? { listedSequence: 6 } : {});
  const input = path.join(root, 'inputs', `${id}.img`), originalFile = path.join(root, 'oracle', `${kind}.bin`);
  if (!corrupt) await writeFile(originalFile, original, { flag: 'wx' });
  const handle = await open(input, 'wx');
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  if (hash(await readFile(input)) !== hash(bytes)) throw Error('Image readback failed');
  plans.push({ id, cohort: 'development', input, inputSha256: hash(bytes), size: bytes.length, modes: ['metadata'] });
  cases.push({ id, cohort: 'development', layout: `${kind}-${corrupt ? 'invalid' : 'valid'}`, sourceSha256: hash(bytes), synthetic: true, targets: [{
    id: `${kind}-target`, name: kind === 'attribute-list' ? 'split-data.bin' : 'compressed.bin',
    originalPath: `synthetic/${kind}.bin`, originalFile, size: original.length, sha256: hash(original),
    recordNumber: kind === 'attribute-list' ? 36 : 37,
    expected: { bodyIntact: !(corrupt && kind === 'compressed'), metadataExact: !corrupt, metadataAbsent: false, metadataRefused: corrupt },
  }], limits: ['Synthetic metadata/bytes only; no actual deletion or TRIM experiment',
    'Corrupt variant must refuse this target; background candidates/errors are scored separately'] });
}
await writeFile(path.join(root, 'plan.json'), JSON.stringify({ version: 1, cases: plans }, null, 2), { flag: 'wx' });
await writeFile(path.join(root, 'oracle', 'answers.json'), JSON.stringify({ version: 1, cases }, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ root, cases: cases.length }));
