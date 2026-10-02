import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = process.env.RECOVERY_PACKAGED_APP || path.join(root, 'dist', 'win-unpacked', '공공 AX 로컬 시리즈 8 - 파일 복구.exe');
const args = process.env.RECOVERY_APP_ENTRY ? [process.env.RECOVERY_APP_ENTRY] : [];
const { _electron } = createRequire(import.meta.url)(process.env.RECOVERY_PLAYWRIGHT_MODULE || 'playwright');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixturePair(bin, token, name, date, payload) {
  const originalPath = 'C:\\Users\\Synthetic\\Documents\\' + name;
  const encoded = Buffer.from(originalPath + '\0', 'utf16le');
  const metadata = Buffer.alloc(28 + encoded.length);
  metadata.writeBigUInt64LE(2n, 0); metadata.writeBigUInt64LE(BigInt(payload.length), 8);
  metadata.writeBigUInt64LE((BigInt(Date.parse(date)) + 11644473600000n) * 10000n, 16);
  metadata.writeUInt32LE(encoded.length / 2, 24); encoded.copy(metadata, 28);
  const metadataPath = path.join(bin, '$I' + token + '.txt');
  const payloadPath = path.join(bin, '$R' + token + '.txt');
  await Promise.all([writeFile(metadataPath, metadata), writeFile(payloadPath, payload)]);
  return { name, originalPath, metadataPath, payloadPath, metadataHash: hash(metadata), payloadHash: hash(payload) };
}

async function descendants(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await descendants(target));
    else files.push(target);
  }
  return files;
}

test('actual Electron Recycle Bin list preserves candidates after picker cancellation and double-click saves unchanged source bytes', {
  timeout: 60000,
  skip: path.isAbsolute(executable) && existsSync(executable) ? false : 'Set RECOVERY_PACKAGED_APP to the built executable.',
}, async () => {
  const temporary = path.resolve(os.tmpdir());
  const runRoot = await mkdtemp(path.join(temporary, 'recovery-electron-recycle-'));
  const workspace = path.join(runRoot, 'runtime');
  const destination = path.join(runRoot, 'destination');
  const bin = path.join(runRoot, '$Recycle.Bin', 'S-1-5-21-100-200-300-1001');
  await Promise.all([mkdir(workspace), mkdir(destination), mkdir(bin, { recursive: true })]);
  const newest = await fixturePair(bin, 'NEW123', '최근 삭제 문서.txt', '2026-09-13T05:00:00Z', Buffer.from('합성 휴지통 파일: 실제 IPC와 Worker로 저장합니다.\n'));
  const older = await fixturePair(bin, 'OLD123', '이전 삭제 문서.txt', '2026-09-12T05:00:00Z', Buffer.from('Older synthetic entry.\n'));
  const originalFiles = (await readdir(bin)).sort();
  let electron;
  try {
    electron = await _electron.launch({ executablePath: executable, args, env: { ...process.env, TZ: 'Asia/Seoul', RECOVERY_WORKSPACE: workspace } });
    await electron.evaluate(({ app, dialog }, fixture) => {
      // Electron's debugger evaluation can stall import(); require() shares the
      // native ESM module cache for this synchronous production module.
      const nativeRequire = process.mainModule.require.bind(process.mainModule);
      const path = nativeRequire('node:path');
      const engineRoot = app.isPackaged ? path.join(process.resourcesPath, 'app.asar.unpacked', 'engine') : path.join(app.getAppPath(), 'engine');
      const { RecoveryJobs } = nativeRequire(path.join(engineRoot, 'job-service.mjs'));
      const original = RecoveryJobs.prototype.recycleSource;
      RecoveryJobs.prototype.recycleSource = async function () {
        this.recycleInventory = async () => ({ roots: [{ path: fixture.bin }], warnings: [] });
        return original.call(this);
      };
      globalThis.__recycleElectronTest = { pickerCalls: 0, cancelPicker: true };
      dialog.showOpenDialog = async (_window, options) => {
        if (!options?.properties?.includes('openDirectory')) throw new Error('Only the destination directory picker is expected.');
        globalThis.__recycleElectronTest.pickerCalls++;
        return globalThis.__recycleElectronTest.cancelPicker ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [fixture.destination] };
      };
    }, { bin: await realpath(bin), destination });
    const page = await electron.firstWindow();
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.getByText('데스크톱 연결됨', { exact: true }).waitFor();
    await page.getByRole('button', { name: /^최근 삭제된 파일 보기/ }).click();
    await page.getByRole('button', { name: '휴지통에도 없어요 · 삭제 기록 찾기', exact: true }).waitFor();
    await page.getByLabel(newest.name + ' 선택').waitFor();
    assert.deepEqual(await page.locator('article.candidate .candidate-name').allTextContents(), [newest.name, older.name]);
    assert.equal(await page.locator('#sort').inputValue(), 'deleted-desc');
    assert.match(await page.locator('article.candidate').first().innerText(), /휴지통으로 이동/);
    assert.equal(await electron.evaluate(() => globalThis.__recycleElectronTest.pickerCalls), 0, 'listing must not ask for a destination');
    assert.deepEqual(await readdir(destination), []);
    const current = await page.evaluate(async () => {
      const state = await window.recoveryAPI.state();
      const job = state.jobs.find(item => item.mode === 'recycle');
      if (!job) throw new Error('The actual recycle job was not registered.');
      return window.recoveryAPI.candidates({ jobId: job.id, sort: 'deleted-desc', limit: 5 });
    });
    assert.equal(current.items[0].source, 'recycle-bin');
    assert.equal(current.items[0].deletedAtSource, 'recycle-metadata');
    assert.equal(current.items[0].originalPath, newest.originalPath);

    const newestName = () => page.locator('article.candidate').filter({ has: page.getByLabel(newest.name + ' 선택') }).locator('.candidate-name');
    await newestName().dblclick();
    await page.waitForFunction(() => document.querySelectorAll('article.candidate').length === 2 && [...document.querySelectorAll('article.candidate button')].some(button => button.textContent === '저장' && !button.disabled));
    assert.equal(await electron.evaluate(() => globalThis.__recycleElectronTest.pickerCalls), 1);
    assert.deepEqual(await page.locator('article.candidate .candidate-name').allTextContents(), [newest.name, older.name], 'canceling the picker preserves the original list');
    assert.deepEqual(await readdir(destination), []);

    await electron.evaluate(() => { globalThis.__recycleElectronTest.cancelPicker = false; });
    await newestName().dblclick();
    await page.locator('.bubble', { hasText: '저장 처리가 끝났어요. 파일별 결과를 확인해주세요.' }).last().waitFor();
    assert.equal(await electron.evaluate(() => globalThis.__recycleElectronTest.pickerCalls), 2);
    const saved = (await descendants(destination)).filter(file => path.basename(file) === newest.name);
    assert.equal(saved.length, 1, 'one completed file is published with the original Korean filename');
    assert.equal(hash(await readFile(saved[0])), newest.payloadHash);
    assert.deepEqual((await readdir(bin)).sort(), originalFiles);
    for (const fixture of [newest, older]) {
      assert.equal(hash(await readFile(fixture.metadataPath)), fixture.metadataHash, 'original recycle metadata remains untouched');
      assert.equal(hash(await readFile(fixture.payloadPath)), fixture.payloadHash, 'original recycle payload remains untouched');
    }
    assert.deepEqual(errors, []);
  } finally {
    await electron?.close().catch(() => {});
    const relative = path.relative(temporary, path.resolve(runRoot));
    assert.ok(relative.startsWith('recovery-electron-recycle-') && !relative.includes(path.sep) && !path.isAbsolute(relative));
    await rm(runRoot, { recursive: true, force: true });
  }
});
