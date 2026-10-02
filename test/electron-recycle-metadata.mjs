import test from 'node:test';
import { metadataClue } from './recycle-presentation-fixture.mjs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { _electron } = createRequire(import.meta.url)(process.env.RECOVERY_PLAYWRIGHT_MODULE || 'playwright');
test('deleted recycle metadata is separate from body recovery and hands off the current drive', { timeout: 70000 }, async () => {
  const evidence = process.env.RECOVERY_STAGE4C_EVIDENCE || 'E:/RecoveryChat-Stage4c-20260926/desktop';
  await mkdir(evidence, { recursive: true });
  const workspace = await mkdtemp(path.join(evidence, 'workspace-'));
  const application = await _electron.launch({ executablePath: process.env.RECOVERY_PACKAGED_APP || path.join(root, 'node_modules/electron/dist/electron.exe'),
    args: process.env.RECOVERY_PACKAGED_APP ? [] : [root], env: { ...process.env, RECOVERY_WORKSPACE: workspace } });
  try {
    await application.evaluate(({ app, BrowserWindow, dialog }, suppliedClue) => {
      const require = process.mainModule.require.bind(process.mainModule), path = require('node:path');
      const { RecoveryJobs } = require(path.join(app.isPackaged ? path.join(process.resourcesPath, 'app.asar.unpacked') : app.getAppPath(), 'engine/job-service.mjs'));
      const data = globalThis.__stage4 = { requests: [], previews: 0, saves: 0, outputs: 0, batchRefreshes: 0, phase: 'idle' };
      const trace = suppliedClue;
      const send = value => BrowserWindow.getAllWindows()[0].webContents.send('recovery-event', value);
      RecoveryJobs.prototype.devices = async () => ({ devices: [{ id: 'fixture-c', label: '시험용 C:', kind: 'volume', fileSystem: 'NTFS', ready: true }] });
      RecoveryJobs.prototype.start = async request => {
        data.requests.push(request); const jobId = `trace-${data.requests.length}`;
        setTimeout(() => { data.phase = 'batch'; send({ type: 'candidate-batch', jobId, count: 1 }); }, 100);
        setTimeout(() => { data.phase = 'complete'; send({ type: 'complete', jobId, complete: true, warnings: [], stats: { candidatesFound: 1, recordCandidates: 0, deletionTraces: 0, recycleMetadata: { artifacts: 1, bodyAssociations: 0 } },
          coverage: { strategy: 'native-journal', requiresVacancyScan: true, partitions: [] } }); }, 1400);
        return { jobId };
      };
      RecoveryJobs.prototype.candidates = async () => {
        if (data.phase === 'batch') data.batchRefreshes++;
        return { items: [trace], total: 1, scannedTotal: 1, status: data.phase === 'complete' ? 'results' : 'scanning', unknownDeletedTimeTotal: 1, matchCounts: { none: 1 } };
      };
      RecoveryJobs.prototype.preview = async () => { data.previews++; throw Error('trace must not read content'); };
      RecoveryJobs.prototype.recover = async () => { data.saves++; throw Error('trace must not recover'); };
      RecoveryJobs.prototype.addDestination = async () => ({ id: 'out', label: '시험용 E:' });
      dialog.showOpenDialog = async () => { data.outputs++; return { canceled: false, filePaths: [app.getPath('userData')] }; };
    }, metadataClue());
    const page = await application.firstWindow(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.getByText('데스크톱 연결됨', { exact: true }).waitFor();
    await page.locator('#program-start').click();
    await page.waitForFunction(() => document.querySelector('article.candidate') && document.querySelector('#activity-indicator').hidden);
    const row = page.locator('article.candidate');
    assert.ok(await application.evaluate(() => globalThis.__stage4.batchRefreshes > 0), 'batch event must refresh while scan remains active');
    assert.equal(await row.locator('input[type=checkbox]').isDisabled(), true);
    assert.match(await row.innerText(), /휴지통 정보 단서/);
    assert.match(await row.innerText(), /크기 모름/);
    assert.equal(await row.getByText('복구해서 저장', { exact: true }).count(), 0);
    await row.locator('.candidate-name').dblclick();
    await page.locator('#preview-panel[data-state="metadata-only"]').waitFor();
    assert.match(await page.locator('#preview-content').innerText(), /저장하거나 미리 볼 본문이 없습니다/);
    assert.equal(await application.evaluate(() => globalThis.__stage4.previews + globalThis.__stage4.saves + globalThis.__stage4.outputs), 0);
    const detail = await page.locator('#preview-content').innerText();
    assert.match(detail, /예산 회의.pdf/); assert.match(detail, /41.0 KB/);
    assert.match(detail, /영구 삭제 시각은 아님/);
    assert.match(detail, /정보에 적힌 원래 위치/);
    await page.evaluate(async () => { await new Promise(requestAnimationFrame); await Promise.all(document.querySelector('#preview-content').getAnimations().map(a => a.finished)); });
    await page.screenshot({ path: path.join(evidence, 'recycle-metadata.png') });
    await row.getByText('같은 드라이브 정밀 검색', { exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#activity-indicator').hidden);
    const result = await application.evaluate(() => globalThis.__stage4);
    assert.equal(result.requests.length, 2); assert.equal(result.requests[1].mode, 'deep');
    assert.equal(result.requests[1].sourceId, result.requests[0].sourceId);
    assert.equal(result.requests[1].deepScope, 'unallocated'); assert.equal(result.outputs, 1);
    assert.deepEqual(errors, []);
  } finally { await application.close(); }
});
