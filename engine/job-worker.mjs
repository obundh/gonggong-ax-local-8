import { parentPort, workerData } from 'node:worker_threads';
import { mkdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { openNtfsProvider, RecoveryError, safeOutputName } from './ntfs-image.mjs';
import { openImageBytes } from './byte-source.mjs';
import { openWindowsVolume, listWindowsDevices } from './windows-device.mjs';
import { openWorkerVolume } from './worker-volume.mjs';
import { searchExistingFiles, copyExistingCandidate, hashDuplicates, existingCandidate, writeSearchIndex, readSearchIndex } from './file-search.mjs';
import { searchAutosaveRoots, assertAutosaveCandidate } from './autosave-search.mjs';
import { searchRecentTraces } from './recent-traces.mjs';
import { classifyNameMatch, normalizeFilters, rankName, candidateSearchName } from './candidate-filter.mjs';
import { MAX_CARVING_CANDIDATES, MAX_METADATA_CANDIDATES, openCandidateStore, setBoundedCandidate, mergeCandidateBatch } from './candidate-store.mjs';
import { openFatProvider } from './fat-volume.mjs';
import { previewBytes, previewFile } from './file-preview.mjs';
import { verifyRecoveredFile } from './recovery-verification.mjs';
import { chooseRecoveryName } from './recovery-name.mjs';
import { recoveryOutcome, recoverySummary, recoveryDiagnosis } from './recovery-outcome.mjs';
import { EarlyCaptureStore } from './early-capture.mjs';
import { candidateCaptureKey, canOfferEarlierCapture } from './capture-link.mjs';
import { discoverVolumes, openPartitionBytes, getUnallocatedRanges } from './volume-layout.mjs';
import { initialDeletedCoverage, nativePartitionStrategy, scanNativePartition,
  prepareNativeCandidate, markPreparationFailure } from './native-recovery-adapter.mjs';

let engine;
let reader;
let captures;
const engines = new Map();
let active = false;
let paused = false;
let wake;
let controller = new AbortController();
const candidateLimit = workerData.candidateLimit ?? (workerData.mode === 'deleted' ? MAX_METADATA_CANDIDATES : MAX_CARVING_CANDIDATES);
let candidates = openCandidateStore(workerData.candidateStorePath, { maxCandidates: candidateLimit });
const recoveredFiles = new Map();
let disposing = false;
const job = workerData;
const deepScanScope = job.deepScope === 'whole' ? 'whole-source' : 'verified-unallocated';
const resumedExaminedBytes = job.resumeCheckpoint?.kind === 'carving'
  ? (job.resumeCheckpoint.coverageState?.examinedRanges ?? []).reduce((sum, range) => sum + (Number(range?.length) || 0), 0) : 0;
const scopeCoverage = coverage => coverage?.strategy === 'carving' ? { ...coverage, scanScope: deepScanScope } : coverage;
const emit = event => {
  if (event.type === 'complete') job.coverage = { ...event.coverage, complete: event.complete,
    truncated: event.truncated === true, stats: event.stats };
  parentPort.postMessage({ ...event, jobId: job.id });
};
const control = { async checkpoint() {
  if (controller.signal.aborted) throw new RecoveryError('CANCELLED', '작업을 취소했어요.');
  while (paused && !controller.signal.aborted) await new Promise(resolve => { wake = resolve; });
  if (controller.signal.aborted) throw new RecoveryError('CANCELLED', '작업을 취소했어요.');
} };
let lastEvent = 0;
let lastStage;
let lastCheckpoint = 0;
let deepCheckpoint;
let emittedDeepCheckpoint;
let started = Date.now();
function reportCheckpoint(force = false) {
  if (!job.outputPath || job.source.kind !== 'image') return;
  if (job.mode === 'deep') {
    if (deepCheckpoint && deepCheckpoint !== emittedDeepCheckpoint && (force || Date.now() - lastCheckpoint >= 500)) {
      lastCheckpoint = Date.now();
      emittedDeepCheckpoint = deepCheckpoint;
      emit({ type: 'checkpoint', checkpoint: deepCheckpoint });
    }
    return;
  }
  if (job.mode !== 'deleted') return;
  if (job.deletedStrategy !== 'full' && (job.filters?.deletedAfter != null || job.filters?.deletedBefore != null)) return;
  const partitions = {};
  for (const [id, volume] of engines) if (typeof volume.exportCheckpoint === 'function') {
    try { partitions[id] = volume.exportCheckpoint(); } catch { /* Not started, or outside the checkpoint limit. */ }
  }
  if (Object.keys(partitions).length) emit({ type: 'checkpoint', checkpoint: { version: 1, partitions } });
}
function progress(event) {
  const now = Date.now();
  if (active === 'scan' && job.mode === 'deleted' && now - lastCheckpoint >= 5000) { lastCheckpoint = now; reportCheckpoint(); }
  const { coverage: incomingCoverage, ...progressFields } = event;
  const coverage = scopeCoverage(incomingCoverage);
  const stats = event.stats ?? progressFields;
  const stage = event.stage ?? event.phase ?? 'scan';
  const done = coverage?.examinedBytes ?? stats.bytesChecked ?? stats.bytesRead ?? stats.recordsRead ?? stats.filesVisited ?? stats.bytesWritten ?? 0;
  const total = coverage?.selectedBytes ?? stats.bytesTotal ?? stats.recordsTotal ?? 0;
  const rateDone = coverage?.strategy === 'carving' ? Math.max(0, done - resumedExaminedBytes) : done;
  if (stage === lastStage && now - lastEvent < 150 && (!total || done < total)) return;
  if (stage !== lastStage) started = now;
  lastEvent = now;
  lastStage = stage;
  const elapsed = (now - started) / 1000;
  const remaining = total > done && rateDone > 0 && elapsed >= 3 ? (total - done) / (rateDone / elapsed) : null;
  emit({ type: active === 'recover' ? 'recover-progress' : 'progress', stage, stats, ...(coverage ? { coverage } : {}),
    eta: remaining === null ? null : { minSeconds: Math.max(0, Math.round(remaining * .7)), maxSeconds: Math.ceil(remaining * 1.5) } });
}
const candidateForStorage = candidate => {
  const id = candidate.id ?? `file:${candidates.size}`;
  const nameMatch = classifyNameMatch(job.filters?.name, candidate);
  const rank = job.filters?.name && nameMatch.kind !== 'unknown' ? rankName(job.filters.name, candidateSearchName(candidate)) : null;
  const item = { ...candidate, id, nameMatch, ...(job.filters?.name ? { score: nameMatch.score,
    reasons: [...new Set([...(candidate.reasons ?? []), ...(rank?.reasons ?? [])])] } : {}) };
  return item;
};
const addCandidate = candidate => {
  const item = candidateForStorage(candidate);
  if (!setBoundedCandidate(candidates, item)) return false;
  emit({ type: 'candidate', candidate: item });
  return true;
};
const addCandidateBatch = batch => {
  const result = candidates.setBatch(batch.map(candidateForStorage));
  if (result.imported) emit({ type: 'candidate-batch', count: result.imported });
  if (result.truncated) throw new RecoveryError('CANDIDATE_LIMIT', '후보 보관 한도에 도달했어요. 표시되지 않은 삭제 이력이 있어요.');
};

async function openDevice() {
  if (job.volumeSession) return openWorkerVolume(parentPort, { signal: controller.signal });
  const current = (await listWindowsDevices()).find(device => device.id === job.source.device.id && device.identity === job.source.identity);
  if (!current) throw new RecoveryError('SOURCE_CHANGED', '원본 장치가 바뀌었어요. 다시 선택해주세요.');
  try { return await openWindowsVolume(current); }
  catch (error) {
    if (error.code !== 'NEEDS_ADMIN' || job.elevate !== true) throw error;
    emit({ type: 'progress', stage: 'permission', message: '장치를 읽기 위한 Windows 권한을 요청해요.' });
    return openWindowsVolume(current, { elevate: true });
  }
}

async function scan() {
  active = 'scan';
  controller = new AbortController();
  const options = { signal: controller.signal, control, onProgress: progress, onCandidate: addCandidate, maxCandidates: candidateLimit };
  const filters = normalizeFilters(job.filters ?? {});
  let result;
  try {
    if (job.capture) {
      captures = new EarlyCaptureStore(job.capture.root, { limits: job.capture.limits,
        signal: controller.signal, control, onProgress: progress });
      await captures.initialize();
    }
    if (job.mode === 'salvage') {
      const { salvageDocument, reconstructPngChunks } = await import('./document-salvage.mjs');
      const operation = job.salvageKind === 'png' ? reconstructPngChunks : salvageDocument;
      const repaired = await operation(job.source.path, job.outputPath, { ...options, sourceKind: 'user-selected' });
      emit({ type: 'recover-complete', results: [{ id: 'salvage', name: path.basename(job.source.path), ...repaired }] });
      return;
    } else if (job.mode === 'recycle') {
      const { searchRecycleBin } = await import('./recycle-bin.mjs');
      result = await searchRecycleBin(job.source.roots, options);
      result.warnings = [...(job.source.warnings ?? []), ...(result.warnings ?? [])];
      if (job.source.warnings?.length) result.complete = false;
    } else if (job.mode === 'traces') {
      result = await searchRecentTraces(job.source.roots[0] ?? null, { ...options, maxCandidates: Math.min(candidateLimit, 2000) });
      result.warnings = [...(job.source.warnings ?? []), ...(result.warnings ?? [])];
      if (job.source.warnings?.length) result.complete = false;
    } else if (job.mode === 'autosave') {
      result = await searchAutosaveRoots(job.source.roots, { ...options, maxCandidates: Math.min(candidateLimit, 2000) });
      result.warnings = [...(job.source.warnings ?? []), ...(result.warnings ?? [])];
      if (job.source.warnings?.length) result.complete = false;
    } else if (job.mode === 'copies') {
      const root = job.source.path ?? (job.source.driveLetter ? `${job.source.driveLetter}\\` : null);
      if (!root) throw new RecoveryError('SOURCE_KIND', '폴더 또는 드라이브를 선택해주세요.');
      result = await searchExistingFiles(root, { ...options, filters: {} });
    } else if (job.mode === 'deleted') {
      const requestedCoverage = initialDeletedCoverage({ source: job.source, deletedStrategy: job.deletedStrategy, filters });
      const nativeRequested = ['native-journal', 'mft-vacancy'].includes(requestedCoverage.strategy);
      const periodFirst = !nativeRequested && job.deletedStrategy !== 'full' && (filters.deletedAfter !== null || filters.deletedBefore !== null);
      reader = job.source.kind === 'image' ? await openImageBytes(job.source.path) : await openDevice();
      const layout = await discoverVolumes(reader, { signal: controller.signal });
      if (!layout.volumes.length) throw new RecoveryError('NO_VALID_VOLUME', '검증된 파일시스템을 찾지 못했어요. 이미지 전체에서 파일 흔적을 찾는 정밀 검색을 선택할 수 있어요.');
      if (!nativeRequested && !periodFirst && job.resumeCheckpoint && (job.resumeCheckpoint.version !== 1 || !job.resumeCheckpoint.partitions || Object.keys(job.resumeCheckpoint.partitions).some(id => !layout.volumes.some(p => p.id === id)))) throw new RecoveryError('INVALID_CHECKPOINT', '이전 검색 위치가 현재 이미지의 파티션과 맞지 않아요.');
      result = { candidates: [], warnings: [...layout.warnings], stats: {}, complete: layout.complete, truncated: false };
      result.coverage = { ...requestedCoverage, partitions: [] };
      for (const partition of layout.volumes) {
        await control.checkpoint();
        try {
          const child = openPartitionBytes(reader, partition);
          engine = partition.bootKind === 'NTFS' ? await openNtfsProvider(child) : await openFatProvider(child);
          engines.set(partition.id, engine);
          const remainingCandidates = Math.max(1, candidateLimit - candidates.size);
          const partitionOptions = { ...options, maxCandidates: remainingCandidates,
            onCandidate: c => addCandidate({ ...c, id: `${partition.id}/${c.id}`, partitionId: partition.id }) };
          const nativeRoute = nativeRequested ? nativePartitionStrategy({ sourceKind: job.source.kind,
            deletedStrategy: job.deletedStrategy, layout, partition, reader }) : null;
          const scan = nativeRequested
            ? await scanNativePartition(engine, { ...options, route: nativeRoute, partitionId: partition.id,
              maxCandidates: remainingCandidates, deletedAfter: filters.deletedAfter,
              deletedBefore: filters.deletedBefore, onCandidate: addCandidate, onCandidates: addCandidateBatch,
              onDiscovered: captures ? (candidate, captureTo) => captures.capture(candidate, captureTo) : undefined })
            : periodFirst
              ? typeof engine.scanDeletedPeriod === 'function'
              ? await engine.scanDeletedPeriod({ ...partitionOptions, deletedAfter: filters.deletedAfter, deletedBefore: filters.deletedBefore })
              : { candidates: [], stats: { recordsRead: 0, recordsTotal: 0, candidatesFound: 0 }, complete: false, truncated: false,
                warnings: [{ code: 'PERIOD_SEARCH_UNSUPPORTED', message: '이 파일시스템은 삭제 이벤트로 기간을 먼저 찾을 수 없어요. 전체 기록 검색으로 이어갈 수 있어요.' }] }
              : await engine.scanDeleted({ ...partitionOptions, resumeFrom: job.resumeCheckpoint?.partitions?.[partition.id] });
          result.coverage.partitions.push({ partitionId: partition.id, ...(scan.coverage || {}), complete: scan.complete });
          result.warnings.push(...scan.warnings); result.stats = { ...result.stats, ...scan.stats, partitionsScanned: engines.size, partitionsTotal: layout.volumes.length }; result.complete &&= scan.complete; result.truncated ||= scan.truncated;
          if (captures) result.stats.capture = { ...captures.stats };
          if (job.recent && !periodFirst && !nativeRequested) {
            // Deletion time is supplemental evidence. Its absence must never turn
            // a modification timestamp into a deletion date or hide a recoverable file.
            if (typeof engine.readDeletionTimes === 'function') {
              try {
                const times = await engine.readDeletionTimes(scan.candidates, options);
                for (const [candidateId, deletedAt] of times.timestamps) {
                  const id = `${partition.id}/${candidateId}`;
                  const candidate = candidates.get(id);
                  if (candidate) addCandidate({ ...candidate, deletedAt, deletedAtSource: 'ntfs-usn' });
                }
                result.warnings.push(...times.warnings.map(warning => ({ ...warning, partition: partition.id })));
                result.stats.deletionTimesComplete = (result.stats.deletionTimesComplete ?? true) && times.complete;
              } catch (error) {
                if (controller.signal.aborted || ['CANCELLED', 'SOURCE_CHANGED'].includes(error.code)) throw error;
                result.stats.deletionTimesComplete = false;
                result.warnings.push({ code: 'DELETION_TIME_UNAVAILABLE', message: '삭제 시각 기록을 읽지 못했어요. 시각 미확인 파일도 목록에 표시합니다.', partition: partition.id });
              }
            } else {
              result.stats.deletionTimesComplete = false;
              result.warnings.push({ code: 'DELETION_TIME_UNSUPPORTED', message: '이 파일시스템에서는 삭제 시각을 확인할 수 없어요. 파일은 시각 미확인 목록에 표시합니다.', partition: partition.id });
            }
          }
          if (candidates.size >= candidateLimit) { result.complete = false; result.truncated = true; break; }
        } catch (error) { if (['CANCELLED', 'SOURCE_CHANGED', 'INVALID_CHECKPOINT', 'CHECKPOINT_UNSUPPORTED'].includes(error.code)) throw error; result.complete = false; result.warnings.push({ code: error.code, message: error.message, partition: partition.id }); }
      }
    } else if (job.mode === 'deep') {
      reader = job.source.kind === 'image' ? await openImageBytes(job.source.path) : await openDevice();
      const { carveFiles } = await import('./carving.mjs');
      let ranges;
      if (job.deepScope !== 'whole') {
        const layout = await discoverVolumes(reader, { signal: controller.signal });
        if (!layout.complete || !layout.volumes.length) throw new RecoveryError('WHOLE_SOURCE_REQUIRED', '미할당 영역을 확실하게 구별할 수 없어요. 전체 범위 검색을 선택할 수 있어요.');
        ranges = [];
        for (const partition of layout.volumes) {
          const child = openPartitionBytes(reader, partition);
          try {
            const allocation = await getUnallocatedRanges(child, options);
            if (!allocation.supported || !allocation.complete) throw new RecoveryError('WHOLE_SOURCE_REQUIRED', '할당 정보를 확인하지 못했어요. 전체 범위 검색을 선택할 수 있어요.');
            ranges.push(...allocation.ranges.map(r => ({ offset: partition.offset + r.offset, length: r.length })));
          } finally { await child.close(); }
        }
      }
      const carvingOptions = { ...options, ...job.deepLimits, ranges,
        ...(job.source.kind === 'image' ? {
          resumeFrom: job.resumeCheckpoint,
          resumeRoots: job.resumeRoots,
          onCheckpoint: checkpoint => { deepCheckpoint = checkpoint; reportCheckpoint(); },
        } : {}) };
      result = ranges?.length === 0 ? { candidates: [], warnings: [], stats: { bytesRead: 0, bytesTotal: 0 }, complete: true }
        : await carveFiles(reader, job.outputPath, carvingOptions);
      result.stats.scanScope = ranges ? 'verified-unallocated' : 'whole-source';
      result.coverage = scopeCoverage(result.coverage ?? {
        version: 1, strategy: 'carving', selectedBytes: 0, scanReadBytes: 0, examinedBytes: 0,
        unexaminedBytes: 0, readErrorBytes: 0, outputBytesWritten: 0, stopReason: 'end-of-ranges', complete: true,
        examinedRanges: [], readErrorRanges: [], rangesTruncated: false,
      });
    } else throw new RecoveryError('UNSUPPORTED_MODE', '지원하지 않는 검색이에요.');
    for (const candidate of result.candidates ?? []) if (!candidates.has(candidate.id)) addCandidate(candidate);
    if (job.recent) {
      let deletionTimesKnown = 0;
      for (const candidate of candidates.values()) if (candidate.deletedAt != null) deletionTimesKnown++;
      result.stats.deletionTimesKnown = deletionTimesKnown;
      result.stats.deletionTimesUnknown = candidates.size - deletionTimesKnown;
    }
    result.stats.candidateLimit = candidateLimit;
    result.stats.candidateStorage = 'disk';
    if (result.truncated && !['autosave', 'traces'].includes(job.mode) && !result.warnings.some(warning => warning.code === 'CANDIDATE_LIMIT')) {
      result.warnings.push({ code: 'CANDIDATE_LIMIT', candidateLimit,
        message: `분석 후보 ${candidateLimit.toLocaleString()}개 안전 한도에 도달해 검색 범위가 일부 남았습니다. 화면 페이지 한도와는 별개입니다.` });
    }
    reportCheckpoint(true);
    const displayFilters = ['deleted', 'recycle'].includes(job.mode) && filters.name ? { ...filters, name: '' } : filters;
    emit({ type: 'complete', stats: result.stats, coverage: result.coverage, complete: result.complete, warnings: result.warnings, truncated: result.truncated,
      filteredCount: candidates.count(displayFilters, { keepNameMismatches: ['deleted', 'recycle'].includes(job.mode) }) });
  } catch (error) { reportCheckpoint(true); emitError(error); }
  finally { active = false; if (disposing) await shutdown(); }
}

function emitError(error) {
  emit({ type: error.code === 'CANCELLED' || error.name === 'AbortError' ? 'cancelled' : 'error',
    ...(error.details?.coverage ? { coverage: scopeCoverage(error.details.coverage), stats: error.details.stats, complete: false } : {}),
    error: { code: error.code ?? 'IO_FAILED', message: error.message, details: error.details ?? {} }, message: error.message });
}

async function prepareForAccess(candidate) {
  if (candidate.autosave) await assertAutosaveCandidate(candidate);
  if (['deletion-trace', 'recycle-metadata', 'directory-slack', 'recent-link'].includes(candidate.source) || candidate.status === 'metadata-only') {
    throw new RecoveryError('CONTENT_NOT_LOCATED', '정보 단서만 확인됐어요. 본문 위치는 정밀 검색으로 확인해야 해요.');
  }
  if (captures?.has(candidate.id)) return candidate;
  if (candidate.preparationKind !== 'combined-native') return candidate;
  const target = engines.get(candidate.partitionId) ?? engine;
  progress({ stage: 'prepare-candidate', recordsRead: 0, recordsTotal: 1 });
  try {
    const updated = await prepareNativeCandidate(target, candidate, { signal: controller.signal, control });
    addCandidate(updated);
    progress({ stage: 'prepare-candidate', recordsRead: 1, recordsTotal: 1 });
    return updated;
  } catch (error) {
    if (error.code !== 'CANCELLED' && error.name !== 'AbortError') addCandidate(markPreparationFailure(candidate, error));
    throw error;
  }
}

function requireLinkedCapture(candidate, proof) {
  if (!candidate || !canOfferEarlierCapture(candidate) || candidateCaptureKey(candidate) !== proof?.key
    || candidate.preservation.sha256 !== proof?.sha256 || typeof proof?.requestedFromJobId !== 'string'
    || !proof.requestedFromJobId || proof.requestedFromJobId === job.id) {
    throw new RecoveryError('CAPTURE_LINK_CHANGED', '이전 확보 본문과 파일 기록의 연결을 확인하지 못했어요.');
  }
  if (!captures) throw new RecoveryError('CAPTURE_MISSING', '이 작업에서 보관한 이전 본문이 없어요.');
  captures.assertLink(candidate.id, proof);
}

async function recover(message) {
  active = 'recover';
  started = Date.now(); lastEvent = 0;
  controller = new AbortController();
  const results = [];
  try {
    if (message.jobOutputPath) job.outputPath = message.jobOutputPath;
    await mkdir(message.outputPath, { recursive: true });
    for (const id of message.ids) {
      await control.checkpoint();
      let candidate = candidates.get(id);
      if (!candidate) throw new RecoveryError('UNKNOWN_CANDIDATE', '선택한 후보를 다시 확인해주세요.');
      try {
        if (message.captureOnly) requireLinkedCapture(candidate, message.captureOnly);
        else candidate = await prepareForAccess(candidate);
        if (candidate.preparationKind === 'combined-native' && candidate.status !== 'readable') {
          throw new RecoveryError('NOT_RECOVERABLE', candidate.reasons?.join(' ') || '선택한 파일 기록을 안전하게 복구할 수 없어요.');
        }
        let result;
        const nameRecovery = chooseRecoveryName(candidate);
        const options = { signal: controller.signal, control, onProgress: progress, outputName: nameRecovery.name };
        const outputPath = await outputFolder(message.outputPath, nameRecovery.originalNameStatus === 'ambiguous' ? { ...candidate, path: null } : candidate);
        if (captures?.has(id)) result = await captures.recover(id, outputPath, options);
        else if (candidate.source === 'recycle-bin') {
          const { recoverRecycleCandidate } = await import('./recycle-bin.mjs');
          result = await recoverRecycleCandidate(candidate, outputPath, options);
        } else if (candidate.source === 'existing-file') result = await copyExistingCandidate(candidate, outputPath, options);
        else if (candidate.source === 'carved') {
          const actual = await realpath(candidate.path);
          const claimedRoot = await realpath(candidate.rootPath ?? job.outputPath);
          const allowedRoots = [job.outputPath, ...(job.resumeRoots ?? [])].filter(Boolean);
          if (!allowedRoots.includes(claimedRoot)) throw new RecoveryError('UNSAFE_OUTPUT', '검증된 이전 작업 폴더의 복구본만 사용할 수 있어요.');
          const relative = path.relative(claimedRoot, actual);
          if (relative.startsWith('..') || path.isAbsolute(relative) || !(await stat(actual)).isFile()) throw new RecoveryError('UNSAFE_OUTPUT', '작업 폴더의 복구본을 확인할 수 없어요.');
          if (candidate.status !== 'readable') throw new RecoveryError('PARTIAL_CANDIDATE', '부분 추출 파일은 전체 복구본으로 보관할 수 없어요. 결과 목록에서 임시 경로를 확인해주세요.');
          const owned = await existingCandidate(actual, claimedRoot);
          result = { ...await copyExistingCandidate({ ...owned, identity: candidate.identity }, outputPath, options), originalIdentityVerified: false };
        } else result = await (engines.get(candidate.partitionId) ?? engine).recover(candidate.recordNumber, outputPath, options);
        if (message.captureOnly) result.preservation = { ...result.preservation, source: 'earlier-discovery-capture',
          sourceJobId: job.id, requestedFromJobId: message.captureOnly.requestedFromJobId };
        // NTFS verifies before publication. Other copy engines receive the same
        // output check here; an unreadable document still retains its copied bytes.
        if (!result.integrity) {
          try { Object.assign(result, await verifyRecoveredFile(result.path, {
            expectedSize: result.size, expectedSha256: result.sha256, fileName: path.basename(result.path), ...options,
          })); } catch (error) {
            error.details = { ...error.details, savedPath: result.path, outputUnverified: true, stage: 'output-verification' };
            throw error;
          }
        }
        const restored = { id, ...result, name: path.basename(result.path), discoveredName: candidate.name,
          ...(candidate.autosave ? { autosave: candidate.autosave } : {}),
          originalIdentityVerified: result.originalIdentityVerified ?? false,
          nameRecovery: { ...nameRecovery, savedName: path.basename(result.path),
            adjustedForFilesystem: path.basename(result.path) !== nameRecovery.name } };
        restored.outcome = recoveryOutcome(restored);
        restored.diagnostic = recoveryDiagnosis({ candidate, result: restored, stage: 'output-assessment', coverage: job.coverage });
        recoveredFiles.set(id, restored);
        results.push(restored);
      } catch (error) {
        if (error.code === 'SOURCE_CHANGED' && candidate.preparationKind === 'combined-native') {
          addCandidate(markPreparationFailure(candidate, error));
        }
        const failed = { id, name: candidate.name, status: error.code === 'CANCELLED' ? 'partial' : 'failed', code: error.code ?? 'IO_FAILED', error: error.message, details: error.details ?? {},
          diagnostic: recoveryDiagnosis({ candidate, error, stage: 'recover', coverage: job.coverage }) };
        failed.outcome = recoveryOutcome(failed);
        results.push(failed);
        if (controller.signal.aborted) break;
      }
      emit({ type: 'recover-progress', results: [...results], stats: recoverySummary(results, message.ids.length) });
    }
    emit({ type: controller.signal.aborted ? 'cancelled' : 'recover-complete', results, stats: recoverySummary(results, message.ids.length) });
  } catch (error) { emitError(error); }
  finally { active = false; if (disposing) await shutdown(); }
}

async function outputFolder(root, candidate) {
  let relative;
  if (candidate.source === 'existing-file') relative = path.relative(candidate.rootPath, path.dirname(candidate.path));
  else if (candidate.source === 'deleted-record' && candidate.path) relative = path.win32.dirname(candidate.path).replace(/^[A-Za-z]:/, '');
  const parts = relative && relative !== '.' ? relative.split(/[\\/]/).filter(Boolean) : [];
  const safe = parts.length <= 32 && !parts.includes('..') ? parts.map((name, i) => safeOutputName(name, i).slice(0, 80)) : [];
  const target = path.join(root, safe.length ? '원래경로' : '경로미확인', ...safe);
  if (target.length > 220) return root;
  await mkdir(target, { recursive: true });
  const canonical = await realpath(target), canonicalRoot = await realpath(root), rel = path.relative(canonicalRoot, canonical);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new RecoveryError('UNSAFE_OUTPUT', '원래 폴더 경로가 결과 폴더 밖으로 이어져요.');
  return canonical;
}

async function shutdown() {
  try { for (const item of engines.values()) await item.close(); if (engine && !engines.size) await engine.close(); await reader?.close(); }
  finally { try { candidates?.close?.(); } finally { process.exit(0); } }
}
async function preview(id) {
  let candidate = candidates.get(id);
  if (!candidate) throw new RecoveryError('UNKNOWN_CANDIDATE', '파일을 다시 선택해주세요.');
  if (['deletion-trace', 'recycle-metadata', 'directory-slack', 'recent-link'].includes(candidate.source) || candidate.status === 'metadata-only') return { type: 'unsupported', reason: '정보 단서는 남아 있지만 본문 위치를 찾지 못했어요. 정밀 검색으로 이어갈 수 있어요.' };
  if (captures?.has(id)) {
    if (candidate.size > 8 * 1024 * 1024) return { type: 'unsupported', reason: '8MB 이하의 파일만 미리 볼 수 있어요.' };
    return previewBytes(chooseRecoveryName(candidate).name, await captures.read(id, { signal: controller.signal }),
      { signal: controller.signal, sourceIdentityVerified: false });
  }
  candidate = await prepareForAccess(candidate);
  if (candidate.status !== 'readable' && candidate.source !== 'existing-file' && candidate.source !== 'carved') {
    return { type: 'unsupported', reason: '읽을 수 있는 파일만 미리 볼 수 있어요.' };
  }
  if (!Number.isSafeInteger(candidate.size) || candidate.size > 8 * 1024 * 1024) {
    return { type: 'unsupported', reason: '8MB 이하의 파일만 미리 볼 수 있어요.' };
  }
  if (candidate.source === 'existing-file') {
    const i = candidate.identity;
    const expectedIdentity = { dev: i.device, ino: i.inode, size: i.size, mtimeMs: String(BigInt(i.modifiedAtNs) / 1000000n) };
    return previewFile(candidate.path, { expectedIdentity, signal: controller.signal });
  }
  if (candidate.source === 'carved') return previewFile(candidate.path, { signal: controller.signal });
  let bytes;
  try {
    bytes = candidate.source === 'recycle-bin'
      ? await (await import('./recycle-bin.mjs')).readRecycleCandidateBytes(candidate, { signal: controller.signal, control })
      : await (engines.get(candidate.partitionId) ?? engine).readCandidateBytes(candidate.recordNumber, { signal: controller.signal, control });
  } catch (error) {
    if (error.code === 'SOURCE_CHANGED' && candidate.preparationKind === 'combined-native') addCandidate(markPreparationFailure(candidate, error));
    throw error;
  }
  return previewBytes(chooseRecoveryName(candidate).name, bytes, { signal: controller.signal, sourceIdentityVerified: true });
}

async function previewRecovered(id) {
  const result = recoveredFiles.get(id);
  if (!result || result.status !== 'saved' || result.integrity?.status !== 'verified') {
    throw new RecoveryError('UNKNOWN_RESULT', '이 작업에서 저장을 확인한 복구본을 선택해주세요.');
  }
  if (result.size > 8 * 1024 * 1024) return { type: 'unsupported', reason: '8MB 이하의 복구본만 미리 볼 수 있어요. 파일 위치를 열어 확인해주세요.' };
  // Check the saved bytes, not the now potentially reused source record.
  const verified = await verifyRecoveredFile(result.path, { expectedSize: result.size, expectedSha256: result.sha256,
    fileName: result.name, signal: controller.signal, control });
  if (verified.document.status !== 'preview-available') return { type: 'unsupported', reason: verified.document.reason || 'DOCUMENT_PREVIEW_UNSUPPORTED' };
  return previewFile(result.path, { signal: controller.signal, expectedIdentity: verified.integrity.identity });
}

async function previewCapture(message) {
  const candidate = candidates.get(message.id);
  requireLinkedCapture(candidate, message);
  const earlierCapture = { jobId: job.id, ...candidate.preservation, originalIdentityVerified: false };
  // Read and rehash even if the renderer cannot preview this file size.
  const bytes = await captures.read(candidate.id, { signal: controller.signal });
  if (bytes.length > 8 * 1024 * 1024) return { type: 'unsupported', earlierCapture,
    reason: '8MB 이하의 파일만 미리 볼 수 있어요. 이전 확보본 저장 후 확인해주세요.' };
  return { ...await previewBytes(chooseRecoveryName(candidate).name, bytes,
    { signal: controller.signal, sourceIdentityVerified: false }), earlierCapture };
}

async function rpc(message) {
  let ownsActive = false;
  try {
    if (['save-index', 'semantic'].includes(message.type) && !job.outputPath) throw new RecoveryError('OUTPUT_REQUIRED', '파일을 저장할 때 폴더를 선택해주세요.');
    let result;
    if (message.type === 'preview') {
      if (active) result = { type: 'unsupported', reason: '검색이 끝난 뒤 내용을 확인할 수 있어요.' };
      else { controller = new AbortController(); active = 'preview'; ownsActive = true; result = await preview(message.id); }
    }
    else {
      if (active) throw new RecoveryError('BUSY', '현재 작업이 끝난 뒤 사용할 수 있어요.');
      controller = new AbortController(); active = message.type; ownsActive = true;
      if (message.type === 'preview-recovered') result = await previewRecovered(message.id);
      else if (message.type === 'preview-capture') result = await previewCapture(message);
      else if (message.type === 'hash') result = await hashDuplicates(message.ids.map(id => candidates.get(id)).filter(Boolean), { signal: controller.signal, control, onProgress: progress });
      else if (message.type === 'save-index') {
        const indexed = [];
        for (const candidate of candidates.values()) if (candidate.source === 'existing-file') {
          indexed.push(candidate);
          if (indexed.length > MAX_CARVING_CANDIDATES) throw new RecoveryError('INVALID_LIMIT', `파일 인덱스는 한 번에 최대 ${MAX_CARVING_CANDIDATES.toLocaleString()}개까지 저장할 수 있어요.`);
        }
        result = await writeSearchIndex(path.join(job.outputPath, 'file-index.json'), indexed, { signal: controller.signal });
      }
      else if (message.type === 'load-index') {
        const loaded = await readSearchIndex(message.path, { signal: controller.signal });
        const removed = [];
        for (const id of loaded.removedIds) if (candidates.get(id)?.source === 'existing-file') {
          candidates.delete(id); removed.push(id);
        }
        if (removed.length) emit({ type: 'candidates-removed', ids: removed });
        const batch = mergeCandidateBatch(loaded.candidates, addCandidate);
        result = { ...loaded, candidates: undefined, stats: { ...loaded.stats, ...batch, removed: removed.length }, complete: loaded.complete && !batch.truncated, truncated: loaded.truncated || batch.truncated };
        if (batch.truncated) emit({ type: 'candidate-limit', skipped: batch.skippedByLimit, candidateLimit,
          message: `분석 후보 ${candidateLimit.toLocaleString()}개 안전 한도에 도달해 인덱스 일부를 가져오지 못했어요.` });
      }
      else if (message.type === 'semantic') {
        const { createFilenameSemanticSearch } = await import('./semantic-search.mjs');
        const model = await createFilenameSemanticSearch({ modelPath: message.modelPath, runtimeRoot: message.runtimeRoot, cacheDirectory: path.join(job.outputPath, 'semantic-cache'), signal: controller.signal });
        try {
          const semanticCandidates = [];
          for (const candidate of candidates.values()) {
            semanticCandidates.push(candidate);
            if (semanticCandidates.length > MAX_CARVING_CANDIDATES) throw new RecoveryError('INVALID_LIMIT', `파일명 의미 검색은 한 번에 최대 ${MAX_CARVING_CANDIDATES.toLocaleString()}개 후보를 비교할 수 있어요.`);
          }
          const ranked = await model.rank(message.query, semanticCandidates, { signal: controller.signal, onProgress: progress });
          for (const c of ranked) { if (setBoundedCandidate(candidates, c)) emit({ type: 'candidate', candidate: c }); }
          result = { ranked: ranked.length };
        }
        finally { await model.close(); }
      }
    }
    emit({ requestId: message.requestId, result });
  } catch (error) { emit({ requestId: message.requestId, error: { code: error.code ?? 'OPERATION_FAILED', message: error.message } }); }
  finally { if (ownsActive) active = false; if (disposing && !active) await shutdown(); }
}

parentPort.on('message', message => {
  if (message.type === 'clear-previews') return;
  else if (message.type === 'cancel') { controller.abort(); paused = false; wake?.(); }
  else if (message.type === 'pause' && active) { paused = true; emit({ type: 'paused' }); }
  else if (message.type === 'resume') { paused = false; wake?.(); emit({ type: 'resumed' }); }
  else if (message.type === 'recover') {
    if (active) { emitError(new RecoveryError('BUSY', '현재 작업을 마친 후 복구해주세요.')); return; }
    void recover(message);
  } else if (['preview', 'preview-capture', 'preview-recovered', 'hash', 'save-index', 'load-index', 'semantic'].includes(message.type)) {
    void rpc(message);
  } else if (message.type === 'dispose') {
    disposing = true; controller.abort(); paused = false; wake?.();
    if (!active) void shutdown();
  }
});
void scan();
