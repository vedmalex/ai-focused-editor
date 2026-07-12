import {
  AIContextVariable,
  AIVariableContribution,
  AIVariableContext,
  AIVariableResolutionRequest,
  AIVariableService,
  ResolvedAIContextVariable
} from '@theia/ai-core';
import { AIVariableCompletionContext } from '@theia/ai-core/lib/browser';
import { injectable, inject } from '@theia/core/shared/inversify';
import { nls } from '@theia/core/lib/common/nls';
import { QuickInputService } from '@theia/core/lib/common';
import URI from '@theia/core/lib/common/uri';
import * as monaco from '@theia/monaco-editor-core';
import { EditorManager } from '@theia/editor/lib/browser/editor-manager';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import type {
  CitationEntry,
  ManuscriptNode,
  NarrativeEntity,
  SourceExcerpt
} from '../common';
import { summarizeExcalidrawScene } from '../common/diagram-summary';
import {
  ManuscriptWorkspaceService,
  NarrativeEntityService,
  SourceLibraryBackendService,
  SourceLibraryService
} from '../common';
import type {
  ManuscriptWorkspaceService as ManuscriptWorkspaceServiceType,
  NarrativeEntityService as NarrativeEntityServiceType,
  SourceLibraryBackendService as SourceLibraryBackendServiceType,
  SourceLibraryService as SourceLibraryServiceType
} from '../common';
import { extractFirstHeading } from '../common/manifest-reconstruction';
import { ManuscriptAiContextAssembler } from './manuscript-ai-context-assembler';

const MAX_CHAPTER_CHARS = 24000;
const MAX_SOURCE_CHARS = 24000;
const MAX_NOTE_CHARS = 24000;
const MAX_DIAGRAM_CHARS = 16000;

/** How many excerpts a `#citation` inlines before summarizing the remainder. */
const MAX_CITATION_EXCERPTS = 12;

/** Per-excerpt text budget when inlined under a `#citation`. */
const MAX_CITATION_EXCERPT_CHARS = 1200;

/** Full-text budget for a single `#excerpt`. */
const MAX_EXCERPT_CHARS = 8000;

/** Text-preview length for excerpt pickers/completions. */
const EXCERPT_PREVIEW_CHARS = 100;

/** Diagram extension the `#diagram` variable reads. */
const DIAGRAM_EXTENSION = '.excalidraw';

/** Standard book-level files offered under the picker's «Книга» category. */
const BOOK_FILES = ['manifest.yaml', 'metadata.yaml'] as const;

/**
 * Command that attaches a resolved context variable to the active chat session.
 * Provided by `@theia/ai-chat` (`ai-chat-frontend-contribution`) with
 * `arguments: [variableName, arg]`; referenced by id so this contribution does
 * not deep-import a browser-internal module.
 */
const ADD_CONTEXT_VARIABLE_COMMAND_ID = 'add-context-variable';

/**
 * Source formats read server-side (they are not decodable as text in the
 * browser); everything else is read directly through the `FileService`.
 */
const BINARY_SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.pdf', '.docx', '.doc', '.pptx', '.ppt', '.xlsx', '.xls', '.odt', '.rtf'
]);

/** Directories a `#note` may read from (author knowledge + AI config). */
const NOTE_ALLOWED_PREFIXES = ['knowledge/', 'ai/'] as const;

/** Extensions a `#note` may read (markdown + yaml). */
const NOTE_ALLOWED_EXTENSIONS: ReadonlySet<string> = new Set(['.md', '.markdown', '.yaml', '.yml']);

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
  isContextVariable: true,
  args: [{
    name: 'path',
    description: nls.localize(
      'ai-focused-editor/workspace/var-chapter-arg-path',
      'Workspace-relative Markdown path; omit to use the active editor.'
    ),
    isOptional: true
  }]
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
  isContextVariable: true,
  args: [{
    name: 'id',
    description: nls.localize(
      'ai-focused-editor/workspace/var-entity-arg-id',
      'Entity id (or label), e.g. krishna.'
    )
  }]
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

export const SOURCE_CONTEXT_VARIABLE: AIContextVariable = {
  id: 'ai-focused-editor.source-context',
  name: 'source',
  label: nls.localize('ai-focused-editor/workspace/var-source-label', 'Source Document'),
  description: nls.localize(
    'ai-focused-editor/workspace/var-source-description',
    'The extracted text of one source document by workspace-relative path (#source:sources/paper.pdf). Binary formats (PDF, Word, Office) are extracted server-side.'
  ),
  iconClasses: ['fa', 'fa-file-o'],
  isContextVariable: true,
  args: [{
    name: 'path',
    description: nls.localize(
      'ai-focused-editor/workspace/var-source-arg-path',
      'Workspace-relative path of a file under sources/, e.g. sources/paper.pdf.'
    )
  }]
};

export const NOTE_CONTEXT_VARIABLE: AIContextVariable = {
  id: 'ai-focused-editor.note-context',
  name: 'note',
  label: nls.localize('ai-focused-editor/workspace/var-note-label', 'Knowledge Note'),
  description: nls.localize(
    'ai-focused-editor/workspace/var-note-description',
    'A single knowledge note (markdown or YAML) under knowledge/ or ai/ by workspace-relative path (#note:knowledge/plans/outline.md).'
  ),
  iconClasses: ['fa', 'fa-sticky-note-o'],
  isContextVariable: true,
  args: [{
    name: 'path',
    description: nls.localize(
      'ai-focused-editor/workspace/var-note-arg-path',
      'Workspace-relative path under knowledge/ or ai/, e.g. knowledge/plans/outline.md.'
    )
  }]
};

export const CITATION_CONTEXT_VARIABLE: AIContextVariable = {
  id: 'ai-focused-editor.citation-context',
  name: 'citation',
  label: nls.localize('ai-focused-editor/workspace/var-citation-label', 'Citation'),
  description: nls.localize(
    'ai-focused-editor/workspace/var-citation-description',
    'One citation record by id (#citation:smith2020) — its title, source, and note plus the source excerpts tied to it.'
  ),
  iconClasses: ['fa', 'fa-quote-left'],
  isContextVariable: true,
  args: [{
    name: 'id',
    description: nls.localize(
      'ai-focused-editor/workspace/var-citation-arg-id',
      'Citation id from sources/citations.yaml, e.g. smith2020.'
    )
  }]
};

export const EXCERPT_CONTEXT_VARIABLE: AIContextVariable = {
  id: 'ai-focused-editor.excerpt-context',
  name: 'excerpt',
  label: nls.localize('ai-focused-editor/workspace/var-excerpt-label', 'Source Excerpt'),
  description: nls.localize(
    'ai-focused-editor/workspace/var-excerpt-description',
    'One source excerpt by id (#excerpt:ex-12) — its full text, note, source, and manuscript back-link.'
  ),
  iconClasses: ['fa', 'fa-indent'],
  isContextVariable: true,
  args: [{
    name: 'id',
    description: nls.localize(
      'ai-focused-editor/workspace/var-excerpt-arg-id',
      'Excerpt id from sources/excerpts.jsonl, e.g. ex-12.'
    )
  }]
};

export const DIAGRAM_CONTEXT_VARIABLE: AIContextVariable = {
  id: 'ai-focused-editor.diagram-context',
  name: 'diagram',
  label: nls.localize('ai-focused-editor/workspace/var-diagram-label', 'Diagram'),
  description: nls.localize(
    'ai-focused-editor/workspace/var-diagram-description',
    'An Excalidraw diagram by workspace-relative path (#diagram:sources/relations-map.excalidraw), summarized as text: nodes, entity links, and connections.'
  ),
  iconClasses: ['fa', 'fa-sitemap'],
  isContextVariable: true,
  args: [{
    name: 'path',
    description: nls.localize(
      'ai-focused-editor/workspace/var-diagram-arg-path',
      'Workspace-relative path of an .excalidraw file, e.g. sources/relations-map.excalidraw.'
    )
  }]
};

const ALL_VARIABLES = [
  MANUSCRIPT_CONTEXT_VARIABLE,
  CHAPTER_CONTEXT_VARIABLE,
  ENTITY_CONTEXT_VARIABLE,
  ENTITIES_CONTEXT_VARIABLE,
  SOURCES_CONTEXT_VARIABLE,
  OUTLINE_CONTEXT_VARIABLE,
  SOURCE_CONTEXT_VARIABLE,
  NOTE_CONTEXT_VARIABLE,
  CITATION_CONTEXT_VARIABLE,
  EXCERPT_CONTEXT_VARIABLE,
  DIAGRAM_CONTEXT_VARIABLE
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

  @inject(SourceLibraryBackendService)
  protected readonly sourceLibraryBackend!: SourceLibraryBackendServiceType;

  @inject(EditorManager)
  protected readonly editorManager!: EditorManager;

  @inject(FileService)
  protected readonly fileService!: FileService;

  @inject(QuickInputService)
  protected readonly quickInput!: QuickInputService;

  registerVariables(service: AIVariableService): void {
    for (const variable of ALL_VARIABLES) {
      service.registerVariable(variable);
      service.registerResolver(variable, this);
    }

    // Argument pickers (paperclip / QuickPick) and inline `#var:` completion
    // providers for the variables that take an argument. MANUSCRIPT/ENTITIES/
    // OUTLINE/SOURCES stay arg-less and get neither.
    service.registerArgumentPicker(CHAPTER_CONTEXT_VARIABLE, () => this.pickChapter());
    service.registerArgumentCompletionProvider(
      CHAPTER_CONTEXT_VARIABLE,
      (model, position, match) => this.completeChapter(model, position, match)
    );
    service.registerArgumentPicker(ENTITY_CONTEXT_VARIABLE, () => this.pickEntity());
    service.registerArgumentCompletionProvider(
      ENTITY_CONTEXT_VARIABLE,
      (model, position, match) => this.completeEntity(model, position, match)
    );
    service.registerArgumentPicker(SOURCE_CONTEXT_VARIABLE, () => this.pickSource());
    service.registerArgumentCompletionProvider(
      SOURCE_CONTEXT_VARIABLE,
      (model, position, match) => this.completeSource(model, position, match)
    );
    service.registerArgumentPicker(NOTE_CONTEXT_VARIABLE, () => this.pickNote());
    service.registerArgumentCompletionProvider(
      NOTE_CONTEXT_VARIABLE,
      (model, position, match) => this.completeNote(model, position, match)
    );
    service.registerArgumentPicker(CITATION_CONTEXT_VARIABLE, () => this.pickCitation());
    service.registerArgumentCompletionProvider(
      CITATION_CONTEXT_VARIABLE,
      (model, position, match) => this.completeCitation(model, position, match)
    );
    service.registerArgumentPicker(EXCERPT_CONTEXT_VARIABLE, () => this.pickExcerpt());
    service.registerArgumentCompletionProvider(
      EXCERPT_CONTEXT_VARIABLE,
      (model, position, match) => this.completeExcerpt(model, position, match)
    );
    service.registerArgumentPicker(DIAGRAM_CONTEXT_VARIABLE, () => this.pickDiagram());
    service.registerArgumentCompletionProvider(
      DIAGRAM_CONTEXT_VARIABLE,
      (model, position, match) => this.completeDiagram(model, position, match)
    );
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
      case 'source':
        return this.resolveSource(arg);
      case 'note':
        return this.resolveNote(arg);
      case 'citation':
        return this.resolveCitation(arg);
      case 'excerpt':
        return this.resolveExcerpt(arg);
      case 'diagram':
        return this.resolveDiagram(arg);
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

  // --- #source --------------------------------------------------------------

  protected async resolveSource(arg?: string): Promise<string> {
    if (!arg) {
      return 'Pass a source path, e.g. #source:sources/paper.pdf';
    }
    if (arg.includes('..')) {
      return `Source path escapes the workspace: ${arg}`;
    }
    const snapshot = await this.manuscriptWorkspace.getSnapshot();
    if (!snapshot.rootUri) {
      return 'Open a manuscript workspace folder first.';
    }
    const rootUri = snapshot.rootUri;
    const extension = this.extensionOf(arg);
    if (BINARY_SOURCE_EXTENSIONS.has(extension)) {
      let extraction;
      try {
        extraction = await this.sourceLibraryBackend.extractSourceText(rootUri, arg);
      } catch (error) {
        return `Could not extract text from ${arg}: ${this.detail(error)}`;
      }
      if (!extraction.ok || extraction.text === undefined) {
        return `Could not extract text from ${arg}: ${extraction.detail ?? 'no extractable text found.'}`;
      }
      return `# Source: ${arg}\n\n${this.cap(extraction.text, MAX_SOURCE_CHARS)}`;
    }
    try {
      const content = await this.fileService.read(new URI(rootUri).resolve(arg));
      return `# Source: ${arg}\n\n${this.cap(content.value, MAX_SOURCE_CHARS)}`;
    } catch (error) {
      return `Could not read source ${arg}: ${this.detail(error)}`;
    }
  }

  // --- #note ----------------------------------------------------------------

  protected async resolveNote(arg?: string): Promise<string> {
    if (!arg) {
      return 'Pass a note path, e.g. #note:knowledge/plans/outline.md';
    }
    if (arg.includes('..')) {
      return `Note path escapes the workspace: ${arg}`;
    }
    if (!this.isAllowedNotePath(arg)) {
      return `#note only reads files under knowledge/ or ai/ (markdown or YAML): ${arg}`;
    }
    const snapshot = await this.manuscriptWorkspace.getSnapshot();
    if (!snapshot.rootUri) {
      return 'Open a manuscript workspace folder first.';
    }
    try {
      const content = await this.fileService.read(new URI(snapshot.rootUri).resolve(arg));
      return `# Note: ${arg}\n\n${this.cap(content.value, MAX_NOTE_CHARS)}`;
    } catch (error) {
      return `Could not read note ${arg}: ${this.detail(error)}`;
    }
  }

  protected isAllowedNotePath(path: string): boolean {
    if (!NOTE_ALLOWED_PREFIXES.some(prefix => path.startsWith(prefix))) {
      return false;
    }
    return NOTE_ALLOWED_EXTENSIONS.has(this.extensionOf(path));
  }

  // --- #citation ------------------------------------------------------------

  protected async resolveCitation(arg?: string): Promise<string> {
    if (!arg) {
      return 'Pass a citation id, e.g. #citation:smith2020';
    }
    const snapshot = await this.sourceLibrary.getSnapshot();
    const citation = snapshot.citations.find(candidate => candidate.id === arg);
    if (!citation) {
      const known = snapshot.citations.map(candidate => candidate.id).join(', ');
      return `No citation found for "${arg}".${known ? ` Known ids: ${known}` : ''}`;
    }
    const related = (snapshot.excerpts ?? []).filter(excerpt => excerpt.sourceId === citation.id);
    const lines: string[] = [`# Citation: ${citation.id}`];
    if (citation.title) {
      lines.push(`Title: ${citation.title}`);
    }
    if (citation.source) {
      lines.push(`Source: ${citation.source}`);
    }
    if (citation.path) {
      lines.push(`File: ${citation.path}`);
    }
    if (citation.note) {
      lines.push('', `Note: ${citation.note}`);
    }
    if (related.length > 0) {
      lines.push('', `## Related excerpts (${related.length})`);
      for (const excerpt of related.slice(0, MAX_CITATION_EXCERPTS)) {
        lines.push(`- [${excerpt.id}] ${this.cap(excerpt.text, MAX_CITATION_EXCERPT_CHARS)}`);
      }
      if (related.length > MAX_CITATION_EXCERPTS) {
        lines.push(`- …and ${related.length - MAX_CITATION_EXCERPTS} more`);
      }
    }
    return lines.join('\n');
  }

  // --- #excerpt -------------------------------------------------------------

  protected async resolveExcerpt(arg?: string): Promise<string> {
    if (!arg) {
      return 'Pass an excerpt id, e.g. #excerpt:ex-12';
    }
    const snapshot = await this.sourceLibrary.getSnapshot();
    const excerpt = (snapshot.excerpts ?? []).find(candidate => candidate.id === arg);
    if (!excerpt) {
      return `No excerpt found for "${arg}".`;
    }
    const lines: string[] = [`# Excerpt: ${excerpt.id}`];
    if (excerpt.sourceId) {
      lines.push(`Source: ${excerpt.sourceId}`);
    }
    if (excerpt.sourcePath) {
      lines.push(`Source file: ${excerpt.sourcePath}`);
    }
    if (excerpt.targetPath) {
      const anchor = excerpt.targetAnchor ? `#${excerpt.targetAnchor}` : '';
      const line = excerpt.targetLine ? ` (line ${excerpt.targetLine})` : '';
      lines.push(`Manuscript link: ${excerpt.targetPath}${anchor}${line}`);
    }
    if (excerpt.note) {
      lines.push('', `Note: ${excerpt.note}`);
    }
    lines.push('', this.cap(excerpt.text, MAX_EXCERPT_CHARS));
    return lines.join('\n');
  }

  // --- #diagram -------------------------------------------------------------

  protected async resolveDiagram(arg?: string): Promise<string> {
    if (!arg) {
      return 'Pass a diagram path, e.g. #diagram:sources/relations-map.excalidraw';
    }
    if (arg.includes('..')) {
      return `Diagram path escapes the workspace: ${arg}`;
    }
    if (this.extensionOf(arg) !== DIAGRAM_EXTENSION) {
      return `#diagram only reads ${DIAGRAM_EXTENSION} files: ${arg}`;
    }
    const snapshot = await this.manuscriptWorkspace.getSnapshot();
    if (!snapshot.rootUri) {
      return 'Open a manuscript workspace folder first.';
    }
    let raw: string;
    try {
      raw = (await this.fileService.read(new URI(snapshot.rootUri).resolve(arg))).value;
    } catch (error) {
      return `Could not read diagram ${arg}: ${this.detail(error)}`;
    }
    let scene: unknown;
    try {
      scene = JSON.parse(raw);
    } catch (error) {
      return `Could not parse diagram ${arg}: ${this.detail(error)}`;
    }
    return summarizeExcalidrawScene(scene, { title: arg, maxChars: MAX_DIAGRAM_CHARS });
  }

  // --- Argument pickers (paperclip / QuickPick) -----------------------------

  protected async pickChapter(): Promise<string | undefined> {
    const chapters = await this.collectChapters();
    if (chapters.length === 0) {
      return undefined;
    }
    const picked = await this.quickInput.showQuickPick(
      chapters.map(chapter => ({ label: chapter.title, description: chapter.path, value: chapter.path })),
      { placeholder: nls.localize('ai-focused-editor/chat-context/pick-chapter', 'Select a chapter') }
    );
    return picked?.value;
  }

  protected async pickEntity(): Promise<string | undefined> {
    const entities = await this.collectEntities();
    if (entities.length === 0) {
      return undefined;
    }
    const picked = await this.quickInput.showQuickPick(
      entities.map(entity => ({ label: entity.label, description: entity.id, value: entity.id })),
      { placeholder: nls.localize('ai-focused-editor/chat-context/pick-entity', 'Select an entity') }
    );
    return picked?.value;
  }

  async pickSource(): Promise<string | undefined> {
    const sources = await this.collectSources();
    if (sources.length === 0) {
      return undefined;
    }
    const picked = await this.quickInput.showQuickPick(
      sources.map(source => ({ label: source.label, description: source.path, value: source.path })),
      { placeholder: nls.localize('ai-focused-editor/chat-context/pick-source', 'Select a source document') }
    );
    return picked?.value;
  }

  async pickNote(): Promise<string | undefined> {
    const notes = await this.collectNotes();
    if (notes.length === 0) {
      return undefined;
    }
    const picked = await this.quickInput.showQuickPick(
      notes.map(note => ({ label: note.label, description: note.path, value: note.path })),
      { placeholder: nls.localize('ai-focused-editor/chat-context/pick-note', 'Select a knowledge note') }
    );
    return picked?.value;
  }

  protected async pickCitation(): Promise<string | undefined> {
    const citations = await this.collectCitations();
    if (citations.length === 0) {
      return undefined;
    }
    const picked = await this.quickInput.showQuickPick(
      citations.map(citation => ({ label: citation.label, description: citation.id, value: citation.id })),
      { placeholder: nls.localize('ai-focused-editor/chat-context/pick-citation', 'Select a citation') }
    );
    return picked?.value;
  }

  protected async pickExcerpt(): Promise<string | undefined> {
    const excerpts = await this.collectExcerpts();
    if (excerpts.length === 0) {
      return undefined;
    }
    const picked = await this.quickInput.showQuickPick(
      excerpts.map(excerpt => ({ label: excerpt.id, description: excerpt.preview, value: excerpt.id })),
      { placeholder: nls.localize('ai-focused-editor/chat-context/pick-excerpt', 'Select a source excerpt') }
    );
    return picked?.value;
  }

  protected async pickDiagram(): Promise<string | undefined> {
    const diagrams = await this.collectDiagrams();
    if (diagrams.length === 0) {
      return undefined;
    }
    const picked = await this.quickInput.showQuickPick(
      diagrams.map(diagram => ({ label: diagram.label, description: diagram.path, value: diagram.path })),
      { placeholder: nls.localize('ai-focused-editor/chat-context/pick-diagram', 'Select a diagram') }
    );
    return picked?.value;
  }

  // --- Inline `#var:` completion providers ----------------------------------

  protected async completeChapter(
    model: monaco.editor.ITextModel,
    position: monaco.Position,
    matchString?: string
  ): Promise<monaco.languages.CompletionItem[] | undefined> {
    const chapters = await this.collectChapters();
    return this.toCompletionItems(
      CHAPTER_CONTEXT_VARIABLE.name,
      model,
      position,
      matchString,
      chapters.map(chapter => ({ label: chapter.title, detail: chapter.path, value: chapter.path }))
    );
  }

  protected async completeEntity(
    model: monaco.editor.ITextModel,
    position: monaco.Position,
    matchString?: string
  ): Promise<monaco.languages.CompletionItem[] | undefined> {
    const entities = await this.collectEntities();
    return this.toCompletionItems(
      ENTITY_CONTEXT_VARIABLE.name,
      model,
      position,
      matchString,
      entities.map(entity => ({ label: entity.label, detail: entity.id, value: entity.id }))
    );
  }

  protected async completeSource(
    model: monaco.editor.ITextModel,
    position: monaco.Position,
    matchString?: string
  ): Promise<monaco.languages.CompletionItem[] | undefined> {
    const sources = await this.collectSources();
    return this.toCompletionItems(
      SOURCE_CONTEXT_VARIABLE.name,
      model,
      position,
      matchString,
      sources.map(source => ({ label: source.label, detail: source.path, value: source.path }))
    );
  }

  protected async completeNote(
    model: monaco.editor.ITextModel,
    position: monaco.Position,
    matchString?: string
  ): Promise<monaco.languages.CompletionItem[] | undefined> {
    const notes = await this.collectNotes();
    return this.toCompletionItems(
      NOTE_CONTEXT_VARIABLE.name,
      model,
      position,
      matchString,
      notes.map(note => ({ label: note.label, detail: note.path, value: note.path }))
    );
  }

  protected async completeCitation(
    model: monaco.editor.ITextModel,
    position: monaco.Position,
    matchString?: string
  ): Promise<monaco.languages.CompletionItem[] | undefined> {
    const citations = await this.collectCitations();
    return this.toCompletionItems(
      CITATION_CONTEXT_VARIABLE.name,
      model,
      position,
      matchString,
      citations.map(citation => ({ label: citation.label, detail: citation.id, value: citation.id }))
    );
  }

  protected async completeExcerpt(
    model: monaco.editor.ITextModel,
    position: monaco.Position,
    matchString?: string
  ): Promise<monaco.languages.CompletionItem[] | undefined> {
    const excerpts = await this.collectExcerpts();
    return this.toCompletionItems(
      EXCERPT_CONTEXT_VARIABLE.name,
      model,
      position,
      matchString,
      excerpts.map(excerpt => ({ label: excerpt.id, detail: excerpt.preview, value: excerpt.id }))
    );
  }

  protected async completeDiagram(
    model: monaco.editor.ITextModel,
    position: monaco.Position,
    matchString?: string
  ): Promise<monaco.languages.CompletionItem[] | undefined> {
    const diagrams = await this.collectDiagrams();
    return this.toCompletionItems(
      DIAGRAM_CONTEXT_VARIABLE.name,
      model,
      position,
      matchString,
      diagrams.map(diagram => ({ label: diagram.label, detail: diagram.path, value: diagram.path }))
    );
  }

  /**
   * Map candidate `{label, detail, value}` rows to Monaco completion items,
   * inserting `var:<value>` and (on accept) attaching the variable to the chat
   * context via the shared `add-context-variable` command — mirroring
   * `file-chat-variable-contribution`.
   */
  protected toCompletionItems(
    variableName: string,
    model: monaco.editor.ITextModel,
    position: monaco.Position,
    matchString: string | undefined,
    candidates: { label: string; detail: string; value: string }[]
  ): monaco.languages.CompletionItem[] | undefined {
    const context = AIVariableCompletionContext.get(variableName, model, position, matchString);
    if (!context) {
      return undefined;
    }
    const { userInput, range, prefix } = context;
    const lowered = userInput.toLowerCase();
    return candidates
      .filter(candidate => !userInput
        || candidate.value.toLowerCase().includes(lowered)
        || candidate.label.toLowerCase().includes(lowered))
      .map((candidate, index) => ({
        label: candidate.label,
        kind: monaco.languages.CompletionItemKind.Value,
        range,
        insertText: `${prefix}${candidate.value}`,
        detail: candidate.detail,
        filterText: userInput ? `${candidate.label} ${candidate.value}` : undefined,
        sortText: `ZZ${index.toString().padStart(4, '0')}`,
        command: {
          title: nls.localize('ai-focused-editor/chat-context/attach', 'Attach to Chat Context'),
          id: ADD_CONTEXT_VARIABLE_COMMAND_ID,
          arguments: [variableName, candidate.value]
        }
      }));
  }

  // --- Candidate enumeration (shared by pickers + completions) --------------

  /** All build-included Markdown chapters, as `{ path, title }`. */
  async collectChapters(): Promise<{ path: string; title: string }[]> {
    const snapshot = await this.manuscriptWorkspace.getSnapshot();
    const out: { path: string; title: string }[] = [];
    this.flattenChapters(snapshot.content, out);
    return out;
  }

  protected flattenChapters(nodes: ManuscriptNode[], out: { path: string; title: string }[]): void {
    for (const node of [...nodes].sort((left, right) => left.order - right.order)) {
      if (node.children) {
        this.flattenChapters(node.children, out);
        continue;
      }
      if (node.type === 'file' && node.path.endsWith('.md')) {
        out.push({ path: node.path, title: node.name || node.path });
      }
    }
  }

  /** All entity cards, as `{ id, label }`. */
  async collectEntities(): Promise<{ id: string; label: string }[]> {
    const snapshot = await this.narrativeEntities.getSnapshot();
    return snapshot.entities.map(entity => ({ id: entity.id, label: entity.label?.trim() || entity.id }));
  }

  /** All source files (workspace-relative), as `{ path, label }`. */
  async collectSources(): Promise<{ path: string; label: string }[]> {
    const snapshot = await this.sourceLibrary.getSnapshot();
    return snapshot.items
      .filter(item => item.type === 'file')
      .map(item => ({ path: item.path, label: item.name }));
  }

  /** All citation records, as `{ id, label }` (label falls back to the id). */
  async collectCitations(): Promise<{ id: string; label: string }[]> {
    const snapshot = await this.sourceLibrary.getSnapshot();
    return snapshot.citations.map((citation: CitationEntry) => ({
      id: citation.id,
      label: citation.title?.trim() || citation.id
    }));
  }

  /** All source excerpts, as `{ id, preview }` (a single-line text preview). */
  async collectExcerpts(): Promise<{ id: string; preview: string }[]> {
    const snapshot = await this.sourceLibrary.getSnapshot();
    return (snapshot.excerpts ?? []).map((excerpt: SourceExcerpt) => ({
      id: excerpt.id,
      preview: this.previewOf(excerpt.text)
    }));
  }

  /** All `.excalidraw` diagrams in the workspace, as `{ path, label }`. */
  async collectDiagrams(): Promise<{ path: string; label: string }[]> {
    const snapshot = await this.manuscriptWorkspace.getSnapshot();
    if (!snapshot.rootUri) {
      return [];
    }
    const root = new URI(snapshot.rootUri);
    const out: { path: string; label: string }[] = [];
    await this.walkDiagrams(root, root, out, 0);
    out.sort((left, right) => left.path.localeCompare(right.path));
    return out;
  }

  protected async walkDiagrams(
    root: URI,
    dir: URI,
    out: { path: string; label: string }[],
    depth: number
  ): Promise<void> {
    if (depth > 8 || out.length >= 200) {
      return;
    }
    const stat = await this.fileService.resolve(dir).catch(() => undefined);
    if (!stat?.children) {
      return;
    }
    for (const child of stat.children) {
      if (child.isDirectory) {
        // Skip hidden folders and dependency trees; manuscripts are small.
        if (child.resource.path.base.startsWith('.') || child.resource.path.base === 'node_modules') {
          continue;
        }
        await this.walkDiagrams(root, child.resource, out, depth + 1);
        continue;
      }
      if (this.extensionOf(child.resource.path.base) !== DIAGRAM_EXTENSION) {
        continue;
      }
      const relative = root.relative(child.resource)?.toString();
      if (relative) {
        out.push({ path: relative, label: child.resource.path.base });
      }
    }
  }

  /**
   * Book-level files (`manifest.yaml`, `metadata.yaml`) that exist at the root,
   * returned as root-prefixed paths so the core `#file` variable resolves them.
   */
  async collectBookFiles(): Promise<{ path: string; label: string }[]> {
    const snapshot = await this.manuscriptWorkspace.getSnapshot();
    if (!snapshot.rootUri) {
      return [];
    }
    const root = new URI(snapshot.rootUri);
    const rootName = root.path.base;
    const out: { path: string; label: string }[] = [];
    for (const name of BOOK_FILES) {
      if (await this.fileService.exists(root.resolve(name))) {
        out.push({ path: rootName ? `${rootName}/${name}` : name, label: name });
      }
    }
    return out;
  }

  protected previewOf(text: string): string {
    const collapsed = text.replace(/\s+/g, ' ').trim();
    return collapsed.length > EXCERPT_PREVIEW_CHARS
      ? `${collapsed.slice(0, EXCERPT_PREVIEW_CHARS)}…`
      : collapsed;
  }

  /**
   * Knowledge/AI notes discoverable under `knowledge/` and `ai/`, as
   * `{ path, label }`. Labels use the first Markdown heading when cheaply
   * available, else the file name.
   */
  async collectNotes(): Promise<{ path: string; label: string }[]> {
    const snapshot = await this.manuscriptWorkspace.getSnapshot();
    if (!snapshot.rootUri) {
      return [];
    }
    const root = new URI(snapshot.rootUri);
    const out: { path: string; label: string }[] = [];
    for (const prefix of NOTE_ALLOWED_PREFIXES) {
      await this.walkNotes(root, root.resolve(prefix.replace(/\/$/, '')), out);
    }
    out.sort((left, right) => left.path.localeCompare(right.path));
    return out;
  }

  protected async walkNotes(root: URI, dir: URI, out: { path: string; label: string }[]): Promise<void> {
    const stat = await this.fileService.resolve(dir).catch(() => undefined);
    if (!stat?.children) {
      return;
    }
    for (const child of stat.children) {
      if (child.isDirectory) {
        await this.walkNotes(root, child.resource, out);
        continue;
      }
      const relative = root.relative(child.resource)?.toString();
      if (!relative || !NOTE_ALLOWED_EXTENSIONS.has(this.extensionOf(relative))) {
        continue;
      }
      out.push({ path: relative, label: await this.noteLabel(child.resource, relative) });
    }
  }

  /** First Markdown heading (best-effort) for a note, else its file name. */
  protected async noteLabel(resource: URI, relative: string): Promise<string> {
    const fallback = resource.path.base;
    if (this.extensionOf(relative) !== '.md' && this.extensionOf(relative) !== '.markdown') {
      return fallback;
    }
    try {
      const content = await this.fileService.read(resource);
      return extractFirstHeading(content.value.slice(0, 2048)) ?? fallback;
    } catch {
      return fallback;
    }
  }

  protected extensionOf(path: string): string {
    const base = path.slice(path.lastIndexOf('/') + 1);
    const dot = base.lastIndexOf('.');
    return dot < 0 ? '' : base.slice(dot).toLowerCase();
  }

  protected cap(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max)}\n\n[...truncated]` : text;
  }

  protected detail(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
