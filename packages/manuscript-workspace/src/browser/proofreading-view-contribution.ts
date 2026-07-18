import { Command, CommandRegistry } from '@theia/core/lib/common';
import { injectable } from '@theia/core/shared/inversify';
import { AbstractViewContribution } from '@theia/core/lib/browser/shell/view-contribution';
import { ProofreadingViewWidget } from './proofreading-view-widget';

export namespace ProofreadingViewCommands {
  export const TOGGLE_VIEW: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.proofreading.openView',
      label: 'Proofreading',
      iconClass: 'codicon codicon-checklist'
    },
    'ai-focused-editor/proofreading-mode/view-label'
  );

  export const REFRESH_VIEW: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.proofreading.refreshView',
      category: 'AI Focused Editor',
      label: 'Refresh Proofreading Sets'
    },
    'ai-focused-editor/proofreading-mode/refresh-view'
  );
}

/**
 * Registers the Proofreading side view in the left activity bar (the
 * `SourceLibraryViewContribution` template): a toggleable view listing the
 * book's proofreading sets. {@link ProofreadingModeContribution} reuses this
 * contribution's `openView` to reveal the view when Proofreading Mode is
 * entered.
 */
@injectable()
export class ProofreadingViewContribution extends AbstractViewContribution<ProofreadingViewWidget> {
  constructor() {
    super({
      widgetId: ProofreadingViewWidget.ID,
      widgetName: ProofreadingViewWidget.LABEL,
      defaultWidgetOptions: {
        area: 'left',
        rank: 220
      },
      toggleCommandId: ProofreadingViewCommands.TOGGLE_VIEW.id
    });
  }

  override registerCommands(commands: CommandRegistry): void {
    super.registerCommands(commands);
    commands.registerCommand(ProofreadingViewCommands.REFRESH_VIEW, {
      execute: async () => {
        const widget = await this.openView({ activate: false, reveal: true });
        await widget.refresh();
      }
    });
  }
}
