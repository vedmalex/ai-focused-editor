import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  EpubGenerator,
  getKatexCss,
  renderMathToHtml,
  renderMathToMathML,
  type TelegraphNode
} from './index';

const SCRATCH =
  '/private/tmp/claude-501/-Users-vedmalex-work-ai-editor-3/8a15f000-cd38-4649-8fe4-b479e61f41c1/scratchpad/math-test';

beforeAll(async () => {
  await rm(SCRATCH, { recursive: true, force: true });
  await mkdir(SCRATCH, { recursive: true });
});

afterAll(async () => {
  await rm(SCRATCH, { recursive: true, force: true });
});

function unzipEntry(path: string, entry: string): string {
  return Bun.spawnSync(['unzip', '-p', path, entry]).stdout.toString();
}

describe('renderMathToHtml', () => {
  test('emits KaTeX HTML markup for a valid formula', () => {
    const html = renderMathToHtml('E=mc^2', false);
    expect(html).toContain('class="katex"');
    // The variables reach the KaTeX HTML layer.
    expect(html).toContain('mc');
  });

  test('block (display) math carries the katex-display wrapper', () => {
    expect(renderMathToHtml('\\int_0^1 x^2 dx', true)).toContain('katex-display');
  });

  test('a malformed formula degrades in place instead of throwing', () => {
    const html = renderMathToHtml('\\frac{', false);
    expect(html).toContain('katex-error');
  });
});

describe('renderMathToMathML', () => {
  test('emits a <math> element (no font payload) for EPUB', () => {
    const mathml = renderMathToMathML('E=mc^2', false);
    expect(mathml).toContain('<math');
    expect(mathml).toContain('</math>');
    // MathML output must not carry the font-dependent HTML span layer.
    expect(mathml).not.toContain('katex-html');
  });

  test('block math is wrapped in a centered div', () => {
    const mathml = renderMathToMathML('x = y', true);
    expect(mathml).toContain('<div class="afe-math-block"');
    expect(mathml).toContain('text-align:center');
    expect(mathml).toContain('<math');
  });
});

describe('getKatexCss', () => {
  test('embeds woff2 fonts as base64 and drops relative font URLs', () => {
    const css = getKatexCss();
    // Fonts are inlined so headless Chrome (no asset host) can render glyphs.
    expect(css).toContain('data:font/woff2;base64,');
    // No unresolved relative references remain that Chrome could not fetch.
    expect(css).not.toContain('url(fonts/');
    // Sanity: still a KaTeX stylesheet.
    expect(css).toContain('.katex');
  });
});

describe('EpubGenerator raw MathML passthrough', () => {
  test('a node with `raw` is emitted verbatim into the chapter xhtml', async () => {
    const outputPath = join(SCRATCH, 'math.epub');
    const generator = new EpubGenerator({
      outputPath,
      title: 'Math Book',
      author: 'Test',
      language: 'en',
      identifier: 'urn:test:math',
      zipStrategy: 'manual'
    });

    generator.addChapterFromContent({
      title: 'Formulas',
      content: 'A formula follows.\n',
      transformNodes: (nodes: TelegraphNode[]): TelegraphNode[] => [
        ...nodes,
        { raw: renderMathToMathML('E=mc^2', true) },
        { tag: 'p', children: ['Inline ', { raw: renderMathToMathML('a+b', false) }, ' here.'] }
      ]
    });

    await generator.generate();
    const xhtml = unzipEntry(outputPath, 'OEBPS/chapter-1.html');

    // The MathML reaches the chapter xhtml verbatim (not HTML-escaped).
    expect(xhtml).toContain('<math');
    expect(xhtml).toContain('<div class="afe-math-block"');
    expect(xhtml).not.toContain('&lt;math');
  });
});
