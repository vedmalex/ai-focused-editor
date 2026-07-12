/*
 * KaTeX-backed math rendering for the book exporter.
 *
 * Formulas are detected upstream by the shared `splitMathSegments` helper in
 * `@ai-focused-editor/semantic-markdown` (the exact same detector the on-screen
 * preview uses, so exported and previewed math cannot drift). This module turns a
 * detected TeX segment into export-ready markup:
 *
 * - HTML / PDF builds → `renderMathToHtml` (KaTeX HTML; needs the KaTeX stylesheet
 *   + fonts, which `getKatexCss` embeds as base64 so headless Chrome renders them
 *   from a single self-contained HTML string with no external asset host);
 * - EPUB builds → `renderMathToMathML` (standards-based MathML; zero font payload).
 *
 * `katex` is required lazily (assembled specifier, like PdfGenerator's
 * puppeteer-core) so the esbuild Theia backend bundler never pulls the heavy
 * package into its graph — it is resolved from node_modules only when a build that
 * actually contains a formula runs.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Minimal shape of the (lazily required) `katex` module this file touches. */
interface KatexModule {
  renderToString(
    tex: string,
    options?: { displayMode?: boolean; throwOnError?: boolean; output?: 'html' | 'mathml' | 'htmlAndMathml' }
  ): string;
}

let katexModule: KatexModule | undefined;

/**
 * Resolve `katex` at call time. The specifier is assembled at runtime so the
 * bundler cannot constant-fold it into an analyzable `require('literal')`.
 */
function loadKatex(): KatexModule {
  if (!katexModule) {
    const moduleName = ['ka', 'tex'].join('');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    katexModule = require(moduleName) as KatexModule;
  }
  return katexModule;
}

/**
 * Render a TeX segment to KaTeX HTML for the HTML / PDF export path. Block math
 * uses `displayMode` (KaTeX emits a `.katex-display` block that the stylesheet
 * centers). A malformed formula degrades in place to a KaTeX error span carrying
 * the source text (`throwOnError:false`) rather than aborting the build.
 */
export function renderMathToHtml(tex: string, displayMode: boolean): string {
  return loadKatex().renderToString(tex, { displayMode, throwOnError: false });
}

/**
 * Render a TeX segment to MathML for the EPUB export path (KaTeX `output:'mathml'`
 * emits `<span class="katex"><math>…</math></span>` — no font payload). Block math
 * is wrapped in a centered `<div>` so display formulas read as their own line.
 */
export function renderMathToMathML(tex: string, displayMode: boolean): string {
  const mathml = loadKatex().renderToString(tex, { displayMode, throwOnError: false, output: 'mathml' });
  if (displayMode) {
    return `<div class="afe-math-block" style="text-align:center;margin:1em 0;">${mathml}</div>`;
  }
  return mathml;
}

let cachedKatexCss: string | undefined;

/** MIME type for each font extension KaTeX ships (only woff2 is embedded). */
const FONT_MIME: Readonly<Record<string, string>> = {
  woff2: 'font/woff2'
};

/**
 * The KaTeX stylesheet with its `@font-face` sources rewritten to embed the woff2
 * font files as base64 `data:` URIs, and the `woff`/`ttf` fallback sources dropped.
 *
 * KaTeX HTML is fed to headless Chrome as a single in-memory HTML string
 * (`page.setContent`, no base URL), so relative `url(fonts/…)` references would not
 * resolve — embedding the fonts is what makes the glyphs render. woff2 alone
 * (Chrome supports it) keeps the payload ~2/3 the size of shipping all three
 * formats. The result is cached across chapters/builds.
 */
export function getKatexCss(): string {
  if (cachedKatexCss !== undefined) {
    return cachedKatexCss;
  }
  const katexPkg = require.resolve(['ka', 'tex'].join('') + '/package.json');
  const distDir = join(dirname(katexPkg), 'dist');
  const rawCss = readFileSync(join(distDir, 'katex.min.css'), 'utf8');

  // Rewrite each `@font-face { … }` block's `src:` to a single embedded woff2 and
  // drop the woff/ttf alternatives (Chrome only needs woff2).
  const embedded = rawCss.replace(/src:[^;]+;/g, srcDeclaration => {
    const woff2Match = /url\(fonts\/([^)]+\.woff2)\)/.exec(srcDeclaration);
    if (!woff2Match) {
      return srcDeclaration;
    }
    const fontFile = woff2Match[1];
    const ext = fontFile.slice(fontFile.lastIndexOf('.') + 1).toLowerCase();
    const mime = FONT_MIME[ext] ?? 'font/woff2';
    try {
      const bytes = readFileSync(join(distDir, 'fonts', fontFile));
      const base64 = bytes.toString('base64');
      return `src:url(data:${mime};base64,${base64}) format("woff2");`;
    } catch {
      // Missing font file: leave the original declaration untouched.
      return srcDeclaration;
    }
  });

  cachedKatexCss = embedded;
  return embedded;
}
