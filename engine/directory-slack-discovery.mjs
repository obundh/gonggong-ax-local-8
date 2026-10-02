import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { parseDirectorySlack } from './ntfs-directory-slack.mjs';
import { buildDirectorySlackClue } from './directory-slack-clue.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const key = ref => `${ref.recordNumber}:${ref.sequence}`;
const entryKey = entry => `${key(entry.reference)}:${entry.name}`;
const clueKey = clue => `${key(clue.directoryReference)}:${clue.recordNumber}:${clue.sequence}:${clue.name}`;
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const validRef = ref => Number.isSafeInteger(ref?.recordNumber) && ref.recordNumber >= 5
  && Number.isInteger(ref.sequence) && ref.sequence > 0 && ref.sequence <= 65535;

/** Only inspect parent directories explicitly referenced by this scan's discoveries. */
export class DirectorySlackCollector {
  constructor(engine, { signal, control, onProgress, maxDirectories = 32, maxBlocks = 8,
    maxBytes = 4 * 1024 * 1024, maxClues = 128, maxTimeMs = 1500, mode = 'allocated-tail', maxPositions = 64 } = {}) {
    if (!['allocated-tail', 'freed-index'].includes(mode) || !Number.isInteger(maxPositions) || maxPositions < 1 || maxPositions > 64) throw new TypeError('invalid directory slack mode');
    for (const [value, cap] of [[maxDirectories, 32], [maxBlocks, 8], [maxBytes, 4 * 1024 * 1024], [maxClues, 128], [maxTimeMs, 1500]]) {
      if (!Number.isInteger(value) || value < 1 || value > cap) throw new TypeError('invalid directory slack limits');
    }
    Object.assign(this, { engine, signal, control, onProgress, maxDirectories, maxBlocks, maxBytes, maxClues, maxTimeMs, mode, maxPositions });
    this.parents = new Map(); this.activeMs = 0;
    this.stats = { directoriesQueued: 0, directoriesInspected: 0, blocksRead: 0, bytesRead: 0, clues: 0,
      currentEntriesSkipped: 0, skippedByCode: {}, limited: false, existingParentsOnly: true,
      clueLimit: maxClues, execution: 'pending', skippedReason: null,
      unallocatedIndexBuffersRead: false, bodyAssociations: 0,
      ...(mode === 'freed-index' ? { mode, bitmapPositionsChecked: 0, blocksRejected: 0, duplicateCluesSkipped: 0, volumeUnallocatedClustersRead: false } : {}) };
  }

  observe(parent) {
    if (!validRef(parent) || parent.recordNumber >= this.engine.info.recordCount || this.parents.has(key(parent))) return;
    if (this.parents.size >= this.maxDirectories) { this.stats.limited = true; return; }
    this.parents.set(key(parent), { recordNumber: parent.recordNumber, sequence: parent.sequence });
    this.stats.directoriesQueued = this.parents.size;
  }

  async checkpoint() {
    if (this.started !== undefined) { this.activeMs += performance.now() - this.started; this.started = undefined; }
    if (this.signal?.aborted) fail('CANCELLED', '작업을 취소했어요.');
    await this.control?.checkpoint();
    if (this.signal?.aborted) fail('CANCELLED', '작업을 취소했어요.');
    if (this.activeMs >= this.maxTimeMs) fail('DIR_SLACK_LIMIT', '폴더 흔적 확인 시간 한도에 도달했어요.');
    this.started = performance.now();
  }

  async read(stream, offset, length, readBit) {
    await this.checkpoint();
    if (this.stats.bytesRead + length > this.maxBytes) fail('DIR_SLACK_LIMIT', '폴더 흔적 읽기 한도에 도달했어요.');
    await this.engine.assertStreamRangeAllocated(stream, offset, length, readBit, this.signal);
    const bytes = await this.engine.readStream(stream, offset, length, this.signal);
    this.stats.bytesRead += bytes.length;
    if (bytes.length !== length) fail('DIR_SLACK_INVALID', '폴더 흔적 읽기가 짧아요.');
    return bytes;
  }

  async inspect(parent) {
    const engine = this.engine;
    await engine.assertUnchanged();
    const directory = await engine.record(parent.recordNumber, this.signal);
    const allocation = await engine.refreshAllocationMetadata(this.signal), readBit = engine.bitmapReader(allocation, this.signal);
    if (directory?.flags !== 3 || directory.sequence !== parent.sequence || !await readBit('mftBitmap', parent.recordNumber)) {
      fail('DIR_SLACK_PARENT_CHANGED', '폴더 기록이 재사용되었거나 현재 사용 상태를 확인할 수 없어요.');
    }
    const streams = engine.directoryIndexStreams(directory);
    if (!streams) return [];
    if (this.mode === 'freed-index' && !streams.allocation) return [];
    const names = directory.names.filter(n => [1, 3].includes(n.namespace));
    const directoryName = parent.recordNumber === 5 ? '볼륨 루트' : names.length === 1 ? names[0].name : `폴더 기록 ${parent.recordNumber}`;
    const proofDirectory = { ...parent, fingerprint: directory.fingerprint, name: directoryName };
    const units = [], reads = [], freed = this.mode === 'freed-index';
    const addUnit = (bytes, kind, offset, expectedVcn, indexBitmap) => {
      const parsed = parseDirectorySlack({ bytes, kind, directoryReference: parent, info: engine.info, expectedVcn });
      this.stats.limited ||= parsed.truncated === true;
      units.push({ bytes, kind, streamOffset: offset, expectedVcn, parsed, ...(indexBitmap ? { indexBitmap } : {}) }); return parsed;
    };
    const rootBytes = streams.root.value;
    if (this.stats.bytesRead + rootBytes.length > this.maxBytes) fail('DIR_SLACK_LIMIT', '폴더 흔적 읽기 한도에 도달했어요.');
    this.stats.bytesRead += rootBytes.length;
    const root = freed ? parseDirectorySlack({ bytes: rootBytes, kind: 'root', directoryReference: parent, info: engine.info }) : addUnit(rootBytes, 'root', 0, 0);
    if (streams.allocation) {
      const blockCount = Math.floor(streams.allocation.size / root.blockSize);
      if (streams.allocation.size % root.blockSize || streams.bitmap.size < Math.ceil(blockCount / 8)) fail('DIR_SLACK_INVALID', '폴더 인덱스 할당 크기가 맞지 않아요.');
      const positions = freed ? this.maxPositions : this.maxBlocks;
      this.stats.limited ||= blockCount > positions;
      const count = Math.min(blockCount, positions), bitmapCache = new Map();
      let freedRead = 0;
      for (let index = 0; index < count; index++) {
        await this.checkpoint();
        const bitmapOffset = Math.floor(index / 8);
        let bitmapBytes = freed ? bitmapCache.get(bitmapOffset) : null;
        if (!bitmapBytes) {
          bitmapBytes = await this.read(streams.bitmap, bitmapOffset, 1, readBit);
          reads.push({ stream: streams.bitmap, offset: bitmapOffset, bytes: bitmapBytes });
          bitmapCache.set(bitmapOffset, bitmapBytes);
        }
        const allocated = Boolean(bitmapBytes[0] & (1 << (index % 8)));
        if (freed) this.stats.bitmapPositionsChecked++;
        if (freed ? allocated : !allocated) continue;
        if (freed && freedRead >= this.maxBlocks) { this.stats.limited = true; break; }
        const offset = index * root.blockSize;
        const bytes = await this.read(streams.allocation, offset, root.blockSize, readBit);
        reads.push({ stream: streams.allocation, offset, bytes }); this.stats.blocksRead++;
        if (freed) {
          freedRead++; this.stats.unallocatedIndexBuffersRead = true;
          try { addUnit(bytes, 'freed-allocation', offset, offset / engine.info.clusterSize, { byteOffset: bitmapOffset, value: bitmapBytes[0] }); }
          catch (error) {
            if (!['DIR_SLACK_INVALID', 'DIR_SLACK_UNSUPPORTED'].includes(error.code)) throw error;
            this.stats.blocksRejected++;
            this.stats.skippedByCode[error.code] = (this.stats.skippedByCode[error.code] ?? 0) + 1;
          }
        } else addUnit(bytes, 'allocation', offset, offset / engine.info.clusterSize);
      }
    }
    const active = new Set((freed ? root.activeEntries : units.flatMap(unit => unit.parsed.activeEntries)).map(entryKey)), seen = new Set(), clues = [];
    remnants: for (const unit of units) for (const entry of unit.parsed.entries) {
      await this.checkpoint();
      if (entry.reference.recordNumber >= engine.info.recordCount || seen.has(entryKey(entry))) continue;
      seen.add(entryKey(entry));
      if (freed && this.excluded?.has(`${key(parent)}:${entryKey(entry)}`)) { this.stats.duplicateCluesSkipped++; continue; }
      if (active.has(entryKey(entry))) { this.stats.currentEntriesSkipped++; continue; }
      // A still-live exact reference/name is not useful as a missing-file clue.
      let target;
      try { target = await engine.record(entry.reference.recordNumber, this.signal); }
      catch (error) { if (error.code === 'CANCELLED' || !['INVALID_RECORD', 'INVALID_FIXUP', 'INVALID_ATTRIBUTE', 'INVALID_RANGE', 'INVALID_NAME'].includes(error.code)) throw error; }
      if (target && (target.flags & 1) && target.sequence === entry.reference.sequence && target.names.some(n => n.name === entry.name
        && n.parent.recordNumber === parent.recordNumber && n.parent.sequence === parent.sequence)) {
        this.stats.currentEntriesSkipped++; continue;
      }
      clues.push(buildDirectorySlackClue({ ...unit, directory: proofDirectory, info: engine.info, entryOffset: entry.offset }));
      if (this.stats.clues + clues.length >= this.maxClues) { this.stats.limited = true; break remnants; }
    }
    // Re-read the directory, both allocation bitmaps, and every inspected unit.
    const current = await engine.record(parent.recordNumber, this.signal);
    const afterAllocation = await engine.refreshAllocationMetadata(this.signal), afterBits = engine.bitmapReader(afterAllocation, this.signal);
    if (current?.fingerprint !== directory.fingerprint || !await afterBits('mftBitmap', parent.recordNumber)) fail('DIR_SLACK_PARENT_CHANGED', '읽는 동안 폴더 기록이 바뀌었어요.');
    for (const proof of reads) {
      const bytes = await this.read(proof.stream, proof.offset, proof.bytes.length, afterBits);
      if (hash(bytes) !== hash(proof.bytes)) fail('DIR_SLACK_PARENT_CHANGED', '읽는 동안 폴더 인덱스가 바뀌었어요.');
    }
    await engine.assertUnchanged();
    return clues;
  }

  async collect({ limit = this.maxClues, excludeCandidates = [] } = {}) {
    const result = [];
    this.excluded = new Set(excludeCandidates.filter(c => c.source === 'directory-slack' && validRef(c.directoryReference)).map(clueKey));
    if (!Number.isInteger(limit) || limit < 0) throw new TypeError('invalid clue limit');
    this.stats.clueLimit = Math.min(this.maxClues, limit);
    if (typeof this.engine.directoryIndexStreams !== 'function') {
      this.stats.skippedByCode.DIR_SLACK_UNSUPPORTED = 1;
      this.stats.execution = 'skipped'; this.stats.skippedReason = 'unsupported-engine'; return result;
    }
    if (!limit) {
      this.stats.limited ||= this.parents.size > 0;
      this.stats.execution = 'skipped'; this.stats.skippedReason = 'global-candidate-limit'; return result;
    }
    if (!this.parents.size) {
      this.stats.execution = 'skipped'; this.stats.skippedReason = 'no-observed-parents'; return result;
    }
    this.stats.execution = 'running';
    this.maxClues = Math.min(this.maxClues, limit);
    for (const parent of this.parents.values()) {
      try {
        await this.checkpoint(); this.stats.directoriesInspected++;
        const clues = await this.inspect(parent);
        result.push(...clues); this.stats.clues = result.length;
        this.onProgress?.({ stage: this.mode === 'freed-index' ? 'directory-freed-index' : 'directory-slack', ...this.stats });
        if (result.length >= this.maxClues) break;
      } catch (error) {
        if (['CANCELLED', 'READ_FAILED', 'SOURCE_CHANGED'].includes(error.code) || this.signal?.aborted || !error.code) throw error;
        this.stats.skippedByCode[error.code] = (this.stats.skippedByCode[error.code] ?? 0) + 1;
        if (error.code === 'DIR_SLACK_LIMIT') { this.stats.limited = true; break; }
      } finally { if (this.started !== undefined) { this.activeMs += performance.now() - this.started; this.started = undefined; } }
    }
    this.stats.activeMs = Math.round(this.activeMs);
    this.stats.execution = this.stats.limited ? 'limited' : Object.keys(this.stats.skippedByCode).length ? 'partial' : 'completed';
    return result;
  }
}
