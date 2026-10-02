import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { damagedZip, localZipEntry, textXml } from './partial-zip-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { _electron } = createRequire(import.meta.url)(process.env.RECOVERY_PLAYWRIGHT_MODULE || 'playwright');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function filesAt(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await filesAt(full));
    else result.push(full);
  }
  return result;
}

test('actual Electron IPC and worker save verified prefix text and display unexamined coverage', { timeout: 90000 }, async () => {
  const evidence = process.env.RECOVERY_PARTIAL_ZIP_EVIDENCE || 'E:/RecoveryChat-PartialZip-0519-20260927/desktop';
  await mkdir(evidence, { recursive: true });
  const run = await mkdtemp(path.join(evidence, 'run-'));
  const source = path.join(run, '앞부분이-남은-문서.docx'), destination = path.join(run, 'results');
  const input = damagedZip([localZipEntry('word/document.xml', textXml('검증된 부분만 보존합니다'))], Buffer.from('broken-tail'));
  await writeFile(source, input, { flag: 'wx' }); await mkdir(destination);
  const application = await _electron.launch({ executablePath: process.env.RECOVERY_PACKAGED_APP || path.join(root, 'node_modules/electron/dist/electron.exe'),
    args: process.env.RECOVERY_PACKAGED_APP ? [] : [root], env: { ...process.env, RECOVERY_WORKSPACE: path.join(run, 'workspace') } });
  try {
    // Only native picker choices are supplied. IPC, admission checks, worker,
    // salvage engine, output publication and result rendering are all real.
    await application.evaluate(({ dialog }, paths) => {
      dialog.showOpenDialog = async (_window, options) => ({ canceled: false,
        filePaths: [options.properties.includes('openDirectory') ? paths.destination : paths.source] });
    }, { source, destination });
    const page = await application.firstWindow(), errors = [];
    page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(20000);
    await page.getByText('데스크톱 연결됨', { exact: true }).waitFor();
    await page.getByRole('button', { name: '도구 · 안내', exact: true }).click();
    await page.getByRole('button', { name: '손상 문서의 부분 내용 추출', exact: true }).click();
    await page.getByRole('button', { name: '파일과 저장 위치 선택', exact: true }).click();
    const card = page.locator('[data-result-id="salvage"]');
    await card.waitFor();
    assert.match(await card.innerText(), /텍스트 1개 부분 저장 · 미추출 0개 · 전체 문서 복구는 아니에요/);
    assert.match(await card.innerText(), /손상 지점 뒤 .*구조를 확인하지 못했어요/);
    const details = card.locator('details'); await details.locator('summary').click();
    assert.match(await details.innerText(), /ZIP_LOCAL_ENTRY_TRUNCATED/);
    assert.doesNotMatch(await card.innerText(), /삭제 전 원본 바이트 일치 확인|문서 열림 확인/);
    const outputs = (await filesAt(destination)).filter(file => file.endsWith('.salvaged.txt'));
    assert.equal(outputs.length, 1);
    const output = await readFile(outputs[0]);
    assert.match(output.toString('utf8'), /검증된 부분만 보존합니다/);
    assert.match(output.toString('utf8'), /구조 미검사: 11바이트/);
    assert.equal(sha(await readFile(source)), sha(input));
    assert.deepEqual(errors, []);
    await details.locator('summary').click();
    await card.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(run, 'partial-text-result.png') });
    await writeFile(path.join(run, 'receipt.json'), JSON.stringify({ status: 'passed',
      packaged: Boolean(process.env.RECOVERY_PACKAGED_APP), nativePickerChoicesMocked: true,
      actualIPC: true, actualWorker: true, actualSalvage: true, liveDeletion: false,
      inputSHA256: sha(input), inputUnchanged: true, output: outputs[0], outputSHA256: sha(output),
      originalRecoveryClaimed: false, missingCoverageShown: true }, null, 2));
  } finally { await application.close(); }
});
