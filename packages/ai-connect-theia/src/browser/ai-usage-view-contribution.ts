import { Command, CommandRegistry } from '@theia/core/lib/common';
import { injectable } from '@theia/core/shared/inversify';
import { AbstractViewContribution } from '@theia/core/lib/browser/shell/view-contribution';
import { AiUsageWidget } from './ai-usage-widget';

export namespace AiUsageCommands {
  export const OPEN: Command = Command.toLocalizedCommand(
    {
      id: 'ai-connect.openUsage',
      label: 'AI Token Usage'
    },
    'ai-focused-editor/ai-usage/open'
  );
}

/**
 * View + command registration for the read-only AI Token Usage report. Adds NO
 * application-menu placement (generic package) — the host application places the
 * exported `ai-connect.openUsage` command into its own menu. The standard Theia
 * "View" toggle registration is kept via `super`.
 */
@injectable()
export class AiUsageViewContribution extends AbstractViewContribution<AiUsageWidget> {
  constructor() {
    super({
      widgetId: AiUsageWidget.ID,
      widgetName: AiUsageWidget.LABEL,
      defaultWidgetOptions: {
        area: 'right',
        rank: 250
      },
      toggleCommandId: AiUsageCommands.OPEN.id
    });
  }

  override registerCommands(commands: CommandRegistry): void {
    // Register OPEN directly (not via super's generic "Toggle {view}" command,
    // whose id would collide with ours) so the command carries the 'AI Token
    // Usage' label and refreshes the report on every open. No menu placement —
    // the host application decides where the command appears.
    commands.registerCommand(AiUsageCommands.OPEN, {
      execute: async () => {
        const widget = await this.openView({ activate: true, reveal: true });
        await widget.refresh();
      }
    });
  }
}
