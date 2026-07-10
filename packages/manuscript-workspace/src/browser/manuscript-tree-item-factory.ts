import { injectable } from '@theia/core/shared/inversify';
import { CompositeTreeNode } from '@theia/core/lib/browser/tree';
import type { ManuscriptNode } from '../common';
import {
  AuthorMaterialItem,
  AuthorMaterialsSection,
  AuthorMaterialsSectionKind,
  formatSectionLabel
} from '../common/author-materials';
import {
  MANUSCRIPT_TREE_ROOT_ID,
  AuthorMaterialsSectionTreeNode,
  AuthorMaterialTreeNode,
  ManuscriptFolderTreeNode,
  ManuscriptTreeNode,
  ManuscriptTreeRootNode
} from './manuscript-tree';

@injectable()
export class ManuscriptTreeItemFactory {
  /**
   * Build the navigator root: one composite node per section, in the order
   * provided. The manuscript section is populated from live manifest nodes
   * (keeping DnD/move behavior intact); every other section holds material
   * leaf nodes derived from {@link AuthorMaterialsSection.items}.
   */
  createRoot(sections: AuthorMaterialsSection[], manuscriptContent: ManuscriptNode[]): ManuscriptTreeRootNode {
    const root: ManuscriptTreeRootNode = {
      id: MANUSCRIPT_TREE_ROOT_ID,
      name: 'Manuscript',
      parent: undefined,
      visible: false,
      children: []
    };

    for (const section of sections) {
      CompositeTreeNode.addChild(root, this.createSectionNode(section, manuscriptContent));
    }

    return root;
  }

  protected createSectionNode(
    section: AuthorMaterialsSection,
    manuscriptContent: ManuscriptNode[]
  ): AuthorMaterialsSectionTreeNode {
    const sectionNode: AuthorMaterialsSectionTreeNode = {
      id: `section:${section.kind}`,
      name: formatSectionLabel(section),
      parent: undefined,
      nodeType: 'section',
      sectionKind: section.kind,
      selected: false,
      expanded: section.expandedByDefault,
      children: []
    };

    if (section.kind === 'manuscript') {
      for (const node of this.sortNodes(manuscriptContent)) {
        CompositeTreeNode.addChild(sectionNode, this.createManuscriptNode(node));
      }
    } else {
      for (const item of section.items) {
        CompositeTreeNode.addChild(sectionNode, this.createMaterialNode(section.kind, item));
      }
    }

    return sectionNode;
  }

  protected createManuscriptNode(manuscript: ManuscriptNode): ManuscriptTreeNode {
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
        CompositeTreeNode.addChild(folder, this.createManuscriptNode(child));
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

  protected createMaterialNode(
    sectionKind: AuthorMaterialsSectionKind,
    item: AuthorMaterialItem
  ): AuthorMaterialTreeNode {
    return {
      id: `material:${sectionKind}:${item.id}`,
      name: item.label,
      parent: undefined,
      nodeType: 'material',
      sectionKind,
      materialUri: item.uri,
      description: item.description,
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
