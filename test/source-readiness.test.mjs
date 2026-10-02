import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { RecoveryJobs } from '../engine/job-service.mjs';
import { inspectSourceReadiness } from '../engine/source-readiness.mjs';

function volume(overrides = {}) {
  return {
    id: 'C:', identity: 'source-v1', label: '원본 (C:)', kind: 'volume', driveLetter: 'C:',
    fileSystem: 'NTFS', size: 1_000_000, diskIds: ['1'], ready: true, system: false,
    physicalDisks: [{ diskId: '1', identity: 'PHYSICAL-1', identityKind: 'unique-id', model: 'Fixture SSD', serialNumber: 'SERIAL-1', size: 2_000_000, interface: 'USB', logicalSectorSize: 512, physicalSectorSize: 4096 }],
    physicalDiskIdentity: 'PHYSICAL-1', physicalDiskModel: 'Fixture SSD', scope: 'volume',
    partitionOffset: 1_048_576, partitionSize: 1_000_000, logicalSectorSize: 512, physicalSectorSize: 4096,
    partitionNumber: 1, sourceTopology: 'single-partition-single-disk', sectorProfile: '512e',
    encryption: 'unlocked', interface: 'USB', ...overrides
  };
}

async function fixture(overrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'source-readiness-'));
  const workspace = path.join(root, 'workspace');
  const destination = path.join(root, 'destination');
  await Promise.all([mkdir(workspace), mkdir(destination)]);
  const workspacePath = await realpath(workspace);
  const destinationPath = await realpath(destination);
  const destinations = new Map([
    [workspacePath, { canonicalPath: workspacePath, identity: 'workspace-v1', diskIds: ['2'], fileSystem: 'NTFS', freeSpace: 900_000 }],
    [destinationPath, { canonicalPath: destinationPath, identity: 'destination-v1', diskIds: ['3'], fileSystem: 'NTFS', freeSpace: 800_000 }]
  ]);
  const inspect = overrides.inspect ?? (async target => {
    const canonical = await realpath(target);
    const result = destinations.get(canonical);
    if (!result) throw new Error(`unexpected inspection: ${canonical}`);
    return result;
  });
  const inventory = overrides.inventory ?? (async () => [volume()]);
  const jobs = new RecoveryJobs({ workspace: workspacePath, inventory, inspect });
  return { root, workspacePath, destinationPath, destinations, jobs, async close() { await jobs.dispose(); await rm(root, { recursive: true, force: true }); } };
}

async function selectedVolume(context) {
  const source = (await context.jobs.devices()).devices[0];
  const destination = await context.jobs.addDestination(context.destinationPath);
  return { source, destination };
}

test('ordinary volume on different known disks reports ready with a serializable observed contract', async () => {
  const context = await fixture();
  try {
    const { source, destination } = await selectedVolume(context);
    const report = await context.jobs.sourceReadiness({ sourceId: source.id, destinationId: destination.id });
    assert.equal(report.overall, 'ready');
    assert.equal(report.source.sourceType, 'live-volume');
    assert.equal(report.source.identityStatus, 'current');
    assert.equal(report.workspace.path, context.workspacePath);
    assert.deepEqual(report.workspace.diskIds, ['2']);
    assert.equal(report.workspace.separation, 'separate');
    assert.deepEqual(report.destination.diskIds, ['3']);
    assert.ok(report.checks.every(check => check.status === 'pass'));
    assert.equal(report.acquisition.canAcquire, false);
    assert.deepEqual(report.acquisition.reasons.map(reason => reason.code), ['RUNTIME_PATHS_NOT_PROVIDED']);
    assert.match(report.limits[0], /운영체제/);
    assert.doesNotThrow(() => JSON.stringify(report));
  } finally { await context.close(); }
});

test('different drive letters on the same physical disk are blocked', async () => {
  const context = await fixture();
  try {
    context.destinations.set(context.destinationPath, {
      canonicalPath: context.destinationPath, identity: 'destination-v1', diskIds: ['1'], driveLetter: 'E:', fileSystem: 'NTFS', freeSpace: 800_000
    });
    const { source, destination } = await selectedVolume(context);
    const report = await context.jobs.sourceReadiness({ sourceId: source.id, destinationId: destination.id });
    assert.equal(report.overall, 'blocked');
    assert.equal(report.checks.find(check => check.id === 'destination-separation').status, 'blocked');
    assert.match(report.checks.find(check => check.id === 'destination-separation').detail, /드라이브 문자/);
  } finally { await context.close(); }
});

test('same physical source and workspace disk is blocked', async () => {
  const context = await fixture();
  try {
    context.destinations.set(context.workspacePath, {
      canonicalPath: context.workspacePath, identity: 'workspace-v1', diskIds: ['1'], fileSystem: 'NTFS', freeSpace: 900_000
    });
    const { source, destination } = await selectedVolume(context);
    const report = await context.jobs.sourceReadiness({ sourceId: source.id, destinationId: destination.id });
    assert.equal(report.overall, 'blocked');
    assert.equal(report.checks.find(check => check.id === 'workspace-separation').status, 'blocked');
  } finally { await context.close(); }
});

test('unknown physical disk relationships remain unknown and never ready', async () => {
  const context = await fixture({ inventory: async () => [volume({ diskIds: [] })] });
  try {
    const { source, destination } = await selectedVolume(context);
    const report = await context.jobs.sourceReadiness({ sourceId: source.id, destinationId: destination.id });
    assert.equal(report.overall, 'attention');
    assert.equal(report.checks.find(check => check.id === 'workspace-separation').status, 'unknown');
    assert.equal(report.checks.find(check => check.id === 'destination-separation').status, 'unknown');
  } finally { await context.close(); }
});

test('changed, disconnected, and not-ready volume snapshots are blocked after inventory refresh', async () => {
  for (const current of [volume({ identity: 'source-v2' }), null, volume({ ready: false, reason: 'NOT_READY' })]) {
    let first = true;
    const context = await fixture({ inventory: async () => {
      if (first) { first = false; return [volume()]; }
      return current ? [current] : [];
    } });
    try {
      const { source, destination } = await selectedVolume(context);
      const report = await context.jobs.sourceReadiness({ sourceId: source.id, destinationId: destination.id });
      assert.equal(report.overall, 'blocked');
      assert.ok(report.checks.some(check => check.status === 'blocked'));
    } finally { await context.close(); }
  }
});

test('a replacement physical disk is rejected even when the volume identity and drive letter are unchanged', async () => {
  let first = true;
  const context = await fixture({ inventory: async () => {
    if (first) { first = false; return [volume()]; }
    return [volume({ physicalDisks: [{
      diskId: '1', identity: 'PHYSICAL-REPLACED', identityKind: 'unique-id', model: 'Fixture SSD', serialNumber: 'SERIAL-REPLACED', size: 2_000_000,
      interface: 'USB', logicalSectorSize: 512, physicalSectorSize: 4096
    }], physicalDiskIdentity: 'PHYSICAL-REPLACED' })];
  } });
  try {
    const { source, destination } = await selectedVolume(context);
    const report = await context.jobs.sourceReadiness({ sourceId: source.id, destinationId: destination.id });
    assert.equal(report.source.identityStatus, 'changed');
    assert.equal(report.overall, 'blocked');
    assert.ok(report.acquisition.reasons.some(reason => reason.code === 'SOURCE_IDENTITY_NOT_CURRENT'));
  } finally { await context.close(); }
});

test('file image is distinguished from a live volume and full verification remains unknown', async () => {
  const context = await fixture();
  try {
    const imagePath = path.join(context.root, 'source.img');
    await writeFile(imagePath, Buffer.from('fixture image bytes'));
    const canonicalImage = await realpath(imagePath);
    const baseInspect = context.jobs.inspect;
    context.jobs.inspect = async target => {
      const canonical = await realpath(target);
      if (canonical === canonicalImage) return { canonicalPath: canonical, identity: 'image-location', diskIds: ['1'], fileSystem: 'NTFS' };
      return baseInspect(target);
    };
    const source = await context.jobs.addSource('image', canonicalImage);
    const destination = await context.jobs.addDestination(context.destinationPath);
    const report = await context.jobs.sourceReadiness({ sourceId: source.id, destinationId: destination.id });
    assert.equal(report.source.sourceType, 'file-image');
    assert.equal(report.source.size, Number((await statForIdentity(canonicalImage)).size));
    assert.equal(report.checks.find(check => check.id === 'image-verification').status, 'unknown');
    assert.match(report.checks.find(check => check.id === 'image-verification').detail, /전체 이미지 해시/);
    assert.equal(report.overall, 'attention');
  } finally { await context.close(); }
});

test('folder source and absent destination are reported without starting work', async () => {
  const context = await fixture();
  try {
    const folder = path.join(context.root, 'source-folder');
    await mkdir(folder);
    const canonicalFolder = await realpath(folder);
    const baseInspect = context.jobs.inspect;
    context.jobs.inspect = async target => {
      const canonical = await realpath(target);
      if (canonical === canonicalFolder) return { canonicalPath: canonical, identity: 'folder-location', diskIds: ['1'], fileSystem: 'NTFS' };
      return baseInspect(target);
    };
    const source = await context.jobs.addSource('folder', canonicalFolder);
    const report = await context.jobs.sourceReadiness({ sourceId: source.id });
    assert.equal(report.source.sourceType, 'folder-copy-source');
    assert.equal(report.destination, null);
    assert.equal(report.checks.find(check => check.id === 'folder-consistency').status, 'warning');
    assert.equal(report.checks.find(check => check.id === 'destination-selection').status, 'warning');
    assert.equal(report.overall, 'attention');
    assert.equal(context.jobs.jobs.size, 0, 'readiness must not start a job');
  } finally { await context.close(); }
});

test('readiness rejects while a job is busy before running inventory or inspection', async () => {
  let inventoryCalls = 0;
  const context = await fixture({ inventory: async () => { inventoryCalls += 1; return [volume()]; } });
  try {
    const source = (await context.jobs.devices()).devices[0];
    context.jobs.jobs.set('busy-job', { status: 'scanning' });
    await assert.rejects(context.jobs.sourceReadiness({ sourceId: source.id }), { code: 'BUSY' });
    assert.equal(inventoryCalls, 1);
  } finally {
    context.jobs.jobs.delete('busy-job');
    await context.close();
  }
});

test('512e USB bridge and 4Kn volume metadata are accepted by the acquisition layer when every write path is separate', async () => {
  for (const geometry of [
    { logicalSectorSize: 512, physicalSectorSize: 4096, sectorProfile: '512e', interface: 'USB' },
    { logicalSectorSize: 4096, physicalSectorSize: 4096, sectorProfile: '4Kn', interface: 'NVMe' }
  ]) {
    const device = volume(geometry);
    const source = { id: 'source', kind: 'volume', label: device.label, identity: device.identity, device };
    const locations = new Map([
      ['W:', { canonicalPath: 'W:', identity: 'workspace', diskIds: ['2'], physicalDiskIdentities: ['PHYSICAL-2'] }],
      ['O:', { canonicalPath: 'O:', identity: 'output', diskIds: ['3'], physicalDiskIdentities: ['PHYSICAL-3'], fileSystem: 'NTFS', freeSpace: 1000 }],
      ['A:', { canonicalPath: 'A:', identity: 'app', diskIds: ['4'], physicalDiskIdentities: ['PHYSICAL-4'] }],
      ['T:', { canonicalPath: 'T:', identity: 'temp', diskIds: ['5'], physicalDiskIdentities: ['PHYSICAL-5'] }]
    ]);
    const report = await inspectSourceReadiness({
      source,
      workspacePath: 'W:',
      destination: { label: 'output', path: 'O:', info: locations.get('O:') },
      inventory: async () => [device],
      inspect: async target => locations.get(target),
      runtimePaths: [{ purpose: 'app', path: 'A:', access: 'read-only' }, { purpose: 'temp', path: 'T:', access: 'writable' }],
      now: () => new Date('2026-09-20T00:00:00.000Z')
    });
    assert.equal(report.overall, 'ready');
    assert.equal(report.acquisition.canAcquire, true);
    assert.equal(report.acquisition.geometry.profile, geometry.sectorProfile);
    assert.equal(report.acquisition.sourceTopology.status, 'supported');
    assert.deepEqual(report.runtimeLocations.map(location => location.separation), ['separate', 'separate']);
  }
});

test('a declared sector profile cannot override contradictory measured geometry', async () => {
  const device = volume({ sectorProfile: '4Kn' });
  const source = { id: 'source', kind: 'volume', label: device.label, identity: device.identity, device };
  const inspect = async target => ({ canonicalPath: target, identity: target, diskIds: [target], physicalDiskIdentities: [`physical-${target}`], fileSystem: 'NTFS', freeSpace: 1000 });
  const report = await inspectSourceReadiness({
    source, workspacePath: 'W:', destination: { label: 'O:', path: 'O:', info: await inspect('O:') },
    inventory: async () => [device], inspect, runtimePaths: [{ purpose: 'temp', path: 'T:' }]
  });
  assert.equal(report.acquisition.geometry.profile, 'unsupported');
  assert.equal(report.acquisition.geometry.declaredProfile, '4Kn');
  assert.equal(report.acquisition.geometry.profileConflict, true);
  assert.equal(report.acquisition.canAcquire, false);
  assert.ok(report.acquisition.reasons.some(reason => reason.code === 'GEOMETRY_UNSUPPORTED'));
});

test('a volume without an exact single-partition length is never acquisition-ready', async () => {
  const device = volume({ partitionSize: 'unknown' });
  const source = { id: 'source', kind: 'volume', label: device.label, identity: device.identity, device };
  const inspect = async target => ({ canonicalPath: target, identity: target, diskIds: [target], physicalDiskIdentities: [`physical-${target}`], fileSystem: 'NTFS', freeSpace: 1000 });
  const report = await inspectSourceReadiness({
    source, workspacePath: 'W:', destination: { label: 'O:', path: 'O:', info: await inspect('O:') },
    inventory: async () => [device], inspect, runtimePaths: [{ purpose: 'temp', path: 'T:' }]
  });
  assert.equal(report.acquisition.sourceTopology.status, 'unknown');
  assert.equal(report.acquisition.canAcquire, false);
  assert.ok(report.acquisition.reasons.some(reason => reason.code === 'SOURCE_TOPOLOGY_UNKNOWN'));
});

test('a file-backed virtual source is rejected when its backing physical disk cannot be mapped', async () => {
  const device = volume({ interface: 'File Backed Virtual', physicalDisks: [{
    diskId: '1', identity: 'VIRTUAL-1', identityKind: 'unique-id', model: 'Virtual Disk', serialNumber: 'unknown', size: 2_000_000,
    interface: 'File Backed Virtual', logicalSectorSize: 512, physicalSectorSize: 4096
  }], physicalDiskIdentity: 'VIRTUAL-1' });
  const source = { id: 'source', kind: 'volume', label: device.label, identity: device.identity, device };
  const inspect = async target => ({ canonicalPath: target, identity: target, diskIds: [target], physicalDiskIdentities: [`physical-${target}`], fileSystem: 'NTFS', freeSpace: 1000 });
  const report = await inspectSourceReadiness({
    source, workspacePath: 'W:', destination: { label: 'O:', path: 'O:', info: await inspect('O:') },
    inventory: async () => [device], inspect, runtimePaths: [{ purpose: 'temp', path: 'T:' }]
  });
  assert.equal(report.acquisition.canAcquire, false);
  assert.ok(report.acquisition.reasons.some(reason => reason.code === 'SOURCE_VIRTUAL_BACKING_UNKNOWN'));
});

test('a detected file-backed virtual destination is rejected when its backing physical disk is unavailable', async () => {
  const device = volume();
  const source = { id: 'source', kind: 'volume', label: device.label, identity: device.identity, device };
  const inspect = async target => target === 'O:'
    ? { canonicalPath: target, identity: target, diskIds: ['3'], physicalDiskIdentities: ['PHYSICAL-3'], fileSystem: 'NTFS', freeSpace: 1000, physicalDiskInterfaces: ['File Backed Virtual'] }
    : { canonicalPath: target, identity: target, diskIds: [target], physicalDiskIdentities: [`physical-${target}`], fileSystem: 'NTFS', freeSpace: 1000 };
  const report = await inspectSourceReadiness({
    source, workspacePath: 'W:', destination: { label: 'O:', path: 'O:', info: await inspect('O:') },
    inventory: async () => [device], inspect, runtimePaths: [{ purpose: 'temp', path: 'T:' }]
  });
  assert.equal(report.destination.virtualBackingStatus, 'unavailable');
  assert.equal(report.checks.find(check => check.id === 'destination-virtual-backing').status, 'unknown');
  assert.equal(report.acquisition.canAcquire, false);
  assert.ok(report.acquisition.reasons.some(reason => reason.code === 'DESTINATION_VIRTUAL_BACKING_UNKNOWN'));
});

test('locked volumes and unknown layer data are never acquisition-ready', async () => {
  for (const device of [
    volume({ ready: false, encryption: 'locked', reason: 'LOCKED' }),
    volume({ physicalDisks: [], physicalDiskIdentity: 'unknown', physicalDiskModel: 'unknown', logicalSectorSize: 'unknown', physicalSectorSize: 'unknown', sectorProfile: 'unknown', sourceTopology: 'unknown', encryption: 'unknown' })
  ]) {
    const source = { id: 'source', kind: 'volume', label: device.label, identity: device.identity, device };
    const inspect = async target => ({ canonicalPath: target, identity: target, diskIds: [target], physicalDiskIdentities: [`physical-${target}`], fileSystem: 'NTFS', freeSpace: 1000 });
    const report = await inspectSourceReadiness({
      source, workspacePath: 'W:', destination: { label: 'O:', path: 'O:', info: await inspect('O:') },
      inventory: async () => [device], inspect, runtimePaths: [{ purpose: 'temp', path: 'T:' }]
    });
    assert.equal(report.acquisition.canAcquire, false);
    if (device.encryption === 'locked') {
      assert.equal(report.overall, 'blocked');
      assert.ok(report.acquisition.reasons.some(reason => reason.code === 'SOURCE_LOCKED'));
    } else {
      assert.equal(report.checks.find(check => check.id === 'device-layer').status, 'unknown');
      assert.ok(report.acquisition.reasons.some(reason => reason.code === 'GEOMETRY_UNKNOWN'));
      assert.ok(report.acquisition.reasons.some(reason => reason.code === 'PHYSICAL_DISK_IDENTITY_UNKNOWN'));
    }
  }
});

test('runtime disk aliases and changed runtime identities conservatively reject volume acquisition', async () => {
  const device = volume();
  const source = { id: 'source', kind: 'volume', label: device.label, identity: device.identity, device };
  const output = { canonicalPath: 'O:', identity: 'output', diskIds: ['3'], physicalDiskIdentities: ['PHYSICAL-3'], fileSystem: 'NTFS', freeSpace: 1000 };
  const inspect = async target => target === 'W:' ? { canonicalPath: target, identity: 'workspace', diskIds: ['2'], physicalDiskIdentities: ['PHYSICAL-2'] }
    : target === 'O:' ? output
      : { canonicalPath: target, identity: 'runtime-new', diskIds: ['99'], physicalDiskIdentities: ['PHYSICAL-1'] };
  const report = await inspectSourceReadiness({
    source, workspacePath: 'W:', destination: { label: 'O:', path: 'O:', info: output }, inventory: async () => [device], inspect,
    runtimePaths: [{ purpose: 'cache', path: 'R:', access: 'writable', identity: 'runtime-old' }]
  });
  assert.equal(report.overall, 'blocked');
  assert.equal(report.runtimeLocations[0].separation, 'same');
  assert.equal(report.runtimeLocations[0].identityStatus, 'changed');
  assert.ok(report.acquisition.reasons.some(reason => reason.code === 'RUNTIME_SEPARATION_UNSAFE'));
  assert.ok(report.acquisition.reasons.some(reason => reason.code === 'RUNTIME_IDENTITY_CHANGED'));
});

test('a fixed file image on the output disk is reported as a warning rather than a live-volume block', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'image-same-disk-'));
  try {
    const sourcePath = path.join(root, 'source.img');
    await writeFile(sourcePath, 'fixed image');
    const info = await statForIdentity(sourcePath);
    const source = { id: 'image', kind: 'image', label: sourcePath, path: sourcePath, identity: info.identity };
    const location = target => ({ canonicalPath: target, identity: `identity:${target}`, diskIds: ['7'], physicalDiskIdentities: ['PHYSICAL-7'], fileSystem: 'NTFS', freeSpace: 1000 });
    const destinationInfo = location('O:');
    const report = await inspectSourceReadiness({
      source, workspacePath: 'W:', destination: { label: 'O:', path: 'O:', info: destinationInfo }, inventory: async () => [],
      inspect: async target => location(target), runtimePaths: []
    });
    assert.equal(report.checks.find(check => check.id === 'destination-separation').status, 'warning');
    assert.notEqual(report.overall, 'blocked');
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function statForIdentity(target) {
  const info = await import('node:fs/promises').then(module => module.stat(target, { bigint: true }));
  return { identity: `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}`, size: info.size };
}
