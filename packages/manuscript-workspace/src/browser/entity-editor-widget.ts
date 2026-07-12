import URI from '@theia/core/lib/common/uri';
import { MessageService } from '@theia/core/lib/common';
import {
  Navigatable,
  open,
  OpenerService
} from '@theia/core/lib/browser';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { nls } from '@theia/core/lib/common/nls';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import {
  inject,
  injectable
} from '@theia/core/shared/inversify';
import React from '@theia/core/shared/react';
import { Document, parseDocument } from 'yaml';
import type {
  EffectiveEntityType,
  EntityFieldDescriptor,
  EntityMention,
  NarrativeEntity,
  WorkspaceDiagnostic
} from '../common';
import {
  DomainYamlSchemaKind,
  extractEntityMentions,
  NarrativeEntityService,
  YamlSchemaValidator
} from '../common';
import { EntityTypeRegistryService } from './entity-type-registry-service';

/**
 * The entity form is now SCHEMA-DRIVEN: it renders one control per
 * {@link EntityFieldDescriptor} of the file's EFFECTIVE type (built-in OR
 * author-declared), resolved from the {@link EntityTypeRegistryService} by the
 * file's `entities/<directory>` segment. The four built-in types were transcribed
 * into the registry 1:1 in stage 1, so their forms stay pixel-identical; author
 * types open in the exact same component with their own declared fields.
 *
 * The registry descriptor carries only the STRUCTURE of a field (name, control
 * kind, i18n label key, role). PRESENTATION defaults — the English label the
 * form supplies inline for `nls.localize`, the placeholder, and the textarea row
 * count — live here, keyed by the well-known base field names/keys, with graceful
 * fallbacks (a humanised label, no placeholder, a default row count) for
 * author-declared fields the form has never seen.
 */

/** A form draft: one string per field name (list fields are newline-joined). */
type EntityDraft = Record<string, string>;

const I18N_PREFIX = 'ai-focused-editor/entities/';

/**
 * English defaults the form supplies inline to `nls.localize(labelKey, default)`
 * for the well-known base label keys. Author fields whose `labelKey` is absent
 * here fall back to a humanised field name.
 */
const LABEL_KEY_DEFAULTS: Record<string, string> = {
  [`${I18N_PREFIX}field-id`]: 'Id',
  [`${I18N_PREFIX}field-name`]: 'Name',
  [`${I18N_PREFIX}field-term`]: 'Term',
  [`${I18N_PREFIX}field-aliases`]: 'Aliases',
  [`${I18N_PREFIX}field-epithets`]: 'Epithets',
  [`${I18N_PREFIX}field-summary`]: 'Summary',
  [`${I18N_PREFIX}field-backstory`]: 'Backstory',
  [`${I18N_PREFIX}field-arc`]: 'Arc',
  [`${I18N_PREFIX}field-speech-patterns`]: 'Speech patterns',
  [`${I18N_PREFIX}field-notes`]: 'Notes'
};

/**
 * Per-field presentation for the well-known base field names: the placeholder
 * (i18n key + English default) and, for multi-line controls, the row count.
 * Matches the current renderer exactly so base types stay pixel-identical.
 */
const FIELD_PRESENTATION: Record<string, { placeholderKey: string; placeholderDefault: string; rows?: number }> = {
  id: { placeholderKey: `${I18N_PREFIX}ph-id`, placeholderDefault: 'stable identifier, e.g. krishna' },
  aliases: { placeholderKey: `${I18N_PREFIX}ph-aliases`, placeholderDefault: 'one alias per line', rows: 3 },
  epithets: { placeholderKey: `${I18N_PREFIX}ph-epithets`, placeholderDefault: 'one epithet per line', rows: 3 },
  summary: { placeholderKey: `${I18N_PREFIX}ph-summary`, placeholderDefault: 'short one-line summary', rows: 2 },
  backstory: { placeholderKey: `${I18N_PREFIX}ph-backstory`, placeholderDefault: 'longer history behind the entity', rows: 4 },
  arc: { placeholderKey: `${I18N_PREFIX}ph-arc`, placeholderDefault: 'how the entity changes across the manuscript', rows: 2 },
  speechPatterns: { placeholderKey: `${I18N_PREFIX}ph-speech-patterns`, placeholderDefault: 'one trait per line', rows: 3 },
  notes: { placeholderKey: `${I18N_PREFIX}ph-notes`, placeholderDefault: 'free-form authoring notes', rows: 3 }
};

/** Default row count for a multi-line control the form has no presentation hint for. */
const DEFAULT_TEXTAREA_ROWS = 3;

/** Kinds that have a backing AJV schema — validation is skipped for author types. */
const VALIDATED_KINDS = new Set<DomainYamlSchemaKind>(['character', 'term', 'artifact', 'location']);

/**
 * The `entities/<directory>` segment of an entity YAML path, or `undefined` when
 * the URI is not under an `entities/<dir>/...` tree. Kind resolution (built-in vs
 * author) is then a directory lookup against the effective type registry.
 */
export function entityDirectoryForUri(uri: URI): string | undefined {
  const segments = uri.path.toString().split('/').filter(segment => segment.length > 0);
  const entitiesIndex = segments.lastIndexOf('entities');
  if (entitiesIndex < 0 || entitiesIndex + 1 >= segments.length) {
    return undefined;
  }
  return segments[entitiesIndex + 1];
}

/**
 * Resolve the effective entity type for a URI against a snapshot of the registry's
 * effective types (built-in + author). Returns `undefined` when the file's
 * directory matches no known type — the open handler uses this to decide whether
 * the form editor should claim the file.
 */
export function effectiveTypeForUri(uri: URI, types: readonly EffectiveEntityType[]): EffectiveEntityType | undefined {
  const directory = entityDirectoryForUri(uri);
  if (!directory) {
    return undefined;
  }
  return types.find(type => type.directory === directory);
}

function toLines(value: string[] | undefined): string {
  return Array.isArray(value) ? value.filter(item => typeof item === 'string').join('\n') : '';
}

function fromLines(value: string): string[] {
  return value
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);
}

function humanize(name: string): string {
  return name.length > 0 ? name.charAt(0).toUpperCase() + name.slice(1) : name;
}

/**
 * Form-based editor for narrative entity YAML files (FR-025). The file on disk
 * stays pure YAML: the widget parses through the `yaml` Document API so comments
 * and untouched keys survive a round-trip, and only edited (schema-owned) keys are
 * rewritten. Fields absent from the schema (author extras, artifact `ownership`,
 * …) are never touched on save and are surfaced read-only so writers know they
 * are preserved.
 */
@injectable()
export class EntityEditorWidget extends ReactWidget implements Navigatable {
  static readonly FACTORY_ID = 'ai-focused-editor.entity-editor';

  @inject(FileService)
  protected readonly fileService!: FileService;

  @inject(MessageService)
  protected readonly messageService!: MessageService;

  @inject(NarrativeEntityService)
  protected readonly entityService!: NarrativeEntityService;

  @inject(OpenerService)
  protected readonly openerService!: OpenerService;

  @inject(EntityTypeRegistryService)
  protected readonly typeRegistry!: EntityTypeRegistryService;

  protected readonly validator = new YamlSchemaValidator();

  /** Cached entity lookup for resolving `[[...]]` mentions (5s TTL). */
  protected mentionIndex = new Map<string, NarrativeEntity>();
  protected mentionIndexExpiresAt = 0;

  protected uri!: URI;
  /** The resolved effective type id (e.g. `character`, or an author id). */
  protected kind = 'character';
  /** The field schema currently rendered (from the effective descriptor). */
  protected fields: EntityFieldDescriptor[] = [];
  protected document: Document | undefined;
  /** Last parsed YAML value, kept so a live schema change can re-map the draft. */
  protected parsedValue: Record<string, unknown> = {};
  protected draft: EntityDraft = {};
  /** Top-level YAML keys not owned by the schema — preserved on save, shown read-only. */
  protected unknownKeys: string[] = [];
  protected loading = false;
  protected dirty = false;
  protected parseError: string | undefined;

  configure(uri: URI): void {
    this.uri = uri;
    this.applyDescriptor();
    this.id = `${EntityEditorWidget.FACTORY_ID}:${uri.toString()}`;
    this.title.label = uri.path.base;
    this.title.caption = nls.localize('ai-focused-editor/entities/editor-caption', 'Entity form: {0}', uri.path.fsPath());
    this.title.iconClass = 'fa fa-id-badge';
    this.title.closable = true;
    this.addClass('afe-entity-editor-widget');
    // Re-resolve the schema when the author edits entities/types.yaml so a file
    // that only just gained a type — or a type whose fields changed — re-renders.
    this.toDispose.push(this.typeRegistry.onDidChange(() => this.onRegistryChanged()));
    void this.load();
    void this.loadMentionIndex();
  }

  /** Resolve the effective descriptor for this file, defaulting to the character type. */
  protected resolveDescriptor(): EffectiveEntityType {
    const types = this.typeRegistry.getEffectiveTypes();
    return effectiveTypeForUri(this.uri, types)
      ?? types.find(type => type.id === 'character')
      ?? types[0];
  }

  /** Adopt the resolved descriptor's kind + field schema (no draft remap). */
  protected applyDescriptor(): void {
    const descriptor = this.resolveDescriptor();
    this.kind = descriptor.id;
    this.fields = [...descriptor.fields];
  }

  protected onRegistryChanged(): void {
    const previousNames = this.fields.map(field => field.name).join(',');
    this.applyDescriptor();
    if (this.fields.map(field => field.name).join(',') === previousNames) {
      return;
    }
    // Schema changed: rebuild the draft, preserving values the writer already
    // typed for fields that still exist, and re-deriving new fields from disk.
    this.draft = this.buildDraft(this.parsedValue, this.draft);
    this.unknownKeys = this.computeUnknownKeys(this.parsedValue);
    this.update();
  }

  /**
   * Refresh the entity lookup used to resolve `[[...]]` mentions. Cached for 5s
   * like the other manuscript widgets so typing does not spam the backend.
   */
  protected async loadMentionIndex(): Promise<void> {
    const now = Date.now();
    if (now < this.mentionIndexExpiresAt) {
      return;
    }
    this.mentionIndexExpiresAt = now + 5000;
    try {
      const snapshot = await this.entityService.getSnapshot();
      const index = new Map<string, NarrativeEntity>();
      for (const entity of snapshot.entities) {
        index.set(`${entity.kind}:${entity.id}`, entity);
        index.set(`${entity.kind === 'character' ? 'char' : entity.kind}:${entity.id}`, entity);
        const bareKey = `id:${entity.id}`;
        if (!index.has(bareKey)) {
          index.set(bareKey, entity);
        }
      }
      this.mentionIndex = index;
      this.update();
    } catch {
      // Keep the last known index when the knowledge base is unavailable.
    }
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
      const content = (await this.fileService.read(this.uri)).value;
      const document = parseDocument(content);
      this.parseError = document.errors.length > 0
        ? document.errors.map(error => error.message).join('; ')
        : undefined;
      this.document = document;
      const value = (document.toJS() ?? {}) as Record<string, unknown>;
      this.parsedValue = value;
      this.draft = this.buildDraft(value);
      this.unknownKeys = this.computeUnknownKeys(value);
    } catch (error) {
      this.document = undefined;
      this.parsedValue = {};
      this.draft = this.buildDraft({});
      this.unknownKeys = [];
      this.parseError = error instanceof Error ? error.message : String(error);
    } finally {
      this.loading = false;
      this.dirty = false;
      this.update();
    }
  }

  /**
   * Build a draft for the current schema from a parsed YAML value. When `preserve`
   * is given, values the writer already typed for still-present fields are kept
   * (used on a live schema change so unsaved edits are not clobbered).
   */
  protected buildDraft(value: Record<string, unknown>, preserve?: EntityDraft): EntityDraft {
    const asString = (input: unknown): string => (typeof input === 'string' ? input : '');
    const asArray = (input: unknown): string[] => Array.isArray(input)
      ? input.filter((item): item is string => typeof item === 'string')
      : [];
    const draft: EntityDraft = {};
    for (const field of this.fields) {
      if (preserve && field.name in preserve) {
        draft[field.name] = preserve[field.name];
        continue;
      }
      draft[field.name] = field.kind === 'list'
        ? toLines(asArray(value[field.name]))
        : asString(value[field.name]);
    }
    return draft;
  }

  /** Top-level YAML keys present on disk but not owned by the current schema. */
  protected computeUnknownKeys(value: Record<string, unknown>): string[] {
    const owned = new Set(this.fields.map(field => field.name));
    return Object.keys(value).filter(key => !owned.has(key));
  }

  protected updateField(field: string, value: string): void {
    this.draft = { ...this.draft, [field]: value };
    this.dirty = true;
    this.update();
  }

  protected toPlainObject(): Record<string, unknown> {
    const object: Record<string, unknown> = {};
    for (const field of this.fields) {
      const value = this.draft[field.name] ?? '';
      if (field.kind === 'list') {
        const items = fromLines(value);
        if (items.length > 0) {
          object[field.name] = items;
        }
      } else {
        const scalar = value.trim();
        if (scalar) {
          object[field.name] = scalar;
        }
      }
    }
    return object;
  }

  protected problems(): WorkspaceDiagnostic[] {
    if (!VALIDATED_KINDS.has(this.kind as DomainYamlSchemaKind)) {
      return [];
    }
    const uri = this.uri?.toString() ?? '';
    return this.validator.validate(this.kind as DomainYamlSchemaKind, uri, this.toPlainObject());
  }

  /**
   * Rewrite only the keys the schema owns, preserving comments and any other keys
   * (author extras, `ownership`, …) on the original document. Emptied fields are
   * removed so the YAML stays clean — mirrors the original per-key semantics.
   */
  protected serialize(): string {
    const document = this.document && this.document.contents != null
      ? this.document
      : new Document({});

    const setScalar = (key: string, value: string): void => {
      const trimmed = value.trim();
      if (trimmed) {
        document.set(key, trimmed);
      } else {
        document.delete(key);
      }
    };
    const setSequence = (key: string, value: string): void => {
      const items = fromLines(value);
      if (items.length > 0) {
        document.set(key, items);
      } else {
        document.delete(key);
      }
    };

    for (const field of this.fields) {
      const value = this.draft[field.name] ?? '';
      if (field.kind === 'list') {
        setSequence(field.name, value);
      } else {
        setScalar(field.name, value);
      }
    }

    return document.toString();
  }

  protected async save(): Promise<void> {
    try {
      const content = this.serialize();
      await this.fileService.write(this.uri, content);
      // Re-read so the in-memory document (and comments) reflect what was written.
      await this.load();
      await this.messageService.info(nls.localize('ai-focused-editor/entities/saved', 'Saved {0}.', this.uri.path.base));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.messageService.error(nls.localize('ai-focused-editor/entities/save-failed', 'Could not save entity: {0}', detail));
    }
  }

  protected render(): React.ReactNode {
    if (this.loading || !this.uri) {
      return React.createElement('div', { className: 'afe-entity-editor' }, nls.localize('ai-focused-editor/entities/loading', 'Loading entity...'));
    }

    const problems = this.problems();
    return React.createElement(
      'div',
      { className: 'afe-entity-editor' },
      React.createElement(
        'div',
        { className: 'afe-entity-editor-header' },
        React.createElement('h3', undefined, nls.localize('ai-focused-editor/entities/editor-heading', '{0} form', this.labelDisplay())),
        React.createElement('span', { className: 'afe-entity-editor-kind' }, this.kind)
      ),
      this.parseError
        ? React.createElement(
          'div',
          { className: 'afe-entity-editor-problem error' },
          nls.localize('ai-focused-editor/entities/parse-warning', 'YAML parse warning: {0}', this.parseError)
        )
        : undefined,
      this.renderProblems(problems),
      React.createElement(
        'form',
        {
          className: 'afe-entity-editor-form',
          onSubmit: (event: React.FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            void this.save();
          }
        },
        ...this.fields.map(field => this.renderField(field)),
        React.createElement(
          'div',
          { className: 'afe-entity-editor-actions' },
          React.createElement(
            'button',
            { className: 'theia-button main', type: 'submit' },
            this.dirty
              ? nls.localize('ai-focused-editor/entities/save-dirty', 'Save*')
              : nls.localize('ai-focused-editor/entities/save', 'Save')
          ),
          React.createElement(
            'button',
            {
              className: 'theia-button secondary',
              type: 'button',
              onClick: () => { void this.load(); }
            },
            nls.localize('ai-focused-editor/entities/reload-from-disk', 'Reload from disk')
          )
        )
      ),
      this.renderUnknownKeys(),
      React.createElement(
        'p',
        { className: 'afe-entity-editor-help' },
        nls.localize(
          'ai-focused-editor/entities/editor-help',
          'Saving writes pure YAML and preserves comments and unknown keys. Use "Open With..." to edit the raw file.'
        )
      )
    );
  }

  protected labelDisplay(): string {
    return this.kind.charAt(0).toUpperCase() + this.kind.slice(1);
  }

  /** Localised field label — the registry `labelKey` with the form's English default. */
  protected fieldLabel(field: EntityFieldDescriptor): string {
    return nls.localize(field.labelKey, LABEL_KEY_DEFAULTS[field.labelKey] ?? humanize(field.name));
  }

  /** Localised placeholder for a field, or `''` when the form has no hint for it. */
  protected fieldPlaceholder(field: EntityFieldDescriptor, label: string): string {
    if (field.role === 'label') {
      return nls.localize('ai-focused-editor/entities/ph-label', 'display {0}', label.toLowerCase());
    }
    const presentation = FIELD_PRESENTATION[field.name];
    return presentation ? nls.localize(presentation.placeholderKey, presentation.placeholderDefault) : '';
  }

  protected renderField(field: EntityFieldDescriptor): React.ReactNode {
    const label = this.fieldLabel(field);
    const placeholder = this.fieldPlaceholder(field, label);
    if (field.kind === 'text') {
      return this.renderInput(label, field.name, placeholder);
    }
    const rows = FIELD_PRESENTATION[field.name]?.rows ?? DEFAULT_TEXTAREA_ROWS;
    return this.renderTextarea(label, field.name, placeholder, rows);
  }

  protected renderProblems(problems: WorkspaceDiagnostic[]): React.ReactNode {
    if (problems.length === 0) {
      return undefined;
    }
    return React.createElement(
      'ul',
      { className: 'afe-entity-editor-problems' },
      ...problems.map((problem, index) => React.createElement(
        'li',
        { key: index, className: `afe-entity-editor-problem ${problem.severity}` },
        problem.message
      ))
    );
  }

  /**
   * Surface the top-level YAML keys the schema does not own as read-only chips so
   * the writer sees they exist and are preserved verbatim on save.
   */
  protected renderUnknownKeys(): React.ReactNode {
    if (this.unknownKeys.length === 0) {
      return undefined;
    }
    return React.createElement(
      'div',
      { className: 'afe-entity-editor-unknown' },
      React.createElement(
        'span',
        { className: 'afe-entity-editor-unknown-label' },
        nls.localize('ai-focused-editor/entities/preserved-fields', 'Preserved as-is:')
      ),
      ...this.unknownKeys.map((key, index) => React.createElement(
        'span',
        { key: index, className: 'afe-entity-editor-unknown-chip' },
        key
      ))
    );
  }

  protected renderInput(label: string, field: string, placeholder: string): React.ReactNode {
    return React.createElement(
      'label',
      { key: field, className: 'afe-entity-editor-field' },
      React.createElement('span', undefined, label),
      React.createElement('input', {
        value: this.draft[field] ?? '',
        placeholder,
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => this.updateField(field, event.currentTarget.value)
      })
    );
  }

  protected renderTextarea(label: string, field: string, placeholder: string, rows: number): React.ReactNode {
    return React.createElement(
      'label',
      { key: field, className: 'afe-entity-editor-field' },
      React.createElement('span', undefined, label),
      React.createElement('textarea', {
        value: this.draft[field] ?? '',
        placeholder,
        rows,
        onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => this.updateField(field, event.currentTarget.value)
      }),
      this.renderMentionsRow(this.draft[field] ?? '')
    );
  }

  /**
   * Below a multi-line field, surface any `[[...]]` mentions it contains as a
   * "Mentions:" chip row so writers can jump to the referenced entity YAML.
   */
  protected renderMentionsRow(text: string): React.ReactNode {
    const mentions = extractEntityMentions(text);
    if (mentions.length === 0) {
      return undefined;
    }
    return React.createElement(
      'div',
      { className: 'afe-entity-mentions-row' },
      React.createElement('span', { className: 'afe-entity-mentions-label' }, nls.localize('ai-focused-editor/entities/mentions-label', 'Mentions:')),
      ...mentions.map((mention, index) => this.renderMentionChip(mention, index))
    );
  }

  protected renderMentionChip(mention: EntityMention, index: number): React.ReactNode {
    const entity = this.resolveMention(mention);
    const display = mention.label ?? entity?.label ?? mention.id;
    if (!entity) {
      return React.createElement('span', {
        key: index,
        className: 'afe-entity-mention-chip unknown',
        title: nls.localize('ai-focused-editor/entities/unknown-entity', 'Unknown entity: {0}', `${mention.kind ? `${mention.kind}:` : ''}${mention.id}`)
      }, display);
    }
    return React.createElement('span', {
      key: index,
      className: 'afe-entity-mention-chip',
      title: nls.localize('ai-focused-editor/entities/open-entity', 'Open {0}: {1}', entity.kind, entity.label),
      role: 'link',
      tabIndex: 0,
      onClick: () => this.openMention(entity),
      onKeyDown: (event: React.KeyboardEvent) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          void this.openMention(entity);
        }
      }
    }, display);
  }

  protected resolveMention(mention: EntityMention): NarrativeEntity | undefined {
    return mention.kind
      ? this.mentionIndex.get(`${mention.kind}:${mention.id}`)
      : this.mentionIndex.get(`id:${mention.id}`);
  }

  protected async openMention(entity: NarrativeEntity): Promise<void> {
    await open(this.openerService, new URI(entity.uri));
  }
}
