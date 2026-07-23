import { nls } from '@theia/core/lib/common/nls';
import { splitMathSegments } from '@ai-focused-editor/semantic-markdown';

/**
 * LIVE KaTeX math for the in-app guide, the SAME architecture the guide's
 * mermaid diagrams use ({@link renderMermaidMarkers} in `welcome-docs-mermaid.ts`)
 * and the SAME KaTeX logic the chapter preview uses
 * (`semantic-markdown-preview-widget.ts`): render the markdown string first, then
 * patch the live DOM — lazily importing the heavy library only when it is
 * actually needed, with self-hosted (offline, CSP-safe) fonts and a per-formula
 * error fallback that never takes the page down.
 *
 * WHY DOM POSTPROCESSING AND NOT A MARKDOWN-IT RULE. Unlike a ```mermaid FENCE
 * (a block markdown-it can hand us as a single token, which is why the mermaid
 * path lives as a fence rule in `welcome-docs-renderer.ts`), math is `$…$` /
 * `$$…$$` DELIMITERS woven through ordinary prose. Detecting them at the
 * markdown-it level would mean re-implementing the delimiter grammar; instead we
 * reuse the ONE detector this codebase already has — {@link splitMathSegments},
 * shared with the chapter preview and the book exporter — over the rendered text
 * nodes, so the guide, the preview and the export agree byte-for-byte on what is
 * a formula. The guide renderer runs with `html:false` and has no DOM, so a
 * `$$…$$` simply survives into the mounted page as plain text for this pass to
 * find (asserted in `welcome-docs-renderer.test.ts`).
 */

/** Minimal shape of the (lazily imported) `katex` module this pass touches. */
export interface KatexModule {
  renderToString(tex: string, options?: { displayMode?: boolean; throwOnError?: boolean }): string;
}

/**
 * Path (relative to the served frontend root) where the apps copy KaTeX's
 * self-hosted stylesheet + fonts during `bundle` (scripts/copy-katex-assets.mjs).
 * The stylesheet's `@font-face url(fonts/KaTeX_*.woff2)` references resolve
 * against `katex-assets/fonts/`, keeping formula fonts OFFLINE (no CDN, CSP-safe)
 * — the SAME asset layout the chapter preview loads, so the guide adds no new
 * assets and no CSP surface: the browser and electron `bundle` step already
 * copies `katex-assets/` for the whole frontend this guide is part of.
 */
const KATEX_ASSET_PATH = './katex-assets/';

/** Elements whose text must never be treated as math (verbatim / non-prose). */
const MATH_SKIP_TAGS: ReadonlySet<string> = new Set([
  'CODE', 'PRE', 'SCRIPT', 'STYLE', 'TEXTAREA'
]);

const ERROR_CLASS = 'afe-docs-katex-error';

/**
 * KaTeX is a large bundle; the module-level promise imports it once for the
 * whole application and only on first formula encountered — the SAME lazy
 * singleton shape as the mermaid pass's `loadMermaidModule` and the chapter
 * preview's `loadKatex`.
 */
let katexModulePromise: Promise<KatexModule> | undefined;

/** Inject KaTeX's self-hosted stylesheet into `doc` once (id-guarded, per document). */
function ensureKatexStyles(doc: Document): void {
  if (!doc.getElementById('afe-katex-styles')) {
    const link = doc.createElement('link');
    link.id = 'afe-katex-styles';
    link.rel = 'stylesheet';
    link.href = `${KATEX_ASSET_PATH}katex.min.css`;
    doc.head.appendChild(link);
  }
}

/**
 * Ensure the stylesheet is present in `doc` and lazily import the (heavy) KaTeX
 * bundle. The JS module is cached across renders and documents; the stylesheet
 * injection is idempotent per document. The `afe-katex-styles` id is the SAME
 * one the chapter preview uses, so when both surfaces live in one document the
 * stylesheet is injected once regardless of which loads first.
 */
function loadKatex(doc: Document): Promise<KatexModule> {
  ensureKatexStyles(doc);
  if (!katexModulePromise) {
    katexModulePromise = import('katex').then(
      module => ((module as { default?: KatexModule }).default ?? module) as KatexModule
    );
  }
  return katexModulePromise;
}

/**
 * Render one TeX fragment into a fresh span. On a KaTeX parse error the span
 * falls back to the raw `$…$` text with the error message as a `title` tooltip —
 * a bad formula never breaks the page (§A.4 "degradation instead of failure",
 * the same contract the mermaid pass follows). `renderToString` is used (rather
 * than `render`) so the DOM is only touched on success (no partial output on
 * throw).
 */
function renderFormula(tex: string, raw: string, displayMode: boolean, katex: KatexModule, doc: Document): HTMLSpanElement {
  const span = doc.createElement('span');
  try {
    span.innerHTML = katex.renderToString(tex, { displayMode, throwOnError: true });
  } catch (error) {
    span.className = ERROR_CLASS;
    span.textContent = raw;
    span.title = nls.localize(
      'ai-focused-editor/welcome/docs-formula-error',
      'Formula error: {0}',
      error instanceof Error ? error.message : String(error)
    );
  }
  return span;
}

/**
 * Replace every `$$…$$` / `$…$` run in a single text node with rendered spans,
 * using the shared {@link splitMathSegments} so the guide, the preview and the
 * book exporter detect math identically. Only touches the DOM when a formula is
 * present (a text node with no math segments is left as-is).
 */
function renderMathInTextNode(textNode: Text, katex: KatexModule, doc: Document): void {
  const text = textNode.nodeValue ?? '';
  const segments = splitMathSegments(text);
  if (!segments.some(segment => segment.type !== 'text')) {
    return;
  }
  const fragment = doc.createDocumentFragment();
  for (const segment of segments) {
    if (segment.type === 'text') {
      fragment.appendChild(doc.createTextNode(segment.value));
      continue;
    }
    const isBlock = segment.type === 'block';
    const raw = isBlock ? `$$${segment.value}$$` : `$${segment.value}$`;
    fragment.appendChild(renderFormula(segment.value, raw, isBlock, katex, doc));
  }
  textNode.parentNode?.replaceChild(fragment, textNode);
}

/**
 * Walk `root`'s text nodes and render any math delimiters found, skipping
 * verbatim tags ({@link MATH_SKIP_TAGS} — so a `$…$` inside a code span/block on
 * the syntax pages stays literal) and already-rendered `.katex` subtrees. Inserts
 * trusted KaTeX output directly on the live nodes — the same post-render DOM
 * patch pattern the chapter preview's `renderMathInElement` uses.
 *
 * Exported as the DOM-harness SEAM (TASK-018 WP-DOM-1/2): it is synchronous and
 * takes an already-resolved {@link KatexModule}, so a test can drive it directly
 * with a fake `katex` over a `happy-dom` document — without touching the lazy
 * `import('katex')` {@link renderKatexMath} guards below.
 */
export function renderMathInto(root: HTMLElement, katex: KatexModule): void {
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Node): number {
      const value = node.nodeValue;
      if (!value || value.indexOf('$') === -1) {
        return NodeFilter.FILTER_REJECT;
      }
      for (let parent = node.parentElement; parent && parent !== root; parent = parent.parentElement) {
        if (MATH_SKIP_TAGS.has(parent.tagName) || parent.classList.contains('katex')) {
          return NodeFilter.FILTER_REJECT;
        }
      }
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  const targets: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    targets.push(node as Text);
  }
  for (const textNode of targets) {
    renderMathInTextNode(textNode, katex, doc);
  }
}

/**
 * DOM postprocessing pass for one mounted guide page — the KaTeX sibling of
 * {@link renderMermaidMarkers}. Called from {@link WelcomeWidget.mountDocs} right
 * after the mermaid pass.
 *
 * A page with no `$` at all never imports `katex` — the guard below returns
 * before the lazy `import('katex')` is ever reached, so the guide's base bundle
 * stays exactly as light as before this feature (the same "no fence, no import"
 * discipline the mermaid pass has).
 *
 * NEVER THROWS out of this call: the lazy import is guarded (a bundle-load
 * failure leaves the formulas as raw text), and each formula renders
 * independently (a bad formula degrades to its own source — see
 * {@link renderFormula}).
 */
export function renderKatexMath(root: HTMLElement): void {
  const text = root.textContent;
  if (!text || text.indexOf('$') === -1) {
    return;
  }
  void loadKatex(root.ownerDocument).then(
    katex => renderMathInto(root, katex),
    () => { /* KaTeX bundle failed to load: leave formulas as raw text. */ }
  );
}
