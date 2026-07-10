import { expect, test } from 'bun:test';
import {
  nextFootnoteNumber,
  normalizeSemanticMarkdownTags,
  parseFootnotes,
  parseSemanticMarkdown,
  renderSemanticMarkdownPreview,
  renderTaskListGlyphs,
  validateSemanticMarkdown
} from './semantic-markdown';

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
