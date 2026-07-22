import { describe, expect, test } from 'bun:test';
import { parseChapterFrontMatter } from './chapter-front-matter';

describe('parseChapterFrontMatter', () => {
  test('a chapter with no front matter is not present, and the body is unchanged', () => {
    const markdown = '# Chapter one\n\nOnce upon a time.\n';
    const result = parseChapterFrontMatter(markdown);
    expect(result.present).toBe(false);
    expect(result.fields).toEqual([]);
    expect(result.body).toBe(markdown);
    expect(result.parseError).toBeUndefined();
  });

  test('a body that merely starts with a stray "---" (no closing fence) is not front matter', () => {
    const markdown = '---\nJust a horizontal rule below, not a fence.\n';
    const result = parseChapterFrontMatter(markdown);
    expect(result.present).toBe(false);
    expect(result.body).toBe(markdown);
  });

  test('known fields (slug/title/type/summary/updated/source/language) are typed and labelled', () => {
    const markdown = [
      '---',
      'slug: my-chapter',
      'title: My Chapter',
      'type: chapter',
      'summary: A short summary.',
      'updated: 2024-03-05',
      'source: interview-01',
      'language: en',
      '---',
      '',
      '# My Chapter',
      '',
      'Body text.'
    ].join('\n');

    const result = parseChapterFrontMatter(markdown);
    expect(result.present).toBe(true);
    expect(result.parseError).toBeUndefined();
    expect(result.body).toBe('\n# My Chapter\n\nBody text.');

    const byKey = Object.fromEntries(result.fields.map(field => [field.key, field]));
    expect(Object.keys(byKey)).toEqual(['slug', 'title', 'type', 'summary', 'updated', 'source', 'language']);

    expect(byKey.slug.known).toBe(true);
    expect(byKey.slug.label).toBe('Slug');
    expect(byKey.slug.value).toEqual({ kind: 'text', segments: [{ type: 'text', value: 'my-chapter' }] });

    expect(byKey.updated.known).toBe(true);
    expect(byKey.updated.value).toEqual({ kind: 'date', display: '2024-03-05' });

    expect(byKey.language.known).toBe(true);
    expect(byKey.language.value).toEqual({ kind: 'text', segments: [{ type: 'text', value: 'en' }] });
  });

  test('an unrecognised field is passthrough-typed (not known) but still rendered by shape', () => {
    const markdown = ['---', 'tags:', '  - draft', '  - romance', 'sortOrder: 3', '---', 'Body.'].join('\n');
    const result = parseChapterFrontMatter(markdown);
    expect(result.present).toBe(true);

    const byKey = Object.fromEntries(result.fields.map(field => [field.key, field]));
    expect(byKey.tags.known).toBe(false);
    expect(byKey.tags.label).toBe('Tags');
    expect(byKey.tags.value).toEqual({
      kind: 'list',
      items: [
        { kind: 'text', segments: [{ type: 'text', value: 'draft' }] },
        { kind: 'text', segments: [{ type: 'text', value: 'romance' }] }
      ]
    });

    expect(byKey.sortOrder.known).toBe(false);
    expect(byKey.sortOrder.label).toBe('Sort order');
    expect(byKey.sortOrder.value).toEqual({ kind: 'raw', display: '3' });
  });

  test('a list-valued known field is rendered as a list, not coerced to text', () => {
    const markdown = ['---', 'source:', '  - interview-01', '  - interview-02', '---', 'Body.'].join('\n');
    const result = parseChapterFrontMatter(markdown);
    const source = result.fields.find(field => field.key === 'source');
    expect(source?.value.kind).toBe('list');
    if (source?.value.kind === 'list') {
      expect(source.value.items).toHaveLength(2);
    }
  });

  test('a wiki-link [[...]] inside a text field value is split into linkable segments', () => {
    const markdown = ['---', 'summary: "See [[char:krishna|Krishna]] and [[vrindavan]]."', '---', 'Body.'].join('\n');
    const result = parseChapterFrontMatter(markdown);
    const summary = result.fields.find(field => field.key === 'summary');
    expect(summary?.value.kind).toBe('text');
    if (summary?.value.kind === 'text') {
      const mentionSegments = summary.value.segments.filter(segment => segment.type === 'mention');
      expect(mentionSegments).toHaveLength(2);
      expect(mentionSegments[0]).toEqual({
        type: 'mention',
        mention: { raw: '[[char:krishna|Krishna]]', kind: 'char', id: 'krishna', label: 'Krishna' }
      });
      expect(mentionSegments[1]).toEqual({
        type: 'mention',
        mention: { raw: '[[vrindavan]]', id: 'vrindavan' }
      });
    }
  });

  test('a non-date-like value in the "updated" field falls back to plain text, not a date', () => {
    const markdown = ['---', 'updated: "soon-ish"', '---', 'Body.'].join('\n');
    const result = parseChapterFrontMatter(markdown);
    const updated = result.fields.find(field => field.key === 'updated');
    expect(updated?.value).toEqual({ kind: 'text', segments: [{ type: 'text', value: 'soon-ish' }] });
  });

  test('an empty front-matter fence parses as present with zero fields and no error', () => {
    const markdown = '---\n---\nBody.';
    const result = parseChapterFrontMatter(markdown);
    expect(result.present).toBe(true);
    expect(result.fields).toEqual([]);
    expect(result.parseError).toBeUndefined();
    expect(result.body).toBe('Body.');
  });

  test('malformed YAML inside the fence is graceful: parseError set, rawBlock kept, no thrown exception', () => {
    const markdown = ['---', 'title: "unterminated', 'foo: [1, 2', '---', 'Body.'].join('\n');
    expect(() => parseChapterFrontMatter(markdown)).not.toThrow();
    const result = parseChapterFrontMatter(markdown);
    expect(result.present).toBe(true);
    expect(result.fields).toEqual([]);
    expect(result.parseError).toBeTruthy();
    expect(result.rawBlock).toContain('unterminated');
  });

  test('a front-matter block that is a YAML sequence (not a mapping) is a graceful parse error', () => {
    const markdown = ['---', '- one', '- two', '---', 'Body.'].join('\n');
    const result = parseChapterFrontMatter(markdown);
    expect(result.present).toBe(true);
    expect(result.fields).toEqual([]);
    expect(result.parseError).toBeTruthy();
  });
});
