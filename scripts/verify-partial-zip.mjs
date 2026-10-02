import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  brokenLocalHeader,
  corruptCrc,
  damagedZip,
  fixtureText,
  localZipEntry,
  textXml,
} from '../test/partial-zip-fixture.mjs';

function usage() {
  return 'Usage: node scripts/verify-partial-zip.mjs <baselineEngineDir> <currentEngineDir> <freshEvidenceDir>';
}

const [baselineDirectory, currentDirectory, evidenceDirectory] = process.argv.slice(2);
if (!baselineDirectory || !currentDirectory || !evidenceDirectory || process.argv.length !== 5) {
  process.stderr.write(`${usage()}\n`);
  process.exitCode = 2;
} else {
  const baselinePath = path.resolve(baselineDirectory, 'document-salvage.mjs');
  const currentPath = path.resolve(currentDirectory, 'document-salvage.mjs');
  const evidencePath = path.resolve(evidenceDirectory);
  if (!existsSync(baselinePath) || !existsSync(currentPath)) {
    process.stderr.write(`Both engine directories must contain document-salvage.mjs.\n${usage()}\n`);
    process.exitCode = 2;
  } else {
    // Preserve the actual inputs and outputs alongside the receipt for replay.
    await mkdir(evidencePath);
    const temporary = evidencePath;
    const sha256 = value => createHash('sha256').update(value).digest('hex');
    const inputs = [
      {
        id: 'docx-prefix-garbage', extension: '.docx', expected: [fixtureText.docx], excluded: [fixtureText.decoy],
        bytes: damagedZip([localZipEntry('word/document.xml', textXml(fixtureText.docx))], Buffer.from('damaged tail')),
      },
      {
        id: 'docx-body-cut', extension: '.docx', expected: [fixtureText.docx], excluded: [fixtureText.decoy],
        bytes: damagedZip([
          localZipEntry('word/document.xml', textXml(fixtureText.docx)),
          brokenLocalHeader({ declaredBodyBytes: 1024 * 1024 }), localZipEntry('word/after-damage.xml', textXml(fixtureText.decoy)),
        ]),
      },
      {
        id: 'pptx-one-valid-one-bad', extension: '.pptx', expected: [fixtureText.pptxGood], excluded: [fixtureText.pptxBad],
        bytes: damagedZip([
          localZipEntry('ppt/presentation.xml', textXml('presentation', 'p:presentation')),
          localZipEntry('ppt/slides/slide1.xml', textXml(fixtureText.pptxGood, 'p:sld')),
          corruptCrc(localZipEntry('ppt/slides/slide2.xml', textXml(fixtureText.pptxBad, 'p:sld'))),
        ]),
      },
      ...[
        ['xlsx', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml', fixtureText.xlsxGood, fixtureText.xlsxBad],
        ['hwpx', '[Content_Types].xml', 'Contents/section0.xml', 'Contents/section1.xml', fixtureText.hwpxGood, fixtureText.hwpxBad],
      ].map(([ext, marker, good, bad, expected, excluded]) => ({
        id: `${ext}-one-valid-one-bad`, extension: `.${ext}`, expected: [expected], excluded: [excluded],
        bytes: damagedZip([localZipEntry(marker, textXml('marker')), localZipEntry(good, textXml(expected)),
          corruptCrc(localZipEntry(bad, textXml(excluded)))]),
      })),
    ];
    const run = async (label, modulePath) => {
      const { salvageDocument } = await import(`${pathToFileURL(modulePath).href}?comparison=${encodeURIComponent(label)}-${Date.now()}`);
      const results = [];
      for (const input of inputs) {
        const inputPath = path.join(temporary, `${label}-${input.id}${input.extension}`);
        const outputPath = path.join(temporary, `${label}-${input.id}-out`);
        await writeFile(inputPath, input.bytes, { flag: 'wx' });
        const inputHash = sha256(input.bytes);
        try {
          const result = await salvageDocument(inputPath, outputPath, { sourceKind: 'owned-carved' });
          const text = await readFile(result.path, 'utf8');
          results.push({ id: input.id, status: result.status, code: null, sourceSha256: inputHash,
            sourceUnchanged: sha256(await readFile(inputPath)) === inputHash,
            expectedTextPresent: input.expected.every(value => text.includes(value)),
            excludedTextAbsent: input.excluded.every(value => !text.includes(value)),
            originalIdentityVerified: result.originalIdentityVerified,
            coverage: result.coverage ?? null, extractedParts: result.extractedParts?.length ?? 0,
            inputPath, outputPath: result.path, outputSha256: sha256(Buffer.from(text, 'utf8')) });
        } catch (error) {
          results.push({ id: input.id, status: 'refused', code: error?.code ?? 'UNEXPECTED_ERROR', sourceSha256: inputHash,
            sourceUnchanged: sha256(await readFile(inputPath)) === inputHash,
            expectedTextPresent: false, excludedTextAbsent: true, originalIdentityVerified: false, coverage: null, extractedParts: 0 });
        }
      }
      return results;
    };
    {
      const baseline = await run('baseline', baselinePath), current = await run('current', currentPath);
      const expectedSuccess = item => item.status === 'partial' && item.expectedTextPresent && item.excludedTextAbsent
        && item.sourceUnchanged && item.originalIdentityVerified === false;
      const report = {
        kind: 'fixture-only-partial-zip-comparison', liveScans: false, originalRecoverySuccesses: 0,
        engineHashes: { baseline: sha256(await readFile(baselinePath)), current: sha256(await readFile(currentPath)) },
        inputs: inputs.map(input => ({ id: input.id, sha256: sha256(input.bytes), bytes: input.bytes.length })),
        baseline, current,
        counts: {
          baselinePartialTextSuccess: baseline.filter(expectedSuccess).length,
          currentPartialTextSuccess: current.filter(expectedSuccess).length,
          originalBytesVerified: 0,
        },
        conclusion: 'This compares generated partial text from fixed damaged ZIP fixtures. It does not measure original-file recovery or live-device behavior.',
      };
      const reportPath = path.join(evidencePath, 'partial-zip-comparison.json');
      await writeFile(reportPath, JSON.stringify(report, null, 2), { flag: 'wx' });
      assert.equal(report.counts.baselinePartialTextSuccess, 0);
      assert.equal(report.counts.currentPartialTextSuccess, inputs.length);
      assert.ok(baseline.every(item => ['ZIP_LOCAL_ENTRY_TRUNCATED', 'ZIP_CRC_MISMATCH'].includes(item.code)));
      assert.ok([...baseline, ...current].every(item => item.sourceUnchanged));
      process.stdout.write(`${JSON.stringify(report.counts)}\n${evidencePath}\n`);
    }
  }
}
