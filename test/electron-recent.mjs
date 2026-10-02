import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createUsnFixture } from './usn-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packagedApp = process.env.RECOVERY_PACKAGED_APP || path.join(root, 'dist', 'win-unpacked', '공공 AX 로컬 시리즈 8 - 파일 복구.exe');
const executableReady = path.isAbsolute(packagedApp) && existsSync(packagedApp);
const { _electron } = createRequire(import.meta.url)(process.env.RECOVERY_PLAYWRIGHT_MODULE || 'playwright');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function findNamedFile(directory, name) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory() && entry.name !== 'previews') {
      const found = await findNamedFile(target, name);
      if (found) return found;
    } else if (entry.isFile() && entry.name === name) return target;
  }
  return null;
}

test('packaged recent-deletion route reads actual synthetic USN timestamps without a destination and double-click saves through its Worker', {
  skip: executableReady ? false : 'Build the packaged app or set RECOVERY_PACKAGED_APP to its absolute executable path.',
  timeout: 60_000
}, async () => {
  const runRoot = await mkdtemp(path.join(os.tmpdir(), 'recovery-electron-recent-'));
  const workspace = path.join(runRoot, 'workspace');
  const destination = path.join(runRoot, 'destination');
  await Promise.all([mkdir(workspace), mkdir(destination)]);
  const fixture = await createUsnFixture(path.join(runRoot, 'fixture'));
  const before = hash(await readFile(fixture.imagePath));
  let app;
  try {
    // The runtime workspace and every source/output file belong to this test.
    // The only native operation replaced is the file/directory picker. Initial
    // Get-Volume inventory may run; no raw-volume search is ever started.
    app = await _electron.launch({
      executablePath: packagedApp,
      args: process.env.RECOVERY_APP_ENTRY ? [process.env.RECOVERY_APP_ENTRY] : [],
      env: { ...process.env, TZ: 'Asia/Seoul', RECOVERY_WORKSPACE: workspace }
    });
    await app.evaluate(({ dialog }, paths) => {
      dialog.showOpenDialog = async (_window, options) => ({
        canceled: false,
        filePaths: options.properties.includes('openFile') ? [paths.image] : [paths.destination]
      });
    }, { image: fixture.imagePath, destination });
    const page = await app.firstWindow();
    page.setDefaultTimeout(15_000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.getByText('데스크톱 연결됨', { exact: true }).waitFor();
    await page.getByRole('button', { name: '휴지통 비운 뒤 파일 찾기', exact:true }).click();
    await page.getByRole('heading', { name: '최근 삭제된 파일부터 살펴볼까요?', exact: true }).waitFor();
    assert.equal(await page.locator('#clue-name').count(), 0, 'the recent route does not require a remembered filename');
    assert.equal(await page.getByRole('heading', { name: '파일이 원래 있던 곳을 골라주세요', exact: true }).count(), 0, 'the first recent scope is selected automatically');
    assert.deepEqual((await page.evaluate(() => window.recoveryAPI.state())).jobs, [], 'automatic scope selection does not start a raw-volume search');
    await page.getByRole('button', { name: /^검색 위치 바꾸기/ }).click();
    await page.getByRole('button', { name: /^디스크 이미지에서 찾을게요/ }).click();
    await page.getByRole('button', { name: /^최근 삭제 목록 검색/ }).click();
    await page.getByRole('button', { name: '검색 시작', exact: true }).click();
    await page.getByRole('button', { name: /원하는 파일 없음/ }).waitFor();
    await page.waitForFunction(() => {
      const names = [...document.querySelectorAll('.candidate-name')].map(element => element.textContent);
      return names[0] === 'contiguous.bin' && names[1] === '삭제된-문서.txt';
    });
    assert.equal(await page.locator('#sort').inputValue(), 'deleted-desc');
    await page.locator('#activity-indicator').waitFor({ state: 'hidden' });
    assert.deepEqual((await page.locator('.candidate-name').allTextContents()).slice(0, 2), ['contiguous.bin', '삭제된-문서.txt']);
    assert.ok((await page.locator('.deletion-time-heading').allTextContents()).includes('삭제 시각 미확인'), 'records without a retained journal event remain in a separate unknown group');
    const state = await page.evaluate(() => window.recoveryAPI.state());
    assert.equal(state.jobs.length, 1, 'only the synthetic image job was created');
    const job = state.jobs[0];
    assert.equal(job.sourceKind, 'image');
    assert.equal(job.recent, true);
    assert.equal(job.mode, 'deleted');
    const results = await page.evaluate(jobId => window.recoveryAPI.candidates({ jobId, filters: {}, sort: 'deleted-desc', offset: 0, limit: 100 }), job.id);
    assert.ok(results.total >= 3);
    assert.equal(results.items[0].recordNumber, 25);
    assert.equal(results.items[1].recordNumber, 24);
    assert.equal(results.items[0].deletedAt, fixture.deletionTimes.get('ntfs:25:4'));
    assert.equal(results.items[1].deletedAt, fixture.deletionTimes.get('ntfs:24:7'));
    assert.ok(results.items.slice(2).every(candidate => candidate.deletedAt === null), 'modification dates are never used as missing deletion timestamps');
    const card = page.locator('article.candidate').filter({ has: page.getByLabel('삭제된-문서.txt 선택', { exact: true }) });
    assert.match(await card.locator('.deletion-time').innerText(), /2026\. 9\. 12\./);
    const screenshot = path.join(root, 'output', 'playwright', 'recovery-packaged-recent.png');
    await mkdir(path.dirname(screenshot), { recursive: true });
    await page.locator('#candidate-list').screenshot({ path: screenshot });
    await card.locator('.candidate-name').dblclick();
    await page.locator('.bubble', { hasText: '저장 처리가 끝났어요. 파일별 결과를 확인해주세요.' }).last().waitFor();
    await page.locator('#activity-indicator').waitFor({ state: 'hidden' });
    const recovered = await findNamedFile(destination, '삭제된-문서.txt');
    assert.ok(recovered, 'the real Worker must publish the selected recovered file in this test destination');
    const expected = fixture.manifest.files.find(candidate => candidate.recordNumber === 24);
    assert.equal(hash(await readFile(recovered)), expected.sha256, 'recovered bytes match the known synthetic original');
    assert.equal(hash(await readFile(fixture.imagePath)), before, 'the synthetic source image remains unchanged');
    assert.deepEqual(errors, [], 'the packaged recent-deletion workflow must not produce renderer errors');
  } finally {
    await app?.close().catch(() => {});
    const cleanupTarget = path.resolve(runRoot);
    assert.equal(path.dirname(cleanupTarget).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(cleanupTarget).startsWith('recovery-electron-recent-'));
    await rm(cleanupTarget, { recursive: true, force: true });
  }
});
