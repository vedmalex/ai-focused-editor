import { parseSemanticMarkdown } from '@ai-focused-editor/semantic-markdown';
import { DisposableCollection } from '@theia/core/lib/common';
import { nls } from '@theia/core/lib/common/nls';
import URI from '@theia/core/lib/common/uri';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { inject, injectable } from '@theia/core/shared/inversify';
import * as monaco from '@theia/monaco-editor-core';
import {
  buildEntityHoverMarkdown,
  NarrativeEntityService,
  type EntityFieldDescriptor,
  type EntityTypeDescriptor,
  type NarrativeEntity
} from '../common';
import { parseBareEntityTags, tagKindToEntityKind } from '../common/link-navigation';
import { SemanticLinkCommands } from './semantic-link-contribution';
import { EntityTypeRegistryService } from './entity-type-registry-service';

const ENTITY_CACHE_TTL_MS = 5000;
const ENTITY_FIELD_LABEL_DEFAULTS: Record<string, string> = {
  'ai-focused-editor/entities/field-id': 'Id',
  'ai-focused-editor/entities/field-name': 'Name',
  'ai-focused-editor/entities/field-term': 'Term',
  'ai-focused-editor/entities/field-aliases': 'Aliases',
  'ai-focused-editor/entities/field-epithets': 'Epithets',
  'ai-focused-editor/entities/field-summary': 'Summary',
  'ai-focused-editor/entities/field-backstory': 'Backstory',
  'ai-focused-editor/entities/field-arc': 'Arc',
  'ai-focused-editor/entities/field-speech-patterns': 'Speech patterns',
  'ai-focused-editor/entities/field-notes': 'Notes'
};

/** A tag occurrence in the document, with its FULL `[[...]]` offset range. */
interface HoverTagMatch {
  kind?: string;
  id: string;
  label: string;
  startOffset: number;
  endOffset: number;
}

/**
 * Full entity-card hover for semantic tags. Registers a single Monaco hover
 * provider for `markdown` that — over the WHOLE `[[kind:id|label]]` tag (including
 * the label part, a UX gain over the link-only affordance) — resolves the entity,
 * reads its YAML card, and renders every schema field (author types included) plus
 * a clickable "open card" link through the pure {@link buildEntityHoverMarkdown}.
 *
 * This provider OWNS the hover content: the decoration service no longer sets a
 * `hoverMessage`, so the card preview and the navigation link are never duplicated.
 * Registered once as a {@link FrontendApplicationContribution}, mirroring
 * `SemanticLinkContribution`.
 */
@injectable()
export class SemanticEntityHoverContribution implements FrontendApplicationContribution {
  @inject(NarrativeEntityService)
  protected readonly narrativeEntities!: NarrativeEntityService;

  @inject(EntityTypeRegistryService)
  protected readonly entityTypeRegistry!: EntityTypeRegistryService;

  @inject(FileService)
  protected readonly fileService!: FileService;

  protected readonly toDispose = new DisposableCollection();
  protected cachedEntities: NarrativeEntity[] = [];
  protected cacheExpiresAt = 0;

  onStart(): void {
    this.toDispose.push(monaco.languages.registerHoverProvider(
      'markdown',
      { provideHover: (model, position) => this.provideHover(model, position) }
    ));
  }

  onStop(): void {
    this.toDispose.dispose();
  }

  protected async provideHover(
    model: monaco.editor.ITextModel,
    position: monaco.Position
  ): Promise<monaco.languages.Hover | undefined> {
    try {
      if (model.getLanguageId() !== 'markdown') {
        return undefined;
      }
      const text = model.getValue();
      const offset = model.getOffsetAt(position);
      const match = this.findTagAt(model, text, offset);
      if (!match) {
        return undefined;
      }

      const entities = await this.getEntities();
      const entity = this.resolveEntity(entities, match.kind, match.id);
      const descriptor = this.resolveDescriptor(match.kind, entity);
      const cardYaml = entity ? await this.readCard(entity.uri) : undefined;
      const openCommandUri = entity ? this.openCommandUri(entity.uri) : undefined;

      const value = buildEntityHoverMarkdown({
        cardYaml,
        descriptor,
        tagLabel: entity?.label ?? match.label,
        id: match.id,
        openCommandUri,
        localize: {
          fieldLabel: field => this.fieldLabel(field),
          typeLabel: type => this.typeLabel(type),
          openLabel: nls.localize('ai-focused-editor/editor/hover-open-card', 'Open card'),
          missingCardText: nls.localize('ai-focused-editor/editor/hover-missing-card', 'No card found for this tag yet.')
        }
      });

      const start = model.getPositionAt(match.startOffset);
      const end = model.getPositionAt(match.endOffset);
      return {
        range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
        contents: [{ value, isTrusted: true, supportHtml: false }]
      };
    } catch {
      // A hover must never throw — fail silently and let other providers answer.
      return undefined;
    }
  }

  /** Collect labeled and bare tags, returning the one whose full range spans `offset`. */
  protected findTagAt(
    model: monaco.editor.ITextModel,
    text: string,
    offset: number
  ): HoverTagMatch | undefined {
    for (const tag of parseSemanticMarkdown(text).tags) {
      const start = model.getOffsetAt({ lineNumber: tag.range.start.line + 1, column: tag.range.start.character + 1 });
      const end = model.getOffsetAt({ lineNumber: tag.range.end.line + 1, column: tag.range.end.character + 1 });
      if (offset >= start && offset <= end) {
        return { kind: tag.kind, id: tag.id, label: tag.label, startOffset: start, endOffset: end };
      }
    }
    for (const bare of parseBareEntityTags(text)) {
      if (offset >= bare.start && offset <= bare.end) {
        return { kind: bare.kind, id: bare.id, label: bare.id, startOffset: bare.start, endOffset: bare.end };
      }
    }
    return undefined;
  }

  protected resolveEntity(
    entities: NarrativeEntity[],
    kind: string | undefined,
    id: string
  ): NarrativeEntity | undefined {
    if (kind) {
      const entityKind = this.tagKindToEntityKind(kind);
      return entities.find(entity => entity.kind === entityKind && entity.id === id);
    }
    return entities.find(entity => entity.id === id);
  }

  /**
   * Resolve the type descriptor for the hover header/schema. Prefer the resolved
   * entity's kind; else map the tag kind through the effective registry; else fall
   * back to a minimal descriptor (an unknown/bare tag still gets a header line).
   */
  protected resolveDescriptor(
    kind: string | undefined,
    entity: NarrativeEntity | undefined
  ): EntityTypeDescriptor {
    const types = this.entityTypeRegistry.getEffectiveTypes();
    if (entity) {
      const byId = types.find(type => type.id === entity.kind);
      if (byId) {
        return byId;
      }
    }
    if (kind) {
      const byTag = types.find(type => type.tagKind === kind);
      if (byTag) {
        return byTag;
      }
    }
    return {
      id: kind ?? 'entity',
      tagKind: kind ?? 'entity',
      directory: kind ?? 'entity',
      label: kind ?? 'Entity',
      sectionKind: kind ?? 'entity',
      icon: '',
      sectionIcon: '',
      fields: []
    };
  }

  /** Map a tag kind to its entity kind via the effective type list (mirrors the link provider). */
  protected tagKindToEntityKind(tagKind: string): string {
    const descriptor = this.entityTypeRegistry.getEffectiveTypes().find(type => type.tagKind === tagKind);
    return descriptor?.id ?? tagKindToEntityKind(tagKind);
  }

  /** Localized field label — the registry `labelKey` with the form's English default. */
  protected fieldLabel(field: EntityFieldDescriptor): string {
    const fallback = ENTITY_FIELD_LABEL_DEFAULTS[field.labelKey]
      ?? (field.name.length > 0 ? field.name.charAt(0).toUpperCase() + field.name.slice(1) : field.name);
    return nls.localize(field.labelKey, fallback);
  }

  /** Localized type label; author types carry their author-declared `label` verbatim. */
  protected typeLabel(type: EntityTypeDescriptor): string {
    return type.label;
  }

  /** Mirror `SemanticLinkContribution.openTargetUri`: `command:openTarget?<encoded [uri]>`. */
  protected openCommandUri(uri: string): string {
    const args = encodeURIComponent(JSON.stringify([uri]));
    return `command:${SemanticLinkCommands.OPEN_TARGET.id}?${args}`;
  }

  protected async readCard(uri: string): Promise<string | undefined> {
    try {
      return (await this.fileService.read(new URI(uri))).value;
    } catch {
      return undefined;
    }
  }

  /** Refresh the 5s entity cache; kept warm so `provideHover` stays snappy. */
  protected async getEntities(): Promise<NarrativeEntity[]> {
    const now = Date.now();
    if (now < this.cacheExpiresAt) {
      return this.cachedEntities;
    }
    try {
      const snapshot = await this.narrativeEntities.getSnapshot();
      this.cachedEntities = snapshot.entities;
    } catch {
      // Keep the previous cache if the snapshot RPC fails.
    }
    this.cacheExpiresAt = now + ENTITY_CACHE_TTL_MS;
    return this.cachedEntities;
  }
}
