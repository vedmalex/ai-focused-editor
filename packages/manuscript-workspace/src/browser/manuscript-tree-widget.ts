import URI from '@theia/core/lib/common/uri';
import {
  inject,
  injectable,
  postConstruct
} from '@theia/core/shared/inversify';
import {
  ContextMenuRenderer,
  open,
  OpenerService
} from '@theia/core/lib/browser';
import {
  TreeModel,
  TreeProps,
  TreeWidget
} from '@theia/core/lib/browser/tree';
import type { TreeNode } from '@theia/core/lib/browser/tree';
import type { ManuscriptWorkspaceSnapshot } from '../common';
import { ManuscriptTreeNode } from './manuscript-tree';
import { ManuscriptTreeModel } from './manuscript-tree-model';

@injectable()
export class ManuscriptTreeWidget extends TreeWidget {
  static readonly ID = 'ai-focused-editor.manuscript-tree';
  static readonly LABEL = 'Manuscript';
  static readonly CONTEXT_MENU = ['ai-focused-editor-manuscript-tree'];

  @inject(OpenerService)
  protected readonly openerService!: OpenerService;

  constructor(
    @inject(TreeProps) props: TreeProps,
    @inject(TreeModel) model: ManuscriptTreeModel,
    @inject(ContextMenuRenderer) contextMenuRenderer: ContextMenuRenderer
  ) {
    super(props, model, contextMenuRenderer);
  }

  @postConstruct()
  protected override init(): void {
    super.init();
    this.id = ManuscriptTreeWidget.ID;
    this.title.label = ManuscriptTreeWidget.LABEL;
    this.title.caption = 'Manifest-backed manuscript content';
    this.title.iconClass = 'fa fa-book';
    this.title.closable = true;
    this.toDispose.push(this.model.onOpenNode(node => this.openManuscriptNode(node)));
  }

  protected async openManuscriptNode(node: Readonly<TreeNode>): Promise<void> {
    if (!ManuscriptTreeNode.isFile(node) || !node.manuscript.uri) {
      return;
    }
    await open(this.openerService, new URI(node.manuscript.uri));
  }

  refreshWorkspace(): Promise<ManuscriptWorkspaceSnapshot> {
    return (this.model as ManuscriptTreeModel).refreshWorkspace();
  }
}
