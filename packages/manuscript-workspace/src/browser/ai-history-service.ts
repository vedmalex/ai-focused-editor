import URI from '@theia/core/lib/common/uri';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { inject, injectable } from '@theia/core/shared/inversify';

export interface AiHistoryRecord {
  timestamp?: string;
  kind: string;
  command: string;
  documentUri?: string;
  data: Record<string, unknown>;
}

@injectable()
export class AiHistoryService {
  @inject(WorkspaceService)
  protected readonly workspaceService!: WorkspaceService;

  @inject(FileService)
  protected readonly fileService!: FileService;

  async appendChatEvent(record: AiHistoryRecord): Promise<URI | undefined> {
    return this.appendJsonl('ai/chat', record);
  }

  async appendContextSnapshot(record: AiHistoryRecord): Promise<URI | undefined> {
    return this.appendJsonl('ai/context-snapshots', record);
  }

  protected async appendJsonl(directoryPath: string, record: AiHistoryRecord): Promise<URI | undefined> {
    const root = await this.getWorkspaceRoot();
    if (!root) {
      return undefined;
    }

    const directoryUri = root.resolve(directoryPath);
    await this.ensureDirectoryPath(root, directoryPath);

    const timestamp = record.timestamp ?? new Date().toISOString();
    const fileUri = directoryUri.resolve(`${timestamp.slice(0, 10)}.jsonl`);
    const line = `${JSON.stringify({
      ...record,
      timestamp
    })}\n`;

    const existing = await this.readTextIfExists(fileUri);
    if (existing === undefined) {
      await this.fileService.create(fileUri, line, { overwrite: false });
    } else {
      await this.fileService.write(fileUri, `${existing}${line}`);
    }
    return fileUri;
  }

  protected async ensureDirectoryPath(root: URI, directoryPath: string): Promise<void> {
    let current = root;
    for (const segment of directoryPath.split('/').filter(Boolean)) {
      current = current.resolve(segment);
      try {
        await this.fileService.createFolder(current);
      } catch {
        // Existing folders are expected during append-only writes.
      }
    }
  }

  protected async getWorkspaceRoot(): Promise<URI | undefined> {
    await this.workspaceService.ready;
    return (this.workspaceService.tryGetRoots()[0] ?? (await this.workspaceService.roots)[0])?.resource;
  }

  protected async readTextIfExists(resource: URI): Promise<string | undefined> {
    try {
      return (await this.fileService.read(resource)).value;
    } catch {
      return undefined;
    }
  }
}
