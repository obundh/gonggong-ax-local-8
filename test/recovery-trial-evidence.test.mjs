import test from 'node:test';
import assert from 'node:assert/strict';
import { eventsForCandidate, eventsForOriginalFileId } from '../scripts/recovery-trial-evidence.mjs';

test('reused MFT slot does not attribute older generations to a recovered fixture', () => {
  const parent = { recordNumber: 500, sequence: 2 };
  const candidate = { recordNumber: 42, sequence: 13, nameReferences: [{ name: '$Rfile.pdf', parent }] };
  const old = { recordNumber: 42, sequence: 11, name: 'unrelated.tmp', parent, reason: 0x200 };
  const rename = { recordNumber: 42, sequence: 12, name: 'original.pdf', parent, reason: 0x1000 };
  const deletion = { recordNumber: 42, sequence: 12, name: '$Rfile.pdf', parent, reason: 0x200 };
  const wrongParent = { ...deletion, parent: { ...parent, sequence: 1 } };
  const wrongName = { ...deletion, name: '$Rother.pdf' };
  const events = [old, rename, deletion, wrongParent, wrongName];
  assert.deepEqual(eventsForCandidate(events, candidate), {
    generationEvents: [rename, deletion, wrongParent, wrongName], matchedDeletes: [deletion],
  });
  assert.deepEqual(eventsForCandidate(events, undefined), { generationEvents: [], matchedDeletes: [] });
  assert.deepEqual(eventsForOriginalFileId(events, ((12n << 48n) | 42n).toString()), [rename, deletion, wrongParent, wrongName]);
});
