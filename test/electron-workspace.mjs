import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { _electron } = createRequire(import.meta.url)(process.env.RECOVERY_PLAYWRIGHT_MODULE || 'playwright');
const openDetails = async (page, selector) => { const details = page.locator(selector); if (!await details.evaluate(element => element.open)) await details.locator(':scope > summary').click(); };

test('workspace exposes checklist and truthful incomplete, saved, damaged and original states over IPC', { timeout: 90000 }, async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'recovery-workspace-ui-'));
  const output = path.join(process.env.RECOVERY_STAGE2_EVIDENCE || 'E:\\RecoveryChat-Stage2-20260920', 'desktop', 'workspace'); await mkdir(output, { recursive: true });
  const app = await _electron.launch({ executablePath: process.env.RECOVERY_PACKAGED_APP || path.join(root, 'node_modules/electron/dist/electron.exe'), args: process.env.RECOVERY_PACKAGED_APP ? [] : [root], env: { ...process.env, RECOVERY_WORKSPACE: workspace } });
  const errors = [];
  try {
    await app.evaluate(({ app }) => {
      const require = process.mainModule.require.bind(process.mainModule), path = require('node:path');
      const { RecoveryJobs } = require(path.join(app.isPackaged ? path.join(process.resourcesPath, 'app.asar.unpacked') : app.getAppPath(), 'engine/job-service.mjs'));
      // UI-state fixtures only. No physical source is opened or scanned by this test.
      RecoveryJobs.prototype.devices = async () => ({ devices: [{ id: 'ui-fixture', label: '상태 검증용 이미지', kind: 'image', ready: true, system: true }] });
      RecoveryJobs.prototype.start = async () => ({ jobId: 'ui-workspace-job' });
      RecoveryJobs.prototype.candidates = async () => ({ items: [], total: 0, scannedTotal: 0 });
    });
    const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(10000);
    await page.getByText('데스크톱 연결됨', { exact: true }).waitFor();
    await openDetails(page, '#journey-details');
    assert.equal(await page.locator('#journey-details').evaluate(element => element.open), true);
    await page.locator('#journey-steps .journey-step').last().waitFor();
    assert.equal(await page.locator('#session-found').innerText(), '—');
    await page.locator('#roadmap-nav').click();
    assert.equal(await page.locator('[data-checklist-stage]').count(), 10);
    assert.match(await page.locator('#roadmap-summary').innerText(), /21.*54/s);
    await page.locator('[data-checklist-stage="10"]').click();
    assert.equal(await page.locator('#roadmap-detail .checklist-items>li').count(), 6);
    assert.match(await page.locator('#roadmap-detail').innerText(), /조건부 연구/);
    await page.locator('[data-checklist-stage="1"]').click();
    await page.locator('#roadmap-detail details').nth(3).locator('summary').click();
    assert.match(await page.locator('#roadmap-detail').innerText(), /JOURNAL_READ_FAILED/);
    await page.locator('#back-to-workspace').click();
    await page.locator('#program-start').click();
    await page.waitForFunction(() => document.body.dataset.hasJob === 'true');
    await openDetails(page, '#job-details');
    assert.equal(await page.locator('button[data-view-mode="chat"]').isDisabled(), true);
    const emit = event => app.evaluate(({ BrowserWindow }, fixtureEvent) => BrowserWindow.getAllWindows()[0].webContents.send('recovery-event', fixtureEvent), { jobId: 'ui-workspace-job', ...event });
    await emit({ type: 'progress', stage: 'native-journal', stats: { eventsRead: 7, candidatesFound: 0 } });
    await page.waitForFunction(() => document.querySelector('[data-journey="records"]').dataset.state === 'running');
    await page.locator('#roadmap-nav').click();
    await page.locator('#back-to-workspace').click();
    assert.equal(await page.locator('button[data-view-mode="chat"]').isDisabled(), true);
    await emit({ type: 'complete', complete: false, stats: { candidatesFound: 0 }, warnings: [{ code: 'JOURNAL_READ_FAILED', message: '시험용 읽기 실패' }] });
    await page.waitForFunction(() => document.querySelector('[data-journey="records"]').dataset.state === 'attention');
    assert.equal(await page.locator('[data-journey="deep"]').getAttribute('data-state'), 'waiting');
    assert.equal(await page.locator('#session-saved').innerText(), '—');
    await page.screenshot({ path: path.join(output, '07-fixture-incomplete.png') });
    await emit({ type: 'recover-progress', stage: 'recover', stats: { filesProcessed: 0, filesTotal: 2 } });
    await emit({ type: 'recover-complete', results: [
      { id: 'damaged', name: '검증용-손상.pdf', status: 'saved', path: 'E:/UI-FIXTURE-NOT-A-REAL-OUTPUT/damaged.pdf', integrity: { status: 'verified' }, document: { status: 'damaged' } },
      { id: 'preview', name: '검증용-이미지.png', status: 'saved', path: 'E:/UI-FIXTURE-NOT-A-REAL-OUTPUT/preview.png', integrity: { status: 'verified' }, document: { status: 'preview-available' } },
    ] });
    await page.waitForFunction(() => document.querySelector('#session-saved').textContent === '2');
    assert.equal(await page.locator('#session-verified').innerText(), '0');
    assert.equal(await page.locator('[data-journey="content"]').getAttribute('data-state'), 'attention');
    assert.match(await page.locator('#session-context').innerText(), /손상 1개/);
    await page.screenshot({ path: path.join(output, '08-fixture-result.png') });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await page.locator('[data-journey="records"] .step-number').evaluate(el => getComputedStyle(el).animationName), 'none');
    await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.setSize(390, 844); win.webContents.setZoomFactor(2); });
    await page.locator('#roadmap-nav').click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1));
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => ({ tag: document.activeElement.tagName, outline: getComputedStyle(document.activeElement).outlineStyle }));
    assert.equal(focused.tag, 'BUTTON'); assert.notEqual(focused.outline, 'none');
    assert.deepEqual(errors, []);
  } finally { await app.close(); }
});

