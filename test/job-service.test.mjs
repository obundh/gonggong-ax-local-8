import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { deflateSync } from 'node:zlib';

import { RecoveryJobs } from '../engine/job-service.mjs';
import { createFixture } from './ntfs-fixtures.mjs';

let root;
let fixture;

function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function crc32(bytes) { let value = 0xffffffff; for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (0xedb88320 & -(value & 1)); } return (value ^ 0xffffffff) >>> 0; }
function pngChunk(type, body = Buffer.alloc(0)) { const name = Buffer.from(type, 'ascii'); return Buffer.concat([Buffer.from([(body.length >>> 24) & 255, (body.length >>> 16) & 255, (body.length >>> 8) & 255, body.length & 255]), name, body, Buffer.from([(crc32(Buffer.concat([name, body])) >>> 24) & 255, (crc32(Buffer.concat([name, body])) >>> 16) & 255, (crc32(Buffer.concat([name, body])) >>> 8) & 255, crc32(Buffer.concat([name, body])) & 255])]); }
function tinyPng() { const header = Buffer.alloc(13); header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 2; return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(Buffer.from([0, 0x21, 0x43, 0x65]))), pngChunk('IEND')]); }
function tinyPdf() { return Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n', 'ascii'); }
async function findFiles(directory) { const files = []; for (const entry of await readdir(directory, { withFileTypes: true })) { const target = path.join(directory, entry.name); if (entry.isDirectory()) files.push(...await findFiles(target)); else if (entry.isFile()) files.push(target); } return files; }
function waitFor(events, predicate, timeout = 15_000) {
  return new Promise((resolve, reject) => {
    const found = events.find(predicate);
    if (found) { resolve(found); return; }
    const timer = setTimeout(() => reject(new Error('Timed out waiting for worker event')), timeout);
    const poll = setInterval(() => {
      const event = events.find(predicate);
      if (event) { clearTimeout(timer); clearInterval(poll); resolve(event); }
    }, 10);
  });
}

function destinationInspector(runtime, destination, { destinationIdentity = 'destination-v1', destinationDiskIds = ['2'], runtimeDiskIds = ['3'] } = {}) {
  return async (target) => {
    const canonicalPath = await realpath(target);
    if (canonicalPath === runtime) return { canonicalPath, identity: 'runtime-v1', diskIds: runtimeDiskIds, freeSpace: 1e12, fileSystem: 'NTFS' };
    if (canonicalPath === destination) return { canonicalPath, identity: destinationIdentity, diskIds: destinationDiskIds, freeSpace: 1e12, fileSystem: 'NTFS' };
    throw new Error(`unexpected inspected path: ${canonicalPath}`);
  };
}

test('asynchronous start and recover admission prevent double-click races before any validation await', async () => {
  const jobs = new RecoveryJobs({ workspace: os.tmpdir() });
  let release;
  jobs.startReady = () => new Promise(resolve => { release = resolve; });
  const first = jobs.start({});
  assert.equal(jobs.busy(), true);
  await assert.rejects(jobs.start({}), { code: 'BUSY' });
  await assert.rejects(jobs.recover({}), { code: 'BUSY' });
  release({ jobId: 'first' }); await first;
  assert.equal(jobs.busy(), false);
  jobs.recoverReady = () => new Promise(resolve => { release = resolve; });
  const saving = jobs.recover({});
  await assert.rejects(jobs.start({}), { code: 'BUSY' });
  await assert.rejects(jobs.recover({}), { code: 'BUSY' });
  release({ jobId: 'saving' }); await saving;
  assert.equal(jobs.busy(), false);
});

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'recovery-jobs-'));
  fixture = await createFixture(path.join(root, 'fixture'));
});

after(async () => { await rm(root, { recursive: true, force: true }); });

test('image scan filters candidates and recovers selected fixture bytes without modifying the source', { timeout: 20_000 }, async () => {
  const workspace = path.join(root, 'workspace-image');
  const destination = path.join(root, 'destination-image');
  await Promise.all([mkdir(workspace), mkdir(destination)]);
  const [runtimePath, destinationPath] = await Promise.all([realpath(workspace), realpath(destination)]);
  const events = [];
  const jobs = new RecoveryJobs({ workspace: runtimePath, onEvent: (event) => events.push(event), inspect: destinationInspector(runtimePath, destinationPath) });
  await jobs.initialize();
  try {
    const source = await jobs.addSource('image', fixture.imagePath);
    const output = await jobs.addDestination(destinationPath);
    const sourceBefore = hash(await readFile(fixture.imagePath));
    const started = await jobs.start({ sourceId: source.id, mode: 'deleted', destinationId: output.id, filters: { name: '삭제된 문서', extensions: ['txt'] } });
    await waitFor(events, (event) => event.jobId === started.jobId && event.type === 'complete');
    const all = jobs.candidates({ jobId: started.jobId, limit: 100, filters: {} });
    assert.ok(all.items.length >= 5, 'the deterministic image should expose its readable candidates');
    const filtered = jobs.candidates({ jobId: started.jobId, limit: 5, filters: { name: '삭제된 문서', extensions: ['txt'] } });
    assert.equal(filtered.matchCounts.partial, 1);
    assert.ok(filtered.total > 1, 'deleted-name search keeps other plausible candidates visible');
    const selected = filtered.items.find(item => item.name === '삭제된-문서.txt');
    assert.equal(selected.recordNumber, 24);
    assert.equal(selected.nameMatch.kind, 'partial');
    assert.ok(filtered.items.some(item => item.nameMatch.kind === 'none' || item.nameMatch.kind === 'unknown'));
    const preview = await jobs.preview({ jobId: started.jobId, id: selected.id });
    assert.equal(preview.type, 'text');
    assert.match(preview.text, /회복 연진 테스트 문서/);
    const recovery = await jobs.recover({ jobId: started.jobId, ids: [selected.id], destinationId: output.id });
    const complete = await waitFor(events, (event) => event.jobId === recovery.jobId && event.type === 'recover-complete');
    assert.equal(complete.results.length, 1);
    assert.equal(complete.results[0].status, 'saved');
    const expected = fixture.manifest.files.find((item) => item.recordNumber === 24);
    assert.equal(hash(await readFile(complete.results[0].path)), expected.sha256);
    const restored = complete.results[0];
    assert.equal(restored.integrity.status, 'verified');
    assert.equal(restored.integrity.sha256, expected.sha256);
    assert.equal(restored.document.status, 'preview-available');
    assert.equal(restored.document.applicationOpenVerified, false);
    assert.equal(restored.nameRecovery.originalNameStatus, 'record-name');
    assert.equal(restored.name, '삭제된-문서.txt');
    assert.equal(await jobs.recoveredPath({ jobId: recovery.jobId, id: selected.id }), restored.path);
    const restoredPreview = await jobs.previewRecovered({ jobId: recovery.jobId, id: selected.id });
    assert.equal(restoredPreview.type, 'text');
    assert.match(restoredPreview.text, /회복 연진 테스트 문서/);
    await assert.rejects(jobs.recoveredPath({ jobId: recovery.jobId, id: 'invented', path: fixture.imagePath }), { code: 'UNKNOWN_RESULT' });
    await writeFile(restored.path, Buffer.alloc(restored.size, 0x41));
    await assert.rejects(jobs.previewRecovered({ jobId: recovery.jobId, id: selected.id }), { code: 'OUTPUT_VERIFICATION_FAILED' });
    assert.equal(hash(await readFile(fixture.imagePath)), sourceBefore, 'scan and selected recovery must leave the image unchanged');
  } finally { await jobs.dispose(); }
});

test('long-name document copy retains its extension and reports the adjusted saved name through the worker', async () => {
  const workspace = path.join(root, 'workspace-long-name'), sourceRoot = path.join(root, 'source-long-name'), destination = path.join(root, 'destination-long-name');
  await Promise.all([mkdir(workspace), mkdir(sourceRoot), mkdir(destination)]);
  const name = '가'.repeat(191) + '.txt', bytes = Buffer.from('확장자를 보존한 복구 문서');
  await writeFile(path.join(sourceRoot, name), bytes);
  const runtimePath = await realpath(workspace), destinationPath = await realpath(destination), events = [];
  const jobs = new RecoveryJobs({ workspace: runtimePath, onEvent: event => events.push(event), inspect: destinationInspector(runtimePath, destinationPath) });
  try {
    await jobs.initialize();
    const source = await jobs.addSource('folder', sourceRoot), output = await jobs.addDestination(destinationPath);
    const started = await jobs.start({ sourceId: source.id, mode: 'copies', filters: {} });
    await waitFor(events, event => event.jobId === started.jobId && event.type === 'complete');
    const candidate = jobs.candidates({ jobId: started.jobId }).items.find(item => item.name === name);
    assert.ok(candidate);
    await jobs.recover({ jobId: started.jobId, ids: [candidate.id], destinationId: output.id });
    const complete = await waitFor(events, event => event.jobId === started.jobId && event.type === 'recover-complete');
    const result = complete.results[0];
    assert.equal(result.status, 'saved');
    assert.equal(result.name.length, 180);
    assert.equal(path.extname(result.path), '.txt');
    assert.equal(result.nameRecovery.adjustedForFilesystem, true);
    assert.equal(result.nameRecovery.name, name);
    assert.equal(result.nameRecovery.savedName, result.name);
    assert.equal(hash(await readFile(result.path)), hash(bytes));
    assert.equal(result.document.status, 'preview-available');
  } finally { await jobs.dispose(); }
});

test('volume output guards reject same physical disk, source drift, and changed output identity before worker access', async () => {
  const workspace = path.join(root, 'workspace-guards');
  const destination = path.join(root, 'destination-guards');
  await Promise.all([mkdir(workspace), mkdir(destination)]);
  const [runtimePath, destinationPath] = await Promise.all([realpath(workspace), realpath(destination)]);
  let destinationIdentity = 'dest-v1';
  let deviceIdentity = 'source-v1';
  const inventory = async () => [{ id: 'VOLUME-A', label: 'test volume', driveLetter: 'T:', fileSystem: 'NTFS', system: false, ready: true, identity: deviceIdentity, diskIds: ['1'] }];
  const inspect = async (target) => {
    const canonicalPath = await realpath(target);
    if (canonicalPath === runtimePath) return { canonicalPath, identity: 'runtime-v1', diskIds: ['8'], freeSpace: 1e12, fileSystem: 'NTFS' };
    return { canonicalPath, identity: destinationIdentity, diskIds: ['1'], freeSpace: 1e12, fileSystem: 'NTFS' };
  };
  const jobs = new RecoveryJobs({ workspace: runtimePath, inventory, inspect });
  await jobs.initialize();
  try {
    const sourceId = (await jobs.devices()).devices[0].id;
    const destinationId = (await jobs.addDestination(destinationPath)).id;
    const source = jobs.sources.get(sourceId);
    await assert.rejects(() => jobs.validateDestination(source, destinationId), { code: 'SAME_PHYSICAL_DISK' });
    destinationIdentity = 'dest-v2';
    await assert.rejects(() => jobs.validateDestination(source, destinationId), { code: 'DESTINATION_CHANGED' });

    // A fresh output selection lets the source-identity check run independently of the changed destination check.
    const freshId = (await jobs.addDestination(destinationPath)).id;
    destinationIdentity = 'dest-v2';
    deviceIdentity = 'source-v2';
    await assert.rejects(() => jobs.validateDestination(source, freshId), { code: 'SOURCE_CHANGED' });
  } finally { await jobs.dispose(); }
});

test('pause, resume and cancellation messages have deterministic service state transitions', async () => {
  const workspace = path.join(root, 'workspace-controls');
  await mkdir(workspace);
  const runtimePath = await realpath(workspace);
  const posted = [];
  const jobs = new RecoveryJobs({ workspace: runtimePath, inspect: async (target) => ({ canonicalPath: await realpath(target), identity: 'runtime', diskIds: ['8'], freeSpace: 1e12, fileSystem: 'NTFS' }) });
  await jobs.initialize();
  const job = { id: 'controlled-job', status: 'scanning', worker: { postMessage: (message) => posted.push(message) }, candidates: new Map(), results: [], stats: {}, source: { kind: 'folder' }, outputPath: runtimePath };
  jobs.jobs.set(job.id, job);
  assert.deepEqual(jobs.pause(job.id), { jobId: job.id });
  assert.deepEqual(posted.pop(), { type: 'pause' });
  jobs.receive(job, { type: 'paused' });
  assert.equal(job.status, 'paused');
  assert.deepEqual(jobs.resume(job.id), { jobId: job.id });
  assert.deepEqual(posted.pop(), { type: 'resume' });
  jobs.receive(job, { type: 'resumed' });
  assert.equal(job.status, 'scanning');
  assert.deepEqual(jobs.cancel(job.id), { jobId: job.id });
  assert.deepEqual(posted.pop(), { type: 'cancel' });
  assert.equal(job.status, 'cancelling');
  jobs.receive(job, { type: 'cancelled' });
  assert.equal(job.status, 'cancelled');
});

test('existing-copy preview and duplicate hashing resolve through correlated worker replies', { timeout: 20_000 }, async () => {
  const workspace = path.join(root, 'workspace-rpc');
  const sourceDirectory = path.join(root, 'copies-rpc');
  await Promise.all([mkdir(workspace), mkdir(sourceDirectory)]);
  await Promise.all([
    writeFile(path.join(sourceDirectory, 'same-a.txt'), 'same recovery content'),
    writeFile(path.join(sourceDirectory, 'same-b.txt'), 'same recovery content'),
  ]);
  const [runtimePath, sourcePath] = await Promise.all([realpath(workspace), realpath(sourceDirectory)]);
  const events = [];
  const jobs = new RecoveryJobs({ workspace: runtimePath, onEvent: (event) => events.push(event), inspect: async (target) => ({ canonicalPath: await realpath(target), identity: 'local', diskIds: ['8'], freeSpace: 1e12, fileSystem: 'NTFS' }) });
  await jobs.initialize();
  try {
    const source = await jobs.addSource('folder', sourcePath);
    const started = await jobs.start({ sourceId: source.id, mode: 'copies', filters: {} });
    await waitFor(events, (event) => event.jobId === started.jobId && event.type === 'complete');
    const candidates = jobs.candidates({ jobId: started.jobId, limit: 20, filters: {} }).items.filter((item) => /^same-[ab]\.txt$/u.test(item.name));
    assert.equal(candidates.length, 2);
    const preview = await jobs.preview({ jobId: started.jobId, id: candidates[0].id });
    assert.equal(preview.type, 'text');
    assert.equal(preview.text, 'same recovery content');
    const duplicate = await jobs.requestWorker(jobs.getJob(started.jobId), 'hash', { ids: candidates.map((item) => item.id) });
    assert.equal(duplicate.complete, true);
    assert.equal(duplicate.groups.length, 1);
    assert.equal(duplicate.groups[0].candidates.length, 2);
  } finally { await jobs.dispose(); }
});

test('index refresh removes only represented unavailable files from both caches and ignores forged stored IDs', async () => {
  const workspace = path.join(root, 'workspace-index-refresh'), sourceDirectory = path.join(root, 'index-refresh');
  await Promise.all([mkdir(workspace), mkdir(sourceDirectory)]);
  const stalePath = path.join(sourceDirectory, 'stale.txt');
  await writeFile(stalePath, 'generated stale fixture'); await writeFile(path.join(sourceDirectory, 'keep.txt'), 'keep current-job-only file');
  const events = [];
  const jobs = new RecoveryJobs({ workspace, onEvent: event => events.push(event), inspect: async target => ({ canonicalPath: await realpath(target), identity: 'fixture', diskIds: ['8'], freeSpace: 1e12, fileSystem: 'NTFS' }) });
  await jobs.initialize();
  try {
    const source = await jobs.addSource('folder', sourceDirectory);
    const { jobId } = await jobs.start({ sourceId: source.id, mode: 'copies', filters: {} });
    await waitFor(events, e => e.jobId === jobId && e.type === 'complete');
    const job = jobs.getJob(jobId), scanned = jobs.candidates({ jobId, limit: 20 }).items;
    const stale = scanned.find(c => c.name === 'stale.txt'), kept = scanned.find(c => c.name === 'keep.txt');
    const index = await jobs.requestWorker(job, 'save-index');
    const stored = JSON.parse(await readFile(index.path, 'utf8'));
    stored.candidates = [{ ...stale, id: kept.id }];
    await writeFile(index.path, JSON.stringify(stored));
    await rm(stalePath); // Only this generated fixture file is removed.
    const refreshed = await jobs.requestWorker(job, 'load-index', { path: index.path });
    assert.equal(refreshed.stats.deleted, 1); assert.equal(refreshed.stats.removed, 1);
    assert.deepEqual(refreshed.removedIds, [stale.id]);
    assert.deepEqual(jobs.candidates({ jobId, limit: 20 }).items.map(c => c.id), [kept.id]);
    await assert.rejects(jobs.preview({ jobId, id: stale.id }), { code: 'UNKNOWN_CANDIDATE' });
    assert.ok(events.some(e => e.type === 'candidates-removed' && e.ids.includes(stale.id)));
    const savedAgain = await jobs.requestWorker(job, 'save-index');
    const workerCandidates = JSON.parse(await readFile(savedAgain.path, 'utf8')).candidates;
    assert.deepEqual(workerCandidates.map(c => c.id), [kept.id]);
    assert.equal(await readFile(kept.path, 'utf8'), 'keep current-job-only file');
  } finally { await jobs.dispose(); }
});

test('restart restores history but requires the same reselected source identity before a rescan', { timeout: 20_000 }, async () => {
  const workspace = path.join(root, 'workspace-history');
  const destination = path.join(root, 'destination-history');
  const image = path.join(root, 'history-source.img');
  await Promise.all([mkdir(workspace), mkdir(destination), copyFile(fixture.imagePath, image)]);
  const [runtimePath, destinationPath] = await Promise.all([realpath(workspace), realpath(destination)]);
  const events = [];
  const first = new RecoveryJobs({ workspace: runtimePath, onEvent: event => events.push(event), inspect: destinationInspector(runtimePath, destinationPath) });
  await first.initialize();
  let previous;
  try {
    const source = await first.addSource('image', image); const output = await first.addDestination(destinationPath);
    previous = await first.start({ sourceId: source.id, mode: 'deleted', destinationId: output.id, filters: {} });
    await waitFor(events, event => event.jobId === previous.jobId && event.type === 'complete');
    await first.getJob(previous.jobId).persistTask;
  } finally { await first.dispose(); }

  const resumed = new RecoveryJobs({ workspace: runtimePath, inspect: destinationInspector(runtimePath, destinationPath) });
  await resumed.initialize();
  try {
    const history = resumed.history();
    assert.equal(history.jobs[0].jobId, previous.jobId);
    assert.equal(history.jobs[0].sourceKind, 'image');
    assert.match(history.restartPolicy, /원본을 다시 확인/);
    await writeFile(image, Buffer.concat([await readFile(image), Buffer.from('identity drift')]));
    const source = await resumed.addSource('image', image); const output = await resumed.addDestination(destinationPath);
    await assert.rejects(() => resumed.start({ sourceId: source.id, mode: 'deleted', destinationId: output.id, resumeId: previous.jobId, filters: {} }), { code: 'SOURCE_CHANGED' });
  } finally { await resumed.dispose(); }
});

test('deep whole-image carving publishes selected complete PNG and PDF only into the final destination', { timeout: 20_000 }, async () => {
  const workspace = path.join(root, 'workspace-deep'); const destination = path.join(root, 'destination-deep'); const image = path.join(root, 'whole-source.bin');
  const png = tinyPng(); const pdf = tinyPdf();
  await Promise.all([mkdir(workspace), mkdir(destination), writeFile(image, Buffer.concat([Buffer.alloc(91, 0x44), png, Buffer.alloc(37, 0x45), pdf, Buffer.alloc(19, 0x46)]))]);
  const [runtimePath, destinationPath] = await Promise.all([realpath(workspace), realpath(destination)]);
  const events = []; const jobs = new RecoveryJobs({ workspace: runtimePath, onEvent: event => events.push(event), inspect: destinationInspector(runtimePath, destinationPath) });
  await jobs.initialize();
  try {
    const source = await jobs.addSource('image', image); const output = await jobs.addDestination(destinationPath);
    const started = await jobs.start({ sourceId: source.id, mode: 'deep', deepScope: 'whole', destinationId: output.id, filters: {} });
    await waitFor(events, event => event.jobId === started.jobId && event.type === 'complete');
    const listed = jobs.candidates({ jobId: started.jobId, limit: 20, filters: {} });
    assert.equal(jobs.getJob(started.jobId).stats.scanScope, 'whole-source');
    const pngCandidate = listed.items.find(item => item.format === 'png' && item.status === 'readable'); const pdfCandidate = listed.items.find(item => item.format === 'pdf' && item.status === 'readable');
    assert.ok(pngCandidate); assert.ok(pdfCandidate);
    const staged = await realpath(pngCandidate.path); assert.ok(staged.startsWith(jobs.getJob(started.jobId).outputPath));
    const recovery = await jobs.recover({ jobId: started.jobId, ids: [pngCandidate.id, pdfCandidate.id], destinationId: output.id });
    const complete = await waitFor(events, event => event.jobId === recovery.jobId && event.type === 'recover-complete');
    assert.deepEqual(complete.results.map(item => item.status), ['saved', 'saved']);
    for (const result of complete.results) {
      const finalPath = await realpath(result.path);
      assert.ok(finalPath.startsWith(jobs.getJob(started.jobId).resultPath), 'selected carved bytes must be copied to the final result folder');
      assert.ok(!finalPath.startsWith(jobs.getJob(started.jobId).outputPath), 'staging artifacts must not be reported as final saved results');
    }
    assert.deepEqual(await readFile(complete.results[0].path), png); assert.deepEqual(await readFile(complete.results[1].path), pdf);
  } finally { await jobs.dispose(); }
});

test('a partial deep-scan artifact stays staged and is never published as saved', { timeout: 20_000 }, async () => {
  const workspace = path.join(root, 'workspace-partial'); const destination = path.join(root, 'destination-partial'); const image = path.join(root, 'partial-source.bin');
  await Promise.all([mkdir(workspace), mkdir(destination), writeFile(image, Buffer.concat([Buffer.alloc(17), tinyPng().subarray(0, -7)]))]);
  const [runtimePath, destinationPath] = await Promise.all([realpath(workspace), realpath(destination)]);
  const events = []; const jobs = new RecoveryJobs({ workspace: runtimePath, onEvent: event => events.push(event), inspect: destinationInspector(runtimePath, destinationPath) });
  await jobs.initialize();
  try {
    const source = await jobs.addSource('image', image); const output = await jobs.addDestination(destinationPath);
    const started = await jobs.start({ sourceId: source.id, mode: 'deep', deepScope: 'whole', destinationId: output.id, filters: {} });
    await waitFor(events, event => event.jobId === started.jobId && event.type === 'complete');
    const partial = jobs.candidates({ jobId: started.jobId, limit: 20, filters: {} }).items.find(item => item.status === 'partial');
    assert.ok(partial, 'truncated validated artifact is shown as partial');
    const recovery = await jobs.recover({ jobId: started.jobId, ids: [partial.id], destinationId: output.id });
    const complete = await waitFor(events, event => event.jobId === recovery.jobId && event.type === 'recover-complete');
    assert.equal(complete.results[0].status, 'failed');
    assert.match(complete.results[0].error, /부분 추출/);
    assert.ok((await findFiles(jobs.getJob(started.jobId).outputPath)).some(file => file.endsWith('.partial')), 'the partial staging artifact remains distinct from final output');
    assert.equal((await findFiles(jobs.getJob(started.jobId).resultPath)).length, 0, 'no partial artifact is published into final results');
  } finally { await jobs.dispose(); }
});

test('a source changed after selection is rejected before the worker starts', async () => {
  const workspace = path.join(root, 'workspace-source-drift'); const destination = path.join(root, 'destination-source-drift'); const image = path.join(root, 'source-drift.img');
  await Promise.all([mkdir(workspace), mkdir(destination), copyFile(fixture.imagePath, image)]);
  const [runtimePath, destinationPath] = await Promise.all([realpath(workspace), realpath(destination)]);
  const jobs = new RecoveryJobs({ workspace: runtimePath, inspect: destinationInspector(runtimePath, destinationPath) });
  await jobs.initialize();
  try {
    const source = await jobs.addSource('image', image); const output = await jobs.addDestination(destinationPath);
    await writeFile(image, Buffer.concat([await readFile(image), Buffer.from('changed after selection')]));
    await assert.rejects(() => jobs.start({ sourceId: source.id, mode: 'deleted', destinationId: output.id, filters: {} }), { code: 'SOURCE_CHANGED' });
    assert.equal(jobs.jobs.size, 0);
  } finally { await jobs.dispose(); }
});

test('persisted image checkpoints resume across service instances and reject changed checkpoint bytes', { timeout: 20_000 }, async () => {
  const workspace = path.join(root, 'checkpoint-workspace'), destination = path.join(root, 'checkpoint-destination');
  await Promise.all([mkdir(workspace), mkdir(destination)]);
  const [runtimePath, destinationPath] = await Promise.all([realpath(workspace), realpath(destination)]);
  const events = [], inspect = destinationInspector(runtimePath, destinationPath);
  let jobs = new RecoveryJobs({ workspace: runtimePath, inspect, onEvent: e => events.push(e) });
  await jobs.initialize();
  const source = await jobs.addSource('image', fixture.imagePath), out = await jobs.addDestination(destinationPath);
  const first = await jobs.start({ sourceId: source.id, destinationId: out.id, mode: 'deleted' });
  await waitFor(events, e => e.jobId === first.jobId && e.type === 'complete');
  const count = jobs.candidates({ jobId: first.jobId, limit: 100 }).total;
  const oldFolder = jobs.getJob(first.jobId).outputPath;
  await jobs.dispose();
  jobs = new RecoveryJobs({ workspace: runtimePath, inspect, onEvent: e => events.push(e) });
  await jobs.initialize();
  try {
    assert.equal(jobs.history().jobs.find(j => j.id === first.jobId).canContinue, true);
    const selected = await jobs.addSource('image', fixture.imagePath), destination2 = await jobs.addDestination(destinationPath);
    const resumed = await jobs.start({ sourceId: selected.id, destinationId: destination2.id, mode: 'deleted', resumeId: first.jobId });
    await waitFor(events, e => e.jobId === resumed.jobId && e.type === 'complete');
    assert.equal(jobs.candidates({ jobId: resumed.jobId, limit: 100 }).total, count);
    assert.ok(events.some(e => e.jobId === resumed.jobId && e.type === 'progress' && e.stats?.resumed));
    await writeFile(path.join(oldFolder, 'checkpoint.json'), '{}');
    await assert.rejects(() => jobs.start({ sourceId: selected.id, destinationId: destination2.id, mode: 'deleted', resumeId: first.jobId }), { code: 'INVALID_CHECKPOINT' });
  } finally { await jobs.dispose(); }
});

test('broadening filters after a copies scan reveals names hidden by the initial filter', { timeout: 20_000 }, async () => {
  const workspace = path.join(root, 'workspace-broaden'); const sourceDirectory = path.join(root, 'copies-broaden');
  await Promise.all([mkdir(workspace), mkdir(sourceDirectory)]);
  await Promise.all([writeFile(path.join(sourceDirectory, '제한된-보고서.txt'), 'initial match'), writeFile(path.join(sourceDirectory, '숨은-사진.txt'), 'available after broadening')]);
  const [runtimePath, sourcePath] = await Promise.all([realpath(workspace), realpath(sourceDirectory)]);
  const events = []; const jobs = new RecoveryJobs({ workspace: runtimePath, onEvent: event => events.push(event), inspect: async target => ({ canonicalPath: await realpath(target), identity: 'local', diskIds: ['8'], freeSpace: 1e12, fileSystem: 'NTFS' }) });
  await jobs.initialize();
  try {
    const source = await jobs.addSource('folder', sourcePath); const started = await jobs.start({ sourceId: source.id, mode: 'copies', filters: { name: '제한된' } });
    await waitFor(events, event => event.jobId === started.jobId && event.type === 'complete');
    const initial = jobs.candidates({ jobId: started.jobId, limit: 20 }).items.map(item => item.name);
    const widened = jobs.candidates({ jobId: started.jobId, limit: 20, filters: {} }).items.map(item => item.name);
    assert.ok(initial.includes('제한된-보고서.txt')); assert.ok(!initial.includes('숨은-사진.txt'));
    assert.ok(widened.includes('제한된-보고서.txt')); assert.ok(widened.includes('숨은-사진.txt'));
  } finally { await jobs.dispose(); }
});

test('deleted candidate pages expose match counts, time labels, and reversible date filtering', () => {
  const jobs = new RecoveryJobs({ workspace: os.tmpdir() });
  jobs.jobs.set('listed', { id: 'listed', mode: 'deleted', complete: true, status: 'results', candidates: new Map([
    ['exact', { id: 'exact', name: '보고서.txt', deletedAt: '2026-09-10T00:00:00.000Z', deletedAtSource: 'ntfs-usn' }],
    ['none', { id: 'none', name: '휴가사진.jpg', deletedAt: '2026-09-10T12:00:00.000Z', deletedAtSource: 'ntfs-usn' }],
    ['unknown', { id: 'unknown', name: 'record-7', nameIsGenerated: true, deletedAt: null }],
    ['older', { id: 'older', name: '과거.txt', deletedAt: '2026-09-01T00:00:00.000Z', deletedAtSource: 'ntfs-usn' }]
  ]) });
  const range = { name: '보고서.txt', deletedAfter: '2026-09-10T00:00:00.000Z', deletedBefore: '2026-09-10T23:59:59.999Z' };
  const page = jobs.candidates({ jobId: 'listed', limit: 100, filters: range });
  assert.equal(page.total, 3); assert.deepEqual(page.matchCounts, { exact: 1, partial: 0, similar: 0, unknown: 1, none: 1 });
  assert.equal(page.unknownDeletedTimeTotal, 1); assert.equal(page.items[0].id, 'exact');
  assert.equal(page.items[0].deletedAtKind, 'final-delete-record'); assert.equal(page.items[0].deletedAtLabel, '최종 삭제 기록 시각');
  assert.equal(jobs.candidates({ jobId: 'listed', limit: 100, filters: { ...range, includeUnknownDeletedAt: false } }).total, 2);
  assert.equal(jobs.candidates({ jobId: 'listed', limit: 100, filters: { name: '보고서.txt' } }).total, 4);
});
