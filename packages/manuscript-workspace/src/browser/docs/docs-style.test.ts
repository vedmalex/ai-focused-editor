import { promises as fs } from 'fs';
import { join } from 'path';
import { describe, expect, test } from 'bun:test';

/**
 * Teeth over `style/docs.css` — specifically over the ONE thing in it a reader
 * can be wrong about without anything failing (ISS-095).
 *
 * WHAT WENT WRONG. The checked step used to be marked by colour alone:
 * `background: var(--theia-checkbox-selectBackground, var(--theia-button-background))`.
 * The fallback is dead — `checkbox.selectBackground` is registered
 * unconditionally by the colour registry — and its value coincided with
 * `--theia-checkbox-background`, so checked and unchecked painted the same
 * `rgb(238, 232, 213)`. The logic was correct throughout; only the indication
 * was missing, which is exactly the failure no unit test and no build step in
 * this repository can see.
 *
 * WHAT IS ASSERTED, AND WHY IT IS A PROPERTY RATHER THAN A SNAPSHOT. There is
 * no browser here, so "the two states look different" cannot be measured. The
 * property that MAKES it true in every theme can be: the difference between the
 * states must not be expressible in colour. A glyph is such a difference — a
 * character is either drawn or not, whatever the palette. So: the checked rule
 * must add a non-empty `content`, and the distinguishing declarations must
 * include at least one that is not a colour.
 *
 * The state is read from `aria-checked`, not from a modifier class, on purpose:
 * the visual and the accessible state then cannot drift apart.
 */

const CSS_PATH = join(import.meta.dir, '../style/docs.css');

interface Rule {
  readonly selector: string;
  readonly declarations: Map<string, string>;
}

/**
 * A deliberately small rule splitter: comments out, then `selector { body }`
 * pairs. Enough for a flat stylesheet with no at-rules, and it fails loudly
 * (zero rules) rather than quietly if that ever stops being true.
 */
async function rules(): Promise<Rule[]> {
  const text = (await fs.readFile(CSS_PATH, 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');
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

/** Merged declarations of every rule whose selector satisfies `predicate`. */
function declarationsOf(all: Rule[], predicate: (selector: string) => boolean): Map<string, string> {
  const merged = new Map<string, string>();
  for (const rule of all.filter(item => predicate(item.selector))) {
    for (const [property, value] of rule.declarations) {
      merged.set(property, value);
    }
  }
  return merged;
}

const COLOUR_PROPERTIES = new Set([
  'color', 'background', 'background-color', 'border-color', 'border', 'outline',
  'outline-color', 'box-shadow', 'opacity', 'fill', 'stroke'
]);

describe('the checklist indicator (ISS-095)', () => {
  test('the stylesheet parses into rules at all', async () => {
    expect((await rules()).length).toBeGreaterThan(10);
  });

  test('the checked state is keyed on aria-checked, so it cannot drift from the a11y state', async () => {
    const selectors = (await rules()).map(rule => rule.selector);
    expect(selectors.some(selector => /\.afe-docs-step\[aria-checked=['"]true['"]\]/.test(selector))).toBe(true);
  });

  test('checked adds a GLYPH — a difference no theme can flatten', async () => {
    const all = await rules();
    const unchecked = declarationsOf(
      all,
      selector => selector.includes('.afe-docs-step::after') && !selector.includes('aria-checked')
    );
    const checked = declarationsOf(
      all,
      selector => selector.includes('.afe-docs-step[aria-checked') && selector.includes('::after')
    );
    expect(unchecked.get('content')).toBe("''");
    expect(checked.get('content')).toBeDefined();
    expect(checked.get('content')).not.toBe("''");
    expect(checked.get('content')).toMatch(/\\e[0-9a-f]{3}/);
  });

  test('the indicator carries the codicon face, or the glyph is a tofu box', async () => {
    const base = declarationsOf(
      await rules(),
      selector => selector.includes('.afe-docs-step::after') && !selector.includes('aria-checked')
    );
    expect(base.get('font-family')).toContain('codicon');
  });

  test('at least one distinguishing declaration is NOT a colour', async () => {
    // The regression guard proper. Reverting to a colour-only indicator — of
    // any pair of variables, not just the two that collided — leaves this set
    // empty and fails here.
    const all = await rules();
    const distinguishing = all
      .filter(rule => /\.afe-docs-step\[aria-checked=['"]true['"]\]/.test(rule.selector))
      .flatMap(rule => [...rule.declarations.keys()])
      .filter(property => !COLOUR_PROPERTIES.has(property));
    expect(distinguishing).toContain('content');
  });

  test('nothing in the checked path depends on --theia-checkbox-selectBackground', async () => {
    // Named explicitly because this is the variable that was MEASURED equal to
    // --theia-checkbox-background in the running app; its documented meaning is
    // "the element it is in is selected", which is not "checked" at all.
    const all = await rules();
    const checkedValues = all
      .filter(rule => rule.selector.includes('aria-checked') || rule.selector.includes('--checked'))
      .flatMap(rule => [...rule.declarations.values()])
      .join(' ');
    expect(checkedValues).not.toContain('--theia-checkbox-selectBackground');
    expect(checkedValues).not.toContain('--theia-checkbox-selectBorder');
  });

  test('the step row is focusable-looking: it declares a focus-visible outline', async () => {
    // It is a <span> since ISS-094, so the focus ring is no longer free.
    const selectors = (await rules()).map(rule => rule.selector);
    expect(selectors).toContain('.afe-docs-step:focus-visible');
  });
});
