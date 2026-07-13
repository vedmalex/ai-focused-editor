import {
  Command,
  CommandRegistry
} from '@theia/core/lib/common';
import { injectable } from '@theia/core/shared/inversify';
import { AbstractViewContribution } from '@theia/core/lib/browser/shell/view-contribution';
import { ModelConfigWidget } from './model-config-widget';

export namespace ModelConfigCommands {
  export const OPEN: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.modelConfig.open',
      label: 'AI Focused Editor: Open AI Model Config'
    },
    'ai-focused-editor/ai-config/open-model-config'
  );

  export const REFRESH: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.modelConfig.refresh',
      label: 'AI Focused Editor: Refresh AI Model Config'
    },
    'ai-focused-editor/ai-config/refresh-model-config'
  );
}

/**
 * View + command registration for the AI Model Config view. This package owns
 * the commands and the widget; the host application places the commands into
 * its own menu (see the manuscript-workspace `AiConnectMenuContribution`). The
 * standard Theia "View" toggle registration is kept via `super`.
 */
@injectable()
export class ModelConfigViewContribution extends AbstractViewContribution<ModelConfigWidget> {
  constructor() {
    super({
      widgetId: ModelConfigWidget.ID,
      widgetName: ModelConfigWidget.LABEL,
      defaultWidgetOptions: {
        area: 'right',
        rank: 230
      },
      toggleCommandId: ModelConfigCommands.OPEN.id
    });
  }

  override registerCommands(commands: CommandRegistry): void {
    super.registerCommands(commands);
    commands.registerCommand(ModelConfigCommands.REFRESH, {
      execute: async () => {
        const widget = await this.openView({ activate: false, reveal: true });
        await widget.refresh();
      }
    });
  }
}
