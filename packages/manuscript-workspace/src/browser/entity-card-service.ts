/**
 * `EntityCardService` — the card's only door to the index (gh#47 WP-3).
 *
 * WHAT IS HERE AND WHAT IS DELIBERATELY NOT. This class issues RPC and nothing
 * else decides anything: every rule about what a card SHOWS lives in
 * `common/entity-card.ts`, which is pure and testable without a DOM. The split
 * is not tidiness — `src/browser/typography/` already needs its own test lane
 * because its bootstrap installs process-wide DOM globals, and a card whose
 * logic sat in the widget would repeat that shape.
 *
 * THE WIDGET NEVER READS THE WORKSPACE. gh#47's service boundary says the
 * frontend consumes a view model; the excerpt in it was read by the backend
 * under a hash check it alone can perform (architecture §5.4).
 */

import { inject, injectable } from '@theia/core/shared/inversify';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import {
  NarrativeKnowledgeService,
  type EffectiveEntityType,
  type IndexState,
  type NarrativeKnowledgeService as NarrativeKnowledgeServiceType
} from '@ai-focused-editor/narrative-knowledge';
import { buildEntityCard, type EntityCardViewModel } from '../common';

/**
 * What a request for a card produced.
 *
 * A UNION RATHER THAN `EntityCardViewModel | undefined`, because the three ways
 * to have no card are three different things to tell the author: no manuscript
 * is open; the index does not know this id; or the index knows nothing yet
 * because it is being rebuilt. Collapsing them to `undefined` is the silence the
 * envelope discipline exists to prevent — and `unknown-entity` carries the index
 * state precisely so the widget can tell "there is no such character" from "the
 * index has not finished".
 */
export type EntityCardResult =
  | { kind: 'card'; card: EntityCardViewModel }
  | { kind: 'no-workspace' }
  | { kind: 'unknown-entity'; entityId: string; indexState: IndexState };

/** How many recent appearances a card asks for by default. */
export const DEFAULT_RECENT_APPEARANCES = 5;

@injectable()
export class EntityCardService {
  @inject(NarrativeKnowledgeService)
  protected readonly knowledge!: NarrativeKnowledgeServiceType;

  @inject(WorkspaceService)
  protected readonly workspaceService!: WorkspaceService;

  /**
   * Assemble the card for `entityId`.
   *
   * ONE CALL FOR EVERYTHING ABOUT APPEARANCES. First, latest, the recent list
   * and the per-document spread are four views of the same rows, and a card
   * showing them together must not assemble them from two generations — see
   * `EntityAppearanceResult`. The entity itself and its relations are separate
   * questions and stay separate calls.
   *
   * A CARD FOR AN ENTITY THE INDEX DOES NOT KNOW IS NOT AN ERROR. An author can
   * write `[[char:someone]]` before creating the card; the panel says so, and
   * says whether the index is still building, rather than throwing.
   */
  async getCard(entityId: string, recentLimit = DEFAULT_RECENT_APPEARANCES): Promise<EntityCardResult> {
    const rootUri = this.workspaceService.tryGetRoots()[0]?.resource.toString();
    if (rootUri === undefined) {
      return { kind: 'no-workspace' };
    }
    const entityAnswer = await this.knowledge.getEntity(rootUri, entityId);
    const entity = entityAnswer.data;
    if (entity === undefined) {
      return { kind: 'unknown-entity', entityId, indexState: entityAnswer.state };
    }
    const [appearances, relations, registry] = await Promise.all([
      // ONE call, and that is the composite-response rule of the architecture
      // rather than a saving: the first appearance, the recent list and the
      // spread are three views of the same rows, and a card that shows them
      // side by side must not assemble them from two generations. The first
      // edition of this method issued an ascending call and a descending one,
      // which broke the rule this very task had just written down.
      this.knowledge.getEntityAppearances(rootUri, entityId, {
        direction: 'desc',
        limit: recentLimit,
        withExcerpt: true,
        withSpread: true,
        withFirst: true
      }),
      this.knowledge.getRelations(rootUri, { entityId, direction: 'either' }),
      this.knowledge.getEntityTypeRegistry(rootUri)
    ]);
    const descriptor = this.descriptorFor(entity.type, registry.data.types);
    return {
      kind: 'card',
      card: buildEntityCard({
        entity,
        ...(descriptor === undefined ? {} : { type: descriptor }),
        ...(appearances.data.first === undefined ? {} : { first: appearances.data.first }),
        descending: appearances.data.appearances,
        chapterSpread: appearances.data.spread ?? [],
        relations: relations.data,
        // The state of the APPEARANCE read, which is where first, latest and the
        // spread all come from — now provably one generation.
        indexState: appearances.state
      })
    };
  }

  /**
   * The registry descriptor for a type id, or `undefined`.
   *
   * LOOKED UP RATHER THAN ASSUMED, and never from a literal list: `character` is
   * one row of the registry, and `entities/types.yaml` lets an author add their
   * own kinds. A card that hard-coded the five built-in types would silently
   * lose its icon and label for every authored one.
   */
  protected descriptorFor(typeId: string, types: readonly EffectiveEntityType[]): EffectiveEntityType | undefined {
    return types.find(type => type.id === typeId);
  }
}
