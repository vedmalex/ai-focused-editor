/**
 * Re-index a knowledge file the moment the author saves it (gh#47 WP-5,
 * architecture resolution F2-6).
 *
 * ## What this is for, and what it is NOT
 *
 * The protocol has carried `updateDocument(uri)` since TASK-022 WP-4b, and until
 * now NOTHING IN THE FRONTEND CALLED IT. That absence had a visible price: the
 * file watcher goes silent after its warm-up (ISS-371, a defect of the vendored
 * `@theia/filesystem`/`@parcel/watcher` that this repository does not attempt to
 * fix), so an author editing a character card IN THE EDITOR — the single most
 * likely way the card's own acceptance criterion is exercised — waited up to
 * five minutes for the fallback sweep, while the widget already knew both the
 * entity and its `sourcePath`, and the backend was one RPC from a targeted
 * re-index.
 *
 * THIS DOES NOT FIX ISS-371 AND MUST NOT BE READ AS DOING SO. It covers the
 * in-IDE path only. An edit made by another program, a `git checkout`, or a
 * second editor is still delivered by the watcher when it is alive and by the
 * five-minute sweep when it is not.
 *
 * ## Two decisions worth stating
 *
 * CLASSIFICATION IS THE BACKEND'S, NOT A LIST OF LITERALS HERE — and the reason
 * is stronger than convenience. `classifyDocument(path, types)` needs the entity
 * type descriptors, because whether `entities/<something>/x.yaml` is a card
 * depends on kinds the AUTHOR declares in `entities/types.yaml`. Answering that
 * on this side would mean caching the registry in the frontend: a second source
 * of truth about entity kinds, drifting from the first every time the author
 * edits `types.yaml`. So a save inside the workspace is simply handed to
 * `updateDocument`, which classifies with the registry it already holds and
 * reports `documentsReindexed: []` for a file it does not read.
 *
 * The architecture note (F2-6) said "checked through `classifyDocument`, not
 * through a list of literals"; this satisfies the second half exactly and moves
 * the first half to the only layer that can answer it truthfully. The cost is
 * one round trip for a save the index ignores — human-paced, and cheaper than a
 * cache that can be wrong.
 *
 * DEBOUNCED, because a save is not always one save: "save all", a formatter that
 * saves after formatting, and an auto-save cadence all produce bursts, and each
 * one would otherwise cost a backend round trip and an index write.
 */

import { inject, injectable } from '@theia/core/shared/inversify';
import { DisposableCollection } from '@theia/core/lib/common';
import type { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { MonacoWorkspace } from '@theia/monaco/lib/browser/monaco-workspace';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import {
  NarrativeKnowledgeService,
  type NarrativeKnowledgeService as NarrativeKnowledgeServiceType
} from '@ai-focused-editor/narrative-knowledge';
import { shouldReindexOnSave } from '../common';

/** Long enough to swallow a "save all" burst, short enough that the author does
 *  not notice waiting. Deliberately far below the five-minute fallback it is
 *  standing in for. */
export const SAVE_REINDEX_DEBOUNCE_MS = 400;

@injectable()
export class NarrativeSaveReindexContribution implements FrontendApplicationContribution {
  @inject(MonacoWorkspace)
  protected readonly monacoWorkspace!: MonacoWorkspace;

  @inject(WorkspaceService)
  protected readonly workspaceService!: WorkspaceService;

  @inject(NarrativeKnowledgeService)
  protected readonly knowledge!: NarrativeKnowledgeServiceType;

  protected readonly toDispose = new DisposableCollection();
  /** One timer per URI: two different cards saved together must both arrive,
   *  and a single shared timer would drop the earlier one. */
  protected readonly pending = new Map<string, ReturnType<typeof setTimeout>>();

  onStart(): void {
    this.toDispose.push(
      this.monacoWorkspace.onDidSaveTextDocument(model => this.onSaved(model.uri))
    );
  }

  onStop(): void {
    for (const timer of this.pending.values()) {
      clearTimeout(timer);
    }
    this.pending.clear();
    this.toDispose.dispose();
  }

  protected onSaved(uri: string): void {
    if (!this.isInsideWorkspace(uri)) {
      // A file opened from elsewhere on disk cannot belong to this index, and
      // that is the ONE thing this side can decide without the registry.
      return;
    }
    const existing = this.pending.get(uri);
    if (existing !== undefined) {
      clearTimeout(existing);
    }
    this.pending.set(
      uri,
      setTimeout(() => {
        this.pending.delete(uri);
        // Fire and forget, and swallow the rejection ON PURPOSE: a re-index
        // refused because another process owns the writer lock is a NORMAL
        // state this window already reports in the status bar, and surfacing it
        // again from a keystroke-adjacent path would turn an ordinary save into
        // an error the author cannot act on.
        void this.knowledge.updateDocument(uri).catch(() => undefined);
      }, SAVE_REINDEX_DEBOUNCE_MS)
    );
  }

  /** Whether the saved file is under a workspace root at all. The decision
   *  itself is a pure function with its own teeth — see `shouldReindexOnSave`. */
  protected isInsideWorkspace(uri: string): boolean {
    return shouldReindexOnSave(uri, this.workspaceService.tryGetRoots().map(root => root.resource.toString()));
  }
}
