const MODES = new Set(['metadata', 'deep', 'deep-whole']);
const SHA256 = /^[a-f0-9]{64}$/;

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const requireString = (value, label) => {
  if (typeof value !== 'string' || !value.trim()) throw Error(`${label} must be a nonempty string`);
  return value;
};
const requireSha256 = (value, label) => {
  if (typeof value !== 'string' || !SHA256.test(value)) throw Error(`${label} must be a lowercase SHA-256 hex string`);
  return value;
};
const requireSize = (value, label) => {
  if (!Number.isSafeInteger(value) || value < 0) throw Error(`${label} must be a nonnegative safe integer`);
  return value;
};
const requireBoolean = (value, label) => {
  if (typeof value !== 'boolean') throw Error(`${label} must be explicitly boolean`);
  return value;
};

export function validateTarget(target, modes, label = 'target') {
  if (!isObject(target)) throw Error(`${label} must be an object`);
  requireString(target.id, `${label}.id`);
  requireString(target.name, `${label}.name`);
  requireSize(target.size, `${label}.size`);
  requireSha256(target.sha256, `${label}.sha256`);
  if (!isObject(target.expected)) throw Error(`${label}.expected must be an object`);
  requireBoolean(target.expected.bodyIntact, `${label}.expected.bodyIntact`);
  if ('metadataRefused' in target.expected) requireBoolean(target.expected.metadataRefused, `${label}.expected.metadataRefused`);
  if (modes.has('metadata')) {
    requireBoolean(target.expected.metadataExact, `${label}.expected.metadataExact`);
    requireBoolean(target.expected.metadataAbsent, `${label}.expected.metadataAbsent`);
    const hasRecordNumber = target.recordNumber !== undefined;
    if (hasRecordNumber && (!Number.isSafeInteger(target.recordNumber) || target.recordNumber < 0)) throw Error(`${label}.recordNumber must be a nonnegative safe integer`);
    if ((target.expected.metadataAbsent || target.expected.metadataRefused) && !hasRecordNumber) throw Error(`${label}.recordNumber is required for metadata absence or refusal`);
  }
  if (modes.has('deep') || modes.has('deep-whole')) requireBoolean(target.expected.deepExact, `${label}.expected.deepExact`);
}

export function validateResult(result) {
  if (!isObject(result)) throw Error('Worker result must be an object');
  if (!Array.isArray(result.outputs) || !Array.isArray(result.candidates)) throw Error('Worker result must contain outputs and candidates arrays');
  for (const [index, output] of result.outputs.entries()) {
    if (!isObject(output)) throw Error(`result.outputs[${index}] must be an object`);
    requireString(output.path, `result.outputs[${index}].path`);
    requireSize(output.size, `result.outputs[${index}].size`);
    requireSha256(output.sha256, `result.outputs[${index}].sha256`);
  }
  for (const [index, candidate] of result.candidates.entries()) if (!isObject(candidate)) throw Error(`result.candidates[${index}] must be an object`);
}

// This module sees the oracle only after the engine has finished and output is frozen.
export function scoreCase(answer, result, mode) {
  if (!MODES.has(mode)) throw Error('Unsupported scoring mode');
  if (!isObject(answer) || !Array.isArray(answer.targets) || !answer.targets.length) throw Error('Oracle case must contain at least one target');
  const modes = new Set([mode]);
  for (const [index, target] of answer.targets.entries()) validateTarget(target, modes, `oracle target ${index}`);
  validateResult(result);
  const positiveKey = mode === 'metadata' ? 'metadataExact' : 'deepExact';
  return answer.targets.map(target => {
    const exactOutputs = result.outputs.filter(output => output.sha256 === target.sha256 && output.size === target.size);
    const hasRecordNumber = Number.isSafeInteger(target.recordNumber);
    const associated = mode === 'metadata' && hasRecordNumber ? result.candidates.filter(candidate => candidate.recordNumber === target.recordNumber) : [];
    const recordOutputs = mode === 'metadata' && hasRecordNumber ? result.outputs.filter(output => output.recordNumber === target.recordNumber) : [];
    const expectedExact = target.expected[positiveKey];
    const forbiddenExact = !target.expected.bodyIntact;
    const metadataRefused = mode === 'metadata' && target.expected.metadataRefused === true;
    const wrongBodySaved = mode === 'metadata' && hasRecordNumber ? recordOutputs.some(output => output.sha256 !== target.sha256) : null;
    const unexpectedClaim = hasRecordNumber && result.outputs.some(output => output.recordNumber === target.recordNumber && output.originalIdentityVerified === true && (output.sha256 !== target.sha256 || output.size !== target.size));
    return { id: target.id, name: target.name, kind: target.kind, size: target.size, expectedExact,
      exact: exactOutputs.length > 0, duplicateExactOutputs: Math.max(0, exactOutputs.length - 1), exactPaths: exactOutputs.map(output => output.path),
      originalNameRestored: exactOutputs.some(output => !output.nameIsGenerated && output.name === target.name), metadataFound: mode === 'metadata' && !hasRecordNumber ? null : associated.length > 0,
      wrongBodySaved, unexpectedOriginalClaim: unexpectedClaim, expectedAbsence: mode === 'metadata' && target.expected.metadataAbsent, metadataRefused,
      pass: expectedExact ? exactOutputs.length > 0 && !unexpectedClaim
        : !unexpectedClaim && !(forbiddenExact && exactOutputs.length) && !(mode === 'metadata' && target.expected.metadataAbsent && associated.length) && !(metadataRefused && recordOutputs.length),
      interpretation: expectedExact ? 'positive-exact-required' : metadataRefused ? 'metadata-must-refuse-record' : forbiddenExact ? 'negative-original-must-not-be-claimed' : 'unsupported-or-missing-metadata-no-exact-requirement'
    };
  });
}
