import { inject, injectable } from '@theia/core/shared/inversify';
import URI from '@theia/core/lib/common/uri';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import type { ToolProvider, ToolRequest } from '@theia/ai-core';
import {
  NARRATIVE_DOCUMENT_CONTEXT_TOOL_ID,
  NARRATIVE_ENTITY_APPEARANCES_TOOL_ID,
  NARRATIVE_ENTITY_RELATIONS_TOOL_ID,
  NARRATIVE_FIND_ENTITIES_TOOL_ID,
  NARRATIVE_FIND_MENTIONS_TOOL_ID,
  NARRATIVE_TOOL_PHRASE_KEYS,
  NarrativeKnowledgeService,
  type NarrativeContextOptions,
  type NarrativeContextSection,
  type NarrativeOrigin,
  type RelationDirection
} from '../common';
import {
  narrativeDocumentContextAnswer,
  narrativeEntityAppearancesAnswer,
  narrativeMissingEntityIdAnswer,
  narrativeEntityRelationsAnswer,
  narrativeFindEntitiesAnswer,
  narrativeFindMentionsAnswer,
  narrativeNoWorkspaceAnswer,
  type NarrativeToolAnswer
} from './narrative-memory-tool-answers';
import { localizeNarrativeMemoryKey } from './narrative-memory-render';

/**
 * The four read-only AI tools over the narrative index (TASK-022 WP-6).
 *
 * NOTHING IS DECIDED IN THIS FILE. Which of the four answers a state produces is
 * `narrativeToolIndexReport` in `src/common`; what an answer contains and how it
 * points at a file is `narrative-memory-tool-answers.ts`; what a sentence says
 * is the ru bundle WP-5 built. What is left here is argument parsing, one RPC
 * call, and a `JSON.stringify` — deliberately, because this file cannot be
 * instantiated under `bun` (it pulls `inversify` and `@theia/ai-core`) and every
 * line of judgement inside it would be a line nothing checks. Same split, same
 * reason, as `narrative-memory-contribution.ts` against
 * `narrative-memory-markers.ts`.
 *
 * READ-ONLY, AND THAT IS AD-4's BOUNDARY. No tool here creates, edits or deletes
 * anything; the writing tools and their provenance discipline are WP-8's
 * (UR-008). None of these carries `confirmAlwaysAllow` for the same reason — a
 * query has nothing to confirm.
 *
 * THE IDS ARE PREFIXED `narrative_`, NOT `manuscript_`. Both sets live in ONE
 * `ToolInvocationRegistry` for the whole of WP-7, and a colliding id there is
 * not a compile error — it is one provider silently shadowing another in a Map.
 */

/** Everything the four providers share: a workspace root and a JSON envelope. */
@injectable()
export abstract class NarrativeMemoryTool implements ToolProvider {
  @inject(NarrativeKnowledgeService)
  protected readonly service!: NarrativeKnowledgeService;

  @inject(WorkspaceService)
  protected readonly workspaceService!: WorkspaceService;

  abstract getTool(): ToolRequest;

  /** The first workspace root, or `undefined` when nothing is open. */
  protected async rootUri(): Promise<string | undefined> {
    await this.workspaceService.ready;
    const root =
      this.workspaceService.tryGetRoots()[0] ?? (await this.workspaceService.roots)[0];
    return root?.resource.toString();
  }

  /**
   * Parse the model's argument string.
   *
   * A NON-OBJECT OR UNPARSEABLE VALUE BECOMES `{}`, never a throw. Every
   * parameter of every tool here is optional except one, so an empty object is
   * always a legal call; turning a malformed argument string into an exception
   * would hand the model an error to paraphrase instead of an answer to read.
   */
  protected parseArgs(argString: string): Record<string, unknown> {
    try {
      const parsed: unknown = JSON.parse(argString || '{}');
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }

  /**
   * Run `body` against the workspace root, or answer that none is open.
   *
   * ALSO THE ONE PLACE A THROWN RPC ERROR IS TURNED INTO AN ANSWER. A backend
   * that is not reachable is not an index failure — inventing a `failed` state
   * for it would put a failure code on screen no backend ever produced — so the
   * honest report is the one the index last had nothing to say about: absent,
   * unanswered, with the no-manuscript sentence.
   */
  protected async answer(
    body: (rootUri: string) => Promise<NarrativeToolAnswer>
  ): Promise<string> {
    const rootUri = await this.rootUri();
    if (rootUri === undefined) {
      return JSON.stringify(narrativeNoWorkspaceAnswer());
    }
    try {
      return JSON.stringify(await body(rootUri));
    } catch {
      return JSON.stringify(narrativeNoWorkspaceAnswer());
    }
  }

  protected localized(id: keyof typeof NARRATIVE_TOOL_PHRASE_KEYS): {
    name: string;
    description: string;
  } {
    const keys = NARRATIVE_TOOL_PHRASE_KEYS[id];
    return {
      name: localizeNarrativeMemoryKey(keys.name),
      description: localizeNarrativeMemoryKey(keys.description)
    };
  }

  /** Read an optional string argument, treating an empty string as absent. */
  protected str(args: Record<string, unknown>, key: string): string | undefined {
    const value = args[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }

  protected bool(args: Record<string, unknown>, key: string): boolean | undefined {
    const value = args[key];
    return typeof value === 'boolean' ? value : undefined;
  }

  protected num(args: Record<string, unknown>, key: string): number | undefined {
    const value = args[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }
}

/** Search entity cards. */
@injectable()
export class NarrativeFindEntitiesTool extends NarrativeMemoryTool {
  static readonly ID = NARRATIVE_FIND_ENTITIES_TOOL_ID;

  getTool(): ToolRequest {
    return {
      id: NarrativeFindEntitiesTool.ID,
      ...this.localized(NARRATIVE_FIND_ENTITIES_TOOL_ID),
      parameters: {
        type: 'object',
        properties: {
          namePrefix: {
            type: 'string',
            description:
              'Case-insensitive PREFIX of the name or of an alias. Not a substring match. Omit to return every entity.'
          },
          type: {
            type: 'string',
            description:
              'Entity type id, e.g. character, term, artifact, location, or any type this book declares. Omit for all types.'
          },
          origin: {
            type: 'string',
            description:
              'Filter by provenance: explicit (the author wrote it), derived (the index computed it), ai-candidate (an agent proposed it).'
          },
          limit: { type: 'number', description: 'Maximum number of entities to return.' }
        },
        required: []
      },
      handler: async (argString: string) => {
        const args = this.parseArgs(argString);
        return this.answer(async rootUri =>
          narrativeFindEntitiesAnswer(
            rootUri,
            await this.service.findEntities(rootUri, {
              ...(this.str(args, 'namePrefix') === undefined
                ? {}
                : { namePrefix: this.str(args, 'namePrefix') }),
              ...(this.str(args, 'type') === undefined ? {} : { type: this.str(args, 'type') }),
              ...(this.str(args, 'origin') === undefined
                ? {}
                : { origin: this.str(args, 'origin') as NarrativeOrigin }),
              ...(this.num(args, 'limit') === undefined ? {} : { limit: this.num(args, 'limit') })
            })
          )
        );
      }
    };
  }
}

/** List references to an entity, or every reference in one document. */
@injectable()
export class NarrativeFindMentionsTool extends NarrativeMemoryTool {
  static readonly ID = NARRATIVE_FIND_MENTIONS_TOOL_ID;

  getTool(): ToolRequest {
    return {
      id: NarrativeFindMentionsTool.ID,
      ...this.localized(NARRATIVE_FIND_MENTIONS_TOOL_ID),
      parameters: {
        type: 'object',
        properties: {
          entityId: { type: 'string', description: 'Restrict to references to this entity id.' },
          path: {
            type: 'string',
            description: 'Workspace-relative path; restrict to references inside this document.'
          },
          brokenOnly: {
            type: 'boolean',
            description: 'Only references naming an entity no card defines.'
          }
        },
        required: []
      },
      handler: async (argString: string) => {
        const args = this.parseArgs(argString);
        return this.answer(async rootUri =>
          narrativeFindMentionsAnswer(
            rootUri,
            await this.service.getMentions(rootUri, {
              ...(this.str(args, 'entityId') === undefined
                ? {}
                : { entityId: this.str(args, 'entityId') }),
              ...(this.str(args, 'path') === undefined ? {} : { relPath: this.str(args, 'path') }),
              ...(this.bool(args, 'brokenOnly') === undefined
                ? {}
                : { brokenOnly: this.bool(args, 'brokenOnly') })
            })
          )
        );
      }
    };
  }
}

/**
 * The DIRECT relations of one entity.
 *
 * `entityId` IS THE ONE REQUIRED PARAMETER IN THIS FILE, and it is required
 * because the alternative is not "all relations of the book" — that is a
 * different question with a different cost, and `narrative_document_context`
 * already answers the passage-shaped version of it.
 */
/**
 * `narrative_entity_appearances` (gh#47).
 *
 * WHY A TOOL AND NOT "USE find_mentions AND SORT". Mentions come back in
 * insertion order and carry no chapter; putting them in the order the book
 * reads needs the manifest, and quoting them needs the file plus the hash check
 * only the backend can perform. A model asked to do that itself would either
 * report the wrong first appearance or quote a passage that has since moved.
 *
 * THE UNPLACEABLE ANSWER IS PART OF THE CONTRACT, not an edge case: an entity
 * that appears only in a chapter cut from the build has appearances and NO
 * first appearance, and the tool says exactly that.
 */
@injectable()
export class NarrativeEntityAppearancesTool extends NarrativeMemoryTool {
  static readonly ID = NARRATIVE_ENTITY_APPEARANCES_TOOL_ID;

  getTool(): ToolRequest {
    return {
      id: NarrativeEntityAppearancesTool.ID,
      ...this.localized(NARRATIVE_ENTITY_APPEARANCES_TOOL_ID),
      parameters: {
        type: 'object',
        properties: {
          entityId: { type: 'string', description: 'The entity whose appearances to list.' },
          direction: {
            type: 'string',
            description:
              'asc reads the book forwards (use it for a first appearance), desc backwards (for the most recent). Defaults to asc.'
          },
          limit: { type: 'number', description: 'How many appearances to return, after ordering.' },
          withExcerpt: {
            type: 'boolean',
            description: 'Include the quoted passage. Costs one file read per document; defaults to false.'
          },
          withSpread: {
            type: 'boolean',
            description: 'Also return every document holding a mention, with counts. Never capped by limit.'
          }
        },
        required: ['entityId']
      },
      handler: async (argString: string) => {
        const args = this.parseArgs(argString);
        const entityId = this.str(args, 'entityId');
        if (entityId === undefined) {
          // Unlike relations, there is no legible book-wide version of this
          // question: "where does everything appear" is the whole mention table.
          return JSON.stringify(narrativeMissingEntityIdAnswer());
        }
        const direction = this.str(args, 'direction');
        const limit = this.num(args, 'limit');
        return this.answer(async rootUri =>
          narrativeEntityAppearancesAnswer(
            rootUri,
            await this.service.getEntityAppearances(rootUri, entityId, {
              ...(direction === 'desc' ? { direction: 'desc' as const } : { direction: 'asc' as const }),
              ...(limit === undefined ? {} : { limit }),
              ...(this.bool(args, 'withExcerpt') === undefined ? {} : { withExcerpt: this.bool(args, 'withExcerpt') }),
              ...(this.bool(args, 'withSpread') === undefined ? {} : { withSpread: this.bool(args, 'withSpread') })
            })
          )
        );
      }
    };
  }
}

@injectable()
export class NarrativeEntityRelationsTool extends NarrativeMemoryTool {
  static readonly ID = NARRATIVE_ENTITY_RELATIONS_TOOL_ID;

  getTool(): ToolRequest {
    return {
      id: NarrativeEntityRelationsTool.ID,
      ...this.localized(NARRATIVE_ENTITY_RELATIONS_TOOL_ID),
      parameters: {
        type: 'object',
        properties: {
          entityId: { type: 'string', description: 'The entity whose direct relations to list.' },
          direction: {
            type: 'string',
            description:
              'Which end the entity is matched against: outgoing, incoming, or either. Defaults to either.'
          },
          relType: { type: 'string', description: 'Restrict to one relation type.' },
          origin: {
            type: 'string',
            description: 'Restrict to explicit, derived, or ai-candidate relations.'
          },
          brokenOnly: {
            type: 'boolean',
            description: 'Only relations with an end naming an id no card defines.'
          }
        },
        required: ['entityId']
      },
      handler: async (argString: string) => {
        const args = this.parseArgs(argString);
        const entityId = this.str(args, 'entityId');
        return this.answer(async rootUri =>
          narrativeEntityRelationsAnswer(
            rootUri,
            await this.service.getRelations(rootUri, {
              // An absent id is passed through as an absent filter rather than
              // rejected: `getRelations` then answers about the whole book,
              // which is a legible answer, and the alternative is an exception
              // the model will paraphrase.
              ...(entityId === undefined ? {} : { entityId, direction: 'either' as RelationDirection }),
              ...(this.str(args, 'direction') === undefined
                ? {}
                : { direction: this.str(args, 'direction') as RelationDirection }),
              ...(this.str(args, 'relType') === undefined
                ? {}
                : { relType: this.str(args, 'relType') }),
              ...(this.str(args, 'origin') === undefined
                ? {}
                : { origin: this.str(args, 'origin') as NarrativeOrigin }),
              ...(this.bool(args, 'brokenOnly') === undefined
                ? {}
                : { brokenOnly: this.bool(args, 'brokenOnly') })
            })
          )
        );
      }
    };
  }
}

/** Everything the index knows about one document or one passage of it. */
@injectable()
export class NarrativeDocumentContextTool extends NarrativeMemoryTool {
  static readonly ID = NARRATIVE_DOCUMENT_CONTEXT_TOOL_ID;

  getTool(): ToolRequest {
    return {
      id: NarrativeDocumentContextTool.ID,
      ...this.localized(NARRATIVE_DOCUMENT_CONTEXT_TOOL_ID),
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Workspace-relative path of the document, e.g. content/ch-03.md.'
          },
          startLine: {
            type: 'number',
            description: 'Zero-based first line of the passage. Omit for the whole document.'
          },
          endLine: {
            type: 'number',
            description: 'Zero-based last line of the passage. Omit for the whole document.'
          },
          spoilerSafe: {
            type: 'boolean',
            description:
              'Defaults to true: chapters positioned after this one contribute nothing. Set false only when the author asked you to look ahead.'
          },
          maxEvidencePerSection: {
            type: 'number',
            description: 'Hard cap per section. What is cut is reported, never silently dropped.'
          },
          include: {
            type: 'array',
            description:
              'Which sections to build: entities, mentions, relations, priorAppearances, findings. Omit for all of them.'
          }
        },
        required: ['path']
      },
      handler: async (argString: string) => {
        const args = this.parseArgs(argString);
        const path = this.str(args, 'path') ?? '';
        const startLine = this.num(args, 'startLine');
        const endLine = this.num(args, 'endLine');
        const include = Array.isArray(args.include)
          ? (args.include.filter(item => typeof item === 'string') as NarrativeContextSection[])
          : undefined;
        const options: NarrativeContextOptions = {
          // TWO LINE NUMBERS RATHER THAN A NESTED RANGE OBJECT, because a
          // language model fills a flat number far more reliably than a
          // four-deep `{start:{line,character}}`. The characters are the whole
          // line by construction: a model does not know column offsets, and
          // guessing one would narrow the answer for no reason.
          ...(startLine === undefined || endLine === undefined
            ? {}
            : {
                range: {
                  start: { line: startLine, character: 0 },
                  end: { line: endLine, character: Number.MAX_SAFE_INTEGER }
                }
              }),
          ...(this.bool(args, 'spoilerSafe') === undefined
            ? {}
            : { spoilerSafe: this.bool(args, 'spoilerSafe') }),
          ...(this.num(args, 'maxEvidencePerSection') === undefined
            ? {}
            : { maxEvidencePerSection: this.num(args, 'maxEvidencePerSection') }),
          ...(include === undefined || include.length === 0 ? {} : { include })
        };
        return this.answer(async rootUri =>
          narrativeDocumentContextAnswer(
            rootUri,
            await this.service.getContextForDocument(
              new URI(rootUri).resolve(path).toString(),
              options
            )
          )
        );
      }
    };
  }
}
