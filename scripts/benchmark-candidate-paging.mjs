// Compare identical frozen candidates; never scans or deletes source files.
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const args = process.argv.slice(2);
const option = key => {
  const at = args.indexOf(key);
  if (at < 0 || !args[at + 1] || args[at + 1].startsWith('--')) throw Error(`${key} is required`);
  return path.resolve(args[at + 1]);
};
const inputPath = option('--input'), baseline = option('--baseline'), current = option('--current'), output = option('--output');
await mkdir(output, { recursive: true });
const root = await mkdtemp(path.join(output, 'paging-'));
const hash = value => createHash('sha256').update(value).digest('hex');
const input = await readFile(inputPath), rows = input.toString().trim().split(/\r?\n/).map(JSON.parse);
const canonicalHash = hash(rows.map(row => JSON.stringify(row) + '\n').join(''));
const filters = { deletedAfter: '2026-09-20T00:00:00+09:00', deletedBefore: '2026-09-21T00:00:00+09:00', includeUnknownDeletedAt: true };
const queries = [
  { label: 'latest-first-page', offset: 0, limit: 20, sort: 'deleted-desc' },
  { label: 'date-first-page', offset: 0, limit: 20, sort: 'deleted-desc', filters },
  { label: 'date-next-page', offset: 20, limit: 20, sort: 'deleted-desc', filters },
  { label: 'date-next-sort-name', offset: 20, limit: 20, sort: 'name-asc', filters }
];
const report = { startedAt: new Date().toISOString(), inputPath, inputSha256: hash(input), inputCount: rows.length,
  scope: 'Identical frozen candidate rows, no disk discovery or body recovery; one run per engine on this PC.', runs: [] };
for (const [label, engineRoot] of [['baseline', baseline], ['current', current]]) {
  const { openCandidateStore } = await import(pathToFileURL(path.join(engineRoot, 'candidate-store.mjs')).href);
  const store = openCandidateStore(path.join(root, `${label}.sqlite`));
  try {
    const start = performance.now();
    for (let index = 0; index < rows.length; index += 256) assert.equal(store.setBatch(rows.slice(index, index + 256)).truncated, false);
    const writeMs = performance.now() - start;
    const storedHash = createHash('sha256');
    for (const row of store.values()) storedHash.update(JSON.stringify(row) + '\n');
    const storedSha256 = storedHash.digest('hex');
    assert.equal(store.size, rows.length); assert.equal(storedSha256, canonicalHash);
    const pages = [];
    for (const { label: queryLabel, ...query } of queries) {
      const before = performance.now(), result = store.page(query), elapsedMs = performance.now() - before;
      const bytes = Buffer.from(JSON.stringify(result));
      await writeFile(path.join(root, `${label}-${queryLabel}.json`), bytes, { flag: 'wx' });
      const receipt = { label: queryLabel, elapsedMs, total: result.total, returned: result.items.length, sha256: hash(bytes) };
      pages.push(receipt); console.log(JSON.stringify({ engine: label, ...receipt }));
    }
    report.runs.push({ label, engineRoot, count: store.size, storedSha256, writeMs, pages });
  } finally { store.close(); }
}
for (let index = 0; index < queries.length; index++) assert.equal(report.runs[0].pages[index].sha256, report.runs[1].pages[index].sha256, queries[index].label);
report.allPageResultsIdentical = true;
report.finishedAt = new Date().toISOString();
await writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ root, allPageResultsIdentical: true }));
