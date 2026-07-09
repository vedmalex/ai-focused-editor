import URI from '@theia/core/lib/common/uri';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { inject, injectable } from '@theia/core/shared/inversify';
import { parse } from 'yaml';
import {
  AiMode,
  AiModeRegistry,
  AiModeRegistrySnapshot,
  ManuscriptWorkspaceService,
  WorkspaceDiagnostic
} from '../common';

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

@injectable()
export class BrowserAiModeRegistry implements AiModeRegistry {
  @inject(ManuscriptWorkspaceService)
  protected readonly manuscriptWorkspace!: ManuscriptWorkspaceService;

  @inject(FileService)
  protected readonly fileService!: FileService;

  async getSnapshot(): Promise<AiModeRegistrySnapshot> {
    const workspace = await this.manuscriptWorkspace.getSnapshot();
    if (!workspace.rootUri) {
      return {
        modes: [],
        diagnostics: [{
          severity: 'info',
          source: 'ai-mode-registry',
          message: 'Open a manuscript workspace to load project AI modes.'
        }]
      };
    }

    const rootUri = new URI(workspace.rootUri);
    const sourceUri = rootUri.resolve(AI_MODES_PATH);
    const diagnostics: WorkspaceDiagnostic[] = [];
    const text = await this.readTextIfExists(sourceUri);
    if (text === undefined) {
      return {
        rootUri: workspace.rootUri,
        sourceUri: sourceUri.toString(),
        modes: [],
        diagnostics: [{
          severity: 'info',
          source: 'ai-mode-registry',
          uri: sourceUri.toString(),
          message: `No project AI modes file found at ${AI_MODES_PATH}.`
        }]
      };
    }

    let document: unknown;
    try {
      document = parse(text);
    } catch (error) {
      return {
        rootUri: workspace.rootUri,
        sourceUri: sourceUri.toString(),
        modes: [],
        diagnostics: [{
          severity: 'error',
          source: 'ai-mode-registry',
          uri: sourceUri.toString(),
          message: `Invalid AI modes YAML: ${error instanceof Error ? error.message : String(error)}`
        }]
      };
    }

    const modes = this.parseModes(document, sourceUri.toString(), diagnostics);
    return {
      rootUri: workspace.rootUri,
      sourceUri: sourceUri.toString(),
      modes,
      diagnostics
    };
  }

  refresh(): Promise<AiModeRegistrySnapshot> {
    return this.getSnapshot();
  }

  async listModes(): Promise<AiMode[]> {
    return (await this.getSnapshot()).modes;
  }

  async getMode(id: string): Promise<AiMode | undefined> {
    return (await this.listModes()).find(mode => mode.id === id);
  }

  protected parseModes(document: unknown, sourceUri: string, diagnostics: WorkspaceDiagnostic[]): AiMode[] {
    const modeEntries = Array.isArray(document)
      ? document
      : this.isRecord(document)
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
    if (!this.isRecord(entry)) {
      diagnostics.push({
        severity: 'warning',
        source: 'ai-mode-registry',
        uri: sourceUri,
        message: `Ignoring AI mode ${index + 1}: expected object.`
      });
      return undefined;
    }

    const modeEntry = entry as AiModeEntry;
    const id = this.asString(modeEntry.id);
    const systemPrompt = this.asString(modeEntry.systemPrompt) || this.asString(modeEntry.prompt);
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
      label: this.asString(modeEntry.label) || id,
      description: this.asString(modeEntry.description),
      systemPrompt,
      userPrompt: this.asString(modeEntry.userPrompt),
      parameters: this.asParameters(modeEntry.parameters)
    };
  }

  protected async readTextIfExists(resource: URI): Promise<string | undefined> {
    try {
      return (await this.fileService.read(resource)).value;
    } catch {
      return undefined;
    }
  }

  protected asParameters(value: unknown): AiMode['parameters'] | undefined {
    if (!this.isRecord(value)) {
      return undefined;
    }
    return { ...value } as AiMode['parameters'];
  }

  protected asString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
  }

  protected isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}
