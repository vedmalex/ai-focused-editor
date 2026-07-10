import { postConstruct, inject, injectable } from '@theia/core/shared/inversify';
import { TreeModelImpl } from '@theia/core/lib/browser/tree';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import type {
  ManuscriptMoveTarget,
  ManuscriptMutationResult,
  ManuscriptWorkspaceSnapshot
} from '../common';
import { ManuscriptWorkspaceService } from '../common';
import { ManuscriptTreeItemFactory } from './manuscript-tree-item-factory';

const AUTO_REFRESH_DELAY_MS = 300;

@injectable()
export class ManuscriptTreeModel extends TreeModelImpl {
  @inject(ManuscriptWorkspaceService)
  protected readonly manuscriptWorkspace!: ManuscriptWorkspaceService;

  @inject(ManuscriptTreeItemFactory)
  protected readonly itemFactory!: ManuscriptTreeItemFactory;

  @inject(FileService)
  protected readonly fileService!: FileService;

  protected currentSnapshot: ManuscriptWorkspaceSnapshot | undefined;
  protected autoRefreshHandle: ReturnType<typeof setTimeout> | undefined;
  protected mutationInFlight = false;

  @postConstruct()
  protected override init(): void {
    super.init();
    this.root = this.itemFactory.createRoot([]);
    this.toDispose.push(this.fileService.onDidFilesChange(event => {
      if (this.mutationInFlight || !this.currentSnapshot?.rootUri) {
        return;
      }
      const affectsManuscript = event.changes.some(change => {
        const path = change.resource.toString();
        return path.endsWith('/manifest.yaml') || path.includes('/content/');
      });
      if (affectsManuscript) {
        this.scheduleAutoRefresh();
      }
    }));
    void this.refreshWorkspace();
  }

  async refreshWorkspace(): Promise<ManuscriptWorkspaceSnapshot> {
    const snapshot = await this.manuscriptWorkspace.refresh();
    this.applySnapshot(snapshot);
    return snapshot;
  }

  async moveEntry(sourcePath: string, target: ManuscriptMoveTarget): Promise<ManuscriptMutationResult> {
    return this.runMutation(() => this.manuscriptWorkspace.moveEntry(sourcePath, target));
  }

  async setBuildInclusion(path: string, include: boolean): Promise<ManuscriptMutationResult> {
    return this.runMutation(() => this.manuscriptWorkspace.setBuildInclusion(path, include));
  }

  async createChapter(parentPath: string | undefined, title: string): Promise<ManuscriptMutationResult> {
    return this.runMutation(() => this.manuscriptWorkspace.createChapter(parentPath, title));
  }

  get snapshot(): ManuscriptWorkspaceSnapshot | undefined {
    return this.currentSnapshot;
  }

  protected async runMutation(mutation: () => Promise<ManuscriptMutationResult>): Promise<ManuscriptMutationResult> {
    this.mutationInFlight = true;
    try {
      const result = await mutation();
      this.applySnapshot(result.snapshot);
      return result;
    } finally {
      this.mutationInFlight = false;
    }
  }

  protected applySnapshot(snapshot: ManuscriptWorkspaceSnapshot): void {
    this.currentSnapshot = snapshot;
    this.root = this.itemFactory.createRoot(snapshot.content);
  }

  protected scheduleAutoRefresh(): void {
    if (this.autoRefreshHandle !== undefined) {
      clearTimeout(this.autoRefreshHandle);
    }
    this.autoRefreshHandle = setTimeout(() => {
      this.autoRefreshHandle = undefined;
      void this.refreshWorkspace();
    }, AUTO_REFRESH_DELAY_MS);
  }
}
