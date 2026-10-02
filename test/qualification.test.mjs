import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRunPolicy, validateOracle, validatePlan, workerArgv } from '../scripts/verify-stage3.mjs';
import { scoreCase } from '../scripts/qualification-score.mjs';

const hash = 'a'.repeat(64);
const planCase = (overrides = {}) => ({ id: 'evaluation-case', cohort: 'evaluation', input: 'C:/fixture.img', inputSha256: hash, size: 64, modes: ['metadata', 'deep'], ...overrides });
const target = (overrides = {}) => ({ id: 'target-1', name: 'original.txt', size: 4, sha256: 'b'.repeat(64), recordNumber: 7, expected: { bodyIntact: true, metadataExact: true, metadataAbsent: false, deepExact: true }, ...overrides });
const oracleCase = (overrides = {}) => ({ id: 'evaluation-case', cohort: 'evaluation', synthetic: true, layout: 'contiguous', sourceSha256: hash, targets: [target()], ...overrides });
const validPlan = () => ({ version: 1, cases: [planCase()] });
const validOracle = () => ({ version: 1, cases: [oracleCase()] });

test('qualification plan requires selected, integrity-checked cases and finite policy', () => {
  assert.throws(() => validatePlan({ version: 1, cases: [] }, 'evaluation'), /nonempty cases/);
  assert.throws(() => validatePlan({ version: 1, cases: [planCase({ modes: [] })] }, 'evaluation'), /modes must be nonempty/);
  assert.throws(() => validatePlan({ version: 1, cases: [planCase({ inputSha256: 'not-a-hash' })] }, 'evaluation'), /SHA-256/);
  assert.throws(() => validatePlan({ version: 1, cases: [planCase({ cohort: 'other' })] }, 'evaluation'), /cohort/);
  assert.throws(() => parseRunPolicy('evaluation', '1e3'), /repetitions/);
  assert.throws(() => parseRunPolicy('other', '2'), /cohort/);
  assert.deepEqual(parseRunPolicy('evaluation', '10'), { cohort: 'evaluation', repetitions: 10 });
});

test('qualification oracle rejects malformed, unmatched, unsupported public, and implicit expectations', () => {
  const plan = validPlan(); const selected = validatePlan(plan, 'evaluation');
  assert.throws(() => validateOracle({ publicinputs: [] }, plan, selected), /version 1/);
  assert.throws(() => validateOracle({ version: 1, cases: [oracleCase({ id: 'missing' })] }, plan, selected), /does not exist/);
  assert.throws(() => validateOracle({ version: 1, cases: [oracleCase({ sourceSha256: 'c'.repeat(64) })] }, plan, selected), /mismatch/);
  assert.throws(() => validateOracle({ version: 1, cases: [oracleCase({ targets: [target({ expected: { bodyIntact: true, metadataExact: true, deepExact: true } })] })] }, plan, selected), /metadataAbsent/);
  assert.throws(() => validateOracle({ version: 1, cases: [oracleCase({ synthetic: true, layout: '' })] }, plan, selected), /synthetic fields/);
  assert.equal(validateOracle(validOracle(), plan, selected).get('evaluation-case').id, 'evaluation-case');
});

test('public deep and metadata cases use only supported association fields', () => {
  const deepPlan = { version: 1, cases: [planCase({ modes: ['deep-whole'] })] }; const deepSelected = validatePlan(deepPlan, 'evaluation');
  const publicDeep = { version: 1, cases: [oracleCase({ cohort: undefined, synthetic: undefined, layout: undefined, targets: [target({ recordNumber: undefined, expected: { bodyIntact: true, deepExact: true } })] })] };
  assert.equal(validateOracle(publicDeep, deepPlan, deepSelected).size, 1);
  const publicMetadata = { version: 1, cases: [oracleCase({ cohort: undefined, synthetic: undefined, layout: undefined, targets: [target({ recordNumber: undefined, expected: { bodyIntact: true, metadataExact: true, metadataAbsent: false } })] })] };
  const metadataPlan = { version: 1, cases: [planCase({ modes: ['metadata'] })] };
  assert.equal(validateOracle(publicMetadata, metadataPlan, validatePlan(metadataPlan, 'evaluation')).size, 1);
  assert.throws(() => validateOracle({ version: 1, cases: [oracleCase({ targets: [target({ recordNumber: undefined, expected: { bodyIntact: false, metadataExact: false, metadataAbsent: true, deepExact: false } })] })] }, metadataPlan, validatePlan(metadataPlan, 'evaluation')), /recordNumber is required/);
});

test('metadata refusal permits discovery but rejects a saved associated output', () => {
  const refusal = target({ expected: { bodyIntact: false, metadataExact: false, metadataAbsent: false, deepExact: false, metadataRefused: true } });
  const discoveredOnly = scoreCase({ targets: [refusal] }, { outputs: [], candidates: [{ recordNumber: 7 }] }, 'metadata');
  assert.equal(discoveredOnly[0].pass, true);
  const saved = scoreCase({ targets: [refusal] }, { outputs: [{ path: 'C:/out', size: 4, sha256: 'c'.repeat(64), recordNumber: 7 }], candidates: [{ recordNumber: 7 }] }, 'metadata');
  assert.equal(saved[0].pass, false);
});

test('scoring refuses implicit negative expectations and malformed worker results', () => {
  assert.throws(() => scoreCase({ targets: [target({ expected: { bodyIntact: false, metadataExact: false, metadataAbsent: false } })] }, { outputs: [], candidates: [] }, 'deep'), /deepExact/);
  assert.throws(() => scoreCase({ targets: [target()] }, { outputs: null, candidates: [] }, 'metadata'), /outputs and candidates/);
  const rows = scoreCase({ targets: [target()] }, { outputs: [{ path: 'C:/out', size: 4, sha256: 'b'.repeat(64), recordNumber: 7 }], candidates: [{ recordNumber: 7 }] }, 'metadata');
  assert.equal(rows[0].pass, true);
});

test('engine worker arguments have no oracle payload slot', () => {
  assert.deepEqual(workerArgv('worker.mjs', 'engine-root', 'image.img', 'deep', 'out'), ['worker.mjs', 'engine-root', 'image.img', 'deep', 'out']);
  assert.throws(() => workerArgv('worker.mjs', 'engine-root', 'image.img', 'oracle', 'out'), /Unexpected mode/);
});
