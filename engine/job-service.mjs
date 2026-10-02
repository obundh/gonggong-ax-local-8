import { Worker } from 'node:worker_threads';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, open as openFile, readFile, writeFile, rename, stat, lstat, realpath, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RecoveryError } from './ntfs-image.mjs';
import { filterCandidates, normalizeFilters } from './candidate-filter.mjs';
import { MAX_CARVING_CANDIDATES, MAX_METADATA_CANDIDATES, openCandidateStore, setBoundedCandidate } from './candidate-store.mjs';
import { listWindowsDevices, inspectDestination, WindowsVolumeSession, readLayerFingerprint } from './windows-device.mjs';
import { WorkerVolumeBroker } from './worker-volume.mjs';
import { initialDeletedCoverage } from './native-recovery-adapter.mjs';
import { inspectSourceReadiness } from './source-readiness.mjs';
import { AcquisitionService } from './acquisition-service.mjs';
import { CAPTURE_LIMITS } from './early-capture.mjs';
import { candidateCaptureKey, canOfferEarlierCapture } from './capture-link.mjs';
import { performance } from 'node:perf_hooks';
import { normalizeDeepLimits } from './deep-limits.mjs';
import { discoverAutosaveLocations, prepareAutosaveRoots, validateAutosaveRoots } from './autosave-search.mjs';
import { discoverRecentRoot, prepareRecentRoot } from './recent-traces.mjs';

const activeStates = new Set(['scanning', 'recovering', 'paused', 'cancelling']);
const MAX_RESUME_ROOTS = 128;
const MAX_CHECKPOINT_BYTES = 16 * 1024 * 1024;
const error = (code, message) => { throw new RecoveryError(code, message); };
const inside = (root, leaf) => { const rel = path.relative(root, leaf); return rel && !rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel); };
const samePath = (left, right) => process.platform === 'win32'
  ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase() : path.resolve(left) === path.resolve(right);
const sha256 = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const sameStrings = (left, right) => Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => value === right[index]);
const diskIds = value => [...new Set((Array.isArray(value) ? value : []).map(String))].sort();
const cloneSource = source => ({ ...source,
  device: source?.device ? { ...source.device, diskIds: [...(source.device.diskIds ?? [])],
    physicalDisks: (source.device.physicalDisks ?? []).map(item => ({ ...item })) } : undefined,
  roots: source?.roots ? source.roots.map(item => typeof item === 'object' ? { ...item } : item) : undefined });
const sourceBindingFor = source => {
  if (source?.kind !== 'volume') return null;
  const device = source.device, fingerprint = readLayerFingerprint(device), ids = diskIds(device?.diskIds);
  if (typeof source.identity !== 'string' || !source.identity || typeof device?.id !== 'string' || !device.id
    || device.identity !== source.identity || !ids.length || !fingerprint) return null;
  return { deviceId: device.id, identity: source.identity, diskIds: ids, readLayerFingerprint: fingerprint,
    nativeIdentity: null, openedKey: null, invalid: false };
};

async function canonicalResumeRoots(values) {
  const roots = [];
  const requested = [...new Set(Array.isArray(values) ? values.filter(value => typeof value === 'string' && value) : [])];
  if (requested.length > MAX_RESUME_ROOTS) error('CHECKPOINT_ROOT_LIMIT', '이전 복구 파일 위치가 128곳을 넘어 이어서 검사할 수 없어요. 새 검색을 시작해주세요.');
  for (const value of requested) {
    if (typeof value !== 'string' || !value) continue;
    try {
      const entry = await lstat(value);
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const canonical = await realpath(value);
      if (!roots.includes(canonical)) roots.push(canonical);
    } catch { /* A missing old output cannot be trusted for artifact reuse. */ }
  }
  return roots;
}

async function readTrustedCheckpoint(previous) {
  if (typeof previous?.outputPath !== 'string' || !previous.outputPath || !sha256(previous.checkpointHash)) {
    error('INVALID_CHECKPOINT', '저장된 검색 기록을 확인할 수 없어요. 새 검색을 시작해주세요.');
  }
  const roots = await canonicalResumeRoots([previous.outputPath]);
  if (roots.length !== 1) error('INVALID_CHECKPOINT', '이전 작업 폴더를 확인할 수 없어요. 새 검색을 시작해주세요.');
  const checkpointPath = path.join(roots[0], 'checkpoint.json');
  let info, canonicalCheckpoint;
  try {
    info = await lstat(checkpointPath);
    canonicalCheckpoint = await realpath(checkpointPath);
  } catch { error('INVALID_CHECKPOINT', '저장된 검색 기록을 확인할 수 없어요. 새 검색을 시작해주세요.'); }
  if (!info.isFile() || info.isSymbolicLink() || !inside(roots[0], canonicalCheckpoint) || info.size > MAX_CHECKPOINT_BYTES) {
    error('INVALID_CHECKPOINT', '저장된 검색 기록이 안전한 파일인지 확인할 수 없어요.');
  }
  const bytes = await readFile(canonicalCheckpoint);
  if (createHash('sha256').update(bytes).digest('hex') !== previous.checkpointHash) {
    error('INVALID_CHECKPOINT', '저장된 검색 기록이 변경됐어요. 새 검색을 시작해주세요.');
  }
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { error('INVALID_CHECKPOINT', '저장된 검색 기록을 읽을 수 없어요. 새 검색을 시작해주세요.'); }
}

export class RecoveryJobs {
  constructor({ workspace, onEvent = () => {}, inspect = inspectDestination, inventory = listWindowsDevices,
    volumeSession = new WindowsVolumeSession(), runtimePaths = [], acquisitionOptions = {},
    workerFactory = (url, options) => new Worker(url, options),
    recycleInventory = async () => (await import('./recycle-bin.mjs')).discoverRecycleRoots(),
    autosaveInventory = discoverAutosaveLocations, recentInventory = discoverRecentRoot }) {
    this.workspace = path.resolve(workspace);
    this.onEvent = onEvent;
    this.inspect = inspect;
    this.inventory = inventory;
    this.workerFactory = workerFactory;
    this.volumeSession = volumeSession;
    this.runtimePaths = runtimePaths;
    this.acquisitions = new AcquisitionService(this, acquisitionOptions);
    this.recycleInventory = recycleInventory;
    this.autosaveInventory = autosaveInventory;
    this.recentInventory = recentInventory;
    this.sources = new Map();
    this.destinations = new Map();
    this.jobs = new Map();
    this.pending = new Map();
    this.savedHistory = new Map();
    this.historyWrite = Promise.resolve();
  }
  async initialize() {
    await mkdir(this.workspace, { recursive: true }); this.workspace = await realpath(this.workspace);
    await this.acquisitions.initialize();
    try {
      const file = path.join(this.workspace, 'history.json');
      if ((await stat(file)).size > 2 * 1024 * 1024) return;
      const data = JSON.parse(await readFile(file, 'utf8'));
      if (data.version === 1 && Array.isArray(data.jobs)) for (const entry of data.jobs.slice(-100)) {
        if (typeof entry.id === 'string' && typeof entry.sourceIdentity === 'string') this.savedHistory.set(entry.id, { ...entry, status: activeStates.has(entry.status) ? 'interrupted' : entry.status, requiresSourceSelection: true });
      }
    } catch { /* No prior local history, or an unreadable history, never starts work. */ }
  }
  async devices() {
    const devices = await this.inventory();
    return { devices: devices.map(device => {
      let source = [...this.sources.values()].find(value => value.kind === 'volume' && value.device.id === device.id && value.identity === device.identity && readLayerFingerprint(value.device) === readLayerFingerprint(device));
      if (!source) { source = { id: randomUUID(), kind: 'volume' }; this.sources.set(source.id, source); }
      Object.assign(source, { device, label: device.label, driveLetter: device.driveLetter, identity: device.identity });
      return { id: source.id, kind: source.kind, label: source.label, fileSystem: device.fileSystem, system: device.system, ready: device.ready, reason: device.reason };
    }) };
  }
  async recycleSource() {
    const discovery = await this.recycleInventory();
    const source = { id: randomUUID(), kind: 'recycle', label: '휴지통', roots: discovery.roots,
      warnings: discovery.warnings ?? [], identity: createHash('sha256').update(JSON.stringify(discovery.roots)).digest('hex') };
    this.sources.set(source.id, source);
    return { id: source.id, kind: source.kind, label: source.label, warnings: source.warnings };
  }
  async autosaveSource() {
    const locations = await this.autosaveInventory();
    const roots = await prepareAutosaveRoots(locations);
    const warnings = locations.filter(item => item.error).map(item => ({ code: 'AUTOSAVE_LOCATION_UNREADABLE', message: `${item.app} · ${item.name}: 위치를 확인하지 못했어요.` }));
    const source = { id: randomUUID(), kind: 'autosave', label: 'Office 자동 복구 위치', roots, warnings,
      identity: createHash('sha256').update(JSON.stringify(roots)).digest('hex') };
    this.sources.set(source.id, source);
    return { source: { id: source.id, kind: source.kind, label: source.label }, locations, warnings };
  }
  async recentSource() {
    const location = await this.recentInventory();
    const root = await prepareRecentRoot(location);
    const roots = root ? [root] : [];
    const warnings = location.error ? [{ code: 'RECENT_LOCATION_UNREADABLE', message: '최근 문서 위치를 읽지 못했어요. 흔적이 없다는 뜻은 아니에요.' }] : [];
    const source = { id: randomUUID(), kind: 'recent-traces', label: '최근 문서 이름·경로 흔적', roots, warnings,
      identity: createHash('sha256').update(JSON.stringify(roots)).digest('hex') };
    this.sources.set(source.id, source);
    return { source: { id: source.id, kind: source.kind, label: source.label }, location, warnings };
  }
  async addSource(kind, selectedPath) {
    if (!['folder', 'image', 'document'].includes(kind)) error('SOURCE_KIND', '올바른 원본 종류를 선택해주세요.');
    const resolved = await realpath(selectedPath);
    const info = await stat(resolved, { bigint: true });
    if (kind === 'folder' ? !info.isDirectory() : !info.isFile()) error('SOURCE_KIND', '선택한 원본의 종류가 맞지 않아요.');
    const source = { id: randomUUID(), label: resolved, path: resolved, kind, identity: `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}` };
    this.sources.set(source.id, source);
    return { id: source.id, label: source.label, kind: source.kind };
  }
  async addDestination(selectedPath) {
    const info = await this.inspect(selectedPath);
    const destination = { id: randomUUID(), label: info.canonicalPath, path: info.canonicalPath, info };
    this.destinations.set(destination.id, destination);
    return { id: destination.id, label: destination.label };
  }
  getJob(id) { const job = this.jobs.get(id); if (!job) error('UNKNOWN_JOB', '작업이 만료됐어요. 원본을 다시 선택해주세요.'); return job; }
  busy() { return Boolean(this.starting || this.earlierCaptureReservation) || this.acquisitions.busy() || [...this.jobs.values()].some(job => activeStates.has(job.status) || job.rpcActive); }
  async sourceReadiness({ sourceId, destinationId } = {}) {
    if (this.disposal) error('CANCELLED', '앱을 종료하고 있어요.');
    if (this.busy()) error('BUSY', '현재 작업이 끝난 뒤 원본 준비 상태를 다시 확인해주세요.');
    this.starting = true;
    try {
      const source = this.sources.get(sourceId);
      if (!source) error('SOURCE_REQUIRED', '준비 상태를 확인할 원본을 선택해주세요.');
      const destination = destinationId == null ? null : this.destinations.get(destinationId);
      if (destinationId != null && !destination) error('OUTPUT_REQUIRED', '준비 상태를 확인할 저장 폴더를 다시 선택해주세요.');
      return await inspectSourceReadiness({ source, workspacePath: this.workspace, destination, runtimePaths: this.runtimePaths, inventory: this.inventory, inspect: this.inspect });
    } finally { this.starting = false; }
  }
  async validateCandidateWorkspace(source) {
    if (['autosave', 'recent-traces'].includes(source.kind)) {
      await validateAutosaveRoots(source.roots);
      for (const root of source.roots) if (this.workspace === root.path || inside(root.path, this.workspace)) {
        error('UNSAFE_OUTPUT', '검색할 원본 폴더 밖의 작업 공간을 사용해주세요.');
      }
      return;
    }
    if (source.kind !== 'volume') return;
    const runtime = await this.inspect(this.workspace);
    const sourceDisks = source.device?.diskIds;
    if (!sourceDisks?.length || !runtime.diskIds?.length) error('UNKNOWN_DISK', '후보 목록 저장 위치와 원본 장치의 물리 관계를 확인할 수 없어 검색을 시작하지 않아요.');
    if (sourceDisks.some(id => runtime.diskIds.includes(id))) {
      error('RUNTIME_ON_SOURCE', '후보 목록도 디스크에 저장됩니다. 원본과 다른 물리 디스크의 프로그램 작업 공간을 사용해주세요.');
    }
    return runtime;
  }
  async validateDestination(source, destinationId, size = 0, largest = 0) {
    const chosen = this.destinations.get(destinationId);
    if (!chosen) error('OUTPUT_REQUIRED', '먼저 작업 저장 폴더를 선택해주세요.');
    const current = await this.inspect(chosen.path);
    if (current.identity !== chosen.info.identity || current.canonicalPath !== chosen.path) error('DESTINATION_CHANGED', '저장장치가 바뀌었어요. 다시 선택해주세요.');
    if (source.kind === 'volume') {
      const latest = (await this.inventory()).find(device => device.id === source.device.id);
      if (!latest || latest.identity !== source.identity) error('SOURCE_CHANGED', '원본 장치가 바뀌었거나 분리됐어요.');
      const runtime = await this.inspect(this.workspace);
      const ids = latest.diskIds;
      if (!ids?.length || !current.diskIds?.length || !runtime.diskIds?.length) error('UNKNOWN_DISK', '물리 장치 관계를 확인할 수 없어 저장을 시작하지 않아요.');
      if (ids.some(id => current.diskIds.includes(id))) error('SAME_PHYSICAL_DISK', '원본과 다른 물리 디스크의 저장 폴더를 선택해주세요.');
      if (ids.some(id => runtime.diskIds.includes(id))) error('RUNTIME_ON_SOURCE', '원본 보호를 위해 프로그램 폴더와 작업 공간을 다른 물리 디스크로 옮겨 실행해주세요.');
    }
    if (source.kind === 'autosave') await validateAutosaveRoots(source.roots);
    if (['recycle', 'autosave'].includes(source.kind)) {
      for (const root of source.roots) {
        const canonical = path.resolve(typeof root === 'string' ? root : root.path);
        if ([chosen.path, this.workspace].some(target => target === canonical || inside(canonical, target))) {
          error('UNSAFE_OUTPUT', '검색한 원본 폴더 밖의 저장 폴더와 작업 공간을 사용해주세요.');
        }
      }
    }
    if (Number.isFinite(current.freeSpace) && current.freeSpace < size + 65536) error('OUTPUT_FULL', '저장 공간이 부족해요. 다른 장치를 선택해주세요.');
    if (/^FAT32$/i.test(current.fileSystem ?? '') && largest > 4294967295) error('FILE_SIZE_LIMIT', '이 저장장치는 4GB 이상의 파일을 저장할 수 없어요.');
    return chosen.path;
  }
  async start(request) {
    if (this.disposal) error('CANCELLED', '앱을 종료하고 있어요.');
    if (this.busy()) error('BUSY', '현재 작업을 마치거나 취소한 뒤 시작해주세요.');
    this.starting = true; this.lifecycle = (this.lifecycle ?? 0) + 1;
    try { return await this.startReady(request); } finally { this.starting = false; }
  }
  async startReady(request) {
    const selectedSource = this.sources.get(request?.sourceId);
    if (!selectedSource) error('SOURCE_REQUIRED', '검색할 위치를 선택해주세요.');
    // Device refresh mutates the source catalog.  A job keeps the exact
    // selection made at admission for every later preflight and worker step.
    const source = cloneSource(selectedSource);
    if (!['copies', 'deleted', 'deep', 'salvage', 'recycle', 'autosave', 'traces'].includes(request.mode)) error('INVALID_MODE', '검색 종류를 선택해주세요.');
    if ((source.kind === 'recent-traces') !== (request.mode === 'traces')) error('SOURCE_KIND', '최근 문서 흔적은 이름·경로 확인으로 사용해주세요.');
    if (request.mode === 'traces' && request.destinationId) error('INVALID_MODE', '최근 문서 흔적은 저장할 본문 없이 이름·경로만 확인해요.');
    if ((source.kind === 'autosave') !== (request.mode === 'autosave')) error('SOURCE_KIND', '자동 복구 위치는 자동 저장본 찾기로 확인해주세요.');
    if (request.deepLimits !== undefined && request.mode !== 'deep') error('INVALID_DEEP_LIMITS', '정밀 검색에서만 검색 제한을 설정할 수 있어요.');
    const deepLimits = normalizeDeepLimits(request.deepLimits);
    if ((source.kind === 'recycle') !== (request.mode === 'recycle')) error('SOURCE_KIND', '휴지통 목록은 휴지통 검색으로 확인해주세요.');
    if ((source.kind === 'document') !== (request.mode === 'salvage')) error('SOURCE_KIND', '손상 파일 추출은 파일을 직접 선택해야 해요.');
    if (source.kind === 'folder' && request.mode !== 'copies') error('SOURCE_KIND', '삭제·정밀 검색은 드라이브 또는 이미지 파일을 선택해주세요.');
    if (source.kind === 'image' && request.mode === 'copies') error('SOURCE_KIND', '복사본 검색은 실제 폴더를 선택해주세요.');
    const filters = normalizeFilters(request.filters ?? {});
    const deletedStrategy = request.deletedStrategy ?? 'auto';
    if (!['auto', 'full', 'vacancy', 'journal-full'].includes(deletedStrategy)) error('INVALID_STRATEGY', '기간 검색, 보존 저널 전체 검색, 빈 기록 추가 검색 또는 전체 기록 검색을 선택해주세요.');
    if (['vacancy', 'journal-full'].includes(deletedStrategy) && !(source.kind === 'volume' && String(source.device?.fileSystem ?? '').toUpperCase() === 'NTFS')) {
      error('INVALID_STRATEGY', '보존 저널 전체 검색과 빈 기록 추가 검색은 확인된 Windows NTFS 볼륨에서만 사용할 수 있어요.');
    }
    const coverage = request.mode === 'deleted' ? initialDeletedCoverage({ source, deletedStrategy, filters }) : null;
    const periodFirst = coverage?.strategy === 'journal-first';
    const deepScope = request.deepScope === 'whole' ? 'whole' : 'unallocated';
    let resumeCheckpoint;
    let resumeRoots = [];
    if (request.resumeId) {
      const inMemory = this.jobs.get(request.resumeId);
      if (inMemory?.persistTask) await inMemory.persistTask;
      const previous = this.savedHistory.get(request.resumeId) ?? (inMemory ? {
        mode: inMemory.mode, deepScope: inMemory.deepScope, sourceIdentity: inMemory.source.identity,
        sourceKind: inMemory.source.kind, outputPath: inMemory.outputPath, checkpointHash: inMemory.checkpointHash,
        resumeRoots: inMemory.resumeRoots,
      } : null);
      if (!previous || previous.sourceIdentity !== source.identity || previous.sourceKind !== source.kind) error('SOURCE_CHANGED', '이전 작업과 같은 원본을 다시 선택해야 해요.');
      if (request.mode === 'deep') {
        if (previous.mode !== 'deep' || source.kind !== 'image') error('INVALID_CHECKPOINT', '이미지 정밀 검색 기록만 이어서 검사할 수 있어요.');
        if (previous.deepScope !== deepScope) error('CHECKPOINT_SCOPE_CHANGED', '이전 정밀 검색과 같은 검색 범위를 선택해야 이어서 검사할 수 있어요.');
        resumeCheckpoint = await readTrustedCheckpoint(previous);
        if (resumeCheckpoint?.version !== 1 || resumeCheckpoint.kind !== 'carving') error('INVALID_CHECKPOINT', '정밀 검색 재개 기록의 형식이 맞지 않아요.');
        resumeRoots = await canonicalResumeRoots(Array.isArray(previous.resumeRoots) ? previous.resumeRoots : [previous.outputPath]);
      } else if (!periodFirst && source.kind === 'image' && request.mode === 'deleted' && previous.checkpointHash) {
        resumeCheckpoint = await readTrustedCheckpoint(previous);
      }
    }
    const metadataOnly = ['deleted', 'recycle', 'autosave', 'traces'].includes(request.mode) && !request.destinationId;
    // Independent read-only checks overlap, but all must settle successfully
    // before any job directory, worker or privileged connection is created.
    // No validation is cached across searches or skipped on the fast path.
    const id = randomUUID();
    let preparedOpen;
    const preflightStarted = performance.now(), preflight = {};
    const measure = async (key, operation) => {
      const begun = performance.now();
      try { return await operation(); } finally { preflight[key] = performance.now() - begun; }
    };
    try {
      const checks = await Promise.allSettled([
        measure('sourceMs', async () => {
          if (source.kind === 'volume') {
            // The session performs the same fresh validation once for this job.
            // Custom inventories must not silently switch to another enumerator.
            if (this.inventory === this.volumeSession.inventory && typeof this.volumeSession.prepareOpen === 'function') {
              preparedOpen = await this.volumeSession.prepareOpen(source.device, { owner: id });
              return;
            }
            const current = (await this.inventory()).find(item => item.id === source.device.id);
            if (!current || current.identity !== source.identity || readLayerFingerprint(current) !== readLayerFingerprint(source.device)) error('SOURCE_CHANGED', '원본 장치가 바뀌었어요. 다시 선택해주세요.');
          } else if (['autosave', 'recent-traces'].includes(source.kind)) {
            await validateAutosaveRoots(source.roots);
          } else if (source.kind !== 'recycle') {
            const current = await stat(source.path, { bigint: true });
            if (`${current.dev}:${current.ino}:${current.size}:${current.mtimeNs}` !== source.identity) error('SOURCE_CHANGED', '선택한 원본이 바뀌었어요. 다시 선택해주세요.');
          }
        }),
        measure('workspaceMs', () => this.validateCandidateWorkspace(source)),
        measure('destinationMs', async () => metadataOnly ? null : request.mode === 'copies' && !request.destinationId ? this.workspace : this.validateDestination(source, request.destinationId)),
      ]);
      for (const check of checks) if (check.status === 'rejected') throw check.reason;
      if (this.disposal) error('CANCELLED', '앱을 종료하고 있어요.');
      preflight.elapsedMs = performance.now() - preflightStarted;
      const workspaceInfo = checks[1].value, outputBase = checks[2].value;
      const outputPath = outputBase ? path.join(outputBase, `recovery-job-${id}`) : null;
      if (outputPath) await mkdir(outputPath);
      const candidateRoot = path.join(this.workspace, 'candidate-jobs');
      await mkdir(candidateRoot, { recursive: true });
      const canonicalCandidateRoot = await realpath(candidateRoot);
      if (!inside(this.workspace, canonicalCandidateRoot)) error('UNSAFE_OUTPUT', '후보 목록 저장 위치가 작업 공간 밖으로 이어져요.');
      const candidateDirectory = path.join(canonicalCandidateRoot, id);
      await mkdir(candidateDirectory);
      const canonicalCandidateDirectory = await realpath(candidateDirectory);
      if (!inside(canonicalCandidateRoot, canonicalCandidateDirectory)) error('UNSAFE_OUTPUT', '후보 목록 작업 폴더가 저장 위치 밖으로 이어져요.');
      const candidateStorePath = path.join(canonicalCandidateDirectory, 'candidates.sqlite');
      let capture;
      if (request.capture !== false && request.mode === 'deleted' && ['native-journal', 'mft-vacancy'].includes(coverage?.strategy)) {
        const maxBytes = Math.min(CAPTURE_LIMITS.maxBytes, Number.isFinite(workspaceInfo?.freeSpace)
          ? Math.max(0, Math.floor(workspaceInfo.freeSpace - 64 * 1024 * 1024)) : CAPTURE_LIMITS.maxBytes);
        if (maxBytes > 0) {
          const captureRoot = path.join(canonicalCandidateDirectory, 'captured');
          await mkdir(captureRoot);
          if (await realpath(captureRoot) !== captureRoot) error('UNSAFE_OUTPUT', '즉시 확보 위치가 작업 폴더 밖으로 이어져요.');
          capture = { root: captureRoot, limits: { ...CAPTURE_LIMITS, maxBytes } };
        }
      }
      const candidateLimit = request.mode === 'deleted' ? MAX_METADATA_CANDIDATES : MAX_CARVING_CANDIDATES;
      const candidateStore = openCandidateStore(candidateStorePath, { maxCandidates: candidateLimit });
      if (this.disposal) { candidateStore.close(); error('CANCELLED', '앱을 종료하고 있어요.'); }
      const jobSource = source;
      const job = { id, source: jobSource, sourceBinding: sourceBindingFor(jobSource), mode: request.mode, deepLimits, deepScope, resumeRoots, trustedResumeRoots: resumeRoots, deletedStrategy, coverage, recent: ['deleted', 'recycle'].includes(request.mode) && (request.recent === true || periodFirst || coverage?.strategy === 'native-journal'), filters, destinationId: request.destinationId, outputPath, createdAt: new Date().toISOString(),
        status: 'scanning', candidates: candidateStore, candidateStorePath, candidateLimit, results: [], warnings: [], preflight, stats: { preflight }, complete: false, actionEpoch: 0, notifications: request.notifications ?? { mode: 'complete' } };
      // Keep only a bounded number of idle workers. History remains in job folders.
      for (const prior of [...this.jobs.values()].filter(value => !activeStates.has(value.status)).slice(0, Math.max(0, this.jobs.size - 2))) {
        prior.evicted = true; prior.workerStopped = true; prior.actionEpoch = (prior.actionEpoch ?? 0) + 1;
        prior.worker?.postMessage({ type: 'dispose' }); prior.worker?.unref();
        this.jobs.delete(prior.id);
      }
      this.jobs.set(id, job);
      await this.persist(job);
      if (this.disposal) { this.jobs.delete(id); candidateStore.close(); error('CANCELLED', '앱을 종료하고 있어요.'); }
      let worker;
      try {
        worker = this.workerFactory(new URL('./job-worker.mjs', import.meta.url), { workerData: { id, source: jobSource, mode: job.mode, deletedStrategy, recent: job.recent, filters, outputPath, candidateStorePath, candidateLimit, capture, resumeCheckpoint, resumeRoots, deepLimits, salvageKind: request.salvageKind === 'png' ? 'png' : 'document', deepScope, elevate: request.elevate === true, volumeSession: jobSource.kind === 'volume' }, resourceLimits: { maxOldGenerationSizeMb: 384 } });
      } catch (failure) {
        this.jobs.delete(id); candidateStore.close(); throw failure;
      }
      job.worker = worker;
      if (jobSource.kind === 'volume') job.volumeBroker = new WorkerVolumeBroker({
        session: this.volumeSession, device: jobSource.device, elevate: request.elevate === true,
        preparedOpen, owner: id,
        onOpened: info => this.bindOpenedVolume(job, info),
        onPermission: () => this.receive(job, { type: 'progress', stage: 'permission', message: 'Windows 허용 창에서 한 번 허용하면 앱을 닫을 때까지 다시 사용할 수 있어요.' }),
        send: message => worker.postMessage(message)
      });
      preparedOpen = undefined; // The broker now owns consumption and cancellation.
      worker.on('message', event => this.receive(job, event));
      worker.on('error', failure => this.receive(job, { type: 'error', jobId: id, message: failure.message, error: { code: 'WORKER_FAILED', message: failure.message } }));
      worker.on('exit', code => {
        job.workerStopped = true; job.actionEpoch = (job.actionEpoch ?? 0) + 1;
        void job.volumeBroker?.dispose().catch(() => {});
        if (job.evicted) { try { job.candidates.close(); } catch { /* store failure was already surfaced by the worker */ } }
        if (!this.disposal && activeStates.has(job.status)) this.receive(job, { type: 'error', jobId: id, message: '작업 모듈이 중단됐어요.', error: { code: 'WORKER_EXIT', exitCode: code } });
      });
      return { jobId: id, coverage };
    } finally {
      if (preparedOpen) this.volumeSession.revokePreparedOpen(preparedOpen);
    }
  }
  bindOpenedVolume(job, info) {
    const binding = job.sourceBinding;
    // Older test providers and non-native readers do not expose this evidence.
    // They remain usable for their normal job, but cannot offer retained bytes.
    if (!binding) return;
    if (!info || typeof info !== 'object') {
      if (binding.openedKey) {
        binding.invalid = true;
        error('SOURCE_CHANGED', '원본 장치의 연결 근거가 사라졌어요.');
      }
      return;
    }
    const nativeIdentity = typeof info.nativeIdentity === 'string' && info.nativeIdentity ? info.nativeIdentity : null;
    const hasReadLayerEvidence = info.identity !== undefined && info.readLayerFingerprint !== undefined;
    if (hasReadLayerEvidence && (info.identity !== binding.identity || info.readLayerFingerprint !== binding.readLayerFingerprint)) {
      binding.invalid = true;
      error('SOURCE_CHANGED', '원본 장치 연결 정보가 선택한 읽기 계층과 달라 작업을 중단했어요.');
    }
    if (!nativeIdentity || !hasReadLayerEvidence) {
      if (binding.openedKey) {
        binding.invalid = true;
        error('SOURCE_CHANGED', '원본 장치 연결 근거가 작업 중 사라져 이전 확보 본문을 사용하지 않아요.');
      }
      return;
    }
    const openedKey = JSON.stringify({ identity: info.identity, nativeIdentity, readLayerFingerprint: info.readLayerFingerprint });
    if (binding.openedKey && binding.openedKey !== openedKey) {
      binding.invalid = true;
      error('SOURCE_CHANGED', '원본 장치 연결 정보가 작업 중 바뀌었어요. 이전 확보 본문을 사용하지 않아요.');
    }
    binding.nativeIdentity = nativeIdentity;
    binding.openedKey = openedKey;
  }
  liveRetainedJob(job) {
    return Boolean(job && !job.evicted && !job.workerStopped && job.worker && !job.rpcActive && !activeStates.has(job.status));
  }
  captureMetadata(candidate) {
    const preservation = candidate?.preservation;
    if (!canOfferEarlierCapture(candidate) || !sha256(preservation.sha256)
      || preservation.size !== candidate.size || !Number.isSafeInteger(candidate.size) || candidate.size <= 0
      || !Number.isFinite(Date.parse(preservation.capturedAt))) return null;
    return { capturedAt: preservation.capturedAt, sha256: preservation.sha256, size: preservation.size,
      documentStatus: 'preview-available', originalIdentityVerified: false };
  }
  hasSameCapturedBytes(candidate, metadata) {
    const preservation = candidate?.preservation;
    return preservation?.status === 'captured' && sha256(preservation.sha256)
      && preservation.size === candidate.size && Number.isSafeInteger(candidate?.size) && candidate.size > 0
      && preservation.sha256 === metadata?.sha256 && preservation.size === metadata?.size;
  }
  sameBinding(left, right) {
    return Boolean(left && right && !left.invalid && !right.invalid && left.deviceId === right.deviceId
      && left.identity === right.identity && sameStrings(left.diskIds, right.diskIds)
      && left.readLayerFingerprint === right.readLayerFingerprint && left.nativeIdentity
      && left.nativeIdentity === right.nativeIdentity && left.openedKey === right.openedKey);
  }
  earlierCaptureFor(job, candidate) {
    const key = candidateCaptureKey(candidate);
    if (!key || !this.liveRetainedJob(job)) return null;
    const earlier = [...this.jobs.values()].filter(prior => prior.id !== job.id && this.liveRetainedJob(prior)
      && Date.parse(prior.createdAt) < Date.parse(job.createdAt) && this.sameBinding(job.sourceBinding, prior.sourceBinding))
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
    for (const prior of earlier) {
      const old = prior.candidates.get(candidate.id);
      const metadata = this.captureMetadata(old);
      if (metadata && candidateCaptureKey(old) === key) {
        if (this.hasSameCapturedBytes(candidate, metadata)) return null;
        return { jobId: prior.id, ...metadata };
      }
    }
    return null;
  }
  assertActionStillCurrent(current, prior, token) {
    if (this.disposal || (this.lifecycle ?? 0) !== token.lifecycle || current.actionEpoch !== token.currentEpoch || prior.actionEpoch !== token.priorEpoch
      || !this.liveRetainedJob(current) || !this.liveRetainedJob(prior)) error('CANCELLED', '작업 상태가 바뀌어 이전 확보 본문 요청을 취소했어요.');
  }
  async verifyLiveSourceBinding(job, token, inventoryRows) {
    const binding = job.sourceBinding;
    if (!binding || binding.invalid || !binding.openedKey || !binding.nativeIdentity) error('SOURCE_CHANGED', '원본 읽기 계층을 다시 확인하지 못해 이전 확보 본문을 사용하지 않아요.');
    const current = (inventoryRows ?? await this.inventory()).find(device => device.id === binding.deviceId);
    this.assertActionStillCurrent(token.current, token.prior, token);
    if (!current || current.identity !== binding.identity || !sameStrings(diskIds(current.diskIds), binding.diskIds)
      || readLayerFingerprint(current) !== binding.readLayerFingerprint) error('SOURCE_CHANGED', '원본 장치가 바뀌었거나 분리됐어요. 다시 선택해주세요.');
  }
  async resolveEarlierCapture({ jobId, id, earlierJobId }) {
    if (typeof earlierJobId !== 'string' || !earlierJobId || earlierJobId === jobId) error('EARLIER_CAPTURE_UNAVAILABLE', '이전 확보 본문을 다시 확인해주세요.');
    const current = this.getJob(jobId), prior = this.getJob(earlierJobId);
    if (Date.parse(prior.createdAt) >= Date.parse(current.createdAt)) error('EARLIER_CAPTURE_UNAVAILABLE', '현재 작업보다 앞선 확보 본문만 선택할 수 있어요.');
    const currentCandidate = current.candidates.get(id), priorCandidate = prior.candidates.get(id);
    if (!currentCandidate || !priorCandidate) error('EARLIER_CAPTURE_UNAVAILABLE', '이전 확보 본문을 사용할 수 없어요.');
    const key = candidateCaptureKey(currentCandidate), priorKey = candidateCaptureKey(priorCandidate), metadata = this.captureMetadata(priorCandidate);
    if (!key || key !== priorKey || !metadata || this.hasSameCapturedBytes(currentCandidate, metadata) || !this.sameBinding(current.sourceBinding, prior.sourceBinding)) {
      error('EARLIER_CAPTURE_UNAVAILABLE', '현재 후보와 같은 원본 근거를 가진 이전 확보 본문만 사용할 수 있어요.');
    }
    const token = { lifecycle: this.lifecycle ?? 0, current, prior, currentEpoch: current.actionEpoch ?? 0, priorEpoch: prior.actionEpoch ?? 0 };
    this.assertActionStillCurrent(current, prior, token);
    const inventoryRows = await this.inventory();
    this.assertActionStillCurrent(current, prior, token);
    await Promise.all([this.verifyLiveSourceBinding(current, token, inventoryRows), this.verifyLiveSourceBinding(prior, token, inventoryRows)]);
    this.assertActionStillCurrent(current, prior, token);
    return { current, prior, key, metadata, token };
  }
  receive(job, event) {
    if (event.type === 'volume-request' || event.type === 'volume-cancel') { void job.volumeBroker?.handle(event); return; }
    if (job.candidateStoreFailed) return;
    if (event.type === 'checkpoint') { if (job.outputPath) { job.checkpoint = event.checkpoint; job.persistTask = this.persist(job).catch(() => {}); } return; }
    if (event.requestId && this.pending.has(event.requestId)) {
      const pending = this.pending.get(event.requestId); this.pending.delete(event.requestId); clearTimeout(pending.timer);
      if (event.error) pending.reject(Object.assign(new Error(event.error.message), event.error)); else pending.resolve(event.result);
      return;
    }
    if (event.type === 'candidate') {
      try {
        // Real workers commit to the shared per-job store before publishing.
        // Fake/test workers and legacy callers still rely on the service write.
        const alreadyStored = typeof job.candidates.page === 'function' && job.candidates.has(event.candidate?.id);
        if (!alreadyStored && !setBoundedCandidate(job.candidates, event.candidate)) {
          job.complete = false;
          job.warnings = [...job.warnings.filter(w => w.code !== 'CANDIDATE_LIMIT'), {
            code: 'CANDIDATE_LIMIT', message: `분석 후보 ${job.candidateLimit?.toLocaleString?.() ?? ''}개 안전 한도에 도달했어요. 저장소 표시 한도와는 별개이며 검색 범위가 일부 남았습니다.`
          }];
          this.onEvent({ type: 'candidate-limit', jobId: job.id, candidateLimit: job.candidateLimit, message: job.warnings.at(-1).message });
          return;
        }
      } catch (failure) {
        const storageError = { code: failure.code ?? 'CANDIDATE_STORE_FAILED', message: failure.message, details: {} };
        job.candidateStoreFailed = true; job.status = 'error'; job.complete = false; job.error = storageError;
        job.worker?.postMessage({ type: 'cancel' });
        this.onEvent({ type: 'error', jobId: job.id, error: storageError, message: storageError.message });
        job.persistTask = this.persist(job).catch(() => {});
        return;
      }
    }
    if (event.type === 'candidates-removed') {
      for (const id of event.ids) {
        if (typeof job.candidates.deleteIfSource === 'function') job.candidates.deleteIfSource(id, 'existing-file');
        else if (job.candidates.get(id)?.source === 'existing-file') job.candidates.delete(id);
      }
      job.persistTask = this.persist(job).catch(() => {});
    }
    if (event.type === 'candidate-limit') { job.complete = false; job.warnings = [...job.warnings.filter(w => w.code !== 'CANDIDATE_LIMIT'), { code: 'CANDIDATE_LIMIT', message: event.message }]; job.persistTask = this.persist(job).catch(() => {}); }
    if (event.stats) { event.stats = { ...event.stats, preflight: job.preflight }; job.stats = event.stats; }
    if (event.coverage) job.coverage = event.coverage;
    if (event.results) job.results = event.results;
    if (event.type === 'complete') { job.status = 'results'; job.complete = event.complete; job.warnings = event.warnings ?? []; }
    if (event.type === 'recover-complete') job.status = 'complete';
    if (event.type === 'cancelled') job.status = 'cancelled';
    if (event.type === 'error') { job.status = 'error'; job.error = event.error; }
    if (event.type === 'paused') { job.beforePause = job.status; job.status = 'paused'; }
    if (event.type === 'resumed') job.status = job.beforePause ?? 'scanning';
    this.onEvent({ ...event, jobId: job.id });
    if (['complete', 'recover-complete', 'cancelled', 'error'].includes(event.type)) job.persistTask = this.persist(job).catch(() => {});
  }
  candidates({ jobId, offset = 0, limit = 5, filters, sort } = {}) {
    const job = this.getJob(jobId);
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) error('INVALID_PAGE', '목록 범위가 잘못됐어요.');
    const normalized = normalizeFilters(filters ?? job.filters);
    const keepNameMismatches = ['deleted', 'recycle', 'deep'].includes(job.mode);
    const effectiveSort = sort === 'semantic-desc' ? 'name' : sort ?? (normalized.name ? 'score-desc' : undefined);
    let page;
    if (typeof job.candidates.page === 'function') {
      page = job.candidates.page({ offset, limit, filters: normalized, sort: sort === 'semantic-desc' ? 'semantic-desc' : effectiveSort, keepNameMismatches });
    } else {
      const values = filterCandidates([...job.candidates.values()], normalized, { sort: effectiveSort, keepNameMismatches });
      if (sort === 'semantic-desc') values.sort((a, b) => (b.semanticScore ?? -2) - (a.semanticScore ?? -2));
      const matchCounts = { exact: 0, partial: 0, similar: 0, unknown: 0, none: 0 };
      for (const candidate of values) matchCounts[candidate.nameMatch.kind]++;
      page = { items: values.slice(offset, offset + limit), total: values.length, scannedTotal: job.candidates.size, matchCounts,
        unknownDeletedTimeTotal: values.filter(candidate => {
          if (typeof candidate.deletedAt === 'number') return !Number.isFinite(new Date(candidate.deletedAt).getTime());
          return typeof candidate.deletedAt !== 'string' || !candidate.deletedAt.trim() || !Number.isFinite(Date.parse(candidate.deletedAt));
        }).length, offset, limit, hasMore: offset + limit < values.length, nextOffset: offset + limit < values.length ? offset + limit : null };
    }
    const items = page.items.map(candidate => {
      const earlierCapture = this.earlierCaptureFor(job, candidate);
      return { ...candidate, earlierCapture: earlierCapture ?? undefined,
      deletedAtKind: candidate.deletedAtSource === 'recycle-metadata' ? 'recycle-bin-entry'
        : ['ntfs-usn', 'windows-usn'].includes(candidate.deletedAtSource) ? 'final-delete-record' : 'unknown',
      deletedAtLabel: candidate.deletedAtSource === 'recycle-metadata' ? '휴지통에 들어간 시각'
        : ['ntfs-usn', 'windows-usn'].includes(candidate.deletedAtSource) ? '최종 삭제 기록 시각' : '삭제 시각 미확인' };
    });
    return { ...page, items, complete: job.complete, status: job.status, coverage: job.coverage,
      candidateLimit: job.candidateLimit ?? null, storage: typeof job.candidates.page === 'function' ? 'disk' : 'memory' };
  }
  async recover({ jobId, ids, destinationId, earlierJobId } = {}) {
    if (this.disposal) error('CANCELLED', '앱을 종료하고 있어요.');
    if (this.busy()) error('BUSY', '검색 완료 또는 취소 후 선택한 파일을 저장할 수 있어요.');
    this.starting = true;
    try {
      if (earlierJobId === undefined) return await this.recoverReady({ jobId, ids, destinationId });
      if (!Array.isArray(ids) || ids.length !== 1) error('INVALID_SELECTION', '이전 확보 본문은 파일 하나씩 명시적으로 저장할 수 있어요.');
      const linked = await this.resolveEarlierCapture({ jobId, id: ids[0], earlierJobId });
      return await this.recoverReady({ jobId: linked.prior.id, ids, destinationId,
        captureOnly: { key: linked.key, sha256: linked.metadata.sha256, requestedFromJobId: linked.current.id },
        earlierAction: linked });
    } finally { this.starting = false; }
  }
  async recoverReady({ jobId, ids, destinationId, captureOnly, earlierAction } = {}) {
    const job = this.getJob(jobId);
    if (job.mode === 'traces') error('CONTENT_NOT_LOCATED', '최근 문서 흔적에는 저장할 문서 본문이 없어요. 이름·경로만 확인해주세요.');
    if (!Array.isArray(ids) || !ids.length || ids.length > 10000 || new Set(ids).size !== ids.length) error('INVALID_SELECTION', '복구할 파일을 선택해주세요.');
    const files = ids.map(id => { const file = job.candidates.get(id); if (!file) error('UNKNOWN_CANDIDATE', '선택한 파일을 다시 확인해주세요.'); return file; });
    if (files.some(file => ['deletion-trace', 'recycle-metadata', 'directory-slack'].includes(file.source) || file.status === 'metadata-only')) error('CONTENT_NOT_LOCATED', '정보 단서만 남은 항목이에요. 정밀 검색으로 본문을 먼저 찾아주세요.');
    const outputBase = await this.validateDestination(job.source, destinationId ?? job.destinationId, files.reduce((sum, file) => sum + file.size, 0), Math.max(...files.map(file => file.size)));
    job.destinationId = destinationId ?? job.destinationId;
    if (!job.outputPath) {
      job.outputPath = path.join(outputBase, `recovery-job-${job.id}`);
      try { await mkdir(job.outputPath); } catch (failure) { job.outputPath = null; throw failure; }
      await this.persist(job);
    }
    job.resultPath = path.join(outputBase, `recovery-results-${job.id}`);
    try { await mkdir(job.resultPath); } catch (failure) { if (failure.code !== 'EEXIST') throw failure; }
    if ((await lstat(job.resultPath)).isSymbolicLink() || await realpath(job.resultPath) !== job.resultPath) error('UNSAFE_OUTPUT', '결과 폴더의 실제 위치가 바뀌었어요. 다른 저장 위치를 선택해주세요.');
    if (this.disposal) error('CANCELLED', '앱을 종료하고 있어요.');
    if (earlierAction) this.assertActionStillCurrent(earlierAction.current, earlierAction.prior, earlierAction.token);
    job.status = 'recovering';
    job.worker.postMessage({ type: 'recover', ids, outputPath: job.resultPath, jobOutputPath: job.outputPath,
      ...(captureOnly ? { captureOnly } : {}) });
    return { jobId };
  }
  cancel(id) { const job = this.getJob(id); job.actionEpoch = (job.actionEpoch ?? 0) + 1; if (activeStates.has(job.status) || job.rpcActive) { if (!job.rpcActive) job.status = 'cancelling'; job.worker.postMessage({ type: 'cancel' }); } return { jobId: id }; }
  pause(id) { const job = this.getJob(id); if (['scanning', 'recovering'].includes(job.status)) job.worker.postMessage({ type: 'pause' }); return { jobId: id }; }
  resume(id) { const job = this.getJob(id); if (job.status !== 'paused') error('NOT_PAUSED', '일시정지된 작업만 이어갈 수 있어요.'); job.worker.postMessage({ type: 'resume' }); return { jobId: id }; }
  requestWorker(job, type, data = {}, reservationToken) {
    if (['autosave', 'traces'].includes(job.mode) && ['load-index', 'save-index', 'hash', 'semantic'].includes(type)) error('INVALID_MODE', '이 검색에서는 현재 확인한 목록을 사용해주세요. 다른 인덱스와 파일 내용 비교는 지원하지 않아요.');
    if (['save-index', 'semantic'].includes(type) && !job.outputPath) error('OUTPUT_REQUIRED', '파일 목록을 먼저 확인하고 저장할 때 폴더를 선택해주세요.');
    const reservation = this.earlierCaptureReservation;
    if (reservation && (reservationToken !== reservation || type !== 'preview-capture' || job.id !== reservation.priorJobId)) error('BUSY', '이전 확보 본문 확인이 끝난 뒤 다시 시도해주세요.');
    if (job.rpcActive || this.starting) error('BUSY', '내용 확인이 끝난 뒤 다시 시도해주세요.');
    if (!job.worker || job.workerStopped || job.evicted) error('WORKER_STOPPED', '이 작업의 확인 모듈이 종료되어 이전 확보 본문을 사용할 수 없어요.');
    if (type !== 'preview' && type !== 'preview-capture' && this.busy()) error('BUSY', '현재 작업이 끝난 뒤 사용할 수 있어요.');
    if (type === 'preview-capture' && !reservation && this.busy()) error('BUSY', '현재 작업이 끝난 뒤 사용할 수 있어요.');
    job.rpcActive = true;
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); job.worker.postMessage({ type: 'cancel' }); reject(new RecoveryError('OPERATION_TIMEOUT', '처리 시간이 초과되어 중단을 요청했어요.')); }, ['preview', 'preview-capture'].includes(type) ? 20000 : 300000);
      this.pending.set(requestId, { resolve, reject, timer });
      job.worker.postMessage({ type, requestId, ...data });
    }).finally(() => { job.rpcActive = false; });
  }
  async preview({ jobId, id, earlierJobId } = {}) {
    const job = this.getJob(jobId);
    if (!job.candidates.has(id)) error('UNKNOWN_CANDIDATE', '파일을 다시 선택해주세요.');
    if (earlierJobId !== undefined) {
      if (this.busy()) error('BUSY', '현재 작업이 끝난 뒤 이전 확보 본문을 확인해주세요.');
      const reservation = { currentJobId: jobId, priorJobId: earlierJobId };
      this.earlierCaptureReservation = reservation;
      try {
        const linked = await this.resolveEarlierCapture({ jobId, id, earlierJobId });
        const result = await this.requestWorker(linked.prior, 'preview-capture', { id, key: linked.key,
          sha256: linked.metadata.sha256, requestedFromJobId: linked.current.id }, reservation);
        this.assertActionStillCurrent(linked.current, linked.prior, linked.token);
        return { ...result, earlierCapture: { jobId: linked.prior.id, ...linked.metadata } };
      } finally {
        if (this.earlierCaptureReservation === reservation) this.earlierCaptureReservation = null;
      }
    }
    return this.requestWorker(job, 'preview', { id });
  }
  async recoveredPath({ jobId, id }) {
    const job = this.getJob(jobId);
    const result = job.results?.find(item => item.id === id && item.status === 'saved' && item.integrity?.status === 'verified');
    if (!result?.path || !job.resultPath || !inside(job.resultPath, result.path)) error('UNKNOWN_RESULT', '이 작업에서 저장을 확인한 복구본을 선택해주세요.');
    const info = await lstat(result.path);
    const [canonical, root] = await Promise.all([realpath(result.path), realpath(job.resultPath)]);
    if (!info.isFile() || info.isSymbolicLink() || canonical !== result.path || root !== job.resultPath || !inside(root, canonical)) {
      error('UNSAFE_OUTPUT', '복구본의 위치가 바뀌었어요. 결과 폴더를 확인해주세요.');
    }
    return canonical;
  }
  async previewRecovered({ jobId, id }) {
    if (this.busy()) error('BUSY', '현재 작업이 끝난 뒤 복구본을 확인해주세요.');
    const job = this.getJob(jobId);
    await this.recoveredPath({ jobId, id });
    return this.requestWorker(job, 'preview-recovered', { id });
  }
  resultPath({ jobId }) { const job = this.getJob(jobId); return job.resultPath ?? job.outputPath; }
  candidatePath({ jobId, id }) { const candidate = this.getJob(jobId).candidates.get(id); return candidate?.source === 'existing-file' ? candidate.path : null; }
  async exportResults({ jobId }) {
    const job = this.getJob(jobId);
    if (!job.outputPath) error('OUTPUT_REQUIRED', '검색 목록은 작업 공간에 보관되어 있어요. 저장 위치를 선택한 뒤 결과를 내보낼 수 있어요.');
    if (job.source.kind === 'volume') await this.validateDestination(job.source, job.destinationId);
    const target = path.join(job.outputPath, `results-${randomUUID()}.json`);
    const stringify = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item, 2);
    const metadata = { version: 1, createdAt: new Date().toISOString(), mode: job.mode, deepScope: job.deepScope, deepLimits: job.deepLimits, deletedStrategy: job.deletedStrategy,
      coverage: job.coverage, source: job.source.label, stats: job.stats, complete: job.complete, warnings: job.warnings };
    const output = await openFile(target, 'wx');
    const writeChunk = async text => {
      const bytes = Buffer.from(text);
      let offset = 0;
      while (offset < bytes.length) {
        const written = await output.write(bytes, offset, bytes.length - offset, null);
        if (written.bytesWritten < 1) error('WRITE_FAILED', '결과 목록을 끝까지 저장하지 못했어요.');
        offset += written.bytesWritten;
      }
    };
    try {
      const fields = Object.entries(metadata).map(([key, value]) => `  ${JSON.stringify(key)}: ${stringify(value).replace(/\n/g, '\n  ')}`);
      await writeChunk(`{\n${fields.join(',\n')},\n  "candidates": [\n`);
      let first = true;
      for (const candidate of job.candidates.values()) {
        await writeChunk(`${first ? '' : ',\n'}${stringify(candidate).replace(/^/gm, '    ')}`);
        first = false;
      }
      await writeChunk(`\n  ],\n  "results": ${stringify(job.results).replace(/\n/g, '\n  ')}\n}\n`);
    } catch (failure) {
      await output.close().catch(() => {});
      await rm(target, { force: true }).catch(() => {});
      throw failure;
    }
    await output.close();
    return { path: target };
  }
  async persist(job) {
    if (!job.outputPath && !job.candidateStorePath) return;
    job.persistQueue = (job.persistQueue ?? Promise.resolve()).catch(() => {}).then(() => this.writeSnapshot(job));
    return job.persistQueue;
  }
  async writeSnapshot(job) {
    if (!job.outputPath && !job.candidateStorePath) return;
    let checkpointPersistable = Boolean(job.checkpoint && job.outputPath);
    let resumeRoots = [];
    if (job.mode === 'deep' && job.source.kind === 'image' && job.checkpoint?.kind === 'carving') {
      const available = [...new Set([...(job.trustedResumeRoots ?? job.resumeRoots ?? []), job.outputPath].filter(Boolean))];
      const requested = [...new Set((job.checkpoint.candidates ?? []).map(entry => entry?.candidate?.rootPath).filter(value => typeof value === 'string' && value))];
      resumeRoots = requested.map(root => available.find(value => samePath(value, root))).filter(Boolean);
      if (resumeRoots.length !== requested.length || resumeRoots.length > MAX_RESUME_ROOTS) {
        checkpointPersistable = false;
        job.checkpointHash = undefined;
        job.resumeUnavailableReason = resumeRoots.length > MAX_RESUME_ROOTS || requested.length > MAX_RESUME_ROOTS
          ? { code: 'CHECKPOINT_ROOT_LIMIT', message: `이전 복구 파일 위치가 ${MAX_RESUME_ROOTS}곳을 넘어 자동 이어 검사를 저장하지 못했어요.` }
          : { code: 'CHECKPOINT_ROOT_INVALID', message: '이어 검사 기록의 이전 복구 파일 위치를 신뢰할 수 없어 자동 재개를 저장하지 못했어요.' };
        resumeRoots = [];
      } else job.resumeUnavailableReason = undefined;
    }
    job.resumeRoots = resumeRoots;
    if (checkpointPersistable) {
      const serialized = JSON.stringify(job.checkpoint);
      if (Buffer.byteLength(serialized) <= MAX_CHECKPOINT_BYTES) {
        const temp = path.join(job.outputPath, `checkpoint-${randomUUID()}.tmp`);
        await writeFile(temp, serialized, { flag: 'wx' }); await rename(temp, path.join(job.outputPath, 'checkpoint.json'));
        job.checkpointHash = createHash('sha256').update(serialized).digest('hex');
      } else {
        job.checkpointHash = undefined;
        job.resumeUnavailableReason = { code: 'CHECKPOINT_LIMIT', message: '이어 검사 기록이 16MiB 저장 한도를 넘어 자동 재개를 저장하지 못했어요.' };
      }
    }
    const snapshot = { id: job.id, mode: job.mode, deepScope: job.deepScope, deepLimits: job.deepLimits, deletedStrategy: job.deletedStrategy, coverage: job.coverage, recent: job.recent === true, sourceLabel: job.source.label, sourceKind: job.source.kind, sourceIdentity: job.source.identity, createdAt: job.createdAt,
      status: job.status, complete: job.complete, stats: job.stats, candidateCount: job.candidates.size, candidateStorePath: job.candidateStorePath,
      candidateLimit: job.candidateLimit, resultPath: job.resultPath, results: job.results, filters: job.filters, outputPath: job.outputPath,
      checkpointHash: job.checkpointHash, resumeRoots, resumeUnavailableReason: job.resumeUnavailableReason, resumeRequiresSourceSelection: true };
    const stateRoot = job.outputPath ?? path.dirname(job.candidateStorePath);
    const temporary = path.join(stateRoot, `state-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(snapshot, null, 2), { flag: 'wx' });
    await rename(temporary, path.join(stateRoot, 'job.json'));
    this.savedHistory.set(job.id, snapshot);
    while (this.savedHistory.size > 100) this.savedHistory.delete(this.savedHistory.keys().next().value);
    this.historyWrite = this.historyWrite.catch(() => {}).then(async () => {
      const temp = path.join(this.workspace, `history-${randomUUID()}.tmp`);
      await writeFile(temp, JSON.stringify({ version: 1, jobs: [...this.savedHistory.values()] }), { flag: 'wx' });
      await rename(temp, path.join(this.workspace, 'history.json'));
    });
    await this.historyWrite;
  }
  history() {
    const history = new Map(this.savedHistory);
    for (const job of this.jobs.values()) if (!job.outputPath) history.set(job.id, { id: job.id, mode: job.mode, deepScope: job.deepScope, deepLimits: job.deepLimits, deletedStrategy: job.deletedStrategy, coverage: job.coverage, recent: job.recent,
      sourceLabel: job.source.label, sourceKind: job.source.kind, status: job.status, createdAt: job.createdAt,
      candidateCount: job.candidates.size, candidateStorePath: job.candidateStorePath, candidateLimit: job.candidateLimit, filters: job.filters, inMemory: false });
    return { jobs: [...history.values()].reverse().map(job => ({ id: job.id, jobId: job.id, mode: job.mode, deepScope: job.deepScope, deepLimits: job.deepLimits, deletedStrategy: job.deletedStrategy, coverage: job.coverage, recent: job.recent === true,
      label: job.sourceLabel, sourceKind: job.sourceKind, status: this.jobs.get(job.id)?.status ?? job.status, createdAt: job.createdAt,
       candidateCount: job.candidateCount, candidateLimit: job.candidateLimit ?? null, filters: job.filters, inMemory: job.inMemory === true,
       resumeUnavailableReason: job.resumeUnavailableReason,
       canContinue: Boolean(job.checkpointHash && job.sourceKind === 'image' && ['deleted', 'deep'].includes(job.mode)) })),
      workspace: this.workspace, restartPolicy: '후보 목록은 작업 공간의 작업별 저장소에 보관합니다. 체크포인트가 있는 이미지 검색은 같은 원본을 다시 확인하고 이전 복구 파일 위치를 검증한 뒤 이어서 검사하며, 볼륨 또는 체크포인트 없는 작업은 처음부터 다시 검사합니다.' };
  }
  async clearHistory() { if (this.busy()) error('BUSY', '작업 종료 후 기록을 지울 수 있어요.'); await Promise.all([...this.jobs.values()].map(j => j.persistTask)); await this.historyWrite; this.savedHistory.clear(); await writeFile(path.join(this.workspace, 'history.json'), JSON.stringify({ version: 1, jobs: [] })); return { cleared: true, message: '목록 기록만 지웠어요. 복구본과 각 작업 폴더는 유지됩니다.' }; }
  state() { return { ...this.history(), acquisitions: this.acquisitions.list(), capabilities: { deleted: true, recycle: true, copies: true, deep: true, embeddings: false, rawVolumes: process.platform === 'win32', pause: true, imageAcquisition: true,
    candidatePaging: { maximumPageSize: 100, deletedRecordCandidateLimit: MAX_METADATA_CANDIDATES,
      copiesRecycleAndCarvingCandidateLimit: MAX_CARVING_CANDIDATES },
    resumeAfterRestart: 'ntfs-image-or-carving-checkpoint-or-rescan' } }; }
  async cleanup({ jobId, confirmed = false, reviewId }) {
    const job = this.getJob(jobId);
    if (activeStates.has(job.status) || job.rpcActive) error('BUSY', '진행 중인 작업은 정리할 수 없어요.');
    await job.persistQueue;
    const roots = [...new Set([job.outputPath, job.resultPath].filter(Boolean))];
    for (const root of roots) if ((await lstat(root)).isSymbolicLink() || await realpath(root) !== root) error('UNSAFE_OUTPUT', '작업 폴더의 실제 위치가 바뀌었어요.');
    const previewRoot = job.outputPath ? path.join(job.outputPath, 'previews') : null;
    const knownPartial = new Set(job.results.map(result => result.details?.partialPath).filter(Boolean));
    for (const candidate of job.candidates.values()) {
      if (candidate.source === 'carved' && candidate.status === 'partial' && candidate.path) knownPartial.add(candidate.path);
    }
    const files = [];
    const identity = info => `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
    async function visit(directory, root) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (inside(root, await realpath(file))) await visit(file, root);
        } else if (entry.isFile()) {
          const staging = /^\.(recovery-working|recoverychat-writing|carving-writing|recoverychat-salvage-writing)-/.test(path.basename(directory)) && ['.recovery-writing.partial', '.carving-writing.partial', '.writing.partial'].includes(entry.name);
          const metadata = directory === job.outputPath && (/^(state|checkpoint)-[\da-f-]{36}\.tmp$/.test(entry.name) || /^\.file-index\.json\.[\da-f-]{36}\.partial$/.test(entry.name));
          if (!staging && !metadata && !knownPartial.has(file) && !(previewRoot && inside(previewRoot, file))) continue;
          const resolved = await realpath(file);
          const info = await lstat(resolved, { bigint: true });
          if (inside(root, resolved) && info.isFile() && !info.isSymbolicLink()) files.push({ path: resolved, size: Number(info.size), identity: identity(info) });
        }
      }
    }
    if (!confirmed) {
      for (const root of roots) await visit(root, root);
      job.cleanupReview = { id: randomUUID(), files };
    } else {
      const review = job.cleanupReview;
      if (!review || review.id !== reviewId) error('CLEANUP_REVIEW_REQUIRED', '정리할 목록을 먼저 확인해주세요.');
      for (const file of review.files) {
        const resolved = await realpath(file.path), info = await lstat(file.path, { bigint: true });
        if (resolved !== file.path || !roots.some(root => inside(root, resolved)) || !info.isFile() || info.isSymbolicLink() || identity(info) !== file.identity) error('CLEANUP_CHANGED', '확인한 임시 파일이 바뀌었어요. 목록을 다시 확인해주세요.');
      }
      files.push(...review.files);
      for (const file of files) await rm(file.path);
      job.cleanupReview = null;
      job.worker?.postMessage({ type: 'clear-previews' });
    }
    return { files, reviewId: job.cleanupReview?.id, bytes: files.reduce((sum, file) => sum + file.size, 0), cleaned: confirmed };
  }
  dispose() {
    if (this.disposal) return this.disposal;
    this.disposal = this.disposeReady();
    return this.disposal;
  }
  async disposeReady() {
    const cleanup = [];
    for (const job of this.jobs.values()) {
      job.worker?.postMessage({ type: 'cancel' });
      cleanup.push(job.worker?.terminate(), job.volumeBroker?.dispose(), job.persistQueue);
    }
    // Closing the session also breaks any outstanding helper connection wait.
    cleanup.push(this.volumeSession.dispose());
    cleanup.push(this.acquisitions.dispose());
    await Promise.allSettled(cleanup);
    for (const job of this.jobs.values()) { try { job.candidates?.close?.(); } catch { /* shutdown is best effort */ } }
    await this.historyWrite.catch(() => {});
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new RecoveryError('CANCELLED', '앱을 종료했어요.')); }
    this.pending.clear();
  }
}
