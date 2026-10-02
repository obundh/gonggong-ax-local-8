// Re-read saved evidence and recovered outputs; no volume access or source writes.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { eventsForOriginalFileId } from './recovery-trial-evidence.mjs';

const root = path.resolve(process.argv[2] ?? '');
const allowedRoot = path.resolve('E:\\RecoveryChat-Combos-20260913');
if (path.dirname(root) !== allowedRoot || !/^live-[0-9a-f-]{36}$/.test(path.basename(root))) throw Error('Expected a generated trial directory');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const readJson = async name => JSON.parse((await fs.readFile(path.join(root, name), 'utf8')).replace(/^\uFEFF/, ''));
const receiptBytes = await fs.readFile(path.join(root, 'receipt.json'));
const receipt = JSON.parse(receiptBytes), manifest = await readJson('manifest.json'), pairs = await readJson('recycle-pairs.json');
if (manifest.intent !== 'agent-generated-combination-fixtures' || manifest.files.length !== 3) throw Error('Unexpected fixture manifest');
const outputRoot = await fs.realpath(path.join(root, 'recovered'));
const inside = (parent, child) => { const relative = path.relative(parent, child); return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative); };
async function absent(file) {
  try { await fs.lstat(file); return false; } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
}
const audit = { auditedAt: new Date().toISOString(), originalReceipt: path.join(root, 'receipt.json'),
  originalReceiptSha256: hash(receiptBytes), originalReceiptPreserved: true,
  eventAssociation: 'Post-discovery audit uses the original full file ID from the fixture manifest; old slot-only event lists contained other generations.',
  priorUsnCursor: receipt.priorUsnCursor, fixtureBaselineChecks: [], combinations: [] };
for (const f of manifest.files) {
  const pair = pairs.find(p => p.originalPath === f.originalPath);
  if (!pair) throw Error('Missing recycle pair');
  const baseline = await fs.readFile(f.backupPath);
  audit.fixtureBaselineChecks.push({ name: f.name, baselineHashMatches: hash(baseline) === f.sha256 && baseline.length === f.size,
    originalAbsentNow: await absent(f.originalPath), recyclePayloadAbsentNow: await absent(pair.payloadPath), recycleMetadataAbsentNow: await absent(pair.metadataPath) });
}
for (const round of receipt.combinations) {
  const auditedRound = { strategy: round.strategy, discoveryMs: round.elapsedMs, files: [] };
  for (const item of round.files) {
    const f = manifest.files.find(f => f.name === item.name);
    if (!f) throw Error('Unexpected fixture result');
    const generationEvents = eventsForOriginalFileId(item.events ?? [], f.fileId);
    const checked = { name: item.name, foundInOriginalReceipt: item.found, originalNameHintMatched: item.previousNameMatched,
      fixtureGenerationEvents: generationEvents, excludedOtherGenerationEvents: (item.events?.length ?? 0) - generationEvents.length,
      recordedRecoveryError: item.error ?? null, output: item.output ?? null, verifiedExactOutput: false };
    if (item.output) {
      const realOutput = await fs.realpath(item.output);
      if (!inside(outputRoot, realOutput) || realOutput === await fs.realpath(f.backupPath)) throw Error('Output is not a recovered file');
      const bytes = await fs.readFile(realOutput);
      checked.actualSize = bytes.length; checked.actualSha256 = hash(bytes);
      checked.verifiedExactOutput = bytes.length === f.size && checked.actualSha256 === f.sha256;
      if (f.zoneSha256) checked.zoneIdentifierHashMatches = hash(await fs.readFile(realOutput + ':Zone.Identifier')) === f.zoneSha256;
    }
    auditedRound.files.push(checked);
  }
  auditedRound.found = auditedRound.files.filter(f => f.foundInOriginalReceipt).length;
  auditedRound.exactRecovered = auditedRound.files.filter(f => f.verifiedExactOutput).length;
  audit.combinations.push(auditedRound);
}
const target = path.join(root, 'output-audit.json');
await fs.writeFile(target, JSON.stringify(audit, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ audit: target, fixtures: audit.fixtureBaselineChecks,
  results: audit.combinations.map(r => ({ strategy: r.strategy, discoveryMs: r.discoveryMs, found: r.found,
    exactRecovered: r.exactRecovered, generationEventCounts: r.files.map(f => f.fixtureGenerationEvents.length),
    zoneIdentifierHashMatches: r.files.find(f => f.zoneIdentifierHashMatches !== undefined)?.zoneIdentifierHashMatches })) }));
