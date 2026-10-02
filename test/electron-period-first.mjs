import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createFixture } from './ntfs-fixtures.mjs';
import { createUsnFixture, journalRecords, usnRecord } from './usn-fixture.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { _electron } = createRequire(import.meta.url)(process.env.RECOVERY_PLAYWRIGHT_MODULE || 'playwright');
const desktopOutput = 'E:\\RecoveryChat-Stage2-20260920\\desktop';
const twoDayJournal = () => journalRecords([
  usnRecord({ deletedAt: '2026-09-13T02:00:00.000Z', recordNumber: 25, sequence: 3, name: 'contiguous.bin' }),
  usnRecord({ deletedAt: '2026-09-12T10:00:00.000Z', recordNumber: 24, sequence: 6, name: '삭제된-문서.txt' })
], 8 * 4096);

async function waitForCandidateNames(page, names) {
  await page.waitForFunction(expected => {
    const actual = [...document.querySelectorAll('article.candidate .candidate-name')].map(element => element.textContent);
    return actual.length === expected.length && actual.every((name, index) => name === expected[index])
      && document.querySelector('#activity-indicator')?.hidden;
  }, names);
}

async function openDetails(page, selector) {
  const details = page.locator(selector);
  if (!await details.evaluate(element => element.open)) await details.locator(':scope > summary').click();
}

async function closeOwnedElectron(application) {
  if (!application) return;
  const child = application.process();
  const closed = await Promise.race([
    application.close().then(() => true, () => true),
    new Promise(resolve => setTimeout(() => resolve(false), 3_000))
  ]);
  if (!closed && child.exitCode === null) child.kill();
  if (child.exitCode === null) await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 3_000))]);
}

test('Electron period-first search re-queries the current image and exposes manual full-record fallback', { timeout: 90_000 }, async () => {
  const runRoot = await mkdtemp(path.join(os.tmpdir(), 'recovery-electron-period-'));
  const workspace = path.join(runRoot, 'workspace');
  const destination = path.join(runRoot, 'destination');
  await Promise.all([mkdir(workspace), mkdir(destination)]);
  const screenshotDirectory = path.join(desktopOutput, 'period-first');
  await mkdir(screenshotDirectory, { recursive: true });
  const journalFixture = await createUsnFixture(path.join(runRoot, 'journal-fixture'), { journalBytes: twoDayJournal() });
  const executablePath = process.env.RECOVERY_PACKAGED_APP || path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
  let app;
  try {
    app = await _electron.launch({
      executablePath,
      args: process.env.RECOVERY_PACKAGED_APP ? [] : [projectRoot],
      env: { ...process.env, RECOVERY_WORKSPACE: workspace, TZ: 'Asia/Seoul' }
    });
    const page = await app.firstWindow();
    page.setDefaultTimeout(15_000);
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.getByText('데스크톱 연결됨', { exact: true }).waitFor();

    await app.evaluate(({ app, BrowserWindow, dialog }, fixture) => {
      const require = process.mainModule.require.bind(process.mainModule);
      const path = require('node:path');
      const engine = app.isPackaged
        ? path.join(process.resourcesPath, 'app.asar.unpacked', 'engine')
        : path.join(app.getAppPath(), 'engine');
      const { RecoveryJobs } = require(path.join(engine, 'job-service.mjs'));
      const originalStart = RecoveryJobs.prototype.start;
      globalThis.__periodTest = { image: fixture.image, destination: fixture.destination, requests: [], events: [] };
      RecoveryJobs.prototype.start = async function periodTestStart(request) {
        globalThis.__periodTest.requests.push({ ...request, filters: { ...(request.filters || {}) } });
        return originalStart.call(this, request);
      };
      dialog.showOpenDialog = async (_window, options) => ({
        canceled: false,
        filePaths: options?.properties?.includes('openFile')
          ? [globalThis.__periodTest.image]
          : [globalThis.__periodTest.destination]
      });
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      const originalSend = contents.send.bind(contents);
      contents.send = (channel, ...args) => {
        if (channel === 'recovery-event') globalThis.__periodTest.events.push(args[0]);
        return originalSend(channel, ...args);
      };
    }, { image: journalFixture.imagePath, destination });

    assert.equal(await page.locator('body').getAttribute('data-view-mode'), 'program');
    await page.locator('button[data-view-mode=chat]').click();
    await page.getByRole('button', { name: /^직접 지웠어요/ }).click();
    await page.getByRole('button', { name: /^휴지통을 비웠어요/ }).click();
    await page.getByRole('button', { name: /^디스크 이미지에서 찾을게요/ }).click();
    await page.getByRole('button', { name: '단서 없이 계속', exact: true }).click();
    await page.getByRole('button', { name: /^기간을 정해서 빠르게 찾기/ }).click();
    const periodDialog = page.getByRole('dialog');
    await periodDialog.waitFor();
    await periodDialog.screenshot({ path: path.join(screenshotDirectory, 'chat-period-dialog.png'), animations: 'disabled' });
    await periodDialog.locator('#chat-period-after').fill('2026-09-12');
    await periodDialog.locator('#chat-period-before').fill('2026-09-13');
    await periodDialog.getByRole('button', { name: '이 기간 적용', exact: true }).click();
    await periodDialog.waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#deleted-after').inputValue(), '2026-09-12');
    assert.equal(await page.locator('#deleted-before').inputValue(), '2026-09-13');
    assert.equal(await app.evaluate(() => globalThis.__periodTest.requests.length), 0, 'choosing a chat period does not start a search');
    await page.getByRole('button', { name: /^삭제 파일 찾기/ }).click();
    await page.getByRole('button', { name: '검색 시작', exact: true }).click();
    await waitForCandidateNames(page, ['contiguous.bin', '삭제된-문서.txt']);
    let requests = await app.evaluate(() => globalThis.__periodTest.requests);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].deletedStrategy, 'auto');
    assert.match(requests[0].filters.deletedAfter, /^2026-09-12T00:00:00/);
    assert.match(requests[0].filters.deletedBefore, /^2026-09-13T23:59:59\.999/);
    await page.getByRole('button', { name: '처음부터', exact: true }).click();
    await page.locator('button[data-view-mode=program]').click();
    await openDetails(page, '.custom-period');
    await openDetails(page, '#search-options-details');

    await page.locator('#deleted-after').fill('2026-09-13');
    await page.locator('#deleted-before').fill('2026-09-13');
    await page.locator('#deleted-before').dispatchEvent('change');
    await page.locator('#include-unknown-date').uncheck();
    await page.locator('#program-image').click();
    await page.waitForFunction(() => document.querySelector('#program-source')?.value.startsWith('image:'));
    await page.locator('#program-start').click();
    await waitForCandidateNames(page, ['contiguous.bin']);

    requests = await app.evaluate(() => globalThis.__periodTest.requests);
    assert.equal(requests.length, 2);
    assert.equal(requests[1].mode, 'deleted');
    assert.equal(requests[1].deletedStrategy, 'auto');
    assert.equal(requests[1].filters.includeUnknownDeletedAt, false);
    assert.match(requests[1].filters.deletedAfter, /^2026-09-13T00:00:00/);
    assert.match(requests[1].filters.deletedBefore, /^2026-09-13T23:59:59\.999/);
    let state = await page.evaluate(() => window.recoveryAPI.state());
    assert.equal(state.jobs[0].coverage.strategy, 'journal-first');
    assert.equal(state.jobs[0].coverage.requiresFullScan, true);
    assert.match(await page.locator('#period-search-note').innerText(), /해당 기간의 삭제 이벤트/);
    assert.equal(await page.locator('#search-all-records').isVisible(), true);
    await page.locator('#period-search-note').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(screenshotDirectory, 'journal-first-result-actions.png'), animations: 'disabled', fullPage: true });
    const firstStages = await app.evaluate(() => globalThis.__periodTest.events
      .filter(event => event.type === 'progress').map(event => event.stage));
    assert.ok(firstStages.some(stage => stage === 'journal' || stage === 'journal-discovery'), 'the real worker publishes journal progress');
    assert.ok(firstStages.includes('period-records'), 'the real worker publishes target-record progress');

    await page.locator('#deleted-after').fill('2026-09-12');
    await page.locator('#deleted-after').dispatchEvent('change');
    await page.waitForTimeout(100);
    assert.equal(await app.evaluate(() => globalThis.__periodTest.requests.length), 2, 'editing dates does not start another worker');
    assert.match(await page.locator('#period-search-note').innerText(), /기간이 바뀌었어요.*다시 검색/s);
    assert.equal(await page.locator('#search-period-again').isVisible(), true);
    await page.locator('#search-period-again').click();
    await waitForCandidateNames(page, ['contiguous.bin', '삭제된-문서.txt']);
    requests = await app.evaluate(() => globalThis.__periodTest.requests);
    assert.equal(requests.length, 3);
    assert.equal(requests[2].sourceId, requests[1].sourceId, 'period re-query keeps the source of the current result job');
    assert.equal(requests[2].deletedStrategy, 'auto');
    assert.match(requests[2].filters.deletedAfter, /^2026-09-12T00:00:00/);
    assert.match(requests[2].filters.deletedBefore, /^2026-09-13T23:59:59\.999/);

    assert.equal(await page.locator('#search-all-records').isVisible(), true);
    assert.equal(await page.locator('#include-unknown-date').isChecked(), false, 'the original period filter excluded unknown-time files');
    await page.locator('#search-all-records').click();
    await page.waitForFunction(expected => document.querySelectorAll('article.candidate').length === expected
      && document.querySelector('#activity-indicator')?.hidden, journalFixture.manifest.files.length);
    requests = await app.evaluate(() => globalThis.__periodTest.requests);
    assert.equal(requests.length, 4);
    assert.equal(requests[3].sourceId, requests[1].sourceId);
    assert.equal(requests[3].deletedStrategy, 'full');
    assert.equal(requests[3].filters.includeUnknownDeletedAt, true);
    assert.equal(await page.locator('#include-unknown-date').isChecked(), true);
    state = await page.evaluate(() => window.recoveryAPI.state());
    assert.equal(state.jobs[0].coverage.strategy, 'full-records');
    const fullJob = state.jobs[0];
    const underlying = await page.evaluate(jobId => window.recoveryAPI.candidates({
      jobId, filters: {}, sort: 'deleted-desc', offset: 0, limit: 100
    }), fullJob.id);
    assert.equal(underlying.scannedTotal, journalFixture.manifest.files.length);
    assert.equal(underlying.items.length, journalFixture.manifest.files.length);
    assert.equal(underlying.unknownDeletedTimeTotal, journalFixture.manifest.files.length - 2);
    assert.match(await page.locator('#period-search-note').innerText(), /전체 기록 검색 결과/);

    assert.deepEqual(pageErrors, []);
  } finally {
    await closeOwnedElectron(app);
    const cleanupTarget = path.resolve(runRoot);
    assert.equal(path.dirname(cleanupTarget).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(cleanupTarget).startsWith('recovery-electron-period-'));
    await rm(cleanupTarget, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('Electron missing-journal result waits for an explicit full-record search', { timeout: 60_000 }, async () => {
  const runRoot = await mkdtemp(path.join(os.tmpdir(), 'recovery-electron-period-missing-'));
  const workspace = path.join(runRoot, 'workspace');
  await mkdir(workspace);
  const screenshotDirectory = path.join(desktopOutput, 'period-first');
  await mkdir(screenshotDirectory, { recursive: true });
  const fixture = await createFixture(path.join(runRoot, 'fixture'));
  const executablePath = process.env.RECOVERY_PACKAGED_APP || path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
  let app;
  try {
    app = await _electron.launch({
      executablePath,
      args: process.env.RECOVERY_PACKAGED_APP ? [] : [projectRoot],
      env: { ...process.env, RECOVERY_WORKSPACE: workspace, TZ: 'Asia/Seoul' }
    });
    const page = await app.firstWindow();
    page.setDefaultTimeout(15_000);
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.getByText('데스크톱 연결됨', { exact: true }).waitFor();
    await app.evaluate(({ app, dialog }, image) => {
      const require = process.mainModule.require.bind(process.mainModule);
      const path = require('node:path');
      const engine = app.isPackaged
        ? path.join(process.resourcesPath, 'app.asar.unpacked', 'engine')
        : path.join(app.getAppPath(), 'engine');
      const { RecoveryJobs } = require(path.join(engine, 'job-service.mjs'));
      const originalStart = RecoveryJobs.prototype.start;
      globalThis.__missingPeriodTest = { requests: [] };
      RecoveryJobs.prototype.start = async function missingPeriodTestStart(request) {
        globalThis.__missingPeriodTest.requests.push({ ...request, filters: { ...(request.filters || {}) } });
        return originalStart.call(this, request);
      };
      dialog.showOpenDialog = async (_window, options) => ({
        canceled: false,
        filePaths: options?.properties?.includes('openFile') ? [image] : []
      });
    }, fixture.imagePath);

    await openDetails(page, '.custom-period');
    await openDetails(page, '#search-options-details');
    await page.locator('#deleted-after').fill('2026-09-12');
    await page.locator('#deleted-before').fill('2026-09-13');
    await page.locator('#deleted-before').dispatchEvent('change');
    await page.locator('#program-image').click();
    await page.waitForFunction(() => document.querySelector('#program-source')?.value.startsWith('image:'));
    await page.locator('#program-start').click();
    await page.waitForFunction(sourceLabel => window.recoveryAPI.state().then(value => value.jobs.some(job =>
      job.label === sourceLabel && job.status === 'results' && job.coverage?.strategy === 'journal-first')),
    fixture.imagePath);
    assert.equal(await page.locator('article.candidate').count(), 0);
    let requests = await app.evaluate(() => globalThis.__missingPeriodTest.requests);
    assert.equal(requests.length, 1, 'no automatic full-record request follows the missing journal result');
    assert.equal(requests[0].deletedStrategy, 'auto');
    let state = await page.evaluate(() => window.recoveryAPI.state());
    const fastJob = state.jobs.find(job => job.label === fixture.imagePath && job.coverage?.strategy === 'journal-first');
    assert.ok(fastJob);
    assert.equal(fastJob.coverage.requiresFullScan, true);
    const fastCandidates = await page.evaluate(jobId => window.recoveryAPI.candidates({ jobId, filters: {}, offset: 0, limit: 100 }), fastJob.id);
    assert.equal(fastCandidates.scannedTotal, 0, 'the bounded worker does not walk the fixture MFT');
    await page.locator('#search-all-records').waitFor({ state: 'visible' });
    await page.locator('#search-all-records').scrollIntoViewIfNeeded();
    await page.waitForFunction(() => !document.querySelector('#search-all-records')?.disabled);
    await page.screenshot({ path: path.join(screenshotDirectory, 'missing-journal-manual-fallback.png'), animations: 'disabled', fullPage: true });

    await page.locator('#search-all-records').click();
    await page.waitForFunction(expected => document.querySelectorAll('article.candidate').length === expected
      && document.querySelector('#activity-indicator')?.hidden, fixture.manifest.files.length);
    requests = await app.evaluate(() => globalThis.__missingPeriodTest.requests);
    assert.equal(requests.length, 2);
    assert.equal(requests[1].deletedStrategy, 'full', 'the full record walk begins only after the manual button');
    assert.equal(requests[1].sourceId, requests[0].sourceId);
    state = await page.evaluate(() => window.recoveryAPI.state());
    assert.equal(state.jobs[0].coverage.strategy, 'full-records');
    assert.deepEqual(pageErrors, []);
  } finally {
    await closeOwnedElectron(app);
    const cleanupTarget = path.resolve(runRoot);
    assert.equal(path.dirname(cleanupTarget).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(cleanupTarget).startsWith('recovery-electron-period-missing-'));
    await rm(cleanupTarget, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('Electron keeps journal validation warnings distinct from files and clears them for a clean new search', { timeout: 60_000 }, async () => {
  const runRoot = await mkdtemp(path.join(os.tmpdir(), 'recovery-electron-period-warnings-'));
  const workspace = path.join(runRoot, 'workspace');
  await mkdir(workspace);
  const executablePath = process.env.RECOVERY_PACKAGED_APP || path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
  const warnings = [
    { code: 'USN_RANGE_LIMIT', message: '삭제 이벤트 확인 범위 한도에 도달했어요.' },
    { code: 'USN_MALFORMED', message: '지원하지 않는 삭제 이벤트 구조를 건너뛰었어요.' },
    ...Array.from({ length: 6 }, (_, index) => ({
      code: 'INVALID_RANGE',
      message: `파일 기록 범위 ${index + 1}을 검증하지 못했어요.`
    })),
    { code: 'USN_CHANGED', message: '읽는 동안 삭제 변경 기록 내용이 바뀌었어요.' }
  ];
  let app;
  try {
    app = await _electron.launch({
      executablePath,
      args: process.env.RECOVERY_PACKAGED_APP ? [] : [projectRoot],
      env: { ...process.env, RECOVERY_WORKSPACE: workspace, TZ: 'Asia/Seoul' }
    });
    await app.evaluate(({ app }, warningFixture) => {
      const require = process.mainModule.require.bind(process.mainModule);
      const path = require('node:path');
      const engine = app.isPackaged
        ? path.join(process.resourcesPath, 'app.asar.unpacked', 'engine')
        : path.join(app.getAppPath(), 'engine');
      const { RecoveryJobs } = require(path.join(engine, 'job-service.mjs'));
      globalThis.__warningPeriodTest = { starts: [], statuses: {}, warnings: warningFixture };
      RecoveryJobs.prototype.devices = async () => ({ devices: [
        { id: 'warning-volume-c', label: 'Windows (C:)', kind: 'volume', ready: true, system: true, fileSystem: 'NTFS' }
      ] });
      RecoveryJobs.prototype.start = async function warningPeriodTestStart(request) {
        const jobId = `warning-period-job-${globalThis.__warningPeriodTest.starts.length + 1}`;
        globalThis.__warningPeriodTest.starts.push({ ...request, jobId, filters: { ...(request.filters || {}) } });
        globalThis.__warningPeriodTest.statuses[jobId] = 'scanning';
        return {
          jobId,
          coverage: globalThis.__warningPeriodTest.starts.length === 1
            ? { strategy: 'journal-first', partitions: [{ journalAvailable: false }], requiresFullScan: true }
            : { strategy: 'full-records', requiresFullScan: false }
        };
      };
      RecoveryJobs.prototype.candidates = function warningPeriodTestCandidates({ jobId }) {
        const status = globalThis.__warningPeriodTest.statuses[jobId] || 'scanning';
        return {
          items: [], total: 0, scannedTotal: 0, complete: status === 'results', status,
          coverage: jobId === 'warning-period-job-1'
            ? { strategy: 'journal-first', partitions: [{ journalAvailable: false }], requiresFullScan: true }
            : { strategy: 'full-records', requiresFullScan: false },
          matchCounts: { exact: 0, partial: 0, similar: 0, unknown: 0, none: 0 },
          unknownDeletedTimeTotal: 0
        };
      };
    }, warnings);

    const page = await app.firstWindow();
    page.setDefaultTimeout(15_000);
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    const emitComplete = async (jobId, event) => {
      await app.evaluate(({ BrowserWindow }, payload) => {
        globalThis.__warningPeriodTest.statuses[payload.jobId] = 'results';
        BrowserWindow.getAllWindows()[0].webContents.send('recovery-event', {
          type: 'complete', jobId: payload.jobId, ...payload.event
        });
      }, { jobId, event });
    };

    await page.getByText('데스크톱 연결됨', { exact: true }).waitFor();
    await openDetails(page, '.custom-period');
    await page.locator('#deleted-after').fill('2026-09-12');
    await page.locator('#deleted-before').fill('2026-09-13');
    await page.locator('#program-start').click();
    await page.waitForFunction(() => globalThis.document.body.dataset.hasJob === 'true');
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.send('recovery-event', {
        type: 'progress',
        jobId: 'warning-period-job-1',
        stage: 'period-records',
        stats: { recordsRead: 4603, provisionalCandidates: 1542, candidatesFound: 0 }
      });
    });
    await page.waitForFunction(() => document.querySelector('#scan-status')?.textContent.includes('검증 전 기록 1,542개'));
    assert.match(await page.locator('#scan-status').innerText(), /검증 전 기록 1,542개 · 파일 후보 확정 전/);
    assert.equal(await page.locator('article.candidate').count(), 0, 'provisional records never render as file candidates');
    await emitComplete('warning-period-job-1', {
      complete: false,
      warnings,
      stats: { recordsRead: 4603, provisionalCandidates: 1542, candidatesFound: 0 },
      coverage: { strategy: 'journal-first', partitions: [{ journalAvailable: false }], requiresFullScan: true }
    });

    const warningPanel = page.locator('#scan-warning-panel');
    await warningPanel.getByText('검색 경고 9건 · 파일 개수가 아니에요', { exact: true }).waitFor();
    assert.equal(await page.locator('article.candidate').count(), 0);
    assert.match(await page.locator('#candidate-list').innerText(), /검증을 마친 파일 후보가 없어요/);
    assert.match(await page.locator('#candidate-list').innerText(), /삭제 파일이 없다는 뜻은 아니에요/);
    assert.match(await page.locator('#notice').innerText(), /검색 경고 9건이 있어요.*파일 개수가 아니/);
    assert.doesNotMatch(await page.locator('#notice').innerText(), /9개 확인 사항/);
    assert.equal(await app.evaluate(() => globalThis.__warningPeriodTest.starts.length), 1, 'warning completion never starts a full scan automatically');

    await warningPanel.getByText('경고 전체 보기', { exact: true }).click();
    assert.equal(await warningPanel.locator('li').count(), 9, 'every warning remains inspectable');
    assert.match(await warningPanel.innerText(), /삭제 이벤트 확인 범위 한도에 도달했어요/);
    assert.match(await warningPanel.innerText(), /지원하지 않는 삭제 이벤트 구조를 건너뛰었어요/);
    assert.match(await warningPanel.innerText(), /읽는 동안 삭제 변경 기록 내용이 바뀌었어요/);
    assert.equal((await warningPanel.locator('li').last().innerText()).includes('USN_CHANGED'), true, 'the final changed-journal diagnostic is not truncated');
    const warningScreenshotDirectory=path.join(desktopOutput,'scan-warnings');
    await mkdir(warningScreenshotDirectory,{recursive:true});
    await page.screenshot({path:path.join(warningScreenshotDirectory,'expanded-warnings.png')});
    await page.locator('#deleted-after').fill('2026-09-14');
    await page.locator('#deleted-after').dispatchEvent('change');
    await page.getByRole('alert').filter({ hasText: '시작일이 종료일보다 늦어요' }).waitFor();
    assert.equal(await warningPanel.getByText('검색 경고 9건 · 파일 개수가 아니에요', { exact: true }).isVisible(), true, 'a generic notice does not erase result warnings');

    await page.getByRole('button', { name: '처음부터', exact: true }).click();
    assert.equal(await warningPanel.isHidden(), true, 'reset clears the prior warning pane');
    assert.doesNotMatch(await page.locator('#candidate-list').innerText(), /검증을 마친 파일 후보가 없어요|삭제 파일이 없다는 뜻은 아니에요/);
    await page.locator('#program-start').click();
    await page.waitForFunction(() => document.body.dataset.hasJob === 'true');
    assert.equal(await app.evaluate(() => globalThis.__warningPeriodTest.starts.length), 2);
    await emitComplete('warning-period-job-2', {
      complete: true,
      warnings: [],
      stats: { recordsRead: 0, candidatesFound: 0 },
      coverage: { strategy: 'full-records', requiresFullScan: false }
    });
    await page.getByText('현재 조건에 맞는 후보가 없어요', { exact: true }).waitFor();
    assert.equal(await warningPanel.isHidden(), true, 'a successful clean scan keeps the warning pane cleared');
    assert.doesNotMatch(await page.locator('#candidate-list').innerText(), /검증을 마친 파일 후보가 없어요|삭제 파일이 없다는 뜻은 아니에요/);
    assert.equal(await app.evaluate(() => globalThis.__warningPeriodTest.starts.length), 2, 'neither completion launches an automatic full scan');
    assert.deepEqual(pageErrors, []);
  } finally {
    await closeOwnedElectron(app);
    const cleanupTarget = path.resolve(runRoot);
    assert.equal(path.dirname(cleanupTarget).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(cleanupTarget).startsWith('recovery-electron-period-warnings-'));
    await rm(cleanupTarget, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
