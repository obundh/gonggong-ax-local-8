// Explicit opt-in experiment. Creates and deletes only new, generated fixtures.
// The scanner receives a time/USN interval, never expected names, IDs or bytes.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { listWindowsDevices, openWindowsVolume, inspectDestination } from '../engine/windows-device.mjs';
import { openNtfsProvider } from '../engine/ntfs-image.mjs';
import { scanCombined, prepareCombinedCandidate } from '../engine/combined-recovery.mjs';
import { eventsForCandidate } from './recovery-trial-evidence.mjs';

if (!process.argv.includes('--generated-live-trial')) throw Error('Requires --generated-live-trial; never accepts user-file arguments.');
const tag = randomUUID(), trialRoot = path.join('E:\\RecoveryChat-Combos-20260913', `live-${tag}`);
const cold = process.argv.includes('--cold'), strategies = process.argv.includes('--journal-only') ? ['journal'] : ['journal', 'vacancy', 'combined'];
const source = path.join(os.tmpdir(), `RecoveryChat-Combo-${tag}`);
if (!/^C:\\/i.test(source) || path.dirname(source).toLowerCase() !== path.resolve(os.tmpdir()).toLowerCase()) throw Error('Unexpected generated source root');
await fs.mkdir(trialRoot); await fs.mkdir(path.join(trialRoot, 'baseline')); await fs.mkdir(path.join(trialRoot, 'recovered'));
const hash = b => createHash('sha256').update(b).digest('hex');
const save = (name, data) => fs.writeFile(path.join(trialRoot, name), JSON.stringify(data, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2) + '\n');
const log = (event, data = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), event, ...data }));
function pdf(label) {
  const content = `BT /F1 14 Tf 40 100 Td (${label}) Tj ET\n`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 160] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`];
  let text = '%PDF-1.4\n' + ('% fixture padding ' + tag + '\n').repeat(160); const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(text)); text += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(text);
  text += `xref\n0 6\n0000000000 65535 f \n` + offsets.slice(1).map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  text += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`; return Buffer.from(text);
}
function powershell(stage) {
  return new Promise((resolve, reject) => {
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(trialRoot, 'recycle-stage.ps1'), '-Stage', stage],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, RECOVERYCHAT_TRIAL_SOURCE: source } });
    let out = '', err = ''; p.stdout.on('data', b => out += b); p.stderr.on('data', b => err += b);
    p.once('error', reject); p.once('exit', code => code === 0 ? resolve(out.trim()) : reject(Error(`${stage}: ${err || out}`)));
  });
}
const receipt = { experiment: 'generated Windows recycle-and-purge trial', source, trialRoot, createdAt: new Date().toISOString(),
  rawWrites: false, priorUsnCursor: !cold, oraclePassedToScanner: false, sequentialLiveComparisonsNotControlledTiming: strategies.length > 1, combinations: [] };
let provider, engine;
try {
  const device = (await listWindowsDevices()).find(d => d.driveLetter === 'C:' && d.fileSystem === 'NTFS');
  const destination = await inspectDestination(path.join(trialRoot, 'recovered'));
  if (!device?.diskIds.length || !destination.diskIds.length || device.diskIds.some(d => destination.diskIds.includes(d))) throw Error('Separate physical output disk required');
  log('awaiting-volume-permission', { trialRoot });
  try { provider = await openWindowsVolume(device); }
  catch (e) { if (e.code !== 'NEEDS_ADMIN') throw e; provider = await openWindowsVolume(device, { elevate: true }); }
  const initialJournal = await provider.queryJournal();
  receipt.initialJournal = initialJournal;
  await fs.mkdir(source); // Existing paths are never reused.
  const fixtures = [{ name: `note-${tag}.txt`, bytes: Buffer.from(`RecoveryChat generated resident document ${tag}\n`) },
    { name: `report-${tag}.pdf`, bytes: pdf('RecoveryChat generated PDF') },
    { name: `download-${tag}.pdf`, bytes: pdf('RecoveryChat generated PDF with Zone.Identifier'), zone: Buffer.from('[ZoneTransfer]\r\nZoneId=3\r\n') }];
  const manifest = { source, intent: 'agent-generated-combination-fixtures', files: [] };
  for (const f of fixtures) {
    const originalPath = path.join(source, f.name), backupPath = path.join(trialRoot, 'baseline', f.name);
    await fs.writeFile(backupPath, f.bytes, { flag: 'wx' }); await fs.writeFile(originalPath, f.bytes, { flag: 'wx' });
    if (f.zone) await fs.writeFile(originalPath + ':Zone.Identifier', f.zone);
    const stat = await fs.stat(originalPath, { bigint: true });
    manifest.files.push({ name: f.name, originalPath, backupPath, size: f.bytes.length, sha256: hash(f.bytes),
      fileId: stat.ino.toString(), recordNumber: Number(stat.ino & 0xffffffffffffn), zoneSha256: f.zone ? hash(f.zone) : null });
  }
  await save('manifest.json', manifest);
  let stageScript = await fs.readFile('E:\\RecoveryChat-Trial-20260913-195822-immediate\\recycle-stage.ps1', 'utf8');
  const originalScope = "$expectedSource='C:\\Users\\USER\\Desktop\\더미휴지통행'";
  if (!stageScript.includes(originalScope)) throw Error('Unexpected trial helper template');
  stageScript = stageScript.replace(originalScope, () => "$expectedSource=$env:RECOVERYCHAT_TRIAL_SOURCE\nif($manifest.intent -cne 'agent-generated-combination-fixtures' -or [IO.Path]::GetDirectoryName($expectedSource) -ine [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\\') -or [IO.Path]::GetFileName($expectedSource) -cnotmatch '^RecoveryChat-Combo-[0-9a-f-]{36}$'){throw 'Generated test scope mismatch'}");
  await fs.writeFile(path.join(trialRoot, 'recycle-stage.ps1'), stageScript, { flag: 'wx' });
  log('recycle', { result: await powershell('Recycle') });
  log('purge', { result: await powershell('Purge') });
  const purge = JSON.parse((await fs.readFile(path.join(trialRoot, 'purge-receipt.json'), 'utf8')).replace(/^\uFEFF/, ''));
  const pairs = JSON.parse((await fs.readFile(path.join(trialRoot, 'recycle-pairs.json'), 'utf8')).replace(/^\uFEFF/, ''));
  receipt.purge = purge;
  engine = await openNtfsProvider(provider);
  receipt.geometry = engine.info;
  for (const strategy of strategies) {
    const start = performance.now(), round = { strategy, afterPurgeMs: Date.now() - Date.parse(purge.finishedAt), files: [] };
    let lastProgress = 0;
    const scan = await scanCombined(engine, { strategy, journalProvider: provider, startUsn: cold ? undefined : initialJournal.nextUsn,
      deletedAfter: Date.parse(receipt.createdAt), onProgress: p => { if (Date.now() - lastProgress > 5000) {
        lastProgress = Date.now(); log('progress', { strategy, stage: p.stage, records: p.recordsRead ?? p.slotsVisited, events: p.eventsRead });
      } } });
    round.elapsedMs = performance.now() - start; round.stats = scan.stats; round.coverage = scan.coverage; round.warnings = scan.warnings;
    // Ground truth is used only after discovery has completed.
    for (const f of manifest.files) {
      const pair = pairs.find(p => p.originalPath === f.originalPath);
      const candidate = scan.candidates.find(c => c.recordNumber === f.recordNumber && c.names.includes(path.basename(pair.payloadPath)));
      const evidence = eventsForCandidate(scan.journal.events, candidate);
      const item = { name: f.name, expectedRecordNumber: f.recordNumber, found: Boolean(candidate),
        previousNameMatched: candidate?.previousNameHints.includes(f.name) ?? false,
        events: evidence.generationEvents, matchedDeletes: evidence.matchedDeletes,
        candidateEvidence: candidate ? { recordNumber: candidate.recordNumber, sequence: candidate.sequence,
          fingerprint: candidate.fingerprint, nameReferences: candidate.nameReferences } : null }; round.files.push(item);
      if (!candidate) {
        try { const r = await engine.record(f.recordNumber); item.observedRecord = r ? { sequence: r.sequence, flags: r.flags,
          names: r.names.map(n => n.name), expectedNameStillPresent: r.names.some(n => n.name === f.name || n.name === path.basename(pair.payloadPath)),
          allocated: await engine.bitmapBit(engine.mftBitmap, f.recordNumber) } : null; }
        catch (error) { item.recordError = { code: error.code, message: error.message }; }
        continue;
      }
      try {
        const prepared = await prepareCombinedCandidate(engine, candidate.recordNumber); item.preparedStatus = prepared.status;
        const recovered = await engine.recover(candidate.recordNumber, destination.canonicalPath); item.output = recovered.path;
        const bytes = await fs.readFile(recovered.path); item.sha256 = hash(bytes); item.exactOriginalMatch = bytes.length === f.size && item.sha256 === f.sha256;
        item.zeroByteFraction = bytes.length ? bytes.reduce((n, b) => n + Number(b === 0), 0) / bytes.length : 0;
        if (f.zoneSha256) item.zonePreserved = hash(await fs.readFile(recovered.path + ':Zone.Identifier')) === f.zoneSha256;
      } catch (error) { item.error = { code: error.code, message: error.message }; }
    }
    receipt.combinations.push(round); await save('receipt.json', receipt);
    log('combination-result', { strategy, elapsedMs: round.elapsedMs, found: round.files.filter(f => f.found).length,
      exactRecovered: round.files.filter(f => f.exactOriginalMatch).length, files: round.files.map(f => ({ name: f.name,
        found: f.found, exactOriginalMatch: f.exactOriginalMatch, previousNameMatched: f.previousNameMatched, eventCount: f.events?.length,
        recordFlags: f.observedRecord?.flags, allocated: f.observedRecord?.allocated, sameName: f.observedRecord?.expectedNameStillPresent,
        error: f.error ?? f.recordError })) });
  }
  receipt.completed = true;
} catch (error) { receipt.error = { code: error.code, message: error.message }; log('trial-error', receipt.error); process.exitCode = 1; }
finally { await engine?.close().catch(() => {}); await provider?.close().catch(() => {}); receipt.finishedAt = new Date().toISOString(); await save('receipt.json', receipt); log('trial-finished', { trialRoot, completed: receipt.completed ?? false }); }
