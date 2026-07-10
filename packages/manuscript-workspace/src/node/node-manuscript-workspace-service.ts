import { promises as fs } from 'fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import { FileUri } from '@theia/core/lib/common/file-uri';
import { inject, injectable } from '@theia/core/shared/inversify';
import { validateSemanticMarkdown } from '@ai-focused-editor/semantic-markdown';
import { isMap, isSeq, parse, parseDocument, YAMLMap, YAMLSeq } from 'yaml';
import {
  DomainYamlSchemaKind,
  ManuscriptMoveTarget,
  ManuscriptMutationResult,
  ManuscriptNode,
  ManuscriptWorkspaceBackendService,
  ManuscriptWorkspaceSnapshot,
  WorkspaceDiagnostic,
  YamlSchemaValidator
} from '../common';

interface ManifestContentEntry {
  path?: unknown;
  title?: unknown;
  include?: unknown;
  children?: unknown;
}

interface ManifestEntryLocation {
  /** The sequence holding the entry. */
  parent: YAMLSeq;
  /** Index of the entry within the parent sequence. */
  index: number;
  /** The entry map itself. */
  entry: YAMLMap;
}

@injectable()
export class NodeManuscriptWorkspaceService implements ManuscriptWorkspaceBackendService {
  @inject(YamlSchemaValidator)
  protected readonly yamlSchemaValidator!: YamlSchemaValidator;

  getSnapshot(rootUri?: string): Promise<ManuscriptWorkspaceSnapshot> {
    if (!rootUri) {
      return Promise.resolve({
        content: [],
        diagnostics: [{
          severity: 'info',
          source: 'manuscript-workspace',
          message: 'Open a colocated manuscript workspace folder.'
        }]
      });
    }

    return this.scanRoot(this.toRootPath(rootUri));
  }

  refresh(rootUri?: string): Promise<ManuscriptWorkspaceSnapshot> {
    return this.getSnapshot(rootUri);
  }

  async moveManuscriptEntry(
    rootUri: string,
    sourcePath: string,
    target: ManuscriptMoveTarget
  ): Promise<ManuscriptMutationResult> {
    return this.mutateManifest(rootUri, async (rootPath, content) => {
      const normalizedSource = this.normalizeManifestPath(sourcePath);
      const source = this.findManifestEntry(content, normalizedSource);
      if (!source) {
        return `Manifest entry not found: ${normalizedSource}`;
      }

      const targetParentPath = target.parentPath ? this.normalizeManifestPath(target.parentPath) : undefined;
      let targetSeq = content;
      let targetDirectory = join(rootPath, 'content');
      if (targetParentPath) {
        if (targetParentPath === normalizedSource || targetParentPath.startsWith(`${normalizedSource}/`)) {
          return 'Cannot move an entry into itself.';
        }
        const parentLocation = this.findManifestEntry(content, targetParentPath);
        if (!parentLocation) {
          return `Target folder entry not found in manifest: ${targetParentPath}`;
        }
        targetSeq = this.ensureChildrenSeq(parentLocation.entry);
        targetDirectory = resolve(rootPath, targetParentPath);
        const parentStat = await this.statIfExists(targetDirectory);
        if (!parentStat?.isDirectory()) {
          return `Target folder is not a directory on disk: ${targetParentPath}`;
        }
      }

      const sameParent = source.parent === targetSeq;
      let insertionIndex = Math.max(0, Math.min(target.index, targetSeq.items.length));

      // Physically relocate the file when it changes parent directories.
      let movedPath = normalizedSource;
      if (!sameParent) {
        const absoluteSource = resolve(rootPath, normalizedSource);
        if (!this.isInside(rootPath, absoluteSource)) {
          return `Source path escapes the workspace root: ${normalizedSource}`;
        }
        const destination = join(targetDirectory, basename(absoluteSource));
        if (resolve(destination) !== absoluteSource) {
          if (await this.exists(destination)) {
            return `Target already contains an entry named ${basename(absoluteSource)}.`;
          }
          if (!(await this.exists(absoluteSource))) {
            return `Source file does not exist on disk: ${normalizedSource}`;
          }
          await fs.mkdir(dirname(destination), { recursive: true });
          await fs.rename(absoluteSource, destination);
          movedPath = this.toWorkspacePath(rootPath, destination);
          source.entry.set('path', movedPath);
        }
      }

      source.parent.items.splice(source.index, 1);
      if (sameParent && source.index < insertionIndex) {
        insertionIndex -= 1;
      }
      targetSeq.items.splice(insertionIndex, 0, source.entry);
      return undefined;
    });
  }

  async setManuscriptBuildInclusion(
    rootUri: string,
    path: string,
    include: boolean
  ): Promise<ManuscriptMutationResult> {
    return this.mutateManifest(rootUri, async (_rootPath, content) => {
      const location = this.findManifestEntry(content, this.normalizeManifestPath(path));
      if (!location) {
        return `Manifest entry not found: ${path}`;
      }
      if (include) {
        location.entry.delete('include');
      } else {
        location.entry.set('include', false);
      }
      return undefined;
    });
  }

  async createManuscriptChapter(
    rootUri: string,
    parentPath: string | undefined,
    title: string
  ): Promise<ManuscriptMutationResult> {
    return this.mutateManifest(rootUri, async (rootPath, content) => {
      const trimmedTitle = title.trim();
      if (!trimmedTitle) {
        return 'Chapter title must not be empty.';
      }

      let targetSeq = content;
      let targetDirectory = join(rootPath, 'content');
      const normalizedParent = parentPath ? this.normalizeManifestPath(parentPath) : undefined;
      if (normalizedParent) {
        const parentLocation = this.findManifestEntry(content, normalizedParent);
        if (!parentLocation) {
          return `Target folder entry not found in manifest: ${normalizedParent}`;
        }
        targetSeq = this.ensureChildrenSeq(parentLocation.entry);
        targetDirectory = resolve(rootPath, normalizedParent);
      }

      await fs.mkdir(targetDirectory, { recursive: true });
      const fileName = await this.uniqueChapterFileName(targetDirectory, trimmedTitle);
      const absolutePath = join(targetDirectory, fileName);
      await fs.writeFile(absolutePath, `# ${trimmedTitle}\n`, { flag: 'wx' });

      const entry = new YAMLMap();
      entry.set('path', this.toWorkspacePath(rootPath, absolutePath));
      entry.set('title', trimmedTitle);
      targetSeq.items.push(entry);
      return undefined;
    });
  }

  /**
   * Shared manifest mutation flow: parse manifest.yaml as a YAML document (preserving
   * comments/format of untouched entries), apply the mutation, persist, and rescan.
   * The mutation callback returns an error message to abort without writing.
   */
  protected async mutateManifest(
    rootUri: string,
    mutation: (rootPath: string, content: YAMLSeq) => Promise<string | undefined>
  ): Promise<ManuscriptMutationResult> {
    const rootPath = this.toRootPath(rootUri);
    const manifestPath = join(rootPath, 'manifest.yaml');
    const manifestText = await this.readTextIfExists(manifestPath);
    const fail = async (message: string): Promise<ManuscriptMutationResult> => ({
      ok: false,
      message,
      snapshot: await this.getSnapshot(rootUri)
    });

    if (manifestText === undefined) {
      return fail('manifest.yaml does not exist; create it before editing the manuscript order.');
    }

    const document = parseDocument(manifestText);
    if (document.errors.length > 0) {
      return fail(`manifest.yaml is not valid YAML: ${document.errors[0].message}`);
    }

    const content = document.get('content');
    if (!isSeq(content)) {
      return fail('manifest.yaml has no content list to edit.');
    }

    const errorMessage = await mutation(rootPath, content);
    if (errorMessage) {
      return fail(errorMessage);
    }

    await fs.writeFile(manifestPath, document.toString(), 'utf8');
    return {
      ok: true,
      snapshot: await this.getSnapshot(rootUri)
    };
  }

  protected findManifestEntry(seq: YAMLSeq, path: string): ManifestEntryLocation | undefined {
    for (const [index, item] of seq.items.entries()) {
      if (!isMap(item)) {
        continue;
      }
      const entryPath = item.get('path');
      if (typeof entryPath === 'string' && this.normalizeManifestPath(entryPath) === path) {
        return { parent: seq, index, entry: item };
      }
      const children = item.get('children');
      if (isSeq(children)) {
        const nested = this.findManifestEntry(children, path);
        if (nested) {
          return nested;
        }
      }
    }
    return undefined;
  }

  protected ensureChildrenSeq(entry: YAMLMap): YAMLSeq {
    const children = entry.get('children');
    if (isSeq(children)) {
      return children;
    }
    const seq = new YAMLSeq();
    entry.set('children', seq);
    return seq;
  }

  protected normalizeManifestPath(path: string): string {
    return path.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  }

  protected async uniqueChapterFileName(directory: string, title: string): Promise<string> {
    const slug = this.slugifyTitle(title);
    let candidate = `${slug}.md`;
    let counter = 2;
    while (await this.exists(join(directory, candidate))) {
      candidate = `${slug}-${counter}.md`;
      counter += 1;
    }
    return candidate;
  }

  protected slugifyTitle(title: string): string {
    const slug = title
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '');
    return slug || 'chapter';
  }

  protected async scanRoot(rootPath: string): Promise<ManuscriptWorkspaceSnapshot> {
    const diagnostics: WorkspaceDiagnostic[] = [];
    const rootUri = FileUri.create(rootPath).toString();
    const manifestPath = join(rootPath, 'manifest.yaml');
    const metadataPath = join(rootPath, 'metadata.yaml');
    const contentPath = join(rootPath, 'content');

    const manifestText = await this.readTextIfExists(manifestPath);
    if (!manifestText) {
      diagnostics.push({
        severity: 'warning',
        source: 'manuscript-workspace',
        uri: FileUri.create(manifestPath).toString(),
        message: 'Missing manifest.yaml; falling back to content/*.md scan.'
      });
    }

    if (!(await this.exists(metadataPath))) {
      diagnostics.push({
        severity: 'warning',
        source: 'manuscript-workspace',
        uri: FileUri.create(metadataPath).toString(),
        message: 'Missing metadata.yaml.'
      });
    } else {
      await this.validateYamlFile(metadataPath, 'metadata', diagnostics);
    }

    const contentStat = await this.statIfExists(contentPath);
    if (!contentStat?.isDirectory()) {
      diagnostics.push({
        severity: 'error',
        source: 'manuscript-workspace',
        uri: FileUri.create(contentPath).toString(),
        message: 'Missing content/ directory.'
      });
    }

    const content = manifestText
      ? await this.readManifestContent(rootPath, manifestPath, manifestText, diagnostics)
      : await this.scanContentDirectory(rootPath, contentPath, diagnostics);

    if (content.length === 0 && contentStat?.isDirectory()) {
      content.push(...await this.scanContentDirectory(rootPath, contentPath, diagnostics));
    }

    await this.checkExpectedDirectories(rootPath, diagnostics);
    await this.validateEntityDirectory(join(rootPath, 'entities/characters'), 'character', diagnostics);
    await this.validateEntityDirectory(join(rootPath, 'entities/terms'), 'term', diagnostics);
    await this.validateEntityDirectory(join(rootPath, 'entities/artifacts'), 'artifact', diagnostics);
    await this.validateEntityDirectory(join(rootPath, 'entities/locations'), 'location', diagnostics);
    await this.validateMarkdownNodes(content, diagnostics);
    // Supplementary materials are texts too (owner intake 2026-07-10):
    // lint sources/ and knowledge/ Markdown with the same semantic checks.
    await this.validateAuxiliaryMarkdown(rootPath, join(rootPath, 'sources'), diagnostics);
    await this.validateAuxiliaryMarkdown(rootPath, join(rootPath, 'knowledge'), diagnostics);

    return {
      rootUri,
      manifestUri: FileUri.create(manifestPath).toString(),
      content,
      diagnostics
    };
  }

  protected async readManifestContent(
    rootPath: string,
    manifestPath: string,
    manifestText: string,
    diagnostics: WorkspaceDiagnostic[]
  ): Promise<ManuscriptNode[]> {
    let manifest: unknown;
    try {
      manifest = parse(manifestText);
    } catch (error) {
      diagnostics.push({
        severity: 'error',
        source: 'manuscript-workspace',
        uri: FileUri.create(manifestPath).toString(),
        message: `Invalid manifest.yaml: ${error instanceof Error ? error.message : String(error)}`
      });
      return [];
    }

    diagnostics.push(...this.yamlSchemaValidator.validate('manifest', FileUri.create(manifestPath).toString(), manifest));

    if (!this.isRecord(manifest) || !Array.isArray(manifest.content)) {
      diagnostics.push({
        severity: 'warning',
        source: 'manuscript-workspace',
        uri: FileUri.create(manifestPath).toString(),
        message: 'manifest.yaml has no content list.'
      });
      return [];
    }

    const nodes: ManuscriptNode[] = [];
    const seenPaths = new Set<string>();
    for (const [index, entry] of manifest.content.entries()) {
      const node = await this.manifestEntryToNode(rootPath, manifestPath, entry, index, diagnostics, seenPaths);
      if (node) {
        nodes.push(node);
      }
    }
    return nodes;
  }

  protected async manifestEntryToNode(
    rootPath: string,
    manifestPath: string,
    entry: unknown,
    order: number,
    diagnostics: WorkspaceDiagnostic[],
    seenPaths: Set<string>
  ): Promise<ManuscriptNode | undefined> {
    if (!this.isRecord(entry)) {
      diagnostics.push({
        severity: 'warning',
        source: 'manuscript-workspace',
        uri: FileUri.create(manifestPath).toString(),
        message: `Ignoring manifest content entry ${order + 1}: expected object.`
      });
      return undefined;
    }

    const manifestEntry = entry as ManifestContentEntry;
    if (typeof manifestEntry.path !== 'string' || manifestEntry.path.trim().length === 0) {
      diagnostics.push({
        severity: 'warning',
        source: 'manuscript-workspace',
        uri: FileUri.create(manifestPath).toString(),
        message: `Ignoring manifest content entry ${order + 1}: missing path.`
      });
      return undefined;
    }

    const path = manifestEntry.path.trim();
    const resourcePath = resolve(rootPath, path);
    if (!this.isInside(rootPath, resourcePath)) {
      diagnostics.push({
        severity: 'error',
        source: 'manuscript-workspace',
        uri: FileUri.create(manifestPath).toString(),
        message: `Manifest path escapes the workspace root: ${path}`
      });
      return undefined;
    }

    const isDuplicate = seenPaths.has(path);
    if (isDuplicate) {
      diagnostics.push({
        severity: 'warning',
        source: 'manuscript-workspace',
        uri: FileUri.create(manifestPath).toString(),
        message: `Duplicate manifest path: ${path} (entry ${order + 1} shadows an earlier entry).`
      });
    }
    seenPaths.add(path);

    const stat = await this.statIfExists(resourcePath);
    if (!stat) {
      diagnostics.push({
        severity: 'error',
        source: 'manuscript-workspace',
        uri: FileUri.create(resourcePath).toString(),
        message: `Manifest path does not exist: ${path}`
      });
    }

    const children = Array.isArray(manifestEntry.children)
      ? await this.manifestChildrenToNodes(rootPath, manifestPath, manifestEntry.children, diagnostics, seenPaths)
      : undefined;

    return {
      id: isDuplicate ? `${path}#${order}` : path,
      name: typeof manifestEntry.title === 'string' && manifestEntry.title.trim()
        ? manifestEntry.title.trim()
        : basename(path),
      path,
      uri: FileUri.create(resourcePath).toString(),
      type: stat?.isDirectory() || children?.length ? 'folder' : 'file',
      order,
      buildIncluded: manifestEntry.include !== false,
      children
    };
  }

  protected async manifestChildrenToNodes(
    rootPath: string,
    manifestPath: string,
    entries: unknown[],
    diagnostics: WorkspaceDiagnostic[],
    seenPaths: Set<string>
  ): Promise<ManuscriptNode[]> {
    const nodes: ManuscriptNode[] = [];
    for (const [index, entry] of entries.entries()) {
      const node = await this.manifestEntryToNode(rootPath, manifestPath, entry, index, diagnostics, seenPaths);
      if (node) {
        nodes.push(node);
      }
    }
    return nodes;
  }

  protected async scanContentDirectory(
    rootPath: string,
    directoryPath: string,
    diagnostics: WorkspaceDiagnostic[]
  ): Promise<ManuscriptNode[]> {
    const stat = await this.statIfExists(directoryPath);
    if (!stat?.isDirectory()) {
      return [];
    }

    const entries = await fs.readdir(directoryPath, { withFileTypes: true });
    const nodes: ManuscriptNode[] = [];

    for (const [order, entry] of entries.sort((left, right) => left.name.localeCompare(right.name)).entries()) {
      const childPath = join(directoryPath, entry.name);
      if (entry.isFile() && !entry.name.endsWith('.md')) {
        continue;
      }

      const children = entry.isDirectory()
        ? await this.scanContentDirectory(rootPath, childPath, diagnostics)
        : undefined;
      const workspacePath = this.toWorkspacePath(rootPath, childPath);
      nodes.push({
        id: workspacePath,
        name: entry.name,
        path: workspacePath,
        uri: FileUri.create(childPath).toString(),
        type: entry.isDirectory() ? 'folder' : 'file',
        order,
        buildIncluded: true,
        children
      });
    }

    return nodes;
  }

  protected async checkExpectedDirectories(rootPath: string, diagnostics: WorkspaceDiagnostic[]): Promise<void> {
    for (const path of ['entities', 'knowledge', 'sources', 'ai']) {
      const absolutePath = join(rootPath, path);
      const stat = await this.statIfExists(absolutePath);
      if (!stat?.isDirectory()) {
        diagnostics.push({
          severity: 'info',
          source: 'manuscript-workspace',
          uri: FileUri.create(absolutePath).toString(),
          message: `Optional domain directory is not present yet: ${path}/`
        });
      }
    }
  }

  protected async validateEntityDirectory(
    directoryPath: string,
    kind: DomainYamlSchemaKind,
    diagnostics: WorkspaceDiagnostic[]
  ): Promise<void> {
    const stat = await this.statIfExists(directoryPath);
    if (!stat?.isDirectory()) {
      return;
    }

    const entries = await fs.readdir(directoryPath, { withFileTypes: true });
    for (const entry of entries
      .filter(child => child.isFile() && (child.name.endsWith('.yaml') || child.name.endsWith('.yml')))
      .sort((left, right) => left.name.localeCompare(right.name))) {
      await this.validateYamlFile(join(directoryPath, entry.name), kind, diagnostics);
    }
  }

  /** Recursively lints every Markdown file under a supplementary directory. */
  protected async validateAuxiliaryMarkdown(
    rootPath: string,
    directoryPath: string,
    diagnostics: WorkspaceDiagnostic[]
  ): Promise<void> {
    const stat = await this.statIfExists(directoryPath);
    if (!stat?.isDirectory()) {
      return;
    }

    const entries = await fs.readdir(directoryPath, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const childPath = join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        await this.validateAuxiliaryMarkdown(rootPath, childPath, diagnostics);
        continue;
      }
      if (!entry.isFile() || !/\.(md|markdown)$/i.test(entry.name)) {
        continue;
      }
      const text = await this.readTextIfExists(childPath);
      if (text === undefined) {
        continue;
      }
      for (const diagnostic of validateSemanticMarkdown(text)) {
        diagnostics.push({
          severity: diagnostic.severity,
          source: 'semantic-markdown',
          uri: FileUri.create(childPath).toString(),
          message: diagnostic.message,
          range: diagnostic.range
        });
      }
    }
  }

  protected async validateMarkdownNodes(nodes: ManuscriptNode[], diagnostics: WorkspaceDiagnostic[]): Promise<void> {
    for (const node of nodes) {
      if (node.children) {
        await this.validateMarkdownNodes(node.children, diagnostics);
      }
      if (node.type !== 'file' || !node.uri || !node.path.endsWith('.md')) {
        continue;
      }

      const text = await this.readTextIfExists(FileUri.fsPath(node.uri));
      if (text === undefined) {
        continue;
      }

      for (const diagnostic of validateSemanticMarkdown(text)) {
        diagnostics.push({
          severity: diagnostic.severity,
          source: 'semantic-markdown',
          uri: node.uri,
          message: diagnostic.message,
          range: diagnostic.range
        });
      }
    }
  }

  protected async validateYamlFile(
    path: string,
    kind: DomainYamlSchemaKind,
    diagnostics: WorkspaceDiagnostic[]
  ): Promise<void> {
    const text = await this.readTextIfExists(path);
    if (text === undefined) {
      return;
    }

    let document: unknown;
    try {
      document = parse(text);
    } catch (error) {
      diagnostics.push({
        severity: 'error',
        source: 'yaml-parser',
        uri: FileUri.create(path).toString(),
        message: `Invalid YAML: ${error instanceof Error ? error.message : String(error)}`
      });
      return;
    }

    diagnostics.push(...this.yamlSchemaValidator.validate(kind, FileUri.create(path).toString(), document));
  }

  protected async readTextIfExists(path: string): Promise<string | undefined> {
    try {
      return await fs.readFile(path, 'utf8');
    } catch {
      return undefined;
    }
  }

  protected async exists(path: string): Promise<boolean> {
    try {
      await fs.access(path);
      return true;
    } catch {
      return false;
    }
  }

  protected async statIfExists(path: string): Promise<import('fs').Stats | undefined> {
    try {
      return await fs.stat(path);
    } catch {
      return undefined;
    }
  }

  protected toRootPath(rootUri: string): string {
    if (rootUri.startsWith('file:')) {
      return FileUri.fsPath(rootUri);
    }
    return isAbsolute(rootUri) ? rootUri : resolve(process.cwd(), rootUri);
  }

  protected isInside(rootPath: string, path: string): boolean {
    const relativePath = relative(rootPath, path);
    return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
  }

  protected toWorkspacePath(rootPath: string, path: string): string {
    return relative(rootPath, path).split(sep).join('/');
  }

  protected isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}
