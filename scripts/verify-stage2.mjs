import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { RecoveryJobs } from '../engine/job-service.mjs';
import { listWindowsDevices } from '../engine/windows-device.mjs';
import { describeTrialContext, compareDeviceObservations } from '../engine/trial-context.mjs';
import { createFixture } from '../test/ntfs-fixtures.mjs';

const root = path.resolve(process.argv[2] || 'E:/RecoveryChat-Stage2-20260920/acceptance', `run-${randomUUID()}`);
await mkdir(root, { recursive: true });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const before = await listWindowsDevices();
const fixture = await createFixture(path.join(root, 'fixture'));
const inputHash = hash(await readFile(fixture.imagePath));
const workspace = path.join(root, 'workspace'), destinationPath = path.join(root, 'collected');
await Promise.all([mkdir(workspace), mkdir(destinationPath)]);
const events = [];
const jobs = new RecoveryJobs({ workspace, onEvent: event => events.push(event) });
const fixedRuns = [];
try {
  await jobs.initialize();
  const source = await jobs.addSource('image', fixture.imagePath), destination = await jobs.addDestination(destinationPath);
  for (let repetition = 1; repetition <= 2; repetition++) {
    const collection = await jobs.acquisitions.start({ sourceId: source.id, destinationId: destination.id });
    const result = await jobs.acquisitions.active.done;
    if (!result.summary?.complete || result.summary.sha256 !== inputHash) throw new Error('Known fixed image acquisition did not match its source.');
    const acquired = await jobs.acquisitions.useImage(collection.id);
    const scan = await jobs.start({ sourceId: acquired.id, mode: 'deleted' });
    const end = Date.now() + 30000;
    while (!events.some(event => event.jobId === scan.jobId && ['complete', 'error'].includes(event.type))) {
      if (Date.now() > end) throw new Error('Fixed image analysis timed out.');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const terminal = events.find(event => event.jobId === scan.jobId && ['complete', 'error'].includes(event.type));
    if (terminal.type === 'error') throw new Error(terminal.error?.message || 'analysis failed');
    const page = jobs.candidates({ jobId: scan.jobId, limit: 100 });
    fixedRuns.push({ repetition, context: describeTrialContext({ sourceKind: 'image', sourceIdentity: jobs.sources.get(source.id).identity }),
      expectedSha256: inputHash, collectedSha256: result.summary.sha256, outputDirectory: result.outputDirectory,
      collectedComplete: result.summary.complete, candidateCount: page.total,
      candidateEvidence: page.items.map(item => ({ recordNumber: item.recordNumber, name: item.name, size: item.size })) });
  }
} finally { await jobs.dispose(); }
const after = await listWindowsDevices();
const systemBefore = before.find(device => device.system), systemAfter = after.find(device => device.id === systemBefore?.id);
const receipt = { recordedAt: new Date().toISOString(), root, inputUnchanged: hash(await readFile(fixture.imagePath)) === inputHash,
  fixedImage: { fixedRuns, repeatMatches: JSON.stringify(fixedRuns[0].candidateEvidence) === JSON.stringify(fixedRuns[1].candidateEvidence) },
  liveSystem: { context: describeTrialContext({ sourceKind: 'volume', system: true, sourceIdentity: systemBefore?.identity, device: systemBefore }),
    acquisitionPerformed: false, observation: compareDeviceObservations(systemBefore, systemAfter), before: systemBefore ?? null, after: systemAfter ?? null },
  limits: ['The live system cohort observes device metadata only; no raw C: acquisition or new user-file deletion was performed.', 'Two fixed-fixture repetitions do not establish hardware recovery performance.'] };
if (!receipt.inputUnchanged || !receipt.fixedImage.repeatMatches) throw new Error('Fixed source or repeated analysis changed unexpectedly.');
await writeFile(path.join(root, 'acceptance.json'), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify({ root, inputUnchanged: receipt.inputUnchanged, repeatMatches: receipt.fixedImage.repeatMatches, candidates: fixedRuns.map(item => item.candidateCount), liveAcquisitionPerformed: false }));
