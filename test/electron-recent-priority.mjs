import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { _electron } = createRequire(import.meta.url)(process.env.RECOVERY_PLAYWRIGHT_MODULE || 'playwright');

test('priority progress is explained in Korean and remains busy until the complete vacancy pass ends', { timeout: 90000 }, async () => {
  const evidence = process.env.RECOVERY_PRIORITY_EVIDENCE || 'E:/RecoveryChat-RecentPriority-0513-20260926/desktop';
  await mkdir(evidence, { recursive: true });
  const run = await mkdtemp(path.join(evidence, 'run-'));
  const application = await _electron.launch({ executablePath: process.env.RECOVERY_PACKAGED_APP || path.join(root, 'node_modules/electron/dist/electron.exe'),
    args: process.env.RECOVERY_PACKAGED_APP ? [] : [root], env: { ...process.env, RECOVERY_WORKSPACE: run } });
  try {
    await application.evaluate(({ app }) => {
      const require = process.mainModule.require.bind(process.mainModule), path = require('node:path');
      const { RecoveryJobs } = require(path.join(app.isPackaged ? path.join(process.resourcesPath, 'app.asar.unpacked') : app.getAppPath(), 'engine/job-service.mjs'));
      // UI event fixture only. The engine comparison is a separate fixed-image test.
      RecoveryJobs.prototype.devices = async () => ({ devices: [{ id: 'priority-fixture', label: '화면 시험용 장치', kind: 'image', ready: true }] });
      RecoveryJobs.prototype.start = async () => ({ jobId: 'priority-ui-job', coverage: { strategy: 'mft-vacancy' } });
      RecoveryJobs.prototype.candidates = async () => ({ items: [], total: 0, scannedTotal: 0 });
    });
    const page = await application.firstWindow(), errors = [];
    page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message));
    await page.getByText('데스크톱 연결됨', { exact: true }).waitFor();
    await page.locator('#program-start').click();
    await page.waitForFunction(() => document.body.dataset.hasJob === 'true');
    const details = page.locator('#job-details');
    if (!await details.evaluate(e => e.open)) await details.locator(':scope > summary').click();
    const emit = event => application.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0].webContents.send('recovery-event', value),
      { jobId: 'priority-ui-job', ...event });
    await emit({ type: 'progress', stage: 'recent-priority', stats: { recordsRead: 2, recordsTotal: 64 } });
    await page.waitForFunction(() => document.querySelector('#scan-status').textContent.includes('최근 삭제된 파일 본문 먼저 확보 중'));
    assert.equal(await page.locator('button[data-view-mode="chat"]').isDisabled(), true);
    assert.doesNotMatch(await page.locator('#scan-status').innerText(), /recent-priority/);
    await page.screenshot({ path: path.join(run, 'recent-priority.png') });
    await emit({ type: 'progress', stage: 'scan', stats: { slotsVisited: 100, selectedSlots: 240 } });
    assert.equal(await page.locator('button[data-view-mode="chat"]').isDisabled(), true);
    await emit({ type: 'complete', complete: false, stats: { candidatesFound: 0 }, warnings: [{ code: 'USN_RETAINED_RANGE_LIMIT', message: '이전 기록은 남아 있지 않을 수 있어요.' }] });
    await page.waitForFunction(() => !document.querySelector('button[data-view-mode="chat"]').disabled);
    assert.deepEqual(errors, []);
    await writeFile(path.join(run, 'receipt.json'), JSON.stringify({ status: 'passed', packaged: Boolean(process.env.RECOVERY_PACKAGED_APP),
      guiEventsMocked: true, physicalScan: false, translatedProgress: true, busyThroughVacancy: true }, null, 2));
  } finally { await application.close(); }
});
