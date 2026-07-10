import { expect, test } from 'bun:test';
import { convertMarkdownToTelegraphNodes } from './markdownConverter';

test('EPUB target renders GFM tables as semantic <table> nodes', () => {
  const nodes = convertMarkdownToTelegraphNodes(
    ['| A | B |', '| - | - |', '| 1 | 2 |', ''].join('\n'),
    { target: 'epub', generateToc: false }
  );
  const json = JSON.stringify(nodes);
  expect(json).toContain('"tag":"table"');
  expect(json).toContain('"tag":"th"');
  expect(json).toContain('"tag":"td"');
});

test('EPUB target renders GFM strikethrough as <del>', () => {
  const nodes = convertMarkdownToTelegraphNodes('Karma-yoga is ~~Bondage~~ Freedom.', {
    target: 'epub',
    generateToc: false
  });
  expect(JSON.stringify(nodes)).toContain('"tag":"del"');
});

test('EPUB target renders GFM task-list markers as ballot-box glyphs', () => {
  const nodes = convertMarkdownToTelegraphNodes(['- [x] done', '- [ ] open', ''].join('\n'), {
    target: 'epub',
    generateToc: false
  });
  const json = JSON.stringify(nodes);
  expect(json).toContain('☑ ');
  expect(json).toContain('☐ ');
  // The raw checkbox marker must not survive in list item text.
  expect(json).not.toContain('[x] done');
  expect(json).not.toContain('[ ] open');
});
