import { describe, expect, test } from 'bun:test';
import MarkdownIt from 'markdown-it';
import {
  decodeNoteLinkPayload,
  encodeNoteLinkPayload,
  noteLinkSentinelForAnchor,
  NOTE_LINK_ATTRIBUTE,
  rewriteNoteLinksForPreview,
  type NoteLinkPayload,
  type NoteLinkResolution,
  type NoteLinkResolverOutcome
} from './preview-note-links';

// The SAME `markdown-it` package this workspace package depends on directly
// (`^14.3.0` — the exact version `@theia/core`'s `MarkdownRendererImpl` also
// bundles), constructed with NO options — i.e. `MarkdownRendererImpl`'s exact
// `markdownit()` call (see `@theia/core/lib/browser/markdown-rendering/
// markdown-renderer.js`: `this.markdownIt = markdownit().use(markdownitemoji.full)`).
// The emoji plugin only touches `:emoji:` shortcodes, irrelevant to link
// rendering, so a plain instance reproduces the exact `html`/`validateLink`
// behaviour the widget's render path exercises.
const markdownIt = new MarkdownIt();

function resolveTable(table: Record<string, NoteLinkResolution>): (notePath: string) => NoteLinkResolution {
  return notePath => table[notePath] ?? { status: 'unresolved' };
}

// NOTE (ISS-149): bare markdown-it is NOT the live preview renderer — the widget
// injects `@theia/core`'s `MarkdownRenderer`, which `@theia/monaco` REBINDS to
// VS Code's `MarkdownRendererService` (marked + VS Code's DOM sanitizer +
// `rewriteRenderedLinks`). These bare-markdown-it cases only cover the FALLBACK
// renderer path; the live-renderer contract that actually shipped broken is
// covered by the "live Monaco/VS Code renderer contract" describe block below.
describe('U7 step 0 — marker-attribute survival smoke test, bare-markdown-it fallback (plan §9/ISS-137)', () => {
  test('the ORIGINAL idea (raw HTML + data-attribute riding the markdown string) does NOT survive markdown-it default rendering', () => {
    const raw = 'See <span data-afe-note-link="payload" class="afe-note-link">Моя заметка</span> here.';
    const html = markdownIt.render(raw);
    // markdown-it's default preset is `html: false`: any inline HTML in the
    // SOURCE is escaped to literal text, never reaching the DOM as an
    // element — the data attribute is gone as markup, only visible as escaped
    // text (`&lt;span ...&gt;`).
    expect(html).not.toContain('<span data-afe-note-link');
    expect(html).toContain('&lt;span data-afe-note-link=&quot;payload&quot;');
  });

  test('the CHOSEN mechanism (plain link with an opaque sentinel href) DOES survive markdown-it default rendering', () => {
    const { markdown, sentinels } = rewriteNoteLinksForPreview(
      'See [[Моя заметка]] here.',
      resolveTable({ 'Моя заметка': { status: 'resolved', path: 'notes/Моя заметка.md' } })
    );
    expect(sentinels.size).toBe(1);
    const [sentinel] = sentinels.keys();

    const html = markdownIt.render(markdown);
    // The sentinel rides through as a normal, un-mangled anchor — this is the
    // exact DOM shape `handlePreviewRender`'s post-render patch queries for
    // (`a[href]`), matching the SVG sentinel pattern (`patchPreviewImages`).
    expect(html).toContain(`<a href="${sentinel}">Моя заметка</a>`);
  });

  test('a post-render DOM patch (the working fallback) can attach the marker attribute directly on the live anchor node — bypassing markdown-it/DOMPurify entirely, since both already ran', () => {
    // Minimal stand-in for the live anchor `patchPreviewImages`'s sibling
    // (`patchPreviewNoteLinks` in the widget) would find via
    // `element.querySelectorAll('a')` — proves the attribute, once set via
    // direct DOM assignment (never through the sanitized markdown string),
    // is exactly what a native delegated click listener reads back.
    const payload: NoteLinkPayload = { status: 'resolved', notePath: 'Моя заметка', path: 'notes/Моя заметка.md' };
    const encoded = encodeNoteLinkPayload(payload);
    const anchor = { attributes: new Map<string, string>(), setAttribute(name: string, value: string) { this.attributes.set(name, value); } };

    anchor.setAttribute(NOTE_LINK_ATTRIBUTE, encoded);

    expect(anchor.attributes.get(NOTE_LINK_ATTRIBUTE)).toBe(encoded);
    expect(decodeNoteLinkPayload(anchor.attributes.get(NOTE_LINK_ATTRIBUTE)!)).toEqual(payload);
  });
});

describe('live Monaco/VS Code renderer contract — noteLinkSentinelForAnchor (ISS-149)', () => {
  // These encode the DOM shape VS Code's `MarkdownRendererService` actually
  // produces, verified against
  // `@theia/monaco-editor-core/.../base/browser/markdownRenderer.js`
  // (`rewriteRenderedLinks`): a surviving note-link anchor has its `href`
  // CLEARED to '' and the sentinel MOVED to `data-href`. The post-render patch
  // must match on `data-href`; the shipped bug matched only `href`, so nothing
  // was ever patched (and, worse, the scheme-less non-`#` href had already been
  // stripped, unwrapping the anchor to plain text).

  test('matches the LIVE renderer shape: sentinel on data-href, href emptied', () => {
    const { sentinels } = rewriteNoteLinksForPreview('[[Заметка]]', resolveTable({}));
    const [sentinel] = sentinels.keys();
    // VS Code: href='' , data-href=sentinel
    expect(noteLinkSentinelForAnchor('', sentinel)).toBe(sentinel);
    expect(sentinels.get(noteLinkSentinelForAnchor('', sentinel)!)).toBeDefined();
  });

  test('matches the bare-markdown-it fallback shape: sentinel on href, no data-href', () => {
    const { sentinels } = rewriteNoteLinksForPreview('[[Заметка]]', resolveTable({}));
    const [sentinel] = sentinels.keys();
    expect(noteLinkSentinelForAnchor(sentinel, null)).toBe(sentinel);
  });

  test('data-href WINS over href when both are present (live renderer relocation)', () => {
    const { sentinels } = rewriteNoteLinksForPreview('[[Заметка]]', resolveTable({}));
    const [sentinel] = sentinels.keys();
    expect(noteLinkSentinelForAnchor('something-else', sentinel)).toBe(sentinel);
  });

  test('ignores a real heading fragment / external link (not one of ours)', () => {
    expect(noteLinkSentinelForAnchor('#chapter-one', null)).toBeUndefined();
    expect(noteLinkSentinelForAnchor('', '#chapter-one')).toBeUndefined();
    expect(noteLinkSentinelForAnchor('https://example.com', null)).toBeUndefined();
    expect(noteLinkSentinelForAnchor('', '')).toBeUndefined();
    expect(noteLinkSentinelForAnchor(null, null)).toBeUndefined();
  });

  test('full seam: rewrite -> live anchor shape -> patch finds the payload', () => {
    const { sentinels } = rewriteNoteLinksForPreview(
      '[[Замысел романа]]',
      resolveTable({ 'Замысел романа': { status: 'resolved', path: 'file:///ws/Замысел романа.md' } })
    );
    const [sentinel] = sentinels.keys();
    // Simulate the widget patch's lookup on the LIVE DOM shape.
    const matched = noteLinkSentinelForAnchor('', sentinel);
    const payload = matched ? sentinels.get(matched) : undefined;
    expect(payload).toEqual({ status: 'resolved', notePath: 'Замысел романа', path: 'file:///ws/Замысел романа.md' });
  });
});

describe('rewriteNoteLinksForPreview — token-class table (plan §2)', () => {
  test('rewrites a bare note token to a sentinel link, leaving surrounding text untouched', () => {
    const { markdown, sentinels } = rewriteNoteLinksForPreview(
      'Before [[sharan-108]] after.',
      resolveTable({})
    );
    // `[[sharan-108]]` has no `:` at all, so it classifies as `note` (plan §2
    // row "[[sharan-108]] | bare без `:` | note-форма") — NOT entity, even
    // though it happens to also be a valid bare-entity id shape. Untouched by
    // this function would mean it stayed `[[sharan-108]]`; it must NOT.
    expect(sentinels.size).toBe(1);
    const [sentinel, payload] = [...sentinels.entries()][0];
    expect(markdown).toBe(`Before [sharan-108](${sentinel}) after.`);
    expect(payload).toEqual({ status: 'unresolved', notePath: 'sharan-108' });
  });

  test('does NOT touch a labeled entity token', () => {
    const md = 'See [[char:krishna|Кришна]] here.';
    const { markdown, sentinels } = rewriteNoteLinksForPreview(md, resolveTable({}));
    expect(markdown).toBe(md);
    expect(sentinels.size).toBe(0);
  });

  test('does NOT touch a bare entity token (kind:id, no alias)', () => {
    const md = 'See [[char:krishna]] here.';
    const { markdown, sentinels } = rewriteNoteLinksForPreview(md, resolveTable({}));
    expect(markdown).toBe(md);
    expect(sentinels.size).toBe(0);
  });

  test('does NOT touch an invalid token (kind-shaped prefix with a space in the id — the regression-guard case)', () => {
    const md = 'See [[char:krishna Krishna]] here.';
    const { markdown, sentinels } = rewriteNoteLinksForPreview(md, resolveTable({}));
    expect(markdown).toBe(md);
    expect(sentinels.size).toBe(0);
  });

  test('resolved note-with-path token carries the resolved path and drops any anchor/alias into the payload correctly', () => {
    const { markdown, sentinels } = rewriteNoteLinksForPreview(
      'Go to [[folder/Моя заметка#Глава Один|Читать]].',
      resolveTable({ 'folder/Моя заметка': { status: 'resolved', path: 'folder/Моя заметка.md' } })
    );
    const [sentinel, payload] = [...sentinels.entries()][0];
    expect(markdown).toBe(`Go to [Читать](${sentinel}).`);
    expect(payload).toEqual({
      status: 'resolved',
      notePath: 'folder/Моя заметка',
      anchor: 'Глава Один',
      path: 'folder/Моя заметка.md'
    });
  });

  test('ambiguous (equal-distance duplicate) token carries the tied candidate list', () => {
    const { sentinels } = rewriteNoteLinksForPreview(
      '[[Дубликат]]',
      resolveTable({
        'Дубликат': { status: 'ambiguous', path: 'a/Дубликат.md', candidates: ['a/Дубликат.md', 'b/Дубликат.md'] }
      })
    );
    const [, payload] = [...sentinels.entries()][0];
    expect(payload).toEqual({
      status: 'ambiguous',
      notePath: 'Дубликат',
      path: 'a/Дубликат.md',
      candidates: ['a/Дубликат.md', 'b/Дубликат.md']
    });
  });

  test('unresolved token omits path/candidates entirely', () => {
    const { sentinels } = rewriteNoteLinksForPreview('[[No Such Note]]', resolveTable({}));
    const [, payload] = [...sentinels.entries()][0];
    expect(payload).toEqual({ status: 'unresolved', notePath: 'No Such Note' });
    expect(payload.path).toBeUndefined();
    expect(payload.candidates).toBeUndefined();
  });

  test('multiple note tokens on one line each get their own sentinel and are resolved in source order', () => {
    const { markdown, sentinels } = rewriteNoteLinksForPreview(
      '[[Alpha]] and [[Beta]].',
      resolveTable({
        Alpha: { status: 'resolved', path: 'Alpha.md' },
        Beta: { status: 'unresolved' }
      })
    );
    expect(sentinels.size).toBe(2);
    const [first, second] = [...sentinels.entries()];
    expect(markdown).toBe(`[Alpha](${first[0]}) and [Beta](${second[0]}).`);
    expect(first[1].status).toBe('resolved');
    expect(second[1].status).toBe('unresolved');
  });

  test('a note name containing Markdown-sensitive characters is escaped in the link label', () => {
    const { markdown } = rewriteNoteLinksForPreview('[[my_file*note]]', resolveTable({}));
    expect(markdown).toBe('[my\\_file\\*note](#afe-note-link-0)');
    // And that escaped label still renders as PLAIN TEXT (no stray emphasis) once through markdown-it.
    const html = markdownIt.render(markdown);
    expect(html).toContain('<a href="#afe-note-link-0">my_file*note</a>');
  });

  test('every rewritten sentinel is a `#`-fragment href — the ONLY colon-free form VS Code’s sanitizer keeps (ISS-149)', () => {
    const { markdown, sentinels } = rewriteNoteLinksForPreview(
      '[[Alpha]] then [[folder/Beta]] then [[Гамма]].',
      resolveTable({})
    );
    // Every emitted sentinel (and thus every `](...)` href) must start with `#`.
    for (const sentinel of sentinels.keys()) {
      expect(sentinel.startsWith('#')).toBe(true);
    }
    // No `](token` where token does NOT start with `#` — a scheme-less non-`#`
    // token is exactly what the live sanitizer strips, unwrapping the anchor to
    // plain text (the shipped ISS-149 bug).
    expect(markdown).not.toMatch(/\]\((?!#)afe-note-link/);
    expect(markdown).toMatch(/\]\(#afe-note-link-0\)/);
  });

  test('no note-class tokens in the source is a byte-identical no-op', () => {
    const md = 'Just prose with [[char:krishna|Кришна]] and a [regular](link.md).';
    const { markdown, sentinels } = rewriteNoteLinksForPreview(md, resolveTable({}));
    expect(markdown).toBe(md);
    expect(sentinels.size).toBe(0);
  });
});

describe('rewriteNoteLinksForPreview — entity-first resolution (QA-fix ISS-151/UR-003(a))', () => {
  // The EDITOR's `resolveWikiToken`/`findEntityById` resolves a bare id
  // against the narrative-entity index BEFORE ever trying `resolveNoteLink`
  // (`semantic-link-contribution.ts`). The preview path did not, so
  // `[[hero]]` — a colon-less token that classifies `note` in `parseWikiLinks`
  // but happens to also be a valid bare-entity id — rendered as an
  // `afe-note-link-unresolved` "click to create" link, which would have
  // created a garbage `hero.md` on click. These cases pin the fix: the
  // injected resolver now answers `'entity'` for that case, and the token
  // must come out byte-for-byte untouched, exactly like an entity-class or
  // invalid token that never reaches this function's rewrite loop at all.

  test('resolver answers entity → token is left completely untouched (no sentinel minted)', () => {
    const md = 'See [[hero]] here.';
    const resolve = (notePath: string): NoteLinkResolverOutcome =>
      notePath === 'hero' ? 'entity' : { status: 'unresolved' };
    const { markdown, sentinels } = rewriteNoteLinksForPreview(md, resolve);
    expect(markdown).toBe(md);
    expect(sentinels.size).toBe(0);
  });

  test('entity unknown (resolver answers a normal NoteLinkResolution) → still rewritten as an unresolved note link', () => {
    const { markdown, sentinels } = rewriteNoteLinksForPreview(
      'See [[Замысел романа]] here.',
      () => ({ status: 'unresolved' })
    );
    expect(sentinels.size).toBe(1);
    const [sentinel, payload] = [...sentinels.entries()][0];
    expect(markdown).toBe(`See [Замысел романа](${sentinel}) here.`);
    expect(payload).toEqual({ status: 'unresolved', notePath: 'Замысел романа' });
  });

  test('an entity token and a note token on the same line: the entity is skipped, the note is rewritten, sentinel numbering stays correct', () => {
    const md = '[[hero]] and [[Заметка]].';
    const resolve = (notePath: string): NoteLinkResolverOutcome =>
      notePath === 'hero' ? 'entity' : { status: 'resolved', path: 'Заметка.md' };
    const { markdown, sentinels } = rewriteNoteLinksForPreview(md, resolve);
    expect(sentinels.size).toBe(1);
    const [sentinel, payload] = [...sentinels.entries()][0];
    expect(markdown).toBe(`[[hero]] and [Заметка](${sentinel}).`);
    expect(payload).toEqual({ status: 'resolved', notePath: 'Заметка', path: 'Заметка.md' });
  });
});

describe('encodeNoteLinkPayload / decodeNoteLinkPayload', () => {
  test('round-trips every payload shape', () => {
    const payloads: NoteLinkPayload[] = [
      { status: 'resolved', notePath: 'Note', path: 'Note.md' },
      { status: 'resolved', notePath: 'Note', anchor: 'Заголовок', path: 'Note.md' },
      { status: 'unresolved', notePath: 'folder/New Note' },
      { status: 'ambiguous', notePath: 'Dup', path: 'a/Dup.md', candidates: ['a/Dup.md', 'b/Dup.md'] }
    ];
    for (const payload of payloads) {
      expect(decodeNoteLinkPayload(encodeNoteLinkPayload(payload))).toEqual(payload);
    }
  });

  test('decode rejects malformed/foreign attribute values without throwing', () => {
    expect(decodeNoteLinkPayload('not json at all %%%')).toBeUndefined();
    expect(decodeNoteLinkPayload(encodeURIComponent(JSON.stringify({ notePath: 'x' })))).toBeUndefined();
    expect(decodeNoteLinkPayload(encodeURIComponent(JSON.stringify({ status: 'weird', notePath: 'x' })))).toBeUndefined();
    expect(decodeNoteLinkPayload(encodeURIComponent(JSON.stringify(42)))).toBeUndefined();
  });
});
