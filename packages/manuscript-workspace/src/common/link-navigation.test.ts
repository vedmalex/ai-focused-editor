import { describe, expect, test } from 'bun:test';
import { parseSemanticMarkdown } from '@ai-focused-editor/semantic-markdown';
import {
  collectUnlabeledWikiEntityMatches,
  findHeadingLine,
  isSkippableLinkTarget,
  noteCreateContent,
  noteCreatePath,
  parseWikiLinks,
  resolveNoteLink,
  resolveRelativeLink,
  semanticTagLinkRange,
  slugifyBase,
  splitLinkAnchor,
  tagKindToEntityKind,
  wikiEntityHoverCandidate
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

// `parseBareEntityTags` (the deprecated `{ kind?, id, start, end }` wrapper
// over `parseWikiLinks`, filtered to unlabeled `class === 'entity'` matches)
// was REMOVED in TASK-015 U-B — its three internal consumers now call
// `parseWikiLinks` directly with their own entity-first inclusion logic (see
// `semantic-entity-hover-contribution.ts`/`book-doctor-contribution.ts`). Its
// classification coverage (colon-less bare -> `note`, unlabeled `[[kind:id]]`
// -> `entity`, labeled tags excluded) lives on below, in the `parseWikiLinks`
// describe block, which was always the actual source of truth this wrapper
// only re-shaped.

describe('collectUnlabeledWikiEntityMatches (TASK-015 U-B, book-doctor entity-count regression)', () => {
  test('folds a colon-less bare token with kind undefined — the pre-TASK-013 shape the wrapper used to drop', () => {
    const matches = collectUnlabeledWikiEntityMatches('meet [[sharan-108]] now');
    expect(matches).toEqual([{ kind: undefined, id: 'sharan-108' }]);
  });

  test('folds an unlabeled [[kind:id]] reference with its kind', () => {
    const matches = collectUnlabeledWikiEntityMatches('[[char:frodo]]');
    expect(matches).toEqual([{ kind: 'char', id: 'frodo' }]);
  });

  test('excludes a labeled [[kind:id|label]] tag (parseSemanticMarkdown\'s job)', () => {
    expect(collectUnlabeledWikiEntityMatches('[[char:frodo|Frodo]]')).toEqual([]);
  });

  test('excludes a labeled bare note link, e.g. [[My Note|Alias]]', () => {
    expect(collectUnlabeledWikiEntityMatches('[[My Note|Alias]]')).toEqual([]);
  });

  test('excludes the regression-guard Invalid case (kind-shaped prefix + whitespace in the id)', () => {
    expect(collectUnlabeledWikiEntityMatches('[[char:krishna Krishna]]')).toEqual([]);
  });

  test('a mix folds BOTH the colon-less bare token AND the kind:id token — the exact regression scenario', () => {
    const text = '[[sharan-108]] and [[term:ring|the ring]] and [[location:shire]]';
    const matches = collectUnlabeledWikiEntityMatches(text);
    expect(matches).toEqual([{ kind: undefined, id: 'sharan-108' }, { kind: 'location', id: 'shire' }]);
  });

  test('folds a multi-word Obsidian note title harmlessly (kind undefined, never matches a real entity card by chance)', () => {
    const matches = collectUnlabeledWikiEntityMatches('See [[My Chapter Notes]] for context.');
    expect(matches).toEqual([{ kind: undefined, id: 'My Chapter Notes' }]);
  });
});

describe('wikiEntityHoverCandidate (TASK-015 U-B, hover entity-first regression)', () => {
  function firstLink(text: string) {
    const [link] = parseWikiLinks(text);
    return link;
  }

  test('an entity-class token always qualifies, regardless of hasEntity', () => {
    const link = firstLink('[[char:frodo]]');
    expect(wikiEntityHoverCandidate(link, () => false)).toEqual({ kind: 'char', id: 'frodo' });
  });

  test('a colon-less bare token qualifies ONLY when hasEntity matches it by bare id (ISS-151-class regression)', () => {
    const link = firstLink('[[sharan-108]]');
    expect(link.class).toBe('note');
    expect(wikiEntityHoverCandidate(link, id => id === 'sharan-108')).toEqual({ id: 'sharan-108' });
  });

  test('a colon-less bare token with NO matching entity is a genuine note link — no hover candidate', () => {
    const link = firstLink('[[My Chapter Notes]]');
    expect(wikiEntityHoverCandidate(link, () => false)).toBeUndefined();
  });

  test('a labeled token never qualifies, even when hasEntity would match (parseSemanticMarkdown\'s job)', () => {
    const link = firstLink('[[char:frodo|Frodo]]');
    expect(wikiEntityHoverCandidate(link, () => true)).toBeUndefined();
  });

  test('an invalid token never qualifies', () => {
    const link = firstLink('[[char:krishna Krishna]]');
    expect(wikiEntityHoverCandidate(link, () => true)).toBeUndefined();
  });
});

describe('parseWikiLinks', () => {
  test('classifies a labeled entity tag (ASCII kind)', () => {
    const [link] = parseWikiLinks('[[char:krishna|Кришна]]');
    expect(link).toEqual({
      class: 'entity',
      kind: 'char',
      id: 'krishna',
      alias: 'Кришна',
      raw: '[[char:krishna|Кришна]]',
      range: { start: 0, end: 23 }
    });
  });

  test('classifies a labeled entity tag with a Cyrillic kind (ISS-136)', () => {
    const [link] = parseWikiLinks('[[персонаж:ivan|Иван]]');
    expect(link.class).toBe('entity');
    expect(link.kind).toBe('персонаж');
    expect(link.id).toBe('ivan');
    expect(link.alias).toBe('Иван');
  });

  test('classifies a bare (unlabeled) entity tag', () => {
    const [link] = parseWikiLinks('[[char:krishna]]');
    expect(link).toEqual({
      class: 'entity',
      kind: 'char',
      id: 'krishna',
      alias: undefined,
      anchor: undefined,
      raw: '[[char:krishna]]',
      range: { start: 0, end: 16 }
    });
  });

  test('classifies a colon-less bare token as a note (not an entity) — ISS-138', () => {
    const [link] = parseWikiLinks('[[sharan-108]]');
    expect(link.class).toBe('note');
    expect(link.notePath).toBe('sharan-108');
    expect(link.kind).toBeUndefined();
    expect(link.id).toBeUndefined();
  });

  test('keeps the regression-guard Invalid case: kind-shaped prefix + whitespace in the id', () => {
    const [link] = parseWikiLinks('[[char:krishna Krishna]]');
    expect(link.class).toBe('invalid');
    expect(link.kind).toBe('char');
    expect(link.id).toBeUndefined();
  });

  test('entity id must stay ASCII even when the kind is Cyrillic (UR-002(2))', () => {
    const [link] = parseWikiLinks('[[персонаж:иван]]');
    expect(link.class).toBe('invalid');
    expect(link.kind).toBe('персонаж');
    expect(link.id).toBeUndefined();
  });

  test('a kind-shaped token with an out-of-charset id is invalid in BOTH classifiers (plan §1/ISS-140 trade-off, seam sync)', () => {
    // `/` is outside the strict entity-id charset [A-Za-z0-9_.:-] — the
    // validator flags this token, so the parser must NOT treat it as a live
    // entity link (validator/parser seam agreement).
    const [link] = parseWikiLinks('[[c:some/path]]');
    expect(link.class).toBe('invalid');
    expect(link.kind).toBe('c');
    expect(link.id).toBeUndefined();
  });

  test('a space-containing kind-shaped id is Invalid (заметка: хвост)', () => {
    const [link] = parseWikiLinks('[[заметка: хвост]]');
    expect(link.class).toBe('invalid');
    expect(link.kind).toBe('заметка');
    expect(link.id).toBeUndefined();
  });

  test('classifies a plain note reference (spaces/Unicode allowed)', () => {
    const [link] = parseWikiLinks('[[Моя заметка]]');
    expect(link).toEqual({
      class: 'note',
      notePath: 'Моя заметка',
      alias: undefined,
      anchor: undefined,
      raw: '[[Моя заметка]]',
      range: { start: 0, end: 15 }
    });
  });

  test('classifies a note path with a folder segment', () => {
    const [link] = parseWikiLinks('[[folder/Моя заметка]]');
    expect(link.class).toBe('note');
    expect(link.notePath).toBe('folder/Моя заметка');
  });

  test('splits a note + #anchor', () => {
    const [link] = parseWikiLinks('[[page#Заголовок]]');
    expect(link.class).toBe('note');
    expect(link.notePath).toBe('page');
    expect(link.anchor).toBe('Заголовок');
  });

  test('splits a note + |alias (display-only)', () => {
    const [link] = parseWikiLinks('[[Моя заметка|Подпись]]');
    expect(link.class).toBe('note');
    expect(link.notePath).toBe('Моя заметка');
    expect(link.alias).toBe('Подпись');
  });

  test('an uppercase/space-led colon prefix is not kind-shaped, so it stays a note', () => {
    const [link] = parseWikiLinks('[[Some Note: Subtitle]]');
    expect(link.class).toBe('note');
    expect(link.notePath).toBe('Some Note: Subtitle');
  });

  test('reports offsets for a token not starting at index 0', () => {
    const text = 'See [[char:frodo|Frodo]] now';
    const [link] = parseWikiLinks(text);
    expect(link.range).toEqual({ start: 4, end: 24 });
    expect(text.slice(link.range.start, link.range.end)).toBe('[[char:frodo|Frodo]]');
  });

  test('scans multiple mixed tokens in one pass', () => {
    const text = '[[frodo]] and [[term:ring|the ring]] and [[location:shire]]';
    const links = parseWikiLinks(text);
    expect(links.map(l => l.class)).toEqual(['note', 'entity', 'entity']);
  });

  // ISS-146: `classifyWikiLinkToken` must trim `path` exactly like
  // `classifyWikiLinkCandidate` (`@ai-focused-editor/semantic-markdown`) does —
  // same whitespace-only and padded-note cases pinned in both packages.
  test('a whitespace-only [[ ]] candidate is invalid, same as [[]] (ISS-146)', () => {
    const [link] = parseWikiLinks('[[ ]]');
    expect(link.class).toBe('invalid');
  });

  test('trims surrounding whitespace before classifying a padded note path (ISS-146)', () => {
    const [link] = parseWikiLinks('[[ x ]]');
    expect(link.class).toBe('note');
    expect(link.notePath).toBe('x');
  });

  test('trims surrounding whitespace before classifying a padded Cyrillic note path (ISS-146)', () => {
    const [link] = parseWikiLinks('[[  Моя заметка  ]]');
    expect(link.class).toBe('note');
    expect(link.notePath).toBe('Моя заметка');
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

describe('resolveNoteLink', () => {
  test('resolves a bare name by lowercased basename, case-insensitively', () => {
    const index = new Map([['note', ['notes/note.md']]]);
    expect(resolveNoteLink('Note', '/chapters/ch1.md', index)).toEqual({ path: 'notes/note.md' });
  });

  test('resolves a bare name whether or not the query carries .md', () => {
    const index = new Map([['note', ['notes/note.md']]]);
    expect(resolveNoteLink('note.md', '/chapters/ch1.md', index)).toEqual({ path: 'notes/note.md' });
  });

  test('returns undefined for a basename with no index entry', () => {
    const index = new Map<string, string[]>();
    expect(resolveNoteLink('missing', 'ch1.md', index)).toBeUndefined();
  });

  test('a target containing / resolves as a vault-relative path, not a doc-relative one', () => {
    // Same basename index as flat lookup, but the query carries a folder segment —
    // only candidates whose full path ends with that (case-insensitive, .md
    // optional) suffix are considered (plan §3: UR-004(1) supersedes "current
    // folder or above" with full Obsidian vault-relative-path parity).
    const index = new Map([['note', ['a/notes/note.md', 'unrelated/note.md']]]);
    expect(resolveNoteLink('notes/Note', 'x/ch1.md', index)).toEqual({ path: 'a/notes/note.md' });
  });

  test('duplicate basenames resolve to the candidate closest to documentPath', () => {
    const index = new Map([['note', ['a/notes/note.md', 'b/notes/note.md']]]);
    expect(resolveNoteLink('note', 'a/chapters/ch1.md', index)).toEqual({ path: 'a/notes/note.md' });
  });

  test('an equal-distance tie resolves to the alphabetically-first path, flagged ambiguous', () => {
    const index = new Map([['note', ['b/note.md', 'a/note.md']]]);
    const result = resolveNoteLink('note', 'root.md', index);
    expect(result).toEqual({ path: 'a/note.md', ambiguous: true, candidates: ['a/note.md', 'b/note.md'] });
  });

  test('a clear single closest candidate is NOT flagged ambiguous (UR-005(1) refinement)', () => {
    const index = new Map([['note', ['a/notes/note.md', 'b/notes/note.md']]]);
    const result = resolveNoteLink('note', 'a/chapters/ch1.md', index);
    expect(result?.ambiguous).toBeUndefined();
    expect(result?.candidates).toBeUndefined();
  });

  test('falls back to titleIndex when the basename lookup misses (title/H1 fallback, UR-005(2))', () => {
    const index = new Map<string, string[]>();
    // Modelled as two titleIndex entries under the same lookup key — building
    // the FM-title-over-H1 PRIORITY into which paths land here is
    // NoteIndexService's job (browser layer, U3); this proves resolveNoteLink
    // applies the exact same generic lookup+tie-break to a title hit as it does
    // to a basename hit (no separate code path).
    const titleIndex = new Map([['welcome', ['docs/a.md', 'docs/other/b.md']]]);
    expect(resolveNoteLink('Welcome', 'docs/x/ch1.md', index, titleIndex)).toEqual({ path: 'docs/a.md' });
  });

  test('a basename hit wins over a titleIndex entry for the same key (basename before title/H1 in the chain)', () => {
    const index = new Map([['welcome', ['welcome.md']]]);
    const titleIndex = new Map([['welcome', ['docs/other-welcome.md']]]);
    expect(resolveNoteLink('Welcome', 'ch1.md', index, titleIndex)).toEqual({ path: 'welcome.md' });
  });

  test('returns undefined when neither index nor titleIndex has a match', () => {
    const index = new Map<string, string[]>();
    const titleIndex = new Map<string, string[]>();
    expect(resolveNoteLink('missing', 'ch1.md', index, titleIndex)).toBeUndefined();
  });

  test('returns undefined for an empty/whitespace-only note path', () => {
    const index = new Map([['note', ['note.md']]]);
    expect(resolveNoteLink('', 'ch1.md', index)).toBeUndefined();
    expect(resolveNoteLink('   ', 'ch1.md', index)).toBeUndefined();
  });
});

// ISS-144: every real consumer (`SemanticLinkContribution.collectWikiLinks`
// via `resolveWikiToken`, and `SemanticMarkdownPreviewWidget.updatePreview` via
// `resolveNoteLinkForPreview`) calls `resolveNoteLink` with `documentPath` set
// to the FULL `model.uri.toString()` / `editor.uri.toString()`, because
// `NoteIndexService`'s index candidates are themselves full `file://...` URI
// strings (`FileSearchService.find` results) — never a bare, scheme-less path.
// `pathDistance`/`directorySegments` are plain string-segment arithmetic, so
// BOTH sides of the comparison must share the same representation for the
// "closest to this chapter" tie-break to mean anything; these cases pin that
// contract for full `file://` URIs (the editor and preview paths share this
// exact `resolveNoteLink` call, so one test covers both consumers' resolution
// engine).
describe('resolveNoteLink with full file:// URI representation (ISS-144)', () => {
  test('duplicate basenames resolve to the file:// candidate closest to a file:// documentPath', () => {
    const index = new Map([['note', [
      'file:///ws/proj/a/notes/note.md',
      'file:///ws/proj/b/notes/note.md'
    ]]]);
    expect(resolveNoteLink('note', 'file:///ws/proj/a/chapters/ch1.md', index)).toEqual({
      path: 'file:///ws/proj/a/notes/note.md'
    });
  });

  test('an equal-distance tie among file:// candidates resolves alphabetically, flagged ambiguous', () => {
    const index = new Map([['note', [
      'file:///ws/proj/b/note.md',
      'file:///ws/proj/a/note.md'
    ]]]);
    const result = resolveNoteLink('note', 'file:///ws/proj/root.md', index);
    expect(result).toEqual({
      path: 'file:///ws/proj/a/note.md',
      ambiguous: true,
      candidates: ['file:///ws/proj/a/note.md', 'file:///ws/proj/b/note.md']
    });
  });

  test('regression guard: a scheme-less documentPath against full file:// candidates degrades the tie-break to a bare alphabetical pick (the pre-fix ISS-144 bug)', () => {
    // This is the EXACT mismatch `SemanticLinkContribution.collectWikiLinks`
    // used to produce (`model.uri.path`, scheme-less, against the full-URI
    // index): `directorySegments` sees the candidate's leading `file:`
    // segment and the document's leading real directory segment mismatch
    // immediately, so `pathDistance` finds NO common ancestor for either
    // candidate and both come out equidistant — "closest to this chapter"
    // silently degenerates into "alphabetically first", even though `a/` is
    // the obviously nearer folder. Pinned here so a reintroduced
    // representation mismatch anywhere in the call chain is caught by this
    // test turning `ambiguous` unexpectedly true again.
    const index = new Map([['note', [
      'file:///ws/proj/a/notes/note.md',
      'file:///ws/proj/b/notes/note.md'
    ]]]);
    const result = resolveNoteLink('note', '/ws/proj/a/chapters/ch1.md', index);
    expect(result?.ambiguous).toBe(true);
  });
});

describe('noteCreatePath', () => {
  const root = '/ws/proj';
  const doc = '/ws/proj/chapters/ch1.md';

  test('a bare note name creates alongside the current chapter', () => {
    expect(noteCreatePath('New Note', doc, root)).toBe('/ws/proj/chapters/New Note.md');
  });

  test('a path in the link wins over the chapter folder, resolved against the root', () => {
    expect(noteCreatePath('appendix/New Note', doc, root)).toBe('/ws/proj/appendix/New Note.md');
  });

  test('appends .md only when missing', () => {
    expect(noteCreatePath('Note.md', doc, root)).toBe('/ws/proj/chapters/Note.md');
    expect(noteCreatePath('Note', doc, root)).toBe('/ws/proj/chapters/Note.md');
  });
});

describe('noteCreateContent', () => {
  test('produces a single # Name heading line, no front-matter', () => {
    expect(noteCreateContent('New Note')).toBe('# New Note\n');
  });

  test('uses only the last path segment for a folder-qualified link', () => {
    expect(noteCreateContent('appendix/New Note')).toBe('# New Note\n');
  });

  test('strips a .md suffix from the name', () => {
    expect(noteCreateContent('Note.md')).toBe('# Note\n');
  });
});

describe('parseWikiLinks + findHeadingLine integration (Cyrillic anchor)', () => {
  // Plan §5: the note+anchor split reuses the existing slugifyBase/findHeadingLine
  // infrastructure unchanged — this proves the two compose end-to-end for a
  // Cyrillic heading rather than re-testing slugifyBase itself.
  test('a note #anchor with a Cyrillic heading resolves via the existing slugify infra', () => {
    const doc = ['# Глава первая', '', 'Текст.', '', '## Второй раздел', '', 'Ещё текст.'].join('\n');
    const [link] = parseWikiLinks('[[page#Второй раздел]]');
    expect(link.class).toBe('note');
    expect(link.anchor).toBe('Второй раздел');
    expect(findHeadingLine(doc, link.anchor!)).toBe(4);
  });
});
