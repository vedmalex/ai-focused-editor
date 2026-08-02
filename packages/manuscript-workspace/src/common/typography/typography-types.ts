/**
 * Pure, Theia-free type model for the auto-typography engine (GitHub #30,
 * TASK-019). Everything here is data: no Monaco, no Theia-browser, no DOM — so
 * rules and the dispatch engine stay unit-testable without an editor.
 *
 * Coordinates are **1-based** (line and column), matching Monaco's
 * `IPosition`/`IRange` convention, so the browser seam can map a
 * {@link TypographyEdit} straight onto `model.pushEditOperations` without an
 * off-by-one translation.
 *
 * NOTE ON NAMING: this module deliberately keeps its own {@link Position} /
 * {@link TextRange} (1-based line/column) distinct from `common/text-range.ts`
 * (0-based line/character, LSP-style). The two never mix — typography types are
 * consumed by path (`common/typography/*`) and are NOT re-exported from the
 * package `common` barrel, so there is no symbol collision.
 */

/** A 1-based line/column caret position (Monaco `IPosition` convention). */
export interface Position {
  /** 1-based line number. */
  readonly line: number;
  /** 1-based column (a caret sits *before* the character at this column). */
  readonly column: number;
}

/** A half-open 1-based text range: `start` inclusive, `end` exclusive-of-caret. */
export interface TextRange {
  readonly start: Position;
  readonly end: Position;
}

/**
 * The classification of a run of characters on a line. Only {@link TokenKind.Text}
 * is eligible for typography edits; the code/comment kinds are skipped so the
 * engine never rewrites literal source, inline code, or comment bytes.
 */
export enum TokenKind {
  /** Ordinary prose — the only kind a rule is allowed to edit. */
  Text = 'text',
  /** Fenced or indented code block content. */
  Code = 'code',
  /** Inline `` `code` `` span content (backtick pair). */
  InlineCode = 'inline-code',
  /** A comment token (secondary Monaco refinement only). */
  Comment = 'comment'
}

/**
 * One classified column span on a line. Columns are 1-based; `endColumn` is
 * exclusive (a token covering the single character at column 3 has
 * `startColumn: 3, endColumn: 4`).
 */
export interface LineToken {
  readonly startColumn: number;
  readonly endColumn: number;
  readonly kind: TokenKind;
}

/**
 * An immutable snapshot of one line handed to a rule: its 1-based line number,
 * full text, the classified non-prose spans on it (inline code, comments), and
 * whether the WHOLE line is code (fenced/indented block). Rules read `isCode`
 * to skip a line wholesale and `tokens` to skip inline spans within a prose
 * line.
 */
export interface LineSnapshot {
  readonly lineNumber: number;
  readonly text: string;
  /** Non-prose spans on this line (inline code, comments). Empty for plain prose. */
  readonly tokens: readonly LineToken[];
  /** True when the entire line is inside a code block (fence or ≥4-space indent). */
  readonly isCode: boolean;
}

/**
 * The read-only context a rule's `apply` receives. `lines` is a contiguous
 * window (the changed lines plus a small look-back) so context-sensitive rules
 * can see preceding prose; `changedRange` marks what the last edit touched;
 * `cursor` is the caret; `locale` drives locale-aware rules (e.g. guillemets);
 * `trigger` distinguishes an incremental keystroke from a paste or a batch run.
 */
export interface TypographyContext {
  readonly lines: readonly LineSnapshot[];
  readonly changedRange: TextRange;
  readonly cursor: Position;
  /** BCP-47-ish locale tag (e.g. `ru`, `en`), lower-cased. */
  readonly locale: string;
  readonly trigger: 'type' | 'paste' | 'batch';
}

/**
 * A single replacement a rule proposes: replace the text currently in `range`
 * with `text`, attributed to `ruleId` (used for conflict tie-breaking and undo
 * labelling).
 *
 * NO CARET FIELD (ISS-247): the contract briefly carried a `cursorHint?:
 * Position` that no rule ever set and no seam ever read — a dead abstraction
 * that read as caret handling while providing none. It is gone because the
 * §5.5 risk it was meant to cover does not arise: every rule's edit is a
 * single-character insertion or in-place replacement, and Monaco's own
 * `pushEditOperations` keeps the caret correct across those. Should a rule ever
 * need to move the caret deliberately, add the field back TOGETHER with the
 * seam code that honours it.
 */
export interface TypographyEdit {
  readonly range: TextRange;
  readonly text: string;
  readonly ruleId: string;
}

/**
 * A typography rule as DATA (rules-as-data, UR-002): a stable `id` (the
 * preference key is derived from it and MUST never change), nls keys for the
 * settings UI, a default toggle state, a `priority` for deterministic conflict
 * resolution, and a PURE, IDEMPOTENT `apply`. `apply` returns the edits to make
 * (possibly empty), or `null` when it has nothing to say — both are treated the
 * same by the engine; `null` is a readability affordance.
 *
 * IDEMPOTENCE CONTRACT: running `apply` on the result of a previous `apply`
 * (same rule) must produce no further edits. The engine and the live seam both
 * rely on this to guarantee the recursion guard terminates.
 *
 * NO `titleKey` (F-CR-2, second application of the ISS-247 precedent recorded on
 * {@link TypographyEdit} above): the contract carried a REQUIRED `titleKey` that
 * all 14 rules implemented and 14 `*-title` entries translated, while the only
 * consumer of rule metadata — `buildTypographySchema` — read `descriptionKey`
 * alone. It was verified against Theia 1.73.1 itself that a per-property `title`
 * in a preference schema is never rendered: the Settings UI derives a leaf row's
 * visible label in `PreferenceTreeLabelProvider.getName()` from the LAST
 * dot-segment of the preference key (`…typography.<id>.enabled` → "Enabled"),
 * and `description` supplies only the secondary text below it. There was no way
 * to make the field live, so — exactly as with `cursorHint` — it is gone rather
 * than left looking like localization the user receives. Reintroduce it only
 * TOGETHER with a surface that actually renders it.
 */
export interface TypographyRule {
  /** Stable kebab-case identifier — the preference key stem. NEVER rename. */
  readonly id: string;
  /** nls key for the settings description. */
  readonly descriptionKey: string;
  /** Whether the rule is on by default when the user has set no preference. */
  readonly defaultEnabled: boolean;
  /**
   * Higher wins when two rules propose overlapping edits (see engine §1.6).
   * Declare it with a named band constant from `typography-priority.ts`, NOT a
   * bare literal — the band table is what keeps a new rule from silently
   * outranking an existing one.
   */
  readonly priority: number;
  /** True when the rule's behaviour depends on `ctx.locale`. */
  readonly localeAware?: boolean;
  /**
   * How many lines ABOVE the changed range this rule needs to see in
   * `ctx.lines` to decide correctly (F-CR-4). Omitted/0 = the rule is
   * line-local.
   *
   * A rule that inspects its predecessor line — `paragraph-start-capital` (is
   * the line above blank, i.e. does a paragraph start here?) and
   * `paragraph-leading-hyphen-to-em-dash` (is the line above a list item?) —
   * declares `1`. Every driver that builds a window aggregates the MAXIMUM over
   * the enabled rules (`resolveRequiredLookback`), so the window is derived from
   * declared needs instead of a private constant in the browser seam that no
   * rule could see and no test pinned.
   *
   * A rule whose look-back is not satisfied MUST stay conservative and emit
   * nothing rather than guess — declaring a value here is a request, and this
   * field never relieves the rule of its own visibility guard.
   */
  readonly requiredLookbackLines?: number;
  /**
   * How many lines BELOW the changed range this rule needs to see in
   * `ctx.lines` to decide correctly (F-CR2-1). Omitted/0 = the rule never looks
   * forward.
   *
   * The exact mirror of {@link requiredLookbackLines}, and it exists because the
   * one-directional contract hid a real defect. `paragraph-leading-hyphen-to-em-dash`
   * reads BOTH neighbours (a leading `- ` next to a list item is a bullet, not a
   * dialogue dash), yet it could only declare the look-BACK half. The live seam
   * built its window as `[changedRange.start - lookback, changedRange.end]`, so on
   * the last line of the window `ctx.lines[idx + 1]` was ALWAYS `undefined` and
   * the forward half of the guard was dead: typing `- пункт` directly ABOVE an
   * existing list silently converted the bullet into an em dash and broke the
   * Markdown list.
   *
   * ASYMMETRY OF COST — why this direction is the dangerous one. A rule denied
   * its look-BACK stays conservative and emits NOTHING (a missed fix). A rule
   * denied its look-AHEAD sees `undefined`, reads it as "no list below", and
   * emits a WRONG edit. Absence of context is not neutral here, which is why a
   * declared value must actually be honoured by every driver that builds a
   * window.
   *
   * CONTEXT ONLY, NEVER WRITE SURFACE: a driver widens the SNAPSHOT by this
   * amount but must NOT let rules edit the extra lines — see
   * `dropEditsBeyondLine` in `typography-engine.ts`. The window doubles as the
   * editable region (the root of ISS-272), so widening it naively would hand
   * rules the right to rewrite lines below the one the user just touched.
   */
  readonly requiredLookaheadLines?: number;
  /** Pure, idempotent transformation: the edits to apply, or `null` for none. */
  apply(ctx: TypographyContext): TypographyEdit[] | null;
}

/**
 * DI token for a {@link TypographyRule} contribution (Theia
 * `ContributionProvider` pattern). Value/type declaration-merge: the same name
 * is the interface (type space) and this symbol (value space), exactly like
 * Theia's own `ContributionProvider`.
 */
export const TypographyRule = Symbol('TypographyRule');
