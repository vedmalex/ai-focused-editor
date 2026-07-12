/**
 * PURE (no Obsidian imports) semantic-tag scanning + "tag under the cursor"
 * resolution for the AFE Companion plugin.
 *
 * The shipped studio parser `parseSemanticMarkdown`
 * (`@ai-focused-editor/semantic-markdown`) restricts a tag's `kind` to
 * `[a-z][\w-]*` and its `id` to ASCII — correct for the four built-in tag kinds
 * (`char`/`term`/`artifact`/`location`) whose ids are slugs. This module
 * GENERALISES that scan to Unicode so an author-declared type may carry a
 * Cyrillic `tagKind` (e.g. `[[персонаж:кришна|Кришна]]`) and still be recognised
 * identically to a built-in — mirroring how the entity-type registry
 * (`entity-type-registry.ts`) passes unknown/author tag kinds through verbatim.
 * The registry stays the single source of truth for WHICH kinds are real; this
 * module only tokenises the text.
 */

export interface ScannedTag {
  /** Tag kind before the `:` (e.g. `char`, `персонаж`); empty for a bare `[[id]]`. */
  kind: string;
  /** Referenced entity id. */
  id: string;
  /** Display label after `|`; undefined for `[[kind:id]]` / `[[id]]`. */
  label?: string;
  /** The whole matched token, e.g. `[[char:krishna|Krishna]]`. */
  raw: string;
  /** Character offset of the opening `[[`. */
  start: number;
  /** Character offset just past the closing `]]` (exclusive). */
  end: number;
}

/**
 * Scan a single line (or any single-line string) for every `[[...]]` semantic
 * token — labeled `[[kind:id|label]]`, unlabeled `[[kind:id]]`, and bare
 * `[[id]]`. Tokens are returned in source order with their character offsets.
 *
 * A token's inner text may not contain `[`, `]`, `|` (except the single label
 * separator) or a newline. The FIRST `:` splits kind from id; the FIRST `|`
 * splits the id from the label, so ids may themselves contain no `|`.
 */
export function scanSemanticTags(line: string): ScannedTag[] {
  const tags: ScannedTag[] = [];
  let cursor = 0;
  while (cursor < line.length) {
    const open = line.indexOf('[[', cursor);
    if (open === -1) {
      break;
    }
    const close = line.indexOf(']]', open + 2);
    if (close === -1) {
      break;
    }
    const inner = line.slice(open + 2, close);
    // Reject anything that is not a single clean token (nested brackets / newline).
    if (inner.length > 0 && !/[\[\]\n]/.test(inner)) {
      const parsed = parseInner(inner);
      if (parsed) {
        tags.push({
          ...parsed,
          raw: line.slice(open, close + 2),
          start: open,
          end: close + 2
        });
      }
    }
    cursor = close + 2;
  }
  return tags;
}

/** Split the text between `[[` and `]]` into kind / id / label. */
function parseInner(inner: string): { kind: string; id: string; label?: string } | undefined {
  const pipe = inner.indexOf('|');
  const head = (pipe === -1 ? inner : inner.slice(0, pipe)).trim();
  const label = pipe === -1 ? undefined : inner.slice(pipe + 1).trim();
  const colon = head.indexOf(':');
  const kind = colon === -1 ? '' : head.slice(0, colon).trim();
  const id = (colon === -1 ? head : head.slice(colon + 1)).trim();
  if (!id) {
    return undefined;
  }
  return label ? { kind, id, label } : { kind, id };
}

/**
 * The full `[[kind:id|label]]` (or `[[kind:id]]` / `[[id]]`) token whose span
 * contains character offset `ch`, or `null` when the cursor is not inside a tag.
 * A cursor exactly on either boundary (`ch === start` or `ch === end`) counts as
 * inside, so a click on the leading `[[` still resolves the tag.
 */
export function tagAtPosition(line: string, ch: number): ScannedTag | null {
  for (const tag of scanSemanticTags(line)) {
    if (ch >= tag.start && ch <= tag.end) {
      return tag;
    }
  }
  return null;
}
