/**
 * Pure logic behind the `[[note` autocomplete source (TASK-013 U6/
 * UR-003(г)/UR-005(3)): given the vault's note index (basename + a
 * caller-resolved vault-relative path per entry) and whatever the author has
 * typed after `[[`, build the note-file suggestion list in Obsidian's
 * insertion form — a unique basename inserts bare (`[[basename]]`); a
 * basename shared by 2+ files (a collision) inserts every one of its
 * occurrences as its vault-relative path instead (`[[relative/path]]`).
 *
 * Kept Theia/Monaco-free (like `note-index.ts`/`link-navigation.ts`) so the
 * grouping/filtering/sort rules are unit-testable without a DOM, a workspace,
 * or a filesystem. The browser `SemanticMarkdownCompletionProvider` supplies
 * `entries` — mapping `NoteIndexService.getIndex().entries` to
 * `{ basename, relativePath }` by resolving each entry's full path against
 * the workspace root (`WorkspaceService`/`URI.relative`) — and layers the
 * Monaco `CompletionItem`/range/trigger wiring on top. This module performs
 * NO path arithmetic against a workspace root itself; `relativePath` is
 * always taken as given.
 */

/** One vault note, as supplied to {@link buildNoteCompletionSuggestions}. */
export interface NoteCompletionEntry {
  /** Display basename, original case, `.md` already stripped. */
  basename: string;
  /**
   * Vault-relative path, POSIX-separated, `.md` already stripped, no leading
   * `/` (e.g. `folder/My Note`). Used verbatim as the collision-form
   * `insertText` and always carried through as `detail`-style context even
   * for a unique basename.
   */
  relativePath: string;
}

/** One built suggestion, ready for the caller to turn into a Monaco `CompletionItem`. */
export interface NoteCompletionSuggestion {
  /**
   * Text to insert inside `[[...]]` (the caller appends the closing `]]`):
   * the bare `basename` when it is unique vault-wide (after filtering — see
   * below), the `relativePath` when 2+ entries share that basename.
   */
  insertText: string;
  /** Display label for the completion list — always the basename, in EITHER form, so the note stays recognizable by name even when the collision form is used for insertion. */
  label: string;
  /** The entry's vault-relative path, always populated regardless of `insertText`'s form (for a `detail`/documentation column distinguishing same-named files). */
  relativePath: string;
}

/**
 * Build note-file completion suggestions from `entries`, optionally filtered
 * to those whose basename starts with `prefix` (the text already typed after
 * `[[`, e.g. `"Мо"` for `[[Мо`).
 *
 * Filtering is case-insensitive via `toLocaleLowerCase` on both sides (not
 * plain `toLowerCase`) so a Cyrillic (or any non-ASCII) prefix matches
 * case-insensitively too (plan §9/ISS-139(c)). A blank/undefined `prefix`
 * matches every entry.
 *
 * Uniqueness is decided from the FILTERED set: two entries sharing a
 * basename always match (or both fail) the same prefix test — since the
 * test only looks at the basename itself — so grouping after filtering is
 * equivalent to grouping the full vault first; this just avoids a second
 * pass. A basename occurring once in the filtered set inserts bare; 2+
 * occurrences all insert their `relativePath` instead.
 *
 * Output is sorted by `label` (locale-aware `localeCompare`, so Cyrillic
 * sorts sensibly rather than by code point), then by `relativePath` to keep
 * same-basename entries in a stable, deterministic order.
 */
export function buildNoteCompletionSuggestions(
  entries: readonly NoteCompletionEntry[],
  prefix?: string
): NoteCompletionSuggestion[] {
  const needle = (prefix ?? '').toLocaleLowerCase();
  const filtered = needle
    ? entries.filter(entry => entry.basename.toLocaleLowerCase().startsWith(needle))
    : entries;

  const countByBasename = new Map<string, number>();
  for (const entry of filtered) {
    const key = entry.basename.toLocaleLowerCase();
    countByBasename.set(key, (countByBasename.get(key) ?? 0) + 1);
  }

  const suggestions = filtered.map((entry): NoteCompletionSuggestion => {
    const key = entry.basename.toLocaleLowerCase();
    const isUnique = (countByBasename.get(key) ?? 0) <= 1;
    return {
      insertText: isUnique ? entry.basename : entry.relativePath,
      label: entry.basename,
      relativePath: entry.relativePath
    };
  });

  return suggestions.sort((a, b) =>
    a.label.localeCompare(b.label) || a.relativePath.localeCompare(b.relativePath)
  );
}
