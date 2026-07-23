/**
 * YAML frontmatter splitting (TASK-018 tech_spec §3 WP-U3-2/3/4).
 *
 * Extracted from `generate-docs-content.mjs` so the two build scripts that both
 * need it — the generator (docs pages) and the extractor (`SKILL.md` skill
 * manifests) — share ONE implementation. A second copy would be the same
 * divergence risk `source-scan.ts` removes for the traversal: two parsers that
 * agree today and quietly disagree after an edit.
 */

/** The result of splitting frontmatter off the head of a document. */
export interface SplitFrontmatter {
  /** The raw YAML text between the `---` fences (no fences). */
  yamlText: string;
  /** The document body after the closing fence, kept byte-exact. */
  body: string;
  /** Number of lines consumed by the frontmatter block (for diagnostics). */
  lineOffset: number;
}

/** Split `---\n…\n---\n` off the head of a page, keeping the body byte-exact. */
export function splitFrontmatter(text: string): SplitFrontmatter | undefined {
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) {
    return undefined;
  }
  const firstBreak = text.indexOf('\n');
  const rest = text.slice(firstBreak + 1);
  const terminator = rest.search(/^---[ \t]*(\r?\n|$)/m);
  if (terminator < 0) {
    return undefined;
  }
  const yamlText = rest.slice(0, terminator);
  const afterTerminator = rest.slice(terminator);
  const terminatorEnd = afterTerminator.indexOf('\n');
  const body = terminatorEnd < 0 ? '' : afterTerminator.slice(terminatorEnd + 1);
  const consumed = text.length - body.length;
  const lineOffset = text.slice(0, consumed).split('\n').length - 1;
  return { yamlText, body, lineOffset };
}
