// Native FSCTL buffers contain a continuation USN followed by filtered records.
// Unlike raw $J bytes, record USNs need not match offsets in this buffer.
import { performance } from 'node:perf_hooks';

function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function stop(signal) { if (signal?.aborted) fail('CANCELLED', '작업을 취소했어요.'); }
function integer64(value) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) fail('USN_PROTOCOL', '변경 기록 위치 형식이 잘못됐어요.');
  const n = BigInt(value);
  if (n > 0x7fffffffffffffffn) fail('USN_PROTOCOL', '변경 기록 위치가 범위를 벗어났어요.');
  return n;
}
function timeBound(value) {
  if (value == null) return null;
  const n = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isSafeInteger(n) || Math.abs(n) > 8640000000000000) fail('INVALID_DATE_RANGE', '삭제 기간이 잘못됐어요.');
  return n;
}
function reference(n) { return { recordNumber: Number(n & 0xffffffffffffn), sequence: Number(n >> 48n) }; }

export function parseNativeUsnBatch(data, { startUsn, endUsn } = {}) {
  if (!Buffer.isBuffer(data) || data.length < 8 || data.length > 1048576) fail('USN_PROTOCOL', '변경 기록 응답 크기가 잘못됐어요.');
  const start = integer64(startUsn), end = integer64(endUsn), next = data.readBigInt64LE(0);
  if (next < start) fail('USN_PROTOCOL', '변경 기록 위치가 뒤로 이동했어요.');
  let offset = 8, previous = start - 1n;
  const events = [], warnings = [];
  while (offset < data.length) {
    if (offset + 8 > data.length) fail('USN_PROTOCOL', '변경 기록 응답이 잘렸어요.');
    const length = data.readUInt32LE(offset), major = data.readUInt16LE(offset + 4), minor = data.readUInt16LE(offset + 6);
    if (length < 8 || length > 65536 || length % 8 || offset + length > data.length) fail('USN_PROTOCOL', '변경 기록 경계가 잘못됐어요.');
    if (major !== 2 || minor !== 0) {
      if (!warnings.length) warnings.push({ code: 'USN_UNSUPPORTED_VERSION', message: '지원하지 않는 변경 기록 버전을 건너뛰었어요.' });
      offset += length; continue;
    }
    if (length < 64) fail('USN_PROTOCOL', '변경 기록 헤더가 잘렸어요.');
    const usn = data.readBigInt64LE(offset + 24), nameLength = data.readUInt16LE(offset + 56), nameOffset = data.readUInt16LE(offset + 58);
    if (usn < start || usn <= previous || usn >= next || nameLength < 2 || nameLength > 510 || nameLength % 2
      || nameOffset < 60 || nameOffset % 2 || nameOffset + nameLength > length) fail('USN_PROTOCOL', '변경 기록 식별자 또는 이름 경계가 잘못됐어요.');
    previous = usn;
    const name = data.subarray(offset + nameOffset, offset + nameOffset + nameLength).toString('utf16le');
    if (name.includes('\0') || /[\\/]/.test(name)) fail('USN_PROTOCOL', '변경 기록 파일 이름이 잘못됐어요.');
    const stamp = data.readBigInt64LE(offset + 32), timestamp = Number(stamp / 10000n - 11644473600000n);
    const atMs = stamp > 0n && Number.isSafeInteger(timestamp) && Math.abs(timestamp) <= 8640000000000000 ? timestamp : null;
    if (usn < end) events.push({ ...reference(data.readBigUInt64LE(offset + 8)), parent: reference(data.readBigUInt64LE(offset + 16)),
      name, usn: usn.toString(), reason: data.readUInt32LE(offset + 40), fileAttributes: data.readUInt32LE(offset + 52), atMs, at: atMs === null ? null : new Date(atMs).toISOString() });
    offset += length;
  }
  return { nextUsn: next.toString(), events, warnings };
}

export async function readNativeJournal(provider, { signal, control, onProgress, startUsn, deletedAfter, deletedBefore,
  maxBytes = 64 * 1024 * 1024, maxEvents = 200000, maxTimeMs = 30000, recentTailUsn = 8 * 1024 * 1024,
  periodReadStrategy = 'auto', latestFirst = false } = {}) {
  for (const [n, max] of [[maxBytes, 256 * 1024 * 1024], [maxEvents, 500000], [maxTimeMs, 120000], [recentTailUsn, 256 * 1024 * 1024]]) {
    if (!Number.isSafeInteger(n) || n < 1 || n > max) fail('INVALID_LIMIT', '변경 기록 읽기 제한이 잘못됐어요.');
  }
  const after = timeBound(deletedAfter), before = timeBound(deletedBefore);
  if (after !== null && before !== null && after > before) fail('INVALID_DATE_RANGE', '삭제 기간이 역순이에요.');
  if (!['auto', 'full-retained'].includes(periodReadStrategy)) fail('INVALID_STRATEGY', '변경 기록 읽기 방식이 잘못됐어요.');
  const events = [], warnings = [], stats = { bytesRead: 0, batchesRead: 0, eventsRead: 0, overreadEventsDiscarded: 0, overreadBatches: 0,
    invalidCursorFallbacks: 0 };
  const seenUsns = new Set();
  let bounds = null, cursor = null, complete = false, available = false, fullJournalComplete = false;
  const periodRequested = after !== null || before !== null;
  let retainedStart = null, fixedEnd = null, readStart = null, periodCoverage = periodRequested ? 'unknown' : 'not-requested';
  let sourceReadMode = 'unavailable', rangePasses = 0, rangeExpansionCount = 0, timeOrderSupported = true, latestCoverage = latestFirst ? 'unknown' : 'not-requested';
  const begun = performance.now();
  const warn = (code, message) => { if (!warnings.some(w => w.code === code)) warnings.push({ code, message }); };
  const limitsReached = () => performance.now() - begun >= maxTimeMs || maxBytes - stats.bytesRead < 65536 || events.length >= maxEvents;
  const readRange = async (from, to, journalId) => {
    let position = from;
    rangePasses++;
    while (position < to) {
      stop(signal); await control?.checkpoint(); stop(signal);
      if (limitsReached()) {
        warn('USN_BUDGET_LIMIT', '변경 기록 읽기 한도에 도달해 일부 범위만 확인했어요.');
        return { cursor: position, complete: false };
      }
      let response;
      try {
        response = await provider.readJournal({ startUsn: position.toString(), journalId,
          maxBytes: Math.min(1048576, maxBytes - stats.bytesRead), signal });
      } catch (error) {
        // A byte-distance tail estimate need not be a valid record cursor.
        // Retry once from the OS-reported retained boundary, with the same
        // journal ID, end cursor and remaining budgets. Never guess forward
        // past a failed record or reset an explicitly supplied caller cursor.
        if (error.code !== 'JOURNAL_INVALID_PARAMETER' || startUsn !== undefined
            || from <= retainedStart || stats.invalidCursorFallbacks) throw error;
        stats.invalidCursorFallbacks++;
        readStart = retainedStart; rangeExpansionCount++;
        sourceReadMode = 'full-retained-cursor-fallback';
        return readRange(retainedStart, to, journalId);
      }
      stop(signal);
      const batch = parseNativeUsnBatch(response.data, { startUsn: position.toString(), endUsn: fixedEnd.toString() });
      stats.bytesRead += response.data.length; stats.batchesRead++;
      for (const warning of batch.warnings) warn(warning.code, warning.message);
      const logicalEvents = batch.events.filter(event => BigInt(event.usn) < to);
      if (logicalEvents.length !== batch.events.length) {
        stats.overreadBatches++; stats.overreadEventsDiscarded += batch.events.length - logicalEvents.length;
      }
      for (const event of logicalEvents) {
        if (events.length >= maxEvents) { warn('USN_EVENT_LIMIT', '변경 사건 보관 한도에 도달했어요.'); break; }
        if (!seenUsns.has(event.usn)) { seenUsns.add(event.usn); events.push(event); }
      }
      stats.eventsRead = events.length;
      const next = integer64(batch.nextUsn);
      onProgress?.({ stage: 'native-journal', ...stats, nextUsn: next.toString(), endUsn: fixedEnd.toString(),
        rangeStartUsn: from.toString(), rangeEndUsn: to.toString(), sourceReadMode });
      if (next === position) { warn('USN_CURSOR_GAP', '변경 기록 끝까지 이어 읽지 못했어요.'); return { cursor: position, complete: false }; }
      position = next > to ? to : next;
    }
    return { cursor: position, complete: true };
  };
  try {
    stop(signal); await control?.checkpoint();
    if (typeof provider?.queryJournal !== 'function' || typeof provider?.readJournal !== 'function') fail('USN_UNAVAILABLE', 'Windows 변경 기록 API를 사용할 수 없어요.');
    const first = await provider.queryJournal({ signal });
    const lower = integer64(first.firstUsn) > integer64(first.lowestValidUsn) ? first.firstUsn : first.lowestValidUsn;
    const end = integer64(first.nextUsn);
    retainedStart = integer64(lower); fixedEnd = end;
    cursor = startUsn === undefined ? retainedStart : integer64(startUsn);
    if (cursor < retainedStart || cursor > end) fail('USN_CURSOR_GAP', '요청한 변경 기록 시작점이 보존 범위를 벗어났어요.');
    const tailDirected = startUsn === undefined && periodReadStrategy === 'auto' && cursor < end && (after !== null || latestFirst);
    const periodDirected = tailDirected && after !== null, latestTailDirected = tailDirected && after === null;
    if (tailDirected) cursor = end - retainedStart > BigInt(recentTailUsn) ? end - BigInt(recentTailUsn) : retainedStart;
    readStart = cursor;
    sourceReadMode = startUsn !== undefined ? 'supplied-cursor' : periodDirected ? 'recent-tail-bounded'
      : latestTailDirected ? 'latest-tail-bounded' : 'full-retained-journal';
    bounds = { journalId: first.journalId, startUsn: cursor.toString(), endUsn: end.toString(), retainedFirstUsn: lower,
      suppliedCursor: startUsn !== undefined, requestedAfter: after === null ? null : new Date(after).toISOString(),
      requestedBefore: before === null ? null : new Date(before).toISOString() };
    available = true;
    if (!tailDirected) {
      const range = await readRange(cursor, end, first.journalId);
      cursor = range.cursor;
      complete = range.complete && cursor >= end && warnings.length === 0;
      fullJournalComplete = complete && readStart === retainedStart;
      periodCoverage = !periodRequested ? 'not-requested' : startUsn === undefined ? 'full-retained-range' : 'supplied-cursor-unverified';
      if (periodRequested && startUsn === undefined && fullJournalComplete) {
        const dated = events.filter(event => event.atMs !== null);
        const oldest = dated.reduce((value, event) => value === null || event.atMs < value ? event.atMs : value, null);
        const requestedBoundary = after ?? before;
        if (oldest !== null && requestedBoundary !== null && oldest > requestedBoundary) {
          complete = false; periodCoverage = 'retained-history-exhausted';
          warn('USN_RETAINED_RANGE_LIMIT', '보존된 변경 기록이 요청 기간까지 이어지는지 확인하지 못했어요. 이전 기록은 롤오버됐을 수 있어요.');
        } else if (events.length && !dated.length) {
          complete = false; periodCoverage = 'timestamps-unavailable';
          warn('USN_TIME_RANGE_UNSUPPORTED', '변경 기록에 사용할 수 있는 시간이 없어 보존 범위 전체를 읽은 뒤 기간 필터만 적용했어요.');
        }
      }
      if (periodRequested && startUsn === undefined && fullJournalComplete && events.length === 0) {
        complete = false; periodCoverage = 'retained-history-empty';
        warn('USN_RETAINED_RANGE_LIMIT', '보존된 변경 기록이 비어 있어 요청 기간의 과거 기록 보존 여부를 확인할 수 없어요.');
      }
    } else if (latestTailDirected) {
      const range = await readRange(cursor, end, first.journalId);
      cursor = range.cursor; fullJournalComplete = range.complete && readStart === retainedStart;
      if (fullJournalComplete) {
        complete = warnings.length === 0; sourceReadMode = 'full-retained-journal'; latestCoverage = 'full-retained-range';
      } else if (range.complete) {
        latestCoverage = 'latest-tail-partial';
        warn('USN_LATEST_TAIL_PARTIAL', '최신 변경 기록 구간을 먼저 확인했어요. 읽지 않은 이전 보존 구간은 전체 기록 검색에서 확인할 수 있어요.');
      } else latestCoverage = 'budget-limited';
    } else {
      let segmentEnd = end, segmentStart = cursor, rangeOkay = true, boundaryObserved = false;
      while (rangeOkay) {
        const range = await readRange(segmentStart, segmentEnd, first.journalId);
        if (stats.invalidCursorFallbacks) segmentStart = retainedStart;
        cursor = range.cursor;
        if (!range.complete) { rangeOkay = false; break; }
        const ordered = events.filter(event => event.atMs !== null).sort((a, b) => BigInt(a.usn) < BigInt(b.usn) ? -1 : 1);
        for (let index = 1; index < ordered.length; index++) {
          if (ordered[index].atMs < ordered[index - 1].atMs) { timeOrderSupported = false; break; }
        }
        boundaryObserved = timeOrderSupported && ordered.some(event => event.atMs <= after);
        if (boundaryObserved || segmentStart === retainedStart) break;
        segmentEnd = segmentStart;
        const visitedSpan = end - segmentStart, nextSpan = visitedSpan * 2n;
        segmentStart = nextSpan >= end - retainedStart ? retainedStart : end - nextSpan;
        readStart = segmentStart; rangeExpansionCount++;
      }
      fullJournalComplete = rangeOkay && readStart === retainedStart;
      if (!timeOrderSupported) {
        warn('USN_TIME_ORDER_UNSUPPORTED', '변경 기록 시간이 순서대로 증가하지 않아 보존 범위 전체를 확인했어요.');
        while (rangeOkay && readStart > retainedStart) {
          const segmentEndFallback = readStart;
          readStart = retainedStart; rangeExpansionCount++;
          const range = await readRange(readStart, segmentEndFallback, first.journalId);
          cursor = range.cursor; rangeOkay = range.complete; fullJournalComplete = rangeOkay;
        }
      }
      if (boundaryObserved && timeOrderSupported && readStart > retainedStart) {
        periodCoverage = 'observed-boundary-partial';
        warn('USN_TIME_DIRECTED_PARTIAL', '요청 기간보다 오래된 시간 경계는 관측했지만 읽지 않은 이전 구간에는 시간 미상 또는 시계 변경 기록이 있을 수 있어요. 전체 보존 범위 확인을 선택할 수 있어요.');
      } else if (boundaryObserved && timeOrderSupported) {
        complete = rangeOkay && warnings.length === 0; periodCoverage = 'full-retained-range';
      }
      else if (fullJournalComplete && events.some(event => event.atMs !== null)) {
        periodCoverage = 'retained-history-exhausted';
        warn('USN_RETAINED_RANGE_LIMIT', '보존된 변경 기록에서 요청 기간보다 오래된 시간 경계를 확인하지 못했어요. 이전 기록은 롤오버됐거나 그 기간에 시간 정보가 없을 수 있어요.');
      } else if (fullJournalComplete) {
        periodCoverage = 'timestamps-unavailable';
        warn('USN_TIME_RANGE_UNSUPPORTED', '변경 기록에 사용할 수 있는 시간이 없어 보존 범위 전체를 읽은 뒤 기간 필터만 적용했어요.');
      } else periodCoverage = warnings.some(w => ['USN_ENTRY_DELETED', 'JOURNAL_ENTRY_DELETED'].includes(w.code)) ? 'journal-lost-during-read' : 'budget-limited';
      if (fullJournalComplete && !stats.invalidCursorFallbacks) sourceReadMode = 'full-retained-fallback';
    }
  } catch (error) {
    if (['CANCELLED', 'SOURCE_CHANGED', 'DEVICE_CHANGED', 'READ_FAILED'].includes(error.code)) throw error;
    warn(error.code ?? 'USN_UNAVAILABLE', error.message); complete = false;
    if (available && after !== null && ['USN_ENTRY_DELETED', 'JOURNAL_ENTRY_DELETED'].includes(error.code)) periodCoverage = 'journal-lost-during-read';
  }
  events.sort((a, b) => BigInt(a.usn) < BigInt(b.usn) ? -1 : BigInt(a.usn) > BigInt(b.usn) ? 1 : 0);
  let datedEvents = 0, oldestDatedMs = null, newestDatedMs = null;
  for (const event of events) {
    if (event.atMs === null) continue;
    datedEvents++;
    if (oldestDatedMs === null || event.atMs < oldestDatedMs) oldestDatedMs = event.atMs;
    if (newestDatedMs === null || event.atMs > newestDatedMs) newestDatedMs = event.atMs;
  }
  const physicallyReduced = available && retainedStart !== null && readStart !== null && readStart > retainedStart;
  if (latestFirst && latestCoverage === 'unknown') latestCoverage = fullJournalComplete ? 'full-retained-range'
    : physicallyReduced ? 'latest-tail-partial' : 'incomplete';
  const fullRetainedFallbackAvailable = physicallyReduced && ['recent-tail-bounded', 'latest-tail-bounded'].includes(sourceReadMode);
  if (bounds) {
    bounds.actualReadStartUsn = readStart?.toString() ?? bounds.startUsn;
    bounds.fullRetainedRead = fullJournalComplete; bounds.periodCoverage = periodCoverage;
  }
  return { events, warnings, stats: { ...stats, elapsedMs: performance.now() - begun, sourceReadMode,
      periodFilterMode: !periodRequested ? 'not-requested' : !available ? 'unavailable'
        : physicallyReduced ? 'source-range-and-event-filter' : 'event-filter-after-full-retained-read',
      physicallyReduced, fullJournalComplete, periodCoverage, latestCoverage, timeOrderSupported, rangePasses, rangeExpansionCount,
      timeDirectedHeuristic: sourceReadMode === 'recent-tail-bounded' && physicallyReduced,
      fullRetainedFallbackAvailable,
      datedEvents, unknownTimeEvents: events.length - datedEvents,
      oldestDatedAt: oldestDatedMs === null ? null : new Date(oldestDatedMs).toISOString(),
      newestDatedAt: newestDatedMs === null ? null : new Date(newestDatedMs).toISOString(),
      retainedStartUsn: retainedStart?.toString() ?? null, readStartUsn: readStart?.toString() ?? null,
      fixedEndUsn: fixedEnd?.toString() ?? null,
      retainedUsnSpan: retainedStart === null || fixedEnd === null ? null : (fixedEnd - retainedStart).toString(),
      visitedUsnSpan: readStart === null || fixedEnd === null ? null : (fixedEnd - readStart).toString(),
      skippedUsnSpan: retainedStart === null || readStart === null ? null : (readStart - retainedStart).toString() }, available, complete,
    truncated: warnings.some(w => /LIMIT/.test(w.code)), bounds, nextUsn: cursor?.toString() ?? null };
}
