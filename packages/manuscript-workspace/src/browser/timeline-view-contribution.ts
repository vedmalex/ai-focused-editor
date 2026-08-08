/**
 * Opening the timeline panel, and the two commands that open it FOCUSED
 * (gh#48 WP-6; deferred here from WP-5 with the panel they need).
 *
 * WHY THEY WERE NOT IN WP-5. All three open a panel, and the panel did not
 * exist. A command that opens nothing is either dead code or a stub, and the
 * tooth WP-5 was given — "the smoke opens the panel THROUGH THE COMMAND REGISTRY
 * and then checks it is findable" — would have been green against a stub, which
 * is the exact shape gh#46 wrote down as "panels nobody can find, with green
 * smokes that opened them through the registry".
 *
 * `Timeline: Validate Chronology` is NOT here and will not be: architecture §3.4
 * transferred chronology verdicts to gh#50's rule registry with capability
 * `timeline`. gh#48 supplies the data (`listEvents`, `getDuplicateEvents`); one
 * registry, one dismiss lifecycle, one publication channel.
 */

import { Command, CommandRegistry, MenuModelRegistry } from '@theia/core/lib/common';
import { nls } from '@theia/core/lib/common/nls';
import { inject, injectable } from '@theia/core/shared/inversify';
import { AbstractViewContribution } from '@theia/core/lib/browser/shell/view-contribution';
import { QuickInputService } from '@theia/core/lib/browser';
import { EditorManager } from '@theia/editor/lib/browser';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { TimelineWidget } from './timeline-widget';
import { AiFocusedEditorMenus } from './ai-focused-editor-menu';

export namespace TimelineViewCommands {
  const CATEGORY = 'AI Focused Editor';
  const CATEGORY_KEY = 'ai-focused-editor/timeline/category';

  export const OPEN: Command = Command.toLocalizedCommand(
    { id: 'ai-focused-editor.timeline.open', label: 'Timeline', category: CATEGORY },
    'ai-focused-editor/timeline/open',
    CATEGORY_KEY
  );

  export const SHOW_FOR_CURRENT_CHAPTER: Command = Command.toLocalizedCommand(
    { id: 'ai-focused-editor.timeline.showForCurrentChapter', label: 'Timeline: Events in This Chapter', category: CATEGORY },
    'ai-focused-editor/timeline/show-for-current-chapter',
    CATEGORY_KEY
  );

  export const SHOW_FOR_CHARACTER: Command = Command.toLocalizedCommand(
    { id: 'ai-focused-editor.timeline.showForCharacter', label: 'Timeline: Events for Character…', category: CATEGORY },
    'ai-focused-editor/timeline/show-for-character',
    CATEGORY_KEY
  );
}

@injectable()
export class TimelineViewContribution extends AbstractViewContribution<TimelineWidget> {
  @inject(EditorManager)
  protected readonly editorManager!: EditorManager;

  @inject(WorkspaceService)
  protected readonly workspaceService!: WorkspaceService;

  @inject(QuickInputService)
  protected readonly quickInput!: QuickInputService;

  constructor() {
    super({
      widgetId: TimelineWidget.ID,
      widgetName: TimelineWidget.LABEL,
      defaultWidgetOptions: { area: 'right', rank: 240 },
      toggleCommandId: TimelineViewCommands.OPEN.id
    });
  }

  override registerCommands(commands: CommandRegistry): void {
    super.registerCommands(commands);

    commands.registerCommand(TimelineViewCommands.SHOW_FOR_CURRENT_CHAPTER, {
      execute: () => this.showForCurrentChapter()
    });
    commands.registerCommand(TimelineViewCommands.SHOW_FOR_CHARACTER, {
      execute: () => this.showForCharacter()
    });
  }

  override registerMenus(menus: MenuModelRegistry): void {
    super.registerMenus(menus);
    for (const command of [
      TimelineViewCommands.OPEN,
      TimelineViewCommands.SHOW_FOR_CURRENT_CHAPTER,
      TimelineViewCommands.SHOW_FOR_CHARACTER
    ]) {
      menus.registerMenuAction(AiFocusedEditorMenus.KNOWLEDGE, { commandId: command.id });
    }
  }

  /**
   * Open the panel filtered to the chapter the author is in.
   *
   * IT OPENS THE PANEL EITHER WAY, even with no editor: the author asked to see
   * the timeline, and refusing outright would leave the command doing nothing
   * visible. What it cannot do without an editor is FILTER, so it clears the
   * chapter filter rather than guessing one.
   */
  protected async showForCurrentChapter(): Promise<void> {
    const widget = await this.openView({ activate: true, reveal: true });
    const chapterPath = this.currentChapterPath();
    widget.setFilter({ ...widget.filterValue, chapterPath });
  }

  /**
   * Open the panel filtered to one character, chosen from the events THEMSELVES.
   *
   * THE LIST COMES FROM THE FACETS, not from the entity registry: offering every
   * character in the manuscript and having most of them match nothing would be a
   * worse answer than offering the ones the timeline actually mentions. It is
   * the same rule the panel's own filter dropdowns follow.
   */
  protected async showForCharacter(): Promise<void> {
    const widget = await this.openView({ activate: true, reveal: true });
    const facets = widget.model.facets.participant;
    if (facets.length === 0) {
      return;
    }
    const picked = await this.quickInput.showQuickPick(
      facets.map(facet => ({ label: facet.id, description: String(facet.count) })),
      {
        placeholder: nls.localize(
          'ai-focused-editor/timeline/pick-character',
          'Which character’s events?'
        )
      }
    );
    if (picked === undefined) {
      return;
    }
    widget.setFilter({ ...widget.filterValue, participant: picked.label });
  }

  /** Workspace-relative path of the open chapter, or `undefined`. */
  protected currentChapterPath(): string | undefined {
    const uri = this.editorManager.currentEditor?.editor.uri;
    const root = this.workspaceService.tryGetRoots()[0]?.resource;
    if (uri === undefined || root === undefined) {
      return undefined;
    }
    return root.relative(uri)?.toString();
  }
}
