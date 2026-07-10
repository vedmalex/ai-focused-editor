import { Event } from '@theia/core/lib/common/event';
import { injectable } from '@theia/core/shared/inversify';
import type {
  DidChangeLabelEvent,
  LabelProviderContribution
} from '@theia/core/lib/browser/label-provider';
import type { AuthorMaterialsSectionKind } from '../common/author-materials';
import {
  AuthorMaterialFolderTreeNode,
  AuthorMaterialsSectionGroupTreeNode,
  AuthorMaterialsSectionTreeNode,
  AuthorMaterialTreeNode,
  ManuscriptTreeNode
} from './manuscript-tree';

/**
 * Icon theme for the author navigator: codicons (shipped with the Theia/Monaco
 * font) with a per-kind accent color applied through the afe-ico-* classes in
 * style/index.css — so the tree reads at a glance and follows the theme.
 */
const SECTION_ICONS: Record<AuthorMaterialsSectionKind, string> = {
  manuscript: 'codicon codicon-book afe-ico-manuscript',
  characters: 'codicon codicon-account afe-ico-characters',
  terms: 'codicon codicon-symbol-key afe-ico-terms',
  artifacts: 'codicon codicon-package afe-ico-artifacts',
  locations: 'codicon codicon-location afe-ico-locations',
  citations: 'codicon codicon-quote afe-ico-citations',
  sources: 'codicon codicon-library afe-ico-sources',
  knowledge: 'codicon codicon-lightbulb afe-ico-knowledge'
};

/**
 * The entities group node: a globe (the story's "world") in a neutral tint so
 * it reads as a structural container next to the colored child sections.
 */
const ENTITY_GROUP_ICON = 'codicon codicon-globe afe-ico-entities';

const MATERIAL_ICONS: Record<AuthorMaterialsSectionKind, string> = {
  manuscript: 'codicon codicon-file afe-ico-manuscript',
  characters: 'codicon codicon-person afe-ico-characters',
  terms: 'codicon codicon-symbol-string afe-ico-terms',
  artifacts: 'codicon codicon-symbol-misc afe-ico-artifacts',
  locations: 'codicon codicon-milestone afe-ico-locations',
  citations: 'codicon codicon-bookmark afe-ico-citations',
  sources: 'codicon codicon-file afe-ico-sources',
  knowledge: 'codicon codicon-note afe-ico-knowledge'
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
      return SECTION_ICONS[element.sectionKind];
    }
    if (AuthorMaterialFolderTreeNode.is(element)) {
      return `codicon codicon-folder afe-ico-${element.sectionKind}`;
    }
    if (AuthorMaterialTreeNode.is(element)) {
      return this.materialIcon(element);
    }
    return undefined;
  }

  /** Sources/knowledge files pick their icon by file type. */
  protected materialIcon(element: AuthorMaterialTreeNode): string {
    if (element.sectionKind === 'sources' || element.sectionKind === 'knowledge') {
      const lower = element.name?.toLowerCase() ?? '';
      const accent = `afe-ico-${element.sectionKind}`;
      if (lower.endsWith('.md') || lower.endsWith('.markdown')) {
        return `codicon codicon-markdown ${accent}`;
      }
      if (lower.endsWith('.pdf')) {
        return `codicon codicon-file-pdf ${accent}`;
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
