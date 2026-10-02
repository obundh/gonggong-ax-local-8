// Fixed synthetic image comparison. Never opens a physical disk or deletes files.
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createFixture, fixtureGeometry } from '../test/ntfs-fixtures.mjs';
import { usnRecord, journalRecords } from '../test/usn-fixture.mjs';

const args = process.argv.slice(2), option = key => args[args.indexOf(key) + 1];
if (!args.includes('--baseline') || !args.includes('--output')) throw Error('--baseline ENGINE_DIRECTORY --output DIRECTORY required');
const output = path.resolve(option('--output')); await mkdir(output, { recursive: true });
const runRoot = await mkdtemp(path.join(output, 'fixed-'));
const baseline = path.resolve(option('--baseline'));
const current = args.includes('--current') ? path.resolve(option('--current')) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../engine');
const load = (root, file) => import(pathToFileURL(path.join(root, file)).href);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fixture = await createFixture(path.join(runRoot, 'input'));
const bytes = await readFile(fixture.imagePath);
// Retain the fixture's actual resident TXT bytes, replace its MFT basename only.
const start = fixtureGeometry.mftLcn * fixtureGeometry.clusterSize + 24 * fixtureGeometry.fileRecordSize;
const old = Buffer.from('삭제된-문서.txt', 'utf16le'), alias = '$RABC123';
const at = bytes.indexOf(old, start);
assert.ok(at >= start && at + old.length <= start + fixtureGeometry.fileRecordSize);
bytes[at - 2] = alias.length; bytes.fill(0, at, at + old.length); Buffer.from(alias, 'utf16le').copy(bytes, at);
await writeFile(fixture.imagePath, bytes);
const scenarios = [
  { recordNumber: 24, sequence: 6, alias, beforeTrash: '최종 본문.txt', transitions: ['초안.txt', '최종 본문.txt', alias], named: true, body: true },
  { recordNumber: 28, sequence: 100, alias: '$RABC128.pdf', beforeTrash: '최종 보고서.pdf', transitions: ['초안.pdf', '수정.pdf', '최종 보고서.pdf', '$RABC128.pdf'], named: true },
  { recordNumber: 29, sequence: 100, alias: '$RABC129.docx', beforeTrash: '다시 보관.docx', transitions: ['문서.docx', '$ROLD129.docx', '문서.docx', '다시 보관.docx', '$RABC129.docx'], named: true },
  { recordNumber: 30, sequence: 100, alias: '$RABC130.hwp', beforeTrash: '단일 이름.hwp', transitions: ['단일 이름.hwp', '$RABC130.hwp'], named: true },
  { recordNumber: 31, sequence: 100, alias: '$RABC131.pdf', beforeTrash: '연결 안됨.pdf', transitions: ['초안.pdf', '다른 파일.pdf', '연결 안됨.pdf', '$RABC131.pdf'], broken: true, named: false },
];
const records = [];
for (const scenario of scenarios) {
  const common = { recordNumber: scenario.recordNumber, sequence: scenario.sequence };
  for (let index = 0; index < scenario.transitions.length - 1; index++) {
    if (scenario.broken && index === 1) continue;
    records.push(usnRecord({ ...common, reason: 0x1000, name: scenario.transitions[index] }),
      usnRecord({ ...common, reason: 0x2000, name: scenario.transitions[index + 1] }),
      usnRecord({ ...common, reason: 0x80002000, name: scenario.transitions[index + 1] }));
  }
  records.push(usnRecord({ ...common, reason: 0x80000200, name: scenario.alias }));
}
const journal = journalRecords(records, 1000), nextUsn = 1000 + journal.length;
const header = Buffer.alloc(8); header.writeBigInt64LE(BigInt(nextUsn));
const transcript = Buffer.concat([header, journal]);
await writeFile(path.join(runRoot, 'journal.bin'), transcript, { flag: 'wx' });
const report = { source: 'identical synthetic NTFS image plus journal records, oracle scoring after candidate freeze',
  imageSha256: hash(bytes), journalSha256: hash(transcript), rows: [],
  limits: ['One real resident TXT payload in a synthetic image. The other four are metadata-only naming scenarios.',
    'Measures pre-trash name recovery, not a new live SSD deletion recovery rate.', 'No whole-stage acceptance claim.'] };
for (const [label, root] of [['baseline', baseline], ['current', current]]) {
  const { openNtfsProvider } = await load(root, 'ntfs-image.mjs');
  const { scanCombined, prepareCombinedCandidate } = await load(root, 'combined-recovery.mjs');
  const { chooseRecoveryName } = await load(root, 'recovery-name.mjs');
  const { classifyNameMatch } = await load(root, 'candidate-filter.mjs');
  const provider = { info: { size: bytes.length, sourceKind: 'volume', sectorSize: 512 },
    async read(offset, length) { return Buffer.from(bytes.subarray(offset, offset + length)); }, async close() {}, async assertUnchanged() {},
    async queryJournal() { return { journalId: '11', firstUsn: '1000', lowestValidUsn: '1000', nextUsn: String(nextUsn) }; },
    async readJournal() { return { data: transcript }; } };
  const engine = await openNtfsProvider(provider);
  try {
    const scan = await scanCombined(engine, { strategy: 'journal', journalProvider: provider });
    const frozen = Buffer.from(JSON.stringify(scan.candidates));
    await writeFile(path.join(runRoot, `${label}-candidates.json`), frozen, { flag: 'wx' });
    // Ground-truth names and hashes are consulted only after discovery freezes.
    const row = { label, engineRoot: root, candidateSha256: hash(frozen), outcomes: [] };
    for (const scenario of scenarios) {
      const found = scan.candidates.find(c => c.recordNumber === scenario.recordNumber);
      assert.ok(found, `${label}: scenario ${scenario.recordNumber} absent`);
      const naming = chooseRecoveryName(found);
      row.outcomes.push({ recordNumber: scenario.recordNumber, expectedName: scenario.beforeTrash,
        observedName: naming.name, source: found.source, status: found.status,
        exactName: naming.name === scenario.beforeTrash,
        exactNameSearch: classifyNameMatch(scenario.beforeTrash, found).kind === 'exact',
        expectedKnownName: scenario.named });
    }
    const body = scan.candidates.find(c => c.recordNumber === 24);
    await prepareCombinedCandidate(engine, body.recordNumber);
    const saved = await engine.recover(body.recordNumber, path.join(runRoot, `${label}-recovered`), { outputName: chooseRecoveryName(body).name });
    const original = fixture.manifest.files.find(f => f.recordNumber === 24);
    row.bodyExact = hash(await readFile(saved.path)) === original.sha256;
    row.savedName = path.basename(saved.path); row.savedPath = saved.path;
    row.knownNamesCorrect = row.outcomes.filter(r => r.expectedKnownName && r.exactName && r.exactNameSearch).length;
    row.falseNameClaims = row.outcomes.filter(r => !r.expectedKnownName && (r.exactName || r.exactNameSearch)).length;
    report.rows.push(row);
  } finally { await engine.close(); }
}
report.sourceUnchanged = hash(await readFile(fixture.imagePath)) === report.imageSha256;
await writeFile(path.join(runRoot, 'comparison.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ runRoot, ...report }, null, 2));
assert.equal(report.rows[0].knownNamesCorrect, 1);
assert.equal(report.rows[1].knownNamesCorrect, 4);
assert.equal(report.rows[1].savedName, scenarios[0].beforeTrash);
assert.ok(report.sourceUnchanged && report.rows.every(r => r.bodyExact && r.falseNameClaims === 0));
