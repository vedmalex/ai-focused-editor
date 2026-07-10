import URI from '@theia/core/lib/common/uri';
import { MessageService } from '@theia/core/lib/common';
import { Navigatable } from '@theia/core/lib/browser';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import {
  inject,
  injectable
} from '@theia/core/shared/inversify';
import React from '@theia/core/shared/react';
import { Document, isMap, isSeq, parseDocument, YAMLSeq } from 'yaml';
import {
  flattenManifestRows,
  includeFlagToYaml,
  normalizeManifestPath,
  validateManifestRows,
  type FormProblem,
  type ManifestRow
} from '../common/book-config-forms';

interface RowBaseline {
  title: string;
  include: boolean;
}

/**
 * Form-based editor for the workspace-root `manifest.yaml` (Wave-8). Presents
 * the content tree as an indented list: titles are editable and the build
 * `include` flag is a checkbox. Reordering, moves, and adding chapters stay in
 * the manuscript navigator tree (backend mutations own ordering) — this form
 * only edits titles and inclusion. Save applies through the `yaml` Document API
 * so comments and entry order survive a round-trip.
 */
@injectable()
export class ManifestEditorWidget extends ReactWidget implements Navigatable {
  static readonly FACTORY_ID = 'ai-focused-editor.manifest-editor';
  static readonly LABEL = 'Manifest';

  @inject(FileService)
  protected readonly fileService!: FileService;

  @inject(MessageService)
  protected readonly messageService!: MessageService;

  protected uri!: URI;
  protected document: Document | undefined;
  protected rows: ManifestRow[] = [];
  protected baseline = new Map<string, RowBaseline>();
  protected loading = false;
  protected dirty = false;
  protected parseError: string | undefined;

  configure(uri: URI): void {
    this.uri = uri;
    this.id = `${ManifestEditorWidget.FACTORY_ID}:${uri.toString()}`;
    this.title.label = ManifestEditorWidget.LABEL;
    this.title.caption = `Manifest form: ${uri.path.fsPath()}`;
    this.title.iconClass = 'fa fa-list-ol';
    this.title.closable = true;
    this.addClass('afe-form-editor-widget');
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
        : new Document({ version: 1, content: [] });
      this.parseError = document.errors.length > 0
        ? document.errors.map(error => error.message).join('; ')
        : undefined;
      this.document = document;
      this.rows = flattenManifestRows(document.toJS() ?? {});
      this.baseline = new Map(
        this.rows.map(row => [normalizeManifestPath(row.path), { title: row.title, include: row.include }])
      );
    } catch (error) {
      this.document = undefined;
      this.rows = [];
      this.baseline = new Map();
      this.parseError = error instanceof Error ? error.message : String(error);
    } finally {
      this.loading = false;
      this.dirty = false;
      this.update();
    }
  }

  protected updateTitle(index: number, value: string): void {
    this.rows = this.rows.map((row, rowIndex) => rowIndex === index ? { ...row, title: value } : row);
    this.dirty = true;
    this.update();
  }

  protected toggleInclude(index: number, include: boolean): void {
    this.rows = this.rows.map((row, rowIndex) => rowIndex === index ? { ...row, include } : row);
    this.dirty = true;
    this.update();
  }

  /**
   * Walk the parsed content sequences recursively, applying edited titles and
   * include flags to the matching entry (by normalized path). Only rows that
   * changed from the loaded baseline are rewritten, preserving comments/order.
   */
  protected applyRows(seq: YAMLSeq, rowsByPath: Map<string, ManifestRow>): void {
    for (const item of seq.items) {
      if (!isMap(item)) {
        continue;
      }
      const rawPath = item.get('path');
      if (typeof rawPath === 'string') {
        const key = normalizeManifestPath(rawPath);
        const row = rowsByPath.get(key);
        const base = this.baseline.get(key);
        if (row && base) {
          const title = row.title.trim();
          if (title !== base.title.trim()) {
            if (title) {
              item.set('title', title);
            } else {
              item.delete('title');
            }
          }
          if (row.include !== base.include) {
            const flag = includeFlagToYaml(row.include);
            if (flag === undefined) {
              item.delete('include');
            } else {
              item.set('include', flag);
            }
          }
        }
      }
      const children = item.get('children');
      if (isSeq(children)) {
        this.applyRows(children, rowsByPath);
      }
    }
  }

  protected serialize(): string {
    const document = this.document && this.document.contents != null
      ? this.document
      : new Document({ version: 1, content: [] });

    let content = document.get('content');
    if (!isSeq(content)) {
      content = new YAMLSeq();
      document.set('content', content);
    }

    const rowsByPath = new Map(this.rows.map(row => [normalizeManifestPath(row.path), row]));
    this.applyRows(content as YAMLSeq, rowsByPath);
    return document.toString();
  }

  protected async save(): Promise<void> {
    try {
      const content = this.serialize();
      await this.fileService.write(this.uri, content);
      await this.load();
      await this.messageService.info(`Saved ${this.uri.path.base}.`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.messageService.error(`Could not save manifest: ${detail}`);
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
      return React.createElement('div', { className: 'afe-form-editor' }, 'Loading manifest...');
    }

    const problems = validateManifestRows(this.rows);
    return React.createElement(
      'div',
      { className: 'afe-form-editor' },
      React.createElement(
        'div',
        { className: 'afe-form-editor-header' },
        React.createElement('h3', undefined, 'Manifest'),
        React.createElement('span', { className: 'afe-form-editor-count' }, `${this.rows.length}`)
      ),
      React.createElement(
        'p',
        { className: 'afe-form-editor-help' },
        'Edit chapter titles and the build "include" flag here. To reorder entries, move them, or add a new chapter, use the manuscript navigator tree (it owns ordering via backend mutations).'
      ),
      this.parseError
        ? React.createElement(
          'div',
          { className: 'afe-form-editor-problem error' },
          `YAML parse warning: ${this.parseError}`
        )
        : undefined,
      this.renderProblems(problems),
      this.rows.length === 0
        ? React.createElement('p', { className: 'afe-form-editor-empty' }, 'The manifest has no content entries yet. Add a chapter from the navigator tree.')
        : React.createElement(
          'ul',
          { className: 'afe-form-editor-tree' },
          ...this.rows.map((row, index) => this.renderRow(row, index))
        ),
      React.createElement(
        'div',
        { className: 'afe-form-editor-actions' },
        React.createElement(
          'button',
          { className: 'theia-button main', type: 'button', onClick: () => { void this.save(); } },
          this.dirty ? 'Save*' : 'Save'
        ),
        React.createElement(
          'button',
          { className: 'theia-button secondary', type: 'button', onClick: () => { void this.load(); } },
          'Reload from disk'
        )
      ),
      React.createElement(
        'p',
        { className: 'afe-form-editor-help' },
        'Saving writes pure YAML and preserves the version key, comments, and entry order. Use "Open With..." to edit the raw file.'
      )
    );
  }

  protected renderProblems(problems: FormProblem[]): React.ReactNode {
    if (problems.length === 0) {
      return undefined;
    }
    return React.createElement(
      'ul',
      { className: 'afe-form-editor-problems' },
      ...problems.map((problem, index) => React.createElement(
        'li',
        { key: index, className: `afe-form-editor-problem ${problem.severity}` },
        problem.message
      ))
    );
  }

  protected renderRow(row: ManifestRow, index: number): React.ReactNode {
    return React.createElement(
      'li',
      {
        key: `${row.path}:${index}`,
        className: `afe-form-editor-tree-row${row.hasChildren ? ' has-children' : ''}`,
        style: { marginLeft: `${row.depth * 20}px` }
      },
      React.createElement(
        'label',
        { className: 'afe-form-editor-include', title: 'Include in build' },
        React.createElement('input', {
          type: 'checkbox',
          checked: row.include,
          onChange: (event: React.ChangeEvent<HTMLInputElement>) => this.toggleInclude(index, event.currentTarget.checked)
        })
      ),
      React.createElement(
        'div',
        { className: 'afe-form-editor-tree-fields' },
        React.createElement('input', {
          className: 'afe-form-editor-tree-title',
          value: row.title,
          placeholder: 'title',
          onChange: (event: React.ChangeEvent<HTMLInputElement>) => this.updateTitle(index, event.currentTarget.value)
        }),
        React.createElement('span', { className: 'afe-form-editor-tree-path', title: row.path }, row.path)
      )
    );
  }
}
