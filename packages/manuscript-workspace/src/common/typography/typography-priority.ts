/**
 * The PRIORITY BANDS of the typography rule set (TASK-019 §3), as data.
 *
 * WHY THIS MODULE EXISTS (F-CR-5): the engine resolves two overlapping edits by
 * `priority` (desc), so a rule's number decides which rule's fix a user actually
 * sees. Those numbers used to be bare literals at each rule's definition site,
 * with the "bands" they belong to described only in prose in the rules' JSDoc.
 * Nothing checked that a rule's number matched the band its own comment claimed,
 * and — because every per-rule suite calls `apply()` DIRECTLY — nothing observed
 * the engine-level overlap drop either. A 15th rule given, say, `priority: 60`
 * would silently outrank every capitalization rule and evict their edits, and
 * the whole suite would stay green.
 *
 * So the bands are now DECLARED here and asserted in `typography-rules.test.ts`
 * (the "priority bands" describe — this module has no suite of its own; the
 * checks are registry-level by design, since they are statements about the
 * SHIPPED rule set rather than about the table in isolation)
 * against the canonical registry: a new rule must pick one of the named steps
 * below (or the band table must be extended deliberately), which makes the
 * ordering decision a visible, reviewed act instead of a typed-in number.
 *
 * ORDERING SEMANTICS: higher priority wins. The bands run low → high in the
 * order a text is normalised conceptually — first make the whitespace and
 * punctuation right, then the dashes and quotes that sit between words, then the
 * capitalization that depends on both being settled.
 *
 * The numeric VALUES are historical and deliberately unchanged: this module
 * renamed them, it did not renumber them. Changing a value here changes which
 * rule wins a conflict, i.e. it is a BEHAVIOUR change and needs its own
 * justification and test evidence.
 *
 * DOM/Theia-free by construction — consumed by the rule modules themselves.
 */

/* --------------------------------------------------------------------------
 * Band 1 — spacing & punctuation (10–25). The lowest band: these rules fix the
 * raw whitespace/punctuation skeleton every later band reads.
 * ----------------------------------------------------------------------- */

/** `collapse-multiple-spaces` — the most basic whitespace normalisation. */
export const PRIORITY_SPACING_WHITESPACE = 10;

/**
 * `period-after-double-space` — above {@link PRIORITY_SPACING_WHITESPACE} so a
 * double space becomes `. ` rather than being collapsed to a single space first.
 */
export const PRIORITY_SPACING_SENTENCE_BREAK = 15;

/** `no-space-before-punctuation`, `space-after-punctuation` — punctuation spacing. */
export const PRIORITY_SPACING_PUNCTUATION = 20;

/** `normalize-word-hyphenation` — top of the spacing band, below the dash band. */
export const PRIORITY_SPACING_HYPHENATION = 25;

/* --------------------------------------------------------------------------
 * Band 2 — dashes & quotes (30–40). Runs above spacing: an em-dash rule needs
 * the spaces around the hyphen already normalised.
 * ----------------------------------------------------------------------- */

/** `spaced-hyphen-to-em-dash`, `paragraph-leading-hyphen-to-em-dash`. */
export const PRIORITY_EM_DASH = 30;

/**
 * `opening-quote-to-guillemet`, `closing-quote-to-guillemet`. The two are
 * mutually exclusive on any given quote character (see `quote-shared.ts`), which
 * is precisely why they may SHARE a step without ever colliding.
 */
export const PRIORITY_GUILLEMET = 40;

/* --------------------------------------------------------------------------
 * Band 3 — capitalization (45–50). The highest band: which letter starts a
 * sentence depends on the punctuation and dashes below being settled first.
 * ----------------------------------------------------------------------- */

/**
 * `fix-double-capital-after-space`, `fix-double-capital-after-punctuation` — the
 * stutter-caps fixers. BELOW {@link PRIORITY_CAPITALIZATION_START} so that when a
 * start-capital rule and a fixer disagree about the same letter, the start rule
 * wins.
 */
export const PRIORITY_CAPITALIZATION_FIXUP = 45;

/**
 * `paragraph-start-capital`, `sentence-start-capital`, `dialogue-dash-capital` —
 * the "this position starts a sentence" family. They share a step because they
 * propose the SAME edit where they overlap (a paragraph-start dialogue line), so
 * the engine's dedupe resolves them without an ordering decision.
 */
export const PRIORITY_CAPITALIZATION_START = 50;

/** One declared band: a named range plus the exact steps rules may occupy in it. */
export interface PriorityBand {
  /** Stable band name, used in test failure messages. */
  readonly name: string;
  /** Inclusive lower bound of the band. */
  readonly min: number;
  /** Inclusive upper bound of the band. */
  readonly max: number;
  /**
   * The exact priority values a rule may use inside this band. Membership is
   * checked against THESE, not against `[min, max]`: an in-range-but-undeclared
   * number (e.g. `33`) is exactly the accidental hand-typed literal this module
   * exists to catch.
   */
  readonly steps: readonly number[];
}

/**
 * The complete band table. Every rule in the canonical registry MUST declare a
 * priority equal to one of the `steps` listed here — asserted in
 * `typography-rules.test.ts` ("priority bands — every rule sits in a DECLARED
 * band").
 *
 * Adding a rule that genuinely needs a NEW step is fine: add the named constant
 * above and list it here. The point is not to forbid new numbers, it is to make
 * introducing one a deliberate edit to this table rather than an invisible
 * literal in a rule file.
 */
export const PRIORITY_BANDS: readonly PriorityBand[] = [
  {
    name: 'spacing',
    min: 10,
    max: 25,
    steps: [
      PRIORITY_SPACING_WHITESPACE,
      PRIORITY_SPACING_SENTENCE_BREAK,
      PRIORITY_SPACING_PUNCTUATION,
      PRIORITY_SPACING_HYPHENATION
    ]
  },
  {
    name: 'dashes-quotes',
    min: 30,
    max: 40,
    steps: [PRIORITY_EM_DASH, PRIORITY_GUILLEMET]
  },
  {
    name: 'capitalization',
    min: 45,
    max: 50,
    steps: [PRIORITY_CAPITALIZATION_FIXUP, PRIORITY_CAPITALIZATION_START]
  }
];

/**
 * The band a priority belongs to, or `undefined` when the value is not a
 * declared step in ANY band (which the registry test treats as a failure).
 */
export function priorityBandOf(priority: number): PriorityBand | undefined {
  return PRIORITY_BANDS.find(band => band.steps.includes(priority));
}
