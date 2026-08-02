import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
// The CANONICAL rule registry (CR/F-CR-1). DOM/Theia-browser free by hard
// constraint, so this Node-lane suite can import the SHIPPED rule set rather
// than a hand-copied list of ids.
import { ALL_TYPOGRAPHY_RULE_IDS } from '../../common/typography/typography-rules';

/**
 * DOCUMENTATION PARITY FOR THE TYPOGRAPHY RULE TABLE (CR/F-CR-6).
 *
 * `content/ru/writing/typography.md` lists every rule as a table row and states
 * how many there are. Nothing enforced either side of that:
 *
 *  - the docs `covers:` gate holds only the THREE command ids in the page's
 *    front matter, and
 *  - the whole `aiFocusedEditor.typography.*` preference family is registered
 *    in `scripts/extract-feature-inventory.mjs` as ONE `kind: "dynamic"` entry,
 *    because the per-rule keys exist only at DI time (the ISS-239 decision — by
 *    design, not a defect).
 *
 * So a 15th rule needed no documentation at all: its toggle would appear in
 * settings, the table and the count would quietly describe 14, and `docs:strict`
 * would stay green. The registry is enumerable and the page is machine-readable
 * (ids in backticks), so the parity can simply be checked where the data IS.
 *
 * Checked in BOTH directions on purpose — a rule with no row is a documentation
 * hole, a row naming no rule is a promise the product does not keep (a renamed
 * or removed rule leaves exactly that behind).
 */

const PAGE_PATH = join(import.meta.dir, 'content/ru/writing/typography.md');
const page = readFileSync(PAGE_PATH, 'utf8');

/** The `## Правила` section, up to the next heading of any level. */
function rulesSection(markdown: string): string {
  const start = markdown.indexOf('\n## Правила\n');
  if (start === -1) {
    return '';
  }
  const body = markdown.slice(start + '\n## Правила\n'.length);
  const next = body.search(/^#{1,6} /m);
  return next === -1 ? body : body.slice(0, next);
}

const section = rulesSection(page);

/** Every `| … |` line of the section that is not the header or its separator. */
function tableRows(text: string): string[] {
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('|'))
    .filter(line => !/^\|\s*#\s*\|/.test(line))
    .filter(line => !/^\|[\s:|-]*\|$/.test(line));
}

const rows = tableRows(section);

/** The `id` cell of a row, when it is a single backticked token. */
function rowId(row: string): string | undefined {
  const cells = row.split('|');
  // A row is `| # | `id` | text |` → ['', ' # ', ' `id` ', ' text ', ''].
  const match = /^\s*`([a-z0-9]+(?:-[a-z0-9]+)*)`\s*$/.exec(cells[2] ?? '');
  return match?.[1];
}

const documentedIds = rows.map(rowId);

describe('typography rule table — the page really is parsable (CR/F-CR-6)', () => {
  /**
   * Every check below compares two sets. If the parse silently yields nothing —
   * the heading is renamed, the table becomes a list, the id column moves — the
   * comparison would collapse to "empty vs empty" or produce a wall of noise.
   * These floors make the parse itself the thing that fails.
   */

  test('the ## Правила section and its table are found', () => {
    expect(section.trim().length).toBeGreaterThan(0);
    expect(rows.length).toBeGreaterThan(0);
  });

  test('every table row carries a backticked rule id in the id column', () => {
    const malformed = rows.filter(row => rowId(row) === undefined);
    expect(malformed).toEqual([]);
  });

  test('no rule is listed twice', () => {
    const seen = new Set<string>();
    const duplicates = documentedIds.filter(id => id !== undefined && (seen.has(id) ? true : (seen.add(id), false)));
    expect(duplicates).toEqual([]);
  });
});

describe('typography rule table — documentation and the shipped registry agree (CR/F-CR-6)', () => {
  const documented = new Set(documentedIds.filter((id): id is string => id !== undefined));

  test('every rule the product ships has a row in the table', () => {
    const undocumented = [...ALL_TYPOGRAPHY_RULE_IDS].filter(id => !documented.has(id));
    expect(undocumented).toEqual([]);
  });

  test('every row in the table names a rule the product actually ships', () => {
    const phantom = [...documented].filter(id => !ALL_TYPOGRAPHY_RULE_IDS.has(id));
    expect(phantom).toEqual([]);
  });

  test('the count the page states is the number of rules that exist', () => {
    // The page tells the reader "все N правил движка". A hardcoded number is
    // fine as long as it cannot silently go stale — which is what this asserts.
    // The sentence is required to exist: dropping it would otherwise turn this
    // check off without anyone noticing.
    const stated = /перечислены все (\d+) правил/.exec(page);
    expect(stated).not.toBeNull();
    expect(Number(stated![1])).toBe(ALL_TYPOGRAPHY_RULE_IDS.size);
    // …and the table really lists that many rows, not just the right id set.
    expect(documented.size).toBe(ALL_TYPOGRAPHY_RULE_IDS.size);
  });
});
