import { promises as fs } from 'fs';
import { homedir } from 'os';
import { isAllowedMaterialFile } from '../common/author-materials';
import { extname, isAbsolute, join, relative, resolve, sep } from 'path';
import { FileUri } from '@theia/core/lib/common/file-uri';
import { injectable } from '@theia/core/shared/inversify';
import { parse } from 'yaml';
import {
  AI_MODE_APPLY_KINDS,
  AI_MODE_CONTEXTS,
  AiMode,
  AiModeApply,
  AiModeContext,
  AiModeLayer,
  AiModeOrigin,
  AiModeRegistryBackendService,
  AiModeRegistrySnapshot,
  layerModes,
  ResolvedAiMode,
  CitationEntry,
  NarrativeEntity,
  NarrativeEntityBackendService,
  NarrativeEntityKind,
  NarrativeEntitySnapshot,
  SourceExcerpt,
  SourceLibraryBackendService,
  SourceLibraryItem,
  SourceLibrarySnapshot,
  SourceTextExtraction,
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
  context?: unknown;
  menu?: unknown;
  apply?: unknown;
  agent?: unknown;
  icon?: unknown;
  enabled?: unknown;
}

const AI_MODES_PATH = 'ai/prompts/custom-modes.yaml';
/** Bundled base modes shipped with the extension (copied to lib/node/ai/ by the build). */
const BUNDLED_MODES_PATH = join(__dirname, 'ai', 'base-modes.yaml');
/** The user-global modes file, hot-watched alongside the book file. */
const GLOBAL_MODES_PATH = join(homedir(), '.ai-focused-editor', 'custom-modes.yaml');

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

/** Minimal structural surface of the `unpdf` functions used for text extraction. */
interface UnpdfModule {
  getDocumentProxy(data: Uint8Array): Promise<unknown>;
  extractText(
    pdf: unknown,
    options?: { mergePages?: boolean }
  ): Promise<{ totalPages: number; text: string | string[] }>;
}

/**
 * Extract the merged plain text of a PDF via `unpdf` (a small, serverless-friendly
 * pdf.js build).
 *
 * `unpdf` is resolved lazily through a runtime-assembled specifier so the esbuild
 * backend bundler never pulls it (it bundles pdf.js and is bundler-hostile) into
 * the graph — it is loaded from node_modules only when a PDF is actually analyzed,
 * mirroring the puppeteer-core lazy-require guard in the PDF exporter. `unpdf`
 * ships a CommonJS entry (`./dist/index.cjs`) so a plain `require` resolves it in
 * the tsc-CJS backend and under the bun test runner alike.
 */
async function extractPdfText(absolutePath: string): Promise<string> {
  const moduleName = ['un', 'pdf'].join('');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const unpdf = require(moduleName) as UnpdfModule;
  const buffer = await fs.readFile(absolutePath);
  const pdf = await unpdf.getDocumentProxy(new Uint8Array(buffer));
  const { text } = await unpdf.extractText(pdf, { mergePages: true });
  return Array.isArray(text) ? text.join('\n') : text;
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

  /**
   * Extract the plain text of a workspace source document (spec §5.4). PDFs are
   * parsed with `unpdf`; other files are read as UTF-8 so the method is a general
   * "give me this source as text" primitive for the analyzer. The path is resolved
   * inside the workspace root and every failure mode (escape, missing file,
   * image-only PDF, parser error) is reported as `ok: false` rather than throwing,
   * so the frontend can warn gracefully.
   */
  async extractSourceText(rootUri: string, path: string): Promise<SourceTextExtraction> {
    if (!rootUri) {
      return { ok: false, detail: 'Open a manuscript workspace before extracting source text.' };
    }
    if (typeof path !== 'string' || path.trim().length === 0) {
      return { ok: false, detail: 'No source path was provided.' };
    }

    const rootPath = toRootPath(rootUri);
    const absolutePath = resolve(rootPath, path);
    const relativePath = relative(rootPath, absolutePath);
    if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
      return { ok: false, detail: `Path escapes the workspace root: ${path}` };
    }

    const stat = await statIfExists(absolutePath);
    if (!stat?.isFile()) {
      return { ok: false, detail: `Source file not found: ${path}` };
    }

    try {
      if (extname(absolutePath).toLowerCase() === '.pdf') {
        const text = await extractPdfText(absolutePath);
        if (text.trim().length === 0) {
          return {
            ok: false,
            detail: `No extractable text found in ${path} (it may be a scanned or image-only PDF).`
          };
        }
        return { ok: true, text };
      }
      return { ok: true, text: await fs.readFile(absolutePath, 'utf8') };
    } catch (error) {
      return {
        ok: false,
        detail: `Could not extract text from ${path}: ${error instanceof Error ? error.message : String(error)}`
      };
    }
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

    const items: SourceLibraryItem[] = [];
    await this.collectSourceItems(rootPath, sourcePath, sourcePath, items);
    return items;
  }

  /**
   * Recursive listing (sources may be organised into folders). Only author
   * material types survive (documents, images, structural yaml/json); dot
   * files and dot directories are skipped; a directory is listed only when it
   * contains surviving descendants. The index files (citations.yaml,
   * excerpts.jsonl) at the sources root are managed separately.
   */
  protected async collectSourceItems(
    rootPath: string,
    sourcesRoot: string,
    directoryPath: string,
    out: SourceLibraryItem[]
  ): Promise<void> {
    const children = (await fs.readdir(directoryPath, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      if (child.name.startsWith('.')) {
        continue;
      }
      const childPath = join(directoryPath, child.name);
      if (child.isDirectory()) {
        const before = out.length;
        const marker: SourceLibraryItem = {
          name: child.name,
          path: toWorkspacePath(rootPath, childPath),
          uri: FileUri.create(childPath).toString(),
          type: 'directory'
        };
        out.push(marker);
        await this.collectSourceItems(rootPath, sourcesRoot, childPath, out);
        if (out.length === before + 1) {
          out.splice(before, 1);
        }
        continue;
      }
      if (!child.isFile()) {
        continue;
      }
      if (directoryPath === sourcesRoot && (child.name === 'citations.yaml' || child.name === 'excerpts.jsonl')) {
        continue;
      }
      if (!isAllowedMaterialFile(child.name)) {
        continue;
      }
      out.push({
        name: child.name,
        path: toWorkspacePath(rootPath, childPath),
        uri: FileUri.create(childPath).toString(),
        type: 'file'
      });
    }
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
  /**
   * Filesystem path of the bundled base modes. Overridable so tests can isolate
   * the base layer (point it at a nonexistent or fixture file). Defaults to the
   * copy shipped in `lib/node/ai/base-modes.yaml`.
   */
  protected bundledModesPath = BUNDLED_MODES_PATH;

  /**
   * Filesystem path of the user-global modes file. Overridable for tests; the
   * default is `~/.ai-focused-editor/custom-modes.yaml`.
   */
  protected globalModesPath = GLOBAL_MODES_PATH;

  /** Test seam: point the bundled/global layers at fixtures instead of the real files. */
  configureModeSources(options: { bundledModesPath?: string; globalModesPath?: string }): void {
    if (options.bundledModesPath !== undefined) {
      this.bundledModesPath = options.bundledModesPath;
    }
    if (options.globalModesPath !== undefined) {
      this.globalModesPath = options.globalModesPath;
    }
  }

  getSnapshot(rootUri?: string): Promise<AiModeRegistrySnapshot> {
    return this.scan(rootUri ? toRootPath(rootUri) : undefined);
  }

  refresh(rootUri?: string): Promise<AiModeRegistrySnapshot> {
    return this.getSnapshot(rootUri);
  }

  protected async scan(rootPath: string | undefined): Promise<AiModeRegistrySnapshot> {
    const diagnostics: WorkspaceDiagnostic[] = [];
    const rootUri = rootPath ? FileUri.create(rootPath).toString() : undefined;
    const globalUri = FileUri.create(this.globalModesPath).toString();
    const sourcePath = rootPath ? join(rootPath, AI_MODES_PATH) : undefined;
    const sourceUri = sourcePath ? FileUri.create(sourcePath).toString() : undefined;

    // Layer 1: bundled base modes (read-only, ship with the extension).
    const bundled = await this.loadLayer('built-in', this.bundledModesPath, diagnostics, { silentMissing: true });
    // Layer 2: user-global modes (optional).
    const global = await this.loadLayer('global', this.globalModesPath, diagnostics, { silentMissing: true });
    // Layer 3: the book's modes (optional; info diagnostic when absent, as before).
    const book = sourcePath
      ? await this.loadLayer('book', sourcePath, diagnostics, {
        silentMissing: false,
        missingMessage: `No project AI modes file found at ${AI_MODES_PATH}.`
      })
      : { origin: 'book' as AiModeOrigin, modes: [] };

    if (!rootPath) {
      diagnostics.push({
        severity: 'info',
        source: 'ai-mode-registry',
        message: 'Open a manuscript workspace to load project AI modes.'
      });
    }

    const layers: AiModeLayer[] = [bundled, global, book];
    const resolved: ResolvedAiMode[] = layerModes(layers);
    const modes: AiMode[] = resolved.filter(mode => mode.enabled);

    const watchUris = [sourceUri, globalUri].filter((uri): uri is string => uri !== undefined);

    return {
      rootUri,
      sourceUri,
      globalUri,
      watchUris,
      modes,
      resolved,
      diagnostics
    };
  }

  /**
   * Read and parse one layer's modes file into a layer record. A missing file is
   * either silent (bundled/global) or reported with an info diagnostic (book).
   * Parse errors and structural problems surface as tagged diagnostics; the layer
   * still contributes whatever valid modes it could parse.
   */
  protected async loadLayer(
    origin: AiModeOrigin,
    filePath: string,
    diagnostics: WorkspaceDiagnostic[],
    options: { silentMissing: boolean; missingMessage?: string }
  ): Promise<AiModeLayer> {
    const uri = FileUri.create(filePath).toString();
    const text = await readTextIfExists(filePath);
    if (text === undefined) {
      if (!options.silentMissing) {
        diagnostics.push({
          severity: 'info',
          source: 'ai-mode-registry',
          uri,
          message: options.missingMessage ?? 'No AI modes file found.'
        });
      }
      return { origin, modes: [] };
    }

    let document: unknown;
    try {
      document = parse(text);
    } catch (error) {
      // Keep the book message backward-compatible ("Invalid AI modes YAML"); the
      // lower layers name their origin so the author can tell which file failed.
      const prefix = origin === 'book' ? '' : `${this.originLabel(origin)} `;
      diagnostics.push({
        severity: origin === 'book' ? 'error' : 'warning',
        source: 'ai-mode-registry',
        uri,
        message: `Invalid ${prefix}AI modes YAML: ${error instanceof Error ? error.message : String(error)}`
      });
      return { origin, modes: [] };
    }

    const modes = this.parseModes(document, uri, diagnostics);
    return { origin, modes };
  }

  protected originLabel(origin: AiModeOrigin): string {
    switch (origin) {
      case 'built-in':
        return 'bundled';
      case 'global':
        return 'global';
      default:
        return 'project';
    }
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

    const context = this.asContext(modeEntry.context, id, sourceUri, diagnostics);
    const apply = this.asApply(modeEntry.apply, context, id, sourceUri, diagnostics);
    const icon = asString(modeEntry.icon);

    return {
      id,
      label: asString(modeEntry.label) || id,
      description: asString(modeEntry.description),
      systemPrompt,
      userPrompt: asString(modeEntry.userPrompt),
      parameters: this.asParameters(modeEntry.parameters),
      context,
      menu: this.asBoolean(modeEntry.menu),
      apply,
      agent: this.asBoolean(modeEntry.agent),
      // Only an explicit `false` disables a mode; absence means enabled.
      ...(modeEntry.enabled === false ? { enabled: false } : {}),
      ...(icon ? { icon } : {})
    };
  }

  protected asParameters(value: unknown): AiMode['parameters'] | undefined {
    if (!isRecord(value)) {
      return undefined;
    }
    return { ...value } as AiMode['parameters'];
  }

  protected asBoolean(value: unknown): boolean {
    return value === true;
  }

  /** Normalizes `context`, defaulting to `chat` and warning on unknown values. */
  protected asContext(
    value: unknown,
    modeId: string,
    sourceUri: string,
    diagnostics: WorkspaceDiagnostic[]
  ): AiModeContext {
    if (value === undefined || value === null || value === '') {
      return 'chat';
    }
    if (typeof value === 'string' && (AI_MODE_CONTEXTS as readonly string[]).includes(value)) {
      return value as AiModeContext;
    }
    diagnostics.push({
      severity: 'warning',
      source: 'ai-mode-registry',
      uri: sourceUri,
      message: `AI mode "${modeId}" has unknown context "${String(value)}"; defaulting to "chat".`
    });
    return 'chat';
  }

  /**
   * Normalizes `apply`, defaulting to `replace` for selection modes and `chat`
   * otherwise. `replace`/`insert` are only valid for `selection`/`word`; for
   * other contexts they warn and fall back to `chat`.
   */
  protected asApply(
    value: unknown,
    context: AiModeContext,
    modeId: string,
    sourceUri: string,
    diagnostics: WorkspaceDiagnostic[]
  ): AiModeApply {
    const fallback: AiModeApply = context === 'selection' ? 'replace' : 'chat';
    let apply: AiModeApply = fallback;
    if (value !== undefined && value !== null && value !== '') {
      if (typeof value === 'string' && (AI_MODE_APPLY_KINDS as readonly string[]).includes(value)) {
        apply = value as AiModeApply;
      } else {
        diagnostics.push({
          severity: 'warning',
          source: 'ai-mode-registry',
          uri: sourceUri,
          message: `AI mode "${modeId}" has unknown apply "${String(value)}"; defaulting to "${fallback}".`
        });
        return fallback;
      }
    }
    if ((apply === 'replace' || apply === 'insert') && context !== 'selection' && context !== 'word') {
      diagnostics.push({
        severity: 'warning',
        source: 'ai-mode-registry',
        uri: sourceUri,
        message: `AI mode "${modeId}" uses apply "${apply}" with context "${context}"; only selection/word modes can replace or insert. Falling back to "chat".`
      });
      return 'chat';
    }
    return apply;
  }
}
