import { injectable } from '@theia/core/shared/inversify';
import { CompositeTreeNode } from '@theia/core/lib/browser/tree';
import type { ManuscriptNode } from '../common';
import {
  MANUSCRIPT_TREE_ROOT_ID,
  ManuscriptFolderTreeNode,
  ManuscriptTreeNode,
  ManuscriptTreeRootNode
} from './manuscript-tree';

@injectable()
export class ManuscriptTreeItemFactory {
  createRoot(content: ManuscriptNode[]): ManuscriptTreeRootNode {
    const root: ManuscriptTreeRootNode = {
      id: MANUSCRIPT_TREE_ROOT_ID,
      name: 'Manuscript',
      parent: undefined,
      visible: false,
      children: []
    };

    for (const node of this.sortNodes(content)) {
      CompositeTreeNode.addChild(root, this.createNode(node));
    }

    return root;
  }

  protected createNode(manuscript: ManuscriptNode): ManuscriptTreeNode {
    if (manuscript.type === 'folder') {
      const folder: ManuscriptFolderTreeNode = {
        id: `manuscript:${manuscript.id}`,
        name: manuscript.name,
        parent: undefined,
        nodeType: 'folder',
        manuscript,
        selected: false,
        expanded: true,
        children: []
      };

      for (const child of this.sortNodes(manuscript.children ?? [])) {
        CompositeTreeNode.addChild(folder, this.createNode(child));
      }

      return folder;
    }

    return {
      id: `manuscript:${manuscript.path}`,
      name: manuscript.name,
      parent: undefined,
      nodeType: 'file',
      manuscript,
      selected: false
    };
  }

  protected sortNodes(nodes: ManuscriptNode[]): ManuscriptNode[] {
    return [...nodes].sort((left, right) => {
      const byOrder = left.order - right.order;
      return byOrder === 0 ? left.name.localeCompare(right.name) : byOrder;
    });
  }
}
