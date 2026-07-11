import {
  Command,
  CommandContribution,
  CommandRegistry,
  CommandService,
  Emitter,
  Event,
  MenuContribution,
  MenuModelRegistry,
  MessageService
} from '@theia/core/lib/common';
import { nls } from '@theia/core/lib/common/nls';
import { inject, injectable } from '@theia/core/shared/inversify';
import {
  ApplicationShell,
  FrontendApplicationContribution,
  Widget
} from '@theia/core/lib/browser';
import {
  TabBarToolbarContribution,
  TabBarToolbarRegistry
} from '@theia/core/lib/browser/shell/tab-bar-toolbar';
import { EditorWidget } from '@theia/editor/lib/browser/editor-widget';
import { AiFocusedEditorMenus } from './ai-focused-editor-menu';

/**
 * Body class applied while Writing Mode is active. It is the CSS hook for the
 * focused, distraction-free layout (see src/browser/style/index.css). The panel
 * collapse below is the functional part; the class only drives the visual
 * suppression of chrome (activity bars, larger tap targets, …).
 */
export const WRITING_MODE_BODY_CLASS = 'afe-writing-mode';

/** Areas Writing Mode collapses; restored on toggle-off if they were open. */
const WRITING_MODE_AREAS: ReadonlyArray<ApplicationShell.Area> = ['left', 'right', 'bottom'];

/** sessionStorage key guarding the narrow-screen hint (once per browser session). */
const HINT_SESSION_KEY = 'afe.writingMode.narrowHintShown';

export namespace WritingModeCommands {
  // en label is the source of truth; ru comes from i18n/ru/mobile.json keyed by
  // `ai-focused-editor/mobile/*`. The command carries a codicon so the Manuscript
  // menu entry and command palette show the book glyph.
  export const TOGGLE: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.writingMode.toggle',
      label: 'Writing Mode',
      iconClass: 'codicon codicon-book'
    },
    'ai-focused-editor/mobile/writing-mode'
  );
}

/**
 * Writing Mode — a writer-focused, mobile-friendly layout layer on top of Theia
 * (which has no mobile mode of its own). Toggling collapses the side/bottom
 * panels and adds a body class for CSS; toggling off restores exactly the panels
 * that were open before. Also owns two frontend-start concerns for the browser
 * target on tablets/phones: a viewport meta tag and a one-time narrow-screen hint.
 */
@injectable()
export class WritingModeContribution
  implements CommandContribution, MenuContribution, TabBarToolbarContribution, FrontendApplicationContribution {

  @inject(ApplicationShell)
  protected readonly shell!: ApplicationShell;

  @inject(MessageService)
  protected readonly messages!: MessageService;

  @inject(CommandService)
  protected readonly commands!: CommandService;

  /** Whether Writing Mode is currently active. */
  protected active = false;

  /**
   * Which panels were expanded when Writing Mode was entered. Held in memory for
   * the session so toggle-off restores the prior layout rather than expanding
   * panels the writer had deliberately closed.
   */
  protected restore: { [area: string]: boolean } | undefined;

  protected readonly onDidChangeEmitter = new Emitter<void>();
  /** Fires when the toggle flips, so the toolbar item re-renders its icon. */
  get onDidChange(): Event<void> {
    return this.onDidChangeEmitter.event;
  }

  registerCommands(registry: CommandRegistry): void {
    registry.registerCommand(WritingModeCommands.TOGGLE, {
      execute: () => this.toggle(),
      isToggled: () => this.active
    });
  }

  registerMenus(menus: MenuModelRegistry): void {
    menus.registerMenuAction(AiFocusedEditorMenus.MAIN, {
      commandId: WritingModeCommands.TOGGLE.id,
      order: '1_writing-mode'
    });
  }

  registerToolbarItems(registry: TabBarToolbarRegistry): void {
    registry.registerItem({
      id: 'ai-focused-editor.writingMode.toolbar',
      command: WritingModeCommands.TOGGLE.id,
      // Icon flips to reflect state; screen-full = enter focus, screen-normal = leave.
      icon: () => this.active ? 'codicon codicon-screen-normal' : 'codicon codicon-screen-full',
      tooltip: nls.localize('ai-focused-editor/mobile/writing-mode-tooltip', 'Toggle Writing Mode (focused, distraction-free layout)'),
      priority: 1,
      onDidChange: this.onDidChange,
      isVisible: (widget?: Widget) => widget instanceof EditorWidget
    });
  }

  onStart(): void {
    this.ensureViewportMeta();
    this.maybeSuggestWritingMode();
  }

  onStop(): void {
    this.onDidChangeEmitter.dispose();
  }

  protected toggle(): void {
    if (this.active) {
      this.deactivate();
    } else {
      this.activate();
    }
  }

  protected activate(): void {
    // Snapshot the current expansion so toggle-off is a faithful restore.
    const restore: { [area: string]: boolean } = {};
    for (const area of WRITING_MODE_AREAS) {
      restore[area] = this.shell.isExpanded(area);
    }
    this.restore = restore;
    for (const area of WRITING_MODE_AREAS) {
      // collapsePanel returns a Promise; fire-and-forget — the layout settles async.
      void this.shell.collapsePanel(area);
    }
    if (typeof document !== 'undefined') {
      document.body.classList.add(WRITING_MODE_BODY_CLASS);
    }
    this.active = true;
    this.onDidChangeEmitter.fire();
  }

  protected deactivate(): void {
    if (typeof document !== 'undefined') {
      document.body.classList.remove(WRITING_MODE_BODY_CLASS);
    }
    const restore = this.restore;
    if (restore) {
      for (const area of WRITING_MODE_AREAS) {
        if (restore[area]) {
          this.shell.expandPanel(area);
        }
      }
    }
    this.restore = undefined;
    this.active = false;
    this.onDidChangeEmitter.fire();
  }

  /**
   * Ensure a responsive viewport meta exists so phones render at device width
   * instead of a zoomed-out desktop. Browser target only in practice; harmless
   * in electron (the shell HTML there already ships one, so we no-op).
   */
  protected ensureViewportMeta(): void {
    if (typeof document === 'undefined' || !document.head) {
      return;
    }
    if (document.querySelector('meta[name="viewport"]')) {
      return;
    }
    const meta = document.createElement('meta');
    meta.name = 'viewport';
    meta.content = 'width=device-width, initial-scale=1';
    document.head.appendChild(meta);
  }

  /**
   * On a narrow viewport at startup, suggest Writing Mode once per session. The
   * offered action enters Writing Mode directly.
   */
  protected maybeSuggestWritingMode(): void {
    if (typeof window === 'undefined' || window.innerWidth >= 700) {
      return;
    }
    try {
      if (window.sessionStorage.getItem(HINT_SESSION_KEY)) {
        return;
      }
      window.sessionStorage.setItem(HINT_SESSION_KEY, '1');
    } catch {
      // sessionStorage can be unavailable (privacy modes); the hint is best-effort.
    }
    const enableAction = nls.localize('ai-focused-editor/mobile/suggest-action-enable', 'Writing Mode');
    void this.messages
      .info(
        nls.localize(
          'ai-focused-editor/mobile/suggest-writing-mode',
          'Narrow screen detected. Try Writing Mode for a focused, distraction-free editor.'
        ),
        enableAction
      )
      .then(action => {
        if (action === enableAction) {
          void this.commands.executeCommand(WritingModeCommands.TOGGLE.id);
        }
      });
  }
}
