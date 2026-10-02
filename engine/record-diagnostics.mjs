import { createHash } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex');
const jsonHash = value => hash(JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item));
const namesOf = record => (record?.nameReferences ?? record?.names ?? []).map(item => typeof item === 'string'
  ? { name: item } : { name: item.name, namespace: item.namespace, parent: item.parent });

// Keep bounded structural evidence, never resident document bytes, in diagnostics.
// Hashes of the raw record and individual regions allow later comparisons without
// multiplying raw MFT buffers in the candidate store.
export function captureRecordEvidence(raw, fixed, record) {
  const used = fixed.readUInt32LE(24), attrStart = fixed.readUInt16LE(20);
  const usaOffset = raw.readUInt16LE(4), usaLength = raw.readUInt16LE(6) * 2;
  const data = record.attributes.filter(item => item.type === 0x80).map(item => ({
    name: item.name, resident: item.resident, flags: item.flags, size: item.size,
    initializedSize: item.initializedSize, allocatedSize: item.allocatedSize,
    firstVcn: item.firstVcn, lastVcn: item.lastVcn, runs: item.runs,
    valueHash: Buffer.isBuffer(item.value) ? hash(item.value) : null, problem: item.problem,
  }));
  return {
    version: 1, recordNumber: record.recordNumber, sequence: record.sequence,
    flags: record.flags, baseReference: String(record.baseReference), fingerprint: record.fingerprint,
    names: namesOf(record).slice(0, 8), namesHash: jsonHash(namesOf(record)),
    dataLayoutHash: jsonHash(data), dataStreams: data.slice(0, 8).map(item => ({
      name: item.name, resident: item.resident, size: item.size, flags: item.flags,
      runCount: item.runs?.length ?? 0, runsHash: jsonHash(item.runs ?? []),
    })),
    regions: {
      logSequence: raw.readBigUInt64LE(8).toString(),
      updateSequenceHash: hash(raw.subarray(usaOffset, usaOffset + usaLength)),
      attributesHash: hash(fixed.subarray(attrStart, used)),
      slackHash: hash(fixed.subarray(used)),
    },
  };
}

export function summarizeRecord(record) {
  if (!record) return null;
  const evidence = record.recordEvidence ?? {};
  const names = namesOf(record);
  return { ...evidence, recordNumber: record.recordNumber ?? evidence.recordNumber,
    sequence: record.sequence ?? evidence.sequence, flags: record.flags ?? evidence.flags,
    baseReference: record.baseReference !== undefined ? String(record.baseReference) : evidence.baseReference,
    fingerprint: record.fingerprint ?? evidence.fingerprint,
    names: names.length ? names.slice(0, 8) : evidence.names ?? [],
    namesHash: names.length ? jsonHash(names) : evidence.namesHash,
  };
}

export function compareRecordEvidence(expectedRecord, observedRecord, { allocationChanged = false } = {}) {
  const expected = summarizeRecord(expectedRecord), observed = summarizeRecord(observedRecord);
  const changes = [];
  if (!observed) return { classification: 'record-missing', expected, observed, changes: ['record-missing'], physicalErasureProven: false };
  for (const key of ['sequence', 'flags', 'baseReference', 'fingerprint', 'namesHash', 'dataLayoutHash']) {
    if (expected?.[key] !== undefined && observed[key] !== undefined && expected[key] !== observed[key]) changes.push(key);
  }
  for (const key of ['logSequence', 'updateSequenceHash', 'attributesHash', 'slackHash']) {
    if (expected?.regions?.[key] !== undefined && observed.regions?.[key] !== undefined
      && expected.regions[key] !== observed.regions[key]) changes.push(key);
  }
  if (allocationChanged) changes.push('allocation');
  const generationChanged = changes.includes('sequence');
  const reused = generationChanged && (Boolean(observed.flags & 1) || changes.includes('namesHash'));
  const classification = reused ? 'record-reused' : generationChanged ? 'record-generation-changed'
    : allocationChanged || changes.includes('flags') ? 'allocation-state-changed'
      : changes.includes('dataLayoutHash') ? 'data-layout-changed'
        : changes.length ? 'same-generation-record-changed' : 'change-unclassified';
  return { classification, expected, observed, changes, physicalErasureProven: false };
}

export function recordChangedError(expected, observed, { stage = 'record-validation', message = '파일 기록이 바뀌어 복구를 중단했어요.', allocationChanged = false } = {}) {
  return Object.assign(new Error(message), { code: 'SOURCE_CHANGED',
    details: { stage, recordChange: compareRecordEvidence(expected, observed, { allocationChanged }) } });
}
