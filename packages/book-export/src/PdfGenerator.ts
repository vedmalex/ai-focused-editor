/*
 * Derived from the owner's telegraph-publisher library
 * (~/work/BhaktiVaibhava/telegraph-publisher, v1.5.0), src/svg/PdfGenerator.ts.
 *
 * AI-focused-editor changes (existing-HTML route):
 * - dropped the `marked` + markdownHtmlConverter markdown->HTML path entirely.
 *   The Theia backend already renders one canonical `book.html` (markdown-it with
 *   semantic labels, unified anchors, nested TOC), so this module simply feeds
 *   THAT HTML into puppeteer. One HTML rendering path, anchors already unified,
 *   far less code to maintain;
 * - trimmed the thermal-printer paper presets: books only need a4/a5;
 * - reduced to two exports — `findChromePath` (chrome discovery incl. the
 *   CHROME_PATH env override) and `renderHtmlToPdf` (a thin wrapper over
 *   puppeteer-core `page.pdf` with sensible book/print CSS);
 * - puppeteer-core is loaded lazily via an indirect require so the esbuild Theia
 *   backend bundler never pulls it (a large, bundler-hostile dependency) into the
 *   graph; it is resolved from node_modules only when a PDF build actually runs.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** Book paper sizes. Thermal-printer presets from the source are intentionally dropped. */
export type PdfPaperFormat = 'a4' | 'a5';

/**
 * Standard install locations probed when no CHROME_PATH override is set. The
 * CHROME_PATH environment variable always takes precedence (see findChromePath).
 */
export const CHROME_CANDIDATE_PATHS: readonly string[] = [
  // macOS
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  // Linux
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/snap/bin/chromium',
  // Windows
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
];

/**
 * Single, stack-trace-free diagnostic surfaced when no Chrome/Chromium binary can
 * be located for PDF export.
 */
export const CHROME_NOT_FOUND_MESSAGE =
  'PDF export requires a Chrome/Chromium installation (set CHROME_PATH to your browser binary).';

/**
 * Locate a Chrome/Chromium executable for PDF rendering.
 *
 * Resolution order: the `CHROME_PATH` environment override wins when it points to
 * an existing file, otherwise the standard OS install paths are probed. Returns
 * `undefined` when nothing is found so callers can emit a clean diagnostic instead
 * of letting puppeteer throw a stack trace.
 *
 * `env` and `candidatePaths` are injectable for deterministic unit testing.
 */
export function findChromePath(
  env: NodeJS.ProcessEnv = process.env,
  candidatePaths: readonly string[] = CHROME_CANDIDATE_PATHS
): string | undefined {
  const override = env.CHROME_PATH?.trim();
  if (override && existsSync(override)) {
    return override;
  }
  for (const candidate of candidatePaths) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

export interface RenderHtmlToPdfOptions {
  /** Absolute (or cwd-relative) path the generated PDF is written to. */
  outputPath: string;
  /** Book paper size; defaults to `a4`. */
  format?: PdfPaperFormat;
  /** Uniform page margin as a CSS length (e.g. `16mm`); defaults to `16mm`. */
  margin?: string;
  /** Explicit Chrome/Chromium executable; when omitted it is discovered via findChromePath. */
  chromePath?: string;
  /** Render CSS backgrounds/colors into the PDF; defaults to true. */
  printBackground?: boolean;
  /** Injectable environment for chrome discovery (testing). */
  env?: NodeJS.ProcessEnv;
  /** Injectable probe list for chrome discovery (testing). */
  candidatePaths?: readonly string[];
}

/** Minimal structural surface of puppeteer-core used here (avoids a type dependency). */
interface PuppeteerPage {
  setContent(html: string, options?: { waitUntil?: string | string[] }): Promise<void>;
  addStyleTag(options: { content: string }): Promise<void>;
  pdf(options: unknown): Promise<Uint8Array>;
}
interface PuppeteerBrowser {
  newPage(): Promise<PuppeteerPage>;
  close(): Promise<void>;
}
interface PuppeteerModule {
  launch(options: {
    executablePath: string;
    headless: boolean;
    args?: string[];
  }): Promise<PuppeteerBrowser>;
}

const PAPER_FORMATS: Record<PdfPaperFormat, string> = {
  a4: 'A4',
  a5: 'A5'
};

/**
 * Print stylesheet layered on top of the canonical `book.html` screen styles. It
 * neutralises the on-screen page chrome (centered column, tinted background) and
 * adds page-break rules so headings never dangle at the bottom of a page and
 * atomic blocks are not split mid-element.
 */
const BOOK_PRINT_CSS = `
  html, body { background: #ffffff !important; }
  main {
    max-width: none !important;
    margin: 0 !important;
    padding: 0 !important;
    min-height: 0 !important;
    background: #ffffff !important;
  }
  h1, h2, h3, h4, h5, h6 {
    page-break-inside: avoid;
    page-break-after: avoid;
    break-inside: avoid;
    break-after: avoid;
  }
  p, li, blockquote, pre, tr, img, figure {
    page-break-inside: avoid;
    break-inside: avoid;
  }
  p { orphans: 3; widows: 3; }
  nav { page-break-after: always; break-after: page; }
`;

/**
 * Render a complete HTML document to a PDF file via headless Chrome/Chromium.
 *
 * This is the entire PDF surface of the exporter: it takes the already-rendered
 * book HTML (so there is a single HTML rendering path across html/pdf exports),
 * layers book print CSS on top, and drives puppeteer-core `page.pdf`. When no
 * browser can be located it throws `CHROME_NOT_FOUND_MESSAGE` (no stack trace of
 * value to surface) so callers can degrade gracefully.
 */
export async function renderHtmlToPdf(html: string, options: RenderHtmlToPdfOptions): Promise<void> {
  const executablePath =
    options.chromePath ?? findChromePath(options.env, options.candidatePaths);
  if (!executablePath) {
    throw new Error(CHROME_NOT_FOUND_MESSAGE);
  }

  const outputPath = resolve(options.outputPath);
  const format = PAPER_FORMATS[options.format ?? 'a4'];
  const margin = options.margin ?? '16mm';
  const printBackground = options.printBackground ?? true;

  const puppeteer = loadPuppeteer();
  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    await page.addStyleTag({ content: BOOK_PRINT_CSS });
    const pdf = await page.pdf({
      format,
      printBackground,
      preferCSSPageSize: false,
      margin: { top: margin, right: margin, bottom: margin, left: margin }
    });
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, Buffer.from(pdf));
  } finally {
    await browser.close();
  }
}

/**
 * Resolve puppeteer-core at call time so the esbuild Theia backend bundler never
 * pulls this large, bundler-hostile dependency into the graph — it stays a plain
 * runtime node_modules dependency, required only when a PDF build actually runs.
 *
 * The specifier is assembled at runtime (`['puppeteer', 'core'].join('-')`) so the
 * bundler cannot constant-fold it into an analyzable `require('literal')` and
 * instead leaves it as a runtime `require`. A CommonJS-style `require` is present
 * in every execution mode this runs in (tsc CLI output, the esbuild-bundled Node
 * backend, and bun's TypeScript test runner).
 */
function loadPuppeteer(): PuppeteerModule {
  const moduleName = ['puppeteer', 'core'].join('-');
  return require(moduleName) as PuppeteerModule;
}
