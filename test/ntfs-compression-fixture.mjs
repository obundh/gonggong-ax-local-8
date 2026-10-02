import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  createFixture,
  fixtureGeometry as geometry,
  fixturePrimitives,
} from './ntfs-fixtures.mjs';

const RECORD_NUMBER = 37;
const COMPRESSION_CLUSTERS = 16;
const UNIT_SIZE = COMPRESSION_CLUSTERS * geometry.clusterSize;
const FIRST_DATA_LCN = 100;

export const compressionFixtureScenarios = Object.freeze([
  'full-native',
  'partial-eof',
  'short-native',
  'uninitialized-poison',
  'sparse-unit',
  'raw-unit',
  'multi-unit',
  'bad-logical-allocation',
  'bad-physical-total',
  'short-decode',
  'malformed-decode',
]);

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function align8(value) {
  return (value + 7) & ~7;
}

function patterned(length, seed) {
  const result = Buffer.alloc(length);
  for (let index = 0; index < length; index += 1) {
    const block = Math.floor(index / 4096);
    result[index] = (seed + block * 11 + (index % 29)) & 0xff;
  }
  return result;
}

function deterministicNoise(length) {
  const result = Buffer.alloc(length);
  let state = 0x51f15e5d;
  for (let index = 0; index < length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    result[index] = state & 0xff;
  }
  return result;
}

export function nativeCompressionSources() {
  const poison = patterned(UNIT_SIZE, 0x31);
  poison.fill(0xe7, 28_000);
  return Object.freeze({
    full: patterned(UNIT_SIZE, 0x41),
    second: patterned(UNIT_SIZE, 0x73),
    short: patterned(19_333, 0x22),
    poison,
    tooShort: patterned(8_192, 0x5a),
  });
}

export function createNativeCompressionBodies(sources = nativeCompressionSources()) {
  assert.equal(process.platform, 'win32', 'native LZNT1 fixtures require Windows');
  const names = Object.keys(sources);
  const request = names.map(name => Buffer.from(sources[name]).toString('base64'));
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class RecoveryChatCompressionFixtureNative {
  [DllImport("ntdll.dll")]
  public static extern int RtlGetCompressionWorkSpaceSize(ushort format, out uint compress, out uint fragment);
  [DllImport("ntdll.dll")]
  public static extern int RtlCompressBuffer(ushort format, byte[] source, uint sourceSize, byte[] destination, uint destinationSize, uint chunkSize, out uint finalSize, IntPtr workspace);
  public static string Compress(byte[] source) {
    uint workspaceSize, fragmentSize, finalSize;
    int status = RtlGetCompressionWorkSpaceSize(2, out workspaceSize, out fragmentSize);
    if (status != 0) throw new InvalidOperationException("RtlGetCompressionWorkSpaceSize failed: " + status);
    IntPtr workspace = Marshal.AllocHGlobal((int)workspaceSize);
    try {
      var destination = new byte[source.Length * 2 + 4096];
      status = RtlCompressBuffer(2, source, (uint)source.Length, destination, (uint)destination.Length, 4096, out finalSize, workspace);
      if (status != 0) throw new InvalidOperationException("RtlCompressBuffer failed: " + status);
      return Convert.ToBase64String(destination, 0, (int)finalSize);
    } finally { Marshal.FreeHGlobal(workspace); }
  }
}
"@
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$result = @($request | ForEach-Object { [RecoveryChatCompressionFixtureNative]::Compress([Convert]::FromBase64String([string]$_)) })
[Console]::Out.Write('__RECOVERYCHAT_LZNT1__' + ($result | ConvertTo-Json -Compress))
`;
  const executable = path.join(
    process.env.SystemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const result = spawnSync(
    executable,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    {
      encoding: 'utf8',
      input: JSON.stringify(request),
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
  const marker = '__RECOVERYCHAT_LZNT1__';
  const markerAt = result.stdout.indexOf(marker);
  assert.ok(markerAt >= 0, `native compressed bytes missing: ${result.stdout}`);
  const encodedBodies = JSON.parse(result.stdout.slice(markerAt + marker.length));
  assert.equal(encodedBodies.length, names.length);
  return Object.freeze(Object.fromEntries(
    names.map((name, index) => [name, Buffer.from(encodedBodies[index], 'base64')]),
  ));
}

function unsignedLittleEndian(value) {
  let encoded = BigInt(value);
  let size = 1;
  while (encoded >= (1n << BigInt(size * 8))) size += 1;
  const result = Buffer.alloc(size);
  for (let index = 0; index < size; index += 1) {
    result[index] = Number(encoded & 0xffn);
    encoded >>= 8n;
  }
  return result;
}

function signedLittleEndian(value) {
  let size = 1;
  while (size < 8) {
    const limit = 2 ** (size * 8 - 1);
    if (value >= -limit && value < limit) break;
    size += 1;
  }
  let encoded = BigInt(value);
  if (encoded < 0) encoded += 1n << BigInt(size * 8);
  const result = Buffer.alloc(size);
  for (let index = 0; index < size; index += 1) {
    result[index] = Number(encoded & 0xffn);
    encoded >>= 8n;
  }
  return result;
}

function encodeRuns(runs) {
  const parts = [];
  let previousLcn = 0;
  for (const run of runs) {
    const count = unsignedLittleEndian(run.clusters);
    if (run.lcn == null) {
      parts.push(Buffer.from([count.length]), count);
      continue;
    }
    const delta = signedLittleEndian(run.lcn - previousLcn);
    parts.push(Buffer.from([(delta.length << 4) | count.length]), count, delta);
    previousLcn = run.lcn;
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

function compressedDataAttribute({ runs, logicalSize, initializedSize, allocatedSize, physicalSize }) {
  const runlist = encodeRuns(runs);
  const length = align8(72 + runlist.length);
  const attribute = Buffer.alloc(length);
  const clusters = runs.reduce((sum, run) => sum + run.clusters, 0);
  attribute.writeUInt32LE(0x80, 0);
  attribute.writeUInt32LE(length, 4);
  attribute[8] = 1;
  attribute.writeUInt16LE(0x0001, 12);
  attribute.writeUInt16LE(2, 14);
  attribute.writeBigUInt64LE(0n, 16);
  attribute.writeBigUInt64LE(BigInt(clusters - 1), 24);
  attribute.writeUInt16LE(72, 32);
  attribute.writeUInt16LE(4, 34);
  attribute.writeBigUInt64LE(BigInt(allocatedSize), 40);
  attribute.writeBigUInt64LE(BigInt(logicalSize), 48);
  attribute.writeBigUInt64LE(BigInt(initializedSize), 56);
  attribute.writeBigUInt64LE(BigInt(physicalSize), 64);
  runlist.copy(attribute, 72);
  return attribute;
}

function addRun(runs, run) {
  const previous = runs.at(-1);
  if (previous && previous.lcn == null && run.lcn == null) {
    previous.clusters += run.clusters;
  } else if (previous && previous.lcn != null && run.lcn != null
    && previous.lcn + previous.clusters === run.lcn) {
    previous.clusters += run.clusters;
  } else {
    runs.push({ ...run });
  }
}

function buildLayout(image, units) {
  const runs = [];
  const physicalRanges = [];
  let nextLcn = FIRST_DATA_LCN;
  for (const unit of units) {
    if (unit.kind === 'zero') {
      addRun(runs, { lcn: null, clusters: COMPRESSION_CLUSTERS });
      continue;
    }
    const stored = unit.kind === 'raw' ? unit.bytes : unit.packed;
    const clusters = unit.kind === 'raw'
      ? COMPRESSION_CLUSTERS
      : Math.ceil(stored.length / geometry.clusterSize);
    assert.ok(clusters >= 1 && clusters <= COMPRESSION_CLUSTERS);
    if (unit.kind === 'compressed') assert.ok(clusters < COMPRESSION_CLUSTERS);
    const offset = nextLcn * geometry.clusterSize;
    stored.copy(image, offset);
    physicalRanges.push({ lcn: nextLcn, clusters, storedBytes: stored.length, kind: unit.kind });
    addRun(runs, { lcn: nextLcn, clusters });
    if (clusters < COMPRESSION_CLUSTERS) {
      addRun(runs, { lcn: null, clusters: COMPRESSION_CLUSTERS - clusters });
    }
    nextLcn += clusters + 3;
  }
  return { runs, physicalRanges };
}

function scenarioDefinition(scenario, nativeBodies, sources) {
  const compressed = (sourceName, packed = nativeBodies[sourceName]) => ({
    kind: 'compressed',
    bytes: sources[sourceName],
    packed,
  });
  const full = sources.full;
  switch (scenario) {
    case 'full-native':
      return { units: [compressed('full')], logicalSize: UNIT_SIZE, initializedSize: UNIT_SIZE, expectedBytes: full };
    case 'partial-eof': {
      const logicalSize = 25_317;
      return { units: [compressed('full')], logicalSize, initializedSize: logicalSize, expectedBytes: full.subarray(0, logicalSize) };
    }
    case 'short-native':
      return { units: [compressed('short')], logicalSize: sources.short.length, initializedSize: sources.short.length, expectedBytes: sources.short };
    case 'uninitialized-poison': {
      const logicalSize = 40_000;
      const initializedSize = 28_000;
      return {
        units: [compressed('poison')],
        logicalSize,
        initializedSize,
        expectedBytes: Buffer.concat([
          sources.poison.subarray(0, initializedSize),
          Buffer.alloc(logicalSize - initializedSize),
        ]),
      };
    }
    case 'sparse-unit': {
      const logicalSize = 45_123;
      return { units: [{ kind: 'zero' }], logicalSize, initializedSize: logicalSize, expectedBytes: Buffer.alloc(logicalSize) };
    }
    case 'raw-unit': {
      const raw = deterministicNoise(UNIT_SIZE);
      return { units: [{ kind: 'raw', bytes: raw }], logicalSize: UNIT_SIZE, initializedSize: UNIT_SIZE, expectedBytes: raw };
    }
    case 'multi-unit': {
      const secondLength = 12_345;
      return {
        units: [compressed('full'), compressed('second')],
        logicalSize: UNIT_SIZE + secondLength,
        initializedSize: UNIT_SIZE + secondLength,
        expectedBytes: Buffer.concat([full, sources.second.subarray(0, secondLength)]),
      };
    }
    case 'bad-logical-allocation':
      return { units: [compressed('full')], logicalSize: UNIT_SIZE, initializedSize: UNIT_SIZE, expectedBytes: full, allocatedDelta: -geometry.clusterSize };
    case 'bad-physical-total':
      return { units: [compressed('full')], logicalSize: UNIT_SIZE, initializedSize: UNIT_SIZE, expectedBytes: full, physicalDelta: geometry.clusterSize };
    case 'short-decode':
      return { units: [compressed('tooShort')], logicalSize: 12_000, initializedSize: 12_000, expectedBytes: null };
    case 'malformed-decode': {
      const malformed = Buffer.from(nativeBodies.full);
      malformed[1] = (malformed[1] & 0x0f) | 0x20;
      return { units: [compressed('full', malformed)], logicalSize: UNIT_SIZE, initializedSize: UNIT_SIZE, expectedBytes: null };
    }
    default:
      throw new RangeError(`unknown compression fixture scenario: ${scenario}`);
  }
}

function markRecordCompressed(record) {
  const standard = record.readUInt16LE(20);
  assert.equal(record.readUInt32LE(standard), 0x10);
  const value = standard + record.readUInt16LE(standard + 20);
  record.writeUInt32LE(record.readUInt32LE(value + 32) | 0x800, value + 32);
}

function baseImageSource(base) {
  if (Buffer.isBuffer(base)) return Promise.resolve(Buffer.from(base));
  if (base?.imagePath) return readFile(base.imagePath);
  return null;
}

/**
 * Build a synthetic image owned by `directory`. `base` may be either the
 * Buffer read from createFixture() or createFixture()'s returned object.
 */
export async function createNtfsCompressionFixture(directory, {
  scenario = 'full-native',
  base,
  nativeBodies,
} = {}) {
  assert.ok(compressionFixtureScenarios.includes(scenario), `unsupported scenario: ${scenario}`);
  const fixtureDirectory = path.resolve(directory);
  await mkdir(fixtureDirectory, { recursive: true });
  let original = baseImageSource(base);
  let baseFixture = base?.imagePath ? base : null;
  if (!original) {
    baseFixture = await createFixture(path.join(fixtureDirectory, 'base'));
    original = readFile(baseFixture.imagePath);
  }
  const baseBytes = await original;
  const sourceImageSHA = sha256(baseBytes);
  const sources = nativeCompressionSources();
  const bodies = nativeBodies ?? createNativeCompressionBodies(sources);
  const definition = scenarioDefinition(scenario, bodies, sources);
  const image = Buffer.from(baseBytes);
  const { runs, physicalRanges } = buildLayout(image, definition.units);
  const logicalCapacity = definition.units.length * UNIT_SIZE;
  const physicalCapacity = physicalRanges.reduce(
    (sum, range) => sum + range.clusters * geometry.clusterSize,
    0,
  );
  const attribute = compressedDataAttribute({
    runs,
    logicalSize: definition.logicalSize,
    initializedSize: definition.initializedSize,
    allocatedSize: logicalCapacity + (definition.allocatedDelta ?? 0),
    physicalSize: physicalCapacity + (definition.physicalDelta ?? 0),
  });
  const record = fixturePrimitives.makeFileRecord({
    recordNumber: RECORD_NUMBER,
    sequence: 2,
    name: `${scenario}.bin`,
    attributes: [attribute],
  });
  markRecordCompressed(record);
  const recordOffset = geometry.mftLcn * geometry.clusterSize + RECORD_NUMBER * geometry.fileRecordSize;
  record.copy(image, recordOffset);

  const imagePath = path.join(fixtureDirectory, `${scenario}.img`);
  await writeFile(imagePath, image, { flag: 'wx' });
  const expectedBytes = definition.expectedBytes == null ? null : Buffer.from(definition.expectedBytes);
  return Object.freeze({
    scenario,
    fixtureDirectory,
    imagePath,
    baseFixture,
    recordNumber: RECORD_NUMBER,
    logicalSize: definition.logicalSize,
    initializedSize: definition.initializedSize,
    expectedBytes,
    expectedSHA: expectedBytes == null ? null : sha256(expectedBytes),
    sourceImageSHA,
    imageSHA: sha256(image),
    logicalAllocatedSize: logicalCapacity + (definition.allocatedDelta ?? 0),
    physicalAllocatedSize: physicalCapacity + (definition.physicalDelta ?? 0),
    physicalRanges: Object.freeze(physicalRanges.map(range => Object.freeze({ ...range }))),
  });
}
