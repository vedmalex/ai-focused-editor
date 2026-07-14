import URI from '@theia/core/lib/common/uri';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import type { FileStat } from '@theia/filesystem/lib/common/files';
import { inject, injectable } from '@theia/core/shared/inversify';
import { PreferenceService } from '@theia/core/lib/common/preferences';
import { parse } from 'yaml';
import {
  ManuscriptNode,
  ManuscriptWorkspaceService,
  WorkspaceDiagnostic
} from '../common';
import { AI_CONNECT_MANUSCRIPT_OVERVIEW } from './ai-focused-editor-preferences';

const MAX_ENTITY_LINES = 30;
const MAX_SOURCE_LINES = 20;
const MAX_DIAGNOSTIC_LINES = 20;

/** Directories a compact overview tallies notes from (mirrors the `#note` scope). */
const NOTE_COUNT_PREFIXES = ['knowledge', 'ai'] as const;
const NOTE_COUNT_EXTENSIONS: ReadonlySet<string> = new Set(['.md', '.markdown', '.yaml', '.yml']);
const COUNT_WALK_MAX_DEPTH = 8;

@injectable()
export class ManuscriptAiContextAssembler {
  @inject(ManuscriptWorkspaceService)
  protected readonly manuscriptWorkspace!: ManuscriptWorkspaceService;

  @inject(FileService)
  protected readonly fileService!: FileService;

  @inject(PreferenceService)
  protected readonly preferenceService!: PreferenceService;

  async assemble(): Promise<string> {
    return this.overviewMode() === 'compact' ? this.assembleCompact() : this.assembleFull();
  }

  /** Resolved `aiConnect.manuscriptOverview` value (`full` by default). */
  protected overviewMode(): 'full' | 'compact' {
    return this.preferenceService.get<string>(AI_CONNECT_MANUSCRIPT_OVERVIEW, 'full') === 'compact'
      ? 'compact'
      : 'full';
  }

  /**
   * The historical full overview — byte-identical to the pre-preference output
   * so `full` never changes the always-on agent context.
   */
  protected async assembleFull(): Promise<string> {
    const snapshot = await this.manuscriptWorkspace.getSnapshot();
    const lines: string[] = [
      '# Manuscript Workspace Context',
      snapshot.rootUri ? `Workspace root: ${snapshot.rootUri}` : 'Workspace root: not open',
      snapshot.manifestUri ? `Manifest: ${snapshot.manifestUri}` : 'Manifest: missing',
      '',
      '## Content Manifest',
      ...this.formatContent(snapshot.content),
      '',
      '## Workspace Diagnostics',
      ...this.formatDiagnostics(snapshot.diagnostics)
    ];

    if (snapshot.rootUri) {
      const rootUri = new URI(snapshot.rootUri);
      lines.push(
        '',
        '## Entities',
        ...await this.formatEntityContext(rootUri),
        '',
        '## Sources',
        ...await this.formatSourceContext(rootUri)
      );
    }

    return lines.join('\n');
  }

  /**
   * A trimmed overview: the manifest structure skeleton plus diagnostics and
   * entity/source/note tallies, dropping the expanded entity and source
   * listings. Keeps the always-on context small for large books.
   */
  protected async assembleCompact(): Promise<string> {
    const snapshot = await this.manuscriptWorkspace.getSnapshot();
    const lines: string[] = [
      '# Manuscript Workspace Context (compact)',
      snapshot.rootUri ? `Workspace root: ${snapshot.rootUri}` : 'Workspace root: not open',
      snapshot.manifestUri ? `Manifest: ${snapshot.manifestUri}` : 'Manifest: missing',
      '',
      '## Content Manifest',
      ...this.formatContent(snapshot.content),
      '',
      '## Workspace Diagnostics',
      ...this.formatDiagnostics(snapshot.diagnostics)
    ];

    if (snapshot.rootUri) {
      const rootUri = new URI(snapshot.rootUri);
      const [entities, sources, notes] = await Promise.all([
        this.countEntities(rootUri),
        this.countFiles(rootUri.resolve('sources'), 0),
        this.countNotes(rootUri)
      ]);
      lines.push(
        '',
        '## Summary',
        `- Entities: ${entities}`,
        `- Sources: ${sources}`,
        `- Notes: ${notes}`,
        '',
        'Use #entities, #sources, or the Add-to-Chat-Context picker to pull specific cards or files in full.'
      );
    }

    return lines.join('\n');
  }

  /** Count entity YAML cards under `entities/` (recursively, bounded). */
  protected async countEntities(rootUri: URI): Promise<number> {
    return this.countFiles(rootUri.resolve('entities'), 0, name => name.endsWith('.yaml') || name.endsWith('.yml'));
  }

  /** Count knowledge/AI note files (markdown or YAML) under `knowledge/` and `ai/`. */
  protected async countNotes(rootUri: URI): Promise<number> {
    let total = 0;
    for (const prefix of NOTE_COUNT_PREFIXES) {
      total += await this.countFiles(rootUri.resolve(prefix), 0, name => {
        const dot = name.lastIndexOf('.');
        return dot >= 0 && NOTE_COUNT_EXTENSIONS.has(name.slice(dot).toLowerCase());
      });
    }
    return total;
  }

  /**
   * Count files under `dir` (recursively, depth-bounded), optionally filtered by
   * base name. Hidden folders and `node_modules` are skipped; a missing dir is 0.
   */
  protected async countFiles(dir: URI, depth: number, accept?: (name: string) => boolean): Promise<number> {
    if (depth > COUNT_WALK_MAX_DEPTH) {
      return 0;
    }
    const stat = await this.resolveIfExists(dir);
    if (!stat?.isDirectory || !stat.children) {
      return 0;
    }
    let total = 0;
    for (const child of stat.children) {
      if (child.isDirectory) {
        const base = child.resource.path.base;
        if (base.startsWith('.') || base === 'node_modules') {
          continue;
        }
        total += await this.countFiles(child.resource, depth + 1, accept);
        continue;
      }
      if (!accept || accept(child.resource.path.base)) {
        total += 1;
      }
    }
    return total;
  }

  protected formatContent(nodes: ManuscriptNode[], depth = 0): string[] {
    if (nodes.length === 0 && depth === 0) {
      return ['- No manifest content found.'];
    }

    return nodes.flatMap(node => {
      const indent = '  '.repeat(depth);
      const marker = node.buildIncluded ? 'included' : 'excluded';
      const own = `${indent}- ${node.type}: ${node.path} (${marker})`;
      const children = node.children ? this.formatContent(node.children, depth + 1) : [];
      return [own, ...children];
    });
  }

  protected formatDiagnostics(diagnostics: WorkspaceDiagnostic[]): string[] {
    if (diagnostics.length === 0) {
      return ['- No diagnostics.'];
    }

    const lines = diagnostics
      .slice(0, MAX_DIAGNOSTIC_LINES)
      .map(diagnostic => `- ${diagnostic.severity}: ${diagnostic.message}${diagnostic.uri ? ` (${diagnostic.uri})` : ''}`);

    if (diagnostics.length > MAX_DIAGNOSTIC_LINES) {
      lines.push(`- ... ${diagnostics.length - MAX_DIAGNOSTIC_LINES} more diagnostic(s).`);
    }
    return lines;
  }

  protected async formatEntityContext(rootUri: URI): Promise<string[]> {
    const characterLines = await this.readEntityDirectory(
      rootUri.resolve('entities/characters'),
      'character',
      'name'
    );
    const termLines = await this.readEntityDirectory(
      rootUri.resolve('entities/terms'),
      'term',
      'term'
    );

    const lines = [...characterLines, ...termLines];
    return lines.length > 0 ? lines : ['- No character or term entity files found.'];
  }

  protected async readEntityDirectory(directoryUri: URI, label: string, displayField: string): Promise<string[]> {
    const stat = await this.resolveIfExists(directoryUri);
    if (!stat?.isDirectory) {
      return [];
    }

    const children = [...(stat.children ?? [])]
      .filter(child => child.isFile && (child.name.endsWith('.yaml') || child.name.endsWith('.yml')))
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(0, MAX_ENTITY_LINES);

    const lines: string[] = [];
    for (const child of children) {
      const text = await this.readTextIfExists(child.resource);
      if (text === undefined) {
        continue;
      }

      try {
        const document = parse(text);
        if (this.isRecord(document)) {
          const id = this.stringifyField(document.id) || child.name.replace(/\.(ya?ml)$/i, '');
          const display = this.stringifyField(document[displayField]) || id;
          const summary = this.stringifyField(document.summary);
          lines.push(`- ${label}: ${id} -> ${display}${summary ? `; ${summary}` : ''}`);
        }
      } catch {
        lines.push(`- ${label}: ${child.name} -> invalid YAML`);
      }
    }

    return lines;
  }

  protected async formatSourceContext(rootUri: URI): Promise<string[]> {
    const sourceUri = rootUri.resolve('sources');
    const stat = await this.resolveIfExists(sourceUri);
    if (!stat?.isDirectory) {
      return ['- sources/ directory is not present.'];
    }

    const children = [...(stat.children ?? [])]
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(0, MAX_SOURCE_LINES);

    if (children.length === 0) {
      return ['- sources/ directory is empty.'];
    }

    return children.map(child => `- ${child.isDirectory ? 'directory' : 'file'}: sources/${child.name}`);
  }

  protected async readTextIfExists(resource: URI): Promise<string | undefined> {
    try {
      return (await this.fileService.read(resource)).value;
    } catch {
      return undefined;
    }
  }

  protected async resolveIfExists(resource: URI): Promise<FileStat | undefined> {
    try {
      return await this.fileService.resolve(resource);
    } catch {
      return undefined;
    }
  }

  protected stringifyField(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
  }

  protected isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}
