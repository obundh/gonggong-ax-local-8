import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixture } from './ntfs-fixtures.mjs';
import { createHwpFixture } from './hwp-carving-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { _electron } = createRequire(import.meta.url)(process.env.RECOVERY_PLAYWRIGHT_MODULE || 'playwright');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

test('packaged UI can discover, preview and save a nameless HWP from an actual synthetic NTFS free range', { timeout: 120000 }, async () => {
  const evidence = process.env.RECOVERY_HWP_EVIDENCE || 'E:/RecoveryChat-HwpCarving-0511-20260926/desktop';
  await mkdir(evidence, { recursive: true });
  const run = await mkdtemp(path.join(evidence, 'run-'));
  const workspace = path.join(run, 'workspace'), destination = path.join(run, 'destination');
  await mkdir(workspace); await mkdir(destination);
  const fixture = await createFixture(path.join(run, 'fixture'));
  const hwp = createHwpFixture().bytes;
  const image = await readFile(fixture.imagePath);
  hwp.copy(image, 100 * 4096); await writeFile(fixture.imagePath, image);
  const application = await _electron.launch({
    executablePath: process.env.RECOVERY_PACKAGED_APP || path.join(root, 'node_modules/electron/dist/electron.exe'),
    args: process.env.RECOVERY_PACKAGED_APP ? [] : [root], env: { ...process.env, RECOVERY_WORKSPACE: workspace },
  });
  try {
    await application.evaluate(({ app, dialog }, input) => {
      const require = process.mainModule.require.bind(process.mainModule), path = require('node:path');
      const { RecoveryJobs } = require(path.join(app.isPackaged ? path.join(process.resourcesPath, 'app.asar.unpacked') : app.getAppPath(), 'engine/job-service.mjs'));
      // Only pickers/inventory are fixtures. Keep real admission, workers, carving,
      // SQLite candidates, preview, selected save and output verification.
      RecoveryJobs.prototype.devices = async () => ({ devices: [] });
      const start = RecoveryJobs.prototype.start;
      RecoveryJobs.prototype.start = function (...args) { globalThis.__hwpService = this; return start.apply(this, args); };
      dialog.showOpenDialog = async (_window, options) => ({ canceled: false,
        filePaths: [options.properties.includes('openFile') ? input.image : input.destination] });
    }, { image: fixture.imagePath, destination });
    const page = await application.firstWindow(), errors = [];
    page.on('pageerror', e => errors.push(e.message)); page.setDefaultTimeout(25000);
    await page.getByText('데스크톱 연결됨', { exact: true }).waitFor();
    const options = page.locator('#search-options-details');
    if (!await options.evaluate(e => e.open)) await options.locator(':scope > summary').click();
    await page.locator('#program-image').click();
    await page.locator('[data-program-route="deep"]').click();
    await page.locator('#program-start').click();
    await page.waitForFunction(() => [...document.querySelectorAll('.candidate-name')].some(e => /\.hwp$/.test(e.textContent))
      && document.querySelector('#activity-indicator').hidden);
    const row = page.locator('article.candidate').filter({ has: page.locator('.candidate-name', { hasText: /\.hwp$/ }) });
    assert.equal(await row.count(), 1);
    assert.match(await row.innerText(), /carved-.*\.hwp/);
    await row.getByRole('button', { name: '정보 · 미리보기', exact: true }).click();
    await page.locator('#preview-content .preview-text').waitFor();
    assert.match(await page.locator('#preview-content').innerText(), /원래 이름.*별도 확인/);
    assert.doesNotMatch(await page.locator('#preview-content').innerText(), /signature:|structure:|cfb-allocation/);
    assert.ok((await page.locator('#preview-content .preview-text').innerText()).trim().length > 0);
    await page.screenshot({ path: path.join(run, 'hwp-carved-preview.png') });
    await row.getByRole('button', { name: '복구해서 저장', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#session-saved').textContent === '1'
      && document.querySelector('#activity-indicator').hidden);
    assert.equal((await page.locator('#session-verified').textContent()).trim(), '0');
    const results = await application.evaluate(() => [...globalThis.__hwpService.jobs.values()].flatMap(j => j.results));
    const saved = results.find(r => r.status === 'saved' && r.path?.endsWith('.hwp'));
    assert.ok(saved); assert.equal(sha(await readFile(saved.path)), sha(hwp));
    assert.equal(saved.document.originalIdentityVerified, false);
    assert.equal(saved.document.applicationOpenVerified, false);
    assert.equal(sha(await readFile(fixture.imagePath)), sha(image));
    await page.screenshot({ path: path.join(run, 'hwp-carved-saved.png') });
    assert.deepEqual(errors, []);
    await writeFile(path.join(run, 'receipt.json'), JSON.stringify({
      packaged: Boolean(process.env.RECOVERY_PACKAGED_APP), sourceSha256: sha(image), hwpSha256: sha(hwp), saved,
      realWorker: true, syntheticNtfs: true, physicalDeletionTest: false, mocked: ['file pickers', 'device list'],
    }, null, 2));
  } finally { await application.close(); }
});
