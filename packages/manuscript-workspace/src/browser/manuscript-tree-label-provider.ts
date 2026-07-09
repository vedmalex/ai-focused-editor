import { Event } from '@theia/core/lib/common/event';
import { injectable } from '@theia/core/shared/inversify';
import type {
  DidChangeLabelEvent,
  LabelProviderContribution
} from '@theia/core/lib/browser/label-provider';
import { ManuscriptTreeNode } from './manuscript-tree';

@injectable()
export class ManuscriptTreeLabelProvider implements LabelProviderContribution {
  readonly onDidChange = Event.None;

  canHandle(element: object): number {
    return ManuscriptTreeNode.is(element) ? 1000 : 0;
  }

  getIcon(element: object): string | undefined {
    if (ManuscriptTreeNode.isFolder(element)) {
      return 'fa fa-folder';
    }
    if (ManuscriptTreeNode.isFile(element)) {
      return 'fa fa-file-text-o';
    }
    return undefined;
  }

  getName(element: object): string | undefined {
    return ManuscriptTreeNode.is(element) ? element.manuscript.name : undefined;
  }

  getLongName(element: object): string | undefined {
    return ManuscriptTreeNode.is(element) ? element.manuscript.path : undefined;
  }

  getDetails(element: object): string | undefined {
    if (!ManuscriptTreeNode.is(element) || element.manuscript.buildIncluded) {
      return undefined;
    }
    return 'excluded from build';
  }

  affects(element: object, event: DidChangeLabelEvent): boolean {
    return ManuscriptTreeNode.is(element) && event.affects(element);
  }
}
