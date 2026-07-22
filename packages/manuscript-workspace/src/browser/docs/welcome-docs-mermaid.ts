import { ThemeService } from '@theia/core/lib/browser/theming';
import { nls } from '@theia/core/lib/common/nls';
import { getThemeMode, ThemeMode } from '@theia/core/lib/common/theme';
import { generateUuid } from '@theia/core/lib/common/uuid';
import { sanitizeDiagram } from '@theia/ai-chat-ui/lib/browser/chat-response-renderer/mermaid-rendering';
import { MERMAID_MARKER_ATTRIBUTE } from './welcome-docs-renderer';

/**
 * Minimal shape of the (lazily imported) `mermaid` module this pass touches —
 * the same "declare only what we call" pattern as the chapter preview's
 * `KatexModule` (`semantic-markdown-preview-widget.ts`): the guide does not
 * depend on `mermaid`'s full type surface, only on `initialize`/`parse`/`render`.
 */
interface MermaidModule {
  initialize(config: { startOnLoad: boolean; securityLevel: 'strict'; theme: 'default' | 'dark' }): void;
  parse(text: string): Promise<unknown>;
  render(id: string, text: string): Promise<{ svg: string }>;
}

/**
 * Mermaid pulls in a large dependency tree (d3, dagre, ...); the module-level
 * promise loads it once for the whole application and only on first use —
 * mirroring `@theia/ai-chat-ui`'s own `loadMermaid` (which is not itself
 * exported, so the guide keeps a small copy of the lazy-singleton shape).
 */
let mermaidModulePromise: Promise<MermaidModule> | undefined;

function loadMermaidModule(): Promise<MermaidModule> {
  if (!mermaidModulePromise) {
    mermaidModulePromise = import('mermaid').then(
      module => ((module as { default?: MermaidModule }).default ?? module) as unknown as MermaidModule
    );
  }
  return mermaidModulePromise;
}

/** Mermaid keeps its configuration in a global singleton; (re-)initialize only when the theme actually changes. */
let initializedTheme: ThemeMode | undefined;

async function loadMermaidForTheme(themeMode: ThemeMode): Promise<MermaidModule> {
  const mermaid = await loadMermaidModule();
  if (initializedTheme !== themeMode) {
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: themeMode === 'dark' ? 'dark' : 'default' });
    initializedTheme = themeMode;
  }
  return mermaid;
}

const DIAGRAM_CLASS = 'afe-docs-mermaid-diagram';
const PENDING_CLASS = 'afe-docs-mermaid-pending';
const ERROR_CLASS = 'afe-docs-mermaid-error';

/**
 * DOM postprocessing pass for one mounted guide page — the same "render the
 * string first, patch the live DOM after" pattern the chapter preview uses for
 * KaTeX (`renderMathInElement`), applied here to `WelcomeDocsRenderer`'s own
 * low-level markdown-it engine instead of Theia's `MarkdownRenderer`.
 *
 * Finds every `<pre data-afe-mermaid>` marker the renderer's fence rule
 * emitted and replaces each with a rendered, sanitized SVG (via the SAME
 * {@link sanitizeDiagram} the AI chat's mermaid viewer uses). A page with no
 * mermaid fence never imports `mermaid` at all — the `markers.length === 0`
 * guard below returns before the lazy `import('mermaid')` is ever reached, so
 * the guide's base bundle stays exactly as light as before this feature.
 *
 * NEVER THROWS out of this call: each marker renders independently, and a
 * failure (invalid diagram syntax, a bundle load failure) degrades that ONE
 * marker to an inline warning plus its raw source — the same "degradation
 * instead of failure" contract the rest of this renderer follows (§A.4),
 * rather than the switch-to-source-view affordance the chapter preview's
 * `MermaidViewer` offers (this low-level surface has no toolbar to switch to).
 */
export function renderMermaidMarkers(root: ParentNode, themeService: ThemeService): void {
  const markers = Array.from(root.querySelectorAll<HTMLElement>(`pre[${MERMAID_MARKER_ATTRIBUTE}]`));
  if (markers.length === 0) {
    return;
  }
  const themeMode = getThemeMode(themeService.getCurrentTheme().type);
  for (const marker of markers) {
    void renderOneMarker(marker, themeMode);
  }
}

async function renderOneMarker(marker: HTMLElement, themeMode: ThemeMode): Promise<void> {
  const code = (marker.textContent ?? '').trim();
  const doc = marker.ownerDocument;
  const container = doc.createElement('div');
  container.className = `${DIAGRAM_CLASS} ${PENDING_CLASS}`;
  marker.replaceWith(container);
  if (!code) {
    // An empty ```mermaid fence: nothing to render, nothing to report.
    container.remove();
    return;
  }
  const id = `afe-docs-mermaid-${generateUuid()}`;
  try {
    const mermaid = await loadMermaidForTheme(themeMode);
    // `parse` throws for an invalid definition — checked separately from
    // `render` so a syntax error is reported the same way regardless of
    // whether `render` would also have thrown.
    await mermaid.parse(code);
    const { svg } = await mermaid.render(id, code);
    container.innerHTML = sanitizeDiagram(svg);
    container.className = DIAGRAM_CLASS;
  } catch (error) {
    renderMermaidError(container, code, error);
  } finally {
    removeStrayMermaidNodes(doc, id, container);
  }
}

/**
 * Mermaid may leave temporary measurement nodes behind, especially on a failed
 * render — but the SUCCESSFUL render's own `<svg>` carries the very id passed
 * to `render()`, and by cleanup time it already lives inside `container`. A
 * bare remove-by-id would delete the just-rendered diagram (a silent
 * zero-height blank, no console error — the exact UR-005 bug), so only strays
 * OUTSIDE the container are cleanup targets.
 */
export function removeStrayMermaidNodes(
  doc: Pick<Document, 'getElementById'>,
  id: string,
  container: Pick<HTMLElement, 'contains'>
): void {
  for (const strayId of [id, `d${id}`]) {
    const stray = doc.getElementById(strayId);
    if (stray && !container.contains(stray)) {
      stray.remove();
    }
  }
}

/**
 * The one documented difference from the chapter preview's `MermaidViewer`:
 * that component tells the reader to "switch to the source view", which does
 * not exist here (no toolbar on this low-level, non-React surface — see
 * `tools/diagrams.md`), so this shows the raw diagram source directly instead.
 */
function renderMermaidError(container: HTMLElement, code: string, error: unknown): void {
  container.className = `${DIAGRAM_CLASS} ${ERROR_CLASS}`;
  container.textContent = '';
  const doc = container.ownerDocument;
  const message = doc.createElement('div');
  message.className = 'afe-docs-mermaid-error-message';
  const icon = doc.createElement('span');
  icon.className = 'codicon codicon-warning';
  message.appendChild(icon);
  const text = doc.createElement('span');
  text.textContent = nls.localize(
    'ai-focused-editor/welcome/docs-mermaid-error',
    'Unable to render this diagram. Showing its source instead.'
  );
  text.title = error instanceof Error ? error.message : String(error);
  message.appendChild(text);
  container.appendChild(message);
  const source = doc.createElement('pre');
  source.className = 'afe-docs-mermaid-source';
  source.textContent = code;
  container.appendChild(source);
}
