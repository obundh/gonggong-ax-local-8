// Read-only NTFS $UsnJrnl:$J parsing. Field offsets follow Microsoft's
// USN_RECORD_V2 contract. No chronological stream ordering is assumed:
// https://learn.microsoft.com/en-us/windows/win32/api/winioctl/ns-winioctl-usn_record_v2
// A journal event is evidence of an observed deletion, not proof that the file
// bytes survived or that retained history contains every deletion in a period.
import { performance } from 'node:perf_hooks';

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_RECORDS = 250000;
const MAX_TIME_MS = 3000;
const MAX_EVENTS = 100000;
const MAX_RECORD_BYTES = 64 * 1024;
const CHUNK_BYTES = 1024 * 1024;
const MAX_DATE_MS = 8640000000000000;

function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
function abort(signal) { if (signal?.aborted) fail('CANCELLED', '작업을 취소했어요.'); }
function limit(value, fallback, maximum) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) fail('INVALID_LIMIT', '삭제 기록 확인 제한이 잘못됐어요.');
  return result;
}
function periodBound(value, label) {
  if (value == null) return null;
  const result = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : Number.NaN;
  if (!Number.isSafeInteger(result) || Math.abs(result) > MAX_DATE_MS) fail('INVALID_DATE_RANGE', `${label}이 올바른 날짜가 아니에요.`);
  return result;
}
function timestampMilliseconds(value) {
  if (value <= 0n) return null;
  const milliseconds = Number(value / 10000n - 11644473600000n);
  return Number.isSafeInteger(milliseconds) && Math.abs(milliseconds) <= MAX_DATE_MS ? milliseconds : null;
}
function ref(value) {
  return { recordNumber: Number(value & 0xffffffffffffn), sequence: Number(value >> 48n) };
}
function eventIdentity(event) {
  return `${event.recordNumber}:${event.sequence}:${event.parent.recordNumber}:${event.parent.sequence}:${event.name}`;
}

/**
 * Collect deletion events from allocated logical byte ranges of an initialized
 * $UsnJrnl:$J stream. Date bounds are inclusive. Selection happens while the
 * journal is parsed, before a caller needs to read any referenced MFT record.
 */
export async function readUsnDeletionEvents({ read, ranges, signal, control, onProgress,
  deletedAfter, deletedBefore, maxBytes, maxRecords, maxTimeMs, maxEvents } = {}) {
  const after = periodBound(deletedAfter, '삭제 기간 시작');
  const before = periodBound(deletedBefore, '삭제 기간 끝');
  if (after == null && before == null) fail('INVALID_DATE_RANGE', '삭제 기간의 시작 또는 끝이 필요해요.');
  if (after != null && before != null && after > before) fail('INVALID_DATE_RANGE', '삭제 기간의 시작이 끝보다 늦어요.');
  return parseUsn({ read, ranges, signal, control, onProgress, after, before,
    byteLimit: limit(maxBytes, MAX_BYTES, MAX_BYTES),
    recordLimit: limit(maxRecords, MAX_RECORDS, MAX_RECORDS),
    timeLimit: limit(maxTimeMs, MAX_TIME_MS, MAX_TIME_MS),
    eventLimit: limit(maxEvents, MAX_EVENTS, MAX_EVENTS) });
}

async function parseUsn({ read, ranges, signal, control, onProgress, after = null, before = null,
  byteLimit, recordLimit, timeLimit, eventLimit, eventPredicate = null }) {
  if (typeof read !== 'function' || !Array.isArray(ranges) || ranges.length > 65536) {
    fail('INVALID_LIMIT', '삭제 기록 저장 범위가 잘못됐어요.');
  }
  const warnings = [];
  const warn = (code, message) => { if (!warnings.some(item => item.code === code)) warnings.push({ code, message }); };
  const merged = [];
  let totalRangeBytes = 0;
  for (const item of ranges) {
    if (!Number.isSafeInteger(item?.offset) || !Number.isSafeInteger(item?.length)
      || item.offset < 0 || item.length <= 0 || !Number.isSafeInteger(item.offset + item.length)) {
      fail('INVALID_RANGE', '삭제 기록 저장 범위가 잘못됐어요.');
    }
    totalRangeBytes += item.length;
    if (!Number.isSafeInteger(totalRangeBytes)) fail('INVALID_RANGE', '삭제 기록 저장 범위가 너무 커요.');
    const previous = merged.at(-1);
    if (previous && item.offset < previous.offset + previous.length) fail('INVALID_RANGE', '삭제 기록 저장 범위가 겹치거나 정렬되지 않았어요.');
    if (previous && item.offset === previous.offset + previous.length) previous.length += item.length;
    else merged.push({ offset: item.offset, length: item.length });
  }

  // Prefer the newest allocated tail, but compare timestamps explicitly because
  // physical and logical record order is not trusted as chronological order.
  let remaining = byteLimit;
  const selected = [];
  for (let index = merged.length - 1; index >= 0 && remaining > 0; index--) {
    const current = merged[index];
    const length = Math.min(current.length, remaining);
    selected.unshift({ offset: current.offset + current.length - length, length });
    remaining -= length;
  }
  if (totalRangeBytes > byteLimit) {
    warn('USN_RANGE_LIMIT', '삭제 기록은 변경 저널의 최근 16MiB 이내에서 확인했어요. 더 오래된 기록은 포함되지 않을 수 있어요.');
  }

  const eventsByIdentity = new Map();
  const stats = { bytesRead: 0, recordsRead: 0, matchedFiles: 0, eventsFound: 0, activeMilliseconds: 0,
    journalBytesRead: 0, journalRecordsRead: 0 };
  let activeStart = performance.now();
  let activeElapsed = 0;
  let stopped = false;
  const checkpoint = async () => {
    abort(signal);
    activeElapsed += performance.now() - activeStart;
    await control?.checkpoint();
    abort(signal);
    activeStart = performance.now();
    if (activeElapsed >= timeLimit) {
      warn('USN_TIME_LIMIT', '삭제 기록 확인의 작업 시간 제한에 도달했어요. 확인된 기록만 표시해요.');
      return false;
    }
    return true;
  };
  const progress = () => {
    stats.eventsFound = [...eventsByIdentity.values()].filter(event =>
      (after == null || event.deletedAtMs >= after) && (before == null || event.deletedAtMs <= before)).length;
    stats.journalBytesRead = stats.bytesRead;
    stats.journalRecordsRead = stats.recordsRead;
    onProgress?.({ stage: 'journal', ...stats });
  };

  for (const selectedRange of selected) {
    if (stopped) break;
    // Every USN record starts on an eight-byte boundary. A bounded tail may
    // begin inside one; embedded bytes cannot pass the logical-USN check.
    let position = Math.ceil(selectedRange.offset / 8) * 8;
    const end = selectedRange.offset + selectedRange.length;
    let pending = Buffer.alloc(0);
    while (position < end || pending.length) {
      if (!(await checkpoint())) { stopped = true; break; }
      if (position < end) {
        const length = Math.min(CHUNK_BYTES - pending.length, end - position);
        const bytes = await read(position, length, signal);
        if (!Buffer.isBuffer(bytes) || bytes.length !== length) fail('READ_FAILED', '삭제 기록의 필요한 바이트를 읽지 못했어요.');
        stats.bytesRead += bytes.length;
        pending = pending.length ? Buffer.concat([pending, bytes]) : bytes;
        position += bytes.length;
        if (!(await checkpoint())) { stopped = true; break; }
      }
      let cursor = 0;
      let attempts = 0;
      while (cursor + 8 <= pending.length) {
        if (++attempts % 4096 === 0 && !(await checkpoint())) { stopped = true; break; }
        if (stats.recordsRead >= recordLimit) {
          warn('USN_RECORD_LIMIT', '삭제 기록 수 제한에 도달했어요. 확인된 기록만 표시해요.'); stopped = true; break;
        }
        const length = pending.readUInt32LE(cursor);
        const major = pending.readUInt16LE(cursor + 4);
        const minor = pending.readUInt16LE(cursor + 6);
        if (length === 0 && major === 0 && minor === 0) { cursor += 8; continue; }
        if (length < 8 || length > MAX_RECORD_BYTES || length % 8 !== 0) {
          warn('USN_MALFORMED', '일부 변경 기록의 경계를 확인하지 못해 건너뛰었어요.'); cursor += 8; continue;
        }
        if (cursor + length > pending.length) {
          if (position < end) break;
          warn('USN_TRUNCATED', '변경 기록의 일부가 잘려 있어 삭제 기록을 모두 확인하지 못했어요.'); cursor += 8; continue;
        }
        if (major !== 2 || minor !== 0) {
          warn('USN_UNSUPPORTED_VERSION', '지원하지 않는 변경 기록 버전이 있어 해당 기록은 사용하지 않아요.');
          cursor += length; continue;
        }
        if (length < 64) {
          warn('USN_MALFORMED', '일부 변경 기록의 경계를 확인하지 못해 건너뛰었어요.'); cursor += 8; continue;
        }
        const nameLength = pending.readUInt16LE(cursor + 56);
        const nameOffset = pending.readUInt16LE(cursor + 58);
        const logicalOffset = position - pending.length + cursor;
        if (nameLength < 2 || nameLength > 510 || nameLength % 2 || nameOffset < 60 || nameOffset % 2
          || nameOffset + nameLength > length
          || pending.readBigInt64LE(cursor + 24) !== BigInt(logicalOffset)) {
          warn('USN_MALFORMED', '일부 변경 기록의 이름 또는 구조를 확인하지 못해 건너뛰었어요.'); cursor += 8; continue;
        }
        stats.recordsRead++;
        if (pending.readUInt32LE(cursor + 40) & 0x200) {
          const milliseconds = timestampMilliseconds(pending.readBigInt64LE(cursor + 32));
          if (milliseconds != null) {
            const file = ref(pending.readBigUInt64LE(cursor + 8));
            const parent = ref(pending.readBigUInt64LE(cursor + 16));
            const event = { ...file, parent,
              name: pending.subarray(cursor + nameOffset, cursor + nameOffset + nameLength).toString('utf16le'),
              deletedAt: new Date(milliseconds).toISOString(), deletedAtMs: milliseconds };
            if (eventPredicate && !eventPredicate(event)) { cursor += length; continue; }
            const key = eventIdentity(event);
            const previous = eventsByIdentity.get(key);
            if (!previous && eventsByIdentity.size >= eventLimit) {
              warn('USN_EVENT_LIMIT', '변경 저널의 고유 삭제 참조 수 제한에 도달했어요. 확인된 기록만 표시해요.');
              stopped = true;
            } else if (!previous || previous.deletedAtMs < milliseconds) {
              eventsByIdentity.set(key, event);
            }
          }
        }
        cursor += length;
        if (stopped) break;
      }
      pending = Buffer.from(pending.subarray(cursor));
      if (stopped) break;
      if (position >= end) {
        if (pending.some(byte => byte !== 0)) warn('USN_TRUNCATED', '변경 기록의 일부가 잘려 있어 삭제 기록을 모두 확인하지 못했어요.');
        break;
      }
      progress();
    }
  }
  abort(signal);
  stats.eventsFound = [...eventsByIdentity.values()].filter(event =>
    (after == null || event.deletedAtMs >= after) && (before == null || event.deletedAtMs <= before)).length;
  stats.journalBytesRead = stats.bytesRead;
  stats.journalRecordsRead = stats.recordsRead;
  stats.activeMilliseconds = Math.round(activeElapsed + performance.now() - activeStart);
  const events = [...eventsByIdentity.values()].filter(event =>
    (after == null || event.deletedAtMs >= after) && (before == null || event.deletedAtMs <= before))
    .sort((a, b) => b.deletedAtMs - a.deletedAtMs
    || a.recordNumber - b.recordNumber || a.sequence - b.sequence || a.name.localeCompare(b.name));
  progress();
  return { events, warnings, complete: warnings.length === 0, truncated: warnings.some(item =>
    ['USN_RANGE_LIMIT', 'USN_RECORD_LIMIT', 'USN_TIME_LIMIT', 'USN_EVENT_LIMIT', 'USN_TRUNCATED'].includes(item.code)), stats,
    bounds: { deletedAfter: after, deletedBefore: before } };
}

/** Compatibility API used by the existing full-scan enrichment path. */
export async function readUsnDeletionTimes({ read, ranges, candidates, signal, control, onProgress,
  maxBytes, maxRecords, maxTimeMs } = {}) {
  if (!Array.isArray(candidates) || candidates.length > 10000) fail('INVALID_LIMIT', '삭제 시각 확인 후보는 10000개 이하여야 해요.');
  const identities = new Map();
  for (const candidate of candidates) {
    if (typeof candidate?.id !== 'string' || !Number.isSafeInteger(candidate.recordNumber)
      || candidate.recordNumber < 0 || candidate.recordNumber > 0xffffffffffff
      || !Number.isSafeInteger(candidate.sequence) || candidate.sequence < 1 || candidate.sequence > 65535) continue;
    const key = `${candidate.recordNumber}:${candidate.sequence}`;
    if (!identities.has(key)) identities.set(key, []);
    identities.get(key).push(candidate);
  }
  const parsed = await parseUsn({ read, ranges, signal, control, onProgress,
    byteLimit: limit(maxBytes, MAX_BYTES, MAX_BYTES), recordLimit: limit(maxRecords, MAX_RECORDS, MAX_RECORDS),
    timeLimit: limit(maxTimeMs, MAX_TIME_MS, MAX_TIME_MS), eventLimit: MAX_EVENTS,
    eventPredicate: event => (identities.get(`${event.recordNumber}:${event.sequence}`) ?? []).some(identity =>
      !identity.names || identity.names.some(item => item.name === event.name
        && item.parent?.recordNumber === event.parent.recordNumber && item.parent?.sequence === event.parent.sequence)) });
  const timestamps = new Map();
  for (const event of parsed.events) {
    const matching = identities.get(`${event.recordNumber}:${event.sequence}`) ?? [];
    for (const identity of matching) {
      const exactName = !identity.names || identity.names.some(item => item.name === event.name
        && item.parent?.recordNumber === event.parent.recordNumber && item.parent?.sequence === event.parent.sequence);
      if (exactName && (!timestamps.has(identity.id) || Date.parse(timestamps.get(identity.id)) < event.deletedAtMs)) {
        timestamps.set(identity.id, event.deletedAt);
      }
    }
  }
  parsed.stats.matchedFiles = timestamps.size;
  return { timestamps, warnings: parsed.warnings, complete: parsed.complete, truncated: parsed.truncated, stats: parsed.stats };
}
