/**
 * Tests for the pure half of the web-app launcher (GitHub #54 / TASK-021).
 *
 * The impure half — spawning Theia, binding a real socket — is covered by the
 * live check in the task record, not here. What *can* regress silently is the
 * decision logic: which port was asked for, how the search steps, what happens
 * when an explicitly requested port is taken, and whether the caller's other
 * arguments survive the wrapper. All four are asserted below.
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_PORT,
  buildTheiaArgs,
  detectPortInUse,
  extractListeningUrl,
  findAvailablePort,
  formatUrl,
  parseStartOptions,
  shouldRetryStartupExit
} from './start-browser-options.mjs';

/** …/scripts → the repository root. */
const REPO_ROOT = join(import.meta.dir, '..');

/** A probe stub: every port in `busy` is taken, everything else is free. */
function stubProbe(busy: number[], seen?: Array<[number, string]>) {
  const taken = new Set(busy);
  return async (port: number, hostname: string) => {
    seen?.push([port, hostname]);
    return !taken.has(port);
  };
}

describe('parseStartOptions — where the desired port comes from', () => {
  test('falls back to Theia\'s own default when nothing asks for a port', () => {
    const options = parseStartOptions([], {});
    expect(options.desiredPort).toBe(DEFAULT_PORT);
    expect(options.desiredPort).toBe(3000);
    expect(options.portSource).toBe('default');
  });

  test('reads --port', () => {
    expect(parseStartOptions(['--port', '4000'], {}).desiredPort).toBe(4000);
    expect(parseStartOptions(['--port=4000'], {}).desiredPort).toBe(4000);
  });

  test('reads the -p alias Theia itself declares', () => {
    expect(parseStartOptions(['-p', '4100'], {}).desiredPort).toBe(4100);
    expect(parseStartOptions(['-p=4100'], {}).desiredPort).toBe(4100);
  });

  test('reads AFE_PORT', () => {
    const options = parseStartOptions([], { AFE_PORT: '4200' });
    expect(options.desiredPort).toBe(4200);
    expect(options.portSource).toBe('AFE_PORT');
  });

  test('reads the conventional PORT when AFE_PORT is absent', () => {
    const options = parseStartOptions([], { PORT: '4300' });
    expect(options.desiredPort).toBe(4300);
    expect(options.portSource).toBe('PORT');
  });

  /**
   * The priority is the point, not a detail: an argument is typed for this one
   * run, a variable is exported once and forgotten. If env ever won, a stale
   * `PORT` in a shell profile would silently override what the user just typed.
   */
  test('an argument beats the environment', () => {
    const options = parseStartOptions(['--port', '4000'], { AFE_PORT: '4200', PORT: '4300' });
    expect(options.desiredPort).toBe(4000);
    expect(options.portSource).toBe('--port');
  });

  test('AFE_PORT beats the generic PORT', () => {
    const options = parseStartOptions([], { AFE_PORT: '4200', PORT: '4300' });
    expect(options.desiredPort).toBe(4200);
    expect(options.portSource).toBe('AFE_PORT');
  });

  test('an empty variable is not a request', () => {
    expect(parseStartOptions([], { AFE_PORT: '', PORT: '4300' }).desiredPort).toBe(4300);
    expect(parseStartOptions([], { AFE_PORT: '', PORT: '' }).desiredPort).toBe(DEFAULT_PORT);
  });

  test('a malformed port is refused instead of silently defaulting', () => {
    expect(() => parseStartOptions(['--port', 'abc'], {})).toThrow(/Invalid port/);
    expect(() => parseStartOptions(['--port', '70000'], {})).toThrow(/Invalid port/);
    expect(() => parseStartOptions(['--port', '-1'], {})).toThrow(/Invalid port/);
    expect(() => parseStartOptions([], { AFE_PORT: 'nope' })).toThrow(/Invalid port/);
    expect(() => parseStartOptions(['--port'], {})).toThrow(/Missing value/);
  });
});

describe('parseStartOptions — everything else passes through untouched', () => {
  test('the port flag is consumed and nothing else is', () => {
    const options = parseStartOptions(
      ['--hostname', '0.0.0.0', '--port', '4000', '../../examples/sample-book', '--auth'],
      {}
    );
    expect(options.forwardedArgs).toEqual([
      '--hostname',
      '0.0.0.0',
      '../../examples/sample-book',
      '--auth'
    ]);
  });

  test('the inline form is consumed whole, not left as a stray token', () => {
    const options = parseStartOptions(['--port=4000', 'workspace'], {});
    expect(options.forwardedArgs).toEqual(['workspace']);
  });

  test('flags the wrapper has never heard of survive, values included', () => {
    const options = parseStartOptions(['--auth-set-password', 'секрет', '--ssl'], {});
    expect(options.forwardedArgs).toEqual(['--auth-set-password', 'секрет', '--ssl']);
  });

  /**
   * `--auth-set-password` takes a value that could look like anything. After a
   * bare `--` the wrapper must stop interpreting entirely, or a password of
   * `--port` would be eaten as a flag.
   */
  test('nothing after a bare -- is interpreted', () => {
    const options = parseStartOptions(['--', '--port', '9999'], {});
    expect(options.desiredPort).toBe(DEFAULT_PORT);
    expect(options.forwardedArgs).toEqual(['--', '--port', '9999']);
  });

  test('the hostname is read for the probe but still forwarded to Theia', () => {
    expect(parseStartOptions(['--hostname', '0.0.0.0'], {}).hostname).toBe('0.0.0.0');
    expect(parseStartOptions(['--hostname', '0.0.0.0'], {}).forwardedArgs).toEqual([
      '--hostname',
      '0.0.0.0'
    ]);
    expect(parseStartOptions(['-h=1.2.3.4'], {}).hostname).toBe('1.2.3.4');
    expect(parseStartOptions(['-h=1.2.3.4'], {}).forwardedArgs).toEqual(['-h=1.2.3.4']);
  });

  test('the hostname defaults to Theia\'s own default, not to a wildcard', () => {
    expect(parseStartOptions([], {}).hostname).toBe('localhost');
  });

  test('the attempt budget is configurable and validated', () => {
    expect(parseStartOptions([], {}).maxAttempts).toBe(DEFAULT_MAX_ATTEMPTS);
    expect(parseStartOptions([], { AFE_PORT_MAX_ATTEMPTS: '3' }).maxAttempts).toBe(3);
    expect(() => parseStartOptions([], { AFE_PORT_MAX_ATTEMPTS: '0' })).toThrow(/AFE_PORT_MAX_ATTEMPTS/);
    expect(() => parseStartOptions([], { AFE_PORT_MAX_ATTEMPTS: 'x' })).toThrow(/AFE_PORT_MAX_ATTEMPTS/);
  });
});

describe('findAvailablePort — predictable, incremental, bounded', () => {
  test('a free port is taken as-is', async () => {
    const result = await findAvailablePort({
      desiredPort: 3000,
      hostname: 'localhost',
      isPortFree: stubProbe([])
    });
    expect(result.port).toBe(3000);
    expect(result.tried).toEqual([3000]);
  });

  /**
   * The increment is the requirement (#54.4): an OS-assigned random port is
   * free too, but nobody can guess it. 3000 → 3001 → 3002 stays memorable.
   */
  test('a busy port steps up by one, not to a random port', async () => {
    const result = await findAvailablePort({
      desiredPort: 3000,
      hostname: 'localhost',
      isPortFree: stubProbe([3000, 3001, 3002])
    });
    expect(result.port).toBe(3003);
    expect(result.tried).toEqual([3000, 3001, 3002, 3003]);
  });

  /**
   * The user's explicit decision (#54.2): an assigned port is a preference, so
   * a busy 4000 becomes 4001 rather than a refusal to start.
   */
  test('an explicitly requested but busy port also moves up', async () => {
    const result = await findAvailablePort({
      desiredPort: 4000,
      hostname: 'localhost',
      isPortFree: stubProbe([4000])
    });
    expect(result.port).toBe(4001);
  });

  test('the search probes the very interface the server will bind', async () => {
    const seen: Array<[number, string]> = [];
    await findAvailablePort({
      desiredPort: 3000,
      hostname: '0.0.0.0',
      isPortFree: stubProbe([3000], seen)
    });
    expect(seen).toEqual([
      [3000, '0.0.0.0'],
      [3001, '0.0.0.0']
    ]);
  });

  test('the search is bounded and names what it tried', async () => {
    const busy = [3000, 3001, 3002, 3003, 3004];
    await expect(
      findAvailablePort({
        desiredPort: 3000,
        hostname: 'localhost',
        maxAttempts: 3,
        isPortFree: stubProbe(busy)
      })
    ).rejects.toThrow(/tried 3000\.\.3002 \(3 port\(s\)\)/);
  });

  test('the budget is the number of ports touched', async () => {
    const seen: Array<[number, string]> = [];
    await findAvailablePort({
      desiredPort: 3000,
      hostname: 'localhost',
      maxAttempts: 4,
      isPortFree: stubProbe([3000, 3001, 3002], seen)
    });
    expect(seen.map(([port]) => port)).toEqual([3000, 3001, 3002, 3003]);
  });

  test('the search stops at the top of the port range', async () => {
    await expect(
      findAvailablePort({
        desiredPort: 65534,
        hostname: 'localhost',
        maxAttempts: 10,
        isPortFree: stubProbe([65534, 65535])
      })
    ).rejects.toThrow(/tried 65534\.\.65535/);
  });

  /** Port 0 already means "any free port"; searching upward from it is nonsense. */
  test('port 0 is passed through for the kernel to resolve', async () => {
    let probed = false;
    const result = await findAvailablePort({
      desiredPort: 0,
      hostname: 'localhost',
      isPortFree: async () => {
        probed = true;
        return true;
      }
    });
    expect(result.port).toBe(0);
    expect(result.searched).toBe(false);
    expect(probed).toBe(false);
  });
});

describe('buildTheiaArgs', () => {
  test('the resolved port is passed to Theia and the rest keeps its order', () => {
    expect(buildTheiaArgs(['--hostname', '0.0.0.0', '../../examples/sample-book'], 3001)).toEqual([
      'start',
      '--port',
      '3001',
      '--hostname',
      '0.0.0.0',
      '../../examples/sample-book'
    ]);
  });
});

describe('formatUrl', () => {
  test('a bind wildcard is shown as something a browser can open', () => {
    expect(formatUrl('0.0.0.0', 3001)).toBe('http://localhost:3001');
    expect(formatUrl('::', 3001)).toBe('http://localhost:3001');
  });

  test('a real hostname is kept', () => {
    expect(formatUrl('localhost', 3000)).toBe('http://localhost:3000');
    expect(formatUrl('127.0.0.1', 3000)).toBe('http://127.0.0.1:3000');
  });

  test('an IPv6 literal is bracketed', () => {
    expect(formatUrl('::1', 3000)).toBe('http://[::1]:3000');
  });
});

/**
 * These two read Theia's own output and decide whether to retry — they are the
 * mechanism that closes the check-then-launch race, so they are worth teeth.
 */
describe('reading Theia\'s startup output', () => {
  test('a lost race is recognised from the kernel error', () => {
    expect(detectPortInUse('Error: listen EADDRINUSE: address already in use 0.0.0.0:3000')).toBe(true);
    expect(detectPortInUse('root INFO Theia app listening on http://0.0.0.0:3000.')).toBe(false);
  });

  test('the address is read back from the line Theia actually prints', () => {
    expect(extractListeningUrl('root INFO Theia app listening on http://0.0.0.0:3001.')).toBe(
      'http://0.0.0.0:3001'
    );
    expect(extractListeningUrl('root INFO Theia app listening on http://[::1]:3001.\nnext line')).toBe(
      'http://[::1]:3001'
    );
    expect(extractListeningUrl('nothing interesting here')).toBeUndefined();
  });

  /**
   * Observed live: a losing attempt died with its EADDRINUSE message still in
   * an unflushed pipe, so the text signal alone silently ended the search. The
   * exit is therefore re-examined against the kernel.
   */
  test('a startup death on a now-occupied port is a lost race, message or not', () => {
    expect(shouldRetryStartupExit({ listened: false, portStillFree: false })).toBe(true);
  });

  test('a startup death on a still-free port is a real crash, not a race', () => {
    expect(shouldRetryStartupExit({ listened: false, portStillFree: true })).toBe(false);
  });

  test('a server that did listen is never restarted', () => {
    expect(shouldRetryStartupExit({ listened: true, portStillFree: false })).toBe(false);
    expect(shouldRetryStartupExit({ listened: true, portStillFree: true })).toBe(false);
  });
});

describe('package wiring', () => {
  async function scripts(dir: string): Promise<Record<string, string>> {
    const manifest = JSON.parse(await fs.readFile(join(dir, 'package.json'), 'utf8'));
    return manifest.scripts as Record<string, string>;
  }

  /**
   * The wrapper only helps if `start` actually goes through it. A future edit
   * that "simplifies" this back to a bare `theia start` restores the original
   * bug in a way no other test would notice.
   */
  test('the browser app starts through the wrapper', async () => {
    const start = (await scripts(join(REPO_ROOT, 'apps/browser'))).start;
    expect(start).toContain('start-browser.mjs');
    expect(start).not.toMatch(/(^|\s)theia start/);
  });

  test('the root start scripts still delegate to the browser app', async () => {
    const root = await scripts(REPO_ROOT);
    expect(root.start).toContain('apps/browser');
    expect(root['start:browser']).toContain('apps/browser');
  });

  /**
   * The smoke scripts pick their own free port and pass `--port` to Theia
   * directly. They must keep bypassing the wrapper — routing them through it
   * would add a second, redundant port negotiation to a test that already
   * knows the address it is asserting against.
   */
  test('the smoke scripts keep their own direct Theia launch', async () => {
    for (const file of ['scripts/browser-smoke.mjs', 'scripts/excalidraw-smoke.mjs']) {
      const source = await fs.readFile(join(REPO_ROOT, file), 'utf8');
      expect(source).toContain('@theia/cli/bin/theia.js');
      expect(source).not.toContain('start-browser.mjs');
    }
  });
});
