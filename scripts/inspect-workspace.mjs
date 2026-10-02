import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { _electron } = createRequire(import.meta.url)(process.env.RECOVERY_PLAYWRIGHT_MODULE || 'playwright');
const output = path.resolve(process.env.RECOVERY_VISUAL_OUTPUT || 'E:/RecoveryChat-Stage2-20260920/visual');
await mkdir(output, { recursive: true });
const app = await _electron.launch({ executablePath: process.env.RECOVERY_PACKAGED_APP || path.join(root, 'node_modules/electron/dist/electron.exe'),
  args: process.env.RECOVERY_PACKAGED_APP ? [] : [root], env: { ...process.env, RECOVERY_WORKSPACE: 'E:/RecoveryChat-Stage2-20260920/visual-workspace' } });
const errors = [];
try {
  const page = await app.firstWindow(); page.on('pageerror', err => errors.push(err.message));
  await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.webContents.setZoomFactor(1); win.setSize(1180, 900); });
  await page.locator('#journey-steps .journey-step').last().waitFor({ state: 'attached' });
  await page.getByText('데스크톱 연결됨', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, '01-workspace.png') });
  await page.locator('#journey-details > summary').click();
  await page.locator('#roadmap-nav').click();
  await page.screenshot({ path: path.join(output, '02-checklist.png') });
  await page.locator('[data-checklist-stage="2"]').click();
  await page.screenshot({ path: path.join(output, '03-next-stage.png') });
  await page.locator('#back-to-workspace').click();
  await page.locator('#journey-details > summary').click();
  let readiness = null;
  if (!process.argv.includes('--layout-only')) {
    await page.locator('#search-options-details > summary').click();
    await page.locator('#check-source-readiness').click();
    await page.locator('#app-dialog[open]').waitFor({ timeout: 180000 });
    await page.screenshot({ path: path.join(output, '04-source-readiness.png') });
    readiness = await page.locator('#app-dialog').innerText();
    await page.locator('[data-action="close-dialog"]').click();
    await page.locator('#search-options-details > summary').click();
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(390, 844));
  await page.screenshot({ path: path.join(output, '05-narrow.png') });
  const overflow = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
  await page.locator('#journey-details > summary').click();
  await page.locator('#roadmap-nav').click();
  await page.screenshot({ path: path.join(output, '06-narrow-checklist.png') });
  await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.setSize(1180, 900); win.webContents.setZoomFactor(2); });
  await page.screenshot({ path: path.join(output, '07-zoom-200.png') });
  const zoomOverflow = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('#back-to-workspace').click();
  await page.locator('#journey-details > summary').focus();
  await page.keyboard.press('Space');
  const keyboard = await page.evaluate(() => ({ outline: getComputedStyle(document.activeElement).outlineStyle, tag: document.activeElement.tagName, detailsOpen: document.querySelector('#journey-details').open }));
  const runtime = await app.evaluate(({ app }) => ({ version: app.getVersion(), packaged: app.isPackaged, temp: app.getPath('temp'), TEMP: process.env.TEMP, TMP: process.env.TMP }));
  await writeFile(path.join(output, 'inspection.json'), JSON.stringify({ errors, overflow, zoomOverflow, keyboard, runtime, readiness }, null, 2));
  if (errors.length || overflow.scroll > overflow.width || zoomOverflow.scroll > zoomOverflow.width || keyboard.outline === 'none') throw new Error('Rendered accessibility inspection needs correction.');
  console.log(JSON.stringify({ output, errors, overflow }));
} finally { await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(1)).catch(() => {}); await app.close(); }
