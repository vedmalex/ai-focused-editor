import {
  Command,
  CommandRegistry
} from '@theia/core/lib/common';
import { injectable } from '@theia/core/shared/inversify';
import { AbstractViewContribution } from '@theia/core/lib/browser/shell/view-contribution';
import { AiDebugWidget } from './ai-debug-widget';

export namespace AiDebugCommands {
  export const OPEN: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.aiDebug.open',
      label: 'AI Focused Editor: Open AI Debug View'
    },
    'ai-focused-editor/ai-config/open-debug'
  );

  export const REFRESH: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.aiDebug.refresh',
      label: 'AI Focused Editor: Refresh AI Debug View'
    },
    'ai-focused-editor/ai-config/refresh-debug'
  );

  export const COPY_SNAPSHOT: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.aiDebug.copySnapshot',
      label: 'AI Focused Editor: Copy AI Debug Snapshot'
    },
    'ai-focused-editor/ai-config/copy-debug-snapshot'
  );
}

/**
 * View + command registration for the AI Debug view. The host application
 * places these commands into its own menu; the standard Theia "View" toggle
 * registration is kept via `super`.
 */
@injectable()
export class AiDebugViewContribution extends AbstractViewContribution<AiDebugWidget> {
  constructor() {
    super({
      widgetId: AiDebugWidget.ID,
      widgetName: AiDebugWidget.LABEL,
      defaultWidgetOptions: {
        area: 'right',
        rank: 240
      },
      toggleCommandId: AiDebugCommands.OPEN.id
    });
  }

  override registerCommands(commands: CommandRegistry): void {
    super.registerCommands(commands);
    commands.registerCommand(AiDebugCommands.REFRESH, {
      execute: async () => {
        const widget = await this.openView({ activate: false, reveal: true });
        await widget.refresh();
      }
    });
    commands.registerCommand(AiDebugCommands.COPY_SNAPSHOT, {
      execute: async () => {
        const widget = await this.openView({ activate: false, reveal: true });
        await widget.copySnapshot();
      }
    });
  }
}
