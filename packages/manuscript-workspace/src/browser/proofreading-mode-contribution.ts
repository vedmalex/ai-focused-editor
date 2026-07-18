import {
  Command,
  CommandContribution,
  CommandRegistry,
  Emitter,
  Event,
  MenuContribution,
  MenuModelRegistry
} from '@theia/core/lib/common';
import { nls } from '@theia/core/lib/common/nls';
import URI from '@theia/core/lib/common/uri';
import { inject, injectable } from '@theia/core/shared/inversify';
import { ApplicationShell, open, OpenerService, Widget } from '@theia/core/lib/browser';
import {
  TabBarToolbarContribution,
  TabBarToolbarRegistry
} from '@theia/core/lib/browser/shell/tab-bar-toolbar';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { AiFocusedEditorMenus } from './ai-focused-editor-menu';
import { ProofreadingViewContribution } from './proofreading-view-contribution';
import { ProofreadingViewWidget } from './proofreading-view-widget';
import { ProofreadingWidget } from './proofreading-widget';
import { ProofreadingSetsService } from './proofreading-sets-service';

/**
 * Body class applied while Proofreading Mode is active. It is the CSS hook for
 * the focused scan/OCR/translation-review layout (see src/browser/style/index.css)
 * — de-emphasizing writing-only chrome so the two-pane proofreading surface owns
 * the screen. The layout snapshot below is the functional part; the class only
 * drives the visual suppression.
 */
export const PROOFREADING_MODE_BODY_CLASS = 'afe-proofreading-mode';

/**
 * Areas Proofreading Mode manages. `left` is REVEALED (it hosts the Proofreading
 * view); `right`/`bottom` are collapsed for focus. All are snapshotted so
 * toggle-off is a faithful restore of the prior layout.
 */
const PROOFREADING_MODE_AREAS: ReadonlyArray<ApplicationShell.Area> = ['left', 'right', 'bottom'];

export namespace ProofreadingModeCommands {
  export const TOGGLE: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.proofreading.toggleMode',
      label: 'Proofreading Mode',
      iconClass: 'codicon codicon-checklist'
    },
    'ai-focused-editor/proofreading-mode/toggle'
  );
}

/**
 * Proofreading Mode — a focused layout/perspective for scan/OCR/translation
 * review, mirroring {@link WritingModeContribution}. Entering reveals the
 * Proofreading view (left), collapses the other side/bottom panels, adds a body
 * class for CSS, and opens the most-recently-modified set into the two-pane
 * editor. Leaving restores exactly the layout that was open before and removes
 * the class. The mode is a layout FOCUS, not a hard modal: with no sets it still
 * shows the view's empty state (the "+ New Set" button works). Never throws.
 */
@injectable()
export class ProofreadingModeContribution
  implements CommandContribution, MenuContribution, TabBarToolbarContribution {

  @inject(ApplicationShell)
  protected readonly shell!: ApplicationShell;

  @inject(ProofreadingViewContribution)
  protected readonly view!: ProofreadingViewContribution;

  @inject(ProofreadingSetsService)
  protected readonly setsService!: ProofreadingSetsService;

  @inject(OpenerService)
  protected readonly openerService!: OpenerService;

  @inject(FileService)
  protected readonly fileService!: FileService;

  /** Whether Proofreading Mode is currently active. */
  protected active = false;

  /** Which panels were expanded when the mode was entered (for a faithful restore). */
  protected restore: { [area: string]: boolean } | undefined;

  protected readonly onDidChangeEmitter = new Emitter<void>();
  /** Fires when the toggle flips, so the toolbar item re-renders its icon. */
  get onDidChange(): Event<void> {
    return this.onDidChangeEmitter.event;
  }

  registerCommands(registry: CommandRegistry): void {
    registry.registerCommand(ProofreadingModeCommands.TOGGLE, {
      execute: () => void this.toggle(),
      isToggled: () => this.active
    });
  }

  registerMenus(menus: MenuModelRegistry): void {
    menus.registerMenuAction(AiFocusedEditorMenus.MAIN, {
      commandId: ProofreadingModeCommands.TOGGLE.id,
      order: '1_proofreading-mode'
    });
  }

  registerToolbarItems(registry: TabBarToolbarRegistry): void {
    registry.registerItem({
      id: 'ai-focused-editor.proofreading.toggleMode.toolbar',
      command: ProofreadingModeCommands.TOGGLE.id,
      // Icon flips to reflect state: enter (checklist) vs leave (screen-normal).
      icon: () => this.active ? 'codicon codicon-screen-normal' : 'codicon codicon-checklist',
      tooltip: nls.localize(
        'ai-focused-editor/proofreading-mode/toggle-tooltip',
        'Toggle Proofreading Mode (focused scan / OCR / translation review layout)'
      ),
      priority: 1,
      onDidChange: this.onDidChange,
      isVisible: (widget?: Widget) =>
        widget instanceof ProofreadingWidget || widget instanceof ProofreadingViewWidget
    });
  }

  protected async toggle(): Promise<void> {
    try {
      if (this.active) {
        await this.deactivate();
      } else {
        await this.activate();
      }
    } catch {
      // A mode toggle must never surface an error to the writer; leave whatever
      // partial state settled and reflect it on the toolbar.
      this.onDidChangeEmitter.fire();
    }
  }

  protected async activate(): Promise<void> {
    // Snapshot the current expansion so toggle-off is a faithful restore.
    const restore: { [area: string]: boolean } = {};
    for (const area of PROOFREADING_MODE_AREAS) {
      restore[area] = this.shell.isExpanded(area);
    }
    this.restore = restore;

    // Reveal the Proofreading view (expands the left panel) and de-clutter the rest.
    try {
      await this.view.openView({ activate: true, reveal: true });
    } catch {
      // View reveal is best-effort; the mode still applies its layout + class.
    }
    void this.shell.collapsePanel('right');
    void this.shell.collapsePanel('bottom');

    if (typeof document !== 'undefined') {
      document.body.classList.add(PROOFREADING_MODE_BODY_CLASS);
    }
    this.active = true;
    this.onDidChangeEmitter.fire();

    // Best-effort: open the most-recently-modified set into the two-pane editor.
    await this.openMostRecentSet();
  }

  protected async deactivate(): Promise<void> {
    if (typeof document !== 'undefined') {
      document.body.classList.remove(PROOFREADING_MODE_BODY_CLASS);
    }
    const restore = this.restore;
    if (restore) {
      for (const area of PROOFREADING_MODE_AREAS) {
        if (restore[area]) {
          this.shell.expandPanel(area);
        } else {
          void this.shell.collapsePanel(area);
        }
      }
    }
    this.restore = undefined;
    this.active = false;
    this.onDidChangeEmitter.fire();
  }

  /**
   * Open the set whose `proofset.yaml` was modified most recently, so entering
   * the mode lands the writer on the set they were last working. Falls back to
   * the last-listed set when mtimes are unavailable; a no-set book opens nothing
   * (the view's empty state stays usable). Never throws.
   */
  protected async openMostRecentSet(): Promise<void> {
    let sets;
    try {
      sets = await this.setsService.list();
    } catch {
      return;
    }
    if (!sets || sets.length === 0) {
      return;
    }
    let target = sets[sets.length - 1];
    let latest = -1;
    for (const set of sets) {
      try {
        const stat = await this.fileService.resolve(new URI(set.uri));
        const mtime = stat.mtime ?? 0;
        if (mtime > latest) {
          latest = mtime;
          target = set;
        }
      } catch {
        // Skip a set whose sidecar cannot be stat'd; keep the current target.
      }
    }
    try {
      await open(this.openerService, new URI(target.uri));
    } catch {
      // Opening is best-effort; the mode remains active either way.
    }
  }
}
