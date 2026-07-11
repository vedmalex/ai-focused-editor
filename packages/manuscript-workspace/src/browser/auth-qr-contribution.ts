// *****************************************************************************
// "Show login QR" command.
//
// Fetches a one-time login URL from the (session-authenticated) `/auth/qr-issue`
// endpoint, renders it as a dependency-free QR image, and shows it in a dialog
// with the URL underneath so a phone on the same network can scan it and get an
// authenticated session. The token is single-use and expires in ~2 minutes.
// *****************************************************************************

import {
  Command,
  CommandContribution,
  CommandRegistry,
  MessageService
} from '@theia/core/lib/common';
import { nls } from '@theia/core/lib/common/nls';
import { AbstractDialog, DialogProps } from '@theia/core/lib/browser/dialogs';
import { inject, injectable } from '@theia/core/shared/inversify';
import { AuthRoutes, type QrIssueResponse } from '../common';
import { encodeQrSvgDataUrl } from './qr-encode';

export namespace AuthQrCommands {
  export const SHOW_LOGIN_QR: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.auth.show-login-qr',
      category: 'AI Focused Editor',
      label: 'Show Login QR…'
    },
    'ai-focused-editor/auth/show-login-qr',
    'ai-focused-editor/auth/category'
  );
}

/** Modal showing the scannable QR image plus the raw login URL. */
class QrLoginDialog extends AbstractDialog<void> {
  constructor(url: string) {
    super({ title: nls.localize('ai-focused-editor/auth/dialog-title', 'Login QR') } as DialogProps);

    const wrap = document.createElement('div');
    wrap.style.display = 'flex';
    wrap.style.flexDirection = 'column';
    wrap.style.alignItems = 'center';
    wrap.style.gap = '12px';
    wrap.style.padding = '8px';
    wrap.style.maxWidth = '320px';

    const img = document.createElement('img');
    img.src = encodeQrSvgDataUrl(url);
    img.alt = nls.localize('ai-focused-editor/auth/qr-alt', 'Login QR code');
    img.style.width = '240px';
    img.style.height = '240px';
    img.style.imageRendering = 'pixelated';
    img.style.background = '#ffffff';
    img.style.padding = '8px';
    img.style.borderRadius = '8px';
    wrap.appendChild(img);

    const hint = document.createElement('div');
    hint.textContent = nls.localize(
      'ai-focused-editor/auth/qr-hint',
      'Scan with a phone on the same network. Single-use, valid ~2 minutes.'
    );
    hint.style.fontSize = '12px';
    hint.style.opacity = '0.75';
    hint.style.textAlign = 'center';
    wrap.appendChild(hint);

    const urlBox = document.createElement('div');
    urlBox.textContent = url;
    urlBox.style.fontFamily = 'var(--theia-code-font-family, monospace)';
    urlBox.style.fontSize = '11px';
    urlBox.style.wordBreak = 'break-all';
    urlBox.style.userSelect = 'all';
    urlBox.style.textAlign = 'center';
    urlBox.style.opacity = '0.9';
    wrap.appendChild(urlBox);

    this.contentNode.appendChild(wrap);
    this.appendCloseButton(nls.localizeByDefault('Close'));
  }

  get value(): void {
    return undefined;
  }
}

@injectable()
export class AuthQrContribution implements CommandContribution {

  @inject(MessageService)
  protected readonly messageService!: MessageService;

  registerCommands(registry: CommandRegistry): void {
    registry.registerCommand(AuthQrCommands.SHOW_LOGIN_QR, {
      execute: () => this.showLoginQr()
    });
  }

  protected async showLoginQr(): Promise<void> {
    let response: Response;
    try {
      response = await fetch(AuthRoutes.qrIssue, {
        method: 'GET',
        credentials: 'same-origin',
        headers: { accept: 'application/json' }
      });
    } catch {
      this.messageService.error(
        nls.localize('ai-focused-editor/auth/error-network', 'Could not reach the auth endpoint.')
      );
      return;
    }

    // 401/403 (session lapsed) or 404 (route absent → gate disabled) both mean
    // "not available for this connection" rather than a hard error.
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      this.messageService.info(
        nls.localize(
          'ai-focused-editor/auth/not-enabled',
          'Login QR is unavailable: authentication is not enabled for this connection.'
        )
      );
      return;
    }
    if (!response.ok) {
      this.messageService.error(
        nls.localize('ai-focused-editor/auth/error-issue', 'Failed to issue a login token.')
      );
      return;
    }

    // When the gate is disabled the request may fall through to Theia's SPA
    // index.html (200, non-JSON). Treat a non-JSON / url-less body as "not enabled".
    let payload: QrIssueResponse | undefined;
    try {
      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('application/json')) {
        payload = (await response.json()) as QrIssueResponse;
      }
    } catch {
      payload = undefined;
    }

    if (!payload?.url) {
      this.messageService.info(
        nls.localize(
          'ai-focused-editor/auth/not-enabled',
          'Login QR is unavailable: authentication is not enabled for this connection.'
        )
      );
      return;
    }

    await new QrLoginDialog(payload.url).open();
  }
}
