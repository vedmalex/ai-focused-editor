/**
 * Pure decision logic for `scripts/start-browser.mjs`.
 *
 * Everything here is side-effect free and injectable, so the interesting half
 * of "start the web app on a port that is actually free" can be tested without
 * spawning Theia: which port was *asked* for, which port is *taken*, how far the
 * search may run, and which arguments must survive the wrapper untouched.
 *
 * The runner (`../start-browser.mjs`) owns the parts that cannot be pure:
 * probing a real socket, spawning Theia, and retrying when the kernel disagrees
 * with our probe.
 */

/** Theia's own browser default (`@theia/core/lib/node/backend-application.js`). */
export const DEFAULT_PORT = 3000;

/** Theia's own default; kept in sync so the probe binds where the server will. */
export const DEFAULT_HOSTNAME = 'localhost';

/**
 * How many ports the search may touch, counting both probes and real launches.
 * 20 is enough to step over a handful of neighbouring dev servers and small
 * enough that a genuinely wedged machine fails fast with a readable message.
 */
export const DEFAULT_MAX_ATTEMPTS = 20;

/** Highest port number the search may reach before giving up. */
export const MAX_PORT = 65535;

/**
 * Environment variables that can carry the desired port, in falling priority.
 * `AFE_PORT` is the project-owned name; `PORT` is honoured because it is the
 * universal convention, but it must never beat an explicit `AFE_PORT`.
 */
const PORT_ENV_VARS = ['AFE_PORT', 'PORT'];

const PORT_FLAGS = new Set(['--port', '-p']);
const HOSTNAME_FLAGS = new Set(['--hostname', '-h']);

/**
 * Splits `--flag=value` into its two halves. A bare `--flag` yields a
 * `value` of `undefined`, which tells the caller to consume the next token.
 */
function splitFlag(token) {
  const eq = token.indexOf('=');
  if (eq === -1) {
    return { flag: token, value: undefined, inline: false };
  }
  return { flag: token.slice(0, eq), value: token.slice(eq + 1), inline: true };
}

/**
 * A port must be a whole number in range. `--port abc` is a typo, not a request
 * for the default: guessing here would silently start the app somewhere the
 * caller did not ask for, which is exactly the failure this task exists to fix.
 */
function parsePortValue(raw, source) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > MAX_PORT) {
    throw new Error(`Invalid port from ${source}: ${JSON.stringify(raw)} (expected an integer 0..${MAX_PORT}).`);
  }
  return value;
}

/**
 * Reads the desired port, the hostname the server will bind to, and the search
 * budget out of `argv` + `env`, and returns everything else verbatim so the
 * wrapper stays transparent to `--hostname`, the workspace path, `--auth`, and
 * any future Theia flag it has never heard of.
 *
 * Priority is CLI > `AFE_PORT` > `PORT` > {@link DEFAULT_PORT}: an argument is
 * typed for this one run and must win over a variable exported once in a shell
 * profile and forgotten.
 *
 * `--port`/`-p` tokens are *consumed* (the runner re-appends the resolved port),
 * while `--hostname`/`-h` is only *read* — Theia still needs it.
 *
 * @param {string[]} argv arguments intended for `theia start`
 * @param {Record<string, string | undefined>} env
 */
export function parseStartOptions(argv = [], env = {}) {
  const forwardedArgs = [];
  let cliPort;
  let hostname = DEFAULT_HOSTNAME;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];

    // A bare `--` ends our own scanning: whatever follows was explicitly marked
    // as "not for you" and is forwarded byte for byte, separator included.
    if (token === '--') {
      forwardedArgs.push(...argv.slice(i));
      break;
    }

    const { flag, value, inline } = splitFlag(token);

    if (PORT_FLAGS.has(flag)) {
      const raw = inline ? value : argv[i + 1];
      if (raw === undefined) {
        throw new Error(`Missing value for ${flag}.`);
      }
      cliPort = parsePortValue(raw, flag);
      if (!inline) {
        i++; // the value token is consumed together with its flag
      }
      continue;
    }

    if (HOSTNAME_FLAGS.has(flag)) {
      const raw = inline ? value : argv[i + 1];
      if (raw === undefined) {
        throw new Error(`Missing value for ${flag}.`);
      }
      hostname = raw;
      forwardedArgs.push(token);
      if (!inline) {
        forwardedArgs.push(raw);
        i++;
      }
      continue;
    }

    forwardedArgs.push(token);
  }

  const fromEnvName = PORT_ENV_VARS.find(name => env[name] !== undefined && env[name] !== '');

  let desiredPort = DEFAULT_PORT;
  let portSource = 'default';
  if (cliPort !== undefined) {
    desiredPort = cliPort;
    portSource = '--port';
  } else if (fromEnvName) {
    desiredPort = parsePortValue(env[fromEnvName], fromEnvName);
    portSource = fromEnvName;
  }

  let maxAttempts = DEFAULT_MAX_ATTEMPTS;
  const rawAttempts = env.AFE_PORT_MAX_ATTEMPTS;
  if (rawAttempts !== undefined && rawAttempts !== '') {
    const parsed = Number(rawAttempts);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new Error(`Invalid AFE_PORT_MAX_ATTEMPTS: ${JSON.stringify(rawAttempts)} (expected an integer >= 1).`);
    }
    maxAttempts = parsed;
  }

  return { desiredPort, portSource, hostname, maxAttempts, forwardedArgs };
}

/**
 * Walks upward from `desiredPort` until `isPortFree` says yes.
 *
 * The walk is deliberately an increment rather than an OS-assigned random port:
 * a developer who asked for 3000 and got 3001 can still guess the bookmark; one
 * who got 54873 cannot.
 *
 * A `desiredPort` of 0 is the one exception — it *means* "any free port", so it
 * is passed straight through for the kernel to resolve, and the real number is
 * read back from Theia's own startup line.
 *
 * @param {object} options
 * @param {number} options.desiredPort
 * @param {string} options.hostname interface the server will bind to
 * @param {number} [options.maxAttempts]
 * @param {(port: number, hostname: string) => Promise<boolean>} options.isPortFree
 * @returns {Promise<{ port: number, tried: number[], searched: boolean }>}
 */
export async function findAvailablePort({
  desiredPort,
  hostname,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  isPortFree
}) {
  if (desiredPort === 0) {
    return { port: 0, tried: [], searched: false };
  }

  const tried = [];
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const candidate = desiredPort + attempt;
    if (candidate > MAX_PORT) {
      break;
    }
    tried.push(candidate);
    if (await isPortFree(candidate, hostname)) {
      return { port: candidate, tried, searched: true };
    }
  }

  const range = tried.length > 0 ? `${tried[0]}..${tried[tried.length - 1]}` : `${desiredPort}`;
  throw new Error(
    `No free port on ${hostname}: tried ${range} (${tried.length} port(s)). ` +
    'Free one of them, pass a different --port, or raise AFE_PORT_MAX_ATTEMPTS.'
  );
}

/**
 * The argument vector for `theia start`.
 *
 * The resolved `--port` goes first so it reads as the wrapper's contribution,
 * and the caller's own arguments — including the positional workspace path —
 * keep their original order behind it.
 */
export function buildTheiaArgs(forwardedArgs, port) {
  return ['start', '--port', String(port), ...forwardedArgs];
}

/**
 * A URL a human can paste. `0.0.0.0`/`::` are bind addresses, not destinations:
 * printing them literally hands the reader something their browser refuses, so
 * they are rendered as `localhost` while the bind address is reported alongside
 * by the caller.
 */
export function formatUrl(hostname, port) {
  const wildcard = hostname === '0.0.0.0' || hostname === '::' || hostname === '';
  const host = wildcard ? 'localhost' : hostname;
  const bracketed = host.includes(':') ? `[${host}]` : host;
  return `http://${bracketed}:${port}`;
}

/**
 * True when Theia's output says the bind failed because somebody else owns the
 * port. This is the *real* signal — the pre-flight probe can only ever report
 * what was true a moment ago (see the TOCTOU note in `start-browser.mjs`).
 */
export function detectPortInUse(text) {
  return /EADDRINUSE|address already in use/i.test(text);
}

/**
 * Decides what a child that stopped during startup means.
 *
 * Reading EADDRINUSE out of the output is the fast path, but it is not a
 * guarantee: Theia's error handler calls `process.exit` on the next tick, and a
 * pipe that has not flushed yet loses the message — observed live, where a
 * losing attempt died having printed nothing at all. So the exit itself is
 * re-examined: if the child never announced a listening socket and the port is
 * *now* occupied, somebody else owns it, whatever the log did or did not say,
 * and the search should move on.
 *
 * If the port is free, the crash was Theia's own and retrying would only hide
 * it behind an identical second failure.
 *
 * @param {{ listened: boolean, portStillFree: boolean }} outcome
 */
export function shouldRetryStartupExit({ listened, portStillFree }) {
  return !listened && !portStillFree;
}

/**
 * Pulls the address out of Theia's own `Theia app listening on <url>.` line,
 * which is authoritative in a way our resolved port is not — if anything ever
 * rewrites the port downstream, this is what actually happened.
 */
export function extractListeningUrl(text) {
  const match = /Theia app listening on (\S+?)\.?(\s|$)/.exec(text);
  return match ? match[1] : undefined;
}
