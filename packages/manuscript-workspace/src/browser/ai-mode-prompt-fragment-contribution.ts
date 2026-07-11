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
  protected watchedSourceUris: URI[] = [];
  protected syncPromise: Promise<void> | undefined;

  async onStart(): Promise<void> {
    this.toDispose.push(this.workspaceService.onWorkspaceChanged(() => {
      void this.syncPromptFragments();
    }));
    this.toDispose.push(this.fileService.onDidFilesChange(event => {
      if (this.watchedSourceUris.some(uri => event.contains(uri))) {
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

    this.updateSourceWatchers(snapshot.watchUris ?? (snapshot.sourceUri ? [snapshot.sourceUri] : []));
  }

  protected removeRegisteredFragments(retain: Set<string>): void {
    for (const fragmentId of [...this.registeredFragmentIds]) {
      if (!retain.has(fragmentId)) {
        this.promptService.removePromptFragment(fragmentId);
        this.registeredFragmentIds.delete(fragmentId);
      }
    }
  }

  protected updateSourceWatchers(sourceUris: string[]): void {
    const next = [...new Set(sourceUris)].sort();
    const current = this.watchedSourceUris.map(uri => uri.toString()).sort();
    if (next.length === current.length && next.every((uri, index) => uri === current[index])) {
      return;
    }

    this.sourceWatcher.dispose();
    this.sourceWatcher = new DisposableCollection();
    this.watchedSourceUris = next.map(uri => new URI(uri));

    for (const uri of this.watchedSourceUris) {
      try {
        this.sourceWatcher.push(this.fileService.watch(uri.parent));
      } catch {
        // Missing prompt directories (e.g. no global config yet) should not
        // prevent the application from starting.
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
