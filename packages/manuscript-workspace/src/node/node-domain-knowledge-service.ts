import { promises as fs } from 'fs';
import { isAbsolute, join, relative, resolve, sep } from 'path';
import { FileUri } from '@theia/core/lib/common/file-uri';
import { injectable } from '@theia/core/shared/inversify';
import { parse } from 'yaml';
import {
  AiMode,
  AiModeRegistryBackendService,
  AiModeRegistrySnapshot,
  CitationEntry,
  NarrativeEntity,
  NarrativeEntityBackendService,
  NarrativeEntityKind,
  NarrativeEntitySnapshot,
  SourceExcerpt,
  SourceLibraryBackendService,
  SourceLibraryItem,
  SourceLibrarySnapshot,
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
  },
  {
    kind: 'artifact',
    directory: 'entities/artifacts',
    labelField: 'name'
  },
  {
    kind: 'location',
    directory: 'entities/locations',
    labelField: 'name'
  }
];

interface CitationDocument {
  citations?: unknown;
}

interface CitationRecord {
  id?: unknown;
  title?: unknown;
  source?: unknown;
  note?: unknown;
}

interface AiModeDocument {
  modes?: unknown;
}

interface AiModeEntry {
  id?: unknown;
  label?: unknown;
  description?: unknown;
  systemPrompt?: unknown;
  prompt?: unknown;
  userPrompt?: unknown;
  parameters?: unknown;
}

const AI_MODES_PATH = 'ai/prompts/custom-modes.yaml';

function toRootPath(rootUri: string): string {
  if (rootUri.startsWith('file:')) {
    return FileUri.fsPath(rootUri);
  }
  return isAbsolute(rootUri) ? rootUri : resolve(process.cwd(), rootUri);
}

function toWorkspacePath(rootPath: string, path: string): string {
  return relative(rootPath, path).split(sep).join('/');
}

async function readTextIfExists(path: string): Promise<string | undefined> {
  try {
    return await fs.readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

async function statIfExists(path: string): Promise<import('fs').Stats | undefined> {
  try {
    return await fs.stat(path);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map(item => item.trim())
    : [];
}

/**
 * Whether a reference string looks like a file path (has a separator or an
 * extension) rather than a URL or a plain label.
 */
function looksLikePath(value: string): boolean {
  if (!value || /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    return false;
  }
  return value.includes('/') || /\.[a-z0-9]+$/i.test(value);
}

/**
 * Normalize a citation `source` into a workspace-relative path. Source
 * references are resolved against the `sources/` directory unless they are
 * already rooted at a known top-level workspace folder.
 */
const ROOT_RELATIVE_PREFIXES = ['sources/', 'content/', 'entities/', 'knowledge/', 'ai/'];
function toWorkspaceSourcePath(source: string): string | undefined {
  if (!looksLikePath(source)) {
    return undefined;
  }
  const normalized = source.replace(/^\.?\//, '');
  if (ROOT_RELATIVE_PREFIXES.some(prefix => normalized.startsWith(prefix))) {
    return normalized;
  }
  return `sources/${normalized}`;
}

function asLineNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return undefined;
}

@injectable()
export class NodeNarrativeEntityService implements NarrativeEntityBackendService {
  getSnapshot(rootUri?: string): Promise<NarrativeEntitySnapshot> {
    if (!rootUri) {
      return Promise.resolve({
        entities: [],
        diagnostics: [{
          severity: 'info',
          source: 'narrative-entities',
          message: 'Open a manuscript workspace to view entity cards.'
        }]
      });
    }

    return this.scan(toRootPath(rootUri));
  }

  refresh(rootUri?: string): Promise<NarrativeEntitySnapshot> {
    return this.getSnapshot(rootUri);
  }

  protected async scan(rootPath: string): Promise<NarrativeEntitySnapshot> {
    const diagnostics: WorkspaceDiagnostic[] = [];
    const entities: NarrativeEntity[] = [];

    for (const config of ENTITY_DIRECTORIES) {
      entities.push(...await this.readEntityDirectory(rootPath, config, diagnostics));
    }

    return {
      rootUri: FileUri.create(rootPath).toString(),
      entities,
      diagnostics
    };
  }

  protected async readEntityDirectory(
    rootPath: string,
    config: EntityDirectoryConfig,
    diagnostics: WorkspaceDiagnostic[]
  ): Promise<NarrativeEntity[]> {
    const directoryPath = join(rootPath, config.directory);
    const stat = await statIfExists(directoryPath);
    if (!stat?.isDirectory()) {
      diagnostics.push({
        severity: 'info',
        source: 'narrative-entities',
        uri: FileUri.create(directoryPath).toString(),
        message: `No ${config.kind} entity directory found at ${config.directory}/.`
      });
      return [];
    }

    const children = (await fs.readdir(directoryPath, { withFileTypes: true }))
      .filter(child => child.isFile() && (child.name.endsWith('.yaml') || child.name.endsWith('.yml')))
      .sort((left, right) => left.name.localeCompare(right.name));

    const entities: NarrativeEntity[] = [];
    for (const child of children) {
      const entity = await this.readEntityFile(rootPath, join(directoryPath, child.name), child.name, config, diagnostics);
      if (entity) {
        entities.push(entity);
      }
    }
    return entities;
  }

  protected async readEntityFile(
    rootPath: string,
    filePath: string,
    fileName: string,
    config: EntityDirectoryConfig,
    diagnostics: WorkspaceDiagnostic[]
  ): Promise<NarrativeEntity | undefined> {
    const uri = FileUri.create(filePath).toString();
    const text = await readTextIfExists(filePath);
    if (text === undefined) {
      diagnostics.push({
        severity: 'warning',
        source: 'narrative-entities',
        uri,
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
        uri,
        message: `Invalid ${config.kind} YAML: ${error instanceof Error ? error.message : String(error)}`
      });
      return undefined;
    }

    if (!isRecord(document)) {
      diagnostics.push({
        severity: 'error',
        source: 'narrative-entities',
        uri,
        message: `${config.kind} entity YAML must be an object.`
      });
      return undefined;
    }

    const id = asString(document.id) || fileName.replace(/\.(ya?ml)$/i, '');
    const label = asString(document[config.labelField]) || id;
    return {
      kind: config.kind,
      id,
      label,
      path: toWorkspacePath(rootPath, filePath),
      uri,
      summary: asString(document.summary),
      aliases: asStringArray(document.aliases),
      epithets: asStringArray(document.epithets),
      backstory: asString(document.backstory),
      arc: asString(document.arc),
      speechPatterns: asStringArray(document.speechPatterns),
      notes: asString(document.notes)
    };
  }
}

@injectable()
export class NodeSourceLibraryService implements SourceLibraryBackendService {
  getSnapshot(rootUri?: string): Promise<SourceLibrarySnapshot> {
    if (!rootUri) {
      return Promise.resolve({
        items: [],
        citations: [],
        excerpts: [],
        diagnostics: [{
          severity: 'info',
          source: 'source-library',
          message: 'Open a manuscript workspace to view sources.'
        }]
      });
    }

    return this.scan(toRootPath(rootUri));
  }

  refresh(rootUri?: string): Promise<SourceLibrarySnapshot> {
    return this.getSnapshot(rootUri);
  }

  protected async scan(rootPath: string): Promise<SourceLibrarySnapshot> {
    const sourcePath = join(rootPath, 'sources');
    const diagnostics: WorkspaceDiagnostic[] = [];
    const items = await this.readSourceItems(rootPath, sourcePath, diagnostics);
    const citations = await this.readCitations(join(sourcePath, 'citations.yaml'), diagnostics);
    const excerpts = await this.readExcerpts(join(sourcePath, 'excerpts.jsonl'), diagnostics);

    return {
      rootUri: FileUri.create(rootPath).toString(),
      sourceUri: FileUri.create(sourcePath).toString(),
      items,
      citations,
      excerpts,
      diagnostics
    };
  }

  protected async readSourceItems(
    rootPath: string,
    sourcePath: string,
    diagnostics: WorkspaceDiagnostic[]
  ): Promise<SourceLibraryItem[]> {
    const stat = await statIfExists(sourcePath);
    if (!stat?.isDirectory()) {
      diagnostics.push({
        severity: 'info',
        source: 'source-library',
        uri: FileUri.create(sourcePath).toString(),
        message: 'sources/ directory is not present yet.'
      });
      return [];
    }

    return (await fs.readdir(sourcePath, { withFileTypes: true }))
      .filter(child => child.name !== 'citations.yaml' && child.name !== 'excerpts.jsonl')
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(child => {
        const childPath = join(sourcePath, child.name);
        return {
          name: child.name,
          path: toWorkspacePath(rootPath, childPath),
          uri: FileUri.create(childPath).toString(),
          type: child.isDirectory() ? 'directory' : 'file'
        };
      });
  }

  protected async readCitations(citationsPath: string, diagnostics: WorkspaceDiagnostic[]): Promise<CitationEntry[]> {
    const uri = FileUri.create(citationsPath).toString();
    const text = await readTextIfExists(citationsPath);
    if (text === undefined) {
      diagnostics.push({
        severity: 'info',
        source: 'source-library',
        uri,
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
        uri,
        message: `Invalid citations.yaml: ${error instanceof Error ? error.message : String(error)}`
      });
      return [];
    }

    const records = Array.isArray(document)
      ? document
      : isRecord(document)
        ? (document as CitationDocument).citations
        : undefined;

    if (!Array.isArray(records)) {
      diagnostics.push({
        severity: 'warning',
        source: 'source-library',
        uri,
        message: 'citations.yaml should contain a citations list.'
      });
      return [];
    }

    return records
      .map((record, index) => this.toCitationEntry(record, index, uri, diagnostics))
      .filter((entry): entry is CitationEntry => entry !== undefined);
  }

  protected toCitationEntry(
    record: unknown,
    index: number,
    uri: string,
    diagnostics: WorkspaceDiagnostic[]
  ): CitationEntry | undefined {
    if (!isRecord(record)) {
      diagnostics.push({
        severity: 'warning',
        source: 'source-library',
        uri,
        message: `Ignoring citation ${index + 1}: expected object.`
      });
      return undefined;
    }

    const citation = record as CitationRecord;
    const id = asString(citation.id);
    const title = asString(citation.title);
    if (!id || !title) {
      diagnostics.push({
        severity: 'warning',
        source: 'source-library',
        uri,
        message: `Ignoring citation ${index + 1}: id and title are required.`
      });
      return undefined;
    }

    const source = asString(citation.source) || undefined;
    return {
      id,
      title,
      source,
      note: asString(citation.note) || undefined,
      path: source ? toWorkspaceSourcePath(source) : undefined
    };
  }

  protected async readExcerpts(excerptsPath: string, diagnostics: WorkspaceDiagnostic[]): Promise<SourceExcerpt[]> {
    const uri = FileUri.create(excerptsPath).toString();
    const text = await readTextIfExists(excerptsPath);
    if (text === undefined) {
      diagnostics.push({
        severity: 'info',
        source: 'source-library',
        uri,
        message: 'No sources/excerpts.jsonl file found.'
      });
      return [];
    }

    const excerpts: SourceExcerpt[] = [];
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index].trim();
      if (line.length === 0) {
        continue;
      }

      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        diagnostics.push({
          severity: 'warning',
          source: 'source-library',
          uri,
          message: `Ignoring excerpt on line ${index + 1}: invalid JSON.`
        });
        continue;
      }

      const excerpt = this.toExcerpt(record, index, uri, diagnostics);
      if (excerpt) {
        excerpts.push(excerpt);
      }
    }
    return excerpts;
  }

  protected toExcerpt(
    record: unknown,
    index: number,
    uri: string,
    diagnostics: WorkspaceDiagnostic[]
  ): SourceExcerpt | undefined {
    if (!isRecord(record)) {
      diagnostics.push({
        severity: 'warning',
        source: 'source-library',
        uri,
        message: `Ignoring excerpt on line ${index + 1}: expected a JSON object.`
      });
      return undefined;
    }

    const text = asString(record.text);
    if (!text) {
      diagnostics.push({
        severity: 'warning',
        source: 'source-library',
        uri,
        message: `Ignoring excerpt on line ${index + 1}: text is required.`
      });
      return undefined;
    }

    const sourceId = asString(record.source) || asString(record.sourceId);
    const sourcePath = asString(record.sourcePath)
      || (looksLikePath(sourceId) ? sourceId : '');
    return {
      id: asString(record.id) || `excerpt-${index + 1}`,
      sourceId: sourceId || undefined,
      sourcePath: sourcePath || undefined,
      text,
      note: asString(record.note) || asString(record.ref) || undefined,
      targetPath: asString(record.targetPath) || undefined,
      targetAnchor: asString(record.targetAnchor) || undefined,
      targetLine: asLineNumber(record.targetLine)
    };
  }
}

@injectable()
export class NodeAiModeRegistryService implements AiModeRegistryBackendService {
  getSnapshot(rootUri?: string): Promise<AiModeRegistrySnapshot> {
    if (!rootUri) {
      return Promise.resolve({
        modes: [],
        diagnostics: [{
          severity: 'info',
          source: 'ai-mode-registry',
          message: 'Open a manuscript workspace to load project AI modes.'
        }]
      });
    }

    return this.scan(toRootPath(rootUri));
  }

  refresh(rootUri?: string): Promise<AiModeRegistrySnapshot> {
    return this.getSnapshot(rootUri);
  }

  protected async scan(rootPath: string): Promise<AiModeRegistrySnapshot> {
    const sourcePath = join(rootPath, AI_MODES_PATH);
    const sourceUri = FileUri.create(sourcePath).toString();
    const rootUri = FileUri.create(rootPath).toString();
    const diagnostics: WorkspaceDiagnostic[] = [];

    const text = await readTextIfExists(sourcePath);
    if (text === undefined) {
      return {
        rootUri,
        sourceUri,
        modes: [],
        diagnostics: [{
          severity: 'info',
          source: 'ai-mode-registry',
          uri: sourceUri,
          message: `No project AI modes file found at ${AI_MODES_PATH}.`
        }]
      };
    }

    let document: unknown;
    try {
      document = parse(text);
    } catch (error) {
      return {
        rootUri,
        sourceUri,
        modes: [],
        diagnostics: [{
          severity: 'error',
          source: 'ai-mode-registry',
          uri: sourceUri,
          message: `Invalid AI modes YAML: ${error instanceof Error ? error.message : String(error)}`
        }]
      };
    }

    const modes = this.parseModes(document, sourceUri, diagnostics);
    return {
      rootUri,
      sourceUri,
      modes,
      diagnostics
    };
  }

  protected parseModes(document: unknown, sourceUri: string, diagnostics: WorkspaceDiagnostic[]): AiMode[] {
    const modeEntries = Array.isArray(document)
      ? document
      : isRecord(document)
        ? (document as AiModeDocument).modes
        : undefined;

    if (!Array.isArray(modeEntries)) {
      diagnostics.push({
        severity: 'warning',
        source: 'ai-mode-registry',
        uri: sourceUri,
        message: 'AI modes file must contain a modes list.'
      });
      return [];
    }

    const modes: AiMode[] = [];
    const seen = new Set<string>();
    for (const [index, entry] of modeEntries.entries()) {
      const mode = this.parseModeEntry(entry, index, sourceUri, diagnostics);
      if (!mode) {
        continue;
      }
      if (seen.has(mode.id)) {
        diagnostics.push({
          severity: 'warning',
          source: 'ai-mode-registry',
          uri: sourceUri,
          message: `Ignoring duplicate AI mode id: ${mode.id}`
        });
        continue;
      }
      seen.add(mode.id);
      modes.push(mode);
    }
    return modes;
  }

  protected parseModeEntry(
    entry: unknown,
    index: number,
    sourceUri: string,
    diagnostics: WorkspaceDiagnostic[]
  ): AiMode | undefined {
    if (!isRecord(entry)) {
      diagnostics.push({
        severity: 'warning',
        source: 'ai-mode-registry',
        uri: sourceUri,
        message: `Ignoring AI mode ${index + 1}: expected object.`
      });
      return undefined;
    }

    const modeEntry = entry as AiModeEntry;
    const id = asString(modeEntry.id);
    const systemPrompt = asString(modeEntry.systemPrompt) || asString(modeEntry.prompt);
    if (!id || !systemPrompt) {
      diagnostics.push({
        severity: 'warning',
        source: 'ai-mode-registry',
        uri: sourceUri,
        message: `Ignoring AI mode ${index + 1}: id and systemPrompt are required.`
      });
      return undefined;
    }

    return {
      id,
      label: asString(modeEntry.label) || id,
      description: asString(modeEntry.description),
      systemPrompt,
      userPrompt: asString(modeEntry.userPrompt),
      parameters: this.asParameters(modeEntry.parameters)
    };
  }

  protected asParameters(value: unknown): AiMode['parameters'] | undefined {
    if (!isRecord(value)) {
      return undefined;
    }
    return { ...value } as AiMode['parameters'];
  }
}
