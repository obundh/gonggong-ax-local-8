import { createReadStream, lstatSync, readFileSync } from 'node:fs';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const DEVELOPMENT_RUNTIME_ROOT = fileURLToPath(new URL('../optional-ai', import.meta.url));
const RUNTIME_MANIFEST = 'runtime-manifest.json';
const MODEL_MANIFEST = 'model-manifest.json';
const EXPECTED_MODEL_ID = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
const MAX_TEXT_LENGTH = 256;
const MAX_BATCH = 32;
const MAX_CANDIDATES = 10_000;

export class SemanticSearchError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SemanticSearchError';
    this.code = code;
    this.details = details;
  }
}

function requireValue(value, code, message, details = {}) {
  if (!value) throw new SemanticSearchError(code, message, details);
}

function cancelled(signal) {
  if (signal?.aborted) throw new SemanticSearchError('CANCELLED', '의미 검색을 취소했어요.');
}

function normalizedText(value) {
  return [...String(value ?? '').normalize('NFKC').trim()].slice(0, MAX_TEXT_LENGTH).join('');
}

function readRuntime(runtimeRoot) {
  if (runtimeRoot !== undefined && (typeof runtimeRoot !== 'string' || !path.isAbsolute(runtimeRoot))) {
    return { available: false, reason: 'runtime-root-invalid' };
  }
  const root = path.resolve(runtimeRoot ?? DEVELOPMENT_RUNTIME_ROOT);
  try {
    const rootStats = lstatSync(root);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) return { available: false, reason: 'runtime-root-invalid', root };
    const manifestPath = path.join(root, RUNTIME_MANIFEST);
    const manifestStats = lstatSync(manifestPath);
    if (!manifestStats.isFile() || manifestStats.isSymbolicLink() || manifestStats.size > 1024 * 1024) {
      return { available: false, reason: 'runtime-missing', root };
    }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (manifest?.schemaVersion !== 1 || manifest.runtime !== 'recoverychat-filename-transformers-node'
      || !Array.isArray(manifest.files) || manifest.files.length < 3) {
      return { available: false, reason: 'runtime-manifest-invalid', root };
    }
    for (const file of manifest.files) {
      if (!file || typeof file.path !== 'string' || !/^[a-zA-Z0-9_.\-/]+$/.test(file.path)
        || file.path.startsWith('/') || file.path.includes('..') || !Number.isSafeInteger(file.bytes) || file.bytes < 1
        || !/^[a-f0-9]{64}$/.test(file.sha256)) return { available: false, reason: 'runtime-manifest-invalid', root };
      const filePath = path.resolve(root, ...file.path.split('/'));
      if (path.relative(root, filePath).startsWith('..')) return { available: false, reason: 'runtime-manifest-invalid', root };
      const stats = lstatSync(filePath);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.size !== file.bytes) return { available: false, reason: 'runtime-missing', root };
    }
    return { available: true, reason: 'ready', root, manifest };
  } catch (error) {
    return { available: false, reason: error?.code === 'ENOENT' ? 'runtime-missing' : 'runtime-manifest-invalid', root };
  }
}

function readModelManifest(modelPath) {
  if (typeof modelPath !== 'string' || !modelPath.trim()) return { available: false, reason: 'model-path-required' };
  const resolved = path.resolve(modelPath);
  try {
    const modelStats = lstatSync(resolved);
    if (!modelStats.isDirectory() || modelStats.isSymbolicLink()) return { available: false, reason: 'model-path-not-directory', path: resolved };
    const manifestPath = path.join(resolved, MODEL_MANIFEST);
    const manifestStats = lstatSync(manifestPath);
    if (!manifestStats.isFile() || manifestStats.isSymbolicLink() || manifestStats.size > 1024 * 1024) {
      return { available: false, reason: 'model-manifest-invalid', path: resolved };
    }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (manifest?.schemaVersion !== 1 || manifest.modelId !== EXPECTED_MODEL_ID || manifest.license !== 'apache-2.0'
      || !Array.isArray(manifest.files) || manifest.files.length < 5) {
      return { available: false, reason: 'model-manifest-invalid', path: resolved };
    }
    for (const file of manifest.files) {
      if (!file || typeof file.path !== 'string' || !/^[a-zA-Z0-9_.\-/]+$/.test(file.path)
        || file.path.startsWith('/') || file.path.includes('..') || !Number.isSafeInteger(file.bytes) || file.bytes < 1
        || !/^[a-f0-9]{64}$/.test(file.sha256)) {
        return { available: false, reason: 'model-manifest-invalid', path: resolved };
      }
      const filePath = path.resolve(resolved, ...file.path.split('/'));
      if (path.relative(resolved, filePath).startsWith('..')) return { available: false, reason: 'model-manifest-invalid', path: resolved };
      const fileStats = lstatSync(filePath);
      if (!fileStats.isFile() || fileStats.isSymbolicLink() || fileStats.size !== file.bytes) {
        return { available: false, reason: 'model-files-missing', path: resolved };
      }
    }
    return { available: true, reason: 'ready', path: resolved, manifest };
  } catch (error) {
    return { available: false, reason: error?.code === 'ENOENT' ? 'model-files-missing' : 'model-manifest-invalid', path: resolved };
  }
}

export function getSemanticStatus({ modelPath, runtimeRoot } = {}) {
  const runtime = readRuntime(runtimeRoot);
  const model = readModelManifest(modelPath);
  return {
    available: runtime.available && model.available,
    reason: !runtime.available ? runtime.reason : model.reason,
    runtimeAvailable: runtime.available,
    modelAvailable: model.available
  };
}

async function sha256File(filePath, signal) {
  cancelled(signal);
  const hash = createHash('sha256');
  const stream = createReadStream(filePath, { highWaterMark: 1024 * 1024 });
  try {
    for await (const chunk of stream) {
      cancelled(signal);
      hash.update(chunk);
      await new Promise(resolve => setImmediate(resolve));
    }
  } catch (error) {
    if (signal?.aborted) throw new SemanticSearchError('CANCELLED', '의미 검색 준비를 취소했어요.');
    throw error;
  }
  return hash.digest('hex');
}

async function verifyModel(model, signal) {
  const canonical = await realpath(model.path);
  requireValue(canonical === model.path, 'MODEL_PATH_CHANGED', '선택한 모델 폴더의 실제 위치가 달라요.');
  for (const file of model.manifest.files) {
    cancelled(signal);
    const filePath = path.resolve(canonical, ...file.path.split('/'));
    const stats = await lstat(filePath);
    requireValue(stats.isFile() && !stats.isSymbolicLink() && stats.size === file.bytes,
      'MODEL_FILES_CHANGED', '모델 파일이 준비 확인 뒤 변경됐어요.', { path: filePath });
    const digest = await sha256File(filePath, signal);
    requireValue(digest === file.sha256, 'MODEL_CHECKSUM_MISMATCH', '모델 파일의 검증값이 맞지 않아요.', { path: filePath });
  }
  return canonical;
}

async function verifyRuntime(runtime, signal) {
  const canonical = await realpath(runtime.root);
  requireValue(canonical === runtime.root, 'RUNTIME_PATH_CHANGED', '선택한 AI 실행 폴더의 실제 위치가 달라요.');
  for (const file of runtime.manifest.files) {
    cancelled(signal);
    const filePath = path.resolve(canonical, ...file.path.split('/'));
    const stats = await lstat(filePath);
    requireValue(stats.isFile() && !stats.isSymbolicLink() && stats.size === file.bytes,
      'RUNTIME_FILES_CHANGED', 'AI 실행 파일이 준비 확인 뒤 변경됐어요.', { path: filePath });
    requireValue(await sha256File(filePath, signal) === file.sha256,
      'RUNTIME_CHECKSUM_MISMATCH', 'AI 실행 파일의 검증값이 맞지 않아요.', { path: filePath });
  }
  return canonical;
}

function normalizeVector(value) {
  const vector = ArrayBuffer.isView(value) ? Array.from(value) : Array.isArray(value) ? value.map(Number) : null;
  requireValue(vector && vector.length > 0 && vector.length <= 4096 && vector.every(Number.isFinite),
    'INVALID_EMBEDDING', '임베딩 결과의 형태가 올바르지 않아요.');
  const magnitude = Math.sqrt(vector.reduce((sum, item) => sum + item * item, 0));
  requireValue(magnitude > 0, 'INVALID_EMBEDDING', '빈 임베딩 결과는 비교할 수 없어요.');
  return Float32Array.from(vector, item => item / magnitude);
}

function cosine(left, right) {
  requireValue(left.length === right.length, 'INVALID_EMBEDDING', '임베딩 차원이 서로 달라요.');
  let result = 0;
  for (let index = 0; index < left.length; index++) result += left[index] * right[index];
  return Math.max(-1, Math.min(1, result));
}

function tensorRows(output, expected) {
  const data = output?.tolist ? output.tolist() : output;
  const rows = Array.isArray(data?.[0]) ? data : expected === 1 && Array.isArray(data) ? [data] : null;
  requireValue(rows && rows.length === expected, 'INVALID_EMBEDDING', '임베딩 결과 개수가 요청과 달라요.');
  return rows.map(normalizeVector);
}

function candidateText(candidate) {
  if (!candidate || typeof candidate !== 'object' || candidate.nameIsGenerated) return null;
  const value = normalizedText(candidate.name);
  return value || null;
}

async function prepareCacheDirectory(cacheDirectory) {
  if (cacheDirectory === undefined || cacheDirectory === null || cacheDirectory === '') return null;
  requireValue(typeof cacheDirectory === 'string', 'INVALID_CACHE', '캐시 폴더 경로가 올바르지 않아요.');
  const resolved = path.resolve(cacheDirectory);
  await mkdir(resolved, { recursive: true });
  const stats = await lstat(resolved);
  requireValue(stats.isDirectory() && !stats.isSymbolicLink(), 'INVALID_CACHE', '캐시 위치는 일반 폴더여야 해요.');
  return realpath(resolved);
}

async function createRuntimeEmbedder({ modelPath, cacheDirectory, signal, runtimeRoot, runtimeImporter }) {
  const status = getSemanticStatus({ modelPath, runtimeRoot });
  requireValue(status.available, 'SEMANTIC_UNAVAILABLE', '로컬 의미 검색 실행 파일과 검증된 모델이 모두 필요해요.', status);
  const model = readModelManifest(modelPath);
  const runtimeInfo = readRuntime(runtimeRoot);
  const canonicalModel = await verifyModel(model, signal);
  const canonicalRuntime = await verifyRuntime(runtimeInfo, signal);
  const canonicalCache = await prepareCacheDirectory(cacheDirectory);
  cancelled(signal);
  let runtime;
  const runtimeEntry = path.join(canonicalRuntime, 'vendor', 'transformers.node.mjs');
  try {
    runtime = await (runtimeImporter ?? (entry => import(pathToFileURL(entry).href)))(runtimeEntry);
  } catch (error) {
    throw new SemanticSearchError('RUNTIME_LOAD_FAILED', '로컬 의미 검색 실행 파일을 불러오지 못했어요.', { cause: error?.message });
  }
  const { env, pipeline } = runtime;
  requireValue(env && typeof pipeline === 'function', 'RUNTIME_LOAD_FAILED', '의미 검색 실행 파일의 API가 올바르지 않아요.');
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.useFS = true;
  env.useFSCache = Boolean(canonicalCache);
  env.useBrowserCache = false;
  env.cacheDir = canonicalCache;
  env.localModelPath = path.dirname(canonicalModel);
  env.fetch = async request => { throw new SemanticSearchError('REMOTE_DISABLED', '의미 검색의 네트워크 접근은 꺼져 있어요.', { request: String(request) }); };
  let extractor;
  try {
    extractor = await pipeline('feature-extraction', canonicalModel, {
      local_files_only: true,
      dtype: 'q8',
      device: 'cpu',
      session_options: {
        intraOpNumThreads: 2,
        interOpNumThreads: 1,
        executionMode: 'sequential'
      }
    });
  } catch (error) {
    throw new SemanticSearchError('MODEL_LOAD_FAILED', '검증된 로컬 이름 임베딩 모델을 열지 못했어요.', { cause: error?.message });
  }
  return {
    async embed(texts) {
      const output = await extractor(texts, { pooling: 'mean', normalize: true });
      return tensorRows(output, texts.length);
    },
    async close() { if (typeof extractor.dispose === 'function') await extractor.dispose(); }
  };
}

export async function createFilenameSemanticSearch({
  modelPath, cacheDirectory, signal, runtimeRoot,
  // Test seams are deliberately undocumented and never used by the application.
  embedder: suppliedEmbedder, runtimeImporter
} = {}) {
  cancelled(signal);
  const embedder = suppliedEmbedder ?? await createRuntimeEmbedder({ modelPath, cacheDirectory, signal, runtimeRoot, runtimeImporter });
  requireValue(embedder && typeof embedder.embed === 'function', 'INVALID_EMBEDDER', '이름 임베딩 실행기가 올바르지 않아요.');
  let closed = false;
  let queue = Promise.resolve();

  async function performRank(query, candidates, { signal: rankSignal, onProgress } = {}) {
    requireValue(!closed, 'SEMANTIC_CLOSED', '의미 검색 실행기가 이미 닫혔어요.');
    cancelled(rankSignal);
    const queryText = normalizedText(query);
    requireValue(queryText, 'EMPTY_QUERY', '의미 검색어를 입력해주세요.');
    requireValue(Array.isArray(candidates) && candidates.length <= MAX_CANDIDATES,
      'INVALID_CANDIDATES', `의미 검색 후보는 한 번에 최대 ${MAX_CANDIDATES}개까지 처리할 수 있어요.`);
    const result = candidates.map((candidate, index) => ({
      index,
      candidate: { ...candidate, semanticScore: null, semanticReasons: [] },
      text: candidateText(candidate)
    }));
    const eligible = result.filter(item => item.text);
    for (const skipped of result.filter(item => !item.text)) {
      skipped.candidate.semanticReasons = [skipped.candidate.nameIsGenerated ? 'semantic:skipped-generated-name' : 'semantic:skipped-empty-name'];
    }
    if (eligible.length === 0) return result.map(item => item.candidate);
    const [queryVector] = (await embedder.embed([queryText], { signal: rankSignal })).map(normalizeVector);
    let processed = 0;
    for (let offset = 0; offset < eligible.length; offset += MAX_BATCH) {
      cancelled(rankSignal);
      const batch = eligible.slice(offset, offset + MAX_BATCH);
      const vectors = (await embedder.embed(batch.map(item => item.text), { signal: rankSignal })).map(normalizeVector);
      requireValue(vectors.length === batch.length, 'INVALID_EMBEDDING', '후보 임베딩 결과 개수가 맞지 않아요.');
      for (let index = 0; index < batch.length; index++) {
        const similarity = cosine(queryVector, vectors[index]);
        batch[index].candidate.semanticScore = Math.round(Math.max(0, similarity) * 10_000) / 100;
        batch[index].candidate.semanticReasons = ['filenameSemanticSimilarity:local-multilingual-embedding', 'localAI:on-demand'];
      }
      processed += batch.length;
      if (typeof onProgress === 'function') onProgress({ phase: 'semantic-rank', processed, total: eligible.length, batchSize: batch.length });
      await new Promise(resolve => setImmediate(resolve));
    }
    return result.sort((left, right) => {
      const leftScore = left.candidate.semanticScore;
      const rightScore = right.candidate.semanticScore;
      if (leftScore === null && rightScore !== null) return 1;
      if (rightScore === null && leftScore !== null) return -1;
      return (rightScore ?? -Infinity) - (leftScore ?? -Infinity) || left.index - right.index;
    }).map(item => item.candidate);
  }

  return {
    rank(query, candidates, options = {}) {
      const task = queue.then(() => performRank(query, candidates, options));
      queue = task.catch(() => {});
      return task;
    },
    async close() {
      await queue;
      if (closed) return;
      closed = true;
      if (typeof embedder.close === 'function') await embedder.close();
    }
  };
}

