// *****************************************************************************
// Injectable singleton holding the resolved auth configuration + the in-memory
// session and one-time-token stores. One instance is shared by BOTH the HTTP
// middleware and the WebSocket-upgrade validator so a session minted over HTTP
// is honoured on the RPC socket.
// *****************************************************************************

import * as crypto from 'crypto';
import { injectable } from '@theia/core/shared/inversify';
import {
  AUTH_SECRET_ENV,
  AUTH_TTL_ENV,
  DEFAULT_SESSION_TTL_SECONDS,
  QR_TOKEN_TTL_SECONDS,
  THEIA_ELECTRON_ENV,
  type AuthCredentialFile
} from '../common/browser-auth-protocol';
import {
  mintOneTimeToken,
  mintSessionCookie,
  readCredentialFile,
  unsignSessionCookie,
  verifyPassword,
  verifySecret
} from './browser-auth-crypto';

@injectable()
export class BrowserAuthConfiguration {
  /** Force the gate on even for loopback peers (set by the `--auth` CLI flag). */
  private forceEnabled = false;

  /** Per-process HMAC secret for signing session cookies. Rotating it on restart invalidates old sessions. */
  private readonly serverSecret = crypto.randomBytes(32);

  private secret: string | undefined;
  private credential: AuthCredentialFile | undefined;
  private ttlSeconds = DEFAULT_SESSION_TTL_SECONDS;
  private resolved = false;

  /** sessionId → expiry epoch ms. */
  private readonly sessions = new Map<string, number>();
  /** one-time token → expiry epoch ms. */
  private readonly oneTimeTokens = new Map<string, number>();

  /** Set by the CLI contribution's `setArguments`, before `initialize()` runs. */
  setForceEnabled(force: boolean): void {
    this.forceEnabled = force;
  }

  isForceEnabled(): boolean {
    return this.forceEnabled;
  }

  /** The Electron backend never gates — detected via Theia's forked-backend env marker. */
  isElectron(): boolean {
    const v = process.env[THEIA_ELECTRON_ENV];
    return typeof v === 'string' && v.length > 0;
  }

  /** Resolve env + credential file exactly once. Idempotent. */
  resolve(): void {
    if (this.resolved) {
      return;
    }
    this.resolved = true;
    const envSecret = process.env[AUTH_SECRET_ENV];
    this.secret = envSecret && envSecret.length > 0 ? envSecret : undefined;
    this.credential = readCredentialFile();
    const ttlRaw = process.env[AUTH_TTL_ENV];
    if (ttlRaw) {
      const parsed = Number.parseInt(ttlRaw, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        this.ttlSeconds = parsed;
      }
    }
  }

  /** True when a credential (env secret and/or hashed file) is configured. */
  hasCredential(): boolean {
    this.resolve();
    return this.secret !== undefined || this.credential !== undefined;
  }

  /**
   * The gate is enabled only when NOT electron AND a credential is configured.
   * The `--auth` flag alone cannot enable the gate (that would lock everyone
   * out with nothing to authenticate against); it only forces loopback gating.
   */
  isEnabled(): boolean {
    if (this.isElectron()) {
      return false;
    }
    return this.hasCredential();
  }

  /** `--auth` was passed but no secret/hash exists — a misconfiguration worth warning about. */
  isForcedButUnconfigured(): boolean {
    return !this.isElectron() && this.forceEnabled && !this.hasCredential();
  }

  /** Verify a candidate password/token against the env secret and/or the hashed file. */
  verifyCredential(candidate: string): boolean {
    this.resolve();
    if (typeof candidate !== 'string' || candidate.length === 0) {
      return false;
    }
    let ok = false;
    if (this.secret !== undefined && verifySecret(candidate, this.secret)) {
      ok = true;
    }
    if (this.credential !== undefined && verifyPassword(candidate, this.credential)) {
      ok = true;
    }
    return ok;
  }

  /** Mint a fresh session; returns the signed cookie value to set. */
  createSession(): string {
    const { sessionId, cookieValue } = mintSessionCookie(this.serverSecret);
    this.sessions.set(sessionId, Date.now() + this.ttlSeconds * 1000);
    return cookieValue;
  }

  /** True when the signed cookie maps to a live, unexpired server-side session. */
  validateCookie(cookieValue: string | undefined): boolean {
    if (!cookieValue) {
      return false;
    }
    const sessionId = unsignSessionCookie(cookieValue, this.serverSecret);
    if (!sessionId) {
      return false;
    }
    const expiry = this.sessions.get(sessionId);
    if (expiry === undefined) {
      return false;
    }
    if (Date.now() > expiry) {
      this.sessions.delete(sessionId);
      return false;
    }
    return true;
  }

  /** Issue a single-use, short-lived QR-login token. */
  issueOneTimeToken(): string {
    this.pruneTokens();
    const token = mintOneTimeToken();
    this.oneTimeTokens.set(token, Date.now() + QR_TOKEN_TTL_SECONDS * 1000);
    return token;
  }

  /** Consume a QR-login token: returns true exactly once for a valid, unexpired token. */
  consumeOneTimeToken(token: string | undefined): boolean {
    if (!token) {
      return false;
    }
    const expiry = this.oneTimeTokens.get(token);
    if (expiry === undefined) {
      return false;
    }
    this.oneTimeTokens.delete(token);
    return Date.now() <= expiry;
  }

  ttl(): number {
    this.resolve();
    return this.ttlSeconds;
  }

  private pruneTokens(): void {
    const now = Date.now();
    for (const [token, expiry] of this.oneTimeTokens) {
      if (now > expiry) {
        this.oneTimeTokens.delete(token);
      }
    }
  }
}
