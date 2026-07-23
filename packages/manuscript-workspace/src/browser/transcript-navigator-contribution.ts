import URI from '@theia/core/lib/common/uri';
import {
  Command,
  CommandContribution,
  CommandRegistry,
  MenuContribution,
  MenuModelRegistry,
  MessageService,
  SelectionService
} from '@theia/core/lib/common';
import { nls } from '@theia/core/lib/common/nls';
import { NAVIGATOR_CONTEXT_MENU } from '@theia/navigator/lib/browser/navigator-contribution';
import { inject, injectable } from '@theia/core/shared/inversify';
import { buildTranscribeFolderArgs, resolveDirectoryUriFromNode } from '../common/transcript-folder-command';
import { TranscriptIngestCommands } from './transcript-ingest-contribution';

/**
 * Registers the existing "Transcribe..." ingest wizard on the STANDARD file
 * Explorer's folder context menu (UR-003/UR-007 point 2): right-clicking any
 * directory in the navigator tree now offers "Импортировать транскрипты..."
 * which opens `TranscriptIngestContribution`'s wizard pre-answered into its
 * IMPORT branch with that folder — closing the "I never saw a wizard menu, or
 * a way to mark a folder as containing transcripts" gap from the user report
 * (the wizard existed and was reachable from the Manuscript tree/menu, but
 * never from the standard file Explorer people actually right-clicked).
 *
 * The wizard itself (`transcript-ingest-contribution.ts`) is untouched — this
 * is a thin folder-scoped entry point into its existing
 * `ai-focused-editor.transcript.transcribe` command, following the
 * `MediaViewerCommandContribution` "Open As Text" escape-hatch pattern
 * (Command+Menu, `NAVIGATOR_CONTEXT_MENU`,
 * `media-viewer-open-handler.ts:70-133`).
 *
 * `explorerResourceIsFolder` — the same when-clause the built-in "New
 * File"/"New Folder" navigator actions use (`@theia/navigator`'s
 * `FileNavigatorContribution.registerMenus`) — keeps the item hidden on plain
 * files. `isEnabled`/`isVisible` additionally resolve the folder URI
 * themselves (`resolveDirectoryUriFromNode`, pure + unit-tested in
 * `common/transcript-folder-command.ts`) so the command stays honest even
 * when invoked outside that exact menu placement (command palette,
 * programmatic tests) — it never fires the wizard against a file.
 */

export namespace TranscriptNavigatorCommands {
  export const TRANSCRIBE_FOLDER: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.transcript.transcribeFolder',
      label: 'Импортировать транскрипты...'
    },
    'ai-focused-editor/transcript/navigator-transcribe-folder'
  );
}

@injectable()
export class TranscriptNavigatorContribution implements CommandContribution, MenuContribution {
  @inject(SelectionService)
  protected readonly selectionService!: SelectionService;

  @inject(CommandRegistry)
  protected readonly commandRegistry!: CommandRegistry;

  @inject(MessageService)
  protected readonly messageService!: MessageService;

  registerCommands(commands: CommandRegistry): void {
    commands.registerCommand(TranscriptNavigatorCommands.TRANSCRIBE_FOLDER, {
      isEnabled: (arg?: unknown) => this.resolveFolderUri(arg) !== undefined,
      isVisible: (arg?: unknown) => this.resolveFolderUri(arg) !== undefined,
      execute: async (arg?: unknown) => {
        const folderUri = this.resolveFolderUri(arg);
        if (!folderUri) {
          await this.messageService.warn(nls.localize(
            'ai-focused-editor/transcript/navigator-select-folder-first',
            'Select a folder first.'
          ));
          return;
        }
        await this.commandRegistry.executeCommand(
          TranscriptIngestCommands.TRANSCRIBE.id,
          buildTranscribeFolderArgs(folderUri)
        );
      }
    });
  }

  registerMenus(menus: MenuModelRegistry): void {
    menus.registerMenuAction([...NAVIGATOR_CONTEXT_MENU, 'navigation'], {
      commandId: TranscriptNavigatorCommands.TRANSCRIBE_FOLDER.id,
      when: 'explorerResourceIsFolder'
    });
  }

  /**
   * Resolve the target folder: an explicit `URI` arg (programmatic
   * invocation / tests) takes priority, otherwise the single selected
   * navigator tree node — resolved to a URI only when it is a directory.
   */
  protected resolveFolderUri(arg?: unknown): URI | undefined {
    if (arg instanceof URI) {
      return arg;
    }
    const selection = this.selectionService.selection;
    const node = Array.isArray(selection) ? selection[0] : selection;
    return resolveDirectoryUriFromNode(node);
  }
}
