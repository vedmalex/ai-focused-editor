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
  ManuscriptWorkspaceService,
  NarrativeEntityService
} from '../common';

const MAX_CHAPTER_CHARS = 16000;

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
