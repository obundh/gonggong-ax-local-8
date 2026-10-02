import { buildRecycleMetadataCandidate, MAX_RECYCLE_METADATA_BYTES } from './recycle-metadata.mjs';

const MAX_ARTIFACTS = 128;
const MAX_BYTES = 8 * 1024 * 1024;
const SID = /^S-1-(?:\d+-){1,14}\d+$/;
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const reference = record => ({ recordNumber: record.recordNumber, sequence: record.sequence });
const sameReference = (a, b) => a?.recordNumber === b?.recordNumber && a?.sequence === b?.sequence;

function canonicalName(record, expected) {
  const names = record.names ?? [];
  const canonical = names.filter(n => [1, 3].includes(n.namespace) && (expected === undefined || n.name === expected));
  if (canonical.length !== 1 || names.some(n => n !== canonical[0]
    && (n.namespace !== 2 || !sameReference(n.parent, canonical[0].parent)))) {
    fail('RECYCLE_METADATA_LOCATION', '휴지통 정보의 이름·부모 기록이 모호해요.');
  }
  return canonical[0];
}

async function directoryChain(engine, parent, signal) {
  const proof = [], seen = new Set();
  for (let index = 0; index < 3; index++) {
    if (!Number.isSafeInteger(parent?.recordNumber) || parent.recordNumber < 0 || parent.recordNumber >= engine.info.recordCount
      || !Number.isInteger(parent.sequence) || parent.sequence < 1 || parent.sequence > 65535 || seen.has(parent.recordNumber)) {
      fail('RECYCLE_METADATA_LOCATION', '휴지통 부모 기록의 참조를 확인할 수 없어요.');
    }
    seen.add(parent.recordNumber);
    const record = await engine.record(parent.recordNumber, signal);
    if (!record || record.flags !== 3 || record.baseReference !== 0n || record.sequence !== parent.sequence
      || record.attributes.some(a => a.type === 0xc0 || a.type === 0x20)
      || !(await engine.bitmapBit(engine.mftBitmap, record.recordNumber, signal))) {
      fail('RECYCLE_METADATA_LOCATION', '휴지통 부모 폴더가 재사용되었거나 현재 출처를 확인할 수 없어요.');
    }
    if (index === 2) {
      if (record.recordNumber !== 5) fail('RECYCLE_METADATA_LOCATION', '볼륨 루트의 휴지통 폴더가 아니에요.');
      proof.push({ ...reference(record), fingerprint: record.fingerprint, name: '.', parent: reference(record) });
    } else {
      const selected = canonicalName(record);
      if (index === 0 ? !SID.test(selected.name) : selected.name.toLowerCase() !== '$recycle.bin') {
        fail('RECYCLE_METADATA_LOCATION', '볼륨 루트 휴지통의 사용자 폴더로 확인되지 않았어요.');
      }
      proof.push({ ...reference(record), fingerprint: record.fingerprint, name: selected.name, parent: { ...selected.parent } });
      parent = selected.parent;
    }
  }
  return proof;
}

/** Inspect only $I records already found by the caller; never enumerate another drive or MFT. */
export class DeletedRecycleInfoCollector {
  constructor(engine, { readBytes, signal, control, onProgress, maxArtifacts = MAX_ARTIFACTS, maxBytes = MAX_BYTES } = {}) {
    if (typeof readBytes !== 'function' || !Number.isInteger(maxArtifacts) || maxArtifacts < 1 || maxArtifacts > MAX_ARTIFACTS
      || !Number.isInteger(maxBytes) || maxBytes < MAX_RECYCLE_METADATA_BYTES || maxBytes > MAX_BYTES) throw new TypeError('invalid recycle metadata limits');
    Object.assign(this, { engine, readBytes, signal, control, onProgress, maxArtifacts, maxBytes });
    this.stats = { inspected: 0, artifacts: 0, bytesRead: 0, skipped: 0, limited: false, skippedByCode: {},
      maxArtifacts, maxBytes, existingDiscoveriesOnly: true, bodyAssociations: 0 };
  }

  async inspect(discovered) {
    const names = discovered.nameReferences ?? [];
    const selected = names.find(n => /^\$I[A-Z0-9]{6}(?:\.[^\\/.]+)?$/i.test(n.name));
    if (!selected) return null;
    if (this.signal?.aborted) fail('CANCELLED', '작업을 취소했어요.');
    await this.control?.checkpoint();
    if (this.signal?.aborted) fail('CANCELLED', '작업을 취소했어요.');
    if (this.stats.inspected >= this.maxArtifacts || this.stats.bytesRead + MAX_RECYCLE_METADATA_BYTES > this.maxBytes) {
      this.stats.limited = true; return null;
    }
    this.stats.inspected++;
    try {
      const record = await this.engine.record(discovered.recordNumber, this.signal);
      if (!record || record.flags !== 0 || record.baseReference !== 0n || record.sequence !== discovered.sequence
        || record.fingerprint !== discovered.fingerprint || await this.engine.bitmapBit(this.engine.mftBitmap, record.recordNumber, this.signal)) {
        fail('SOURCE_CHANGED', '휴지통 정보 파일의 기록이 검색 후 바뀌었어요.');
      }
      const name = canonicalName(record, selected.name);
      const directories = await directoryChain(this.engine, name.parent, this.signal);
      const bytes = await this.readBytes(discovered, { maxBytes: MAX_RECYCLE_METADATA_BYTES, signal: this.signal, control: this.control });
      if (!Buffer.isBuffer(bytes) || bytes.length > MAX_RECYCLE_METADATA_BYTES) fail('RECYCLE_METADATA_INVALID', '휴지통 정보 읽기 범위를 벗어났어요.');
      this.stats.bytesRead += bytes.length;
      const after = await this.engine.record(record.recordNumber, this.signal);
      if (after?.fingerprint !== record.fingerprint || await this.engine.bitmapBit(this.engine.mftBitmap, record.recordNumber, this.signal)
        || JSON.stringify(await directoryChain(this.engine, name.parent, this.signal)) !== JSON.stringify(directories)) {
        fail('SOURCE_CHANGED', '휴지통 정보를 읽는 동안 기록이나 부모 폴더가 바뀌었어요.');
      }
      const artifact = buildRecycleMetadataCandidate({ record: { ...discovered, name: name.name }, bytes, directoryEvidence: directories });
      this.stats.artifacts++;
      this.onProgress?.({ stage: 'recycle-metadata', ...this.stats });
      return artifact;
    } catch (error) {
      if (error.code === 'CANCELLED' || this.signal?.aborted) throw error;
      if (!error.code) throw error;
      this.stats.skipped++; this.stats.skippedByCode[error.code] = (this.stats.skippedByCode[error.code] ?? 0) + 1;
      return null;
    }
  }
}
