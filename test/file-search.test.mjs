import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  copyExistingCandidate,
  findBackupLocations,
  hashDuplicates,
  readSearchIndex,
  searchExistingFiles,
  writeSearchIndex
} from '../engine/file-search.mjs';

async function isolated(callback) {
  const temporaryRoot = path.resolve(os.tmpdir());
  const root = await mkdtemp(path.join(temporaryRoot, 'recoverychat-files-'));
  try { await callback(root); }
  finally {
    const relative = path.relative(temporaryRoot, root);
    assert.ok(relative.startsWith('recoverychat-files-') && !relative.includes(path.sep) && !path.isAbsolute(relative));
    await rm(root, { recursive: true, force: true });
  }
}

test('searchExistingFiles walks real Korean files and streams stable matching candidates', async () => isolated(async root => {
  const selected = path.join(root, '선택 폴더');
  await mkdir(path.join(selected, '회의 자료'), { recursive: true });
  await writeFile(path.join(selected, '회의 자료', '결산 보고서_최종본_20260912.docx'), 'document');
  await writeFile(path.join(selected, '회의 자료', '사진.jpg'), 'photo');
  await writeFile(path.join(selected, '다른.txt'), 'other');
  const streamed = [];
  let checkpoints = 0;
  const result = await searchExistingFiles(selected, {
    filters: { name: '결산보고서', kind: 'document', extensions: ['docx'], pathContains: '회의 자료' },
    onCandidate: candidate => streamed.push(candidate),
    control: { checkpoint: async () => { checkpoints++; } }
  });
  assert.equal(result.complete, true);
  assert.equal(result.truncated, false);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].name, '결산 보고서_최종본_20260912.docx');
  assert.equal(result.candidates[0].source, 'existing-file');
  assert.equal(result.candidates[0].status, 'existing');
  assert.equal(result.candidates[0].deletedAt, null);
  assert.equal(result.candidates[0].id, streamed[0].id);
  assert.ok(result.candidates[0].reasons.includes('noAI'));
  assert.ok(checkpoints > 0);
}));

test('search cancellation rejects with CANCELLED and does not return a false complete result', async () => isolated(async root => {
  await writeFile(path.join(root, '첫 파일.txt'), 'one');
  await writeFile(path.join(root, '둘 파일.txt'), 'two');
  const controller = new AbortController();
  await assert.rejects(searchExistingFiles(root, {
    signal: controller.signal,
    onCandidate: () => controller.abort()
  }), { code: 'CANCELLED' });
}));

test('directory links are not followed outside the selected root', async t => isolated(async root => {
  const selected = path.join(root, 'selected');
  const outside = path.join(root, 'outside');
  await mkdir(selected);
  await mkdir(outside);
  await writeFile(path.join(selected, 'inside.txt'), 'inside');
  await writeFile(path.join(outside, 'secret.txt'), 'outside');
  try { await symlink(outside, path.join(selected, 'junction'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') return t.skip(`links unavailable: ${error.code}`);
    throw error;
  }
  const result = await searchExistingFiles(selected);
  assert.deepEqual(result.candidates.map(candidate => candidate.name), ['inside.txt']);
  assert.equal(result.stats.symlinksSkipped, 1);
}));

test('duplicate hashing retains full candidates and rejects a source changed during hashing', async () => isolated(async root => {
  const data = Buffer.alloc(2 * 1024 * 1024, 0x5a);
  await writeFile(path.join(root, '같음1.bin'), data);
  await writeFile(path.join(root, '같음2.bin'), data);
  await writeFile(path.join(root, '변경.bin'), data);
  const scan = await searchExistingFiles(root);
  const identical = scan.candidates.filter(candidate => candidate.name.startsWith('같음'));
  const equalResult = await hashDuplicates(identical);
  assert.equal(equalResult.complete, true);
  assert.equal(equalResult.groups.length, 1);
  assert.deepEqual(equalResult.groups[0].candidates.map(candidate => candidate.id), identical.map(candidate => candidate.id));
  assert.equal(equalResult.results.length, 2);

  const changing = scan.candidates.find(candidate => candidate.name === '변경.bin');
  let changed = false;
  const changedResult = await hashDuplicates([changing], {
    onProgress: progress => {
      if (!changed && progress.fileBytesHashed > 0) {
        changed = true;
        appendFileSync(changing.path, Buffer.from([1]));
      }
    }
  });
  assert.equal(changedResult.complete, false);
  assert.equal(changedResult.results.length, 0);
  assert.equal(changedResult.warnings[0].code, 'SOURCE_CHANGED');
}));

test('copy publishes into a fresh directory, never overwrites, and returns a verified hash', async () => isolated(async root => {
  const sourceRoot = path.join(root, 'source');
  const destination = path.join(root, 'destination');
  await mkdir(sourceRoot);
  const bytes = Buffer.from('복사할 실제 내용', 'utf8');
  await writeFile(path.join(sourceRoot, '.. 위험한 이름 .txt'), bytes);
  const candidate = (await searchExistingFiles(sourceRoot)).candidates[0];
  const first = await copyExistingCandidate(candidate, destination);
  const second = await copyExistingCandidate(candidate, destination);
  assert.equal(first.status, 'saved');
  assert.equal(first.size, bytes.length);
  assert.match(first.sha256, /^[a-f0-9]{64}$/);
  assert.notEqual(first.path, second.path);
  assert.deepEqual(await readFile(first.path), bytes);
  assert.deepEqual(await readFile(second.path), bytes);
  assert.ok(!path.basename(first.path).includes('..'));
  const outputFolders = await readdir(destination);
  assert.equal(outputFolders.length, 2);
  assert.ok(outputFolders.every(name => !name.startsWith('.recoverychat-writing-')));
}));

test('a changed candidate is refused before copy and cannot overwrite output', async () => isolated(async root => {
  const source = path.join(root, 'source.txt');
  await writeFile(source, 'before');
  const candidate = (await searchExistingFiles(root)).candidates[0];
  await writeFile(source, 'after and different');
  const destination = path.join(root, 'destination');
  await assert.rejects(copyExistingCandidate(candidate, destination), { code: 'SOURCE_CHANGED' });
  await assert.rejects(readdir(destination), { code: 'ENOENT' });
}));

test('explicit search indexes revalidate changed and deleted entries', async () => isolated(async root => {
  const selected = path.join(root, 'selected');
  await mkdir(selected);
  const kept = path.join(selected, 'kept.txt');
  const removed = path.join(selected, 'removed.txt');
  await writeFile(kept, 'old');
  await writeFile(removed, 'remove');
  const scan = await searchExistingFiles(selected);
  const indexPath = path.join(root, 'chosen-index.json');
  assert.deepEqual(await writeSearchIndex(indexPath, scan.candidates), { path: indexPath, entries: 2 });
  await writeFile(kept, 'new content');
  await rm(removed);
  const loaded = await readSearchIndex(indexPath);
  assert.equal(loaded.candidates.length, 1);
  assert.equal(loaded.candidates[0].name, 'kept.txt');
  assert.ok(loaded.candidates[0].reasons.includes('index:changed'));
  assert.equal(loaded.stats.changed, 1);
  assert.equal(loaded.stats.deleted, 1);
  assert.deepEqual(loaded.removedIds, [scan.candidates.find(item => item.name === 'removed.txt').id]);
}));

test('backup location discovery reports only known paths and their existence', async () => isolated(async root => {
  const existing = path.join(root, 'AppData', 'Local', 'Microsoft', 'Office', 'UnsavedFiles');
  await mkdir(existing, { recursive: true });
  const locations = await findBackupLocations(root);
  assert.equal(locations.length, 4);
  assert.equal(locations.find(location => location.name === 'UnsavedFiles').exists, true);
  assert.equal(locations.filter(location => location.exists).length, 1);
  assert.ok(locations.every(location => location.path.startsWith(root)));
}));
