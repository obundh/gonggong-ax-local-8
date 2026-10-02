import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { recoveryDiagnosis } from '../engine/recovery-outcome.mjs';
import { assessRecoveredBytes } from '../engine/recovery-verification.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { _electron } = createRequire(import.meta.url)(process.env.RECOVERY_PLAYWRIGHT_MODULE || 'playwright');

test('saved large files, limited previews, partial extraction and failed read ranges remain distinct in the GUI', { timeout: 90000 }, async () => {
  const evidence = process.env.RECOVERY_STAGE5_EVIDENCE || 'E:/RecoveryChat-Stage5-0514-20260926/desktop';
  await mkdir(evidence, { recursive: true });
  const run = await mkdtemp(path.join(evidence, 'run-'));
  const application = await _electron.launch({ executablePath: process.env.RECOVERY_PACKAGED_APP || path.join(root, 'node_modules/electron/dist/electron.exe'),
    args: process.env.RECOVERY_PACKAGED_APP ? [] : [root], env: { ...process.env, RECOVERY_WORKSPACE: run } });
  try {
    await application.evaluate(({ app }) => {
      const require = process.mainModule.require.bind(process.mainModule), path = require('node:path');
      const { RecoveryJobs } = require(path.join(app.isPackaged ? path.join(process.resourcesPath, 'app.asar.unpacked') : app.getAppPath(), 'engine/job-service.mjs'));
      // UI result fixtures only; actual NTFS byte recovery is covered separately.
      RecoveryJobs.prototype.devices = async () => ({ devices: [{ id: 'stage5-fixture', label: '5단계 화면 시험', kind: 'image', ready: true }] });
      RecoveryJobs.prototype.start = async () => ({ jobId: 'stage5-ui' });
      RecoveryJobs.prototype.candidates = async () => ({ items: [], total: 0, scannedTotal: 0 });
    });
    const page = await application.firstWindow(), errors = [];
    page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message));
    await page.getByText('데스크톱 연결됨', { exact: true }).waitFor();
    await page.locator('#program-start').click();
    await page.waitForFunction(() => document.body.dataset.hasJob === 'true');
    const details = page.locator('#job-details');
    if (!await details.evaluate(e => e.open)) await details.locator(':scope > summary').click();
    const emit = event => application.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0].webContents.send('recovery-event', value),
      { jobId: 'stage5-ui', ...event });
    await emit({ type: 'complete', complete: true, stats: { candidatesFound: 0 } });
    const base = { status: 'saved', path: 'E:/UI-FIXTURE-NOT-REAL-OUTPUT/document.bin', originalIdentityVerified: false, integrity: { status: 'verified' } };
    const readFailure = { logicalOffset: 1048576, requestedBytes: 4096, physicalOffset: 8388608,
      runVcn: 256, runLcn: 2048, extentKind: 'physical', cause: 'EIO', exactFailedBytesKnown: false };
    const failed = { id: 'failed', name: '읽기-실패.bin', status: 'failed', code: 'READ_FAILED',
      error: '요청 구간 읽기 실패', details: { readFailure } };
    failed.diagnostic = recoveryDiagnosis({ error: failed });
    const largeMismatch = await assessRecoveredBytes('손상된-큰파일.png', Buffer.alloc(9 * 1024 * 1024));
    const results = [
      { ...base, id: 'large-mismatch', name: '손상된-큰파일.png', document: largeMismatch },
      { ...base, id: 'large', name: '전체저장-큰파일.bin', document: { status: 'needs-check', reason: 'FILE_TOO_LARGE', assessmentLimited: true, truncated: false } },
      { ...base, id: 'legacy', name: '이전버전-큰파일.bin', document: { status: 'needs-check', reason: 'FILE_TOO_LARGE', truncated: true } },
      { ...base, id: 'preview', name: '미리보기-제한.txt', document: { status: 'preview-available', truncated: true, assessmentLimited: true } },
      { ...base, id: 'partial', name: '일부본문-저장.txt', partial: true, document: { status: 'needs-check' } }, failed,
    ];
    await emit({ type: 'recover-complete', results });
    await page.locator('[data-result-id="large"]').waitFor();
    const mismatchText = await page.locator('[data-result-id="large-mismatch"]').innerText();
    assert.match(mismatchText, /손상/);
    assert.doesNotMatch(mismatchText, /문서 상태 미확인|일부 본문 저장/);
    for (const id of ['large', 'legacy']) {
      const text = await page.locator(`[data-result-id="${id}"]`).innerText();
      assert.match(text, /파일 저장 · 문서 상태 미확인/);
      assert.match(text, /문서 검사 범위 제한/);
      assert.doesNotMatch(text, /일부 내용|일부 본문|전체 복구 미완료/);
    }
    const preview = await page.locator('[data-result-id="preview"]').innerText();
    assert.match(preview, /미리보기 범위 제한/); assert.doesNotMatch(preview, /일부 본문 저장/);
    assert.match(await page.locator('[data-result-id="partial"]').innerText(), /일부 본문 저장 · 전체 복구 미완료/);
    const failedText = await page.locator('[data-result-id="failed"]').innerText();
    assert.match(failedText, /원본에서 요청한 4.0 KB 구간/);
    assert.doesNotMatch(failedText, /파일 내용 .*위치/);
    assert.match(failedText, /정확한 손상 바이트 수는 미확정/);
    assert.equal(await page.locator('#session-verified').innerText(), '0');
    assert.equal(await page.locator('#session-saved').innerText(), '5');
    await page.locator('[data-result-id="large"]').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(run, 'large-file-status.png') });
    await page.locator('[data-result-id="failed"]').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(run, 'partial-and-failure.png') });
    assert.deepEqual(errors, []);
    await writeFile(path.join(run, 'receipt.json'), JSON.stringify({ status: 'passed', packaged: Boolean(process.env.RECOVERY_PACKAGED_APP),
      guiEventsMocked: true, physicalScan: false, largeFileNotPartial: true, legacyMigration: true,
      largeSignatureMismatchShown: true, truePartialDistinct: true, failedRangeShown: true, originalVerificationClaimed: false }, null, 2));
  } finally { await application.close(); }
});
