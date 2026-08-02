import { describe, expect, test } from 'bun:test';
import { computeCodeMask } from './code-mask';

describe('computeCodeMask — block code', () => {
  test('a ``` fence marks the fence lines and their content as code', () => {
    const lines = ['prose', '```js', 'const x = 1;', '```', 'more prose'];
    const mask = computeCodeMask(lines);
    expect(mask.isCode).toEqual([false, true, true, true, false]);
  });

  test('a ~~~ fence works the same way', () => {
    const lines = ['a', '~~~', 'code', '~~~', 'b'];
    expect(computeCodeMask(lines).isCode).toEqual([false, true, true, true, false]);
  });

  test('a closing fence must be at least as long as the opener', () => {
    const lines = ['````', 'still code', '```', 'STILL code', '````', 'prose'];
    // The 3-backtick line is too short to close a 4-backtick fence.
    expect(computeCodeMask(lines).isCode).toEqual([true, true, true, true, true, false]);
  });

  test('an unterminated fence keeps the rest of the document as code', () => {
    const lines = ['prose', '```', 'code', 'more code'];
    expect(computeCodeMask(lines).isCode).toEqual([false, true, true, true]);
  });

  test('a 4-space indented line is an indented code block', () => {
    const lines = ['prose', '    indented code', 'prose again'];
    expect(computeCodeMask(lines).isCode).toEqual([false, true, false]);
  });

  test('a tab-indented line is code; a 3-space indent is not', () => {
    const lines = ['\tcode', '   only three'];
    expect(computeCodeMask(lines).isCode).toEqual([true, false]);
  });
});

describe('computeCodeMask — YAML front matter (ISS-241)', () => {
  test('a leading --- block is code, delimiters included; prose below is not', () => {
    const lines = ['---', 'title: Х', 'type: chapter', '---', 'проза, тут'];
    const mask = computeCodeMask(lines);
    expect(mask.isCode).toEqual([true, true, true, true, false]);
    // Code lines carry no inline spans, so no rule can address them at all.
    expect(mask.inlineRanges.slice(0, 4)).toEqual([[], [], [], []]);
  });

  test('trailing whitespace on the delimiters still opens/closes the block', () => {
    const lines = ['---  ', 'type: chapter', '---\t', 'проза'];
    expect(computeCodeMask(lines).isCode).toEqual([true, true, true, false]);
  });

  test('--- in the MIDDLE of a document is a thematic break, not front matter', () => {
    const lines = ['проза', '', '---', 'type: chapter', '---', 'ещё проза'];
    expect(computeCodeMask(lines).isCode).toEqual([false, false, false, false, false, false]);
  });

  test('an UNCLOSED leading --- masks nothing (fail-open to the fence scanner)', () => {
    // Documented choice: one stray `---` at the top must not silently disable
    // typography for the entire manuscript.
    const lines = ['---', 'вот,текст', 'и ещё,текст'];
    expect(computeCodeMask(lines).isCode).toEqual([false, false, false]);
    // ...and the prose really is still addressable (inline scan ran on it).
    expect(computeCodeMask(['---', 'a `x` b']).inlineRanges[1]).toEqual([
      { startCol: 2, endCol: 5 }
    ]);
  });

  test('a lone --- line (no body, no closer) masks nothing', () => {
    expect(computeCodeMask(['---']).isCode).toEqual([false]);
  });

  test('---- / --- foo are NOT front matter openers', () => {
    expect(computeCodeMask(['----', 'title: Х', '---', 'проза']).isCode).toEqual([
      false, false, false, false
    ]);
    expect(computeCodeMask(['--- foo', 'title: Х', '---', 'проза']).isCode).toEqual([
      false, false, false, false
    ]);
  });

  test('an indented --- is not a front matter opener (and stays indent-code)', () => {
    const lines = ['  ---', 'title: Х', '---', 'проза'];
    expect(computeCodeMask(lines).isCode).toEqual([false, false, false, false]);
  });

  test('the block may be closed with the YAML ... document terminator', () => {
    const lines = ['---', 'type: chapter', '...', 'проза'];
    expect(computeCodeMask(lines).isCode).toEqual([true, true, true, false]);
  });

  test('an empty front matter (--- immediately followed by ---) is masked', () => {
    expect(computeCodeMask(['---', '---', 'проза']).isCode).toEqual([true, true, false]);
  });

  test('a BOM before the opening --- is tolerated', () => {
    const lines = ['﻿---', 'type: chapter', '---', 'проза'];
    expect(computeCodeMask(lines).isCode).toEqual([true, true, true, false]);
  });

  test('front matter does not disturb a fence that follows it', () => {
    const lines = [
      '---',
      'type: chapter',
      '---',
      'проза',
      '```js',
      'const x = 1;',
      '```',
      'ещё проза'
    ];
    expect(computeCodeMask(lines).isCode).toEqual([
      true, true, true, false, true, true, true, false
    ]);
  });

  test('a --- inside a fenced block does not close a front matter that is not open', () => {
    // Fence opens on line 0, so line 1 never reaches the front-matter probe.
    const lines = ['```', '---', '```', 'проза'];
    expect(computeCodeMask(lines).isCode).toEqual([true, true, true, false]);
  });
});

describe('computeCodeMask — inline code', () => {
  test('a single backtick pair yields one span covering the backticks', () => {
    const [ranges] = computeCodeMask(['a `code` b']).inlineRanges;
    expect(ranges).toEqual([{ startCol: 2, endCol: 8 }]);
  });

  test('an unmatched backtick yields no span', () => {
    expect(computeCodeMask(['a ` b']).inlineRanges[0]).toEqual([]);
  });

  test('two spans on one line are both detected', () => {
    const [ranges] = computeCodeMask(['`x` and `y`']).inlineRanges;
    expect(ranges).toEqual([
      { startCol: 0, endCol: 3 },
      { startCol: 8, endCol: 11 }
    ]);
  });

  test('a double-backtick span (embedding a single backtick) is matched by run length', () => {
    const [ranges] = computeCodeMask(['``a`b``']).inlineRanges;
    expect(ranges).toEqual([{ startCol: 0, endCol: 7 }]);
  });

  test('no inline spans are reported on a code line', () => {
    const lines = ['```', 'a `code` b', '```'];
    expect(computeCodeMask(lines).inlineRanges[1]).toEqual([]);
  });
});
