import URI from '@theia/core/lib/common/uri';
import {
  open,
  OpenerService
} from '@theia/core/lib/browser';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import {
  inject,
  injectable,
  postConstruct
} from '@theia/core/shared/inversify';
import React from '@theia/core/shared/react';
import {
  CitationEntry,
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
      this.renderCitations(snapshot.citations)
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
      undefined,
      React.createElement('h4', undefined, `Source Files (${items.length})`),
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
      undefined,
      React.createElement('h4', undefined, `Citations (${citations.length})`),
      citations.length === 0
        ? React.createElement('p', undefined, 'No citations found.')
        : React.createElement(
          'ul',
          { className: 'afe-source-library-citations' },
          ...citations.map(citation => React.createElement(
            'li',
            { key: citation.id },
            React.createElement('strong', undefined, citation.title),
            React.createElement('code', undefined, citation.id),
            citation.source ? React.createElement('span', undefined, ` source: ${citation.source}`) : undefined,
            citation.note ? React.createElement('p', undefined, citation.note) : undefined
          ))
        )
    );
  }

  protected async openUri(uri: string): Promise<void> {
    await open(this.openerService, new URI(uri));
  }
}
