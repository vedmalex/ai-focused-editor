import { injectable } from '@theia/core/shared/inversify';
import { nls } from '@theia/core/lib/common/nls';
import { CompositeTreeNode } from '@theia/core/lib/browser/tree';
import type { ManuscriptNode } from '../common';
import {
  AuthorMaterialItem,
  AuthorMaterialsSection,
  AuthorMaterialsSectionKind
} from '../common/author-materials';
import {
  MANUSCRIPT_TREE_ROOT_ID,
  AUTHOR_MATERIALS_ENTITY_GROUP_KIND,
  AuthorMaterialFolderTreeNode,
  AuthorMaterialsSectionGroupTreeNode,
  AuthorMaterialsSectionTreeNode,
  AuthorMaterialTreeNode,
  ManuscriptFolderTreeNode,
  ManuscriptTreeNode,
  ManuscriptTreeRootNode
} from './manuscript-tree';

/**
 * English section-header defaults, kept byte-identical to the common
 * `SECTION_LABELS` so the default-locale UI (and the flow pack, which matches
 * section rows by text) is unchanged. Russian comes from
 * `i18n/ru/manuscript-tree.json` keyed by `.../section-<kind>`; localizing here
 * (the display point) keeps the Theia-free common section assembly — and its
 * bun tests asserting the English labels — untouched.
 */
const SECTION_LABEL_DEFAULTS: Record<AuthorMaterialsSectionKind, string> = {
  manuscript: 'Manuscript',
  characters: 'Characters',
  terms: 'Terms',
  artifacts: 'Artifacts',
  locations: 'Locations',
  citations: 'Citations',
  sources: 'Sources',
  knowledge: 'Knowledge',
  skills: 'Skills'
};

/** Entity sections nested under the single collapsible group node. */
const ENTITY_GROUP_KINDS: ReadonlySet<AuthorMaterialsSectionKind> = new Set([
  'characters',
  'terms',
  'artifacts',
  'locations'
]);

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

    // Nest the entity sections under one collapsible group node (mirroring the
    // `entities/` folder) so the top level reads Manuscript / <Entities> /
    // Citations / Sources / Knowledge. The group sits where the first entity
    // section would have gone; every non-entity section stays top-level.
    const entityCount = sections
      .filter(section => ENTITY_GROUP_KINDS.has(section.kind))
      .reduce((sum, section) => sum + section.count, 0);
    let entityGroup: AuthorMaterialsSectionGroupTreeNode | undefined;

    for (const section of sections) {
      if (ENTITY_GROUP_KINDS.has(section.kind)) {
        if (!entityGroup) {
          entityGroup = this.createEntityGroupNode(entityCount);
          CompositeTreeNode.addChild(root, entityGroup);
        }
        CompositeTreeNode.addChild(entityGroup, this.createSectionNode(section, manuscriptContent));
      } else {
        CompositeTreeNode.addChild(root, this.createSectionNode(section, manuscriptContent));
      }
    }

    return root;
  }

  /**
   * The entities group node: expanded by default, selectable, composite. It
   * carries no `manuscript` field so the manuscript DnD guards ignore it, and a
   * `groupKind` discriminator so it maps to the `entities` context-key value.
   */
  protected createEntityGroupNode(count: number): AuthorMaterialsSectionGroupTreeNode {
    const label = nls.localize('ai-focused-editor/manuscript-tree/section-entities', 'Entities');
    return {
      id: `section-group:${AUTHOR_MATERIALS_ENTITY_GROUP_KIND}`,
      name: `${label} (${count})`,
      parent: undefined,
      nodeType: 'section-group',
      groupKind: AUTHOR_MATERIALS_ENTITY_GROUP_KIND,
      selected: false,
      expanded: true,
      children: []
    };
  }

  protected createSectionNode(
    section: AuthorMaterialsSection,
    manuscriptContent: ManuscriptNode[]
  ): AuthorMaterialsSectionTreeNode {
    const sectionNode: AuthorMaterialsSectionTreeNode = {
      id: `section:${section.kind}`,
      name: this.sectionDisplayName(section),
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

  /**
   * Localized section header with the count suffix, e.g. `Characters (3)` /
   * `Персонажи (3)`. English defaults stay byte-identical to the common
   * `formatSectionLabel` output so the default locale is unchanged.
   */
  protected sectionDisplayName(section: AuthorMaterialsSection): string {
    const label = nls.localize(
      `ai-focused-editor/manuscript-tree/section-${section.kind}`,
      SECTION_LABEL_DEFAULTS[section.kind]
    );
    return `${label} (${section.count})`;
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
  ): AuthorMaterialTreeNode | AuthorMaterialFolderTreeNode {
    if (item.itemType === 'folder') {
      const folder: AuthorMaterialFolderTreeNode = {
        id: `material-folder:${sectionKind}:${item.id}`,
        name: item.label,
        parent: undefined,
        nodeType: 'material-folder',
        sectionKind,
        selected: false,
        expanded: false,
        children: []
      };
      for (const child of item.children ?? []) {
        CompositeTreeNode.addChild(folder, this.createMaterialNode(sectionKind, child));
      }
      return folder;
    }
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
