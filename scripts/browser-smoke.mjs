import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import net from 'node:net';
import { chromium } from 'playwright';

const repoRoot = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const appDir = join(repoRoot, 'apps/browser');
const sampleRoot = join(repoRoot, 'examples/sample-book');
const port = Number(process.env.AFE_SMOKE_PORT || await getFreePort());
const url = `http://127.0.0.1:${port}`;

const server = spawn(process.execPath, [
  'node_modules/@theia/cli/bin/theia.js',
  'start',
  '--hostname',
  '127.0.0.1',
  '--port',
  String(port),
  sampleRoot
], {
  cwd: appDir,
  env: process.env,
  stdio: ['ignore', 'pipe', 'pipe']
});

let serverOutput = '';
server.stdout.on('data', chunk => {
  serverOutput += chunk.toString();
});
server.stderr.on('data', chunk => {
  serverOutput += chunk.toString();
});

let browser;
try {
  await waitForServer(url, 120_000);
  browser = await chromium.launch({
    headless: process.env.HEADED !== '1'
  });
  const page = await browser.newPage();
  await page.addInitScript(() => {
    window.__afeSmokeGetBindingByKeyName = name => {
      const container = window.theia?.container;
      if (!container) {
        throw new Error('Theia container is not available.');
      }
      for (const [key] of container._bindingDictionary._map.entries()) {
        if (key?.name === name) {
          return key;
        }
      }
      throw new Error(`No Theia binding found: ${name}`);
    };
    window.__afeSmokeGetCommandRegistry = () =>
      window.theia.container.get(window.__afeSmokeGetBindingByKeyName('CommandRegistry'));
  });
  await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000
  });

  await page.waitForFunction(() =>
    document.title.includes('AI Focused Editor') ||
    Boolean(document.querySelector('.theia-ApplicationShell, #theia-app-shell, .p-Widget')),
  undefined, {
    timeout: 60_000
  });

  await page.waitForFunction(() => {
    const shellText = document.querySelector('#theia-app-shell')?.textContent ?? '';
    return document.title.includes('sample-book') ||
      shellText.includes('chapter-01.md') ||
      shellText.includes('sample-book');
  }, undefined, {
    timeout: 45_000
  });

  await page.waitForFunction(() =>
    (document.querySelector('#theia-statusBar')?.textContent ?? '').includes('AI:'),
  undefined, {
    timeout: 20_000
  });

  await assertCommandsRegistered(page, [
    'ai-focused-editor.workspace.validate',
    'ai-focused-editor.manuscriptTree.refresh',
    'ai-focused-editor.sources.refresh',
    'ai-focused-editor.entities.refreshCards',
    'ai-focused-editor.bookBuild.buildMarkdown',
    'ai-focused-editor.bookBuild.buildHtml',
    'ai-focused-editor.semanticMarkdown.preview.refresh'
  ]);

  await executeCommand(page, 'ai-focused-editor.manuscriptTree.refresh');
  await executeCommand(page, 'ai-focused-editor.sources.refresh');
  await executeCommand(page, 'ai-focused-editor.entities.refreshCards');

  await page.waitForFunction(() => {
    const text = document.body.innerText;
    return text.includes('Sources') &&
      text.includes('Knowledge Cards');
  }, undefined, {
    timeout: 20_000
  });

  await startCommand(page, 'ai-focused-editor.workspace.validate');
  await page.waitForFunction(() =>
    document.body.innerText.includes('Manuscript workspace:'),
  undefined, {
    timeout: 20_000
  });

  console.log(`Browser smoke passed: ${url}`);
} catch (error) {
  console.error('Browser smoke failed.');
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  if (serverOutput.trim()) {
    console.error('\nTheia server output:\n' + serverOutput.trim().slice(-4000));
  }
  process.exitCode = 1;
} finally {
  if (browser) {
    await browser.close();
  }
  server.kill('SIGTERM');
  await Promise.race([
    once(server, 'exit'),
    new Promise(resolve => setTimeout(resolve, 5_000))
  ]);
}

async function getFreePort() {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  const freePort = typeof address === 'object' && address ? address.port : 0;
  probe.close();
  await once(probe, 'close');
  return freePort;
}

async function waitForServer(targetUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(targetUrl);
      if (response.ok || response.status < 500) {
        return;
      }
      lastError = new Error(`Unexpected HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw lastError instanceof Error ? lastError : new Error(`Timed out waiting for ${targetUrl}`);
}

async function assertCommandsRegistered(page, commandIds) {
  const missingCommands = await page.evaluate(ids => {
    const registry = window.__afeSmokeGetCommandRegistry();
    return ids.filter(id => !registry.getCommand(id));
  }, commandIds);

  if (missingCommands.length > 0) {
    throw new Error(`Missing Theia command(s): ${missingCommands.join(', ')}`);
  }
}

async function executeCommand(page, commandId) {
  const result = await page.evaluate(async id => {
    const registry = window.__afeSmokeGetCommandRegistry();
    try {
      await Promise.race([
        registry.executeCommand(id),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`Command timed out: ${id}`)), 10_000))
      ]);
      return {
        ok: true
      };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }, commandId);

  if (!result.ok) {
    throw new Error(result.message);
  }
}

async function startCommand(page, commandId) {
  const result = await page.evaluate(id => {
    const registry = window.__afeSmokeGetCommandRegistry();
    registry.executeCommand(id).catch(error => {
      window.__afeSmokeCommandError = error instanceof Error ? error.message : String(error);
    });
    return {
      ok: true
    };
  }, commandId);

  if (!result.ok) {
    throw new Error(`Failed to start command: ${commandId}`);
  }
}
