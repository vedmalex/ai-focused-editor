/**
 * Passive legacy-transcript detection → a non-intrusive Explorer tree badge
 * (UR-003, UR-007 item 2, UR-008 O2 — TASK-016 U2b).
 *
 * WHY THIS FILE LOOKS THE WAY IT DOES (ISS-159, plan §8c): Theia's
 * `DecorationsService` does NOT call `provideDecorations` when a tree node is
 * rendered — confirmed from `@theia/core`'s `DecorationProviderWrapper`
 * (`decorations-service.js`) and `@theia/filesystem`'s
 * `FileTreeDecoratorAdapter`: the adapter only reacts to
 * `DecorationsService#onDidChangeDecorations`, which is only fired once a
 * REGISTERED `DecorationsProvider` fires its own `onDidChange(uris)`. A
 * provider that only implements a synchronous `provideDecorations` and never
 * emits `onDidChange` is invisible — no badge ever appears, on any node,
 * expanded or not.
 *
 * The fix (same shape as the in-repo reference,
 * `packages/theia-git-fork/src/browser/git-decoration-provider.ts`
 * `GitDecorationProvider`): keep a synchronous `Map<uri, Decoration>` behind
 * `provideDecorations`, and EXPLICITLY fire `onDidChange` with every affected
 * URI whenever that map changes. `propagateDecorationsByUri`
 * (`file-tree-decorator-adapter.js`) then bubbles the `bubble:true` dot up
 * every ancestor folder by URI path — we only ever need to emit the exact
 * legacy chunk-dir URI, never its parents.
 *
 * THREE-LAYER HYBRID (plan §8c / F-PLAN-2-*):
 *  (a) BASE SCAN on `onStart` — a bounded, async, non-blocking recursive
 *      listing of every workspace root (multi-root aware, F-PLAN-2-1) via
 *      `FileService.resolve`, 2-3 directory levels deep, detected through the
 *      already-existing pure `detectLegacyTranscriptSets` (never duplicated —
 *      see `../common/legacy-transcript-decoration.ts` for the map-building
 *      wrapper around it). Skips the book's own `transcription/` and
 *      `sources/audio/` areas (already-migrated content, not legacy input).
 *  (b) INCREMENTAL — `FileService.onDidFilesChange` behind an EXPLICIT debounce
 *      wrapper (`DebouncedTrigger`, F-PLAN-2-2: never rely on an assumed
 *      built-in debounce), recomputing only the affected parent directories.
 *  (c) OPTIONAL FALLBACK — `FileNavigatorModel#onExpansionChanged` (attached
 *      once the Explorer's `FileNavigatorWidget` exists, since the model lives
 *      in that widget's own child container, not a plain DI singleton) rescans
 *      a newly-expanded directory, catching legacy folders nested beyond the
 *      base scan's perf budget/depth (F-PLAN-2-3). Not the primary mechanism.
 *
 * The pure map-building logic + debounce utility live in
 * `../common/legacy-transcript-decoration.ts` (Theia-import-free, so it stays
 * `bun test`-able without a DOM shim — this file's own Theia-heavy imports,
 * e.g. `@theia/core/lib/browser`'s barrel, transitively require `document`).
 */

import { inject, injectable } from '@theia/core/shared/inversify';
import { CancellationToken, Emitter, Event } from '@theia/core/lib/common';
import URI from '@theia/core/lib/common/uri';
import { Decoration, DecorationsProvider, DecorationsService } from '@theia/core/lib/browser/decorations-service';
import { ExpandableTreeNode, FrontendApplicationContribution, Widget, WidgetManager } from '@theia/core/lib/browser';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { FileStatNode } from '@theia/filesystem/lib/browser/file-tree';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { FILE_NAVIGATOR_ID, FileNavigatorWidget } from '@theia/navigator/lib/browser/navigator-widget';
import { ScannedDirectory } from '../common/legacy-transcript-import';
import {
  DebouncedTrigger,
  LegacyDecorationEntry,
  collectLegacyDecorationEntries
} from '../common/legacy-transcript-decoration';

export {
  DebouncedTrigger,
  LEGACY_TRANSCRIPT_DECORATION,
  LEGACY_TRANSCRIPT_DECORATION_COLOR_ID,
  LEGACY_TRANSCRIPT_DECORATION_LETTER,
  LEGACY_TRANSCRIPT_DECORATION_TOOLTIP,
  collectLegacyDecorationEntries
} from '../common/legacy-transcript-decoration';
export type { CollectLegacyDecorationEntriesOptions, LegacyDecoration, LegacyDecorationEntry } from '../common/legacy-transcript-decoration';

/** Base-scan depth passed to {@link LegacyTranscriptDecorationProvider.scanDirectory} (2-3 directory levels, plan §8c). */
const SCAN_DEPTH = 2;

/** Perf budget (F-PLAN-2-3): stop descending once this many directories have been visited in one scan pass. */
const MAX_SCAN_FOLDERS = 4000;

/** Explicit debounce window for the incremental layer (F-PLAN-2-2). */
const INCREMENTAL_DEBOUNCE_MS = 400;

@injectable()
export class LegacyTranscriptDecorationProvider implements DecorationsProvider, FrontendApplicationContribution {

  @inject(FileService)
  protected readonly fileService!: FileService;

  @inject(WorkspaceService)
  protected readonly workspaceService!: WorkspaceService;

  @inject(DecorationsService)
  protected readonly decorationsService!: DecorationsService;

  @inject(WidgetManager)
  protected readonly widgetManager!: WidgetManager;

  protected readonly decorations = new Map<string, Decoration>();

  private readonly onDidChangeEmitter = new Emitter<URI[]>();
  readonly onDidChange: Event<URI[]> = this.onDidChangeEmitter.event;

  protected readonly incrementalTrigger = new DebouncedTrigger<string>(INCREMENTAL_DEBOUNCE_MS, items =>
    this.runIncrementalRescan(items).catch(() => undefined)
  );

  /* ---------------------------------------------------------------------- *
   * DecorationsProvider
   * ---------------------------------------------------------------------- */

  provideDecorations(uri: URI, _token: CancellationToken): Decoration | undefined {
    return this.decorations.get(uri.toString());
  }

  /* ---------------------------------------------------------------------- *
   * FrontendApplicationContribution
   * ---------------------------------------------------------------------- */

  onStart(): void {
    this.decorationsService.registerDecorationsProvider(this);

    // (a) base scan — async, never blocks startup.
    this.runInitialScan().catch(() => undefined);

    // (b) incremental — explicit debounce (F-PLAN-2-2), never the assumed
    // built-in batching of onDidFilesChange.
    this.fileService.onDidFilesChange(event => {
      for (const change of event.changes) {
        this.incrementalTrigger.schedule(change.resource.toString());
      }
    });

    // (c) optional fallback — catches folders deeper than the base scan.
    this.wireExpansionFallback();
  }

  onStop(): void {
    this.incrementalTrigger.dispose();
  }

  /* ---------------------------------------------------------------------- *
   * (a) Base scan
   * ---------------------------------------------------------------------- */

  protected async runInitialScan(): Promise<void> {
    await this.workspaceService.ready;
    const changed: URI[] = [];
    // F-PLAN-2-1: iterate ALL workspace roots, not just the first.
    for (const root of this.workspaceService.tryGetRoots()) {
      const budget = { remaining: MAX_SCAN_FOLDERS };
      const listing = await this.scanDirectory(root.resource, SCAN_DEPTH, budget);
      const entries = collectLegacyDecorationEntries(listing);
      changed.push(...this.mergeEntries(root.resource, entries));
    }
    if (changed.length > 0) {
      this.onDidChangeEmitter.fire(changed);
    }
  }

  /* ---------------------------------------------------------------------- *
   * (b) Incremental rescan
   * ---------------------------------------------------------------------- */

  protected async runIncrementalRescan(changedUriStrings: readonly string[]): Promise<void> {
    const parents = new Map<string, URI>();
    for (const raw of changedUriStrings) {
      const parent = new URI(raw).parent;
      parents.set(parent.toString(), parent);
    }
    const changed: URI[] = [];
    for (const parentUri of parents.values()) {
      changed.push(...await this.rescanPrefix(parentUri));
    }
    if (changed.length > 0) {
      this.onDidChangeEmitter.fire(changed);
    }
  }

  /* ---------------------------------------------------------------------- *
   * (c) Optional fallback — expansion-triggered rescan
   * ---------------------------------------------------------------------- */

  /**
   * `FileNavigatorModel` lives in the Explorer widget's OWN child container
   * (built by `createFileNavigatorWidget`), not a plain DI singleton — so we
   * attach once the widget actually exists (already-open + any future one),
   * via `WidgetManager`, rather than injecting the model directly.
   */
  protected wireExpansionFallback(): void {
    const attach = (widget: Widget): void => {
      const navigatorWidget = widget as FileNavigatorWidget;
      if (!navigatorWidget.model?.onExpansionChanged) {
        return;
      }
      navigatorWidget.model.onExpansionChanged(node => this.handleExpansionChanged(node));
    };
    for (const widget of this.widgetManager.getWidgets(FILE_NAVIGATOR_ID)) {
      attach(widget);
    }
    this.widgetManager.onDidCreateWidget(event => {
      if (event.factoryId === FILE_NAVIGATOR_ID) {
        attach(event.widget);
      }
    });
  }

  protected handleExpansionChanged(node: Readonly<ExpandableTreeNode>): void {
    if (!node.expanded || !FileStatNode.is(node)) {
      return;
    }
    const rawUri = FileStatNode.getUri(node);
    if (!rawUri) {
      return;
    }
    this.rescanPrefix(new URI(rawUri))
      .then(changed => {
        if (changed.length > 0) {
          this.onDidChangeEmitter.fire(changed);
        }
      })
      .catch(() => undefined);
  }

  /* ---------------------------------------------------------------------- *
   * Shared rescan + merge helpers
   * ---------------------------------------------------------------------- */

  /** Rescan ONE directory (one level down) and merge the result into {@link decorations}; returns the changed URIs. */
  protected async rescanPrefix(prefixUri: URI): Promise<URI[]> {
    const root = this.workspaceService.tryGetRoots().find(candidate => candidate.resource.isEqualOrParent(prefixUri));
    if (!root) {
      return [];
    }
    const startSegments = this.relativeSegments(root.resource, prefixUri);
    const budget = { remaining: MAX_SCAN_FOLDERS };
    const listing = await this.scanDirectory(prefixUri, 1, budget);
    const entries = collectLegacyDecorationEntries(listing, { startSegments });
    return this.mergeEntries(prefixUri, entries, prefixUri);
  }

  /**
   * Reconcile freshly-detected `entries` (paths rooted at `pathRoot`, URIs
   * materialized against `uriRoot`'s scheme/authority) into {@link decorations}:
   * clears stale entries under `uriRoot` that disappeared, sets new/changed
   * ones (reference-equal ⇒ untouched, per `LEGACY_TRANSCRIPT_DECORATION`
   * being a shared singleton). Returns every URI whose decoration changed.
   */
  protected mergeEntries(uriRoot: URI, entries: readonly LegacyDecorationEntry[], prefixForRemoval: URI = uriRoot): URI[] {
    const changed: URI[] = [];
    const fresh = new Map<string, Decoration>();
    for (const entry of entries) {
      fresh.set(uriRoot.withPath(entry.path).toString(), entry.decoration);
    }
    for (const [key] of this.decorations) {
      if (fresh.has(key)) {
        continue;
      }
      const existing = new URI(key);
      if (prefixForRemoval.isEqualOrParent(existing)) {
        this.decorations.delete(key);
        changed.push(existing);
      }
    }
    for (const [key, decoration] of fresh) {
      if (this.decorations.get(key) !== decoration) {
        this.decorations.set(key, decoration);
        changed.push(new URI(key));
      }
    }
    return changed;
  }

  protected relativeSegments(rootUri: URI, uri: URI): string[] {
    const relative = rootUri.relative(uri);
    if (!relative) {
      return [];
    }
    return relative.toString().split('/').filter(segment => segment.length > 0);
  }

  /* ---------------------------------------------------------------------- *
   * FileService bridging (mirrors the established
   * TranscriptIngestContribution#scanDirectory shape, extended so a
   * depth-0 child still yields its OWN file listing — needed for
   * detectLegacyTranscriptSets' rule 1/2 evaluation one level below the
   * recursion cutoff).
   * ---------------------------------------------------------------------- */

  protected async scanDirectory(uri: URI, depth: number, budget: { remaining: number }): Promise<ScannedDirectory> {
    const stat = await this.fileService.resolve(uri).catch(() => undefined);
    const files: string[] = [];
    const directories: ScannedDirectory[] = [];
    for (const child of stat?.children ?? []) {
      if (child.isDirectory) {
        if (budget.remaining <= 0) {
          // F-PLAN-2-3: perf budget hit — stop descending; (c) covers the rest on-demand.
          continue;
        }
        budget.remaining--;
        directories.push(await this.scanChild(child.resource, child.name, depth, budget));
      } else {
        files.push(child.name);
      }
    }
    return { path: uri.path.toString(), name: uri.path.base, files, directories };
  }

  protected async scanChild(uri: URI, name: string, depth: number, budget: { remaining: number }): Promise<ScannedDirectory> {
    if (depth <= 0) {
      const stat = await this.fileService.resolve(uri).catch(() => undefined);
      const files = (stat?.children ?? []).filter(child => !child.isDirectory).map(child => child.name);
      return { path: uri.path.toString(), name, files, directories: [] };
    }
    return this.scanDirectory(uri, depth - 1, budget);
  }
}
