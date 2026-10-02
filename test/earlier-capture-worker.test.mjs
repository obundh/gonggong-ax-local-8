import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import test from 'node:test';
import { RecoveryJobs } from '../engine/job-service.mjs';
import { readLayerFingerprint } from '../engine/windows-device.mjs';
import { candidateCaptureKey } from '../engine/capture-link.mjs';
import { createFixture, fixtureGeometry as g, fixturePrimitives as p } from './ntfs-fixtures.mjs';
import { usnRecord } from './usn-fixture.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, bytes = Buffer.alloc(0)) {
  const head = Buffer.alloc(8), tail = Buffer.alloc(4);
  head.writeUInt32BE(bytes.length); head.write(type, 4, 'ascii');
  tail.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), bytes])));
  return Buffer.concat([head, bytes, tail]);
}
function png() {
  const header = Buffer.alloc(13); header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, 0x21, 0x43, 0x65]))), chunk('IEND')]);
}
async function waitFor(events, jobId, type, start = 0) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const recent = events.slice(start).filter(e => e.jobId === jobId);
    const failure = recent.find(e => e.type === 'error');
    if (failure) throw new Error(JSON.stringify(failure));
    const result = recent.find(e => e.type === type);
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Missing ${type} for ${jobId}`);
}

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'earlier-capture-worker-'));
  const fixture = await createFixture(path.join(root, 'fixture'));
  const fixtureBefore = await readFile(fixture.imagePath), bytes = Buffer.from(fixtureBefore), original = png();
  const mftOffset = g.mftLcn * g.clusterSize + 25 * g.fileRecordSize, bodyOffset = 20 * g.clusterSize;
  p.makeFileRecord({ recordNumber: 25, sequence: 4, name: '확보-사진.png', attributes: [
    p.nonresidentAttribute(0x80, [{ lcn: 20, clusters: 1 }], original.length, 2),
  ] }).copy(bytes, mftOffset);
  original.copy(bytes, bodyOffset);
  const workspace = path.join(root, 'workspace'), destination = path.join(root, 'output'), events = [];
  await mkdir(workspace); await mkdir(destination);
  const device = { id: '\\\\.\\C:', identity: 'synthetic-capture-source', diskIds: ['1'], fileSystem: 'NTFS', ready: true,
    physicalDisks: [{ identityKind: 'unique-id', identity: 'synthetic-disk-one' }], partitionOffset: 0,
    partitionNumber: 1, partitionSize: bytes.length, logicalSectorSize: 512, physicalSectorSize: 4096,
    sourceTopology: 'single-partition-single-disk' };
  let reads = 0;
  const header = Buffer.alloc(8); header.writeBigInt64LE(2000n);
  const session = { async dispose() {}, async open() { return {
    info: { size: bytes.length, sectorSize: 512, identity: device.identity, sourceKind: 'volume',
      nativeIdentity: 'synthetic-native-one', readLayerFingerprint: readLayerFingerprint(device) },
    async assertUnchanged() {}, async close() {},
    async read(offset, length) { reads++; return Buffer.from(bytes.subarray(offset, offset + length)); },
    async queryJournal() { return { journalId: 'carry-fixture', firstUsn: '1000', lowestValidUsn: '1000', nextUsn: '2000' }; },
    async readJournal() { return { data: Buffer.concat([header,
      usnRecord({ recordNumber: 25, sequence: 3, name: '확보-사진.png', usn: 1100 })]) }; },
  }; } };
  const jobs = new RecoveryJobs({ workspace, inventory: async () => [structuredClone(device)], volumeSession: session,
    inspect: async file => ({ canonicalPath: await realpath(file), identity: 'output', diskIds: ['2'], freeSpace: 1e12, fileSystem: 'NTFS' }),
    onEvent: event => events.push(event) });
  await jobs.initialize();
  const source = (await jobs.devices()).devices[0], output = await jobs.addDestination(destination);
  const scan = async () => {
    const { jobId } = await jobs.start({ sourceId: source.id, mode: 'deleted' });
    await waitFor(events, jobId, 'complete');
    const candidate = jobs.candidates({ jobId, limit: 100 }).items.find(c => c.recordNumber === 25);
    assert.ok(candidate); assert.ok(candidateCaptureKey(candidate));
    return { jobId, candidate };
  };
  const save = async (current, earlierJobId) => {
    const start = events.length;
    const reply = await jobs.recover({ jobId: current.jobId, ids: [current.candidate.id], destinationId: output.id,
      ...(earlierJobId ? { earlierJobId } : {}) });
    return (await waitFor(events, reply.jobId, 'recover-complete', start)).results[0];
  };
  return { jobs, root, bytes, original, mftOffset, bodyOffset, workspace, events, output, scan, save,
    reads: () => reads, damage: () => bytes.fill(0x5a, bodyOffset, bodyOffset + original.length),
    async close() { await jobs.dispose(); assert.deepEqual(await readFile(fixture.imagePath), fixtureBefore); } };
}

test('real workers keep an earlier valid capture explicit when only later nonresident data changes', { timeout: 40000 }, async () => {
  const h = await setup();
  try {
    const first = await h.scan();
    assert.equal(first.candidate.preservation.documentStatus, 'preview-available');
    const mft = Buffer.from(h.bytes.subarray(h.mftOffset, h.mftOffset + g.fileRecordSize));
    h.damage();
    const current = await h.scan();
    assert.deepEqual(h.bytes.subarray(h.mftOffset, h.mftOffset + g.fileRecordSize), mft);
    assert.equal(current.candidate.preservation.documentStatus, 'format-mismatch');
    assert.equal(candidateCaptureKey(first.candidate), candidateCaptureKey(current.candidate));
    assert.equal(current.candidate.earlierCapture.jobId, first.jobId);
    const reads = h.reads();
    const normal = await h.jobs.preview({ jobId: current.jobId, id: current.candidate.id });
    assert.equal(normal.type, 'text'); assert.equal(normal.text, 'Z'.repeat(h.original.length));
    assert.equal(normal.earlierCapture, undefined);
    const preview = await h.jobs.preview({ jobId: current.jobId, id: current.candidate.id, earlierJobId: first.jobId });
    assert.equal(preview.type, 'image'); assert.equal(preview.earlierCapture.sha256, hash(h.original));
    const currentOutput = await h.save(current);
    assert.equal(currentOutput.preservation.source, 'discovery-capture');
    assert.equal(currentOutput.document.status, 'format-mismatch');
    assert.notEqual(hash(await readFile(currentOutput.path)), hash(h.original));
    const earlierOutput = await h.save(current, first.jobId);
    assert.equal(earlierOutput.status, 'saved'); assert.equal(earlierOutput.document.status, 'preview-available');
    assert.equal(earlierOutput.name, '확보-사진.png');
    assert.equal(earlierOutput.preservation.source, 'earlier-discovery-capture');
    assert.equal(earlierOutput.preservation.sourceJobId, first.jobId);
    assert.equal(earlierOutput.preservation.requestedFromJobId, current.jobId);
    assert.equal(earlierOutput.originalIdentityVerified, false);
    assert.equal(earlierOutput.outcome.originalBytesVerified, false);
    assert.equal(hash(await readFile(earlierOutput.path)), hash(h.original));
    assert.equal(h.reads(), reads, 'explicit earlier reads never go back to volume bytes');
    await writeFile(path.join(h.root, 'receipt.json'), JSON.stringify({ fixture: 'synthetic-nonresident-data-only-mutation',
      first: first.candidate, current: current.candidate, currentOutput, earlierOutput, rawReadsAfterScan: 0 }, null, 2));
  } finally { await h.close(); }
});

test('worker rejects changed proof and tampered previous bytes without live-source fallback', { timeout: 40000 }, async () => {
  const h = await setup();
  try {
    const first = await h.scan(); h.damage(); const current = await h.scan(), reads = h.reads();
    const proof = { id: first.candidate.id, key: candidateCaptureKey(first.candidate),
      sha256: first.candidate.preservation.sha256, requestedFromJobId: current.jobId };
    for (const change of [{ key: `${proof.key}x` }, { sha256: 'a'.repeat(64) }, { requestedFromJobId: first.jobId }]) {
      await assert.rejects(h.jobs.requestWorker(h.jobs.getJob(first.jobId), 'preview-capture', { ...proof, ...change }),
        { code: 'CAPTURE_LINK_CHANGED' });
    }
    const oldFolder = path.join(h.workspace, 'candidate-jobs', first.jobId, 'captured');
    const files = await readdir(oldFolder, { recursive: true });
    const captured = files.filter(file => file.endsWith('.png'));
    assert.equal(captured.length, 1);
    await writeFile(path.join(oldFolder, captured[0]), Buffer.alloc(h.original.length, 0x41));
    await assert.rejects(h.jobs.preview({ jobId: current.jobId, id: current.candidate.id, earlierJobId: first.jobId }), { code: 'CAPTURE_CHANGED' });
    const result = await h.save(current, first.jobId);
    assert.equal(result.status, 'failed'); assert.equal(result.code, 'CAPTURE_CHANGED'); assert.equal(result.path, undefined);
    assert.equal(h.reads(), reads);
  } finally { await h.close(); }
});

test('changed MFT generation cannot reuse a prior body even when the name stays the same', { timeout: 40000 }, async () => {
  const h = await setup();
  try {
    const first = await h.scan();
    h.bytes.writeUInt16LE(5, h.mftOffset + 16); h.damage();
    const { jobId } = await h.jobs.start({ sourceId: h.jobs.getJob(first.jobId).source.id, mode: 'deleted', deletedStrategy: 'vacancy' });
    await waitFor(h.events, jobId, 'complete');
    const candidates = h.jobs.candidates({ jobId, limit: 100 }).items;
    assert.ok(candidates.every(c => !c.earlierCapture));
    await assert.rejects(h.jobs.preview({ jobId, id: first.candidate.id, earlierJobId: first.jobId }));
  } finally { await h.close(); }
});
