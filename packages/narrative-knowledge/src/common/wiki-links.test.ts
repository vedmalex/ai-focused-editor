import { describe, expect, test } from 'bun:test';
import {
  collectUnlabeledWikiEntityMatches,
  parseWikiLinks,
  wikiEntityHoverCandidate
} from './wiki-links';

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

// ---------------------------------------------------------------------------
// Code-blindness fix (TASK-022/UR-035, ISS-358): a `[[...]]` token written as
// a syntax EXAMPLE inside inline code or a fenced code block must not be
// treated as a live wiki-link/entity reference by `parseWikiLinks` (and
// therefore not by `collectUnlabeledWikiEntityMatches`, which folds its
// output) — the SAME rule `@ai-focused-editor/semantic-markdown`'s
// `parseSemanticMarkdown` now applies to LABELED tags, reusing the identical
// `computeCodeSpanRanges` walk rather than a second, independently-written
// code detector.
// ---------------------------------------------------------------------------

describe('parseWikiLinks — code-span blindness fix (ISS-358)', () => {
  test('a bare [[kind:id]] token inside inline code is not a link at all', () => {
    expect(parseWikiLinks('Use `[[char:nobody]]` as an example.')).toEqual([]);
  });

  test('a bare token inside a fenced code block (```) is not a link', () => {
    expect(parseWikiLinks('```\n[[char:nobody]]\n```')).toEqual([]);
  });

  test('a bare token inside a ~~~ fenced code block is not a link', () => {
    expect(parseWikiLinks('~~~\n[[char:nobody]]\n~~~')).toEqual([]);
  });

  test('a colon-less bare note-shaped token inside inline code is not a link either', () => {
    expect(parseWikiLinks('See `[[sharan-108]]` for the corpus convention.')).toEqual([]);
  });

  test('a real link AFTER a fenced code example is still found, with unshifted offsets', () => {
    const text = '```\n[[char:nobody]]\n```\nMeet [[char:krishna|Krishna]] here.';
    const links = parseWikiLinks(text);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ class: 'entity', kind: 'char', id: 'krishna', alias: 'Krishna' });
    const start = text.indexOf('[[char:krishna|Krishna]]');
    expect(links[0].range).toEqual({ start, end: start + '[[char:krishna|Krishna]]'.length });
  });

  test('a real link on the SAME line as inline code, after it, keeps its own offset', () => {
    const text = 'The `[[kind:id]]` syntax links [[char:krishna]] like this.';
    const links = parseWikiLinks(text);
    expect(links).toHaveLength(1);
    const start = text.indexOf('[[char:krishna]]');
    expect(links[0].range).toEqual({ start, end: start + '[[char:krishna]]'.length });
  });
});

describe('collectUnlabeledWikiEntityMatches — code-span blindness fix (ISS-358)', () => {
  test('excludes a bare [[kind:id]] token written inside inline code', () => {
    expect(collectUnlabeledWikiEntityMatches('Use `[[char:nobody]]` as an example.')).toEqual([]);
  });

  test('excludes a bare token inside a fenced code block, but still folds a real one after it', () => {
    const text = '```\n[[char:nobody]]\n```\n[[char:krishna]] appears.';
    expect(collectUnlabeledWikiEntityMatches(text)).toEqual([{ kind: 'char', id: 'krishna' }]);
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
