import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Local static GUI preview only. No recovery endpoints or filesystem browsing.
const directory = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] || 54137);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid preview port.');
const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/workspace.css', ['workspace.css', 'text/css; charset=utf-8']],
  ['/ui/workspace.mjs', ['ui/workspace.mjs', 'text/javascript; charset=utf-8']],
  ['/ui/acquisition.mjs', ['ui/acquisition.mjs', 'text/javascript; charset=utf-8']],
  ['/ui/checklist-data.mjs', ['ui/checklist-data.mjs', 'text/javascript; charset=utf-8']],
  ['/engine/recovery-outcome.mjs', ['engine/recovery-outcome.mjs', 'text/javascript; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
]);
const server = http.createServer(async (request, response) => {
  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cross-Origin-Resource-Policy': 'same-origin' };
  let url;
  try { url = new URL(request.url || '/', 'http://127.0.0.1'); }
  catch { response.writeHead(400, headers); response.end('Invalid request'); return; }
  const file = files.get(url.pathname);
  if (!['GET', 'HEAD'].includes(request.method) || !file) {
    response.writeHead(404, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found'); return;
  }
  try {
    const data = await readFile(path.join(directory, file[0]));
    response.writeHead(200, { ...headers, 'Content-Type': file[1] });
    response.end(request.method === 'HEAD' ? undefined : data);
  } catch {
    response.writeHead(500, headers); response.end('Preview file unavailable');
  }
});
server.listen(port, '127.0.0.1', () => console.log(`Recovery GUI preview: http://127.0.0.1:${server.address().port}`));
server.on('error', (error) => { console.error(error.code === 'EADDRINUSE' ? 'Preview port is busy. Run: node serve.mjs 54138' : error.message); process.exitCode = 1; });
