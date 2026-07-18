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
const SECTION_LABEL_DEFAULTS: Record<string, string> = {
  manuscript: 'Manuscript',
  characters: 'Characters',
  terms: 'Terms',
  artifacts: 'Artifacts',
  locations: 'Locations',
  citations: 'Citations',
  sources: 'Sources',
  knowledge: 'Knowledge',
  skills: 'Skills',
  proofreading: 'Proofreading'
};

/**
 * Options for {@link ManuscriptTreeItemFactory.createRoot}. `typesYamlUri`, when
 * present (a workspace is open), surfaces an `entities/types.yaml` leaf under the
 * entities group so authors can find + edit their entity-type declarations.
 */
export interface CreateRootOptions {
  typesYamlUri?: string;
}

/**
 * Seed written into `entities/types.yaml` the first time the types leaf is opened
 * on a book that has none — a commented example plus an empty `types: []` list so
 * the file parses cleanly and shows authors the declaration shape.
 */
const TYPES_YAML_SEED = [
  '# Custom entity types for this book.',
  '# Each entry adds a type alongside the built-ins (character, term, artifact, location).',
  '#',
  '# - id: faction          # kebab-case, unique; also the default tagKind + directory',
  '#   label: Faction        # shown verbatim in the navigator (your language)',
  '#   icon: codicon codicon-organization   # optional; a codicon class',
  '#   # tagKind: faction    # optional; [[tagKind:id]] token kind (defaults to id)',
  '#   # directory: factions # optional; entities/<directory>/ (defaults to id)',
  '#   # fields:             # optional custom form schema (defaults to a sensible set)',
  '#   #   - { name: name, kind: text, role: label }',
  '#   #   - { name: summary, kind: textarea }',
  '',
  'types: []',
  ''
].join('\n');

/**
 * Compose a codicon class with its optional `afe-ico-*` accent, matching the
 * `${icon} ${accentClass}` shape the label provider's static maps produce for
 * built-in types (so author sections read identically to built-in ones).
 */
function iconClassOf(icon: string, accentClass?: string): string {
  return accentClass ? `${icon} ${accentClass}` : icon;
}

@injectable()
export class ManuscriptTreeItemFactory {
  /**
   * Build the navigator root: one composite node per section, in the order
   * provided. The manuscript section is populated from live manifest nodes
   * (keeping DnD/move behavior intact); every other section holds material
   * leaf nodes derived from {@link AuthorMaterialsSection.items}.
   */
  createRoot(
    sections: AuthorMaterialsSection[],
    manuscriptContent: ManuscriptNode[],
    options: CreateRootOptions = {}
  ): ManuscriptTreeRootNode {
    const root: ManuscriptTreeRootNode = {
      id: MANUSCRIPT_TREE_ROOT_ID,
      name: 'Manuscript',
      parent: undefined,
      visible: false,
      children: []
    };

    // Nest the entity sections under one collapsible group node (mirroring the
    // `entities/` folder) so the top level reads Manuscript / <Entities> /
    // Citations / Sources / Knowledge. Entity sections (built-in AND author) are
    // exactly the ones carrying an `entityType` descriptor; every other section
    // stays top-level. The group sits where the first entity section would go.
    const entityCount = sections
      .filter(section => section.entityType)
      .reduce((sum, section) => sum + section.count, 0);
    let entityGroup: AuthorMaterialsSectionGroupTreeNode | undefined;

    for (const section of sections) {
      if (section.entityType) {
        if (!entityGroup) {
          entityGroup = this.createEntityGroupNode(entityCount);
          CompositeTreeNode.addChild(root, entityGroup);
        }
        CompositeTreeNode.addChild(entityGroup, this.createSectionNode(section, manuscriptContent));
      } else {
        CompositeTreeNode.addChild(root, this.createSectionNode(section, manuscriptContent));
      }
    }

    // Surface the entity-type declarations file as the last leaf under the group.
    if (entityGroup && options.typesYamlUri) {
      CompositeTreeNode.addChild(entityGroup, this.createTypesLeafNode(options.typesYamlUri));
    }

    return root;
  }

  /**
   * The `entities/types.yaml` leaf under the entities group: opens the author's
   * entity-type declarations (seeded on first open when the file is missing).
   */
  protected createTypesLeafNode(typesYamlUri: string): AuthorMaterialTreeNode {
    const label = nls.localize('ai-focused-editor/manuscript-tree/entity-types', 'Entity Types');
    return {
      id: `material:${AUTHOR_MATERIALS_ENTITY_GROUP_KIND}:types`,
      name: label,
      parent: undefined,
      nodeType: 'material',
      sectionKind: AUTHOR_MATERIALS_ENTITY_GROUP_KIND,
      materialUri: typesYamlUri,
      description: 'entities/types.yaml',
      iconClass: 'codicon codicon-symbol-namespace afe-ico-entities',
      createSeed: TYPES_YAML_SEED,
      selected: false
    };
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
    // Author-declared entity sections carry explicit icon classes (built-in
    // sections stay undefined and use the label provider's static per-kind map,
    // so the default locale/icons are byte-identical).
    const authorType = section.entityType?.origin === 'book' ? section.entityType : undefined;
    const sectionNode: AuthorMaterialsSectionTreeNode = {
      id: `section:${section.kind}`,
      name: this.sectionDisplayName(section),
      parent: undefined,
      nodeType: 'section',
      sectionKind: section.kind,
      selected: false,
      expanded: section.expandedByDefault,
      children: [],
      ...(authorType ? { iconClass: iconClassOf(authorType.sectionIcon, authorType.accentClass) } : {})
    };

    if (section.kind === 'manuscript') {
      for (const node of this.sortNodes(manuscriptContent)) {
        CompositeTreeNode.addChild(sectionNode, this.createManuscriptNode(node));
      }
    } else {
      const materialIconClass = authorType
        ? iconClassOf(authorType.icon, authorType.accentClass)
        : undefined;
      for (const item of section.items) {
        CompositeTreeNode.addChild(sectionNode, this.createMaterialNode(section.kind, item, materialIconClass));
      }
    }

    return sectionNode;
  }

  /**
   * Section header with the count suffix, e.g. `Characters (3)` / `Персонажи (3)`.
   * Built-in sections go through the i18n path (English default byte-identical to
   * the common `formatSectionLabel`); author-declared sections use their label
   * VERBATIM — it is the author's own language and is never localized.
   */
  protected sectionDisplayName(section: AuthorMaterialsSection): string {
    if (section.entityType?.origin === 'book') {
      return `${section.label} (${section.count})`;
    }
    const label = nls.localize(
      `ai-focused-editor/manuscript-tree/section-${section.kind}`,
      SECTION_LABEL_DEFAULTS[section.kind] ?? section.label
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
    item: AuthorMaterialItem,
    iconClass?: string
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
        CompositeTreeNode.addChild(folder, this.createMaterialNode(sectionKind, child, iconClass));
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
      selected: false,
      ...(iconClass ? { iconClass } : {})
    };
  }

  protected sortNodes(nodes: ManuscriptNode[]): ManuscriptNode[] {
    return [...nodes].sort((left, right) => {
      const byOrder = left.order - right.order;
      return byOrder === 0 ? left.name.localeCompare(right.name) : byOrder;
    });
  }
}
