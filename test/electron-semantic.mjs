import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const runtimeModules = 'C:\\Users\\USER\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\node\\node_modules';
const packagedApp = process.env.RECOVERY_SEMANTIC_PACKAGED_APP || process.env.RECOVERY_PACKAGED_FINAL_APP;
const executableReady = Boolean(packagedApp && path.isAbsolute(packagedApp));

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function workingSetKiB(metrics) {
  return metrics.reduce((sum, item) => sum + (Number(item.memory?.workingSetSize) || 0), 0);
}

test('packaged Electron runs multilingual filename semantics through renderer IPC and the worker', {
  skip: executableReady ? false : 'Set RECOVERY_SEMANTIC_PACKAGED_APP after staging the optional AI pack beside the packaged executable.',
  timeout: 360_000,
}, async () => {
  const requireFromRuntime = createRequire(path.join(runtimeModules, 'playwright', 'package.json'));
  const { _electron } = requireFromRuntime('playwright');
  const temporaryRoot = path.resolve(os.tmpdir());
  const runRoot = await mkdtemp(path.join(temporaryRoot, 'recovery-electron-semantic-'));
  const workspace = path.join(runRoot, 'workspace');
  const sourceDirectory = path.join(runRoot, 'source');
  await Promise.all([mkdir(workspace), mkdir(sourceDirectory)]);
  const fixtures = [
    ['연간 재무 보고서.xlsx', 'synthetic Korean annual financial report'],
    ['오늘의 날씨 사진.jpg', 'synthetic weather image placeholder'],
    ['회의 일정 메모.txt', 'synthetic meeting schedule note'],
  ];
  for (const [name, content] of fixtures) await writeFile(path.join(sourceDirectory, name), content);
  const sourceHashes = new Map(await Promise.all(fixtures.map(async ([name]) => [name, sha256(await readFile(path.join(sourceDirectory, name)))])));
  let electronApp;
  try {
    electronApp = await _electron.launch({
      executablePath: packagedApp,
      args: [],
      env: { ...process.env, RECOVERY_WORKSPACE: workspace },
    });
    await electronApp.evaluate(({ dialog }, selectedSource) => {
      dialog.showOpenDialog = async (_window, options) => {
        if (!options.properties.includes('openDirectory')) throw new Error('This smoke test only permits its generated source folder.');
        return { canceled: false, filePaths: [selectedSource] };
      };
    }, sourceDirectory);
    const page = await electronApp.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.getByText('데스크톱 연결됨', { exact: true }).waitFor({ state: 'visible' });

    const scan = await page.evaluate(async () => {
      const events = [];
      const stop = window.recoveryAPI.onEvent(event => events.push(event));
      try {
        const source = await window.recoveryAPI.chooseSource('folder');
        const started = await window.recoveryAPI.start({
          sourceId: source.id,
          mode: 'copies',
          filters: {},
          notifications: { mode: 'complete' },
        });
        const deadline = Date.now() + 30_000;
        let listing;
        do {
          listing = await window.recoveryAPI.candidates({ jobId: started.jobId, offset: 0, limit: 100, filters: {} });
          if (listing.status === 'results') break;
          await new Promise(resolve => setTimeout(resolve, 50));
        } while (Date.now() < deadline);
        return { source, started, listing, events };
      } finally { stop(); }
    });
    assert.equal(scan.source.kind, 'folder');
    assert.equal(scan.listing.status, 'results', `folder scan did not complete: ${JSON.stringify(scan.listing)}`);
    assert.equal(scan.listing.complete, true);
    assert.equal(scan.listing.total, 3);
    assert.ok(scan.events.some(event => event.type === 'candidate'), 'candidate events should cross the worker/main/renderer bridge');
    assert.ok(scan.events.some(event => event.type === 'complete'), 'the completion event should cross the worker/main/renderer bridge');
    assert.ok(scan.listing.items.every(candidate => candidate.source === 'existing-file'));

    const status = await page.evaluate(() => window.recoveryAPI.semanticStatus());
    assert.deepEqual({ available: status.available, runtimeAvailable: status.runtimeAvailable, modelAvailable: status.modelAvailable }, {
      available: true,
      runtimeAvailable: true,
      modelAvailable: true,
    }, `optional AI pack is not ready beside the executable: ${JSON.stringify(status)}`);

    const metricsBefore = await electronApp.evaluate(({ app }) => app.getAppMetrics());
    const semanticStarted = Date.now();
    const semantic = await page.evaluate(jobId => window.recoveryAPI.semantic({ jobId, query: 'annual financial report' }), scan.started.jobId);
    const semanticElapsedMs = Date.now() - semanticStarted;
    assert.equal(semantic.ranked, 3);
    const ranked = await page.evaluate(jobId => window.recoveryAPI.candidates({
      jobId,
      offset: 0,
      limit: 100,
      filters: {},
      sort: 'semantic-desc',
    }), scan.started.jobId);
    const names = ranked.items.map(candidate => candidate.name);
    const koreanFinancial = ranked.items.find(candidate => candidate.name === '연간 재무 보고서.xlsx');
    const weather = ranked.items.find(candidate => candidate.name === '오늘의 날씨 사진.jpg');
    assert.ok(koreanFinancial && weather, `expected generated fixtures in ranked candidates: ${JSON.stringify(names)}`);
    assert.ok(Number.isFinite(koreanFinancial.semanticScore));
    assert.ok(Number.isFinite(weather.semanticScore));
    assert.ok(names.indexOf(koreanFinancial.name) < names.indexOf(weather.name), `Korean financial filename should rank above weather: ${JSON.stringify(ranked.items)}`);
    assert.ok(koreanFinancial.semanticScore > weather.semanticScore, `expected a higher semantic score: ${JSON.stringify(ranked.items)}`);
    assert.ok(koreanFinancial.semanticReasons.includes('filenameSemanticSimilarity:local-multilingual-embedding'));

    const metricsAfter = await electronApp.evaluate(({ app }) => app.getAppMetrics());
    const observation = {
      semanticElapsedMs,
      semanticScores: ranked.items.map(candidate => ({ name: candidate.name, score: candidate.semanticScore })),
      processCountBefore: metricsBefore.length,
      processCountAfter: metricsAfter.length,
      workingSetBeforeKiB: workingSetKiB(metricsBefore),
      workingSetAfterKiB: workingSetKiB(metricsAfter),
      note: 'Single packaged Electron observation; not a cross-PC performance guarantee.',
    };
    process.stdout.write(`Packaged semantic observation: ${JSON.stringify(observation)}\n`);

    for (const [name, expected] of sourceHashes) {
      assert.equal(sha256(await readFile(path.join(sourceDirectory, name))), expected, `source fixture changed: ${name}`);
    }
  } finally {
    await electronApp?.close().catch(() => {});
    const relative = path.relative(temporaryRoot, runRoot);
    assert.ok(relative.startsWith('recovery-electron-semantic-') && !relative.includes(path.sep) && !path.isAbsolute(relative));
    await rm(runRoot, { recursive: true, force: true });
  }
});
