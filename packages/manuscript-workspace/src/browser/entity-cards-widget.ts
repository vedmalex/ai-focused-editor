import URI from '@theia/core/lib/common/uri';
import {
  open,
  OpenerService
} from '@theia/core/lib/browser';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { nls } from '@theia/core/lib/common/nls';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import {
  inject,
  injectable,
  postConstruct
} from '@theia/core/shared/inversify';
import React from '@theia/core/shared/react';
import {
  NarrativeKnowledgeService,
  type NarrativeEntity,
  type NarrativeKnowledgeService as NarrativeKnowledgeServiceType
} from '@ai-focused-editor/narrative-knowledge';
import {
  EntityMention,
  WorkspaceDiagnostic,
  splitEntityMentions
} from '../common';

/**
 * The two things this widget renders that `NarrativeEntity` alone does not
 * carry (TASK-022 WP-7): `diagnostics` come from `getEntityTypeRegistry`'s
 * `typeProblems`, exactly as they did through the pre-migration
 * `NarrativeEntitySnapshot`. Per-card and per-directory read diagnostics
 * (malformed YAML, a missing entity directory) are NOT reproduced here — see
 * `NodeNarrativeEntityService`'s doc comment for the same, deliberate,
 * recorded gap; there is no cheap index query for them yet.
 */
interface EntityCardsSnapshot {
  entities: NarrativeEntity[];
  diagnostics: WorkspaceDiagnostic[];
}

@injectable()
export class EntityCardsWidget extends ReactWidget {
  static readonly ID = 'ai-focused-editor.entity-cards';
  static readonly LABEL = 'Knowledge Cards';

  @inject(NarrativeKnowledgeService)
  protected readonly knowledge!: NarrativeKnowledgeServiceType;

  @inject(WorkspaceService)
  protected readonly workspaceService!: WorkspaceService;

  @inject(OpenerService)
  protected readonly openerService!: OpenerService;

  protected snapshot: EntityCardsSnapshot | undefined;
  /** Lookup for resolving `[[kind:id|label]]` / `[[id]]` mentions to entities. */
  protected mentionIndex = new Map<string, NarrativeEntity>();
  /** The workspace root the last snapshot was fetched for — needed to derive a
   *  navigable URI from `entity.sourcePath` (TECH_SPEC WP-7 §4: `sourceUri` is
   *  stale after a rename in both store adapters, so it is never read here). */
  protected rootUri: URI | undefined;

  @postConstruct()
  protected init(): void {
    this.id = EntityCardsWidget.ID;
    this.title.label = nls.localize('ai-focused-editor/entities/cards-title', EntityCardsWidget.LABEL);
    this.title.caption = nls.localize('ai-focused-editor/entities/cards-caption', 'AI Focused Editor character and term cards');
    this.title.iconClass = 'fa fa-address-card';
    this.title.closable = true;
    this.addClass('afe-entity-cards-widget');
    void this.refresh();
  }

  async refresh(): Promise<void> {
    const rootUri = await this.getRootUri();
    if (!rootUri) {
      this.rootUri = undefined;
      this.snapshot = {
        entities: [],
        diagnostics: [{
          severity: 'info',
          source: 'narrative-entities',
          message: 'Open a manuscript workspace to view entity cards.'
        }]
      };
      this.update();
      return;
    }
    this.rootUri = new URI(rootUri);
    const [entitiesEnvelope, registryEnvelope] = await Promise.all([
      this.knowledge.findEntities(rootUri),
      this.knowledge.getEntityTypeRegistry(rootUri)
    ]);
    this.snapshot = {
      entities: entitiesEnvelope.data,
      diagnostics: registryEnvelope.data.problems.map(problem => ({
        severity: 'warning' as const,
        source: 'entity-types',
        message: `entities/types.yaml: ${problem.message}`
      }))
    };
    this.update();
  }

  protected async getRootUri(): Promise<string | undefined> {
    await this.workspaceService.ready;
    const root = this.workspaceService.tryGetRoots()[0] ?? (await this.workspaceService.roots)[0];
    return root?.resource.toString();
  }

  protected render(): React.ReactNode {
    const snapshot = this.snapshot;
    if (!snapshot) {
      return React.createElement('div', { className: 'afe-entity-cards' }, nls.localize('ai-focused-editor/entities/loading-cards', 'Loading knowledge cards...'));
    }

    this.mentionIndex = this.buildMentionIndex(snapshot);
    const characters = snapshot.entities.filter(entity => entity.type === 'character');
    const terms = snapshot.entities.filter(entity => entity.type === 'term');
    const artifacts = snapshot.entities.filter(entity => entity.type === 'artifact');
    const locations = snapshot.entities.filter(entity => entity.type === 'location');

    return React.createElement(
      'div',
      { className: 'afe-entity-cards' },
      React.createElement(
        'div',
        { className: 'afe-entity-cards-header' },
        React.createElement('h3', undefined, nls.localize('ai-focused-editor/entities/cards-title', 'Knowledge Cards')),
        React.createElement(
          'button',
          {
            className: 'theia-button secondary',
            onClick: () => this.refresh()
          },
          nls.localize('ai-focused-editor/entities/refresh', 'Refresh')
        )
      ),
      this.renderDiagnostics(snapshot),
      this.renderEntityGroup(nls.localize('ai-focused-editor/entities/group-characters', 'Characters'), 'character', characters),
      this.renderEntityGroup(nls.localize('ai-focused-editor/entities/group-artifacts', 'Artifacts'), 'artifact', artifacts),
      this.renderEntityGroup(nls.localize('ai-focused-editor/entities/group-locations', 'Locations'), 'location', locations),
      this.renderEntityGroup(nls.localize('ai-focused-editor/entities/group-terms', 'Terms'), 'term', terms)
    );
  }

  protected renderDiagnostics(snapshot: EntityCardsSnapshot): React.ReactNode {
    if (snapshot.diagnostics.length === 0) {
      return undefined;
    }

    return React.createElement(
      'div',
      { className: 'afe-entity-cards-diagnostics' },
      ...snapshot.diagnostics.map((diagnostic, index) => React.createElement(
        'div',
        {
          key: `${diagnostic.source}-${index}`,
          className: `afe-entity-cards-diagnostic ${diagnostic.severity}`
        },
        `${diagnostic.severity}: ${diagnostic.message}`
      ))
    );
  }

  protected renderEntityGroup(
    title: string,
    kind: string,
    entities: NarrativeEntity[]
  ): React.ReactNode {
    return React.createElement(
      'section',
      { className: `afe-entity-group ${kind}` },
      React.createElement('h4', undefined, `${title} (${entities.length})`),
      entities.length === 0
        ? React.createElement('p', { className: 'afe-empty-state' }, nls.localize('ai-focused-editor/entities/no-entities', 'No {0} entities found.', kind))
        : React.createElement(
          'div',
          { className: 'afe-entity-card-list' },
          ...entities.map(entity => this.renderEntityCard(entity))
        )
    );
  }

  protected renderEntityCard(entity: NarrativeEntity): React.ReactNode {
    const epithets = entity.epithets ?? [];
    const speechPatterns = entity.speechPatterns ?? [];
    return React.createElement(
      'article',
      {
        // `entity.id` rather than `entity.sourceUri`: the id is stable across a
        // rename, `sourceUri` is not (TECH_SPEC WP-7 §4).
        key: entity.id,
        className: `afe-entity-card ${entity.type}`
      },
      React.createElement(
        'div',
        { className: 'afe-entity-card-title' },
        React.createElement('strong', undefined, entity.name),
        React.createElement('span', { className: 'afe-entity-kind' }, entity.type)
      ),
      React.createElement('div', { className: 'afe-entity-id' }, entity.id),
      entity.aliases.length > 0
        ? React.createElement('div', { className: 'afe-entity-aliases' }, nls.localize('ai-focused-editor/entities/aliases-line', 'Aliases: {0}', entity.aliases.join(', ')))
        : undefined,
      epithets.length > 0
        ? React.createElement('div', { className: 'afe-entity-epithets' }, nls.localize('ai-focused-editor/entities/epithets-line', 'Epithets: {0}', epithets.join(', ')))
        : undefined,
      entity.summary
        ? React.createElement('p', { className: 'afe-entity-summary' }, ...this.renderMentionText(entity.summary, `${entity.id}-summary`))
        : undefined,
      entity.arc
        ? React.createElement(
          'div',
          { className: 'afe-entity-arc' },
          React.createElement('span', { className: 'afe-entity-field-label' }, nls.localize('ai-focused-editor/entities/arc-label', 'Arc: ')),
          ...this.renderMentionText(entity.arc, `${entity.id}-arc`)
        )
        : undefined,
      speechPatterns.length > 0
        ? this.renderCollapsible(nls.localize('ai-focused-editor/entities/field-speech-patterns', 'Speech patterns'), React.createElement(
          'ul',
          { className: 'afe-entity-speech-list' },
          ...speechPatterns.map((pattern, index) => React.createElement('li', { key: index }, pattern))
        ))
        : undefined,
      entity.backstory
        ? this.renderCollapsible(nls.localize('ai-focused-editor/entities/field-backstory', 'Backstory'), React.createElement('p', { className: 'afe-entity-backstory' }, ...this.renderMentionText(entity.backstory, `${entity.id}-backstory`)))
        : undefined,
      entity.notes
        ? this.renderCollapsible(nls.localize('ai-focused-editor/entities/field-notes', 'Notes'), React.createElement('p', { className: 'afe-entity-notes' }, ...this.renderMentionText(entity.notes, `${entity.id}-notes`)))
        : undefined,
      React.createElement('code', { className: 'afe-entity-path' }, entity.sourcePath),
      React.createElement(
        'button',
        {
          className: 'theia-button',
          onClick: () => this.openEntity(entity)
        },
        nls.localize('ai-focused-editor/entities/open-yaml', 'Open YAML')
      )
    );
  }

  /**
   * Keep long-form fields (backstory, speech patterns, notes) out of the way so
   * the card stays scannable; writers expand only what they need.
   */
  protected renderCollapsible(label: string, body: React.ReactNode): React.ReactNode {
    return React.createElement(
      'details',
      { className: 'afe-entity-details' },
      React.createElement('summary', undefined, label),
      body
    );
  }

  /**
   * Index every entity under both its real `kind:id` and the `char` shorthand,
   * plus a bare `id:` key so `[[id]]` fallbacks resolve to the first match.
   */
  protected buildMentionIndex(snapshot: EntityCardsSnapshot): Map<string, NarrativeEntity> {
    const index = new Map<string, NarrativeEntity>();
    for (const entity of snapshot.entities) {
      index.set(`${entity.type}:${entity.id}`, entity);
      index.set(`${this.toTagKind(entity.type)}:${entity.id}`, entity);
      const bareKey = `id:${entity.id}`;
      if (!index.has(bareKey)) {
        index.set(bareKey, entity);
      }
    }
    return index;
  }

  protected toTagKind(kind: string): string {
    return kind === 'character' ? 'char' : kind;
  }

  protected resolveMention(mention: EntityMention): NarrativeEntity | undefined {
    return mention.kind
      ? this.mentionIndex.get(`${mention.kind}:${mention.id}`)
      : this.mentionIndex.get(`id:${mention.id}`);
  }

  /**
   * Render a text field, turning `[[...]]` mentions into clickable spans that
   * open the referenced entity's YAML; unknown ids stay plain text with a hint.
   */
  protected renderMentionText(text: string, keyPrefix: string): React.ReactNode[] {
    return splitEntityMentions(text).map((segment, index) => {
      if (segment.type === 'text') {
        return segment.value;
      }
      const { mention } = segment;
      const entity = this.resolveMention(mention);
      const display = mention.label ?? entity?.name ?? mention.id;
      const key = `${keyPrefix}-${index}`;
      if (!entity) {
        return React.createElement('span', {
          key,
          className: 'afe-entity-mention unknown',
          title: nls.localize('ai-focused-editor/entities/unknown-entity', 'Unknown entity: {0}', `${mention.kind ? `${mention.kind}:` : ''}${mention.id}`)
        }, display);
      }
      return React.createElement('span', {
        key,
        className: 'afe-entity-mention',
        title: nls.localize('ai-focused-editor/entities/open-entity', 'Open {0}: {1}', entity.type, entity.name),
        role: 'link',
        tabIndex: 0,
        onClick: () => this.openEntity(entity),
        onKeyDown: (event: React.KeyboardEvent) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            void this.openEntity(entity);
          }
        }
      }, display);
    });
  }

  /**
   * Navigate to the card's YAML file.
   *
   * DERIVED FROM `sourcePath` + workspace root, NEVER FROM `entity.sourceUri`
   * (TECH_SPEC WP-7 §4). `sourceUri` is a known-stale field after a rename in
   * both store adapters — neither repairs it on `moveDocument` — and the two
   * existing consumers that navigate off the index (`narrative-memory-tool-answers.ts`,
   * `narrative-memory-markers.ts`) already made this same call for the same
   * reason; this widget follows the same rule rather than inventing a second one.
   */
  protected async openEntity(entity: NarrativeEntity): Promise<void> {
    if (!this.rootUri) {
      return;
    }
    await open(this.openerService, this.rootUri.resolve(entity.sourcePath));
  }
}
