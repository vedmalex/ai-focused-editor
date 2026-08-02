import { DisposableCollection } from '@theia/core/lib/common';
import URI from '@theia/core/lib/common/uri';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { ContributionProvider } from '@theia/core/lib/common/contribution-provider';
import { PreferenceService } from '@theia/core/lib/common/preferences';
import { nls } from '@theia/core/lib/common/nls';
import { inject, injectable, named } from '@theia/core/shared/inversify';
import { EditorManager } from '@theia/editor/lib/browser/editor-manager';
import type { EditorWidget } from '@theia/editor/lib/browser/editor-widget';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import * as monaco from '@theia/monaco-editor-core';
import { MonacoEditor } from '@theia/monaco/lib/browser/monaco-editor';
import { parse as parseYaml } from 'yaml';
import { flattenManifestRows } from '../../common/book-config-forms';
import {
  isChapterProse,
  isMarkdownProse,
  manifestChapterBasenames
} from '../../common/typography/scope-predicate';
import {
  TextRange,
  TypographyRule
} from '../../common/typography/typography-types';
import {
  TYPOGRAPHY_ENABLED_KEY,
  TYPOGRAPHY_SCOPE_KEY,
  TypographyScope,
  ruleEnabledKey
} from '../../common/typography/typography-rule-contribution';
import { TypographyEngine, dropEditsBeyondLine } from '../../common/typography/typography-engine';
import {
  resolveRequiredLookahead,
  resolveRequiredLookback
} from '../../common/typography/typography-rules';
import { TypographyMonacoAdapter } from './typography-monaco-adapter';

/** Coalesce keystroke bursts into one typography pass per window (Q5). */
export const TYPOGRAPHY_TYPE_DEBOUNCE_MS = 200;

/**
 * BASELINE look-back included in the context window above the changed range.
 *
 * F-CR-4: this is now a FLOOR, not the whole answer. A rule declares the
 * look-back it needs as data (`TypographyRule.requiredLookbackLines`) and
 * {@link AutoTypographyContribution.currentLookbackLines} takes the MAXIMUM over
 * the enabled rules, so a rule that needs more context gets it without anyone
 * editing this constant — and a rule's stated need can no longer silently
 * disagree with the window it is actually handed.
 *
 * The floor is kept deliberately: it is the historical window size, so rules
 * that declare nothing keep seeing exactly the context they see today. Lowering
 * it is a behaviour change (a smaller window means a rule sees fewer lines to
 * edit), not a cleanup.
 */
export const CONTEXT_LOOKBACK_LINES = 2;

/** The book-root marker file walked up to for the `chapters` scope (§1.3). */
const MANIFEST_FILE = 'manifest.yaml';

/**
 * How many parent directories to climb from an editor's file looking for
 * {@link MANIFEST_FILE}. A book folder holds chapters at most a few levels deep
 * (`content/part-01/chapter-02.md`), so a small bound both finds the manifest
 * and stops the walk well before the filesystem root.
 */
const MANIFEST_WALK_MAX_DEPTH = 8;

/**
 * A debounced typography pass request. `changedRange` is the region the trigger
 * touched (a keystroke's changed range, or a paste's inserted range); when
 * absent the pass falls back to the whole-caret point (composition end / the
 * initial attach). `trigger` becomes `ctx.trigger` so rules can distinguish an
 * incremental keystroke from a paste.
 */
interface ScheduledPass {
  readonly trigger: 'type' | 'paste';
  readonly changedRange?: TextRange;
}

/** The resolved value space of Monaco's `autoClosingQuotes` editor option. */
type AutoClosingQuotes = 'always' | 'languageDefined' | 'beforeWhitespace' | 'never';

/** Per-editor tracking state. */
interface EditorState {
  readonly control: monaco.editor.IStandaloneCodeEditor;
  readonly disposables: DisposableCollection;
  /**
   * Q7 / ISS-244: true only once we have ACTUALLY written
   * `autoClosingQuotes: 'never'` onto this editor — i.e. after a pass cleared the
   * precise scope gate. Files that never enter scope (`notes.md`, `README.md`)
   * keep the user's auto-closer untouched, and untrack restores nothing.
   */
  quotesSuppressed?: boolean;
  /**
   * The option value read immediately BEFORE our first suppression, kept only so
   * restore can put it back. Undefined while {@link quotesSuppressed} is false —
   * we never read (and therefore never re-write) an option we did not change.
   */
  previousAutoClosingQuotes?: AutoClosingQuotes;
  /**
   * Chapter basenames from the enclosing book's `manifest.yaml`, resolved once
   * (async) at track time and cached here (§1.3). `undefined` until resolved (or
   * when the file is in no book); the `chapters` gate then relies on front matter
   * alone. Manifest membership is the authoritative signal for chapters that
   * carry no `type: chapter` front matter (the sample-book case).
   */
  manifestBasenames?: readonly string[];
  /**
   * IME composition guard for THIS editor: true between its own
   * `onDidCompositionStart` and `onDidCompositionEnd`.
   *
   * F-CR-7 — this used to be a field on the CONTRIBUTION, which is a singleton
   * across every open editor, and it was cleared only by the composition-end
   * listener registered in one editor's disposables. Closing a tab mid-composition
   * (an IME popup is open, the user hits Cmd+W) therefore disposed that listener
   * before it ever fired and left the flag stuck `true` FOREVER: `applyAt`
   * returned on its first line for every editor, so live typography was silently
   * dead until the application restarted, with no error and nothing to see. The
   * lesser sibling of the same bug was cross-talk — composing in one editor
   * suppressed passes in all the others.
   *
   * Per-editor state fixes both: a disposed editor takes its guard with it, and
   * `untrack` clears it belt-and-braces.
   */
  composing?: boolean;
}

/**
 * Live auto-typography seam (TASK-019 §2). Mirrors `LiveValidationContribution`'s
 * editor-tracking + debounce shape, but instead of publishing markers it drives
 * the pure {@link TypographyEngine} over the changed line window and writes the
 * resulting edits back through {@link TypographyMonacoAdapter} as discrete undo
 * steps.
 *
 * W1a scope: the `type` path is fully wired for rule #38 (the probe). Paste and
 * composition are handled at the guard level (a paste triggers a full pass; IME
 * composition suppresses passes) — the richer paste-range handling lands in W1b.
 */
@injectable()
export class AutoTypographyContribution implements FrontendApplicationContribution {
  @inject(EditorManager)
  protected readonly editorManager!: EditorManager;

  @inject(PreferenceService)
  protected readonly preferenceService!: PreferenceService;

  @inject(TypographyEngine)
  protected readonly engine!: TypographyEngine;

  @inject(TypographyMonacoAdapter)
  protected readonly adapter!: TypographyMonacoAdapter;

  @inject(ContributionProvider) @named(TypographyRule)
  protected readonly ruleProvider!: ContributionProvider<TypographyRule>;

  @inject(FileService)
  protected readonly fileService!: FileService;

  protected readonly toDispose = new DisposableCollection();
  protected readonly editorStates = new Map<EditorWidget, EditorState>();
  protected readonly pendingPasses = new Map<EditorWidget, ReturnType<typeof setTimeout>>();
  /**
   * Per-book manifest cache keyed by book-root URI string. The manifest is
   * parsed once per book (not per keystroke, not per editor): every chapter of
   * the same book shares one resolved basename set.
   */
  protected readonly manifestCache = new Map<string, Promise<readonly string[]>>();

  /**
   * Recursion guard: true while we are applying our own edits (§2).
   *
   * DELIBERATELY CONTRIBUTION-SCOPED, unlike the per-editor composition guard
   * (F-CR-7). It protects GLOBAL re-entrancy of the write path: `applyEdits` is
   * synchronous and monaco echoes our own write back as a content change on the
   * same call stack, so the flag is set and cleared inside one `try/finally`
   * with no `await` in between. It is therefore never observable as `true`
   * outside that stack frame, cannot be stranded by a disposed editor, and does
   * not need per-editor keying. (Making it per-editor would additionally lose
   * the protection if a rule's write ever caused a change in another model.)
   */
  protected applyingOwnEdit = false;
  /** The set of currently-enabled rule ids (recomputed on preference change). */
  protected enabledIds: ReadonlySet<string> = new Set();

  onStart(): void {
    this.recomputeEnabled();
    this.toDispose.push(this.editorManager.onCurrentEditorChanged(widget => this.trackEditor(widget)));
    this.toDispose.push(this.preferenceService.onPreferenceChanged(change => {
      if (change.preferenceName.startsWith('aiFocusedEditor.typography.')) {
        this.recomputeEnabled();
      }
    }));
    this.trackEditor(this.editorManager.currentEditor ?? this.editorManager.activeEditor);
  }

  onStop(): void {
    for (const widget of [...this.editorStates.keys()]) {
      this.untrack(widget);
    }
    this.toDispose.dispose();
  }

  /**
   * The enabled rule-id set (master + per-rule toggles), recomputed fresh from
   * preferences. Exposed so the batch commands run the SAME rule set the live
   * seam does (UR-006) without duplicating the master/per-rule resolution.
   */
  getEnabledRuleIds(): ReadonlySet<string> {
    this.recomputeEnabled();
    return this.enabledIds;
  }

  /** The current single-segment locale tag (e.g. `ru`), for the batch commands. */
  getLocale(): string {
    return this.currentLocale();
  }

  /**
   * Recompute the enabled rule-id set from preferences (master + per-rule).
   *
   * F-D5-2: `applyAt` bails out BEFORE the scope gate whenever `enabledIds` is
   * empty (~line 325), so that early exit never reaches the `restoreAutoClosingQuotes`
   * call in the out-of-scope branch. Without this, turning the master toggle off
   * (or disabling every rule) while a chapter's quote auto-closer was already
   * suppressed left `autoClosingQuotes: 'never'` stuck until the editor closed —
   * the auto-closer looked "broken" with no visible cause. Restoring here, for
   * every tracked editor, the moment the enabled set becomes empty closes that
   * gap. Turning rules back on does NOT eagerly re-suppress: suppression only
   * ever happens inside `applyAt` after a pass clears the scope gate (ISS-244).
   */
  protected recomputeEnabled(): void {
    const masterOn = this.preferenceService.get<boolean>(TYPOGRAPHY_ENABLED_KEY, true) !== false;
    if (!masterOn) {
      this.enabledIds = new Set();
      this.restoreAllSuppressedQuotes();
      return;
    }
    const ids = new Set<string>();
    for (const rule of this.ruleProvider.getContributions()) {
      const enabled = this.preferenceService.get<boolean>(ruleEnabledKey(rule.id), rule.defaultEnabled) !== false;
      if (enabled) {
        ids.add(rule.id);
      }
    }
    this.enabledIds = ids;
    if (ids.size === 0) {
      this.restoreAllSuppressedQuotes();
    }
  }

  /**
   * Give the auto-closer back on every tracked editor that currently has it
   * suppressed. Called when `enabledIds` transitions to empty (master toggle
   * off, or every rule disabled) — see {@link recomputeEnabled}. A no-op per
   * editor that was never suppressed ({@link restoreAutoClosingQuotes} already
   * guards on `quotesSuppressed`).
   */
  protected restoreAllSuppressedQuotes(): void {
    for (const state of this.editorStates.values()) {
      this.restoreAutoClosingQuotes(state);
    }
  }

  protected trackEditor(widget: EditorWidget | undefined): void {
    if (!widget || this.editorStates.has(widget)) {
      return;
    }
    // Coarse attach filter: only markdown prose can ever be in-scope (both the
    // `chapters` and `all-md` scopes are markdown); the precise chapter gate is
    // re-checked per pass in `applyAt` (front matter can change mid-edit).
    if (!isMarkdownProse(widget.editor.uri.path.toString())) {
      return;
    }
    const monacoEditor = MonacoEditor.get(widget);
    const control = monacoEditor?.getControl();
    if (!control) {
      return;
    }

    const disposables = new DisposableCollection();
    // Q7 / ISS-244: quote auto-closing is NOT suppressed here. Attaching is only
    // the coarse "is markdown" filter; the precise scope gate runs per pass in
    // `applyAt`. Suppressing at attach time would strip the auto-closer from
    // every out-of-scope markdown file (notes.md, README.md) where no rule ever
    // runs — a pure regression. See {@link suppressAutoClosingQuotes}.
    const state: EditorState = { control, disposables };
    this.editorStates.set(widget, state);

    // §1.3: resolve manifest membership once, off the keystroke path. Until it
    // resolves the `chapters` gate leans on front matter; a manifest-listed
    // chapter with no `type: chapter` front matter (the sample-book layout) then
    // starts matching as soon as this settles.
    void this.resolveManifestBasenames(widget, state);

    disposables.push(control.onDidChangeModelContent(event => {
      if (this.applyingOwnEdit || state.composing) {
        return;
      }
      // DEFECT-2 / UR-003: a change produced by undo, redo, or a full model
      // flush must NOT schedule a pass. Otherwise the debounced pass re-applies
      // the very auto-fix the user just reverted, so one Cmd+Z appears to do
      // nothing (the discrete undo step exists — it is immediately clobbered).
      if (event.isUndoing || event.isRedoing || event.isFlush) {
        return;
      }
      this.schedulePass(widget, { trigger: 'type', changedRange: this.adapter.readChangedRange(event) });
    }));
    disposables.push(control.onDidCompositionStart(() => { state.composing = true; }));
    disposables.push(control.onDidCompositionEnd(() => {
      state.composing = false;
      this.schedulePass(widget, { trigger: 'type' });
    }));
    disposables.push(control.onDidPaste(event => {
      // W1b: run the pass over the EXACT pasted range (with the standard
      // look-back), not a whole-caret point — a multi-line paste must be fully
      // covered. The write still lands as one discrete undo element (§2), so a
      // single Ctrl+Z reverts the whole paste's auto-fixes together.
      this.schedulePass(widget, { trigger: 'paste', changedRange: this.rangeFromMonaco(event.range) });
    }));
    disposables.push(widget.onDispose(() => this.untrack(widget)));
  }

  protected untrack(widget: EditorWidget): void {
    const state = this.editorStates.get(widget);
    if (!state) {
      return;
    }
    this.cancelScheduledPass(widget);
    this.restoreAutoClosingQuotes(state);
    // Belt-and-braces (F-CR-7): the state object is dropped from the map on the
    // next line, so this matters only for a caller still holding a reference —
    // but leaving a "composition in progress" flag set on a torn-down editor is
    // precisely the stranded-guard shape this fix exists to remove.
    state.composing = false;
    state.disposables.dispose();
    this.editorStates.delete(widget);
  }

  /**
   * Q7 / ISS-244: take over Monaco's quote auto-closing, LAZILY and idempotently.
   * Called only from the in-scope branch of {@link applyAt}, so a markdown file
   * that never clears the scope gate keeps the user's auto-closer. The prior
   * value is captured here — immediately before the first write — so
   * {@link restoreAutoClosingQuotes} can put back exactly what was in effect.
   */
  protected suppressAutoClosingQuotes(state: EditorState): void {
    if (state.quotesSuppressed) {
      return;
    }
    state.previousAutoClosingQuotes = state.control.getOption(monaco.editor.EditorOption.autoClosingQuotes);
    state.control.updateOptions({ autoClosingQuotes: 'never' });
    state.quotesSuppressed = true;
  }

  /**
   * Give the auto-closer back — on untrack, and whenever a pass finds the editor
   * has LEFT our scope (front matter edited away from `type: chapter`).
   *
   * ISS-244: "not touched -> not restored". `getOption` always resolves to a
   * concrete value, so unconditionally writing it back would pin the resolved
   * default as an explicit setting on editors we never suppressed. We therefore
   * write only when we actually suppressed, and even then only when the captured
   * value differs from the `'never'` we installed (writing `'never'` over
   * `'never'` would be a pointless re-pin).
   */
  protected restoreAutoClosingQuotes(state: EditorState): void {
    if (!state.quotesSuppressed) {
      return;
    }
    const previous = state.previousAutoClosingQuotes;
    state.quotesSuppressed = false;
    state.previousAutoClosingQuotes = undefined;
    if (previous === undefined || previous === 'never') {
      return;
    }
    if (state.control.getModel()?.isDisposed?.()) {
      return;
    }
    state.control.updateOptions({ autoClosingQuotes: previous });
  }

  protected schedulePass(widget: EditorWidget, pass: ScheduledPass): void {
    this.cancelScheduledPass(widget);
    this.pendingPasses.set(widget, setTimeout(() => {
      this.pendingPasses.delete(widget);
      this.applyAt(widget, pass);
    }, TYPOGRAPHY_TYPE_DEBOUNCE_MS));
  }

  protected cancelScheduledPass(widget: EditorWidget): void {
    const pending = this.pendingPasses.get(widget);
    if (pending !== undefined) {
      clearTimeout(pending);
      this.pendingPasses.delete(widget);
    }
  }

  /**
   * The synchronous read -> compute -> apply pass. No `await` between reading
   * the buffer and writing back, so there is no drift window (the adapter's
   * getValueInRange drift guard is belt-and-braces).
   */
  protected applyAt(widget: EditorWidget, pass: ScheduledPass): void {
    if (this.enabledIds.size === 0) {
      return;
    }
    const state = this.editorStates.get(widget);
    if (!state) {
      return;
    }
    // F-CR-7: the composition guard is read from THIS editor's state. A stuck
    // guard on some other (possibly already closed) editor must never stop this
    // one from running.
    if (state.composing) {
      return;
    }
    const control = state.control;
    const model = control.getModel();
    if (!model) {
      return;
    }

    // Q6: never rewrite under a multi-cursor or a non-empty selection.
    const selections = control.getSelections();
    if (!selections || selections.length !== 1 || !selections[0].isEmpty()) {
      return;
    }

    // Precise scope gate (re-read front matter from the live buffer).
    const uriPath = widget.editor.uri.path.toString();
    const scope = this.currentScope();
    const inScope = scope === 'all-md'
      ? isMarkdownProse(uriPath)
      : isChapterProse(uriPath, {
        frontMatterType: this.adapter.readFrontMatterType(model),
        manifestBasenames: state.manifestBasenames
      });
    if (!inScope) {
      // ISS-244: the editor is (or has become) out of scope — if we previously
      // took the auto-closer over, hand it straight back.
      this.restoreAutoClosingQuotes(state);
      return;
    }
    // In scope for real: NOW suppress Monaco quote auto-closing (Q7), so a
    // guillemet rule (#34/#35) never fights the auto-closer. Idempotent.
    this.suppressAutoClosingQuotes(state);

    const changedRange = pass.changedRange ?? this.wholeCaretRange(control);
    const cursorPosition = control.getPosition();
    const cursor = cursorPosition
      ? { line: cursorPosition.lineNumber, column: cursorPosition.column }
      : changedRange.start;

    const context = this.adapter.buildContext(model, {
      changedRange,
      cursor,
      trigger: pass.trigger,
      locale: this.currentLocale(),
      windowStart: changedRange.start.line - this.currentLookbackLines(),
      // F-CR2-1: the window extends PAST the changed range by whatever look-ahead
      // the enabled rules declare, so a rule that inspects its successor line
      // (`paragraph-leading-hyphen-to-em-dash`: is the line below a list item?)
      // actually receives it. Overshooting the end of the document is safe — the
      // adapter clamps with `Math.min(lineCount, windowEnd)`.
      windowEnd: changedRange.end.line + this.currentLookaheadLines()
    });

    // …but the widened lines are CONTEXT ONLY. The window is also the editable
    // region, so without this clamp the look-ahead would silently license every
    // enabled rule to rewrite lines the user never touched. The write set stays
    // exactly what it was before the widening (see `dropEditsBeyondLine`).
    const edits = dropEditsBeyondLine(
      this.engine.computeEdits(context, this.enabledIds),
      changedRange.end.line
    );
    if (edits.length === 0) {
      return;
    }

    this.applyingOwnEdit = true;
    try {
      this.adapter.applyEdits(model, edits);
    } finally {
      this.applyingOwnEdit = false;
    }
  }

  /**
   * How many lines of look-back the context window must carry for the CURRENTLY
   * ENABLED rules (F-CR-4): the {@link CONTEXT_LOOKBACK_LINES} baseline, widened
   * to the largest `requiredLookbackLines` any enabled rule declares.
   *
   * Aggregating over the ENABLED set (not the whole registry) means a
   * context-hungry rule the user has switched off costs nothing.
   */
  protected currentLookbackLines(): number {
    return Math.max(
      CONTEXT_LOOKBACK_LINES,
      resolveRequiredLookback(this.ruleProvider.getContributions(), this.enabledIds)
    );
  }

  /**
   * How many lines BELOW the changed range the context window must carry for the
   * CURRENTLY ENABLED rules (F-CR2-1).
   *
   * NO BASELINE, unlike {@link currentLookbackLines}: the forward window was
   * historically zero, so the aggregate alone decides. With no look-ahead-declaring
   * rule enabled this returns 0 and the window ends exactly where it always did —
   * the fix costs nothing when it is not needed.
   */
  protected currentLookaheadLines(): number {
    return resolveRequiredLookahead(this.ruleProvider.getContributions(), this.enabledIds);
  }

  protected currentScope(): TypographyScope {
    const value = this.preferenceService.get<string>(TYPOGRAPHY_SCOPE_KEY, 'chapters');
    return value === 'all-md' ? 'all-md' : 'chapters';
  }

  protected currentLocale(): string {
    return (nls.locale ?? 'en').toLowerCase().split('-')[0];
  }

  /**
   * DEFECT-1 / §1.3: resolve the editor's book manifest and record its chapter
   * basenames on the tracking state. Runs once per editor at track time (off the
   * keystroke path); the parsed manifest is shared per-book via
   * {@link manifestCache}. Silently no-ops when the file belongs to no book (no
   * enclosing `manifest.yaml`) — the `chapters` gate then relies on front matter.
   */
  protected async resolveManifestBasenames(widget: EditorWidget, state: EditorState): Promise<void> {
    const manifestUri = await this.findManifestUri(widget.editor.uri);
    if (!manifestUri) {
      return;
    }
    const bookRootKey = manifestUri.parent.toString();
    let pending = this.manifestCache.get(bookRootKey);
    if (!pending) {
      pending = this.readManifestBasenames(manifestUri);
      this.manifestCache.set(bookRootKey, pending);
    }
    const basenames = await pending;
    // The editor may have been untracked (or replaced) while awaiting; only
    // record onto the state that is still the live one for this widget.
    if (this.editorStates.get(widget) === state) {
      state.manifestBasenames = basenames;
    }
  }

  /**
   * Climb from `fileUri`'s directory looking for the enclosing book's
   * `manifest.yaml`, up to {@link MANIFEST_WALK_MAX_DEPTH} levels. Returns the
   * manifest URI, or undefined when the file is in no book.
   */
  protected async findManifestUri(fileUri: URI): Promise<URI | undefined> {
    let dir = fileUri.parent;
    for (let depth = 0; depth < MANIFEST_WALK_MAX_DEPTH; depth++) {
      const candidate = dir.resolve(MANIFEST_FILE);
      try {
        if (await this.fileService.exists(candidate)) {
          return candidate;
        }
      } catch {
        // Ignore probe errors and keep climbing; a missing book is a no-op.
      }
      const parent = dir.parent;
      if (parent.toString() === dir.toString()) {
        break; // reached the filesystem root
      }
      dir = parent;
    }
    return undefined;
  }

  /**
   * Read + parse a book `manifest.yaml` into the set of chapter basenames its
   * `content:` tree lists (folder/part entries and non-markdown rows dropped).
   * Failure (unreadable / malformed YAML) yields an empty list — the gate then
   * relies on front matter, never throwing on the track path.
   */
  protected async readManifestBasenames(manifestUri: URI): Promise<readonly string[]> {
    try {
      const text = (await this.fileService.read(manifestUri)).value;
      const parsed = parseYaml(text) as unknown;
      const paths = flattenManifestRows(parsed).map(row => row.path);
      return manifestChapterBasenames(paths);
    } catch {
      return [];
    }
  }

  private wholeCaretRange(control: monaco.editor.IStandaloneCodeEditor): TextRange {
    const position = control.getPosition() ?? { lineNumber: 1, column: 1 };
    const point = { line: position.lineNumber, column: position.column };
    return { start: point, end: point };
  }

  /** Convert a Monaco 1-based {@link monaco.IRange} to the pure {@link TextRange}. */
  private rangeFromMonaco(range: monaco.IRange): TextRange {
    return {
      start: { line: range.startLineNumber, column: range.startColumn },
      end: { line: range.endLineNumber, column: range.endColumn }
    };
  }
}
