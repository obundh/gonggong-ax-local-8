import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { RecoveryJobs } from '../engine/job-service.mjs';
import {
  listWindowsDevices,
  normalizeInventory,
  readLayerFingerprint,
  WindowsVolumeSession
} from '../engine/windows-device.mjs';

const stageRoot = 'E:\\RecoveryChat-Stage2-20260920\\tests';
const volumeSize = 4 * 1024 * 1024;

function rawVolume(physicalIdentity) {
  return {
    id: '\\\\?\\Volume{11111111-2222-3333-4444-555555555555}\\',
    label: 'Known source',
    driveLetter: 'R:',
    fileSystem: 'NTFS',
    size: volumeSize - 4096,
    freeSpace: volumeSize / 2,
    diskIds: ['41'],
    serial: 'LEGACY-VOLUME-ID',
    system: false,
    ready: true,
    physicalDisks: [{
      diskId: '41',
      identity: physicalIdentity,
      identityKind: 'unique-id',
      model: 'Fixture SSD',
      serialNumber: physicalIdentity,
      size: volumeSize * 2,
      interface: 'USB',
      logicalSectorSize: 512,
      physicalSectorSize: 4096
    }],
    partitionOffset: 1_048_576,
    partitionNumber: 1,
    partitionSize: volumeSize,
    sourceTopology: 'single-partition-single-disk',
    logicalSectorSize: 512,
    physicalSectorSize: 4096,
    interface: 'USB',
    encryption: 'unlocked'
  };
}

function normalizeFixture() {
  const [a] = normalizeInventory([rawVolume('PHYSICAL-A')]);
  const [b] = normalizeInventory([rawVolume('PHYSICAL-B')]);
  assert.equal(a.identity, b.identity, 'the regression fixture must retain the same legacy identity');
  assert.match(readLayerFingerprint(a), /^[0-9a-f]{64}$/);
  assert.match(readLayerFingerprint(b), /^[0-9a-f]{64}$/);
  assert.notEqual(readLayerFingerprint(a), readLayerFingerprint(b));
  return { a, b };
}

async function fixture({ inventory, volumeSession, inspectHook, acquisitionOptions = {} } = {}) {
  await mkdir(stageRoot, { recursive: true });
  const root = await mkdtemp(path.join(stageRoot, 'acquisition-binding-'));
  const workspace = path.join(root, 'workspace');
  const destination = path.join(root, 'destination');
  await Promise.all([mkdir(workspace), mkdir(destination)]);
  const canonicalWorkspace = path.resolve(workspace);
  const canonicalDestination = path.resolve(destination);
  const inspect = async target => {
    const canonicalPath = path.resolve(target);
    const destinationLocation = canonicalPath === canonicalDestination;
    const observed = {
      canonicalPath,
      identity: destinationLocation ? 'destination-fixture' : 'runtime-fixture',
      diskIds: [destinationLocation ? '92' : '91'],
      physicalDiskIdentities: [destinationLocation ? 'PHYSICAL-OUTPUT' : 'PHYSICAL-RUNTIME'],
      fileSystem: 'NTFS',
      freeSpace: volumeSize * 4
    };
    return await inspectHook?.({
      canonicalPath,
      role: destinationLocation ? 'destination' : 'runtime',
      observed
    }) ?? observed;
  };
  const jobs = new RecoveryJobs({
    workspace: canonicalWorkspace,
    inventory,
    inspect,
    volumeSession,
    runtimePaths: [{ purpose: 'test runtime', path: canonicalWorkspace, access: 'writable' }],
    acquisitionOptions: {
      async collect() { throw new Error('collection must not start in a source-binding rejection'); },
      ...acquisitionOptions
    }
  });
  await jobs.initialize();
  return {
    root,
    destination: canonicalDestination,
    jobs,
    async select() {
      const source = (await jobs.devices()).devices[0];
      const output = await jobs.addDestination(canonicalDestination);
      return { source, output };
    },
    async assertNoOutput() {
      assert.deepEqual(await readdir(canonicalDestination), []);
      assert.equal(jobs.acquisitions.records.size, 0);
      await assert.rejects(stat(path.join(canonicalWorkspace, 'acquisitions.json')), { code: 'ENOENT' });
    },
    async close() { await jobs.dispose(); }
  };
}

test('readiness blocks replacement media that retained the selected volume legacy identity', async () => {
  const { a, b } = normalizeFixture();
  let call = 0;
  const f = await fixture({ inventory: async () => [call++ === 0 ? a : b] });
  try {
    const { source, output } = await f.select();
    const report = await f.jobs.sourceReadiness({ sourceId: source.id, destinationId: output.id });
    assert.equal(report.source.identityStatus, 'changed');
    assert.equal(report.overall, 'blocked');
    assert.equal(report.checks.find(check => check.id === 'source-identity')?.status, 'blocked');
    assert.equal(report.acquisition.canAcquire, false);
  } finally {
    await f.close();
  }
});

test('acquisition rejects replacement media before opening a helper or creating output', async () => {
  const { a, b } = normalizeFixture();
  let inventoryCalls = 0;
  let helperOpens = 0;
  const volumeSession = {
    async open() { helperOpens++; throw new Error('helper must not open'); },
    async dispose() {}
  };
  const f = await fixture({
    inventory: async () => [inventoryCalls++ === 0 ? a : b],
    volumeSession
  });
  try {
    const { source, output } = await f.select();
    await assert.rejects(
      f.jobs.acquisitions.start({ sourceId: source.id, destinationId: output.id }),
      error => error?.code === 'SOURCE_CHANGED'
    );
    assert.equal(helperOpens, 0);
    await f.assertNoOutput();
  } finally {
    await f.close();
  }
});

test('device refresh allocates a new source ID and retains the old selected snapshot', async () => {
  const { a, b } = normalizeFixture();
  let call = 0;
  const f = await fixture({ inventory: async () => [call++ === 0 ? a : b] });
  try {
    const selectedA = (await f.jobs.devices()).devices[0];
    const retainedA = f.jobs.sources.get(selectedA.id);
    const selectedB = (await f.jobs.devices()).devices[0];

    assert.notEqual(selectedB.id, selectedA.id);
    assert.equal(f.jobs.sources.size, 2);
    assert.equal(f.jobs.sources.get(selectedA.id), retainedA);
    assert.equal(readLayerFingerprint(retainedA.device), readLayerFingerprint(a));
    assert.equal(retainedA.device.physicalDiskIdentity, 'PHYSICAL-A');
    assert.equal(readLayerFingerprint(f.jobs.sources.get(selectedB.id).device), readLayerFingerprint(b));
  } finally {
    await f.close();
  }
});

test('an opened replacement fingerprint is rejected before the first read or output file', async () => {
  const { a, b } = normalizeFixture();
  let reads = 0;
  let closes = 0;
  const f = await fixture({
    inventory: async () => [a],
    volumeSession: {
      async open() {
        return {
          info: {
            identity: a.identity,
            nativeIdentity: 'native-physical-b',
            size: a.partitionSize,
            sectorSize: a.logicalSectorSize,
            readLayerFingerprint: readLayerFingerprint(b)
          },
          async read() { reads++; return Buffer.alloc(512); },
          async close() { closes++; }
        };
      },
      async dispose() {}
    }
  });
  try {
    const { source, output } = await f.select();
    await assert.rejects(
      f.jobs.acquisitions.start({ sourceId: source.id, destinationId: output.id }),
      error => error?.code === 'SOURCE_CHANGED'
    );
    assert.equal(reads, 0);
    assert.equal(closes, 1);
    await f.assertNoOutput();
  } finally {
    await f.close();
  }
});

test('a replacement observed immediately after opening is rejected even if the reader reports the old fingerprint', async () => {
  const { a, b } = normalizeFixture();
  let current = a;
  let reads = 0;
  let closes = 0;
  const f = await fixture({
    inventory: async () => [current],
    volumeSession: {
      async open() {
        current = b;
        return {
          info: {
            identity: a.identity,
            nativeIdentity: 'native-physical-a',
            size: a.partitionSize,
            sectorSize: a.logicalSectorSize,
            readLayerFingerprint: readLayerFingerprint(a)
          },
          async read() { reads++; return Buffer.alloc(512); },
          async close() { closes++; }
        };
      },
      async dispose() {}
    }
  });
  try {
    const { source, output } = await f.select();
    await assert.rejects(
      f.jobs.acquisitions.start({ sourceId: source.id, destinationId: output.id }),
      error => error?.code === 'SOURCE_CHANGED'
    );
    assert.equal(reads, 0);
    assert.equal(closes, 1);
    await f.assertNoOutput();
  } finally {
    await f.close();
  }
});

test('destination remapping during helper open is rejected before reads, output, or history', async () => {
  const { a } = normalizeFixture();
  let remapped = false;
  let reads = 0;
  let closes = 0;
  const f = await fixture({
    inventory: async () => [a],
    inspectHook: ({ role, observed }) => role === 'destination' && remapped ? {
      ...observed,
      identity: 'replacement-destination',
      diskIds: ['41'],
      physicalDiskIdentities: ['PHYSICAL-A']
    } : observed,
    volumeSession: {
      async open() {
        remapped = true;
        return {
          info: {
            identity: a.identity,
            nativeIdentity: 'native-physical-a',
            size: a.partitionSize,
            sectorSize: a.logicalSectorSize,
            readLayerFingerprint: readLayerFingerprint(a)
          },
          async read() { reads++; return Buffer.alloc(512); },
          async close() { closes++; }
        };
      },
      async dispose() {}
    }
  });
  try {
    const { source, output } = await f.select();
    await assert.rejects(
      f.jobs.acquisitions.start({ sourceId: source.id, destinationId: output.id }),
      error => error?.code === 'DESTINATION_CHANGED'
    );
    assert.equal(reads, 0);
    assert.equal(closes, 1);
    assert.equal(f.jobs.busy(), false);
    await f.assertNoOutput();
  } finally {
    await f.close();
  }
});

test('destination physical aliasing after helper open is caught even with separate disk IDs and unchanged path identity', async () => {
  const { a } = normalizeFixture();
  let remapped = false;
  let reads = 0;
  let closes = 0;
  const f = await fixture({
    inventory: async () => [a],
    inspectHook: ({ role, observed }) => role === 'destination' && remapped ? {
      ...observed,
      diskIds: ['93'],
      physicalDiskIdentities: ['PHYSICAL-A']
    } : observed,
    volumeSession: {
      async open() {
        remapped = true;
        return {
          info: {
            identity: a.identity,
            nativeIdentity: 'native-physical-a',
            size: a.partitionSize,
            sectorSize: a.logicalSectorSize,
            readLayerFingerprint: readLayerFingerprint(a)
          },
          async read() { reads++; return Buffer.alloc(512); },
          async close() { closes++; }
        };
      },
      async dispose() {}
    }
  });
  try {
    const { source, output } = await f.select();
    await assert.rejects(
      f.jobs.acquisitions.start({ sourceId: source.id, destinationId: output.id }),
      error => error?.code === 'ACQUISITION_NOT_READY'
    );
    assert.equal(reads, 0);
    assert.equal(closes, 1);
    assert.equal(f.jobs.busy(), false);
    await f.assertNoOutput();
  } finally {
    await f.close();
  }
});

test('runtime physical remapping during helper open is rejected before any persistent write', async () => {
  const { a } = normalizeFixture();
  let remapped = false;
  let reads = 0;
  let closes = 0;
  const f = await fixture({
    inventory: async () => [a],
    inspectHook: ({ role, observed }) => role === 'runtime' && remapped ? {
      ...observed,
      diskIds: ['94'],
      physicalDiskIdentities: ['PHYSICAL-A']
    } : observed,
    volumeSession: {
      async open() {
        remapped = true;
        return {
          info: {
            identity: a.identity,
            nativeIdentity: 'native-physical-a',
            size: a.partitionSize,
            sectorSize: a.logicalSectorSize,
            readLayerFingerprint: readLayerFingerprint(a)
          },
          async read() { reads++; return Buffer.alloc(512); },
          async close() { closes++; }
        };
      },
      async dispose() {}
    }
  });
  try {
    const { source, output } = await f.select();
    await assert.rejects(
      f.jobs.acquisitions.start({ sourceId: source.id, destinationId: output.id }),
      error => error?.code === 'ACQUISITION_NOT_READY'
    );
    assert.equal(reads, 0);
    assert.equal(closes, 1);
    assert.equal(f.jobs.busy(), false);
    await f.assertNoOutput();
  } finally {
    await f.close();
  }
});

test('an unchanged volume acquires the exact partition length even when its filesystem capacity is smaller', async () => {
  const { a } = normalizeFixture();
  assert.equal(a.partitionSize, volumeSize);
  assert.equal(a.size, volumeSize - 4096);
  let reads = 0;
  let closes = 0;
  let collections = 0;
  const f = await fixture({
    inventory: async () => [a],
    acquisitionOptions: {
      async collect({ reader }) {
        collections++;
        const bytes = await reader.read(0, 512);
        assert.equal(bytes.length, 512);
        return {
          state: 'complete',
          complete: true,
          scope: 'volume',
          image: { bytesWritten: bytes.length, sha256: '0'.repeat(64) },
          readErrors: []
        };
      }
    },
    volumeSession: {
      async open() {
        return {
          info: {
            identity: a.identity,
            nativeIdentity: 'native-physical-a',
            size: a.partitionSize,
            sectorSize: a.logicalSectorSize,
            readLayerFingerprint: readLayerFingerprint(a)
          },
          async read(_offset, length) { reads++; return Buffer.alloc(length); },
          async close() { closes++; }
        };
      },
      async dispose() {}
    }
  });
  try {
    const { source, output } = await f.select();
    const started = await f.jobs.acquisitions.start({ sourceId: source.id, destinationId: output.id });
    const active = f.jobs.acquisitions.active;
    assert.ok(active);
    const completed = await active.done;
    assert.equal(completed.id, started.id);
    assert.equal(completed.status, 'complete');
    assert.equal(collections, 1);
    assert.equal(reads, 1);
    assert.equal(closes, 1);
    assert.equal(f.jobs.busy(), false);
    assert.equal(f.jobs.acquisitions.records.size, 1);
    assert.deepEqual(await readdir(f.destination), [`acquisition-${started.id}`]);
    assert.equal((await stat(path.join(f.jobs.workspace, 'acquisitions.json'))).isFile(), true);
  } finally {
    await f.close();
  }
});

test('Windows session releases and reopens a handle when only the read-layer fingerprint changes', async t => {
  const rawA = rawVolume('PHYSICAL-A');
  const rawB = rawVolume('PHYSICAL-B');
  const [a] = await listWindowsDevices({ fixture: [rawA] });
  let current = a;
  let nativeIdentity = 'native-physical-a';
  const calls = [];
  const channel = {
    closed: false,
    opened: null,
    destroy() { this.closed = true; this.opened = null; },
    async request(command, fields = {}) {
      calls.push({ command, fields });
      if (command === 'hello') return { protocol: 1, sessionReuse: true };
      if (command === 'release') { this.opened = null; return { released: true }; }
      if (command === 'open') {
        assert.equal(this.opened, null);
        this.opened = { identity: nativeIdentity, size: volumeSize, sectorSize: 512 };
        return { ...this.opened };
      }
      if (command === 'assert') return { unchanged: true, identity: this.opened.identity };
      if (command === 'close') { this.destroy(); return { closed: true }; }
      if (command === 'read') return { data: Buffer.alloc(fields.length).toString('base64') };
      throw new Error(`unexpected command: ${command}`);
    }
  };
  const session = new WindowsVolumeSession({
    inventory: async () => [current],
    helperPath: async () => 'fixture-helper',
    directFactory: async () => channel
  });
  t.after(() => session.dispose());

  const first = await session.open(a);
  assert.equal(first.info.readLayerFingerprint, readLayerFingerprint(a));

  const [b] = await listWindowsDevices({ fixture: [rawB] });
  current = b;
  nativeIdentity = 'native-physical-b';
  const second = await session.open(b);

  assert.equal(second.info.readLayerFingerprint, readLayerFingerprint(b));
  assert.notEqual(second.info.readLayerFingerprint, first.info.readLayerFingerprint);
  assert.equal(calls.filter(call => call.command === 'open').length, 2);
  assert.equal(calls.filter(call => call.command === 'release').length, 1);
  const readsBefore = calls.filter(call => call.command === 'read').length;
  await assert.rejects(first.read(0, 512), { code: 'DEVICE_CHANGED' });
  assert.equal(calls.filter(call => call.command === 'read').length, readsBefore);
});
