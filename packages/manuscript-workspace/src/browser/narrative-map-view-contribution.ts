import {
  Command,
  CommandRegistry,
  MenuModelRegistry
} from '@theia/core/lib/common';
import { nls } from '@theia/core/lib/common/nls';
import { injectable } from '@theia/core/shared/inversify';
import { AbstractViewContribution } from '@theia/core/lib/browser/shell/view-contribution';
import type { FrontendApplication, FrontendApplicationContribution } from '@theia/core/lib/browser';
import { NarrativeMapWidget } from './narrative-map-widget';
import { AiFocusedEditorMenus } from './ai-focused-editor-menu';

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
