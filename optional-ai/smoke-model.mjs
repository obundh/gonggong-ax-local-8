import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createFilenameSemanticSearch, getSemanticStatus } from '../engine/semantic-search.mjs';

const modelPath = fileURLToPath(new URL('../models/name-embedding/paraphrase-multilingual-MiniLM-L12-v2/', import.meta.url));
const runtimeRoot = fileURLToPath(new URL('./', import.meta.url));
const memoryBefore = process.memoryUsage().rss;
const started = performance.now();
const status = getSemanticStatus({ modelPath, runtimeRoot });
if (!status.available) throw new Error(`Semantic model unavailable: ${status.reason}`);
const search = await createFilenameSemanticSearch({ modelPath, runtimeRoot });
const loaded = performance.now();
const ranked = await search.rank('annual financial report', [
  { id: 'ko', name: '연간 재무 보고서.xlsx' },
  { id: 'weather', name: '오늘의 날씨 사진.jpg' },
  { id: 'generated', name: 'carved-0001.docx', nameIsGenerated: true }
]);
const finished = performance.now();
await search.close();
const result = {
  status,
  order: ranked.map(candidate => ({ id: candidate.id, semanticScore: candidate.semanticScore, semanticReasons: candidate.semanticReasons })),
  modelLoadMs: Math.round(loaded - started),
  rankMs: Math.round(finished - loaded),
  rssBeforeBytes: memoryBefore,
  rssAfterBytes: process.memoryUsage().rss,
  rssDeltaBytes: process.memoryUsage().rss - memoryBefore,
  measuredAt: new Date().toISOString(),
  note: 'One local Windows run; this is a measurement, not a performance guarantee.'
};
if (ranked[0]?.id !== 'ko' || ranked.at(-1)?.id !== 'generated') throw new Error(`Unexpected multilingual smoke order: ${JSON.stringify(result.order)}`);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
