// TASK-022 ISS-372 follow-up -- auxiliary, throwaway diagnostic (NOT product
// code). Purpose: capture the theia BACKEND's raw stdout/stderr live (the
// existing .plan/task-022-iss-371-navigator-probe.mjs only prints it on
// failure, and this run is expected to "succeed" in the sense of not
// throwing) so we can see whether "TypeError: this.target[method] is not
// a function" actually appears during a normal internal+external rename
// pair, and if so pin the exact method name from the stack/message; and
// whether the frontend FileService.onDidFilesChange event fires at all for
// either rename.
//
// Same safety discipline as the sibling probe: isolated throwaway workspace,
// free port outside 3000/3001/3002, examples/sample-book untouched.
//
// Usage: node .plan/task-022-iss372-rpc-instrumentation-probe.mjs

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import net from 'node:net';
import { chromium } from 'playwright';
import { renameSync, writeFileSync } from 'node:fs';
import {
  createIsolatedSampleWorkspace,
  removeIsolatedSampleWorkspace
} from '../scripts/narrative-knowledge-round-trip.mjs';

const FORBIDDEN_PORTS = new Set([3000, 3001, 3002]);
const repoRoot = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const appDir = join(repoRoot, 'apps/browser');
const sampleBookSource = join(repoRoot, 'examples/sample-book');

const { workspaceDir: smokeWorkspaceDir, sampleRoot } = await createIsolatedSampleWorkspace(sampleBookSource);

const before = 'knowledge/zz-iss372-rpc-probe-v1.md';
const after = 'knowledge/zz-iss372-rpc-probe-v2.md';
writeFileSync(join(sampleRoot, before), '# probe\n\nISS-372 RPC-instrumentation probe file.\n');

const port = await getFreePort();
const url = 'http://127.0.0.1:' + port;

const server = spawn(process.execPath, [
  'node_modules/@theia/cli/bin/theia.js',
  'start',
  '--hostname', '127.0.0.1',
  '--port', String(port),
  sampleRoot
], {
  cwd: appDir,
  env: process.env,
  stdio: ['ignore', 'pipe', 'pipe']
});

let serverOutput = '';
server.stdout.on('data', chunk => {
  const text = chunk.toString();
  serverOutput += text;
  process.stdout.write('[server:out] ' + text);
});
server.stderr.on('data', chunk => {
  const text = chunk.toString();
  serverOutput += text;
  process.stdout.write('[server:err] ' + text);
});

let browser;
try {
  await waitForServer(url, 120_000);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on('console', msg => console.log('[page]', msg.type(), msg.text()));
  page.on('pageerror', err => console.log('[page:error]', String(err)));
  await page.addInitScript(() => {
    window.__probeGetBindingByKeyName = function (name) {
      var container = window.theia && window.theia.container;
      if (!container) throw new Error('Theia container is not available.');
      for (var entry of container._bindingDictionary._map.entries()) {
        var key = entry[0];
        if (key && key.name === name) return key;
      }
      throw new Error('No Theia binding found: ' + name);
    };
    window.__probeGet = function (name) {
      return window.theia.container.get(window.__probeGetBindingByKeyName(name));
    };
  });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(() =>
    document.title.includes('AI Focused Editor') ||
    Boolean(document.querySelector('.theia-ApplicationShell, #theia-app-shell, .p-Widget')),
  undefined, { timeout: 60_000 });
  await page.waitForFunction(() => {
    const shellText = document.querySelector('#theia-app-shell')?.textContent ?? '';
    return document.title.includes('sample-book') || shellText.includes('chapter-01.md') || shellText.includes('sample-book');
  }, undefined, { timeout: 45_000 });
  console.log('[t=0ms] session ready -- url=' + url + ', workspace=' + sampleRoot);

  // Subscribe to fileService.onDidFilesChange on the FRONTEND directly (not
  // via a widget) so we get an unambiguous yes/no on frontend delivery,
  // independent of any tree-widget rendering behavior.
  await page.evaluate(() => {
    window.__fileServiceEvents = [];
    const fileService = window.__probeGet('FileService');
    fileService.onDidFilesChange(event => {
      window.__fileServiceEvents.push({ t: Date.now(), changes: event.changes.map(c => ({ uri: c.resource.toString(), type: c.type })) });
      console.log('[frontend] fileService.onDidFilesChange fired: ' + JSON.stringify(event.changes.map(c => c.resource.toString())));
    });
  });

  console.log('[action] issuing internal rename via fileService.move ...');
  await page.evaluate(async ([before, after]) => {
    const fileService = window.__probeGet('FileService');
    const workspaceService = window.__probeGet('WorkspaceService');
    const root = workspaceService.tryGetRoots()[0].resource;
    await fileService.move(root.resolve(before), root.resolve(after));
  }, [before, after]);
  console.log('[action] internal rename issued, waiting 8s for any onDidFilesChange ...');
  await sleep(8000);

  const events1 = await page.evaluate(() => window.__fileServiceEvents);
  console.log('[result] frontend fileService events after internal rename: ' + JSON.stringify(events1));

  console.log('[action] issuing external rename via fs.renameSync ...');
  renameSync(join(sampleRoot, after), join(sampleRoot, before + '.ext-renamed.md'));
  console.log('[action] external rename issued, waiting 10s for any onDidFilesChange ...');
  await sleep(10000);

  const events2 = await page.evaluate(() => window.__fileServiceEvents);
  console.log('[result] frontend fileService events after external rename: ' + JSON.stringify(events2));

  console.log('\n=== SERVER OUTPUT SCAN: "not a function" / RpcProxyFactory / onNotification occurrences ===');
  const lines = serverOutput.split('\n');
  lines.forEach((line, i) => {
    if (line.includes('not a function') || line.includes('RpcProxyFactory') || line.includes('onNotification')) {
      const context = lines.slice(Math.max(0, i - 3), i + 5).join('\n');
      console.log('--- match at line ' + i + ' ---\n' + context + '\n');
    }
  });
} catch (error) {
  console.error('Probe failed.');
  console.error(error instanceof Error ? error.stack || error.message : String(error));
} finally {
  if (browser) await browser.close();
  server.kill('SIGTERM');
  await Promise.race([once(server, 'exit'), sleep(5_000)]);
  await removeIsolatedSampleWorkspace(smokeWorkspaceDir);
}

async function getFreePort() {
  for (let attempt = 0; attempt < 10; attempt++) {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const address = probe.address();
    const freePort = typeof address === 'object' && address ? address.port : 0;
    probe.close();
    await once(probe, 'close');
    if (!FORBIDDEN_PORTS.has(freePort)) return freePort;
  }
  throw new Error('Could not find a free port outside the forbidden set.');
}

async function waitForServer(targetUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(targetUrl);
      if (response.ok || response.status < 500) return;
      lastError = new Error('Unexpected HTTP ' + response.status);
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }
  throw lastError instanceof Error ? lastError : new Error('Timed out waiting for ' + targetUrl);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
