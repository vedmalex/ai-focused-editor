import {
  Command,
  CommandRegistry,
  MenuModelRegistry
} from '@theia/core/lib/common';
import { injectable } from '@theia/core/shared/inversify';
import { nls } from '@theia/core/lib/common/nls';
import { AbstractViewContribution } from '@theia/core/lib/browser/shell/view-contribution';
import { TranscriptionSettingsWidget } from './transcription-settings-widget';
import { AiFocusedEditorMenus } from './ai-focused-editor-menu';

export namespace TranscriptionSettingsCommands {
  export const OPEN: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.transcriptionSettings.open',
      category: 'AI Focused Editor',
      label: 'Open Transcription Settings'
    },
    'ai-focused-editor/transcription-settings/open-command',
    'ai-focused-editor/doctor/category'
  );
}

/**
 * View + command + menu registration for the Transcription Settings panel
 * (mirrors the AI Model Config view registration: an
 * {@link AbstractViewContribution} whose toggle command opens the view in the
 * right area, plus a product-menu entry alongside the other Manuscript
 * commands).
 */
@injectable()
export class TranscriptionSettingsViewContribution extends AbstractViewContribution<TranscriptionSettingsWidget> {
  constructor() {
    super({
      widgetId: TranscriptionSettingsWidget.ID,
      widgetName: TranscriptionSettingsWidget.LABEL,
      defaultWidgetOptions: {
        area: 'right',
        rank: 240
      },
      toggleCommandId: TranscriptionSettingsCommands.OPEN.id
    });
  }

  override registerCommands(commands: CommandRegistry): void {
    super.registerCommands(commands);
  }

  override registerMenus(menus: MenuModelRegistry): void {
    super.registerMenus(menus);
    // Product menu bar, next to the Book Doctor entry. The explicit label
    // overrides the generic "Toggle … View" label the base class registers.
    menus.registerMenuAction(AiFocusedEditorMenus.MAIN, {
      commandId: TranscriptionSettingsCommands.OPEN.id,
      label: nls.localize('ai-focused-editor/transcription-settings/menu-label', 'Transcription Settings...'),
      order: '1c'
    });
  }
}
