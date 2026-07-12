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

/**
 * Boolean context-key name: true when the current manuscript-tree selection is an
 * entity surface — the entities group, any entity section (built-in OR author),
 * or an item/leaf within one. The generic «Новая сущность…» create action reads
 * it so its `when` clause covers author section kinds without enumerating their
 * (dynamic) string values — {@link AFE_MANUSCRIPT_SECTION_CONTEXT_KEY} alone can
 * only match a fixed set of literals.
 */
export const AFE_MANUSCRIPT_SECTION_IS_ENTITY_CONTEXT_KEY = 'afeManuscriptSectionIsEntity';

/**
 * Context-key value and node discriminator for the collapsible group that nests
 * the four entity sections (Characters, Terms, Artifacts, Locations) under a
 * single node — mirroring the on-disk `entities/` folder. Selecting the group
 * sets {@link AFE_MANUSCRIPT_SECTION_CONTEXT_KEY} to this value so the four
 * entity create actions are all offered on the group's context menu.
 */
export const AUTHOR_MATERIALS_ENTITY_GROUP_KIND = 'entities' as const;

export interface ManuscriptTreeRootNode extends CompositeTreeNode {
  readonly id: typeof MANUSCRIPT_TREE_ROOT_ID;
  readonly name: 'Manuscript';
  children: (AuthorMaterialsSectionTreeNode | AuthorMaterialsSectionGroupTreeNode)[];
}

/**
 * A collapsible group nesting the entity sections under one node. Like a
 * section it is composite and carries no `manuscript` field, so the manuscript
 * DnD guards treat it as neither a draggable source nor a drop target; unlike a
 * section it carries a {@link groupKind} discriminator instead of a
 * `sectionKind`, so it maps to its own `entities` context-key value.
 */
export interface AuthorMaterialsSectionGroupTreeNode extends CompositeTreeNode {
  readonly nodeType: 'section-group';
  readonly groupKind: typeof AUTHOR_MATERIALS_ENTITY_GROUP_KIND;
  /**
   * The nested entity sections, plus an optional trailing material leaf that
   * opens `entities/types.yaml` (the author's entity-type declarations) so the
   * types file is discoverable right under the group header.
   */
  children: (AuthorMaterialsSectionTreeNode | AuthorMaterialTreeNode)[];
  expanded: boolean;
  selected: boolean;
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
  /**
   * Explicit header icon class for author-declared entity sections (built-in
   * sections leave this undefined and fall back to the static per-kind map in
   * the label provider). Carries the descriptor's `sectionIcon` + accent.
   */
  readonly iconClass?: string;
}

/** A leaf material item (entity, citation, source, or knowledge file). */
export interface AuthorMaterialTreeNode extends TreeNode {
  readonly nodeType: 'material';
  readonly sectionKind: AuthorMaterialsSectionKind;
  /** URI opened on activation; undefined items are non-openable. */
  readonly materialUri?: string;
  /** Secondary text rendered after the label. */
  readonly description?: string;
  /**
   * Explicit icon class for items whose section has no static per-kind icon
   * (author-declared entity items; the `entities/types.yaml` leaf). Built-in
   * section items leave this undefined and use the label provider's static map.
   */
  readonly iconClass?: string;
  /**
   * When set and {@link materialUri} does not yet exist on disk, the tree widget
   * seeds the file with this content before opening it — used by the
   * `entities/types.yaml` leaf so clicking it always lands in a real editor.
   */
  readonly createSeed?: string;
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

export namespace AuthorMaterialsSectionGroupTreeNode {
  export function is(node: unknown): node is AuthorMaterialsSectionGroupTreeNode {
    return typeof node === 'object' && node !== null
      && (node as { nodeType?: unknown }).nodeType === 'section-group';
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
