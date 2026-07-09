import {
  Command,
  CommandContribution,
  CommandRegistry,
  MenuContribution,
  MenuModelRegistry,
  MessageService
} from '@theia/core/lib/common';
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

export namespace AiModeCommands {
  export const SHOW_PROJECT_AI_MODES: Command = {
    id: 'ai-focused-editor.aiModes.show',
    label: 'AI Focused Editor: Show Project AI Modes'
  };

  export const COPY_PROJECT_AI_MODES: Command = {
    id: 'ai-focused-editor.aiModes.copySummary',
    label: 'AI Focused Editor: Copy Project AI Mode Summary'
  };

  export const OPEN_PROJECT_AI_MODES_FILE: Command = {
    id: 'ai-focused-editor.aiModes.openFile',
    label: 'AI Focused Editor: Open Project AI Modes File'
  };
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
    const menuPath = ['ai-focused-editor', 'ai-modes'];
    menus.registerSubmenu(menuPath, 'AI Modes');
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
      ? `${snapshot.modes.length} project AI mode(s): ${snapshot.modes.map(mode => mode.id).join(', ')}`
      : 'No project AI modes loaded.';

    if (warningCount > 0) {
      await this.messages.warn(`${summary} ${warningCount} diagnostic(s).`);
      return;
    }
    await this.messages.info(summary);
  }

  protected async copyProjectAiModes(): Promise<void> {
    const snapshot = await this.aiModes.refresh();
    await this.clipboard.writeText(this.formatModes(snapshot.modes));
    await this.messages.info(`Copied ${snapshot.modes.length} project AI mode(s) to clipboard.`);
  }

  protected async openProjectAiModesFile(): Promise<void> {
    const snapshot = await this.aiModes.refresh();
    if (!snapshot.sourceUri) {
      await this.messages.warn('Open a manuscript workspace before opening project AI modes.');
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
