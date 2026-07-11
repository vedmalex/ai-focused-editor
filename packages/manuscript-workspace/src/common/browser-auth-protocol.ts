// *****************************************************************************
// OPTIONAL shared-secret browser auth — shared constants + config contract.
//
// This gate is DISABLED BY DEFAULT and only ever runs on the *browser* backend
// (the Theia `target: browser` server). The Electron backend never gates (the
// backend there is only reachable through the Electron shell, which already
// carries its own ElectronSecurityToken). Localhost stays frictionless: a
// loopback connection passes through untouched unless auth is *force-enabled*
// with the `--auth` CLI flag.
//
// Nothing here is Theia- or Node-specific so both the node backend and the
// browser command can share the route/cookie names.
// *****************************************************************************

/** Env var holding a shared secret (password/token). Presence enables the gate. */
export const AUTH_SECRET_ENV = 'AI_FOCUSED_EDITOR_AUTH_SECRET';

/** Env var overriding the session TTL, in seconds. */
export const AUTH_TTL_ENV = 'AI_FOCUSED_EDITOR_AUTH_TTL';

/** Env var overriding the auth home directory (defaults to `~/.ai-focused-editor`). */
export const AUTH_HOME_ENV = 'AI_FOCUSED_EDITOR_AUTH_HOME';

/**
 * Env Theia sets in the *forked electron backend* process
 * (`process.env.THEIA_ELECTRON_VERSION = process.versions.electron`). Its mere
 * presence is our reliable "this is the Electron target" signal — the browser
 * server never sets it.
 */
export const THEIA_ELECTRON_ENV = 'THEIA_ELECTRON_VERSION';

/** Name of the file (under the auth home dir) storing the SALTED HASH, never a plaintext token. */
export const AUTH_STORE_FILENAME = 'auth.json';

/** Signed, HttpOnly, SameSite=Lax session cookie name. */
export const SESSION_COOKIE = 'afe_session';

/** Default session lifetime (seconds) — 7 days. */
export const DEFAULT_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

/** One-time QR-login token lifetime (seconds) — ~2 minutes. */
export const QR_TOKEN_TTL_SECONDS = 120;

/** Public + protected auth route paths (kept in one place so the gate can allow-list them). */
export const AuthRoutes = {
  /** GET → serve the login page; POST → verify password/token and set the session cookie. */
  login: '/auth/login',
  /** GET → static CSS for the login page (public asset). */
  loginStyle: '/auth/login.css',
  /** GET `?token=` → consume a one-time QR token, set the cookie, 302 → `/`. Public (token IS the credential). */
  qrLogin: '/auth/qr-login',
  /** GET → (session-authenticated) issue a one-time QR token + absolute login URL as JSON. */
  qrIssue: '/auth/qr-issue'
} as const;

/**
 * The persisted credential file shape. We ONLY ever store a scrypt-derived hash
 * plus its salt and parameters — never the plaintext password/token.
 */
export interface AuthCredentialFile {
  readonly version: 1;
  /** Key-derivation function used. Only `scrypt` is supported today. */
  readonly kdf: 'scrypt';
  /** Hex-encoded random salt. */
  readonly salt: string;
  /** Hex-encoded scrypt-derived key. */
  readonly hash: string;
  /** Derived key length in bytes. */
  readonly keylen: number;
  /** scrypt cost parameter N (power of two). */
  readonly N: number;
  /** scrypt block-size parameter r. */
  readonly r: number;
  /** scrypt parallelization parameter p. */
  readonly p: number;
}

/** JSON body returned by the QR-issue endpoint. */
export interface QrIssueResponse {
  /** Absolute one-time login URL to encode into the QR image. */
  readonly url: string;
  /** Seconds until the token expires. */
  readonly expiresIn: number;
}
