import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  assertAutosaveCandidate,
  discoverAutosaveLocations,
  prepareAutosaveRoots,
  searchAutosaveRoots,
  validateAutosaveRoots
} from '../engine/autosave-search.mjs';

async function isolated(callback) {
  const temporaryRoot = path.resolve(os.tmpdir());
  const root = await mkdtemp(path.join(temporaryRoot, 'recoverychat-autosave-'));
  try { await callback(root); }
  finally {
    const relative = path.relative(temporaryRoot, root);
    assert.ok(relative.startsWith('recoverychat-autosave-') && !relative.includes(path.sep) && !path.isAbsolute(relative));
    await rm(root, { recursive: true, force: true });
  }
}

async function prepared(folder, app = 'Microsoft Word', name = '자동 복구 폴더') {
  return prepareAutosaveRoots([{ path: folder, app, name, exists: true, status: 'existing' }]);
}

test('discovery reports the four fixed Office locations and distinguishes missing from invalid', async () => isolated(async home => {
  const unsaved = path.join(home, 'AppData', 'Local', 'Microsoft', 'Office', 'UnsavedFiles');
  const word = path.join(home, 'AppData', 'Roaming', 'Microsoft', 'Word');
  await mkdir(unsaved, { recursive: true });
  await mkdir(path.dirname(word), { recursive: true });
  await writeFile(word, 'not a directory');

  const locations = await discoverAutosaveLocations(home);
  assert.equal(locations.length, 4);
  assert.deepEqual(locations.map(item => item.status), ['existing', 'error', 'missing', 'missing']);
  assert.equal(locations[0].exists, true);
  assert.equal(locations[1].error.code, 'UNSUPPORTED_ROOT');
  assert.ok(locations.every(item => item.path.startsWith(home)));
}));

test('preparation canonicalizes and deduplicates roots with bigint-derived identities', async () => isolated(async root => {
  const folder = path.join(root, 'Office');
  await mkdir(folder);
  const roots = await prepareAutosaveRoots([
    { path: folder, app: 'Microsoft Office', name: 'first', exists: true },
    { path: path.join(folder, '.'), app: 'Microsoft Word', name: 'duplicate', status: 'existing' },
    { path: path.join(root, 'missing'), app: 'Microsoft Excel', name: 'missing', status: 'missing', exists: false }
  ]);
  assert.equal(roots.length, 1);
  assert.match(roots[0].identity.dev, /^\d+$/);
  assert.match(roots[0].identity.ino, /^\d+$/);
  assert.equal(roots[0].name, 'first');
  assert.deepEqual(await validateAutosaveRoots(roots), roots);
}));

test('search includes document, Office autosave, and extensionless files but excludes owner and executable files', async () => isolated(async root => {
  const folder = path.join(root, 'Word');
  await mkdir(path.join(folder, 'nested'), { recursive: true });
  for (const name of ['report.docx', 'rescue.asd', 'sheet.xar', 'temporary.tmp', 'extensionless']) {
    await writeFile(path.join(folder, 'nested', name), name);
  }
  await writeFile(path.join(folder, 'nested', '~$report.docx'), 'owner lock');
  await writeFile(path.join(folder, 'nested', 'program.exe'), 'not a document');
  await writeFile(path.join(folder, 'nested', 'photo.jpg'), 'not a document');

  const roots = await prepared(folder);
  const streamed = [];
  const result = await searchAutosaveRoots(roots, { onCandidate: item => streamed.push(item) });
  assert.equal(result.complete, true);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.candidates.map(item => item.name).sort(),
    ['extensionless', 'report.docx', 'rescue.asd', 'sheet.xar', 'temporary.tmp']);
  assert.ok(result.candidates.every(item => item.source === 'existing-file' && item.status === 'existing' && item.kind === 'document'));
  assert.ok(result.candidates.every(item => item.autosave.source === 'office-default-location'
    && item.autosave.relationship === 'unknown' && item.autosave.rootPath === roots[0].path));
  assert.deepEqual(streamed.map(item => item.id), result.candidates.map(item => item.id));
  assert.equal(result.coverage.kind, 'autosave');
  assert.equal(result.coverage.filesVisited, 8);
  assert.equal(result.stats.ineligibleFilesSkipped, 3);
  assert.equal(result.coverage.roots[0].status, 'scanned');
}));

test('filters are applied to autosave candidates after document classification', async () => isolated(async root => {
  const folder = path.join(root, 'Excel');
  await mkdir(folder);
  await writeFile(path.join(folder, 'budget.tmp'), 'draft');
  await writeFile(path.join(folder, 'notes.txt'), 'notes');
  const roots = await prepared(folder, 'Microsoft Excel');
  const result = await searchAutosaveRoots(roots, { filters: { name: 'budget', kind: 'document', extensions: ['tmp'] } });
  assert.deepEqual(result.candidates.map(item => item.name), ['budget.tmp']);
}));

test('candidate assertion validates Office provenance, root identity, and containment', async () => isolated(async root => {
  const folder = path.join(root, 'PowerPoint');
  await mkdir(folder);
  await writeFile(path.join(folder, 'deck.pptx'), 'deck');
  const roots = await prepared(folder, 'Microsoft PowerPoint');
  const candidate = (await searchAutosaveRoots(roots)).candidates[0];
  assert.equal(await assertAutosaveCandidate(candidate), candidate);

  await assert.rejects(assertAutosaveCandidate({ ...candidate, autosave: { ...candidate.autosave, relationship: 'same-document' } }),
    { code: 'INVALID_CANDIDATE' });
  await assert.rejects(assertAutosaveCandidate({ ...candidate, path: path.join(root, 'outside.pptx') }),
    { code: 'PATH_OUTSIDE_ROOT' });
  await assert.rejects(assertAutosaveCandidate({ ...candidate, rootPath: root }),
    { code: 'INVALID_CANDIDATE' });
}));

test('candidate assertion rejects an unchanged file reached through a new escaping directory link', async t => isolated(async root => {
  const folder = path.join(root, 'Office');
  const originalParent = path.join(folder, 'drafts');
  const movedParent = path.join(root, 'moved-drafts');
  await mkdir(originalParent, { recursive: true });
  await writeFile(path.join(originalParent, 'deck.pptx'), 'deck');
  const candidate = (await searchAutosaveRoots(await prepared(folder))).candidates[0];
  await rename(originalParent, movedParent);
  try { await symlink(movedParent, originalParent, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES') return t.skip(`links unavailable: ${error.code}`);
    throw error;
  }
  await assert.rejects(assertAutosaveCandidate(candidate), { code: 'SOURCE_CHANGED' });
}));

test('file and candidate limits are global across roots and produce explicit coverage', async () => isolated(async root => {
  const first = path.join(root, 'Word');
  const second = path.join(root, 'Excel');
  await mkdir(first);
  await mkdir(second);
  await writeFile(path.join(first, 'one.docx'), 'one');
  await writeFile(path.join(second, 'two.xlsx'), 'two');
  const roots = await prepareAutosaveRoots([
    { path: first, app: 'Microsoft Word', name: 'Word' },
    { path: second, app: 'Microsoft Excel', name: 'Excel' }
  ]);
  const result = await searchAutosaveRoots(roots, { maxFiles: 1 });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.stats.filesVisited, 1);
  assert.equal(result.complete, false);
  assert.equal(result.truncated, true);
  assert.equal(result.coverage.stopReason, 'file-limit');
  assert.equal(result.coverage.rootsScanned, 1);
  assert.equal(result.warnings.at(-1).code, 'FILE_LIMIT');
}));

test('a replaced autosave root fails closed with SOURCE_CHANGED', async () => isolated(async root => {
  const folder = path.join(root, 'Office');
  await mkdir(folder);
  const roots = await prepared(folder);
  await rm(folder, { recursive: true });
  await mkdir(folder);
  await assert.rejects(validateAutosaveRoots(roots), { code: 'SOURCE_CHANGED' });
  await assert.rejects(searchAutosaveRoots(roots), { code: 'SOURCE_CHANGED' });
}));

test('cancellation interrupts traversal instead of returning partial success', async () => isolated(async root => {
  const folder = path.join(root, 'Office');
  await mkdir(folder);
  await writeFile(path.join(folder, 'one.docx'), 'one');
  const roots = await prepared(folder);
  const controller = new AbortController();
  let checkpoints = 0;
  await assert.rejects(searchAutosaveRoots(roots, {
    signal: controller.signal,
    control: { checkpoint: async () => { if (++checkpoints === 2) controller.abort(); } }
  }), { code: 'CANCELLED' });
}));

test('a directory that becomes unreadable during traversal is warned and marks coverage incomplete', async () => isolated(async root => {
  const folder = path.join(root, 'Office');
  const nested = path.join(folder, 'nested');
  await mkdir(nested, { recursive: true });
  await writeFile(path.join(nested, 'draft.docx'), 'draft');
  const roots = await prepared(folder);
  let checkpoints = 0;
  const result = await searchAutosaveRoots(roots, {
    control: { checkpoint: async () => { if (++checkpoints === 4) await rm(nested, { recursive: true }); } }
  });
  assert.equal(result.complete, false);
  assert.equal(result.truncated, false);
  assert.equal(result.coverage.roots[0].status, 'partial');
  assert.equal(result.warnings[0].code, 'DIRECTORY_READ_FAILED');
}));

test('a queued subdirectory replaced by an escaping junction is revalidated before opening', async t => isolated(async root => {
  const folder = path.join(root, 'Office');
  const queued = path.join(folder, 'queued');
  const outside = path.join(root, 'outside');
  await mkdir(queued, { recursive: true });
  await mkdir(outside);
  await writeFile(path.join(queued, 'inside.docx'), 'inside');
  await writeFile(path.join(outside, 'secret.docx'), 'outside');
  const roots = await prepared(folder);
  let checkpoints = 0;
  let linked = false;
  const result = await searchAutosaveRoots(roots, {
    control: { checkpoint: async () => {
      if (++checkpoints !== 4) return;
      await rm(queued, { recursive: true });
      try { await symlink(outside, queued, process.platform === 'win32' ? 'junction' : 'dir'); linked = true; }
      catch (error) {
        if (error?.code !== 'EPERM' && error?.code !== 'EACCES') throw error;
      }
    } }
  });
  if (!linked) return t.skip('directory links unavailable');
  assert.deepEqual(result.candidates, []);
  assert.equal(result.complete, false);
  assert.equal(result.coverage.roots[0].status, 'partial');
  assert.ok(result.warnings.some(item => item.code === 'LINK_SKIPPED' && item.path === queued));
}));

test('directory links are skipped with a bounded warning and never traversed', async t => isolated(async root => {
  const folder = path.join(root, 'Office');
  const outside = path.join(root, 'outside');
  await mkdir(folder);
  await mkdir(outside);
  await writeFile(path.join(folder, 'inside.docx'), 'inside');
  await writeFile(path.join(outside, 'secret.docx'), 'outside');
  try { await symlink(outside, path.join(folder, 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES') return t.skip(`links unavailable: ${error.code}`);
    throw error;
  }
  const result = await searchAutosaveRoots(await prepared(folder));
  assert.deepEqual(result.candidates.map(item => item.name), ['inside.docx']);
  assert.equal(result.stats.symlinksSkipped, 1);
  assert.equal(result.warnings[0].code, 'LINK_SKIPPED');
  assert.equal(result.complete, true);
}));
