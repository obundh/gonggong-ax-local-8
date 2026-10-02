import { scanCombined, prepareCombinedCandidate } from './combined-recovery.mjs';
import { recoveryDiagnosis } from './recovery-outcome.mjs';

const NATIVE_PREPARATION = 'combined-native';

function hasDateFilter(filters = {}) {
  return filters.deletedAfter !== null && filters.deletedAfter !== undefined
    || filters.deletedBefore !== null && filters.deletedBefore !== undefined;
}

export function initialDeletedCoverage({ source, deletedStrategy = 'auto', filters = {} }) {
  const nativeVolume = source?.kind === 'volume' && String(source.device?.fileSystem ?? '').toUpperCase() === 'NTFS';
  if (nativeVolume && ['auto', 'journal-full'].includes(deletedStrategy)) return {
    strategy: 'native-journal', deletedAfter: filters.deletedAfter ?? null, deletedBefore: filters.deletedBefore ?? null,
    requiresVacancyScan: true, requiresFullScan: true
  };
  if (nativeVolume && deletedStrategy === 'vacancy') return {
    strategy: 'mft-vacancy', deletedAfter: filters.deletedAfter ?? null, deletedBefore: filters.deletedBefore ?? null,
    requiresVacancyScan: false, requiresFullScan: false
  };
  const periodFirst = deletedStrategy !== 'full' && hasDateFilter(filters);
  return { strategy: periodFirst ? 'journal-first' : 'full-records', deletedAfter: filters.deletedAfter ?? null,
    deletedBefore: filters.deletedBefore ?? null, requiresFullScan: periodFirst };
}

export function nativePartitionStrategy({ sourceKind, deletedStrategy, layout, partition, reader }) {
  if (sourceKind !== 'volume' || !['auto', 'vacancy', 'journal-full'].includes(deletedStrategy) || partition?.bootKind !== 'NTFS') return null;
  const sectorSize = partition?.sectorSize;
  const validSectorGeometry = Number.isSafeInteger(sectorSize) && sectorSize >= 512 && sectorSize <= 4096
    && (sectorSize & (sectorSize - 1)) === 0 && reader?.info?.sectorSize === sectorSize
    && Number.isSafeInteger(partition.size) && partition.size > 0 && partition.size % sectorSize === 0
    && Number.isSafeInteger(reader?.info?.size) && reader.info.size > 0 && reader.info.size % sectorSize === 0;
  // A real Windows C: trial exposed a one-logical-sector difference between
  // the NTFS boot geometry and Get-Partition length. Accept only that bounded
  // trailing sector (or exact equality) on an otherwise proven direct volume.
  const trailingBytes = validSectorGeometry ? reader.info.size - partition.size : NaN;
  const wholeVolume = layout?.scheme === 'volume' && layout.volumes?.length === 1 && partition.trusted === true
    && partition.offset === 0 && validSectorGeometry && (trailingBytes === 0 || trailingBytes === sectorSize);
  if (!wholeVolume) return { strategy: null, reason: 'NATIVE_VOLUME_MISMATCH' };
  if (typeof reader.queryJournal !== 'function' || typeof reader.readJournal !== 'function') {
    return { strategy: null, reason: 'NATIVE_JOURNAL_UNAVAILABLE' };
  }
  return { strategy: deletedStrategy === 'vacancy' ? 'vacancy' : 'journal', journalProvider: reader,
    ...(deletedStrategy === 'journal-full' ? { journalOptions: { periodReadStrategy: 'full-retained' } } : {}) };
}

export function decorateNativeCandidate(candidate, partitionId) {
  return { ...candidate, id: `${partitionId}/${candidate.id}`, partitionId,
    requiresPreparation: !['deletion-trace', 'recycle-metadata', 'directory-slack'].includes(candidate.source),
    preparationKind: ['deletion-trace', 'recycle-metadata', 'directory-slack'].includes(candidate.source) ? null : NATIVE_PREPARATION };
}

export function mergePreparedCandidate(discovered, prepared) {
  const reasons = [...new Set([...(discovered.reasons ?? []), ...(prepared.reasons ?? [])])];
  return { ...discovered, ...prepared,
    id: discovered.id, partitionId: discovered.partitionId, recordNumber: discovered.recordNumber,
    sequence: discovered.sequence, name: discovered.name, deletedAt: discovered.deletedAt ?? null,
    deletedAtSource: discovered.deletedAtSource ?? null, dateMatch: discovered.dateMatch,
    discoveredName: discovered.discoveredName ?? discovered.name, originalNameStatus: discovered.originalNameStatus ?? 'unknown',
    restorationName: discovered.restorationName ?? null,
    previousNameHints: discovered.previousNameHints ?? [], discoverySources: discovered.discoverySources ?? [],
    preparationKind: discovered.preparationKind, requiresPreparation: false, preparationStatus: 'checked', reasons };
}

export function markPreparationFailure(candidate, failure) {
  const changed = failure?.code === 'SOURCE_CHANGED';
  return { ...candidate, requiresPreparation: false, preparationStatus: changed ? 'source-changed' : 'unsupported',
    diagnostic: recoveryDiagnosis({ candidate, error: failure, stage: 'prepare-candidate' }),
    status: changed ? 'conflict' : 'unsupported',
    reasons: [...new Set([...(candidate.reasons ?? []), failure?.message || '선택한 파일 기록을 확인하지 못했어요.'])] };
}

export async function prepareNativeCandidate(engine, candidate, options = {}) {
  if (['deletion-trace', 'recycle-metadata', 'directory-slack'].includes(candidate?.source)) throw Object.assign(new Error('정보 단서만 남아 있어 본문 위치를 먼저 찾아야 해요.'), { code: 'CONTENT_NOT_LOCATED' });
  if (candidate?.preparationKind !== NATIVE_PREPARATION) return candidate;
  const prepared = await (options.prepare ?? prepareCombinedCandidate)(engine, candidate.recordNumber, options);
  return mergePreparedCandidate(candidate, prepared);
}

export async function scanNativePartition(engine, { route, partitionId, onCandidate, onCandidates, onDiscovered, ...options }) {
  if (!route?.strategy || !route.journalProvider) throw Object.assign(new Error('Windows NTFS 볼륨의 변경 기록 API를 현재 파티션과 안전하게 연결하지 못했어요.'), {
    code: route?.reason ?? 'NATIVE_VOLUME_MISMATCH'
  });
  return scanCombined(engine, { ...options, strategy: route.strategy, journalProvider: route.journalProvider,
    journalOptions: { ...options.journalOptions, ...route.journalOptions },
    onDiscovered: onDiscovered ? async (candidate, captureTo) => {
      const decorated = decorateNativeCandidate(candidate, partitionId);
      const preservation = await onDiscovered(decorated, captureTo);
      if (preservation) Object.assign(candidate, preservation);
    } : undefined,
    onCandidate: candidate => onCandidate?.(decorateNativeCandidate(candidate, partitionId)),
    onCandidates: onCandidates ? batch => onCandidates(batch.map(candidate => decorateNativeCandidate(candidate, partitionId))) : undefined });
}
