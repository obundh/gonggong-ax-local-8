const COVERAGE_RANGE_LIMIT = 1024;

function checkedBoundary(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative safe integer`);
  return value;
}

class IntervalLedger {
  constructor() {
    this.intervals = [];
    this.total = 0;
  }

  add(offset, length) {
    const start = checkedBoundary(offset, 'offset');
    const size = checkedBoundary(length, 'length');
    if (size === 0) return;
    const end = checkedBoundary(start + size, 'range end');
    // Scans advance monotonically. Avoid walking all prior free-space ranges
    // for each new chunk while retaining merging for out-of-order callers.
    const previous = this.intervals.at(-1);
    if (!previous || start > previous.end) {
      this.intervals.push({ start, end });
      this.total += size;
      return;
    }
    if (start >= previous.start) {
      this.total += Math.max(0, end - previous.end);
      previous.end = Math.max(previous.end, end);
      return;
    }
    let index = 0;
    while (index < this.intervals.length && this.intervals[index].end < start) index++;
    let mergedStart = start;
    let mergedEnd = end;
    let removed = 0;
    let last = index;
    while (last < this.intervals.length && this.intervals[last].start <= mergedEnd) {
      const current = this.intervals[last];
      mergedStart = Math.min(mergedStart, current.start);
      mergedEnd = Math.max(mergedEnd, current.end);
      removed += current.end - current.start;
      last++;
    }
    this.intervals.splice(index, last - index, { start: mergedStart, end: mergedEnd });
    this.total += mergedEnd - mergedStart - removed;
  }

  publicRanges() {
    return this.intervals.slice(0, COVERAGE_RANGE_LIMIT)
      .map(range => ({ offset: range.start, length: range.end - range.start }));
  }

  get truncated() { return this.intervals.length > COVERAGE_RANGE_LIMIT; }
}

export function createCarvingCoverage({ scanScope, selectedRanges, restoredState }) {
  const selectedBytes = selectedRanges.reduce((sum, range) => sum + range.length, 0);
  const examined = new IntervalLedger();
  const readErrors = new IntervalLedger();
  let scanReadBytes = 0;
  let outputBytesWritten = 0;

  if (restoredState) {
    // The checkpoint loader validates bounds against the selected source ranges.
    for (const range of restoredState.examinedRanges) examined.add(range.offset, range.length);
    for (const range of restoredState.readErrorRanges) readErrors.add(range.offset, range.length);
    scanReadBytes = checkedBoundary(restoredState.scanReadBytes, 'restored scan reads');
    outputBytesWritten = checkedBoundary(restoredState.outputBytesWritten, 'restored output writes');
  }

  return {
    get scanReadBytes() { return scanReadBytes; },
    get outputBytesWritten() { return outputBytesWritten; },

    recordScanRead(length) {
      scanReadBytes = checkedBoundary(scanReadBytes + checkedBoundary(length, 'scan read length'), 'scan read total');
    },

    recordOutputWrite(length) {
      outputBytesWritten = checkedBoundary(outputBytesWritten + checkedBoundary(length, 'output write length'), 'output write total');
    },

    markExamined(offset, length) { examined.add(offset, length); },
    markReadError(offset, length) { readErrors.add(offset, length); },

    exportState() {
      // Public progress is truncated for the UI; restart accounting must retain every interval.
      const all = ledger => ledger.intervals.map(({ start, end }) => ({ offset: start, length: end - start }));
      return { scanReadBytes, outputBytesWritten, examinedRanges: all(examined), readErrorRanges: all(readErrors) };
    },

    snapshot({ stopReason = null, complete = false } = {}) {
      return {
        version: 1,
        strategy: 'carving',
        scanScope,
        selectedBytes,
        scanReadBytes,
        examinedBytes: examined.total,
        unexaminedBytes: selectedBytes - examined.total,
        readErrorBytes: readErrors.total,
        outputBytesWritten,
        stopReason,
        complete,
        examinedRanges: examined.publicRanges(),
        readErrorRanges: readErrors.publicRanges(),
        rangesTruncated: examined.truncated || readErrors.truncated
      };
    }
  };
}

export { COVERAGE_RANGE_LIMIT };
