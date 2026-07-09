import { promises as fs } from 'fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import { FileUri } from '@theia/core/lib/common/file-uri';
import { injectable } from '@theia/core/shared/inversify';
import { parse } from 'yaml';
import type {
  BookBuildChapter,
  BookBuildRequest,
  BookBuildResult,
  BookBuildService,
  WorkspaceDiagnostic
} from '../common';

interface ManifestContentEntry {
  path?: unknown;
  title?: unknown;
  include?: unknown;
  children?: unknown;
}

interface ChapterSource {
  absolutePath: string;
  path: string;
  title: string;
  included: boolean;
}

interface BookMetadata {
  title: string;
  author?: string;
  language?: string;
}

interface YamlReadResult {
  exists: boolean;
  value?: unknown;
}

const DEFAULT_OUTPUT_PATH = 'build/book.md';

@injectable()
export class NodeBookBuildService implements BookBuildService {
  async buildMarkdown(request: BookBuildRequest = {}): Promise<BookBuildResult> {
    const rootPath = this.toRootPath(request.rootUri);
    const rootUri = FileUri.create(rootPath).toString();
    const generatedAt = new Date().toISOString();
    const diagnostics: WorkspaceDiagnostic[] = [];
    const outputPath = this.resolveOutputPath(rootPath, request.outputPath);
    const metadata = await this.readMetadata(rootPath, diagnostics);
    const sources = await this.readChapterSources(rootPath, diagnostics);
    const includedSources = sources.filter(source => source.included);

    if (includedSources.length === 0) {
      diagnostics.push({
        severity: 'error',
        source: 'book-build',
        uri: rootUri,
        message: 'No included Markdown chapters were found for book export.'
      });
    }

    if (this.hasErrors(diagnostics)) {
      return this.createFailedResult(rootUri, outputPath, metadata.title, diagnostics, generatedAt);
    }

    const chapters: BookBuildChapter[] = [];
    const chapterTexts: Array<{ source: ChapterSource; text: string }> = [];
    for (const source of includedSources) {
      const text = await this.readText(source.absolutePath, diagnostics);
      if (text !== undefined) {
        chapterTexts.push({ source, text });
        chapters.push({
          path: source.path,
          title: source.title,
          uri: FileUri.create(source.absolutePath).toString(),
          included: source.included,
          bytes: Buffer.byteLength(text)
        });
      }
    }

    if (this.hasErrors(diagnostics)) {
      return this.createFailedResult(rootUri, outputPath, metadata.title, diagnostics, generatedAt);
    }

    const parts: string[] = [
      this.renderFrontMatter(metadata, generatedAt),
      `# ${metadata.title}`,
      '',
      '## Table of Contents',
      ''
    ];

    for (const [index, source] of includedSources.entries()) {
      parts.push(`${index + 1}. [${source.title}](#${this.slugify(source.title)})`);
    }

    parts.push('');

    for (const { source, text } of chapterTexts) {
      parts.push(`<!-- Source: ${source.path} -->`);
      if (!this.startsWithHeading(text)) {
        parts.push('', `## ${source.title}`);
      }
      parts.push('', text.trimEnd(), '');
    }

    const content = `${parts.join('\n').replace(/\n{4,}/g, '\n\n\n').trimEnd()}\n`;
    await fs.mkdir(dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, content, 'utf8');

    return {
      rootUri,
      outputUri: FileUri.create(outputPath).toString(),
      outputPath,
      format: 'markdown',
      title: metadata.title,
      chapters,
      diagnostics,
      generatedAt,
      contentLength: content.length
    };
  }

  protected async readMetadata(rootPath: string, diagnostics: WorkspaceDiagnostic[]): Promise<BookMetadata> {
    const metadataPath = join(rootPath, 'metadata.yaml');
    const metadata = (await this.readYaml(metadataPath, diagnostics, false)).value;
    if (!this.isRecord(metadata)) {
      return {
        title: basename(rootPath)
      };
    }

    return {
      title: this.asNonEmptyString(metadata.title) ?? basename(rootPath),
      author: this.asNonEmptyString(metadata.author),
      language: this.asNonEmptyString(metadata.language)
    };
  }

  protected async readChapterSources(rootPath: string, diagnostics: WorkspaceDiagnostic[]): Promise<ChapterSource[]> {
    const manifestPath = join(rootPath, 'manifest.yaml');
    const manifestRead = await this.readYaml(manifestPath, diagnostics, false);
    if (!manifestRead.exists) {
      diagnostics.push({
        severity: 'warning',
        source: 'book-build',
        uri: FileUri.create(manifestPath).toString(),
        message: 'Missing manifest.yaml; falling back to sorted content/**/*.md export.'
      });
      return this.scanContentDirectory(rootPath, join(rootPath, 'content'), true, diagnostics);
    }

    const manifest = manifestRead.value;
    if (manifest === undefined) {
      return [];
    }

    if (!this.isRecord(manifest) || !Array.isArray(manifest.content)) {
      diagnostics.push({
        severity: 'error',
        source: 'book-build',
        uri: FileUri.create(manifestPath).toString(),
        message: 'manifest.yaml must contain a content list before book export can run.'
      });
      return [];
    }

    const sources: ChapterSource[] = [];
    for (const [index, entry] of manifest.content.entries()) {
      sources.push(...await this.manifestEntryToSources(rootPath, manifestPath, entry, true, index, diagnostics));
    }
    return sources;
  }

  protected async manifestEntryToSources(
    rootPath: string,
    manifestPath: string,
    entry: unknown,
    inheritedInclude: boolean,
    index: number,
    diagnostics: WorkspaceDiagnostic[]
  ): Promise<ChapterSource[]> {
    if (!this.isRecord(entry)) {
      diagnostics.push({
        severity: 'warning',
        source: 'book-build',
        uri: FileUri.create(manifestPath).toString(),
        message: `Ignoring manifest content entry ${index + 1}: expected object.`
      });
      return [];
    }

    const manifestEntry = entry as ManifestContentEntry;
    const rawPath = this.asNonEmptyString(manifestEntry.path);
    if (!rawPath) {
      diagnostics.push({
        severity: 'warning',
        source: 'book-build',
        uri: FileUri.create(manifestPath).toString(),
        message: `Ignoring manifest content entry ${index + 1}: missing path.`
      });
      return [];
    }

    const absolutePath = resolve(rootPath, rawPath);
    if (!this.isInside(rootPath, absolutePath)) {
      diagnostics.push({
        severity: 'error',
        source: 'book-build',
        uri: FileUri.create(manifestPath).toString(),
        message: `Manifest path escapes the workspace root: ${rawPath}`
      });
      return [];
    }

    const included = inheritedInclude && manifestEntry.include !== false;
    const stat = await this.statIfExists(absolutePath);
    if (!stat) {
      diagnostics.push({
        severity: 'error',
        source: 'book-build',
        uri: FileUri.create(absolutePath).toString(),
        message: `Manifest path does not exist: ${rawPath}`
      });
      return [];
    }

    if (stat.isDirectory()) {
      if (Array.isArray(manifestEntry.children)) {
        const sources: ChapterSource[] = [];
        for (const [childIndex, child] of manifestEntry.children.entries()) {
          sources.push(...await this.manifestEntryToSources(rootPath, manifestPath, child, included, childIndex, diagnostics));
        }
        return sources;
      }
      return this.scanContentDirectory(rootPath, absolutePath, included, diagnostics);
    }

    if (!stat.isFile() || !rawPath.endsWith('.md')) {
      diagnostics.push({
        severity: 'warning',
        source: 'book-build',
        uri: FileUri.create(absolutePath).toString(),
        message: `Skipping non-Markdown manifest entry: ${rawPath}`
      });
      return [];
    }

    return [{
      absolutePath,
      path: this.toWorkspacePath(rootPath, absolutePath),
      title: this.asNonEmptyString(manifestEntry.title) ?? this.titleFromPath(rawPath),
      included
    }];
  }

  protected async scanContentDirectory(
    rootPath: string,
    directoryPath: string,
    included: boolean,
    diagnostics: WorkspaceDiagnostic[]
  ): Promise<ChapterSource[]> {
    const stat = await this.statIfExists(directoryPath);
    if (!stat?.isDirectory()) {
      diagnostics.push({
        severity: 'error',
        source: 'book-build',
        uri: FileUri.create(directoryPath).toString(),
        message: 'Missing content directory for book export.'
      });
      return [];
    }

    const entries = await fs.readdir(directoryPath, { withFileTypes: true });
    const sources: ChapterSource[] = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const childPath = join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        sources.push(...await this.scanContentDirectory(rootPath, childPath, included, diagnostics));
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        sources.push({
          absolutePath: childPath,
          path: this.toWorkspacePath(rootPath, childPath),
          title: this.titleFromPath(entry.name),
          included
        });
      }
    }
    return sources;
  }

  protected renderFrontMatter(metadata: BookMetadata, generatedAt: string): string {
    const lines = [
      '---',
      `title: ${JSON.stringify(metadata.title)}`
    ];
    if (metadata.author) {
      lines.push(`author: ${JSON.stringify(metadata.author)}`);
    }
    if (metadata.language) {
      lines.push(`language: ${JSON.stringify(metadata.language)}`);
    }
    lines.push(`generated: ${JSON.stringify(generatedAt)}`);
    lines.push('---');
    return lines.join('\n');
  }

  protected async readYaml(path: string, diagnostics: WorkspaceDiagnostic[], required: boolean): Promise<YamlReadResult> {
    let text: string;
    try {
      text = await fs.readFile(path, 'utf8');
    } catch {
      if (required) {
        diagnostics.push({
          severity: 'error',
          source: 'book-build',
          uri: FileUri.create(path).toString(),
          message: `Missing YAML file: ${this.toDisplayPath(path)}`
        });
      }
      return { exists: false };
    }

    try {
      return {
        exists: true,
        value: parse(text)
      };
    } catch (error) {
      diagnostics.push({
        severity: 'error',
        source: 'book-build',
        uri: FileUri.create(path).toString(),
        message: `Invalid YAML: ${error instanceof Error ? error.message : String(error)}`
      });
      return { exists: true };
    }
  }

  protected async readText(path: string, diagnostics: WorkspaceDiagnostic[]): Promise<string | undefined> {
    try {
      return await fs.readFile(path, 'utf8');
    } catch (error) {
      diagnostics.push({
        severity: 'error',
        source: 'book-build',
        uri: FileUri.create(path).toString(),
        message: `Failed to read chapter: ${error instanceof Error ? error.message : String(error)}`
      });
      return undefined;
    }
  }

  protected async statIfExists(path: string): Promise<import('fs').Stats | undefined> {
    try {
      return await fs.stat(path);
    } catch {
      return undefined;
    }
  }

  protected toRootPath(rootUri: string | undefined): string {
    if (!rootUri) {
      return process.cwd();
    }
    if (rootUri.startsWith('file:')) {
      return FileUri.fsPath(rootUri);
    }
    return isAbsolute(rootUri) ? rootUri : resolve(process.cwd(), rootUri);
  }

  protected resolveOutputPath(rootPath: string, outputPath: string | undefined): string {
    const requested = outputPath?.trim() || DEFAULT_OUTPUT_PATH;
    const absolutePath = isAbsolute(requested) ? requested : resolve(rootPath, requested);
    if (!this.isInside(rootPath, absolutePath)) {
      return resolve(rootPath, DEFAULT_OUTPUT_PATH);
    }
    return absolutePath;
  }

  protected isInside(rootPath: string, path: string): boolean {
    const relativePath = relative(rootPath, path);
    return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
  }

  protected toWorkspacePath(rootPath: string, path: string): string {
    return relative(rootPath, path).split(sep).join('/');
  }

  protected titleFromPath(path: string): string {
    return basename(path, '.md')
      .replace(/[-_]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\b\w/g, character => character.toUpperCase());
  }

  protected slugify(title: string): string {
    const slug = title.toLowerCase()
      .replace(/[^a-z0-9а-яё\s-]/gi, '')
      .trim()
      .replace(/\s+/g, '-');
    return slug || 'section';
  }

  protected startsWithHeading(text: string): boolean {
    return /^#{1,6}\s+\S/m.test(text.trimStart().split(/\r?\n/, 1)[0] ?? '');
  }

  protected hasErrors(diagnostics: WorkspaceDiagnostic[]): boolean {
    return diagnostics.some(diagnostic => diagnostic.severity === 'error');
  }

  protected createFailedResult(
    rootUri: string,
    outputPath: string,
    title: string,
    diagnostics: WorkspaceDiagnostic[],
    generatedAt: string
  ): BookBuildResult {
    return {
      rootUri,
      outputUri: FileUri.create(outputPath).toString(),
      outputPath,
      format: 'markdown',
      title,
      chapters: [],
      diagnostics,
      generatedAt,
      contentLength: 0
    };
  }

  protected asNonEmptyString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
  }

  protected isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  protected toDisplayPath(path: string): string {
    return path.split(sep).join('/');
  }
}
