import { Event } from '@theia/core/lib/common/event';
import { injectable } from '@theia/core/shared/inversify';
import type {
  DidChangeLabelEvent,
  LabelProviderContribution
} from '@theia/core/lib/browser/label-provider';
import type { AuthorMaterialsSectionKind } from '../common/author-materials';
import {
  AuthorMaterialsSectionTreeNode,
  AuthorMaterialTreeNode,
  ManuscriptTreeNode
} from './manuscript-tree';

/** Font Awesome 4 icons for section headers, consistent with `fa fa-book`. */
const SECTION_ICONS: Record<AuthorMaterialsSectionKind, string> = {
  manuscript: 'fa fa-book',
  characters: 'fa fa-user',
  terms: 'fa fa-tag',
  artifacts: 'fa fa-cube',
  locations: 'fa fa-map-marker',
  citations: 'fa fa-quote-right',
  sources: 'fa fa-archive',
  knowledge: 'fa fa-lightbulb-o'
};

/** Leaf icons per material kind. */
const MATERIAL_ICONS: Record<AuthorMaterialsSectionKind, string> = {
  manuscript: 'fa fa-file-text-o',
  characters: 'fa fa-user-o',
  terms: 'fa fa-tag',
  artifacts: 'fa fa-cube',
  locations: 'fa fa-map-marker',
  citations: 'fa fa-bookmark',
  sources: 'fa fa-file-o',
  knowledge: 'fa fa-lightbulb-o'
};

@injectable()
export class ManuscriptTreeLabelProvider implements LabelProviderContribution {
  readonly onDidChange = Event.None;

  canHandle(element: object): number {
    return ManuscriptTreeNode.is(element)
      || AuthorMaterialsSectionTreeNode.is(element)
      || AuthorMaterialTreeNode.is(element)
      ? 1000
      : 0;
  }

  getIcon(element: object): string | undefined {
    if (ManuscriptTreeNode.isFolder(element)) {
      return 'fa fa-folder';
    }
    if (ManuscriptTreeNode.isFile(element)) {
      return 'fa fa-file-text-o';
    }
    if (AuthorMaterialsSectionTreeNode.is(element)) {
      return SECTION_ICONS[element.sectionKind];
    }
    if (AuthorMaterialTreeNode.is(element)) {
      return MATERIAL_ICONS[element.sectionKind];
    }
    return undefined;
  }

  getName(element: object): string | undefined {
    if (ManuscriptTreeNode.is(element)) {
      return element.manuscript.name;
    }
    if (AuthorMaterialsSectionTreeNode.is(element) || AuthorMaterialTreeNode.is(element)) {
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
    if (AuthorMaterialsSectionTreeNode.is(element)) {
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
      || AuthorMaterialsSectionTreeNode.is(element)
      || AuthorMaterialTreeNode.is(element))
      && event.affects(element);
  }
}
