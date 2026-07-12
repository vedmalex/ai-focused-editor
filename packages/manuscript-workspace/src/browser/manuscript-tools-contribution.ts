import { inject, injectable } from '@theia/core/shared/inversify';
import { nls } from '@theia/core/lib/common/nls';
import type { ToolProvider, ToolRequest } from '@theia/ai-core';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import URI from '@theia/core/lib/common/uri';
import type {
  ManuscriptNode,
  NarrativeEntityService as NarrativeEntityServiceType,
  ManuscriptWorkspaceService as ManuscriptWorkspaceServiceType
} from '../common';
import {
  diagramSpecToSkeleton,
  entityTypeById,
  ManuscriptWorkspaceService,
  NarrativeEntityService
} from '../common';
import {
  buildEntityYaml,
  createSemanticEntityId,
  CREATABLE_ENTITY_KINDS,
  ENTITY_KIND_TAG,
  entityRelativePath,
  KNOWLEDGE_CATEGORIES,
  knowledgeNoteRelativePath,
  uniqueRelativePath,
  type CreatableEntityKind
} from '../common/entity-creation';
import { loadExcalidrawCanvasModule } from './excalidraw-editor-widget';

const MAX_CHAPTER_CHARS = 16000;

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

/**
 * Theia AI tools for the Manuscript chat agent (spec §3.5 Tools/Function
 * Calling): entity lookup and chapter access, referenced from the agent's
 * prompt template via ~{tool_id}.
 */
@injectable()
export class ManuscriptFindEntitiesTool implements ToolProvider {
  static readonly ID = 'manuscript_find_entities';

  @inject(NarrativeEntityService)
  protected readonly entities!: NarrativeEntityServiceType;

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
        const snapshot = await this.entities.getSnapshot();
        const query = (args.query ?? '').toLowerCase();
        const kind = (args.kind ?? '').toLowerCase();
        const matches = snapshot.entities.filter(entity => {
          if (kind && entity.kind !== kind) {
            return false;
          }
          if (!query) {
            return true;
          }
          const haystack = [
            entity.id,
            entity.label,
            ...entity.aliases,
            ...(entity.epithets ?? [])
          ].join('\n').toLowerCase();
          return haystack.includes(query);
        });
        return JSON.stringify(matches.map(entity => ({
          kind: entity.kind,
          id: entity.id,
          label: entity.label,
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
 */
@injectable()
export class ManuscriptCreateEntityTool implements ToolProvider {
  static readonly ID = 'manuscript_create_entity';

  @inject(ManuscriptWorkspaceService)
  protected readonly manuscriptWorkspace!: ManuscriptWorkspaceServiceType;

  @inject(FileService)
  protected readonly fileService!: FileService;

  getTool(): ToolRequest {
    return {
      id: ManuscriptCreateEntityTool.ID,
      name: nls.localize('ai-focused-editor/workspace/tool-create-entity-name', 'Create Entity'),
      description: nls.localize(
        'ai-focused-editor/workspace/tool-create-entity-description',
        'Create a knowledge-base entity card (character, term, artifact, or location) as an entities/<dir>/<id>.yaml file. '
          + 'The id defaults to a slug of the name (Cyrillic is transliterated). Refuses to overwrite an existing card. '
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
          }
        },
        required: ['kind', 'name']
      },
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

          const root = await resolveWorkspaceRoot(this.manuscriptWorkspace);
          if (!root) {
            return JSON.stringify({ ok: false, error: 'No manuscript workspace is open.' });
          }

          const kindId = kind as CreatableEntityKind;
          const providedId = typeof args.id === 'string' ? args.id.trim() : '';
          const id = providedId || createSemanticEntityId(ENTITY_KIND_TAG[kindId], name);
          const relPath = entityRelativePath(kindId, id);
          const fileUri = root.resolve(relPath);

          if (await this.fileService.exists(fileUri)) {
            return JSON.stringify({ ok: false, error: `Entity already exists at ${relPath} (refusing to overwrite).` });
          }

          await ensureFolder(this.fileService, fileUri.parent);
          await this.fileService.create(fileUri, buildEntityYaml({ id, name, summary }), { overwrite: false });
          return JSON.stringify({ ok: true, kind: kindId, id, path: relPath });
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
 */
@injectable()
export class ManuscriptWriteNoteTool implements ToolProvider {
  static readonly ID = 'manuscript_write_note';

  @inject(ManuscriptWorkspaceService)
  protected readonly manuscriptWorkspace!: ManuscriptWorkspaceServiceType;

  @inject(FileService)
  protected readonly fileService!: FileService;

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
          }
        },
        required: ['title', 'markdown']
      },
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

          const root = await resolveWorkspaceRoot(this.manuscriptWorkspace);
          if (!root) {
            return JSON.stringify({ ok: false, error: 'No manuscript workspace is open.' });
          }

          const relDir = category ? `knowledge/${category}` : 'knowledge';
          const existing = await existingRelPaths(this.fileService, root, relDir);
          const relPath = uniqueRelativePath(knowledgeNoteRelativePath(category, title), candidate => existing.has(candidate));
          const fileUri = root.resolve(relPath);

          await ensureFolder(this.fileService, root.resolve('knowledge'));
          if (category) {
            await ensureFolder(this.fileService, root.resolve(relDir));
          }
          await this.fileService.create(fileUri, markdown, { overwrite: false });
          return JSON.stringify({ ok: true, path: relPath });
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
 */
@injectable()
export class ManuscriptCreateDiagramTool implements ToolProvider {
  static readonly ID = 'manuscript_create_diagram';

  @inject(ManuscriptWorkspaceService)
  protected readonly manuscriptWorkspace!: ManuscriptWorkspaceServiceType;

  @inject(FileService)
  protected readonly fileService!: FileService;

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
          + 'Returns the created workspace-relative path.'
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
          }
        },
        required: ['title', 'spec']
      },
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
            elements,
            appState: { gridSize: null, viewBackgroundColor: '#ffffff' },
            files: {}
          };
          await ensureFolder(this.fileService, root.resolve('sources'));
          await this.fileService.create(fileUri, `${JSON.stringify(scene, undefined, 2)}\n`, { overwrite: false });
          return JSON.stringify({ ok: true, path: relPath, nodes: built.skeletons.filter(s => s.type === 'rectangle').length });
        } catch (error) {
          return JSON.stringify({ ok: false, error: errorDetail(error) });
        }
      }
    };
  }
}
