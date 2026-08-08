/**
 * `Timeline: Add Event from Selection` (gh#48 WP-5, plan Р-6).
 *
 * ## The one thing this command may not do
 *
 * IT DOES NOT TOUCH THE CHAPTER. Not a byte. The author selects a passage, and
 * what gets written is a YAML entry in `knowledge/timeline/` that POINTS AT that
 * passage — the chapter file is read for its path and its line numbers and is
 * never opened for writing. That is invariant §5.7 ("commands of knowledge do
 * not touch prose"), and it is asserted by comparing bytes rather than by the
 * absence of complaints.
 *
 * ## Why the shaping lives in `common/`
 *
 * Everything that decides WHAT gets written — the id, the quoting, where the
 * text is inserted, and the refusal to clobber a file that is not a timeline —
 * is `timeline-event-authoring.ts`, pure and Theia-free, so it is testable
 * without a shell. What is left here is what genuinely needs the frontend: the
 * active editor's selection, a prompt, a file write, and the targeted re-index
 * that makes the new event visible without waiting for the fallback sweep.
 *
 * ## The re-index is not optional politeness
 *
 * The file watcher goes quiet after warm-up (ISS-371), so without the explicit
 * `updateDocument` the author would add an event and see nothing for up to five
 * minutes — on the one path where the app knows exactly which file changed. This
 * is the same reasoning `narrative-save-reindex-contribution.ts` records, and
 * the same remedy.
 */

import { inject, injectable } from '@theia/core/shared/inversify';
import { Command, CommandContribution, CommandRegistry, MenuContribution, MenuModelRegistry } from '@theia/core/lib/common';
import { nls } from '@theia/core/lib/common/nls';
import { QuickInputService } from '@theia/core/lib/browser';
import { EditorManager } from '@theia/editor/lib/browser';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import URI from '@theia/core/lib/common/uri';
import {
  NarrativeKnowledgeService,
  type NarrativeKnowledgeService as NarrativeKnowledgeServiceType
} from '@ai-focused-editor/narrative-knowledge';
import { AiFocusedEditorMenus } from './ai-focused-editor-menu';
import {
  appendEventToTimeline,
  DEFAULT_TIMELINE_FILE,
  type NewTimelineEvent
} from '../common/timeline-event-authoring';
import { MessageService } from '@theia/core/lib/common/message-service';

export namespace TimelineCommands {
  export const ADD_EVENT_FROM_SELECTION: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.timeline.addEventFromSelection',
      label: 'AI Focused Editor: Add Timeline Event from Selection',
      category: 'Timeline'
    },
    'ai-focused-editor/timeline/add-event-from-selection'
  );
}

@injectable()
export class TimelineAuthoringContribution implements CommandContribution, MenuContribution {
  @inject(EditorManager)
  protected readonly editorManager!: EditorManager;

  @inject(FileService)
  protected readonly fileService!: FileService;

  @inject(WorkspaceService)
  protected readonly workspaceService!: WorkspaceService;

  @inject(QuickInputService)
  protected readonly quickInput!: QuickInputService;

  @inject(NarrativeKnowledgeService)
  protected readonly knowledge!: NarrativeKnowledgeServiceType;

  @inject(MessageService)
  protected readonly messages!: MessageService;

  registerCommands(commands: CommandRegistry): void {
    commands.registerCommand(TimelineCommands.ADD_EVENT_FROM_SELECTION, {
      execute: () => this.addEventFromSelection()
    });
  }

  registerMenus(menus: MenuModelRegistry): void {
    menus.registerMenuAction(AiFocusedEditorMenus.KNOWLEDGE, {
      commandId: TimelineCommands.ADD_EVENT_FROM_SELECTION.id
    });
  }

  protected async addEventFromSelection(): Promise<void> {
    const editor = this.editorManager.currentEditor?.editor;
    if (editor === undefined) {
      await this.messages.warn(
        nls.localize(
          'ai-focused-editor/timeline/needs-editor',
          'Open a chapter in the editor before adding a timeline event.'
        )
      );
      return;
    }
    const root = this.workspaceService.tryGetRoots()[0]?.resource;
    if (root === undefined) {
      await this.messages.warn(
        nls.localize('ai-focused-editor/timeline/needs-workspace', 'Open a manuscript folder first.')
      );
      return;
    }
    const chapterPath = this.relativePath(root, editor.uri);
    if (chapterPath === undefined) {
      await this.messages.warn(
        nls.localize(
          'ai-focused-editor/timeline/outside-workspace',
          'This file is outside the manuscript folder, so an event cannot point at it.'
        )
      );
      return;
    }

    const selection = editor.selection;
    const selectedText = editor.document.getText(selection);
    const title = await this.quickInput.input({
      prompt: nls.localize('ai-focused-editor/timeline/title-prompt', 'Title of the event'),
      // The selection is the DEFAULT, not the value: an author who selected a
      // paragraph wants a short title, and one who selected a phrase usually
      // wants it verbatim. Pre-filling lets both accept or type over it.
      value: suggestTitle(selectedText),
      placeHolder: nls.localize('ai-focused-editor/timeline/title-placeholder', 'What happens here')
    });
    if (title === undefined || title.trim().length === 0) {
      // Cancelled. Nothing has been written yet, and nothing will be.
      return;
    }

    const timelineUri = root.resolve(DEFAULT_TIMELINE_FILE);
    const existing = await this.readIfExists(timelineUri);
    const event: NewTimelineEvent = {
      title: title.trim(),
      chapterPath,
      // A SELECTION OF NOTHING IS A WHOLE-FILE REFERENCE, not a zero-length
      // range at the cursor. `evidence.ts` is explicit that manufacturing
      // coordinates makes a weaker claim indistinguishable from a precise one,
      // and a caret resting in a chapter is not a passage.
      ...(selection.start.line === selection.end.line && selection.start.character === selection.end.character
        ? {}
        : { range: { startLine: selection.start.line, endLine: selection.end.line } })
    };

    const result = appendEventToTimeline(existing, event);
    if (!result.ok) {
      await this.messages.warn(
        nls.localize(
          'ai-focused-editor/timeline/not-a-timeline-file',
          '{0} is not a timeline file (it has no `events:` list), so the event was not written. Fix or rename it first.',
          DEFAULT_TIMELINE_FILE
        )
      );
      return;
    }

    await this.fileService.write(timelineUri, result.text);
    // Targeted re-index, so the event is visible now rather than after the
    // fallback sweep — see the class note.
    await this.knowledge.updateDocument(timelineUri.toString());
    await this.messages.info(
      nls.localize(
        'ai-focused-editor/timeline/added',
        'Added “{0}” to {1}.',
        result.eventId,
        DEFAULT_TIMELINE_FILE
      )
    );
  }

  /** Workspace-relative POSIX path, or `undefined` for a file outside it. */
  protected relativePath(root: URI, file: URI): string | undefined {
    const relative = root.relative(file);
    return relative === undefined ? undefined : relative.toString();
  }

  protected async readIfExists(uri: URI): Promise<string | undefined> {
    try {
      return (await this.fileService.read(uri)).value;
    } catch {
      // Absent, or unreadable. Either way there is nothing to append TO, and
      // `appendEventToTimeline` creates a fresh file — which is the right answer
      // for absent and the safe answer for unreadable, because a write that
      // cannot read what it is replacing must not silently replace it. See the
      // note on the refusal path: a file that EXISTS and is unreadable will
      // surface as a write error rather than as a silent clobber.
      return undefined;
    }
  }
}

/**
 * A title suggestion from the selected prose.
 *
 * FIRST SENTENCE, TRIMMED, CAPPED. An author selecting a paragraph gets
 * something to edit rather than a paragraph pasted into a title field; an author
 * selecting a phrase gets the phrase.
 */
export function suggestTitle(selection: string): string {
  const collapsed = selection.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) {
    return '';
  }
  const sentence = collapsed.split(/(?<=[.!?…])\s/)[0] ?? collapsed;
  const candidate = sentence.length > 0 ? sentence : collapsed;
  return candidate.length <= 80 ? candidate : `${candidate.slice(0, 79).trimEnd()}…`;
}
