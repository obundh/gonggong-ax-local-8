// Portable synthetic HWP 5 / CFB v3 fixture.
// The DocInfo, Section0, preview text, and BinData bytes are test data only;
// this fixture proves container allocation, not Hanword application validity.

const FREE = 0xffffffff;
const END = 0xfffffffe;
const FAT = 0xfffffffd;
const NO_STREAM = FREE;
const SECTOR_SIZE = 512;
const MINI_SECTOR_SIZE = 64;

function putU32(buffer, offset, value) {
  buffer.writeUInt32LE(value >>> 0, offset);
}

function sectorOffset(id) {
  return (id + 1) * SECTOR_SIZE;
}

function writeDirectoryEntry(buffer, offset, {
  name, type, color = 1, left = NO_STREAM, right = NO_STREAM,
  child = NO_STREAM, first = END, size = 0
}) {
  const encoded = Buffer.from(`${name}\0`, 'utf16le');
  if (encoded.length > 64) throw new RangeError('CFB directory name is too long');
  encoded.copy(buffer, offset);
  buffer.writeUInt16LE(encoded.length, offset + 64);
  buffer[offset + 66] = type;
  buffer[offset + 67] = color;
  putU32(buffer, offset + 68, left);
  putU32(buffer, offset + 72, right);
  putU32(buffer, offset + 76, child);
  putU32(buffer, offset + 116, first);
  buffer.writeBigUInt64LE(BigInt(size), offset + 120);
}

function makeFileHeader(protectionFlags) {
  const bytes = Buffer.alloc(256);
  bytes.write('HWP Document File', 0, 'ascii');
  // HWP 5.0.0.0 is stored least-significant component first.
  bytes.set([0, 0, 0, 5], 32);
  putU32(bytes, 36, protectionFlags);
  bytes.write('synthetic allocation fixture', 64, 'ascii');
  return bytes;
}

function makeRecordBytes(length, tag, label) {
  const bytes = Buffer.alloc(length);
  putU32(bytes, 0, (tag & 0x3ff) | ((length - 4) << 20));
  bytes.write(label, 4, 'ascii');
  for (let index = 4 + label.length; index < bytes.length; index += 1) {
    bytes[index] = (index * 29 + tag) & 0xff;
  }
  return bytes;
}

/**
 * Create a bounded, allocation-complete CFB v3 container recognized as HWP 5.
 *
 * @param {{includePrvText?: boolean, nonMonotonic?: boolean, protectionFlags?: number}} options
 * @returns {{bytes: Buffer, layout: object, offsets: object}}
 */
export function createHwpFixture({
  includePrvText = true,
  nonMonotonic = false,
  protectionFlags = 0
} = {}) {
  const chains = nonMonotonic
    ? {
        directory: [2, 1],
        miniFat: [3],
        miniStream: [4],
        binData: [12, 5, 11, 6, 10, 7, 9, 8]
      }
    : {
        directory: [1, 2],
        miniFat: [3],
        miniStream: [4],
        binData: [5, 6, 7, 8, 9, 10, 11, 12]
      };
  const sectorCount = 13;
  const bytes = Buffer.alloc(SECTOR_SIZE * (sectorCount + 1));

  // CFB v3 header.
  Buffer.from('d0cf11e0a1b11ae1', 'hex').copy(bytes, 0);
  bytes.writeUInt16LE(0x003e, 24);
  bytes.writeUInt16LE(3, 26);
  bytes.writeUInt16LE(0xfffe, 28);
  bytes.writeUInt16LE(9, 30);
  bytes.writeUInt16LE(6, 32);
  putU32(bytes, 40, 0);
  putU32(bytes, 44, 1);
  putU32(bytes, 48, chains.directory[0]);
  putU32(bytes, 52, 0);
  putU32(bytes, 56, 4096);
  putU32(bytes, 60, chains.miniFat[0]);
  putU32(bytes, 64, 1);
  putU32(bytes, 68, END);
  putU32(bytes, 72, 0);
  putU32(bytes, 76, 0);
  for (let index = 1; index < 109; index += 1) putU32(bytes, 76 + index * 4, FREE);

  // FAT: every allocated regular sector is owned exactly once.
  const fatOffset = sectorOffset(0);
  for (let index = 0; index < 128; index += 1) putU32(bytes, fatOffset + index * 4, FREE);
  putU32(bytes, fatOffset, FAT);
  for (const chain of [chains.directory, chains.miniFat, chains.miniStream, chains.binData]) {
    for (let index = 0; index < chain.length; index += 1) {
      putU32(bytes, fatOffset + chain[index] * 4, index + 1 < chain.length ? chain[index + 1] : END);
    }
  }

  // MiniFAT: all allocated mini sectors belong to exactly one stream.
  const miniFatOffset = sectorOffset(chains.miniFat[0]);
  for (let index = 0; index < 128; index += 1) putU32(bytes, miniFatOffset + index * 4, FREE);
  const miniChains = {
    FileHeader: [0, 1, 2, 3],
    DocInfo: [4],
    Section0: [5, 6],
    ...(includePrvText ? { PrvText: [7] } : {})
  };
  for (const chain of Object.values(miniChains)) {
    for (let index = 0; index < chain.length; index += 1) {
      putU32(bytes, miniFatOffset + chain[index] * 4, index + 1 < chain.length ? chain[index + 1] : END);
    }
  }

  const fileHeader = makeFileHeader(protectionFlags);
  const docInfo = makeRecordBytes(64, 16, 'Synthetic DocInfo');
  const section0 = makeRecordBytes(128, 66, 'Synthetic Section0');
  const prvText = Buffer.from('복구 테스트 미리보기', 'utf16le');
  const miniStream = Buffer.alloc(SECTOR_SIZE);
  fileHeader.copy(miniStream, miniChains.FileHeader[0] * MINI_SECTOR_SIZE);
  docInfo.copy(miniStream, miniChains.DocInfo[0] * MINI_SECTOR_SIZE);
  section0.copy(miniStream, miniChains.Section0[0] * MINI_SECTOR_SIZE);
  if (includePrvText) prvText.copy(miniStream, miniChains.PrvText[0] * MINI_SECTOR_SIZE);
  miniStream.copy(bytes, sectorOffset(chains.miniStream[0]));

  const binData = Buffer.alloc(4096);
  binData.write('synthetic regular HWP BinData stream', 0, 'ascii');
  for (let index = 40; index < binData.length; index += 1) binData[index] = (index * 17 + 3) & 0xff;
  for (let index = 0; index < chains.binData.length; index += 1) {
    binData.copy(bytes, sectorOffset(chains.binData[index]), index * SECTOR_SIZE, (index + 1) * SECTOR_SIZE);
  }

  const directory = Buffer.alloc(SECTOR_SIZE * 2);
  const entrySpecs = [
    { name: 'Root Entry', type: 5, color: 1, child: 3, first: chains.miniStream[0], size: includePrvText ? 512 : 448 },
    { name: 'FileHeader', type: 2, color: 1, first: 0, size: fileHeader.length },
    { name: 'DocInfo', type: 2, color: 1, left: 6, right: includePrvText ? 5 : NO_STREAM, first: 4, size: docInfo.length },
    { name: 'BodyText', type: 1, color: 1, left: 2, right: 1, child: 4, first: 0 },
    { name: 'Section0', type: 2, color: 1, first: 5, size: section0.length },
    includePrvText
      ? { name: 'PrvText', type: 2, color: 0, first: 7, size: prvText.length }
      : null,
    { name: 'BinData', type: 1, color: 0, child: 7, first: 0 },
    { name: 'BIN0001', type: 2, color: 1, first: chains.binData[0], size: binData.length }
  ];
  const directoryEntries = {};
  for (let index = 0; index < entrySpecs.length; index += 1) {
    if (!entrySpecs[index]) continue;
    writeDirectoryEntry(directory, index * 128, entrySpecs[index]);
    const logicalSectorIndex = Math.floor(index / 4);
    directoryEntries[entrySpecs[index].name] = {
      index,
      offset: sectorOffset(chains.directory[logicalSectorIndex]) + (index % 4) * 128
    };
  }
  for (let index = 0; index < chains.directory.length; index += 1) {
    directory.copy(bytes, sectorOffset(chains.directory[index]), index * SECTOR_SIZE, (index + 1) * SECTOR_SIZE);
  }

  const streams = {
    FileHeader: { firstMiniSector: 0, size: fileHeader.length, offset: sectorOffset(chains.miniStream[0]) },
    DocInfo: { firstMiniSector: 4, size: docInfo.length, offset: sectorOffset(chains.miniStream[0]) + 4 * MINI_SECTOR_SIZE },
    Section0: { firstMiniSector: 5, size: section0.length, offset: sectorOffset(chains.miniStream[0]) + 5 * MINI_SECTOR_SIZE },
    ...(includePrvText ? { PrvText: { firstMiniSector: 7, size: prvText.length, offset: sectorOffset(chains.miniStream[0]) + 7 * MINI_SECTOR_SIZE } } : {}),
    BIN0001: { firstSector: chains.binData[0], sectors: [...chains.binData], size: binData.length }
  };
  const layout = {
    sectorSize: SECTOR_SIZE,
    miniSectorSize: MINI_SECTOR_SIZE,
    sectorCount,
    length: bytes.length,
    sectors: { fat: [0], ...Object.fromEntries(Object.entries(chains).map(([name, ids]) => [name, [...ids]])) },
    fatEntries: Array.from({ length: sectorCount }, (_, id) => fatOffset + id * 4),
    miniFatEntries: Array.from({ length: 8 }, (_, id) => miniFatOffset + id * 4),
    directoryEntries,
    streams,
    header: {
      majorVersion: 26,
      sectorShift: 30,
      firstDirectorySector: 48,
      transactionSignature: 52,
      firstMiniFatSector: 60,
      firstDifatSector: 68,
      difatSectorCount: 72,
      firstInlineFatSector: 76
    }
  };
  return { bytes, layout, offsets: layout };
}

export const CFB_MARKERS = Object.freeze({ FREE, END, FAT });
