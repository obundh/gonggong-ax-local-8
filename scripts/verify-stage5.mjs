// Fixed-image acceptance and output-classification comparison. Never opens a live drive.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createStage5BodyFixture } from '../test/stage5-body-fixture.mjs';

const [baselineDirectory, currentDirectory, outputDirectory] = process.argv.slice(2);
if (!baselineDirectory || !currentDirectory || !outputDirectory) throw Error('Supply baseline engine, current engine and fresh evidence directory');
const output = path.resolve(outputDirectory); await mkdir(output);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const versions = [];
for (const [label, directory] of [['baseline', baselineDirectory], ['current', currentDirectory]]) {
  const base = path.resolve(directory), load = name => import(pathToFileURL(path.join(base, name)));
  versions.push({ label, openNtfsImage: (await load('ntfs-image.mjs')).openNtfsImage,
    recoveryOutcome: (await load('recovery-outcome.mjs')).recoveryOutcome,
    hashes: Object.fromEntries(await Promise.all(['ntfs-image.mjs', 'recovery-verification.mjs', 'recovery-outcome.mjs']
      .map(async name => [name, sha(await readFile(path.join(base, name)))]))) });
}
const cases = [];
for (const [name, tail] of [['full-initialized', 0], ['declared-uninitialized-tail', 2049]]) {
  const fixture = await createStage5BodyFixture(path.join(output, name), { uninitializedTailBytes: tail });
  const sourceSha = sha(await readFile(fixture.imagePath)), rows = [];
  for (const version of versions) {
    const engine = await version.openNtfsImage(fixture.imagePath);
    try {
      const scan = await engine.scanDeleted();
      const candidate = scan.candidates.find(item => item.recordNumber === fixture.recordNumber);
      assert.equal(candidate.status, 'readable');
      const saved = await engine.recover(candidate.recordNumber, path.join(output, name, version.label));
      const actual = await readFile(saved.path), outcome = version.recoveryOutcome(saved);
      assert.equal(saved.size, fixture.logicalSize); assert.equal(actual.length, fixture.logicalSize);
      assert.equal(sha(actual), fixture.expectedSHA); assert.equal(saved.sha256, fixture.expectedSHA);
      assert.equal(saved.integrity.status, 'verified'); assert.equal(saved.originalIdentityVerified, false);
      assert.equal(outcome.originalBytesVerified, false); assert.equal(outcome.documentOpenVerified, false);
      assert.equal(outcome.partialContent, version.label === 'baseline');
      assert.equal(outcome.kind, version.label === 'baseline' ? 'partial-content-saved' : 'saved-unchecked');
      assert.equal(sha(await readFile(fixture.imagePath)), sourceSha);
      rows.push({ version: version.label, engineHashes: version.hashes, saved, outcome,
        externalComparison: { exact: true, expectedSHA: fixture.expectedSHA, actualSHA: sha(actual), size: actual.length },
        sourceUnchanged: true });
    } finally { await engine.close(); }
  }
  cases.push({ name, sourceSha, imagePath: fixture.imagePath, logicalSize: fixture.logicalSize,
    initializedSize: fixture.initializedSize, runs: fixture.runs, rows });
}
const result = { scope: 'Fixed synthetic NTFS 3.1 images, 4 KiB clusters, 1 KiB records. No live SSD trial or recovery-rate claim.',
  conclusion: 'Both versions recover exact full logical bytes. Only the new version separates document assessment limits from partial extraction.', cases };
await writeFile(path.join(output, 'stage5-comparison.json'), JSON.stringify(result, null, 2), { flag: 'wx' });
console.log(JSON.stringify(cases.map(c => ({ name: c.name, bytes: c.logicalSize, rows: c.rows.map(r => ({ version: r.version,
  exact: r.externalComparison.exact, partialContent: r.outcome.partialContent, kind: r.outcome.kind })) })), null, 2));
