import { stat as statPath } from 'node:fs/promises';
import { readLayerFingerprint } from './windows-device.mjs';

const UNKNOWN = 'unknown';

function diskIds(value) {
  return [...new Set((Array.isArray(value) ? value : value == null ? [] : [value]).map(String))]
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

function observed(row, names) {
  for (const name of names) {
    const value = row?.[name];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return UNKNOWN;
}

function serialNumber(value) {
  if (typeof value === 'bigint') return value.toString();
  return Number.isFinite(value) ? Number(value) : value;
}

function physicalIdentities(row) {
  const explicit = row?.physicalDiskIdentities;
  if (explicit != null) return diskIds(explicit).filter(value => value && value !== UNKNOWN);
  return [...new Set((Array.isArray(row?.physicalDisks) ? row.physicalDisks : [])
    .map(disk => String(disk?.identity ?? '').trim()).filter(value => value && value !== UNKNOWN))].sort();
}

function isFileBackedVirtual(row) {
  const interfaces = [row?.interface, row?.interfaceType, row?.busType,
    ...(Array.isArray(row?.physicalDiskInterfaces) ? row.physicalDiskInterfaces : []),
    ...(Array.isArray(row?.physicalDisks) ? row.physicalDisks.map(disk => disk?.interface) : [])];
  return interfaces.some(value => typeof value === 'string' && value.trim().toLowerCase() === 'file backed virtual');
}

function sectorProfile(logical, physical) {
  if (!Number.isSafeInteger(logical) || !Number.isSafeInteger(physical)) return UNKNOWN;
  if (logical === 512 && physical === 512) return '512n';
  if (logical === 512 && physical === 4096) return '512e';
  if (logical === 4096 && physical === 4096) return '4Kn';
  return 'unsupported';
}

function sourceSnapshot(source, current = source?.device, sourceDiskIds = []) {
  const base = {
    label: source.label,
    kind: source.kind,
    diskIds: diskIds(sourceDiskIds),
    identityStatus: 'unknown'
  };
  if (source.kind === 'volume') {
    return {
      ...base,
      sourceType: 'live-volume',
      driveLetter: current?.driveLetter ?? source.device?.driveLetter ?? null,
      fileSystem: current?.fileSystem ?? source.device?.fileSystem ?? UNKNOWN,
      size: serialNumber(current?.size ?? source.device?.size ?? UNKNOWN),
      system: Boolean(current?.system ?? source.device?.system),
      ready: current?.ready === undefined ? UNKNOWN : Boolean(current.ready),
      scope: current?.scope ?? 'volume',
      physicalDisks: Array.isArray(current?.physicalDisks) ? current.physicalDisks : [],
      physicalDiskIdentity: observed(current, ['physicalDiskIdentity']),
      physicalDiskModel: observed(current, ['physicalDiskModel']),
      partitionOffset: serialNumber(observed(current, ['partitionOffset', 'startingOffset'])),
      partitionNumber: serialNumber(observed(current, ['partitionNumber'])),
      partitionSize: serialNumber(observed(current, ['partitionSize', 'rawVolumeSize'])),
      sourceTopology: observed(current, ['sourceTopology']),
      logicalSectorSize: serialNumber(observed(current, ['logicalSectorSize', 'sectorSize', 'bytesPerSector'])),
      physicalSectorSize: serialNumber(observed(current, ['physicalSectorSize', 'physicalBytesPerSector'])),
      sectorProfile: observed(current, ['sectorProfile']),
      encryption: observed(current, ['encryption', 'encryptionStatus', 'bitLockerStatus']),
      interface: observed(current, ['interface', 'interfaceType', 'busType'])
    };
  }
  return {
    ...base,
    sourceType: source.kind === 'image' ? 'file-image'
      : source.kind === 'folder' ? 'folder-copy-source'
        : source.kind === 'document' ? 'document-file' : 'virtual-source',
    path: source.path ?? null
  };
}

function addCheck(checks, id, title, status, detail) {
  checks.push({ id, title, status, detail });
}

function sameDisk(left, right) {
  const rightSet = new Set(right);
  return left.some(id => rightSet.has(id));
}

function storageRelation(sourceDiskIds, sourcePhysicalIdentities, target) {
  const targetDiskIds = diskIds(target?.diskIds);
  const targetPhysicalIdentities = physicalIdentities(target);
  if (sameDisk(sourceDiskIds, targetDiskIds) || sameDisk(sourcePhysicalIdentities, targetPhysicalIdentities)) return 'same';
  if (isFileBackedVirtual(target)) return 'unknown';
  if (!sourceDiskIds.length || !targetDiskIds.length) return 'unknown';
  return 'separate';
}

function identityFor(info) {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}`;
}

function safeMessage(error, fallback) {
  return typeof error?.message === 'string' && error.message.trim() ? error.message : fallback;
}

function layerFields(row) {
  return {
    physicalDisk: diskIds(row?.diskIds).length ? diskIds(row.diskIds).join(', ') : UNKNOWN,
    physicalDiskIdentity: observed(row, ['physicalDiskIdentity']),
    physicalDiskModel: observed(row, ['physicalDiskModel']),
    partitionOffset: observed(row, ['partitionOffset', 'startingOffset']),
    partitionSize: observed(row, ['partitionSize', 'rawVolumeSize']),
    logicalSectorSize: observed(row, ['logicalSectorSize', 'sectorSize', 'bytesPerSector']),
    physicalSectorSize: observed(row, ['physicalSectorSize', 'physicalBytesPerSector']),
    fileSystem: observed(row, ['fileSystem']),
    encryption: observed(row, ['encryption', 'encryptionStatus', 'bitLockerStatus']),
    interface: observed(row, ['interface', 'interfaceType', 'busType']),
    scope: observed(row, ['scope']),
    sourceTopology: observed(row, ['sourceTopology'])
  };
}

function acquisitionGeometry(row) {
  const logicalSectorSize = serialNumber(observed(row, ['logicalSectorSize', 'sectorSize', 'bytesPerSector']));
  const physicalSectorSize = serialNumber(observed(row, ['physicalSectorSize', 'physicalBytesPerSector']));
  // Treat the measured sector sizes as the authority.  A supplied profile is
  // useful evidence to retain, but it cannot turn missing geometry into a
  // supported read layer or override a contradictory 512e/4Kn declaration.
  const measuredProfile = sectorProfile(logicalSectorSize, physicalSectorSize);
  const declaredProfile = observed(row, ['sectorProfile']);
  const profileConflict = declaredProfile !== UNKNOWN && declaredProfile !== measuredProfile;
  const profile = profileConflict ? 'unsupported' : measuredProfile;
  return {
    status: profile === UNKNOWN ? 'unknown' : ['512n', '512e', '4Kn'].includes(profile) ? 'supported' : 'unsupported',
    profile,
    logicalSectorSize,
    physicalSectorSize,
    declaredProfile,
    profileConflict
  };
}

function acquisitionTopology(row) {
  const kind = observed(row, ['sourceTopology']);
  const hasOffset = Number.isSafeInteger(row?.partitionOffset ?? row?.startingOffset) && (row.partitionOffset ?? row.startingOffset) >= 0;
  const partitionSize = row?.partitionSize ?? row?.rawVolumeSize;
  const hasPartitionSize = Number.isSafeInteger(partitionSize) && partitionSize > 0;
  if (kind === 'single-partition-single-disk' && hasOffset && hasPartitionSize) return { status: 'supported', kind, partitionSize };
  if (kind === 'multi-partition-or-disk') return { status: 'unsupported', kind };
  return { status: 'unknown', kind };
}

/**
 * Produces a metadata-only readiness report. It never opens a raw device, starts
 * a worker, creates a file, requests elevation, or claims image acquisition.
 */
export async function inspectSourceReadiness({
  source,
  workspacePath,
  destination = null,
  inventory,
  inspect,
  runtimePaths = [],
  stat = statPath,
  now = () => new Date()
}) {
  const checkedAt = (typeof now === 'function' ? now() : now);
  const checks = [];
  const limits = [];
  let currentSource = source?.kind === 'volume' ? null : source?.device ?? null;
  let sourceDiskIds = [];
  let sourcePhysicalIdentities = [];
  let sourceIdentityStatus = 'unknown';
  let observedFileSize = null;
  let workspaceSeparation = 'unknown';
  let destinationSeparation = destination ? 'unknown' : 'missing';
  const runtimeLocations = [];

  if (source.kind === 'volume') {
    let devices;
    try {
      devices = await inventory();
      currentSource = devices.find(device => String(device.id).toLowerCase() === String(source.device?.id).toLowerCase()) ?? null;
      if (!currentSource) {
        const identityMatches = devices.filter(device => device.identity === source.identity);
        currentSource = identityMatches.length === 1 ? identityMatches[0] : null;
      }
    } catch (failure) {
      addCheck(checks, 'source-identity', '원본 장치 재확인', 'blocked', `장치 목록을 새로 확인하지 못했습니다: ${safeMessage(failure, 'inventory failed')}`);
    }
    if (devices) {
      if (!currentSource) {
        addCheck(checks, 'source-identity', '원본 장치 재확인', 'blocked', '선택한 볼륨이 현재 장치 목록에 없습니다. 분리되었을 수 있습니다.');
        sourceIdentityStatus = 'unavailable';
      } else if (currentSource.identity !== source.identity || readLayerFingerprint(currentSource) !== readLayerFingerprint(source.device)) {
        addCheck(checks, 'source-identity', '원본 장치 재확인', 'blocked', '볼륨 식별 정보, 물리 장치 또는 파티션·섹터 정보가 선택 당시와 달라 다시 선택해야 합니다.');
        sourceIdentityStatus = 'changed';
      } else {
        addCheck(checks, 'source-identity', '원본 장치 재확인', 'pass', '현재 장치의 식별 정보가 선택 당시와 같습니다.');
        sourceIdentityStatus = 'current';
      }
    }
    sourceDiskIds = diskIds(currentSource?.diskIds);
    sourcePhysicalIdentities = physicalIdentities(currentSource);
    if (currentSource) {
      const locked = observed(currentSource, ['encryption', 'encryptionStatus', 'bitLockerStatus']) === 'locked';
      addCheck(checks, 'source-ready', '원본 준비 상태', currentSource.ready === true && !locked ? 'pass' : 'blocked',
        currentSource.ready === true && !locked ? 'Windows가 볼륨을 준비된 상태로 보고했습니다.' : `Windows가 볼륨을 준비되지 않은 상태로 보고했습니다${locked ? ' (LOCKED)' : currentSource.reason ? ` (${currentSource.reason})` : ''}.`);
      const fields = layerFields(currentSource);
      const missing = Object.entries(fields).filter(([, value]) => value === UNKNOWN).map(([name]) => name);
      const fieldLabels = { physicalDisk: '물리 디스크', physicalDiskIdentity: '물리 디스크 식별자', physicalDiskModel: '물리 디스크 모델', partitionOffset: '파티션 시작 위치', partitionSize: '파티션 길이', logicalSectorSize: '논리 섹터 크기', physicalSectorSize: '물리 섹터 크기', fileSystem: '파일시스템', encryption: '암호화 상태', interface: '연결 방식', scope: '수집 범위', sourceTopology: '원본 토폴로지' };
      addCheck(checks, 'device-layer', '장치·읽기 계층 관측', missing.length ? 'unknown' : 'pass',
        missing.length ? `현재 장치 목록만으로 확인하지 못한 항목: ${missing.map(name => fieldLabels[name]).join(', ')}.` : '물리 디스크, 파티션 시작점, 섹터 크기, 파일시스템, 암호화, 인터페이스 정보를 관측했습니다.');
    } else {
      addCheck(checks, 'source-ready', '원본 준비 상태', 'blocked', '현재 원본 볼륨의 준비 상태를 확인할 수 없습니다.');
      addCheck(checks, 'device-layer', '장치·읽기 계층 관측', 'unknown', '현재 원본 장치가 없어 읽기 계층 정보를 확인하지 못했습니다.');
    }
    limits.push('앱의 읽기 전용 경로는 운영체제, 파일시스템, 다른 프로그램, SSD 컨트롤러의 원본 쓰기나 내부 상태 변화를 중지시키지 않습니다.');
  } else if (['image', 'folder', 'document'].includes(source.kind)) {
    try {
      const current = await stat(source.path, { bigint: true });
      if (source.kind === 'image' && current.size <= BigInt(Number.MAX_SAFE_INTEGER)) observedFileSize = Number(current.size);
      if (identityFor(current) === source.identity) {
        sourceIdentityStatus = 'current';
        addCheck(checks, 'source-identity', '원본 경로 재확인', 'pass', '선택한 경로의 기본 파일시스템 식별 정보가 선택 당시와 같습니다.');
      } else {
        sourceIdentityStatus = 'changed';
        addCheck(checks, 'source-identity', '원본 경로 재확인', 'blocked', '선택한 파일 또는 폴더의 기본 식별 정보가 바뀌었습니다. 다시 선택해야 합니다.');
      }
    } catch (failure) {
      sourceIdentityStatus = 'unavailable';
      addCheck(checks, 'source-identity', '원본 경로 재확인', 'blocked', `선택한 파일 또는 폴더를 다시 확인하지 못했습니다: ${safeMessage(failure, 'path unavailable')}`);
    }
    try {
      const sourceLocation = await inspect(source.path);
      sourceDiskIds = diskIds(sourceLocation.diskIds);
      sourcePhysicalIdentities = physicalIdentities(sourceLocation);
    } catch {
      sourceDiskIds = [];
    }
    if (source.kind === 'image') {
      addCheck(checks, 'image-verification', '이미지 검증 범위', 'unknown', '파일 이미지 경로만 확인했습니다. 전체 이미지 해시, 수집 범위, 읽기 오류 구간, 수집 이력은 검증하지 않았습니다.');
      limits.push('이 보고서는 이미지 수집 또는 포렌식 이미지의 완전성 검증을 수행하지 않습니다.');
    } else if (source.kind === 'folder') {
      addCheck(checks, 'folder-consistency', '폴더 복사 원본 상태', 'warning', '폴더 루트의 선택 상태만 확인했습니다. 하위 파일은 운영체제나 다른 프로그램에 의해 계속 바뀔 수 있습니다.');
      limits.push('폴더 복사 준비도는 삭제 영역이나 미할당 공간을 보존하는 이미지 수집을 대신하지 않습니다.');
    } else {
      addCheck(checks, 'document-consistency', '문서 파일 상태', 'warning', '선택한 문서 파일의 기본 식별 정보만 확인했습니다. 전체 파일 해시나 응용 프로그램 수준 유효성은 검증하지 않았습니다.');
    }
  } else {
    addCheck(checks, 'source-identity', '원본 재확인', 'unknown', '이 원본 종류의 물리 장치 관계를 이 준비도 검사에서 확인할 수 없습니다.');
  }

  let workspaceInfo = null;
  try { workspaceInfo = await inspect(workspacePath); } catch { /* reported below */ }
  const workspaceDiskIds = diskIds(workspaceInfo?.diskIds);
  workspaceSeparation = storageRelation(sourceDiskIds, sourcePhysicalIdentities, workspaceInfo);
  if (workspaceSeparation === 'unknown') {
    addCheck(checks, 'workspace-separation', '원본과 작업 공간 분리', 'unknown', '원본과 작업 공간의 물리 디스크 관계를 확인할 수 없어 준비 완료로 판단하지 않습니다.');
  } else if (workspaceSeparation === 'same') {
    addCheck(checks, 'workspace-separation', '원본과 작업 공간 분리', source.kind === 'volume' ? 'blocked' : 'warning',
      source.kind === 'volume' ? '원본 볼륨과 작업 공간이 같은 물리 디스크에 있습니다.' : '파일 또는 폴더 원본과 작업 공간이 같은 물리 디스크에 있습니다. 원본 경로는 읽기 전용으로 유지해야 합니다.');
  } else {
    addCheck(checks, 'workspace-separation', '원본과 작업 공간 분리', 'pass', '원본과 작업 공간이 서로 다른 것으로 식별된 물리 디스크에 있습니다.');
  }

  let destinationReport = null;
  if (!destination) {
    addCheck(checks, 'destination-selection', '출력 위치 선택', 'warning', '출력 위치가 아직 없습니다. 삭제 목록 검색은 가능하지만 복구 출력의 분리는 검증하지 못했습니다.');
  } else {
    let currentDestination = null;
    try { currentDestination = await inspect(destination.path); } catch (failure) {
      addCheck(checks, 'destination-identity', '출력 위치 재확인', 'blocked', `출력 위치를 다시 확인하지 못했습니다: ${safeMessage(failure, 'destination unavailable')}`);
    }
    const destinationDiskIds = diskIds(currentDestination?.diskIds);
    destinationSeparation = storageRelation(sourceDiskIds, sourcePhysicalIdentities, currentDestination);
    destinationReport = {
      label: destination.label,
      path: destination.path,
      diskIds: destinationDiskIds,
      physicalDiskIdentities: physicalIdentities(currentDestination),
      fileSystem: currentDestination?.fileSystem ?? destination.info?.fileSystem ?? UNKNOWN,
      freeSpace: serialNumber(currentDestination?.freeSpace ?? destination.info?.freeSpace ?? UNKNOWN),
      interface: observed(currentDestination, ['interface', 'interfaceType', 'busType']),
      virtualBackingStatus: isFileBackedVirtual(currentDestination) ? 'unavailable' : 'not-reported',
      identityStatus: !currentDestination ? 'unavailable'
        : currentDestination.identity === destination.info?.identity && currentDestination.canonicalPath === destination.path ? 'current' : 'changed'
    };
    if (currentDestination) {
      addCheck(checks, 'destination-identity', '출력 위치 재확인', destinationReport.identityStatus === 'current' ? 'pass' : 'blocked',
        destinationReport.identityStatus === 'current' ? '출력 위치의 식별 정보가 선택 당시와 같습니다.' : '출력 위치가 선택 당시와 달라 다시 선택해야 합니다.');
    }
    if (isFileBackedVirtual(currentDestination)) {
      addCheck(checks, 'destination-virtual-backing', '가상 출력 장치 backing 확인', 'unknown', '가상 출력 장치의 실제 backing 물리 디스크를 현재 메타데이터로 확인하지 못했습니다.');
    }
    if (destinationSeparation === 'unknown') {
      addCheck(checks, 'destination-separation', '원본과 출력 위치 분리', 'unknown', '원본과 출력 위치의 물리 디스크 관계를 확인할 수 없어 준비 완료로 판단하지 않습니다.');
    } else if (destinationSeparation === 'same') {
      addCheck(checks, 'destination-separation', '원본과 출력 위치 분리', source.kind === 'volume' ? 'blocked' : 'warning',
        source.kind === 'volume' ? '드라이브 문자나 경로가 달라도 원본 볼륨과 출력 위치가 같은 물리 디스크에 있습니다.' : '파일 또는 폴더 원본과 출력 위치가 같은 물리 디스크에 있습니다. 원본 경로를 덮어쓰지 않는지 별도로 확인해야 합니다.');
    } else {
      addCheck(checks, 'destination-separation', '원본과 출력 위치 분리', 'pass', '원본과 출력 위치가 서로 다른 것으로 식별된 물리 디스크에 있습니다.');
    }
  }

  for (const [index, entry] of (Array.isArray(runtimePaths) ? runtimePaths : []).entries()) {
    const purpose = typeof entry?.purpose === 'string' && entry.purpose.trim() ? entry.purpose.trim() : `runtime-${index + 1}`;
    const requestedPath = typeof entry?.path === 'string' ? entry.path : '';
    const access = entry?.access === 'read-only' ? 'read-only' : 'writable';
    const checkId = `runtime-separation-${index + 1}`;
    let current = null;
    try { current = requestedPath ? await inspect(requestedPath) : null; } catch { /* reported below */ }
    const identityStatus = !current ? 'unavailable' : entry?.identity == null ? 'observed' : current.identity === entry.identity ? 'current' : 'changed';
    const relation = storageRelation(sourceDiskIds, sourcePhysicalIdentities, current);
    runtimeLocations.push({
      purpose, path: requestedPath, access,
      canonicalPath: current?.canonicalPath ?? null,
      diskIds: diskIds(current?.diskIds),
      physicalDiskIdentities: physicalIdentities(current),
      identity: current?.identity ?? null,
      identityStatus,
      separation: relation,
      checkId
    });
    if (!current) {
      addCheck(checks, checkId, `${purpose} 위치 분리`, 'blocked', `${purpose} 위치를 다시 확인하지 못했습니다.`);
    } else if (identityStatus === 'changed') {
      addCheck(checks, checkId, `${purpose} 위치 분리`, 'blocked', `${purpose} 위치의 저장 장치 식별 정보가 바뀌었습니다.`);
    } else if (relation === 'unknown') {
      addCheck(checks, checkId, `${purpose} 위치 분리`, 'unknown', `${purpose} 위치와 원본의 물리 디스크 관계를 확인할 수 없습니다.`);
    } else if (relation === 'same') {
      addCheck(checks, checkId, `${purpose} 위치 분리`, source.kind === 'volume' ? 'blocked' : 'warning',
        source.kind === 'volume' ? `${purpose} 위치가 원본 볼륨과 같은 물리 디스크에 있습니다.` : `${purpose} 위치가 파일 또는 폴더 원본과 같은 물리 디스크에 있습니다.`);
    } else {
      addCheck(checks, checkId, `${purpose} 위치 분리`, 'pass', `${purpose} 위치가 원본과 다른 것으로 식별된 물리 디스크에 있습니다.`);
    }
  }

  const sourceReport = sourceSnapshot(source, currentSource, sourceDiskIds);
  if (source.kind === 'image' && observedFileSize !== null) sourceReport.size = observedFileSize;
  sourceReport.identityStatus = sourceIdentityStatus;
  const geometry = acquisitionGeometry(currentSource);
  const sourceTopology = acquisitionTopology(currentSource);
  const reasons = [];
  const addReason = (code, detail) => { if (!reasons.some(reason => reason.code === code)) reasons.push({ code, detail }); };
  if (source.kind !== 'volume') addReason('SOURCE_SCOPE_UNSUPPORTED', '이 수집 게이트는 실제 Windows 볼륨 원본만 다룹니다.');
  if (source.kind === 'volume') {
    if (sourceIdentityStatus !== 'current') addReason('SOURCE_IDENTITY_NOT_CURRENT', '현재 원본 식별 정보가 선택 당시와 일치하지 않습니다.');
    const encryption = observed(currentSource, ['encryption', 'encryptionStatus', 'bitLockerStatus']);
    if (encryption === 'locked') addReason('SOURCE_LOCKED', '암호화 볼륨이 잠겨 있습니다.');
    else if (currentSource?.ready !== true) addReason('SOURCE_NOT_READY', 'Windows가 원본 볼륨을 준비된 상태로 보고하지 않았습니다.');
    const physicalDisks = Array.isArray(currentSource?.physicalDisks) ? currentSource.physicalDisks : [];
    const stablePhysicalIdentity = physicalDisks.length === 1 && ['unique-id', 'serial-number'].includes(physicalDisks[0]?.identityKind)
      && physicalDisks[0]?.identity && physicalDisks[0].identity !== UNKNOWN;
    if (!stablePhysicalIdentity) addReason('PHYSICAL_DISK_IDENTITY_UNKNOWN', '단일 물리 디스크의 고유 ID 또는 일련번호를 확인하지 못했습니다.');
    if (isFileBackedVirtual(currentSource)) addReason('SOURCE_VIRTUAL_BACKING_UNKNOWN', '가상 원본 장치의 실제 backing 물리 디스크를 확인하지 못해 출력 분리를 증명할 수 없습니다.');
    if (geometry.status === 'unknown') addReason('GEOMETRY_UNKNOWN', '논리·물리 섹터 크기를 확인하지 못했습니다.');
    else if (geometry.status === 'unsupported') addReason('GEOMETRY_UNSUPPORTED', `지원하지 않는 섹터 조합입니다 (${geometry.logicalSectorSize}/${geometry.physicalSectorSize}).`);
    if (sourceTopology.status === 'unknown') addReason('SOURCE_TOPOLOGY_UNKNOWN', '단일 파티션·단일 디스크 원본과 정확한 파티션 길이를 확인하지 못했습니다.');
    else if (sourceTopology.status === 'unsupported') addReason('SOURCE_TOPOLOGY_UNSUPPORTED', '여러 파티션 또는 디스크에 걸친 볼륨 수집은 지원하지 않습니다.');
    if (workspaceSeparation === 'same') addReason('WORKSPACE_SEPARATION_UNSAFE', '작업 공간이 원본과 같은 물리 디스크에 있습니다.');
    else if (workspaceSeparation === 'unknown') addReason('WORKSPACE_SEPARATION_UNKNOWN', '작업 공간과 원본의 물리 분리를 확인하지 못했습니다.');
    if (!destination) addReason('DESTINATION_REQUIRED', '볼륨 수집 출력을 저장할 위치가 필요합니다.');
    else {
      if (destinationReport?.identityStatus !== 'current') addReason('DESTINATION_IDENTITY_CHANGED', '출력 위치의 식별 정보를 다시 확인해야 합니다.');
      if (destinationReport?.virtualBackingStatus === 'unavailable') addReason('DESTINATION_VIRTUAL_BACKING_UNKNOWN', '가상 출력 장치의 실제 backing 물리 디스크를 확인하지 못해 원본과의 분리를 증명할 수 없습니다.');
      if (destinationSeparation === 'same') addReason('DESTINATION_SEPARATION_UNSAFE', '출력 위치가 원본과 같은 물리 디스크에 있습니다.');
      else if (destinationSeparation === 'unknown') addReason('DESTINATION_SEPARATION_UNKNOWN', '출력 위치와 원본의 물리 분리를 확인하지 못했습니다.');
    }
    if (!runtimeLocations.length) addReason('RUNTIME_PATHS_NOT_PROVIDED', '앱·헬퍼·로그·캐시·임시 위치가 제공되지 않았습니다.');
    for (const location of runtimeLocations) {
      if (location.identityStatus === 'changed' || location.identityStatus === 'unavailable') addReason('RUNTIME_IDENTITY_CHANGED', '하나 이상의 실행 위치를 다시 확인하지 못했습니다.');
      if (location.separation === 'same') addReason('RUNTIME_SEPARATION_UNSAFE', '하나 이상의 실행 위치가 원본과 같은 물리 디스크에 있습니다.');
      else if (location.separation === 'unknown') addReason('RUNTIME_SEPARATION_UNKNOWN', '하나 이상의 실행 위치와 원본의 물리 분리를 확인하지 못했습니다.');
    }
  }
  const statuses = checks.map(check => check.status);
  const overall = statuses.includes('blocked') ? 'blocked' : statuses.some(status => status === 'warning' || status === 'unknown') ? 'attention' : 'ready';
  return {
    checkedAt: (checkedAt instanceof Date ? checkedAt : new Date(checkedAt)).toISOString(),
    source: sourceReport,
    workspace: { path: workspacePath, diskIds: workspaceDiskIds, physicalDiskIdentities: physicalIdentities(workspaceInfo), separation: workspaceSeparation },
    destination: destinationReport,
    runtimeLocations,
    acquisition: { scope: source.kind === 'volume' ? 'volume' : 'not-applicable', canAcquire: source.kind === 'volume' && reasons.length === 0, reasons, geometry, sourceTopology },
    checks,
    overall,
    limits
  };
}
