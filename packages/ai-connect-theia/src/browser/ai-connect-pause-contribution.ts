import {
  Command,
  CommandContribution,
  CommandRegistry,
  MessageService
} from '@theia/core/lib/common';
import {
  KeybindingContribution,
  KeybindingRegistry
} from '@theia/core/lib/browser/keybinding';
import { nls } from '@theia/core/lib/common/nls';
import { inject, injectable } from '@theia/core/shared/inversify';
import { AiConnectStreamController } from './ai-connect-stream-controller';

export namespace AiConnectPauseCommands {
  const CATEGORY_KEY = 'ai-focused-editor/ai-config/category';

  export const PAUSE_STREAMING: Command = Command.toLocalizedCommand(
    {
      id: 'ai-connect.pauseStreaming',
      category: 'AI Focused Editor',
      label: 'Pause AI Response'
    },
    'ai-focused-editor/ai-config/pause-streaming',
    CATEGORY_KEY
  );
}

/**
 * Command + keybinding to PAUSE the most recent AI streaming response
 * (ai-connect `pauseSignal`: keeps the partial answer, unlike a cancel).
 * Book-agnostic: registers the command and a default keybinding but places NO
 * menu item — the host application decides where (if anywhere) it appears.
 */
@injectable()
export class AiConnectPauseContribution implements CommandContribution, KeybindingContribution {
  @inject(AiConnectStreamController)
  protected readonly streamController!: AiConnectStreamController;

  @inject(MessageService)
  protected readonly messages!: MessageService;

  registerCommands(commands: CommandRegistry): void {
    commands.registerCommand(AiConnectPauseCommands.PAUSE_STREAMING, {
      execute: () => {
        if (!this.streamController.pauseLatest()) {
          this.messages.info(nls.localize(
            'ai-focused-editor/ai-config/pause-nothing-active',
            'No AI response is currently streaming.'
          ));
        }
      }
    });
  }

  registerKeybindings(keybindings: KeybindingRegistry): void {
    keybindings.registerKeybinding({
      command: AiConnectPauseCommands.PAUSE_STREAMING.id,
      keybinding: 'ctrlcmd+alt+.'
    });
  }
}
