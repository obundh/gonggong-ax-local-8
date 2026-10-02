import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDeepLimits } from '../engine/deep-limits.mjs';
import { deepCoverageView, deepSearchLimits } from '../ui/deep-coverage.mjs';

test('deep limits require explicit positive byte bounds and preserve full-search defaults', () => {
  assert.deepEqual(normalizeDeepLimits(undefined), {});
  assert.equal(deepSearchLimits('full'), undefined);
  const small = deepSearchLimits('small');
  assert.deepEqual(normalizeDeepLimits(small), { maxScanBytes: 1073741824, maxOutputBytes: 268435456 });
  assert.deepEqual(normalizeDeepLimits(deepSearchLimits('medium')), { maxScanBytes: 4294967296, maxOutputBytes: 1073741824 });
  for (const value of [null, [], 3, { maxScanBytes: 0 }, { maxScanBytes: -1 }, { maxScanBytes: '10' },
    { maxOutputBytes: 1.1 }, { maxOutputBytes: Infinity }, { maxScanBytes: Number.MAX_SAFE_INTEGER + 1 }, { maxTime: 10 }]) {
    assert.throws(() => normalizeDeepLimits(value), { code: 'INVALID_DEEP_LIMITS' });
  }
});

test('coverage display never substitutes buffered read bytes for examined bytes', () => {
  const coverage = { strategy: 'carving', selectedBytes: 1048576, scanReadBytes: 1048576,
    examinedBytes: 32, unexaminedBytes: 1048544, readErrorBytes: 0, complete: false, stopReason: 'candidate-limit' };
  const view = deepCoverageView(coverage);
  assert.ok(view.percent < 1);
  assert.equal(view.incomplete, true);
  assert.match(view.label, /후보 개수 한도/);
  assert.equal(deepCoverageView({ ...coverage, examinedBytes: 1048577 }), null);
  assert.equal(deepCoverageView({ ...coverage, unexaminedBytes: 0 }), null);
  assert.equal(deepCoverageView({ strategy: 'native-journal' }), null);
  assert.equal(deepCoverageView({ ...coverage, selectedBytes: 0, examinedBytes: 0, unexaminedBytes: 0 }).percent, null);
});


test('fragmented coverage keeps exact totals with bounded public ranges and out-of-order merging', async () => {
  const { createCarvingCoverage } = await import('../engine/carving-coverage.mjs');
  const ranges=Array.from({length:10000},(_,i)=>({offset:i*32,length:16}));
  const ledger=createCarvingCoverage({scanScope:'selected-ranges',selectedRanges:ranges});
  for(const range of ranges){ledger.markExamined(range.offset,8);ledger.markExamined(range.offset+4,12);}
  ledger.markExamined(0,16); // Earlier duplicate must not inflate the total.
  const coverage=ledger.snapshot({stopReason:'end-of-ranges',complete:true});
  assert.equal(coverage.examinedBytes,160000);assert.equal(coverage.unexaminedBytes,0);
  assert.equal(coverage.examinedRanges.length,1024);assert.equal(coverage.rangesTruncated,true);
});
