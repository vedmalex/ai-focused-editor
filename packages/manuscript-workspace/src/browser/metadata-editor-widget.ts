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
import { Document, isMap, parseDocument, YAMLMap } from 'yaml';
import {
  extractMetadataFields,
  isMetadataKnownKey,
  validateMetadata,
  type FormProblem,
  type MetadataFields
} from '../common/book-config-forms';

type CoverStatus = 'none' | 'checking' | 'exists' | 'missing';

function cloneFields(fields: MetadataFields): MetadataFields {
  return {
    title: fields.title,
    author: fields.author,
    language: fields.language,
    cover: fields.cover,
    unknown: fields.unknown.map(entry => ({ ...entry }))
  };
}

/**
 * Form-based editor for the workspace-root `metadata.yaml` (FR / Wave-8). The
 * file on disk stays pure YAML: the widget parses through the `yaml` Document
 * API so the document header, key order, comments, and any unknown nested
 * structures survive a round-trip. Only edited keys are rewritten — known
 * fields (title/author/language/cover) plus a free key-value section for other
 * top-level scalar keys.
 */
@injectable()
export class MetadataEditorWidget extends ReactWidget implements Navigatable {
  static readonly FACTORY_ID = 'ai-focused-editor.metadata-editor';
  static readonly LABEL = 'Book Metadata';

  @inject(FileService)
  protected readonly fileService!: FileService;

  @inject(MessageService)
  protected readonly messageService!: MessageService;

  protected uri!: URI;
  protected document: Document | undefined;
  protected fields: MetadataFields = { title: '', author: '', language: '', cover: '', unknown: [] };
  protected baseline: MetadataFields = { title: '', author: '', language: '', cover: '', unknown: [] };
  protected loading = false;
  protected dirty = false;
  protected parseError: string | undefined;
  protected coverStatus: CoverStatus = 'none';

  configure(uri: URI): void {
    this.uri = uri;
    this.id = `${MetadataEditorWidget.FACTORY_ID}:${uri.toString()}`;
    this.title.label = nls.localize('ai-focused-editor/book-config/metadata-title', MetadataEditorWidget.LABEL);
    this.title.caption = nls.localize(
      'ai-focused-editor/book-config/metadata-caption',
      'Book metadata form: {0}',
      uri.path.fsPath()
    );
    this.title.iconClass = 'fa fa-book';
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
        : new Document({});
      this.parseError = document.errors.length > 0
        ? document.errors.map(error => error.message).join('; ')
        : undefined;
      this.document = document;
      this.fields = extractMetadataFields(document.toJS() ?? {});
      this.baseline = cloneFields(this.fields);
    } catch (error) {
      this.document = undefined;
      this.fields = { title: '', author: '', language: '', cover: '', unknown: [] };
      this.baseline = cloneFields(this.fields);
      this.parseError = error instanceof Error ? error.message : String(error);
    } finally {
      this.loading = false;
      this.dirty = false;
      this.update();
      void this.refreshCoverStatus();
    }
  }

  protected updateField(field: 'title' | 'author' | 'language' | 'cover', value: string): void {
    this.fields = { ...this.fields, [field]: value };
    this.dirty = true;
    this.update();
    if (field === 'cover') {
      void this.refreshCoverStatus();
    }
  }

  protected updateUnknown(index: number, part: 'key' | 'value', value: string): void {
    this.fields = {
      ...this.fields,
      unknown: this.fields.unknown.map((entry, entryIndex) =>
        entryIndex === index ? { ...entry, [part]: value } : entry)
    };
    this.dirty = true;
    this.update();
  }

  protected addUnknown(): void {
    this.fields = { ...this.fields, unknown: [...this.fields.unknown, { key: '', value: '' }] };
    this.dirty = true;
    this.update();
  }

  protected deleteUnknown(index: number): void {
    this.fields = {
      ...this.fields,
      unknown: this.fields.unknown.filter((_, entryIndex) => entryIndex !== index)
    };
    this.dirty = true;
    this.update();
  }

  /** Cheap existence hint for the cover: resolve relative to the workspace root. */
  protected async refreshCoverStatus(): Promise<void> {
    const cover = this.fields.cover.trim();
    if (!cover) {
      this.coverStatus = 'none';
      this.update();
      return;
    }
    this.coverStatus = 'checking';
    this.update();
    try {
      const target = this.uri.parent.resolve(cover);
      this.coverStatus = (await this.fileService.exists(target)) ? 'exists' : 'missing';
    } catch {
      this.coverStatus = 'missing';
    }
    this.update();
  }

  protected ensureMap(document: Document): YAMLMap {
    if (isMap(document.contents)) {
      return document.contents;
    }
    const map = new YAMLMap();
    document.contents = map;
    return map;
  }

  /** Set/delete a known field only when it differs from the loaded baseline. */
  protected applyField(document: Document, key: 'title' | 'author' | 'language' | 'cover', required: boolean): void {
    const value = this.fields[key].trim();
    if (value === this.baseline[key].trim()) {
      return;
    }
    if (value) {
      document.set(key, value);
    } else if (required) {
      document.set(key, '');
    } else {
      document.delete(key);
    }
  }

  /**
   * Rewrite only edited keys through the Document API. Known fields plus the
   * free scalar rows are updated; unknown structures and comments are left
   * untouched.
   */
  protected serialize(): string {
    const document = this.document && this.document.contents != null
      ? this.document
      : new Document({});
    this.ensureMap(document);

    this.applyField(document, 'title', true);
    this.applyField(document, 'language', true);
    this.applyField(document, 'author', false);
    this.applyField(document, 'cover', false);

    const baselineUnknown = new Map(this.baseline.unknown.map(entry => [entry.key.trim(), entry.value]));
    const currentKeys = new Set<string>();
    for (const entry of this.fields.unknown) {
      const key = entry.key.trim();
      if (!key || isMetadataKnownKey(key)) {
        continue;
      }
      currentKeys.add(key);
      const previous = baselineUnknown.get(key);
      if (previous === undefined || previous !== entry.value) {
        document.set(key, entry.value);
      }
    }
    // Delete unknown keys that were present at load but removed in the form.
    for (const key of baselineUnknown.keys()) {
      if (key && !currentKeys.has(key)) {
        document.delete(key);
      }
    }

    return document.toString();
  }

  protected async save(): Promise<void> {
    const problems = validateMetadata(this.fields);
    if (problems.some(problem => problem.severity === 'error')) {
      await this.messageService.error(nls.localize(
        'ai-focused-editor/book-config/fix-problems-before-save',
        'Fix the highlighted metadata problems before saving.'
      ));
      return;
    }
    try {
      const content = this.serialize();
      await this.fileService.write(this.uri, content);
      await this.load();
      await this.messageService.info(nls.localize(
        'ai-focused-editor/book-config/saved',
        'Saved {0}.',
        this.uri.path.base
      ));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.messageService.error(nls.localize(
        'ai-focused-editor/book-config/save-metadata-failed',
        'Could not save metadata: {0}',
        detail
      ));
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
      return React.createElement('div', { className: 'afe-form-editor' }, nls.localize('ai-focused-editor/book-config/loading-metadata', 'Loading metadata...'));
    }

    const problems = validateMetadata(this.fields);
    return React.createElement(
      'div',
      { className: 'afe-form-editor' },
      React.createElement(
        'div',
        { className: 'afe-form-editor-header' },
        React.createElement('h3', undefined, nls.localize('ai-focused-editor/book-config/metadata-title', 'Book Metadata'))
      ),
      this.parseError
        ? React.createElement(
          'div',
          { className: 'afe-form-editor-problem error' },
          nls.localize('ai-focused-editor/book-config/yaml-parse-warning', 'YAML parse warning: {0}', this.parseError)
        )
        : undefined,
      this.renderProblems(problems),
      React.createElement(
        'div',
        { className: 'afe-form-editor-section' },
        this.renderInput(
          nls.localize('ai-focused-editor/book-config/field-title', 'Title'),
          'title',
          nls.localize('ai-focused-editor/book-config/field-title-placeholder', 'book title'),
          true
        ),
        this.renderInput(
          nls.localize('ai-focused-editor/book-config/field-author', 'Author'),
          'author',
          nls.localize('ai-focused-editor/book-config/field-author-placeholder', 'author name'),
          false
        ),
        this.renderInput(
          nls.localize('ai-focused-editor/book-config/field-language', 'Language'),
          'language',
          nls.localize('ai-focused-editor/book-config/field-language-placeholder', 'e.g. en, ru'),
          true
        ),
        this.renderCoverField()
      ),
      React.createElement(
        'div',
        { className: 'afe-form-editor-section' },
        React.createElement('h4', { className: 'afe-form-editor-subhead' }, nls.localize('ai-focused-editor/book-config/other-keys', 'Other keys')),
        React.createElement(
          'p',
          { className: 'afe-form-editor-help' },
          nls.localize(
            'ai-focused-editor/book-config/other-keys-help',
            'Any other top-level scalar keys in metadata.yaml. Nested structures (lists/maps) are preserved but not shown here.'
          )
        ),
        this.fields.unknown.length === 0
          ? React.createElement('p', { className: 'afe-form-editor-empty' }, nls.localize('ai-focused-editor/book-config/no-other-keys', 'No other keys.'))
          : React.createElement(
            'ul',
            { className: 'afe-form-editor-rows' },
            ...this.fields.unknown.map((entry, index) => this.renderUnknownRow(entry.key, entry.value, index))
          ),
        React.createElement(
          'button',
          { className: 'theia-button secondary', type: 'button', onClick: () => this.addUnknown() },
          nls.localize('ai-focused-editor/book-config/add-key', 'Add key')
        )
      ),
      React.createElement(
        'div',
        { className: 'afe-form-editor-actions' },
        React.createElement(
          'button',
          { className: 'theia-button main', type: 'button', onClick: () => { void this.save(); } },
          this.dirty
            ? nls.localize('ai-focused-editor/book-config/save-dirty', 'Save*')
            : nls.localize('ai-focused-editor/book-config/save', 'Save')
        ),
        React.createElement(
          'button',
          { className: 'theia-button secondary', type: 'button', onClick: () => { void this.load(); } },
          nls.localize('ai-focused-editor/book-config/reload-from-disk', 'Reload from disk')
        )
      ),
      React.createElement(
        'p',
        { className: 'afe-form-editor-help' },
        nls.localize(
          'ai-focused-editor/book-config/metadata-help-bottom',
          'Saving rewrites only edited keys and preserves the file header, comments, and unknown structures. Use "Open With..." to edit the raw file.'
        )
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

  protected renderInput(
    label: string,
    field: 'title' | 'author' | 'language' | 'cover',
    placeholder: string,
    required: boolean
  ): React.ReactNode {
    return React.createElement(
      'label',
      { className: 'afe-form-editor-field' },
      React.createElement(
        'span',
        undefined,
        label,
        required ? React.createElement('span', { className: 'afe-form-editor-required' }, ' *') : undefined
      ),
      React.createElement('input', {
        value: this.fields[field],
        placeholder,
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => this.updateField(field, event.currentTarget.value)
      })
    );
  }

  protected renderCoverField(): React.ReactNode {
    return React.createElement(
      'label',
      { className: 'afe-form-editor-field' },
      React.createElement('span', undefined, nls.localize('ai-focused-editor/book-config/field-cover', 'Cover')),
      React.createElement('input', {
        value: this.fields.cover,
        placeholder: nls.localize('ai-focused-editor/book-config/field-cover-placeholder', 'workspace-relative image path, e.g. cover.png'),
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => this.updateField('cover', event.currentTarget.value)
      }),
      this.renderCoverHint()
    );
  }

  protected renderCoverHint(): React.ReactNode {
    switch (this.coverStatus) {
      case 'checking':
        return React.createElement('span', { className: 'afe-form-editor-hint' }, nls.localize('ai-focused-editor/book-config/cover-checking', 'Checking...'));
      case 'exists':
        return React.createElement('span', { className: 'afe-form-editor-hint ok' }, nls.localize('ai-focused-editor/book-config/cover-found', 'File found.'));
      case 'missing':
        return React.createElement('span', { className: 'afe-form-editor-hint warn' }, nls.localize('ai-focused-editor/book-config/cover-missing', 'File not found at this path.'));
      default:
        return undefined;
    }
  }

  protected renderUnknownRow(key: string, value: string, index: number): React.ReactNode {
    return React.createElement(
      'li',
      { key: index, className: 'afe-form-editor-kv-row' },
      React.createElement('input', {
        className: 'afe-form-editor-kv-key',
        value: key,
        placeholder: nls.localize('ai-focused-editor/book-config/kv-key-placeholder', 'key'),
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => this.updateUnknown(index, 'key', event.currentTarget.value)
      }),
      React.createElement('input', {
        className: 'afe-form-editor-kv-value',
        value,
        placeholder: nls.localize('ai-focused-editor/book-config/kv-value-placeholder', 'value'),
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => this.updateUnknown(index, 'value', event.currentTarget.value)
      }),
      React.createElement(
        'button',
        {
          className: 'theia-button secondary afe-form-editor-delete',
          type: 'button',
          title: nls.localize('ai-focused-editor/book-config/delete-key-title', 'Delete this key'),
          onClick: () => this.deleteUnknown(index)
        },
        nls.localize('ai-focused-editor/book-config/delete', 'Delete')
      )
    );
  }
}
