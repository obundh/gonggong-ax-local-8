// Electron UI contract test with deterministic service responses. No raw-device IO.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { _electron } = createRequire(import.meta.url)(process.env.RECOVERY_PLAYWRIGHT_MODULE || 'playwright');

test('native candidates are selectable, prepared on preview, saved on request, and manually expanded', { timeout: 70_000 }, async () => {
  const evidenceRoot = 'E:/RecoveryChat-GUI-Integration-20260913';
  await mkdir(evidenceRoot, { recursive: true });
  const runRoot = await mkdtemp(path.join(evidenceRoot, 'desktop-'));
  const screenshots = path.join(root, 'output', 'playwright', 'native-integration');
  await mkdir(screenshots, { recursive: true });
  let application;
  try {
    application = await _electron.launch({ executablePath: process.env.RECOVERY_PACKAGED_APP || path.join(root, 'node_modules/electron/dist/electron.exe'),
      args: process.env.RECOVERY_PACKAGED_APP ? [] : [root], env: { ...process.env, RECOVERY_WORKSPACE: runRoot, TZ: 'Asia/Seoul' } });
    await application.evaluate(({ app, BrowserWindow, dialog }) => {
      const require = process.mainModule.require.bind(process.mainModule);
      const path = require('node:path');
      const engineRoot = app.isPackaged ? path.join(process.resourcesPath, 'app.asar.unpacked/engine') : path.join(app.getAppPath(), 'engine');
      const { RecoveryJobs } = require(path.join(engineRoot, 'job-service.mjs'));
      const fixture = globalThis.__nativeUI = { requests: [], previews: [], saves: [], destinations: 0, jobs: {} };
      const send = event => BrowserWindow.getAllWindows()[0].webContents.send('recovery-event', event);
      RecoveryJobs.prototype.devices = async () => ({ devices: [{ id: 'fixture-ntfs', label: '시험 장치 (C:)', kind: 'volume', ready: true, system: true, fileSystem: 'NTFS' }] });
      RecoveryJobs.prototype.start = async function(request) {
        const jobId = 'native-ui-' + (fixture.requests.length + 1), vacancy = request.deletedStrategy === 'vacancy', failed = fixture.failBinding;
        fixture.requests.push(request);
        const coverage = { strategy: vacancy ? 'mft-vacancy' : 'native-journal', requiresVacancyScan: !vacancy, requiresFullScan: !vacancy,
          deletedAfter: null, deletedBefore: null, partitions: [{ journalAvailable: true, journalComplete: true }] };
        fixture.jobs[jobId] = { status: 'scanning', coverage, items: [{ id: 'vol/ntfs:24:7', recordNumber: 24, name: '$RABC123.txt', size: 78,
          source: 'deleted-record', status: 'unverified', requiresPreparation: true, deletedAt: '2026-09-13T13:47:49Z',
          deletedAtSource: 'windows-usn', previousNameHints: ['회의자료.txt'], restorationName: { name: '회의자료.txt' }, nameMatch: { kind: 'unknown', score: 0 } }] };
        if(failed){fixture.jobs[jobId].items=[];coverage.partitions=[];}
        setTimeout(() => {
          send({ type: 'progress', jobId, stage: 'native-journal', stats: { eventsRead: 101, bytesRead: 4096 } });
          if(!failed)send({ type: 'candidate', jobId, candidate: fixture.jobs[jobId].items[0] });
        }, 100);
        setTimeout(() => { fixture.jobs[jobId].status = 'results'; send({ type: 'complete', jobId, coverage, complete: !failed,
          stats: { recordsRead: failed?0:1, recordsTotal: failed?0:1, candidatesFound: failed?0:1 },
          warnings: failed?[{code:'NATIVE_VOLUME_MISMATCH',message:'볼륨과 삭제 이력을 연결하지 못했어요.'}]:[] }); }, 750);
        return { jobId, coverage };
      };
      RecoveryJobs.prototype.candidates = function({ jobId, offset = 0, limit = 25 }) {
        const job = fixture.jobs[jobId];
        return { items: job.items.slice(offset, offset + limit), total: job.items.length, scannedTotal: job.items.length, status: job.status,
          coverage: job.coverage, complete: job.status === 'results', unknownDeletedTimeTotal: 0, matchCounts: { unknown: 1 } };
      };
      RecoveryJobs.prototype.preview = async function({ jobId, id }) {
        fixture.previews.push({ jobId, id });
        const candidate = fixture.jobs[jobId].items.find(item => item.id === id);
        candidate.status = 'readable';
        send({ type: 'candidate', jobId, candidate });
        return { type: 'text', text: '시험용 복구 문서 본문' };
      };
      RecoveryJobs.prototype.addDestination = async function() { fixture.destinations++; return { id: 'destination', label: '시험 저장 폴더' }; };
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: ['E:/fixture-output'] });
      RecoveryJobs.prototype.recover = async function(request) {
        fixture.saves.push(request);
        setTimeout(() => send({ type: 'recover-complete', jobId: request.jobId, results: [{ id: request.ids[0], name: '회의자료.txt', status: 'saved', path: 'fixture-output/result.txt',
          integrity: { status: 'verified' }, document: { status: 'preview-available', format: 'plain text', applicationOpenVerified: false },
          nameRecovery: { originalNameStatus: 'restored-from-history' }, originalIdentityVerified: false }] }), 60);
        return { jobId: request.jobId };
      };
    });
    const page = await application.firstWindow();
    page.setDefaultTimeout(12_000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.getByText('데스크톱 연결됨', { exact: true }).waitFor();
    await page.locator('#program-start').click();
    await page.waitForFunction(() => document.body.dataset.hasJob === 'true');
    assert.equal(await page.locator('[data-view-mode=chat]').isDisabled(), true);
    await page.waitForFunction(() => document.querySelector('article.candidate') && document.querySelector('#activity-indicator').hidden);
    const row = page.locator('article.candidate');
    assert.equal(await row.locator('input[type=checkbox]').isEnabled(), true);
    assert.match(await row.innerText(), /선택 시 확인/);
    assert.match(await row.innerText(), /복원할 이름: 회의자료.txt/);
    assert.equal(await page.locator('#search-vacant-records').isVisible(), true);
    assert.equal(await page.locator('#search-all-records').isHidden(), true);
    assert.equal(await application.evaluate(() => globalThis.__nativeUI.destinations), 0, 'discovery never asks for output');
    await page.screenshot({ path: path.join(screenshots, 'native-candidates.png') });
    await row.locator('.candidate-name').click();
    await page.locator('.preview-text').filter({ hasText: '시험용 복구 문서 본문' }).waitFor();
    assert.match(await row.innerText(), /읽을 수 있음/);
    assert.equal(await application.evaluate(() => globalThis.__nativeUI.previews.length), 1);
    assert.equal(await application.evaluate(() => globalThis.__nativeUI.destinations), 0, 'preview never asks for output');
    await page.locator('.preview-save').click();
    await page.waitForFunction(() => document.querySelector('#results-actions')?.textContent.includes('파일 저장 1개'));
    assert.match(await page.locator('.recovery-summary').innerText(), /문서 열림 확인 0개/);
    assert.equal(await application.evaluate(() => globalThis.__nativeUI.destinations), 1);
    assert.deepEqual(await application.evaluate(() => globalThis.__nativeUI.saves[0].ids), ['vol/ntfs:24:7']);
    assert.match(await page.locator('.recovery-result').innerText(), /원래 이름 복원/);
    assert.match(await page.locator('.recovery-result').innerText(), /내용 미리보기 확인/);
    await page.screenshot({ path: path.join(screenshots, 'native-preview-and-save.png') });
    const captured = JSON.parse(await readFile(new URL('./fixtures/mixed6-recovery-status.json', import.meta.url), 'utf8'));
    await application.evaluate(({ BrowserWindow }, results) => {
      BrowserWindow.getAllWindows()[0].webContents.send('recovery-event', { type: 'recover-complete',
        jobId: globalThis.__nativeUI.saves[0].jobId, results });
    }, captured.results);
    await page.waitForFunction(() => document.querySelector('.recovery-summary')?.textContent.includes('손상 자료 2개'));
    assert.match(await page.locator('.recovery-summary').innerText(), /파일 저장 2개 · 문서 열림 확인 0개 · 손상 자료 2개 · 미저장 3개/);
    assert.equal(await page.getByText('문서 손상 확인 · 손상 자료 저장', { exact: true }).count(), 2);
    assert.doesNotMatch(await page.locator('#results-actions').innerText(), /저장 완료|본문 저장 확인/);
    await page.locator('#results-actions').screenshot({ path: path.join(screenshots, 'stage1-corrupt-documents.png') });
    await application.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.send('recovery-event', { type: 'recover-complete', jobId: globalThis.__nativeUI.saves[0].jobId,
        results: [{ id: 'unverified-output', name: '확인실패.txt', status: 'failed', details: { savedPath: 'fixture-output/unverified.txt', outputUnverified: true } }] });
    });
    await page.getByText('파일 기록됨 · 저장 확인 실패', { exact: true }).waitFor();
    assert.match(await page.locator('.recovery-summary').innerText(), /파일 저장 1개.*미저장 0개/);
    assert.match(await page.locator('#results-actions').innerText(), /저장 파일 중 확인 실패 1개/);
    await application.evaluate(({ BrowserWindow }) => {
      const request=globalThis.__nativeUI.saves[0];
      BrowserWindow.getAllWindows()[0].webContents.send('recovery-event', { type:'recover-complete',jobId:request.jobId,
        results:[{id:request.ids[0],name:'가'.repeat(175)+'.docx',status:'saved',integrity:{status:'verified'},
          nameRecovery:{originalNameStatus:'restored-from-history',adjustedForFilesystem:true,name:'가'.repeat(190)+'.docx'},
          document:{status:'needs-check',reason:'DOCUMENT_PREVIEW_UNSUPPORTED'}}]});
    });
    await page.waitForFunction(()=>document.querySelector('.recovery-result')?.textContent.includes('원래 이름 일부 복원'));
    assert.match(await page.locator('.recovery-result').innerText(),/확인한 이름:/);
    assert.doesNotMatch(await page.locator('.recovery-result').innerText(),/원래 이름 복원 ·/);
    await page.locator('#search-vacant-records').click();
    await page.waitForFunction(() => document.querySelector('#period-search-note')?.textContent.includes('빈 기록 자리') && document.querySelector('#activity-indicator').hidden);
    const requests = await application.evaluate(() => globalThis.__nativeUI.requests);
    assert.equal(requests.length, 2, 'additional search only starts from explicit button');
    assert.equal(requests[0].deletedStrategy, 'auto');
    assert.equal(requests[0].filters.deletedAfter, null);
    assert.equal(requests[1].deletedStrategy, 'vacancy');
    assert.equal(requests[1].sourceId, requests[0].sourceId);
    assert.equal(requests[1].filters.includeUnknownDeletedAt, true);
    assert.equal(await page.locator('#search-vacant-records').isHidden(), true);
    await application.evaluate(() => { globalThis.__nativeUI.failBinding = true; });
    await page.locator('#search-period-again').click();
    await page.waitForFunction(() => document.querySelector('#candidate-list')?.textContent.includes('검증을 마친 파일 후보가 없어요') && document.querySelector('#activity-indicator').hidden);
    assert.equal(await page.locator('article.candidate').count(), 0);
    assert.match(await page.locator('#candidate-list').innerText(), /삭제 파일이 없다는 뜻은 아니에요/);
    assert.match(await page.locator('#transcript li').last().textContent(), /읽거나 검증하지 못한 범위/);
    assert.doesNotMatch(await page.locator('#transcript li').last().textContent(), /후보를 먼저 찾았어요/);
    assert.equal(await application.evaluate(() => globalThis.__nativeUI.requests.length), 3, 'binding failure never starts a fallback');
    await page.screenshot({ path: path.join(screenshots, 'native-binding-failure.png') });
    await application.evaluate(({ BrowserWindow }) => {
      const fixture = globalThis.__nativeUI, jobId = Object.keys(fixture.jobs).at(-1), job = fixture.jobs[jobId];
      job.items = Array.from({ length: 10005 }, (_, index) => ({ id: `bulk-${index}`, name: `후보-${index}.txt`, size: 100,
        source: 'deleted-record', status: 'unverified', requiresPreparation: true, recordNumber: index + 16, reasons: [] }));
      BrowserWindow.getAllWindows()[0].webContents.send('recovery-event', { type: 'complete', jobId,
        complete: true, warnings: [], coverage: job.coverage, stats: { candidatesFound: 10005 } });
    });
    await page.locator('#candidate-page').waitFor();
    assert.equal(await page.locator('article.candidate').count(), 25);
    await page.locator('#candidate-page').fill('401');
    await page.locator('#candidates-go').click();
    await page.locator('.candidate-name').filter({ hasText: '후보-10004.txt' }).waitFor();
    assert.equal(await page.locator('article.candidate').count(), 5, 'renderer retains the current page only');
    await page.locator('.candidate-name').filter({ hasText: '후보-10004.txt' }).dblclick();
    await page.waitForFunction(() => document.querySelector('.recovery-summary')?.textContent.includes('파일 저장 1개'));
    assert.deepEqual(await application.evaluate(() => globalThis.__nativeUI.saves.at(-1).ids), ['bulk-10004']);
    assert.deepEqual(errors, []);
  } finally { if (application) await application.close(); }
});
