import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, open, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { _electron } = createRequire(import.meta.url)(process.env.RECOVERY_PLAYWRIGHT_MODULE || 'playwright');

test('real 1 GiB UI budget stops a 2 GiB image search and shows the unexamined half', { timeout: 180000 }, async () => {
  const evidence = process.env.RECOVERY_COVERAGE_EVIDENCE || 'E:/RecoveryChat-DeepCoverage-0512-20260926/desktop';
  await mkdir(evidence, { recursive: true });
  const run = await mkdtemp(path.join(evidence, 'run-'));
  const workspace = path.join(run, 'workspace'), destination = path.join(run, 'output'), imagePath = path.join(run, 'zero-range.img');
  await mkdir(workspace); await mkdir(destination);
  const file = await open(imagePath, 'wx');
  try { await file.truncate(2 * 1024 ** 3); await file.sync(); } finally { await file.close(); }
  const before = await stat(imagePath, { bigint: true });
  const application = await _electron.launch({
    executablePath: process.env.RECOVERY_PACKAGED_APP || path.join(root, 'node_modules/electron/dist/electron.exe'),
    args: process.env.RECOVERY_PACKAGED_APP ? [] : [root], env: { ...process.env, RECOVERY_WORKSPACE: workspace },
  });
  try {
    await application.evaluate(({ app, dialog }, input) => {
      const require = process.mainModule.require.bind(process.mainModule), path = require('node:path');
      const { RecoveryJobs } = require(path.join(app.isPackaged ? path.join(process.resourcesPath, 'app.asar.unpacked') : app.getAppPath(), 'engine/job-service.mjs'));
      RecoveryJobs.prototype.devices = async () => ({ devices: [] });
      const start = RecoveryJobs.prototype.start;
      RecoveryJobs.prototype.start = function (...args) { globalThis.__coverageService = this; return start.apply(this, args); };
      dialog.showOpenDialog = async (_window, options) => ({ canceled: false, filePaths: [options.properties.includes('openFile') ? input.imagePath : input.destination] });
    }, { imagePath, destination });
    const page = await application.firstWindow(), errors = [];
    page.on('pageerror', e => errors.push(e.message)); page.setDefaultTimeout(30000);
    await page.getByText('데스크톱 연결됨', { exact: true }).waitFor();
    const options = page.locator('#search-options-details');
    if (!await options.evaluate(e => e.open)) await options.locator(':scope > summary').click();
    await page.locator('#program-image').click();
    await page.locator('[data-program-route="deep"]').click();
    await page.locator('#program-deep-limit').selectOption('small');
    await page.locator('#program-start').click();
    // The blank raw image has no verified bitmap. The real product requires the
    // explicit whole-image choice; no scan scope/budget is changed by a mock.
    await page.waitForFunction(() => document.querySelector('#notice').textContent.includes('전체 범위')
      && document.querySelector('#activity-indicator').hidden);
    await page.locator('#go-deeper').click();
    await page.waitForFunction(() => document.querySelector('#scan-status').textContent.includes('설정한 검색량')
      && document.querySelector('#activity-indicator').hidden, undefined, { timeout: 120000 });
    const text = await page.locator('#scan-status').innerText();
    assert.match(text, /미검사/); assert.match(text, /일부 범위 확인 필요/);
    const percent = await page.locator('#scan-status progress').evaluate(e => e.value);
    assert.ok(percent > 49 && percent < 51, `actual progress ${percent}`);
    const receipt = await application.evaluate(async () => {
      const job = [...globalThis.__coverageService.jobs.values()].find(j => j.coverage?.strategy === 'carving');
      await job.persistTask;
      return { complete: job.complete, coverage: job.coverage, limits: job.deepLimits, outputPath: job.outputPath };
    });
    assert.equal(receipt.complete, false);
    assert.equal(receipt.coverage.stopReason, 'scan-byte-limit');
    assert.equal(receipt.coverage.scanReadBytes, 1024 ** 3);
    assert.equal(receipt.coverage.selectedBytes, 2 * 1024 ** 3);
    assert.deepEqual(receipt.limits, { maxScanBytes: 1024 ** 3, maxOutputBytes: 256 * 1024 ** 2 });
    assert.deepEqual(JSON.parse(await readFile(path.join(receipt.outputPath, 'job.json'), 'utf8')).coverage, receipt.coverage);
    const after = await stat(imagePath, { bigint: true });
    assert.equal(after.size, before.size); assert.equal(after.mtimeNs, before.mtimeNs);
    assert.deepEqual(errors, []);
    await page.locator('#scan-status').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(run, 'bounded-deep-search.png') });
    // Restoring history preserves the actual limits and now identifies the
    // verified image checkpoint as resumable without starting the second pass.
    await page.locator('#program-deep-limit').selectOption('full');
    await page.getByRole('button', { name: '도구 · 안내', exact: true }).click();
    await page.getByRole('button', { name: '이전 작업 기록', exact: true }).click();
    await page.locator('#dialog-content button.choice').first().click();
    assert.equal(await page.locator('#program-deep-limit').inputValue(), 'small');
    assert.match(await page.locator('#notice').innerText(), /같은 이미지.*이전 복구 파일 위치.*이어/);
    await writeFile(path.join(run, 'receipt.json'), JSON.stringify({ ...receipt, percent, text,
      packaged: Boolean(process.env.RECOVERY_PACKAGED_APP), realWorker: true, physicalDeletionTest: false,
      mocked: ['file pickers', 'device inventory'], inputSizeAndMtimeUnchanged: true }, null, 2));
  } finally { await application.close(); }
});
