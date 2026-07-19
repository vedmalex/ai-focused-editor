import { Event } from '@theia/core/lib/common/event';
import { injectable } from '@theia/core/shared/inversify';
import type {
  DidChangeLabelEvent,
  LabelProviderContribution
} from '@theia/core/lib/browser/label-provider';
import { BASE_ENTITY_TYPES } from '../common/entity-type-registry';
import {
  AuthorMaterialFolderTreeNode,
  AuthorMaterialsSectionGroupTreeNode,
  AuthorMaterialsSectionTreeNode,
  AuthorMaterialTreeNode,
  ManuscriptTreeNode
} from './manuscript-tree';

/**
 * Icons for the four narrative-entity sections, derived from the single-source
 * registry so the codicon + `afe-ico-*` accent stay in one place. Section
 * headers use each type's `sectionIcon`; tree items use its `icon`. Both classes
 * are byte-identical to the previous inline literals.
 */
const ENTITY_SECTION_ICONS: Record<string, string> = Object.fromEntries(
  BASE_ENTITY_TYPES.map(type => [type.sectionKind, `${type.sectionIcon} ${type.accentClass}`])
);
const ENTITY_MATERIAL_ICONS: Record<string, string> = Object.fromEntries(
  BASE_ENTITY_TYPES.map(type => [type.sectionKind, `${type.icon} ${type.accentClass}`])
);

/**
 * Icon theme for the author navigator: codicons (shipped with the Theia/Monaco
 * font) with a per-kind accent color applied through the afe-ico-* classes in
 * style/index.css — so the tree reads at a glance and follows the theme.
 */
const SECTION_ICONS: Record<string, string> = {
  manuscript: 'codicon codicon-book afe-ico-manuscript',
  ...ENTITY_SECTION_ICONS,
  citations: 'codicon codicon-quote afe-ico-citations',
  sources: 'codicon codicon-library afe-ico-sources',
  knowledge: 'codicon codicon-lightbulb afe-ico-knowledge',
  skills: 'codicon codicon-mortar-board afe-ico-skills',
  proofreading: 'codicon codicon-checklist afe-ico-proofreading',
  transcription: 'codicon codicon-mic afe-ico-transcription'
};

/**
 * The entities group node: a globe (the story's "world") in a neutral tint so
 * it reads as a structural container next to the colored child sections.
 */
const ENTITY_GROUP_ICON = 'codicon codicon-globe afe-ico-entities';

const MATERIAL_ICONS: Record<string, string> = {
  manuscript: 'codicon codicon-file afe-ico-manuscript',
  ...ENTITY_MATERIAL_ICONS,
  citations: 'codicon codicon-bookmark afe-ico-citations',
  sources: 'codicon codicon-file afe-ico-sources',
  knowledge: 'codicon codicon-note afe-ico-knowledge',
  skills: 'codicon codicon-mortar-board afe-ico-skills',
  proofreading: 'codicon codicon-checklist afe-ico-proofreading',
  transcription: 'codicon codicon-mic afe-ico-transcription'
};

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.tif', '.tiff', '.bmp'];
const STRUCTURED_EXTENSIONS = ['.yaml', '.yml', '.json', '.jsonl'];

@injectable()
export class ManuscriptTreeLabelProvider implements LabelProviderContribution {
  readonly onDidChange = Event.None;

  canHandle(element: object): number {
    return ManuscriptTreeNode.is(element)
      || AuthorMaterialsSectionGroupTreeNode.is(element)
      || AuthorMaterialsSectionTreeNode.is(element)
      || AuthorMaterialTreeNode.is(element)
      || AuthorMaterialFolderTreeNode.is(element)
      ? 1000
      : 0;
  }

  getIcon(element: object): string | undefined {
    if (ManuscriptTreeNode.isFolder(element)) {
      return 'codicon codicon-folder afe-ico-manuscript';
    }
    if (ManuscriptTreeNode.isFile(element)) {
      return 'codicon codicon-book afe-ico-manuscript';
    }
    if (AuthorMaterialsSectionGroupTreeNode.is(element)) {
      return ENTITY_GROUP_ICON;
    }
    if (AuthorMaterialsSectionTreeNode.is(element)) {
      // Author-declared entity sections carry their own icon class; built-in
      // sections fall back to the static per-kind map.
      return element.iconClass ?? SECTION_ICONS[element.sectionKind];
    }
    if (AuthorMaterialFolderTreeNode.is(element)) {
      return `codicon codicon-folder afe-ico-${element.sectionKind}`;
    }
    if (AuthorMaterialTreeNode.is(element)) {
      // Explicit per-node icon (author entity items, the types.yaml leaf) wins;
      // otherwise pick by section kind / file type.
      return element.iconClass ?? this.materialIcon(element);
    }
    return undefined;
  }

  /** Sources/knowledge files pick their icon by file type. */
  protected materialIcon(element: AuthorMaterialTreeNode): string | undefined {
    if (element.sectionKind === 'sources' || element.sectionKind === 'knowledge') {
      const lower = element.name?.toLowerCase() ?? '';
      const accent = `afe-ico-${element.sectionKind}`;
      if (lower.endsWith('.md') || lower.endsWith('.markdown')) {
        return `codicon codicon-markdown ${accent}`;
      }
      if (lower.endsWith('.pdf')) {
        return `codicon codicon-file-pdf ${accent}`;
      }
      if (lower.endsWith('.docx') || lower.endsWith('.doc') || lower.endsWith('.odt') || lower.endsWith('.rtf')) {
        return `codicon codicon-file-text ${accent}`;
      }
      if (lower.endsWith('.xlsx') || lower.endsWith('.xls') || lower.endsWith('.ods')) {
        return `codicon codicon-table ${accent}`;
      }
      if (lower.endsWith('.pptx') || lower.endsWith('.ppt')) {
        return `codicon codicon-preview ${accent}`;
      }
      if (lower.endsWith('.excalidraw')) {
        return `codicon codicon-pencil ${accent}`;
      }
      if (IMAGE_EXTENSIONS.some(ext => lower.endsWith(ext))) {
        return `codicon codicon-file-media ${accent}`;
      }
      if (STRUCTURED_EXTENSIONS.some(ext => lower.endsWith(ext))) {
        return `codicon codicon-json ${accent}`;
      }
      return `codicon codicon-file ${accent}`;
    }
    return MATERIAL_ICONS[element.sectionKind];
  }

  getName(element: object): string | undefined {
    if (ManuscriptTreeNode.is(element)) {
      return element.manuscript.name;
    }
    if (AuthorMaterialsSectionGroupTreeNode.is(element)
      || AuthorMaterialsSectionTreeNode.is(element)
      || AuthorMaterialTreeNode.is(element)
      || AuthorMaterialFolderTreeNode.is(element)) {
      return element.name;
    }
    return undefined;
  }

  getLongName(element: object): string | undefined {
    if (ManuscriptTreeNode.is(element)) {
      return element.manuscript.path;
    }
    if (AuthorMaterialTreeNode.is(element)) {
      return element.description ?? element.name;
    }
    if (AuthorMaterialsSectionGroupTreeNode.is(element)
      || AuthorMaterialsSectionTreeNode.is(element)
      || AuthorMaterialFolderTreeNode.is(element)) {
      return element.name;
    }
    return undefined;
  }

  getDetails(element: object): string | undefined {
    if (AuthorMaterialTreeNode.is(element)) {
      return element.description;
    }
    if (!ManuscriptTreeNode.is(element) || element.manuscript.buildIncluded) {
      return undefined;
    }
    return 'excluded from build';
  }

  affects(element: object, event: DidChangeLabelEvent): boolean {
    return (ManuscriptTreeNode.is(element)
      || AuthorMaterialsSectionGroupTreeNode.is(element)
      || AuthorMaterialsSectionTreeNode.is(element)
      || AuthorMaterialTreeNode.is(element)
      || AuthorMaterialFolderTreeNode.is(element))
      && event.affects(element);
  }
}
