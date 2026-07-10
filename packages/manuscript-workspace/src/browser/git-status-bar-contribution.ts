import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import {
  StatusBar,
  StatusBarAlignment
} from '@theia/core/lib/browser/status-bar/status-bar';
import { DisposableCollection } from '@theia/core/lib/common/disposable';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { inject, injectable } from '@theia/core/shared/inversify';
import type { GitStatusService } from '../common';
import { GitStatusService as GitStatusServiceSymbol } from '../common';

const STATUS_BAR_ID = 'ai-focused-editor.git-status';
const REFRESH_INTERVAL_MS = 15000;
const FILE_CHANGE_DEBOUNCE_MS = 1500;

/**
 * Read-only git branch/dirty indicator (spec §5.6/§7). Commits stay manual;
 * once a platform-compatible @theia/git provider is available the SCM view
 * takes over the interactive side.
 */
@injectable()
export class GitStatusBarContribution implements FrontendApplicationContribution {
  @inject(StatusBar)
  protected readonly statusBar!: StatusBar;

  @inject(GitStatusServiceSymbol)
  protected readonly gitStatus!: GitStatusService;

  @inject(WorkspaceService)
  protected readonly workspaceService!: WorkspaceService;

  @inject(FileService)
  protected readonly fileService!: FileService;

  protected readonly toDispose = new DisposableCollection();
  protected refreshTimer: ReturnType<typeof setInterval> | undefined;
  protected debounceTimer: ReturnType<typeof setTimeout> | undefined;

  onStart(): void {
    void this.updateStatus();
    this.refreshTimer = setInterval(() => { void this.updateStatus(); }, REFRESH_INTERVAL_MS);
    this.toDispose.push({ dispose: () => this.refreshTimer && clearInterval(this.refreshTimer) });
    this.toDispose.push(this.fileService.onDidFilesChange(() => this.scheduleUpdate()));
  }

  onStop(): void {
    this.toDispose.dispose();
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
    }
  }

  protected scheduleUpdate(): void {
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      void this.updateStatus();
    }, FILE_CHANGE_DEBOUNCE_MS);
  }

  protected async updateStatus(): Promise<void> {
    await this.workspaceService.ready;
    const root = this.workspaceService.tryGetRoots()[0];
    const status = await this.gitStatus.getStatus(root?.resource.toString()).catch(() => undefined);

    if (!status?.isRepository) {
      this.statusBar.removeElement(STATUS_BAR_ID);
      return;
    }

    const dirty = status.dirtyCount ?? 0;
    const sync = [
      status.ahead ? `↑${status.ahead}` : undefined,
      status.behind ? `↓${status.behind}` : undefined
    ].filter(Boolean).join(' ');
    const text = `$(source-control) ${status.branch}${dirty > 0 ? ` •${dirty}` : ''}${sync ? ` ${sync}` : ''}`;

    await this.statusBar.setElement(STATUS_BAR_ID, {
      text,
      alignment: StatusBarAlignment.LEFT,
      priority: 100,
      tooltip: [
        `Git branch: ${status.branch}`,
        `Changed files: ${dirty}`,
        status.ahead !== undefined ? `Ahead of upstream: ${status.ahead}` : undefined,
        status.behind !== undefined ? `Behind upstream: ${status.behind}` : undefined,
        'Commits stay manual (spec §5.6).'
      ].filter((line): line is string => Boolean(line)).join('\n')
    });
  }
}
