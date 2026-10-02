// Experimental compositions use the same existing content recovery checks.
// Metadata discovery never by itself authorizes a byte read or output.
import { readNativeJournal } from './native-usn.mjs';
import { scanVacantRecords } from './ntfs-vacancy.mjs';
import { chooseRecoveryName } from './recovery-name.mjs';
import { recordChangedError, summarizeRecord } from './record-diagnostics.mjs';
import { performance } from 'node:perf_hooks';
import { buildDeletionTraces } from './deletion-traces.mjs';
import { DeletedRecycleInfoCollector } from './deleted-recycle-discovery.mjs';
import { DirectorySlackCollector } from './directory-slack-discovery.mjs';

const discoveries = new WeakMap();
// Acceleration only: the complete vacancy walk still follows this bounded pass.
// Elapsed time is checked between targets, never by weakening an in-flight read.
export const RECENT_PRIORITY_LIMITS = Object.freeze({ maxRecords: 64, maxMilliseconds: 2000 });
const LOCAL_ERRORS = new Set(['INVALID_RECORD', 'INVALID_FIXUP', 'INVALID_ATTRIBUTE', 'INVALID_ATTRIBUTE_LIST', 'INVALID_NAME', 'INVALID_RANGE', 'UNSUPPORTED_ATTRIBUTE']);
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function stop(signal) { if (signal?.aborted) fail('CANCELLED', '작업을 취소했어요.'); }
function bound(value) {
  if (value == null) return null;
  const n = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isSafeInteger(n) || Math.abs(n) > 8640000000000000) fail('INVALID_DATE_RANGE', '삭제 기간이 잘못됐어요.');
  return n;
}
function matchingDelete(record, event) {
  return event.reason & 0x200 && event.sequence > 0 && event.sequence < 65535 && record.sequence === event.sequence + 1
    && record.nameReferences.some(n => n.name === event.name && n.parent.recordNumber === event.parent.recordNumber && n.parent.sequence === event.parent.sequence);
}
function newestFirst(left, right) {
  const leftDated = left.atMs !== null, rightDated = right.atMs !== null;
  if (leftDated !== rightDated) return rightDated - leftDated;
  if (leftDated && left.atMs !== right.atMs) return right.atMs - left.atMs;
  const leftUsn = BigInt(left.usn), rightUsn = BigInt(right.usn);
  return leftUsn < rightUsn ? 1 : leftUsn > rightUsn ? -1 : 0;
}
function light(record) {
  const data = record.attributes.filter(a => a.type === 0x80 && !a.name && !a.problem);
  return { recordNumber: record.recordNumber, sequence: record.sequence, fingerprint: record.fingerprint,
    ...(record.attributes.some(a => a.type === 0x20) ? { splitData: true } : {}),
    names: record.names.map(n => n.name), nameReferences: record.names.map(n => ({ name: n.name, namespace: n.namespace, parent: { ...n.parent } })),
    recordEvidence: summarizeRecord(record),
    size: data.length === 1 && Number.isSafeInteger(data[0].size) ? data[0].size : undefined };
}

export async function scanCombined(engine, { strategy = 'combined', journalProvider = engine.provider,
  signal, control, onProgress, onCandidate, onCandidates, onDiscovered, deletedAfter, deletedBefore, startUsn, maxCandidates = 100000, journalOptions = {} } = {}) {
  if (!['journal', 'vacancy', 'combined'].includes(strategy)) fail('INVALID_STRATEGY', '지원하지 않는 검색 조합이에요.');
  if (!Number.isInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 100000) fail('INVALID_LIMIT', '후보 한도가 잘못됐어요.');
  const after = bound(deletedAfter), before = bound(deletedBefore);
  if (after !== null && before !== null && after > before) fail('INVALID_DATE_RANGE', '삭제 기간이 역순이에요.');
  if (engine.busy) fail('BUSY', '다른 작업이 진행 중이에요.');
  engine.busy = true;
  discoveries.delete(engine); engine.scanned.clear(); engine.scanCheckpoint = null;
  const begun = performance.now(), accepted = new Map(), records = new Map(), warnings = [];
  const stats = { recordsRead: 0, candidatesFound: 0, datedCandidates: 0, undatedCandidates: 0, parseErrors: 0 };
  const warn = w => { if (warnings.length < 100) warnings.push(w); };
  const byRecord = new Map(), byIdentity = new Map(), matchedIdentities = new Set(), observations = new Map();
  const directorySlack = new DirectorySlackCollector(engine, { signal, control, onProgress });
  const directoryFreedIndex = new DirectorySlackCollector(engine, { signal, control, onProgress, mode: 'freed-index' });
  const observeDirectory = parent => { directorySlack.observe(parent); directoryFreedIndex.observe(parent); };
  const recycleInfo = new DeletedRecycleInfoCollector(engine, { signal, control, onProgress,
    readBytes: async (record, options) => {
      // Reuse the normal generation/allocation read checks in an isolated view.
      // The outer scan retains its busy lock throughout this awaited operation.
      const view = Object.create(engine); view.busy = false; view.scanned = new Map();
      discoveries.set(view, new Map([[record.recordNumber, record]]));
      try {
        await prepareCombinedCandidate(view, record.recordNumber, options);
        return await view.readCandidateBytes(record.recordNumber, options);
      } finally { discoveries.delete(view); view.scanned.clear(); }
    } });
  let journal, vacancy = null, truncated = false;
  try {
    stop(signal); await engine.assertUnchanged();
    journal = await readNativeJournal(journalProvider, { ...journalOptions, signal, control, onProgress, startUsn,
      latestFirst: journalOptions.latestFirst ?? true,
      deletedAfter: after, deletedBefore: before });
    warnings.push(...journal.warnings);
    for (const event of journal.events) {
      if (event.recordNumber < 16 || event.recordNumber >= engine.info.recordCount) continue;
      const key = `${event.recordNumber}:${event.sequence}`;
      if (!byIdentity.has(key)) byIdentity.set(key, []);
      byIdentity.get(key).push(event);
      if (!(event.reason & 0x200)) continue;
      if (!byRecord.has(event.recordNumber)) byRecord.set(event.recordNumber, []);
      byRecord.get(event.recordNumber).push(event);
    }
    const publish = async (record, source) => {
      if (!record.names.length) return;
      const matched = (byRecord.get(record.recordNumber) ?? []).filter(e => matchingDelete(record, e));
      const dated = matched.filter(e => e.atMs !== null).sort((a, b) => b.atMs - a.atMs)[0] ?? null;
      if (dated && ((after !== null && dated.atMs < after) || (before !== null && dated.atMs > before))) return;
      if (accepted.has(record.recordNumber)) {
        const existing = accepted.get(record.recordNumber);
        if (existing.source !== 'recycle-metadata' && existing.fingerprint === record.fingerprint && !existing.discoverySources.includes(source)) existing.discoverySources.push(source);
        return;
      }
      if (accepted.size >= maxCandidates) { truncated = true; return; }
      for (const name of record.nameReferences) observeDirectory(name.parent);
      const recycleArtifact = await recycleInfo.inspect(record);
      if (recycleArtifact) {
        accepted.set(record.recordNumber, recycleArtifact);
        for (const event of matched) matchedIdentities.add(`${event.recordNumber}:${event.sequence}:${event.usn}`);
        stats.candidatesFound++; stats.undatedCandidates++;
        // This is a separately attested information file, never a $R body link.
        // Do not offer an early capture callback or add it to byte preparation.
        await onCandidate?.(recycleArtifact);
        return;
      }
      const evidenceDelete = matched.length === 1 ? matched[0] : null;
      const generationEvents = evidenceDelete ? (byIdentity.get(`${record.recordNumber}:${evidenceDelete.sequence}`) ?? []) : [];
      const hints = dated ? (byIdentity.get(`${record.recordNumber}:${dated.sequence}`) ?? [])
        .filter(e => e.reason & 0x1000 && BigInt(e.usn) < BigInt(dated.usn)).map(e => e.name) : [];
      const naming = chooseRecoveryName({ ...record, name: record.names[0], generationEvents, matchedDeletes: matched });
      const candidate = { id: `ntfs:${record.recordNumber}:${record.sequence}`, ...record, name: record.names[0], size: record.size ?? 0,
        source: 'deleted-record', status: 'unverified', storage: 'unverified', path: null, pathStatus: 'unknown',
        originalIdentityVerified: false, deletedAt: dated?.at ?? null, deletedAtSource: dated ? 'windows-usn' : null,
        // Re-encode the two fields decoded from the accepted journal event;
        // never derive this deletion identity from the current MFT generation.
        ...(evidenceDelete ? { deletionEvidence: {
          fileReference: (BigInt(evidenceDelete.recordNumber) | BigInt(evidenceDelete.sequence) << 48n).toString(),
          deleteUsn: evidenceDelete.usn,
        } } : {}),
        dateMatch: dated ? 'matched' : after !== null || before !== null ? 'unknown' : 'not-requested',
        discoveredName: naming.discoveredName, originalNameStatus: naming.originalNameStatus,
        restorationName: naming.originalNameStatus === 'restored-from-history'
          ? { name: naming.name, source: naming.source, evidence: naming.evidence } : null,
        previousNameHints: [...new Set(hints)].slice(-8), discoverySources: [source],
        reasons: ['파일 기록 흔적이에요. 선택하면 현재 기록과 본문 저장 구간을 다시 확인해요.'] };
      accepted.set(record.recordNumber, candidate); records.set(record.recordNumber, record);
      for (const event of matched) matchedIdentities.add(`${event.recordNumber}:${event.sequence}:${event.usn}`);
      stats.candidatesFound++; if (dated) stats.datedCandidates++; else stats.undatedCandidates++;
      if (onDiscovered) {
        // The scan keeps its lock. An awaited, single-record view gives the
        // existing recovery checks their own busy/scanned state without making
        // the live scan reentrant or trusting discovery as content proof.
        let available = true;
        const captureTo = async (destination, options = {}) => {
          if (!available) fail('SCAN_REQUIRED', '이 후보의 즉시 확보 시점이 지났어요.');
          available = false;
          const view = Object.create(engine);
          view.busy = false; view.scanned = new Map();
          discoveries.set(view, new Map([[record.recordNumber, record]]));
          try {
            await prepareCombinedCandidate(view, record.recordNumber, { ...options, signal: options.signal ?? signal, control: options.control ?? control });
            return await view.recover(record.recordNumber, destination, { ...options, signal: options.signal ?? signal, control: options.control ?? control });
          } finally { discoveries.delete(view); view.scanned.clear(); }
        };
        try { await onDiscovered(candidate, captureTo); } finally { available = false; }
      }
      await onCandidate?.(candidate);
    };
    const recentPriority = strategy === 'vacancy' ? {
      enabled: Boolean(journal.available && typeof onDiscovered === 'function'),
      reason: !journal.available ? 'journal-unavailable' : typeof onDiscovered !== 'function' ? 'capture-disabled' : null,
      recordsLimit: RECENT_PRIORITY_LIMITS.maxRecords, maxMilliseconds: RECENT_PRIORITY_LIMITS.maxMilliseconds,
      targetsAvailable: 0, recordsRead: 0, bodyCandidates: 0, elapsedMs: 0, stopReason: 'disabled',
    } : null;
    if (recentPriority) stats.recentPriority = recentPriority;
    if ((strategy !== 'vacancy' || recentPriority.enabled) && journal.available) {
      const targets = [...byRecord.entries()].map(([number, events]) => ({ number,
        priority: [...events].filter(e => e.atMs === null ? !recentPriority
          : (after === null || e.atMs >= after) && (before === null || e.atMs <= before))
          .sort(newestFirst)[0] ?? null })).filter(target => target.priority).sort((a, b) => newestFirst(a.priority, b.priority) || a.number - b.number);
      const priorityStart = performance.now();
      if (recentPriority) {
        recentPriority.targetsAvailable = targets.length;
        recentPriority.stopReason = targets.length ? 'targets-complete' : 'no-targets';
      }
      stats.recordsTotal = recentPriority ? Math.min(targets.length, recentPriority.recordsLimit) : targets.length;
      if (recentPriority) onProgress?.({ stage: 'recent-priority', ...stats });
      for (const { number } of targets) {
        stop(signal); await control?.checkpoint();
        stop(signal);
        if (recentPriority) {
          if (accepted.size >= maxCandidates) { recentPriority.stopReason = 'candidate-limit'; break; }
          if (recentPriority.recordsRead >= recentPriority.recordsLimit) { recentPriority.stopReason = 'record-limit'; break; }
          if (performance.now() - priorityStart >= recentPriority.maxMilliseconds) { recentPriority.stopReason = 'time-limit'; break; }
          recentPriority.recordsRead++;
        }
        try {
          const record = await engine.record(number, signal); stats.recordsRead++;
          observations.set(number, record ? { sequence: record.sequence, flags: record.flags, fingerprint: record.fingerprint, observedAt: new Date().toISOString(), stage: 'journal-target-read' }
            : { reason: 'record-unavailable', observedAt: new Date().toISOString(), stage: 'journal-target-read' });
          if (record?.flags === 0 && record.baseReference === 0n && !(await engine.bitmapBit(engine.mftBitmap, number, signal))) {
            const item = light(record);
            if ((byRecord.get(number) ?? []).some(e => matchingDelete(item, e))) {
              await publish(item, 'windows-usn');
              if (recentPriority && accepted.get(number)?.source === 'deleted-record') recentPriority.bodyCandidates++;
            }
          }
        } catch (error) { if (!LOCAL_ERRORS.has(error.code)) throw error; observations.set(number, { reason: error.code, observedAt: new Date().toISOString(), stage: 'journal-target-read' }); stats.parseErrors++; warn({ recordNumber: number, code: error.code, message: error.message }); }
        if (stats.recordsRead % (recentPriority ? 8 : 128) === 0) {
          if (recentPriority) recentPriority.elapsedMs = performance.now() - priorityStart;
          onProgress?.({ stage: recentPriority ? 'recent-priority' : 'combined-records', ...stats });
        }
      }
      if (recentPriority) {
        recentPriority.elapsedMs = performance.now() - priorityStart;
        onProgress?.({ stage: 'recent-priority', ...stats });
      }
    }
    if (strategy !== 'journal') {
      vacancy = await scanVacantRecords(engine, { signal, control, onProgress,
        onCandidate: item => publish(item, 'mft-vacancy') });
      for (const item of vacancy.stats.parseErrorSamples) warn(item);
      stats.vacancy = vacancy.stats;
      truncated ||= vacancy.stats.candidatesTruncated;
    }
    stop(signal); await engine.assertUnchanged();
    // A surviving journal event remains useful when the MFT slot has been
    // reused. Keep it separate from byte-bearing records and publish it only
    // after those records so traces cannot consume their candidate budget.
    const traces = journal.available && journal.bounds?.journalId
      ? buildDeletionTraces({ events: journal.events, journalId: journal.bounds.journalId,
        after, before, matchedIdentities, observations, maxTraces: maxCandidates })
      : { candidates: [], truncated: false, stats: {} };
    const traceCandidates = traces.candidates.slice(0, Math.max(0, maxCandidates - accepted.size));
    truncated ||= traces.truncated || traceCandidates.length < traces.candidates.length;
    stats.recordCandidates = [...accepted.values()].filter(c => c.source === 'deleted-record').length;
    stats.recycleMetadata = { ...recycleInfo.stats };
    if (recycleInfo.stats.limited) warn({ code: 'RECYCLE_METADATA_LIMIT', message: '휴지통 정보 단서의 읽기 한도에 도달했어요. 확인하지 못한 정보 파일이 있어요.' });
    stats.deletionTraces = traceCandidates.length;
    stats.traceEvidence = traces.stats;
    for (let offset = 0; offset < traceCandidates.length; offset += 256) {
      stop(signal); await control?.checkpoint();
      const batch = traceCandidates.slice(offset, offset + 256);
      if (onCandidates) await onCandidates(batch);
      else for (const trace of batch) { stop(signal); await control?.checkpoint(); await onCandidate?.(trace); }
      onProgress?.({ stage: 'deletion-traces', recordsRead: offset + batch.length, recordsTotal: traceCandidates.length,
        candidatesFound: accepted.size + offset + batch.length });
    }
    stats.candidatesFound += traceCandidates.length;
    // Give body-bearing records and confirmed deletion events first use of the
    // candidate budget. Folder remnants never suppress or rename those results.
    for (const trace of traceCandidates) {
      const ref = BigInt(trace.traceEvidence.deletedParentFileReference);
      observeDirectory({ recordNumber: Number(ref & 0xffffffffffffn), sequence: Number(ref >> 48n) });
    }
    const slackCandidates = await directorySlack.collect({ limit: Math.max(0, maxCandidates - accepted.size - traceCandidates.length) });
    stats.directorySlack = { ...directorySlack.stats };
    for (const clue of slackCandidates) { stop(signal); await onCandidate?.(clue); }
    stats.candidatesFound += slackCandidates.length;
    stats.undatedCandidates += slackCandidates.length;
    if (directorySlack.stats.limited) warn({ code: 'DIR_SLACK_LIMIT', message: '폴더 이름 흔적은 제한된 범위만 확인했어요. 읽지 않은 폴더·인덱스 영역이 있을 수 있어요.' });
    if (Object.keys(directorySlack.stats.skippedByCode).some(code => code !== 'DIR_SLACK_LIMIT')) {
      warn({ code: 'DIR_SLACK_PARTIAL', message: '일부 폴더의 옛 이름 흔적은 구조·세대·변경 상태를 확인하지 못해 제외했어요.' });
    }
    // Each directory pass has its own 128-clue allowance. An allocated tail
    // must not starve freed nodes just by filling its own allowance. The global
    // candidate cap still protects earlier body, trace, and tail results.
    const freedCandidates = await directoryFreedIndex.collect({
      limit: Math.max(0, maxCandidates - accepted.size - traceCandidates.length - slackCandidates.length),
      excludeCandidates: slackCandidates });
    stats.directoryFreedIndex = { ...directoryFreedIndex.stats };
    for (const clue of freedCandidates) { stop(signal); await onCandidate?.(clue); }
    stats.candidatesFound += freedCandidates.length;
    stats.undatedCandidates += freedCandidates.length;
    if (directoryFreedIndex.stats.limited) warn({ code: 'DIR_FREED_LIMIT', message: '사용 해제된 폴더 기록은 제한된 범위만 확인했어요. 추가로 남은 이름 흔적이 있을 수 있어요.' });
    if (Object.keys(directoryFreedIndex.stats.skippedByCode).some(code => code !== 'DIR_SLACK_LIMIT')) {
      warn({ code: 'DIR_FREED_PARTIAL', message: '일부 사용 해제된 폴더 기록은 구조·할당·변경 상태를 확인하지 못해 제외했어요.' });
    }
    await engine.assertUnchanged();
    if (truncated) warn({ code: 'CANDIDATE_LIMIT', message: '후보 보관 한도에 도달했어요. 결과에 포함되지 않은 기록이 있어요.' });
    discoveries.set(engine, records);
    const candidates = [...accepted.values(), ...traceCandidates, ...slackCandidates, ...freedCandidates].sort((a, b) => Number(Boolean(b.deletedAt)) - Number(Boolean(a.deletedAt))
      || (b.deletedAt ?? '').localeCompare(a.deletedAt ?? '') || a.recordNumber - b.recordNumber);
    return { strategy, candidates, warnings, truncated, complete: !truncated && warnings.length === 0 && journal.complete && (vacancy?.complete ?? true),
      stats: { ...stats, elapsedMs: performance.now() - begun, journal: journal.stats },
      coverage: { journalAvailable: journal.available, journalComplete: journal.complete, journalBounds: journal.bounds,
        journalFullRetainedRead: journal.stats.fullJournalComplete, periodReadMode: journal.stats.sourceReadMode,
        periodCoverage: journal.stats.periodCoverage, periodPhysicallyReduced: journal.stats.physicallyReduced,
        latestCoverage: journal.stats.latestCoverage, fullRetainedFallbackAvailable: journal.stats.fullRetainedFallbackAvailable,
        periodFilteredAfterFullRead: journal.stats.periodFilterMode === 'event-filter-after-full-retained-read',
        timeDirectedReadUsesObservedJournalOrder: journal.stats.physicallyReduced,
        vacancyScanned: vacancy !== null, vacancyComplete: vacancy?.complete ?? null, allDiskComplete: false,
        ...(recentPriority ? { recentPriority: { ...recentPriority }, recentPriorityCompletesVacancyScan: false } : {}),
        undatedCandidatesAreNotDateMatches: true, deletionTracesHaveNoLocatedContent: true,
        recycleMetadataExistingDiscoveriesOnly: true, recycleMetadataBodyAssociations: 0,
        recycleEnteredAtIsNotPermanentDeletionTime: true,
        directorySlackTargetedParentsOnly: true, directorySlackDeletionConfirmed: false,
        directorySlackCompleteWithinBounds: !directorySlack.stats.limited && Object.keys(directorySlack.stats.skippedByCode).length === 0,
        directorySlackUnallocatedBuffersRead: directoryFreedIndex.stats.unallocatedIndexBuffersRead, directorySlackBodyAssociations: 0,
        directoryFreedIndexCompleteWithinBounds: !directoryFreedIndex.stats.limited && Object.keys(directoryFreedIndex.stats.skippedByCode).length === 0,
        directoryClueLimitPerPass: 128, directoryClueCombinedLimit: 256,
        directoryFreedIndexExecution: directoryFreedIndex.stats.execution,
        directoryFreedIndexSkippedReason: directoryFreedIndex.stats.skippedReason,
        directoryFreedIndexFirstPositions: 64, directoryFreedIndexPerDirectoryBlockLimit: 8,
        directoryFreedIndexVolumeUnallocatedClustersRead: false }, journal };
  } finally { engine.busy = false; }
}

export async function prepareCombinedCandidate(engine, number, { signal, control } = {}) {
  if (engine.busy) fail('BUSY', '다른 작업이 진행 중이에요.');
  const found = discoveries.get(engine)?.get(number);
  if (!found) fail('SCAN_REQUIRED', '이 검색에서 찾은 후보를 선택해주세요.');
  engine.busy = true;
  try {
    stop(signal); await control?.checkpoint(); await engine.assertUnchanged();
    const record = await engine.record(number, signal);
    if (!record || record.flags !== 0 || record.baseReference !== 0n || record.fingerprint !== found.fingerprint) {
      throw recordChangedError(found, record, { stage: 'prepare-candidate', message: '선택한 파일 기록이 바뀌었어요.' });
    }
    const allocation = await engine.refreshAllocationMetadata(signal), proof = {};
    const candidate = await engine.candidate(record, signal, allocation, proof);
    if (await engine.bitmapBit(allocation.mftBitmap, number, signal)) {
      throw recordChangedError(found, record, { stage: 'prepare-candidate', message: '파일 기록 자리가 다시 사용 중이에요.', allocationChanged: true });
    }
    const after = await engine.record(number, signal);
    if (after?.fingerprint !== found.fingerprint) {
      throw recordChangedError(record, after, { stage: 'prepare-candidate', message: '확인 중 파일 기록이 바뀌었어요.' });
    }
    engine.scanned.set(number, { fingerprint: record.fingerprint, extensions: proof.extensions, candidate,
      deletionIdentity: { sequence: record.sequence, names: record.names }, recordEvidence: summarizeRecord(record) });
    return candidate;
  } finally { engine.busy = false; }
}
