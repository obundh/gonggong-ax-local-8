import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const MODEL_ID = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
const REVISION = '2c4055b12046f11709e9df2c122e59ffbdc2f900';
const BASE_MODEL_ID = 'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2';
const BASE_REVISION = 'e8f8c211226b894fcb81acc59f3b34ba3efd5f42';
const TARGET = fileURLToPath(new URL('../models/name-embedding/paraphrase-multilingual-MiniLM-L12-v2/', import.meta.url));
const FILES = [
  { path: 'config.json', bytes: 673, gitBlobSha1: 'ce7fe159b2eee53ef2b9704a72a4efa6c22248b4' },
  { path: 'special_tokens_map.json', bytes: 280, gitBlobSha1: 'd5698132694f4f1bcff08fa7d937b1701812598e' },
  { path: 'tokenizer.json', bytes: 17_082_913, sha256: 'b60b6b43406a48bf3638526314f3d232d97058bc93472ff2de930d43686fa441' },
  { path: 'tokenizer_config.json', bytes: 496, gitBlobSha1: '9f3bfd538ec86d360dc988dac25e3cfb0c4c14d5' },
  { path: 'unigram.json', bytes: 14_763_234, sha256: '71b44701d7efd054205115acfa6ef126c5d2f84bd3affe0c59e48163674d19a6' },
  { path: 'onnx/model_quantized.onnx', bytes: 118_308_126, sha256: '66fc00f5f29afcaff34092e1bdd20008ca3918265a82fb9695a551e510cc4ebc' }
];

function sourceUrl(file) {
  return `https://huggingface.co/${MODEL_ID}/resolve/${REVISION}/${file.path}`;
}

async function digests(filePath, expectedBytes) {
  const handle = await open(filePath, 'r');
  const sha256 = createHash('sha256');
  const gitSha1 = createHash('sha1');
  gitSha1.update(`blob ${expectedBytes}\0`);
  let position = 0;
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    while (position < expectedBytes) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, expectedBytes - position), position);
      if (!bytesRead) throw new Error(`Unexpected end of ${filePath}`);
      const chunk = buffer.subarray(0, bytesRead);
      sha256.update(chunk);
      gitSha1.update(chunk);
      position += bytesRead;
    }
  } finally { await handle.close(); }
  return { bytes: position, sha256: sha256.digest('hex'), gitBlobSha1: gitSha1.digest('hex') };
}

async function validExisting(file, target) {
  try {
    if ((await stat(target)).size !== file.bytes) return null;
    const found = await digests(target, file.bytes);
    return (file.sha256 ? found.sha256 === file.sha256 : found.gitBlobSha1 === file.gitBlobSha1) ? found : null;
  } catch { return null; }
}

async function download(file) {
  const target = path.resolve(TARGET, ...file.path.split('/'));
  const existing = await validExisting(file, target);
  if (existing) {
    process.stderr.write(`verified ${file.path}\n`);
    return { path: file.path, bytes: file.bytes, sha256: existing.sha256, source: sourceUrl(file) };
  }
  await mkdir(path.dirname(target), { recursive: true });
  const partial = `${target}.download.partial`;
  await rm(partial, { force: true });
  const response = await fetch(sourceUrl(file), { redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`Download failed for ${file.path}: HTTP ${response.status}`);
  const handle = await open(partial, 'wx', 0o600);
  let position = 0;
  let lastReported = 0;
  try {
    for await (const chunk of response.body) {
      const bytes = Buffer.from(chunk);
      if (position + bytes.length > file.bytes) throw new Error(`Downloaded file exceeds fixed size: ${file.path}`);
      let written = 0;
      while (written < bytes.length) written += (await handle.write(bytes, written, bytes.length - written, position + written)).bytesWritten;
      position += bytes.length;
      if (position === file.bytes || position - lastReported >= 8 * 1024 * 1024) {
        process.stderr.write(`\r${file.path}: ${position}/${file.bytes}`);
        lastReported = position;
      }
    }
    await handle.sync();
  } finally { await handle.close(); }
  process.stderr.write('\n');
  if (position !== file.bytes) throw new Error(`Downloaded size mismatch for ${file.path}: ${position}`);
  const found = await digests(partial, file.bytes);
  if (file.sha256 ? found.sha256 !== file.sha256 : found.gitBlobSha1 !== file.gitBlobSha1) {
    throw new Error(`Downloaded digest mismatch for ${file.path}`);
  }
  await rm(target, { force: true });
  await rename(partial, target);
  return { path: file.path, bytes: file.bytes, sha256: found.sha256, source: sourceUrl(file) };
}

await mkdir(TARGET, { recursive: true });
const files = [];
for (const file of FILES) files.push(await download(file));

const licenseMetadata = {
  modelLicense: 'apache-2.0',
  modelId: MODEL_ID,
  modelRevision: REVISION,
  convertedFrom: BASE_MODEL_ID,
  baseModelRevision: BASE_REVISION,
  evidence: [
    `https://huggingface.co/${MODEL_ID}/tree/${REVISION}`,
    `https://huggingface.co/${BASE_MODEL_ID}/tree/${BASE_REVISION}`,
    'https://www.apache.org/licenses/LICENSE-2.0'
  ],
  note: 'The converted repository identifies the base model. The base model card declares apache-2.0.'
};
const metadataPath = path.join(TARGET, 'LICENSE-METADATA.json');
await writeFile(metadataPath, `${JSON.stringify(licenseMetadata, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
const metadataBytes = (await stat(metadataPath)).size;
const metadataDigest = await digests(metadataPath, metadataBytes);
files.push({ path: 'LICENSE-METADATA.json', bytes: metadataBytes, sha256: metadataDigest.sha256,
  source: `https://huggingface.co/${BASE_MODEL_ID}/tree/${BASE_REVISION}` });

const manifest = {
  schemaVersion: 1,
  modelId: MODEL_ID,
  revision: REVISION,
  baseModelId: BASE_MODEL_ID,
  baseRevision: BASE_REVISION,
  license: 'apache-2.0',
  dtype: 'q8',
  task: 'feature-extraction',
  remoteRuntimeAllowed: false,
  files,
  totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
  preparedAt: new Date().toISOString()
};
await writeFile(path.join(TARGET, 'model-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
process.stdout.write(`${JSON.stringify({ target: TARGET, files: files.length, bytes: manifest.totalBytes, revision: REVISION }, null, 2)}\n`);
