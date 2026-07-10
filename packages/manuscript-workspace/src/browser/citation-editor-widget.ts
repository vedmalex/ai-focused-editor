import URI from '@theia/core/lib/common/uri';
import { MessageService } from '@theia/core/lib/common';
import { nls } from '@theia/core/lib/common/nls';
import { Navigatable } from '@theia/core/lib/browser';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import {
  inject,
  injectable
} from '@theia/core/shared/inversify';
import React from '@theia/core/shared/react';
import { Document, isSeq, parseDocument, YAMLSeq } from 'yaml';

/** One editable citation row (mirrors a `sources/citations.yaml` list entry). */
interface CitationRow {
  id: string;
  title: string;
  source: string;
  note: string;
}

/** A validation problem surfaced in the form (blocks Save when `error`). */
interface CitationProblem {
  message: string;
  severity: 'error' | 'warning';
}

const EMPTY_ROW: CitationRow = { id: '', title: '', source: '', note: '' };

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Form-based editor for `sources/citations.yaml` (FR-025 style). The file on
 * disk stays pure YAML: the widget parses through the `yaml` Document API, so
 * the document header, the `version` key, and any sibling keys/comments survive
 * a round-trip — only the `citations` sequence is rewritten from the form rows.
 */
@injectable()
export class CitationEditorWidget extends ReactWidget implements Navigatable {
  static readonly FACTORY_ID = 'ai-focused-editor.citation-editor';
  static readonly LABEL = 'Citations';

  @inject(FileService)
  protected readonly fileService!: FileService;

  @inject(MessageService)
  protected readonly messageService!: MessageService;

  protected uri!: URI;
  protected document: Document | undefined;
  protected rows: CitationRow[] = [];
  protected loading = false;
  protected dirty = false;
  protected parseError: string | undefined;

  configure(uri: URI): void {
    this.uri = uri;
    this.id = `${CitationEditorWidget.FACTORY_ID}:${uri.toString()}`;
    this.title.label = nls.localize('ai-focused-editor/sources/citations-label', 'Citations');
    this.title.caption = nls.localize('ai-focused-editor/sources/citations-caption', 'Citations form: {0}', uri.path.fsPath());
    this.title.iconClass = 'fa fa-quote-right';
    this.title.closable = true;
    this.addClass('afe-citation-editor-widget');
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
    this.parseError = undefined;
    this.update();
    try {
      const content = await this.readTextIfExists(this.uri);
      const document = content !== undefined && content.trim().length > 0
        ? parseDocument(content)
        : new Document({ version: 1, citations: [] });
      this.parseError = document.errors.length > 0
        ? document.errors.map(error => error.message).join('; ')
        : undefined;
      this.document = document;
      this.rows = this.toRows(document.toJS() ?? {});
    } catch (error) {
      this.document = undefined;
      this.rows = [];
      this.parseError = error instanceof Error ? error.message : String(error);
    } finally {
      this.loading = false;
      this.dirty = false;
      this.update();
    }
  }

  protected toRows(value: unknown): CitationRow[] {
    const records = Array.isArray(value)
      ? value
      : isRecord(value) && Array.isArray(value.citations)
        ? value.citations
        : [];
    return records
      .filter(isRecord)
      .map(record => ({
        id: asString(record.id),
        title: asString(record.title),
        source: asString(record.source),
        note: asString(record.note)
      }));
  }

  protected updateRow(index: number, field: keyof CitationRow, value: string): void {
    this.rows = this.rows.map((row, rowIndex) => rowIndex === index ? { ...row, [field]: value } : row);
    this.dirty = true;
    this.update();
  }

  protected addRow(): void {
    this.rows = [...this.rows, { ...EMPTY_ROW }];
    this.dirty = true;
    this.update();
  }

  protected deleteRow(index: number): void {
    this.rows = this.rows.filter((_, rowIndex) => rowIndex !== index);
    this.dirty = true;
    this.update();
  }

  /** Unique, non-empty ids are required; a blank title is a non-blocking warning. */
  protected validate(): CitationProblem[] {
    const problems: CitationProblem[] = [];
    const seen = new Set<string>();
    this.rows.forEach((row, index) => {
      const id = row.id.trim();
      if (!id) {
        problems.push({
          severity: 'error',
          message: nls.localize('ai-focused-editor/sources/row-id-required', 'Row {0}: citation id is required.', index + 1)
        });
      } else if (seen.has(id)) {
        problems.push({
          severity: 'error',
          message: nls.localize('ai-focused-editor/sources/row-id-duplicate', 'Row {0}: duplicate citation id "{1}".', index + 1, id)
        });
      } else {
        seen.add(id);
      }
      if (id && !row.title.trim()) {
        problems.push({
          severity: 'warning',
          message: nls.localize(
            'ai-focused-editor/sources/row-title-recommended',
            'Row {0}: a title is recommended (rows without one are hidden from the Sources view).',
            index + 1
          )
        });
      }
    });
    return problems;
  }

  /**
   * Rewrite the `citations` sequence from the current rows while keeping the
   * document header, the `version` key, and any sibling keys/comments intact.
   */
  protected serialize(): string {
    const document = this.document && this.document.contents != null
      ? this.document
      : new Document({ version: 1, citations: [] });

    let seq: YAMLSeq;
    if (isSeq(document.contents)) {
      seq = document.contents;
    } else {
      const current = document.get('citations');
      if (isSeq(current)) {
        seq = current;
      } else {
        seq = new YAMLSeq();
        document.set('citations', seq);
      }
    }

    seq.items = [];
    for (const row of this.rows) {
      seq.add(document.createNode(this.toEntry(row)));
    }
    return document.toString();
  }

  /** Ordered `{ id, title?, source?, note? }` entry with only non-empty fields. */
  protected toEntry(row: CitationRow): Record<string, string> {
    const entry: Record<string, string> = { id: row.id.trim() };
    const title = row.title.trim();
    if (title) {
      entry.title = title;
    }
    const source = row.source.trim();
    if (source) {
      entry.source = source;
    }
    const note = row.note.trim();
    if (note) {
      entry.note = note;
    }
    return entry;
  }

  protected async save(): Promise<void> {
    const problems = this.validate();
    if (problems.some(problem => problem.severity === 'error')) {
      await this.messageService.error(nls.localize(
        'ai-focused-editor/sources/citations-save-error',
        'Fix citation id problems before saving (ids must be unique and non-empty).'
      ));
      return;
    }
    try {
      const content = this.serialize();
      await this.fileService.write(this.uri, content);
      // Re-read so the in-memory document (and comments) reflect what was written.
      await this.load();
      await this.messageService.info(nls.localize('ai-focused-editor/sources/saved-file', 'Saved {0}.', this.uri.path.base));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.messageService.error(nls.localize('ai-focused-editor/sources/citations-save-failed', 'Could not save citations: {0}', detail));
    }
  }

  protected async readTextIfExists(resource: URI): Promise<string | undefined> {
    try {
      return (await this.fileService.read(resource)).value;
    } catch {
      return undefined;
    }
  }

  protected render(): React.ReactNode {
    if (this.loading || !this.uri) {
      return React.createElement(
        'div',
        { className: 'afe-citation-editor' },
        nls.localize('ai-focused-editor/sources/citations-loading', 'Loading citations...')
      );
    }

    const problems = this.validate();
    return React.createElement(
      'div',
      { className: 'afe-citation-editor' },
      React.createElement(
        'div',
        { className: 'afe-citation-editor-header' },
        React.createElement('h3', undefined, nls.localize('ai-focused-editor/sources/citations-label', 'Citations')),
        React.createElement('span', { className: 'afe-citation-editor-count' }, `${this.rows.length}`)
      ),
      this.parseError
        ? React.createElement(
          'div',
          { className: 'afe-citation-editor-problem error' },
          nls.localize('ai-focused-editor/sources/citations-parse-warning', 'YAML parse warning: {0}', this.parseError)
        )
        : undefined,
      this.renderProblems(problems),
      this.rows.length === 0
        ? React.createElement('p', { className: 'afe-citation-editor-empty' }, nls.localize('ai-focused-editor/sources/citations-empty', 'No citations yet. Add one below.'))
        : React.createElement(
          'ul',
          { className: 'afe-citation-editor-rows' },
          ...this.rows.map((row, index) => this.renderRow(row, index))
        ),
      React.createElement(
        'div',
        { className: 'afe-citation-editor-actions' },
        React.createElement(
          'button',
          { className: 'theia-button secondary', type: 'button', onClick: () => this.addRow() },
          nls.localize('ai-focused-editor/sources/add-citation', 'Add citation')
        ),
        React.createElement(
          'button',
          { className: 'theia-button main', type: 'button', onClick: () => { void this.save(); } },
          this.dirty
            ? nls.localize('ai-focused-editor/sources/save-dirty', 'Save*')
            : nls.localize('ai-focused-editor/sources/save', 'Save')
        ),
        React.createElement(
          'button',
          { className: 'theia-button secondary', type: 'button', onClick: () => { void this.load(); } },
          nls.localize('ai-focused-editor/sources/reload-from-disk', 'Reload from disk')
        )
      ),
      React.createElement(
        'p',
        { className: 'afe-citation-editor-help' },
        nls.localize(
          'ai-focused-editor/sources/citations-help',
          'Saving writes pure YAML and preserves the file header, the version key, and comments. Use "Open With..." to edit the raw file.'
        )
      )
    );
  }

  protected renderProblems(problems: CitationProblem[]): React.ReactNode {
    if (problems.length === 0) {
      return undefined;
    }
    return React.createElement(
      'ul',
      { className: 'afe-citation-editor-problems' },
      ...problems.map((problem, index) => React.createElement(
        'li',
        { key: index, className: `afe-citation-editor-problem ${problem.severity}` },
        problem.message
      ))
    );
  }

  protected renderRow(row: CitationRow, index: number): React.ReactNode {
    return React.createElement(
      'li',
      { key: index, className: 'afe-citation-editor-row' },
      React.createElement(
        'div',
        { className: 'afe-citation-editor-row-head' },
        this.renderInput(
          nls.localize('ai-focused-editor/sources/field-id-label', 'Id'),
          row, index, 'id',
          nls.localize('ai-focused-editor/sources/field-id-placeholder', 'stable slug, e.g. bg-2-47')
        ),
        React.createElement(
          'button',
          {
            className: 'theia-button secondary afe-citation-editor-delete',
            type: 'button',
            title: nls.localize('ai-focused-editor/sources/delete-citation-title', 'Delete this citation'),
            onClick: () => this.deleteRow(index)
          },
          nls.localize('ai-focused-editor/sources/delete-button', 'Delete')
        )
      ),
      this.renderInput(
        nls.localize('ai-focused-editor/sources/field-title-label', 'Title'),
        row, index, 'title',
        nls.localize('ai-focused-editor/sources/field-title-placeholder', 'display title')
      ),
      this.renderInput(
        nls.localize('ai-focused-editor/sources/field-source-label', 'Source'),
        row, index, 'source',
        nls.localize('ai-focused-editor/sources/field-source-placeholder', 'workspace-relative source path or reference')
      ),
      this.renderTextarea(
        nls.localize('ai-focused-editor/sources/field-note-label', 'Note'),
        row, index, 'note',
        nls.localize('ai-focused-editor/sources/citation-note-placeholder', 'free-form note')
      )
    );
  }

  protected renderInput(label: string, row: CitationRow, index: number, field: keyof CitationRow, placeholder: string): React.ReactNode {
    return React.createElement(
      'label',
      { className: 'afe-citation-editor-field' },
      React.createElement('span', undefined, label),
      React.createElement('input', {
        value: row[field],
        placeholder,
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => this.updateRow(index, field, event.currentTarget.value)
      })
    );
  }

  protected renderTextarea(label: string, row: CitationRow, index: number, field: keyof CitationRow, placeholder: string): React.ReactNode {
    return React.createElement(
      'label',
      { className: 'afe-citation-editor-field' },
      React.createElement('span', undefined, label),
      React.createElement('textarea', {
        value: row[field],
        placeholder,
        rows: 2,
        onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => this.updateRow(index, field, event.currentTarget.value)
      })
    );
  }
}
