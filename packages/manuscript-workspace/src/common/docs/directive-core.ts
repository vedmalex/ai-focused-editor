/**
 * The SINGLE directive parser in this codebase (tech_spec §A, WP-A).
 *
 * The guide pages of the Welcome screen are plain `.md` carrying a small
 * directive dialect: `:action[Открыть]{command="…"}` and friends. Two very
 * different consumers read that dialect — the build-time generator (which must
 * FAIL a build on a typo) and the runtime renderer (which must DEGRADE, never
 * throw). Both call this module; neither owns a second grammar. That single
 * ownership is the point of WP-A: two parsers would drift, and a drift here is
 * silently-dead buttons on a page the user was told to trust.
 *
 * GRAMMAR (§A.1-§A.3) — three forms, all deliberate SUBSETS of
 * remark-directive so the eventual MDX migration (UR-010) replaces the
 * implementation without rewriting a single `.md`:
 *
 *   inline     `:NAME[LABEL]{ATTRS}`      inside a paragraph, no children
 *   leaf       `::NAME[LABEL]{ATTRS}`     alone on its own line
 *   container  `:::NAME{ATTRS}` … `:::`   block level, markdown children
 *
 * Attribute values are DOUBLE-QUOTED ONLY, with exactly two escapes (`\"`,
 * `\\`); labels are plain text with exactly two escapes (`\]`, `\\`). Anything
 * else — `key=value`, `key='v'`, `#id`, `.cls`, a stray `\n` — is rejected
 * rather than guessed, because a guess would be a place where our reading and
 * remark's reading could differ.
 *
 * NEVER THROWS (§A.4). {@link parseDirective} returns a discriminated result;
 * the CALLER picks the policy:
 *
 *   - generator (build time): `!result.ok || result.warnings.length > 0` ⇒ fail
 *     the build with `<file>:<line>:<col>` composed from `position`;
 *   - renderer (runtime): `!result.ok` ⇒ emit the source text as-is + warn;
 *     `warnings` ⇒ render anyway + warn.
 *
 * The two-channel shape is not decoration — it is what the §A.4 asymmetry
 * table requires. Three of its seven rows (unknown attribute, bad `icon`,
 * markdown metacharacter in a label) say the RUNTIME still renders the
 * directive and only drops/warns about the offending part. Those rows cannot
 * be expressed by `ok: false`, which throws away the parsed node. So they come
 * back as {@link ParsedDirective} + {@link DirectiveDiagnostic}s in
 * `warnings`, with the offending attribute already removed from `attributes`
 * (`иконка не выводится`). Every other row is `ok: false`. §F.5 calls the bad
 * `icon` "ошибка ещё в parse" and §A.4 calls it a runtime warning; both hold
 * here — it is DETECTED at parse time and REPORTED as a warning with the
 * attribute stripped, so the renderer can never emit a bad icon class. Making
 * it `ok: false` instead would leave §A.4's runtime column unimplementable.
 *
 * WHOLE-PAGE SCANNING lives here too ({@link scanDirectives}) rather than in
 * the generator and the renderer separately. They would not have diverged on
 * the grammar — they would have diverged on the EDGES: what counts as an
 * occurrence inside a code fence, how a colon in ordinary prose is told apart
 * from a mistyped directive. Those edges are decided once, below.
 */

/** The three forms of §A.1. */
export type DirectiveForm = 'inline' | 'leaf' | 'container';

/**
 * Machine-readable classification of a finding. Codes are stable — tests and
 * the generator's teeth assert on them; the human `message` is free to change.
 */
export type DirectiveDiagnosticCode =
  /* fatal: `ok: false` */
  | 'not-a-directive'
  | 'invalid-name'
  | 'unknown-directive'
  | 'invalid-form'
  | 'not-own-line'
  | 'trailing-content'
  | 'label-not-allowed'
  | 'unterminated-label'
  | 'invalid-escape'
  | 'space-before-label'
  | 'space-before-attributes'
  | 'unterminated-attributes'
  | 'invalid-attribute-syntax'
  | 'duplicate-attribute'
  | 'missing-attribute'
  | 'ambiguous-label'
  | 'unclosed-container'
  | 'nested-container'
  /* degradable: `ok: true` + `warnings` */
  | 'unknown-attribute'
  | 'invalid-attribute-value'
  | 'label-metacharacter';

/** A source position; `line`/`column` are 1-based, for `<file>:<line>:<col>`. */
export interface DirectivePosition {
  /** Zero-based offset into the `source` string handed to the parser. */
  readonly offset: number;
  readonly line: number;
  readonly column: number;
}

/** One finding — fatal when returned as the error, degradable when in `warnings`. */
export interface DirectiveDiagnostic {
  readonly code: DirectiveDiagnosticCode;
  /**
   * The finding without any location prefix: callers compose
   * `docs-gen: ${message} at ${file}:${line}:${col}` themselves (§A.4).
   */
  readonly message: string;
  readonly position: DirectivePosition;
}

/** Declared shape of one attribute of one directive (§A.6). */
export interface DirectiveAttributeSpec {
  /** A missing required attribute is FATAL (§A.4 row 2). */
  readonly required: boolean;
  /**
   * Value constraint. A violation is DEGRADABLE (§A.4 row 6): the attribute is
   * dropped and a `invalid-attribute-value` warning is raised — the runtime
   * then simply renders no icon instead of losing the whole card.
   */
  readonly pattern?: RegExp;
  /** Why the attribute exists — read by humans, not by code. */
  readonly description: string;
}

/** One row of the six-directive registry (§A.6). */
export interface DirectiveSpec {
  readonly name: string;
  /** Forms this directive may be written in; any other form is fatal. */
  readonly forms: readonly DirectiveForm[];
  readonly attributes: Readonly<Record<string, DirectiveAttributeSpec>>;
}

/** A successfully parsed directive occurrence. */
export interface ParsedDirective {
  readonly name: string;
  readonly form: DirectiveForm;
  /**
   * Decoded `[LABEL]` (escapes resolved), or `undefined` when absent.
   * Always PLAIN TEXT: never parsed as inline markdown — that is exactly the
   * divergence §A.5 п.5 closes with the metacharacter rule.
   */
  readonly label?: string;
  /**
   * Decoded attribute values, keyed by attribute name. Attributes that failed
   * their `pattern` are ABSENT here and reported in `warnings`; unknown
   * attributes are likewise absent.
   */
  readonly attributes: Readonly<Record<string, string>>;
  /** Raw markdown between the container fences; `undefined` for inline/leaf. */
  readonly body?: string;
  /** Offset of the leading `:` in the source handed to the parser. */
  readonly start: number;
  /** Offset just past the occurrence — a scanner resumes here. */
  readonly end: number;
}

/** `{ ok: true, … } | { ok: false, error, position }` of §A.4. */
export type ParseDirectiveResult =
  | {
      readonly ok: true;
      readonly directive: ParsedDirective;
      /** Degradable findings; a build-time caller treats any of them as fatal. */
      readonly warnings: readonly DirectiveDiagnostic[];
    }
  | {
      readonly ok: false;
      readonly code: DirectiveDiagnosticCode;
      readonly error: string;
      readonly position: DirectivePosition;
    };

const ICON_PATTERN = /^codicon-[a-z0-9-]+$/;

/**
 * The six directives of §2 of the design — normative, not extensible at
 * runtime. A seventh name is a build failure, which is the whole reason the
 * set is a closed whitelist rather than an open convention.
 */
export const DIRECTIVE_REGISTRY: Readonly<Record<string, DirectiveSpec>> = {
  action: {
    name: 'action',
    forms: ['inline', 'leaf'],
    attributes: {
      command: { required: true, description: 'Theia command id executed on click.' },
      label: { required: false, description: 'Button caption when there is no [LABEL].' }
    }
  },
  settings: {
    name: 'settings',
    forms: ['inline', 'leaf'],
    attributes: {
      query: { required: true, description: 'Search string handed to `preferences:open`.' },
      label: { required: false, description: 'Button caption when there is no [LABEL].' }
    }
  },
  doc: {
    name: 'doc',
    forms: ['inline'],
    attributes: {
      page: { required: true, description: 'Guide page id to navigate to inside the widget.' }
    }
  },
  scenario: {
    name: 'scenario',
    forms: ['container'],
    attributes: {
      /**
       * REQUIRED although the design table does not mark it so (§A.6
       * "РЕШЕНИЕ"): a scenario card with no destination has no behaviour and
       * lands straight in the dead-button class the whole three-line contract
       * exists to prevent. The design edit is queued in §G.5.
       */
      page: { required: true, description: 'Target guide page of the scenario card.' },
      icon: {
        required: false,
        pattern: ICON_PATTERN,
        description: 'Codicon name; defaults to `codicon-book` when absent.'
      }
    }
  },
  steps: {
    name: 'steps',
    forms: ['container'],
    attributes: {
      id: { required: true, description: 'Persistent checklist key within the page.' }
    }
  },
  requires: {
    name: 'requires',
    forms: ['container'],
    attributes: {
      title: { required: false, description: 'Heading of the prerequisites block.' }
    }
  }
};

/** 1-based line/column for `offset` within `source`. */
export function positionAt(source: string, offset: number): DirectivePosition {
  const clamped = Math.max(0, Math.min(offset, source.length));
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < clamped; index++) {
    if (source.charCodeAt(index) === 10 /* \n */) {
      line++;
      lineStart = index + 1;
    }
  }
  return { offset: clamped, line, column: clamped - lineStart + 1 };
}

function fail(
  source: string,
  offset: number,
  code: DirectiveDiagnosticCode,
  message: string
): ParseDirectiveResult {
  return { ok: false, code, error: message, position: positionAt(source, offset) };
}

function diagnostic(
  source: string,
  offset: number,
  code: DirectiveDiagnosticCode,
  message: string
): DirectiveDiagnostic {
  return { code, message, position: positionAt(source, offset) };
}

/**
 * A markdown metacharacter found in a decoded label, per the NINE constructs of
 * §A.5. `index` is an index into `label`, so the caller can map it back to a
 * source offset.
 *
 * The check is deliberately CONSERVATIVE: it rejects a superset of the strings
 * that would actually read differently under remark/MDX (a lone `*` opens no
 * emphasis; a lone `}` is harmless outside MDX). Emulating CommonMark's
 * delimiter-run rules exactly would mean writing a second inline parser —
 * precisely what this module exists to avoid.
 */
export interface LabelMetacharacter {
  readonly char: string;
  readonly index: number;
  /** Row number in the §A.5 table — kept so a message can cite the rule. */
  readonly rule: number;
}

/** Unconditional metacharacters: rows 1-5 and 9 of §A.5. */
const UNCONDITIONAL_METACHARACTERS: ReadonlyMap<string, number> = new Map([
  ['*', 1],
  ['_', 2],
  ['`', 3],
  ['[', 4],
  ['~', 5],
  ['{', 9],
  ['}', 9]
]);

/** Row 7: `&` only bites when it actually opens a character reference. */
const CHARACTER_REFERENCE = /^&([A-Za-z][A-Za-z0-9]*;|#[0-9]+;|#[xX][0-9a-fA-F]+;)/;

/**
 * First §A.5 violation in a DECODED label, or `undefined` when the label is
 * plain text under CommonMark, GFM and MDX alike.
 *
 * Rows 6 and 7 (`<` and `&`) are CONTEXTUAL on purpose: an unconditional ban
 * would outlaw ordinary Russian prose («A & B», «если x < y») and would make
 * the spec's own §A.3 example illegal.
 *
 * Row 8 (a stray `\`) is not checked here — an invalid escape never survives
 * label decoding, so it is already a fatal `invalid-escape`.
 */
export function findLabelMetacharacter(label: string): LabelMetacharacter | undefined {
  for (let index = 0; index < label.length; index++) {
    const char = label[index];
    const unconditional = UNCONDITIONAL_METACHARACTERS.get(char);
    if (unconditional !== undefined) {
      return { char, index, rule: unconditional };
    }
    if (char === '<' && /[A-Za-z/?!]/.test(label[index + 1] ?? '')) {
      return { char, index, rule: 6 };
    }
    if (char === '&' && CHARACTER_REFERENCE.test(label.slice(index))) {
      return { char, index, rule: 7 };
    }
  }
  return undefined;
}

const NAME_PATTERN = /^[a-z][a-z0-9-]*/;
const KEY_PATTERN = /^[a-z][a-zA-Z0-9-]*/;

function isHorizontalSpace(char: string | undefined): boolean {
  return char === ' ' || char === '\t';
}

/** Offset of the first character of the line containing `offset`. */
function lineStartOf(source: string, offset: number): number {
  const previousNewline = source.lastIndexOf('\n', offset - 1);
  return previousNewline + 1;
}

/** True when only spaces/tabs separate `offset` from the start of its line. */
function isFirstOnLine(source: string, offset: number): boolean {
  for (let index = lineStartOf(source, offset); index < offset; index++) {
    if (!isHorizontalSpace(source[index])) {
      return false;
    }
  }
  return true;
}

/** Offset of the line terminator at or after `offset` (or the source end). */
function endOfLine(source: string, offset: number): number {
  const newline = source.indexOf('\n', offset);
  return newline === -1 ? source.length : newline;
}

/** True when everything from `offset` to the end of its line is whitespace. */
function isRestOfLineBlank(source: string, offset: number): boolean {
  for (let index = offset; index < endOfLine(source, offset); index++) {
    if (!isHorizontalSpace(source[index]) && source[index] !== '\r') {
      return false;
    }
  }
  return true;
}

interface DecodedLabel {
  readonly text: string;
  /** Source offset of each decoded character, for precise diagnostics. */
  readonly offsets: readonly number[];
  /** Offset just past the closing `]`. */
  readonly end: number;
}

type LabelResult =
  | { readonly ok: true; readonly label: DecodedLabel }
  | { readonly ok: false; readonly result: ParseDirectiveResult };

/**
 * Decode `[LABEL]` starting at the `[` (§A.3). Exactly two escapes are legal —
 * `\]` and `\\`; every other backslash sequence is fatal, because CommonMark
 * treats `\` before ASCII punctuation and `\` before anything else in two
 * different ways, and two branches mean two possible readings after migration.
 */
function readLabel(source: string, open: number): LabelResult {
  const text: string[] = [];
  const offsets: number[] = [];
  let index = open + 1;
  while (index < source.length) {
    const char = source[index];
    if (char === '\n') {
      break;
    }
    if (char === ']') {
      return { ok: true, label: { text: text.join(''), offsets, end: index + 1 } };
    }
    if (char === '\\') {
      const escaped = source[index + 1];
      if (escaped !== ']' && escaped !== '\\') {
        return {
          ok: false,
          result: fail(
            source,
            index,
            'invalid-escape',
            `invalid escape sequence '\\${escaped ?? ''}' in directive label; only \\] and \\\\ are allowed`
          )
        };
      }
      text.push(escaped);
      offsets.push(index);
      index += 2;
      continue;
    }
    text.push(char);
    offsets.push(index);
    index++;
  }
  return {
    ok: false,
    result: fail(source, open, 'unterminated-label', 'unterminated directive label: missing closing ]')
  };
}

interface DecodedAttributes {
  readonly values: Map<string, string>;
  /** Source offset of each attribute KEY, for precise diagnostics. */
  readonly keyOffsets: Map<string, number>;
  /** Offset just past the closing `}`. */
  readonly end: number;
}

type AttributesResult =
  | { readonly ok: true; readonly attributes: DecodedAttributes }
  | { readonly ok: false; readonly result: ParseDirectiveResult };

/**
 * Decode `{ATTRS}` starting at the `{` (§A.2). Double quotes only, one or more
 * spaces/tabs between pairs, no repeated key.
 *
 * A repeated key is an ERROR rather than last-one-wins: last-one-wins loses the
 * author's intent without saying so, and the whole point of the build-time
 * teeth is that nothing about a page is decided silently.
 */
function readAttributes(source: string, open: number): AttributesResult {
  const values = new Map<string, string>();
  const keyOffsets = new Map<string, number>();
  let index = open + 1;
  let first = true;
  for (;;) {
    let separated = false;
    while (isHorizontalSpace(source[index])) {
      index++;
      separated = true;
    }
    if (index >= source.length || source[index] === '\n') {
      return {
        ok: false,
        result: fail(source, open, 'unterminated-attributes', 'unterminated directive attributes: missing closing }')
      };
    }
    if (source[index] === '}') {
      return { ok: true, attributes: { values, keyOffsets, end: index + 1 } };
    }
    if (!first && !separated) {
      return {
        ok: false,
        result: fail(
          source,
          index,
          'invalid-attribute-syntax',
          'directive attributes must be separated by whitespace'
        )
      };
    }

    const keyOffset = index;
    const key = KEY_PATTERN.exec(source.slice(index))?.[0];
    if (key === undefined) {
      return {
        ok: false,
        result: fail(
          source,
          index,
          'invalid-attribute-syntax',
          `expected an attribute name matching [a-z][a-zA-Z0-9-]* but found '${source[index]}'; shorthand (#id, .class) is not supported`
        )
      };
    }
    index += key.length;
    if (source[index] !== '=') {
      return {
        ok: false,
        result: fail(source, index, 'invalid-attribute-syntax', `attribute '${key}' must have a ="value"`)
      };
    }
    index++;
    if (source[index] !== '"') {
      return {
        ok: false,
        result: fail(
          source,
          index,
          'invalid-attribute-syntax',
          `attribute '${key}' must be double-quoted; single quotes and bare values are not supported`
        )
      };
    }

    const valueOpen = index;
    index++;
    const chars: string[] = [];
    let closed = false;
    while (index < source.length) {
      const char = source[index];
      if (char === '\n') {
        break;
      }
      if (char === '"') {
        closed = true;
        index++;
        break;
      }
      if (char === '\\') {
        const escaped = source[index + 1];
        if (escaped !== '"' && escaped !== '\\') {
          return {
            ok: false,
            result: fail(
              source,
              index,
              'invalid-escape',
              `invalid escape sequence '\\${escaped ?? ''}' in attribute '${key}'; only \\" and \\\\ are allowed`
            )
          };
        }
        chars.push(escaped);
        index += 2;
        continue;
      }
      chars.push(char);
      index++;
    }
    if (!closed) {
      return {
        ok: false,
        result: fail(
          source,
          valueOpen,
          'unterminated-attributes',
          `unterminated value of attribute '${key}': missing closing "`
        )
      };
    }
    if (values.has(key)) {
      return {
        ok: false,
        result: fail(source, keyOffset, 'duplicate-attribute', `duplicate attribute '${key}'`)
      };
    }
    values.set(key, chars.join(''));
    keyOffsets.set(key, keyOffset);
    first = false;
  }
}

/**
 * Sort the decoded attributes against a {@link DirectiveSpec} into the kept
 * ones and the degradable findings (§A.4 rows 3 and 6): an unknown attribute
 * and a value failing its `pattern` are both DROPPED and reported — the
 * runtime keeps rendering the directive without them.
 */
function collectAttributes(
  source: string,
  spec: DirectiveSpec,
  decoded: DecodedAttributes,
  fallbackOffset: number
): { readonly attributes: Record<string, string>; readonly warnings: DirectiveDiagnostic[] } {
  const attributes: Record<string, string> = {};
  const warnings: DirectiveDiagnostic[] = [];

  for (const [key, value] of decoded.values) {
    const offset = decoded.keyOffsets.get(key) ?? fallbackOffset;
    const attributeSpec = spec.attributes[key];
    if (attributeSpec === undefined) {
      warnings.push(
        diagnostic(source, offset, 'unknown-attribute', `unknown attribute '${key}' on directive '${spec.name}'`)
      );
      continue;
    }
    if (attributeSpec.pattern && !attributeSpec.pattern.test(value)) {
      warnings.push(
        diagnostic(
          source,
          offset,
          'invalid-attribute-value',
          `attribute '${key}' of directive '${spec.name}' must match ${String(attributeSpec.pattern)} but is '${value}'`
        )
      );
      continue;
    }
    attributes[key] = value;
  }

  return { attributes, warnings };
}

/** Fatal half of §A.4 row 2 — a required attribute that never arrived. */
function checkRequiredAttributes(
  source: string,
  spec: DirectiveSpec,
  attributes: Record<string, string>,
  nameOffset: number
): ParseDirectiveResult | undefined {
  for (const [key, attributeSpec] of Object.entries(spec.attributes)) {
    if (attributeSpec.required && attributes[key] === undefined) {
      return fail(
        source,
        nameOffset,
        'missing-attribute',
        `directive '${spec.name}' requires attribute '${key}'`
      );
    }
  }
  return undefined;
}

const NO_ATTRIBUTES: DecodedAttributes = { values: new Map(), keyOffsets: new Map(), end: 0 };

/**
 * Parse ONE directive occurrence that starts at `offset` (which must point at
 * the leading `:`). Returns the occurrence and its `end`, so a scanner can walk
 * a page by repeatedly locating a `:` and resuming from `end`.
 *
 * NEVER THROWS — see the module header for the caller-side policy split.
 */
export function parseDirective(source: string, offset = 0): ParseDirectiveResult {
  if (source[offset] !== ':') {
    return fail(source, offset, 'not-a-directive', "expected a directive to start with ':'");
  }

  let colons = 0;
  while (source[offset + colons] === ':') {
    colons++;
  }
  if (colons > 3) {
    return fail(
      source,
      offset,
      'invalid-form',
      `expected 1, 2 or 3 colons but found ${colons}; container fences are exactly three colons`
    );
  }
  const form: DirectiveForm = colons === 1 ? 'inline' : colons === 2 ? 'leaf' : 'container';

  const nameOffset = offset + colons;
  const name = NAME_PATTERN.exec(source.slice(nameOffset))?.[0];
  if (name === undefined) {
    return fail(
      source,
      nameOffset,
      'invalid-name',
      'expected a directive name matching [a-z][a-z0-9-]*'
    );
  }
  const spec = DIRECTIVE_REGISTRY[name];
  if (spec === undefined) {
    return fail(
      source,
      nameOffset,
      'unknown-directive',
      `unknown directive '${name}'; known directives are ${Object.keys(DIRECTIVE_REGISTRY).sort().join(', ')}`
    );
  }
  if (!spec.forms.includes(form)) {
    return fail(
      source,
      nameOffset,
      'invalid-form',
      `directive '${name}' cannot be used in ${form} form; allowed forms are ${spec.forms.join(', ')}`
    );
  }

  // Leaf and container are block-level: they own their line (§A.1). Enforcing
  // it here keeps the language a SUBSET — a caller that meets a `::name` mid
  // paragraph degrades to text rather than rendering something remark would
  // have read differently.
  if (form !== 'inline' && !isFirstOnLine(source, offset)) {
    return fail(
      source,
      offset,
      'not-own-line',
      `a ${form} directive must be the first thing on its line`
    );
  }

  return form === 'container'
    ? parseContainer(source, offset, spec, nameOffset + name.length)
    : parseInlineOrLeaf(source, offset, form, spec, nameOffset + name.length);
}

function parseInlineOrLeaf(
  source: string,
  start: number,
  form: DirectiveForm,
  spec: DirectiveSpec,
  afterName: number
): ParseDirectiveResult {
  let index = afterName;
  let label: string | undefined;
  let labelOffsets: readonly number[] = [];
  let labelStart = index;

  // `:action [x]` / `:action {…}` — a space between the parts is an error, not
  // "a directive with no label followed by prose": accepting it would make the
  // form depend on whitespace the author cannot see.
  const spaceRun = countHorizontalSpace(source, index);
  if (spaceRun > 0 && source[index + spaceRun] === '[') {
    return fail(source, index, 'space-before-label', 'no whitespace is allowed between a directive name and its [label]');
  }
  if (spaceRun > 0 && source[index + spaceRun] === '{') {
    return fail(
      source,
      index,
      'space-before-attributes',
      'no whitespace is allowed between a directive and its {attributes}'
    );
  }

  if (source[index] === '[') {
    labelStart = index;
    const read = readLabel(source, index);
    if (!read.ok) {
      return read.result;
    }
    label = read.label.text;
    labelOffsets = read.label.offsets;
    index = read.label.end;

    // Only attributes may follow a label, so a gap here is unambiguous. A gap
    // before a `[` is NOT flagged: `:doc[Home] [see also](url)` is legal prose.
    const afterLabelSpace = countHorizontalSpace(source, index);
    if (afterLabelSpace > 0 && source[index + afterLabelSpace] === '{') {
      return fail(
        source,
        index,
        'space-before-attributes',
        'no whitespace is allowed between a directive label and its {attributes}'
      );
    }
  }

  let decoded = NO_ATTRIBUTES;
  if (source[index] === '{') {
    const read = readAttributes(source, index);
    if (!read.ok) {
      return read.result;
    }
    decoded = read.attributes;
    index = decoded.end;
  }
  const collected = collectAttributes(source, spec, decoded, start);
  const attributes = collected.attributes;
  const warnings: DirectiveDiagnostic[] = [...collected.warnings];

  // `[…]` and `label=` together: refuse rather than pick a precedence the
  // author will never see applied (§A.6). Checked BEFORE requiredness so the
  // message names the real defect even on an otherwise incomplete directive.
  if (label !== undefined && attributes.label !== undefined) {
    return fail(
      source,
      start,
      'ambiguous-label',
      `directive '${spec.name}' carries both a [label] and a label attribute; keep exactly one`
    );
  }

  const missing = checkRequiredAttributes(source, spec, attributes, start);
  if (missing) {
    return missing;
  }

  if (label !== undefined) {
    const found = findLabelMetacharacter(label);
    if (found) {
      warnings.push(
        diagnostic(
          source,
          labelOffsets[found.index] ?? labelStart,
          'label-metacharacter',
          `markdown metacharacter '${found.char}' in directive label; labels are plain text`
        )
      );
    }
  }

  if (form === 'leaf' && !isRestOfLineBlank(source, index)) {
    return fail(source, index, 'trailing-content', 'a leaf directive must be alone on its line');
  }

  return {
    ok: true,
    directive: { name: spec.name, form, label, attributes, start, end: index },
    warnings
  };
}

function parseContainer(
  source: string,
  start: number,
  spec: DirectiveSpec,
  afterName: number
): ParseDirectiveResult {
  let index = afterName;

  if (source[index] === '[') {
    return fail(source, index, 'label-not-allowed', 'a container directive cannot carry a [label]');
  }
  const spaceRun = countHorizontalSpace(source, index);
  if (spaceRun > 0 && source[index + spaceRun] === '{') {
    return fail(
      source,
      index,
      'space-before-attributes',
      'no whitespace is allowed between a directive and its {attributes}'
    );
  }

  let decoded = NO_ATTRIBUTES;
  if (source[index] === '{') {
    const read = readAttributes(source, index);
    if (!read.ok) {
      return read.result;
    }
    decoded = read.attributes;
    index = decoded.end;
  }
  const collected = collectAttributes(source, spec, decoded, start);
  const attributes = collected.attributes;
  const warnings: DirectiveDiagnostic[] = [...collected.warnings];
  const missing = checkRequiredAttributes(source, spec, attributes, start);
  if (missing) {
    return missing;
  }

  if (!isRestOfLineBlank(source, index)) {
    return fail(
      source,
      index,
      'trailing-content',
      'nothing may follow the opening fence of a container directive'
    );
  }

  const bodyStart = endOfLine(source, index) + 1;
  if (bodyStart > source.length) {
    return fail(source, start, 'unclosed-container', "unclosed container directive: missing closing ':::'");
  }

  let lineStart = bodyStart;
  while (lineStart <= source.length) {
    const lineEnd = endOfLine(source, lineStart);
    const line = source.slice(lineStart, lineEnd).trim();
    if (line === ':::') {
      const body = stripTrailingNewline(source.slice(bodyStart, lineStart));
      return {
        ok: true,
        directive: {
          name: spec.name,
          form: 'container',
          attributes,
          body,
          start,
          end: lineEnd < source.length ? lineEnd + 1 : source.length
        },
        warnings
      };
    }
    // Nesting is forbidden (§A.1) — remark allows it, we do not, and the
    // narrower rule is what keeps the inclusion in remark-directive true.
    if (/^:::[a-z]/.test(line)) {
      return fail(source, lineStart, 'nested-container', 'container directives cannot be nested');
    }
    if (lineEnd >= source.length) {
      break;
    }
    lineStart = lineEnd + 1;
  }

  return fail(source, start, 'unclosed-container', "unclosed container directive: missing closing ':::'");
}

/** Whether a scan finding stops a build outright or only degrades a render. */
export type DirectiveSeverity = 'error' | 'warning';

/** A {@link DirectiveDiagnostic} carrying which of the two channels it came from. */
export interface ScanDiagnostic extends DirectiveDiagnostic {
  readonly severity: DirectiveSeverity;
}

/** Everything one page yields in a single pass. */
export interface ScanDirectivesResult {
  /**
   * Every occurrence that parsed, in source order. A container appears BEFORE
   * the directives nested in its body — the body is scanned too, because a
   * `:action` inside a `:::requires` block still has to reach the coverage
   * function (§C.7) and the renderer.
   */
  readonly directives: readonly ParsedDirective[];
  /**
   * Every finding of the whole page, in source order. `severity: 'error'`
   * means the occurrence is NOT in `directives`; `severity: 'warning'` means
   * it is, and was degraded.
   */
  readonly diagnostics: readonly ScanDiagnostic[];
}

/** A fenced code block found at a line start. */
interface CodeFence {
  /** Offset just past the block, i.e. where scanning resumes. */
  readonly end: number;
}

/**
 * A ``` or ~~~ fence opening at `lineStart`, per CommonMark: up to three
 * leading spaces, at least three fence characters, closed by a line whose
 * fence is the same character and at least as long. An unclosed fence runs to
 * the end of the document, which is also CommonMark.
 */
function codeFenceAt(source: string, lineStart: number): CodeFence | undefined {
  let index = lineStart;
  let indent = 0;
  while (indent < 4 && isHorizontalSpace(source[index])) {
    index++;
    indent++;
  }
  const fenceChar = source[index];
  if (fenceChar !== '`' && fenceChar !== '~') {
    return undefined;
  }
  let openLength = 0;
  while (source[index + openLength] === fenceChar) {
    openLength++;
  }
  if (openLength < 3) {
    return undefined;
  }

  let cursor = endOfLine(source, index) + 1;
  while (cursor <= source.length) {
    const lineEnd = endOfLine(source, cursor);
    const line = source.slice(cursor, lineEnd).trim();
    let closeLength = 0;
    while (line[closeLength] === fenceChar) {
      closeLength++;
    }
    if (closeLength >= openLength && closeLength === line.length) {
      return { end: lineEnd < source.length ? lineEnd + 1 : source.length };
    }
    if (lineEnd >= source.length) {
      break;
    }
    cursor = lineEnd + 1;
  }
  return { end: source.length };
}

/**
 * End of an inline code span opening with `runLength` backticks at `open`, or
 * `undefined` when it never closes (CommonMark then treats the run as literal
 * text, and so do we). The search stops at a blank line, because a code span
 * cannot cross a paragraph break.
 */
function codeSpanEnd(source: string, open: number, runLength: number): number | undefined {
  let index = open + runLength;
  while (index < source.length) {
    if (source[index] === '\n' && /^[ \t]*\n/.test(source.slice(index + 1))) {
      return undefined;
    }
    if (source[index] === '`') {
      let length = 0;
      while (source[index + length] === '`') {
        length++;
      }
      if (length === runLength) {
        return index + length;
      }
      index += length;
      continue;
    }
    index++;
  }
  return undefined;
}

/**
 * Scan a whole page: find every directive occurrence and collect EVERY
 * finding in one pass.
 *
 * NEVER THROWS and never stops at the first error — the generator has to be
 * able to print the full list of a page's problems in one run, otherwise an
 * author fixes them one rebuild at a time.
 *
 * CALLER POLICY, unchanged from {@link parseDirective}: the generator fails on
 * `diagnostics.length > 0` (which is exactly the aggregate of
 * `!ok || warnings.length > 0` over the page); the renderer renders
 * `directives`, logs `diagnostics`, and leaves the source text in place
 * wherever an `error` diagnostic says no directive was produced. The severity
 * split is reported, not acted on, here.
 *
 * CODE IS NOT SCANNED — decided, not defaulted. Fenced code blocks (``` and
 * ~~~) and inline code spans are skipped ENTIRELY: no directives, no
 * diagnostics. The guide contains a page ABOUT this markup, and its examples
 * are directives written inside code fences; a scanner that picked them up
 * would make the page documenting the syntax the one page that cannot be
 * built — and worse, `:::scenario` in an example would trip the "only on the
 * root page" gate of §A.7. Silence inside code is therefore the only coherent
 * rule, and it matches remark, which never parses directives inside code.
 *
 * NAMED BOUNDARY: INDENTED (four-space) code blocks are NOT recognised.
 * Telling one from a continuation line inside a list item requires block-level
 * markdown state — a second markdown parser, which is what this module exists
 * to avoid. Consequence: a directive indented four spaces outside a list is
 * still scanned. The mitigation is a convention, not a mechanism — guide pages
 * use fenced blocks (they need a language tag for highlighting anyway).
 *
 * A COLON IN PROSE IS NOT AN OCCURRENCE. Only a colon run followed
 * immediately by `[a-z]` is treated as an attempted directive, so «Примечание:
 * текст», `10:30` and `https://x` are simply text. A backslash before the
 * colon opts out explicitly, as in remark. The cost is named: an ASCII word
 * pair like `mailto:foo` IS read as an attempt and reported as an unknown
 * directive. That trade is deliberate — the alternative, ignoring anything not
 * already in the registry, would make a typo (`:actoin[…]`) silently render as
 * plain text, which is precisely the dead-affordance class §A.4 makes fatal.
 */
export function scanDirectives(source: string): ScanDirectivesResult {
  const directives: ParsedDirective[] = [];
  const diagnostics: ScanDiagnostic[] = [];
  let index = 0;

  while (index < source.length) {
    const char = source[index];

    if (index === 0 || source[index - 1] === '\n') {
      const fence = codeFenceAt(source, index);
      if (fence) {
        index = fence.end;
        continue;
      }
    }

    if (char === '`') {
      let runLength = 0;
      while (source[index + runLength] === '`') {
        runLength++;
      }
      const spanEnd = codeSpanEnd(source, index, runLength);
      index = spanEnd ?? index + runLength;
      continue;
    }

    if (char !== ':' || source[index - 1] === '\\') {
      index++;
      continue;
    }

    let colons = 0;
    while (source[index + colons] === ':') {
      colons++;
    }
    if (!/[a-z]/.test(source[index + colons] ?? '')) {
      index += colons;
      continue;
    }

    const result = parseDirective(source, index);
    if (!result.ok) {
      diagnostics.push({
        severity: 'error',
        code: result.code,
        message: result.error,
        position: result.position
      });
      // Step past the colons only: the rest of the line may still hold
      // something worth reporting, and re-reading them would not terminate.
      index += colons;
      continue;
    }

    directives.push(result.directive);
    for (const warning of result.warnings) {
      diagnostics.push({ severity: 'warning', ...warning });
    }
    // For a container, resume INSIDE the body rather than after the block, so
    // nested inline directives are found. The closing `:::` is a colon run
    // followed by a newline, so the scan skips it on its own.
    index =
      result.directive.form === 'container'
        ? endOfLine(source, index) + 1
        : result.directive.end;
  }

  diagnostics.sort((left, right) => left.position.offset - right.position.offset);
  return { directives, diagnostics };
}

function countHorizontalSpace(source: string, offset: number): number {
  let count = 0;
  while (isHorizontalSpace(source[offset + count])) {
    count++;
  }
  return count;
}

function stripTrailingNewline(text: string): string {
  if (text.endsWith('\r\n')) {
    return text.slice(0, -2);
  }
  return text.endsWith('\n') ? text.slice(0, -1) : text;
}
