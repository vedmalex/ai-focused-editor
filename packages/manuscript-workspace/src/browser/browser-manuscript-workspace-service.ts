import URI from '@theia/core/lib/common/uri';
import { validateSemanticMarkdown } from '@ai-focused-editor/semantic-markdown';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import type { FileStat } from '@theia/filesystem/lib/common/files';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { inject, injectable } from '@theia/core/shared/inversify';
import { parse } from 'yaml';
import type {
  ManuscriptNode,
  ManuscriptWorkspaceService,
  ManuscriptWorkspaceSnapshot,
  WorkspaceDiagnostic
} from '../common';
import {
  DomainYamlSchemaKind,
  YamlSchemaValidator
} from './yaml-schema-validator';

interface ManifestContentEntry {
  path?: unknown;
  title?: unknown;
  include?: unknown;
  children?: unknown;
}

@injectable()
export class BrowserManuscriptWorkspaceService implements ManuscriptWorkspaceService {
  @inject(WorkspaceService)
  protected readonly workspaceService!: WorkspaceService;

  @inject(FileService)
  protected readonly fileService!: FileService;

  @inject(YamlSchemaValidator)
  protected readonly yamlSchemaValidator!: YamlSchemaValidator;

  async getSnapshot(): Promise<ManuscriptWorkspaceSnapshot> {
    await this.workspaceService.ready;
    const root = this.workspaceService.tryGetRoots()[0] ?? (await this.workspaceService.roots)[0];

    if (!root) {
      return {
        content: [],
        diagnostics: [{
          severity: 'info',
          source: 'manuscript-workspace',
          uri: undefined,
          message: 'Open a colocated manuscript workspace folder.'
        }]
      };
    }

    return this.scanRoot(root.resource);
  }

  refresh(): Promise<ManuscriptWorkspaceSnapshot> {
    return this.getSnapshot();
  }

  protected async scanRoot(rootUri: URI): Promise<ManuscriptWorkspaceSnapshot> {
    const diagnostics: WorkspaceDiagnostic[] = [];
    const manifestUri = rootUri.resolve('manifest.yaml');
    const metadataUri = rootUri.resolve('metadata.yaml');
    const contentUri = rootUri.resolve('content');

    const manifestText = await this.readTextIfExists(manifestUri);
    if (!manifestText) {
      diagnostics.push({
        severity: 'warning',
        source: 'manuscript-workspace',
        uri: manifestUri.toString(),
        message: 'Missing manifest.yaml; falling back to content/*.md scan.'
      });
    }

    if (!(await this.exists(metadataUri))) {
      diagnostics.push({
        severity: 'warning',
        source: 'manuscript-workspace',
        uri: metadataUri.toString(),
        message: 'Missing metadata.yaml.'
      });
    } else {
      await this.validateYamlFile(metadataUri, 'metadata', diagnostics);
    }

    const contentStat = await this.resolveIfExists(contentUri);
    if (!contentStat?.isDirectory) {
      diagnostics.push({
        severity: 'error',
        source: 'manuscript-workspace',
        uri: contentUri.toString(),
        message: 'Missing content/ directory.'
      });
    }

    const content = manifestText
      ? await this.readManifestContent(rootUri, manifestUri, manifestText, diagnostics)
      : await this.scanContentDirectory(contentStat, diagnostics);

    if (content.length === 0 && contentStat?.isDirectory) {
      content.push(...await this.scanContentDirectory(contentStat, diagnostics));
    }

    await this.checkExpectedDirectories(rootUri, diagnostics);
    await this.validateEntityDirectory(rootUri.resolve('entities/characters'), 'character', diagnostics);
    await this.validateEntityDirectory(rootUri.resolve('entities/terms'), 'term', diagnostics);
    await this.validateMarkdownNodes(content, diagnostics);

    return {
      rootUri: rootUri.toString(),
      manifestUri: manifestUri.toString(),
      content,
      diagnostics
    };
  }

  protected async readManifestContent(
    rootUri: URI,
    manifestUri: URI,
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
        uri: manifestUri.toString(),
        message: `Invalid manifest.yaml: ${error instanceof Error ? error.message : String(error)}`
      });
      return [];
    }

    diagnostics.push(...this.yamlSchemaValidator.validate('manifest', manifestUri.toString(), manifest));

    if (!this.isRecord(manifest) || !Array.isArray(manifest.content)) {
      diagnostics.push({
        severity: 'warning',
        source: 'manuscript-workspace',
        uri: manifestUri.toString(),
        message: `${manifestUri.path.base} has no content list.`
      });
      return [];
    }

    const nodes: ManuscriptNode[] = [];
    for (const [index, entry] of manifest.content.entries()) {
      const node = await this.manifestEntryToNode(rootUri, entry, index, diagnostics);
      if (node) {
        nodes.push(node);
      }
    }
    return nodes;
  }

  protected async manifestEntryToNode(
    rootUri: URI,
    entry: unknown,
    order: number,
    diagnostics: WorkspaceDiagnostic[]
  ): Promise<ManuscriptNode | undefined> {
    if (!this.isRecord(entry)) {
      diagnostics.push({
        severity: 'warning',
        source: 'manuscript-workspace',
        uri: rootUri.resolve('manifest.yaml').toString(),
        message: `Ignoring manifest content entry ${order + 1}: expected object.`
      });
      return undefined;
    }

    const manifestEntry = entry as ManifestContentEntry;
    if (typeof manifestEntry.path !== 'string' || manifestEntry.path.trim().length === 0) {
      diagnostics.push({
        severity: 'warning',
        source: 'manuscript-workspace',
        uri: rootUri.resolve('manifest.yaml').toString(),
        message: `Ignoring manifest content entry ${order + 1}: missing path.`
      });
      return undefined;
    }

    const path = manifestEntry.path.trim();
    const resource = rootUri.resolve(path);
    const stat = await this.resolveIfExists(resource);
    if (!stat) {
      diagnostics.push({
        severity: 'error',
        source: 'manuscript-workspace',
        uri: resource.toString(),
        message: `Manifest path does not exist: ${path}`
      });
    }

    const children = Array.isArray(manifestEntry.children)
      ? await this.manifestChildrenToNodes(rootUri, manifestEntry.children, diagnostics)
      : undefined;

    return {
      id: path,
      name: typeof manifestEntry.title === 'string' && manifestEntry.title.trim()
        ? manifestEntry.title.trim()
        : this.basename(path),
      path,
      uri: resource.toString(),
      type: stat?.isDirectory || children?.length ? 'folder' : 'file',
      order,
      buildIncluded: manifestEntry.include !== false,
      children
    };
  }

  protected async manifestChildrenToNodes(
    rootUri: URI,
    entries: unknown[],
    diagnostics: WorkspaceDiagnostic[]
  ): Promise<ManuscriptNode[]> {
    const nodes: ManuscriptNode[] = [];
    for (const [index, entry] of entries.entries()) {
      const node = await this.manifestEntryToNode(rootUri, entry, index, diagnostics);
      if (node) {
        nodes.push(node);
      }
    }
    return nodes;
  }

  protected async scanContentDirectory(
    contentStat: FileStat | undefined,
    diagnostics: WorkspaceDiagnostic[]
  ): Promise<ManuscriptNode[]> {
    if (!contentStat?.isDirectory) {
      return [];
    }

    const children = [...(contentStat.children ?? [])]
      .sort((left, right) => left.name.localeCompare(right.name));
    const nodes: ManuscriptNode[] = [];

    for (const [order, child] of children.entries()) {
      const node = await this.fileStatToNode(child, order, diagnostics);
      if (node) {
        nodes.push(node);
      }
    }

    return nodes;
  }

  protected async fileStatToNode(
    stat: FileStat,
    order: number,
    diagnostics: WorkspaceDiagnostic[]
  ): Promise<ManuscriptNode | undefined> {
    if (stat.isFile && !stat.name.endsWith('.md')) {
      return undefined;
    }

    const path = this.workspaceRelativePath(stat.resource);
    const children = stat.isDirectory
      ? await this.scanContentDirectory(await this.resolveIfExists(stat.resource), diagnostics)
      : undefined;

    return {
      id: path,
      name: stat.name,
      path,
      uri: stat.resource.toString(),
      type: stat.isDirectory ? 'folder' : 'file',
      order,
      buildIncluded: true,
      children
    };
  }

  protected async checkExpectedDirectories(rootUri: URI, diagnostics: WorkspaceDiagnostic[]): Promise<void> {
    for (const path of ['entities', 'knowledge', 'sources', 'ai']) {
      const stat = await this.resolveIfExists(rootUri.resolve(path));
      if (!stat?.isDirectory) {
        diagnostics.push({
          severity: 'info',
          source: 'manuscript-workspace',
          uri: rootUri.resolve(path).toString(),
          message: `Optional domain directory is not present yet: ${path}/`
        });
      }
    }
  }

  protected async validateEntityDirectory(
    directoryUri: URI,
    kind: DomainYamlSchemaKind,
    diagnostics: WorkspaceDiagnostic[]
  ): Promise<void> {
    const stat = await this.resolveIfExists(directoryUri);
    if (!stat?.isDirectory) {
      return;
    }

    const children = [...(stat.children ?? [])]
      .filter(child => child.isFile && (child.name.endsWith('.yaml') || child.name.endsWith('.yml')))
      .sort((left, right) => left.name.localeCompare(right.name));

    for (const child of children) {
      await this.validateYamlFile(child.resource, kind, diagnostics);
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

      const text = await this.readTextIfExists(new URI(node.uri));
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
    resource: URI,
    kind: DomainYamlSchemaKind,
    diagnostics: WorkspaceDiagnostic[]
  ): Promise<void> {
    const text = await this.readTextIfExists(resource);
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
        uri: resource.toString(),
        message: `Invalid YAML: ${error instanceof Error ? error.message : String(error)}`
      });
      return;
    }

    diagnostics.push(...this.yamlSchemaValidator.validate(kind, resource.toString(), document));
  }

  protected async readTextIfExists(resource: URI): Promise<string | undefined> {
    try {
      return (await this.fileService.read(resource)).value;
    } catch {
      return undefined;
    }
  }

  protected async exists(resource: URI): Promise<boolean> {
    try {
      return await this.fileService.exists(resource);
    } catch {
      return false;
    }
  }

  protected async resolveIfExists(resource: URI): Promise<FileStat | undefined> {
    try {
      return await this.fileService.resolve(resource);
    } catch {
      return undefined;
    }
  }

  protected workspaceRelativePath(resource: URI): string {
    const root = this.workspaceService.getWorkspaceRootUri(resource);
    const relative = root?.relative(resource);
    return relative?.toString() ?? resource.path.toString();
  }

  protected basename(path: string): string {
    return path.split('/').filter(Boolean).pop() ?? path;
  }

  protected isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}
