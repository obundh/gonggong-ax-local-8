import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, open, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { _electron } = createRequire(import.meta.url)(process.env.RECOVERY_PLAYWRIGHT_MODULE || 'playwright');
const evidenceRoot = process.env.RECOVERY_DEEP_RESUME_EVIDENCE || 'E:/RecoveryChat-DeepResume-0601-20260927/electron-resume';
const GIB = 1024 ** 3;

function makePdf(label) {
  return Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Label (${label}) >>\nendobj\n%%EOF\n`, 'ascii');
}

async function launch(workspace, imagePath, destination) {
  const application = await _electron.launch({
    executablePath: process.env.RECOVERY_PACKAGED_APP || path.join(root, 'node_modules/electron/dist/electron.exe'),
    args: process.env.RECOVERY_PACKAGED_APP ? [] : [root], env: { ...process.env, RECOVERY_WORKSPACE: workspace },
  });
  await application.evaluate(({ app, dialog }, input) => {
    const require = process.mainModule.require.bind(process.mainModule), path = require('node:path');
    const { RecoveryJobs } = require(path.join(app.isPackaged ? path.join(process.resourcesPath, 'app.asar.unpacked') : app.getAppPath(), 'engine/job-service.mjs'));
    RecoveryJobs.prototype.devices = async () => ({ devices: [] });
    const start = RecoveryJobs.prototype.start;
    RecoveryJobs.prototype.start = function (...args) { globalThis.__deepResumeService = this; return start.apply(this, args); };
    dialog.showOpenDialog = async (_window, options) => ({ canceled: false,
      filePaths: [options.properties.includes('openFile') ? input.imagePath : input.destination] });
  }, { imagePath, destination });
  const page = await application.firstWindow();
  page.setDefaultTimeout(30000);
  await page.getByText('데스크톱 연결됨', { exact: true }).waitFor();
  return { application, page };
}

async function waitForLatestJob(application, excludedId = null, timeout = 120000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const value = await application.evaluate((_electron, excluded) => {
      const service = globalThis.__deepResumeService;
      const job = service ? [...service.jobs.values()].at(-1) : null;
      if (!job || job.id === excluded || !['results', 'error', 'cancelled'].includes(job.status)) return null;
      return { id: job.id, status: job.status, complete: job.complete, outputPath: job.outputPath,
        coverage: job.coverage, candidates: [...job.candidates.values()].map(candidate => ({
          id: candidate.id, offset: candidate.offset, path: candidate.path, rootPath: candidate.rootPath,
        })) };
    }, excludedId).catch(() => null);
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Electron deep job did not finish');
}

test('Electron close and relaunch resumes a bounded image deep scan into a fresh output folder', { timeout: 240000 }, async () => {
  await mkdir(evidenceRoot, { recursive: true });
  const run = await mkdtemp(path.join(evidenceRoot, 'run-'));
  const workspace = path.join(run, 'workspace'), destination = path.join(run, 'output'), imagePath = path.join(run, 'two-pass.img');
  await mkdir(workspace); await mkdir(destination);
  const firstOffset = 256 * 1024 ** 2, secondOffset = 1280 * 1024 ** 2;
  const firstPdf = makePdf('first-pass'), secondPdf = makePdf('second-pass');
  const image = await open(imagePath, 'wx');
  try {
    await image.truncate(2 * GIB);
    await image.write(firstPdf, 0, firstPdf.length, firstOffset);
    await image.write(secondPdf, 0, secondPdf.length, secondOffset);
    await image.sync();
  } finally { await image.close(); }
  const before = await stat(imagePath, { bigint: true });

  const first = await launch(workspace, imagePath, destination);
  let firstJob;
  try {
    const options = first.page.locator('#search-options-details');
    if (!await options.evaluate(element => element.open)) await options.locator(':scope > summary').click();
    await first.page.locator('#program-image').click();
    await first.page.locator('[data-program-route="deep"]').click();
    await first.page.locator('#program-deep-limit').selectOption('small');
    await first.page.locator('#program-start').click();
    await first.page.waitForFunction(() => document.querySelector('#notice').textContent.includes('전체 범위')
      && document.querySelector('#activity-indicator').hidden);
    const failedJobId = await first.application.evaluate(() => [...globalThis.__deepResumeService.jobs.values()].at(-1)?.id);
    await first.page.locator('#go-deeper').click();
    firstJob = await waitForLatestJob(first.application, failedJobId);
    assert.equal(firstJob.complete, false);
    assert.equal(firstJob.coverage.stopReason, 'scan-byte-limit');
    assert.ok(firstJob.candidates.some(candidate => candidate.offset === firstOffset));
    assert.ok(!firstJob.candidates.some(candidate => candidate.offset === secondOffset));
  } finally { await first.application.close(); }

  const second = await launch(workspace, imagePath, destination);
  let resumed;
  try {
    await second.page.getByRole('button', { name: '도구 · 안내', exact: true }).click();
    await second.page.getByRole('button', { name: '이전 작업 기록', exact: true }).click();
    await second.page.locator('#dialog-content button.choice').first().click();
    assert.match(await second.page.locator('#notice').innerText(), /같은 이미지.*이전 복구 파일 위치.*이어/);
    const options = second.page.locator('#search-options-details');
    if (!await options.evaluate(element => element.open)) await options.locator(':scope > summary').click();
    assert.equal(await second.page.locator('#program-deep-limit').inputValue(), 'small');
    await second.page.locator('#program-deep-limit').selectOption('full');
    await second.page.locator('#program-start').click();
    resumed = await waitForLatestJob(second.application);
    assert.equal(resumed.status, 'results');
    assert.equal(resumed.complete, true);
    assert.equal(resumed.coverage.stopReason, 'end-of-ranges');
    assert.equal(resumed.coverage.unexaminedBytes, 0);
    assert.notEqual(resumed.outputPath, firstJob.outputPath);
    assert.equal(new Set(resumed.candidates.map(candidate => candidate.id)).size, resumed.candidates.length);
    const restored = resumed.candidates.find(candidate => candidate.offset === firstOffset);
    const later = resumed.candidates.find(candidate => candidate.offset === secondOffset);
    assert.ok(restored); assert.ok(later);
    assert.equal(restored.rootPath, firstJob.outputPath);
    assert.equal(later.rootPath, resumed.outputPath);
    assert.equal(restored.path, firstJob.candidates.find(candidate => candidate.offset === firstOffset).path);
    await second.page.locator('#scan-status').scrollIntoViewIfNeeded();
    await second.page.screenshot({ path: path.join(run, 'relaunch-resumed.png') });
  } finally { await second.application.close(); }

  const after = await stat(imagePath, { bigint: true });
  assert.equal(after.size, before.size); assert.equal(after.mtimeNs, before.mtimeNs);
  await writeFile(path.join(run, 'receipt.json'), JSON.stringify({ firstJob, resumed,
    appClosedBetweenPasses: true, sourceSizeAndMtimeUnchanged: true, realWorker: true,
    mocked: ['file pickers', 'device inventory'], packaged: Boolean(process.env.RECOVERY_PACKAGED_APP) }, null, 2));
});
