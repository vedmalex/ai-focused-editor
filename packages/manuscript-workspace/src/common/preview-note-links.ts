/**
 * Pure pre-render rewrite of Obsidian-style `[[note]]` wiki-links for the
 * semantic Markdown preview (TASK-013 plan §9/ISS-137; mechanism CORRECTED for
 * the real live renderer per ISS-149 — see below).
 *
 * THE LIVE RENDERER IS NOT bare markdown-it. The preview widget injects
 * `@theia/core`'s `MarkdownRenderer` symbol, which `@theia/monaco`'s frontend
 * module REBINDS to `MonacoMarkdownRenderer` -> VS Code's
 * `MarkdownRendererService` (`monaco-editor-core/.../base/browser/markdownRenderer`).
 * That renderer is `marked` + VS Code's own DOM sanitizer, and it does TWO
 * things a plain `markdownit().render()` never does — both fatal to the
 * original sentinel design, and both invisible to a smoke test that renders
 * through bare markdown-it (the ISS-149 root cause: the U7 smoke test used the
 * WRONG renderer):
 *
 *  1. Its DOM sanitizer (`domSanitize`) DROPS the `href` of any link whose
 *     value is neither an allowed scheme (http/https/mailto/file/…) NOR starts
 *     with `#` — a scheme-less relative token like `afe-note-link-0` is stripped
 *     unless the source markdown carried a `baseUri` (the preview string has
 *     none). The `#`-fragment exemption (`domSanitize`: `attrValue.startsWith('#')`)
 *     is the ONLY reliable way to keep a colon-free opaque token.
 *  2. `rewriteRenderedLinks` then CLEARS every surviving anchor's `href` to `''`
 *     and moves the value to `data-href` (VS Code drives clicks off `data-href`,
 *     not `href`). An anchor whose `href` was stripped in step 1 is UNWRAPPED to
 *     plain text (`el.replaceWith(...el.childNodes)`) — which is exactly the
 *     "no `<a>` at all, plain text" symptom ISS-149 reported.
 *
 * THE MECHANISM THAT ACTUALLY SURVIVES (post-render DOM patch, same pattern as
 * the widget's SVG `patchPreviewImages`): {@link rewriteNoteLinksForPreview}
 * rewrites every note-class token into a PLAIN Markdown link
 * `[label](#afe-note-link-N)` — a `#`-fragment sentinel (see
 * {@link NOTE_LINK_SENTINEL_PREFIX}), opaque and never a real target. The `#`
 * prefix carries it past the sanitizer (step 1); the anchor then survives with
 * the sentinel relocated to `data-href` (step 2). The widget's
 * `handlePreviewRender` hook walks the RENDERED DOM, matches each anchor by
 * `data-href` (falling back to `href` for renderers — e.g. bare markdown-it in
 * tests — that keep it; see {@link noteLinkSentinelForAnchor}), and sets the
 * real `data-afe-note-link=<encoded payload>` attribute (see
 * {@link encodeNoteLinkPayload}/{@link decodeNoteLinkPayload}) plus the
 * resolved/unresolved CSS class DIRECTLY on the live node — after both the
 * sanitizer and `rewriteRenderedLinks` have already run, so neither can touch
 * it (the same reason `patchPreviewImages` swaps SVG `data:` URIs post-render).
 *
 * Only note-class tokens are rewritten here. Entity-class and invalid tokens
 * are left byte-for-byte untouched — `renderSemanticMarkdownPreview` (labeled
 * entities) and the existing bare-tag decorations keep treating them exactly
 * as before TASK-013.
 *
 * QA-fix (ISS-151): a note-class token can still name a narrative ENTITY —
 * `[[hero]]` has no `:`, so `parseWikiLinks` classifies it `note`, but `hero`
 * may be a valid bare entity id (the pre-TASK-013 corpus this whole
 * UR-003(a) chain exists to keep working). The EDITOR's `resolveWikiToken`
 * already checks entity-by-bare-id FIRST, before ever touching
 * `resolveNoteLink` (`semantic-link-contribution.ts`); the preview path did
 * not, so a bare-entity token rendered as an unresolved "click to create"
 * note link — clicking would have created a garbage `hero.md`. The injected
 * {@link NoteLinkResolver} now answers `'entity'` for that case (see
 * {@link NoteLinkResolverOutcome}), and `rewriteNoteLinksForPreview` leaves
 * that token completely untouched, same as an entity-class/invalid token
 * that never reaches this loop at all.
 */

import { parseWikiLinks } from './link-navigation';

/** Resolution outcome for one note-class `[[...]]` token (plan §2/§3 chain, minus the entity step — this only ever sees note-class tokens). */
export type NoteLinkStatus = 'resolved' | 'unresolved' | 'ambiguous';

/** What a caller-supplied resolver answers for one note reference (alias/anchor already stripped). */
export interface NoteLinkResolution {
  status: NoteLinkStatus;
  /** Resolved (or alphabetically-first tied) workspace path — required for `resolved`/`ambiguous`, absent for `unresolved`. */
  path?: string;
  /** Full tied candidate set (plan §2/UR-005(1)) — only present for `ambiguous`. */
  candidates?: string[];
}

/**
 * A resolver answers `'entity'` (ISS-151) when `notePath` — a note-class
 * token's bare id (never carries a `kind:` prefix; that shape classifies as
 * `entity`, not `note`, in `parseWikiLinks`) — matches a narrative entity by
 * bare id, exactly the editor's `resolveWikiToken`/`findEntityById`
 * no-kind branch. This wins BEFORE any note-path resolution is attempted;
 * `rewriteNoteLinksForPreview` leaves such a token completely untouched
 * (no sentinel, no rewrite) rather than ever classifying it resolved/
 * unresolved/ambiguous as a note.
 */
export type NoteLinkResolverOutcome = NoteLinkResolution | 'entity';

/**
 * Resolve one note reference (the same `notePath` a `note`-class
 * `WikiLinkMatch` carries) to a {@link NoteLinkResolverOutcome}. Kept as an
 * injected callback — NOT a direct `NoteIndexService`/entity-index
 * dependency — so this module stays Theia/DOM-free and unit-testable; the
 * browser widget supplies a resolver backed by its entity `mentionIndex`
 * (entity-first, ISS-151) then `resolveNoteLink` + `NoteIndexService.getIndex()`.
 */
export type NoteLinkResolver = (notePath: string) => NoteLinkResolverOutcome;

/**
 * Everything the click handler needs to act on a rewritten note link without
 * re-parsing the source markdown or re-resolving the note (both may have
 * moved on by click time — this is a snapshot from render time, same
 * staleness tolerance as the existing note-index/decoration design).
 */
export interface NoteLinkPayload {
  status: NoteLinkStatus;
  /** The raw note reference text (name or path) as written inside `[[...]]` — `|alias`/`#anchor` already stripped. */
  notePath: string;
  /** First `#anchor` segment, when present (heading slug target — plan §2/§3). */
  anchor?: string;
  /** Resolved (or tied alphabetically-first) workspace path — present for `resolved`/`ambiguous`. */
  path?: string;
  /** Full tied candidate set — only present for `ambiguous` (plan §2/UR-005(1) click → picker). */
  candidates?: string[];
}

export interface RewriteNoteLinksResult {
  /** The markdown with every note-class `[[...]]` token replaced by a plain `[label](sentinel)` link; everything else byte-identical. */
  markdown: string;
  /** Sentinel token (also the rewritten link's `href`) -> payload, consumed by the widget's post-render DOM patch. */
  sentinels: Map<string, NoteLinkPayload>;
}

/**
 * Sentinel prefix for the rewritten note-link href. It is a `#`-FRAGMENT
 * (`#afe-note-link-N`) on purpose (ISS-149): VS Code's DOM sanitizer keeps a
 * link href only when it uses an allowed scheme OR starts with `#`, so this is
 * the one colon-free opaque form that survives the live Monaco/VS Code
 * renderer. The full sentinel (prefix + counter) is BOTH the rewritten link's
 * href AND the key in {@link RewriteNoteLinksResult.sentinels}, so the widget's
 * post-render patch can look a matched anchor straight back up.
 */
const NOTE_LINK_SENTINEL_PREFIX = '#afe-note-link-';

/** CSS classes U5 declares in `style/index.css` (plan §11) — U7 only references them by name. */
export const NOTE_LINK_CLASS = 'afe-note-link';
export const NOTE_LINK_UNRESOLVED_CLASS = 'afe-note-link-unresolved';

/** The DOM attribute the post-render patch sets on a resolved anchor node (plan §9/ISS-137). */
export const NOTE_LINK_ATTRIBUTE = 'data-afe-note-link';

/**
 * Rewrite every note-class `[[...]]` token in `markdown` into a plain
 * `[label](sentinel)` Markdown link, calling `resolve` once per token (in
 * source order) to classify it resolved/unresolved/ambiguous — UNLESS
 * `resolve` answers `'entity'` (ISS-151: the bare id names a narrative entity,
 * entity resolution wins first), in which case that token is left completely
 * untouched, same as an entity-class token. Entity-class and invalid tokens
 * (per `parseWikiLinks`) never reach this loop at all. A `notePath` that is
 * empty/whitespace-only never happens for a `note`-class match (the
 * classifier requires a non-empty `path`), but is defensively skipped here
 * too.
 */
export function rewriteNoteLinksForPreview(markdown: string, resolve: NoteLinkResolver): RewriteNoteLinksResult {
  const matches = parseWikiLinks(markdown).filter(match => match.class === 'note' && !!match.notePath?.trim());
  if (matches.length === 0) {
    return { markdown, sentinels: new Map() };
  }

  const sentinels = new Map<string, NoteLinkPayload>();
  let result = '';
  let cursor = 0;
  let counter = 0;

  for (const match of matches) {
    const notePath = match.notePath!;
    const outcome = resolve(notePath);
    if (outcome === 'entity') {
      // ISS-151: entity resolution wins FIRST — leave this token completely
      // untouched (including the text since `cursor`), same as an
      // entity-class/invalid token that never reaches this loop at all. No
      // sentinel is minted, so `counter` is NOT advanced for this token.
      result += markdown.slice(cursor, match.range.end);
      cursor = match.range.end;
      continue;
    }
    const resolution = outcome;
    const sentinel = `${NOTE_LINK_SENTINEL_PREFIX}${counter++}`;

    const payload: NoteLinkPayload = { status: resolution.status, notePath };
    if (match.anchor) {
      payload.anchor = match.anchor;
    }
    if (resolution.path !== undefined) {
      payload.path = resolution.path;
    }
    if (resolution.candidates !== undefined) {
      payload.candidates = resolution.candidates;
    }
    sentinels.set(sentinel, payload);

    const displayText = escapeLinkLabel(match.alias ?? notePath);
    result += markdown.slice(cursor, match.range.start) + `[${displayText}](${sentinel})`;
    cursor = match.range.end;
  }
  result += markdown.slice(cursor);
  return { markdown: result, sentinels };
}

// `parseWikiLinks`'s token pattern already forbids `[`, `]`, and newlines
// inside a `[[...]]` token's inner text, so a note/alias text can never
// contain those — only Markdown inline-emphasis/escape characters need
// neutralising so a note named e.g. `my_file` or `a*b` renders as literal
// text inside the link label rather than triggering `_..._`/`*...*` emphasis.
function escapeLinkLabel(value: string): string {
  return value.replace(/[\\*_`]/g, character => `\\${character}`);
}

/**
 * Given a rendered anchor's `href` and `data-href` attribute values, return the
 * note-link sentinel to look up in {@link RewriteNoteLinksResult.sentinels}, or
 * `undefined` when the anchor is not one of ours.
 *
 * This is the seam the widget's post-render patch runs on, extracted here so the
 * LIVE-renderer DOM contract is unit-testable without a browser (ISS-149 — the
 * original smoke test never exercised it, which is why the bug shipped):
 *
 *  - The live Monaco/VS Code renderer relocates the sentinel to `data-href` and
 *    empties `href` to `''` (see the module doc), so `data-href` is tried FIRST.
 *  - A bare-markdown-it renderer (used in tests / other embeddings) keeps the
 *    sentinel on `href`, so it is the fallback.
 *  - Only a value carrying the {@link NOTE_LINK_SENTINEL_PREFIX} is ours; any
 *    other link (a real `#heading` fragment, an `http(s)` link) returns
 *    `undefined` so the patch leaves it untouched.
 */
export function noteLinkSentinelForAnchor(href: string | null, dataHref: string | null): string | undefined {
  const candidate = (dataHref && dataHref.length > 0) ? dataHref : (href && href.length > 0 ? href : undefined);
  if (!candidate || !candidate.startsWith(NOTE_LINK_SENTINEL_PREFIX)) {
    return undefined;
  }
  return candidate;
}

/** Encode a payload for the `data-afe-note-link` DOM attribute (set post-render — see the module doc for why this survives). */
export function encodeNoteLinkPayload(payload: NoteLinkPayload): string {
  return encodeURIComponent(JSON.stringify(payload));
}

/**
 * Decode a `data-afe-note-link` attribute value back to its payload.
 * Returns `undefined` on anything malformed/foreign rather than throwing — a
 * corrupted or third-party attribute must never crash the click handler.
 */
export function decodeNoteLinkPayload(raw: string): NoteLinkPayload | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeURIComponent(raw));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') {
    return undefined;
  }
  const candidate = parsed as Partial<NoteLinkPayload>;
  if (
    typeof candidate.notePath !== 'string' ||
    (candidate.status !== 'resolved' && candidate.status !== 'unresolved' && candidate.status !== 'ambiguous')
  ) {
    return undefined;
  }
  return candidate as NoteLinkPayload;
}
