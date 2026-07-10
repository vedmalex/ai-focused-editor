import { expect, test } from 'bun:test';
import {
  normalizeSemanticMarkdownTags,
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
