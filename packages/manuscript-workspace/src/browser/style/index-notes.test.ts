import { promises as fs } from 'fs';
import { join } from 'path';
import { describe, expect, test } from 'bun:test';

/**
 * Teeth over the TASK-013 (U5) additions to `style/index.css` — specifically
 * over the ONE thing that can be wrong here without any build step catching
 * it (plan §9 ISS-139(a), same failure shape as `docs-style.test.ts`'s
 * ISS-095): resolved vs. unresolved (and note vs. `.afe-note-link`'s
 * unresolved counterpart) must differ by more than colour, because colour
 * alone can — and, per ISS-095, DID — collapse to the same rendered value
 * under a real theme's variable substitution, which nothing here can see.
 *
 * `index.css` (4000+ lines) has `@media`/`@keyframes` blocks elsewhere that a
 * naive brace-splitter would mis-parse, so this test scopes its parsing to
 * the two specific, flat, hand-authored comment-delimited sections it cares
 * about rather than the whole file.
 */

const CSS_PATH = join(import.meta.dir, 'index.css');

interface Rule {
  readonly selector: string;
  readonly declarations: Map<string, string>;
}

function parseRules(cssSlice: string): Rule[] {
  const text = cssSlice.replace(/\/\*[\s\S]*?\*\//g, '');
  const parsed: Rule[] = [];
  for (const match of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const declarations = new Map<string, string>();
    for (const line of match[2].split(';')) {
      const colon = line.indexOf(':');
      if (colon > 0) {
        declarations.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
      }
    }
    parsed.push({ selector: match[1].trim().replace(/\s+/g, ' '), declarations });
  }
  return parsed;
}

/** Extract the substring between two markers (both must exist), excluding the markers themselves. */
function sliceBetween(text: string, startMarker: string, endMarker: string): string {
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker, start);
  if (start < 0 || end < 0) {
    throw new Error(`section markers not found: ${JSON.stringify({ startMarker, endMarker, start, end })}`);
  }
  return text.slice(start + startMarker.length, end);
}

function declarationsOf(rules: Rule[], selector: string): Map<string, string> {
  const rule = rules.find(candidate => candidate.selector === selector);
  if (!rule) {
    throw new Error(`no rule found for selector ${JSON.stringify(selector)}`);
  }
  return rule.declarations;
}

const COLOUR_PROPERTIES = new Set([
  'color', 'background', 'background-color', 'border-color', 'border', 'outline',
  'outline-color', 'box-shadow', 'opacity', 'fill', 'stroke'
]);

/** Declaration keys present on `full` but absent (or same-valued) on `base` — the "what changed" set for a modifier rule. */
function changedDeclarationKeys(base: Map<string, string>, modifier: Map<string, string>): string[] {
  const changed: string[] = [];
  for (const [key, value] of modifier) {
    if (base.get(key) !== value) {
      changed.push(key);
    }
  }
  return changed;
}

describe('editor decoration classes: note/unresolved/ambiguous differ by more than colour (TASK-013 U5, ISS-139a)', () => {
  test('the stylesheet parses into rules at all', async () => {
    const text = await fs.readFile(CSS_PATH, 'utf8');
    expect(parseRules(text).length).toBeGreaterThan(50);
  });

  test('.afe-semantic-tag-note, -note-ambiguous, -unresolved rules all exist', async () => {
    const text = await fs.readFile(CSS_PATH, 'utf8');
    const section = sliceBetween(
      text,
      '/* ---------- semantic tag editor decorations ---------- */',
      '/* ---------- manuscript tree ---------- */'
    );
    const selectors = parseRules(section).map(rule => rule.selector);
    expect(selectors).toContain('.monaco-editor .afe-semantic-tag-note');
    expect(selectors).toContain('.monaco-editor .afe-semantic-tag-note-ambiguous');
    expect(selectors).toContain('.monaco-editor .afe-semantic-tag-unresolved');
  });

  test('.afe-semantic-tag-unresolved differs from .afe-semantic-tag-note by a non-colour declaration', async () => {
    const text = await fs.readFile(CSS_PATH, 'utf8');
    const section = sliceBetween(
      text,
      '/* ---------- semantic tag editor decorations ---------- */',
      '/* ---------- manuscript tree ---------- */'
    );
    const rules = parseRules(section);
    const note = declarationsOf(rules, '.monaco-editor .afe-semantic-tag-note');
    const unresolved = declarationsOf(rules, '.monaco-editor .afe-semantic-tag-unresolved');

    // Every distinguishing property (colour or not) between the two rules —
    // regression guard: this must never be empty, or the states are identical.
    const distinguishing = new Set([...changedDeclarationKeys(note, unresolved), ...changedDeclarationKeys(unresolved, note)]);
    expect(distinguishing.size).toBeGreaterThan(0);

    // The property that actually carries the difference under ANY theme
    // (colour values are theme-substituted and can coincide, exactly like
    // ISS-095): `border-bottom` must encode a different border-style token
    // (`solid` vs `dashed`), not merely a different colour.
    const noteBorder = note.get('border-bottom') ?? '';
    const unresolvedBorder = unresolved.get('border-bottom') ?? '';
    expect(noteBorder).toContain('solid');
    expect(unresolvedBorder).toContain('dashed');
    expect(noteBorder).not.toContain('dashed');
    expect(unresolvedBorder).not.toContain('solid');
  });

  test('.afe-semantic-tag-note-ambiguous adds a non-colour marker (dotted), distinct from both -note and -unresolved', async () => {
    const text = await fs.readFile(CSS_PATH, 'utf8');
    const section = sliceBetween(
      text,
      '/* ---------- semantic tag editor decorations ---------- */',
      '/* ---------- manuscript tree ---------- */'
    );
    const ambiguous = declarationsOf(parseRules(section), '.monaco-editor .afe-semantic-tag-note-ambiguous');
    expect(ambiguous.get('border-bottom-style')).toBe('dotted');
    // The ambiguous modifier rule declares ONLY the non-colour override — it
    // rides on `.afe-semantic-tag-note`'s colour/background, so a themed
    // colour swap can never silently erase the dotted marker.
    const nonBorderStyleKeys = [...ambiguous.keys()].filter(key => key !== 'border-bottom-style');
    expect(nonBorderStyleKeys).toEqual([]);
  });

  test('.afe-note-link and .afe-note-link-unresolved (preview, U7 consumer) exist and differ by more than colour', async () => {
    const text = await fs.readFile(CSS_PATH, 'utf8');
    const section = sliceBetween(
      text,
      'never redefines them) ---------- */',
      '/* ---------- entity editor: preserved (non-schema) keys ---------- */'
    );
    const rules = parseRules(section);
    const resolved = declarationsOf(rules, '.afe-note-link');
    const unresolved = declarationsOf(rules, '.afe-note-link-unresolved');

    expect(resolved.get('text-decoration-style')).toBe('solid');
    expect(unresolved.get('text-decoration-style')).toBe('dotted');

    const distinguishing = new Set([
      ...changedDeclarationKeys(resolved, unresolved),
      ...changedDeclarationKeys(unresolved, resolved)
    ]);
    const nonColourDistinguishing = [...distinguishing].filter(key => !COLOUR_PROPERTIES.has(key));
    expect(nonColourDistinguishing).toContain('text-decoration-style');
  });
});
