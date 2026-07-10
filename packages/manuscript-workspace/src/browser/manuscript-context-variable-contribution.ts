import {
  AIContextVariable,
  AIVariableContribution,
  AIVariableContext,
  AIVariableResolutionRequest,
  AIVariableService,
  ResolvedAIContextVariable
} from '@theia/ai-core';
import { injectable, inject } from '@theia/core/shared/inversify';
import { nls } from '@theia/core/lib/common/nls';
import URI from '@theia/core/lib/common/uri';
import { EditorManager } from '@theia/editor/lib/browser/editor-manager';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import type {
  ManuscriptNode,
  NarrativeEntity
} from '../common';
import {
  ManuscriptWorkspaceService,
  NarrativeEntityService,
  SourceLibraryService
} from '../common';
import type {
  ManuscriptWorkspaceService as ManuscriptWorkspaceServiceType,
  NarrativeEntityService as NarrativeEntityServiceType,
  SourceLibraryService as SourceLibraryServiceType
} from '../common';
import { ManuscriptAiContextAssembler } from './manuscript-ai-context-assembler';

const MAX_CHAPTER_CHARS = 24000;

export const MANUSCRIPT_CONTEXT_VARIABLE: AIContextVariable = {
  id: 'ai-focused-editor.manuscript-context',
  name: 'manuscript',
  label: nls.localize('ai-focused-editor/workspace/var-manuscript-label', 'Manuscript'),
  description: nls.localize(
    'ai-focused-editor/workspace/var-manuscript-description',
    'Whole-project context: manifest, diagnostics, entities, and source summary.'
  ),
  iconClasses: ['fa', 'fa-book'],
  isContextVariable: true
};

export const CHAPTER_CONTEXT_VARIABLE: AIContextVariable = {
  id: 'ai-focused-editor.chapter-context',
  name: 'chapter',
  label: nls.localize('ai-focused-editor/workspace/var-chapter-label', 'Chapter'),
  description: nls.localize(
    'ai-focused-editor/workspace/var-chapter-description',
    'A single chapter\'s Markdown. Defaults to the active editor; pass a workspace-relative path as argument (#chapter:content/chapter-01.md).'
  ),
  iconClasses: ['fa', 'fa-file-text-o'],
  isContextVariable: true
};

export const ENTITY_CONTEXT_VARIABLE: AIContextVariable = {
  id: 'ai-focused-editor.entity-context',
  name: 'entity',
  label: nls.localize('ai-focused-editor/workspace/var-entity-label', 'Entity Card'),
  description: nls.localize(
    'ai-focused-editor/workspace/var-entity-description',
    'One knowledge-base card by id (#entity:krishna) with all fields.'
  ),
  iconClasses: ['fa', 'fa-user'],
  isContextVariable: true
};

export const ENTITIES_CONTEXT_VARIABLE: AIContextVariable = {
  id: 'ai-focused-editor.entities-context',
  name: 'entities',
  label: nls.localize('ai-focused-editor/workspace/var-entities-label', 'All Entities'),
  description: nls.localize(
    'ai-focused-editor/workspace/var-entities-description',
    'Compact roster of every character, term, artifact, and location card.'
  ),
  iconClasses: ['fa', 'fa-users'],
  isContextVariable: true
};

export const SOURCES_CONTEXT_VARIABLE: AIContextVariable = {
  id: 'ai-focused-editor.sources-context',
  name: 'sources',
  label: nls.localize('ai-focused-editor/workspace/var-sources-label', 'Sources & Citations'),
  description: nls.localize(
    'ai-focused-editor/workspace/var-sources-description',
    'Source files, citations, and excerpts registered in the workspace.'
  ),
  iconClasses: ['fa', 'fa-quote-right'],
  isContextVariable: true
};

export const OUTLINE_CONTEXT_VARIABLE: AIContextVariable = {
  id: 'ai-focused-editor.outline-context',
  name: 'outline',
  label: nls.localize('ai-focused-editor/workspace/var-outline-label', 'Book Outline'),
  description: nls.localize(
    'ai-focused-editor/workspace/var-outline-description',
    'Manifest structure plus the heading outline of every included chapter.'
  ),
  iconClasses: ['fa', 'fa-list'],
  isContextVariable: true
};

const ALL_VARIABLES = [
  MANUSCRIPT_CONTEXT_VARIABLE,
  CHAPTER_CONTEXT_VARIABLE,
  ENTITY_CONTEXT_VARIABLE,
  ENTITIES_CONTEXT_VARIABLE,
  SOURCES_CONTEXT_VARIABLE,
  OUTLINE_CONTEXT_VARIABLE
];

/**
 * Chat context variables for the writing workspace. `#manuscript` was the
 * historical single mention (from the manuscript.md era); chapters, entities,
 * sources, and the outline are now addressable individually so writers can
 * shape the AI context precisely.
 */
@injectable()
export class ManuscriptContextVariableContribution implements AIVariableContribution {
  @inject(ManuscriptAiContextAssembler)
  protected readonly contextAssembler!: ManuscriptAiContextAssembler;

  @inject(ManuscriptWorkspaceService)
  protected readonly manuscriptWorkspace!: ManuscriptWorkspaceServiceType;

  @inject(NarrativeEntityService)
  protected readonly narrativeEntities!: NarrativeEntityServiceType;

  @inject(SourceLibraryService)
  protected readonly sourceLibrary!: SourceLibraryServiceType;

  @inject(EditorManager)
  protected readonly editorManager!: EditorManager;

  @inject(FileService)
  protected readonly fileService!: FileService;

  registerVariables(service: AIVariableService): void {
    for (const variable of ALL_VARIABLES) {
      service.registerVariable(variable);
      service.registerResolver(variable, this);
    }
  }

  canResolve(request: AIVariableResolutionRequest, _context: AIVariableContext): number {
    return ALL_VARIABLES.some(variable => variable.name === request.variable.name) ? 100 : 0;
  }

  async resolve(
    request: AIVariableResolutionRequest,
    _context: AIVariableContext
  ): Promise<ResolvedAIContextVariable | undefined> {
    const value = await this.resolveValue(request.variable.name, request.arg?.trim());
    if (value === undefined) {
      return undefined;
    }
    return {
      variable: request.variable,
      arg: request.arg,
      value,
      contextValue: value
    };
  }

  protected async resolveValue(name: string, arg?: string): Promise<string | undefined> {
    switch (name) {
      case 'manuscript':
        return this.contextAssembler.assemble();
      case 'chapter':
        return this.resolveChapter(arg);
      case 'entity':
        return this.resolveEntity(arg);
      case 'entities':
        return this.resolveEntities();
      case 'sources':
        return this.resolveSources();
      case 'outline':
        return this.resolveOutline();
      default:
        return undefined;
    }
  }

  protected async resolveChapter(arg?: string): Promise<string | undefined> {
    const snapshot = await this.manuscriptWorkspace.getSnapshot();
    let uri: URI | undefined;
    let label: string | undefined;

    if (arg) {
      if (!snapshot.rootUri || arg.includes('..')) {
        return `Chapter argument could not be resolved: ${arg}`;
      }
      uri = new URI(snapshot.rootUri).resolve(arg);
      label = arg;
    } else {
      const editor = this.editorManager.currentEditor?.editor ?? this.editorManager.activeEditor?.editor;
      if (!editor) {
        return 'No active editor; pass a workspace-relative path, e.g. #chapter:content/chapter-01.md';
      }
      uri = editor.uri;
      label = uri.path.base;
    }

    try {
      const content = await this.fileService.read(uri);
      const text = content.value.length > MAX_CHAPTER_CHARS
        ? `${content.value.slice(0, MAX_CHAPTER_CHARS)}\n\n[...truncated]`
        : content.value;
      return `# Chapter: ${label}\n\n${text}`;
    } catch (error) {
      return `Could not read chapter ${label}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  protected async resolveEntity(arg?: string): Promise<string> {
    if (!arg) {
      return 'Pass an entity id, e.g. #entity:krishna';
    }
    const snapshot = await this.narrativeEntities.getSnapshot();
    const entity = snapshot.entities.find(candidate => candidate.id === arg)
      ?? snapshot.entities.find(candidate => candidate.label.toLowerCase() === arg.toLowerCase());
    if (!entity) {
      return `No entity card found for "${arg}". Known ids: ${snapshot.entities.map(e => e.id).join(', ')}`;
    }
    return this.formatEntity(entity, true);
  }

  protected async resolveEntities(): Promise<string> {
    const snapshot = await this.narrativeEntities.getSnapshot();
    if (snapshot.entities.length === 0) {
      return 'The knowledge base has no entity cards yet.';
    }
    return [
      '# Entity Roster',
      ...snapshot.entities.map(entity => this.formatEntity(entity, false))
    ].join('\n');
  }

  protected formatEntity(entity: NarrativeEntity, full: boolean): string {
    const header = `- ${entity.kind}:${entity.id} — ${entity.label}`;
    const parts = [header];
    if (entity.aliases.length > 0) {
      parts.push(`  aliases: ${entity.aliases.join(', ')}`);
    }
    if (entity.epithets && entity.epithets.length > 0) {
      parts.push(`  epithets: ${entity.epithets.join(', ')}`);
    }
    if (entity.summary) {
      parts.push(`  summary: ${entity.summary}`);
    }
    if (full) {
      if (entity.arc) {
        parts.push(`  arc: ${entity.arc}`);
      }
      if (entity.backstory) {
        parts.push(`  backstory: ${entity.backstory}`);
      }
      if (entity.speechPatterns && entity.speechPatterns.length > 0) {
        parts.push(`  speech: ${entity.speechPatterns.join('; ')}`);
      }
      if (entity.notes) {
        parts.push(`  notes: ${entity.notes}`);
      }
    }
    return parts.join('\n');
  }

  protected async resolveSources(): Promise<string> {
    const snapshot = await this.sourceLibrary.getSnapshot();
    const lines: string[] = ['# Sources & Citations'];
    lines.push(`Files (${snapshot.items.length}):`);
    for (const item of snapshot.items) {
      lines.push(`- ${item.path}`);
    }
    lines.push(`Citations (${snapshot.citations.length}):`);
    for (const citation of snapshot.citations) {
      lines.push(`- [${citation.id}] ${citation.title ?? ''}${citation.source ? ` — ${citation.source}` : ''}`);
    }
    const excerpts = snapshot.excerpts ?? [];
    lines.push(`Excerpts (${excerpts.length}):`);
    for (const excerpt of excerpts.slice(0, 50)) {
      lines.push(`- [${excerpt.id}] ${excerpt.text.slice(0, 160)}${excerpt.text.length > 160 ? '…' : ''}`);
    }
    return lines.join('\n');
  }

  protected async resolveOutline(): Promise<string> {
    const snapshot = await this.manuscriptWorkspace.getSnapshot();
    const lines: string[] = ['# Book Outline'];
    if (!snapshot.rootUri) {
      return 'Open a manuscript workspace folder first.';
    }
    await this.appendOutline(snapshot.content, new URI(snapshot.rootUri), 0, lines);
    return lines.join('\n');
  }

  protected async appendOutline(nodes: ManuscriptNode[], root: URI, depth: number, out: string[]): Promise<void> {
    for (const node of [...nodes].sort((left, right) => left.order - right.order)) {
      const indent = '  '.repeat(depth);
      const marker = node.buildIncluded ? '' : ' (excluded)';
      out.push(`${indent}- ${node.name}${marker} [${node.path}]`);
      if (node.children) {
        await this.appendOutline(node.children, root, depth + 1, out);
        continue;
      }
      if (node.type === 'file' && node.buildIncluded && node.path.endsWith('.md')) {
        try {
          const content = await this.fileService.read(root.resolve(node.path));
          for (const heading of this.extractHeadings(content.value)) {
            out.push(`${indent}  ${'#'.repeat(heading.level)} ${heading.text}`);
          }
        } catch {
          // Unreadable chapters simply have no heading outline.
        }
      }
    }
  }

  protected extractHeadings(text: string): { level: number; text: string }[] {
    const headings: { level: number; text: string }[] = [];
    let inFence = false;
    for (const line of text.split('\n')) {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        continue;
      }
      if (inFence) {
        continue;
      }
      const match = line.match(/^(#{1,6})\s+(.*)$/);
      if (match) {
        headings.push({ level: match[1].length, text: match[2].trim() });
      }
    }
    return headings;
  }
}
