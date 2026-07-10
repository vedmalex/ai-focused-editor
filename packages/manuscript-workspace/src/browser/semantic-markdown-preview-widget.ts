import {
  parseSemanticMarkdown,
  renderSemanticMarkdownPreview,
  SemanticTag
} from '@ai-focused-editor/semantic-markdown';
import { Disposable, DisposableCollection } from '@theia/core/lib/common';
import { nls } from '@theia/core/lib/common/nls';
import URI from '@theia/core/lib/common/uri';
import { PreferenceService } from '@theia/core/lib/common/preferences';
import { Markdown } from '@theia/core/lib/browser/markdown-rendering/markdown';
import { MarkdownRenderer } from '@theia/core/lib/browser/markdown-rendering/markdown-renderer';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import type { ExtractableWidget } from '@theia/core/lib/browser/widgets/extractable-widget';
import { EditorManager } from '@theia/editor/lib/browser/editor-manager';
import type { TextEditor } from '@theia/editor/lib/browser/editor';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
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

/** Extension (lower-case, no dot) -> data-URI mime for inlinable raster/vector images. */
const IMAGE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml'
};

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

/** Lower-case extension (no dot) of a POSIX path, or '' when there is none. */
function extensionOf(path: string): string {
  const slash = path.lastIndexOf('/');
  const dot = path.lastIndexOf('.');
  if (dot <= slash + 1) {
    return '';
  }
  return path.slice(dot + 1).toLowerCase();
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

  protected editorDisposables = new DisposableCollection();
  protected previewMarkdown = '';
  protected sourceLabel = nls.localize('ai-focused-editor/editor/source-none', 'No Markdown editor selected');
  protected semanticTags: SemanticTag[] = [];

  /** Absolute-path (URI string) -> resolved data URI, keyed by file mtime so a
   * re-render on every keystroke re-reads/re-encodes an image only when it changed. */
  protected readonly imageCache = new Map<string, { mtime: number; dataUri: string }>();

  /** Current render's SVG sentinel token -> data URI, consumed by {@link patchPreviewImages}. */
  protected svgSentinels = new Map<string, string>();

  /** Monotonic token so a slow async image resolution never overwrites a newer render. */
  protected imageRenderGeneration = 0;

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
      this.svgSentinels = new Map();
      // Cancel any in-flight image resolution so it cannot repopulate the cleared preview.
      this.imageRenderGeneration++;
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
    this.semanticTags = parseSemanticMarkdown(text).tags;
    const preview = renderSemanticMarkdownPreview(text);
    // Show text + tags immediately; images resolve asynchronously and swap in.
    this.previewMarkdown = preview;
    this.svgSentinels = new Map();
    this.imageRenderGeneration++;
    this.update();
    void this.resolveImagesAndUpdate(editor, preview, this.imageRenderGeneration);
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
      const mime = IMAGE_MIME_BY_EXTENSION[extensionOf(resolved.path)];
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

  protected isMarkdownEditor(editor: TextEditor): boolean {
    return editor.uri.path.ext.toLowerCase() === '.md' || editor.document.languageId === 'markdown';
  }

  protected render(): React.ReactNode {
    return React.createElement(
      'div',
      { className: 'afe-semantic-markdown-preview' },
      React.createElement('div', { className: 'afe-semantic-markdown-preview-source' }, this.sourceLabel),
      this.showTagChips ? this.renderTagSummary() : undefined,
      this.previewMarkdown
        ? React.createElement(Markdown, {
            markdown: this.previewMarkdown,
            markdownRenderer: this.markdownRenderer,
            className: 'afe-semantic-markdown-preview-content',
            onRender: this.patchPreviewImages
          })
        : React.createElement(
            'div',
            { className: 'afe-semantic-markdown-preview-empty' },
            nls.localize('ai-focused-editor/editor/no-preview-content', 'No preview content.')
          )
    );
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
}
