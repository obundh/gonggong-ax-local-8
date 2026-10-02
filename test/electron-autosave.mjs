import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { _electron } = createRequire(import.meta.url)(process.env.RECOVERY_PLAYWRIGHT_MODULE || 'playwright');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function filesAt(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await filesAt(full)); else result.push(full);
  }
  return result;
}

for (const mode of ['program', 'chat']) test(`actual Electron autosave ${mode}: aggregate, preview, copy and provenance`, { timeout: 90000 }, async () => {
  const evidence = process.env.RECOVERY_AUTOSAVE_EVIDENCE || 'E:/RecoveryChat-Autosave-0520-20260927/desktop';
  await mkdir(evidence, { recursive: true });
  const run = await mkdtemp(path.join(evidence, `${mode}-`));
  const word = path.join(run, 'Word'), excel = path.join(run, 'Excel'), destination = path.join(run, 'results');
  await Promise.all([mkdir(word), mkdir(excel), mkdir(destination)]);
  const inputs = [
    [word, '회의 메모.txt', '자동 저장 사본 시험 본문'], [word, '예전 메모.txt', '이전 사본 시험'],
    [word, '임시.asd', '형식 미확인 시험 자료'], [excel, '예산.csv', '항목,금액\n검증,100'],
    [excel, '임시.tmp', '임시 조각 시험'],
  ];
  for (const [directory, name, body] of inputs) await writeFile(path.join(directory, name), body, { flag: 'wx' });
  await writeFile(path.join(word, '~$소유자.docx'), 'owner');
  await writeFile(path.join(excel, 'excluded.exe'), 'not a document');
  const locations = [{ path: word, app: 'Word', name: '자동 복구', exists: true }, { path: excel, app: 'Excel', name: '자동 복구', exists: true }];
  const application = await _electron.launch({ executablePath: process.env.RECOVERY_PACKAGED_APP || path.join(root, 'node_modules/electron/dist/electron.exe'),
    args: process.env.RECOVERY_PACKAGED_APP ? [] : [root], env: { ...process.env, RECOVERY_WORKSPACE: path.join(run, 'workspace') } });
  try {
    // Only the configured Office locations and native folder choice are test
    // inputs. Candidate inventory, IPC, worker, preview and copy are real.
    await application.evaluate(({ dialog }, fixture) => {
      const require = process.mainModule.require.bind(process.mainModule);
      const { RecoveryJobs } = require(fixture.engine);
      const original = RecoveryJobs.prototype.autosaveSource;
      RecoveryJobs.prototype.autosaveSource = function () { this.autosaveInventory = async () => fixture.locations; return original.call(this); };
      globalThis.autosavePickerCount = 0;
      dialog.showOpenDialog = async () => { globalThis.autosavePickerCount++; return { canceled: false, filePaths: [fixture.destination] }; };
    }, { locations, destination, engine: process.env.RECOVERY_PACKAGED_APP
      ? path.join(path.dirname(process.env.RECOVERY_PACKAGED_APP), 'resources/app.asar.unpacked/engine/job-service.mjs')
      : path.join(root, 'engine/job-service.mjs') });
    const page = await application.firstWindow(), errors = [];
    page.on('pageerror', error => { errors.push(error.message); console.error('renderer:', error.message); }); page.setDefaultTimeout(20000);
    await page.getByText('데스크톱 연결됨', { exact: true }).waitFor();
    if (mode === 'chat') await page.locator('button[data-view-mode=chat]').click();
    // A previous deletion-period selection must not hide current copies.
    await page.evaluate(() => {
      document.querySelector('#deleted-after').value = '2020-01-01';
      document.querySelector('#deleted-before').value = '2020-01-02';
      document.querySelector('#include-unknown-date').checked = false;
    });
    await page.getByRole('button', { name: '도구 · 안내', exact: true }).click();
    await page.getByRole('button', { name: '저장하지 못한 문서 · 자동 저장본', exact: true }).click();
    await page.getByRole('button', { name: '자동 저장 위치 한 번에 찾기', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('[data-candidate-id]').length === 5);
    await page.getByRole('button', { name: '사본 저장', exact: true }).first().waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent === '사본 저장' && !b.disabled));
    assert.equal(await application.evaluate(() => globalThis.autosavePickerCount), 0, 'list first without an output picker');
    assert.equal(await page.locator('#sort').inputValue(), 'modified-desc');
    assert.match(await page.locator('#deletion-time-note').innerText(), /原本|원본과의 관계·최신 버전 여부는 미확인/);
    assert.doesNotMatch(await page.locator('#candidate-list').innerText(), /삭제 시각 미확인|excluded.exe|~\$/);
    const card = page.locator('[data-candidate-id]').filter({ hasText: '회의 메모.txt' });
    assert.match(await card.innerText(), /Word · 자동 복구/);
    await card.getByRole('button', { name: '정보 · 미리보기', exact: true }).click();
    await page.getByText('자동 저장 사본 시험 본문', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(run, 'candidates-preview.png') });
    await card.getByRole('button', { name: '사본 저장', exact: true }).click();
    const result = page.locator('[data-result-id]').filter({ hasText: '회의 메모.txt' });
    await result.waitFor();
    assert.match(await result.innerText(), /자동 저장 위치의 사본 저장 · Word · 원본과의 관계·최신 버전 여부 미확인/);
    assert.doesNotMatch(await result.innerText(), /삭제 전 원본 바이트 일치 확인|문서 열림 확인/);
    const outputs = (await filesAt(destination)).filter(file => file.endsWith('회의 메모.txt'));
    assert.equal(outputs.length, 1);
    assert.equal(sha(await readFile(outputs[0])), sha(Buffer.from(inputs[0][2])));
    for (const [directory, name, body] of inputs) assert.equal(sha(await readFile(path.join(directory, name))), sha(Buffer.from(body)));
    assert.equal(await application.evaluate(() => globalThis.autosavePickerCount), 1);
    assert.deepEqual(errors, []);
    await result.scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(run, 'saved-copy.png') });
    await writeFile(path.join(run, 'receipt.json'), JSON.stringify({ status: 'passed', mode,
      packaged: Boolean(process.env.RECOVERY_PACKAGED_APP), fixtureOfficeRoots: true, nativePickerChoiceMocked: true,
      actualIPC: true, actualWorker: true, actualInventory: true, actualCopy: true,
      eligibleFiles: 5, candidatesFound: 5, exactCopies: 1, inputsUnchanged: true,
      liveDeletion: false, originalRecoveryClaimed: false, output: outputs[0] }, null, 2));
  } catch (error) {
    const page = await application.firstWindow();
    await writeFile(path.join(run, 'failure.txt'), await page.locator('body').innerText());
    await page.screenshot({ path: path.join(run, 'failure.png') });
    throw error;
  } finally { await application.close(); }
});
