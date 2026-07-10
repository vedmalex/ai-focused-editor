import { injectable } from '@theia/core/shared/inversify';
import { Emitter } from '@theia/core/lib/common/event';
import {
  Disposable,
  DisposableCollection
} from '@theia/core/lib/common/disposable';
import type { MaybePromise } from '@theia/core/lib/common/types';
import URI from '@theia/core/lib/common/uri';
import type {
  IconTheme,
  IconThemeService
} from '@theia/core/lib/browser/icon-theme-service';
import type { IconThemeContribution } from '@theia/core/lib/browser/icon-theme-contribution';
import {
  DidChangeLabelEvent,
  LabelProviderContribution,
  URIIconReference
} from '@theia/core/lib/browser/label-provider';
import { FileStat } from '@theia/filesystem/lib/common/files';

/** Root class toggled on `document.body` while this icon theme is active. */
export const WRITER_ICONS_ROOT_CLASS = 'afe-writer-icons';

/**
 * Priority returned from {@link WriterIconThemeContribution.canHandle} for the
 * file/URI elements we style. It sits above Theia's default file-icon provider
 * (`WorkspaceUriLabelProviderContribution`, priority 10) so our codicons win in
 * the Files navigator, editor tabs, open-editors and search results — but below
 * the manuscript tree label provider (priority 1000) so the author navigator's
 * own `afe-ico-*` icons keep winning for manuscript/section nodes.
 */
const WRITER_ICONS_PRIORITY = 500;

const FILE_ICON = 'codicon codicon-file';
const FOLDER_ICON = 'codicon codicon-folder afe-writer-folder';

interface IconRule {
  readonly extensions: readonly string[];
  readonly icon: string;
}

/**
 * Extension → codicon mapping tuned for a writing workspace. Each icon carries
 * an `afe-writer-*` accent class coloured in `style/index.css` (theme-aware via
 * Theia chart colour variables), consistent with the `afe-ico-*` tree palette.
 */
const ICON_RULES: readonly IconRule[] = [
  { extensions: ['.md', '.markdown'], icon: 'codicon codicon-markdown afe-writer-md' },
  { extensions: ['.yaml', '.yml'], icon: 'codicon codicon-json afe-writer-yaml' },
  { extensions: ['.json', '.jsonl'], icon: 'codicon codicon-json afe-writer-json' },
  {
    extensions: ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.tif', '.tiff', '.bmp', '.ico'],
    icon: 'codicon codicon-file-media afe-writer-image'
  },
  { extensions: ['.pdf'], icon: 'codicon codicon-file-pdf afe-writer-pdf' },
  { extensions: ['.epub'], icon: 'codicon codicon-book afe-writer-epub' },
  { extensions: ['.html', '.htm'], icon: 'codicon codicon-code afe-writer-html' },
  { extensions: ['.txt'], icon: 'codicon codicon-file afe-writer-txt' }
];

/**
 * A codicon-based file icon theme for the whole workbench, tuned for authoring.
 *
 * It follows the same shape as Theia's built-in {@link NoneIconTheme}: it is at
 * once an {@link IconTheme} (selectable via *File Icon Theme*), an
 * {@link IconThemeContribution} (self-registers with the {@link IconThemeService}),
 * and a {@link LabelProviderContribution} that only resolves icons while the
 * theme is the active one. When active it adds the {@link WRITER_ICONS_ROOT_CLASS}
 * body class so the accent colours in `style/index.css` apply.
 */
@injectable()
export class WriterIconThemeContribution
implements IconTheme, IconThemeContribution, LabelProviderContribution {
  readonly id = 'afe-writer-icons';
  readonly label = 'Writer Icons (AI Focused Editor)';
  readonly description = 'Codicon file icons tuned for a writing workspace.';
  readonly hasFileIcons = true;
  readonly hasFolderIcons = true;

  protected readonly onDidChangeEmitter = new Emitter<DidChangeLabelEvent>();
  readonly onDidChange = this.onDidChangeEmitter.event;
  protected readonly toDeactivate = new DisposableCollection();

  registerIconThemes(iconThemes: IconThemeService): MaybePromise<void> {
    iconThemes.register(this);
  }

  activate(): Disposable {
    if (this.toDeactivate.disposed) {
      const { classList } = document.body;
      classList.add(WRITER_ICONS_ROOT_CLASS);
      this.toDeactivate.push(Disposable.create(() => {
        classList.remove(WRITER_ICONS_ROOT_CLASS);
        this.fireDidChange();
      }));
      this.fireDidChange();
    }
    return this.toDeactivate;
  }

  protected fireDidChange(): void {
    this.onDidChangeEmitter.fire({ affects: () => true });
  }

  canHandle(element: object): number {
    if (this.toDeactivate.disposed) {
      return 0;
    }
    if (FileStat.is(element)
      || URIIconReference.is(element)
      || (element instanceof URI && element.scheme === 'file')) {
      return WRITER_ICONS_PRIORITY;
    }
    return 0;
  }

  getIcon(element: object): string | undefined {
    if (URIIconReference.is(element)) {
      if (element.id === 'folder') {
        return FOLDER_ICON;
      }
      return element.uri ? this.fileIcon(element.uri) : FILE_ICON;
    }
    if (FileStat.is(element)) {
      return element.isDirectory ? FOLDER_ICON : this.fileIcon(element.resource);
    }
    if (element instanceof URI) {
      return this.fileIcon(element);
    }
    return undefined;
  }

  protected fileIcon(uri: URI): string {
    const name = uri.path.base.toLowerCase();
    for (const rule of ICON_RULES) {
      if (rule.extensions.some(ext => name.endsWith(ext))) {
        return rule.icon;
      }
    }
    return FILE_ICON;
  }
}
