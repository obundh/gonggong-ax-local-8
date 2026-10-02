// Bounded, fixture-only capacity check. It neither enumerates nor reads source disks.
import { mkdir, mkdtemp, readdir, stat, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const args = process.argv.slice(2);
const option = key => {
  const at = args.indexOf(key);
  if (at < 0 || !args[at + 1] || args[at + 1].startsWith('--')) throw new Error(`${key} is required`);
  return path.resolve(args[at + 1]);
};

const output = option('--output');
const engineRoot = path.resolve(option('--engine'));
const BUDGETS = Object.freeze({
  acceptedCandidates: 100000,
  overflowCandidates: 10000,
  batchSize: 256,
  firstPageMs: 1000,
  tailPageMs: 1000,
  importMs: 60000,
  eventLoopBlockMs: 60000,
  processRssMiB: 512,
  outputMiB: 256,
  firstAndTailPageSize: 20
});

const mib = bytes => Math.round((bytes / 1024 / 1024) * 100) / 100;
const nowRss = () => process.memoryUsage().rss;
const rounded = value => Math.round(value * 100) / 100;
const syntheticCandidate = index => ({
  id: `fixture-${String(index).padStart(6, '0')}`,
  source: 'fixture-only-resource-budget',
  name: `synthetic-candidate-${String(index).padStart(6, '0')}.txt`,
  originalPath: `X:\\fixture-only\\candidate-${String(index).padStart(6, '0')}.txt`,
  size: 1024 + (index % 4096),
  modifiedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index % 60)).toISOString(),
  deletedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + index * 1000).toISOString(),
  score: index % 101,
  semanticScore: index % 101,
  kind: 'document',
  status: 'fixture-only',
  hasContent: false,
  bodyAssociation: 'not-asserted'
});

async function delayProbe(work) {
  const expectedDelayMs = 25;
  const scheduledAt = performance.now();
  let firedAt = null;
  const timer = new Promise(resolve => setTimeout(() => { firedAt = performance.now(); resolve(); }, expectedDelayMs));
  const result = work();
  await timer;
  return { result, elapsedMs: performance.now() - scheduledAt, eventLoopBlockMs: Math.max(0, firedAt - scheduledAt - expectedDelayMs) };
}

async function directoryBytes(root) {
  const entries = await readdir(root, { withFileTypes: true });
  let bytes = 0;
  for (const entry of entries) {
    const item = path.join(root, entry.name);
    if (entry.isDirectory()) bytes += await directoryBytes(item);
    else if (entry.isFile()) bytes += (await stat(item)).size;
  }
  return bytes;
}

await mkdir(output, { recursive: true });
const root = await mkdtemp(path.join(output, 'resource-budget-'));
const preset = {
  status: 'preset-before-run',
  createdAt: new Date().toISOString(),
  engineRoot,
  source: 'Generated deterministic fixture candidates in this process. No source disk, user path, or private file is opened.',
  budgets: BUDGETS,
  rationale: {
    firstAndTailPage: 'A 20-row list page should return within one second at the 100,000 accepted-candidate cap.',
    import: 'One bounded fixture import may take up to 60 seconds; this is an engine/store budget, not a promise for a real disk scan.',
    memory: '512 MiB per Node process is a guardrail for an 8 GiB worker allocation, even though this host has more RAM.',
    output: '256 MiB reserves capacity for the synthetic SQLite store and receipts; it is not a recovery-image or user-data estimate.',
    block: 'The synchronous import must not block this Node event loop for more than the same 60-second bounded import window.'
  }
};
await writeFile(path.join(root, 'budget-preset.json'), JSON.stringify(preset, null, 2), { flag: 'wx' });

const { openCandidateStore } = await import(pathToFileURL(path.join(engineRoot, 'candidate-store.mjs')).href);
const store = openCandidateStore(path.join(root, 'fixture-candidates.sqlite'));
let maxRssBytes = nowRss();
const captureRss = () => { maxRssBytes = Math.max(maxRssBytes, nowRss()); };
const outcome = { root, startedAt: new Date().toISOString(), fixtureOnly: true,
  runtime: { node: process.version, execArgv: process.execArgv }, budgets: BUDGETS, measurements: {}, checks: {}, failures: [] };

try {
  const importProbe = await delayProbe(() => {
    let imported = 0;
    let skipped = 0;
    for (let start = 0; start < BUDGETS.acceptedCandidates + BUDGETS.overflowCandidates; start += BUDGETS.batchSize) {
      const end = Math.min(start + BUDGETS.batchSize, BUDGETS.acceptedCandidates + BUDGETS.overflowCandidates);
      const batch = Array.from({ length: end - start }, (_, offset) => syntheticCandidate(start + offset));
      const receipt = store.setBatch(batch);
      imported += receipt.imported;
      skipped += receipt.skippedByLimit;
      captureRss();
    }
    return { imported, skipped, stored: store.size };
  });
  outcome.measurements.import = { elapsedMs: rounded(importProbe.elapsedMs), eventLoopBlockMs: rounded(importProbe.eventLoopBlockMs), ...importProbe.result };

  const first = await delayProbe(() => store.page({ offset: 0, limit: BUDGETS.firstAndTailPageSize, sort: 'deleted-desc' }));
  const tailOffset = BUDGETS.acceptedCandidates - BUDGETS.firstAndTailPageSize;
  const tail = await delayProbe(() => store.page({ offset: tailOffset, limit: BUDGETS.firstAndTailPageSize, sort: 'deleted-desc' }));
  captureRss();
  const expectedFirstIds = Array.from({ length: BUDGETS.firstAndTailPageSize }, (_, index) => syntheticCandidate(BUDGETS.acceptedCandidates - 1 - index).id);
  const expectedTailIds = Array.from({ length: BUDGETS.firstAndTailPageSize }, (_, index) => syntheticCandidate(BUDGETS.firstAndTailPageSize - 1 - index).id);
  assert.deepEqual(first.result.items.map(item => item.id), expectedFirstIds, 'first page omitted or reordered a candidate');
  assert.deepEqual(tail.result.items.map(item => item.id), expectedTailIds, 'tail page omitted or reordered a candidate');
  assert.equal(first.result.total, BUDGETS.acceptedCandidates);
  assert.equal(tail.result.total, BUDGETS.acceptedCandidates);
  assert.equal(tail.result.hasMore, false);
  outcome.measurements.firstPage = { elapsedMs: rounded(first.elapsedMs), eventLoopBlockMs: rounded(first.eventLoopBlockMs), total: first.result.total, returned: first.result.items.length, firstId: first.result.items[0].id };
  outcome.measurements.tailPage = { elapsedMs: rounded(tail.elapsedMs), eventLoopBlockMs: rounded(tail.eventLoopBlockMs), offset: tailOffset, total: tail.result.total, returned: tail.result.items.length, firstId: tail.result.items[0].id, lastId: tail.result.items.at(-1).id };
  outcome.checks = {
    acceptedCount: outcome.measurements.import.imported === BUDGETS.acceptedCandidates && outcome.measurements.import.stored === BUDGETS.acceptedCandidates,
    rejectedOverflow: outcome.measurements.import.skipped === BUDGETS.overflowCandidates,
    firstPageCorrect: true,
    tailPageCorrect: true,
    noTailOmission: tail.result.items.length === BUDGETS.firstAndTailPageSize && tail.result.hasMore === false
  };
} catch (error) {
  outcome.failures.push({ name: error.name, message: error.message, stack: error.stack });
} finally {
  store.close();
}

outcome.measurements.maxRssMiB = mib(maxRssBytes);
outcome.measurements.outputMiB = mib(await directoryBytes(root));
outcome.finishedAt = new Date().toISOString();
outcome.budgetResults = {
  import: outcome.measurements.import?.elapsedMs <= BUDGETS.importMs,
  eventLoopBlock: outcome.measurements.import?.eventLoopBlockMs <= BUDGETS.eventLoopBlockMs,
  firstPage: outcome.measurements.firstPage?.elapsedMs <= BUDGETS.firstPageMs,
  tailPage: outcome.measurements.tailPage?.elapsedMs <= BUDGETS.tailPageMs,
  rss: outcome.measurements.maxRssMiB <= BUDGETS.processRssMiB,
  output: outcome.measurements.outputMiB <= BUDGETS.outputMiB,
  correctness: Object.values(outcome.checks).every(Boolean) && outcome.failures.length === 0
};
outcome.status = Object.values(outcome.budgetResults).every(Boolean) ? 'passed-with-fixture-only-limitations' : 'failed-see-bottleneck';
await writeFile(path.join(root, 'result.json'), JSON.stringify(outcome, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ root, status: outcome.status, budgetResults: outcome.budgetResults, measurements: outcome.measurements }));
if (outcome.status !== 'passed-with-fixture-only-limitations') process.exitCode = 1;
