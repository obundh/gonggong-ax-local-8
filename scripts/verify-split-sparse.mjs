// Same immutable synthetic images to both versions; never opens a live drive.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSplitSparseFixture } from '../test/ntfs-split-sparse-fixture.mjs';

const [baselineDirectory, currentDirectory, evidenceDirectory] = process.argv.slice(2);
if (!baselineDirectory || !currentDirectory || !evidenceDirectory) throw Error('Supply baseline engine, current engine, fresh evidence directory');
const output = path.resolve(evidenceDirectory);
await mkdir(output);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const versions = [];
for (const [name, directory] of [['baseline', baselineDirectory], ['current', currentDirectory]]) {
  const modulePath = path.resolve(directory, 'ntfs-image.mjs');
  versions.push({ name, open: (await import(pathToFileURL(modulePath))).openNtfsImage,
    engineSHA: sha(await readFile(modulePath)) });
}
const cases = [];
for (const scenario of ['compact', 'extended', 'all-sparse-extension', 'multi-extension-uninitialized']) {
  const fixture = await createSplitSparseFixture(path.join(output, scenario), { scenario });
  const rows = [];
  for (const version of versions) {
    const image = await version.open(fixture.imagePath);
    try {
      const candidate = (await image.scanDeleted()).candidates.find(c => c.recordNumber === fixture.recordNumber);
      assert.ok(candidate);
      let result;
      try {
        const saved = await image.recover(fixture.recordNumber, path.join(output, scenario, version.name));
        const bytes = await readFile(saved.path);
        assert.equal(saved.originalIdentityVerified, false);
        result = { saved: true, exact: bytes.length === fixture.logicalSize && sha(bytes) === fixture.expectedSHA,
          size: bytes.length, sha256: sha(bytes), path: saved.path };
        assert.equal(result.exact, true, 'Saved output must match the independent original');
      } catch (error) {
        if (error.code !== 'NOT_RECOVERABLE') throw error;
        result = { saved: false, exact: false, error: error.code };
      }
      assert.equal(result.exact, version.name === 'current', scenario);
      assert.equal(sha(await readFile(fixture.imagePath)), fixture.imageSHA);
      rows.push({ version: version.name, engineSHA: version.engineSHA, candidateStatus: candidate.status, ...result });
    } finally { await image.close(); }
  }
  cases.push({ scenario, imagePath: fixture.imagePath, sourceSHA: fixture.imageSHA,
    expectedSHA: fixture.expectedSHA, logicalSize: fixture.logicalSize, initializedSize: fixture.initializedSize, rows });
}
const summary = Object.fromEntries(versions.map(v => [v.name, { exact: cases.filter(c => c.rows.find(r => r.version === v.name).exact).length, total: cases.length }]));
await writeFile(path.join(output, 'comparison.json'), JSON.stringify({ scope: 'Synthetic NTFS split sparse images. No live SSD deletion trial.', summary, cases }, null, 2), { flag: 'wx' });
console.log(JSON.stringify(summary));
