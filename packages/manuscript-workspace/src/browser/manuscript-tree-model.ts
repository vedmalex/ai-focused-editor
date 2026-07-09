import { postConstruct, inject, injectable } from '@theia/core/shared/inversify';
import { TreeModelImpl } from '@theia/core/lib/browser/tree';
import type { ManuscriptWorkspaceSnapshot } from '../common';
import { ManuscriptWorkspaceService } from '../common';
import { ManuscriptTreeItemFactory } from './manuscript-tree-item-factory';

@injectable()
export class ManuscriptTreeModel extends TreeModelImpl {
  @inject(ManuscriptWorkspaceService)
  protected readonly manuscriptWorkspace!: ManuscriptWorkspaceService;

  @inject(ManuscriptTreeItemFactory)
  protected readonly itemFactory!: ManuscriptTreeItemFactory;

  protected currentSnapshot: ManuscriptWorkspaceSnapshot | undefined;

  @postConstruct()
  protected override init(): void {
    super.init();
    this.root = this.itemFactory.createRoot([]);
    void this.refreshWorkspace();
  }

  async refreshWorkspace(): Promise<ManuscriptWorkspaceSnapshot> {
    const snapshot = await this.manuscriptWorkspace.refresh();
    this.currentSnapshot = snapshot;
    this.root = this.itemFactory.createRoot(snapshot.content);
    return snapshot;
  }

  get snapshot(): ManuscriptWorkspaceSnapshot | undefined {
    return this.currentSnapshot;
  }
}
