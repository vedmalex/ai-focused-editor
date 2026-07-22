import {
  parseSemanticMarkdown,
  renderSemanticMarkdownPreview,
  splitMathSegments,
  SemanticTag
} from '@ai-focused-editor/semantic-markdown';
import { Disposable, DisposableCollection, UntitledResourceResolver } from '@theia/core/lib/common';
import { nls } from '@theia/core/lib/common/nls';
import URI from '@theia/core/lib/common/uri';
import { PreferenceService } from '@theia/core/lib/common/preferences';
import { Markdown } from '@theia/core/lib/browser/markdown-rendering/markdown';
import { MarkdownRenderer } from '@theia/core/lib/browser/markdown-rendering/markdown-renderer';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import type { ExtractableWidget } from '@theia/core/lib/browser/widgets/extractable-widget';
import { ClipboardService } from '@theia/core/lib/browser/clipboard-service';
import { ThemeService } from '@theia/core/lib/browser/theming';
import { open, OpenerService } from '@theia/core/lib/browser';
import { EditorManager } from '@theia/editor/lib/browser/editor-manager';
import type { TextEditor } from '@theia/editor/lib/browser/editor';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { MonacoEditorProvider } from '@theia/monaco/lib/browser/monaco-editor-provider';
import {
  MarkdownMermaidSegment,
  MermaidViewer,
  splitMermaidSegments
} from '@theia/ai-chat-ui/lib/browser/chat-response-renderer/mermaid-rendering';
import {
  inject,
  injectable,
  postConstruct
} from '@theia/core/shared/inversify';
import React from '@theia/core/shared/react';
import { AI_FOCUSED_EDITOR_PREVIEW_SHOW_TAG_CHIPS } from './ai-focused-editor-preferences';
import { resolveRelativeLink } from '../common/link-navigation';
import {
  classifyImageTarget,
  extractImageTargets,
  rewriteImageTargets
} from '../common/preview-images';
import { imageMimeForPath } from '../common/image-mime';
import {
  parseChapterFrontMatter,
  type ChapterFrontMatterField,
  type ChapterFrontMatterResult,
  type ChapterFrontMatterValue
} from '../common/chapter-front-matter';
import type { EntityMention, EntityMentionSegment, NarrativeEntity } from '../common';
import { NarrativeEntityService } from '../common';

/** Skip inlining any single image whose bytes exceed this, and cap the total per render. */
const MAX_SINGLE_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 40 * 1024 * 1024;

// Sentinel src used for SVG only: markdown-it's validateLink drops
// `data:image/svg+xml` entirely (its GOOD_DATA_RE allows only gif/png/jpeg/webp),
// so an SVG data URI cannot ride the string route. Instead the rewrite emits a
// bare `afe-preview-image-N` token (which markdown-it + DOMPurify preserve as an
// <img src>), and `patchPreviewImages` swaps in the real data URI on the live DOM
// node after render — bypassing both filters. Raster formats need none of this:
// their data URIs pass validateLink and survive DOMPurify (img ∈ DATA_URI_TAGS).
const SVG_SENTINEL_PREFIX = 'afe-preview-image-';

/** Encode raw bytes as base64 without blowing the call stack on large buffers. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }
  return btoa(binary);
}

// ---------------------------------------------------------------------------
// KaTeX math rendering ($$…$$ block / $…$ inline) over the rendered preview DOM.
// ---------------------------------------------------------------------------

/** Minimal shape of the (lazily imported) `katex` module this widget touches. */
interface KatexModule {
  renderToString(tex: string, options?: { displayMode?: boolean; throwOnError?: boolean }): string;
}

/**
 * Path (relative to the served frontend root) where the apps copy KaTeX's
 * self-hosted stylesheet + fonts during `bundle` (scripts/copy-katex-assets.mjs).
 * The stylesheet's `@font-face url(fonts/KaTeX_*.woff2)` references resolve
 * against `katex-assets/fonts/`, keeping formula fonts OFFLINE (no CDN, CSP-safe)
 * — the EXCALIDRAW_ASSET_PATH pattern applied to KaTeX.
 */
const KATEX_ASSET_PATH = './katex-assets/';

/** Elements whose text must never be treated as math (verbatim / non-prose). */
const MATH_SKIP_TAGS: ReadonlySet<string> = new Set([
  'CODE', 'PRE', 'SCRIPT', 'STYLE', 'TEXTAREA'
]);

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
 * bundle on first formula encountered — the JS module is cached across renders
 * and documents; the stylesheet injection is idempotent per document (so a
 * preview extracted to a secondary window gets its own `<link>`).
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
 * a bad formula never breaks the preview. `renderToString` is used (rather than
 * `render`) so the DOM is only touched on success (no partial output on throw).
 */
function renderFormula(tex: string, raw: string, displayMode: boolean, katex: KatexModule, doc: Document): HTMLSpanElement {
  const span = doc.createElement('span');
  try {
    span.innerHTML = katex.renderToString(tex, { displayMode, throwOnError: true });
  } catch (error) {
    span.className = 'afe-katex-error';
    span.textContent = raw;
    span.title = nls.localize(
      'ai-focused-editor/editor/formula-error',
      'Formula error: {0}',
      error instanceof Error ? error.message : String(error)
    );
  }
  return span;
}

/**
 * Replace every `$$…$$` / `$…$` run in a single text node with rendered spans,
 * using the shared {@link splitMathSegments} so the preview and the book exporter
 * detect math identically. Only touches the DOM when a formula is present (a text
 * node with no math segments is left as-is), preserving the prior no-match no-op.
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
 * verbatim tags ({@link MATH_SKIP_TAGS}) and already-rendered `.katex` subtrees.
 * Bypasses markdown-it/DOMPurify (both already ran on the string) and inserts
 * trusted KaTeX output directly on the live nodes — the same post-render DOM
 * patch pattern as {@link SemanticMarkdownPreviewWidget.patchPreviewImages}.
 */
function renderMathInElement(root: HTMLElement, katex: KatexModule): void {
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

// ---------------------------------------------------------------------------
// Mermaid diagram rendering, reusing Theia's own @theia/ai-chat-ui chat renderer
// (splitMermaidSegments + MermaidViewer) rather than reimplementing the lazy
// `import('mermaid')` + sanitize + toolbar/zoom/pan machinery a second time.
// ---------------------------------------------------------------------------

/**
 * Pure markdown -> segment-list split, exported for direct unit testing without
 * a DOM or a widget instance. Wraps {@link splitMermaidSegments} with the same
 * "drop a blank markdown segment between two mermaid fences" filter the
 * upstream `MarkdownWithMermaid` applies, so an adjacent pair of diagrams never
 * renders an empty (and pointlessly re-rendered) Markdown segment between them.
 */
export function segmentPreviewMarkdown(markdown: string): MarkdownMermaidSegment[] {
  return splitMermaidSegments(markdown).filter(
    segment => segment.type === 'mermaid' || segment.content.trim().length > 0
  );
}

@injectable()
export class SemanticMarkdownPreviewWidget extends ReactWidget implements ExtractableWidget {
  static readonly ID = 'ai-focused-editor.semantic-markdown.preview';
  static readonly LABEL = nls.localize('ai-focused-editor/editor/preview-label', 'Semantic Preview');

  /** FR-021: the preview can move to its own secondary window (writer-side reading surface). */
  isExtractable = true;
  secondaryWindow: Window | undefined = undefined;

  @inject(EditorManager)
  protected readonly editorManager!: EditorManager;

  @inject(MarkdownRenderer)
  protected readonly markdownRenderer!: MarkdownRenderer;

  @inject(PreferenceService)
  protected readonly preferenceService!: PreferenceService;

  @inject(FileService)
  protected readonly fileService!: FileService;

  @inject(WorkspaceService)
  protected readonly workspaceService!: WorkspaceService;

  /** DI services required by {@link MermaidViewer} (theme sync, copy-source, source-view editor). */
  @inject(ThemeService)
  protected readonly themeService!: ThemeService;

  @inject(ClipboardService)
  protected readonly clipboardService!: ClipboardService;

  @inject(MonacoEditorProvider)
  protected readonly editorProvider!: MonacoEditorProvider;

  @inject(UntitledResourceResolver)
  protected readonly untitledResourceResolver!: UntitledResourceResolver;

  /** DI services required for the front-matter panel's `[[...]]` click-to-open (FR: UR-002/REQ-007). */
  @inject(NarrativeEntityService)
  protected readonly entityService!: NarrativeEntityService;

  @inject(OpenerService)
  protected readonly openerService!: OpenerService;

  protected editorDisposables = new DisposableCollection();
  protected previewMarkdown = '';
  protected sourceLabel = nls.localize('ai-focused-editor/editor/source-none', 'No Markdown editor selected');
  protected semanticTags: SemanticTag[] = [];
  /** Parsed front-matter of the current chapter (UR-002/REQ-007); `body` is the markdown with the fence stripped. */
  protected frontMatter: ChapterFrontMatterResult = { present: false, fields: [], body: '' };
  /** Lookup for resolving `[[kind:id|label]]` / `[[id]]` mentions inside front-matter values to entities. */
  protected mentionIndex = new Map<string, NarrativeEntity>();
  protected mentionIndexExpiresAt = 0;

  /** Absolute-path (URI string) -> resolved data URI, keyed by file mtime so a
   * re-render on every keystroke re-reads/re-encodes an image only when it changed. */
  protected readonly imageCache = new Map<string, { mtime: number; dataUri: string }>();

  /** Current render's SVG sentinel token -> data URI, consumed by {@link patchPreviewImages}. */
  protected svgSentinels = new Map<string, string>();

  /** Monotonic token so a slow async image resolution never overwrites a newer render. */
  protected imageRenderGeneration = 0;

  /** Monotonic token so a slow async KaTeX load never patches a superseded render. */
  protected mathRenderGeneration = 0;

  @postConstruct()
  protected init(): void {
    this.id = SemanticMarkdownPreviewWidget.ID;
    this.title.label = SemanticMarkdownPreviewWidget.LABEL;
    this.title.caption = nls.localize('ai-focused-editor/editor/preview-caption', 'Semantic Markdown Preview');
    this.title.iconClass = 'fa fa-eye';
    this.title.closable = true;
    this.addClass('afe-semantic-markdown-preview-widget');

    this.toDispose.push(this.editorManager.onCurrentEditorChanged(() => this.refresh()));
    this.toDispose.push(Disposable.create(() => this.editorDisposables.dispose()));
    this.toDispose.push(this.preferenceService.onPreferenceChanged(change => {
      if (change.preferenceName === AI_FOCUSED_EDITOR_PREVIEW_SHOW_TAG_CHIPS) {
        this.update();
      }
    }));
    this.refresh();
  }

  protected get showTagChips(): boolean {
    return this.preferenceService.get<boolean>(AI_FOCUSED_EDITOR_PREVIEW_SHOW_TAG_CHIPS, true);
  }

  refresh(): void {
    this.editorDisposables.dispose();
    this.editorDisposables = new DisposableCollection();

    const editor = this.editorManager.currentEditor?.editor ?? this.editorManager.activeEditor?.editor;
    if (!editor || !this.isMarkdownEditor(editor)) {
      this.previewMarkdown = '';
      this.semanticTags = [];
      this.frontMatter = { present: false, fields: [], body: '' };
      this.svgSentinels = new Map();
      // Cancel any in-flight image/math resolution so it cannot repopulate the cleared preview.
      this.imageRenderGeneration++;
      this.mathRenderGeneration++;
      this.sourceLabel = nls.localize(
        'ai-focused-editor/editor/source-open-file',
        'Open a Markdown manuscript file to preview semantic tags.'
      );
      this.update();
      return;
    }

    this.sourceLabel = editor.uri.path.base;
    this.updatePreview(editor);
    this.editorDisposables.push(editor.onDocumentContentChanged(() => this.updatePreview(editor)));
    this.editorDisposables.push(editor.onLanguageChanged(() => this.refresh()));
  }

  protected updatePreview(editor: TextEditor): void {
    const text = editor.document.getText();
    // Front matter (UR-002/REQ-007) is stripped BEFORE semantic-tag parsing and
    // markdown rendering: the YAML fence is metadata, not prose, and must never
    // show up as a dirty text block in the rendered body (nor get scanned for
    // semantic tags). `renderFrontMatterPanel` renders the typed fields instead.
    this.frontMatter = parseChapterFrontMatter(text);
    const bodyText = this.frontMatter.body;
    this.semanticTags = parseSemanticMarkdown(bodyText).tags;
    const preview = renderSemanticMarkdownPreview(bodyText);
    // Show text + tags immediately; images resolve asynchronously and swap in.
    this.previewMarkdown = preview;
    this.svgSentinels = new Map();
    this.imageRenderGeneration++;
    // Bumped ONCE per document-level render pass (not per segment): segmenting
    // the preview into one `Markdown` instance per non-mermaid run (§render)
    // means `handlePreviewRender` now fires once PER SEGMENT within the same
    // pass. Bumping this counter inside that per-segment callback (as the single
    // pre-segmentation call used to) would make each segment's KaTeX load race
    // its SIBLING segments' calls — later segments in the same pass would flag
    // earlier ones as "superseded" and silently drop their math. Bumping here
    // instead means every segment of ONE render pass shares one generation
    // value, so the guard only ever fires across two genuinely different
    // document renders, exactly as {@link renderMath}'s guard intends.
    this.mathRenderGeneration++;
    this.update();
    void this.resolveImagesAndUpdate(editor, preview, this.imageRenderGeneration);
    // Cheap on the hot (every-keystroke) path: the 5s TTL cache in
    // `loadMentionIndex` makes this a no-op on all but the first call in a while.
    void this.loadMentionIndex();
  }

  /**
   * Refresh the entity lookup used to resolve `[[...]]` mentions inside
   * front-matter values (UR-002/REQ-007), cached for 5s like the other
   * manuscript widgets so typing does not spam the backend.
   */
  protected async loadMentionIndex(): Promise<void> {
    const now = Date.now();
    if (now < this.mentionIndexExpiresAt) {
      return;
    }
    this.mentionIndexExpiresAt = now + 5000;
    try {
      const snapshot = await this.entityService.getSnapshot();
      const index = new Map<string, NarrativeEntity>();
      for (const entity of snapshot.entities) {
        index.set(`${entity.kind}:${entity.id}`, entity);
        index.set(`${entity.kind === 'character' ? 'char' : entity.kind}:${entity.id}`, entity);
        const bareKey = `id:${entity.id}`;
        if (!index.has(bareKey)) {
          index.set(bareKey, entity);
        }
      }
      this.mentionIndex = index;
      this.update();
    } catch {
      // Keep the last known index when the knowledge base is unavailable.
    }
  }

  /**
   * Resolve every relative / workspace-absolute image target in `preview` against
   * the document directory, read each file, and rewrite the target to an inline
   * `data:` URI (raster) or an SVG sentinel (see {@link SVG_SENTINEL_PREFIX}).
   * Applies only when still the latest render (`generation` guard) so typing does
   * not stack stale swaps, and only calls `update()` when something changed — no
   * flicker loop (`render()` never triggers `updatePreview`).
   */
  protected async resolveImagesAndUpdate(
    editor: TextEditor,
    preview: string,
    generation: number
  ): Promise<void> {
    const root = this.workspaceService.tryGetRoots()[0]?.resource;
    if (!root) {
      return;
    }
    const documentPath = editor.uri.path.toString();
    const rootPath = root.path.toString();

    const replacements = new Map<string, string>();
    const attempted = new Set<string>();
    const sentinels = new Map<string, string>();
    let totalBytes = 0;

    for (const { target } of extractImageTargets(preview)) {
      if (attempted.has(target)) {
        continue;
      }
      attempted.add(target);

      const classification = classifyImageTarget(target);
      if (classification !== 'relative' && classification !== 'absolute-workspace') {
        continue; // external / data / skip: leave the target untouched.
      }
      const resolved = resolveRelativeLink(target, documentPath, rootPath);
      if (!resolved) {
        continue; // escapes the workspace root, or otherwise not resolvable.
      }
      const mime = imageMimeForPath(resolved.path);
      if (!mime) {
        continue; // not a recognised image extension.
      }
      if (totalBytes >= MAX_TOTAL_IMAGE_BYTES) {
        continue; // total budget spent; leave the rest unresolved.
      }

      const read = await this.readImageDataUri(root.withPath(resolved.path), mime);
      if (generation !== this.imageRenderGeneration) {
        return; // a newer render superseded us mid-flight.
      }
      if (!read || totalBytes + read.bytes > MAX_TOTAL_IMAGE_BYTES) {
        continue; // over the single-image cap, unreadable, or would blow the total.
      }
      totalBytes += read.bytes;

      if (mime === 'image/svg+xml') {
        const sentinel = `${SVG_SENTINEL_PREFIX}${sentinels.size}`;
        sentinels.set(sentinel, read.dataUri);
        replacements.set(target, sentinel);
      } else {
        replacements.set(target, read.dataUri);
      }
    }

    if (generation !== this.imageRenderGeneration) {
      return;
    }
    const rewritten = replacements.size === 0
      ? preview
      : rewriteImageTargets(preview, target => replacements.get(target));
    if (rewritten === this.previewMarkdown && sentinels.size === 0) {
      return; // nothing to inline; avoid a redundant re-render.
    }
    this.svgSentinels = sentinels;
    this.previewMarkdown = rewritten;
    this.update();
  }

  /**
   * Read an image file and return its `data:` URI plus raw byte length, using the
   * mtime-keyed cache to skip re-reading unchanged files. Returns `undefined` when
   * the file is missing, over {@link MAX_SINGLE_IMAGE_BYTES}, or unreadable.
   */
  protected async readImageDataUri(
    uri: URI,
    mime: string
  ): Promise<{ dataUri: string; bytes: number } | undefined> {
    try {
      const stat = await this.fileService.resolve(uri, { resolveMetadata: true });
      if (stat.size > MAX_SINGLE_IMAGE_BYTES) {
        return undefined;
      }
      const key = uri.toString();
      const cached = this.imageCache.get(key);
      if (cached && cached.mtime === stat.mtime) {
        return { dataUri: cached.dataUri, bytes: stat.size };
      }
      const content = await this.fileService.readFile(uri);
      const bytes = content.value.buffer;
      if (bytes.length > MAX_SINGLE_IMAGE_BYTES) {
        return undefined;
      }
      const dataUri = `data:${mime};base64,${bytesToBase64(bytes)}`;
      this.imageCache.set(key, { mtime: stat.mtime, dataUri });
      return { dataUri, bytes: bytes.length };
    } catch {
      return undefined; // missing/unreadable file: leave the image unresolved.
    }
  }

  /**
   * After the MarkdownRenderer produces the preview DOM, swap each SVG sentinel
   * `<img src="afe-preview-image-N">` to its real `data:image/svg+xml` URI by
   * setting `img.src` on the live node — bypassing markdown-it's format whitelist
   * and DOMPurify (both already ran on the string). Raster images already carry a
   * `data:` src and are ignored. Bound once so the memoized Markdown component's
   * `onRender` prop stays referentially stable across updates.
   */
  protected readonly patchPreviewImages = (element?: HTMLElement): void => {
    if (!element || this.svgSentinels.size === 0) {
      return;
    }
    for (const img of Array.from(element.querySelectorAll('img'))) {
      const src = img.getAttribute('src');
      const dataUri = src ? this.svgSentinels.get(src) : undefined;
      if (dataUri) {
        img.src = dataUri;
      }
    }
  };

  /**
   * `onRender` hook for the preview Markdown component: swap SVG sentinels
   * (see {@link patchPreviewImages}) and, when the rendered text contains any
   * `$`, lazily load KaTeX and render `$$…$$` / `$…$` math over the live DOM.
   * Bound once so the memoized Markdown component's `onRender` prop stays
   * referentially stable across updates.
   *
   * Since the preview segments the markdown around ```mermaid fences
   * ({@link segmentPreviewMarkdown}), this hook now fires once PER MARKDOWN
   * SEGMENT of one document render (a document with N non-mermaid runs mounts
   * N independent `Markdown` instances, each of which calls `onRender`
   * independently — see `Markdown`'s `useMarkdown`). It reads the CURRENT
   * {@link mathRenderGeneration} rather than incrementing it (that happens once
   * per document render, in {@link updatePreview}) so sibling segments of the
   * same pass never flag each other as stale.
   */
  protected readonly handlePreviewRender = (element?: HTMLElement): void => {
    this.patchPreviewImages(element);
    if (element) {
      void this.renderMath(element, this.mathRenderGeneration);
    }
  };

  /**
   * Lazily load KaTeX (only when a `$` is present) and render math over the
   * preview DOM. The `generation` guard drops a stale load that resolved after a
   * newer render replaced the content, and a bundle-load failure leaves the
   * formulas as raw text rather than breaking the preview.
   */
  protected async renderMath(element: HTMLElement, generation: number): Promise<void> {
    const text = element.textContent;
    if (!text || text.indexOf('$') === -1) {
      return;
    }
    let katex: KatexModule;
    try {
      katex = await loadKatex(element.ownerDocument);
    } catch {
      return; // KaTeX bundle failed to load: leave formulas as raw text.
    }
    if (generation !== this.mathRenderGeneration) {
      return; // a newer render superseded us mid-flight.
    }
    renderMathInElement(element, katex);
  }

  protected isMarkdownEditor(editor: TextEditor): boolean {
    return editor.uri.path.ext.toLowerCase() === '.md' || editor.document.languageId === 'markdown';
  }

  protected render(): React.ReactNode {
    return React.createElement(
      'div',
      { className: 'afe-semantic-markdown-preview' },
      React.createElement('div', { className: 'afe-semantic-markdown-preview-source' }, this.sourceLabel),
      this.renderFrontMatterPanel(),
      this.showTagChips ? this.renderTagSummary() : undefined,
      this.previewMarkdown
        ? React.createElement(
            'div',
            { className: 'afe-semantic-markdown-preview-content' },
            ...segmentPreviewMarkdown(this.previewMarkdown).map((segment, index) => this.renderPreviewSegment(segment, index))
          )
        : React.createElement(
            'div',
            { className: 'afe-semantic-markdown-preview-empty' },
            nls.localize('ai-focused-editor/editor/no-preview-content', 'No preview content.')
          )
    );
  }

  /**
   * One preview segment ({@link segmentPreviewMarkdown}): a ```mermaid fence
   * becomes a {@link MermaidViewer} (the exact toolbar/zoom/pan/source-toggle
   * component the AI chat uses, so the UX is consistent); everything else stays
   * on the EXISTING `Markdown` component — unchanged from before segmentation —
   * so the KaTeX `onRender` postprocessing keeps running per segment (each
   * `Markdown` instance calls `onRender` independently; see
   * `handlePreviewRender`).
   */
  protected renderPreviewSegment(segment: MarkdownMermaidSegment, index: number): React.ReactNode {
    if (segment.type === 'mermaid') {
      return React.createElement(MermaidViewer, {
        key: index,
        code: segment.content,
        isComplete: true,
        themeService: this.themeService,
        clipboardService: this.clipboardService,
        editorProvider: this.editorProvider,
        untitledResourceResolver: this.untitledResourceResolver
      });
    }
    return React.createElement(Markdown, {
      key: index,
      markdown: segment.content,
      markdownRenderer: this.markdownRenderer,
      onRender: this.handlePreviewRender
    });
  }

  protected renderTagSummary(): React.ReactNode {
    if (this.semanticTags.length === 0) {
      return React.createElement(
        'div',
        { className: 'afe-semantic-markdown-tag-summary empty' },
        nls.localize('ai-focused-editor/editor/no-tags-detected', 'No semantic tags detected.')
      );
    }

    return React.createElement(
      'div',
      { className: 'afe-semantic-markdown-tag-summary' },
      // en default keeps `{0} semantic tag(s)` byte-identical: the default-locale
      // UI-flow guard (AFE-04) waits for the literal substring "semantic tag(s)".
      React.createElement('strong', undefined, nls.localize(
        'ai-focused-editor/editor/tag-summary-count',
        '{0} semantic tag(s)',
        this.semanticTags.length
      )),
      React.createElement(
        'div',
        { className: 'afe-semantic-markdown-tag-list' },
        ...this.semanticTags.slice(0, 24).map(tag => React.createElement(
          'span',
          {
            key: `${tag.kind}:${tag.id}:${tag.range.start.line}:${tag.range.start.character}`,
            className: `afe-semantic-markdown-tag-chip ${this.normalizeKind(tag.kind)}`
          },
          `${tag.label} (${tag.kind}:${tag.id})`
        )),
        this.semanticTags.length > 24
          ? React.createElement('span', { className: 'afe-semantic-markdown-tag-chip more' }, nls.localize(
              'ai-focused-editor/editor/tag-summary-more',
              '+{0} more',
              this.semanticTags.length - 24
            ))
          : undefined
      )
    );
  }

  protected normalizeKind(kind: string): string {
    return kind.replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
  }

  // ---------------------------------------------------------------------------
  // Front-matter "Properties" panel (UR-002/REQ-007) — read-only, Obsidian-style.
  // ---------------------------------------------------------------------------

  /**
   * The typed front-matter panel, rendered at the very TOP of the preview (above
   * the tag summary and the rendered body). Renders NOTHING — not even an empty
   * frame — when the chapter has no front matter, or when the fence enclosed no
   * keys at all; a malformed fence still renders a panel (an error notice plus
   * the raw YAML block) rather than silently disappearing.
   */
  protected renderFrontMatterPanel(): React.ReactNode {
    const frontMatter = this.frontMatter;
    if (!frontMatter.present) {
      return undefined;
    }
    if (frontMatter.fields.length === 0 && !frontMatter.parseError) {
      return undefined;
    }
    return React.createElement(
      'div',
      { className: 'afe-chapter-front-matter' },
      frontMatter.parseError
        ? this.renderFrontMatterError(frontMatter)
        : React.createElement(
            'dl',
            { className: 'afe-chapter-front-matter-list' },
            ...frontMatter.fields.flatMap((field, index) => this.renderFrontMatterField(field, index))
          )
    );
  }

  /**
   * Graceful fallback for a fence that was found but whose YAML failed to parse
   * (or was not a mapping): an explanatory notice plus the raw block, so the
   * writer can see and fix it without the whole preview breaking.
   */
  protected renderFrontMatterError(frontMatter: ChapterFrontMatterResult): React.ReactNode {
    return React.createElement(
      'div',
      { className: 'afe-chapter-front-matter-error' },
      React.createElement(
        'div',
        { className: 'afe-chapter-front-matter-error-message' },
        nls.localize(
          'ai-focused-editor/editor/front-matter-parse-error',
          'Front matter could not be parsed: {0}',
          frontMatter.parseError ?? ''
        )
      ),
      frontMatter.rawBlock
        ? React.createElement('pre', { className: 'afe-chapter-front-matter-raw' }, frontMatter.rawBlock)
        : undefined
    );
  }

  protected renderFrontMatterField(field: ChapterFrontMatterField, index: number): React.ReactNode[] {
    return [
      React.createElement(
        'dt',
        { key: `fm-label-${index}`, className: `afe-chapter-front-matter-label${field.known ? ' known' : ' passthrough'}` },
        field.label
      ),
      React.createElement(
        'dd',
        { key: `fm-value-${index}`, className: 'afe-chapter-front-matter-value' },
        this.renderFrontMatterValue(field.value, `fm-${index}`)
      )
    ];
  }

  /** Render one typed value, recursing into list items (a list of dates/links renders each item typed). */
  protected renderFrontMatterValue(value: ChapterFrontMatterValue, keyPrefix: string): React.ReactNode {
    switch (value.kind) {
      case 'date':
        return React.createElement(
          'span',
          { className: 'afe-chapter-front-matter-date' },
          React.createElement('i', { className: 'fa fa-calendar', 'aria-hidden': 'true' }),
          ` ${value.display}`
        );
      case 'list':
        return React.createElement(
          'ul',
          { className: 'afe-chapter-front-matter-list-value' },
          ...value.items.map((item, index) => React.createElement(
            'li',
            { key: `${keyPrefix}-${index}` },
            this.renderFrontMatterValue(item, `${keyPrefix}-${index}`)
          ))
        );
      case 'text':
        return this.renderMentionSegments(value.segments, keyPrefix);
      case 'empty':
        return React.createElement(
          'span',
          { className: 'afe-chapter-front-matter-empty' },
          nls.localize('ai-focused-editor/editor/front-matter-empty-value', '(empty)')
        );
      case 'raw':
        return React.createElement('span', undefined, value.display);
      default:
        return undefined;
    }
  }

  /**
   * Render a front-matter text value, turning any `[[...]]` wiki-link segments
   * into clickable spans that open the referenced entity — the same
   * mention-chip UX the entity cards and entity form widgets use for
   * narrative-entity text fields, reused here so a chapter's `summary:` (or any
   * other field) links out exactly like it would inside an entity card.
   * Read-only: this never edits the front matter, only resolves and opens.
   */
  protected renderMentionSegments(segments: EntityMentionSegment[], keyPrefix: string): React.ReactNode[] {
    return segments.map((segment, index) => {
      if (segment.type === 'text') {
        return segment.value;
      }
      const { mention } = segment;
      const entity = this.resolveMention(mention);
      const display = mention.label ?? entity?.label ?? mention.id;
      const key = `${keyPrefix}-mention-${index}`;
      if (!entity) {
        return React.createElement(
          'span',
          {
            key,
            className: 'afe-entity-mention unknown',
            title: nls.localize(
              'ai-focused-editor/entities/unknown-entity',
              'Unknown entity: {0}',
              `${mention.kind ? `${mention.kind}:` : ''}${mention.id}`
            )
          },
          display
        );
      }
      return React.createElement(
        'span',
        {
          key,
          className: 'afe-entity-mention',
          title: nls.localize('ai-focused-editor/entities/open-entity', 'Open {0}: {1}', entity.kind, entity.label),
          role: 'link',
          tabIndex: 0,
          onClick: () => { void this.openMention(entity); },
          onKeyDown: (event: React.KeyboardEvent) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              void this.openMention(entity);
            }
          }
        },
        display
      );
    });
  }

  protected resolveMention(mention: EntityMention): NarrativeEntity | undefined {
    return mention.kind
      ? this.mentionIndex.get(`${mention.kind}:${mention.id}`)
      : this.mentionIndex.get(`id:${mention.id}`);
  }

  protected async openMention(entity: NarrativeEntity): Promise<void> {
    await open(this.openerService, new URI(entity.uri));
  }
}
