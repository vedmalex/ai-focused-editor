import {
  Command,
  CommandRegistry,
  MenuModelRegistry
} from '@theia/core/lib/common';
import { nls } from '@theia/core/lib/common/nls';
import { injectable } from '@theia/core/shared/inversify';
import { AbstractViewContribution } from '@theia/core/lib/browser/shell/view-contribution';
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
export class NarrativeMapViewContribution extends AbstractViewContribution<NarrativeMapWidget> {
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
