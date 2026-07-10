import { Command, MessageService } from '@theia/core/lib/common';
import { CommandRegistry } from '@theia/core/lib/common/command';
import { PreferenceScope, PreferenceService } from '@theia/core/lib/common/preferences';
import { LabelProvider } from '@theia/core/lib/browser';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import URI from '@theia/core/lib/common/uri';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { WorkspaceCommands } from '@theia/workspace/lib/browser';
import {
  inject,
  injectable,
  postConstruct
} from '@theia/core/shared/inversify';
import React from '@theia/core/shared/react';
import { AI_FOCUSED_EDITOR_WELCOME_SHOW_ON_STARTUP } from './ai-focused-editor-preferences';

/**
 * Commands surfaced by the welcome page. Defined here (not in the frontend
 * module) so the widget can reference the ids it invokes without importing the
 * module that binds it — keeping the module → widget dependency one-directional.
 * The `WelcomeContribution` in `welcome-frontend-module.ts` registers them.
 */
export namespace WelcomeCommands {
  /** Open/reveal the welcome page as the active main tab. */
  export const OPEN: Command = {
    id: 'ai-focused-editor.welcome.open',
    category: 'AI Focused Editor',
    label: 'Welcome'
  };

  /** Multi-step "New Book..." wizard that materializes a fresh book scaffold. */
  export const NEW_BOOK: Command = {
    id: 'ai-focused-editor.book.newBook',
    category: 'AI Focused Editor',
    label: 'New Book...'
  };
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

  /** Newest-first recent workspace URIs, loaded asynchronously after construction. */
  protected recent: string[] = [];

  @postConstruct()
  protected init(): void {
    this.id = WelcomeWidget.ID;
    this.title.label = WelcomeWidget.LABEL;
    this.title.caption = 'AI Focused Editor — Welcome';
    this.title.iconClass = 'codicon codicon-book';
    this.title.closable = true;
    this.addClass('afe-welcome');

    this.toDispose.push(this.preferenceService.onPreferenceChanged(change => {
      if (change.preferenceName === AI_FOCUSED_EDITOR_WELCOME_SHOW_ON_STARTUP) {
        this.update();
      }
    }));

    void this.loadRecent();
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

  protected render(): React.ReactNode {
    return React.createElement(
      'div',
      { className: 'afe-welcome-body', tabIndex: -1 },
      this.renderHeader(),
      this.renderStart(),
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
        'A writer-first manuscript workspace: draft, structure, and publish your book.'
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
      React.createElement('h2', { className: 'afe-welcome-section-title' }, 'Start'),
      React.createElement(
        'div',
        { className: 'afe-welcome-actions' },
        this.renderActionButton(
          'codicon codicon-new-file',
          'Create New Book...',
          'Materialize a fresh book scaffold with the New Book wizard',
          () => this.runCommand(WelcomeCommands.NEW_BOOK.id),
          true
        ),
        this.renderActionButton(
          'codicon codicon-folder-opened',
          'Open Folder...',
          'Open an existing book folder as the workspace',
          () => this.openFolder()
        ),
        this.renderActionButton(
          'codicon codicon-checklist',
          'Book Doctor...',
          doctorRegistered
            ? 'Inspect the current book and create any missing scaffold'
            : 'Book Doctor is not available in this build',
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

  protected renderRecent(): React.ReactNode {
    if (this.recent.length === 0) {
      return undefined;
    }
    const rows = this.recent.slice(0, MAX_RECENT).map(uri => this.renderRecentRow(uri));
    return React.createElement(
      'section',
      { className: 'afe-welcome-section' },
      React.createElement('h2', { className: 'afe-welcome-section-title' }, 'Recent'),
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
          title: `Open ${path}`,
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
        React.createElement('span', undefined, 'Show this page when no files are open')
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
      void this.messages.warn('Opening a folder is not available in this build.');
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
      void this.messages.warn('Open a manuscript workspace before running the Book Doctor.');
      return;
    }
    void this.commandRegistry.executeCommand(BOOK_DOCTOR_COMMAND_ID);
  }

  /** Reload the window into the given workspace folder/file (recent row click). */
  protected openWorkspace(uriString: string): void {
    this.workspaceService.open(new URI(uriString));
  }
}
