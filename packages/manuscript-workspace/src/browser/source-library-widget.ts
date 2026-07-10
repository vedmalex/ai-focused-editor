import URI from '@theia/core/lib/common/uri';
import {
  open,
  OpenerService
} from '@theia/core/lib/browser';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { EditorOpenerOptions } from '@theia/editor/lib/browser/editor-manager';
import {
  inject,
  injectable,
  postConstruct
} from '@theia/core/shared/inversify';
import React from '@theia/core/shared/react';
import {
  CitationEntry,
  SourceExcerpt,
  SourceLibraryItem,
  SourceLibraryService,
  SourceLibrarySnapshot
} from '../common';

@injectable()
export class SourceLibraryWidget extends ReactWidget {
  static readonly ID = 'ai-focused-editor.sources';
  static readonly LABEL = 'Sources';

  @inject(SourceLibraryService)
  protected readonly sourceLibrary!: SourceLibraryService;

  @inject(OpenerService)
  protected readonly openerService!: OpenerService;

  protected snapshot: SourceLibrarySnapshot | undefined;

  @postConstruct()
  protected init(): void {
    this.id = SourceLibraryWidget.ID;
    this.title.label = SourceLibraryWidget.LABEL;
    this.title.caption = 'AI Focused Editor source library and citations';
    this.title.iconClass = 'fa fa-archive';
    this.title.closable = true;
    this.addClass('afe-source-library-widget');
    void this.refresh();
  }

  async refresh(): Promise<void> {
    this.snapshot = await this.sourceLibrary.refresh();
    this.update();
  }

  protected render(): React.ReactNode {
    const snapshot = this.snapshot;
    if (!snapshot) {
      return React.createElement('div', { className: 'afe-source-library' }, 'Loading sources...');
    }

    return React.createElement(
      'div',
      { className: 'afe-source-library' },
      React.createElement(
        'div',
        { className: 'afe-source-library-header' },
        React.createElement('h3', undefined, 'Sources'),
        React.createElement('button', { className: 'theia-button', onClick: () => this.refresh() }, 'Refresh')
      ),
      this.renderDiagnostics(snapshot),
      this.renderItems(snapshot.items),
      this.renderCitations(snapshot.citations),
      this.renderExcerpts(snapshot.excerpts)
    );
  }

  protected renderDiagnostics(snapshot: SourceLibrarySnapshot): React.ReactNode {
    if (snapshot.diagnostics.length === 0) {
      return undefined;
    }
    return React.createElement(
      'ul',
      { className: 'afe-source-library-diagnostics' },
      ...snapshot.diagnostics.map((diagnostic, index) => React.createElement(
        'li',
        { key: `${diagnostic.source}-${index}` },
        `${diagnostic.severity}: ${diagnostic.message}`
      ))
    );
  }

  protected renderItems(items: SourceLibraryItem[]): React.ReactNode {
    return React.createElement(
      'section',
      { className: 'afe-source-library-section' },
      React.createElement('h4', undefined, `Files (${items.length})`),
      items.length === 0
        ? React.createElement('p', undefined, 'No source files found.')
        : React.createElement(
          'ul',
          { className: 'afe-source-library-items' },
          ...items.map(item => React.createElement(
            'li',
            { key: item.uri },
            React.createElement('span', undefined, `${item.type}: ${item.path}`),
            React.createElement('button', { className: 'theia-button', onClick: () => this.openUri(item.uri) }, 'Open')
          ))
        )
    );
  }

  protected renderCitations(citations: CitationEntry[]): React.ReactNode {
    return React.createElement(
      'section',
      { className: 'afe-source-library-section' },
      React.createElement('h4', undefined, `Citations (${citations.length})`),
      citations.length === 0
        ? React.createElement('p', undefined, 'No citations found.')
        : React.createElement(
          'ul',
          { className: 'afe-source-library-citations' },
          ...citations.map(citation => this.renderCitation(citation))
        )
    );
  }

  protected renderCitation(citation: CitationEntry): React.ReactNode {
    const title = citation.path
      ? React.createElement(
        'a',
        {
          className: 'afe-source-library-link',
          href: '#',
          title: `Open ${citation.path}`,
          onClick: (event: React.MouseEvent) => {
            event.preventDefault();
            void this.openWorkspacePath(citation.path!);
          }
        },
        citation.title
      )
      : React.createElement('strong', undefined, citation.title);

    return React.createElement(
      'li',
      { key: citation.id },
      title,
      React.createElement('code', undefined, citation.id),
      citation.source ? React.createElement('span', undefined, ` source: ${citation.source}`) : undefined,
      citation.note ? React.createElement('p', undefined, citation.note) : undefined
    );
  }

  protected renderExcerpts(excerpts: SourceExcerpt[]): React.ReactNode {
    return React.createElement(
      'section',
      { className: 'afe-source-library-section' },
      React.createElement('h4', undefined, `Excerpts (${excerpts.length})`),
      excerpts.length === 0
        ? React.createElement('p', undefined, 'No excerpts indexed.')
        : React.createElement(
          'ul',
          { className: 'afe-source-library-excerpts' },
          ...excerpts.map(excerpt => this.renderExcerpt(excerpt))
        )
    );
  }

  protected renderExcerpt(excerpt: SourceExcerpt): React.ReactNode {
    const sourceLabel = excerpt.sourcePath || excerpt.sourceId;
    const body = excerpt.targetPath
      ? React.createElement(
        'a',
        {
          className: 'afe-source-library-link',
          href: '#',
          title: `Open ${excerpt.targetPath}${excerpt.targetLine ? `:${excerpt.targetLine}` : ''}`,
          onClick: (event: React.MouseEvent) => {
            event.preventDefault();
            void this.openWorkspacePath(excerpt.targetPath!, excerpt.targetLine);
          }
        },
        excerpt.text
      )
      : React.createElement('span', { className: 'afe-source-library-excerpt-text' }, excerpt.text);

    return React.createElement(
      'li',
      { key: excerpt.id },
      body,
      sourceLabel
        ? React.createElement('span', { className: 'afe-source-library-excerpt-source' }, ` — ${sourceLabel}`)
        : undefined,
      excerpt.note ? React.createElement('p', undefined, excerpt.note) : undefined
    );
  }

  protected async openUri(uri: string): Promise<void> {
    await open(this.openerService, new URI(uri));
  }

  /**
   * Open a workspace-relative path, optionally revealing a 1-based line.
   * Excerpts and citations link source facts back to manuscript text (spec §5.4).
   */
  protected async openWorkspacePath(path: string, line?: number): Promise<void> {
    const rootUri = this.snapshot?.rootUri;
    if (!rootUri) {
      return;
    }
    const uri = new URI(rootUri).resolve(path);
    const options: EditorOpenerOptions | undefined = line && line > 0
      ? { selection: this.toLineSelection(line) }
      : undefined;
    await open(this.openerService, uri, options);
  }

  protected toLineSelection(line: number): EditorOpenerOptions['selection'] {
    const zeroBased = Math.max(0, line - 1);
    return {
      start: { line: zeroBased, character: 0 },
      end: { line: zeroBased, character: 0 }
    };
  }
}
