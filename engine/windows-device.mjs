import { createHash, randomBytes } from 'node:crypto';
import { access, realpath } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const MAX_READ = 1024 * 1024;
const HELPER_PROTOCOL = 1;
const JOURNAL_REASON_MASK = 0x00000200 | 0x00001000 | 0x00002000;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MAX_INT64 = 0x7fffffffffffffffn;
const MAX_UINT64 = 0xffffffffffffffffn;
const DEVICE_ID = /^(?:\\\\\?\\Volume\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}\\?|[a-z]:)$/i;
const PIPE_NAME = /^RecoveryChat\.[0-9a-f]{32}$/;
const SID = /^S-1-(?:\d+-){1,14}\d+$/;
const approvedDevices = new Map();
// Tokens never leave this module's private association.  Their public object
// deliberately contains no device path, identity, geometry, or native handle.
const preparedOpens = new WeakMap();
const PREPARED_OPEN_TTL_MS = 5000;

export class WindowsDeviceError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'WindowsDeviceError';
    this.code = code;
    this.details = details;
  }
}

const inventoryScript = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$partitions = @(Get-Partition -ErrorAction SilentlyContinue)
$disks = @(Get-Disk -ErrorAction SilentlyContinue)
$bitLocker = @{}
$canQueryBitLocker = $false
try {
  $principal = [Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
  $canQueryBitLocker = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
} catch { }
if ($canQueryBitLocker) {
  try {
    foreach ($item in @(Get-BitLockerVolume -ErrorAction Stop)) {
      $key = ([string]$item.MountPoint).TrimEnd('\\').ToUpperInvariant()
      if (-not [string]::IsNullOrWhiteSpace($key)) {
        $bitLocker[$key] = if ([string]$item.LockStatus -eq 'Locked') { 'locked' } elseif ([string]$item.LockStatus -eq 'Unlocked') { 'unlocked' } else { 'unknown' }
      }
    }
  } catch {
    try {
      foreach ($item in @(Get-CimInstance -Namespace 'root\CIMV2\Security\MicrosoftVolumeEncryption' -ClassName Win32_EncryptableVolume -ErrorAction Stop)) {
        $key = ([string]$item.DriveLetter).TrimEnd('\\').ToUpperInvariant()
        if (-not [string]::IsNullOrWhiteSpace($key)) {
          $lockResult = Invoke-CimMethod -InputObject $item -MethodName GetLockStatus -ErrorAction Stop
          $bitLocker[$key] = if ([uint32]$lockResult.ReturnValue -ne 0) { 'unknown' }
            elseif ([uint32]$lockResult.LockStatus -eq 1) { 'locked' }
            elseif ([uint32]$lockResult.LockStatus -eq 0) { 'unlocked' } else { 'unknown' }
        }
      }
    } catch { }
  }
}
$systemLetter = [System.IO.Path]::GetPathRoot($env:SystemRoot).Substring(0, 2).ToUpperInvariant()
$rows = foreach ($volume in @(Get-Volume -ErrorAction Stop)) {
  $letter = if ($null -ne $volume.DriveLetter) { ([string]$volume.DriveLetter).ToUpperInvariant() + ':' } else { $null }
  $unique = [string]$volume.UniqueId
  $id = if (-not [string]::IsNullOrWhiteSpace($unique)) { $unique } else { $letter }
  if ([string]::IsNullOrWhiteSpace($id)) { continue }
  $matched = @($partitions | Where-Object {
    ($letter -and $_.DriveLetter -and (([string]$_.DriveLetter).ToUpperInvariant() + ':') -eq $letter) -or
    ($unique -and @($_.AccessPaths) -contains $unique)
  })
  $diskIds = @($matched | ForEach-Object { [string]$_.DiskNumber } | Sort-Object -Unique)
  $diskRows = @($diskIds | ForEach-Object {
    $diskId = [string]$_
    $disk = @($disks | Where-Object { [string]$_.Number -eq $diskId }) | Select-Object -First 1
    if ($disk) {
      $diskIdentity = if (-not [string]::IsNullOrWhiteSpace([string]$disk.UniqueId)) { [string]$disk.UniqueId }
        elseif (-not [string]::IsNullOrWhiteSpace([string]$disk.SerialNumber)) { [string]$disk.SerialNumber }
        elseif (-not [string]::IsNullOrWhiteSpace([string]$disk.Path)) { [string]$disk.Path } else { $null }
      $identityKind = if (-not [string]::IsNullOrWhiteSpace([string]$disk.UniqueId)) { 'unique-id' }
        elseif (-not [string]::IsNullOrWhiteSpace([string]$disk.SerialNumber)) { 'serial-number' }
        elseif (-not [string]::IsNullOrWhiteSpace([string]$disk.Path)) { 'device-path' } else { 'unknown' }
      [ordered]@{
        diskId = $diskId
        identity = $diskIdentity
        identityKind = $identityKind
        model = if (-not [string]::IsNullOrWhiteSpace([string]$disk.Model)) { [string]$disk.Model } else { [string]$disk.FriendlyName }
        serialNumber = if (-not [string]::IsNullOrWhiteSpace([string]$disk.SerialNumber)) { [string]$disk.SerialNumber } else { $null }
        size = if ($null -ne $disk.Size) { [uint64]$disk.Size } else { $null }
        interface = if (-not [string]::IsNullOrWhiteSpace([string]$disk.BusType)) { [string]$disk.BusType } else { $null }
        logicalSectorSize = if ($null -ne $disk.LogicalSectorSize) { [uint32]$disk.LogicalSectorSize } else { $null }
        physicalSectorSize = if ($null -ne $disk.PhysicalSectorSize) { [uint32]$disk.PhysicalSectorSize } else { $null }
      }
    }
  })
  $partitionOffset = if ($matched.Count -eq 1 -and $null -ne $matched[0].Offset) { [uint64]$matched[0].Offset } else { $null }
  $partitionNumber = if ($matched.Count -eq 1 -and $null -ne $matched[0].PartitionNumber) { [uint32]$matched[0].PartitionNumber } else { $null }
  $sourceTopology = if ($matched.Count -eq 1 -and $diskIds.Count -eq 1) { 'single-partition-single-disk' }
    elseif ($matched.Count -gt 0 -or $diskIds.Count -gt 0) { 'multi-partition-or-disk' } else { 'unknown' }
  $partitionSize = if ($sourceTopology -eq 'single-partition-single-disk' -and $null -ne $matched[0].Size) { [uint64]$matched[0].Size } else { $null }
  $singleDisk = if ($diskRows.Count -eq 1) { $diskRows[0] } else { $null }
  $encryption = if ($letter -and $bitLocker.ContainsKey($letter)) { [string]$bitLocker[$letter] }
    elseif ($unique -and $bitLocker.ContainsKey($unique.TrimEnd('\\').ToUpperInvariant())) { [string]$bitLocker[$unique.TrimEnd('\\').ToUpperInvariant()] }
    else { 'unknown' }
  $size = if ($null -eq $volume.Size) { 0 } else { [uint64]$volume.Size }
  $free = if ($null -eq $volume.SizeRemaining) { 0 } else { [uint64]$volume.SizeRemaining }
  $ready = $size -gt 0 -and $encryption -ne 'locked'
  [ordered]@{
    id = $id
    label = [string]$volume.FileSystemLabel
    driveLetter = $letter
    fileSystem = [string]$volume.FileSystem
    size = $size
    freeSpace = $free
    diskIds = $diskIds
    physicalDisks = $diskRows
    partitionOffset = $partitionOffset
    partitionNumber = $partitionNumber
    partitionSize = $partitionSize
    sourceTopology = $sourceTopology
    logicalSectorSize = if ($singleDisk) { $singleDisk.logicalSectorSize } else { $null }
    physicalSectorSize = if ($singleDisk) { $singleDisk.physicalSectorSize } else { $null }
    interface = if ($singleDisk) { $singleDisk.interface } else { $null }
    encryption = $encryption
    scope = 'volume'
    serial = [string]$volume.UniqueId
    system = ($letter -eq $systemLetter)
    ready = $ready
    reason = if ($ready) { $null } elseif ($encryption -eq 'locked') { 'LOCKED' } else { 'NOT_READY' }
  }
}
@($rows) | ConvertTo-Json -Compress -Depth 5
`;

const destinationScript = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$requested = $env:RECOVERYCHAT_DESTINATION
if ([string]::IsNullOrWhiteSpace($requested)) { throw 'Destination path is empty.' }
$item = Get-Item -LiteralPath $requested -Force
$canonical = $item.FullName
$root = [System.IO.Path]::GetPathRoot($canonical)
$letter = if ($root -match '^[A-Za-z]:\\') { $root.Substring(0, 2).ToUpperInvariant() } else { $null }
$volume = if ($letter) { Get-Volume -DriveLetter $letter.Substring(0, 1) -ErrorAction Stop } else { $null }
$partitions = if ($letter) { @(Get-Partition -DriveLetter $letter.Substring(0, 1) -ErrorAction SilentlyContinue) } else { @() }
$diskIds = @($partitions | ForEach-Object { [string]$_.DiskNumber } | Sort-Object -Unique)
$disks = @($diskIds | ForEach-Object { Get-Disk -Number $_ -ErrorAction SilentlyContinue })
$physicalDiskIdentities = @($diskIds | ForEach-Object {
  $diskId = [string]$_
  $disk = @($disks | Where-Object { [string]$_.Number -eq $diskId }) | Select-Object -First 1
  if ($disk) {
    if (-not [string]::IsNullOrWhiteSpace([string]$disk.UniqueId)) { [string]$disk.UniqueId }
    elseif (-not [string]::IsNullOrWhiteSpace([string]$disk.SerialNumber)) { [string]$disk.SerialNumber }
    elseif (-not [string]::IsNullOrWhiteSpace([string]$disk.Path)) { [string]$disk.Path }
  }
} | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Sort-Object -Unique)
$driveInfo = New-Object System.IO.DriveInfo($root)
$physicalDiskInterfaces = @($disks | Where-Object { $diskIds -contains [string]$_.Number } | ForEach-Object { [string]$_.BusType } | Sort-Object -Unique)
[ordered]@{
  canonicalPath = $canonical
  id = if ($volume) { [string]$volume.UniqueId } else { $root }
  driveLetter = $letter
  fileSystem = if ($volume) { [string]$volume.FileSystem } else { [string]$driveInfo.DriveFormat }
  freeSpace = [uint64]$driveInfo.AvailableFreeSpace
  size = [uint64]$driveInfo.TotalSize
  diskIds = $diskIds
  physicalDiskIdentities = $physicalDiskIdentities
  physicalDiskInterfaces = $physicalDiskInterfaces
  serial = if ($volume) { [string]$volume.UniqueId } else { $root }
} | ConvertTo-Json -Compress -Depth 4
`;

const currentSidScript = "[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value";
const elevationScript = String.raw`
$ErrorActionPreference = 'Stop'
$helper = $env:RECOVERYCHAT_HELPER
$pipe = $env:RECOVERYCHAT_PIPE
$owner = $env:RECOVERYCHAT_OWNER_SID
if (-not [System.IO.Path]::IsPathRooted($helper) -or -not (Test-Path -LiteralPath $helper -PathType Leaf)) { throw 'Invalid helper path.' }
if ($pipe -notmatch '^RecoveryChat\.[0-9a-f]{32}$') { throw 'Invalid pipe name.' }
if ($owner -notmatch '^S-1-(?:\d+-){1,14}\d+$') { throw 'Invalid owner SID.' }
$process = Start-Process -FilePath $helper -ArgumentList @('--pipe', $pipe, '--owner', $owner) -Verb RunAs -WindowStyle Hidden -PassThru
[ordered]@{ pid = $process.Id } | ConvertTo-Json -Compress
`;

function stableIdentity(row) {
  const material = JSON.stringify([
    String(row.id ?? '').toLowerCase(), String(row.serial ?? '').toLowerCase(),
    Number(row.size ?? 0), [...(row.diskIds ?? [])].map(String).sort()
  ]);
  return `windows-volume:${createHash('sha256').update(material).digest('hex')}`;
}

// Keep the legacy volume identity compatible with the native protocol. Bind a
// selected acquisition separately to its observed physical device and geometry.
export function readLayerFingerprint(device) {
  const physical = device?.physicalDisks;
  if (!Array.isArray(physical) || physical.length !== 1 ||
      !['unique-id', 'serial-number'].includes(physical[0]?.identityKind) ||
      !physical[0].identity || physical[0].identity === 'unknown' ||
      !Number.isSafeInteger(device.partitionOffset) || device.partitionOffset < 0 ||
      !Number.isSafeInteger(device.logicalSectorSize) || device.logicalSectorSize <= 0 ||
      !Number.isSafeInteger(device.physicalSectorSize) || device.physicalSectorSize <= 0 ||
      device.sourceTopology !== 'single-partition-single-disk') return null;
  const material = [String(device.id).toLowerCase(), device.identity,
    normalizeDiskIds(device.diskIds), physical[0].identityKind, String(physical[0].identity).trim(),
    device.partitionOffset, device.partitionNumber ?? null,
    Number.isSafeInteger(device.partitionSize) && device.partitionSize > 0 ? device.partitionSize : 'unknown',
    device.logicalSectorSize, device.physicalSectorSize, device.sourceTopology,
    String(device.fileSystem || '').toUpperCase()];
  return createHash('sha256').update(JSON.stringify(material)).digest('hex');
}

const volumeLeaseKey = device => `${device.id.toLowerCase()}\0${device.identity}\0${readLayerFingerprint(device) ?? 'unknown'}`;

function parseJsonOutput(stdout, context) {
  const trimmed = stdout.trim();
  if (!trimmed) throw new WindowsDeviceError('INVENTORY_FAILED', `${context} returned no data.`);
  try { return JSON.parse(trimmed); }
  catch (error) { throw new WindowsDeviceError('INVENTORY_FAILED', `${context} returned invalid JSON.`, { cause: error.message }); }
}

function normalizeDiskIds(value) {
  return [...new Set((Array.isArray(value) ? value : value == null ? [] : [value]).map(String))].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

function knownString(value) {
  const normalized = value == null ? '' : String(value).trim();
  return normalized || 'unknown';
}

function positiveInteger(value) {
  const normalized = Number(value);
  return Number.isSafeInteger(normalized) && normalized > 0 ? normalized : 'unknown';
}

function nonnegativeInteger(value) {
  if (value == null || typeof value === 'boolean' || typeof value === 'string' && !value.trim()) return 'unknown';
  const normalized = Number(value);
  return Number.isSafeInteger(normalized) && normalized >= 0 ? normalized : 'unknown';
}

function sectorProfile(logical, physical) {
  if (logical === 'unknown' || physical === 'unknown') return 'unknown';
  if (logical === 512 && physical === 512) return '512n';
  if (logical === 512 && physical === 4096) return '512e';
  if (logical === 4096 && physical === 4096) return '4Kn';
  return 'unsupported';
}

function normalizeEncryption(value) {
  const normalized = knownString(value).toLowerCase();
  return normalized === 'locked' || normalized === 'unlocked' ? normalized : 'unknown';
}

function normalizePhysicalDisks(value) {
  const rows = Array.isArray(value) ? value : [];
  return Object.freeze(rows.map(row => Object.freeze({
    diskId: knownString(row?.diskId),
    identity: knownString(row?.identity),
    identityKind: ['unique-id', 'serial-number', 'device-path'].includes(row?.identityKind) ? row.identityKind : 'unknown',
    model: knownString(row?.model),
    serialNumber: knownString(row?.serialNumber),
    size: positiveInteger(row?.size),
    interface: knownString(row?.interface),
    logicalSectorSize: positiveInteger(row?.logicalSectorSize),
    physicalSectorSize: positiveInteger(row?.physicalSectorSize)
  })));
}

export function normalizeInventory(payload) {
  const rows = Array.isArray(payload) ? payload : payload == null ? [] : [payload];
  return rows.map(row => {
    const id = String(row.id ?? '').trim();
    if (!DEVICE_ID.test(id)) throw new WindowsDeviceError('INVALID_INVENTORY', `Windows returned an invalid volume identifier: ${id}`);
    const diskIds = normalizeDiskIds(row.diskIds);
    const physicalDisks = normalizePhysicalDisks(row.physicalDisks);
    const logicalSectorSize = positiveInteger(row.logicalSectorSize);
    const physicalSectorSize = positiveInteger(row.physicalSectorSize);
    const encryption = normalizeEncryption(row.encryption ?? row.encryptionStatus ?? row.bitLockerStatus);
    const windowsReady = Boolean(row.ready);
    const normalized = {
      id,
      label: String(row.label || row.driveLetter || id),
      driveLetter: row.driveLetter ? String(row.driveLetter).toUpperCase() : null,
      fileSystem: row.fileSystem ? String(row.fileSystem).toUpperCase() : null,
      size: Number(row.size || 0),
      freeSpace: Number(row.freeSpace || 0),
      diskIds,
      physicalDisks,
      physicalDiskIdentity: physicalDisks.length === 1 ? physicalDisks[0].identity : 'unknown',
      physicalDiskModel: physicalDisks.length === 1 ? physicalDisks[0].model : 'unknown',
      partitionOffset: nonnegativeInteger(row.partitionOffset ?? row.startingOffset),
      partitionNumber: positiveInteger(row.partitionNumber),
      partitionSize: positiveInteger(row.partitionSize ?? row.rawVolumeSize),
      sourceTopology: ['single-partition-single-disk', 'multi-partition-or-disk'].includes(row.sourceTopology) ? row.sourceTopology : 'unknown',
      logicalSectorSize,
      physicalSectorSize,
      sectorProfile: sectorProfile(logicalSectorSize, physicalSectorSize),
      interface: knownString(row.interface ?? row.interfaceType ?? row.busType),
      encryption,
      scope: 'volume',
      system: Boolean(row.system),
      ready: windowsReady && encryption !== 'locked'
    };
    normalized.identity = stableIdentity({ ...row, ...normalized });
    if (!normalized.ready) normalized.reason = encryption === 'locked' ? 'LOCKED' : String(row.reason || 'NOT_READY');
    return Object.freeze(normalized);
  }).sort((a, b) => (a.driveLetter || a.id).localeCompare(b.driveLetter || b.id, 'en'));
}

function runPowerShell(script, environment = {}, { cancellationCode = 'POWERSHELL_FAILED', timeout = 20_000, signal } = {}) {
  if (signal?.aborted) return Promise.reject(new WindowsDeviceError('CANCELLED', 'The Windows helper startup was cancelled.'));
  if (process.platform !== 'win32') return Promise.reject(new WindowsDeviceError('WINDOWS_ONLY', 'Windows device access is available only on Windows.'));
  const utf8Script = `$recoveryChatUtf8 = New-Object System.Text.UTF8Encoding($false)\n[Console]::OutputEncoding = $recoveryChatUtf8\n$OutputEncoding = $recoveryChatUtf8\n${script}`;
  const encoded = Buffer.from(utf8Script, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...environment }
    });
    let stdout = '', stderr = '', settled = false;
    const abort = () => { child.kill(); finish(new WindowsDeviceError('CANCELLED', 'The Windows helper startup was cancelled.')); };
    const timer = setTimeout(() => { child.kill(); finish(new WindowsDeviceError('HELPER_TIMEOUT', 'The Windows helper did not respond in time.')); }, timeout);
    function finish(error, value) {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      error ? reject(error) : resolve(value);
    }
    child.stdout.on('data', chunk => { if (stdout.length < 8 * 1024 * 1024) stdout += chunk; });
    child.stderr.on('data', chunk => { if (stderr.length < 64 * 1024) stderr += chunk; });
    child.once('error', error => finish(new WindowsDeviceError(cancellationCode, error.message)));
    child.once('close', code => code === 0 ? finish(null, stdout) : finish(new WindowsDeviceError(cancellationCode, stderr.trim() || `PowerShell exited with code ${code}.`)));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export async function listWindowsDevices(options = {}) {
  const payload = options.fixture ?? parseJsonOutput(await runPowerShell(inventoryScript, {}, { signal: options.signal }), 'Windows volume inventory');
  const devices = normalizeInventory(payload);
  approvedDevices.clear();
  for (const device of devices) approvedDevices.set(`${device.id.toLowerCase()}\0${device.identity}`, device);
  return devices;
}

export async function inspectDestination(requestedPath, options = {}) {
  if (typeof requestedPath !== 'string' || !requestedPath.trim()) throw new WindowsDeviceError('INVALID_DESTINATION', 'Choose an existing destination folder.');
  const resolvedPath = options.fixture ? requestedPath : await realpath(requestedPath);
  const row = options.fixture ?? parseJsonOutput(await runPowerShell(destinationScript, { RECOVERYCHAT_DESTINATION: resolvedPath }), 'Destination inspection');
  const diskIds = normalizeDiskIds(row.diskIds);
  const physicalDiskIdentities = [...new Set((Array.isArray(row.physicalDiskIdentities) ? row.physicalDiskIdentities : row.physicalDiskIdentities == null ? [] : [row.physicalDiskIdentities])
    .map(value => String(value).trim()).filter(Boolean))].sort();
  return Object.freeze({
    canonicalPath: String(row.canonicalPath), diskIds, physicalDiskIdentities,
    physicalDiskInterfaces: [...new Set((Array.isArray(row.physicalDiskInterfaces) ? row.physicalDiskInterfaces : row.physicalDiskInterfaces == null ? [] : [row.physicalDiskInterfaces]).map(String).map(value => value.trim()).filter(Boolean))].sort(),
    freeSpace: Number(row.freeSpace || 0), fileSystem: row.fileSystem ? String(row.fileSystem).toUpperCase() : null,
    identity: stableIdentity({ ...row, diskIds })
  });
}

function sameDevice(expected, actual) {
  return expected.id.toLowerCase() === actual.id.toLowerCase() && expected.identity === actual.identity &&
    JSON.stringify(expected.diskIds) === JSON.stringify(actual.diskIds) && readLayerFingerprint(expected) === readLayerFingerprint(actual);
}

function preparedOwner(owner) {
  if (typeof owner !== 'string' || !owner.trim()) {
    throw new WindowsDeviceError('PREPARED_OPEN_OWNER', 'A prepared volume open must be bound to its job owner.');
  }
  return owner;
}

function clonePreparedDevice(device) {
  return Object.freeze({ ...device,
    diskIds: Object.freeze([...(device.diskIds ?? [])]),
    physicalDisks: Object.freeze((device.physicalDisks ?? []).map(disk => Object.freeze({ ...disk })))
  });
}

async function helperExecutable() {
  const candidate = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'native', 'bin', 'RecoveryChat.VolumeReader.exe');
  await access(candidate);
  return realpath(candidate);
}

export class JsonChannel {
  constructor(readable, writable, onClose) {
    this.writable = writable;
    this.onClose = onClose;
    this.pending = new Map();
    this.nextId = 1;
    this.buffer = '';
    this.closed = false;
    readable.setEncoding('utf8');
    readable.on('data', data => this.accept(data));
    readable.once('end', () => this.failAll(new WindowsDeviceError('HELPER_CLOSED', 'The volume helper disconnected.')));
    readable.once('error', error => this.failAll(new WindowsDeviceError('HELPER_FAILED', error.message)));
  }
  accept(data) {
    if (this.closed) return;
    this.buffer += data;
    if (this.buffer.length > 4 * 1024 * 1024) {
      this.buffer = '';
      this.failAll(new WindowsDeviceError('HELPER_PROTOCOL_LIMIT', 'The volume helper response exceeded its bounded frame size.'));
      return;
    }
    for (;;) {
      const at = this.buffer.indexOf('\n');
      if (at < 0) break;
      const line = this.buffer.slice(0, at).trim(); this.buffer = this.buffer.slice(at + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { this.failAll(new WindowsDeviceError('HELPER_PROTOCOL', 'The volume helper returned invalid JSON.')); return; }
      const pending = this.pending.get(String(message.id));
      if (!pending) continue;
      this.pending.delete(String(message.id)); clearTimeout(pending.timer);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new WindowsDeviceError(message.error?.code || 'HELPER_FAILED', message.error?.message || 'The volume helper failed.'));
    }
  }
  request(command, fields = {}, timeout = 15_000) {
    if (this.closed) return Promise.reject(new WindowsDeviceError('HELPER_CLOSED', 'The volume helper is closed.'));
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.failAll(new WindowsDeviceError('HELPER_TIMEOUT', 'The volume helper did not respond in time.')), timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.writable.write(`${JSON.stringify({ id, command, ...fields })}\n`, error => {
        if (!error) return;
        clearTimeout(timer); this.pending.delete(id); reject(new WindowsDeviceError('HELPER_FAILED', error.message));
      });
    });
  }
  failAll(error) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear(); this.onClose?.();
  }
  destroy() { this.failAll(new WindowsDeviceError('HELPER_CLOSED', 'The volume helper is closed.')); this.writable.destroy?.(); }
}

async function startDirect(helper) {
  const child = spawn(helper, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { if (stderr.length < 64 * 1024) stderr += chunk; });
  const channel = new JsonChannel(child.stdout, child.stdin, () => { if (!child.killed) child.kill(); });
  child.once('error', error => channel.failAll(new WindowsDeviceError('HELPER_FAILED', error.message)));
  child.once('exit', code => channel.failAll(new WindowsDeviceError('HELPER_CLOSED', stderr.trim() || `The volume helper exited with code ${code}.`)));
  return channel;
}

export function buildElevationSpec(helper, pipeName, ownerSid) {
  if (!path.isAbsolute(helper) || !PIPE_NAME.test(pipeName) || !SID.test(ownerSid)) throw new WindowsDeviceError('INVALID_ELEVATION_ARGUMENT', 'Invalid fixed elevation helper arguments.');
  return Object.freeze({ script: elevationScript, environment: { RECOVERYCHAT_HELPER: helper, RECOVERYCHAT_PIPE: pipeName, RECOVERYCHAT_OWNER_SID: ownerSid } });
}

export function planAlignedReads(offset, length, size, sectorSize) {
  if (![offset, length, size, sectorSize].every(Number.isSafeInteger) || offset < 0 || length <= 0 || length > MAX_READ ||
      size <= 0 || sectorSize <= 0 || sectorSize > 65536 || (sectorSize & (sectorSize - 1)) !== 0 || offset > size - length)
    throw new WindowsDeviceError('INVALID_READ', 'The requested read is outside the volume or exceeds 1 MiB.');
  const alignedStart = Math.floor(offset / sectorSize) * sectorSize;
  const alignedEnd = Math.ceil((offset + length) / sectorSize) * sectorSize;
  if (alignedEnd > size) throw new WindowsDeviceError('INVALID_GEOMETRY', 'The volume length is not compatible with its sector size.');
  const reads = [];
  for (let cursor = alignedStart; cursor < alignedEnd;) {
    const chunkLength = Math.min(MAX_READ, alignedEnd - cursor);
    reads.push(Object.freeze({ offset: cursor, length: chunkLength }));
    cursor += chunkLength;
  }
  return Object.freeze({ reads: Object.freeze(reads), sliceStart: offset - alignedStart, length });
}

function decimalField(value, label, maximum) {
  if (typeof value !== 'string' || !DECIMAL.test(value) || BigInt(value) > maximum)
    throw new WindowsDeviceError('INVALID_JOURNAL_REQUEST', `${label} must be a canonical nonnegative decimal string.`);
  return value;
}

export function planJournalRead({ startUsn, journalId, maxBytes = MAX_READ } = {}) {
  const normalizedStart = decimalField(startUsn, 'startUsn', MAX_INT64);
  const normalizedId = decimalField(journalId, 'journalId', MAX_UINT64);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 8 || maxBytes > MAX_READ)
    throw new WindowsDeviceError('INVALID_JOURNAL_REQUEST', 'maxBytes must be an integer between 8 bytes and 1 MiB.');
  return Object.freeze({ startUsn: normalizedStart, journalId: normalizedId, maxBytes });
}

export function normalizeJournalQuery(result) {
  if (!result || typeof result !== 'object') throw new WindowsDeviceError('HELPER_PROTOCOL', 'The volume helper returned an invalid USN journal description.');
  try {
    const normalized = {
      journalId: decimalField(result.journalId, 'journalId', MAX_UINT64),
      firstUsn: decimalField(result.firstUsn, 'firstUsn', MAX_INT64),
      nextUsn: decimalField(result.nextUsn, 'nextUsn', MAX_INT64),
      lowestValidUsn: decimalField(result.lowestValidUsn, 'lowestValidUsn', MAX_INT64),
      maxUsn: decimalField(result.maxUsn, 'maxUsn', MAX_INT64),
      maximumSize: decimalField(result.maximumSize, 'maximumSize', MAX_UINT64),
      allocationDelta: decimalField(result.allocationDelta, 'allocationDelta', MAX_UINT64)
    };
    if (BigInt(normalized.firstUsn) > BigInt(normalized.nextUsn) || BigInt(normalized.nextUsn) > BigInt(normalized.maxUsn))
      throw new WindowsDeviceError('HELPER_PROTOCOL', 'The volume helper returned inconsistent USN journal bounds.');
    return Object.freeze(normalized);
  } catch (error) {
    if (error.code === 'HELPER_PROTOCOL') throw error;
    throw new WindowsDeviceError('HELPER_PROTOCOL', 'The volume helper returned an invalid USN journal description.', { cause: error.message });
  }
}

export function normalizeJournalRead(result, maxBytes = MAX_READ) {
  if (!result || typeof result !== 'object' || !Number.isSafeInteger(result.bytesRead)
      || result.bytesRead < 8 || result.bytesRead > maxBytes || result.reasonMask !== JOURNAL_REASON_MASK
      || typeof result.data !== 'string' || !BASE64.test(result.data))
    throw new WindowsDeviceError('HELPER_PROTOCOL', 'The volume helper returned an invalid USN journal buffer.');
  const data = Buffer.from(result.data, 'base64');
  if (data.length !== result.bytesRead)
    throw new WindowsDeviceError('HELPER_PROTOCOL', 'The USN journal response length does not match its payload.');
  let nextUsn;
  try { nextUsn = decimalField(result.nextUsn, 'nextUsn', MAX_INT64); }
  catch (error) { throw new WindowsDeviceError('HELPER_PROTOCOL', 'The volume helper returned an invalid next USN.', { cause: error.message }); }
  if (data.readBigInt64LE(0) < 0n || data.readBigInt64LE(0).toString() !== nextUsn)
    throw new WindowsDeviceError('HELPER_PROTOCOL', 'The next USN does not match the returned journal buffer.');
  return Object.freeze({ data, bytesRead: data.length, nextUsn, reasonMask: JOURNAL_REASON_MASK });
}

async function connectPipe(pipeName, timeout = 30_000, signal) {
  const pipePath = `\\\\.\\pipe\\${pipeName}`;
  const expires = Date.now() + timeout;
  return new Promise((resolve, reject) => {
    let socket, retry, settled = false;
    const abort = () => finish(new WindowsDeviceError('CANCELLED', 'The Windows helper connection was cancelled.'));
    function finish(error, channel) {
      if (settled) return;
      settled = true;
      clearTimeout(retry);
      signal?.removeEventListener('abort', abort);
      if (error) { socket?.destroy(); reject(error); } else resolve(channel);
    }
    const attempt = () => {
      if (settled) return;
      socket = net.createConnection(pipePath);
      const failed = error => {
        socket.destroy();
        if (settled) return;
        if (Date.now() >= expires) finish(new WindowsDeviceError('HELPER_TIMEOUT', 'The elevated volume helper did not connect.', { cause: error.message }));
        else retry = setTimeout(attempt, 125);
      };
      socket.once('error', failed);
      socket.once('connect', () => {
        socket.removeListener('error', failed);
        const connected = socket;
        if (settled) { connected.destroy(); return; }
        finish(null, new JsonChannel(connected, connected, () => connected.destroy()));
      });
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort(); else attempt();
  });
}

async function startElevated(helper, { signal } = {}) {
  const ownerSid = (await runPowerShell(currentSidScript, {}, { signal })).trim();
  if (!SID.test(ownerSid)) throw new WindowsDeviceError('SID_FAILED', 'Windows did not return a valid current-user SID.');
  const pipeName = `RecoveryChat.${randomBytes(16).toString('hex')}`;
  const spec = buildElevationSpec(helper, pipeName, ownerSid);
  parseJsonOutput(await runPowerShell(spec.script, spec.environment, { cancellationCode: 'ELEVATION_CANCELLED', timeout: 60_000, signal }), 'Elevation launcher');
  return connectPipe(pipeName, 30_000, signal);
}

async function validateListedDevice(device, inventory = listWindowsDevices) {
  if (!device || typeof device !== 'object') throw new WindowsDeviceError('INVALID_DEVICE', 'Choose a device from the current Windows device list.');
  const approved = approvedDevices.get(`${String(device.id).toLowerCase()}\0${String(device.identity)}`);
  if (!approved || !sameDevice(approved, device)) throw new WindowsDeviceError('DEVICE_NOT_ENUMERATED', 'Refresh the device list and choose one of the listed volumes.');
  const current = (await inventory()).find(row => row.id.toLowerCase() === approved.id.toLowerCase());
  if (!current || !sameDevice(approved, current)) throw new WindowsDeviceError('DEVICE_CHANGED', 'The selected Windows volume changed. Refresh the device list.');
  if (!current.ready) throw new WindowsDeviceError(current.reason || 'NOT_READY', 'The selected Windows volume is not ready.');
  return current;
}

export async function openWindowsVolume(device, options = {}) {
  const current = await validateListedDevice(device);
  const helper = await helperExecutable();
  const channel = options.elevate === true ? await startElevated(helper) : await startDirect(helper);
  let nativeInfo;
  try {
    const hello = await channel.request('hello');
    if (hello.protocol !== HELPER_PROTOCOL) throw new WindowsDeviceError('HELPER_PROTOCOL', 'The native helper protocol version does not match.');
    nativeInfo = await channel.request('open', { path: current.id, expectedDiskIds: current.diskIds });
  } catch (error) { channel.destroy(); throw error; }
  return volumeProvider(current, nativeInfo, channel);
}

function volumeProvider(current, nativeInfo, channel) {
  let closed = false;
  let queue = Promise.resolve();
  async function verifyCurrent() {
    // The native assertion re-queries serial, size, sector geometry, physical
    // extents, filesystem and storage identity on the opened handle. Re-running
    // PowerShell inventory during raw reads adds latency and source activity.
    const result = await channel.request('assert');
    if (result?.unchanged !== true || result.identity !== nativeInfo.identity)
      throw new WindowsDeviceError('DEVICE_CHANGED', 'The opened Windows volume identity changed.');
  }
  function serialize(operation) {
    const result = queue.then(operation, operation);
    queue = result.catch(() => {});
    return result;
  }
  return {
    info: Object.freeze({ ...nativeInfo, id: current.id, driveLetter: current.driveLetter, diskIds: current.diskIds, identity: current.identity, nativeIdentity: nativeInfo.identity, readLayerFingerprint: readLayerFingerprint(current) }),
    read(offset, length, { signal } = {}) {
      return serialize(async () => {
        if (closed) throw new WindowsDeviceError('HELPER_CLOSED', 'The volume is closed.');
        if (signal?.aborted) throw new WindowsDeviceError('CANCELLED', 'The read was cancelled.');
        const plan = planAlignedReads(offset, length, nativeInfo.size, nativeInfo.sectorSize);
        await verifyCurrent();
        const chunks = [];
        for (const nativeRead of plan.reads) {
          if (signal?.aborted) throw new WindowsDeviceError('CANCELLED', 'The read was cancelled.');
          const result = await channel.request('read', nativeRead, 30_000);
          const chunk = Buffer.from(result.data, 'base64');
          if (chunk.length !== nativeRead.length) throw new WindowsDeviceError('SHORT_READ', 'The volume helper returned fewer bytes than requested.');
          chunks.push(chunk);
        }
        if (signal?.aborted) throw new WindowsDeviceError('CANCELLED', 'The read was cancelled.');
        return Buffer.concat(chunks).subarray(plan.sliceStart, plan.sliceStart + plan.length);
      });
    },
    queryJournal({ signal } = {}) {
      return serialize(async () => {
        if (closed) throw new WindowsDeviceError('HELPER_CLOSED', 'The volume is closed.');
        if (signal?.aborted) throw new WindowsDeviceError('CANCELLED', 'The journal query was cancelled.');
        await verifyCurrent();
        const result = normalizeJournalQuery(await channel.request('queryJournal', {}, 30_000));
        if (signal?.aborted) throw new WindowsDeviceError('CANCELLED', 'The journal query was cancelled.');
        return result;
      });
    },
    readJournal(options = {}) {
      return serialize(async () => {
        if (closed) throw new WindowsDeviceError('HELPER_CLOSED', 'The volume is closed.');
        const { signal } = options;
        if (signal?.aborted) throw new WindowsDeviceError('CANCELLED', 'The journal read was cancelled.');
        const request = planJournalRead(options);
        await verifyCurrent();
        const result = normalizeJournalRead(await channel.request('readJournal', request, 30_000), request.maxBytes);
        if (signal?.aborted) throw new WindowsDeviceError('CANCELLED', 'The journal read was cancelled.');
        return result;
      });
    },
    assertUnchanged() { return serialize(async () => { if (closed) throw new WindowsDeviceError('HELPER_CLOSED', 'The volume is closed.'); await verifyCurrent(true); }); },
    close() {
      return serialize(async () => {
        if (closed) return;
        closed = true;
        try { await channel.request('close'); } finally { channel.destroy(); }
      });
    }
  };
}

// Owned by the main process, not by a per-search worker. A single secured
// connection holds at most one native volume handle. Each operation selects its
// lease's volume inside the shared queue and checks its original native identity.
export class WindowsVolumeSession {
  constructor({ inventory = listWindowsDevices, helperPath = helperExecutable,
    directFactory = startDirect, elevatedFactory = startElevated, now = () => performance.now(),
    preparedOpenTtlMs = PREPARED_OPEN_TTL_MS } = {}) {
    if (typeof now !== 'function' || !Number.isSafeInteger(preparedOpenTtlMs) || preparedOpenTtlMs < 1 || preparedOpenTtlMs > 60_000) {
      throw new WindowsDeviceError('INVALID_LIMIT', 'The prepared volume open lifetime is invalid.');
    }
    this.inventory = inventory;
    this.helperPath = helperPath;
    this.directFactory = directFactory;
    this.elevatedFactory = elevatedFactory;
    this.now = now;
    this.preparedOpenTtlMs = preparedOpenTtlMs;
    this.queue = Promise.resolve();
    this.channel = null;
    this.active = null;
    this.elevated = false;
    this.generation = 0;
    this.disposed = false;
    this.openBatch = null;
    this.controller = new AbortController();
  }

  serialize(operation) {
    const result = this.queue.then(async () => {
      try { return await operation(); }
      catch (error) {
        if (this.channel?.closed) this.retire(true);
        throw error;
      }
    });
    this.queue = result.catch(() => {});
    return result;
  }

  ensureRunning() {
    if (this.disposed) throw new WindowsDeviceError('HELPER_CLOSED', 'The Windows volume session is closed.');
  }

  retire(invalidateLeases) {
    const channel = this.channel;
    this.channel = null;
    this.active = null;
    this.elevated = false;
    if (invalidateLeases) this.generation++;
    channel?.destroy();
  }

  async start(elevated, onPermission, batch) {
    let channel, closeStartingChannel;
    try {
      this.ensureRunning();
      const helper = await this.helperPath();
      this.ensureRunning();
      if (elevated) {
        // Notify only when a new elevated process is actually being requested.
        try { onPermission?.(); } catch { /* An observer cannot own the helper lifecycle. */ }
      }
      const options = { signal: this.controller.signal };
      channel = await (elevated ? this.elevatedFactory(helper, options) : this.directFactory(helper, options));
      this.ensureRunning();
      closeStartingChannel = () => channel.destroy();
      this.controller.signal.addEventListener('abort', closeStartingChannel, { once: true });
      const hello = await channel.request('hello');
      if (hello?.protocol !== HELPER_PROTOCOL || hello.sessionReuse !== true)
        throw new WindowsDeviceError('HELPER_PROTOCOL', 'The native helper does not support reusable volume sessions. Update the application and its helper together.');
      this.ensureRunning();
      this.channel = channel;
      this.elevated = elevated;
    } catch (error) {
      channel?.destroy();
      // Concurrent searches share the failed permission attempt. Only a later
      // open after this batch settles can ask the user again.
      batch.failure = error;
      throw error;
    } finally {
      if (closeStartingChannel) this.controller.signal.removeEventListener('abort', closeStartingChannel);
    }
  }

  async select(current, expectedNative = null, verify = true) {
    const channel = this.channel;
    if (!channel || channel.closed) throw new WindowsDeviceError('HELPER_CLOSED', 'The volume helper disconnected.');
    try {
      const key = volumeLeaseKey(current);
      if (this.active?.key !== key) {
        if (this.active) {
          this.active = null;
          await channel.request('release');
        }
        const nativeInfo = await channel.request('open', { path: current.id, expectedDiskIds: current.diskIds });
        this.ensureRunning();
        this.active = { key, nativeInfo };
      }
      const nativeInfo = this.active.nativeInfo;
      const assertion = verify ? await channel.request('assert') : null;
      if (!nativeInfo || typeof nativeInfo.identity !== 'string' || !nativeInfo.identity
          || (verify && (assertion?.unchanged !== true || assertion.identity !== nativeInfo.identity))
          || (expectedNative && nativeInfo.identity !== expectedNative.identity)) {
        throw new WindowsDeviceError('DEVICE_CHANGED', 'The opened Windows volume identity changed.');
      }
      return nativeInfo;
    } catch (error) {
      await this.clearStaleHandle(channel, error);
      throw error;
    }
  }

  async clearStaleHandle(channel, error) {
    if (this.channel !== channel || !['DEVICE_CHANGED', 'NOT_OPEN'].includes(error.code)) return;
    this.active = null;
    try { await channel.request('release'); } catch { /* Preserve the source error; a dead channel is retired by serialize. */ }
  }

  async prepareOpen(device, { owner } = {}) {
    this.ensureRunning();
    const boundOwner = preparedOwner(owner);
    const current = await validateListedDevice(device, () => this.inventory({ signal: this.controller.signal }));
    this.ensureRunning();
    // A newly requested search may reconnect an already disconnected helper.
    // Mint against the new generation rather than forcing an extra user retry.
    if (this.channel?.closed) this.retire(true);
    const token = Object.freeze({});
    preparedOpens.set(token, { session: this, owner: boundOwner, current: clonePreparedDevice(current),
      createdAt: this.now(), generation: this.generation });
    return token;
  }

  revokePreparedOpen(token) {
    if (token && (typeof token === 'object' || typeof token === 'function')) preparedOpens.delete(token);
  }

  consumePreparedOpen(device, token, owner) {
    if (!token || (typeof token !== 'object' && typeof token !== 'function')) {
      throw new WindowsDeviceError('PREPARED_OPEN_INVALID', 'The prepared volume open is invalid or already used.');
    }
    const prepared = preparedOpens.get(token);
    // Delete before checking any property so a supplied token is one-shot even
    // when its owner, source, session, or age is wrong.
    preparedOpens.delete(token);
    if (!prepared || prepared.session !== this) {
      throw new WindowsDeviceError('PREPARED_OPEN_INVALID', 'The prepared volume open is invalid or already used.');
    }
    if (prepared.owner !== preparedOwner(owner)) {
      throw new WindowsDeviceError('PREPARED_OPEN_OWNER', 'The prepared volume open belongs to another job.');
    }
    if (!device || typeof device !== 'object' || typeof device.id !== 'string' || typeof device.identity !== 'string' || !sameDevice(prepared.current, device)) {
      throw new WindowsDeviceError('PREPARED_OPEN_SOURCE', 'The prepared volume open does not match the selected source.');
    }
    if (prepared.generation !== this.generation) {
      throw new WindowsDeviceError('PREPARED_OPEN_INVALID', 'The prepared volume open belongs to an older session.');
    }
    return prepared;
  }

  preparedExpired(prepared) {
    return this.now() - prepared.createdAt >= this.preparedOpenTtlMs;
  }

  async open(device, { elevate = false, onPermission = () => {}, preparedOpen, owner } = {}) {
    this.ensureRunning();
    const batch = this.openBatch ?? (this.openBatch = { pending: 0, failure: null });
    batch.pending++;
    try {
      const prepared = preparedOpen === undefined ? null : this.consumePreparedOpen(device, preparedOpen, owner);
      // An expired token is still source/owner-bound, but it cannot avoid the
      // current inventory check.  Delay that check until the serialized open so
      // a token expiring while queued is treated the same way.
      const initial = prepared?.current ?? await validateListedDevice(device, () => this.inventory({ signal: this.controller.signal }));
      return await this.serialize(async () => {
        this.ensureRunning();
        if (batch.failure) throw batch.failure;
        if (this.channel?.closed) this.retire(true);
        let current = initial;
        if (prepared) {
          if (prepared.generation !== this.generation) {
            throw new WindowsDeviceError('PREPARED_OPEN_INVALID', 'The prepared volume open belongs to an older session.');
          }
          if (this.preparedExpired(prepared)) current = await validateListedDevice(device, () => this.inventory({ signal: this.controller.signal }));
        }
        if (!this.channel) await this.start(false, onPermission, batch);
        let nativeInfo;
        try { nativeInfo = await this.select(current); }
        catch (error) {
          if (error.code !== 'NEEDS_ADMIN' || this.elevated) throw error;
          // An explicitly authorized foreground open may upgrade the connection.
          // Existing leases retain their expected identity across this upgrade.
          this.retire(false);
          if (elevate !== true) throw error;
          await this.start(true, onPermission, batch);
          nativeInfo = await this.select(current);
        }
        this.ensureRunning();
        const lease = { current, nativeInfo, generation: this.generation, closed: false };
        return volumeProvider(current, nativeInfo, {
          request: (command, fields, timeout) => this.request(lease, command, fields, timeout),
          destroy: () => { lease.closed = true; }
        });
      });
    } finally {
      if (--batch.pending === 0 && this.openBatch === batch) this.openBatch = null;
    }
  }

  request(lease, command, fields, timeout) {
    return this.serialize(async () => {
      if (command === 'close') {
        if (lease.closed) return { closed: true };
        lease.closed = true;
        const key = volumeLeaseKey(lease.current);
        if (!this.disposed && lease.generation === this.generation && this.channel && !this.channel.closed && this.active?.key === key) {
          this.active = null;
          await this.channel.request('release');
        }
        return { closed: true };
      }
      this.ensureRunning();
      if (lease.closed || lease.generation !== this.generation || !this.channel || this.channel.closed)
        throw new WindowsDeviceError('HELPER_CLOSED', 'The volume helper disconnected. Start a new search to reconnect.');
      // read/queryJournal/readJournal already assert inside the native helper;
      // the provider's assert command also verifies the response identity.
      const channel = this.channel;
      await this.select(lease.current, lease.nativeInfo, false);
      try { return await channel.request(command, fields, timeout); }
      catch (error) {
        await this.clearStaleHandle(channel, error);
        throw error;
      }
    });
  }

  async dispose() {
    if (!this.disposed) {
      this.disposed = true;
      this.controller.abort();
      // Closing the pipe makes the native process release its handle and exit.
      // Do this immediately so an in-flight read cannot hold application shutdown.
      this.retire(true);
    }
    await this.queue;
  }
}
