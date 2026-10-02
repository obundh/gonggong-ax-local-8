import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { _electron } = createRequire(import.meta.url)(process.env.RECOVERY_PLAYWRIGHT_MODULE || 'playwright');

test('earlier discovery captures stay explicit in program and chat results, preview, save, provenance, and cancellation', { timeout: 90000 }, async () => {
  const evidence = process.env.RECOVERY_CAPTURE_CARRY_EVIDENCE || 'E:/RecoveryChat-CaptureCarry-0516-20260926/desktop';
  await mkdir(evidence, { recursive: true });
  const run = await mkdtemp(path.join(evidence, 'run-'));
  const application = await _electron.launch({ executablePath: process.env.RECOVERY_PACKAGED_APP || path.join(root, 'node_modules/electron/dist/electron.exe'),
    args: process.env.RECOVERY_PACKAGED_APP ? [] : [root], env: { ...process.env, RECOVERY_WORKSPACE: run } });
  try {
    await application.evaluate(({ app, BrowserWindow, dialog, shell }) => {
      const require = process.mainModule.require.bind(process.mainModule), path = require('node:path');
      const { RecoveryJobs } = require(path.join(app.isPackaged ? path.join(process.resourcesPath, 'app.asar.unpacked') : app.getAppPath(), 'engine/job-service.mjs'));
      const offer = { jobId: 'prior-capture-job', capturedAt: '2026-09-26T12:34:56.000Z', sha256: 'a'.repeat(64), size: 17,
        documentStatus: 'preview-available', originalIdentityVerified: false };
      const data = globalThis.__earlierCapture = { previews: [], recovers: [], resultFolders: [], exportedResults: [], cancels: [], pauses: [], resumes: [], destinationCancelled: false, failEarlierPreview: false, missingProvenance: false };
      const send = event => BrowserWindow.getAllWindows()[0].webContents.send('recovery-event', event);
      const candidate = { id: 'candidate-with-capture', name: '최근-보고서.txt', source: 'deleted-record', status: 'readable', size: 17,
        deletedAt: '2026-09-26T11:00:00.000Z', modifiedAt: '2026-09-26T10:00:00.000Z', earlierCapture: offer };
      const missing = { id: 'candidate-without-capture', name: '확보본-없음.txt', source: 'deleted-record', status: 'readable', size: 9,
        deletedAt: '2026-09-26T10:00:00.000Z', modifiedAt: '2026-09-26T09:00:00.000Z' };
      RecoveryJobs.prototype.devices = async () => ({ devices: [{ id: 'capture-fixture', label: '확보본 UI 시험 장치', kind: 'image', ready: true }] });
      RecoveryJobs.prototype.start = async () => { setTimeout(() => send({ type: 'complete', jobId: 'current-search-job', complete: true, warnings: [], stats: { candidatesFound: 2 } }), 30); return { jobId: 'current-search-job' }; };
      RecoveryJobs.prototype.candidates = async () => ({ items: [candidate, missing], total: 2, scannedTotal: 2, status: 'results', matchCounts: { none: 2 } });
      RecoveryJobs.prototype.preview = async request => {
        data.previews.push(request);
        if (request.earlierJobId && data.missingProvenance) return { type: 'text', text: 'unattested response' };
        if (request.earlierJobId && data.failEarlierPreview) throw new Error('prior capture unavailable');
        return request.earlierJobId ? { type: 'text', text: 'earlier captured text', earlierCapture: offer } : { type: 'text', text: 'normal current-source preview' };
      };
      RecoveryJobs.prototype.recover = async request => { data.recovers.push(request); return { jobId: 'prior-capture-job' }; };
      RecoveryJobs.prototype.resultPath = request => { data.resultFolders.push(request); return app.getPath('userData'); };
      RecoveryJobs.prototype.exportResults = async request => { data.exportedResults.push(request); return { path: 'E:/UI-FIXTURE/results.json' }; };
      shell.openPath = async () => ''; shell.showItemInFolder = () => {};
      RecoveryJobs.prototype.cancel = jobId => { data.cancels.push(jobId); return { cancelled: true }; };
      RecoveryJobs.prototype.pause = jobId => { data.pauses.push(jobId); return { paused: true }; };
      RecoveryJobs.prototype.resume = jobId => { data.resumes.push(jobId); return { resumed: true }; };
      RecoveryJobs.prototype.addDestination = async () => ({ id: 'capture-output', label: 'E:/capture-output' });
      dialog.showOpenDialog = async () => data.destinationCancelled ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [app.getPath('userData')] };
    });
    const page = await application.firstWindow(), errors = [];
    page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
    await page.getByText('데스크톱 연결됨', { exact: true }).waitFor();
    await page.locator('#program-start').click();
    await page.waitForFunction(() => document.querySelectorAll('article.candidate').length === 2 && document.querySelector('#activity-indicator').hidden);
    const row = page.locator('[data-candidate-id="candidate-with-capture"]');
    const missing = page.locator('[data-candidate-id="candidate-without-capture"]');
    assert.equal(await row.getByText('이전 확보본 보기', { exact: true }).count(), 1);
    assert.equal(await row.getByText('이전 확보본 저장', { exact: true }).count(), 1);
    assert.equal(await missing.getByText('이전 확보본 보기', { exact: true }).count(), 0);
    await row.getByText('정보 · 미리보기', { exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#preview-content').textContent.includes('normal current-source preview'));
    await row.getByText('이전 확보본 보기', { exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#preview-content').textContent.includes('이전 검색에서 보관한 본문이에요'));
    assert.match(await page.locator('#preview-content').innerText(), /2026/);
    await page.screenshot({ path: path.join(run, 'earlier-capture-preview.png') });
    let state = await application.evaluate(() => globalThis.__earlierCapture);
    assert.deepEqual(state.previews.map(request => ({ jobId: request.jobId, earlierJobId: request.earlierJobId ?? null })), [
      { jobId: 'current-search-job', earlierJobId: null }, { jobId: 'current-search-job', earlierJobId: 'prior-capture-job' }
    ]);
    await page.locator('button[data-view-mode="chat"]').click();
    await page.waitForFunction(() => document.body.dataset.viewMode === 'chat');
    assert.equal(await page.locator('[data-candidate-id="candidate-with-capture"]').getByText('이전 확보본 보기', { exact: true }).count(), 1);
    await page.locator('button[data-view-mode="program"]').click();
    await page.waitForFunction(() => document.body.dataset.viewMode === 'program');
    await application.evaluate(() => { globalThis.__earlierCapture.destinationCancelled = true; });
    await page.locator('[data-candidate-id="candidate-with-capture"]').getByText('이전 확보본 저장', { exact: true }).click();
    await page.waitForTimeout(100);
    state = await application.evaluate(() => globalThis.__earlierCapture);
    assert.equal(state.recovers.length, 0, 'cancelled folder picker must not recover');
    await application.evaluate(() => { globalThis.__earlierCapture.destinationCancelled = false; });
    await row.getByText('이전 확보본 저장', { exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#scan-status button')?.textContent.includes('일시 정지'));
    await page.locator('#scan-status').getByText('일시 정지', { exact: true }).click();
    await page.locator('#scan-status').getByText('이어하기', { exact: true }).click();
    await page.locator('#scan-status').getByText('검색 취소', { exact: true }).click();
    state = await application.evaluate(() => globalThis.__earlierCapture);
    assert.deepEqual(state.recovers.map(request => ({ jobId: request.jobId, earlierJobId: request.earlierJobId, ids: request.ids })), [
      { jobId: 'current-search-job', earlierJobId: 'prior-capture-job', ids: ['candidate-with-capture'] }
    ]);
    assert.deepEqual(state.pauses, ['prior-capture-job']); assert.deepEqual(state.resumes, ['prior-capture-job']); assert.deepEqual(state.cancels, ['prior-capture-job']);
    const failedEarlierSave = async () => {
      await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('recovery-event', {
        type: 'recover-complete', jobId: 'prior-capture-job', results: [{ id: 'candidate-with-capture', name: '최근-보고서.txt',
          status: 'failed', code: 'CAPTURE_CHANGED', error: 'prior capture changed' }] }));
      await page.getByText('미완료 항목 다시 시도', { exact: true }).waitFor();
    };
    for (const label of ['미완료 항목 다시 시도', '저장 위치 바꾸기']) {
      await failedEarlierSave();
      await page.getByText(label, { exact: true }).click();
      await page.waitForFunction(() => document.querySelector('#scan-status button')?.textContent.includes('일시 정지'));
      state = await application.evaluate(() => globalThis.__earlierCapture);
      assert.equal(state.recovers.at(-1).jobId, 'current-search-job');
      assert.equal(state.recovers.at(-1).earlierJobId, 'prior-capture-job', label + ' must retain the earlier-body choice');
    }
    assert.equal(state.recovers.length, 3);
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('recovery-event', { type: 'recover-complete', jobId: 'prior-capture-job', results: [{
      id: 'candidate-with-capture', name: '최근-보고서.txt', status: 'saved', path: 'E:/UI-FIXTURE/captured.txt', integrity: { status: 'verified' }, document: { status: 'preview-available' },
      originalIdentityVerified: false, preservation: { source: 'earlier-discovery-capture', sourceJobId: 'prior-capture-job', requestedFromJobId: 'current-search-job', capturedAt: '2026-09-26T12:34:56.000Z' }
    }] }));
    await page.locator('[data-result-id="candidate-with-capture"]').waitFor();
    assert.match(await page.locator('[data-result-id="candidate-with-capture"]').innerText(), /이전 검색에서 확보한 본문/);
    await page.screenshot({ path: path.join(run, 'earlier-capture-saved.png') });
    await page.getByText('결과 폴더 열기', { exact: true }).click();
    await page.getByText('결과 목록 저장', { exact: true }).click();
    state = await application.evaluate(() => globalThis.__earlierCapture);
    assert.deepEqual(state.resultFolders, [{ jobId: 'prior-capture-job' }]);
    assert.deepEqual(state.exportedResults, [{ jobId: 'prior-capture-job' }]);
    await page.getByText('도구 · 안내', { exact: true }).click();
    await page.getByText('현재 결과 목록 저장', { exact: true }).click();
    state = await application.evaluate(() => globalThis.__earlierCapture);
    assert.deepEqual(state.exportedResults, [{ jobId: 'prior-capture-job' }, { jobId: 'prior-capture-job' }]);
    await application.evaluate(() => { globalThis.__earlierCapture.missingProvenance = true; });
    await row.getByText('이전 확보본 보기', { exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#preview-content').textContent.includes('이전 확보본의 확인 정보를 받지 못했어요'));
    assert.doesNotMatch(await page.locator('#preview-content').innerText(), /unattested response/);
    await application.evaluate(() => { globalThis.__earlierCapture.missingProvenance = false; globalThis.__earlierCapture.failEarlierPreview = true; });
    await row.getByText('이전 확보본 보기', { exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#preview-content').textContent.includes('미리보기를 불러오지 못했어요'));
    state = await application.evaluate(() => globalThis.__earlierCapture);
    assert.equal(state.previews.at(-1).earlierJobId, 'prior-capture-job');
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(run, 'earlier-capture-provenance.png') });
    await writeFile(path.join(run, 'receipt.json'), JSON.stringify({ status: 'passed', packaged: Boolean(process.env.RECOVERY_PACKAGED_APP),
      guiServiceSynthetic: true, physicalScan: false, programAndChatButtons: true, normalPreviewUnaffected: true, earlierPayloadBound: true,
      cancelledDestinationDidNotRecover: true, provenanceShown: true, sourceErrorDidNotFallback: true, cancellationTargetedPriorJob: true, retriesPreservedEarlierSource: true, resultActionsTargetedPriorJob: true }, null, 2));
  } finally { await application.close(); }
});
