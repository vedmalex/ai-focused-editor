import URI from '@theia/core/lib/common/uri';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { inject, injectable } from '@theia/core/shared/inversify';
import { parse } from 'yaml';
import {
  CitationEntry,
  ManuscriptWorkspaceService,
  SourceLibraryItem,
  SourceLibraryService,
  SourceLibrarySnapshot,
  WorkspaceDiagnostic
} from '../common';

interface CitationDocument {
  citations?: unknown;
}

interface CitationRecord {
  id?: unknown;
  title?: unknown;
  source?: unknown;
  note?: unknown;
}

@injectable()
export class BrowserSourceLibraryService implements SourceLibraryService {
  @inject(ManuscriptWorkspaceService)
  protected readonly manuscriptWorkspace!: ManuscriptWorkspaceService;

  @inject(FileService)
  protected readonly fileService!: FileService;

  async getSnapshot(): Promise<SourceLibrarySnapshot> {
    const workspace = await this.manuscriptWorkspace.getSnapshot();
    if (!workspace.rootUri) {
      return {
        items: [],
        citations: [],
        diagnostics: [{
          severity: 'info',
          source: 'source-library',
          message: 'Open a manuscript workspace to view sources.'
        }]
      };
    }

    const rootUri = new URI(workspace.rootUri);
    const sourceUri = rootUri.resolve('sources');
    const diagnostics: WorkspaceDiagnostic[] = [];
    const items = await this.readSourceItems(rootUri, sourceUri, diagnostics);
    const citations = await this.readCitations(sourceUri.resolve('citations.yaml'), diagnostics);

    return {
      rootUri: workspace.rootUri,
      sourceUri: sourceUri.toString(),
      items,
      citations,
      diagnostics
    };
  }

  refresh(): Promise<SourceLibrarySnapshot> {
    return this.getSnapshot();
  }

  protected async readSourceItems(
    rootUri: URI,
    sourceUri: URI,
    diagnostics: WorkspaceDiagnostic[]
  ): Promise<SourceLibraryItem[]> {
    const stat = await this.resolveIfExists(sourceUri);
    if (!stat?.isDirectory) {
      diagnostics.push({
        severity: 'info',
        source: 'source-library',
        uri: sourceUri.toString(),
        message: 'sources/ directory is not present yet.'
      });
      return [];
    }

    return [...(stat.children ?? [])]
      .filter(child => child.name !== 'citations.yaml')
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(child => ({
        name: child.name,
        path: rootUri.relative(child.resource)?.toString() ?? child.resource.path.toString(),
        uri: child.resource.toString(),
        type: child.isDirectory ? 'directory' : 'file'
      }));
  }

  protected async readCitations(citationsUri: URI, diagnostics: WorkspaceDiagnostic[]): Promise<CitationEntry[]> {
    const text = await this.readTextIfExists(citationsUri);
    if (text === undefined) {
      diagnostics.push({
        severity: 'info',
        source: 'source-library',
        uri: citationsUri.toString(),
        message: 'No sources/citations.yaml file found.'
      });
      return [];
    }

    let document: unknown;
    try {
      document = parse(text);
    } catch (error) {
      diagnostics.push({
        severity: 'error',
        source: 'source-library',
        uri: citationsUri.toString(),
        message: `Invalid citations.yaml: ${error instanceof Error ? error.message : String(error)}`
      });
      return [];
    }

    const records = Array.isArray(document)
      ? document
      : this.isRecord(document)
        ? (document as CitationDocument).citations
        : undefined;

    if (!Array.isArray(records)) {
      diagnostics.push({
        severity: 'warning',
        source: 'source-library',
        uri: citationsUri.toString(),
        message: 'citations.yaml should contain a citations list.'
      });
      return [];
    }

    return records
      .map((record, index) => this.toCitationEntry(record, index, citationsUri.toString(), diagnostics))
      .filter((entry): entry is CitationEntry => entry !== undefined);
  }

  protected toCitationEntry(
    record: unknown,
    index: number,
    uri: string,
    diagnostics: WorkspaceDiagnostic[]
  ): CitationEntry | undefined {
    if (!this.isRecord(record)) {
      diagnostics.push({
        severity: 'warning',
        source: 'source-library',
        uri,
        message: `Ignoring citation ${index + 1}: expected object.`
      });
      return undefined;
    }

    const citation = record as CitationRecord;
    const id = this.asString(citation.id);
    const title = this.asString(citation.title);
    if (!id || !title) {
      diagnostics.push({
        severity: 'warning',
        source: 'source-library',
        uri,
        message: `Ignoring citation ${index + 1}: id and title are required.`
      });
      return undefined;
    }

    return {
      id,
      title,
      source: this.asString(citation.source) || undefined,
      note: this.asString(citation.note) || undefined
    };
  }

  protected async readTextIfExists(resource: URI): Promise<string | undefined> {
    try {
      return (await this.fileService.read(resource)).value;
    } catch {
      return undefined;
    }
  }

  protected async resolveIfExists(resource: URI): Promise<import('@theia/filesystem/lib/common/files').FileStat | undefined> {
    try {
      return await this.fileService.resolve(resource);
    } catch {
      return undefined;
    }
  }

  protected asString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
  }

  protected isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}
