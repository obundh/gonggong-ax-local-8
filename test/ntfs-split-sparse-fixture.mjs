import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  createFixture,
  fixtureGeometry as geometry,
  fixturePrimitives,
} from './ntfs-fixtures.mjs';

const ATTRIBUTE = Object.freeze({
  STANDARD_INFORMATION: 0x10,
  ATTRIBUTE_LIST: 0x20,
  FILE_NAME: 0x30,
  DATA: 0x80,
});

const BASE_RECORD = 36;
const BASE_SEQUENCE = 2;
const EXTENSION_RECORDS = Object.freeze([43, 44]);
const EXTENSION_SEQUENCES = Object.freeze([7, 8]);
const BASE_DATA_ID = 3;
const EXTENSION_DATA_IDS = Object.freeze([4, 5]);
const FIRST_DATA_LCN = 60;

export const splitSparseFixtureScenarios = Object.freeze([
  'compact',
  'extended',
  'all-sparse-extension',
  'multi-extension-uninitialized',
  'compressed',
  'flag-mismatch',
  'owner-mismatch',
  'generation-mismatch',
  'attribute-id-mismatch',
  'vcn-gap',
  'vcn-overlap',
  'physical-overlap',
  'base-wrong-size',
  'continuation-wrong-size',
  'continuation-unit',
  'extended-physical-size',
  'base-flag-mismatch',
  'missing-file-sparse-flag',
  'named-stream',
]);

const validScenarios = new Set([
  'compact',
  'extended',
  'all-sparse-extension',
  'multi-extension-uninitialized',
]);

function align8(value) {
  return (value + 7) & ~7;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function fileReference(recordNumber, sequence) {
  return BigInt(recordNumber) | (BigInt(sequence) << 48n);
}

function recordOffset(recordNumber) {
  return geometry.mftLcn * geometry.clusterSize + recordNumber * geometry.fileRecordSize;
}

function unsignedLittleEndian(value) {
  let encoded = BigInt(value);
  assert.ok(encoded > 0n);
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
    const minimum = -(2 ** (size * 8 - 1));
    const maximum = 2 ** (size * 8 - 1) - 1;
    if (value >= minimum && value <= maximum) break;
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

function mappingPairs(runs) {
  const parts = [];
  let previousLcn = 0;
  for (const run of runs) {
    const count = unsignedLittleEndian(run.clusters);
    if (run.lcn == null) {
      parts.push(Buffer.from([count.length]), count);
      continue;
    }
    const relative = signedLittleEndian(run.lcn - previousLcn);
    parts.push(Buffer.from([(relative.length << 4) | count.length]), count, relative);
    previousLcn = run.lcn;
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

// Kept independent from fixturePrimitives so the split-record metadata is
// explicit in this fixture instead of inheriting the single-extent defaults.
function residentAttribute(type, value, id, { name = '', flags = 0 } = {}) {
  const encodedName = Buffer.from(name, 'utf16le');
  const nameOffset = encodedName.length ? 24 : 0;
  const valueOffset = align8(24 + encodedName.length);
  const length = align8(valueOffset + value.length);
  const attribute = Buffer.alloc(length);
  attribute.writeUInt32LE(type, 0);
  attribute.writeUInt32LE(length, 4);
  attribute[9] = encodedName.length / 2;
  attribute.writeUInt16LE(nameOffset, 10);
  attribute.writeUInt16LE(flags, 12);
  attribute.writeUInt16LE(id, 14);
  attribute.writeUInt32LE(value.length, 16);
  attribute.writeUInt16LE(valueOffset, 20);
  if (encodedName.length) encodedName.copy(attribute, nameOffset);
  value.copy(attribute, valueOffset);
  return attribute;
}

function nonresidentData({
  id,
  firstVcn,
  runs,
  flags,
  compressionUnit,
  headerSize,
  allocatedSize,
  dataSize,
  initializedSize,
  physicalSize,
}) {
  const pairs = mappingPairs(runs);
  const length = align8(headerSize + pairs.length);
  const attribute = Buffer.alloc(length);
  const clusterCount = runs.reduce((sum, run) => sum + run.clusters, 0);
  attribute.writeUInt32LE(ATTRIBUTE.DATA, 0);
  attribute.writeUInt32LE(length, 4);
  attribute[8] = 1;
  attribute.writeUInt16LE(flags, 12);
  attribute.writeUInt16LE(id, 14);
  attribute.writeBigUInt64LE(BigInt(firstVcn), 16);
  attribute.writeBigUInt64LE(BigInt(firstVcn + clusterCount - 1), 24);
  attribute.writeUInt16LE(headerSize, 32);
  attribute.writeUInt16LE(compressionUnit, 34);
  attribute.writeBigUInt64LE(BigInt(allocatedSize), 40);
  attribute.writeBigUInt64LE(BigInt(dataSize), 48);
  attribute.writeBigUInt64LE(BigInt(initializedSize), 56);
  if (headerSize === 72) attribute.writeBigUInt64LE(BigInt(physicalSize), 64);
  pairs.copy(attribute, headerSize);
  return attribute;
}

function attributeListEntry(type, lowestVcn, recordNumber, sequence, attributeId) {
  const entry = Buffer.alloc(32);
  entry.writeUInt32LE(type, 0);
  entry.writeUInt16LE(entry.length, 4);
  entry.writeBigUInt64LE(BigInt(lowestVcn), 8);
  entry.writeBigUInt64LE(fileReference(recordNumber, sequence), 16);
  entry.writeUInt16LE(attributeId, 24);
  return entry;
}

function extensionRecord({ recordNumber, sequence, baseReference, attribute }) {
  const record = Buffer.alloc(geometry.fileRecordSize);
  const usaOffset = 0x30;
  const firstAttributeOffset = 0x38;
  record.write('FILE', 0, 4, 'ascii');
  record.writeUInt16LE(usaOffset, 4);
  record.writeUInt16LE(3, 6);
  record.writeUInt16LE(sequence, 16);
  record.writeUInt16LE(1, 18);
  record.writeUInt16LE(firstAttributeOffset, 20);
  record.writeUInt16LE(0, 22);
  record.writeUInt32LE(geometry.fileRecordSize, 28);
  record.writeBigUInt64LE(baseReference, 32);
  record.writeUInt16LE(2, 40);
  record.writeUInt32LE(recordNumber, 44);
  attribute.copy(record, firstAttributeOffset);
  const terminator = firstAttributeOffset + attribute.length;
  assert.ok(terminator + 8 <= record.length - 2);
  record.writeUInt32LE(0xffffffff, terminator);
  record.writeUInt32LE(terminator + 4, 24);

  const updateSequence = 0xd000 + recordNumber;
  record.writeUInt16LE(updateSequence, usaOffset);
  record.writeUInt16LE(record.readUInt16LE(510), usaOffset + 2);
  record.writeUInt16LE(record.readUInt16LE(1022), usaOffset + 4);
  record.writeUInt16LE(updateSequence, 510);
  record.writeUInt16LE(updateSequence, 1022);
  return record;
}

function attributeOffset(record, type) {
  let cursor = record.readUInt16LE(20);
  while (cursor + 8 <= record.length) {
    const found = record.readUInt32LE(cursor);
    assert.notEqual(found, 0xffffffff, `attribute ${type.toString(16)} must exist`);
    if (found === type) return cursor;
    const length = record.readUInt32LE(cursor + 4);
    assert.ok(length >= 24);
    cursor += length;
  }
  assert.fail(`attribute ${type.toString(16)} not found`);
}

function setSparseFileFlag(record, enabled) {
  const standard = attributeOffset(record, ATTRIBUTE.STANDARD_INFORMATION);
  const value = standard + record.readUInt16LE(standard + 20);
  const current = record.readUInt32LE(value + 32);
  record.writeUInt32LE(enabled ? current | 0x200 : current & ~0x200, value + 32);
}

function deterministicCluster(lcn) {
  const bytes = Buffer.alloc(geometry.clusterSize);
  let state = (0x9e3779b9 ^ (lcn * 0x45d9f3b)) >>> 0;
  for (let index = 0; index < bytes.length; index += 1) {
    state = (Math.imul(state ^ (state >>> 16), 0x45d9f3b) + index + 17) >>> 0;
    bytes[index] = (state ^ (state >>> 11) ^ lcn) & 0xff;
  }
  return bytes;
}

function normalLayout(scenario) {
  if (scenario === 'all-sparse-extension') {
    return [
      [{ lcn: FIRST_DATA_LCN, clusters: 1 }, { lcn: null, clusters: 2 }],
      [{ lcn: null, clusters: 3 }],
    ];
  }
  if (scenario === 'multi-extension-uninitialized') {
    return [
      [{ lcn: FIRST_DATA_LCN, clusters: 1 }, { lcn: null, clusters: 2 }],
      [{ lcn: null, clusters: 1 }, { lcn: FIRST_DATA_LCN + 2, clusters: 2 }],
      [{ lcn: null, clusters: 1 }, { lcn: FIRST_DATA_LCN + 5, clusters: 1 }, { lcn: null, clusters: 1 }],
    ];
  }
  return [
    [{ lcn: FIRST_DATA_LCN, clusters: 1 }, { lcn: null, clusters: 2 }],
    [{ lcn: null, clusters: 1 }, { lcn: FIRST_DATA_LCN + 2, clusters: 2 }],
  ];
}

function scenarioDefinition(scenario) {
  const intended = scenario === 'extended-physical-size' ? 'extended'
    : validScenarios.has(scenario) ? scenario : 'compact';
  const segments = normalLayout(intended).map(runs => runs.map(run => ({ ...run })));
  const extended = intended === 'extended';
  const capacity = segments.flat().reduce((sum, run) => sum + run.clusters, 0) * geometry.clusterSize;
  let logicalSize = capacity - 1_139;
  let initializedSize = logicalSize;
  if (intended === 'all-sparse-extension') logicalSize = capacity - 777;
  if (intended === 'multi-extension-uninitialized') {
    logicalSize = capacity - 991;
    initializedSize = 7 * geometry.clusterSize + 333;
  }

  const definition = {
    intended,
    segments,
    extended,
    logicalSize,
    initializedSize,
    baseFlags: 0x8000,
    continuationFlags: 0x8000,
    baseCompressionUnit: extended ? 4 : 0,
    continuationCompressionUnit: 0,
    sparseFileFlag: true,
    baseAllocatedDelta: 0,
    physicalSizeDelta: 0,
    continuationDataSize: 0,
    ownerRecord: BASE_RECORD,
    listedSequenceDelta: 0,
    listedAttributeIdDelta: 0,
    addNamedStream: false,
  };

  switch (scenario) {
    case 'compressed': definition.baseFlags = 0x0001; break;
    case 'flag-mismatch': definition.continuationFlags = 0; break;
    case 'owner-mismatch': definition.ownerRecord = BASE_RECORD - 1; break;
    case 'generation-mismatch': definition.listedSequenceDelta = 1; break;
    case 'attribute-id-mismatch': definition.listedAttributeIdDelta = 1; break;
    case 'vcn-gap': definition.extensionFirstVcnDelta = 1; break;
    case 'vcn-overlap': definition.extensionFirstVcnDelta = -1; break;
    case 'physical-overlap': {
      const firstPhysical = definition.segments[1].find(run => run.lcn != null);
      firstPhysical.lcn = FIRST_DATA_LCN;
      break;
    }
    case 'base-wrong-size': definition.baseAllocatedDelta = geometry.clusterSize; break;
    case 'continuation-wrong-size': definition.continuationDataSize = 1; break;
    case 'continuation-unit': definition.continuationCompressionUnit = 4; break;
    case 'extended-physical-size': definition.physicalSizeDelta = geometry.clusterSize; break;
    case 'base-flag-mismatch': definition.baseFlags = 0; break;
    case 'missing-file-sparse-flag': definition.sparseFileFlag = false; break;
    case 'named-stream': definition.addNamedStream = true; break;
    default: break;
  }
  return definition;
}

function physicalRangesOf(segments) {
  const ranges = [];
  let firstVcn = 0;
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    let vcn = firstVcn;
    for (const run of segments[segmentIndex]) {
      if (run.lcn != null) {
        ranges.push({
          segmentIndex,
          firstVcn: vcn,
          lcn: run.lcn,
          clusters: run.clusters,
          offset: run.lcn * geometry.clusterSize,
          length: run.clusters * geometry.clusterSize,
        });
      }
      vcn += run.clusters;
    }
    firstVcn = vcn;
  }
  return ranges;
}

function expectedFromLayout(image, segments, logicalSize, initializedSize) {
  const capacity = segments.flat().reduce((sum, run) => sum + run.clusters, 0) * geometry.clusterSize;
  const logical = Buffer.alloc(capacity);
  let logicalOffset = 0;
  for (const run of segments.flat()) {
    const length = run.clusters * geometry.clusterSize;
    if (run.lcn != null) image.copy(logical, logicalOffset, run.lcn * geometry.clusterSize, run.lcn * geometry.clusterSize + length);
    logicalOffset += length;
  }
  logical.fill(0, initializedSize, logicalSize);
  return Buffer.from(logical.subarray(0, logicalSize));
}

function baseImageSource(base) {
  if (Buffer.isBuffer(base)) return Promise.resolve(Buffer.from(base));
  if (base?.imagePath) return readFile(base.imagePath);
  return null;
}

export async function createSplitSparseFixture(directory, { scenario = 'compact', base } = {}) {
  assert.ok(splitSparseFixtureScenarios.includes(scenario), `unsupported split sparse fixture scenario: ${scenario}`);
  const fixtureDirectory = path.resolve(directory);
  await mkdir(fixtureDirectory, { recursive: true });
  let source = baseImageSource(base);
  let baseFixture = base?.imagePath ? base : null;
  if (!source) {
    baseFixture = await createFixture(path.join(fixtureDirectory, 'base'));
    source = readFile(baseFixture.imagePath);
  }
  const sourceBytes = await source;
  const sourceImageSHA = sha256(sourceBytes);
  const image = Buffer.from(sourceBytes);
  const definition = scenarioDefinition(scenario);
  const extensionCount = definition.segments.length - 1;
  const extensionRecordNumbers = EXTENSION_RECORDS.slice(0, extensionCount);
  const physicalRanges = physicalRangesOf(definition.segments);
  const physicalBytes = physicalRanges.reduce((sum, range) => sum + range.length, 0);
  const logicalCapacity = definition.segments.flat().reduce((sum, run) => sum + run.clusters, 0) * geometry.clusterSize;

  for (const range of physicalRanges) {
    for (let cluster = 0; cluster < range.clusters; cluster += 1) {
      deterministicCluster(range.lcn + cluster).copy(image, (range.lcn + cluster) * geometry.clusterSize);
    }
  }

  const firstVcns = [];
  let nextVcn = 0;
  for (const runs of definition.segments) {
    firstVcns.push(nextVcn);
    nextVcn += runs.reduce((sum, run) => sum + run.clusters, 0);
  }
  if (definition.extensionFirstVcnDelta) firstVcns[1] += definition.extensionFirstVcnDelta;

  const listEntries = [
    attributeListEntry(ATTRIBUTE.STANDARD_INFORMATION, 0, BASE_RECORD, BASE_SEQUENCE, 0),
    attributeListEntry(ATTRIBUTE.FILE_NAME, 0, BASE_RECORD, BASE_SEQUENCE, 1),
    attributeListEntry(ATTRIBUTE.DATA, 0, BASE_RECORD, BASE_SEQUENCE, BASE_DATA_ID),
  ];
  for (let index = 0; index < extensionCount; index += 1) {
    listEntries.push(attributeListEntry(
      ATTRIBUTE.DATA,
      firstVcns[index + 1],
      extensionRecordNumbers[index],
      EXTENSION_SEQUENCES[index] + (index === 0 ? definition.listedSequenceDelta : 0),
      EXTENSION_DATA_IDS[index] + (index === 0 ? definition.listedAttributeIdDelta : 0),
    ));
  }

  const baseHeaderSize = definition.extended || definition.baseFlags === 0x0001 ? 72 : 64;
  const baseAllocated = (definition.extended ? logicalCapacity : physicalBytes) + definition.baseAllocatedDelta;
  const baseData = nonresidentData({
    id: BASE_DATA_ID,
    firstVcn: 0,
    runs: definition.segments[0],
    flags: definition.baseFlags,
    compressionUnit: definition.baseFlags === 0x0001 ? 4 : definition.baseCompressionUnit,
    headerSize: baseHeaderSize,
    allocatedSize: baseAllocated,
    dataSize: definition.logicalSize,
    initializedSize: definition.initializedSize,
    physicalSize: physicalBytes + definition.physicalSizeDelta,
  });
  const baseAttributes = [
    residentAttribute(ATTRIBUTE.ATTRIBUTE_LIST, Buffer.concat(listEntries), 2),
    baseData,
  ];
  if (definition.addNamedStream) {
    baseAttributes.push(residentAttribute(ATTRIBUTE.DATA, Buffer.from('alternate'), 6, { name: 'secret' }));
  }
  const baseRecord = fixturePrimitives.makeFileRecord({
    recordNumber: BASE_RECORD,
    sequence: BASE_SEQUENCE,
    name: `split-sparse-${scenario}.bin`,
    attributes: baseAttributes,
  });
  setSparseFileFlag(baseRecord, definition.sparseFileFlag);
  baseRecord.copy(image, recordOffset(BASE_RECORD));

  for (let index = 0; index < extensionCount; index += 1) {
    const runs = definition.segments[index + 1];
    const data = nonresidentData({
      id: EXTENSION_DATA_IDS[index],
      firstVcn: firstVcns[index + 1],
      runs,
      flags: definition.continuationFlags,
      compressionUnit: index === 0 ? definition.continuationCompressionUnit : 0,
      headerSize: 64,
      allocatedSize: 0,
      dataSize: index === 0 ? definition.continuationDataSize : 0,
      initializedSize: 0,
      physicalSize: 0,
    });
    const record = extensionRecord({
      recordNumber: extensionRecordNumbers[index],
      sequence: EXTENSION_SEQUENCES[index],
      baseReference: fileReference(definition.ownerRecord, BASE_SEQUENCE),
      attribute: data,
    });
    record.copy(image, recordOffset(extensionRecordNumbers[index]));
  }

  const expectedBytes = expectedFromLayout(
    image,
    definition.segments,
    definition.logicalSize,
    definition.initializedSize,
  );
  const imagePath = path.join(fixtureDirectory, `${scenario}.img`);
  await writeFile(imagePath, image, { flag: 'wx' });
  return Object.freeze({
    scenario,
    fixtureDirectory,
    imagePath,
    baseFixture,
    recordNumber: BASE_RECORD,
    expectedBytes,
    expectedSHA: sha256(expectedBytes),
    imageSHA: sha256(image),
    sourceImageSHA,
    logicalSize: definition.logicalSize,
    initializedSize: definition.initializedSize,
    compression: definition.baseCompressionUnit,
    extensionRecordNumbers: Object.freeze([...extensionRecordNumbers]),
    physicalRanges: Object.freeze(physicalRanges.map(range => Object.freeze({ ...range }))),
  });
}
