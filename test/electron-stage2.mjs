import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createFixture } from './ntfs-fixtures.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidenceRoot = process.env.RECOVERY_STAGE2_EVIDENCE || 'E:\\RecoveryChat-Stage2-20260920';
const testsRoot = path.join(evidenceRoot, 'tests');
const desktopRoot = path.join(evidenceRoot, 'desktop');
const executablePath = process.env.RECOVERY_PACKAGED_APP
  || path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
const { _electron } = createRequire(import.meta.url)(process.env.RECOVERY_PLAYWRIGHT_MODULE || 'playwright');

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const normalized = value => path.resolve(value).toLowerCase();
const isInside = (parent, child) => {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};

async function closeOwnedElectron(application) {
  if (!application) return;
  const child = application.process();
  const closed = await Promise.race([
    application.close().then(() => true, () => true),
    new Promise(resolve => setTimeout(() => resolve(false), 3_000)),
  ]);
  if (!closed && child.exitCode === null) child.kill();
  if (child.exitCode === null) {
    await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 3_000))]);
  }
}

test('Stage 2 acquires, verifies, selects and searches a real fixed NTFS image through Electron', { timeout: 120_000 }, async () => {
  await Promise.all([mkdir(testsRoot, { recursive: true }), mkdir(desktopRoot, { recursive: true })]);
  const runRoot = await mkdtemp(path.join(testsRoot, 'stage2-'));
  const fixture = await createFixture(path.join(runRoot, 'fixture'));
  const workspace = path.join(runRoot, 'workspace-runtime');
  const destination = path.join(runRoot, 'acquired-images');
  const screenshots = path.join(desktopRoot, path.basename(runRoot));
  await Promise.all([mkdir(workspace), mkdir(destination), mkdir(screenshots, { recursive: true })]);
  const originalHash = sha256(await readFile(fixture.imagePath));
  let application;
  try {
    application = await _electron.launch({
      executablePath,
      args: process.env.RECOVERY_PACKAGED_APP ? [] : [projectRoot],
      env: { ...process.env, RECOVERY_WORKSPACE: workspace, TZ: 'Asia/Seoul' },
    });
    await application.evaluate(({ app, dialog }, paths) => {
      const require = process.mainModule.require.bind(process.mainModule);
      const nodePath = require('node:path');
      const engineRoot = app.isPackaged
        ? nodePath.join(process.resourcesPath, 'app.asar.unpacked', 'engine')
        : nodePath.join(app.getAppPath(), 'engine');
      const { RecoveryJobs } = require(nodePath.join(engineRoot, 'job-service.mjs'));
      const { AcquisitionService } = require(nodePath.join(engineRoot, 'acquisition-service.mjs'));
      const originalAddDestination = RecoveryJobs.prototype.addDestination;
      const originalReadiness = RecoveryJobs.prototype.sourceReadiness;
      const originalSearch = RecoveryJobs.prototype.start;
      const originalAcquire = AcquisitionService.prototype.start;
      const evidence = globalThis.__stage2Test = {
        acquisitionStarts: [], readiness: [], searchStarts: [], pickerCalls: [], delayedReads: 0, metadataCalls: [],
      };

      RecoveryJobs.prototype.addDestination = async function stage2Destination(selectedPath) {
        // Storage topology discovery is the only metadata mock in this test. The
        // selected files and all subsequent acquisition/search bytes stay real.
        this.inspect = async target => {
          const canonicalPath = nodePath.resolve(target);
          evidence.metadataCalls.push(canonicalPath);
          return {
            canonicalPath, identity: `stage2-storage:${nodePath.parse(canonicalPath).root.toLowerCase()}`,
            diskIds: ['stage2-evidence-disk'], physicalDiskIdentities: ['stage2-evidence-disk'],
            fileSystem: 'NTFS', freeSpace: 64 * 1024 ** 3,
          };
        };
        return originalAddDestination.call(this, selectedPath);
      };

      RecoveryJobs.prototype.sourceReadiness = async function stage2Readiness(request) {
        const result = await originalReadiness.call(this, request);
        evidence.readiness.push({ request, overall: result.overall, acquisition: result.acquisition });
        return result;
      };
      RecoveryJobs.prototype.start = async function stage2Search(request) {
        evidence.searchStarts.push({ ...request, filters: { ...(request.filters || {}) } });
        return originalSearch.call(this, request);
      };
      AcquisitionService.prototype.start = async function stage2Acquire(request) {
        evidence.acquisitionStarts.push({ ...request });
        if (!this.__stage2DelayedOpen) {
          this.__stage2DelayedOpen = true;
          const actualOpen = this.openImage.bind(this);
          this.openImage = async selectedPath => {
            const reader = await actualOpen(selectedPath);
            const actualRead = reader.read.bind(reader);
            reader.read = async (...args) => {
              evidence.delayedReads += 1;
              await new Promise(resolve => setTimeout(resolve, 175));
              return actualRead(...args);
            };
            return reader;
          };
        }
        return originalAcquire.call(this, request);
      };
      dialog.showOpenDialog = async (_window, options) => {
        const openFile = options?.properties?.includes('openFile');
        const selected = openFile ? paths.image : paths.destination;
        evidence.pickerCalls.push({ title: options?.title, properties: options?.properties, selected });
        return { canceled: false, filePaths: [selected] };
      };
    }, { image: fixture.imagePath, destination });

    const page = await application.firstWindow();
    page.setDefaultTimeout(20_000);
    const pageErrors = [];
    const consoleErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    await page.getByText('데스크톱 연결됨', { exact: true }).waitFor();

    const runtime = await application.evaluate(({ app }) => ({
      temp: app.getPath('temp'), userData: app.getPath('userData'), sessionData: app.getPath('sessionData'),
      logs: app.getPath('logs'), crashDumps: app.getPath('crashDumps'),
      envTemp: process.env.TEMP, envTmp: process.env.TMP,
    }));
    for (const [name, target] of Object.entries(runtime)) {
      assert.ok(isInside(workspace, target), `${name} must stay in the selected runtime workspace: ${target}`);
    }
    assert.equal(normalized(runtime.temp), normalized(path.join(workspace, 'temp')));
    assert.equal(normalized(runtime.envTemp), normalized(runtime.temp));
    assert.equal(normalized(runtime.envTmp), normalized(runtime.temp));

    const advanced = page.locator('#search-options-details');
    await advanced.locator('summary').click();
    assert.equal(await advanced.evaluate(element => element.open), true);
    await page.locator('#program-image').click();
    await page.waitForFunction(source => document.querySelector('#program-source option:checked')?.textContent === source, fixture.imagePath);

    await page.getByRole('button', { name: '도구 · 안내', exact: true }).click();
    await page.getByRole('button', { name: '원본 보관 · 이미지', exact: true }).click();
    await page.getByRole('button', { name: '현재 선택한 위치 보관하기', exact: true }).click();
    const confirmation = page.getByRole('dialog');
    await confirmation.getByText('원본을 이미지로 보관하기', { exact: true }).waitFor();
    assert.match(await confirmation.innerText(), /원본 크기: 4 MB/);
    assert.match(await confirmation.innerText(), new RegExp(destination.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
    const readinessEvidence = await application.evaluate(() => globalThis.__stage2Test.readiness);
    assert.equal(readinessEvidence.length, 1, 'the confirmation must be backed by the real source-readiness service');
    assert.notEqual(readinessEvidence[0].overall, 'blocked');

    await confirmation.getByRole('button', { name: '전체 이미지 만들기', exact: true }).click();
    await page.getByText('작업 중에는 모드를 전환할 수 없어요', { exact: true }).waitFor();
    assert.equal(await page.locator('button[data-view-mode="chat"]').isDisabled(), true);
    await page.waitForFunction(() => /원본 보관 중|보관본 검사 중/.test(document.querySelector('#acquisition-status')?.textContent || ''));
    assert.match(await page.locator('#acquisition-status').innerText(), /원본 보관 중|보관본 검사 중/);
    await page.screenshot({ path: path.join(screenshots, '01-acquiring-mode-locked.png'), animations: 'disabled', fullPage: true });

    const useAcquired = page.locator('#acquisition-status').getByRole('button', { name: '보관 이미지에서 파일 찾기', exact: true });
    await useAcquired.waitFor({ state: 'visible' });
    const acquisitionState = await page.evaluate(() => window.recoveryAPI.state());
    assert.equal(acquisitionState.acquisitions.items.length, 1);
    const acquisition = acquisitionState.acquisitions.items[0];
    assert.equal(acquisition.status, 'complete');
    assert.equal(acquisition.summary.complete, true);
    assert.equal(acquisition.summary.readErrorCount, 0);
    assert.equal(acquisition.summary.sha256, originalHash);
    const acquiredImage = path.join(acquisition.outputDirectory, 'image.raw');
    const manifest = JSON.parse(await readFile(path.join(acquisition.outputDirectory, 'acquisition.json'), 'utf8'));
    assert.equal(manifest.image.readbackVerified, true);
    assert.equal(manifest.image.sha256, originalHash);
    assert.equal(sha256(await readFile(acquiredImage)), originalHash, 'the acquired bytes must match the fixed source');
    assert.equal(sha256(await readFile(fixture.imagePath)), originalHash, 'acquisition must preserve the original fixture');
    assert.ok((await application.evaluate(() => globalThis.__stage2Test.delayedReads)) > 0, 'the real image reader must carry the acquisition bytes');
    await page.screenshot({ path: path.join(screenshots, '02-acquisition-complete.png'), animations: 'disabled', fullPage: true });

    await useAcquired.click();
    await page.getByText('보관 이미지 검증을 마쳤어요. 이 이미지에서 파일을 찾을 수 있어요.', { exact: true }).waitFor();
    await page.waitForFunction(source => document.querySelector('#program-source option:checked')?.textContent === source, acquiredImage);
    assert.equal(await page.locator('body').getAttribute('data-view-mode'), 'program');

    await page.locator('#program-start').click();
    await page.waitForFunction(() => {
      const fallback = document.querySelector('#search-all-records');
      const hasCandidates = document.querySelectorAll('#candidate-list [data-candidate-id], #candidate-list article.candidate').length > 0;
      return document.querySelector('#activity-indicator')?.hidden
        && (hasCandidates || fallback && !fallback.hidden && !fallback.disabled);
    });
    if (await page.locator('#search-all-records').isVisible()) await page.locator('#search-all-records').click();
    await page.waitForFunction(() => {
      const count = Number.parseInt(document.querySelector('#results-count')?.textContent || '0', 10);
      return count > 0 && document.querySelectorAll('#candidate-list [data-candidate-id], #candidate-list article.candidate').length > 0
        && document.querySelector('#activity-indicator')?.hidden;
    });
    const finalState = await page.evaluate(() => window.recoveryAPI.state());
    const imageJob = finalState.jobs.find(job => job.label === acquiredImage && job.candidateCount > 0);
    assert.ok(imageJob, 'a real worker must report candidates from the acquired and verified image');
    assert.equal(imageJob.sourceKind, 'image');
    assert.ok(imageJob.candidateCount > 0);
    assert.ok((await application.evaluate(() => globalThis.__stage2Test.searchStarts.length)) >= 1,
      'the program start action must use the real search service');
    assert.equal(sha256(await readFile(fixture.imagePath)), originalHash, 'search must also preserve the original fixture');
    assert.equal(sha256(await readFile(acquiredImage)), originalHash, 'search must preserve the verified acquisition image');
    await page.screenshot({ path: path.join(screenshots, '03-real-worker-candidates.png'), animations: 'disabled', fullPage: true });

    assert.deepEqual(pageErrors, []);
    assert.deepEqual(consoleErrors, []);
  } finally {
    await closeOwnedElectron(application);
  }
});
