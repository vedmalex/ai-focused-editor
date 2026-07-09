import type { CompositeTreeNode, TreeNode } from '@theia/core/lib/browser/tree';
import type { ManuscriptNode } from '../common';

export const MANUSCRIPT_TREE_ROOT_ID = 'ai-focused-editor.manuscript-tree.root';

export interface ManuscriptTreeRootNode extends CompositeTreeNode {
  readonly id: typeof MANUSCRIPT_TREE_ROOT_ID;
  readonly name: 'Manuscript';
  children: ManuscriptTreeNode[];
}

export interface ManuscriptTreeNodeData {
  readonly manuscript: ManuscriptNode;
}

export interface ManuscriptFileTreeNode extends TreeNode, ManuscriptTreeNodeData {
  readonly nodeType: 'file';
  selected: boolean;
}

export interface ManuscriptFolderTreeNode extends CompositeTreeNode, ManuscriptTreeNodeData {
  readonly nodeType: 'folder';
  children: ManuscriptTreeNode[];
  expanded: boolean;
  selected: boolean;
}

export type ManuscriptTreeNode = ManuscriptFileTreeNode | ManuscriptFolderTreeNode;

export namespace ManuscriptTreeNode {
  export function is(node: unknown): node is ManuscriptTreeNode {
    return typeof node === 'object' && node !== null && 'manuscript' in node;
  }

  export function isFile(node: unknown): node is ManuscriptFileTreeNode {
    return is(node) && node.nodeType === 'file';
  }

  export function isFolder(node: unknown): node is ManuscriptFolderTreeNode {
    return is(node) && node.nodeType === 'folder';
  }
}
