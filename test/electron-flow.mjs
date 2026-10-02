import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createFixture } from './ntfs-fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeModules = 'C:\\Users\\USER\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\node\\node_modules';
const packagedApp = process.env.RECOVERY_PACKAGED_APP || path.join(root, 'dist', 'win-unpacked', '공공 AX 로컬 시리즈 8 - 파일 복구.exe');
const appArgs = process.env.RECOVERY_APP_ENTRY ? [process.env.RECOVERY_APP_ENTRY] : [];
const executableReady = Boolean(path.isAbsolute(packagedApp) && existsSync(packagedApp));
const finalPackagedApp = process.env.RECOVERY_PACKAGED_FINAL_APP || packagedApp;
const finalExecutableReady = Boolean(path.isAbsolute(finalPackagedApp) && existsSync(finalPackagedApp));

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
test('packaged result filters reset correctly and index refresh clears unavailable selected candidates', {
  skip: executableReady ? false : 'Build the packaged executable first.', timeout: 45_000,
}, async () => {
  const { _electron } = createRequire(path.join(runtimeModules, 'playwright', 'package.json'))('playwright');
  const runRoot = await mkdtemp(path.join(os.tmpdir(), 'recovery-electron-filters-'));
  const source = path.join(runRoot, 'source');
  const workspace = path.join(runRoot, 'workspace');
  await Promise.all([mkdir(source), mkdir(workspace)]);
  for (const name of ['예산.txt', '회의.txt', '예산.png']) {
    const file = path.join(source, name);
    await writeFile(file, 'synthetic fixture');
    await utimes(file, new Date('2026-09-12T08:00:00+09:00'), new Date('2026-09-12T08:00:00+09:00'));
  }
  let app;
  try {
    app = await _electron.launch({ executablePath: packagedApp, args: appArgs, env: { ...process.env, TZ: 'Asia/Seoul', RECOVERY_WORKSPACE: workspace } });
    await app.evaluate(({ dialog }, source) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] }); }, source);
    const page = await app.firstWindow();
    await page.getByText('데스크톱 연결됨', { exact: true }).waitFor();
    const begin = async (name, kind) => {
      await page.getByRole('button', { name: /^찾아보니 없어요/ }).click();
      await page.getByRole('button', { name: /^폴더를 직접 고를게요/ }).click();
      await page.locator('#clue-name').fill(name);
      await page.locator('#clue-kind').selectOption(kind);
      await page.getByRole('button', { name: '계속', exact: true }).click();
      await page.getByRole('button', { name: /^복사본·비슷한 파일 찾기/ }).click();
      await page.getByRole('button', { name: '검색 시작', exact: true }).click();
      await page.getByRole('button', { name: /원하는 파일 없음/ }).waitFor();
    };
    await begin('예산', 'document');
    assert.equal(await page.locator('#path-filter').inputValue(), '예산');
    assert.equal(await page.locator('[data-kind=document]').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.getByLabel('예산.png 선택').count(), 0);
    await page.locator('#path-filter').fill('');
    await page.locator('#path-filter').dispatchEvent('change');
    await page.getByLabel('회의.txt 선택').waitFor();
    await page.getByText('날짜·크기·경로 조건', { exact: true }).click();
    await page.locator('#modified-after').fill('2026-09-12');
    await page.locator('#modified-after').dispatchEvent('change');
    await page.getByLabel('예산.txt 선택').waitFor();
    assert.equal(await page.locator('article.candidate').count(), 2, '08:00 KST on the selected day is included');
    await page.locator('#original-path').fill('no-such-path');
    await page.locator('#original-path').dispatchEvent('change');
    await page.locator('#modified-before').fill('2026-09-13');
    await page.locator('#max-size').fill('1');
    await page.locator('#sort').selectOption('size-desc');
    await page.getByRole('button', { name: '처음부터', exact: true }).click();
    await begin('', 'image');
    await page.getByLabel('예산.png 선택').waitFor();
    assert.equal(await page.locator('article.candidate').count(), 1);
    for (const id of ['path-filter', 'modified-after', 'modified-before', 'max-size', 'original-path']) assert.equal(await page.locator('#'+id).inputValue(), '');
    assert.equal(await page.locator('#sort').inputValue(), 'score-desc');
    assert.equal(await page.locator('[data-kind=photo]').getAttribute('aria-pressed'), 'true');
    await page.getByLabel('예산.png 선택').check();
    const indexed = await page.evaluate(async () => {
      const jobId = (await window.recoveryAPI.state()).jobs[0].id;
      return { jobId, ...await window.recoveryAPI.saveIndex({ jobId }) };
    });
    await app.evaluate(({ dialog }, indexPath) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [indexPath] }); }, indexed.path);
    await rm(path.join(source, '예산.png')); // This file belongs to the generated test fixture.
    await page.getByRole('button', { name: '도구 · 안내', exact: true }).click();
    await page.getByRole('button', { name: '기존 인덱스 불러오기', exact: true }).click();
    await page.getByText(/인덱스 재확인:.*삭제·확인 불가 1개/).waitFor();
    await page.waitForFunction(() => document.querySelectorAll('article.candidate').length === 0);
    await page.getByText('0개 선택됨', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '선택 파일 저장', exact: true }).count(), 0);
    const current = await page.evaluate(jobId => window.recoveryAPI.candidates({ jobId, filters: {}, limit: 20 }), indexed.jobId);
    assert.equal(current.total, 2, 'unaffected current files stay in both the job and result cache');
  } finally { await app?.close().catch(() => {}); await rm(runRoot, { recursive: true, force: true }); }
});
async function findNamedFile(directory, name) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory() && entry.name !== 'previews') { const found = await findNamedFile(target, name); if (found) return found; }
    else if (entry.isFile() && entry.name === name) return target;
  }
  return null;
}

test('packaged Electron image workflow scans, selects, previews and recovers an actual synthetic NTFS file', {
  skip: executableReady ? false : 'Set RECOVERY_PACKAGED_APP to the absolute packaged executable after the portable build is ready.',
  timeout: 45_000,
}, async () => {
  const requireFromRuntime = createRequire(path.join(runtimeModules, 'playwright', 'package.json'));
  const { _electron } = requireFromRuntime('playwright');
  const runRoot = await mkdtemp(path.join(os.tmpdir(), 'recovery-electron-'));
  const workspace = path.join(runRoot, 'workspace');
  const destination = path.join(runRoot, 'destination');
  await Promise.all([mkdir(workspace), mkdir(destination)]);
  const fixture = await createFixture(path.join(runRoot, 'fixture'));
  const sourceHash = sha256(await readFile(fixture.imagePath));
  const screenshot = process.env.RECOVERY_ELECTRON_SCREENSHOT || path.join(root, 'output', 'playwright', 'recovery-packaged-460x720.png');
  await mkdir(path.dirname(screenshot), { recursive: true });
  let electronApp;
  try {
    electronApp = await _electron.launch({ executablePath: packagedApp, args: appArgs, env: { ...process.env, RECOVERY_WORKSPACE: workspace } });
    await electronApp.evaluate(({ dialog }, paths) => {
      dialog.showOpenDialog = async (_window, options) => ({ canceled: false, filePaths: options.properties.includes('openFile') ? [paths.image] : [paths.destination] });
    }, { image: fixture.imagePath, destination });
    const page = await electronApp.firstWindow();
    page.setDefaultTimeout(10_000);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(500);
    await page.screenshot({ path: screenshot });
    const directDelete = page.getByRole('button', { name: /^직접 지웠어요/ });
    assert.equal(await directDelete.count(), 1, `The packaged initial screen did not load the guided recovery UI. URL: ${page.url()}\nBody: ${(await page.locator('body').innerText()).slice(0, 1_000)}`);
    await directDelete.click();
    await page.getByRole('button', { name: /^휴지통에 없어요/ }).click();
    await page.getByRole('button', { name: /^디스크 이미지에서 찾을게요/ }).click();
    await page.getByRole('button', { name: '단서 없이 계속', exact: true }).click();
    await page.getByRole('button', { name: /^삭제 파일 찾기/ }).click();
    await page.getByRole('button', { name: '검색 시작', exact: true }).click();
    await page.getByLabel('삭제된-문서.txt 선택').waitFor({ state: 'visible' });
    await page.getByRole('button', { name: /원하는 파일 없음/ }).waitFor({ state: 'visible' });
    await page.locator('article.candidate').filter({ has: page.getByLabel('삭제된-문서.txt 선택') }).locator('.candidate-name').dblclick();
    await page.locator('.bubble', { hasText: '저장 처리가 끝났어요. 파일별 결과를 확인해주세요.' }).last().waitFor({ state: 'visible' });
    const bounds = await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
    assert.equal(bounds.width, 460);
    assert.equal(bounds.height, 720);
    await page.screenshot({ path: screenshot });
    const recovered = await findNamedFile(destination, '삭제된-문서.txt');
    assert.ok(recovered, 'the selected recovered file should be published below the mocked output directory');
    const expected = fixture.manifest.files.find((item) => item.recordNumber === 24);
    assert.equal(sha256(await readFile(recovered)), expected.sha256);
    await page.locator('article.candidate').filter({ has: page.getByLabel('삭제된-문서.txt 선택') }).getByRole('button', { name: '미리보기', exact: true }).click();
    await page.locator('#app-dialog .preview-text').waitFor({ state: 'visible' });
    assert.match(await page.locator('#app-dialog .preview-text').innerText(), /회복 연진 테스트 문서/);
    await page.locator('#app-dialog').getByRole('button', { name: '닫기', exact: true }).click();
    await page.getByRole('button', { name: '정리 대상 확인', exact: true }).click();
    await page.getByRole('heading', { name: '정리 전 확인', exact: true }).waitFor({ state: 'visible' });
    assert.match(await page.locator('#app-dialog').innerText(), /정리 대상: 1개/);
    await page.getByRole('button', { name: '이 항목 정리', exact: true }).click();
    await page.getByText('정리 요청을 완료했습니다.', { exact: true }).waitFor({ state: 'visible' });
    assert.equal(sha256(await readFile(recovered)), expected.sha256, 'temporary preview cleanup must preserve the published recovered file');
    assert.equal(sha256(await readFile(fixture.imagePath)), sourceHash, 'the source image remains read-only');
  } finally {
    await electronApp?.close().catch(() => {});
    await rm(runRoot, { recursive: true, force: true });
  }
});

test('final packaged tools call support and history, then reselect the saved image through the native dialog bridge', {
  skip: finalExecutableReady ? false : 'Set RECOVERY_PACKAGED_FINAL_APP after the final package rebuild is ready.',
  timeout: 30_000,
}, async () => {
  const requireFromRuntime = createRequire(path.join(runtimeModules, 'playwright', 'package.json'));
  const { _electron } = requireFromRuntime('playwright');
  const runRoot = await mkdtemp(path.join(os.tmpdir(), 'recovery-electron-tools-'));
  const workspace = path.join(runRoot, 'workspace'); const destination = path.join(runRoot, 'destination');
  await Promise.all([mkdir(workspace), mkdir(destination)]);
  const fixture = await createFixture(path.join(runRoot, 'fixture'));
  await writeFile(path.join(workspace, 'history.json'), JSON.stringify({ version: 1, jobs: [{
    id: 'saved-image-job', mode: 'deleted', sourceLabel: '이전 이미지 작업', sourceKind: 'image', sourceIdentity: 'fixture-before-restart',
    createdAt: '2026-01-01T00:00:00.000Z', status: 'results', complete: true, candidateCount: 1, filters: { name: '삭제된 문서' }, outputPath: path.join(workspace, 'old-job')
  }] }));
  const screenshot = process.env.RECOVERY_ELECTRON_TOOLS_SCREENSHOT || path.join(root, 'output', 'playwright', 'recovery-packaged-tools-history.png');
  await mkdir(path.dirname(screenshot), { recursive: true });
  let electronApp;
  try {
    electronApp = await _electron.launch({ executablePath: finalPackagedApp, args: appArgs, env: { ...process.env, RECOVERY_WORKSPACE: workspace } });
    await electronApp.evaluate(({ dialog }, paths) => {
      dialog.showOpenDialog = async (_window, options) => ({ canceled: false, filePaths: options.properties.includes('openFile') ? [paths.image] : [paths.destination] });
    }, { image: fixture.imagePath, destination });
    const page = await electronApp.firstWindow();
    page.setDefaultTimeout(10_000);
    await page.waitForLoadState('domcontentloaded');
    await page.getByText('데스크톱 연결됨', { exact: true }).waitFor({ state: 'visible' });
    await page.getByRole('button', { name: '도구 · 안내', exact: true }).click();
    await page.getByRole('heading', { name: '작업 도구', exact: true }).waitFor({ state: 'visible' });
    await page.getByRole('button', { name: '지원 범위 · 버전 · 오픈소스', exact: true }).click();
    await page.getByRole('heading', { name: /지원 범위 ·/ }).waitFor({ state: 'visible' });
    await page.getByText(/작업 기록 위치:/).waitFor({ state: 'visible' });
    await page.locator('#app-dialog').getByRole('button', { name: '닫기', exact: true }).click();
    await page.getByRole('button', { name: '도구 · 안내', exact: true }).click();
    await page.getByRole('button', { name: '이전 작업 기록', exact: true }).click();
    await page.getByRole('heading', { name: '이전 작업 기록', exact: true }).waitFor({ state: 'visible' });
    await page.getByRole('button', { name: /이전 이미지 작업/ }).click();
    await page.getByRole('heading', { name: '검색할 내용을 확인해 주세요', exact: true }).waitFor({ state: 'visible' });
    await page.screenshot({ path: screenshot });
    assert.match(await page.locator('body').innerText(), /원래 위치/);
    // CDP keyboard events bypass Electron before-input-event; use its native input path.
    const zoomKey = async key => {
      await electronApp.evaluate(({ BrowserWindow }, key) => { const w=BrowserWindow.getAllWindows()[0];w.focus();w.webContents.sendInputEvent({type:'keyDown',keyCode:key,modifiers:['control']});w.webContents.sendInputEvent({type:'keyUp',keyCode:key,modifiers:['control']}); }, key);
      await page.waitForTimeout(50);
    };
    for (let index = 0; index < 4; index++) await zoomKey('=');
    assert.equal(await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor()), 2);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, '200% zoom must keep the page within the window');
    await zoomKey('0');
    assert.equal(await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor()), 1);
  } finally {
    await electronApp?.close().catch(() => {});
    await rm(runRoot, { recursive: true, force: true });
  }
});
