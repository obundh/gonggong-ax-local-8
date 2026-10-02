import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = createRequire(import.meta.url)(process.env.RECOVERY_PLAYWRIGHT_MODULE || 'playwright');

// Actual app markup/CSS, with a synthetic inventory only. No scan, file read,
// native dialog, recovery or artificially delayed chat message is triggered.
async function withAnimatedApp(reducedMotion, body) {
  const assets = new Map([
    ['/', ['index.html', 'text/html; charset=utf-8']],
    ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
    ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
    ['/favicon.svg', ['favicon.svg', 'image/svg+xml']]
  ]);
  const server = createServer(async (request, response) => {
    const asset = assets.get(new URL(request.url, 'http://127.0.0.1').pathname);
    if (!asset) { response.writeHead(404).end(); return; }
    try { response.writeHead(200, { 'content-type': asset[1] }).end(await readFile(path.join(root, asset[0]))); }
    catch { response.writeHead(500).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 460, height: 720 }, reducedMotion });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      window.__chatAnimationEvidence = [];
      document.addEventListener('animationstart', event => {
        if (!event.target.matches('.bubble')) return;
        const animation = event.target.getAnimations().find(item => item.animationName === event.animationName);
        window.__chatAnimationEvidence.push({
          role: event.target.parentElement.classList.contains('user') ? 'user' : 'assistant',
          name: event.animationName,
          frames: animation?.effect.getKeyframes(),
          timing: animation?.effect.getTiming()
        });
      });
      window.recoveryAPI = {
        devices: async () => ({ devices: [{ id: 'animation-fixture', label: '시험용 Windows (C:)', kind: 'volume', ready: true, system: true, fileSystem: 'NTFS' }] }),
        onEvent: () => () => {}
      };
    });
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.getByText('데스크톱 연결됨', { exact: true }).waitFor();
    await body(page);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

async function showChatConversation(page) {
  await page.getByRole('button', { name: /^잘 모르겠어요/ }).click();
  await page.getByRole('button', { name: /^어디인지 모르겠어요/ }).click();
  await page.locator('#clue-name').waitFor();
}

test('chat bubbles enter gently once without moving the fixed footer or leaving ongoing animations', { timeout: 20_000 }, async () => {
  await withAnimatedApp('no-preference', async page => {
    const footerBefore = await page.locator('.app-footer').boundingBox();
    await showChatConversation(page);
    await page.waitForFunction(() => window.__chatAnimationEvidence.some(item => item.role === 'user') && window.__chatAnimationEvidence.some(item => item.role === 'assistant'));
    const evidence = await page.evaluate(() => window.__chatAnimationEvidence);
    assert.deepEqual(new Set(evidence.map(item => item.name)), new Set(['chat-send', 'chat-receive']));
    for (const animation of evidence) {
      assert.equal(animation.timing.iterations, 1, 'message entrances must not loop');
      assert.ok(animation.timing.duration > 0 && animation.timing.duration <= 350, 'messages should appear promptly');
      assert.equal(animation.frames[0].opacity, '0');
      assert.equal(animation.frames.at(-1).opacity, '1');
      assert.ok(animation.frames[0].transform.includes('translate3d'));
      assert.ok(animation.frames.every(frame => !('height' in frame) && !('margin' in frame)), 'the entrance must not animate layout dimensions');
    }
    assert.deepEqual(await page.locator('.app-footer').boundingBox(), footerBefore, 'message entrances keep the activity footer fixed');
    await page.evaluate(async () => {
      const animations = [...document.querySelectorAll('.bubble,.choice-list')].flatMap(element => element.getAnimations());
      await Promise.all(animations.map(animation => animation.finished.catch(() => {})));
    });
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('.bubble,.choice-list')].flatMap(element => element.getAnimations()).length), 0, 'finished entrances leave no continuous decoration running');
    const completed = await page.locator('.bubble').evaluateAll(elements => elements.map(element => ({ opacity: getComputedStyle(element).opacity, transform: getComputedStyle(element).transform })));
    assert.ok(completed.length >= 2 && completed.every(style => style.opacity === '1' && style.transform === 'none'));
    await mkdir(path.join(root, 'output', 'playwright'), { recursive: true });
    await page.screenshot({ path: path.join(root, 'output', 'playwright', 'chat-animation.png') });
  });
});

test('reduced motion shows chat and choices immediately without entrance animation', { timeout: 20_000 }, async () => {
  await withAnimatedApp('reduce', async page => {
    await showChatConversation(page);
    const styles = await page.locator('.bubble,.question>.clue-grid,.question>.composer-row').evaluateAll(elements => elements.map(element => ({
      name: getComputedStyle(element).animationName,
      opacity: getComputedStyle(element).opacity,
      transform: getComputedStyle(element).transform
    })));
    assert.ok(styles.length >= 3);
    assert.ok(styles.every(style => style.name === 'none' && style.opacity === '1' && style.transform === 'none'));
    assert.deepEqual(await page.evaluate(() => window.__chatAnimationEvidence), []);
  });
});
