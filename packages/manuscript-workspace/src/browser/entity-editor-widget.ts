import URI from '@theia/core/lib/common/uri';
import { MessageService } from '@theia/core/lib/common';
import {
  Navigatable,
  open,
  OpenerService
} from '@theia/core/lib/browser';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import {
  inject,
  injectable
} from '@theia/core/shared/inversify';
import React from '@theia/core/shared/react';
import { Document, parseDocument } from 'yaml';
import type { EntityMention, NarrativeEntity, NarrativeEntityKind, WorkspaceDiagnostic } from '../common';
import {
  DomainYamlSchemaKind,
  extractEntityMentions,
  NarrativeEntityService,
  YamlSchemaValidator
} from '../common';

interface EntityDraft {
  id: string;
  label: string;
  aliases: string;
  epithets: string;
  summary: string;
  backstory: string;
  arc: string;
  speechPatterns: string;
  notes: string;
}

const EMPTY_DRAFT: EntityDraft = {
  id: '',
  label: '',
  aliases: '',
  epithets: '',
  summary: '',
  backstory: '',
  arc: '',
  speechPatterns: '',
  notes: ''
};

/** Sub-directory under `entities/` mapped to its entity kind and label key. */
const ENTITY_KIND_BY_DIRECTORY: Record<string, { kind: NarrativeEntityKind; labelKey: 'name' | 'term'; labelText: string }> = {
  characters: { kind: 'character', labelKey: 'name', labelText: 'Name' },
  artifacts: { kind: 'artifact', labelKey: 'name', labelText: 'Name' },
  locations: { kind: 'location', labelKey: 'name', labelText: 'Name' },
  terms: { kind: 'term', labelKey: 'term', labelText: 'Term' }
};

export function entityDescriptorForUri(uri: URI): { kind: NarrativeEntityKind; labelKey: 'name' | 'term'; labelText: string } | undefined {
  const segments = uri.path.toString().split('/').filter(segment => segment.length > 0);
  const entitiesIndex = segments.lastIndexOf('entities');
  if (entitiesIndex < 0 || entitiesIndex + 1 >= segments.length) {
    return undefined;
  }
  return ENTITY_KIND_BY_DIRECTORY[segments[entitiesIndex + 1]];
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

/**
 * Form-based editor for narrative entity YAML files (FR-025). The file on disk
 * stays pure YAML: the widget parses through the `yaml` Document API so comments
 * and untouched keys survive a round-trip, and only edited keys are rewritten.
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

  protected readonly validator = new YamlSchemaValidator();

  /** Cached entity lookup for resolving `[[...]]` mentions (5s TTL). */
  protected mentionIndex = new Map<string, NarrativeEntity>();
  protected mentionIndexExpiresAt = 0;

  protected uri!: URI;
  protected kind: NarrativeEntityKind = 'character';
  protected labelKey: 'name' | 'term' = 'name';
  protected labelText = 'Name';
  protected document: Document | undefined;
  protected draft: EntityDraft = { ...EMPTY_DRAFT };
  protected loading = false;
  protected dirty = false;
  protected parseError: string | undefined;

  configure(uri: URI): void {
    this.uri = uri;
    const descriptor = entityDescriptorForUri(uri) ?? ENTITY_KIND_BY_DIRECTORY.characters;
    this.kind = descriptor.kind;
    this.labelKey = descriptor.labelKey;
    this.labelText = descriptor.labelText;
    this.id = `${EntityEditorWidget.FACTORY_ID}:${uri.toString()}`;
    this.title.label = uri.path.base;
    this.title.caption = `Entity form: ${uri.path.fsPath()}`;
    this.title.iconClass = 'fa fa-id-badge';
    this.title.closable = true;
    this.addClass('afe-entity-editor-widget');
    void this.load();
    void this.loadMentionIndex();
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
      this.draft = this.toDraft(value);
    } catch (error) {
      this.document = undefined;
      this.draft = { ...EMPTY_DRAFT };
      this.parseError = error instanceof Error ? error.message : String(error);
    } finally {
      this.loading = false;
      this.dirty = false;
      this.update();
    }
  }

  protected toDraft(value: Record<string, unknown>): EntityDraft {
    const asString = (input: unknown): string => (typeof input === 'string' ? input : '');
    const asArray = (input: unknown): string[] => Array.isArray(input)
      ? input.filter((item): item is string => typeof item === 'string')
      : [];
    return {
      id: asString(value.id),
      label: asString(value[this.labelKey]),
      aliases: toLines(asArray(value.aliases)),
      epithets: toLines(asArray(value.epithets)),
      summary: asString(value.summary),
      backstory: asString(value.backstory),
      arc: asString(value.arc),
      speechPatterns: toLines(asArray(value.speechPatterns)),
      notes: asString(value.notes)
    };
  }

  protected updateField(field: keyof EntityDraft, value: string): void {
    this.draft = { ...this.draft, [field]: value };
    this.dirty = true;
    this.update();
  }

  protected toPlainObject(): Record<string, unknown> {
    const object: Record<string, unknown> = {};
    const id = this.draft.id.trim();
    const label = this.draft.label.trim();
    if (id) {
      object.id = id;
    }
    if (label) {
      object[this.labelKey] = label;
    }
    const aliases = fromLines(this.draft.aliases);
    if (aliases.length > 0) {
      object.aliases = aliases;
    }
    const epithets = fromLines(this.draft.epithets);
    if (epithets.length > 0) {
      object.epithets = epithets;
    }
    for (const key of ['summary', 'backstory', 'arc', 'notes'] as const) {
      const scalar = this.draft[key].trim();
      if (scalar) {
        object[key] = scalar;
      }
    }
    const speechPatterns = fromLines(this.draft.speechPatterns);
    if (speechPatterns.length > 0) {
      object.speechPatterns = speechPatterns;
    }
    return object;
  }

  protected problems(): WorkspaceDiagnostic[] {
    const uri = this.uri?.toString() ?? '';
    return this.validator.validate(this.kind as DomainYamlSchemaKind, uri, this.toPlainObject());
  }

  /**
   * Rewrite only the keys the form owns, preserving comments and any other keys
   * on the original document. Emptied fields are removed so the YAML stays clean.
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

    setScalar('id', this.draft.id);
    setScalar(this.labelKey, this.draft.label);
    setSequence('aliases', this.draft.aliases);
    setSequence('epithets', this.draft.epithets);
    setScalar('summary', this.draft.summary);
    setScalar('backstory', this.draft.backstory);
    setScalar('arc', this.draft.arc);
    setSequence('speechPatterns', this.draft.speechPatterns);
    setScalar('notes', this.draft.notes);

    return document.toString();
  }

  protected async save(): Promise<void> {
    try {
      const content = this.serialize();
      await this.fileService.write(this.uri, content);
      // Re-read so the in-memory document (and comments) reflect what was written.
      await this.load();
      await this.messageService.info(`Saved ${this.uri.path.base}.`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.messageService.error(`Could not save entity: ${detail}`);
    }
  }

  protected render(): React.ReactNode {
    if (this.loading || !this.uri) {
      return React.createElement('div', { className: 'afe-entity-editor' }, 'Loading entity...');
    }

    const problems = this.problems();
    return React.createElement(
      'div',
      { className: 'afe-entity-editor' },
      React.createElement(
        'div',
        { className: 'afe-entity-editor-header' },
        React.createElement('h3', undefined, `${this.labelDisplay()} form`),
        React.createElement('span', { className: 'afe-entity-editor-kind' }, this.kind)
      ),
      this.parseError
        ? React.createElement(
          'div',
          { className: 'afe-entity-editor-problem error' },
          `YAML parse warning: ${this.parseError}`
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
        this.renderInput('Id', 'id', 'stable identifier, e.g. krishna'),
        this.renderInput(this.labelText, 'label', `display ${this.labelText.toLowerCase()}`),
        this.renderTextarea('Aliases', 'aliases', 'one alias per line', 3),
        this.renderTextarea('Epithets', 'epithets', 'one epithet per line', 3),
        this.renderTextarea('Summary', 'summary', 'short one-line summary', 2),
        this.renderTextarea('Backstory', 'backstory', 'longer history behind the entity', 4),
        this.renderTextarea('Arc', 'arc', 'how the entity changes across the manuscript', 2),
        this.renderTextarea('Speech patterns', 'speechPatterns', 'one trait per line', 3),
        this.renderTextarea('Notes', 'notes', 'free-form authoring notes', 3),
        React.createElement(
          'div',
          { className: 'afe-entity-editor-actions' },
          React.createElement(
            'button',
            { className: 'theia-button main', type: 'submit' },
            this.dirty ? 'Save*' : 'Save'
          ),
          React.createElement(
            'button',
            {
              className: 'theia-button secondary',
              type: 'button',
              onClick: () => { void this.load(); }
            },
            'Reload from disk'
          )
        )
      ),
      React.createElement(
        'p',
        { className: 'afe-entity-editor-help' },
        'Saving writes pure YAML and preserves comments and unknown keys. Use "Open With..." to edit the raw file.'
      )
    );
  }

  protected labelDisplay(): string {
    return this.kind.charAt(0).toUpperCase() + this.kind.slice(1);
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

  protected renderInput(label: string, field: keyof EntityDraft, placeholder: string): React.ReactNode {
    return React.createElement(
      'label',
      { className: 'afe-entity-editor-field' },
      React.createElement('span', undefined, label),
      React.createElement('input', {
        value: this.draft[field],
        placeholder,
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => this.updateField(field, event.currentTarget.value)
      })
    );
  }

  protected renderTextarea(label: string, field: keyof EntityDraft, placeholder: string, rows: number): React.ReactNode {
    return React.createElement(
      'label',
      { className: 'afe-entity-editor-field' },
      React.createElement('span', undefined, label),
      React.createElement('textarea', {
        value: this.draft[field],
        placeholder,
        rows,
        onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => this.updateField(field, event.currentTarget.value)
      }),
      this.renderMentionsRow(this.draft[field])
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
      React.createElement('span', { className: 'afe-entity-mentions-label' }, 'Mentions:'),
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
        title: `Unknown entity: ${mention.kind ? `${mention.kind}:` : ''}${mention.id}`
      }, display);
    }
    return React.createElement('span', {
      key: index,
      className: 'afe-entity-mention-chip',
      title: `Open ${entity.kind}: ${entity.label}`,
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
