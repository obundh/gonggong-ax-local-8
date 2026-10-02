import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BYTES_PER_SECTOR = 512;
const SECTORS_PER_CLUSTER = 8;
const CLUSTER_SIZE = BYTES_PER_SECTOR * SECTORS_PER_CLUSTER;
const FILE_RECORD_SIZE = 1024;
const TOTAL_CLUSTERS = 1024;
const MFT_LCN = 4;
const MFT_RECORD_COUNT = 64;
const MFT_CLUSTER_COUNT = (MFT_RECORD_COUNT * FILE_RECORD_SIZE) / CLUSTER_SIZE;
const IMAGE_SIZE = TOTAL_CLUSTERS * CLUSTER_SIZE;
const ROOT_RECORD = 5;

const ATTRIBUTE = Object.freeze({
  STANDARD_INFORMATION: 0x10,
  ATTRIBUTE_LIST: 0x20,
  FILE_NAME: 0x30,
  VOLUME_INFORMATION: 0x70,
  DATA: 0x80,
  BITMAP: 0xb0,
});

const FIXTURE_TIME = new Date('2025-02-03T04:05:06.000Z');

function align8(value) {
  return (value + 7) & ~7;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function ntfsTime(date) {
  return (BigInt(date.getTime()) + 11_644_473_600_000n) * 10_000n;
}

function fileReference(recordNumber, sequence = 1) {
  return BigInt(recordNumber) | (BigInt(sequence) << 48n);
}

function residentAttribute(type, value, id, flags = 0) {
  const length = align8(24 + value.length);
  const attribute = Buffer.alloc(length);
  attribute.writeUInt32LE(type, 0);
  attribute.writeUInt32LE(length, 4);
  attribute[8] = 0;
  attribute[9] = 0;
  attribute.writeUInt16LE(0, 10);
  attribute.writeUInt16LE(flags, 12);
  attribute.writeUInt16LE(id, 14);
  attribute.writeUInt32LE(value.length, 16);
  attribute.writeUInt16LE(24, 20);
  attribute[22] = 0;
  value.copy(attribute, 24);
  return attribute;
}

function signedLittleEndian(value) {
  let size = 1;
  while (size < 8) {
    const min = -(2 ** (size * 8 - 1));
    const max = 2 ** (size * 8 - 1) - 1;
    if (value >= min && value <= max) break;
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

function dataRuns(runs) {
  const parts = [];
  let previousLcn = 0;
  for (const run of runs) {
    const lengthBytes = unsignedLittleEndian(run.clusters);
    if (run.lcn == null) {
      parts.push(Buffer.from([lengthBytes.length]), lengthBytes);
      continue;
    }
    const relativeLcn = run.lcn - previousLcn;
    const offsetBytes = signedLittleEndian(relativeLcn);
    parts.push(
      Buffer.from([(offsetBytes.length << 4) | lengthBytes.length]),
      lengthBytes,
      offsetBytes,
    );
    previousLcn = run.lcn;
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

function nonresidentAttribute(
  type,
  runs,
  dataSize,
  id,
  { flags = 0, compressionUnit = 0, allocatedSize, initializedSize = dataSize } = {},
) {
  const runlist = dataRuns(runs);
  const headerSize = flags & 0x0001 ? 72 : 64;
  const length = align8(headerSize + runlist.length);
  const attribute = Buffer.alloc(length);
  const clusterCount = runs.reduce((sum, run) => sum + run.clusters, 0);
  const physicalClusters = runs.reduce(
    (sum, run) => sum + (run.lcn == null ? 0 : run.clusters),
    0,
  );
  attribute.writeUInt32LE(type, 0);
  attribute.writeUInt32LE(length, 4);
  attribute[8] = 1;
  attribute[9] = 0;
  attribute.writeUInt16LE(0, 10);
  attribute.writeUInt16LE(flags, 12);
  attribute.writeUInt16LE(id, 14);
  attribute.writeBigUInt64LE(0n, 16);
  attribute.writeBigUInt64LE(BigInt(clusterCount - 1), 24);
  attribute.writeUInt16LE(headerSize, 32);
  attribute.writeUInt16LE(compressionUnit, 34);
  attribute.writeBigUInt64LE(
    BigInt(allocatedSize ?? physicalClusters * CLUSTER_SIZE),
    40,
  );
  attribute.writeBigUInt64LE(BigInt(dataSize), 48);
  attribute.writeBigUInt64LE(BigInt(initializedSize), 56);
  if (headerSize === 72) {
    attribute.writeBigUInt64LE(BigInt(physicalClusters * CLUSTER_SIZE), 64);
  }
  runlist.copy(attribute, headerSize);
  return attribute;
}

function standardInformation() {
  const value = Buffer.alloc(72);
  const timestamp = ntfsTime(FIXTURE_TIME);
  for (const offset of [0, 8, 16, 24]) value.writeBigUInt64LE(timestamp, offset);
  value.writeUInt32LE(0x20, 32);
  return value;
}

function fileNameAttribute(
  name,
  parentRecord = ROOT_RECORD,
  parentSequence = 1,
  allocatedSize = 0,
  dataSize = 0,
) {
  const encodedName = Buffer.from(name, 'utf16le');
  const value = Buffer.alloc(66 + encodedName.length);
  const timestamp = ntfsTime(FIXTURE_TIME);
  value.writeBigUInt64LE(fileReference(parentRecord, parentSequence), 0);
  for (const offset of [8, 16, 24, 32]) value.writeBigUInt64LE(timestamp, offset);
  value.writeBigUInt64LE(BigInt(allocatedSize), 40);
  value.writeBigUInt64LE(BigInt(dataSize), 48);
  value.writeUInt32LE(0x20, 56);
  value[64] = encodedName.length / 2;
  value[65] = 1;
  encodedName.copy(value, 66);
  return value;
}

function volumeInformation() {
  const value = Buffer.alloc(12);
  value[8] = 3;
  value[9] = 1;
  value.writeUInt16LE(0, 10);
  return value;
}

function makeFileRecord({
  recordNumber,
  sequence = 1,
  active = false,
  directory = false,
  name,
  parentRecord = ROOT_RECORD,
  parentSequence = 1,
  attributes = [],
  malformedAttribute = false,
  corruptUsa = false,
}) {
  const record = Buffer.alloc(FILE_RECORD_SIZE);
  const usaOffset = 0x30;
  const firstAttributeOffset = 0x38;
  record.write('FILE', 0, 4, 'ascii');
  record.writeUInt16LE(usaOffset, 4);
  record.writeUInt16LE(3, 6);
  record.writeUInt16LE(sequence, 16);
  record.writeUInt16LE(1, 18);
  record.writeUInt16LE(firstAttributeOffset, 20);
  record.writeUInt16LE((active ? 1 : 0) | (directory ? 2 : 0), 22);
  record.writeUInt32LE(FILE_RECORD_SIZE, 28);
  record.writeUInt16LE(attributes.length + 3, 40);
  record.writeUInt32LE(recordNumber, 44);

  const dataAttribute = attributes.find((attribute) => attribute.readUInt32LE(0) === ATTRIBUTE.DATA);
  const dataSize = dataAttribute
    ? Number(dataAttribute[8] === 0
      ? dataAttribute.readUInt32LE(16)
      : dataAttribute.readBigUInt64LE(48))
    : 0;
  const allocatedSize = dataAttribute
    ? Number(dataAttribute[8] === 0
      ? dataAttribute.readUInt32LE(16)
      : dataAttribute.readBigUInt64LE(40))
    : 0;
  const allAttributes = [residentAttribute(ATTRIBUTE.STANDARD_INFORMATION, standardInformation(), 0)];
  if (name != null) {
    allAttributes.push(
      residentAttribute(
        ATTRIBUTE.FILE_NAME,
        fileNameAttribute(name, parentRecord, parentSequence, allocatedSize, dataSize),
        1,
      ),
    );
  }
  allAttributes.push(...attributes);

  let cursor = firstAttributeOffset;
  for (const attribute of allAttributes) {
    if (cursor + attribute.length + 8 > FILE_RECORD_SIZE - 2) {
      throw new Error(`record ${recordNumber} attributes exceed the fixture record`);
    }
    attribute.copy(record, cursor);
    cursor += attribute.length;
  }
  if (malformedAttribute) {
    record.writeUInt32LE(ATTRIBUTE.DATA, cursor);
    record.writeUInt32LE(0, cursor + 4);
    cursor += 8;
  } else {
    record.writeUInt32LE(0xffffffff, cursor);
    cursor += 4;
  }
  record.writeUInt32LE(cursor, 24);

  const updateSequence = 0xa000 + recordNumber;
  record.writeUInt16LE(updateSequence, usaOffset);
  record.writeUInt16LE(record.readUInt16LE(510), usaOffset + 2);
  record.writeUInt16LE(record.readUInt16LE(1022), usaOffset + 4);
  record.writeUInt16LE(updateSequence, 510);
  record.writeUInt16LE(updateSequence, 1022);
  if (corruptUsa) record.writeUInt16LE(updateSequence ^ 0xffff, 510);
  return record;
}

function makeBootSector() {
  const boot = Buffer.alloc(BYTES_PER_SECTOR);
  boot.set([0xeb, 0x52, 0x90], 0);
  boot.write('NTFS    ', 3, 8, 'ascii');
  boot.writeUInt16LE(BYTES_PER_SECTOR, 11);
  boot[13] = SECTORS_PER_CLUSTER;
  boot.writeUInt16LE(0, 14);
  boot[21] = 0xf8;
  boot.writeUInt16LE(63, 24);
  boot.writeUInt16LE(255, 26);
  boot.writeBigUInt64LE(BigInt(IMAGE_SIZE / BYTES_PER_SECTOR), 40);
  boot.writeBigUInt64LE(BigInt(MFT_LCN), 48);
  boot.writeBigUInt64LE(BigInt(TOTAL_CLUSTERS - 1), 56);
  boot.writeInt8(-10, 64);
  boot.writeInt8(1, 68);
  boot.writeBigUInt64LE(0x53594e5448455449n, 72);
  boot[510] = 0x55;
  boot[511] = 0xaa;
  return boot;
}

function setBitmapBit(bitmap, bit) {
  bitmap[Math.floor(bit / 8)] |= 1 << (bit % 8);
}

function deterministicBytes(length, seed) {
  const bytes = Buffer.alloc(length);
  let state = seed >>> 0;
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    bytes[index] = state >>> 24;
  }
  return bytes;
}

function candidateMetadata(recordNumber, name, payload, expected) {
  return {
    recordNumber,
    name,
    originalFile: payload ? `originals/record-${recordNumber}.bin` : null,
    size: payload?.length ?? expected.size,
    sha256: payload ? sha256(payload) : null,
    modifiedAt: FIXTURE_TIME.toISOString(),
    deletedAt: null,
    ...expected,
  };
}

export async function createFixture(directory) {
  const fixtureDirectory = path.resolve(directory);
  const originalsDir = path.join(fixtureDirectory, 'originals');
  const imagePath = path.join(fixtureDirectory, 'synthetic-ntfs.img');
  const manifestPath = path.join(fixtureDirectory, 'manifest.json');
  await mkdir(path.dirname(fixtureDirectory), { recursive: true });
  await mkdir(fixtureDirectory);
  await mkdir(originalsDir);

  const image = Buffer.alloc(IMAGE_SIZE);
  makeBootSector().copy(image, 0);

  const unicodePayload = Buffer.from(
    '회복 연진 테스트 문서\r\n인코딩: UTF-8\r\n',
    'utf8',
  );
  const contiguousPayload = deterministicBytes(6_000, 0xc0ffee);
  const multiRunPayload = deterministicBytes(6_000, 0x51a9ed);
  const unsafePayload = Buffer.from('sanitized recovery target\n', 'utf8');
  const badUsaPayload = Buffer.from('must never be recovered\n', 'utf8');
  const attributeListPayload = Buffer.from('attribute-list unsupported\n', 'utf8');
  const compressedPayload = deterministicBytes(3_000, 0xc0dec0de);
  const allocatedPayload = deterministicBytes(1_200, 0xa110ca7e);
  const orphanPayload = Buffer.from('parent sequence mismatch, data is resident\n', 'utf8');

  const volumeBitmap = Buffer.alloc(TOTAL_CLUSTERS / 8);
  for (let cluster = 0; cluster < MFT_LCN + MFT_CLUSTER_COUNT; cluster += 1) {
    setBitmapBit(volumeBitmap, cluster);
  }
  setBitmapBit(volumeBitmap, 40);

  const mftBitmap = Buffer.alloc(MFT_RECORD_COUNT / 8);
  for (const recordNumber of [0, 3, 5, 6, 42]) setBitmapBit(mftBitmap, recordNumber);

  const records = new Map();
  records.set(
    0,
    makeFileRecord({
      recordNumber: 0,
      sequence: 1,
      active: true,
      name: '$MFT',
      attributes: [
        nonresidentAttribute(
          ATTRIBUTE.DATA,
          [{ lcn: MFT_LCN, clusters: MFT_CLUSTER_COUNT }],
          MFT_RECORD_COUNT * FILE_RECORD_SIZE,
          2,
          {
            allocatedSize: MFT_CLUSTER_COUNT * CLUSTER_SIZE,
            initializedSize: MFT_RECORD_COUNT * FILE_RECORD_SIZE,
          },
        ),
        residentAttribute(ATTRIBUTE.BITMAP, mftBitmap, 3),
      ],
    }),
  );
  records.set(
    3,
    makeFileRecord({
      recordNumber: 3,
      sequence: 1,
      active: true,
      name: '$Volume',
      attributes: [residentAttribute(ATTRIBUTE.VOLUME_INFORMATION, volumeInformation(), 2)],
    }),
  );
  records.set(
    5,
    makeFileRecord({
      recordNumber: 5,
      sequence: 1,
      active: true,
      directory: true,
      name: '.',
      parentRecord: ROOT_RECORD,
      parentSequence: 1,
    }),
  );
  records.set(
    6,
    makeFileRecord({
      recordNumber: 6,
      sequence: 1,
      active: true,
      name: '$Bitmap',
      attributes: [residentAttribute(ATTRIBUTE.DATA, volumeBitmap, 2)],
    }),
  );

  records.set(
    24,
    makeFileRecord({
      recordNumber: 24,
      sequence: 7,
      name: '삭제된-문서.txt',
      attributes: [residentAttribute(ATTRIBUTE.DATA, unicodePayload, 2)],
    }),
  );
  records.set(
    25,
    makeFileRecord({
      recordNumber: 25,
      sequence: 4,
      name: 'contiguous.bin',
      attributes: [
        nonresidentAttribute(
          ATTRIBUTE.DATA,
          [{ lcn: 20, clusters: 2 }],
          contiguousPayload.length,
          2,
        ),
      ],
    }),
  );
  records.set(
    26,
    makeFileRecord({
      recordNumber: 26,
      sequence: 3,
      name: 'synthetic-ntfs.img',
      attributes: [
        nonresidentAttribute(
          ATTRIBUTE.DATA,
          [
            { lcn: 30, clusters: 1 },
            { lcn: 28, clusters: 1 },
          ],
          multiRunPayload.length,
          2,
        ),
      ],
    }),
  );
  records.set(
    27,
    makeFileRecord({
      recordNumber: 27,
      sequence: 9,
      name: '..\\..\\escape.txt',
      attributes: [residentAttribute(ATTRIBUTE.DATA, unsafePayload, 2)],
    }),
  );
  records.set(
    33,
    makeFileRecord({
      recordNumber: 33,
      sequence: 2,
      name: 'orphaned.txt',
      parentSequence: 99,
      attributes: [residentAttribute(ATTRIBUTE.DATA, orphanPayload, 2)],
    }),
  );
  records.set(
    34,
    makeFileRecord({
      recordNumber: 34,
      sequence: 2,
      name: 'allocated-cluster.bin',
      attributes: [
        nonresidentAttribute(
          ATTRIBUTE.DATA,
          [{ lcn: 40, clusters: 1 }],
          allocatedPayload.length,
          2,
        ),
      ],
    }),
  );
  records.set(
    35,
    makeFileRecord({
      recordNumber: 35,
      sequence: 2,
      name: 'out-of-range.bin',
      attributes: [
        nonresidentAttribute(
          ATTRIBUTE.DATA,
          [{ lcn: TOTAL_CLUSTERS + 50, clusters: 1 }],
          128,
          2,
        ),
      ],
    }),
  );
  records.set(
    36,
    makeFileRecord({
      recordNumber: 36,
      sequence: 2,
      name: 'attribute-list.txt',
      attributes: [
        residentAttribute(ATTRIBUTE.ATTRIBUTE_LIST, Buffer.alloc(0), 2),
        residentAttribute(ATTRIBUTE.DATA, attributeListPayload, 3),
      ],
    }),
  );
  records.set(
    37,
    makeFileRecord({
      recordNumber: 37,
      sequence: 2,
      name: 'compressed.bin',
      attributes: [
        nonresidentAttribute(
          ATTRIBUTE.DATA,
          [{ lcn: 50, clusters: 1 }],
          compressedPayload.length,
          2,
          { flags: 0x0001, compressionUnit: 4 },
        ),
      ],
    }),
  );
  records.set(
    38,
    makeFileRecord({
      recordNumber: 38,
      sequence: 2,
      name: 'sparse.bin',
      attributes: [
        nonresidentAttribute(
          ATTRIBUTE.DATA,
          [{ lcn: null, clusters: 1 }],
          CLUSTER_SIZE,
          2,
          { flags: 0x8000, allocatedSize: 0 },
        ),
      ],
    }),
  );
  records.set(
    39,
    makeFileRecord({
      recordNumber: 39,
      sequence: 2,
      name: 'invalid-usa.txt',
      attributes: [residentAttribute(ATTRIBUTE.DATA, badUsaPayload, 2)],
      corruptUsa: true,
    }),
  );
  records.set(
    40,
    makeFileRecord({
      recordNumber: 40,
      sequence: 2,
      name: 'malformed-attribute.bin',
      malformedAttribute: true,
    }),
  );
  records.set(
    41,
    makeFileRecord({
      recordNumber: 41,
      sequence: 2,
      directory: true,
      name: 'deleted-directory',
    }),
  );
  records.set(
    42,
    makeFileRecord({
      recordNumber: 42,
      sequence: 2,
      active: true,
      name: 'active-file.txt',
      attributes: [residentAttribute(ATTRIBUTE.DATA, Buffer.from('active\n'), 2)],
    }),
  );

  for (const [recordNumber, record] of records) {
    const offset = MFT_LCN * CLUSTER_SIZE + recordNumber * FILE_RECORD_SIZE;
    record.copy(image, offset);
  }

  contiguousPayload.copy(image, 20 * CLUSTER_SIZE);
  multiRunPayload.subarray(0, CLUSTER_SIZE).copy(image, 30 * CLUSTER_SIZE);
  multiRunPayload.subarray(CLUSTER_SIZE).copy(image, 28 * CLUSTER_SIZE);
  allocatedPayload.copy(image, 40 * CLUSTER_SIZE);
  compressedPayload.copy(image, 50 * CLUSTER_SIZE);

  const metadata = [
    candidateMetadata(24, '삭제된-문서.txt', unicodePayload, {
      case: 'resident-unicode',
      expectedStorage: 'resident',
      expectedStatus: 'readable',
      expectedPathStatus: 'known',
      recoverable: true,
    }),
    candidateMetadata(25, 'contiguous.bin', contiguousPayload, {
      case: 'nonresident-contiguous',
      expectedStorage: 'nonresident',
      expectedStatus: 'readable',
      expectedPathStatus: 'known',
      recoverable: true,
    }),
    candidateMetadata(26, 'synthetic-ntfs.img', multiRunPayload, {
      case: 'nonresident-multi-run-signed-relative-lcn',
      expectedStorage: 'nonresident',
      expectedStatus: 'readable',
      expectedPathStatus: 'known',
      recoverable: true,
    }),
    candidateMetadata(27, '..\\..\\escape.txt', unsafePayload, {
      case: 'unsafe-name',
      expectedStorage: 'resident',
      expectedStatus: 'readable',
      expectedPathStatus: 'known',
      recoverable: true,
    }),
    candidateMetadata(33, 'orphaned.txt', orphanPayload, {
      case: 'parent-sequence-mismatch',
      expectedStorage: 'resident',
      expectedStatus: 'readable',
      expectedPathStatus: 'unknown',
      recoverable: true,
    }),
    candidateMetadata(34, 'allocated-cluster.bin', allocatedPayload, {
      case: 'allocated-cluster-conflict',
      expectedStorage: 'nonresident',
      expectedStatus: 'conflict',
      expectedPathStatus: 'known',
      recoverable: false,
    }),
    candidateMetadata(35, 'out-of-range.bin', null, {
      case: 'out-of-range-run',
      size: 128,
      expectedStorage: 'unsupported',
      expectedStatus: 'conflict',
      expectedPathStatus: 'known',
      recoverable: false,
    }),
    candidateMetadata(36, 'attribute-list.txt', attributeListPayload, {
      case: 'attribute-list',
      expectedStorage: 'unsupported',
      expectedStatus: 'unsupported',
      expectedPathStatus: 'known',
      recoverable: false,
    }),
    candidateMetadata(37, 'compressed.bin', compressedPayload, {
      case: 'compressed-data',
      expectedStorage: 'unsupported',
      expectedStatus: 'unsupported',
      expectedPathStatus: 'known',
      recoverable: false,
    }),
    candidateMetadata(38, 'sparse.bin', null, {
      case: 'sparse-data',
      size: CLUSTER_SIZE,
      expectedStorage: 'unsupported',
      expectedStatus: 'unsupported',
      expectedPathStatus: 'known',
      recoverable: false,
    }),
  ];

  for (const item of metadata) {
    if (!item.originalFile || !item.sha256) continue;
    const payloadByRecord = new Map([
      [24, unicodePayload],
      [25, contiguousPayload],
      [26, multiRunPayload],
      [27, unsafePayload],
      [33, orphanPayload],
      [34, allocatedPayload],
      [36, attributeListPayload],
      [37, compressedPayload],
    ]);
    await writeFile(
      path.join(fixtureDirectory, item.originalFile),
      payloadByRecord.get(item.recordNumber),
      { flag: 'wx' },
    );
  }

  const manifest = {
    format: 'RecoveryChat synthetic NTFS fixture manifest v1',
    synthetic: true,
    evidenceLimit:
      'Programmatically fabricated NTFS metadata for deterministic parser tests; it is not a Windows-formatted volume and is not evidence of behavior on a real disk.',
    ntfsVersion: '3.1',
    geometry: {
      bytesPerSector: BYTES_PER_SECTOR,
      sectorsPerCluster: SECTORS_PER_CLUSTER,
      clusterSize: CLUSTER_SIZE,
      fileRecordSize: FILE_RECORD_SIZE,
      totalClusters: TOTAL_CLUSTERS,
      mftLcn: MFT_LCN,
      mftRecordCount: MFT_RECORD_COUNT,
      mftClusterCount: MFT_CLUSTER_COUNT,
    },
    controls: {
      invalidUsaRecord: 39,
      malformedAttributeRecord: 40,
      deletedDirectoryRecord: 41,
      activeFileRecord: 42,
    },
    files: metadata,
  };

  await writeFile(imagePath, image, { flag: 'wx' });
  await writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    { encoding: 'utf8', flag: 'wx' },
  );
  return { fixtureDirectory, imagePath, originalsDir, manifestPath, manifest };
}

const isDirectRun = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  const destination = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.resolve('test', 'generated-ntfs-fixture');
  const result = await createFixture(destination);
  process.stdout.write(`${result.imagePath}\n${result.manifestPath}\n`);
}

export const fixtureGeometry = Object.freeze({
  bytesPerSector: BYTES_PER_SECTOR,
  sectorsPerCluster: SECTORS_PER_CLUSTER,
  clusterSize: CLUSTER_SIZE,
  fileRecordSize: FILE_RECORD_SIZE,
  totalClusters: TOTAL_CLUSTERS,
  mftLcn: MFT_LCN,
  mftRecordCount: MFT_RECORD_COUNT,
});

// Test-image construction only. These helpers are never imported by the engine.
export const fixturePrimitives = Object.freeze({
  makeFileRecord, residentAttribute, nonresidentAttribute, setBitmapBit,
});
