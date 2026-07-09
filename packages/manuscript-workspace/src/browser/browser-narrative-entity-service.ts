import URI from '@theia/core/lib/common/uri';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import type { FileStat } from '@theia/filesystem/lib/common/files';
import { inject, injectable } from '@theia/core/shared/inversify';
import { parse } from 'yaml';
import {
  ManuscriptWorkspaceService,
  NarrativeEntity,
  NarrativeEntityKind,
  NarrativeEntityService,
  NarrativeEntitySnapshot,
  WorkspaceDiagnostic
} from '../common';

interface EntityDirectoryConfig {
  kind: NarrativeEntityKind;
  directory: string;
  labelField: 'name' | 'term';
}

const ENTITY_DIRECTORIES: EntityDirectoryConfig[] = [
  {
    kind: 'character',
    directory: 'entities/characters',
    labelField: 'name'
  },
  {
    kind: 'term',
    directory: 'entities/terms',
    labelField: 'term'
  }
];

@injectable()
export class BrowserNarrativeEntityService implements NarrativeEntityService {
  @inject(ManuscriptWorkspaceService)
  protected readonly manuscriptWorkspace!: ManuscriptWorkspaceService;

  @inject(FileService)
  protected readonly fileService!: FileService;

  async getSnapshot(): Promise<NarrativeEntitySnapshot> {
    const workspace = await this.manuscriptWorkspace.getSnapshot();
    if (!workspace.rootUri) {
      return {
        entities: [],
        diagnostics: [{
          severity: 'info',
          source: 'narrative-entities',
          message: 'Open a manuscript workspace to view entity cards.'
        }]
      };
    }

    const rootUri = new URI(workspace.rootUri);
    const diagnostics: WorkspaceDiagnostic[] = [];
    const entities: NarrativeEntity[] = [];

    for (const config of ENTITY_DIRECTORIES) {
      entities.push(...await this.readEntityDirectory(rootUri, config, diagnostics));
    }

    return {
      rootUri: workspace.rootUri,
      entities,
      diagnostics
    };
  }

  refresh(): Promise<NarrativeEntitySnapshot> {
    return this.getSnapshot();
  }

  protected async readEntityDirectory(
    rootUri: URI,
    config: EntityDirectoryConfig,
    diagnostics: WorkspaceDiagnostic[]
  ): Promise<NarrativeEntity[]> {
    const directoryUri = rootUri.resolve(config.directory);
    const stat = await this.resolveIfExists(directoryUri);
    if (!stat?.isDirectory) {
      diagnostics.push({
        severity: 'info',
        source: 'narrative-entities',
        uri: directoryUri.toString(),
        message: `No ${config.kind} entity directory found at ${config.directory}/.`
      });
      return [];
    }

    const children = [...(stat.children ?? [])]
      .filter(child => child.isFile && (child.name.endsWith('.yaml') || child.name.endsWith('.yml')))
      .sort((left, right) => left.name.localeCompare(right.name));

    const entities: NarrativeEntity[] = [];
    for (const child of children) {
      const entity = await this.readEntityFile(rootUri, child, config, diagnostics);
      if (entity) {
        entities.push(entity);
      }
    }
    return entities;
  }

  protected async readEntityFile(
    rootUri: URI,
    file: FileStat,
    config: EntityDirectoryConfig,
    diagnostics: WorkspaceDiagnostic[]
  ): Promise<NarrativeEntity | undefined> {
    const text = await this.readTextIfExists(file.resource);
    if (text === undefined) {
      diagnostics.push({
        severity: 'warning',
        source: 'narrative-entities',
        uri: file.resource.toString(),
        message: `Could not read ${config.kind} entity file.`
      });
      return undefined;
    }

    let document: unknown;
    try {
      document = parse(text);
    } catch (error) {
      diagnostics.push({
        severity: 'error',
        source: 'narrative-entities',
        uri: file.resource.toString(),
        message: `Invalid ${config.kind} YAML: ${error instanceof Error ? error.message : String(error)}`
      });
      return undefined;
    }

    if (!this.isRecord(document)) {
      diagnostics.push({
        severity: 'error',
        source: 'narrative-entities',
        uri: file.resource.toString(),
        message: `${config.kind} entity YAML must be an object.`
      });
      return undefined;
    }

    const id = this.asString(document.id) || file.name.replace(/\.(ya?ml)$/i, '');
    const label = this.asString(document[config.labelField]) || id;
    return {
      kind: config.kind,
      id,
      label,
      path: this.workspaceRelativePath(rootUri, file.resource),
      uri: file.resource.toString(),
      summary: this.asString(document.summary),
      aliases: this.asStringArray(document.aliases)
    };
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

  protected workspaceRelativePath(rootUri: URI, resource: URI): string {
    return rootUri.relative(resource)?.toString() ?? resource.path.toString();
  }

  protected asString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
  }

  protected asStringArray(value: unknown): string[] {
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map(item => item.trim())
      : [];
  }

  protected isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}
