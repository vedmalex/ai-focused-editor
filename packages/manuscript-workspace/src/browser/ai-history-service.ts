import URI from '@theia/core/lib/common/uri';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { inject, injectable } from '@theia/core/shared/inversify';
import {
  AiHistoryLogRecord,
  DEFAULT_HISTORY_LIMIT,
  parseHistoryJsonl
} from '../common/ai-history-log';

export type AiHistoryKind = 'chat' | 'context-snapshots';

export type AiHistoryRecord = AiHistoryLogRecord;

const HISTORY_DAY_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

@injectable()
export class AiHistoryService {
  @inject(WorkspaceService)
  protected readonly workspaceService!: WorkspaceService;

  @inject(FileService)
  protected readonly fileService!: FileService;

  /**
   * Appends are serialized through this queue: the JSONL write is a
   * read-modify-write, and concurrent commands would otherwise lose lines.
   */
  protected appendQueue: Promise<unknown> = Promise.resolve();

  async appendChatEvent(record: AiHistoryRecord): Promise<URI | undefined> {
    return this.enqueueAppend('ai/chat', record);
  }

  async appendContextSnapshot(record: AiHistoryRecord): Promise<URI | undefined> {
    return this.enqueueAppend('ai/context-snapshots', record);
  }

  /**
   * Lists the available history days for the given log kind, newest first.
   * Returns an empty list when there is no workspace or no history yet.
   */
  async listHistoryDays(kind: AiHistoryKind): Promise<string[]> {
    const directoryUri = await this.getHistoryDirectoryUri(kind);
    if (!directoryUri) {
      return [];
    }
    try {
      const stat = await this.fileService.resolve(directoryUri);
      if (!stat.isDirectory || !stat.children) {
        return [];
      }
      return stat.children
        .filter(child => child.isFile && HISTORY_DAY_FILE.test(child.name))
        .map(child => child.name.replace(/\.jsonl$/, ''))
        .sort((left, right) => right.localeCompare(left));
    } catch {
      return [];
    }
  }

  /**
   * Reads and defensively parses the history entries for a single day,
   * newest first, capped at `limit` records (default 100).
   */
  async readHistoryEntries(kind: AiHistoryKind, day: string, limit: number = DEFAULT_HISTORY_LIMIT): Promise<AiHistoryRecord[]> {
    const fileUri = await this.getHistoryDayUri(kind, day);
    if (!fileUri) {
      return [];
    }
    const text = await this.readTextIfExists(fileUri);
    if (text === undefined) {
      return [];
    }
    return parseHistoryJsonl(text, limit);
  }

  async getHistoryDayUri(kind: AiHistoryKind, day: string): Promise<URI | undefined> {
    const directoryUri = await this.getHistoryDirectoryUri(kind);
    return directoryUri?.resolve(`${day}.jsonl`);
  }

  protected async getHistoryDirectoryUri(kind: AiHistoryKind): Promise<URI | undefined> {
    const root = await this.getWorkspaceRoot();
    return root?.resolve(`ai/${kind}`);
  }

  protected enqueueAppend(directoryPath: string, record: AiHistoryRecord): Promise<URI | undefined> {
    const next = this.appendQueue.then(() => this.appendJsonl(directoryPath, record));
    this.appendQueue = next.catch(() => undefined);
    return next;
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
