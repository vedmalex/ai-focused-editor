import { Command, MessageService } from '@theia/core/lib/common';
import { CommandRegistry } from '@theia/core/lib/common/command';
import { PreferenceScope, PreferenceService } from '@theia/core/lib/common/preferences';
import { LabelProvider } from '@theia/core/lib/browser';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { FileDialogService } from '@theia/filesystem/lib/browser';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import URI from '@theia/core/lib/common/uri';
import { nls } from '@theia/core/lib/common/nls';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { WorkspaceCommands } from '@theia/workspace/lib/browser';
import {
  inject,
  injectable,
  postConstruct
} from '@theia/core/shared/inversify';
import React from '@theia/core/shared/react';
import { parse } from 'yaml';
import {
  BookCatalogEntry,
  buildBookCatalog,
  RawBookCandidate
} from '../common/book-catalog';
import {
  AI_FOCUSED_EDITOR_LIBRARY_PATH,
  AI_FOCUSED_EDITOR_WELCOME_SHOW_ON_STARTUP
} from './ai-focused-editor-preferences';

/**
 * Commands surfaced by the welcome page. Defined here (not in the frontend
 * module) so the widget can reference the ids it invokes without importing the
 * module that binds it — keeping the module → widget dependency one-directional.
 * The `WelcomeContribution` in `welcome-frontend-module.ts` registers them.
 */
export namespace WelcomeCommands {
  /** Open/reveal the welcome page as the active main tab. */
  export const OPEN: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.welcome.open',
      category: 'AI Focused Editor',
      label: 'Welcome'
    },
    'ai-focused-editor/welcome/open',
    'ai-focused-editor/welcome/category'
  );

  /** Multi-step "New Book..." wizard that materializes a fresh book scaffold. */
  export const NEW_BOOK: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.book.newBook',
      category: 'AI Focused Editor',
      label: 'New Book...'
    },
    'ai-focused-editor/welcome/new-book',
    'ai-focused-editor/welcome/category'
  );
}

/**
 * Command id for the parallel "Book Doctor" contribution. Referenced as a bare
 * string (not imported) so the welcome page stays decoupled from that module;
 * the button is guarded with {@link CommandRegistry.getCommand} and only enabled
 * when the command is actually registered.
 */
const BOOK_DOCTOR_COMMAND_ID = 'ai-focused-editor.book.doctor';

/** Newest-first recent workspaces rendered in the Recent section. */
const MAX_RECENT = 5;

/**
 * How many directory levels below the configured library folder we scan for
 * books. `1` = the library's immediate subfolders; `2` also descends one level
 * further (e.g. `library/<author>/<book>`) for folders that are not themselves
 * books — we never descend into a folder that already holds a `manifest.yaml`.
 */
const LIBRARY_SCAN_DEPTH = 2;

/** Encode raw bytes as base64 without overflowing the call stack on big buffers. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }
  return btoa(binary);
}

/**
 * The AI Focused Editor welcome page: a writer-first landing surface shown on
 * startup when no files are open, and reachable any time from the Manuscript
 * menu. It offers the primary entry points (New Book wizard, Open Folder, Book
 * Doctor), a short list of recent workspaces, and a toggle for the
 * show-on-startup preference — all through core services, with no external
 * assets. Rendered as a singleton main-area {@link ReactWidget} bound by
 * `welcome-frontend-module.ts`.
 */
@injectable()
export class WelcomeWidget extends ReactWidget {
  static readonly ID = 'ai-focused-editor.welcome';
  static readonly LABEL = 'Welcome';

  @inject(CommandRegistry)
  protected readonly commandRegistry!: CommandRegistry;

  @inject(MessageService)
  protected readonly messages!: MessageService;

  @inject(PreferenceService)
  protected readonly preferenceService!: PreferenceService;

  @inject(WorkspaceService)
  protected readonly workspaceService!: WorkspaceService;

  @inject(LabelProvider)
  protected readonly labelProvider!: LabelProvider;

  @inject(FileService)
  protected readonly fileService!: FileService;

  @inject(FileDialogService)
  protected readonly fileDialogService!: FileDialogService;

  /** Newest-first recent workspace URIs, loaded asynchronously after construction. */
  protected recent: string[] = [];

  /** Books discovered under the configured library folder (sorted by title). */
  protected catalog: BookCatalogEntry[] = [];

  /** False until the first library scan settles (drives the "Scanning…" line). */
  protected catalogLoaded = false;

  @postConstruct()
  protected init(): void {
    this.id = WelcomeWidget.ID;
    this.title.label = nls.localize('ai-focused-editor/welcome/title-label', WelcomeWidget.LABEL);
    this.title.caption = nls.localize('ai-focused-editor/welcome/title-caption', 'AI Focused Editor — Welcome');
    this.title.iconClass = 'codicon codicon-book';
    this.title.closable = true;
    this.addClass('afe-welcome');

    this.toDispose.push(this.preferenceService.onPreferenceChanged(change => {
      if (change.preferenceName === AI_FOCUSED_EDITOR_WELCOME_SHOW_ON_STARTUP) {
        this.update();
      } else if (change.preferenceName === AI_FOCUSED_EDITOR_LIBRARY_PATH) {
        void this.loadCatalog();
      }
    }));

    void this.loadRecent();
    void this.loadCatalog();
    this.update();
  }

  protected async loadRecent(): Promise<void> {
    try {
      this.recent = await this.workspaceService.recentWorkspaces();
    } catch {
      this.recent = [];
    }
    this.update();
  }

  protected get showOnStartup(): boolean {
    return this.preferenceService.get<boolean>(AI_FOCUSED_EDITOR_WELCOME_SHOW_ON_STARTUP, true) !== false;
  }

  /** Configured library folder as a URI string, or '' when unset. */
  protected get libraryPath(): string {
    return (this.preferenceService.get<string>(AI_FOCUSED_EDITOR_LIBRARY_PATH, '') ?? '').trim();
  }

  /**
   * Scan the configured library folder for books and rebuild {@link catalog}.
   * A no-op-safe: an unset path clears the catalog; any scan error leaves an
   * empty catalog rather than throwing into React.
   */
  protected async loadCatalog(): Promise<void> {
    const configured = this.libraryPath;
    this.catalogLoaded = false;
    this.update();
    if (!configured) {
      this.catalog = [];
      this.catalogLoaded = true;
      this.update();
      return;
    }
    try {
      const candidates = await this.scanLibrary(new URI(configured), LIBRARY_SCAN_DEPTH);
      this.catalog = buildBookCatalog(candidates);
    } catch {
      this.catalog = [];
    }
    this.catalogLoaded = true;
    this.update();
  }

  /**
   * Walk up to {@link LIBRARY_SCAN_DEPTH} directory levels below `root`,
   * collecting every folder that directly contains a `manifest.yaml`. A book
   * folder is a leaf: we never descend into it, so a book's own subfolders can
   * never masquerade as books.
   */
  protected async scanLibrary(root: URI, maxDepth: number): Promise<RawBookCandidate[]> {
    const found: RawBookCandidate[] = [];
    const visit = async (dir: URI, depth: number): Promise<void> => {
      const stat = await this.fileService.resolve(dir).catch(() => undefined);
      if (!stat?.isDirectory || !stat.children) {
        return;
      }
      for (const child of stat.children) {
        if (!child.isDirectory) {
          continue;
        }
        if (await this.fileService.exists(child.resource.resolve('manifest.yaml'))) {
          found.push(await this.readCandidate(child.resource));
        } else if (depth < maxDepth) {
          await visit(child.resource, depth + 1);
        }
      }
    };
    await visit(root, 1);
    return found;
  }

  /**
   * Read a confirmed book folder's `metadata.yaml` (tolerant of a missing or
   * malformed file) and, when present, inline its `cover.png` as a base64
   * `data:` URI so the thumbnail renders in both browser and Electron without a
   * separate asset route.
   */
  protected async readCandidate(folder: URI): Promise<RawBookCandidate> {
    let metadata: unknown;
    try {
      const text = (await this.fileService.read(folder.resolve('metadata.yaml'))).value;
      metadata = parse(text);
    } catch {
      metadata = undefined;
    }
    let coverUri: string | undefined;
    const coverFile = folder.resolve('cover.png');
    try {
      if (await this.fileService.exists(coverFile)) {
        const bytes = (await this.fileService.readFile(coverFile)).value.buffer;
        coverUri = `data:image/png;base64,${bytesToBase64(bytes)}`;
      }
    } catch {
      coverUri = undefined;
    }
    return { path: folder.toString(), metadata, coverUri };
  }

  protected render(): React.ReactNode {
    return React.createElement(
      'div',
      { className: 'afe-welcome-body', tabIndex: -1 },
      this.renderHeader(),
      this.renderStart(),
      this.renderCatalog(),
      this.renderRecent(),
      this.renderFooter()
    );
  }

  protected renderHeader(): React.ReactNode {
    return React.createElement(
      'header',
      { className: 'afe-welcome-header' },
      React.createElement('h1', { className: 'afe-welcome-title' }, 'AI Focused Editor'),
      React.createElement(
        'p',
        { className: 'afe-welcome-tagline' },
        nls.localize(
          'ai-focused-editor/welcome/tagline',
          'A writer-first manuscript workspace: draft, structure, and publish your book.'
        )
      )
    );
  }

  protected renderStart(): React.ReactNode {
    // The Book Doctor command ships in a parallel module; only offer the button
    // when it is registered. Whether it is currently *enabled* (it needs an open
    // workspace) is checked at click time so a disabled command warns rather
    // than throwing NO_ACTIVE_HANDLER.
    const doctorRegistered = this.commandRegistry.getCommand(BOOK_DOCTOR_COMMAND_ID) !== undefined;
    return React.createElement(
      'section',
      { className: 'afe-welcome-section' },
      React.createElement(
        'h2',
        { className: 'afe-welcome-section-title' },
        nls.localize('ai-focused-editor/welcome/section-start', 'Start')
      ),
      React.createElement(
        'div',
        { className: 'afe-welcome-actions' },
        this.renderActionButton(
          'codicon codicon-new-file',
          nls.localize('ai-focused-editor/welcome/action-new-book-label', 'Create New Book...'),
          nls.localize(
            'ai-focused-editor/welcome/action-new-book-title',
            'Materialize a fresh book scaffold with the New Book wizard'
          ),
          () => this.runCommand(WelcomeCommands.NEW_BOOK.id),
          true
        ),
        this.renderActionButton(
          'codicon codicon-folder-opened',
          nls.localize('ai-focused-editor/welcome/action-open-folder-label', 'Open Folder...'),
          nls.localize(
            'ai-focused-editor/welcome/action-open-folder-title',
            'Open an existing book folder as the workspace'
          ),
          () => this.openFolder()
        ),
        this.renderActionButton(
          'codicon codicon-checklist',
          nls.localize('ai-focused-editor/welcome/action-book-doctor-label', 'Book Doctor...'),
          doctorRegistered
            ? nls.localize(
                'ai-focused-editor/welcome/action-book-doctor-title',
                'Inspect the current book and create any missing scaffold'
              )
            : nls.localize(
                'ai-focused-editor/welcome/action-book-doctor-unavailable',
                'Book Doctor is not available in this build'
              ),
          () => this.runBookDoctor(),
          false,
          !doctorRegistered
        )
      )
    );
  }

  protected renderActionButton(
    iconClass: string,
    label: string,
    title: string,
    onClick: () => void,
    primary = false,
    disabled = false
  ): React.ReactNode {
    return React.createElement(
      'button',
      {
        className: `theia-button afe-welcome-action${primary ? ' main' : ' secondary'}`,
        type: 'button',
        title,
        disabled,
        onClick
      },
      React.createElement('span', { className: `afe-welcome-action-icon ${iconClass}` }),
      React.createElement('span', undefined, label)
    );
  }

  /**
   * The "My Books" section, rendered ABOVE Recent. When no library folder is
   * configured it collapses to a one-line hint offering to pick one; once
   * configured it shows the scanned grid (or an empty-state / scanning line)
   * with a button to change the folder.
   */
  protected renderCatalog(): React.ReactNode {
    const title = nls.localize('ai-focused-editor/welcome/section-my-books', 'My Books');
    if (!this.libraryPath) {
      return React.createElement(
        'section',
        { className: 'afe-welcome-section afe-welcome-catalog afe-welcome-catalog-hint' },
        React.createElement('h2', { className: 'afe-welcome-section-title' }, title),
        React.createElement(
          'p',
          { className: 'afe-welcome-catalog-empty' },
          nls.localize(
            'ai-focused-editor/welcome/catalog-hint',
            'Point at a folder that holds your books to see them all here.'
          )
        ),
        this.renderPickFolderButton(
          nls.localize('ai-focused-editor/welcome/catalog-choose-folder', 'Choose books folder...')
        )
      );
    }
    return React.createElement(
      'section',
      { className: 'afe-welcome-section afe-welcome-catalog' },
      React.createElement(
        'div',
        { className: 'afe-welcome-catalog-head' },
        React.createElement('h2', { className: 'afe-welcome-section-title' }, title),
        this.renderPickFolderButton(
          nls.localize('ai-focused-editor/welcome/catalog-change-folder', 'Change folder...')
        )
      ),
      this.renderCatalogBody()
    );
  }

  protected renderCatalogBody(): React.ReactNode {
    if (!this.catalogLoaded) {
      return React.createElement(
        'p',
        { className: 'afe-welcome-catalog-empty' },
        nls.localize('ai-focused-editor/welcome/catalog-scanning', 'Scanning for books...')
      );
    }
    if (this.catalog.length === 0) {
      return React.createElement(
        'p',
        { className: 'afe-welcome-catalog-empty' },
        nls.localize(
          'ai-focused-editor/welcome/catalog-none',
          'No books found in this folder. Books are folders that contain a manifest.yaml.'
        )
      );
    }
    return React.createElement(
      'div',
      { className: 'afe-welcome-catalog-grid' },
      ...this.catalog.map(entry => this.renderBookCard(entry))
    );
  }

  protected renderBookCard(entry: BookCatalogEntry): React.ReactNode {
    const cover = entry.coverUri
      ? React.createElement('img', {
          className: 'afe-welcome-book-cover',
          src: entry.coverUri,
          alt: ''
        })
      : React.createElement('span', {
          className: 'afe-welcome-book-cover afe-welcome-book-cover-placeholder codicon codicon-book'
        });
    return React.createElement(
      'button',
      {
        key: entry.path,
        className: 'afe-welcome-book-card',
        type: 'button',
        title: nls.localize('ai-focused-editor/welcome/catalog-open-book', 'Open {0}', entry.title),
        onClick: () => this.openWorkspace(entry.path)
      },
      cover,
      React.createElement('span', { className: 'afe-welcome-book-title' }, entry.title),
      entry.author
        ? React.createElement('span', { className: 'afe-welcome-book-author' }, entry.author)
        : undefined
    );
  }

  protected renderPickFolderButton(label: string): React.ReactNode {
    return React.createElement(
      'button',
      {
        className: 'theia-button afe-welcome-action secondary afe-welcome-catalog-pick',
        type: 'button',
        onClick: () => this.chooseLibraryFolder()
      },
      React.createElement('span', { className: 'afe-welcome-action-icon codicon codicon-library' }),
      React.createElement('span', undefined, label)
    );
  }

  /** Folder picker that writes the chosen path to the library preference. */
  protected async chooseLibraryFolder(): Promise<void> {
    const startFolder = this.workspaceService.tryGetRoots()[0];
    const selection = await this.fileDialogService.showOpenDialog(
      {
        title: nls.localize(
          'ai-focused-editor/welcome/catalog-pick-title',
          'Choose the folder that holds your books'
        ),
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false
      },
      startFolder
    );
    const picked = Array.isArray(selection) ? selection[0] : selection;
    if (!picked) {
      return;
    }
    // The onPreferenceChanged listener re-runs the scan when this lands.
    await this.preferenceService.set(AI_FOCUSED_EDITOR_LIBRARY_PATH, picked.toString(), PreferenceScope.User);
  }

  protected renderRecent(): React.ReactNode {
    if (this.recent.length === 0) {
      return undefined;
    }
    const rows = this.recent.slice(0, MAX_RECENT).map(uri => this.renderRecentRow(uri));
    return React.createElement(
      'section',
      { className: 'afe-welcome-section' },
      React.createElement(
        'h2',
        { className: 'afe-welcome-section-title' },
        nls.localize('ai-focused-editor/welcome/section-recent', 'Recent')
      ),
      React.createElement('ul', { className: 'afe-welcome-recent' }, ...rows)
    );
  }

  protected renderRecentRow(uriString: string): React.ReactNode {
    const uri = new URI(uriString);
    const name = this.labelProvider.getName(uri) || uri.path.base || uriString;
    const path = this.labelProvider.getLongName(uri);
    return React.createElement(
      'li',
      { key: uriString },
      React.createElement(
        'button',
        {
          className: 'afe-welcome-recent-row',
          type: 'button',
          title: nls.localize('ai-focused-editor/welcome/recent-open', 'Open {0}', path),
          onClick: () => this.openWorkspace(uriString)
        },
        React.createElement('span', { className: 'afe-welcome-recent-name' }, name),
        React.createElement('span', { className: 'afe-welcome-recent-path' }, path)
      )
    );
  }

  protected renderFooter(): React.ReactNode {
    return React.createElement(
      'footer',
      { className: 'afe-welcome-footer' },
      React.createElement(
        'label',
        { className: 'afe-welcome-startup' },
        React.createElement('input', {
          type: 'checkbox',
          checked: this.showOnStartup,
          onChange: (event: React.ChangeEvent<HTMLInputElement>) => this.setShowOnStartup(event.currentTarget.checked)
        }),
        React.createElement(
          'span',
          undefined,
          nls.localize('ai-focused-editor/welcome/show-on-startup', 'Show this page when no files are open')
        )
      )
    );
  }

  protected async setShowOnStartup(value: boolean): Promise<void> {
    await this.preferenceService.set(AI_FOCUSED_EDITOR_WELCOME_SHOW_ON_STARTUP, value, PreferenceScope.User);
    this.update();
  }

  protected runCommand(id: string): void {
    void this.commandRegistry.executeCommand(id);
  }

  /**
   * Open an existing folder as the workspace. In the browser (and macOS
   * Electron) the enabled command is {@link WorkspaceCommands.OPEN} (its
   * dialog label is "Open Folder"); on Linux/Windows Electron `OPEN` is
   * unavailable and {@link WorkspaceCommands.OPEN_FOLDER} is used instead — pick
   * whichever is currently enabled.
   */
  protected openFolder(): void {
    const candidates = [WorkspaceCommands.OPEN.id, WorkspaceCommands.OPEN_FOLDER.id, WorkspaceCommands.OPEN_WORKSPACE.id];
    const id = candidates.find(candidate => this.commandRegistry.isEnabled(candidate));
    if (!id) {
      void this.messages.warn(nls.localize(
        'ai-focused-editor/welcome/open-folder-unavailable',
        'Opening a folder is not available in this build.'
      ));
      return;
    }
    void this.commandRegistry.executeCommand(id);
  }

  protected runBookDoctor(): void {
    if (!this.commandRegistry.getCommand(BOOK_DOCTOR_COMMAND_ID)) {
      return;
    }
    // The command's own handler is gated on an open workspace (isEnabled);
    // executing a disabled command would throw, so warn instead.
    if (!this.commandRegistry.isEnabled(BOOK_DOCTOR_COMMAND_ID)) {
      void this.messages.warn(nls.localize(
        'ai-focused-editor/welcome/book-doctor-needs-workspace',
        'Open a manuscript workspace before running the Book Doctor.'
      ));
      return;
    }
    void this.commandRegistry.executeCommand(BOOK_DOCTOR_COMMAND_ID);
  }

  /** Reload the window into the given workspace folder/file (recent row click). */
  protected openWorkspace(uriString: string): void {
    this.workspaceService.open(new URI(uriString));
  }
}
