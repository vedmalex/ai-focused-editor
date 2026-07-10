import {
  Command,
  CommandContribution,
  CommandRegistry,
  MenuContribution,
  MenuModelRegistry,
  MessageService
} from '@theia/core/lib/common';
import { nls } from '@theia/core/lib/common/nls';
import { ClipboardService } from '@theia/core/lib/browser/clipboard-service';
import URI from '@theia/core/lib/common/uri';
import {
  open,
  OpenerService
} from '@theia/core/lib/browser';
import { inject, injectable } from '@theia/core/shared/inversify';
import {
  AiMode,
  AiModeRegistry
} from '../common';
import {
  AI_FOCUSED_EDITOR_MENU_LABEL,
  AiFocusedEditorMenus
} from './ai-focused-editor-menu';

export namespace AiModeCommands {
  export const SHOW_PROJECT_AI_MODES: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.aiModes.show',
      label: 'AI Focused Editor: Show Project AI Modes'
    },
    'ai-focused-editor/ai-modes/show-project-modes'
  );

  export const COPY_PROJECT_AI_MODES: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.aiModes.copySummary',
      label: 'AI Focused Editor: Copy Project AI Mode Summary'
    },
    'ai-focused-editor/ai-modes/copy-project-modes'
  );

  export const OPEN_PROJECT_AI_MODES_FILE: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.aiModes.openFile',
      label: 'AI Focused Editor: Open Project AI Modes File'
    },
    'ai-focused-editor/ai-modes/open-project-modes-file'
  );
}

@injectable()
export class AiModeContribution implements CommandContribution, MenuContribution {
  @inject(AiModeRegistry)
  protected readonly aiModes!: AiModeRegistry;

  @inject(MessageService)
  protected readonly messages!: MessageService;

  @inject(ClipboardService)
  protected readonly clipboard!: ClipboardService;

  @inject(OpenerService)
  protected readonly openerService!: OpenerService;

  registerCommands(registry: CommandRegistry): void {
    registry.registerCommand(AiModeCommands.SHOW_PROJECT_AI_MODES, {
      execute: () => this.showProjectAiModes()
    });
    registry.registerCommand(AiModeCommands.COPY_PROJECT_AI_MODES, {
      execute: () => this.copyProjectAiModes()
    });
    registry.registerCommand(AiModeCommands.OPEN_PROJECT_AI_MODES_FILE, {
      execute: () => this.openProjectAiModesFile()
    });
  }

  registerMenus(menus: MenuModelRegistry): void {
    const menuPath = AiFocusedEditorMenus.AI_MODES;
    menus.registerMenuAction(menuPath, {
      commandId: AiModeCommands.SHOW_PROJECT_AI_MODES.id
    });
    menus.registerMenuAction(menuPath, {
      commandId: AiModeCommands.COPY_PROJECT_AI_MODES.id
    });
    menus.registerMenuAction(menuPath, {
      commandId: AiModeCommands.OPEN_PROJECT_AI_MODES_FILE.id
    });
  }

  protected async showProjectAiModes(): Promise<void> {
    const snapshot = await this.aiModes.refresh();
    const warningCount = snapshot.diagnostics.filter(diagnostic => diagnostic.severity !== 'info').length;
    const summary = snapshot.modes.length > 0
      ? nls.localize('ai-focused-editor/ai-modes/modes-summary', '{0} project AI mode(s): {1}', snapshot.modes.length, snapshot.modes.map(mode => mode.id).join(', '))
      : nls.localize('ai-focused-editor/ai-modes/no-modes-loaded', 'No project AI modes loaded.');

    if (warningCount > 0) {
      await this.messages.warn(nls.localize('ai-focused-editor/ai-modes/modes-summary-with-diagnostics', '{0} {1} diagnostic(s).', summary, warningCount));
      return;
    }
    await this.messages.info(summary);
  }

  protected async copyProjectAiModes(): Promise<void> {
    const snapshot = await this.aiModes.refresh();
    await this.clipboard.writeText(this.formatModes(snapshot.modes));
    await this.messages.info(nls.localize('ai-focused-editor/ai-modes/modes-copied', 'Copied {0} project AI mode(s) to clipboard.', snapshot.modes.length));
  }

  protected async openProjectAiModesFile(): Promise<void> {
    const snapshot = await this.aiModes.refresh();
    if (!snapshot.sourceUri) {
      await this.messages.warn(nls.localize('ai-focused-editor/ai-modes/open-workspace-first', 'Open a manuscript workspace before opening project AI modes.'));
      return;
    }
    await open(this.openerService, new URI(snapshot.sourceUri));
  }

  protected formatModes(modes: AiMode[]): string {
    if (modes.length === 0) {
      return '# Project AI Modes\n\nNo project AI modes loaded.';
    }

    return [
      '# Project AI Modes',
      '',
      ...modes.flatMap(mode => [
        `## ${mode.label}`,
        `- id: ${mode.id}`,
        mode.description ? `- description: ${mode.description}` : undefined,
        mode.parameters ? `- parameters: ${JSON.stringify(mode.parameters)}` : undefined,
        '',
        mode.systemPrompt
      ].filter((line): line is string => line !== undefined))
    ].join('\n');
  }
}
