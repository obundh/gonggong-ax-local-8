import { createHash } from 'node:crypto';

// Bounded, contiguous HWP 5 extent validation. This validates the CFB container
// and stream allocation only; it does not decompress or interpret HWP records.
const SECTOR_SIZE = 512;
const MINI_SECTOR_SIZE = 64;
const MINI_STREAM_CUTOFF = 4096;
const HARD_FILE_LIMIT = 64 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 4096;
const MAX_FAT_SECTORS = 109;
const FAT_ENTRIES_PER_SECTOR = SECTOR_SIZE / 4;
const DIRECTORY_ENTRIES_PER_SECTOR = SECTOR_SIZE / 128;

const MAXREGSECT = 0xfffffffa;
const DIFSECT = 0xfffffffc;
const FATSECT = 0xfffffffd;
const ENDOFCHAIN = 0xfffffffe;
const FREESECT = 0xffffffff;
const NOSTREAM = 0xffffffff;

const CFB_SIGNATURE = Buffer.from('d0cf11e0a1b11ae1', 'hex');
const HWP_SIGNATURE = Buffer.from('HWP Document File', 'ascii');
const ZERO_CLSID = Buffer.alloc(16);
const ZERO_RESERVED = Buffer.alloc(6);

// Password, distribution, DRM, certificate encryption/signing preparation,
// certificate DRM, and personal-information protection are not decoded here.
const HWP_PROTECTED_FLAGS = (1 << 1) | (1 << 2) | (1 << 4) | (1 << 8)
  | (1 << 9) | (1 << 10) | (1 << 13);

class ValidationStop extends Error {
  constructor(state, reason) {
    super(reason);
    this.state = state;
    this.reason = reason;
  }
}

class ReadFailure {
  constructor(error) { this.error = error; }
}

function stop(state, reason) {
  throw new ValidationStop(state, reason);
}

function invalid(ok, reason) {
  if (!ok) stop('invalid', reason);
}

function unsupported(ok, reason) {
  if (!ok) stop('unsupported', reason);
}

function limit(ok, reason) {
  if (!ok) stop('limit', reason);
}

function isRegularSector(value) {
  return Number.isInteger(value) && value >= 0 && value < MAXREGSECT;
}

function nameKey(name) {
  return name.toUpperCase();
}

export async function validateHwpExtent(read, availableBytes, maxFileBytes) {
  try {
    invalid(typeof read === 'function', '읽기 함수가 올바르지 않아요.');
    invalid(Number.isSafeInteger(availableBytes) && availableBytes >= 0, '후보 범위 길이가 올바르지 않아요.');
    invalid(Number.isSafeInteger(maxFileBytes) && maxFileBytes > 0, '파일 크기 제한이 올바르지 않아요.');

    const fileLimit = Math.min(maxFileBytes, HARD_FILE_LIMIT);
    limit(fileLimit >= SECTOR_SIZE * 3, '검사 한도가 CFB 최소 크기보다 작아요.');
    invalid(availableBytes >= SECTOR_SIZE * 3, '후보 범위가 CFB 최소 크기보다 짧아요.');

    async function checkedRead(relativeOffset, length) {
      invalid(Number.isSafeInteger(relativeOffset) && relativeOffset >= 0
        && Number.isSafeInteger(length) && length >= 0 && length <= 1024 * 1024,
      '내부 읽기 범위가 올바르지 않아요.');
      const end = relativeOffset + length;
      invalid(Number.isSafeInteger(end) && end <= availableBytes, '선언된 섹터가 후보 범위를 벗어났어요.');
      limit(end <= fileLimit, 'HWP가 파일별 크기 제한을 넘어요.');
      let bytes;
      try { bytes = await read(relativeOffset, length); }
      catch (error) { throw new ReadFailure(error); }
      invalid(Buffer.isBuffer(bytes) && bytes.length === length, '필요한 바이트를 모두 읽지 못했어요.');
      return bytes;
    }

    const header = await checkedRead(0, SECTOR_SIZE);
    invalid(header.subarray(0, 8).equals(CFB_SIGNATURE), 'CFB 서명이 맞지 않아요.');
    invalid(header.subarray(8, 24).equals(ZERO_CLSID), 'CFB 헤더 CLSID가 올바르지 않아요.');
    unsupported(header.readUInt16LE(26) === 3, 'CFB 버전 3만 지원해요.');
    invalid(header.readUInt16LE(28) === 0xfffe, 'CFB 바이트 순서가 올바르지 않아요.');
    invalid(header.readUInt16LE(30) === 9 && header.readUInt16LE(32) === 6,
      'CFB 섹터 크기 정보가 올바르지 않아요.');
    invalid(header.subarray(34, 40).equals(ZERO_RESERVED), 'CFB 예약 필드가 올바르지 않아요.');
    invalid(header.readUInt32LE(40) === 0, 'CFB 버전 3의 디렉터리 섹터 수가 올바르지 않아요.');
    invalid(header.readUInt32LE(56) === MINI_STREAM_CUTOFF, 'CFB mini stream 경계가 올바르지 않아요.');

    const fatCount = header.readUInt32LE(44);
    const directoryFirst = header.readUInt32LE(48);
    const miniFatFirst = header.readUInt32LE(60);
    const miniFatCount = header.readUInt32LE(64);
    const firstDifat = header.readUInt32LE(68);
    const difatCount = header.readUInt32LE(72);

    invalid(fatCount > 0, 'FAT 섹터가 없어요.');
    unsupported(fatCount <= MAX_FAT_SECTORS, '확장 DIFAT가 필요한 CFB는 지원하지 않아요.');
    unsupported(difatCount === 0 && firstDifat === ENDOFCHAIN, '확장 DIFAT CFB는 지원하지 않아요.');
    invalid(isRegularSector(directoryFirst), '디렉터리 시작 섹터가 올바르지 않아요.');

    const structuralHash = createHash('sha256');
    structuralHash.update(header);
    const fatIds = [];
    const fatIdSet = new Set();
    for (let index = 0; index < MAX_FAT_SECTORS; index++) {
      const sectorId = header.readUInt32LE(76 + index * 4);
      if (index < fatCount) {
        invalid(isRegularSector(sectorId) && !fatIdSet.has(sectorId), 'FAT 섹터 목록이 올바르지 않아요.');
        fatIdSet.add(sectorId);
        fatIds.push(sectorId);
      } else {
        invalid(sectorId === FREESECT, '사용하지 않는 DIFAT 항목이 비어 있지 않아요.');
      }
    }

    function sectorEnd(sectorId) {
      invalid(isRegularSector(sectorId), '섹터 번호가 올바르지 않아요.');
      const end = (sectorId + 2) * SECTOR_SIZE;
      invalid(Number.isSafeInteger(end) && end <= availableBytes, '선언된 섹터가 후보 범위를 벗어났어요.');
      limit(end <= fileLimit, 'HWP가 파일별 크기 제한을 넘어요.');
      return end;
    }

    async function readSector(sectorId) {
      const end = sectorEnd(sectorId);
      return checkedRead(end - SECTOR_SIZE, SECTOR_SIZE);
    }

    const fatSectors = [];
    for (const sectorId of fatIds) {
      const bytes = await readSector(sectorId);
      fatSectors.push(bytes);
      structuralHash.update(bytes);
    }
    const fatCapacity = fatCount * FAT_ENTRIES_PER_SECTOR;
    const fatAt = sectorId => {
      invalid(Number.isInteger(sectorId) && sectorId >= 0 && sectorId < fatCapacity,
        'FAT 참조가 테이블 범위를 벗어났어요.');
      const table = fatSectors[Math.floor(sectorId / FAT_ENTRIES_PER_SECTOR)];
      return table.readUInt32LE((sectorId % FAT_ENTRIES_PER_SECTOR) * 4);
    };

    let highestAllocated = -1;
    for (let sectorId = 0; sectorId < fatCapacity; sectorId++) {
      const next = fatAt(sectorId);
      if (next !== FREESECT) highestAllocated = sectorId;
      if (next === DIFSECT) stop('unsupported', 'DIFAT 섹터가 있는 CFB는 지원하지 않아요.');
      invalid(next === FREESECT || next === ENDOFCHAIN || next === FATSECT || isRegularSector(next),
        'FAT 항목에 잘못된 값이 있어요.');
    }
    invalid(highestAllocated >= 1, 'CFB 할당 섹터가 부족해요.');
    const sectorCount = highestAllocated + 1;
    const length = (sectorCount + 1) * SECTOR_SIZE;
    invalid(length <= availableBytes, 'CFB가 후보 범위에서 잘렸어요.');
    limit(length <= fileLimit, 'HWP가 파일별 크기 제한을 넘어요.');

    for (const sectorId of fatIds) {
      invalid(sectorId < sectorCount && fatAt(sectorId) === FATSECT, 'FAT 섹터 표시가 맞지 않아요.');
    }
    for (let sectorId = 0; sectorId < sectorCount; sectorId++) {
      if (fatAt(sectorId) === FATSECT) {
        invalid(fatIdSet.has(sectorId), '목록에 없는 FAT 섹터가 있어요.');
      }
    }
    for (let sectorId = sectorCount; sectorId < fatCapacity; sectorId++) {
      invalid(fatAt(sectorId) === FREESECT, '추론한 파일 끝 뒤 FAT 항목이 비어 있지 않아요.');
    }

    const owners = new Int32Array(sectorCount);
    owners.fill(-1);
    let nextOwner = 1;
    const claim = (sectorId, owner) => {
      invalid(Number.isInteger(sectorId) && sectorId >= 0 && sectorId < sectorCount,
        '체인 섹터가 파일 범위를 벗어났어요.');
      invalid(owners[sectorId] === -1, '서로 다른 체인이 같은 섹터를 사용해요.');
      owners[sectorId] = owner;
    };
    const fatOwner = nextOwner++;
    for (const sectorId of fatIds) claim(sectorId, fatOwner);

    function exactChain(first, expectedSectors, owner) {
      if (expectedSectors === 0) {
        invalid(first === ENDOFCHAIN || first === FREESECT, '빈 스트림의 시작 섹터가 올바르지 않아요.');
        return [];
      }
      invalid(isRegularSector(first), '스트림 시작 섹터가 올바르지 않아요.');
      const chain = [];
      let sectorId = first;
      for (let index = 0; index < expectedSectors; index++) {
        invalid(sectorId < sectorCount, '스트림 체인이 파일 범위를 벗어났어요.');
        claim(sectorId, owner);
        chain.push(sectorId);
        const following = fatAt(sectorId);
        if (index === expectedSectors - 1) {
          invalid(following === ENDOFCHAIN, '스트림 체인 길이가 선언된 크기와 달라요.');
        } else {
          invalid(isRegularSector(following) && following < sectorCount,
            '스트림 체인이 선언된 크기보다 짧아요.');
          sectorId = following;
        }
      }
      return chain;
    }

    function terminatedChain(first, maximumSectors, owner, label) {
      invalid(isRegularSector(first), `${label} 시작 섹터가 올바르지 않아요.`);
      const chain = [];
      let sectorId = first;
      while (sectorId !== ENDOFCHAIN) {
        limit(chain.length < maximumSectors, `${label} 항목 수가 검사 한도를 넘어요.`);
        invalid(isRegularSector(sectorId) && sectorId < sectorCount, `${label} 체인이 파일 범위를 벗어났어요.`);
        claim(sectorId, owner);
        chain.push(sectorId);
        const following = fatAt(sectorId);
        invalid(following === ENDOFCHAIN || (isRegularSector(following) && following < sectorCount),
          `${label} 체인이 올바르지 않아요.`);
        sectorId = following;
      }
      return chain;
    }

    const directoryOwner = nextOwner++;
    const maxDirectorySectors = MAX_DIRECTORY_ENTRIES / DIRECTORY_ENTRIES_PER_SECTOR;
    const directoryChain = terminatedChain(directoryFirst, maxDirectorySectors, directoryOwner, '디렉터리');
    invalid(directoryChain.length > 0, '디렉터리 체인이 비어 있어요.');

    const entries = [];
    for (const sectorId of directoryChain) {
      const bytes = await readSector(sectorId);
      structuralHash.update(bytes);
      for (let offset = 0; offset < SECTOR_SIZE; offset += 128) {
        const type = bytes[offset + 66];
        if (type === 0) {
          entries.push(null);
          continue;
        }
        invalid(type === 1 || type === 2 || type === 5, '디렉터리 개체 형식이 올바르지 않아요.');
        const nameLength = bytes.readUInt16LE(offset + 64);
        invalid(nameLength >= 2 && nameLength <= 64 && nameLength % 2 === 0,
          '디렉터리 이름 길이가 올바르지 않아요.');
        invalid(bytes[offset + nameLength - 2] === 0 && bytes[offset + nameLength - 1] === 0,
          '디렉터리 이름이 null로 끝나지 않아요.');
        const name = bytes.toString('utf16le', offset, offset + nameLength - 2);
        invalid(name.length > 0 && !name.includes('\u0000') && !/[\\/:!]/u.test(name),
          '디렉터리 이름이 올바르지 않아요.');
        const color = bytes[offset + 67];
        invalid(color === 0 || color === 1, '디렉터리 색상 값이 올바르지 않아요.');
        const sizeHigh = bytes.readUInt32LE(offset + 124);
        invalid(sizeHigh === 0, 'CFB 버전 3 스트림 크기가 너무 커요.');
        const size = bytes.readUInt32LE(offset + 120);
        invalid(size <= length, '스트림 크기가 컨테이너 범위를 넘어요.');
        const start = bytes.readUInt32LE(offset + 116);
        if (type === 1) {
          invalid(size === 0 && start === 0, '스토리지 항목의 스트림 필드가 올바르지 않아요.');
        }
        entries.push({
          id: entries.length,
          name,
          type,
          color,
          left: bytes.readUInt32LE(offset + 68),
          right: bytes.readUInt32LE(offset + 72),
          child: bytes.readUInt32LE(offset + 76),
          start,
          size,
        });
      }
    }
    limit(entries.length <= MAX_DIRECTORY_ENTRIES, '디렉터리 항목 수가 검사 한도를 넘어요.');

    const root = entries[0];
    invalid(root?.type === 5 && root.name === 'Root Entry',
      '루트 디렉터리 항목이 올바르지 않아요.');
    invalid(root.left === NOSTREAM && root.right === NOSTREAM, '루트 항목의 형제 포인터가 올바르지 않아요.');
    for (let id = 1; id < entries.length; id++) {
      invalid(entries[id]?.type !== 5, '루트 항목이 중복되어 있어요.');
    }

    const parentOf = new Int32Array(entries.length);
    parentOf.fill(-1);
    parentOf[0] = 0;
    const childrenByParent = new Map();
    const storageQueue = [0];
    for (let queueAt = 0; queueAt < storageQueue.length; queueAt++) {
      const storageId = storageQueue[queueAt];
      const storage = entries[storageId];
      const children = [];
      const names = new Set();
      const stack = storage.child === NOSTREAM ? [] : [storage.child];
      while (stack.length) {
        const id = stack.pop();
        invalid(Number.isInteger(id) && id > 0 && id < entries.length && entries[id],
          '디렉터리 트리 포인터가 올바르지 않아요.');
        invalid(parentOf[id] === -1, '디렉터리 트리에 순환 또는 중복 참조가 있어요.');
        parentOf[id] = storageId;
        const entry = entries[id];
        const key = nameKey(entry.name);
        invalid(!names.has(key), '같은 스토리지에 중복된 이름이 있어요.');
        names.add(key);
        children.push(entry);
        if (entry.left !== NOSTREAM) stack.push(entry.left);
        if (entry.right !== NOSTREAM) stack.push(entry.right);
        if (entry.type === 1) storageQueue.push(id);
        else invalid(entry.child === NOSTREAM, '스트림 항목에 자식 포인터가 있어요.');
      }
      childrenByParent.set(storageId, children);
    }
    for (let id = 1; id < entries.length; id++) {
      if (entries[id]) invalid(parentOf[id] !== -1, '도달할 수 없는 디렉터리 항목이 있어요.');
    }

    const rootChildren = childrenByParent.get(0) ?? [];
    const direct = (children, name, type) => children.filter(entry => entry.name === name && entry.type === type);
    const fileHeaders = direct(rootChildren, 'FileHeader', 2);
    const docInfos = direct(rootChildren, 'DocInfo', 2);
    const bodyTexts = direct(rootChildren, 'BodyText', 1);
    invalid(fileHeaders.length === 1 && fileHeaders[0].size === 256,
      '256바이트 FileHeader 스트림이 루트에 없어요.');
    invalid(docInfos.length === 1 && docInfos[0].size > 0, '비어 있지 않은 DocInfo 스트림이 루트에 없어요.');
    invalid(bodyTexts.length === 1, 'BodyText 스토리지가 루트에 없어요.');
    const bodyChildren = childrenByParent.get(bodyTexts[0].id) ?? [];
    const sections = direct(bodyChildren, 'Section0', 2);
    invalid(sections.length === 1 && sections[0].size > 0,
      '비어 있지 않은 BodyText/Section0 스트림이 없어요.');

    const miniFatOwner = nextOwner++;
    let miniFatChain = [];
    if (miniFatCount === 0) {
      invalid(miniFatFirst === ENDOFCHAIN || miniFatFirst === FREESECT,
        '빈 miniFAT의 시작 섹터가 올바르지 않아요.');
    } else {
      limit(miniFatCount <= sectorCount, 'miniFAT 섹터 수가 검사 한도를 넘어요.');
      miniFatChain = exactChain(miniFatFirst, miniFatCount, miniFatOwner);
    }

    invalid(root.size % MINI_SECTOR_SIZE === 0, '루트 mini stream 크기가 64바이트 경계가 아니에요.');
    const rootOwner = nextOwner++;
    const rootChain = exactChain(root.start, Math.ceil(root.size / SECTOR_SIZE), rootOwner);

    const streams = entries.filter(entry => entry?.type === 2);
    for (const entry of streams) {
      if (entry.size >= MINI_STREAM_CUTOFF) {
        exactChain(entry.start, Math.ceil(entry.size / SECTOR_SIZE), nextOwner++);
      } else if (entry.size === 0) {
        invalid(entry.start === ENDOFCHAIN || entry.start === FREESECT,
          '빈 스트림의 시작 섹터가 올바르지 않아요.');
      }
    }

    const rootMiniCount = root.size / MINI_SECTOR_SIZE;
    const miniFatCapacity = miniFatCount * FAT_ENTRIES_PER_SECTOR;
    invalid(rootMiniCount <= miniFatCapacity || rootMiniCount === 0,
      'miniFAT가 루트 mini stream보다 작아요.');
    const miniFatValues = new Uint32Array(rootMiniCount);
    let miniIndex = 0;
    for (const sectorId of miniFatChain) {
      const bytes = await readSector(sectorId);
      structuralHash.update(bytes);
      for (let offset = 0; offset < SECTOR_SIZE; offset += 4, miniIndex++) {
        const value = bytes.readUInt32LE(offset);
        if (miniIndex < rootMiniCount) {
          invalid(value === FREESECT || value === ENDOFCHAIN
            || (isRegularSector(value) && value < rootMiniCount), 'miniFAT 항목이 올바르지 않아요.');
          miniFatValues[miniIndex] = value;
        } else {
          invalid(value === FREESECT, 'mini stream 끝 뒤 miniFAT 항목이 비어 있지 않아요.');
        }
      }
    }

    const miniOwners = new Int32Array(rootMiniCount);
    miniOwners.fill(-1);
    const miniChains = new Map();
    for (const entry of streams) {
      if (entry.size <= 0 || entry.size >= MINI_STREAM_CUTOFF) continue;
      const expected = Math.ceil(entry.size / MINI_SECTOR_SIZE);
      invalid(isRegularSector(entry.start) && entry.start < rootMiniCount,
        'mini stream 시작 섹터가 올바르지 않아요.');
      const owner = nextOwner++;
      const chain = [];
      let miniSector = entry.start;
      for (let index = 0; index < expected; index++) {
        invalid(miniSector < rootMiniCount && miniOwners[miniSector] === -1,
          'mini stream 체인이 겹치거나 범위를 벗어났어요.');
        miniOwners[miniSector] = owner;
        chain.push(miniSector);
        const following = miniFatValues[miniSector];
        if (index === expected - 1) {
          invalid(following === ENDOFCHAIN, 'mini stream 체인 길이가 선언된 크기와 달라요.');
        } else {
          invalid(isRegularSector(following) && following < rootMiniCount,
            'mini stream 체인이 선언된 크기보다 짧아요.');
          miniSector = following;
        }
      }
      miniChains.set(entry.id, chain);
    }
    for (let index = 0; index < rootMiniCount; index++) {
      if (miniFatValues[index] !== FREESECT) {
        invalid(miniOwners[index] !== -1, '어떤 스트림에도 속하지 않는 mini 섹터가 있어요.');
      }
    }

    for (let sectorId = 0; sectorId < sectorCount; sectorId++) {
      const allocation = fatAt(sectorId);
      if (allocation === FREESECT) {
        invalid(owners[sectorId] === -1, 'FREE 섹터가 체인에 포함되어 있어요.');
      } else {
        invalid(owners[sectorId] !== -1, '어떤 체인에도 속하지 않는 할당 섹터가 있어요.');
      }
    }

    const fileHeader = fileHeaders[0];
    const headerMiniChain = miniChains.get(fileHeader.id);
    invalid(headerMiniChain?.length === 4, 'FileHeader mini stream 체인이 올바르지 않아요.');
    const headerChunks = [];
    for (const miniSector of headerMiniChain) {
      const logicalOffset = miniSector * MINI_SECTOR_SIZE;
      const rootSectorIndex = Math.floor(logicalOffset / SECTOR_SIZE);
      const offsetInSector = logicalOffset % SECTOR_SIZE;
      invalid(rootSectorIndex < rootChain.length && offsetInSector + MINI_SECTOR_SIZE <= SECTOR_SIZE,
        'FileHeader가 루트 mini stream 범위를 벗어났어요.');
      const physicalOffset = (rootChain[rootSectorIndex] + 1) * SECTOR_SIZE + offsetInSector;
      headerChunks.push(await checkedRead(physicalOffset, MINI_SECTOR_SIZE));
    }
    const hwpHeader = Buffer.concat(headerChunks, 256);
    invalid(hwpHeader.length === 256 && hwpHeader.subarray(0, HWP_SIGNATURE.length).equals(HWP_SIGNATURE)
      && hwpHeader.subarray(HWP_SIGNATURE.length, 32).every(value => value === 0),
    'HWP FileHeader 서명이 올바르지 않아요.');
    const hwpVersion = hwpHeader.readUInt32LE(32);
    unsupported(((hwpVersion >>> 24) & 0xff) === 5, 'HWP 문서 형식 5만 지원해요.');
    const hwpFlags = hwpHeader.readUInt32LE(36);
    unsupported((hwpFlags & HWP_PROTECTED_FLAGS) === 0, '암호화·배포·DRM 보호 HWP는 지원하지 않아요.');
    unsupported((hwpFlags & 0xfffc0000) === 0, '알 수 없는 HWP FileHeader 속성이 있어요.');
    structuralHash.update(hwpHeader);

    return {
      state: 'complete',
      length,
      extension: 'hwp',
      kind: 'document',
      validation: 'hwp5-cfb-allocation-chains',
      validationScope: 'container-and-stream-allocation',
      originalLengthKnown: false,
      structuralSha256: structuralHash.digest('hex'),
    };
  } catch (error) {
    if (error instanceof ReadFailure) throw error.error;
    if (error instanceof ValidationStop) return { state: error.state, reason: error.reason };
    return { state: 'invalid', reason: 'HWP 컨테이너 구조를 확인하지 못했어요.' };
  }
}
