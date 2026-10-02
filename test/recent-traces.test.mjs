import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { discoverRecentRoot, prepareRecentRoot, searchRecentTraces } from '../engine/recent-traces.mjs';

const CLSID = Buffer.from('0114020000000000c000000000000046', 'hex');

async function isolated(callback) {
  const temp = path.resolve(os.tmpdir());
  const root = await mkdtemp(path.join(temp, 'recoverychat-recent-'));
  try { await callback(root); }
  finally {
    const relative = path.relative(temp, root);
    assert.ok(relative.startsWith('recoverychat-recent-') && !relative.includes(path.sep) && !path.isAbsolute(relative));
    await rm(root, { recursive: true, force: true });
  }
}

function header(flags) {
  const bytes = Buffer.alloc(0x4c);
  bytes.writeUInt32LE(0x4c, 0);
  CLSID.copy(bytes, 4);
  bytes.writeUInt32LE(flags >>> 0, 20);
  return bytes;
}

function wide(value, terminated = true) {
  return Buffer.from(`${value}${terminated ? '\0' : ''}`, 'utf16le');
}

function ansi(value, terminated = true) {
  return Buffer.from(`${value}${terminated ? '\0' : ''}`, 'ascii');
}

function unicodeLink(target, { suffix = '', extra = Buffer.alloc(4) } = {}) {
  const volume = Buffer.alloc(0x11);
  volume.writeUInt32LE(volume.length, 0);
  volume.writeUInt32LE(3, 4);
  volume.writeUInt32LE(0x12345678, 8);
  volume.writeUInt32LE(0x10, 12);
  const base = wide(target);
  const common = wide(suffix);
  const ansiBase = ansi(target.replace(/[^\x20-\x7e]/gu, '?'));
  const ansiSuffix = ansi(suffix.replace(/[^\x20-\x7e]/gu, '?'));
  const headerSize = 0x24;
  const volumeOffset = headerSize;
  const localAnsiOffset = volumeOffset + volume.length;
  const suffixAnsiOffset = localAnsiOffset + ansiBase.length;
  const localUnicodeOffset = suffixAnsiOffset + ansiSuffix.length;
  const suffixUnicodeOffset = localUnicodeOffset + base.length;
  const size = suffixUnicodeOffset + common.length;
  const info = Buffer.alloc(size);
  info.writeUInt32LE(size, 0);
  info.writeUInt32LE(headerSize, 4);
  info.writeUInt32LE(1, 8);
  info.writeUInt32LE(volumeOffset, 12);
  info.writeUInt32LE(localAnsiOffset, 16);
  info.writeUInt32LE(0, 20);
  info.writeUInt32LE(suffixAnsiOffset, 24);
  info.writeUInt32LE(localUnicodeOffset, 28);
  info.writeUInt32LE(suffixUnicodeOffset, 32);
  volume.copy(info, volumeOffset);
  ansiBase.copy(info, localAnsiOffset);
  ansiSuffix.copy(info, suffixAnsiOffset);
  base.copy(info, localUnicodeOffset);
  common.copy(info, suffixUnicodeOffset);
  return Buffer.concat([header((1 << 1) | (1 << 7)), info, extra]);
}

function stringDataLink({ name = '', relativePath = '', workingDir = '' }) {
  let flags = 1 << 7;
  const chunks = [];
  for (const [value, bit] of [[name, 2], [relativePath, 3], [workingDir, 4]]) {
    if (!value) continue;
    flags |= 1 << bit;
    const valueBytes = wide(value, false);
    const count = Buffer.alloc(2);
    count.writeUInt16LE(value.length, 0);
    chunks.push(count, valueBytes);
  }
  return Buffer.concat([header(flags), ...chunks, Buffer.alloc(4)]);
}

function ansiStringDataLink(relativePath) {
  const value = Buffer.from(relativePath, 'latin1');
  const count = Buffer.alloc(2);
  count.writeUInt16LE(value.length, 0);
  return Buffer.concat([header(1 << 3), count, value, Buffer.alloc(4)]);
}

function mixedUnicodeAnsiSuffixLink(target, suffix) {
  const volume = Buffer.alloc(0x11);
  volume.writeUInt32LE(volume.length, 0);
  volume.writeUInt32LE(3, 4);
  volume.writeUInt32LE(0x23456789, 8);
  volume.writeUInt32LE(0x10, 12);
  const ansiBase = ansi(target.replace(/[^\x20-\x7e]/gu, '?'));
  const ansiSuffix = Buffer.concat([Buffer.from(suffix, 'latin1'), Buffer.alloc(1)]);
  const unicodeBase = wide(target);
  const volumeOffset = 0x24;
  const localAnsiOffset = volumeOffset + volume.length;
  const suffixAnsiOffset = localAnsiOffset + ansiBase.length;
  const localUnicodeOffset = suffixAnsiOffset + ansiSuffix.length;
  const size = localUnicodeOffset + unicodeBase.length;
  const info = Buffer.alloc(size);
  info.writeUInt32LE(size, 0);
  info.writeUInt32LE(0x24, 4);
  info.writeUInt32LE(1, 8);
  info.writeUInt32LE(volumeOffset, 12);
  info.writeUInt32LE(localAnsiOffset, 16);
  info.writeUInt32LE(0, 20);
  info.writeUInt32LE(suffixAnsiOffset, 24);
  info.writeUInt32LE(localUnicodeOffset, 28);
  info.writeUInt32LE(0, 32);
  volume.copy(info, volumeOffset);
  ansiBase.copy(info, localAnsiOffset);
  ansiSuffix.copy(info, suffixAnsiOffset);
  unicodeBase.copy(info, localUnicodeOffset);
  return Buffer.concat([header((1 << 1) | (1 << 7)), info, Buffer.alloc(4)]);
}

function networkLink() {
  const suffix = ansi('secret.docx');
  const netName = ansi('\\\\server\\share');
  const network = Buffer.alloc(0x14 + netName.length);
  network.writeUInt32LE(network.length, 0);
  network.writeUInt32LE(0, 4);
  network.writeUInt32LE(0x14, 8);
  network.writeUInt32LE(0, 12);
  network.writeUInt32LE(0, 16);
  netName.copy(network, 0x14);
  const size = 0x1c + network.length + suffix.length;
  const info = Buffer.alloc(size);
  info.writeUInt32LE(size, 0);
  info.writeUInt32LE(0x1c, 4);
  info.writeUInt32LE(2, 8);
  info.writeUInt32LE(0, 12);
  info.writeUInt32LE(0, 16);
  info.writeUInt32LE(0x1c, 20);
  info.writeUInt32LE(0x1c + network.length, 24);
  network.copy(info, 0x1c);
  suffix.copy(info, 0x1c + network.length);
  return Buffer.concat([header(1 << 1), info, Buffer.alloc(4)]);
}

function knownFolderLink() {
  const block = Buffer.alloc(0x1c);
  block.writeUInt32LE(block.length, 0);
  block.writeUInt32LE(0xa000000b, 4);
  return Buffer.concat([header(0), block, Buffer.alloc(4)]);
}

function ansiLink(target) {
  const volume = Buffer.alloc(0x11);
  volume.writeUInt32LE(volume.length, 0);
  volume.writeUInt32LE(3, 4);
  volume.writeUInt32LE(0x87654321, 8);
  volume.writeUInt32LE(0x10, 12);
  const base = Buffer.concat([Buffer.from(target, 'latin1'), Buffer.alloc(1)]);
  const suffix = Buffer.alloc(1);
  const volumeOffset = 0x1c;
  const localOffset = volumeOffset + volume.length;
  const suffixOffset = localOffset + base.length;
  const size = suffixOffset + suffix.length;
  const info = Buffer.alloc(size);
  info.writeUInt32LE(size, 0);
  info.writeUInt32LE(0x1c, 4);
  info.writeUInt32LE(1, 8);
  info.writeUInt32LE(volumeOffset, 12);
  info.writeUInt32LE(localOffset, 16);
  info.writeUInt32LE(0, 20);
  info.writeUInt32LE(suffixOffset, 24);
  volume.copy(info, volumeOffset);
  base.copy(info, localOffset);
  suffix.copy(info, suffixOffset);
  return Buffer.concat([header(1 << 1), info, Buffer.alloc(4)]);
}

async function recentFolder(home) {
  const folder = path.join(home, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Recent');
  await mkdir(folder, { recursive: true });
  return folder;
}

test('discovery and preparation use only the fixed Recent folder and pin its identity', async () => isolated(async home => {
  let discovered = await discoverRecentRoot(home);
  assert.deepEqual({ exists: discovered.exists, status: discovered.status, error: discovered.error },
    { exists: false, status: 'missing', error: null });
  const folder = await recentFolder(home);
  discovered = await discoverRecentRoot(home);
  assert.deepEqual(discovered, { path: folder, exists: true, status: 'existing', error: null });
  const prepared = await prepareRecentRoot(discovered);
  assert.equal(prepared.path, await import('node:fs/promises').then(fs => fs.realpath(folder)));
  assert.match(prepared.identity.dev, /^\d+$/u);
  assert.match(prepared.identity.ino, /^\d+$/u);
  assert.equal(await prepareRecentRoot({ path: path.join(home, 'missing'), status: 'missing', exists: false }), null);
}));

test('valid Unicode LinkInfo becomes a metadata-only trace without checking the target', async () => isolated(async home => {
  const folder = await recentFolder(home);
  const shortcut = path.join(folder, '보고서.lnk');
  await writeFile(shortcut, unicodeLink('C:\\사용자\\자료\\예산 보고서.hwpx'));
  const streamed = [];
  const result = await searchRecentTraces(await prepareRecentRoot(folder), { onCandidate: item => streamed.push(item) });
  assert.equal(result.complete, true);
  assert.equal(result.coverage.scope, 'nonrecursive-lnk-only');
  assert.equal(result.coverage.targetExistenceChecks, 0);
  assert.equal(result.candidates.length, 1);
  const candidate = result.candidates[0];
  assert.equal(candidate.name, '예산 보고서.hwpx');
  assert.equal(candidate.originalPath, 'C:\\사용자\\자료\\예산 보고서.hwpx');
  assert.equal(candidate.path, null);
  assert.equal(candidate.source, 'recent-link');
  assert.equal(candidate.status, 'metadata-only');
  assert.equal(candidate.hasContent, false);
  assert.equal(candidate.requiresPreparation, false);
  assert.equal(candidate.size, null);
  assert.equal(candidate.deletedAt, null);
  assert.equal(candidate.modifiedAt, null);
  assert.equal(candidate.deletionConfirmed, false);
  assert.equal(candidate.originalIdentityVerified, false);
  assert.equal(candidate.shortcutPath, shortcut);
  assert.deepEqual(candidate.clue.targetEvidence, {
    source: 'link-info-unicode', confidence: 'absolute-local-drive', encodingLoss: false,
    unsupportedReason: null, knownFolderPresent: false
  });
  assert.equal(candidate.clue.relationship, 'unknown');
  assert.equal(candidate.clue.targetExistence, 'not-checked');
  assert.deepEqual(streamed, result.candidates);
}));

test('StringData relative path uses the shortcut directory even when activation working directory differs', { skip: process.platform !== 'win32' }, async () => isolated(async home => {
  const folder = await recentFolder(home);
  await writeFile(path.join(folder, 'draft.lnk'), stringDataLink({
    name: 'Draft description', relativePath: '..\\drafts\\plan.docx', workingDir: 'D:\\Office\\Current'
  }));
  const result = await searchRecentTraces(await prepareRecentRoot(folder));
  const [candidate] = result.candidates;
  assert.equal(candidate.originalPath, path.win32.resolve(folder, '..\\drafts\\plan.docx'));
  assert.notEqual(candidate.originalPath, 'D:\\Office\\drafts\\plan.docx');
  assert.equal(candidate.clue.targetEvidence.source, 'relative-path-unicode');
  assert.equal(candidate.clue.targetEvidence.confidence, 'relative-derived');
}));

test('relative path does not drop a repeated directory name as a LinkInfo suffix', { skip: process.platform !== 'win32' }, async () => isolated(async home => {
  const folder = await recentFolder(home);
  await writeFile(path.join(folder, 'nested.lnk'), stringDataLink({ relativePath: 'Recent' }));
  const result = await searchRecentTraces(await prepareRecentRoot(folder));
  assert.equal(result.candidates[0].originalPath, path.win32.join(folder, 'Recent'));
  assert.equal(result.candidates[0].clue.targetEvidence.confidence, 'relative-derived');
}));

test('LinkInfo suffix matching requires a complete path-component boundary', async () => isolated(async home => {
  const folder = await recentFolder(home);
  await writeFile(path.join(folder, 'component.lnk'), unicodeLink('C:\\docs\\foobar', { suffix: 'bar' }));
  await writeFile(path.join(folder, 'duplicate.lnk'), unicodeLink('C:\\docs\\bar', { suffix: 'bar' }));
  const result = await searchRecentTraces(await prepareRecentRoot(folder));
  const paths = result.candidates.map(candidate => candidate.originalPath).sort();
  assert.deepEqual(paths, ['C:\\docs\\bar', 'C:\\docs\\foobar\\bar']);
}));

test('a Unicode relative path can be derived textually from the shortcut location', { skip: process.platform !== 'win32' }, async () => isolated(async home => {
  const folder = await recentFolder(home);
  await writeFile(path.join(folder, 'remember.lnk'), stringDataLink({ relativePath: '..\\기억할 문서.txt' }));
  const result = await searchRecentTraces(await prepareRecentRoot(folder));
  const [candidate] = result.candidates;
  assert.equal(candidate.originalPath, path.win32.join(path.win32.dirname(folder), '기억할 문서.txt'));
  assert.equal(candidate.name, '기억할 문서.txt');
  assert.equal(candidate.clue.targetEvidence.source, 'relative-path-unicode');
  assert.equal(candidate.clue.targetEvidence.confidence, 'relative-derived');
  assert.equal(candidate.clue.targetExistence, 'not-checked');
  assert.equal(result.stats.unsupportedTargets, 0);
}));

test('UNC LinkInfo stays explicit metadata and is never exposed as a checked target', async () => isolated(async home => {
  const folder = await recentFolder(home);
  await writeFile(path.join(folder, 'network document.lnk'), networkLink());
  const result = await searchRecentTraces(await prepareRecentRoot(folder));
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].name, 'network document');
  assert.equal(result.candidates[0].originalPath, null);
  assert.equal(result.candidates[0].clue.targetPath, null);
  assert.equal(result.candidates[0].clue.targetEvidence.unsupportedReason, 'network-target');
  assert.equal(result.candidates[0].clue.targetExistence, 'not-checked');
  assert.ok(result.warnings.some(item => item.code === 'UNSUPPORTED_NETWORK_TARGET'));
}));

test('KnownFolder-only and ambiguous ANSI links remain unsupported metadata without external resolution', async () => isolated(async home => {
  const folder = await recentFolder(home);
  await writeFile(path.join(folder, 'known.lnk'), knownFolderLink());
  await writeFile(path.join(folder, 'ansi.lnk'), ansiLink('C:\\caf\xe9\\draft.docx'));
  const result = await searchRecentTraces(await prepareRecentRoot(folder));
  assert.equal(result.candidates.length, 2);
  const known = result.candidates.find(item => item.name === 'known');
  const ambiguous = result.candidates.find(item => item.name === 'ansi');
  assert.equal(known.clue.targetEvidence.unsupportedReason, 'known-folder');
  assert.equal(known.clue.targetEvidence.knownFolderPresent, true);
  assert.equal(ambiguous.clue.targetEvidence.unsupportedReason, 'ansi-code-page-ambiguous');
  assert.equal(ambiguous.clue.targetEvidence.encodingLoss, true);
  assert.ok(result.warnings.some(item => item.code === 'UNSUPPORTED_KNOWN_FOLDER'));
  assert.ok(result.warnings.some(item => item.code === 'UNSUPPORTED_ANSI_PATH'));
}));

test('ambiguous ANSI StringData and mixed Unicode/ANSI LinkInfo never surface garbled absolute targets', async () => isolated(async home => {
  const folder = await recentFolder(home);
  await writeFile(path.join(folder, 'ansi-string.lnk'), ansiStringDataLink('C:\\caf\xe9\\draft.docx'));
  await writeFile(path.join(folder, 'mixed-suffix.lnk'), mixedUnicodeAnsiSuffixLink('C:\\docs', 'caf\xe9.docx'));
  const result = await searchRecentTraces(await prepareRecentRoot(folder));
  assert.equal(result.candidates.length, 2);
  for (const candidate of result.candidates) {
    assert.equal(candidate.originalPath, null);
    assert.equal(candidate.clue.targetPath, null);
    assert.equal(candidate.clue.targetEvidence.confidence, 'unsupported');
    assert.equal(candidate.clue.targetEvidence.encodingLoss, true);
  }
}));

test('malformed, truncated, adversarial-offset, and unknown links create no candidates', async () => isolated(async home => {
  const folder = await recentFolder(home);
  await writeFile(path.join(folder, 'short.lnk'), Buffer.alloc(20));
  const unknown = header(0);
  unknown[4] ^= 0xff;
  await writeFile(path.join(folder, 'unknown.lnk'), unknown);
  await writeFile(path.join(folder, 'missing-terminal.lnk'), header(0));
  const unknownExtra = Buffer.alloc(12);
  unknownExtra.writeUInt32LE(8, 0);
  unknownExtra.writeUInt32LE(0xdeadbeef, 4);
  await writeFile(path.join(folder, 'unknown-extra.lnk'), Buffer.concat([header(0), unknownExtra]));
  const overflow = unicodeLink('C:\\safe\\file.docx');
  overflow.writeUInt32LE(0xfffffff0, 0x4c + 28);
  await writeFile(path.join(folder, 'overflow.lnk'), overflow);
  const incomplete = stringDataLink({ relativePath: 'C:\\safe\\file.docx' }).subarray(0, -3);
  await writeFile(path.join(folder, 'incomplete.lnk'), incomplete);
  await writeFile(path.join(folder, 'ordinary.txt'), unicodeLink('C:\\safe\\ignored.docx'));
  const result = await searchRecentTraces(await prepareRecentRoot(folder));
  assert.deepEqual(result.candidates, []);
  assert.equal(result.stats.filesVisited, 6);
  assert.equal(result.stats.malformedSkipped, 6);
  assert.equal(result.stats.nonShortcutSkipped, 1);
  assert.ok(result.warnings.some(item => item.code === 'UNKNOWN_SHORTCUT_FORMAT'));
  assert.ok(result.warnings.every(item => !item.path.endsWith('ordinary.txt')));
}));

test('a file over 1MiB is rejected before any shortcut bytes are read', async () => isolated(async home => {
  const folder = await recentFolder(home);
  await writeFile(path.join(folder, 'large.lnk'), Buffer.alloc(1024 * 1024 + 1, 0x41));
  const result = await searchRecentTraces(await prepareRecentRoot(folder));
  assert.deepEqual(result.candidates, []);
  assert.equal(result.stats.bytesRead, 0);
  assert.equal(result.warnings[0].code, 'SHORTCUT_TOO_LARGE');
}));

test('search is nonrecursive and does not parse destination databases', async () => isolated(async home => {
  const folder = await recentFolder(home);
  await mkdir(path.join(folder, 'AutomaticDestinations'));
  await mkdir(path.join(folder, 'CustomDestinations'));
  await writeFile(path.join(folder, 'AutomaticDestinations', 'nested.lnk'), unicodeLink('C:\\private\\nested.docx'));
  await writeFile(path.join(folder, 'CustomDestinations', 'x.customDestinations-ms'), Buffer.alloc(100));
  await writeFile(path.join(folder, 'top.lnk'), unicodeLink('C:\\public\\top.docx'));
  const result = await searchRecentTraces(await prepareRecentRoot(folder));
  assert.deepEqual(result.candidates.map(item => item.name), ['top.docx']);
  assert.equal(result.coverage.automaticDestinations, 'unsupported');
  assert.equal(result.coverage.customDestinations, 'unsupported');
}));

test('file and candidate bounds report truncated coverage', async () => isolated(async home => {
  const folder = await recentFolder(home);
  await writeFile(path.join(folder, 'one.lnk'), unicodeLink('C:\\docs\\one.docx'));
  await writeFile(path.join(folder, 'two.lnk'), unicodeLink('C:\\docs\\two.docx'));
  const byFile = await searchRecentTraces(await prepareRecentRoot(folder), { maxFiles: 1 });
  assert.equal(byFile.candidates.length, 1);
  assert.equal(byFile.truncated, true);
  assert.equal(byFile.complete, false);
  assert.equal(byFile.coverage.stopReason, 'file-limit');
  const byCandidate = await searchRecentTraces(await prepareRecentRoot(folder), { maxCandidates: 1 });
  assert.equal(byCandidate.candidates.length, 1);
  assert.equal(byCandidate.coverage.stopReason, 'candidate-limit');
}));

test('root identity replacement and cancellation fail closed', async () => isolated(async home => {
  const folder = await recentFolder(home);
  await writeFile(path.join(folder, 'one.lnk'), unicodeLink('C:\\docs\\one.docx'));
  const prepared = await prepareRecentRoot(folder);
  let changed = false;
  await assert.rejects(searchRecentTraces(prepared, { control: { checkpoint: async () => {
    if (changed) return;
    changed = true;
    await rename(folder, `${folder}-old`);
    await mkdir(folder);
  } } }), { code: 'SOURCE_CHANGED' });

  const current = await prepareRecentRoot(folder);
  await writeFile(path.join(folder, 'cancel.lnk'), unicodeLink('C:\\docs\\cancel.docx'));
  const controller = new AbortController();
  await assert.rejects(searchRecentTraces(current, {
    signal: controller.signal,
    control: { checkpoint: async () => controller.abort() }
  }), { code: 'CANCELLED' });
}));

test('filesystem symlinks are rejected as roots and skipped as shortcut entries', async t => isolated(async home => {
  const folder = await recentFolder(home);
  const outside = path.join(home, 'outside.lnk');
  await writeFile(outside, unicodeLink('C:\\secret\\outside.docx'));
  const rootLink = path.join(home, 'root-link');
  try {
    await symlink(folder, rootLink, process.platform === 'win32' ? 'junction' : 'dir');
    await symlink(outside, path.join(folder, 'linked.lnk'), 'file');
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES') return t.skip(`links unavailable: ${error.code}`);
    throw error;
  }
  await assert.rejects(prepareRecentRoot(rootLink), { code: 'UNSUPPORTED_ROOT' });
  const result = await searchRecentTraces(await prepareRecentRoot(folder));
  assert.deepEqual(result.candidates, []);
  assert.equal(result.stats.symlinksSkipped, 1);
  assert.equal(result.warnings[0].code, 'LINK_SKIPPED');
}));

test('missing Recent folder returns an empty complete report without scanning elsewhere', async () => {
  const result = await searchRecentTraces(null);
  assert.deepEqual(result.candidates, []);
  assert.equal(result.complete, true);
  assert.equal(result.coverage.root.status, 'missing');
  assert.equal(result.stats.rootsTotal, 0);
});
