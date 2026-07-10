import { describe, expect, test } from 'bun:test';
import { parseSemanticMarkdown } from '@ai-focused-editor/semantic-markdown';
import {
  findHeadingLine,
  isSkippableLinkTarget,
  parseBareEntityTags,
  resolveRelativeLink,
  semanticTagLinkRange,
  slugifyBase,
  splitLinkAnchor,
  tagKindToEntityKind
} from './link-navigation';

describe('tagKindToEntityKind', () => {
  test('maps the char shorthand to the character entity kind', () => {
    expect(tagKindToEntityKind('char')).toBe('character');
  });

  test('passes every other kind through verbatim', () => {
    expect(tagKindToEntityKind('term')).toBe('term');
    expect(tagKindToEntityKind('artifact')).toBe('artifact');
    expect(tagKindToEntityKind('location')).toBe('location');
  });
});

describe('semanticTagLinkRange', () => {
  test('covers only [[kind:id, stopping before the pipe', () => {
    const text = '[[char:frodo|Frodo]]';
    const [tag] = parseSemanticMarkdown(text).tags;
    const range = semanticTagLinkRange(tag);
    // `[[char:frodo` is 12 chars (indices 0..11); the `|` at index 12 is excluded.
    expect(range.start).toEqual({ line: 0, character: 0 });
    expect(range.end).toEqual({ line: 0, character: 12 });
    expect(text.slice(range.start.character, range.end.character)).toBe('[[char:frodo');
  });

  test('honours a tag that does not start at column 0', () => {
    const text = 'See [[term:one-ring|the One Ring]] here.';
    const [tag] = parseSemanticMarkdown(text).tags;
    const range = semanticTagLinkRange(tag);
    expect(range.start).toEqual({ line: 0, character: 4 });
    expect(text.slice(range.start.character, range.end.character)).toBe('[[term:one-ring');
  });

  test('computes ranges on a later line', () => {
    const text = 'intro line\n\n[[artifact:sting|Sting]] glows.';
    const [tag] = parseSemanticMarkdown(text).tags;
    const range = semanticTagLinkRange(tag);
    expect(range.start).toEqual({ line: 2, character: 0 });
    // `[[artifact:sting` is 16 chars; the `|` at index 16 is excluded.
    expect(range.end).toEqual({ line: 2, character: 16 });
  });
});

describe('parseBareEntityTags', () => {
  test('parses a bare [[id]] reference', () => {
    const matches = parseBareEntityTags('meet [[frodo]] now');
    expect(matches).toEqual([{ id: 'frodo', start: 5, end: 14 }]);
  });

  test('parses an unlabeled [[kind:id]] reference', () => {
    const matches = parseBareEntityTags('[[char:frodo]]');
    expect(matches).toEqual([{ kind: 'char', id: 'frodo', start: 0, end: 14 }]);
  });

  test('ignores labeled [[kind:id|label]] tags', () => {
    expect(parseBareEntityTags('[[char:frodo|Frodo]]')).toEqual([]);
  });

  test('handles a mix and multiple matches', () => {
    const text = '[[frodo]] and [[term:ring|the ring]] and [[location:shire]]';
    const matches = parseBareEntityTags(text);
    expect(matches.map(m => ({ kind: m.kind, id: m.id }))).toEqual([
      { kind: undefined, id: 'frodo' },
      { kind: 'location', id: 'shire' }
    ]);
  });
});

describe('isSkippableLinkTarget', () => {
  test('skips external, mailto, in-page and empty targets', () => {
    for (const target of [
      '',
      '   ',
      '#section',
      'http://example.com',
      'https://example.com/a',
      'HTTPS://EXAMPLE.COM',
      'file:///etc/passwd',
      'ftp://host/x',
      'mailto:me@example.com',
      'tel:+123',
      'javascript:alert(1)'
    ]) {
      expect(isSkippableLinkTarget(target)).toBe(true);
    }
  });

  test('does not skip relative paths', () => {
    for (const target of ['chapter.md', './a.md', '../b.md#h', 'notes/c.md']) {
      expect(isSkippableLinkTarget(target)).toBe(false);
    }
  });
});

describe('splitLinkAnchor', () => {
  test('splits path and anchor on the first hash', () => {
    expect(splitLinkAnchor('a/b.md#heading')).toEqual({ path: 'a/b.md', anchor: 'heading' });
  });

  test('returns no anchor when there is no hash', () => {
    expect(splitLinkAnchor('a/b.md')).toEqual({ path: 'a/b.md' });
  });

  test('drops an empty trailing anchor', () => {
    expect(splitLinkAnchor('a/b.md#')).toEqual({ path: 'a/b.md' });
  });
});

describe('resolveRelativeLink', () => {
  const root = '/ws/proj';
  const doc = '/ws/proj/chapters/ch1.md';

  test('resolves a sibling relative path', () => {
    expect(resolveRelativeLink('ch2.md', doc, root)).toEqual({ path: '/ws/proj/chapters/ch2.md' });
  });

  test('resolves a ../ path with an anchor', () => {
    expect(resolveRelativeLink('../notes/n.md#the-heading', doc, root)).toEqual({
      path: '/ws/proj/notes/n.md',
      anchor: 'the-heading'
    });
  });

  test('resolves a leading-slash path against the workspace root', () => {
    expect(resolveRelativeLink('/appendix/a.md', doc, root)).toEqual({ path: '/ws/proj/appendix/a.md' });
  });

  test('resolves a ./ path', () => {
    expect(resolveRelativeLink('./sub/x.md', doc, root)).toEqual({ path: '/ws/proj/chapters/sub/x.md' });
  });

  test('decodes percent-encoded segments', () => {
    expect(resolveRelativeLink('my%20file.md', doc, root)).toEqual({ path: '/ws/proj/chapters/my file.md' });
  });

  test('rejects targets that escape the workspace root', () => {
    expect(resolveRelativeLink('../../../etc/passwd', doc, root)).toBeUndefined();
    expect(resolveRelativeLink('../../outside.md', doc, root)).toBeUndefined();
  });

  test('skips external, mailto and #-only targets', () => {
    expect(resolveRelativeLink('https://example.com', doc, root)).toBeUndefined();
    expect(resolveRelativeLink('mailto:me@example.com', doc, root)).toBeUndefined();
    expect(resolveRelativeLink('#local', doc, root)).toBeUndefined();
    expect(resolveRelativeLink('', doc, root)).toBeUndefined();
  });

  test('allows a target that resolves exactly to the root', () => {
    expect(resolveRelativeLink('..', doc, root)).toEqual({ path: '/ws/proj' });
  });
});

describe('slugifyBase', () => {
  test('lowercases and hyphenates', () => {
    expect(slugifyBase('The One Ring')).toBe('the-one-ring');
  });

  test('is idempotent on already-slugged input', () => {
    expect(slugifyBase('the-one-ring')).toBe('the-one-ring');
  });

  test('keeps Unicode letters', () => {
    expect(slugifyBase('Главный Герой')).toBe('главный-герой');
  });

  test('trims leading/trailing separators', () => {
    expect(slugifyBase('  **Sting!** ')).toBe('sting');
  });
});

describe('findHeadingLine', () => {
  const doc = [
    '# Chapter One',
    '',
    'Some prose.',
    '',
    '## The Second Section',
    '',
    'More prose.'
  ].join('\n');

  test('finds a heading by its slug', () => {
    expect(findHeadingLine(doc, 'chapter-one')).toBe(0);
    expect(findHeadingLine(doc, 'the-second-section')).toBe(4);
  });

  test('matches regardless of anchor casing/format', () => {
    expect(findHeadingLine(doc, 'The Second Section')).toBe(4);
  });

  test('returns undefined when no heading matches', () => {
    expect(findHeadingLine(doc, 'missing')).toBeUndefined();
    expect(findHeadingLine(doc, '')).toBeUndefined();
  });
});
