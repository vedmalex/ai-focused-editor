import URI from '@theia/core/lib/common/uri';
import { Emitter, Event, MessageService } from '@theia/core/lib/common';
import { nls } from '@theia/core/lib/common/nls';
import { Navigatable } from '@theia/core/lib/browser';
import { Saveable, SaveOptions } from '@theia/core/lib/browser/saveable';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import {
  inject,
  injectable
} from '@theia/core/shared/inversify';
import React from '@theia/core/shared/react';
import { Document, parseDocument } from 'yaml';
import {
  BASE_ENTITY_TYPES,
  parseEntityTypesYaml,
  type EntityFieldDescriptor,
  type EntityFieldKind,
  type EntityTypeDescriptor,
  type EntityTypeProblem
} from '../common';
import {
  emptyAuthorTypeRow,
  hasBlockingTypeProblems,
  serializeTypesDocument,
  typesToRows,
  validateTypeRows,
  type AuthorTypeRow,
  type FieldRow
} from '../common/entity-type-forms';

/** The three field controls, in the order the kind select offers them. */
const FIELD_KINDS: readonly EntityFieldKind[] = ['text', 'textarea', 'list'];

function fieldKindLabel(kind: EntityFieldKind): string {
  switch (kind) {
    case 'textarea':
      return nls.localize('ai-focused-editor/entity-types/kind-textarea', 'Multi-line text');
    case 'list':
      return nls.localize('ai-focused-editor/entity-types/kind-list', 'List (one per line)');
    default:
      return nls.localize('ai-focused-editor/entity-types/kind-text', 'Single-line text');
  }
}

/**
 * Form-based editor for a book's `entities/types.yaml` (author-declared entity
 * types). The four built-in types are shown read-only for reference; the author
 * types are edited as expandable cards with an inline field sub-editor.
 *
 * The file on disk stays pure YAML: the widget parses through the `yaml` Document
 * API, so the document header, the `version` key, and comments survive a
 * round-trip — only the `types` sequence is rebuilt from the form rows (through
 * the pure {@link serializeTypesDocument}). Validation delegates to the registry
 * parser via {@link validateTypeRows} (one validation brain).
 *
 * Saving takes effect immediately: the manuscript tree and the entity-type
 * registry watch `entities/types.yaml` and re-scan on write, so the navigator
 * sections, tags, and the entity form all pick up the change on save.
 */
@injectable()
export class EntityTypesEditorWidget extends ReactWidget implements Navigatable, Saveable {
  static readonly FACTORY_ID = 'ai-focused-editor.entity-types-editor';
  static readonly LABEL = nls.localize('ai-focused-editor/entity-types/editor-label', 'Entity Types');

  @inject(FileService)
  protected readonly fileService!: FileService;

  @inject(MessageService)
  protected readonly messageService!: MessageService;

  protected uri!: URI;
  protected document: Document | undefined;
  protected rows: AuthorTypeRow[] = [];
  protected selectedIndex: number | undefined;
  protected builtInExpanded = new Set<string>();
  protected loading = false;
  protected parseError: string | undefined;
  protected watcherInstalled = false;

  // --- Saveable ---
  protected _dirty = false;
  protected readonly onDirtyChangedEmitter = new Emitter<void>();
  protected readonly onContentChangedEmitter = new Emitter<void>();
  readonly onDirtyChanged: Event<void> = this.onDirtyChangedEmitter.event;
  readonly onContentChanged: Event<void> = this.onContentChangedEmitter.event;

  get dirty(): boolean {
    return this._dirty;
  }

  configure(uri: URI): void {
    this.uri = uri;
    this.id = `${EntityTypesEditorWidget.FACTORY_ID}:${uri.toString()}`;
    this.title.label = EntityTypesEditorWidget.LABEL;
    this.title.caption = nls.localize('ai-focused-editor/entity-types/editor-caption', 'Entity types form: {0}', uri.path.fsPath());
    this.title.iconClass = 'codicon codicon-symbol-namespace';
    this.title.closable = true;
    this.addClass('afe-entity-types-editor-widget');
    this.toDispose.push(this.onDirtyChangedEmitter);
    this.toDispose.push(this.onContentChangedEmitter);
    if (!this.watcherInstalled) {
      this.watcherInstalled = true;
      // Author create actions and external edits touch this file; reflect them
      // live while the form has no unsaved edits.
      this.toDispose.push(this.fileService.onDidFilesChange(event => {
        if (!this._dirty && event.changes.some(change => change.resource.toString() === this.uri.toString())) {
          void this.load();
        }
      }));
    }
    void this.load();
  }

  getResourceUri(): URI | undefined {
    return this.uri;
  }

  createMoveToUri(resourceUri: URI): URI | undefined {
    return resourceUri;
  }

  protected setDirty(dirty: boolean): void {
    if (dirty !== this._dirty) {
      this._dirty = dirty;
      this.onDirtyChangedEmitter.fire();
    }
    if (dirty) {
      this.onContentChangedEmitter.fire();
    }
  }

  protected async load(): Promise<void> {
    this.loading = true;
    this.parseError = undefined;
    this.update();
    try {
      const content = await this.readTextIfExists(this.uri);
      const document = content !== undefined && content.trim().length > 0
        ? parseDocument(content)
        : new Document({ version: 1, types: [] });
      this.parseError = document.errors.length > 0
        ? document.errors.map(error => error.message).join('; ')
        : undefined;
      this.document = document;
      // Reuse the registry parser to resolve defaults, then flatten to rows.
      this.rows = typesToRows(parseEntityTypesYaml(content ?? '').types);
    } catch (error) {
      this.document = undefined;
      this.rows = [];
      this.parseError = error instanceof Error ? error.message : String(error);
    } finally {
      this.loading = false;
      this.setDirty(false);
      this.selectedIndex = this.rows.length > 0 ? 0 : undefined;
      this.update();
    }
  }

  protected async readTextIfExists(resource: URI): Promise<string | undefined> {
    try {
      return (await this.fileService.read(resource)).value;
    } catch {
      return undefined;
    }
  }

  // --- type-row mutations ---

  protected updateRow<K extends keyof AuthorTypeRow>(index: number, field: K, value: AuthorTypeRow[K]): void {
    this.rows = this.rows.map((row, rowIndex) => rowIndex === index ? { ...row, [field]: value } : row);
    this.setDirty(true);
    this.update();
  }

  protected addRow(): void {
    this.rows = [...this.rows, emptyAuthorTypeRow()];
    this.selectedIndex = this.rows.length - 1;
    this.setDirty(true);
    this.update();
  }

  protected deleteRow(index: number): void {
    this.rows = this.rows.filter((_, rowIndex) => rowIndex !== index);
    if (this.selectedIndex !== undefined) {
      if (this.selectedIndex === index) {
        this.selectedIndex = this.rows.length > 0 ? Math.min(index, this.rows.length - 1) : undefined;
      } else if (this.selectedIndex > index) {
        this.selectedIndex -= 1;
      }
    }
    this.setDirty(true);
    this.update();
  }

  protected toggleSelected(index: number): void {
    this.selectedIndex = this.selectedIndex === index ? undefined : index;
    this.update();
  }

  protected toggleBuiltIn(id: string): void {
    if (this.builtInExpanded.has(id)) {
      this.builtInExpanded.delete(id);
    } else {
      this.builtInExpanded.add(id);
    }
    this.update();
  }

  // --- field sub-editor mutations ---

  protected mutateFields(typeIndex: number, mutate: (fields: FieldRow[]) => FieldRow[]): void {
    this.rows = this.rows.map((row, rowIndex) =>
      rowIndex === typeIndex ? { ...row, fields: mutate([...row.fields]) } : row);
    this.setDirty(true);
    this.update();
  }

  protected updateField<K extends keyof FieldRow>(typeIndex: number, fieldIndex: number, key: K, value: FieldRow[K]): void {
    this.mutateFields(typeIndex, fields =>
      fields.map((field, index) => index === fieldIndex ? { ...field, [key]: value } : field));
  }

  protected addField(typeIndex: number): void {
    this.mutateFields(typeIndex, fields => [...fields, { name: '', kind: 'text', label: '' }]);
  }

  protected deleteField(typeIndex: number, fieldIndex: number): void {
    // The pinned id (0) and label (1) rows are never removable.
    if (fieldIndex < 2) {
      return;
    }
    this.mutateFields(typeIndex, fields => fields.filter((_, index) => index !== fieldIndex));
  }

  /** Reorder a custom field. The pinned id/label rows at indices 0/1 stay put. */
  protected moveField(typeIndex: number, fieldIndex: number, direction: -1 | 1): void {
    const target = fieldIndex + direction;
    // Custom fields only ever move within the [2, length) range.
    if (fieldIndex < 2 || target < 2) {
      return;
    }
    this.mutateFields(typeIndex, fields => {
      if (target >= fields.length) {
        return fields;
      }
      const next = [...fields];
      const [moved] = next.splice(fieldIndex, 1);
      next.splice(target, 0, moved);
      return next;
    });
  }

  // --- save / revert (Saveable) ---

  protected serializeYaml(): string {
    return serializeTypesDocument(this.document, this.rows);
  }

  async save(_options?: SaveOptions): Promise<void> {
    const problems = validateTypeRows(this.rows);
    if (hasBlockingTypeProblems(problems)) {
      await this.messageService.error(nls.localize(
        'ai-focused-editor/entity-types/fix-problems',
        'Fix the highlighted entity-type problems before saving (ids must be present, kebab-case, and must not collide with a built-in or another type).'
      ));
      return;
    }
    try {
      const content = this.serializeYaml();
      await this.fileService.write(this.uri, content);
      // Re-read so the in-memory document (and comments) reflect what was written.
      await this.load();
      await this.messageService.info(nls.localize('ai-focused-editor/entity-types/saved', 'Saved {0}.', this.uri.path.base));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.messageService.error(nls.localize('ai-focused-editor/entity-types/save-failed', 'Could not save entity types: {0}', detail));
    }
  }

  async revert(): Promise<void> {
    await this.load();
  }

  // --- rendering ---

  protected render(): React.ReactNode {
    if (this.loading || !this.uri) {
      return React.createElement('div', { className: 'afe-entity-types-editor' }, nls.localize('ai-focused-editor/entity-types/loading', 'Loading entity types...'));
    }

    const problems = validateTypeRows(this.rows);
    const blocked = hasBlockingTypeProblems(problems);
    return React.createElement(
      'div',
      { className: 'afe-entity-types-editor' },
      React.createElement(
        'div',
        { className: 'afe-entity-types-editor-header' },
        React.createElement('h3', undefined, nls.localize('ai-focused-editor/entity-types/heading', 'Entity Types')),
        React.createElement('span', { className: 'afe-entity-types-editor-count' }, `${this.rows.length}`)
      ),
      React.createElement(
        'p',
        { className: 'afe-entity-types-editor-help' },
        nls.localize('ai-focused-editor/entity-types/help-live', 'Tree sections, tags, and the entity form pick up your changes as soon as you save.')
      ),
      this.parseError
        ? React.createElement(
          'div',
          { className: 'afe-entity-types-editor-problem error' },
          nls.localize('ai-focused-editor/entity-types/parse-warning', 'YAML parse warning: {0}', this.parseError)
        )
        : undefined,
      this.renderProblems(problems),
      this.renderBuiltIns(),
      React.createElement('h4', { className: 'afe-entity-types-editor-section-title' }, nls.localize('ai-focused-editor/entity-types/author-heading', 'Author types')),
      this.rows.length === 0
        ? React.createElement('p', { className: 'afe-entity-types-editor-empty' }, nls.localize('ai-focused-editor/entity-types/empty', 'No author types yet. Add one below.'))
        : React.createElement(
          'ul',
          { className: 'afe-entity-types-editor-cards' },
          ...this.rows.map((row, index) => this.renderCard(row, index, problems))
        ),
      React.createElement(
        'div',
        { className: 'afe-entity-types-editor-actions' },
        React.createElement(
          'button',
          { className: 'theia-button secondary', type: 'button', onClick: () => this.addRow() },
          nls.localize('ai-focused-editor/entity-types/add-type', 'Add Type')
        ),
        React.createElement(
          'button',
          {
            className: 'theia-button main',
            type: 'button',
            disabled: blocked,
            title: blocked ? nls.localize('ai-focused-editor/entity-types/fix-before-save-title', 'Fix the highlighted problems before saving.') : undefined,
            onClick: () => { void this.save(); }
          },
          this._dirty ? nls.localize('ai-focused-editor/entity-types/save-dirty', 'Save*') : nls.localize('ai-focused-editor/entity-types/save', 'Save')
        ),
        React.createElement(
          'button',
          { className: 'theia-button secondary', type: 'button', onClick: () => { void this.load(); } },
          nls.localize('ai-focused-editor/entity-types/reload', 'Reload from disk')
        )
      ),
      React.createElement(
        'p',
        { className: 'afe-entity-types-editor-help' },
        nls.localize('ai-focused-editor/entity-types/help-builtins', 'The four built-in types (character, term, artifact, location) cannot be overridden. Saving writes pure YAML and preserves the file header, the version key, and comments. Use "Open With..." to edit the raw file.')
      )
    );
  }

  /** Read-only reference cards for the four built-in types. */
  protected renderBuiltIns(): React.ReactNode {
    return React.createElement(
      'div',
      { className: 'afe-entity-types-editor-builtins' },
      React.createElement('h4', { className: 'afe-entity-types-editor-section-title' }, nls.localize('ai-focused-editor/entity-types/builtin-heading', 'Built-in types')),
      React.createElement(
        'ul',
        { className: 'afe-entity-types-editor-cards' },
        ...BASE_ENTITY_TYPES.map(type => this.renderBuiltInCard(type))
      )
    );
  }

  protected renderBuiltInCard(type: EntityTypeDescriptor): React.ReactNode {
    const expanded = this.builtInExpanded.has(type.id);
    return React.createElement(
      'li',
      { key: type.id, className: 'afe-entity-types-editor-card readonly' },
      React.createElement(
        'div',
        { className: 'afe-entity-types-editor-card-head' },
        React.createElement(
          'button',
          {
            className: 'afe-entity-types-editor-card-toggle',
            type: 'button',
            onClick: () => this.toggleBuiltIn(type.id)
          },
          React.createElement('span', { className: `codicon codicon-chevron-${expanded ? 'down' : 'right'}` }),
          React.createElement('span', { className: `${type.icon} afe-entity-types-editor-card-icon` }),
          React.createElement('span', { className: 'afe-entity-types-editor-card-id' }, type.id),
          React.createElement('span', { className: 'afe-entity-types-editor-card-label' }, type.label),
          React.createElement('span', { className: 'afe-entity-types-editor-badge origin' }, nls.localize('ai-focused-editor/entity-types/origin-built-in', 'built-in'))
        )
      ),
      expanded
        ? React.createElement(
          'div',
          { className: 'afe-entity-types-editor-card-body' },
          React.createElement('div', { className: 'afe-entity-types-editor-meta' }, `[[${type.tagKind}:id]] · entities/${type.directory}/`),
          this.renderReadOnlyFields(type.fields)
        )
        : undefined
    );
  }

  protected renderReadOnlyFields(fields: readonly EntityFieldDescriptor[]): React.ReactNode {
    return React.createElement(
      'ul',
      { className: 'afe-entity-types-editor-fields readonly' },
      ...fields.map((field, index) => React.createElement(
        'li',
        { key: index, className: 'afe-entity-types-editor-field-row readonly' },
        React.createElement('span', { className: 'afe-entity-types-editor-field-name' }, field.name),
        React.createElement('span', { className: 'afe-entity-types-editor-badge kind' }, fieldKindLabel(field.kind)),
        field.role
          ? React.createElement('span', { className: 'afe-entity-types-editor-badge role' }, field.role)
          : undefined
      ))
    );
  }

  protected renderCard(row: AuthorTypeRow, index: number, problems: EntityTypeProblem[]): React.ReactNode {
    const selected = this.selectedIndex === index;
    const rowHasError = problems.some(problem => problem.index === index);
    return React.createElement(
      'li',
      { key: index, className: `afe-entity-types-editor-card${selected ? ' selected' : ''}${rowHasError ? ' has-error' : ''}` },
      React.createElement(
        'div',
        { className: 'afe-entity-types-editor-card-head' },
        React.createElement(
          'button',
          {
            className: 'afe-entity-types-editor-card-toggle',
            type: 'button',
            onClick: () => this.toggleSelected(index)
          },
          React.createElement('span', { className: `codicon codicon-chevron-${selected ? 'down' : 'right'}` }),
          React.createElement('span', { className: 'afe-entity-types-editor-card-id' }, row.id.trim() || nls.localize('ai-focused-editor/entity-types/new-type', '(new type)')),
          row.label.trim()
            ? React.createElement('span', { className: 'afe-entity-types-editor-card-label' }, row.label.trim())
            : undefined
        ),
        React.createElement(
          'button',
          {
            className: 'theia-button secondary afe-entity-types-editor-delete',
            type: 'button',
            title: nls.localize('ai-focused-editor/entity-types/delete-type-title', 'Delete this type'),
            onClick: () => this.deleteRow(index)
          },
          nls.localize('ai-focused-editor/entity-types/delete', 'Delete')
        )
      ),
      selected ? this.renderCardBody(row, index) : undefined
    );
  }

  protected renderCardBody(row: AuthorTypeRow, index: number): React.ReactNode {
    return React.createElement(
      'div',
      { className: 'afe-entity-types-editor-card-body' },
      this.renderInput(nls.localize('ai-focused-editor/entity-types/field-id', 'Id'), row.id, value => this.updateRow(index, 'id', value), nls.localize('ai-focused-editor/entity-types/field-id-ph', 'kebab-case slug, e.g. faction'), true),
      this.renderKebabHint(row.id),
      this.renderInput(nls.localize('ai-focused-editor/entity-types/field-label', 'Label'), row.label, value => this.updateRow(index, 'label', value), nls.localize('ai-focused-editor/entity-types/field-label-ph', 'shown verbatim in the navigator'), true),
      this.renderInput(nls.localize('ai-focused-editor/entity-types/field-tag-kind', 'Tag kind'), row.tagKind, value => this.updateRow(index, 'tagKind', value), nls.localize('ai-focused-editor/entity-types/field-tag-kind-ph', '[[tagKind:id]] token kind (defaults to the id)')),
      this.renderInput(nls.localize('ai-focused-editor/entity-types/field-directory', 'Directory'), row.directory, value => this.updateRow(index, 'directory', value), nls.localize('ai-focused-editor/entity-types/field-directory-ph', 'entities/<directory>/ (defaults to the id)')),
      this.renderInput(nls.localize('ai-focused-editor/entity-types/field-icon', 'Icon'), row.icon, value => this.updateRow(index, 'icon', value), nls.localize('ai-focused-editor/entity-types/field-icon-ph', 'a codicon class, e.g. codicon codicon-organization')),
      this.renderInput(nls.localize('ai-focused-editor/entity-types/field-accent', 'Accent class'), row.accentClass ?? '', value => this.updateRow(index, 'accentClass', value), nls.localize('ai-focused-editor/entity-types/field-accent-ph', 'optional afe-ico-* accent class')),
      this.renderFieldsEditor(row, index)
    );
  }

  protected renderKebabHint(id: string): React.ReactNode {
    const trimmed = id.trim();
    if (!trimmed || /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(trimmed)) {
      return undefined;
    }
    return React.createElement(
      'p',
      { className: 'afe-entity-types-editor-hint warning' },
      nls.localize('ai-focused-editor/entity-types/kebab-hint', 'The id should be kebab-case: lowercase letters, digits, and single hyphens.')
    );
  }

  protected renderFieldsEditor(row: AuthorTypeRow, typeIndex: number): React.ReactNode {
    return React.createElement(
      'fieldset',
      { className: 'afe-entity-types-editor-fieldset' },
      React.createElement('legend', undefined, nls.localize('ai-focused-editor/entity-types/fields-legend', 'Form fields')),
      React.createElement(
        'p',
        { className: 'afe-entity-types-editor-hint' },
        nls.localize('ai-focused-editor/entity-types/fields-hint', 'The id and label fields are pinned at the top and cannot be removed or reordered. Leave the fields at their defaults to keep the file terse.')
      ),
      React.createElement(
        'ul',
        { className: 'afe-entity-types-editor-fields' },
        ...row.fields.map((field, fieldIndex) => this.renderFieldRow(field, fieldIndex, typeIndex, row.fields.length))
      ),
      React.createElement(
        'button',
        { className: 'theia-button secondary afe-entity-types-editor-add-field', type: 'button', onClick: () => this.addField(typeIndex) },
        nls.localize('ai-focused-editor/entity-types/add-field', 'Add Field')
      )
    );
  }

  protected renderFieldRow(field: FieldRow, fieldIndex: number, typeIndex: number, fieldCount: number): React.ReactNode {
    const pinned = fieldIndex < 2;
    const roleLabel = fieldIndex === 0
      ? nls.localize('ai-focused-editor/entity-types/role-id', 'id')
      : fieldIndex === 1
        ? nls.localize('ai-focused-editor/entity-types/role-label', 'label')
        : undefined;
    return React.createElement(
      'li',
      { key: fieldIndex, className: `afe-entity-types-editor-field-row${pinned ? ' pinned' : ''}` },
      roleLabel
        ? React.createElement('span', { className: 'afe-entity-types-editor-badge role' }, roleLabel)
        : undefined,
      React.createElement('input', {
        className: 'afe-entity-types-editor-field-name',
        value: field.name,
        placeholder: nls.localize('ai-focused-editor/entity-types/field-name-ph', 'YAML key, e.g. motto'),
        // The id key is fixed; the label field's key stays editable.
        disabled: fieldIndex === 0,
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => this.updateField(typeIndex, fieldIndex, 'name', event.currentTarget.value)
      }),
      React.createElement(
        'select',
        {
          className: 'afe-entity-types-editor-field-kind',
          value: field.kind,
          // id/label are always single-line text.
          disabled: pinned,
          onChange: (event: React.ChangeEvent<HTMLSelectElement>) => this.updateField(typeIndex, fieldIndex, 'kind', event.currentTarget.value as EntityFieldKind)
        },
        ...FIELD_KINDS.map(kind => React.createElement('option', { key: kind, value: kind }, fieldKindLabel(kind)))
      ),
      React.createElement('input', {
        className: 'afe-entity-types-editor-field-label',
        value: field.label,
        placeholder: nls.localize('ai-focused-editor/entity-types/field-labelkey-ph', 'optional label key'),
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => this.updateField(typeIndex, fieldIndex, 'label', event.currentTarget.value)
      }),
      React.createElement(
        'span',
        { className: 'afe-entity-types-editor-field-controls' },
        React.createElement('button', {
          className: 'afe-entity-types-editor-icon-button',
          type: 'button',
          title: nls.localize('ai-focused-editor/entity-types/move-up', 'Move up'),
          disabled: pinned || fieldIndex <= 2,
          onClick: () => this.moveField(typeIndex, fieldIndex, -1)
        }, React.createElement('span', { className: 'codicon codicon-chevron-up' })),
        React.createElement('button', {
          className: 'afe-entity-types-editor-icon-button',
          type: 'button',
          title: nls.localize('ai-focused-editor/entity-types/move-down', 'Move down'),
          disabled: pinned || fieldIndex >= fieldCount - 1,
          onClick: () => this.moveField(typeIndex, fieldIndex, 1)
        }, React.createElement('span', { className: 'codicon codicon-chevron-down' })),
        React.createElement('button', {
          className: 'afe-entity-types-editor-icon-button',
          type: 'button',
          title: nls.localize('ai-focused-editor/entity-types/remove-field', 'Remove field'),
          disabled: pinned,
          onClick: () => this.deleteField(typeIndex, fieldIndex)
        }, React.createElement('span', { className: 'codicon codicon-trash' }))
      )
    );
  }

  protected renderInput(label: string, value: string, onChange: (value: string) => void, placeholder: string, required = false): React.ReactNode {
    return React.createElement(
      'label',
      { className: 'afe-entity-types-editor-field' },
      React.createElement(
        'span',
        undefined,
        label,
        required ? React.createElement('span', { className: 'afe-entity-types-editor-required' }, ' *') : undefined
      ),
      React.createElement('input', {
        value,
        placeholder,
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => onChange(event.currentTarget.value)
      })
    );
  }

  protected renderProblems(problems: EntityTypeProblem[]): React.ReactNode {
    if (problems.length === 0) {
      return undefined;
    }
    return React.createElement(
      'ul',
      { className: 'afe-entity-types-editor-problems' },
      ...problems.map((problem, index) => React.createElement(
        'li',
        { key: index, className: 'afe-entity-types-editor-problem error' },
        this.localizeProblem(problem)
      ))
    );
  }

  /**
   * Localize a registry {@link EntityTypeProblem} by its stable code. The row
   * number ({@link EntityTypeProblem.index} + 1) and the offending id are the only
   * values threaded in; codes that reference a tag/directory value in English fall
   * back to a generic localized phrasing (still keyed by the type id). Unknown
   * codes fall back to the byte-identical English `message`.
   */
  protected localizeProblem(problem: EntityTypeProblem): string {
    const at = problem.index !== undefined ? problem.index + 1 : 0;
    const id = problem.id ?? '';
    switch (problem.code) {
      case 'invalid-shape':
        return nls.localize('ai-focused-editor/entity-types/problem-invalid-shape', 'The file must be a list of entity types (or a { types: [...] } object): {0}', problem.message);
      case 'invalid-entry':
        return nls.localize('ai-focused-editor/entity-types/problem-invalid-entry', 'Entity type {0}: expected an object.', at);
      case 'missing-id':
        return nls.localize('ai-focused-editor/entity-types/problem-missing-id', 'Entity type {0}: an id is required.', at);
      case 'invalid-id':
        return nls.localize('ai-focused-editor/entity-types/problem-invalid-id', 'Entity type "{0}": id must be a kebab-case token (lowercase letters, digits, hyphens).', id);
      case 'missing-label':
        return nls.localize('ai-focused-editor/entity-types/problem-missing-label', 'Entity type "{0}": a label is required.', id);
      case 'duplicate-id':
        return nls.localize('ai-focused-editor/entity-types/problem-duplicate-id', 'Entity type "{0}": duplicate id.', id);
      case 'duplicate-tag-kind':
        return nls.localize('ai-focused-editor/entity-types/problem-duplicate-tag-kind', 'Entity type "{0}": its tag kind is already used by another author type.', id);
      case 'duplicate-directory':
        return nls.localize('ai-focused-editor/entity-types/problem-duplicate-directory', 'Entity type "{0}": its directory is already used by another author type.', id);
      case 'reserved-id':
        return nls.localize('ai-focused-editor/entity-types/problem-reserved-id', 'Entity type "{0}": id collides with a built-in type; built-in types cannot be overridden.', id);
      case 'reserved-tag-kind':
        return nls.localize('ai-focused-editor/entity-types/problem-reserved-tag-kind', 'Entity type "{0}": its tag kind collides with a built-in type.', id);
      case 'reserved-directory':
        return nls.localize('ai-focused-editor/entity-types/problem-reserved-directory', 'Entity type "{0}": its directory collides with a built-in type.', id);
      default:
        return problem.message;
    }
  }
}
