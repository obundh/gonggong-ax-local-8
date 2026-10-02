import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, stat, realpath, lstat } from 'node:fs/promises';
import { openImageBytes } from './byte-source.mjs';
import { acquireImage, verifyAcquisition } from './image-acquisition.mjs';
import { inspectSourceReadiness } from './source-readiness.mjs';
import { RecoveryError } from './ntfs-image.mjs';
import { readLayerFingerprint } from './windows-device.mjs';

const fail = (code, message) => { throw new RecoveryError(code, message); };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fileIdentity = info => `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}`;
function failureInfo(failure) {
  const code = failure.code || 'ACQUISITION_FAILED';
  const messages = {
    CANCELLED: '작업을 중단했어요. 저장된 구간과 기록은 남겨둡니다.',
    ENOSPC: '저장 공간이 부족해 중단했어요. 이미 보관한 구간은 남겨둡니다.',
    SOURCE_CHANGED: '원본이 바뀌어 중단했어요. 원본을 다시 선택해주세요.',
    SOURCE_MISMATCH: '이전과 같은 원본인지 확인하지 못해 이어 쓰지 않았어요.',
    DEVICE_CHANGED: '장치가 바뀌었거나 분리되어 중단했어요.',
    HELPER_CLOSED: '원본 읽기 연결이 끊겼어요. 보관 기록은 유지됩니다.',
    HELPER_TIMEOUT: '원본 읽기 응답이 늦어 중단했어요.',
    READ_TIMEOUT: '원본 읽기 시간이 초과되어 중단했어요.',
    TIME_LIMIT: '작업 시간 한도에 도달해 중단 기록을 남겼어요.',
    IMAGE_TAMPERED: '보관한 파일의 내용이 기록과 달라 이어 쓰지 않았어요.',
    JOURNAL_TAMPERED: '보관 이력이 맞지 않아 이어 쓰지 않았어요.',
    OUTPUT_CHANGED: '저장 파일이나 폴더가 바뀌어 중단했어요.',
    OUTPUT_VERIFY_FAILED: '저장한 내용을 다시 확인했지만 해시가 맞지 않아요.',
    INVALID_MANIFEST: '보관 기록을 확인할 수 없어요.',
    UNSAFE_OUTPUT: '이 저장 경로는 안전하게 사용할 수 없어요. 다른 폴더를 골라주세요.',
    ENOENT: '원본 또는 보관 파일을 찾을 수 없어요.',
  };
  return { code, message: /[가-힣]/.test(failure.message || '') ? failure.message : messages[code] || '보관 작업을 완료하지 못했어요. 보관 폴더의 기록에서 원인을 확인할 수 있어요.', technicalMessage: failure.message };
}
const terminalSummary = manifest => ({
  state: manifest.state, complete: manifest.complete === true,
  bytesWritten: manifest.image?.bytesWritten ?? 0, sha256: manifest.image?.sha256 ?? null,
  scope: manifest.scope, readErrorCount: manifest.readErrors?.length ?? 0,
  stopReason: manifest.stopReason ?? null,
});

// Owns admission and opaque IDs; the acquisition core owns byte/manifest integrity.
export class AcquisitionService {
  constructor(jobs, { openImage = openImageBytes, collect = acquireImage, verify = verifyAcquisition } = {}) {
    this.jobs = jobs; this.openImage = openImage; this.collect = collect; this.verify = verify;
    this.records = new Map(); this.active = null; this.writes = Promise.resolve();
  }
  busy() { return Boolean(this.active); }
  async initialize() {
    try {
      const file = path.join(this.jobs.workspace, 'acquisitions.json');
      if ((await stat(file)).size > 1024 * 1024 || (await lstat(file)).isSymbolicLink()) return;
      const data = JSON.parse(await readFile(file, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.records)) return;
      for (const record of data.records.slice(-100)) {
        if (!uuid.test(record.id) || !['image', 'volume'].includes(record.sourceKind) || typeof record.sourceIdentity !== 'string' || !path.isAbsolute(record.outputDirectory || '') || path.basename(record.outputDirectory) !== `acquisition-${record.id}`) continue;
        record.status = ['preparing', 'acquiring', 'verifying', 'cancelling'].includes(record.status) ? 'interrupted' : record.status;
        record.hasCheckpoint = await this.readCheckpoint(record);
        this.records.set(record.id, record);
      }
    } catch { /* An unreadable index cannot authorize any operation. */ }
  }
  publicRecord(record) {
    return { id: record.id, sourceLabel: record.sourceLabel, sourceKind: record.sourceKind,
      status: record.status, createdAt: record.createdAt, outputDirectory: record.outputDirectory,
      summary: record.summary ?? null, error: record.error ? { code: record.error.code, message: record.error.message } : null,
      canResume: record.sourceKind === 'image' && record.hasCheckpoint === true && !record.summary?.readErrorCount && ['cancelled', 'interrupted', 'error'].includes(record.status),
      canUse: record.status === 'complete' && record.hasCheckpoint === true && record.summary?.complete === true };
  }
  list() { return { items: [...this.records.values()].reverse().map(record => this.publicRecord(record)), activeId: this.active?.record.id ?? null }; }
  async readCheckpoint(record) {
    try {
      const file = path.join(record.outputDirectory, 'acquisition.json');
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 32 * 1024 * 1024) return false;
      const manifest = JSON.parse(await readFile(file, 'utf8'));
      if (manifest.schema !== 'recoverychat.raw-acquisition' || manifest.source?.identity !== record.sourceIdentity) return false;
      record.summary = terminalSummary(manifest);
      return true;
    } catch { return false; }
  }
  persist() {
    const data = JSON.stringify({ version: 1, records: [...this.records.values()].slice(-100) }, null, 2);
    const task = this.writes.catch(() => {}).then(async () => {
      const temporary = path.join(this.jobs.workspace, `acquisitions-${randomUUID()}.tmp`);
      await writeFile(temporary, data, { flag: 'wx' });
      await rename(temporary, path.join(this.jobs.workspace, 'acquisitions.json'));
    });
    this.writes = task;
    return task;
  }
  emit(record, type, extra = {}) { this.jobs.onEvent({ type, acquisitionId: record.id, acquisition: this.publicRecord(record), ...extra }); }
  async validateSource(sourceId) {
    const registered = this.jobs.sources.get(sourceId);
    if (!registered || !['image', 'volume'].includes(registered.kind)) fail('SOURCE_REQUIRED', '보관할 드라이브 또는 raw 이미지 파일을 선택해주세요.');
    const source = structuredClone(registered);
    if (source.kind === 'volume') {
      const current = (await this.jobs.inventory()).find(item => item.id.toLowerCase() === source.device.id.toLowerCase());
      if (!current || current.identity !== source.identity || current.ready !== true || readLayerFingerprint(current) !== readLayerFingerprint(source.device)) fail('SOURCE_CHANGED', '원본 장치나 파티션·섹터 정보가 바뀌었거나 준비되지 않았어요. 다시 선택해주세요.');
      if (!Number.isSafeInteger(current.partitionSize) || current.partitionSize <= 0) fail('SOURCE_TOPOLOGY_UNKNOWN', '원본의 정확한 단일 파티션 길이를 확인하지 못했어요. 다시 선택해주세요.');
      source.device = current;
    } else {
      const current = await stat(source.path, { bigint: true });
      if (`${current.dev}:${current.ino}:${current.size}:${current.mtimeNs}` !== source.identity) fail('SOURCE_CHANGED', '원본 이미지 파일이 바뀌었어요. 다시 선택해주세요.');
    }
    return source;
  }
  async gate(source, destinationId, requiredBytes) {
    const parent = await this.jobs.validateDestination(source, destinationId, requiredBytes, requiredBytes);
    const destination = this.jobs.destinations.get(destinationId);
    const report = await inspectSourceReadiness({ source, destination, workspacePath: this.jobs.workspace,
      runtimePaths: this.jobs.runtimePaths, inventory: this.jobs.inventory, inspect: this.jobs.inspect });
    if (source.kind === 'volume' && !report.acquisition?.canAcquire) fail('ACQUISITION_NOT_READY', '원본 보관을 시작할 수 없어요. ' + (report.acquisition?.reasons ?? []).map(item => item.detail).join(' '));
    if (source.kind === 'image' && (report.source.identityStatus !== 'current' || report.destination?.identityStatus !== 'current')) fail('SOURCE_CHANGED', '원본 또는 저장 위치를 다시 선택해주세요.');
    return { parent, report };
  }
  async start({ sourceId, destinationId, resumeId, elevate = false } = {}) {
    if (this.jobs.disposal) fail('CANCELLED', '앱을 종료하고 있어요.');
    if (this.jobs.busy()) fail('BUSY', '현재 작업이 끝난 뒤 원본을 보관해주세요.');
    this.jobs.starting = true;
    let reader;
    try {
      const source = await this.validateSource(sourceId);
      let record = resumeId ? this.records.get(resumeId) : null;
      if (resumeId && !record) fail('UNKNOWN_ACQUISITION', '이전에 보관하던 자료를 찾을 수 없어요.');
      if (record) {
        if (record.sourceKind !== 'image' || record.sourceIdentity !== source.identity || record.sourceKind !== source.kind) fail('SOURCE_CHANGED', '재개하려면 이전과 같은 고정 이미지 파일을 선택해야 해요. 실행 중인 드라이브 수집은 새로 시작해주세요.');
        if (!this.publicRecord(record).canResume) fail('NOT_RESUMABLE', '중단된 이미지 수집만 이어갈 수 있어요.');
        if ((await lstat(record.outputDirectory)).isSymbolicLink() || await realpath(record.outputDirectory) !== record.outputDirectory) fail('UNSAFE_OUTPUT', '보관 폴더의 실제 위치가 바뀌었어요.');
        destinationId = (await this.jobs.addDestination(path.dirname(record.outputDirectory))).id;
      }
      const size = source.kind === 'volume' ? source.device.partitionSize : Number((await stat(source.path)).size);
      // Reserving the entire remaining image conservatively avoids relying on an untrusted checkpoint size.
      const { parent, report } = await this.gate(source, destinationId, size);
      reader = source.kind === 'volume' ? await this.jobs.volumeSession.open(source.device, { elevate, onPermission: () => this.jobs.onEvent({ type: 'acquisition-permission', message: '원본을 읽기 위한 Windows 허용을 기다리고 있어요.' }) }) : await this.openImage(source.path);
      if (reader.info.identity !== source.identity || reader.info.size !== size) fail('SOURCE_CHANGED', '실제로 열린 원본이 선택한 장치와 달라요.');
      if (source.kind === 'volume' && reader.info.sectorSize !== report.acquisition.geometry.logicalSectorSize) fail('GEOMETRY_CHANGED', '실제 읽기 계층의 섹터 크기가 장치 목록과 달라요.');
      if (source.kind === 'volume') {
        const expectedLayer = readLayerFingerprint(source.device);
        if (!expectedLayer || reader.info.readLayerFingerprint !== expectedLayer) fail('SOURCE_CHANGED', '실제로 연 물리 장치가 선택한 원본과 달라요.');
        const afterOpen = await this.validateSource(sourceId);
        if (readLayerFingerprint(afterOpen.device) !== expectedLayer) fail('SOURCE_CHANGED', '읽기 연결을 여는 동안 원본 장치가 바뀌었어요.');
      }
      // Opening the helper may wait for UAC. Recheck the output and every runtime
      // location after that interval, before creating a directory or writing history.
      const admitted = await this.gate(source, destinationId, size);
      if (admitted.parent !== parent) fail('DESTINATION_CHANGED', '읽기 연결을 여는 동안 저장 위치가 바뀌었어요. 다시 선택해주세요.');
      if (!record) {
        const id = randomUUID(), outputDirectory = path.join(parent, `acquisition-${id}`);
        await mkdir(outputDirectory);
        record = { id, sourceIdentity: source.identity, sourceKind: source.kind, sourceLabel: source.label,
          outputDirectory, createdAt: new Date().toISOString(), status: 'preparing', summary: null, hasCheckpoint: false };
        this.records.set(id, record);
      }
      record.error = null; record.status = 'acquiring';
      await this.persist();
      const controller = new AbortController();
      const active = { record, controller, reader, done: null };
      this.active = active;
      const bytes = { ...reader, info: { ...reader.info, sourceKind: source.kind } };
      active.done = new Promise(resolve => setImmediate(resolve)).then(async () => {
        try {
          const manifest = await this.collect({ reader: bytes, outputDirectory: record.outputDirectory,
            source: { kind: source.kind, identity: source.identity, label: source.label, device: source.kind === 'volume' ? source.device : undefined },
            resume: Boolean(resumeId), signal: controller.signal,
            onProgress: progress => { this.emit(record, 'acquisition-progress', { progress }); } });
          record.summary = terminalSummary(manifest);
          record.hasCheckpoint = true;
          record.status = controller.signal.aborted ? 'cancelled' : manifest.complete === true ? 'complete' : manifest.state === 'cancelled' ? 'cancelled' : 'partial';
        } catch (failure) {
          record.status = controller.signal.aborted ? 'cancelled' : 'error';
          record.error = failureInfo(failure);
          record.hasCheckpoint = await this.readCheckpoint(record);
        } finally {
          try { await active.reader.close(); } catch { /* The collection manifest retains the primary failure. */ }
          try { await this.persist(); } catch (failure) { record.status = 'error'; record.error = { code: 'HISTORY_WRITE_FAILED', message: failure.message }; }
          this.active = null;
          this.emit(record, 'acquisition-complete');
        }
        return this.publicRecord(record);
      });
      reader = null;
      return this.publicRecord(record);
    } finally {
      if (reader) await reader.close().catch(() => {});
      this.jobs.starting = false;
    }
  }
  cancel(id) {
    if (!this.active || this.active.record.id !== id) fail('UNKNOWN_ACQUISITION', '진행 중인 원본 보관 작업이 아니에요.');
    this.active.record.status = 'cancelling'; this.active.controller.abort();
    return { id, status: 'cancelling' };
  }
  async useImage(id) {
    if (this.jobs.disposal || this.jobs.busy()) fail('BUSY', '진행 중인 작업이 끝난 뒤 보관 이미지를 열어주세요.');
    const record = this.records.get(id);
    if (!record || !this.publicRecord(record).canUse) fail('INCOMPLETE_IMAGE', '읽지 못한 구간이 있거나 중단된 이미지는 완성된 원본으로 열 수 없어요.');
    const priorStatus = record.status;
    this.jobs.starting = true;
    const controller = new AbortController();
    const active = { record, controller, done: null }; this.active = active;
    try {
      const imagePath = path.join(record.outputDirectory, 'image.raw');
      const before = await stat(imagePath, { bigint: true });
      active.done = this.verify(record.outputDirectory, { signal: controller.signal, onProgress: progress => this.emit(record, 'acquisition-progress', { progress, verifying: true }) });
      const result = await active.done;
      if (!result.valid || !result.complete) fail('IMAGE_VERIFICATION_FAILED', '보관 이미지의 해시나 수집 범위가 맞지 않아요. 원본으로 열지 않았어요.');
      const after = await stat(imagePath, { bigint: true });
      if (fileIdentity(before) !== fileIdentity(after) || before.ctimeNs !== after.ctimeNs) fail('IMAGE_CHANGED', '검증 도중 보관 이미지가 바뀌었어요. 원본으로 열지 않았어요.');
      const selected = await this.jobs.addSource('image', imagePath);
      if (this.jobs.sources.get(selected.id)?.identity !== fileIdentity(before)) { this.jobs.sources.delete(selected.id); fail('IMAGE_CHANGED', '보관 이미지가 바뀌었어요. 다시 확인해주세요.'); }
      return selected;
    } catch (failure) {
      const info = failureInfo(failure);
      if (!controller.signal.aborted) { record.status = 'verification-failed'; record.error = info; await this.persist(); }
      throw new RecoveryError(info.code, info.message);
    } finally { if (controller.signal.aborted) record.status = priorStatus; this.active = null; this.jobs.starting = false; }
  }
  async dispose() {
    this.active?.controller.abort();
    await this.active?.done?.catch(() => {});
    await this.writes.catch(() => {});
  }
}
