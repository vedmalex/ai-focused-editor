// *****************************************************************************
// The optional shared-secret browser-auth gate.
//
// Wiring (all hooks verified against @theia/core 1.73.1 in this repo):
//  - HTTP:   an Express Router pushed into `EarlyExpressMiddleware.handlers`
//            during `initialize()`. Core applies those handlers at the very
//            start of `configure()`, BEFORE the gzip/static file handlers and
//            before the RPC endpoints — so an unauthenticated peer never
//            receives the app shell.
//  - WS/RPC: a `WsRequestValidatorContribution.allowWsUpgrade(request)` — core's
//            `WebsocketEndpoint` runs every bound validator inside Socket.IO's
//            `allowRequest` handshake callback and rejects the upgrade on the
//            first `false`. HTTP-only gating would be a hole; this closes it.
// *****************************************************************************

import * as http from 'http';
import * as express from '@theia/core/shared/express';
import { inject, injectable } from '@theia/core/shared/inversify';
import { BackendApplicationContribution, EarlyExpressMiddleware } from '@theia/core/lib/node';
import { WsRequestValidatorContribution } from '@theia/core/lib/node/ws-request-validators';
import { AuthRoutes, SESSION_COOKIE } from '../common/browser-auth-protocol';
import { BrowserAuthConfiguration } from './browser-auth-configuration';
import { parseCookies, shouldGateConnection } from './browser-auth-gate';
import { LOGIN_PAGE_CSS, renderLoginPage } from './browser-auth-login-page';

const LOG_PREFIX = '[browser-auth]';

@injectable()
export class BrowserAuthService
  implements BackendApplicationContribution, WsRequestValidatorContribution {

  @inject(BrowserAuthConfiguration)
  protected readonly config!: BrowserAuthConfiguration;

  @inject(EarlyExpressMiddleware)
  protected readonly earlyMiddleware!: EarlyExpressMiddleware;

  initialize(): void {
    this.config.resolve();

    if (this.config.isElectron()) {
      // The Electron backend is only reachable through the Electron shell,
      // which carries its own security token — never gate it.
      return;
    }

    if (this.config.isForcedButUnconfigured()) {
      // `--auth` with no secret/hash would lock everyone out. Fail OPEN with a
      // loud warning rather than bricking the app.
      // eslint-disable-next-line no-console
      console.warn(
        `${LOG_PREFIX} --auth was passed but no credential is configured ` +
        `(set ${'AI_FOCUSED_EDITOR_AUTH_SECRET'} or run the set-password CLI). Auth stays DISABLED.`
      );
    }

    if (this.config.isEnabled()) {
      // eslint-disable-next-line no-console
      console.info(
        `${LOG_PREFIX} enabled — remote connections require a session; ` +
        `localhost is ${this.config.isForceEnabled() ? 'ALSO gated (--auth)' : 'open (frictionless)'}.`
      );
    }

    // Registered even while currently disabled: the router's first middleware
    // exits immediately (`next('router')`) whenever the gate is off, so this is
    // a no-op until a credential is configured.
    this.earlyMiddleware.handlers.push(this.createRouter());
  }

  /** Build the auth Express Router (public login/QR routes + the catch-all gate). */
  protected createRouter(): express.RequestHandler {
    const router = express.Router();

    // Short-circuit the whole router when the gate is disabled.
    router.use((_req, _res, next) => {
      if (this.config.isEnabled()) {
        next();
      } else {
        next('router');
      }
    });

    router.get(AuthRoutes.loginStyle, (_req, res) => {
      res.type('text/css').send(LOGIN_PAGE_CSS);
    });

    router.get(AuthRoutes.login, (_req, res) => {
      res.status(200).type('html').send(renderLoginPage());
    });

    router.post(
      AuthRoutes.login,
      express.urlencoded({ extended: false, limit: '4kb' }),
      (req, res) => {
        const password = typeof req.body?.password === 'string' ? req.body.password : '';
        if (this.config.verifyCredential(password)) {
          this.setSessionCookie(req, res);
          res.redirect(302, '/');
          return;
        }
        res.status(401).type('html').send(renderLoginPage({ error: true }));
      }
    );

    // Consume a one-time QR token → set the session cookie → redirect to the app.
    router.get(AuthRoutes.qrLogin, (req, res) => {
      const token = typeof req.query.token === 'string' ? req.query.token : undefined;
      if (this.config.consumeOneTimeToken(token)) {
        this.setSessionCookie(req, res);
        res.redirect(302, '/');
        return;
      }
      res.status(401).type('html').send(renderLoginPage({ error: true }));
    });

    // Session-authenticated: mint a one-time QR-login URL for the phone.
    router.get(AuthRoutes.qrIssue, (req, res) => {
      if (!this.isRequestAuthenticated(req)) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      const token = this.config.issueOneTimeToken();
      const url = this.absoluteUrl(req, `${AuthRoutes.qrLogin}?token=${encodeURIComponent(token)}`);
      res.json({ url, expiresIn: 120 });
    });

    // Catch-all gate for every other request.
    router.use((req, res, next) => {
      if (this.isRequestAuthenticated(req)) {
        next();
        return;
      }
      if (this.isNavigation(req)) {
        res.status(200).type('html').send(renderLoginPage());
      } else {
        res.status(401).json({ error: 'unauthorized' });
      }
    });

    return router;
  }

  // --- WsRequestValidatorContribution -------------------------------------

  allowWsUpgrade(request: http.IncomingMessage): boolean {
    if (!this.config.isEnabled()) {
      return true;
    }
    const gated = shouldGateConnection({
      enabled: true,
      forceEnabled: this.config.isForceEnabled(),
      remoteAddress: request.socket?.remoteAddress
    });
    if (!gated) {
      return true;
    }
    const cookies = parseCookies(request.headers.cookie);
    return this.config.validateCookie(cookies[SESSION_COOKIE]);
  }

  // --- helpers -------------------------------------------------------------

  /**
   * A request is authenticated when the connection is not gated (trusted
   * loopback) OR carries a valid session cookie.
   */
  protected isRequestAuthenticated(req: express.Request): boolean {
    const gated = shouldGateConnection({
      enabled: this.config.isEnabled(),
      forceEnabled: this.config.isForceEnabled(),
      remoteAddress: req.socket?.remoteAddress
    });
    if (!gated) {
      return true;
    }
    const cookies = parseCookies(req.headers.cookie);
    return this.config.validateCookie(cookies[SESSION_COOKIE]);
  }

  protected setSessionCookie(req: express.Request, res: express.Response): void {
    res.cookie(SESSION_COOKIE, this.config.createSession(), {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure: this.isHttps(req),
      maxAge: this.config.ttl() * 1000
    });
  }

  protected isHttps(req: express.Request): boolean {
    const proto = req.headers['x-forwarded-proto'];
    if (typeof proto === 'string' && proto.split(',')[0].trim() === 'https') {
      return true;
    }
    return req.secure === true;
  }

  protected absoluteUrl(req: express.Request, pathAndQuery: string): string {
    const proto = this.isHttps(req) ? 'https' : 'http';
    const host = req.headers.host ?? `localhost`;
    return `${proto}://${host}${pathAndQuery}`;
  }

  /** Treat an HTML GET (browser navigation) as one that should receive the login page. */
  protected isNavigation(req: express.Request): boolean {
    if (req.method !== 'GET') {
      return false;
    }
    const mode = req.headers['sec-fetch-mode'];
    if (typeof mode === 'string' && mode === 'navigate') {
      return true;
    }
    const accept = req.headers.accept;
    return typeof accept === 'string' && accept.includes('text/html');
  }
}
