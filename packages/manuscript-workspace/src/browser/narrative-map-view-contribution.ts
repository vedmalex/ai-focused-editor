import {
  Command,
  CommandRegistry,
  MenuModelRegistry
} from '@theia/core/lib/common';
import { nls } from '@theia/core/lib/common/nls';
import { inject, injectable } from '@theia/core/shared/inversify';
import { AbstractViewContribution } from '@theia/core/lib/browser/shell/view-contribution';
import { StorageService } from '@theia/core/lib/browser/storage-service';
import type { FrontendApplication, FrontendApplicationContribution } from '@theia/core/lib/browser';
import { NarrativeMapWidget } from './narrative-map-widget';
import { AiFocusedEditorMenus } from './ai-focused-editor-menu';
import { ensurePanelMigrated } from './layout-panel-migration';

export namespace NarrativeMapCommands {
  export const OPEN: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.narrative.openMap',
      label: 'AI Focused Editor: Open Narrative Map'
    },
    'ai-focused-editor/entities/open-map'
  );

  export const REFRESH: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.narrative.refreshMap',
      label: 'AI Focused Editor: Refresh Narrative Map'
    },
    'ai-focused-editor/entities/refresh-map'
  );
}

@injectable()
export class NarrativeMapViewContribution extends AbstractViewContribution<NarrativeMapWidget>
  implements FrontendApplicationContribution {
  @inject(StorageService)
  protected readonly storageService!: StorageService;

  constructor() {
    super({
      widgetId: NarrativeMapWidget.ID,
      widgetName: NarrativeMapWidget.LABEL,
      defaultWidgetOptions: {
        area: 'right',
        rank: 230
      },
      toggleCommandId: NarrativeMapCommands.OPEN.id
    });
  }

  /**
   * UR-039: on a fresh shell layout (no saved layout to restore — Theia only
   * calls this when `restoreLayout()` found nothing, see
   * `FrontendApplication.createDefaultLayout()`), attach the widget to the
   * right panel so its icon is visible from the first launch, same as
   * `ManuscriptTreeViewContribution`/`@theia/outline-view` do for their
   * panels. `activate: false, reveal: false` on purpose: the panel must be
   * PRESENT, not opened — opening it unconditionally here would also
   * overwrite a user's deliberately-closed saved layout, except this path
   * never runs when a saved layout exists in the first place.
   */
  async initializeLayout(_app: FrontendApplication): Promise<void> {
    await this.openView({ activate: false, reveal: false });
  }

  /**
   * UR-040: a workbook whose shell layout was saved by a version of the app
   * that predates this panel restores that OLD layout successfully (it's a
   * structurally valid, just older, `ApplicationShell.LayoutData`), so
   * `initializeLayout` above never runs for it — `restoreLayout()` already
   * returned `true`. Without this hook such a workspace would never see the
   * panel again: not on reload, not on a backend restart, not across a
   * bundle rebuild, forever, because "restore succeeded" short-circuits the
   * fresh-layout path permanently. `onDidInitializeLayout` fires
   * unconditionally after EITHER path (see `FrontendApplication.start()`),
   * which is what makes it the right hook for a one-time backfill. See
   * `ensurePanelMigrated`'s doc comment for why this is gated by a
   * persisted per-workspace marker rather than a live "is it attached?"
   * check: it must run at most once ever, so a panel the author closes
   * afterwards stays closed.
   */
  async onDidInitializeLayout(_app: FrontendApplication): Promise<void> {
    await ensurePanelMigrated(
      this.storageService,
      'ai-focused-editor.narrativeMap.layoutMigrationVersion',
      () => this.openView({ activate: false, reveal: false })
    );
  }

  override registerCommands(commands: CommandRegistry): void {
    super.registerCommands(commands);
    commands.registerCommand(NarrativeMapCommands.REFRESH, {
      execute: async () => {
        const widget = await this.openView({ activate: false, reveal: true });
        await widget.refresh();
      }
    });
  }

  override registerMenus(menus: MenuModelRegistry): void {
    super.registerMenus(menus);
    const menuPath = AiFocusedEditorMenus.KNOWLEDGE;
    menus.registerMenuAction(menuPath, {
      commandId: NarrativeMapCommands.OPEN.id
    });
    menus.registerMenuAction(menuPath, {
      commandId: NarrativeMapCommands.REFRESH.id
    });
  }
}
