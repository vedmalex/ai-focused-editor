import { inject, injectable } from '@theia/core/shared/inversify';
import type { CommandContribution, CommandRegistry } from '@theia/core/lib/common/command';
import { DisposableCollection } from '@theia/core/lib/common/disposable';
import { MessageService } from '@theia/core/lib/common/message-service';
import { nls } from '@theia/core/lib/common/nls';
import { PreferenceService } from '@theia/core/lib/common/preferences';
import URI from '@theia/core/lib/common/uri';
import type { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { ClipboardService } from '@theia/core/lib/browser/clipboard-service';
import { StatusBar, StatusBarAlignment } from '@theia/core/lib/browser/status-bar/status-bar';
import { ProblemManager } from '@theia/markers/lib/browser/problem/problem-manager';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import {
  DEFAULT_NARRATIVE_MEMORY_CONFIG,
  NARRATIVE_MEMORY_DIAGNOSTICS_ENABLED,
  NARRATIVE_MEMORY_NLS_PREFIX,
  NarrativeKnowledgeService,
  NOT_BUILT_INDEX_STATE,
  checkForChangesFailurePresentation,
  checkForChangesOutcome,
  isNarrativeMemoryPreference,
  narrativeIndexStatusReport,
  narrativeMemoryPatchFromPreferences,
  narrativeMemoryPresentation,
  type IndexState,
  type NarrativeMemoryPresentation,
  type NarrativeMemoryPreferenceKey
} from '../common';
import { NarrativeMemoryCommands } from './narrative-memory-commands';
import {
  NARRATIVE_MEMORY_MARKER_OWNER,
  mergeMarkerBatches,
  narrativeDuplicateEntityMarkerBatches,
  narrativeMarkerBatches,
  narrativeRelationMarkerBatches
} from './narrative-memory-markers';
import {
  checkForChangesOutcomeLines,
  indexStatusReportLines,
  localizeNarrativeMemoryKey,
  statusBarText,
  statusBarTooltip
} from './narrative-memory-render';

const STATUS_BAR_ID = 'ai-focused-editor.narrativeMemory.status';

/**
 * How often the frontend re-asks the backend what the index is doing.
 *
 * POLLING, AND IT IS A KNOWN COST rather than an oversight. The RPC contract
 * (`NarrativeKnowledgeService`) has no client half — nothing on the backend can
 * call the frontend — so an index that changes because a file changed has no
 * way to say so. Adding a push channel means adding an `RpcServer` client
 * interface to the protocol, which is a change to WP-1's surface and to every
 * consumer WP-7 is about to migrate; doing it inside WP-5 would be re-deciding
 * a contract this work package was handed.
 *
 * The call is cheap by construction — `getIndexStatus` assembles four
 * primitives and returns a small record — and the EXPENSIVE half is not on this
 * timer at all: markers are only recomputed when `generation` moves, which is
 * exactly the use `IndexState.generation` documents ("a value a consumer is
 * safe to cache against").
 *
 * STILL THE RIGHT CALL AFTER ISS-360 (TASK-022 UR-036 part 2), RE-EXAMINED
 * RATHER THAN ASSUMED. ISS-360 closed the multi-MINUTE loss window a cold
 * watcher subscription used to leave open — `NarrativeIndexMaintainer`'s
 * warm-up phase now applies an on-disk edit within roughly
 * `WATCHER_WARMUP_SWEEP_INTERVAL_MS` (2 s) of arming, and a live watcher event
 * applies one within one debounce window (400 ms by default) — so the term
 * THIS timer adds is now the LARGEST remaining one for the two surfaces that
 * actually read it (the status bar, and the diagnostics markers gated on
 * `applyDiagnostics`'s own `publishedGeneration` check): up to 5 s of extra
 * display latency on top of a backend that is typically sub-two-seconds now.
 * That is a real, user-visible number, not a rounding error — and it is
 * WHY THE ORIGINAL RATIONALE ABOVE STILL CARRIES THE DECISION: a push channel
 * needs a `RpcServer` CLIENT half added to `NarrativeKnowledgeService` — a
 * change to the protocol's SHAPE, felt by the round-trip probe, the frontend
 * module's proxy wiring and every future consumer of this service, not a
 * change local to this file — and that is deliberately not a call to make
 * inside a bug-fix pass that owns the maintainer, not the protocol. The smoke
 * check this ISS added (`assertNarrativeKnowledgeWatcherSelfUpdates`) is
 * UNAFFECTED by this timer either way: it calls `getIndexStatus`/
 * `listDocuments` directly over RPC on its own 500 ms loop, never through this
 * contribution's poll. If the 5 s display lag becomes the complaint on its own
 * (rather than the multi-minute loss ISS-360 was about), that is the moment to
 * spend the protocol change — tracked, not silently deferred again.
 */
export const NARRATIVE_MEMORY_POLL_INTERVAL_MS = 5000;

/**
 * Commands, the status bar, diagnostics and the settings bridge (TASK-022 WP-5).
 *
 * ALMOST NOTHING IS DECIDED HERE. Which of the six rows of the plan's state
 * table applies, whether a command is visible, whether it is enabled, and what
 * happens to the marker set are all `narrativeMemoryPresentation()` in
 * `src/common`; what a phrase says is `narrative-memory-render.ts`; what a
 * marker looks like is `narrative-memory-markers.ts`. What is left in this file
 * is the part that cannot be tested under `bun` at all — `StatusBar`,
 * `ProblemManager`, `WorkspaceService` and the command registry — and it is
 * left as thin as it can be made, because every line of judgement inside a
 * class that cannot be instantiated in a test is a line nothing checks.
 *
 * REBUILD ASKS ABOUT OWNERSHIP TWICE, ON PURPOSE. Once on every refresh, to
 * decide the affordance; and again inside `execute`, because tech_spec ОВ-4
 * requires the check to happen AT THE MOMENT OF THE CALL — a lock expires 30
 * seconds after its last heartbeat, and that can happen while the user is
 * looking at the status bar. The second ask is what makes the refusal true
 * rather than merely displayed, and the store's own refusal underneath it is
 * what makes it safe even if both asks are stale.
 */
@injectable()
export class NarrativeMemoryContribution
  implements FrontendApplicationContribution, CommandContribution
{
  @inject(NarrativeKnowledgeService)
  protected readonly service!: NarrativeKnowledgeService;

  @inject(StatusBar)
  protected readonly statusBar!: StatusBar;

  @inject(ProblemManager)
  protected readonly problemManager!: ProblemManager;

  @inject(WorkspaceService)
  protected readonly workspaceService!: WorkspaceService;

  @inject(PreferenceService)
  protected readonly preferenceService!: PreferenceService;

  @inject(MessageService)
  protected readonly messageService!: MessageService;

  @inject(ClipboardService)
  protected readonly clipboardService!: ClipboardService;

  protected readonly toDispose = new DisposableCollection();

  /** URIs this owner currently has markers on, so a withdrawal can be exact. */
  protected readonly publishedUris = new Set<string>();

  /** The generation the published markers were computed from. `undefined` means
   *  nothing has been published in this session. */
  protected publishedGeneration: number | undefined;

  /** The last observed answer, so `isEnabled`/`isVisible` — which Theia calls
   *  SYNCHRONOUSLY, many times, while painting a menu — never block on RPC. */
  protected presentation: NarrativeMemoryPresentation = narrativeMemoryPresentation({
    state: NOT_BUILT_INDEX_STATE,
    rebuildBlockedByForeignWriter: false,
    diagnosticsEnabled: DEFAULT_NARRATIVE_MEMORY_CONFIG.diagnosticsEnabled
  });

  protected timer: ReturnType<typeof setInterval> | undefined;

  /**
   * Local, UI-only flag driving the "Проверяю изменения…" status-bar text
   * (UR-037). NOT part of {@link presentation} — the five-second poll would
   * almost never catch a `checkForChanges` pass in flight (it typically runs
   * in the tens of milliseconds), so the "in progress" affordance has to come
   * from the command handler that KNOWS it started a call, not from the next
   * scheduled `refresh()`. Cleared in the handler's `finally`, so it cannot
   * stick if the call throws.
   */
  protected checkingNow = false;

  onStart(): void {
    void this.pushPreferences();
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), NARRATIVE_MEMORY_POLL_INTERVAL_MS);
    this.toDispose.push(
      this.preferenceService.onPreferenceChanged(change => {
        if (!isNarrativeMemoryPreference(change.preferenceName)) {
          return;
        }
        // `diagnostics.enabled` is frontend-only and immediate; the other four
        // go to the backend. Both paths end in a refresh, because both change
        // what the surfaces should show.
        if (change.preferenceName !== NARRATIVE_MEMORY_DIAGNOSTICS_ENABLED) {
          void this.pushPreferences();
        }
        void this.refresh();
      })
    );
  }

  onStop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.toDispose.dispose();
  }

  registerCommands(commands: CommandRegistry): void {
    commands.registerCommand(NarrativeMemoryCommands.REBUILD_INDEX, {
      execute: () => this.rebuild(),
      isEnabled: () => this.presentation.rebuildCommand.enabled,
      // BOTH GUARDS, and they say different things. `isVisible` false is the
      // `no-manuscript` row, where this package has nothing to offer at all;
      // `isEnabled` false with `isVisible` true is the ownership refusal, where
      // the command MUST stay on screen — hiding it would leave the user unable
      // to see why the one action the status bar offers does nothing (ОВ-4).
      isVisible: () => this.presentation.rebuildCommand.visible
    });
    commands.registerCommand(NarrativeMemoryCommands.SHOW_INDEX_STATUS, {
      execute: () => this.showStatus(),
      isEnabled: () => this.presentation.showStatusCommand.enabled,
      isVisible: () => this.presentation.showStatusCommand.visible
    });
    commands.registerCommand(NarrativeMemoryCommands.CHECK_FOR_CHANGES, {
      execute: () => this.checkForChanges(),
      // `checkNowCommand.enabled` is unconditionally true whenever the command
      // is offered at all (UR-036 part 1 — ownership never disables it); the
      // local `checkingNow` guard is what stops a second click from queuing a
      // redundant pass behind the one already running.
      isEnabled: () => this.presentation.checkNowCommand.enabled && !this.checkingNow,
      isVisible: () => this.presentation.checkNowCommand.visible
    });
  }

  // ---- the loop ----------------------------------------------------------

  protected async rootUri(): Promise<string | undefined> {
    await this.workspaceService.ready;
    const root =
      this.workspaceService.tryGetRoots()[0] ?? (await this.workspaceService.roots)[0];
    return root?.resource.toString();
  }

  protected diagnosticsEnabled(): boolean {
    return this.preferenceService.get<boolean>(
      NARRATIVE_MEMORY_DIAGNOSTICS_ENABLED,
      DEFAULT_NARRATIVE_MEMORY_CONFIG.diagnosticsEnabled
    );
  }

  /** Re-ask both questions, then apply the answer to all three surfaces. */
  protected async refresh(): Promise<void> {
    const rootUri = await this.rootUri();
    if (rootUri === undefined) {
      return;
    }
    let state: IndexState;
    let blocked: boolean;
    try {
      state = await this.service.getIndexStatus(rootUri);
      blocked = !(await this.service.getRebuildAvailability(rootUri)).available;
    } catch {
      // An unreachable backend is not an index failure, and inventing a
      // `failed` state for it would put a `IndexFailureReason` on screen that
      // no backend ever produced. Leaving the last known presentation in place
      // is the honest reading: nothing new is known.
      return;
    }
    this.presentation = narrativeMemoryPresentation({
      state,
      rebuildBlockedByForeignWriter: blocked,
      diagnosticsEnabled: this.diagnosticsEnabled()
    });
    await this.renderStatusBar();
    await this.applyDiagnostics(rootUri, state);
  }

  protected async renderStatusBar(): Promise<void> {
    const model = this.presentation.statusBar;
    if (model === undefined) {
      // HIDDEN ENTIRELY — the `absent`/`no-manuscript` row. Not an empty label
      // and not a grey "not built": this workspace is not a manuscript, and a
      // status bar entry about a manuscript index would be noise in a photo
      // folder.
      this.statusBar.removeElement(STATUS_BAR_ID);
      return;
    }
    // UR-037's progress affordance, LOCAL AND IMMEDIATE — never waits for the
    // next poll (see `checkingNow`'s own doc). SUPPRESSED WHILE THE INDEX IS
    // ALREADY `rebuilding`: that state already reads "строится", and UR-037's
    // own "следствие" forbids a second, disagreeing vocabulary for the same
    // fact — showing "Проверяю…" over a rebuild in flight would claim this
    // click started work that is, in truth, someone else's pass.
    const checking = this.checkingNow && model.phraseKey !== `${NARRATIVE_MEMORY_NLS_PREFIX}/status-rebuilding`;
    await this.statusBar.setElement(STATUS_BAR_ID, {
      text: checking ? `$(sync~spin) ${localizeNarrativeMemoryKey(`${NARRATIVE_MEMORY_NLS_PREFIX}/check-checking`)}` : statusBarText(model),
      alignment: StatusBarAlignment.RIGHT,
      priority: 110,
      tooltip: checking
        ? localizeNarrativeMemoryKey(`${NARRATIVE_MEMORY_NLS_PREFIX}/check-checking`)
        : statusBarTooltip(model),
      // The one click leads to the surface that can explain the state; Rebuild
      // is reached from there or from the palette. Making the click REBUILD
      // would put a destructive action one stray click away from a status bar.
      command: NarrativeMemoryCommands.SHOW_INDEX_STATUS.id,
      ...(model.tone === 'warning' ? { backgroundColor: 'var(--theia-statusBarItem-warningBackground)' } : {}),
      ...(model.tone === 'error' ? { backgroundColor: 'var(--theia-statusBarItem-errorBackground)' } : {})
    });
  }

  // ---- diagnostics -------------------------------------------------------

  protected async applyDiagnostics(rootUri: string, state: IndexState): Promise<void> {
    const { publishNew, retainExisting } = this.presentation.diagnostics;

    if (!retainExisting) {
      this.withdrawMarkers();
    }
    if (!publishNew) {
      return;
    }
    // ONLY WHEN THE INDEX MOVED. `generation` is the store's write counter and
    // is documented as the value a consumer may cache against, so re-fetching
    // every mention on a five-second timer that usually observes the same
    // number would be work with a guaranteed-identical result.
    if (this.publishedGeneration === state.generation) {
      return;
    }
    let mentions;
    let relations;
    let duplicates;
    try {
      [mentions, relations, duplicates] = await Promise.all([
        this.service.getMentions(rootUri, { brokenOnly: true }),
        this.service.getRelations(rootUri, { brokenOnly: true }),
        this.service.getDuplicateEntities(rootUri)
      ]);
    } catch {
      return;
    }
    // THREE ENVELOPES NOW, NOT ONE, and all three have to agree before
    // anything is published. The state may have moved between any of the
    // three calls — publishing markers computed under one generation while
    // claiming another would make the cache key a lie, exactly the reasoning
    // that already governs `publishedGeneration` for a single envelope, now
    // applied to all three: every envelope must report `ready`, AND all three
    // must report the SAME generation, or this pass is abandoned and the next
    // poll tries again.
    if (
      mentions.state.state !== 'ready' ||
      relations.state.state !== 'ready' ||
      duplicates.state.state !== 'ready' ||
      relations.state.generation !== mentions.state.generation ||
      duplicates.state.generation !== mentions.state.generation
    ) {
      return;
    }
    const batches = mergeMarkerBatches(
      narrativeMarkerBatches(rootUri, mentions.data),
      narrativeRelationMarkerBatches(rootUri, relations.data),
      narrativeDuplicateEntityMarkerBatches(rootUri, duplicates.data)
    );
    const nextUris = new Set(batches.map(batch => batch.uri));
    for (const uri of this.publishedUris) {
      if (!nextUris.has(uri)) {
        this.problemManager.setMarkers(new URI(uri), NARRATIVE_MEMORY_MARKER_OWNER, []);
      }
    }
    for (const batch of batches) {
      this.problemManager.setMarkers(
        new URI(batch.uri),
        NARRATIVE_MEMORY_MARKER_OWNER,
        batch.diagnostics
      );
    }
    this.publishedUris.clear();
    for (const uri of nextUris) {
      this.publishedUris.add(uri);
    }
    this.publishedGeneration = mentions.state.generation;
  }

  protected withdrawMarkers(): void {
    for (const uri of this.publishedUris) {
      this.problemManager.setMarkers(new URI(uri), NARRATIVE_MEMORY_MARKER_OWNER, []);
    }
    this.publishedUris.clear();
    this.publishedGeneration = undefined;
  }

  // ---- commands ----------------------------------------------------------

  protected async rebuild(): Promise<void> {
    const rootUri = await this.rootUri();
    if (rootUri === undefined) {
      return;
    }
    // ASKED AGAIN, AT THE MOMENT OF THE CALL (ОВ-4). The cached answer decided
    // whether to grey the command out; it may be up to five seconds old, and a
    // lock expires on a 30-second heartbeat.
    const availability = await this.service.getRebuildAvailability(rootUri);
    if (!availability.available) {
      this.messageService.warn(
        nls.localize(
          `${NARRATIVE_MEMORY_NLS_PREFIX}/rebuild-blocked-foreign-writer`,
          'The narrative index is owned by another process. Rebuilding would delete its work.'
        )
      );
      await this.refresh();
      return;
    }
    this.messageService.info(
      nls.localize(`${NARRATIVE_MEMORY_NLS_PREFIX}/rebuild-started`, 'Rebuilding the narrative index...')
    );
    try {
      await this.service.rebuild(rootUri);
    } catch {
      // The backend keeps `Error.message` and `Error.stack` on its own side of
      // the RPC boundary (ОВ-8 rule 2), so there is nothing here to show but
      // the fact and a pointer at the log. Showing `String(error)` would be the
      // sanitation leak that rule exists to prevent.
      this.messageService.error(
        nls.localize(
          `${NARRATIVE_MEMORY_NLS_PREFIX}/rebuild-failed`,
          'The narrative index could not be rebuilt. Details are in the backend log.'
        )
      );
    }
    await this.refresh();
  }

  /**
   * "Check for Changes Now" (UR-036 part 1, UR-037, UR-038, ISS-361).
   *
   * NO PRE-CALL OWNERSHIP GATE, unlike {@link rebuild}. UR-036 requires this
   * command to stay available under a foreign lock — a sweep with nothing to
   * write succeeds read-only, so refusing the CALL ahead of time on the
   * strength of `getRebuildAvailability` would refuse a legitimate success.
   * The availability check instead runs INSIDE the `catch`, only to explain a
   * failure that already happened — {@link checkForChangesFailurePresentation}'s
   * own doc spells out why that order, not the reverse, is correct here.
   */
  protected async checkForChanges(): Promise<void> {
    const rootUri = await this.rootUri();
    if (rootUri === undefined) {
      return;
    }
    this.checkingNow = true;
    await this.renderStatusBar();
    try {
      const result = await this.service.checkForChanges(rootUri);
      const outcome = checkForChangesOutcome(result.data);
      this.messageService.info(checkForChangesOutcomeLines(outcome).join('\n'));
    } catch {
      // ОВ-8: the thrown error carries nothing distinguishable across the RPC
      // boundary, so a SECOND call is what tells "another process owns the
      // index" apart from any other backend failure (ISS-361) — never a read
      // of the caught error itself.
      let availability: { available: boolean };
      try {
        availability = await this.service.getRebuildAvailability(rootUri);
      } catch {
        // The backend that just failed to check may also fail to answer this;
        // treat it as unattributable rather than throwing a second time out of
        // a command handler.
        availability = { available: true };
      }
      const { messageKey } = checkForChangesFailurePresentation(availability);
      this.messageService.warn(localizeNarrativeMemoryKey(messageKey));
    } finally {
      this.checkingNow = false;
    }
    await this.refresh();
  }

  protected async showStatus(): Promise<void> {
    const rootUri = await this.rootUri();
    if (rootUri === undefined) {
      return;
    }
    const state = await this.service.getIndexStatus(rootUri);
    const availability = await this.service.getRebuildAvailability(rootUri);
    const report = narrativeIndexStatusReport({
      state,
      rebuildBlockedByForeignWriter: !availability.available,
      diagnosticsEnabled: this.diagnosticsEnabled()
    });
    const body = indexStatusReportLines(report).join('\n');
    const copy = report.failure
      ? nls.localize(`${NARRATIVE_MEMORY_NLS_PREFIX}/report-copy-incident`, 'Copy incident id')
      : undefined;
    // "Check for Changes Now" IS OFFERED FROM THIS DIALOG TOO (UR-037 entry
    // point (a) — the status-bar click opens exactly this dialog). It is
    // offered on every branch, including a broken index: a sweep is a cheap,
    // read-leaning probe, and refusing to even attempt one here would be a
    // stronger claim than `checkNowCommand`'s own presentation makes anywhere
    // else.
    const checkNow = localizeNarrativeMemoryKey(`${NARRATIVE_MEMORY_NLS_PREFIX}/command-check-now`);
    const actions = [checkNow, ...(copy === undefined ? [] : [copy])];
    const chosen = await this.messageService.info(body, ...actions);
    if (chosen === checkNow) {
      await this.checkForChanges();
      return;
    }
    if (chosen === copy && report.failure !== undefined) {
      // The id is copied VERBATIM, never through a localized sentence: it is
      // going into a bug report next to a backend log line that prints the same
      // characters (ОВ-8).
      await this.clipboardService.writeText(report.failure.incidentId);
    }
  }

  // ---- settings bridge ---------------------------------------------------

  /**
   * Send the four backend-owned preferences down as ONE patch.
   *
   * ONE PATCH RATHER THAN FOUR CALLS, because ОВ-9б guarantees order
   * independence but not four separate `configVersion` bumps, and because a
   * patch that changes nothing is defined to touch the watcher not at all —
   * which is what makes it safe to call this on every keystroke in a settings
   * field, the exact hazard consequence 3 of that section names.
   *
   * THE RESULT IS SHOWN, NOT DISCARDED. `configure` returns `applied`,
   * `deferred` and `rejected` precisely so a UI can stop guessing: an
   * out-of-range value is REFUSED rather than clamped (ОВ-9б, "Валидация:
   * ОТКЛОНЯТЬ, а не зажимать"), and the price of that decision — stated there —
   * is that WP-5 must tell the user. A `databasePath` change lands in
   * `deferred`, and the user is told it starts working at the next backend
   * start rather than being left to infer it from a settings description.
   */
  protected async pushPreferences(): Promise<void> {
    const rootUri = await this.rootUri();
    if (rootUri === undefined) {
      return;
    }
    const patch = narrativeMemoryPatchFromPreferences(
      (key: NarrativeMemoryPreferenceKey) => this.preferenceService.get(key)
    );
    let result;
    try {
      result = await this.service.configure(patch, rootUri);
    } catch {
      return;
    }
    for (const rejection of result.rejected) {
      this.messageService.warn(
        nls.localize(
          'ai-focused-editor/narrative-memory/configure-rejected',
          'Setting "{0}" was refused: {1}',
          rejection.key,
          rejection.reason
        )
      );
    }
    for (const deferral of result.deferred) {
      this.messageService.info(
        nls.localize(
          'ai-focused-editor/narrative-memory/configure-deferred',
          'Setting "{0}" will take effect at the next backend start.',
          deferral.key
        )
      );
    }
  }
}
