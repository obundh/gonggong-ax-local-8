import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  buildElevationSpec,
  inspectDestination,
  listWindowsDevices,
  normalizeInventory,
  openWindowsVolume,
  planAlignedReads
} from '../engine/windows-device.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const windowsDeviceSource = await readFile(path.join(root, 'engine', 'windows-device.mjs'), 'utf8');

function runPowerShell(script) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '', stderr = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error('PowerShell behavior test exceeded its 20 second bound.'));
    }, 20_000);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', value => { stdout += value; });
    child.stderr.on('data', value => { stderr += value; });
    child.once('error', error => finish(error));
    child.once('close', code => code === 0 ? finish(null, stdout) : finish(new Error(stderr || `PowerShell exited with ${code}`)));
  });
}

const fixture = [
  {
    id: '\\\\?\\Volume{11111111-2222-3333-4444-555555555555}\\',
    label: 'Archive', driveLetter: 'e:', fileSystem: 'ntfs', size: 2000,
    freeSpace: 1500, diskIds: [7], serial: 'VOL-A', system: false, ready: true,
    physicalDisks: [{ diskId: 7, identity: 'USB-BRIDGE-SERIAL', identityKind: 'serial-number', model: 'Bridge SSD', serialNumber: 'USB-BRIDGE-SERIAL', size: 4000, interface: 'USB', logicalSectorSize: 512, physicalSectorSize: 4096 }],
    partitionOffset: 1048576, partitionNumber: 1, partitionSize: 2000, sourceTopology: 'single-partition-single-disk',
    logicalSectorSize: 512, physicalSectorSize: 4096, interface: 'USB', encryption: 'unlocked'
  },
  {
    id: 'C:', label: '', driveLetter: 'c:', fileSystem: 'NTFS', size: 1000,
    freeSpace: 100, diskIds: 0, serial: 'VOL-SYSTEM', system: true, ready: true,
    physicalDisks: [{ diskId: 0, identity: 'NVME-0', identityKind: 'unique-id', model: 'Native NVMe', serialNumber: 'N0', size: 1000, interface: 'NVMe', logicalSectorSize: 4096, physicalSectorSize: 4096 }],
    partitionOffset: 0, partitionNumber: 1, partitionSize: 1000, sourceTopology: 'single-partition-single-disk',
    logicalSectorSize: 4096, physicalSectorSize: 4096, interface: 'NVMe', encryption: 'locked'
  }
];

test('fixture inventory is normalized, physically mapped, ordered, and identified deterministically', () => {
  const devices = normalizeInventory(fixture);
  assert.equal(devices.length, 2);
  assert.equal(devices[0].id, 'C:');
  assert.equal(devices[0].ready, false);
  assert.equal(devices[0].reason, 'LOCKED');
  assert.equal(devices[0].encryption, 'locked');
  assert.equal(devices[0].sectorProfile, '4Kn');
  assert.equal(devices[0].physicalDiskIdentity, 'NVME-0');
  assert.match(devices[0].identity, /^windows-volume:[0-9a-f]{64}$/);
  assert.deepEqual(devices[1].diskIds, ['7']);
  assert.equal(devices[1].sectorProfile, '512e');
  assert.equal(devices[1].interface, 'USB');
  assert.equal(devices[1].partitionOffset, 1048576);
  assert.equal(devices[1].partitionSize, 2000);
  assert.equal(devices[1].scope, 'volume');
  assert.equal(normalizeInventory(fixture)[1].identity, devices[1].identity);
  assert.ok(Object.isFrozen(devices[1]));
  assert.ok(Object.isFrozen(devices[1].physicalDisks));
});

test('volume GUID identity survives drive-letter changes without changing the stable formula', () => {
  const selected = normalizeInventory([fixture[0]])[0];
  const remounted = normalizeInventory([{ ...fixture[0], driveLetter: 'x:' }])[0];
  assert.equal(remounted.driveLetter, 'X:');
  assert.equal(remounted.id, selected.id);
  assert.equal(remounted.identity, selected.identity);
});

test('unknown metadata remains explicit and unsupported geometry is not guessed', () => {
  const [unknown] = normalizeInventory([{ id: 'D:', driveLetter: 'd:', size: 1000, diskIds: [9], serial: 'D', ready: true }]);
  assert.equal(unknown.encryption, 'unknown');
    assert.equal(unknown.physicalDiskIdentity, 'unknown');
    assert.equal(unknown.partitionSize, 'unknown');
  assert.equal(unknown.logicalSectorSize, 'unknown');
  assert.equal(unknown.sectorProfile, 'unknown');
  for (const missing of [null, '', ' ', false]) {
    const [device] = normalizeInventory([{ ...fixture[0], partitionOffset: missing, startingOffset: missing }]);
    assert.equal(device.partitionOffset, 'unknown');
  }

  const [unsupported] = normalizeInventory([{
    id: 'F:', driveLetter: 'f:', size: 1000, diskIds: [10], serial: 'F', ready: true,
    logicalSectorSize: 4096, physicalSectorSize: 8192, encryption: 'unlocked'
  }]);
  assert.equal(unsupported.sectorProfile, 'unsupported');
});

test('inventory rejects identifiers that could turn into arbitrary native paths', () => {
  assert.throws(() => normalizeInventory([{ id: 'C:\\Windows', ready: true }]), { code: 'INVALID_INVENTORY' });
  assert.throws(() => normalizeInventory([{ id: '\\\\.\\PhysicalDrive0', ready: true }]), { code: 'INVALID_INVENTORY' });
});

test('ordinary inventory skips unavailable BitLocker providers and returns live unknown encryption', { skip: process.platform !== 'win32', timeout: 30_000 }, async t => {
  const inventory = windowsDeviceSource.match(/const inventoryScript = String\.raw`([\s\S]*?)`;\r?\n\r?\nconst destinationScript/);
  assert.ok(inventory, 'the Windows inventory script must be available for behavior testing');
  const script = String.raw`
$principal = [Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  [ordered]@{ skipped = 'current token is elevated; ordinary-token behavior is not applicable' } | ConvertTo-Json -Compress
  exit 0
}
$global:bitLockerCalls = 0
$global:cimCalls = 0
function Get-Partition { [CmdletBinding()] param() @([pscustomobject]@{ DriveLetter = 'D'; AccessPaths = @('\\?\Volume{aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee}\'); DiskNumber = 4; Offset = [uint64]1048576; PartitionNumber = 1; Size = [uint64]10485760 }) }
function Get-Disk { [CmdletBinding()] param() @([pscustomobject]@{ Number = 4; UniqueId = 'fixture-disk-4'; SerialNumber = 'fixture-serial-4'; Model = 'fixture disk'; FriendlyName = 'fixture disk'; Size = [uint64]20971520; BusType = 'USB'; LogicalSectorSize = [uint32]512; PhysicalSectorSize = [uint32]4096 }) }
function Get-Volume { [CmdletBinding()] param() @([pscustomobject]@{ DriveLetter = 'D'; UniqueId = '\\?\Volume{aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee}\'; FileSystemLabel = 'fixture'; FileSystem = 'NTFS'; Size = [uint64]10485760; SizeRemaining = [uint64]5242880 }) }
function Get-BitLockerVolume { [CmdletBinding()] param() $global:bitLockerCalls++; throw 'BitLocker provider must not run for an ordinary token' }
function Get-CimInstance { [CmdletBinding()] param() $global:cimCalls++; throw 'CIM fallback must not run for an ordinary token' }
$inventoryJson = & {
${inventory[1]}
}
[ordered]@{
  bitLockerCalls = $global:bitLockerCalls
  cimCalls = $global:cimCalls
  rows = @($inventoryJson | ForEach-Object { $_ | ConvertFrom-Json })
} | ConvertTo-Json -Compress -Depth 8
  `;
  const result = JSON.parse((await runPowerShell(script)).trim());
  if (result.skipped) return t.skip(result.skipped);
  assert.equal(result.bitLockerCalls, 0);
  assert.equal(result.cimCalls, 0);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].encryption, 'unknown');
  assert.equal(result.rows[0].ready, true);
});

test('destination fixture reports canonical storage facts and stable physical identity', async () => {
  const inspected = await inspectDestination('ignored-with-fixture', { fixture: {
    canonicalPath: 'E:\\Recovered', id: '\\\\?\\Volume{aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee}\\',
    fileSystem: 'ReFS', freeSpace: 9000, size: 10000, diskIds: [4], serial: 'DEST'
  } });
  assert.deepEqual(inspected.diskIds, ['4']);
  assert.deepEqual(inspected.physicalDiskIdentities, []);
  assert.equal(inspected.fileSystem, 'REFS');
  assert.equal(inspected.freeSpace, 9000);
  assert.match(inspected.identity, /^windows-volume:[0-9a-f]{64}$/);
});

test('destination inspection retains observed virtual disk bus types', async () => {
  const inspected = await inspectDestination('ignored-with-fixture', { fixture: {
    canonicalPath: 'Z:\\out', diskIds: ['3'], physicalDiskInterfaces: ['File Backed Virtual'],
    fileSystem: 'NTFS', freeSpace: 9000, size: 10000
  } });
  assert.deepEqual(inspected.physicalDiskInterfaces, ['File Backed Virtual']);
});

test('elevation specification accepts only a fixed absolute helper, strict pipe, and SID', () => {
  const spec = buildElevationSpec('C:\\Program Files\\RecoveryChat\\RecoveryChat.VolumeReader.exe', `RecoveryChat.${'a'.repeat(32)}`, 'S-1-5-21-1-2-3-1001');
  assert.equal(spec.environment.RECOVERYCHAT_PIPE, `RecoveryChat.${'a'.repeat(32)}`);
  assert.equal(spec.environment.RECOVERYCHAT_OWNER_SID, 'S-1-5-21-1-2-3-1001');
  assert.throws(() => buildElevationSpec('relative.exe', `RecoveryChat.${'a'.repeat(32)}`, 'S-1-5-18'), { code: 'INVALID_ELEVATION_ARGUMENT' });
  assert.throws(() => buildElevationSpec('C:\\ok.exe', 'RecoveryChat.bad --owner S-1-5-18', 'S-1-5-18'), { code: 'INVALID_ELEVATION_ARGUMENT' });
});

test('open refuses a renderer-shaped raw target that was not returned by inventory', async () => {
  await listWindowsDevices({ fixture });
  await assert.rejects(openWindowsVolume({ id: '\\\\.\\PhysicalDrive0', identity: 'forged', diskIds: ['0'] }), { code: 'DEVICE_NOT_ENUMERATED' });
});

test('provider requests are expanded into bounded aligned native reads and sliced back', () => {
  assert.deepEqual(planAlignedReads(4097, 1, 4 * 1024 * 1024, 512), {
    reads: [{ offset: 4096, length: 512 }], sliceStart: 1, length: 1
  });
  assert.deepEqual(planAlignedReads(1, 1024 * 1024, 4 * 1024 * 1024, 512), {
    reads: [{ offset: 0, length: 1024 * 1024 }, { offset: 1024 * 1024, length: 512 }],
    sliceStart: 1, length: 1024 * 1024
  });
  assert.throws(() => planAlignedReads(0, 1024 * 1024 + 1, 4 * 1024 * 1024, 512), { code: 'INVALID_READ' });
});

test('compiled helper speaks correlated JSON and exposes only its read-only role', async () => {
  const executable = path.join(root, 'native', 'bin', 'RecoveryChat.VolumeReader.exe');
  const child = spawn(executable, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', data => { output += data; });
  child.stdin.write(`${JSON.stringify({ id: 'hello-7', command: 'hello' })}\n`);
  child.stdin.write(`${JSON.stringify({ id: 'close-8', command: 'close' })}\n`);
  child.stdin.end();
  const exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  assert.equal(exitCode, 0);
  const replies = output.trim().split(/\r?\n/).map(JSON.parse);
  assert.deepEqual(replies.map(reply => reply.id), ['hello-7', 'close-8']);
  assert.deepEqual(replies[0].result, { protocol: 1, role: 'readonly-volume-reader', sessionReuse: true });
  assert.equal(replies[1].result.closed, true);
});

test('actual Windows inventory and destination inspection are metadata-only and internally consistent', { skip: process.platform !== 'win32' }, async () => {
  const devices = await listWindowsDevices();
  assert.ok(devices.length > 0);
  for (const device of devices) {
    assert.match(device.id, /^(?:\\\\\?\\Volume\{[0-9a-f-]+\}\\?|[A-Z]:)$/i);
    assert.ok(Array.isArray(device.diskIds));
    assert.equal(typeof device.ready, 'boolean');
    assert.equal(device.scope, 'volume');
    assert.ok(['locked', 'unlocked', 'unknown'].includes(device.encryption));
    assert.ok(['512n', '512e', '4Kn', 'unsupported', 'unknown'].includes(device.sectorProfile));
    assert.ok(['single-partition-single-disk', 'multi-partition-or-disk', 'unknown'].includes(device.sourceTopology));
    assert.ok(Array.isArray(device.physicalDisks));
    if (device.encryption === 'locked') {
      assert.equal(device.ready, false);
      assert.equal(device.reason, 'LOCKED');
    }
  }
  const destination = await inspectDestination(root);
  assert.equal(path.resolve(destination.canonicalPath), root);
  assert.ok(destination.freeSpace >= 0);
  assert.ok(Array.isArray(destination.diskIds));
});
