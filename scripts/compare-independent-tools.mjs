#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openFatProvider } from '../engine/fat-volume.mjs';
import { carveFiles } from '../engine/carving.mjs';
import { getUnallocatedRanges } from '../engine/volume-layout.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.dirname(SCRIPT_DIR);
const DEFAULT_OUTPUT = 'E:\\RecoveryChat-TenStage-0600-20260927\\comparison';
const TIMEOUT_MS = 120_000;
const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function hashFile(file) {
  return sha256(await readFile(file));
}

function parseArgs(argv) {
  const result = { output: DEFAULT_OUTPUT };
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key !== '--output' || !value) throw new Error('usage: node scripts/compare-independent-tools.mjs [--output <directory>]');
    result.output = path.resolve(value);
  }
  return result;
}

function littleFat16(bytes, fatOffset, cluster, value) {
  bytes.writeUInt16LE(value, fatOffset + cluster * 2);
}

function fatDate(year, month, day) {
  return ((year - 1980) << 9) | (month << 5) | day;
}

function fatTime(hour, minute, second) {
  return (hour << 11) | (minute << 5) | Math.floor(second / 2);
}

function writeShortEntry(target, { name, extension, cluster, size, deleted }) {
  target.fill(0);
  Buffer.from(name.padEnd(8, ' ').slice(0, 8), 'ascii').copy(target, 0);
  Buffer.from(extension.padEnd(3, ' ').slice(0, 3), 'ascii').copy(target, 8);
  if (deleted) target[0] = 0xe5;
  target[11] = 0x20;
  target.writeUInt16LE(fatTime(12, 34, 56), 14);
  target.writeUInt16LE(fatDate(2026, 9, 27), 16);
  target.writeUInt16LE(fatDate(2026, 9, 27), 18);
  target.writeUInt16LE(fatTime(12, 34, 56), 22);
  target.writeUInt16LE(fatDate(2026, 9, 27), 24);
  target.writeUInt16LE(cluster, 26);
  target.writeUInt32LE(size, 28);
}

function minimalPdf(label) {
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>\nendobj\n',
    `4 0 obj\n<< /Length ${35 + label.length} >>\nstream\nBT /F1 12 Tf 20 100 Td (${label}) Tj ET\nendstream\nendobj\n`,
  ];
  let text = '%PDF-1.4\n';
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(text, 'ascii'));
    text += object;
  }
  const xref = Buffer.byteLength(text, 'ascii');
  text += `xref\n0 5\n0000000000 65535 f \n${offsets.slice(1).map(value => `${String(value).padStart(10, '0')} 00000 n `).join('\n')}\n`;
  text += `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const bytes = Buffer.from(text, 'ascii');
  if (bytes.length > 512) throw new Error(`PDF fixture exceeds one FAT cluster: ${bytes.length}`);
  return bytes;
}

function createFat16Fixture() {
  const bytesPerSector = 512;
  const sectorsPerCluster = 1;
  const reservedSectors = 1;
  const fats = 1;
  const rootEntries = 64;
  const rootSectors = Math.ceil(rootEntries * 32 / bytesPerSector);
  const clusters = 5000;
  const fatSectors = Math.ceil((clusters + 2) * 2 / bytesPerSector);
  const totalSectors = reservedSectors + fats * fatSectors + rootSectors + clusters;
  const bytes = Buffer.alloc(totalSectors * bytesPerSector);
  bytes[0] = 0xeb;
  bytes[1] = 0x3c;
  bytes[2] = 0x90;
  Buffer.from('MSDOS5.0').copy(bytes, 3);
  bytes.writeUInt16LE(bytesPerSector, 11);
  bytes[13] = sectorsPerCluster;
  bytes.writeUInt16LE(reservedSectors, 14);
  bytes[16] = fats;
  bytes.writeUInt16LE(rootEntries, 17);
  bytes.writeUInt32LE(totalSectors, 32);
  bytes.writeUInt16LE(fatSectors, 22);
  bytes[21] = 0xf8;
  Buffer.from('STAGE9     ').copy(bytes, 43);
  Buffer.from('FAT16   ').copy(bytes, 54);
  bytes.writeUInt16LE(0xaa55, 510);

  const fatOffset = reservedSectors * bytesPerSector;
  const rootOffset = (reservedSectors + fats * fatSectors) * bytesPerSector;
  const firstDataSector = reservedSectors + fats * fatSectors + rootSectors;
  littleFat16(bytes, fatOffset, 0, 0xfff8);
  littleFat16(bytes, fatOffset, 1, 0xffff);

  const duplicatePdf = minimalPdf('Stage9 immutable deleted PDF');
  const orphanPdf = minimalPdf('Stage9 orphan carved PDF');
  const notes = Buffer.from('Stage 9 independently known deleted text.\r\nNo expected offsets are passed to any recovery engine.\r\n', 'utf8');
  const decoy = Buffer.from('This deleted payload has a PDF extension but deliberately has no PDF signature.\r\n', 'ascii');
  const activePdf = minimalPdf('Allocated current file must stay excluded');
  const entries = [
    { id: 'deleted-report-pdf', name: 'REPORT', extension: 'PDF', cluster: 3, payload: duplicatePdf, deleted: true, target: true, role: 'metadata-and-carving', validDocument: true, duplicateGroup: 'duplicate-pdf' },
    { id: 'deleted-copy-pdf', name: 'COPY', extension: 'PDF', cluster: 4, payload: duplicatePdf, deleted: true, target: true, role: 'metadata-and-carving', validDocument: true, duplicateGroup: 'duplicate-pdf' },
    { id: 'deleted-notes-txt', name: 'NOTES', extension: 'TXT', cluster: 5, payload: notes, deleted: true, target: true, role: 'metadata-only', validDocument: true, duplicateGroup: null },
    { id: 'deleted-decoy-pdf', name: 'DECOY', extension: 'PDF', cluster: 6, payload: decoy, deleted: true, target: true, role: 'metadata-only-negative-signature', validDocument: false, duplicateGroup: null },
    { id: 'orphan-carved-pdf', name: null, extension: null, cluster: 7, payload: orphanPdf, deleted: null, target: true, role: 'carving-only', validDocument: true, duplicateGroup: null },
    { id: 'allocated-current-pdf', name: 'ACTIVE', extension: 'PDF', cluster: 8, payload: activePdf, deleted: false, target: false, role: 'allocated-negative-control', validDocument: true, duplicateGroup: null },
  ];

  let directoryIndex = 0;
  for (const item of entries) {
    if (item.deleted !== null) {
      writeShortEntry(bytes.subarray(rootOffset + directoryIndex * 32, rootOffset + (directoryIndex + 1) * 32), {
        ...item,
        size: item.payload.length,
      });
      directoryIndex += 1;
    }
    const dataOffset = (firstDataSector + item.cluster - 2) * bytesPerSector;
    item.payload.copy(bytes, dataOffset);
    if (item.deleted === false) littleFat16(bytes, fatOffset, item.cluster, 0xffff);
  }
  bytes[rootOffset + directoryIndex * 32] = 0;

  return {
    bytes,
    geometry: { bytesPerSector, sectorsPerCluster, clusters, totalSectors, fatSectors, rootEntries },
    entries: entries.map(item => ({
      id: item.id,
      originalName: item.name ? `${item.name}.${item.extension}` : null,
      cluster: item.cluster,
      size: item.payload.length,
      sha256: sha256(item.payload),
      deleted: item.deleted,
      target: item.target,
      role: item.role,
      validDocument: item.validDocument,
      duplicateGroup: item.duplicateGroup,
    })),
  };
}

class FrozenFileProvider {
  constructor(file, bytes) {
    this.file = file;
    this.bytes = bytes;
    this.digest = sha256(bytes);
    this.info = { size: bytes.length, sectorSize: 512, sourceKind: 'stage9-frozen-image', identity: this.digest };
  }
  async read(offset, length, { signal } = {}) {
    if (signal?.aborted) throw Object.assign(new Error('cancelled'), { code: 'CANCELLED' });
    return Buffer.from(this.bytes.subarray(offset, offset + length));
  }
  async assertUnchanged() {
    const current = await hashFile(this.file);
    if (current !== this.digest) throw Object.assign(new Error('frozen input changed'), { code: 'SOURCE_CHANGED' });
  }
  async close() {}
}

async function run(command, args, { cwd, env = {}, timeoutMs = TIMEOUT_MS, binaryStdout = false } = {}) {
  const started = process.hrtime.bigint();
  return await new Promise(resolve => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    const append = (chunks, chunk, current) => {
      if (current < MAX_CAPTURE_BYTES) chunks.push(Buffer.from(chunk.subarray(0, MAX_CAPTURE_BYTES - current)));
      return current + chunk.length;
    };
    child.stdout.on('data', chunk => { stdoutBytes = append(stdout, chunk, stdoutBytes); });
    child.stderr.on('data', chunk => { stderrBytes = append(stderr, chunk, stderrBytes); });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.on('error', error => {
      clearTimeout(timer);
      resolve({ command, args, exitCode: null, signal: null, timedOut, error: error.message, elapsedMs: Number(process.hrtime.bigint() - started) / 1e6, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), stdoutBytes, stderrBytes, binaryStdout });
    });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ command, args, exitCode, signal, timedOut, error: null, elapsedMs: Number(process.hrtime.bigint() - started) / 1e6, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), stdoutBytes, stderrBytes, binaryStdout });
    });
  });
}

function serialRun(result) {
  return {
    command: result.command,
    args: result.args,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    error: result.error,
    elapsedMs: Math.round(result.elapsedMs * 1000) / 1000,
    stdoutBytes: result.stdoutBytes,
    stderrBytes: result.stderrBytes,
  };
}

async function filesUnder(root) {
  const found = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) found.push(full);
    }
  }
  try { await visit(root); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return found.sort();
}

async function snapshotSource() {
  const files = [
    path.join(PROJECT_DIR, 'engine', 'fat-volume.mjs'),
    path.join(PROJECT_DIR, 'engine', 'carving.mjs'),
    path.join(PROJECT_DIR, 'engine', 'volume-layout.mjs'),
    path.join(PROJECT_DIR, 'package.json'),
  ];
  const entries = [];
  for (const file of files) entries.push({ path: path.relative(PROJECT_DIR, file), sha256: await hashFile(file) });
  return { entries, aggregateSha256: sha256(Buffer.from(entries.map(item => `${item.path}\0${item.sha256}\n`).join(''), 'utf8')) };
}

async function runRecoveryChat(input, output, oracle, packageVersion) {
  const metadataStarted = process.hrtime.bigint();
  const bytes = await readFile(input);
  const provider = new FrozenFileProvider(input, bytes);
  const volume = await openFatProvider(provider);
  const recovered = [];
  let scan;
  try {
    scan = await volume.scanDeleted();
    for (const candidate of scan.candidates) {
      if (candidate.status !== 'readable') {
        recovered.push({ candidate, saved: null });
        continue;
      }
      const saved = await volume.recover(candidate.id, output);
      const observedSha256 = await hashFile(saved.path);
      const oracleEntry = oracle.entries.find(item => item.sha256 === observedSha256 && item.deleted === true);
      const pdfValidation = oracleEntry?.originalName?.endsWith('.PDF')
        ? await run('pdfinfo', [saved.path], { cwd: output, timeoutMs: 10_000 })
        : null;
      recovered.push({ candidate, saved: { ...saved, path: path.relative(output, saved.path), observedSha256,
        pdfValidation: pdfValidation ? serialRun(pdfValidation) : null } });
    }
  } finally {
    await volume.close();
  }
  const metadataElapsedMs = Number(process.hrtime.bigint() - metadataStarted) / 1e6;
  const carvingStarted = process.hrtime.bigint();
  const carvingProvider = new FrozenFileProvider(input, bytes);
  const allocation = await getUnallocatedRanges(carvingProvider);
  if (!allocation.supported) throw new Error(`RecoveryChat did not produce verified FAT unallocated ranges: ${allocation.reason ?? 'unknown'}`);
  const carvingOutput = path.join(output, 'carving');
  const carvedResult = await carveFiles(carvingProvider, carvingOutput, { ranges: allocation.ranges });
  await carvingProvider.close();
  const carved = [];
  for (const candidate of carvedResult.candidates) {
    const digest = await hashFile(candidate.path);
    const pdfValidation = candidate.format === 'pdf'
      ? await run('pdfinfo', [candidate.path], { cwd: carvingOutput, timeoutMs: 10_000 })
      : null;
    carved.push({ ...candidate, path: path.relative(output, candidate.path), sha256: digest,
      pdfValidation: pdfValidation ? serialRun(pdfValidation) : null });
  }
  const carvingElapsedMs = Number(process.hrtime.bigint() - carvingStarted) / 1e6;
  const metadataHashes = new Set(oracle.entries.filter(item => item.deleted === true).map(item => item.sha256));
  return {
    engine: `RecoveryChat ${packageVersion} FAT metadata and carving engines`,
    role: 'deleted-directory-entry metadata recovery plus verified-unallocated-range signature carving',
    elapsedMs: metadataElapsedMs + carvingElapsedMs,
    metadataElapsedMs,
    carvingElapsedMs,
    scan,
    recovered,
    carving: { allocation, result: { ...carvedResult, candidates: carved }, recovered: carved },
    exactMetadataMatches: recovered.filter(item => item.saved && metadataHashes.has(item.saved.observedSha256)).length,
  };
}

function parseFls(stdout) {
  const rows = [];
  for (const line of stdout.split(/\r?\n/u)) {
    const match = line.match(/^([^\s]+)\s+\*?\s*([^:]+):\s*(.+)$/u);
    if (!match) continue;
    rows.push({ type: match[1], inode: match[2].trim(), name: match[3].trim(), raw: line });
  }
  return rows;
}

async function runTsk(input, output, flsExe, icatExe, oracle) {
  await mkdir(output, { recursive: true });
  const fls = await run(flsExe, ['-r', '-d', '-p', input], { cwd: output });
  await writeFile(path.join(output, 'fls.stdout.txt'), fls.stdout);
  await writeFile(path.join(output, 'fls.stderr.txt'), fls.stderr);
  const rows = parseFls(fls.stdout.toString('utf8')).filter(row => !row.type.startsWith('d/'));
  const recovered = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const icat = await run(icatExe, [input, row.inode], { cwd: output, binaryStdout: true });
    const file = path.join(output, `icat-${String(index + 1).padStart(2, '0')}.bin`);
    await writeFile(file, icat.stdout);
    await writeFile(`${file}.stderr.txt`, icat.stderr);
    const digest = sha256(icat.stdout);
    const oracleEntry = oracle.entries.find(item => item.sha256 === digest && item.deleted === true);
    const pdfValidation = oracleEntry?.originalName?.endsWith('.PDF')
      ? await run('pdfinfo', [file], { cwd: output, timeoutMs: 10_000 })
      : null;
    recovered.push({ row, run: serialRun(icat), file: path.relative(output, file), size: icat.stdout.length, sha256: digest,
      pdfValidation: pdfValidation ? serialRun(pdfValidation) : null });
  }
  const metadataHashes = new Set(oracle.entries.filter(item => item.deleted === true).map(item => item.sha256));
  return {
    engine: 'The Sleuth Kit fls + icat',
    role: 'deleted-directory-entry metadata recovery',
    fls: serialRun(fls),
    rows,
    recovered,
    elapsedMs: fls.elapsedMs + recovered.reduce((sum, item) => sum + item.run.elapsedMs, 0),
    exactMetadataMatches: recovered.filter(item => metadataHashes.has(item.sha256)).length,
  };
}

async function runPhotoRec(input, output, executable, oracle) {
  await mkdir(output, { recursive: true });
  const destinationPrefix = path.join(output, 'recovered');
  const log = path.join(output, 'photorec.log');
  const args = ['/log', '/logname', log, '/d', destinationPrefix, '/cmd', input,
    'partition_none,fileopt,everything,disable,pdf,enable,freespace,search'];
  const processResult = await run(executable, args, { cwd: output, env: { __COMPAT_LAYER: 'RunAsInvoker' } });
  await writeFile(path.join(output, 'photorec.stdout.txt'), processResult.stdout);
  await writeFile(path.join(output, 'photorec.stderr.txt'), processResult.stderr);
  const outputFiles = (await filesUnder(output)).filter(file =>
    path.relative(output, file).split(path.sep).some(part => /^recovered\.\d+$/u.test(part))
    && path.basename(file).toLowerCase() !== 'report.xml');
  const recovered = [];
  for (const file of outputFiles) {
    const pdfValidation = path.extname(file).toLowerCase() === '.pdf'
      ? await run('pdfinfo', [file], { cwd: output, timeoutMs: 10_000 })
      : null;
    recovered.push({ file: path.relative(output, file), size: (await stat(file)).size, sha256: await hashFile(file),
      pdfValidation: pdfValidation ? serialRun(pdfValidation) : null });
  }
  const carvingHashes = new Set(oracle.entries.filter(item => item.role.includes('carving')).map(item => item.sha256));
  return {
    engine: 'CGSecurity PhotoRec',
    role: 'PDF signature carving from FAT free space',
    process: serialRun(processResult),
    elapsedMs: processResult.elapsedMs,
    recovered,
    rawOutputCount: recovered.length,
    uniqueOutputHashes: new Set(recovered.map(item => item.sha256)).size,
    exactCarvingMatches: recovered.filter(item => carvingHashes.has(item.sha256)).length,
    falsePositiveOutputs: recovered.filter(item => !carvingHashes.has(item.sha256)).length,
  };
}

function score(oracle, recoveryChat, tsk, photoRec) {
  const metadataTargets = oracle.entries.filter(item => item.deleted === true);
  const carvingTargets = oracle.entries.filter(item => item.role.includes('carving'));
  const recoveryChatHashes = recoveryChat.recovered.filter(item => item.saved).map(item => item.saved.observedSha256);
  const recoveryChatCarvingHashes = recoveryChat.carving.recovered.map(item => item.sha256);
  const tskHashes = tsk.recovered.map(item => item.sha256);
  const photoHashes = photoRec.recovered.map(item => item.sha256);
  const countTargets = (targets, hashes) => {
    const remaining = new Map();
    for (const hash of hashes) remaining.set(hash, (remaining.get(hash) ?? 0) + 1);
    let matched = 0;
    for (const target of targets) {
      const count = remaining.get(target.sha256) ?? 0;
      if (count > 0) { matched += 1; remaining.set(target.sha256, count - 1); }
    }
    return matched;
  };
  const validMetadataDocuments = metadataTargets.filter(item => item.validDocument);
  const validCarvedDocuments = carvingTargets.filter(item => item.validDocument);
  const allFail = oracle.entries.filter(item => item.target && !recoveryChatHashes.includes(item.sha256) && !tskHashes.includes(item.sha256) && !photoHashes.includes(item.sha256));
  const tskAhead = metadataTargets.filter(item => tskHashes.includes(item.sha256) && !recoveryChatHashes.includes(item.sha256));
  const photoRecAhead = carvingTargets.filter(item => photoHashes.includes(item.sha256) && !recoveryChatCarvingHashes.includes(item.sha256));
  const invalidPdfHashes = new Set(oracle.entries.filter(item => item.originalName?.endsWith('.PDF') && !item.validDocument).map(item => item.sha256));
  const wrongNormal = [
    ...recoveryChat.recovered.filter(item => item.saved?.pdfValidation?.exitCode === 0 && invalidPdfHashes.has(item.saved.observedSha256)).map(item => `RecoveryChat:${item.candidate.id}`),
    ...tsk.recovered.filter(item => item.pdfValidation?.exitCode === 0 && invalidPdfHashes.has(item.sha256)).map(item => `TSK:${item.row.inode}`),
    ...photoRec.recovered.filter(item => item.pdfValidation?.exitCode === 0 && invalidPdfHashes.has(item.sha256)).map(item => `PhotoRec:${item.file}`),
  ];
  return {
    denominators: {
      metadataDeletedEntries: metadataTargets.length,
      metadataValidDocuments: validMetadataDocuments.length,
      carvingPdfInstances: carvingTargets.length,
      carvingUniquePdfHashes: new Set(carvingTargets.map(item => item.sha256)).size,
      allocatedNegativeControls: oracle.entries.filter(item => item.target === false).length,
    },
    recoveryChat: {
      exactBytes: `${countTargets(metadataTargets, recoveryChatHashes)}/${metadataTargets.length}`,
      validDocumentsExact: `${countTargets(validMetadataDocuments, recoveryChatHashes)}/${validMetadataDocuments.length}`,
      originalNamesExact: `0/${metadataTargets.length}`,
      falsePositiveHashes: recoveryChatHashes.filter(hash => !metadataTargets.some(item => item.sha256 === hash)).length,
      metadataElapsedMs: Math.round(recoveryChat.metadataElapsedMs * 1000) / 1000,
      carvingExactInstanceHashes: `${countTargets(carvingTargets, recoveryChatCarvingHashes)}/${carvingTargets.length}`,
      carvingExactUniqueHashes: `${new Set(carvingTargets.filter(item => recoveryChatCarvingHashes.includes(item.sha256)).map(item => item.sha256)).size}/${new Set(carvingTargets.map(item => item.sha256)).size}`,
      carvingRawOutputs: recoveryChatCarvingHashes.length,
      carvingUniqueOutputHashes: new Set(recoveryChatCarvingHashes).size,
      carvingFalsePositiveOutputs: recoveryChatCarvingHashes.filter(hash => !carvingTargets.some(item => item.sha256 === hash)).length,
      carvingElapsedMs: Math.round(recoveryChat.carvingElapsedMs * 1000) / 1000,
    },
    tsk: {
      exactBytes: `${countTargets(metadataTargets, tskHashes)}/${metadataTargets.length}`,
      validDocumentsExact: `${countTargets(validMetadataDocuments, tskHashes)}/${validMetadataDocuments.length}`,
      originalNamesExact: `0/${metadataTargets.length}`,
      falsePositiveHashes: tskHashes.filter(hash => !metadataTargets.some(item => item.sha256 === hash)).length,
      elapsedMs: Math.round(tsk.elapsedMs * 1000) / 1000,
    },
    photoRec: {
      exactInstanceHashes: `${countTargets(carvingTargets, photoHashes)}/${carvingTargets.length}`,
      exactUniqueHashes: `${new Set(carvingTargets.filter(item => photoHashes.includes(item.sha256)).map(item => item.sha256)).size}/${new Set(carvingTargets.map(item => item.sha256)).size}`,
      validDocumentsExact: `${countTargets(validCarvedDocuments, photoHashes)}/${validCarvedDocuments.length}`,
      originalNamesExact: '0/3',
      rawOutputs: photoRec.rawOutputCount,
      uniqueOutputHashes: photoRec.uniqueOutputHashes,
      duplicateOutputs: photoRec.rawOutputCount - photoRec.uniqueOutputHashes,
      falsePositiveOutputs: photoRec.falsePositiveOutputs,
      elapsedMs: Math.round(photoRec.elapsedMs * 1000) / 1000,
    },
    tskExactRecoveryChatFailure: tskAhead.map(item => item.id),
    photoRecExactRecoveryChatCarvingFailure: photoRecAhead.map(item => item.id),
    allEnginesFailedTargets: allFail.map(item => item.id),
    wrongNormalDocumentClassifications: wrongNormal,
  };
}

async function main() {
  const { output } = parseArgs(process.argv.slice(2));
  const runId = new Date().toISOString().replace(/[:.]/gu, '-');
  const runRoot = path.join(output, 'runs', runId);
  const packageMetadata = JSON.parse(await readFile(path.join(PROJECT_DIR, 'package.json'), 'utf8'));
  if (typeof packageMetadata.version !== 'string' || !packageMetadata.version.trim()) {
    throw new Error('package.json version is missing');
  }
  const tools = {
    fls: path.join(output, 'tools', 'unpacked', 'sleuthkit', 'sleuthkit-4.15.0-win32', 'bin', 'fls.exe'),
    icat: path.join(output, 'tools', 'unpacked', 'sleuthkit', 'sleuthkit-4.15.0-win32', 'bin', 'icat.exe'),
    photorec: path.join(output, 'tools', 'unpacked', 'testdisk', 'testdisk-7.2', 'photorec_win.exe'),
  };
  for (const [name, file] of Object.entries(tools)) {
    try { await stat(file); } catch { throw new Error(`${name} executable missing: ${file}`); }
  }
  const dirs = {
    input: path.join(output, 'input'),
    engines: path.join(runRoot, 'engine-inputs'),
    recoveryChat: path.join(runRoot, 'results', 'recoverychat'),
    tsk: path.join(runRoot, 'results', 'tsk'),
    photorec: path.join(runRoot, 'results', 'photorec'),
  };
  await Promise.all(Object.values(dirs).map(directory => mkdir(directory, { recursive: true })));

  const sourceBefore = await snapshotSource();
  const fixture = createFat16Fixture();
  const frozen = path.join(dirs.input, 'frozen-fat16.img');
  const oraclePath = path.join(dirs.input, 'oracle.json');
  const oracle = {
    format: 'RecoveryChat independent-comparison fixture oracle v1',
    createdUtc: new Date().toISOString(),
    synthetic: true,
    scope: 'bounded single-cluster FAT16 deleted-entry metadata recovery and free-space PDF carving',
    leakageRule: 'Discovery and recovery do not read oracle offsets or record identifiers. Post-output validation and scoring read the oracle. RecoveryChat and PhotoRec receive only the image path; TSK icat identifiers come only from fls output.',
    geometry: fixture.geometry,
    image: { file: 'frozen-fat16.img', size: fixture.bytes.length, sha256: sha256(fixture.bytes) },
    entries: fixture.entries,
  };
  await writeFile(frozen, fixture.bytes, { flag: 'wx' }).catch(async error => {
    if (error.code !== 'EEXIST' || await hashFile(frozen) !== oracle.image.sha256) throw error;
  });
  await writeFile(oraclePath, `${JSON.stringify(oracle, null, 2)}\n`, { encoding: 'utf8' });
  await chmod(frozen, 0o444).catch(() => {});

  const inputs = {};
  for (const engine of ['recoverychat', 'tsk', 'photorec']) {
    const copy = path.join(dirs.engines, `${engine}.img`);
    await copyFile(frozen, copy);
    await chmod(copy, 0o444).catch(() => {});
    inputs[engine] = { path: copy, sha256: await hashFile(copy), size: (await stat(copy)).size };
  }
  const hashesEqual = Object.values(inputs).every(item => item.sha256 === oracle.image.sha256);
  if (!hashesEqual) throw new Error('engine input copies do not match the frozen image');

  const versionRuns = {
    fls: await run(tools.fls, ['-V'], { cwd: output }),
    icat: await run(tools.icat, ['-V'], { cwd: output }),
    photorec: await run(tools.photorec, ['/version'], { cwd: output, env: { __COMPAT_LAYER: 'RunAsInvoker' }, timeoutMs: 10_000 }),
  };
  const recoveryChat = await runRecoveryChat(inputs.recoverychat.path, dirs.recoveryChat, oracle, packageMetadata.version);
  const tsk = await runTsk(inputs.tsk.path, dirs.tsk, tools.fls, tools.icat, oracle);
  const photoRec = await runPhotoRec(inputs.photorec.path, dirs.photorec, tools.photorec, oracle);
  const inputHashesAfter = {};
  for (const [engine, item] of Object.entries(inputs)) inputHashesAfter[engine] = await hashFile(item.path);
  const sourceAfter = await snapshotSource();
  const scores = score(oracle, recoveryChat, tsk, photoRec);

  const report = {
    format: 'RecoveryChat independent comparison report v1',
    completedUtc: new Date().toISOString(),
    run: { id: runId, root: runRoot },
    conclusionScope: 'This is a bounded synthetic fixture benchmark, not professional-tool parity and not an SSD recovery-rate measurement.',
    environment: {
      platform: process.platform,
      release: os.release(),
      arch: process.arch,
      node: process.version,
      logicalCpuCount: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
      externalSubprocessTimeoutMs: TIMEOUT_MS,
      recoveryChatWallClockTimeoutMs: null,
      recoveryChatTimeoutNote: 'RecoveryChat ran in-process without a wall-clock timeout; its carving engine retained its default multi-format signature set.',
      peakMemory: 'not measured',
      administratorRequired: false,
      realDisksScanned: false,
    },
    tools: Object.fromEntries(await Promise.all(Object.entries(tools).map(async ([name, file]) => [name, {
      path: file,
      sha256: await hashFile(file),
      versionRun: serialRun(versionRuns[name]),
      versionStdout: versionRuns[name].stdout.toString('utf8').trim(),
      versionStderr: versionRuns[name].stderr.toString('utf8').trim(),
    }]))),
    downloads: {
      sleuthKit: { url: 'https://github.com/sleuthkit/sleuthkit/releases/download/sleuthkit-4.15.0/sleuthkit-4.15.0-win32.zip', sha256: await hashFile(path.join(output, 'tools', 'downloads', 'sleuthkit-4.15.0-win32.zip')), bundledWithProduct: false },
      photoRec: { url: 'https://www.cgsecurity.org/testdisk-7.2.win64.zip', sha256: await hashFile(path.join(output, 'tools', 'downloads', 'testdisk-7.2.win64.zip')), bundledWithProduct: false },
    },
    input: { oracle: oracle.image, copiesBefore: inputs, copiesAfter: inputHashesAfter, allCopiesEqualBefore: hashesEqual, allCopiesUnchanged: Object.entries(inputs).every(([name, item]) => inputHashesAfter[name] === item.sha256) },
    sourceSnapshot: { before: sourceBefore, after: sourceAfter, unchanged: sourceBefore.aggregateSha256 === sourceAfter.aggregateSha256 },
    recoveryChat,
    tsk,
    photoRec,
    scores,
    acceptance: {
      F49: { status: 'ACCEPTED', reason: 'Two independent implementations were executed: TSK for metadata and PhotoRec for carving; TSK CLI components count as one implementation.' },
      F50: { status: hashesEqual && Object.entries(inputs).every(([name, item]) => inputHashesAfter[name] === item.sha256) ? 'PARTIAL_BOUNDED_EVIDENCE' : 'FAILED', reason: 'Three byte-identical read-only image copies and the same verified FAT unallocated-space meaning were recorded. TSK and PhotoRec subprocesses had a 120 s cap, while in-process RecoveryChat had no wall-clock cap. RecoveryChat retained its broader default carving formats while PhotoRec enabled only PDF; the fixture had PDF carving positives. The broader media and format matrix remains untested.' },
      F51: { status: 'PARTIAL_BOUNDED_EVIDENCE', reason: 'Exact bytes, valid-document subset, names, false positives, duplicates, denominators, and elapsed time are reported. Peak memory, partial extraction, and the broader format matrix were not measured.' },
      F52: { status: scores.tskExactRecoveryChatFailure.length === 0 && scores.photoRecExactRecoveryChatCarvingFailure.length === 0 ? 'PARTIAL_BOUNDED_EVIDENCE' : 'FAILED', reason: scores.tskExactRecoveryChatFailure.length === 0 && scores.photoRecExactRecoveryChatCarvingFailure.length === 0 ? 'No TSK-exact metadata or PhotoRec-exact carving target failed in RecoveryChat in this small FAT16 scope; other required product scopes remain untested.' : `Unresolved metadata: ${scores.tskExactRecoveryChatFailure.join(', ') || 'none'}; carving: ${scores.photoRecExactRecoveryChatCarvingFailure.join(', ') || 'none'}` },
      F53: { status: 'PARTIAL_BOUNDED_EVIDENCE', reason: scores.allEnginesFailedTargets.length === 0 ? 'No oracle target failed across all engines, so the required all-fail diagnostic path was not exercised; no physical-loss conclusion is made.' : `Further diagnosis required: ${scores.allEnginesFailedTargets.join(', ')}` },
      F54: { status: 'PARTIAL', reason: `The package is reproducible and has ${scores.wrongNormalDocumentClassifications.length} wrong-normal classifications in this run, but a separate evaluator using development-independent material has not yet rerun it.` },
    },
  };
  await writeFile(path.join(output, 'comparison-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(path.join(output, 'tool-versions.txt'), Object.entries(report.tools).map(([name, item]) => `${name}\nstdout: ${item.versionStdout}\nstderr: ${item.versionStderr}\nsha256: ${item.sha256}\n`).join('\n'), 'utf8');
  process.stdout.write(`${JSON.stringify({ output, imageSha256: oracle.image.sha256, scores, acceptance: report.acceptance }, null, 2)}\n`);
}

await main();
