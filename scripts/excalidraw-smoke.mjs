// Excalidraw render smoke: launches the browser app against examples/sample-book,
// opens sources/world-map.excalidraw, and asserts the Excalidraw canvas mounts with
// self-hosted assets (no CDN fetch, no 404). Run on demand: node scripts/excalidraw-smoke.mjs
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import net from 'node:net';
import { chromium } from 'playwright';

const repoRoot = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const appDir = join(repoRoot, 'apps/browser');
const sampleRoot = join(repoRoot, 'examples/sample-book');

function getFreePort() {
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.listen(0, () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}
async function waitForServer(url, timeout) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { const r = await fetch(url); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('server did not start');
}

const port = Number(process.env.AFE_SMOKE_PORT || await getFreePort());
const url = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, [
  'node_modules/@theia/cli/bin/theia.js', 'start', '--hostname', '127.0.0.1', '--port', String(port), sampleRoot
], { cwd: appDir, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
server.stdout.on('data', c => { out += c; });
server.stderr.on('data', c => { out += c; });

let browser;
const cdnHits = [];
const asset404 = [];
try {
  await waitForServer(url, 120_000);
  browser = await chromium.launch({ headless: process.env.HEADED !== '1' });
  const page = await browser.newPage();
  page.on('request', r => { if (/esm\.sh|unpkg|cdn/i.test(r.url())) cdnHits.push(r.url()); });
  page.on('response', r => { if (/excalidraw-assets/i.test(r.url()) && r.status() >= 400) asset404.push(`${r.status()} ${r.url()}`); });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.theia-TreeNode', { timeout: 90_000 });

  // Reveal the fixture: expand tree sections until the .excalidraw node shows.
  const findNode = async () => page.evaluate(() =>
    [...document.querySelectorAll('.theia-TreeNode')].find(n => n.textContent?.includes('world-map')) ? true : false);
  for (let i = 0; i < 12 && !(await findNode()); i++) {
    await page.evaluate(() => {
      const s = [...document.querySelectorAll('.theia-TreeNode')].find(n => /SOURCES|Источник/i.test(n.textContent || ''));
      if (s) { const r = s.getBoundingClientRect(); const o = { bubbles: true, cancelable: true, clientX: r.left + 8, clientY: r.top + 8, button: 0, buttons: 1, view: window }; s.dispatchEvent(new MouseEvent('mousedown', o)); s.dispatchEvent(new MouseEvent('mouseup', o)); s.dispatchEvent(new MouseEvent('click', o)); }
    });
    await page.waitForTimeout(600);
  }
  if (!(await findNode())) throw new Error('fixture node world-map.excalidraw not found in tree');

  // Double-click the node to open it (our open handler priority 500 should win).
  await page.evaluate(() => {
    const n = [...document.querySelectorAll('.theia-TreeNode')].find(x => x.textContent?.includes('world-map'));
    const r = n.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 8, button: 0, buttons: 1, view: window, detail: 2 };
    n.dispatchEvent(new MouseEvent('mousedown', o));
    n.dispatchEvent(new MouseEvent('mouseup', o));
    n.dispatchEvent(new MouseEvent('dblclick', o));
  });

  // The Excalidraw component mounts a container with class "excalidraw" and a canvas.
  await page.waitForSelector('.excalidraw', { timeout: 60_000 });
  await page.waitForTimeout(3000); // let fonts + canvas settle
  const state = await page.evaluate(() => ({
    excalidrawMounted: !!document.querySelector('.excalidraw'),
    canvasCount: document.querySelectorAll('.excalidraw canvas').length,
    assetPath: window.EXCALIDRAW_ASSET_PATH,
    linkCss: !![...document.querySelectorAll('link[rel=stylesheet]')].find(l => /excalidraw-assets/i.test(l.href))
  }));
  const fontResp = await page.request.get(`${url}/excalidraw-assets/index.css`);
  console.log('STATE:', JSON.stringify(state));
  console.log('assetCss:', fontResp.status());
  console.log('cdnHits:', cdnHits.length, 'asset404:', asset404.length);
  const ok = state.excalidrawMounted && state.canvasCount > 0 && cdnHits.length === 0 && asset404.length === 0 && fontResp.status() === 200;
  console.log(ok ? 'EXCALIDRAW PROBE PASSED' : 'EXCALIDRAW PROBE FAILED');
  if (!ok) { console.log('details:', JSON.stringify({ cdnHits, asset404 })); process.exitCode = 1; }
} catch (e) {
  console.error('PROBE ERROR:', String(e).split('\n')[0]);
  console.error(out.split('\n').slice(-12).join('\n'));
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  server.kill('SIGTERM');
}
