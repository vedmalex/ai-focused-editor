import { describe, expect, test } from 'bun:test';
import { TEXT_RUNNER_MAX_PASSES, runTypographyOnText } from './text-runner';
import { DefaultTypographyEngine } from './typography-engine';
import type { TypographyRule } from './typography-types';
import { ALL_TYPOGRAPHY_RULE_IDS, TYPOGRAPHY_RULES } from './typography-rules';
import { collapseMultipleSpacesRule } from './rules/collapse-multiple-spaces';
import { noSpaceBeforePunctuationRule } from './rules/no-space-before-punctuation';
import { spaceAfterPunctuationRule } from './rules/space-after-punctuation';
import { spacedHyphenToEmDashRule } from './rules/spaced-hyphen-to-em-dash';
import { openingQuoteToGuillemetRule } from './rules/opening-quote-to-guillemet';
import { closingQuoteToGuillemetRule } from './rules/closing-quote-to-guillemet';

const engine = new DefaultTypographyEngine([
  collapseMultipleSpacesRule,
  noSpaceBeforePunctuationRule,
  spaceAfterPunctuationRule,
  spacedHyphenToEmDashRule,
  openingQuoteToGuillemetRule,
  closingQuoteToGuillemetRule
]);

const ALL: ReadonlySet<string> = new Set([
  collapseMultipleSpacesRule.id,
  noSpaceBeforePunctuationRule.id,
  spaceAfterPunctuationRule.id,
  spacedHyphenToEmDashRule.id,
  openingQuoteToGuillemetRule.id,
  closingQuoteToGuillemetRule.id
]);

/**
 * The FULL rule set — THE CANONICAL REGISTRY ITSELF, not a copy of it (F-CR-1).
 *
 * This file used to declare its own `everyRule` array transcribed by hand from
 * the frontend module, because the registry lived behind the browser boundary and
 * this Node lane could not import it. Nothing checked that copy for completeness,
 * so a 15th rule added to the product and forgotten here would have left the
 * whole-document golden AND the anti-ISS-241 front-matter band below running
 * against 14 rules and reporting green. ISS-241 was a MASK defect — any rule
 * could be the one that corrupts metadata — so a silently-incomplete rule set is
 * exactly what those suites must not tolerate.
 *
 * The registry now lives in `common/typography/typography-rules.ts` and is
 * imported here, so every rule added to the product automatically enters these
 * suites. Deleting a rule from the registry likewise turns them red.
 *
 * Deliberately NOT re-derived or filtered: `TYPOGRAPHY_RULES` verbatim.
 */
const fullEngine = new DefaultTypographyEngine(TYPOGRAPHY_RULES);
const EVERY_ID: ReadonlySet<string> = ALL_TYPOGRAPHY_RULE_IDS;

/**
 * Metadata lines chosen to be MAXIMALLY attackable by the rule set:
 *  - `title: привет,мир`      — #37 would insert a space after `,`, #31 would
 *                               capitalize the `t` of `title`;
 *  - `updated: 2026-08-01T10:20` — #37 would break the clock into `10: 20`;
 *  - `type: chapter`          — the key the §1.3 scope gate itself depends on;
 *  - `subtitle: слово - слово`  — #38 would turn the hyphen into an em dash.
 */
const META_LINES = [
  'title: привет,мир',
  'type: chapter',
  'updated: 2026-08-01T10:20',
  'subtitle: слово - слово'
];
const FRONT_MATTER = ['---', ...META_LINES, '---'].join('\n');

describe('runTypographyOnText — YAML front matter is never rewritten (ISS-241)', () => {
  test('a full-rule run leaves the front matter byte-identical while editing the prose', () => {
    const body = ['иван шёл  по улице ,и молчал .', '', 'слово - слово'].join('\n');
    const input = `${FRONT_MATTER}\n\n${body}`;

    const { text, editCount } = runTypographyOnText(fullEngine, input, EVERY_ID, 'ru');

    // The run is NOT vacuous: prose below the front matter really was rewritten.
    expect(editCount).toBeGreaterThan(0);
    expect(text.slice(FRONT_MATTER.length)).not.toBe(input.slice(FRONT_MATTER.length));

    // …and the front-matter prefix survived character for character.
    const after = text.slice(0, FRONT_MATTER.length);
    expect(after).toBe(FRONT_MATTER);
    for (let i = 0; i < FRONT_MATTER.length; i++) {
      expect(after[i]).toBe(FRONT_MATTER[i]);
    }
    // Nothing was inserted that would push the closing delimiter down either.
    expect(text.split('\n').slice(0, 6)).toEqual(FRONT_MATTER.split('\n'));
  });

  test('anti-tautology: the SAME metadata lines ARE rewritten when they are prose', () => {
    // Proves the assertion above is carried by the code mask, not by the rules
    // happening to ignore this text.
    const input = ['проза.', '', ...META_LINES].join('\n');
    const { text } = runTypographyOnText(fullEngine, input, EVERY_ID, 'ru');
    const rewritten = text.split('\n').slice(2);

    expect(rewritten).not.toEqual(META_LINES);
    expect(rewritten[0]).toBe('Title: привет, мир');
    expect(rewritten[3]).toBe('subtitle: слово — слово');
    // The ISO timestamp is the ONE metadata line that survives even as prose:
    // rule #37's clock/structural guards (ISS-240) refuse to split `10:20`
    // wherever it appears. Two independent defences now cover it — the code
    // mask here and the rule's own guard — so this line proves nothing about
    // the mask and is asserted only to pin that overlap.
    expect(rewritten[2]).toBe('updated: 2026-08-01T10:20');
  });

  test('a mid-document --- separator does NOT get front-matter protection', () => {
    const input = ['проза.', '', '---', '', 'слово ,слово'].join('\n');
    const { text } = runTypographyOnText(fullEngine, input, EVERY_ID, 'ru');
    expect(text.split('\n')[4]).toBe('Слово, слово');
  });

  test('an UNCLOSED leading --- does not disable typography for the document', () => {
    const input = ['---', 'слово ,слово'].join('\n');
    const { text, editCount } = runTypographyOnText(fullEngine, input, EVERY_ID, 'ru');
    expect(editCount).toBeGreaterThan(0);
    expect(text.split('\n')[1]).toBe('слово, слово');
  });
});

describe('runTypographyOnText (pure multi-file driver)', () => {
  test('golden: whole document normalised, code fence left intact', () => {
    const input = [
      'foo  bar ,baz . end',
      '```',
      'let x =  1 ,2',
      '```',
      'слово - слово'
    ].join('\n');
    const { text, editCount } = runTypographyOnText(engine, input, ALL, 'ru');
    expect(editCount).toBeGreaterThan(0);
    expect(text).toBe([
      'foo bar, baz. end',
      '```',
      'let x =  1 ,2',
      '```',
      'слово — слово'
    ].join('\n'));
  });

  test('Q7 integration: typing "привет" resolves to «привет» (ru)', () => {
    // The autoClosingQuotes:"never" seam means the buffer holds the raw straight
    // quotes; the engine converts opening→« and closing→» with no orphan.
    const { text } = runTypographyOnText(engine, '"привет"', ALL, 'ru');
    expect(text).toBe('«привет»');
  });

  test('CRLF line endings are preserved', () => {
    const input = 'foo  bar\r\nsecond ,line';
    const { text } = runTypographyOnText(engine, input, ALL, 'ru');
    expect(text).toBe('foo bar\r\nsecond, line');
  });

  test('empty enabled set is a no-op', () => {
    const { text, editCount } = runTypographyOnText(engine, 'foo  bar', new Set(), 'ru');
    expect(editCount).toBe(0);
    expect(text).toBe('foo  bar');
  });

  test('idempotence: a second run makes no edits', () => {
    const first = runTypographyOnText(engine, 'foo  bar ,baz', ALL, 'ru');
    const second = runTypographyOnText(engine, first.text, ALL, 'ru');
    expect(second.editCount).toBe(0);
    expect(second.text).toBe(first.text);
  });
});

/**
 * A manuscript page written the way an author actually types one: dialogue
 * dashes, straight quotes, a stutter caps-lock, spaced hyphens, acronyms and
 * units that must NOT be "fixed", abbreviations, front matter, a fenced code
 * block and an inline-code span — all in one document, so every rule in the canonical
 * registry has something to bite on AND something to leave alone.
 *
 * The point is INTERACTION: the per-rule suites prove each rule is individually
 * idempotent, and the runs above prove convergence over 3- and 6-rule subsets,
 * but the shipped product runs THE WHOLE REGISTRY TOGETHER over exactly this kind
 * of text.
 * A pair that ping-pongs (one rule undoing another) is invisible to every
 * subset test and would surface to a user as a document that keeps changing
 * every time the batch command is invoked (QA/ISS-255).
 */
const SATURATED_PAGE = [
  '---',
  'title: привет,мир',
  'type: chapter',
  'updated: 2026-08-01T10:20',
  '---',
  '',
  '# заголовок остаётся',
  '',
  'иван шёл по улице ,и молчал .он думал о том ,что всё кончено .',
  '',
  '- первый пункт ,второй',
  '- ВТорой пункт .',
  '',
  '— как дела ? спросил ОН .',
  '— всё хорошо ,ответила она .',
  '',
  'она сказала: "привет ,мир" и ушла .',
  '',
  'слово - слово, и ещё раз слово - слово .',
  '',
  'он ПРишёл домой. КАк всегда ,поздно .',
  '',
  'по ГОСТ 12345 и США — давление 10 МПа .',
  '',
  'см. рис ниже, т.е. вот тут ,и стр. 5 далее .',
  '',
  'тут  двойной пробел вместо точки',
  '',
  '```',
  'let x =  1 ,2   // КОд НЕ трогаем .',
  'const s = "не  кавычки"',
  '```',
  '',
  'а тут `код  внутри ,строки` и обычный текст .',
  '',
  'конец .'
].join('\n');

describe('runTypographyOnText — the WHOLE registry together reaches a fixpoint (ISS-255)', () => {
  test('CRITICAL: a second full-set run over a saturated page makes ZERO edits', () => {
    const first = runTypographyOnText(fullEngine, SATURATED_PAGE, EVERY_ID, 'ru');

    // Not vacuous: the first run really did rewrite the page, and it converged
    // WITHIN the pass budget rather than being cut off by it.
    expect(first.editCount).toBeGreaterThan(0);
    expect(first.text).not.toBe(SATURATED_PAGE);
    expect(first.converged).toBe(true);
    // More than one productive pass is needed here — one rule's output unlocks
    // another's input — so this genuinely exercises the fixpoint loop.
    expect(first.passes).toBeGreaterThan(1);

    const second = runTypographyOnText(fullEngine, first.text, EVERY_ID, 'ru');
    expect(second.editCount).toBe(0);
    expect(second.text).toBe(first.text);

    // A third run for the ping-pong case a single re-run cannot catch: a pair
    // with an even-length cycle returns to a stable-looking text after two runs.
    const third = runTypographyOnText(fullEngine, second.text, EVERY_ID, 'ru');
    expect(third.editCount).toBe(0);
    expect(third.text).toBe(first.text);
  });

  test('the converged page is the RIGHT page, not merely a stable one', () => {
    // Spot checks across the rule bands, so "no further edits" cannot be
    // satisfied by a run that mangled the text into a fixed point.
    const { text } = runTypographyOnText(fullEngine, SATURATED_PAGE, EVERY_ID, 'ru');
    const lines = text.split('\n');

    // Front matter: byte-identical (ISS-241).
    expect(lines.slice(0, 5)).toEqual(['---', 'title: привет,мир', 'type: chapter', 'updated: 2026-08-01T10:20', '---']);
    // Heading left alone; prose capitalized and punctuated.
    expect(text).toContain('# заголовок остаётся');
    expect(text).toContain('Иван шёл по улице, и молчал. Он думал о том, что всё кончено.');
    // Dialogue dashes (#41) and quotes (#34/#35).
    expect(text).toContain('— Как дела? Спросил ОН.');
    expect(text).toContain('«привет, мир»');
    // Em dash (#32) and the stutter fixers (#42/#43).
    expect(text).toContain('Слово — слово, и ещё раз слово — слово.');
    expect(text).toContain('Он Пришёл домой. Как всегда, поздно.');
    // Negatives that must SURVIVE the full set: acronyms, units, abbreviations.
    expect(text).toContain('По ГОСТ 12345 и США — давление 10 МПа.');
    expect(text).toContain('См. рис ниже, т. е. вот тут, и стр. 5 далее.');
    // Code is untouched — fence content and inline span alike.
    expect(text).toContain('let x =  1 ,2   // КОд НЕ трогаем .');
    expect(text).toContain('const s = "не  кавычки"');
    expect(text).toContain('`код  внутри ,строки`');
  });

  test('a clean document converges on the FIRST pass with no edits', () => {
    const clean = runTypographyOnText(fullEngine, SATURATED_PAGE, EVERY_ID, 'ru').text;
    const again = runTypographyOnText(fullEngine, clean, EVERY_ID, 'ru');
    expect(again.passes).toBe(1);
    expect(again.converged).toBe(true);
  });
});

/**
 * A deliberately NON-CONVERGING rule pair: `flip-a` rewrites a leading `a` to
 * `b`, `flip-b` rewrites a leading `b` back to `a`. Each pass produces exactly
 * one edit and the next pass undoes it, so the loop can only ever stop on its
 * pass budget.
 *
 * This is the one thing `TEXT_RUNNER_MAX_PASSES` exists for, and before ISS-255
 * nothing observed it: the runner returned an INTERMEDIATE text together with a
 * healthy-looking `editCount`, indistinguishable from a finished run. A rule pair
 * introduced later that failed to converge would therefore have shipped silently.
 */
function flipRule(id: string, from: string, to: string, priority: number): TypographyRule {
  return {
    id,
    descriptionKey: `ai-focused-editor/typography/${id}-desc`,
    defaultEnabled: true,
    priority,
    apply: ctx => {
      const line = ctx.lines[0];
      if (!line || line.text[0] !== from) {
        return null;
      }
      return [{
        ruleId: id,
        range: { start: { line: line.lineNumber, column: 1 }, end: { line: line.lineNumber, column: 2 } },
        text: to
      }];
    }
  };
}

describe('runTypographyOnText — the pass budget is observable, not silent success (ISS-255)', () => {
  const flipA = flipRule('flip-a', 'a', 'b', 20);
  const flipB = flipRule('flip-b', 'b', 'a', 10);
  const flipEngine = new DefaultTypographyEngine([flipA, flipB]);
  const FLIP_IDS: ReadonlySet<string> = new Set(['flip-a', 'flip-b']);

  test('CRITICAL: a non-converging pair stops at maxPasses and reports converged: false', () => {
    const result = runTypographyOnText(flipEngine, 'a tail', FLIP_IDS, 'ru');

    expect(result.converged).toBe(false);
    expect(result.passes).toBe(TEXT_RUNNER_MAX_PASSES);
    // It really did run the full budget — one edit per pass, none skipped.
    expect(result.editCount).toBe(TEXT_RUNNER_MAX_PASSES);
    // …and it terminated rather than spinning: the assertion above only holds
    // because the loop returned at all.
    expect(result.text).toMatch(/^[ab] tail$/);
  });

  test('ANTI-TAUTOLOGY: the same engine on text it CAN finish reports converged: true', () => {
    // `flip-b` alone on `a tail` matches nothing → one clean pass.
    const result = runTypographyOnText(flipEngine, 'a tail', new Set(['flip-b']), 'ru');
    expect(result.converged).toBe(true);
    expect(result.passes).toBe(1);
    expect(result.editCount).toBe(0);
    expect(result.text).toBe('a tail');
  });

  test('an explicit lower maxPasses is honoured and reported', () => {
    const result = runTypographyOnText(flipEngine, 'a tail', FLIP_IDS, 'ru', 3);
    expect(result.passes).toBe(3);
    expect(result.editCount).toBe(3);
    expect(result.converged).toBe(false);
  });

  test('a run that converges reports the passes it actually used, not the budget', () => {
    // `flip-a` alone: pass 1 rewrites `a`→`b`, pass 2 finds nothing.
    const result = runTypographyOnText(flipEngine, 'a tail', new Set(['flip-a']), 'ru');
    expect(result.text).toBe('b tail');
    expect(result.passes).toBe(2);
    expect(result.editCount).toBe(1);
    expect(result.converged).toBe(true);
  });

  test('an empty enabled set is a converged no-op (nothing to disagree about)', () => {
    const result = runTypographyOnText(flipEngine, 'a tail', new Set(), 'ru');
    expect(result).toEqual({ text: 'a tail', editCount: 0, passes: 0, converged: true });
  });
});
