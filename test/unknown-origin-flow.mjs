import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = createRequire(import.meta.url)(process.env.RECOVERY_PLAYWRIGHT_MODULE || 'playwright');
const inventory = [
  { id: 'opaque-offline', label: '준비되지 않은 장치 (Z:)', kind: 'volume', ready: false, fileSystem: 'NTFS' },
  { id: 'opaque-data-a', label: '자료 A (D:)', kind: 'volume', ready: true, fileSystem: 'NTFS' },
  { id: 'opaque-system', label: 'Windows (C:)', kind: 'volume', ready: true, system: true, fileSystem: 'NTFS' },
  { id: 'opaque-data-b', label: '자료 B (E:)', kind: 'volume', ready: true, fileSystem: 'NTFS' },
];

// Only the UI is exercised: every API response is a synthetic fixture, and no
// disk enumeration, source access, recovery, native dialog or real job is run.
async function withMockApp(deviceResponses, body, { failSourceIds = [] } = {}) {
  const assets = new Map([
    ['/', ['index.html', 'text/html; charset=utf-8']],
    ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
    ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
    ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
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
    const page = await browser.newPage({ viewport: { width: 460, height: 720 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(({ responses, failSourceIds }) => {
      let subscriber;
      let deviceCalls = 0;
      const starts = [];
      const completed = new Set();
      window.__recoveryFlowTest = {
        starts,
        get deviceCalls() { return deviceCalls; },
        completeLatest() {
          const jobId = 'mock-job-' + starts.length;
          completed.add(jobId);
          subscriber({ type: 'complete', jobId, complete: true, stats: { candidatesFound: 0 }, warnings: [] });
        },
      };
      window.recoveryAPI = {
        devices: async () => ({ devices: responses[Math.min(deviceCalls++, responses.length - 1)] }),
        chooseDestination: async () => ({ id: 'opaque-output', label: '시험용 별도 저장 위치' }),
        start: async request => {
          starts.push(structuredClone(request));
          if (failSourceIds.includes(request.sourceId)) throw new Error('시험용 오류: 원본과 작업 공간은 다른 물리 디스크여야 합니다.');
          return { jobId: 'mock-job-' + starts.length };
        },
        candidates: async ({ jobId }) => ({ items: [], total: 0, scannedTotal: 0, complete: completed.has(jobId), status: completed.has(jobId) ? 'complete' : 'scanning' }),
        onEvent: listener => { subscriber = listener; return () => { subscriber = null; }; },
      };
    }, { responses: deviceResponses, failSourceIds });
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.getByText('데스크톱 연결됨', { exact: true }).waitFor();
    await body(page);
    assert.deepEqual(errors, [], 'the rendered flow must not raise client errors');
  } finally {
    await browser?.close();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

async function chooseUnknownOrigin(page) {
  await page.getByRole('button', { name: /^직접 지웠어요/ }).click();
  await page.getByRole('button', { name: /^휴지통을 비웠어요/ }).click();
  await page.getByRole('button', { name: /^어디인지 모르겠어요/ }).click();
}

async function assertNotAskedToChooseOriginAgain(page) {
  assert.equal(await page.getByRole('heading', { name: '연결된 장치 중 어느 곳일까요?', exact: true }).count(), 0);
  assert.equal(await page.getByRole('heading', { name: '파일이 원래 있던 곳을 골라주세요', exact: true }).count(), 0);
  for (const device of inventory) {
    assert.equal(await page.locator('#question .choice strong').filter({ hasText: device.label }).count(), 0, 'origin must be chosen by the app after the unknown answer');
  }
}

async function startCurrentScope(page) {
  await page.getByRole('button', { name: /^삭제 파일 찾기/ }).click();
  const destination = page.getByRole('button', { name: /^저장 위치 선택/ });
  if (await destination.count()) await destination.click();
  await page.getByRole('button', { name: '검색 시작', exact: true }).click();
  await page.getByRole('button', { name: '검색 취소', exact: true }).waitFor();
}

test('unknown origin advances through ready volumes without asking for the origin again', { timeout: 40_000 }, async () => {
  await withMockApp([inventory], async page => {
    await chooseUnknownOrigin(page);
    await page.locator('#clue-name').waitFor();
    await assertNotAskedToChooseOriginAgain(page);
    await page.locator('#clue-name').fill('회의록');
    await page.locator('#clue-extension').fill('docx');
    await page.locator('#clue-kind').selectOption('document');
    await page.locator('#clue-time').fill('지난주');
    await page.getByRole('button', { name: '계속', exact: true }).click();

    await page.getByRole('heading', { name: '검색할 내용을 확인해 주세요', exact: true }).waitFor();
    const summary = await page.locator('#question .summary').innerText();
    assert.ok(summary.includes('Windows (C:)'), 'summary identifies the source that will actually be searched');
    assert.match(summary, /1\s*\/\s*3/, 'summary shows the current position in the automatic source list');
    assert.ok(summary.includes('회의록') && summary.includes('docx'));
    await startCurrentScope(page);
    const expectedSources = [inventory[2], inventory[1], inventory[3]];
    for (const [index, expected] of expectedSources.entries()) {
      await page.getByRole('button', { name: '검색 취소', exact: true }).waitFor();
      await assertNotAskedToChooseOriginAgain(page);
      const status = await page.locator('#scan-status').innerText();
      assert.ok(status.includes(expected.label), 'scan status identifies only the source that is actually running');
      assert.match(status, new RegExp(`${index + 1}\\s*/\\s*3`), 'scan status retains the scope position');
      assert.equal(await page.getByRole('button', { name: /^다음 위치 찾기/ }).count(), 0, 'the next location cannot be started while a search is active');
      const starts = await page.evaluate(() => window.__recoveryFlowTest.starts);
      assert.equal(starts.length, index + 1);
      assert.equal(starts[index].sourceId, expected.id, 'actual start uses only the current opaque source ID');
      assert.equal(starts[index].mode, 'deleted');
      assert.deepEqual(starts[index].filters, { name: '회의록', extensions: 'docx', kind: 'document' });
      assert.equal(starts[index].destinationId, undefined, 'metadata listing defers the destination until save');
      await page.evaluate(() => window.__recoveryFlowTest.completeLatest());
      await page.getByRole('button', { name: /원하는 파일 없음/ }).waitFor();
      const next = page.getByRole('button', { name: /^다음 위치 찾기/ });
      if (index < expectedSources.length - 1) {
        await next.waitFor();
        await next.click();
      } else assert.equal(await next.count(), 0, 'there is no next-location action after the last eligible volume');
    }
    assert.equal(await page.evaluate(() => window.__recoveryFlowTest.deviceCalls), 1);
    assert.equal(await page.evaluate(() => window.__recoveryFlowTest.starts.some(call => call.sourceId === 'opaque-offline')), false, 'not-ready sources never start');
  });
});

test('empty inventory retry preserves unknown origin and advances directly to clues when a device appears', { timeout: 25_000 }, async () => {
  await withMockApp([[], inventory], async page => {
    await chooseUnknownOrigin(page);
    await page.getByRole('button', { name: /장치 다시 확인|다시 확인/ }).click();
    await page.locator('#clue-name').waitFor();
    await assertNotAskedToChooseOriginAgain(page);
    assert.equal(await page.evaluate(() => window.__recoveryFlowTest.deviceCalls), 2);
    assert.equal(await page.evaluate(() => window.__recoveryFlowTest.starts.length), 0, 'retry only chooses scope and never starts a search without the user');
    await page.getByRole('button', { name: '단서 없이 계속', exact: true }).click();
    assert.ok((await page.locator('#question .summary').innerText()).includes('Windows (C:)'));
  });
});

test('a rejected start keeps the safety error visible and allows the next location without losing clues', { timeout: 25_000 }, async () => {
  await withMockApp([inventory], async page => {
    await chooseUnknownOrigin(page);
    await page.locator('#clue-name').fill('안전 시험');
    await page.getByRole('button', { name: '계속', exact: true }).click();
    await page.getByRole('button', { name: /^삭제 파일 찾기/ }).click();
    await page.getByRole('button', { name: '검색 시작', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '시험용 오류' }).waitFor();
    assert.equal(await page.getByRole('button', { name: '검색 취소', exact: true }).count(), 0, 'a rejected start must not appear as an active scan');
    assert.equal(await page.getByRole('button', { name: '작업 저장 위치 바꾸기', exact: true }).count(),0,'metadata listing does not request a destination');
    await page.getByRole('button', { name: /^다음 위치 찾기/ }).click();
    await page.getByRole('button', { name: '검색 취소', exact: true }).waitFor();
    await assertNotAskedToChooseOriginAgain(page);
    const starts = await page.evaluate(() => window.__recoveryFlowTest.starts);
    assert.deepEqual(starts.map(call => call.sourceId), ['opaque-system', 'opaque-data-a']);
    assert.equal(starts[1].filters.name, '안전 시험');
    assert.equal(starts[1].destinationId, undefined, 'the next location remains a metadata-only listing');
  }, { failSourceIds: ['opaque-system'] });
});
