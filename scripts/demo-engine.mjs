import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createFixture } from '../test/ntfs-fixtures.mjs';
import { openNtfsImage } from '../engine/ntfs-image.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'output', 'recovery-engine');
await mkdir(output, { recursive: true });
const run = await mkdtemp(path.join(output, 'run-'));
const fixture = await createFixture(path.join(run, 'fixture'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const before = hash(await readFile(fixture.imagePath));
const image = await openNtfsImage(fixture.imagePath);
try {
  const scan = await image.scanDeleted();
  const recovered = [];
  for (const expected of fixture.manifest.files.filter(file => file.recoverable)) {
    const result = await image.recover(expected.recordNumber, path.join(run, 'recovered'));
    const actualHash = hash(await readFile(result.path));
    if (actualHash !== expected.sha256 || result.sha256 !== expected.sha256) throw new Error(`복구본 비교 실패: ${expected.recordNumber}`);
    recovered.push({ recordNumber: expected.recordNumber, originalName: expected.name, ...result, expectedSha256: expected.sha256, fixtureBytesMatched: true });
  }
  const after = hash(await readFile(fixture.imagePath));
  if (before !== after) throw new Error('시험 이미지가 변경됐습니다.');
  const report = { testedAt: new Date().toISOString(), synthetic: true, evidenceLimit: fixture.manifest.evidenceLimit,
    info: image.info, scan: { stats: scan.stats, complete: scan.complete, warnings: scan.warnings, candidates: scan.candidates },
    sourceUnchanged: true, sourceSha256Before: before, sourceSha256After: after, recovered };
  const reportPath = path.join(run, 'report.json');
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write(`시험 이미지 복구: ${recovered.length}개 파일 바이트 비교 통과\n원본 이미지 변경 없음\n결과: ${reportPath}\n`);
} finally { await image.close(); }
