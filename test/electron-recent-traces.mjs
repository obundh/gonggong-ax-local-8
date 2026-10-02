import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWindowsShortcut } from './recent-shortcut-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { _electron } = createRequire(import.meta.url)(process.env.RECOVERY_PLAYWRIGHT_MODULE || 'playwright');
for (const mode of ['program', 'chat']) test(`recent document clues in ${mode}: actual Windows shortcut and worker, no save or target access`, { skip: process.platform !== 'win32', timeout: 90000 }, async () => {
  const evidence = process.env.RECOVERY_RECENT_TRACE_EVIDENCE || 'E:/RecoveryChat-TenStage-0600-20260927/recent-desktop';
  await mkdir(evidence, { recursive: true });
  const run = await mkdtemp(path.join(evidence, `${mode}-`)), recent = path.join(run, 'Recent');
  await mkdir(recent);
  const target = path.join(run, '회의 자료.txt'), moved = path.join(run, 'moved.txt');
  await writeFile(target, 'Test-owned document; target must not be read by trace search');
  await createWindowsShortcut(path.join(recent, '회의 자료.lnk'), target);
  await rename(target, moved);
  const application = await _electron.launch({ executablePath: process.env.RECOVERY_PACKAGED_APP || path.join(root, 'node_modules/electron/dist/electron.exe'),
    args: process.env.RECOVERY_PACKAGED_APP ? [] : [root], env: { ...process.env, RECOVERY_WORKSPACE: path.join(run, 'workspace') } });
  try {
    await application.evaluate(({ dialog }, fixture) => {
      const require = process.mainModule.require.bind(process.mainModule), { RecoveryJobs } = require(fixture.engine);
      const original = RecoveryJobs.prototype.recentSource;
      RecoveryJobs.prototype.recentSource = function () { this.recentInventory = async () => ({ path: fixture.recent, status: 'existing', exists: true, error: null }); return original.call(this); };
      globalThis.recentPickerCount = 0;
      dialog.showOpenDialog = async () => { globalThis.recentPickerCount++; return { canceled: true, filePaths: [] }; };
    }, { recent, engine: process.env.RECOVERY_PACKAGED_APP
      ? path.join(path.dirname(process.env.RECOVERY_PACKAGED_APP), 'resources/app.asar.unpacked/engine/job-service.mjs')
      : path.join(root, 'engine/job-service.mjs') });
    const page = await application.firstWindow(), errors = [];
    page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(20000);
    await page.getByText('데스크톱 연결됨', { exact: true }).waitFor();
    if (mode === 'chat') await page.locator('button[data-view-mode=chat]').click();
    await page.getByRole('button', { name: '도구 · 안내', exact: true }).click();
    await page.getByRole('button', { name: '최근 문서 이름·경로 단서', exact: true }).click();
    await page.getByRole('button', { name: '이름·경로 단서 찾기', exact: true }).click();
    const card = page.locator('[data-candidate-id]').filter({ hasText: '회의 자료.txt' });
    await card.waitFor();
    assert.match(await card.innerText(), /최근 문서 바로가기/);
    assert.match(await card.innerText(), /경로 단서 · 본문 없음/);
    assert.match(await card.innerText(), /삭제·열람 시각 아님/);
    assert.equal(await card.locator('input[type=checkbox]').isDisabled(), true);
    assert.equal(await card.getByRole('button', { name: /저장|위치 열기/ }).count(), 0);
    await card.getByRole('button', { name: '정보 · 미리보기', exact: true }).click();
    const preview = page.locator('#preview-content');
    assert.match(await preview.innerText(), /문서 본문이 없습니다/);
    assert.match(await preview.innerText(), /삭제 여부\s*확인하지 않음/);
    assert.equal(await preview.locator('.preview-save').count(), 0);
    assert.equal(await application.evaluate(() => globalThis.recentPickerCount), 0);
    assert.equal(await readFile(moved, 'utf8'), 'Test-owned document; target must not be read by trace search');
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(run, 'recent-clue.png') });
    await writeFile(path.join(run, 'receipt.json'), JSON.stringify({ status: 'passed', mode, packaged: Boolean(process.env.RECOVERY_PACKAGED_APP),
      actualIPC: true, actualWorker: true, windowsCreatedShortcut: true, rootLocationInjected: true,
      targetMovedBeforeSearch: true, targetBodyUnchanged: true, candidateCount: 1, savedFiles: 0,
      originalRecoveryClaimed: false, targetExistence: 'not-checked', screenshot: 'recent-clue.png' }, null, 2));
  } catch (error) {
    const page = await application.firstWindow();
    await writeFile(path.join(run, 'failure.txt'), await page.locator('body').innerText());
    await page.screenshot({ path: path.join(run, 'failure.png') }); throw error;
  } finally { await application.close(); }
});
