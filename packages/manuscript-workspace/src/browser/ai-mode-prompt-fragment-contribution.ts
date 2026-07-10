import URI from '@theia/core/lib/common/uri';
import { DisposableCollection } from '@theia/core/lib/common';
import { nls } from '@theia/core/lib/common/nls';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { inject, injectable } from '@theia/core/shared/inversify';
import {
  BasePromptFragment,
  PromptService
} from '@theia/ai-core/lib/common/prompt-service';
import {
  AiMode,
  AiModeRegistry
} from '../common';

const PROJECT_AI_MODE_FRAGMENT_PREFIX = 'ai-focused-editor.project-mode.';
const PROJECT_AI_MODE_COMMAND_PREFIX = 'afe-';

@injectable()
export class AiModePromptFragmentContribution implements FrontendApplicationContribution {
  @inject(AiModeRegistry)
  protected readonly aiModes!: AiModeRegistry;

  @inject(PromptService)
  protected readonly promptService!: PromptService;

  @inject(WorkspaceService)
  protected readonly workspaceService!: WorkspaceService;

  @inject(FileService)
  protected readonly fileService!: FileService;

  protected readonly toDispose = new DisposableCollection();
  protected registeredFragmentIds = new Set<string>();
  protected sourceWatcher = new DisposableCollection();
  protected watchedSourceUri: URI | undefined;
  protected syncPromise: Promise<void> | undefined;

  async onStart(): Promise<void> {
    this.toDispose.push(this.workspaceService.onWorkspaceChanged(() => {
      void this.syncPromptFragments();
    }));
    this.toDispose.push(this.fileService.onDidFilesChange(event => {
      if (this.watchedSourceUri && event.contains(this.watchedSourceUri)) {
        void this.syncPromptFragments();
      }
    }));
    await this.syncPromptFragments();
  }

  onStop(): void {
    this.toDispose.dispose();
    this.sourceWatcher.dispose();
    this.removeRegisteredFragments(new Set());
  }

  protected async syncPromptFragments(): Promise<void> {
    if (!this.syncPromise) {
      this.syncPromise = this.doSyncPromptFragments().finally(() => {
        this.syncPromise = undefined;
      });
    }
    return this.syncPromise;
  }

  protected async doSyncPromptFragments(): Promise<void> {
    const snapshot = await this.aiModes.refresh();
    const nextFragmentIds = new Set(snapshot.modes.map(mode => this.getFragmentId(mode.id)));

    this.removeRegisteredFragments(nextFragmentIds);

    for (const mode of snapshot.modes) {
      const fragmentId = this.getFragmentId(mode.id);
      if (this.registeredFragmentIds.has(fragmentId)) {
        this.promptService.removePromptFragment(fragmentId);
      }
      this.promptService.addBuiltInPromptFragment(this.toPromptFragment(mode));
      this.registeredFragmentIds.add(fragmentId);
    }

    this.updateSourceWatcher(snapshot.sourceUri);
  }

  protected removeRegisteredFragments(retain: Set<string>): void {
    for (const fragmentId of [...this.registeredFragmentIds]) {
      if (!retain.has(fragmentId)) {
        this.promptService.removePromptFragment(fragmentId);
        this.registeredFragmentIds.delete(fragmentId);
      }
    }
  }

  protected updateSourceWatcher(sourceUri: string | undefined): void {
    if ((this.watchedSourceUri?.toString() ?? '') === (sourceUri ?? '')) {
      return;
    }

    this.sourceWatcher.dispose();
    this.sourceWatcher = new DisposableCollection();
    this.watchedSourceUri = sourceUri ? new URI(sourceUri) : undefined;

    if (this.watchedSourceUri) {
      try {
        this.sourceWatcher.push(this.fileService.watch(this.watchedSourceUri.parent));
      } catch {
        // Missing prompt directories should not prevent the application from starting.
      }
    }
  }

  protected toPromptFragment(mode: AiMode): BasePromptFragment {
    // The prompt-fragment picker renders `name` (falling back to the fragment id)
    // and `description`, so both carry the author's mode label/description; the
    // 1.73 slash-command list can only render the ASCII `commandName`, so that
    // stays a normalized slug while the label surfaces through name/description.
    const displayLabel = mode.label?.trim() || mode.id;
    return {
      id: this.getFragmentId(mode.id),
      name: nls.localize('ai-focused-editor/ai-modes/fragment-name', 'AI Focused Editor: {0}', displayLabel),
      description: mode.description || nls.localize('ai-focused-editor/ai-modes/fragment-fallback-description', 'Project AI mode: {0}', mode.id),
      template: this.getTemplate(mode),
      isCommand: true,
      commandName: `${PROJECT_AI_MODE_COMMAND_PREFIX}${this.normalizeCommandName(mode.id)}`,
      commandDescription: mode.description || displayLabel
    };
  }

  protected getTemplate(mode: AiMode): string {
    if (!mode.userPrompt) {
      return mode.systemPrompt;
    }
    return [
      mode.systemPrompt,
      '',
      'Additional user instruction:',
      mode.userPrompt
    ].join('\n');
  }

  protected getFragmentId(modeId: string): string {
    return `${PROJECT_AI_MODE_FRAGMENT_PREFIX}${modeId}`;
  }

  protected normalizeCommandName(modeId: string): string {
    return modeId
      .replace(/[^a-z0-9-]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase() || 'mode';
  }
}
