import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { filterCandidates } from '../engine/candidate-filter.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = createRequire(import.meta.url)(process.env.RECOVERY_PLAYWRIGHT_MODULE || 'playwright');
const inventory = [
  { id: 'fixture-offline', label: '준비되지 않은 장치 (Z:)', kind: 'volume', ready: false },
  { id: 'fixture-data', label: '자료 (D:)', kind: 'volume', ready: true, fileSystem: 'NTFS' },
  { id: 'fixture-system', label: 'Windows (C:)', kind: 'volume', ready: true, system: true, fileSystem: 'NTFS' }
];
const fixtureCandidates = [
  { id: 'unknown', name: '삭제 시각 미상.txt', deletedAt: null, modifiedAt: '2099-01-01T00:00:00Z' },
  { id: 'older', name: '어제 삭제한 문서.txt', deletedAt: Date.parse('2026-09-12T12:00:00+09:00'), modifiedAt: '2026-09-11T00:00:00Z' },
  { id: 'latest', name: '오늘 삭제한 문서.txt', deletedAt: '2026-09-13T12:00:00+09:00', modifiedAt: '2026-09-10T00:00:00Z' }
].map(candidate => ({ ...candidate, path: `C:/synthetic-recent-fixture/${candidate.name}`, source: 'deleted-record', status: 'readable', size: 128, reasons: [] }));

// Every device, dialog, job and file is a synthetic API fixture. The real UI and
// engine sorting run; this test never enumerates or reads a real source device.
async function withMockApp(body) {
  const assets = new Map([
    ['/', ['index.html', 'text/html; charset=utf-8']],
    ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
    ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
    ['/favicon.svg', ['favicon.svg', 'image/svg+xml']]
  ]);
  const server = createServer(async (request, response) => {
    const asset = assets.get(new URL(request.url, 'http://127.0.0.1').pathname);
    if (!asset) { response.writeHead(404).end(); return; }
    try { response.writeHead(200, { 'content-type': asset[1] }).end(await readFile(path.join(root, asset[0]))); }
    catch { response.writeHead(500).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 460, height: 720 }, reducedMotion: 'no-preference' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.exposeFunction('__sortRecentFixtures', request => {
      const items = fixtureCandidates.map(candidate => ({ ...candidate, source: request.fixtureMode === 'recycle' ? 'recycle-bin' : candidate.source }));
      const all = filterCandidates(items, request.filters, { sort: request.sort });
      return { items: all.slice(request.offset, request.offset + request.limit), total: all.length, scannedTotal: fixtureCandidates.length };
    });
    await page.addInitScript(devices => {
      let subscriber;
      let jobCount = 0;
      let status = 'scanning';
      let mode;
      const calls = [];
      const pending = new Map();
      function delayed(operation, request, value) {
        calls.push({ operation, request: structuredClone(request) });
        return new Promise((resolve, reject) => {
          const entries = pending.get(operation) || [];
          entries.push({ resolve, reject, value });
          pending.set(operation, entries);
        });
      }
      window.__recentFlowTest = {
        calls,
        release(operation, error, value) {
          const entry = pending.get(operation)?.shift();
          if (!entry) throw new Error(`No pending fixture operation: ${operation}`);
          if (error) entry.reject(new Error(error));
          else entry.resolve(arguments.length >= 3 ? value : entry.value);
        },
        emit(type, data = {}) {
          if (type === 'paused') status = 'paused';
          if (type === 'resumed') status = 'scanning';
          if (type === 'complete' || type === 'recover-complete') status = 'complete';
          if (type === 'error') status = 'failed';
          if (type === 'cancelled') status = 'cancelled';
          subscriber({ type, jobId: 'fixture-job-' + jobCount, complete: true, warnings: [], stats: { candidatesFound: 3 }, ...data });
        }
      };
      window.recoveryAPI = {
        recycleSource: () => delayed('recycleSource', {}, { id: 'fixture-recycle', kind: 'recycle', label: '시험용 휴지통' }),
        devices: () => delayed('devices', {}, { devices }),
        chooseDestination: () => delayed('chooseDestination', {}, { id: 'fixture-output', label: '시험용 별도 저장 위치' }),
        start: request => { status = 'scanning'; mode = request.mode; return delayed('start', request, { jobId: 'fixture-job-' + (++jobCount) }); },
        candidates: async request => {
          calls.push({ operation: 'candidates', request: structuredClone(request) });
          return { ...await window.__sortRecentFixtures({ ...request, fixtureMode: mode }), status, complete: status === 'complete' };
        },
        preview: request => delayed('preview', request, { type: 'text', text: '실제 파일을 읽지 않은 UI 시험용 미리보기입니다.' }),
        recover: request => { status = 'recovering'; return delayed('recover', request, { jobId: 'fixture-job-' + jobCount }); },
        pause: async () => { window.__recentFlowTest.emit('paused'); return { paused: true }; },
        resume: async () => { window.__recentFlowTest.emit('resumed'); return { resumed: true }; },
        onEvent: listener => { subscriber = listener; return () => { subscriber = null; }; }
      };
    }, inventory);
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.getByText('데스크톱 연결됨', { exact: true }).waitFor();
    await body(page);
    assert.deepEqual(errors, [], 'the rendered recent-deletion flow must not raise client errors');
  } finally {
    await browser?.close();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

async function release(page, operation, error) {
  await page.evaluate(({ operation, error }) => window.__recentFlowTest.release(operation, error), { operation, error });
}

async function assertIdle(page) {
  await page.locator('#activity-indicator').waitFor({ state: 'hidden' });
}

async function assertActivity(page, text) {
  await page.locator('#activity-indicator').waitFor({ state: 'visible' });
  await page.waitForFunction(expected => document.querySelector('#activity-label').textContent.includes(expected), text);
}

async function chooseRecent(page) {
  await page.getByRole('button', { name: '휴지통 비운 뒤 파일 찾기', exact: true }).click();
  await assertActivity(page, '장치');
  await release(page, 'devices');
  await page.getByRole('button', { name: /^최근 삭제 목록 검색/ }).waitFor();
  assert.equal(await page.locator('#clue-name').count(), 0, 'recent browsing does not require a filename clue');
  assert.equal(await page.getByRole('heading', { name: '파일이 원래 있던 곳을 골라주세요', exact: true }).count(), 0, 'recent browsing selects the scope automatically');
  assert.equal(await page.getByRole('heading', { name: '휴지통을 확인해 보셨나요?', exact: true }).count(), 0, 'recent browsing skips the disappearance questionnaire');
}

async function prepareRecentStart(page) {
  await chooseRecent(page);
  await page.getByRole('button', { name: /^최근 삭제 목록 검색/ }).click();
  await page.getByRole('button', { name: '검색 시작', exact: true }).waitFor();
}

async function startRecent(page) {
  await prepareRecentStart(page);
  await page.getByRole('button', { name: '검색 시작', exact: true }).click();
  await assertActivity(page, '준비');
  await release(page, 'start');
  await page.getByRole('button', { name: '검색 취소', exact: true }).waitFor();
  await page.locator('.candidate').first().waitFor();
}

async function startRecycle(page) {
  await page.getByRole('button', { name: /^최근 삭제된 파일 보기/ }).click();
  await page.locator('#activity-indicator').waitFor({ state: 'visible' });
  await release(page, 'recycleSource');
  await assertActivity(page, '준비');
  await release(page, 'start');
  await page.getByRole('button', { name: '검색 취소', exact: true }).waitFor();
  await page.locator('.candidate').first().waitFor();
}

test('emptied-recycle route automatically picks a source, shows loading, and sorts by real deletion time', { timeout: 40_000 }, async () => {
  await withMockApp(async page => {
    await assertIdle(page);
    await page.getByRole('button', { name: '휴지통 비운 뒤 파일 찾기', exact: true }).click();
    await assertActivity(page, '장치');
    const spinner = page.locator('.activity-spinner');
    assert.notEqual(await spinner.evaluate(element => getComputedStyle(element).animationName), 'none');
    assert.equal(await page.locator('#activity-indicator').getAttribute('role'), 'status');
    await mkdir(path.join(root, 'output', 'playwright'), { recursive: true });
    await page.screenshot({ path: path.join(root, 'output', 'playwright', 'recent-loading.png') });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await spinner.evaluate(element => getComputedStyle(element).animationName), 'none', 'reduced-motion users see a static activity asset');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await release(page, 'devices');
    await page.getByRole('button', { name: /^최근 삭제 목록 검색/ }).waitFor();
    await assertIdle(page);
    assert.equal(await page.locator('#clue-name').count(), 0);
    assert.equal(await page.getByRole('heading', { name: '파일이 원래 있던 곳을 골라주세요', exact: true }).count(), 0);
    await page.getByRole('button', { name: /^최근 삭제 목록 검색/ }).click();
    await page.locator('#notification-mode').focus();
    let reachedStart = false;
    for (let index = 0; index < 8; index++) {
      await page.keyboard.press('Tab');
      reachedStart = await page.evaluate(() => document.activeElement?.textContent === '검색 시작');
      if (reachedStart) break;
    }
    assert.equal(reachedStart, true, 'the start action is reachable through keyboard tab order');
    await page.keyboard.press('Enter');
    await assertActivity(page, '준비');
    const start = await page.evaluate(() => window.__recentFlowTest.calls.find(call => call.operation === 'start').request);
    assert.equal(start.sourceId, 'fixture-system');
    assert.equal(start.mode, 'deleted');
    assert.equal(start.recent, true);
    assert.equal(start.destinationId, undefined);
    assert.equal(await page.evaluate(() => window.__recentFlowTest.calls.filter(call => call.operation === 'chooseDestination').length), 0, 'listing must not open an output picker');
    assert.equal(start.filters.name || '', '');
    await release(page, 'start');
    await page.getByRole('button', { name: '검색 취소', exact: true }).waitFor();
    await page.locator('.candidate').first().waitFor();
    assert.equal(await page.locator('#sort').inputValue(), 'deleted-desc');
    assert.deepEqual(await page.locator('.candidate-name').allTextContents(), ['오늘 삭제한 문서.txt', '어제 삭제한 문서.txt', '삭제 시각 미상.txt']);
    const requests = await page.evaluate(() => window.__recentFlowTest.calls.filter(call => call.operation === 'candidates').map(call => call.request));
    assert.ok(requests.length > 0 && requests.every(request => request.sort === 'deleted-desc'));
    const unknown = page.locator('.candidate').filter({ has: page.getByText('삭제 시각 미상.txt', { exact: true }) });
    assert.match(await unknown.innerText(), /삭제.*(모름|알 수 없|미상|미확인)/);
    assert.doesNotMatch(await unknown.locator('.deletion-time').innerText(), /2099/, 'modification time never becomes the displayed deletion date');
    assert.ok((await page.locator('.deletion-time-heading').allTextContents()).some(text => /모름|알 수 없|미상|미확인/.test(text)), 'unknown deletion times have a separate group');
    await page.evaluate(() => window.__recentFlowTest.emit('paused'));
    await assertActivity(page, '일시 정지');
    assert.equal(await spinner.evaluate(element => getComputedStyle(element).animationPlayState), 'paused');
    await page.evaluate(() => window.__recentFlowTest.emit('resumed'));
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.activity-spinner')).animationPlayState === 'running');
    await page.evaluate(() => window.__recentFlowTest.emit('complete'));
    await assertIdle(page);
    await page.getByRole('button', { name: /^원하는 파일 없음/ }).waitFor();
    await page.locator('#candidate-list').screenshot({ path: path.join(root, 'output', 'playwright', 'recent-candidates.png') });
    await page.setViewportSize({ width: 360, height: 720 });
    const overflow = await page.evaluate(() => {
      const workspace = document.querySelector('.workspace');
      return {
        page: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        workspace: workspace.scrollWidth > workspace.clientWidth,
        candidates: [...document.querySelectorAll('.candidate')].some(candidate => candidate.scrollWidth > candidate.clientWidth)
      };
    });
    assert.deepEqual(overflow, { page: false, workspace: false, candidates: false }, 'the compact 360px layout does not introduce horizontal overflow');
  });
});

test('preview and recovery display activity until their asynchronous work finishes', { timeout: 35_000 }, async () => {
  await withMockApp(async page => {
    await startRecent(page);
    await page.evaluate(() => window.__recentFlowTest.emit('complete'));
    await assertIdle(page);
    assert.equal(await page.getByRole('button', { name: '미리보기', exact: true }).count(), 0, 'deleted-file preview waits until the user has chosen a safe output');
    await page.getByRole('checkbox', { name: '오늘 삭제한 문서.txt 선택', exact: true }).check();
    await page.getByRole('button', { name: '선택 파일 저장', exact: true }).click();
    await assertActivity(page, '폴더');
    await release(page, 'chooseDestination');
    await assertActivity(page, '복구');
    await release(page, 'recover');
    await assertActivity(page, '저장');
    await page.evaluate(() => window.__recentFlowTest.emit('recover-complete', { results: [{ id: 'latest', name: '오늘 삭제한 문서.txt', status: 'saved', path: 'fixture-output/result.txt' }] }));
    await assertIdle(page);
    assert.match(await page.locator('#results-actions').innerText(), /파일 저장 1개/);
    await page.getByRole('button', { name: '미리보기', exact: true }).first().click();
    await assertActivity(page, '미리보기');
    await release(page, 'preview');
    await page.getByRole('dialog').waitFor();
    await assertIdle(page);
    assert.match(await page.locator('.preview-text').innerText(), /UI 시험용/);
    await page.getByRole('dialog').getByRole('button', { name: '닫기', exact: true }).click();
    await page.getByRole('button', { name: '미리보기', exact: true }).first().click();
    await assertActivity(page, '미리보기');
    await release(page, 'preview', '시험용 미리보기 실패');
    await page.getByRole('alert').filter({ hasText: '시험용 미리보기 실패' }).waitFor();
    await assertIdle(page);
  });
});

test('API failures and job errors clear activity and preserve visible error guidance', { timeout: 35_000 }, async () => {
  await withMockApp(async page => {
    await page.getByRole('button', { name: '휴지통 비운 뒤 파일 찾기', exact: true }).click();
    await assertActivity(page, '장치');
    await release(page, 'devices', '시험용 장치 확인 실패');
    await page.getByRole('alert').filter({ hasText: '시험용 장치 확인 실패' }).waitFor();
    await assertIdle(page);
    await page.getByRole('button', { name: '다시 확인', exact: true }).click();
    await assertActivity(page, '장치');
    await release(page, 'devices');
    await page.getByRole('button', { name: /^최근 삭제 목록 검색/ }).click();
    await page.getByRole('button', { name: '검색 시작', exact: true }).click();
    await assertActivity(page, '준비');
    await release(page, 'start', '시험용 검색 준비 실패');
    await page.getByRole('alert').filter({ hasText: '시험용 검색 준비 실패' }).waitFor();
    await assertIdle(page);
    assert.equal(await page.getByRole('button', { name: '검색 시작', exact: true }).isEnabled(), true);
    await page.getByRole('button', { name: '검색 시작', exact: true }).click();
    await release(page, 'start');
    await page.getByRole('button', { name: '검색 취소', exact: true }).waitFor();
    await page.evaluate(() => window.__recentFlowTest.emit('error', { error: { message: '시험용 검색 중 오류' } }));
    await page.getByRole('alert').filter({ hasText: '시험용 검색 중 오류' }).waitFor();
    await assertIdle(page);
  });
});

test('candidate refresh activity does not move the date-details click target', { timeout: 30_000 }, async () => {
  await withMockApp(async page => {
    await startRecent(page);
    await page.evaluate(() => window.__recentFlowTest.emit('complete'));
    await assertIdle(page);
    await page.locator('#results').evaluate(element => element.scrollIntoView({ block: 'start' }));
    await page.locator('#path-filter').fill('삭제');
    const summary = page.getByText('날짜·크기·경로 조건', { exact: true });
    const before = await summary.boundingBox();
    assert.ok(before);
    await page.evaluate(() => {
      const original = window.recoveryAPI.candidates;
      let resume;
      const deferred = new Promise(resolve => { resume = resolve; });
      window.recoveryAPI.candidates = async request => { await deferred; return original(request); };
      window.__releaseCandidateLayout = () => { window.recoveryAPI.candidates = original; resume(); };
    });
    await page.locator('#path-filter').dispatchEvent('change');
    await assertActivity(page, '목록');
    const during = await summary.boundingBox();
    assert.ok(during);
    assert.equal(during.y, before.y, 'showing asynchronous activity must not shift the date-details summary');
    assert.equal(during.height, before.height);
    await page.mouse.click(before.x + before.width / 2, before.y + before.height / 2);
    assert.equal(await summary.evaluate(element => element.parentElement.open), true, 'the original pointer target still opens date details while the request is pending');
    await page.evaluate(() => window.__releaseCandidateLayout());
    await assertIdle(page);
    assert.equal((await summary.boundingBox()).y, before.y, 'hiding completed activity must not shift the summary either');
  });
});

for (const outcome of ['resolve', 'reject']) {
  test(`restart discards a pending candidate refresh and its later ${outcome} outcome`, { timeout: 30_000 }, async () => {
    await withMockApp(async page => {
      await startRecent(page);
      await page.evaluate(() => window.__recentFlowTest.emit('complete'));
      await assertIdle(page);
      await page.evaluate(outcome => {
        const original = window.recoveryAPI.candidates;
        let resume;
        const deferred = new Promise(resolve => { resume = resolve; });
        const requests = [];
        window.recoveryAPI.candidates = request => {
          const pending = deferred.then(() => {
            if (outcome === 'reject') throw new Error('시험용 이전 목록 요청 오류');
            return original(request);
          });
          requests.push(pending);
          return pending;
        };
        window.__releaseStaleCandidates = async () => {
          window.recoveryAPI.candidates = original;
          resume();
          await Promise.allSettled(requests);
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        };
      }, outcome);
      await page.locator('#path-filter').fill('삭제');
      await page.locator('#path-filter').dispatchEvent('change');
      await assertActivity(page, '목록');
      await page.getByRole('button', { name: '처음부터', exact: true }).click();
      const initial = page.getByRole('heading', { name: '파일이 어떻게 없어졌나요?', exact: true });
      await initial.waitFor();
      await assertIdle(page);
      assert.equal(await page.locator('#results').isVisible(), false, 'restart immediately hides previous candidates without waiting for their request');
      assert.equal(await page.locator('#scan-status').isVisible(), false);
      await page.evaluate(() => window.__releaseStaleCandidates());
      await initial.waitFor();
      await assertIdle(page);
      assert.equal(await page.locator('#results').isVisible(), false, 'a late response must not restore the old result surface');
      assert.equal(await page.locator('#scan-status').isVisible(), false);
      assert.equal(await page.getByRole('button', { name: /선택 파일 저장|검색 취소/ }).count(), 0, 'no old recovery or scan controls are exposed');
      assert.equal(await page.locator('#notice').isVisible(), false, 'an old request failure must not become a new-session notice');
      assert.doesNotMatch(await page.locator('#announcer').textContent(), /시험용 이전 목록 요청 오류/);
    });
  });
}

test('recent recycle listing opens no picker, and repeated double-click saves only the clicked file', { timeout: 30_000 }, async () => {
  await withMockApp(async page => {
    await startRecycle(page);
    const start = await page.evaluate(() => window.__recentFlowTest.calls.find(call => call.operation === 'start').request);
    assert.equal(start.sourceId, 'fixture-recycle');
    assert.equal(start.mode, 'recycle');
    assert.equal(start.destinationId, undefined);
    assert.equal(await page.evaluate(() => window.__recentFlowTest.calls.filter(call => ['devices', 'chooseDestination'].includes(call.operation)).length), 0, 'the first route goes directly to the current recycle listing');
    await page.evaluate(() => window.__recentFlowTest.emit('complete'));
    await assertIdle(page);
    assert.equal(await page.locator('#sort').inputValue(), 'deleted-desc');
    await page.getByRole('checkbox', { name: '어제 삭제한 문서.txt 선택', exact: true }).check();
    await page.getByRole('checkbox', { name: '삭제 시각 미상.txt 선택', exact: true }).check();
    await page.getByText('오늘 삭제한 문서.txt', { exact: true }).dblclick();
    await assertActivity(page, '폴더');
    await page.getByText('오늘 삭제한 문서.txt', { exact: true }).dblclick();
    assert.equal(await page.evaluate(() => window.__recentFlowTest.calls.filter(call => call.operation === 'chooseDestination').length), 1, 'duplicate double-clicks cannot open another destination picker');
    assert.equal(await page.evaluate(() => window.__recentFlowTest.calls.filter(call => call.operation === 'recover').length), 0, 'saving waits for the destination result');
    await release(page, 'chooseDestination');
    await assertActivity(page, '복구');
    const recover = await page.evaluate(() => window.__recentFlowTest.calls.find(call => call.operation === 'recover').request);
    assert.deepEqual(recover.ids, ['latest'], 'double-click targets the clicked file and ignores a previous multi-selection');
    assert.equal(recover.destinationId, 'fixture-output');
    await release(page, 'recover');
    await page.evaluate(() => window.__recentFlowTest.emit('recover-complete', { results: [{ id: 'latest', name: '오늘 삭제한 문서.txt', status: 'saved', path: 'fixture-output/result.txt' }] }));
    await assertIdle(page);
    assert.match(await page.locator('#results-actions').innerText(), /파일 저장 1개/);
  });
});

test('cancelling the save picker retains recycle candidates and still allows deleted-record search', { timeout: 30_000 }, async () => {
  await withMockApp(async page => {
    await startRecycle(page);
    await page.evaluate(() => window.__recentFlowTest.emit('complete'));
    await assertIdle(page);
    const names = await page.locator('.candidate-name').allTextContents();
    await page.getByText('오늘 삭제한 문서.txt', { exact: true }).dblclick();
    await assertActivity(page, '폴더');
    await page.evaluate(() => window.__recentFlowTest.release('chooseDestination', null, null));
    await assertIdle(page);
    assert.deepEqual(await page.locator('.candidate-name').allTextContents(), names, 'cancelling a folder dialog keeps the current list intact');
    assert.equal(await page.getByRole('button', { name: '저장', exact: true }).first().isEnabled(), true);
    assert.equal(await page.evaluate(() => window.__recentFlowTest.calls.filter(call => call.operation === 'recover').length), 0);
    await page.getByRole('button', { name: '휴지통에도 없어요 · 삭제 기록 찾기', exact: true }).click();
    await assertActivity(page, '장치');
    await release(page, 'devices');
    await page.getByRole('button', { name: /^최근 삭제 목록 검색/ }).waitFor();
    assert.equal(await page.evaluate(() => window.__recentFlowTest.calls.filter(call => call.operation === 'chooseDestination').length), 1, 'switching to raw deletion records does not choose a save destination');
  });
});

test('an immediate Worker save error remains visible after the recover IPC resolves and allows retry', { timeout: 30_000 }, async () => {
  await withMockApp(async page => {
    await startRecycle(page);
    await page.evaluate(() => window.__recentFlowTest.emit('complete'));
    await assertIdle(page);
    await page.evaluate(() => {
      window.recoveryAPI.recover = request => {
        window.__recentFlowTest.calls.push({ operation: 'recover', request: structuredClone(request) });
        window.__recentFlowTest.emit('error', { error: { code: 'FIXTURE_SAVE_FAILED', message: '시험용 즉시 복구 오류' } });
        return Promise.resolve({ jobId: request.jobId });
      };
    });
    await page.getByText('오늘 삭제한 문서.txt', { exact: true }).dblclick();
    await assertActivity(page, '폴더');
    await release(page, 'chooseDestination');
    await assertIdle(page);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const notice = page.getByRole('alert').filter({ hasText: '시험용 즉시 복구 오류' });
    await notice.waitFor();
    assert.equal(await notice.getAttribute('data-tone'), 'error');
    assert.equal(await page.getByRole('button', { name: '검색 취소', exact: true }).count(), 0, 'a failed save must not remain in a working state');
    const card = page.locator('.candidate').filter({ has: page.getByText('오늘 삭제한 문서.txt', { exact: true }) });
    const retry = card.getByRole('button', { name: '저장', exact: true });
    assert.equal(await retry.isEnabled(), true, 'the failed file remains available for another save attempt');
    await retry.click();
    await assertActivity(page, '폴더');
    assert.equal(await page.evaluate(() => window.__recentFlowTest.calls.filter(call => call.operation === 'chooseDestination').length), 2, 'retry can actually open a new save destination picker');
    await page.evaluate(() => window.__recentFlowTest.release('chooseDestination', null, null));
    await assertIdle(page);
    await notice.waitFor();
  });
});
