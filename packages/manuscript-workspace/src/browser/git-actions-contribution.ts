import {
  Command,
  CommandContribution,
  CommandRegistry,
  MenuContribution,
  MenuModelRegistry,
  MessageService,
  SelectionService
} from '@theia/core/lib/common';
import { UriAwareCommandHandler } from '@theia/core/lib/common/uri-command-handler';
import { nls } from '@theia/core/lib/common/nls';
import URI from '@theia/core/lib/common/uri';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { NAVIGATOR_CONTEXT_MENU } from '@theia/navigator/lib/browser/navigator-contribution';
import { inject, injectable } from '@theia/core/shared/inversify';
import type { GitStatusService } from '../common';
import { GitStatusService as GitStatusServiceSymbol } from '../common';
import { AiFocusedEditorMenus } from './ai-focused-editor-menu';

export namespace GitActionCommands {
  const CATEGORY_KEY = 'ai-focused-editor/git/category';

  export const INIT_REPOSITORY: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.git.initRepository',
      category: 'AI Focused Editor',
      label: 'Initialize Git Repository'
    },
    'ai-focused-editor/git/init-repository',
    CATEGORY_KEY
  );

  export const ADD_TO_GITIGNORE: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.git.addToGitignore',
      category: 'AI Focused Editor',
      label: 'Add to .gitignore'
    },
    'ai-focused-editor/git/add-to-gitignore',
    CATEGORY_KEY
  );
}

/**
 * Writer-friendly git setup actions (owner intake): initialize a repository
 * for a fresh book folder and add files to .gitignore from the navigator.
 * Commits stay manual (spec §5.6) — these only prepare the workspace.
 */
@injectable()
export class GitActionsContribution implements CommandContribution, MenuContribution {
  @inject(GitStatusServiceSymbol)
  protected readonly gitStatus!: GitStatusService;

  @inject(WorkspaceService)
  protected readonly workspaceService!: WorkspaceService;

  @inject(FileService)
  protected readonly fileService!: FileService;

  @inject(MessageService)
  protected readonly messages!: MessageService;

  @inject(SelectionService)
  protected readonly selectionService!: SelectionService;

  registerCommands(registry: CommandRegistry): void {
    registry.registerCommand(GitActionCommands.INIT_REPOSITORY, {
      execute: () => this.initRepository()
    });

    registry.registerCommand(
      GitActionCommands.ADD_TO_GITIGNORE,
      UriAwareCommandHandler.MonoSelect(this.selectionService, {
        execute: uri => this.addToGitignore(uri),
        isEnabled: uri => uri.scheme === 'file',
        isVisible: uri => uri.scheme === 'file'
      })
    );
  }

  registerMenus(menus: MenuModelRegistry): void {
    menus.registerMenuAction(AiFocusedEditorMenus.MAIN, {
      commandId: GitActionCommands.INIT_REPOSITORY.id,
      order: 'z8'
    });
    menus.registerMenuAction([...NAVIGATOR_CONTEXT_MENU, 'z_afe'], {
      commandId: GitActionCommands.ADD_TO_GITIGNORE.id
    });
  }

  protected async initRepository(): Promise<void> {
    await this.workspaceService.ready;
    const root = this.workspaceService.tryGetRoots()[0];
    if (!root) {
      await this.messages.warn(nls.localize('ai-focused-editor/git/open-workspace-first', 'Open a workspace folder first.'));
      return;
    }
    const result = await this.gitStatus.initRepository(root.resource.toString());
    if (result.ok) {
      await this.messages.info(nls.localize(
        'ai-focused-editor/git/repository-initialized',
        '{0} The git indicator appears in the status bar shortly.',
        result.message
      ));
    } else {
      await this.messages.warn(result.message);
    }
  }

  protected async addToGitignore(uri: URI): Promise<void> {
    await this.workspaceService.ready;
    const root = this.workspaceService.tryGetRoots()[0];
    if (!root) {
      await this.messages.warn(nls.localize('ai-focused-editor/git/open-workspace-first', 'Open a workspace folder first.'));
      return;
    }

    const relative = root.resource.relative(uri)?.toString();
    if (!relative) {
      await this.messages.warn(nls.localize(
        'ai-focused-editor/git/file-outside-workspace',
        'The selected file is outside the workspace.'
      ));
      return;
    }

    const gitignoreUri = root.resource.resolve('.gitignore');
    let existing = '';
    try {
      existing = (await this.fileService.read(gitignoreUri)).value;
    } catch {
      // No .gitignore yet — it will be created below.
    }

    const lines = existing.split('\n').map(line => line.trim());
    if (lines.includes(relative) || lines.includes(`/${relative}`)) {
      await this.messages.info(nls.localize(
        'ai-focused-editor/git/gitignore-already-contains',
        '.gitignore already contains {0}.',
        relative
      ));
      return;
    }

    const next = existing.length === 0 || existing.endsWith('\n')
      ? `${existing}${relative}\n`
      : `${existing}\n${relative}\n`;
    if (existing.length === 0) {
      await this.fileService.create(gitignoreUri, next, { overwrite: false }).catch(async () => {
        await this.fileService.write(gitignoreUri, next);
      });
    } else {
      await this.fileService.write(gitignoreUri, next);
    }
    await this.messages.info(nls.localize('ai-focused-editor/git/gitignore-added', 'Added {0} to .gitignore.', relative));
  }
}
