/**
 * Pure (Theia-free) helpers for the book's `.gitignore` — used by the
 * "New Transcript Set..." command to keep heavy audio/video media out of git
 * (owner decision: the audio area is gitignored at set creation, then
 * user-managed), and by the Book Doctor's advisory transcription check.
 *
 * Deliberately SIMPLE: this is not a full gitignore matcher. Entries are
 * compared after normalizing comments, whitespace, and leading `/` + trailing
 * `/` markers, which is exactly enough to (a) append an area entry
 * idempotently and (b) recognize that the same area entry is already present.
 */

/** Normalize one `.gitignore` line for comparison (`/sources/audio/` → `sources/audio`). */
function normalizeGitignoreLine(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) {
    return undefined;
  }
  return trimmed.replace(/^\/+/, '').replace(/\/+$/, '');
}

/**
 * True when `.gitignore` (raw text; `undefined` = absent file) already carries
 * `entry` — compared loosely, so `sources/audio/`, `/sources/audio/`, and
 * `sources/audio` all count as the same entry. A broader glob (e.g.
 * `sources/audio/**`) is NOT recognized; the helper stays a plain
 * entry-equality check.
 */
export function hasGitignoreEntry(text: string | undefined, entry: string): boolean {
  if (text === undefined) {
    return false;
  }
  const wanted = normalizeGitignoreLine(entry);
  if (!wanted) {
    return false;
  }
  return text
    .split(/\r?\n/)
    .some(line => normalizeGitignoreLine(line) === wanted);
}

/** Result of {@link appendGitignoreEntry}. */
export interface AppendGitignoreResult {
  /** The new `.gitignore` text (unchanged when `added` is false). */
  text: string;
  /** True when the entry was appended (false = it was already present). */
  added: boolean;
}

/**
 * Idempotently append `entry` (plus an optional `# comment` line above it) to
 * the `.gitignore` text. `undefined` text means the file does not exist yet —
 * the result is then a fresh file holding just the comment + entry. Existing
 * content is never reordered or rewritten; the entry lands at the end,
 * separated by a blank line, and the file always ends with a newline.
 */
export function appendGitignoreEntry(
  text: string | undefined,
  entry: string,
  comment?: string
): AppendGitignoreResult {
  if (hasGitignoreEntry(text, entry)) {
    return { text: text ?? '', added: false };
  }
  const lines: string[] = [];
  if (comment) {
    lines.push(`# ${comment}`);
  }
  lines.push(entry);
  const block = lines.join('\n') + '\n';
  if (text === undefined || text.trim() === '') {
    return { text: block, added: true };
  }
  const base = text.endsWith('\n') ? text : `${text}\n`;
  return { text: `${base}\n${block}`, added: true };
}
