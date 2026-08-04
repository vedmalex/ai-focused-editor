import { inject, injectable } from '@theia/core/shared/inversify';
import { nls } from '@theia/core/lib/common/nls';
import type { ToolProvider, ToolRequest } from '@theia/ai-core';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import URI from '@theia/core/lib/common/uri';
import {
  NarrativeKnowledgeService,
  type NarrativeKnowledgeService as NarrativeKnowledgeServiceType
} from '@ai-focused-editor/narrative-knowledge';
import type {
  ManuscriptNode,
  ManuscriptWorkspaceService as ManuscriptWorkspaceServiceType
} from '../common';
import {
  diagramSpecToSkeleton,
  entityTypeById,
  ManuscriptWorkspaceService
} from '../common';
import {
  createSemanticEntityId,
  CREATABLE_ENTITY_KINDS,
  ENTITY_KIND_TAG,
  entityRelativePath,
  KNOWLEDGE_CATEGORIES,
  knowledgeNoteRelativePath,
  uniqueRelativePath,
  type CreatableEntityKind
} from '../common/entity-creation';
import {
  buildAiEntityCardYaml,
  decideAiWriteProvenance,
  provenanceRecord,
  withProvenanceFrontMatter,
  type AiWriteProvenance
} from '../common/ai-write-provenance';
import {
  AiWriteConfirmationService,
  type AiWriteConfirmationService as AiWriteConfirmationServiceType
} from './ai-write-confirmation';
import { loadExcalidrawCanvasModule } from './excalidraw-editor-widget';

const MAX_CHAPTER_CHARS = 16000;

/**
 * Shared description of the `evidence` parameter the three WRITE tools accept
 * (TASK-022 WP-8, UR-008).
 *
 * Stated once because it is one contract, and because the whole point of the
 * work package is that the three tools cannot drift apart on it.
 */
const EVIDENCE_PARAMETER_DESCRIPTION =
  'Where in the manuscript this is read from: a workspace-relative path string, or '
    + '{ "path": "content/chapter-01.md", "range"?: { "start": { "line", "character" }, "end": { "line", "character" } } } '
    + '(zero-based). WITH evidence the result is recorded as origin "explicit"; WITHOUT it, as an unconfirmed '
    + '"ai-candidate". Either way the author is asked to approve the write. Cite a real file — a path that does not '
    + 'exist is refused.';

/**
 * The `evidence` parameter, declared once for the tools that accept it.
 *
 * `anyOf` rather than a single `type`: the accepted forms really are two (a
 * bare path string and a `{ path, range? }` object), and declaring only one of
 * them would advertise a contract narrower than the parser honours.
 */
const EVIDENCE_PARAMETER = {
  anyOf: [{ type: 'string' as const }, { type: 'object' as const }],
  description: EVIDENCE_PARAMETER_DESCRIPTION
};

/**
 * Resolve the open manuscript workspace root URI, or `undefined` when no
 * workspace is open. Shared by the write tools below (the read tools resolve it
 * inline off their own snapshot).
 */
async function resolveWorkspaceRoot(workspace: ManuscriptWorkspaceServiceType): Promise<URI | undefined> {
  const snapshot = await workspace.getSnapshot();
  return snapshot.rootUri ? new URI(snapshot.rootUri) : undefined;
}

/**
 * Collect the workspace-relative paths of the direct children of `relDir` into a
 * set, so a pure `uniqueRelativePath(...)` collision check can run synchronously.
 * A missing directory yields an empty set.
 */
async function existingRelPaths(fileService: FileService, root: URI, relDir: string): Promise<Set<string>> {
  const set = new Set<string>();
  const stat = await fileService.resolve(root.resolve(relDir)).catch(() => undefined);
  for (const child of stat?.children ?? []) {
    const relative = root.relative(child.resource);
    if (relative) {
      set.add(relative.toString());
    }
  }
  return set;
}

/** Ensure a folder exists (idempotent — an already-present folder is not an error). */
async function ensureFolder(fileService: FileService, uri: URI): Promise<void> {
  try {
    await fileService.createFolder(uri);
  } catch {
    // Folder already exists — expected.
  }
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Parse a tool `argString` (JSON object) into a record; `{}` on any parse failure. */
function parseObjectArgs(argString: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(argString || '{}');
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/* ------------------------------------------------------------------------- */
/* The AI write gate (TASK-022 WP-8, UR-008)                                  */
/*                                                                            */
/* An AI creates CANDIDATES, NOT FACTS. Everything below exists so that a file */
/* the model creates carries WHO PROPOSED IT and WHAT IT WAS READ FROM, and so */
/* that it is created only because the author said yes. The decision itself is */
/* in the Theia-free `../common/ai-write-provenance`; these helpers are the    */
/* two things that need the filesystem and the author: proving a citation      */
/* points at a real file, and asking.                                         */
/* ------------------------------------------------------------------------- */

/** A refusal carrying the reason, or a go-ahead. */
type WriteGate = { ok: true } | { ok: false; error: string };

/**
 * Prove that a citation points at a file that actually exists.
 *
 * WITHOUT THIS THE WHOLE WORK PACKAGE IS BYPASSABLE. `origin: 'explicit'` is
 * granted for supplying evidence; if nobody checks the path, a model that
 * invents `content/chapter-07.md` gets its guess recorded as an authored fact —
 * the exact substitution UR-008 exists to prevent, reached by the shortest
 * possible route. The shape checks live in the pure module; only existence
 * needs the disk, so only existence is here.
 */
async function verifyEvidenceExists(
  fileService: FileService,
  root: URI,
  provenance: AiWriteProvenance
): Promise<WriteGate> {
  const evidence = provenance.evidence;
  if (!evidence) {
    return { ok: true };
  }
  const exists = await fileService.exists(root.resolve(evidence.path)).catch(() => false);
  return exists
    ? { ok: true }
    : { ok: false, error: `Evidence path "${evidence.path}" does not exist in this workspace. Cite a file that is really there, or omit evidence and the result will be marked as an unconfirmed candidate.` };
}

/**
 * Ask the author, and treat an unavailable gate as a REFUSAL.
 *
 * The missing-gate branch is the important one. UR-008 asks for EXPLICIT
 * confirmation, so "there was nobody to ask" cannot mean "go ahead" — that is
 * how a required approval quietly becomes a default. Under normal DI the
 * service is always bound and this branch is unreachable; it is here so that
 * any construction path that forgets it FAILS CLOSED instead of writing.
 */
async function confirmWrite(
  confirmation: AiWriteConfirmationServiceType | undefined,
  request: { toolId: string; artifactLabel: string; path: string; provenance: AiWriteProvenance }
): Promise<WriteGate> {
  if (!confirmation) {
    return { ok: false, error: 'Refused: this write needs the author\'s confirmation and no confirmation service is available.' };
  }
  const approved = await confirmation.confirm(request);
  return approved
    ? { ok: true }
    : { ok: false, error: `Refused by the author: ${request.path} was not created.` };
}

/**
 * Theia AI tools for the Manuscript chat agent (spec §3.5 Tools/Function
 * Calling): entity lookup and chapter access, referenced from the agent's
 * prompt template via ~{tool_id}.
 */
/**
 * TASK-022 WP-7 (UR-007): migrated onto `NarrativeKnowledgeService` directly —
 * per tech_spec TECH_SPEC WP-7 §1 this tool may NOT be a thin adapter over the
 * legacy `NarrativeEntityService`/`LegacyNarrativeEntity` bridge.
 *
 * MATCHING SEMANTICS ARE KEPT, NOT `EntityQuery.namePrefix`'S (§3 of the same
 * decision). `EntityQuery.namePrefix` is a case-insensitive PREFIX over `name`
 * + `aliases` only; this tool's baseline (`narrative-consumer-baseline.test.ts`,
 * "manuscript_find_entities") pins a case-insensitive SUBSTRING over
 * `id`+`label`+`aliases`+`epithets` — an epithet match in particular that
 * `namePrefix` cannot express at all. So `findEntities(rootUri, {})` is called
 * UNFILTERED and the old substring filter runs here, client-side, exactly as
 * it did against `entities.getSnapshot()` before this migration — only the
 * data source moved.
 */
@injectable()
export class ManuscriptFindEntitiesTool implements ToolProvider {
  static readonly ID = 'manuscript_find_entities';

  @inject(NarrativeKnowledgeService)
  protected readonly knowledge!: NarrativeKnowledgeServiceType;

  @inject(ManuscriptWorkspaceService)
  protected readonly workspace!: ManuscriptWorkspaceServiceType;

  getTool(): ToolRequest {
    return {
      id: ManuscriptFindEntitiesTool.ID,
      // A friendly, localized human label for the chat capabilities panel; the
      // stable `id` above is what the prompt template and selections reference.
      name: nls.localize('ai-focused-editor/chat-capabilities/tool-find-entities-name', 'Find Entities'),
      description: nls.localize(
        'ai-focused-editor/chat-capabilities/tool-find-entities-description',
        'Search the manuscript knowledge base for characters, terms, artifacts, and locations by name, alias, epithet, or id. Returns matching entity cards.'
      ),
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Substring to match against id, label, aliases, and epithets. Empty returns all entities.'
          },
          kind: {
            type: 'string',
            description: 'Optional filter: character, term, artifact, or location.'
          }
        },
        required: []
      },
      handler: async (argString: string) => {
        const args = this.parseArgs(argString);
        const root = await resolveWorkspaceRoot(this.workspace);
        if (!root) {
          return JSON.stringify([]);
        }
        const envelope = await this.knowledge.findEntities(root.toString());
        const query = (args.query ?? '').toLowerCase();
        const kind = (args.kind ?? '').toLowerCase();
        const matches = envelope.data.filter(entity => {
          if (kind && entity.type !== kind) {
            return false;
          }
          if (!query) {
            return true;
          }
          const haystack = [
            entity.id,
            entity.name,
            ...entity.aliases,
            ...(entity.epithets ?? [])
          ].join('\n').toLowerCase();
          return haystack.includes(query);
        });
        return JSON.stringify(matches.map(entity => ({
          // Wire contract keys are `kind`/`label` — the tool's OWN JSON shape,
          // unrelated to `LegacyNarrativeEntity` (that bridge is reserved for
          // the frozen thin-adapter list, tech_spec TECH_SPEC WP-7 §1).
          kind: entity.type,
          id: entity.id,
          label: entity.name,
          aliases: entity.aliases,
          epithets: entity.epithets,
          summary: entity.summary,
          arc: entity.arc
        })));
      }
    };
  }

  protected parseArgs(argString: string): { query?: string; kind?: string } {
    try {
      const parsed = JSON.parse(argString || '{}');
      return typeof parsed === 'object' && parsed !== null ? parsed : {};
    } catch {
      return { query: argString };
    }
  }
}

@injectable()
export class ManuscriptListChaptersTool implements ToolProvider {
  static readonly ID = 'manuscript_list_chapters';

  @inject(ManuscriptWorkspaceService)
  protected readonly manuscriptWorkspace!: ManuscriptWorkspaceServiceType;

  getTool(): ToolRequest {
    return {
      id: ManuscriptListChaptersTool.ID,
      name: nls.localize('ai-focused-editor/chat-capabilities/tool-list-chapters-name', 'List Chapters'),
      description: nls.localize(
        'ai-focused-editor/chat-capabilities/tool-list-chapters-description',
        'List the manuscript chapters and parts in manifest order, with workspace-relative paths, titles, and build inclusion.'
      ),
      parameters: {
        type: 'object',
        properties: {},
        required: []
      },
      handler: async () => {
        const snapshot = await this.manuscriptWorkspace.getSnapshot();
        const flat: { path: string; title: string; type: string; included: boolean; depth: number }[] = [];
        const walk = (nodes: ManuscriptNode[], depth: number) => {
          for (const node of [...nodes].sort((left, right) => left.order - right.order)) {
            flat.push({
              path: node.path,
              title: node.name,
              type: node.type,
              included: node.buildIncluded,
              depth
            });
            if (node.children) {
              walk(node.children, depth + 1);
            }
          }
        };
        walk(snapshot.content, 0);
        return JSON.stringify(flat);
      }
    };
  }
}

@injectable()
export class ManuscriptGetChapterTool implements ToolProvider {
  static readonly ID = 'manuscript_get_chapter';

  @inject(ManuscriptWorkspaceService)
  protected readonly manuscriptWorkspace!: ManuscriptWorkspaceServiceType;

  @inject(FileService)
  protected readonly fileService!: FileService;

  getTool(): ToolRequest {
    return {
      id: ManuscriptGetChapterTool.ID,
      name: nls.localize('ai-focused-editor/chat-capabilities/tool-get-chapter-name', 'Read Chapter'),
      description: nls.localize(
        'ai-focused-editor/chat-capabilities/tool-get-chapter-description',
        'Read a manuscript chapter by its workspace-relative path (as returned by manuscript_list_chapters). Returns the Markdown text.'
      ),
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Workspace-relative chapter path, e.g. content/chapter-01.md'
          }
        },
        required: ['path']
      },
      handler: async (argString: string) => {
        let path = '';
        try {
          const parsed = JSON.parse(argString || '{}');
          path = typeof parsed.path === 'string' ? parsed.path : '';
        } catch {
          path = argString.trim();
        }
        if (!path || path.includes('..')) {
          return JSON.stringify({ error: 'Provide a workspace-relative chapter path.' });
        }

        const snapshot = await this.manuscriptWorkspace.getSnapshot();
        if (!snapshot.rootUri) {
          return JSON.stringify({ error: 'No manuscript workspace is open.' });
        }
        try {
          const uri = new URI(snapshot.rootUri).resolve(path);
          const content = await this.fileService.read(uri);
          const text = content.value.length > MAX_CHAPTER_CHARS
            ? `${content.value.slice(0, MAX_CHAPTER_CHARS)}\n\n[...truncated at ${MAX_CHAPTER_CHARS} characters]`
            : content.value;
          return text;
        } catch (error) {
          return JSON.stringify({ error: `Could not read ${path}: ${error instanceof Error ? error.message : String(error)}` });
        }
      }
    };
  }
}

/**
 * WRITE tool: create a narrative entity YAML card under `entities/<dir>/<id>.yaml`.
 * The `kind` is validated against the entity-type registry; `id` defaults to the
 * transliterated slug of `name`; an existing file is REFUSED (never overwritten).
 * Returns a concise JSON result and never throws (errors → `{ ok:false, error }`).
 *
 * PROVENANCE (TASK-022 WP-8, UR-008). The card carries `origin:` and, when the
 * model cited one, `evidence:`. A card the model could not source lands as
 * `ai-candidate`; a sourced one as `explicit`. Either way the author confirms
 * first, and the confirmation shows the exact stamp that will be in the file.
 *
 * THE MARK IS DURABLE HERE, which is why marking is the right answer for this
 * tool. `EntityEditorWidget` edits cards through the `yaml` Document API and
 * preserves keys outside its schema verbatim
 * (`entity-editor-widget.ts:178`, `:393`), so an author opening and saving a
 * candidate card does not erase its stamp.
 */
@injectable()
export class ManuscriptCreateEntityTool implements ToolProvider {
  static readonly ID = 'manuscript_create_entity';

  @inject(ManuscriptWorkspaceService)
  protected readonly manuscriptWorkspace!: ManuscriptWorkspaceServiceType;

  @inject(FileService)
  protected readonly fileService!: FileService;

  @inject(AiWriteConfirmationService)
  protected readonly confirmation!: AiWriteConfirmationServiceType;

  getTool(): ToolRequest {
    return {
      id: ManuscriptCreateEntityTool.ID,
      name: nls.localize('ai-focused-editor/workspace/tool-create-entity-name', 'Create Entity'),
      description: nls.localize(
        'ai-focused-editor/workspace/tool-create-entity-description',
        'Create a knowledge-base entity card (character, term, artifact, or location) as an entities/<dir>/<id>.yaml file. '
          + 'The id defaults to a slug of the name (Cyrillic is transliterated). Refuses to overwrite an existing card. '
          + 'The author confirms every card before it is created, and the card records where it came from. '
          + 'Returns the created workspace-relative path.'
      ),
      parameters: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            description: `Entity kind, one of: ${CREATABLE_ENTITY_KINDS.join(', ')}.`
          },
          id: {
            type: 'string',
            description: 'Optional stable id/slug. Defaults to a transliterated slug of the name.'
          },
          name: {
            type: 'string',
            description: 'Display name of the entity (e.g. "Кришна", "Dharma").'
          },
          summary: {
            type: 'string',
            description: 'Optional one-paragraph summary stored on the card.'
          },
          evidence: EVIDENCE_PARAMETER
        },
        required: ['kind', 'name']
      },
      // Theia's own guard against the chat's "Always Allow" quietly turning
      // these three tools into unattended file creation. The dialog below is
      // the author's confirmation; this keeps the chat UI from offering to skip
      // asking in the first place.
      confirmAlwaysAllow: true,
      handler: async (argString: string) => {
        try {
          const args = parseObjectArgs(argString);
          const kind = typeof args.kind === 'string' ? args.kind.trim().toLowerCase() : '';
          const name = typeof args.name === 'string' ? args.name.trim() : '';
          const summary = typeof args.summary === 'string' ? args.summary : undefined;

          if (!entityTypeById(kind)) {
            return JSON.stringify({ ok: false, error: `Unknown entity kind "${kind}". Use one of: ${CREATABLE_ENTITY_KINDS.join(', ')}.` });
          }
          if (!name) {
            return JSON.stringify({ ok: false, error: 'Provide a non-empty entity name.' });
          }

          const decision = decideAiWriteProvenance(args.evidence);
          if (!decision.ok) {
            return JSON.stringify({ ok: false, error: decision.error });
          }
          const provenance = decision.provenance;

          const root = await resolveWorkspaceRoot(this.manuscriptWorkspace);
          if (!root) {
            return JSON.stringify({ ok: false, error: 'No manuscript workspace is open.' });
          }

          const evidenceGate = await verifyEvidenceExists(this.fileService, root, provenance);
          if (!evidenceGate.ok) {
            return JSON.stringify({ ok: false, error: evidenceGate.error });
          }

          const kindId = kind as CreatableEntityKind;
          const providedId = typeof args.id === 'string' ? args.id.trim() : '';
          const id = providedId || createSemanticEntityId(ENTITY_KIND_TAG[kindId], name);
          const relPath = entityRelativePath(kindId, id);
          const fileUri = root.resolve(relPath);

          if (await this.fileService.exists(fileUri)) {
            return JSON.stringify({ ok: false, error: `Entity already exists at ${relPath} (refusing to overwrite).` });
          }

          // The bytes are built BEFORE the author is asked, so the confirmation
          // and the file are two views of one already-decided value rather than
          // two chances to compute the stamp differently.
          const content = buildAiEntityCardYaml({ id, name, summary }, provenance);
          const approval = await confirmWrite(this.confirmation, {
            toolId: ManuscriptCreateEntityTool.ID,
            artifactLabel: nls.localize('ai-focused-editor/workspace/ai-write-artifact-entity', 'an entity card'),
            path: relPath,
            provenance
          });
          if (!approval.ok) {
            return JSON.stringify({ ok: false, error: approval.error });
          }

          await ensureFolder(this.fileService, fileUri.parent);
          await this.fileService.create(fileUri, content, { overwrite: false });
          return JSON.stringify({ ok: true, kind: kindId, id, path: relPath, ...provenanceRecord(provenance) });
        } catch (error) {
          return JSON.stringify({ ok: false, error: errorDetail(error) });
        }
      }
    };
  }
}

/**
 * WRITE tool: create a Markdown knowledge note under `knowledge/<category>/<slug>.md`
 * (or `knowledge/<slug>.md` at the root). The slug is derived from the title and
 * unique-suffixed on collision, so a note is never overwritten. The markdown body
 * may embed `$$...$$` KaTeX formulas. Errors → `{ ok:false, error }`; never throws.
 *
 * PROVENANCE (TASK-022 WP-8, UR-008). The stamp goes into the note's YAML front
 * matter — the note's own "in the YAML itself". Nothing in this editor rewrites
 * a note programmatically (it is edited as text), and the preview already reads
 * and renders front matter, so the mark is both durable and VISIBLE to the
 * author rather than buried.
 */
@injectable()
export class ManuscriptWriteNoteTool implements ToolProvider {
  static readonly ID = 'manuscript_write_note';

  @inject(ManuscriptWorkspaceService)
  protected readonly manuscriptWorkspace!: ManuscriptWorkspaceServiceType;

  @inject(FileService)
  protected readonly fileService!: FileService;

  @inject(AiWriteConfirmationService)
  protected readonly confirmation!: AiWriteConfirmationServiceType;

  getTool(): ToolRequest {
    return {
      id: ManuscriptWriteNoteTool.ID,
      name: nls.localize('ai-focused-editor/workspace/tool-write-note-name', 'Write Knowledge Note'),
      description: nls.localize(
        'ai-focused-editor/workspace/tool-write-note-description',
        'Create a Markdown knowledge note under knowledge/<category>/<slug>.md (slug derived from the title, unique-suffixed, never overwrites). '
          + `The optional category is one of: ${KNOWLEDGE_CATEGORIES.join(', ')} (omit for the knowledge/ root). `
          + 'The markdown body may embed display math as $$...$$ (rendered with KaTeX). Returns the created workspace-relative path.'
      ),
      parameters: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            description: `Optional subfolder, one of: ${KNOWLEDGE_CATEGORIES.join(', ')}. Omit to file the note at the knowledge/ root.`
          },
          title: {
            type: 'string',
            description: 'Note title; the H1 heading and the filename slug are derived from it.'
          },
          markdown: {
            type: 'string',
            description: 'Full Markdown body of the note. May embed $$...$$ formulas (KaTeX).'
          },
          evidence: EVIDENCE_PARAMETER
        },
        required: ['title', 'markdown']
      },
      confirmAlwaysAllow: true,
      handler: async (argString: string) => {
        try {
          const args = parseObjectArgs(argString);
          const title = typeof args.title === 'string' ? args.title.trim() : '';
          const markdown = typeof args.markdown === 'string' ? args.markdown : '';
          const rawCategory = typeof args.category === 'string' ? args.category.trim() : '';
          const category = rawCategory || undefined;

          if (!title) {
            return JSON.stringify({ ok: false, error: 'Provide a non-empty note title.' });
          }
          if (category && !KNOWLEDGE_CATEGORIES.includes(category)) {
            return JSON.stringify({ ok: false, error: `Unknown category "${category}". Use one of: ${KNOWLEDGE_CATEGORIES.join(', ')} (or omit for the root).` });
          }

          const decision = decideAiWriteProvenance(args.evidence);
          if (!decision.ok) {
            return JSON.stringify({ ok: false, error: decision.error });
          }
          const provenance = decision.provenance;
          const stamped = withProvenanceFrontMatter(markdown, provenance);
          if (!stamped.ok) {
            return JSON.stringify({ ok: false, error: stamped.error });
          }

          const root = await resolveWorkspaceRoot(this.manuscriptWorkspace);
          if (!root) {
            return JSON.stringify({ ok: false, error: 'No manuscript workspace is open.' });
          }

          const evidenceGate = await verifyEvidenceExists(this.fileService, root, provenance);
          if (!evidenceGate.ok) {
            return JSON.stringify({ ok: false, error: evidenceGate.error });
          }

          const relDir = category ? `knowledge/${category}` : 'knowledge';
          const existing = await existingRelPaths(this.fileService, root, relDir);
          const relPath = uniqueRelativePath(knowledgeNoteRelativePath(category, title), candidate => existing.has(candidate));
          const fileUri = root.resolve(relPath);

          const approval = await confirmWrite(this.confirmation, {
            toolId: ManuscriptWriteNoteTool.ID,
            artifactLabel: nls.localize('ai-focused-editor/workspace/ai-write-artifact-note', 'a knowledge note'),
            path: relPath,
            provenance
          });
          if (!approval.ok) {
            return JSON.stringify({ ok: false, error: approval.error });
          }

          await ensureFolder(this.fileService, root.resolve('knowledge'));
          if (category) {
            await ensureFolder(this.fileService, root.resolve(relDir));
          }
          await this.fileService.create(fileUri, stamped.content, { overwrite: false });
          return JSON.stringify({ ok: true, path: relPath, ...provenanceRecord(provenance) });
        } catch (error) {
          return JSON.stringify({ ok: false, error: errorDetail(error) });
        }
      }
    };
  }
}

/**
 * WRITE tool: build an Excalidraw diagram from a STRUCTURED scene `spec` and write
 * it to `sources/<slug>.excalidraw` (unique-suffixed, never overwrites). Nodes
 * become labeled boxes on a deterministic grid, edges become arrows between their
 * centers, and texts become free labels; a node with an `entity` links to that
 * entity's card (`afe-entity://kind/id`), strengthening the world map. Errors →
 * `{ ok:false, error }`; never throws.
 *
 * PROVENANCE (TASK-022 WP-8, UR-008): THIS TOOL REQUIRES EVIDENCE, and that is
 * the one place the three write tools deliberately differ.
 *
 * The reason is in the file format, not in taste. The other two artifacts can
 * WEAR a candidate mark for as long as it matters: an entity card is edited
 * through the `yaml` Document API, which preserves keys outside its schema, and
 * a note is edited as text. A `.excalidraw` scene cannot. When the author opens
 * a diagram and saves it, `ExcalidrawEditorWidget.save` rebuilds the file from
 * `serializeAsJSON(elements, appState, files, 'local')`
 * (`excalidraw-editor-widget.ts:341-345`) — it is handed the elements, the app
 * state and the files, and NOTHING ELSE, so any top-level key we wrote is gone,
 * silently, on the author's first save.
 *
 * A mark that disappears on its own is worse than no mark: the diagram would
 * become indistinguishable from an authored one WITHOUT anyone deciding that it
 * should. UR-008 offers two branches — require evidence, or mark the result —
 * and the plan's readiness block for WP-8 spells out the same disjunction
 * ("either refused, or lands with `origin: 'ai-candidate'`"). Where marking
 * cannot hold, the honest branch is to require. So an unsourced diagram is not
 * created at all, and a sourced one is `explicit`, which needs no durable mark.
 *
 * The scene still records the stamp under a top-level `provenance` key: it is
 * true at creation, it is what the author approved, and its erasure coincides
 * exactly with the author taking the diagram over by editing it.
 */
@injectable()
export class ManuscriptCreateDiagramTool implements ToolProvider {
  static readonly ID = 'manuscript_create_diagram';

  @inject(ManuscriptWorkspaceService)
  protected readonly manuscriptWorkspace!: ManuscriptWorkspaceServiceType;

  @inject(FileService)
  protected readonly fileService!: FileService;

  @inject(AiWriteConfirmationService)
  protected readonly confirmation!: AiWriteConfirmationServiceType;

  getTool(): ToolRequest {
    return {
      id: ManuscriptCreateDiagramTool.ID,
      name: nls.localize('ai-focused-editor/workspace/tool-create-diagram-name', 'Create Diagram'),
      description: nls.localize(
        'ai-focused-editor/workspace/tool-create-diagram-description',
        'Build an Excalidraw diagram from a structured scene spec and save it under sources/<slug>.excalidraw (unique-suffixed). '
          + 'The spec is: { "nodes": [{ "id", "label", "entity"?: { "kind", "id" } }], "edges"?: [{ "from", "to", "label"? }], "texts"?: [{ "text", "x"?, "y"? }] }. '
          + 'Nodes are boxes on an auto grid; edges are arrows between node centers (from/to reference node ids); a node with an entity links to its card. '
          + 'Example: { "title": "Kurukshetra", "spec": { "nodes": [ { "id": "a", "label": "Arjuna", "entity": { "kind": "character", "id": "arjuna" } }, { "id": "k", "label": "Krishna", "entity": { "kind": "character", "id": "krishna" } } ], "edges": [ { "from": "k", "to": "a", "label": "advises" } ] } }. '
          + 'Evidence is REQUIRED for this tool: name the chapter or card the diagram depicts. The author confirms the '
          + 'diagram before it is created. Returns the created workspace-relative path.'
      ),
      parameters: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Diagram title; the filename slug is derived from it.'
          },
          spec: {
            type: 'object',
            description: 'Structured scene: { nodes: [{ id, label, entity?: { kind, id } }], edges?: [{ from, to, label? }], texts?: [{ text, x?, y? }] }.'
          },
          evidence: EVIDENCE_PARAMETER
        },
        required: ['title', 'spec', 'evidence']
      },
      confirmAlwaysAllow: true,
      handler: async (argString: string) => {
        try {
          const args = parseObjectArgs(argString);
          const title = typeof args.title === 'string' ? args.title.trim() : '';
          if (!title) {
            return JSON.stringify({ ok: false, error: 'Provide a non-empty diagram title.' });
          }
          if (typeof args.spec !== 'object' || args.spec === null) {
            return JSON.stringify({ ok: false, error: 'Provide a "spec" object describing nodes/edges/texts.' });
          }

          // Evidence is REQUIRED here — see the class note. Checked BEFORE the
          // absent branch reaches `decideAiWriteProvenance`, so the refusal
          // says what this tool needs instead of producing a candidate mark the
          // file format cannot keep.
          if (args.evidence === undefined || args.evidence === null) {
            return JSON.stringify({
              ok: false,
              error: 'This tool requires "evidence": the workspace-relative path (optionally with a range) of the chapter or card the diagram depicts. '
                + 'A diagram file cannot carry a durable "unconfirmed candidate" mark, so an unsourced diagram is not created.'
            });
          }
          const decision = decideAiWriteProvenance(args.evidence);
          if (!decision.ok) {
            return JSON.stringify({ ok: false, error: decision.error });
          }
          const provenance = decision.provenance;

          // Pure translation FIRST — invalid specs fail before any file work.
          let built: ReturnType<typeof diagramSpecToSkeleton>;
          try {
            built = diagramSpecToSkeleton(args.spec);
          } catch (specError) {
            return JSON.stringify({ ok: false, error: errorDetail(specError) });
          }

          const root = await resolveWorkspaceRoot(this.manuscriptWorkspace);
          if (!root) {
            return JSON.stringify({ ok: false, error: 'No manuscript workspace is open.' });
          }

          const evidenceGate = await verifyEvidenceExists(this.fileService, root, provenance);
          if (!evidenceGate.ok) {
            return JSON.stringify({ ok: false, error: evidenceGate.error });
          }

          const module = await loadExcalidrawCanvasModule();
          const elements = module.convertToExcalidrawElements(built.skeletons, { regenerateIds: false }) as Record<string, unknown>[];
          // Re-assert entity links: conversion can push a container's link onto its
          // bound-text child, so set link back on each entity node by its stable id.
          const linkById = new Map(built.entityLinks.map(entry => [entry.elementId, entry.link]));
          for (const element of elements) {
            const link = linkById.get(element.id as string);
            if (link) {
              element.link = link;
            }
          }

          const slug = createSemanticEntityId('diagram', title);
          const existing = await existingRelPaths(this.fileService, root, 'sources');
          const relPath = uniqueRelativePath(`sources/${slug}.excalidraw`, candidate => existing.has(candidate));
          const fileUri = root.resolve(relPath);

          const scene = {
            type: 'excalidraw',
            version: 2,
            source: 'ai-focused-editor',
            // True at creation; NOT preserved by the widget's own save — see the
            // class note for why that is acceptable here and why it is exactly
            // the reason evidence is required rather than optional.
            provenance: provenanceRecord(provenance),
            elements,
            appState: { gridSize: null, viewBackgroundColor: '#ffffff' },
            files: {}
          };
          const content = `${JSON.stringify(scene, undefined, 2)}\n`;

          const approval = await confirmWrite(this.confirmation, {
            toolId: ManuscriptCreateDiagramTool.ID,
            artifactLabel: nls.localize('ai-focused-editor/workspace/ai-write-artifact-diagram', 'a diagram'),
            path: relPath,
            provenance
          });
          if (!approval.ok) {
            return JSON.stringify({ ok: false, error: approval.error });
          }

          await ensureFolder(this.fileService, root.resolve('sources'));
          await this.fileService.create(fileUri, content, { overwrite: false });
          return JSON.stringify({
            ok: true,
            path: relPath,
            nodes: built.skeletons.filter(s => s.type === 'rectangle').length,
            ...provenanceRecord(provenance)
          });
        } catch (error) {
          return JSON.stringify({ ok: false, error: errorDetail(error) });
        }
      }
    };
  }
}
