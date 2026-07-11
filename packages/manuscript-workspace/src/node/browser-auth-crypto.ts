// *****************************************************************************
// Crypto + credential-store helpers for the optional browser-auth gate.
//
// All hashing uses Node's built-in `crypto` (scrypt for the password KDF,
// timing-safe comparison for verification, HMAC for the session-cookie
// signature). No secret is ever written in plaintext.
// *****************************************************************************

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  AUTH_HOME_ENV,
  AUTH_STORE_FILENAME,
  type AuthCredentialFile
} from '../common/browser-auth-protocol';

const SCRYPT_KEYLEN = 64;
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

/** Resolve the auth home directory (`~/.ai-focused-editor`, overridable by env). */
export function authHomeDir(): string {
  const override = process.env[AUTH_HOME_ENV];
  if (override && override.trim().length > 0) {
    return override;
  }
  return path.join(os.homedir(), '.ai-focused-editor');
}

/** Absolute path to the credential file. */
export function authStorePath(): string {
  return path.join(authHomeDir(), AUTH_STORE_FILENAME);
}

/** Derive a scrypt credential file from a plaintext password. Never persists the plaintext. */
export function hashPassword(password: string): AuthCredentialFile {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P
  });
  return {
    version: 1,
    kdf: 'scrypt',
    salt: salt.toString('hex'),
    hash: hash.toString('hex'),
    keylen: SCRYPT_KEYLEN,
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P
  };
}

/** Verify a candidate password against a stored scrypt credential, in constant time. */
export function verifyPassword(candidate: string, cred: AuthCredentialFile): boolean {
  if (cred.kdf !== 'scrypt') {
    return false;
  }
  let derived: Buffer;
  try {
    derived = crypto.scryptSync(candidate, Buffer.from(cred.salt, 'hex'), cred.keylen, {
      N: cred.N,
      r: cred.r,
      p: cred.p
    });
  } catch {
    return false;
  }
  const expected = Buffer.from(cred.hash, 'hex');
  if (derived.length !== expected.length) {
    return false;
  }
  return crypto.timingSafeEqual(derived, expected);
}

/** Constant-time comparison of a candidate against a plaintext shared secret (env). */
export function verifySecret(candidate: string, secret: string): boolean {
  const a = Buffer.from(candidate, 'utf8');
  const b = Buffer.from(secret, 'utf8');
  if (a.length !== b.length) {
    // Still perform a comparison against a same-length buffer to avoid trivial
    // length-based timing leaks, then return false.
    const pad = Buffer.alloc(a.length);
    crypto.timingSafeEqual(a, a.length === pad.length ? pad : a);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

/** Read + parse the credential file, or `undefined` when absent/invalid. */
export function readCredentialFile(): AuthCredentialFile | undefined {
  const file = authStorePath();
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<AuthCredentialFile>;
    if (
      parsed &&
      parsed.version === 1 &&
      parsed.kdf === 'scrypt' &&
      typeof parsed.salt === 'string' &&
      typeof parsed.hash === 'string' &&
      typeof parsed.keylen === 'number' &&
      typeof parsed.N === 'number' &&
      typeof parsed.r === 'number' &&
      typeof parsed.p === 'number'
    ) {
      return parsed as AuthCredentialFile;
    }
  } catch {
    /* fallthrough */
  }
  return undefined;
}

/** Persist a credential file (0600) into the auth home dir. Used by the `set-password` CLI. */
export function writeCredentialFile(cred: AuthCredentialFile): void {
  const dir = authHomeDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(authStorePath(), JSON.stringify(cred, undefined, 2), { mode: 0o600 });
}

/** HMAC-SHA256 signature of an opaque session id, hex-encoded. */
export function signSessionId(sessionId: string, serverSecret: Buffer): string {
  return crypto.createHmac('sha256', serverSecret).update(sessionId).digest('hex');
}

/**
 * Build the signed cookie value `<sessionId>.<hmac>` from a fresh random id.
 * Returns both the opaque id (to track server-side) and the cookie value.
 */
export function mintSessionCookie(serverSecret: Buffer): { sessionId: string; cookieValue: string } {
  const sessionId = crypto.randomBytes(24).toString('hex');
  const cookieValue = `${sessionId}.${signSessionId(sessionId, serverSecret)}`;
  return { sessionId, cookieValue };
}

/**
 * Verify a signed cookie value and return the embedded session id when the HMAC
 * checks out (constant-time), or `undefined` otherwise. Callers must still
 * confirm the id is a live, unexpired server-side session.
 */
export function unsignSessionCookie(cookieValue: string, serverSecret: Buffer): string | undefined {
  const dot = cookieValue.lastIndexOf('.');
  if (dot <= 0) {
    return undefined;
  }
  const sessionId = cookieValue.slice(0, dot);
  const providedSig = cookieValue.slice(dot + 1);
  const expectedSig = signSessionId(sessionId, serverSecret);
  const a = Buffer.from(providedSig, 'utf8');
  const b = Buffer.from(expectedSig, 'utf8');
  if (a.length !== b.length) {
    return undefined;
  }
  return crypto.timingSafeEqual(a, b) ? sessionId : undefined;
}

/** Generate a one-time QR token (URL-safe hex). */
export function mintOneTimeToken(): string {
  return crypto.randomBytes(24).toString('hex');
}
