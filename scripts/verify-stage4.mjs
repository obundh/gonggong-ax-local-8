// Fixed-input comparison; never deletes a file or opens a physical volume.
import { mkdtemp, mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createFixture } from '../test/ntfs-fixtures.mjs';
import { usnRecord } from '../test/usn-fixture.mjs';
const args = process.argv.slice(2);
const option = key => args[args.indexOf(key) + 1];
if (!args.includes('--baseline') || !args.includes('--output')) throw Error('--baseline ENGINE_DIRECTORY --output DIRECTORY required');
const output = path.resolve(option('--output'));
await mkdir(output, { recursive: true });
const runRoot = await mkdtemp(path.join(output, 'fixed-'));
const load = (root, file) => import(pathToFileURL(path.join(root, file)).href);
const current = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../engine');
const baseline = path.resolve(option('--baseline'));
const fixture = await createFixture(path.join(runRoot, 'input'));
const bytes = await readFile(fixture.imagePath), hash = b => createHash('sha256').update(b).digest('hex');
const records = [usnRecord({ recordNumber: 24, sequence: 6, name: '삭제된-문서.txt', usn: 1100 })];
for (let i = 0; i < 5; i++) {
  const common = { recordNumber: 25 + i, sequence: 100 };
  records.push(usnRecord({ ...common, reason: 0x1000, name: `사라진 문서 ${i + 1}.pdf`, usn: 1200 + i * 300 }),
    usnRecord({ ...common, reason: 0x2000, name: `$RABC12${i}.pdf`, usn: 1300 + i * 300 }),
    usnRecord({ ...common, reason: 0x80000200, name: `$RABC12${i}.pdf`, usn: 1400 + i * 300 }));
}
const header = Buffer.alloc(8); header.writeBigInt64LE(3000n);
const transcript = Buffer.concat([header, ...records]);
await writeFile(path.join(runRoot, 'journal.bin'), transcript, { flag: 'wx' });
const report = { source: 'synthetic fixed image and identical native-journal response', imageSha256: hash(bytes), journalSha256: hash(transcript),
  limits: ['Five journal-only PDF-name traces have no original PDF bodies in this fixture.', 'The one recoverable control is TXT.',
    'Startup benchmark uses independent 300 ms fake inventory/inspection delays; it is not a live C drive speed claim.'], rows: [] };
for (const [label, root] of [['baseline', baseline], ['current', current]]) {
  const { openNtfsProvider } = await load(root, 'ntfs-image.mjs');
  const { scanCombined, prepareCombinedCandidate } = await load(root, 'combined-recovery.mjs');
  const provider = { info: { size: bytes.length, sourceKind: 'volume', sectorSize: 512 },
    async read(offset, length) { return Buffer.from(bytes.subarray(offset, offset + length)); }, async close() {}, async assertUnchanged() {},
    async queryJournal() { return { journalId: '11', firstUsn: '1000', lowestValidUsn: '1000', nextUsn: '3000' }; },
    async readJournal() { return { data: transcript }; } };
  const engine = await openNtfsProvider(provider);
  const result = await scanCombined(engine, { strategy: 'journal', journalProvider: provider });
  const frozen = Buffer.from(JSON.stringify(result.candidates));
  await writeFile(path.join(runRoot, `${label}-candidates.json`), frozen, { flag: 'wx' });
  const row = { label, engineRoot: root, candidatesSha256: hash(frozen), contentCandidates: result.candidates.filter(c => c.source === 'deleted-record').length,
    orphanTraces: result.candidates.filter(c => c.source === 'deletion-trace').length,
    namesFromHistory: result.candidates.filter(c => c.source === 'deletion-trace' && c.originalNameStatus === 'history-only').length };
  // Scoring begins only after candidate freeze; original names/hashes never
  // enter discovery or determine which MFT records it reads.
  const control = result.candidates.find(c => c.source === 'deleted-record' && c.recordNumber === 24);
  await prepareCombinedCandidate(engine, control.recordNumber);
  const destination = path.join(runRoot, `${label}-recovered`); await mkdir(destination);
  const saved = await engine.recover(control.recordNumber, destination);
  row.originalControls = Number(hash(await readFile(saved.path)) === fixture.manifest.files.find(f => f.recordNumber === 24).sha256);
  await engine.close();
  const { RecoveryJobs } = await load(root, 'job-service.mjs');
  row.startupMs = [];
  for (let sample = 0; sample < 3; sample++) {
    const workspace = path.join(runRoot, `${label}-startup-${sample}`);
    const delay = () => new Promise(resolve => setTimeout(resolve, 300));
    const device = { id: 'SYNTHETIC', identity: 'one', ready: true, diskIds: ['source'] };
    const jobs = new RecoveryJobs({ workspace,
      inventory: async () => { await delay(); return [device]; },
      inspect: async target => { await delay(); return { canonicalPath: await realpath(target), identity: 'out', diskIds: ['output'], freeSpace: 1e12 }; },
      volumeSession: { async dispose() {} },
      workerFactory() { const worker = new EventEmitter(); worker.postMessage = () => {}; worker.unref = () => {}; worker.terminate = async () => 0; return worker; },
    });
    await jobs.initialize(); jobs.sources.set('s', { id: 's', kind: 'volume', device, identity: device.identity });
    const began = performance.now();
    await jobs.start({ sourceId: 's', mode: 'deleted' });
    row.startupMs.push(performance.now() - began);
    await jobs.dispose();
  }
  row.startupMeanMs = row.startupMs.reduce((a, b) => a + b, 0) / row.startupMs.length;
  report.rows.push(row);
}
report.sourceUnchanged = hash(await readFile(fixture.imagePath)) === report.imageSha256;
await writeFile(path.join(runRoot, 'comparison.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ runRoot, ...report }, null, 2));
if (!report.sourceUnchanged || report.rows[1].orphanTraces !== 5 || report.rows[1].namesFromHistory !== 5 || report.rows.some(row => row.originalControls !== 1)) process.exitCode = 1;
