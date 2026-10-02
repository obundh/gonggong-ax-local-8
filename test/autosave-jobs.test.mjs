import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

import { RecoveryJobs } from '../engine/job-service.mjs';

let root;

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function waitFor(events, predicate, timeout = 15_000) {
  return new Promise((resolve, reject) => {
    const found = events.find(predicate);
    if (found) { resolve(found); return; }
    const timer = setTimeout(() => {
      clearInterval(poll);
      reject(new Error('Timed out waiting for autosave worker event'));
    }, timeout);
    const poll = setInterval(() => {
      const event = events.find(predicate);
      if (!event) return;
      clearTimeout(timer); clearInterval(poll); resolve(event);
    }, 10);
  });
}

async function inspectFixturePath(target) {
  const canonicalPath = await realpath(target);
  const info = await stat(canonicalPath, { bigint: true });
  return { canonicalPath, identity: `${info.dev}:${info.ino}`, diskIds: ['fixture-disk'], freeSpace: 1e12, fileSystem: 'NTFS' };
}

async function fixtureSet(label) {
  const base = path.join(root, label);
  const workspace = path.join(base, 'workspace');
  const destination = path.join(base, 'destination');
  const word = path.join(base, 'word-autorecover');
  const excel = path.join(base, 'excel-unsaved');
  await Promise.all([mkdir(workspace, { recursive: true }), mkdir(destination, { recursive: true }),
    mkdir(word, { recursive: true }), mkdir(excel, { recursive: true })]);
  const inventory = async () => [
    { app: 'Word', name: '자동 복구', path: word, exists: true },
    { app: 'Excel', name: '저장 안 함', path: excel, exists: true },
  ];
  return { base, workspace, destination, word, excel, inventory };
}

before(async () => { root = await mkdtemp(path.join(os.tmpdir(), 'recovery-autosave-jobs-')); });
after(async () => { await rm(root, { recursive: true, force: true }); });

test('autosave metadata-only search keeps multi-root provenance, excludes owner/executables, previews, and copies exact bytes', { timeout: 20_000 }, async () => {
  const fixture = await fixtureSet('metadata-copy');
  const wordBytes = Buffer.from('Word autosave fixture\nsecond line', 'utf8');
  const excelBytes = Buffer.from('Excel autosave fixture', 'utf8');
  const wordFile = path.join(fixture.word, 'draft.txt');
  const excelFile = path.join(fixture.excel, 'book.txt');
  await Promise.all([
    writeFile(wordFile, wordBytes),
    writeFile(excelFile, excelBytes),
    writeFile(path.join(fixture.word, '~$draft.txt'), 'owner marker must not be a candidate'),
    writeFile(path.join(fixture.excel, 'helper.exe'), 'executable must not be a candidate'),
  ]);
  const sourceHashes = new Map([[wordFile, sha256(wordBytes)], [excelFile, sha256(excelBytes)]]);
  const events = [];
  const jobs = new RecoveryJobs({ workspace: fixture.workspace, autosaveInventory: fixture.inventory,
    inspect: inspectFixturePath, onEvent: event => events.push(event) });
  await jobs.initialize();
  try {
    const discovery = await jobs.autosaveSource();
    assert.equal(discovery.source.kind, 'autosave');
    assert.equal(discovery.locations.length, 2);
    assert.deepEqual(discovery.warnings, []);

    const started = await jobs.start({ sourceId: discovery.source.id, mode: 'autosave', filters: {} });
    await waitFor(events, event => event.jobId === started.jobId && event.type === 'complete');
    const job = jobs.getJob(started.jobId);
    assert.equal(job.outputPath, null);
    assert.equal(job.destinationId, undefined);

    const candidates = jobs.candidates({ jobId: started.jobId, limit: 20, filters: {} }).items;
    assert.deepEqual(candidates.map(candidate => candidate.name).sort(), ['book.txt', 'draft.txt']);
    for (const candidate of candidates) {
      assert.equal(candidate.source, 'existing-file');
      assert.equal(candidate.autosave.relationship, 'unknown');
      assert.equal(candidate.autosave.source, 'office-default-location');
      assert.equal(typeof candidate.autosave.rootIdentity.dev, 'string');
      assert.equal(typeof candidate.autosave.rootIdentity.ino, 'string');
      assert.equal(candidate.autosave.rootPath, candidate.name === 'draft.txt' ? await realpath(fixture.word) : await realpath(fixture.excel));
      assert.equal(candidate.autosave.app, candidate.name === 'draft.txt' ? 'Word' : 'Excel');
      assert.equal(candidate.autosave.name, candidate.name === 'draft.txt' ? '자동 복구' : '저장 안 함');
    }

    const selected = candidates.find(candidate => candidate.name === 'draft.txt');
    const preview = await jobs.preview({ jobId: started.jobId, id: selected.id });
    assert.equal(preview.type, 'text');
    assert.match(preview.text, /Word autosave fixture/);

    const output = await jobs.addDestination(fixture.destination);
    const recovery = await jobs.recover({ jobId: started.jobId, ids: [selected.id], destinationId: output.id });
    const complete = await waitFor(events, event => event.jobId === recovery.jobId && event.type === 'recover-complete');
    assert.equal(complete.results.length, 1);
    const result = complete.results[0];
    assert.equal(result.status, 'saved');
    assert.equal(result.originalIdentityVerified, false);
    assert.deepEqual(result.autosave, selected.autosave);
    assert.equal(sha256(await readFile(result.path)), sourceHashes.get(wordFile));
    for (const [file, expected] of sourceHashes) assert.equal(sha256(await readFile(file)), expected, 'autosave source must stay unchanged');
  } finally { await jobs.dispose(); }
});

test('autosave source and mode are mutually required', async () => {
  const fixture = await fixtureSet('mode-guard');
  await writeFile(path.join(fixture.word, 'draft.txt'), 'mode guard fixture');
  const jobs = new RecoveryJobs({ workspace: fixture.workspace, autosaveInventory: fixture.inventory, inspect: inspectFixturePath });
  await jobs.initialize();
  try {
    const discovery = await jobs.autosaveSource();
    await assert.rejects(jobs.start({ sourceId: discovery.source.id, mode: 'copies', filters: {} }), { code: 'SOURCE_KIND' });
    const folder = await jobs.addSource('folder', fixture.word);
    await assert.rejects(jobs.start({ sourceId: folder.id, mode: 'autosave', filters: {} }), { code: 'SOURCE_KIND' });
  } finally { await jobs.dispose(); }
});

test('destination inside an autosave root is rejected before worker creation', async () => {
  const fixture = await fixtureSet('destination-guard');
  const inside = path.join(fixture.word, 'recovered-here');
  await mkdir(inside);
  await writeFile(path.join(fixture.word, 'draft.txt'), 'destination guard fixture');
  const jobs = new RecoveryJobs({ workspace: fixture.workspace, autosaveInventory: fixture.inventory, inspect: inspectFixturePath });
  await jobs.initialize();
  try {
    const discovery = await jobs.autosaveSource();
    const destination = await jobs.addDestination(inside);
    await assert.rejects(jobs.start({ sourceId: discovery.source.id, mode: 'autosave', destinationId: destination.id, filters: {} }), { code: 'UNSAFE_OUTPUT' });
    assert.equal(jobs.jobs.size, 0);
  } finally { await jobs.dispose(); }
});

test('replacing an autosave root after scanning blocks preview and recovery even when the original file inode is moved back', { timeout: 20_000 }, async () => {
  const fixture = await fixtureSet('root-replacement');
  const file = path.join(fixture.word, 'draft.txt');
  const parked = path.join(fixture.base, 'old-word-root');
  await writeFile(file, 'root identity fixture');
  const events = [];
  const jobs = new RecoveryJobs({ workspace: fixture.workspace, autosaveInventory: fixture.inventory,
    inspect: inspectFixturePath, onEvent: event => events.push(event) });
  await jobs.initialize();
  try {
    const discovery = await jobs.autosaveSource();
    const started = await jobs.start({ sourceId: discovery.source.id, mode: 'autosave', filters: {} });
    await waitFor(events, event => event.jobId === started.jobId && event.type === 'complete');
    const candidate = jobs.candidates({ jobId: started.jobId, limit: 20, filters: {} }).items.find(item => item.name === 'draft.txt');
    assert.ok(candidate);

    await rename(fixture.word, parked);
    await mkdir(fixture.word);
    await rename(path.join(parked, 'draft.txt'), file);
    assert.equal(sha256(await readFile(file)), sha256(Buffer.from('root identity fixture')));

    await assert.rejects(jobs.preview({ jobId: started.jobId, id: candidate.id }), { code: 'SOURCE_CHANGED' });
    const output = await jobs.addDestination(fixture.destination);
    await assert.rejects(jobs.recover({ jobId: started.jobId, ids: [candidate.id], destinationId: output.id }), { code: 'SOURCE_CHANGED' });
  } finally { await jobs.dispose(); }
});

test('autosave jobs reject loading a stored candidate index', { timeout: 20_000 }, async () => {
  const fixture = await fixtureSet('index-guard');
  await writeFile(path.join(fixture.word, 'draft.txt'), 'index guard fixture');
  const events = [];
  const jobs = new RecoveryJobs({ workspace: fixture.workspace, autosaveInventory: fixture.inventory,
    inspect: inspectFixturePath, onEvent: event => events.push(event) });
  await jobs.initialize();
  try {
    const discovery = await jobs.autosaveSource();
    const started = await jobs.start({ sourceId: discovery.source.id, mode: 'autosave', filters: {} });
    await waitFor(events, event => event.jobId === started.jobId && event.type === 'complete');
    assert.throws(() => jobs.requestWorker(jobs.getJob(started.jobId), 'load-index', { path: path.join(fixture.base, 'forged-index.json') }), { code: 'INVALID_MODE' });
  } finally { await jobs.dispose(); }
});
