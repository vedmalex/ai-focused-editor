import { expect, test } from 'bun:test';
import {
  classifyWikiLinkCandidate,
  nextFootnoteNumber,
  normalizeSemanticMarkdownTags,
  parseFootnotes,
  parseSemanticMarkdown,
  renderSemanticMarkdownPreview,
  renderTaskListGlyphs,
  splitMathSegments,
  validateSemanticMarkdown
} from './semantic-markdown';
import type { MathSegment } from './semantic-markdown';

test('parses semantic tags with ranges', () => {
  const document = parseSemanticMarkdown('A [[char:krishna|Krishna]] meets [[term:dharma|dharma]].');

  expect(document.tags).toHaveLength(2);
  expect(document.tags[0]).toMatchObject({
    kind: 'char',
    id: 'krishna',
    label: 'Krishna',
    range: {
      start: { line: 0, character: 2 },
      end: { line: 0, character: 26 }
    },
    labelRange: {
      start: { line: 0, character: 17 },
      end: { line: 0, character: 24 }
    }
  });
  expect(document.tags[1]).toMatchObject({
    kind: 'term',
    id: 'dharma',
    label: 'dharma'
  });
});

test('keeps line and character ranges across lines', () => {
  const document = parseSemanticMarkdown('Intro\n[[artifact:gandiva|Gandiva]]');

  expect(document.tags[0].range).toEqual({
    start: { line: 1, character: 0 },
    end: { line: 1, character: 28 }
  });
});

test('renders semantic tags into portable preview markdown', () => {
  expect(renderSemanticMarkdownPreview('Hello [[char:krishna|Krishna]].')).toBe('Hello **Krishna** _(char:krishna)_.');
});

test('renders GFM task-list markers as ballot-box glyphs', () => {
  expect(renderTaskListGlyphs('- [ ] todo\n- [x] done\n- plain')).toBe('- ☐ todo\n- ☑ done\n- plain');
  // Indented + ordered task items keep their list prefix.
  expect(renderTaskListGlyphs('  - [X] nested\n1. [ ] first')).toBe('  - ☑ nested\n1. ☐ first');
  // Non-task list items and inline brackets are untouched.
  expect(renderTaskListGlyphs('a [x] mid-line\n- normal item')).toBe('a [x] mid-line\n- normal item');
});

test('preview keeps task-list glyphs alongside semantic tags', () => {
  expect(renderSemanticMarkdownPreview('- [x] meet [[char:krishna|Krishna]]'))
    .toBe('- ☑ meet **Krishna** _(char:krishna)_');
});

test('validates malformed semantic tag candidates', () => {
  const diagnostics = validateSemanticMarkdown('A [[char:krishna Krishna]]\nB [[term:dharma|dharma');

  expect(diagnostics).toHaveLength(2);
  expect(diagnostics[0]).toMatchObject({
    severity: 'error',
    message: 'Invalid semantic Markdown tag. Expected [[kind:id|label]] with single-line label and ASCII id.',
    range: {
      start: { line: 0, character: 2 },
      end: { line: 0, character: 26 }
    }
  });
  expect(diagnostics[1]).toMatchObject({
    severity: 'error',
    message: 'Unclosed semantic Markdown tag. Expected closing ]].',
    range: {
      start: { line: 1, character: 2 },
      end: { line: 1, character: 22 }
    }
  });
});

test('does not flag bare [[id]] references', () => {
  expect(validateSemanticMarkdown('See [[krishna]] for context.')).toHaveLength(0);
});

test('does not flag bare [[kind:id]] references', () => {
  expect(validateSemanticMarkdown('See [[char:krishna]] for context.')).toHaveLength(0);
});

test('does not flag bare [[id#anchor]] references with a Cyrillic anchor', () => {
  // Bare-form anchors are not ASCII-restricted (TASK-012, UR-002): the id/anchor
  // token may hold Unicode, unlike the labeled kind:id|label form.
  expect(validateSemanticMarkdown('See [[sharan-domain-relation-map#Полный-baseline-обзор]] for context.'))
    .toHaveLength(0);
});

test('does not flag bare [[kind:id#anchor]] references with a Cyrillic anchor', () => {
  expect(validateSemanticMarkdown('See [[doc:sharan-domain-relation-map#Полный-baseline-обзор]] here.'))
    .toHaveLength(0);
});

test('still validates the labeled kind:id|label form with ASCII id', () => {
  expect(validateSemanticMarkdown('Meet [[char:krishna|Krishna]].')).toHaveLength(0);
});

test('still flags a malformed pipe-less candidate with embedded whitespace as invalid', () => {
  // Regression guard: `krishna Krishna` is not a valid bare id (embedded
  // whitespace is stray prose, not a single-token bare reference) — this must
  // keep failing exactly like the pre-existing malformed-tag test above.
  const diagnostics = validateSemanticMarkdown('A [[char:krishna Krishna]]');
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toMatchObject({
    severity: 'error',
    message: 'Invalid semantic Markdown tag. Expected [[kind:id|label]] with single-line label and ASCII id.'
  });
});

test('still flags an unclosed semantic Markdown tag', () => {
  const diagnostics = validateSemanticMarkdown('B [[term:dharma|dharma');
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toMatchObject({
    severity: 'error',
    message: 'Unclosed semantic Markdown tag. Expected closing ]].'
  });
});

test('still flags a multiline label inside the labeled kind:id|label form', () => {
  const diagnostics = validateSemanticMarkdown('A [[term:dharma|multi\nline]] end');
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toMatchObject({
    severity: 'error',
    message: 'Invalid semantic Markdown tag. Expected [[kind:id|label]] with single-line label and ASCII id.'
  });
});

// ---------------------------------------------------------------------------
// classifyWikiLinkCandidate / validateSemanticMarkdown — TASK-013 kind-grammar
// table (§2): Obsidian-style [[note]] links vs [[kind:id]] entity references,
// discriminated by whether the pre-`:` prefix matches the Unicode-lowercase
// kind grammar (ISS-136).
// ---------------------------------------------------------------------------

test('parses a labeled entity tag with a Cyrillic kind (ISS-136 Unicode-lowercase kind grammar)', () => {
  const document = parseSemanticMarkdown('Смотри [[персонаж:ivan|Иван]] тут.');
  expect(document.tags).toHaveLength(1);
  expect(document.tags[0]).toMatchObject({ kind: 'персонаж', id: 'ivan', label: 'Иван' });
});

test('classifies a labeled entity with a Cyrillic kind as valid', () => {
  expect(classifyWikiLinkCandidate('[[персонаж:ivan|Иван]]')).toMatchObject({
    kind: 'entity',
    valid: true,
    entityKind: 'персонаж',
    id: 'ivan',
    alias: 'Иван'
  });
  expect(validateSemanticMarkdown('[[персонаж:ivan|Иван]]')).toHaveLength(0);
});

test('classifies a bare entity with a Cyrillic kind as valid', () => {
  expect(classifyWikiLinkCandidate('[[персонаж:ivan]]')).toMatchObject({
    kind: 'entity',
    valid: true,
    entityKind: 'персонаж',
    id: 'ivan'
  });
  expect(validateSemanticMarkdown('[[персонаж:ivan]]')).toHaveLength(0);
});

test('classifies [[sharan-108]] (bare, no colon) as a valid note-form reference (§2)', () => {
  // No `:` in the path => note intent, even though it also happens to look
  // like a bare entity id; resolution order (entity-first) is a studio
  // concern outside this validator (TASK-013 §3/U4), not a grammar concern.
  expect(classifyWikiLinkCandidate('[[sharan-108]]')).toMatchObject({ kind: 'note', valid: true, path: 'sharan-108' });
  expect(validateSemanticMarkdown('[[sharan-108]]')).toHaveLength(0);
});

test('classifies a plain Obsidian-style note name with spaces as valid', () => {
  expect(classifyWikiLinkCandidate('[[Моя заметка]]')).toMatchObject({
    kind: 'note',
    valid: true,
    path: 'Моя заметка'
  });
  expect(validateSemanticMarkdown('See [[Моя заметка]] here.')).toHaveLength(0);
});

test('classifies a vault-relative note path (with /) as valid', () => {
  expect(classifyWikiLinkCandidate('[[folder/Моя заметка]]')).toMatchObject({
    kind: 'note',
    valid: true,
    path: 'folder/Моя заметка'
  });
  expect(validateSemanticMarkdown('[[folder/Моя заметка]]')).toHaveLength(0);
});

test('classifies a note + anchor reference with a Cyrillic heading', () => {
  expect(classifyWikiLinkCandidate('[[page#Заголовок]]')).toMatchObject({
    kind: 'note',
    valid: true,
    path: 'page',
    anchor: 'Заголовок'
  });
  expect(validateSemanticMarkdown('[[page#Заголовок]]')).toHaveLength(0);
});

test('classifies a note + alias reference', () => {
  expect(classifyWikiLinkCandidate('[[Моя заметка|Подпись]]')).toMatchObject({
    kind: 'note',
    valid: true,
    path: 'Моя заметка',
    alias: 'Подпись'
  });
  expect(validateSemanticMarkdown('[[Моя заметка|Подпись]]')).toHaveLength(0);
});

test('a colon preceded by an uppercase/space prefix does not match the kind grammar => note, not entity', () => {
  // "Some Note" fails ^\p{Ll}[\p{L}\p{N}_-]*$ (uppercase first char + an
  // embedded space), so the whole candidate is a note title that happens to
  // contain a literal colon, not an entity kind:id split (TASK-013 §1/§2).
  expect(classifyWikiLinkCandidate('[[Some Note: Subtitle]]')).toMatchObject({
    kind: 'note',
    valid: true,
    path: 'Some Note: Subtitle'
  });
  expect(validateSemanticMarkdown('[[Some Note: Subtitle]]')).toHaveLength(0);
});

test('a lowercase-token + colon prefix is read as entity intent even for a note-like phrase (trade-off, §1/§9 ISS-140)', () => {
  // "заметка" is all-lowercase (incl. Cyrillic), so it matches the kind
  // grammar: the candidate is classified as an ENTITY attempt, and the
  // space-containing remainder fails the ASCII id grammar => Invalid (NOT
  // silently reclassified as a valid note — this is the documented trade-off).
  expect(classifyWikiLinkCandidate('[[заметка: хвост]]')).toEqual({ kind: 'entity', valid: false });
  const diagnostics = validateSemanticMarkdown('[[заметка: хвост]]');
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toMatchObject({
    severity: 'error',
    message: 'Invalid semantic Markdown tag. Expected [[kind:id|label]] with single-line label and ASCII id.'
  });
});

test('rejects an empty [[]] candidate', () => {
  expect(classifyWikiLinkCandidate('[[]]')).toEqual({ kind: 'note', valid: false });
  expect(validateSemanticMarkdown('See [[]] here.')).toHaveLength(1);
});

// ISS-146: `classifyWikiLinkCandidate` must trim `path` exactly like
// `classifyWikiLinkToken` (link-navigation.ts) does — same whitespace-only
// and padded-note cases pinned in both packages' test suites.
test('rejects a whitespace-only [[ ]] candidate the same way as [[]] (ISS-146)', () => {
  expect(classifyWikiLinkCandidate('[[ ]]')).toEqual({ kind: 'note', valid: false });
  expect(validateSemanticMarkdown('See [[ ]] here.')).toHaveLength(1);
});

test('trims surrounding whitespace before classifying a padded note path (ISS-146)', () => {
  expect(classifyWikiLinkCandidate('[[ x ]]')).toMatchObject({ kind: 'note', valid: true, path: 'x' });
  expect(validateSemanticMarkdown('[[ x ]]')).toHaveLength(0);
});

test('trims surrounding whitespace before classifying a padded Cyrillic note path (ISS-146)', () => {
  expect(classifyWikiLinkCandidate('[[  Моя заметка  ]]')).toMatchObject({
    kind: 'note',
    valid: true,
    path: 'Моя заметка'
  });
  expect(validateSemanticMarkdown('[[  Моя заметка  ]]')).toHaveLength(0);
});

test('normalizes valid semantic tag label spacing', () => {
  expect(normalizeSemanticMarkdownTags('[[char:krishna|  Krishna   Govinda ]]')).toBe('[[char:krishna|Krishna Govinda]]');
});

test('parses footnote references and definitions with ranges', () => {
  const document = parseFootnotes('A claim.[^1]\nMore.[^2]\n\n[^1]: First note.\n[^2]: Second note.');

  expect(document.references.map(reference => reference.id)).toEqual(['1', '2']);
  expect(document.definitions.map(definition => definition.id)).toEqual(['1', '2']);
  expect(document.numbers.get('1')).toBe(1);
  expect(document.numbers.get('2')).toBe(2);
  // Reference marker range covers `[^1]` on line 0.
  expect(document.references[0].range).toMatchObject({
    start: { line: 0, character: 8 },
    end: { line: 0, character: 12 }
  });
  // Definition marker range covers `[^1]` at the start of its line.
  expect(document.definitions[0]).toMatchObject({
    line: 3,
    text: 'First note.',
    range: { start: { line: 3, character: 0 }, end: { line: 3, character: 4 } }
  });
});

test('does not treat definition markers as references', () => {
  const document = parseFootnotes('[^1]: lonely definition');
  expect(document.references).toHaveLength(0);
  expect(document.definitions).toHaveLength(1);
});

test('computes the next free numeric footnote number', () => {
  expect(nextFootnoteNumber('No footnotes here.')).toBe(1);
  expect(nextFootnoteNumber('One.[^1]\n[^1]: a')).toBe(2);
  // Gaps and label ids do not lower the next numeric id.
  expect(nextFootnoteNumber('a[^3] b[^note]\n[^3]: c\n[^note]: d')).toBe(4);
});

test('renders footnote references as superscripts with an end Notes list', () => {
  expect(renderSemanticMarkdownPreview('A claim.[^1] More.[^2]\n\n[^1]: First note.\n[^2]: Second note.'))
    .toBe('A claim.¹ More.²\n\n#### Notes\n\n1. First note.\n2. Second note.');
});

test('keeps footnote Notes list working alongside semantic tags', () => {
  expect(renderSemanticMarkdownPreview('Meet [[char:krishna|Krishna]].[^1]\n\n[^1]: On the field.'))
    .toBe('Meet **Krishna** _(char:krishna)_.¹\n\n#### Notes\n\n1. On the field.');
});

// ---------------------------------------------------------------------------
// splitMathSegments — the detector shared by the preview widget and the exporter.
// ---------------------------------------------------------------------------

/** Compact helper: render segments as `type:value` for readable expectations. */
function shape(segments: MathSegment[]): string[] {
  return segments.map(segment => `${segment.type}:${segment.value}`);
}

test('splitMathSegments: plain text yields a single text segment', () => {
  expect(splitMathSegments('no math here')).toEqual([{ type: 'text', value: 'no math here' }]);
});

test('splitMathSegments: inline $...$ splits around the formula (delimiters stripped)', () => {
  expect(shape(splitMathSegments('energy $E=mc^2$ done')))
    .toEqual(['text:energy ', 'inline:E=mc^2', 'text: done']);
});

test('splitMathSegments: block $$...$$ may span newlines', () => {
  expect(shape(splitMathSegments('a\n\n$$\nx = y\n$$\n\nb')))
    .toEqual(['text:a\n\n', 'block:\nx = y\n', 'text:\n\nb']);
});

test('splitMathSegments: inline does not match across a newline (unclosed -> text)', () => {
  expect(splitMathSegments('$a\nb$')).toEqual([{ type: 'text', value: '$a\nb$' }]);
});

test('splitMathSegments: an unclosed inline delimiter degrades to text', () => {
  expect(splitMathSegments('cost is $5 today')).toEqual([{ type: 'text', value: 'cost is $5 today' }]);
});

test('splitMathSegments: an empty inline $$ is not math', () => {
  // Two adjacent `$$` with nothing between: no non-empty block, no inline -> all text.
  expect(splitMathSegments('a $$ b')).toEqual([{ type: 'text', value: 'a $$ b' }]);
});

test('splitMathSegments: escaped \\$ is literal, never a delimiter', () => {
  expect(splitMathSegments('price \\$5 and \\$10 flat'))
    .toEqual([{ type: 'text', value: 'price \\$5 and \\$10 flat' }]);
});

test('splitMathSegments: $ inside a fenced code block stays literal', () => {
  const input = 'before\n\n```\nlet a = $x$;\n```\n\nafter $y$ end';
  expect(shape(splitMathSegments(input)))
    .toEqual(['text:before\n\n```\nlet a = $x$;\n```\n\nafter ', 'inline:y', 'text: end']);
});

test('splitMathSegments: $ inside inline code stays literal', () => {
  expect(shape(splitMathSegments('use `$x$` then $y$')))
    .toEqual(['text:use `$x$` then ', 'inline:y']);
});

test('splitMathSegments: consecutive inline formulas', () => {
  expect(shape(splitMathSegments('$a$$b$'))).toEqual(['inline:a', 'inline:b']);
});

test('splitMathSegments: block is preferred over inline for $$', () => {
  expect(shape(splitMathSegments('$$x$$'))).toEqual(['block:x']);
});

test('splitMathSegments: reconstructing raw delimiters round-trips the source', () => {
  const source = 'a $i$ b\n$$blk$$ c';
  const rebuilt = splitMathSegments(source)
    .map(s => s.type === 'block' ? `$$${s.value}$$` : s.type === 'inline' ? `$${s.value}$` : s.value)
    .join('');
  expect(rebuilt).toBe(source);
});

test('splitMathSegments: a lone backtick does not swallow following math', () => {
  // Mirrors a preview text node that holds a literal backtick (no closing run):
  // the backtick is literal and the later $...$ still parses.
  expect(shape(splitMathSegments('a ` then $z$'))).toEqual(['text:a ` then ', 'inline:z']);
});
