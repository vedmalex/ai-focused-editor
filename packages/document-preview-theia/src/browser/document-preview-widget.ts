import DOMPurify from 'dompurify';
import URI from '@theia/core/lib/common/uri';
import { MessageService } from '@theia/core/lib/common';
import { Navigatable } from '@theia/core/lib/browser';
import { EditorManager } from '@theia/editor/lib/browser/editor-manager';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { nls } from '@theia/core/lib/common/nls';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { inject, injectable } from '@theia/core/shared/inversify';
import React from '@theia/core/shared/react';
import {
  DocumentPreviewResult,
  DocumentPreviewService,
  documentPreviewExtension
} from '../common';

/**
 * Read-only form-style preview for office documents (docx/xlsx/xls/ods/pptx and
 * the legacy binary .doc/.ppt, which render a friendly "unsupported" card
 * instead of binary garbage in Monaco).
 *
 * The heavy parsing happens in the node {@link DocumentPreviewService}; the widget
 * only renders the returned payload. All HTML the backend produces (mammoth's
 * docx output, assembled sheet tables, slide run lists) is sanitized with
 * DOMPurify before it is injected — the office parsers are third-party and their
 * output is never trusted verbatim.
 */
@injectable()
export class DocumentPreviewWidget extends ReactWidget implements Navigatable {
  /** Historical factory id kept verbatim so saved layouts keep restoring. */
  static readonly FACTORY_ID = 'ai-focused-editor.office-preview';

  @inject(DocumentPreviewService)
  protected readonly documentPreviewService!: DocumentPreviewService;

  @inject(WorkspaceService)
  protected readonly workspaceService!: WorkspaceService;

  @inject(MessageService)
  protected readonly messageService!: MessageService;

  @inject(EditorManager)
  protected readonly editorManager!: EditorManager;

  protected uri!: URI;
  protected loading = false;
  protected error: string | undefined;
  protected result: DocumentPreviewResult | undefined;
  /** Index of the active worksheet tab (spreadsheets only). */
  protected activeSheet = 0;

  configure(uri: URI): void {
    this.uri = uri;
    this.id = `${DocumentPreviewWidget.FACTORY_ID}:${uri.toString()}`;
    this.title.label = uri.path.base;
    this.title.caption = nls.localize('ai-focused-editor/office/caption', 'Office preview: {0}', uri.path.fsPath());
    this.title.iconClass = 'codicon codicon-preview';
    this.title.closable = true;
    this.addClass('afe-office-preview-widget');
    void this.load();
  }

  getResourceUri(): URI | undefined {
    return this.uri;
  }

  createMoveToUri(resourceUri: URI): URI | undefined {
    return resourceUri;
  }

  protected async load(): Promise<void> {
    this.loading = true;
    this.error = undefined;
    this.update();
    try {
      const root = await this.getRootUri();
      if (!root) {
        this.error = nls.localize('ai-focused-editor/office/no-workspace', 'Open a manuscript workspace to preview this document.');
        return;
      }
      const path = this.workspaceRelativePath(root);
      this.result = await this.documentPreviewService.convertOfficeDocument(root.toString(), path);
      this.activeSheet = 0;
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.loading = false;
      this.update();
    }
  }

  protected async getRootUri(): Promise<URI | undefined> {
    await this.workspaceService.ready;
    const root = this.workspaceService.tryGetRoots()[0] ?? (await this.workspaceService.roots)[0];
    return root?.resource;
  }

  protected workspaceRelativePath(root: URI): string {
    const relative = root.relative(this.uri);
    return relative ? relative.toString() : this.uri.path.toString();
  }

  /** Open the raw file in the text editor via "Open With..." semantics. */
  protected async openAsText(): Promise<void> {
    try {
      await this.editorManager.open(this.uri);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.messageService.error(nls.localize('ai-focused-editor/office/open-text-failed', 'Could not open as text: {0}', detail));
    }
  }

  /** Sanitize third-party office HTML before it is injected into the DOM. */
  protected sanitize(html: string): string {
    return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
  }

  protected render(): React.ReactNode {
    if (this.loading || !this.uri) {
      return React.createElement('div', { className: 'afe-office-preview' },
        nls.localize('ai-focused-editor/office/loading', 'Loading preview...'));
    }
    return React.createElement(
      'div',
      { className: 'afe-office-preview' },
      this.renderHeader(),
      this.error
        ? React.createElement('div', { className: 'afe-office-preview-problem error' },
          nls.localize('ai-focused-editor/office/error', 'Could not build preview: {0}', this.error))
        : undefined,
      this.renderWarnings(),
      this.renderBody()
    );
  }

  protected renderHeader(): React.ReactNode {
    return React.createElement(
      'div',
      { className: 'afe-office-preview-header' },
      React.createElement('span', { className: 'afe-office-preview-title' }, this.uri.path.base),
      React.createElement('span', { className: 'afe-office-preview-ext' }, documentPreviewExtension(this.uri.path.base).replace('.', '').toUpperCase()),
      React.createElement(
        'button',
        {
          className: 'theia-button secondary afe-office-preview-open-text',
          type: 'button',
          onClick: () => { void this.openAsText(); }
        },
        nls.localize('ai-focused-editor/office/open-as-text', 'Open as text')
      ),
      React.createElement(
        'button',
        {
          className: 'theia-button secondary',
          type: 'button',
          onClick: () => { void this.load(); }
        },
        nls.localize('ai-focused-editor/office/reload', 'Reload')
      )
    );
  }

  protected renderWarnings(): React.ReactNode {
    const warnings = this.result?.warnings ?? [];
    if (warnings.length === 0) {
      return undefined;
    }
    return React.createElement(
      'ul',
      { className: 'afe-office-preview-warnings' },
      ...warnings.map((warning, index) => React.createElement('li', { key: index }, warning))
    );
  }

  protected renderBody(): React.ReactNode {
    const result = this.result;
    if (!result) {
      return undefined;
    }
    switch (result.kind) {
      case 'html':
        return this.renderHtml(result.html ?? '');
      case 'sheets':
        return this.renderSheets(result);
      case 'slides':
        return this.renderSlides(result);
      case 'unsupported':
      default:
        return this.renderUnsupported();
    }
  }

  protected renderHtml(html: string): React.ReactNode {
    return React.createElement('div', {
      className: 'afe-office-preview-doc',
      dangerouslySetInnerHTML: { __html: this.sanitize(html) }
    });
  }

  protected renderSheets(result: DocumentPreviewResult): React.ReactNode {
    const sheets = result.sheets ?? [];
    if (sheets.length === 0) {
      return React.createElement('div', { className: 'afe-office-preview-empty' },
        nls.localize('ai-focused-editor/office/no-sheets', 'This workbook has no worksheets.'));
    }
    const active = Math.min(this.activeSheet, sheets.length - 1);
    const tabs = React.createElement(
      'div',
      { className: 'afe-office-sheet-tabs', role: 'tablist' },
      ...sheets.map((sheet, index) => React.createElement(
        'button',
        {
          key: index,
          role: 'tab',
          'aria-selected': index === active,
          className: `afe-office-sheet-tab${index === active ? ' active' : ''}`,
          onClick: () => { this.activeSheet = index; this.update(); }
        },
        sheet.truncated
          ? `${sheet.name} ${nls.localize('ai-focused-editor/office/truncated-badge', '(truncated)')}`
          : sheet.name
      ))
    );
    const current = sheets[active];
    const table = React.createElement('div', {
      className: 'afe-office-sheet-body',
      dangerouslySetInnerHTML: { __html: this.sanitize(current.html) }
    });
    return React.createElement('div', { className: 'afe-office-sheets' }, tabs, table);
  }

  protected renderSlides(result: DocumentPreviewResult): React.ReactNode {
    const slides = result.slides ?? [];
    if (slides.length === 0) {
      return React.createElement('div', { className: 'afe-office-preview-empty' },
        nls.localize('ai-focused-editor/office/no-slides', 'No slides were found in this presentation.'));
    }
    return React.createElement(
      'div',
      { className: 'afe-office-slides' },
      ...slides.map(slide => React.createElement(
        'section',
        { key: slide.index, className: 'afe-office-slide-card' },
        React.createElement(
          'div',
          { className: 'afe-office-slide-number' },
          nls.localize('ai-focused-editor/office/slide-number', 'Slide {0}', slide.index)
        ),
        slide.title
          ? React.createElement('h3', { className: 'afe-office-slide-title' }, slide.title)
          : undefined,
        React.createElement('div', {
          className: 'afe-office-slide-content',
          dangerouslySetInnerHTML: { __html: this.sanitize(slide.html) }
        })
      ))
    );
  }

  protected renderUnsupported(): React.ReactNode {
    return React.createElement(
      'div',
      { className: 'afe-office-preview-unsupported' },
      React.createElement('span', { className: 'codicon codicon-file-binary afe-office-preview-unsupported-icon' }),
      React.createElement('p', undefined,
        nls.localize('ai-focused-editor/office/unsupported', 'This document cannot be previewed.')),
      React.createElement(
        'button',
        {
          className: 'theia-button main',
          type: 'button',
          onClick: () => { void this.openAsText(); }
        },
        nls.localize('ai-focused-editor/office/open-as-text', 'Open as text')
      )
    );
  }
}

/** @deprecated Use {@link DocumentPreviewWidget}. */
export const OfficePreviewWidget = DocumentPreviewWidget;
/** @deprecated Use {@link DocumentPreviewWidget}. */
export type OfficePreviewWidget = DocumentPreviewWidget;
