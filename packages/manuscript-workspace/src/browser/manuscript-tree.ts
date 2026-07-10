import type { CompositeTreeNode, TreeNode } from '@theia/core/lib/browser/tree';
import type { ManuscriptNode } from '../common';
import type { AuthorMaterialsSectionKind } from '../common/author-materials';

export const MANUSCRIPT_TREE_ROOT_ID = 'ai-focused-editor.manuscript-tree.root';

/**
 * Context-key name tracking the manuscript tree's current selection
 * (`none`, `manuscript`, or an author-materials {@link AuthorMaterialsSectionKind}).
 * Menu `when` clauses read it to gate the per-section create actions in the tree
 * context menu without also hiding them from the always-visible product menu bar.
 */
export const AFE_MANUSCRIPT_SECTION_CONTEXT_KEY = 'afeManuscriptSection';

export interface ManuscriptTreeRootNode extends CompositeTreeNode {
  readonly id: typeof MANUSCRIPT_TREE_ROOT_ID;
  readonly name: 'Manuscript';
  children: AuthorMaterialsSectionTreeNode[];
}

/**
 * A top-level author-materials section (Manuscript, Characters, Terms, …).
 * Sections are composite, non-draggable, and — crucially — carry no
 * `manuscript` field, so the manuscript DnD guards ({@link ManuscriptTreeNode.is})
 * treat them as neither draggable sources nor drop targets.
 */
export interface AuthorMaterialsSectionTreeNode extends CompositeTreeNode {
  readonly nodeType: 'section';
  readonly sectionKind: AuthorMaterialsSectionKind;
  children: TreeNode[];
  expanded: boolean;
  selected: boolean;
}

/** A leaf material item (entity, citation, source, or knowledge file). */
export interface AuthorMaterialTreeNode extends TreeNode {
  readonly nodeType: 'material';
  readonly sectionKind: AuthorMaterialsSectionKind;
  /** URI opened on activation; undefined items are non-openable. */
  readonly materialUri?: string;
  /** Secondary text rendered after the label. */
  readonly description?: string;
  selected: boolean;
}

/** A folder grouping nested materials (sources/knowledge keep their layout). */
export interface AuthorMaterialFolderTreeNode extends CompositeTreeNode {
  readonly nodeType: 'material-folder';
  readonly sectionKind: AuthorMaterialsSectionKind;
  children: TreeNode[];
  expanded: boolean;
  selected: boolean;
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

export namespace AuthorMaterialsSectionTreeNode {
  export function is(node: unknown): node is AuthorMaterialsSectionTreeNode {
    return typeof node === 'object' && node !== null
      && (node as { nodeType?: unknown }).nodeType === 'section';
  }

  export function isManuscript(node: unknown): node is AuthorMaterialsSectionTreeNode {
    return is(node) && node.sectionKind === 'manuscript';
  }
}

export namespace AuthorMaterialTreeNode {
  export function is(node: unknown): node is AuthorMaterialTreeNode {
    return typeof node === 'object' && node !== null
      && (node as { nodeType?: unknown }).nodeType === 'material';
  }
}

export namespace AuthorMaterialFolderTreeNode {
  export function is(node: unknown): node is AuthorMaterialFolderTreeNode {
    return typeof node === 'object' && node !== null
      && (node as { nodeType?: unknown }).nodeType === 'material-folder';
  }
}
