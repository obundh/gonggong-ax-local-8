import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createFilenameSemanticSearch, getSemanticStatus } from '../engine/semantic-search.mjs';

async function isolated(callback) {
  const temporaryRoot = path.resolve(os.tmpdir());
  const root = await mkdtemp(path.join(temporaryRoot, 'recoverychat-semantic-'));
  try { await callback(root); }
  finally {
    const relative = path.relative(temporaryRoot, root);
    assert.ok(relative.startsWith('recoverychat-semantic-') && !relative.includes(path.sep) && !path.isAbsolute(relative));
    await rm(root, { recursive: true, force: true });
  }
}

async function fakeManifest(root) {
  const files = [];
  for (const name of ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'unigram.json', 'onnx/model_quantized.onnx']) {
    const bytes = Buffer.from(`fixture:${name}`);
    const target = path.join(root, ...name.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);
    files.push({ path: name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  await writeFile(path.join(root, 'model-manifest.json'), JSON.stringify({
    schemaVersion: 1,
    modelId: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
    license: 'apache-2.0',
    files
  }));
}

async function fakeRuntime(root) {
  const files = [];
  for (const name of ['vendor/transformers.node.mjs', 'vendor/runtime.bin', 'vendor/LICENSE.txt']) {
    const bytes = Buffer.from(`runtime:${name}`);
    const target = path.join(root, ...name.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);
    files.push({ path: name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  await writeFile(path.join(root, 'runtime-manifest.json'), JSON.stringify({
    schemaVersion: 1,
    runtime: 'recoverychat-filename-transformers-node',
    files
  }));
}

function semanticFixtureEmbedder() {
  let active = 0;
  let maximumActive = 0;
  let closed = 0;
  const calls = [];
  const vector = text => {
    const value = String(text);
    if (/재무|financial|결산|회계/i.test(value)) return [1, 0, 0];
    if (/날씨|weather/i.test(value)) return [0, 1, 0];
    return [0, 0, 1];
  };
  return {
    get calls() { return calls; },
    get maximumActive() { return maximumActive; },
    get closed() { return closed; },
    async embed(texts) {
      active++;
      maximumActive = Math.max(maximumActive, active);
      calls.push([...texts]);
      await new Promise(resolve => setImmediate(resolve));
      active--;
      return texts.map(vector);
    },
    async close() { closed++; }
  };
}

test('status requires both the isolated runtime and a validated local model manifest', async () => isolated(async root => {
  const missing = getSemanticStatus({ modelPath: path.join(root, 'missing') });
  assert.equal(missing.available, false);
  assert.equal(missing.modelAvailable, false);
  assert.ok(['runtime-missing', 'model-files-missing'].includes(missing.reason));
  await fakeManifest(root);
  const ready = getSemanticStatus({ modelPath: root });
  assert.equal(ready.modelAvailable, true);
  assert.equal(ready.available, ready.runtimeAvailable);
  assert.equal(ready.reason, ready.runtimeAvailable ? 'ready' : 'runtime-missing');
  await writeFile(path.join(root, 'config.json'), 'changed-size');
  assert.equal(getSemanticStatus({ modelPath: root }).available, false);
}));

test('status accepts an explicit absolute packaged runtime root and rejects relative roots', async () => isolated(async root => {
  const model = path.join(root, 'model');
  const runtime = path.join(root, 'optional-ai');
  await mkdir(model);
  await mkdir(runtime);
  await fakeManifest(model);
  await fakeRuntime(runtime);
  assert.deepEqual(getSemanticStatus({ modelPath: model, runtimeRoot: runtime }), {
    available: true,
    reason: 'ready',
    runtimeAvailable: true,
    modelAvailable: true
  });
  const invalid = getSemanticStatus({ modelPath: model, runtimeRoot: 'optional-ai' });
  assert.equal(invalid.runtimeAvailable, false);
  assert.equal(invalid.reason, 'runtime-root-invalid');
}));

test('injected embedding results rank Korean-English meaning and skip generated or empty names', async () => {
  const embedder = semanticFixtureEmbedder();
  const search = await createFilenameSemanticSearch({ embedder });
  const original = [
    { id: 'weather', name: '오늘의 날씨 사진.jpg' },
    { id: 'finance', name: '연간 재무 보고서.xlsx' },
    { id: 'generated', name: 'carved-000001.docx', nameIsGenerated: true },
    { id: 'empty', name: '' }
  ];
  const ranked = await search.rank('annual financial report', original);
  assert.deepEqual(ranked.map(candidate => candidate.id), ['finance', 'weather', 'generated', 'empty']);
  assert.equal(ranked[0].semanticScore, 100);
  assert.deepEqual(ranked[0].semanticReasons, ['filenameSemanticSimilarity:local-multilingual-embedding', 'localAI:on-demand']);
  assert.deepEqual(ranked[2].semanticReasons, ['semantic:skipped-generated-name']);
  assert.deepEqual(ranked[3].semanticReasons, ['semantic:skipped-empty-name']);
  assert.equal(original[0].semanticScore, undefined);
  await search.close();
  assert.equal(embedder.closed, 1);
});

test('ranking is serialized, truncates text, and batches at 32 names', async () => {
  const embedder = semanticFixtureEmbedder();
  const search = await createFilenameSemanticSearch({ embedder });
  const candidates = Array.from({ length: 65 }, (_, index) => ({ id: String(index), name: `재무 보고서 ${index}` }));
  const first = search.rank('재무'.repeat(300), candidates);
  const second = search.rank('weather', [{ id: 'w', name: '날씨.jpg' }]);
  await Promise.all([first, second]);
  assert.equal(embedder.maximumActive, 1);
  assert.deepEqual(embedder.calls.slice(0, 4).map(call => call.length), [1, 32, 32, 1]);
  assert.equal([...embedder.calls[0][0]].length, 256);
  await search.close();
});

test('cancellation is checked between bounded candidate batches', async () => {
  const embedder = semanticFixtureEmbedder();
  const search = await createFilenameSemanticSearch({ embedder });
  const controller = new AbortController();
  const candidates = Array.from({ length: 64 }, (_, index) => ({ id: String(index), name: `보고서 ${index}` }));
  await assert.rejects(search.rank('재무 보고서', candidates, {
    signal: controller.signal,
    onProgress: progress => { if (progress.processed === 32) controller.abort(); }
  }), { code: 'CANCELLED' });
  assert.deepEqual(embedder.calls.map(call => call.length), [1, 32]);
  await search.close();
});
