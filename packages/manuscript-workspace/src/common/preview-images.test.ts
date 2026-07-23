import { describe, expect, test } from 'bun:test';
import {
  classifyImageTarget,
  extractImageTargets,
  rewriteImageTargets,
  type ImageTargetClass
} from './preview-images';

describe('extractImageTargets', () => {
  test('extracts a simple relative image with the target range only', () => {
    const md = 'before ![Cover](../cover.png) after';
    const targets = extractImageTargets(md);
    expect(targets).toHaveLength(1);
    expect(targets[0].target).toBe('../cover.png');
    // The range must cover exactly the target substring.
    expect(md.slice(targets[0].range.start, targets[0].range.end)).toBe('../cover.png');
  });

  test('extracts nested paths', () => {
    const md = '![a](assets/images/deep/pic.png)';
    const [t] = extractImageTargets(md);
    expect(t.target).toBe('assets/images/deep/pic.png');
    expect(md.slice(t.range.start, t.range.end)).toBe('assets/images/deep/pic.png');
  });

  test('extracts ../ traversal and %20-encoded paths', () => {
    const md = '![a](../../shared/my%20cover.png)';
    const [t] = extractImageTargets(md);
    expect(t.target).toBe('../../shared/my%20cover.png');
  });

  test('stops the target before a "title", keeping the range tight', () => {
    const md = '![a](images/pic.png "A caption")';
    const [t] = extractImageTargets(md);
    expect(t.target).toBe('images/pic.png');
    expect(md.slice(t.range.start, t.range.end)).toBe('images/pic.png');
  });

  test('stops the target before a single-quoted title', () => {
    const md = "![a](images/pic.png 'cap')";
    const [t] = extractImageTargets(md);
    expect(t.target).toBe('images/pic.png');
  });

  test('tolerates whitespace after the opening paren', () => {
    const md = '![a](   images/pic.png)';
    const [t] = extractImageTargets(md);
    expect(t.target).toBe('images/pic.png');
    expect(md.slice(t.range.start, t.range.end)).toBe('images/pic.png');
  });

  test('extracts multiple images with correct independent ranges', () => {
    const md = '![one](a.png) and ![two](sub/b.jpg)';
    const targets = extractImageTargets(md);
    expect(targets.map(t => t.target)).toEqual(['a.png', 'sub/b.jpg']);
    for (const t of targets) {
      expect(md.slice(t.range.start, t.range.end)).toBe(t.target);
    }
  });

  test('captures an existing data: URI target (classification decides skipping)', () => {
    const md = '![a](data:image/png;base64,iVBORw0KGgo=)';
    const [t] = extractImageTargets(md);
    expect(t.target).toBe('data:image/png;base64,iVBORw0KGgo=');
  });

  test('does not match reference-style images (no inline destination) — documented skip', () => {
    // `![alt][ref]` carries no inline `(target)`, so it is intentionally not
    // extracted; the widget cannot inline reference-style images.
    const md = '![alt][ref]\n\n[ref]: images/pic.png';
    const targets = extractImageTargets(md);
    // Only the *definition* line is not an image; nothing inline matches.
    expect(targets.map(t => t.target)).toEqual([]);
  });

  test('does not treat a plain link as an image', () => {
    const md = '[not an image](page.md)';
    expect(extractImageTargets(md)).toHaveLength(0);
  });

  test('ignores an empty destination ![a]()', () => {
    expect(extractImageTargets('![a]()')).toHaveLength(0);
  });
});

describe('classifyImageTarget', () => {
  const cases: Array<[string, ImageTargetClass | undefined]> = [
    ['images/pic.png', 'relative'],
    ['../cover.png', 'relative'],
    ['./a/b.png', 'relative'],
    ['/assets/logo.svg', 'absolute-workspace'],
    ['http://example.com/a.png', 'external'],
    ['https://example.com/a.png', 'external'],
    ['data:image/png;base64,AAA=', 'data'],
    ['DATA:image/png;base64,AAA=', 'data'],
    ['mailto:a@b.com', undefined],
    ['tel:+1', undefined],
    ['javascript:alert(1)', undefined],
    ['file:///etc/passwd', undefined],
    ['//cdn.example.com/a.png', undefined],
    ['#anchor', undefined],
    ['', undefined],
    ['   ', undefined]
  ];
  for (const [target, expected] of cases) {
    test(`${JSON.stringify(target)} => ${expected}`, () => {
      expect(classifyImageTarget(target)).toBe(expected);
    });
  }
});

describe('rewriteImageTargets', () => {
  test('replaces only the resolved target, byte-exact elsewhere', () => {
    const md = 'x ![Cover](../cover.png "Front") y';
    const out = rewriteImageTargets(md, t =>
      t === '../cover.png' ? 'data:image/png;base64,ZZZ=' : undefined
    );
    expect(out).toBe('x ![Cover](data:image/png;base64,ZZZ= "Front") y');
  });

  test('leaves targets the map does not resolve untouched', () => {
    const md = '![a](keep.png) ![b](change.png)';
    const out = rewriteImageTargets(md, t => (t === 'change.png' ? 'REPL' : undefined));
    expect(out).toBe('![a](keep.png) ![b](REPL)');
  });

  test('is a no-op when the map resolves nothing', () => {
    const md = '![a](x.png) plain [link](y.md) text';
    expect(rewriteImageTargets(md, () => undefined)).toBe(md);
  });

  test('replaces every occurrence of a repeated target', () => {
    const md = '![a](p.png) ![b](p.png)';
    const out = rewriteImageTargets(md, t => (t === 'p.png' ? 'D' : undefined));
    expect(out).toBe('![a](D) ![b](D)');
  });

  test('preserves surrounding markdown structure with multiple mixed images', () => {
    const md = [
      '# Title',
      '',
      '![keep external](https://x/y.png)',
      '![inline me](img/a.png)',
      '![keep data](data:image/gif;base64,AA=)'
    ].join('\n');
    const out = rewriteImageTargets(md, t => (t === 'img/a.png' ? 'data:image/png;base64,QQ=' : undefined));
    expect(out).toBe([
      '# Title',
      '',
      '![keep external](https://x/y.png)',
      '![inline me](data:image/png;base64,QQ=)',
      '![keep data](data:image/gif;base64,AA=)'
    ].join('\n'));
  });

  test('round-trips: extract ranges and rewrite agree', () => {
    const md = 'a ![x](one.png) b ![y](two/three.png "t") c';
    const out = rewriteImageTargets(md, t => t.toUpperCase());
    expect(out).toBe('a ![x](ONE.PNG) b ![y](TWO/THREE.PNG "t") c');
  });
});

// ISS-150 (TASK-015 U-B): reproduce/refute the hypothesis that the SVG-sentinel
// preview mechanism (`SVG_SENTINEL_PREFIX` in `semantic-markdown-preview-widget.ts`)
// shares ISS-149's sanitizer-strip defect class. The live preview renderer is
// NOT bare `markdown-it` — `@theia/monaco` globally rebinds Theia's
// `MarkdownRenderer` to VS Code's `MonacoMarkdownRenderer` (marked + VS Code's
// own `domSanitize`), exactly the renderer ISS-149 was fixed against (see that
// fix's regression suite: `preview-note-links.test.ts`'s "live Monaco/VS Code
// renderer contract" block). `validateLink` below is copied VERBATIM from the
// installed `@theia/monaco-editor-core` sanitizer
// (`esm/vs/base/browser/domSanitize.js`) — it is pure URL/scheme logic with no
// DOM dependency, so this is a byte-exact reproduction of the real decision,
// not an approximation. `REAL_ALLOWED_MEDIA_PROTOCOLS` is copied from
// `getDomSanitizerConfig` in `esm/vs/base/browser/markdownRenderer.js`
// (`allowedMediaProtocols.override`).
describe('SVG sentinel vs the live VS Code sanitizer contract (ISS-150)', () => {
  const fakeRelativeUrlProtocol = 'vscode-relative-path';

  function validateLink(value: string, allowedProtocols: { override: string[]; allowRelativePaths: boolean }): boolean {
    try {
      const url = new URL(value, fakeRelativeUrlProtocol + '://');
      if (allowedProtocols.override.includes(url.protocol.replace(/:$/, ''))) {
        return true;
      }
      if (
        allowedProtocols.allowRelativePaths &&
        url.protocol === fakeRelativeUrlProtocol + ':' &&
        !value.trim().toLowerCase().startsWith(fakeRelativeUrlProtocol)
      ) {
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  const REAL_ALLOWED_MEDIA_PROTOCOLS = [
    'http',
    'https',
    'data',
    'file',
    'vscode-file-resource',
    'vscode-remote',
    'vscode-remote-resource'
  ];

  // The widget NEVER sets a `baseUri` on the rendered `MarkdownString` (no
  // `markdownOptions.baseUri` — the type doesn't even expose one; see
  // `renderPreviewSegment`), so `allowRelativeMediaPaths` (`= !!baseUri` in
  // `getDomSanitizerConfig`) is always `false` for this widget's real renders.
  const WIDGET_ALLOW_RELATIVE_MEDIA_PATHS = false;

  test('regression: the ORIGINAL bare-token sentinel (`afe-preview-image-0`) FAILS the live sanitizer\'s src check — its src attribute would be stripped before patchPreviewImages ever runs (ISS-150 reproduced)', () => {
    expect(
      validateLink('afe-preview-image-0', {
        override: REAL_ALLOWED_MEDIA_PROTOCOLS,
        allowRelativePaths: WIDGET_ALLOW_RELATIVE_MEDIA_PATHS
      })
    ).toBe(false);
  });

  test('a genuine relative image path (no sentinel at all) would ALSO be stripped under the same config — confirms this is a scheme-membership gate, not sentinel-specific', () => {
    expect(
      validateLink('images/pic.png', {
        override: REAL_ALLOWED_MEDIA_PROTOCOLS,
        allowRelativePaths: WIDGET_ALLOW_RELATIVE_MEDIA_PATHS
      })
    ).toBe(false);
  });

  test('the FIX (`data:,afe-preview-image-0` — the actual SVG_SENTINEL_PREFIX shape) PASSES the live sanitizer unconditionally, regardless of baseUri/allowRelativeMediaPaths', () => {
    const sentinel = 'data:,afe-preview-image-0';
    expect(
      validateLink(sentinel, { override: REAL_ALLOWED_MEDIA_PROTOCOLS, allowRelativePaths: false })
    ).toBe(true);
    expect(
      validateLink(sentinel, { override: REAL_ALLOWED_MEDIA_PROTOCOLS, allowRelativePaths: true })
    ).toBe(true);
  });

  test('why raster images never needed a sentinel: a real data: URI (any subtype, including svg+xml) already passes the live sanitizer unconditionally', () => {
    for (const dataUri of [
      'data:image/png;base64,AAAA',
      'data:image/svg+xml;base64,AAAA' // the widget's own comment attributes this rejection to
      // `markdown-it`'s GOOD_DATA_RE — a DIFFERENT renderer path never used by
      // this widget's live render (see SVG_SENTINEL_PREFIX's doc comment).
    ]) {
      expect(
        validateLink(dataUri, { override: REAL_ALLOWED_MEDIA_PROTOCOLS, allowRelativePaths: false })
      ).toBe(true);
    }
  });
});
