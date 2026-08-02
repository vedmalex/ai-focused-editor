/**
 * Starts the browser app on a port that is actually free.
 *
 * `theia start` binds exactly the port it was given and dies with EADDRINUSE if
 * something already owns it — which on a developer machine is routine, because
 * 3000 is the most contested port in the ecosystem. This wrapper turns that
 * hard failure into a predictable step upward and, crucially, *prints where the
 * app ended up*: a floating port nobody can see is worse than a crash.
 *
 * An explicitly requested port is treated as a strong preference, not a
 * contract. If you asked for 4000 and 4000 is taken, you get 4001 and a line
 * saying so, because "the editor did not start" is never the more useful
 * outcome for this application.
 *
 * ## The TOCTOU window, and how it is closed
 *
 * The pre-flight probe binds a candidate port, learns it is free, and releases
 * it — so between the probe and Theia's own `listen()` another process can take
 * it. That window cannot be removed without handing Theia an already-bound
 * socket, which its CLI has no way to accept.
 *
 * So it is not papered over: it is *recovered from*. The wrapper watches the
 * child's output and, if Theia itself reports EADDRINUSE before it reaches its
 * listening line, it treats that as the authoritative answer, resumes the
 * search above the lost port and relaunches. The probe is only an optimisation
 * that keeps the common case to a single launch; the kernel's verdict during
 * the real bind is what decides.
 *
 * What remains: a process that grabs every candidate faster than we can launch
 * will exhaust the attempt budget, and the wrapper then fails with the range it
 * tried. That is the correct outcome — an infinite retry against an adversary
 * is worse than a message naming what happened.
 *
 * Usage:
 *   node scripts/start-browser.mjs [--port N] [--hostname H] [...theia args]
 *   AFE_PORT=4000 bun run start
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildTheiaArgs,
  detectPortInUse,
  extractListeningUrl,
  findAvailablePort,
  formatUrl,
  parseStartOptions,
  shouldRetryStartupExit
} from './start-browser-options.mjs';

const repoRoot = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const appDir = join(repoRoot, 'apps/browser');
const theiaCli = join(appDir, 'node_modules/@theia/cli/bin/theia.js');

/**
 * Asks the kernel, on the very interface the server will use. Probing
 * `127.0.0.1` for a server that will bind `0.0.0.0` produces confident
 * nonsense: a port can be free on the loopback and taken on another interface,
 * and `0.0.0.0` conflicts with both.
 */
function isPortFree(port, hostname) {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    // An empty hostname means "all interfaces", which is what `listen(port)` does.
    if (hostname) {
      probe.listen(port, hostname);
    } else {
      probe.listen(port);
    }
  });
}

/**
 * Runs `theia start` once on `port` and tees its output.
 *
 * Resolves with `{ kind: 'port_in_use' }` only when EADDRINUSE appears *before*
 * the listening line — after a successful bind the same string in a log message
 * belongs to something else (a debug adapter, a terminal, a plugin) and must not
 * restart a healthy editor.
 *
 * @returns {Promise<{ kind: 'port_in_use' } | { kind: 'exit', code: number, listened: boolean }>}
 */
function runTheia(port, forwardedArgs, hostname) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [theiaCli, ...buildTheiaArgs(forwardedArgs, port)], {
      cwd: appDir,
      env: process.env,
      stdio: ['inherit', 'pipe', 'pipe']
    });

    let listened = false;
    let settledAsPortInUse = false;
    // Output arrives in arbitrary chunks, so the line we are looking for can be
    // split in half. Scanning a short rolling tail instead of the bare chunk
    // keeps a mid-line boundary from swallowing the signal.
    let tail = '';

    const forwardSignal = signal => child.kill(signal);
    process.on('SIGINT', forwardSignal);
    process.on('SIGTERM', forwardSignal);

    const cleanup = () => {
      process.off('SIGINT', forwardSignal);
      process.off('SIGTERM', forwardSignal);
    };

    const inspect = (chunk, stream) => {
      const text = chunk.toString();
      stream.write(text);

      if (listened || settledAsPortInUse) {
        return;
      }

      tail = (tail + text).slice(-4096);

      const url = extractListeningUrl(tail);
      if (url) {
        listened = true;
        tail = '';
        // With `--port 0` the kernel picked the number, so Theia's own line is
        // the only place it exists.
        const shown = port === 0 ? url : formatUrl(hostname, port);
        console.log(`\n  AI Focused Editor is running at ${shown}`);
        if (shown !== url) {
          console.log(`  (bound to ${url})`);
        }
        console.log('');
        return;
      }

      if (detectPortInUse(tail)) {
        settledAsPortInUse = true;
        child.kill('SIGTERM');
        cleanup();
        resolve({ kind: 'port_in_use' });
      }
    };

    child.stdout.on('data', chunk => inspect(chunk, process.stdout));
    child.stderr.on('data', chunk => inspect(chunk, process.stderr));

    child.on('error', error => {
      if (settledAsPortInUse) {
        return;
      }
      cleanup();
      console.error(`Failed to launch Theia: ${error.message}`);
      resolve({ kind: 'exit', code: 1, listened });
    });

    child.on('exit', code => {
      if (settledAsPortInUse) {
        return;
      }
      cleanup();
      resolve({ kind: 'exit', code: code ?? 0, listened });
    });
  });
}

async function main() {
  if (!existsSync(theiaCli)) {
    throw new Error(`Theia CLI not found at ${theiaCli}. Run \`bun install\` first.`);
  }

  const { desiredPort, portSource, hostname, maxAttempts, forwardedArgs } =
    parseStartOptions(process.argv.slice(2), process.env);

  let searchFrom = desiredPort;
  const attempted = [];

  for (let launch = 0; launch < maxAttempts; launch++) {
    const { port, searched } = await findAvailablePort({
      desiredPort: searchFrom,
      hostname,
      maxAttempts: maxAttempts - launch,
      isPortFree
    });

    if (searched && port !== desiredPort && attempted.length === 0) {
      console.log(
        `Port ${desiredPort} (from ${portSource}) is busy on ${hostname} — using ${port} instead.`
      );
    }

    attempted.push(port);
    const result = await runTheia(port, forwardedArgs, hostname);

    let lostTheRace = result.kind === 'port_in_use';

    if (result.kind === 'exit' && !result.listened) {
      // The child stopped before it ever served anything. Ask the kernel who
      // owns the port now rather than trusting output that may never have been
      // flushed — see `shouldRetryStartupExit`.
      lostTheRace = shouldRetryStartupExit({
        listened: false,
        portStillFree: await isPortFree(port, hostname)
      });

      if (!lostTheRace) {
        console.error(
          `\nTheia stopped during startup (exit code ${result.code}) without binding ${formatUrl(hostname, port)}. ` +
          'The port is free, so this is not a port conflict — see the output above.'
        );
        process.exitCode = result.code === 0 ? 1 : result.code;
        return;
      }
    }

    if (!lostTheRace) {
      process.exitCode = result.code;
      return;
    }

    // The probe said free, the bind said otherwise: somebody took the port in
    // between. Resume the search strictly above it so we never retry a loser.
    console.log(`Port ${port} was taken between the check and the launch — retrying on the next free port.`);
    searchFrom = port + 1;
  }

  throw new Error(
    `Could not start after ${maxAttempts} attempt(s); ports tried: ${attempted.join(', ')}. ` +
    'Raise AFE_PORT_MAX_ATTEMPTS or free one of these ports.'
  );
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
