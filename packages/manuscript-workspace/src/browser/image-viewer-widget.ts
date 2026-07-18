import URI from '@theia/core/lib/common/uri';
import { Navigatable } from '@theia/core/lib/browser';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { nls } from '@theia/core/lib/common/nls';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { inject, injectable } from '@theia/core/shared/inversify';
import React from '@theia/core/shared/react';
import {
  imageExtensionOf,
  imageMimeForPath,
  isBrowserRenderableImage
} from '../common/image-mime';

/** Skip inlining any single image whose bytes exceed this (preview-widget parity). */
const MAX_SINGLE_IMAGE_BYTES = 10 * 1024 * 1024;

/** Encode raw bytes as base64 without blowing the call stack (preview-widget copy). */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }
  return btoa(binary);
}

/** Human-readable byte size (e.g. `3.4 MB`) for the "too large"/"can't preview" panels. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

type ImageFit = 'fit' | 'actual';

/**
 * A read-only image viewer editor. Any image file (see `common/image-mime.ts`)
 * opens here as an actual image instead of raw bytes in the text editor. It is
 * {@link Navigatable} (so it participates in "reveal in editor" / move) but NOT
 * `Saveable` — an image is never edited in place.
 *
 * Browser-renderable formats (png/jpeg/webp/gif/svg/bmp/ico/avif/apng) are read
 * through the {@link FileService}, encoded to a base64 `data:` URI, and shown in a
 * centered `<img>` on a neutral checkerboard backdrop with a fit/actual-size
 * toggle. Formats a Chromium `<img>` cannot decode (tiff/heic/heif) get a clear
 * "convert to PNG/JPEG" panel instead of a broken image; oversize files get a
 * "too large to preview" panel. The widget never throws — every failure resolves
 * to a message.
 */
@injectable()
export class ImageViewerWidget extends ReactWidget implements Navigatable {
  static readonly FACTORY_ID = 'ai-focused-editor.image-viewer';

  @inject(FileService)
  protected readonly fileService!: FileService;

  protected uri!: URI;
  protected loading = true;
  protected error: string | undefined;
  protected dataUri: string | undefined;
  /** True for a recognised image the browser cannot render (tiff/heic/heif). */
  protected unrenderable = false;
  /** True when the file is over {@link MAX_SINGLE_IMAGE_BYTES}. */
  protected oversize = false;
  protected fileSize = 0;
  protected fitMode: ImageFit = 'fit';

  /** mtime-keyed data-URI cache so a revert/reload re-encodes only when changed. */
  protected readonly imageCache = new Map<string, { mtime: number; dataUri: string }>();

  configure(uri: URI): void {
    this.uri = uri;
    this.id = `${ImageViewerWidget.FACTORY_ID}:${uri.toString()}`;
    this.title.label = uri.path.base;
    this.title.caption = nls.localize('ai-focused-editor/image-viewer/caption', 'Image: {0}', uri.path.fsPath());
    this.title.iconClass = 'codicon codicon-file-media';
    this.title.closable = true;
    this.addClass('afe-image-viewer-widget');
    void this.load();
  }

  getResourceUri(): URI | undefined {
    return this.uri;
  }

  createMoveToUri(resourceUri: URI): URI | undefined {
    return resourceUri;
  }

  protected async load(): Promise<void> {
    this.loading = true;
    this.error = undefined;
    this.dataUri = undefined;
    this.unrenderable = false;
    this.oversize = false;
    this.update();
    try {
      const path = this.uri.path.toString();
      const stat = await this.fileService.resolve(this.uri, { resolveMetadata: true });
      this.fileSize = stat.size;
      if (!isBrowserRenderableImage(path)) {
        // A recognised-but-undecodable image (tiff/heic/heif): show the "convert"
        // panel rather than a broken <img>.
        this.unrenderable = true;
        return;
      }
      if (stat.size > MAX_SINGLE_IMAGE_BYTES) {
        this.oversize = true;
        return;
      }
      this.dataUri = await this.readImageDataUri(this.uri, stat.mtime);
      if (!this.dataUri) {
        this.error = nls.localize(
          'ai-focused-editor/image-viewer/read-failed',
          'The image could not be read.'
        );
      }
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.loading = false;
      this.update();
    }
  }

  /**
   * Read the image file and return its `data:` URI, using the mtime-keyed cache to
   * skip re-encoding an unchanged file. Returns `undefined` when the file is
   * unreadable or over {@link MAX_SINGLE_IMAGE_BYTES} (preview-widget parity).
   */
  protected async readImageDataUri(uri: URI, mtime: number): Promise<string | undefined> {
    const mime = imageMimeForPath(uri.path.toString()) ?? 'application/octet-stream';
    const key = uri.toString();
    const cached = this.imageCache.get(key);
    if (cached && cached.mtime === mtime) {
      return cached.dataUri;
    }
    try {
      const content = await this.fileService.readFile(uri);
      const bytes = content.value.buffer;
      if (bytes.length > MAX_SINGLE_IMAGE_BYTES) {
        return undefined;
      }
      const dataUri = `data:${mime};base64,${bytesToBase64(bytes)}`;
      this.imageCache.set(key, { mtime, dataUri });
      return dataUri;
    } catch {
      return undefined;
    }
  }

  protected toggleFit(): void {
    this.fitMode = this.fitMode === 'fit' ? 'actual' : 'fit';
    this.update();
  }

  protected render(): React.ReactNode {
    if (this.loading) {
      return React.createElement(
        'div',
        { className: 'afe-image-viewer-status' },
        nls.localize('ai-focused-editor/image-viewer/loading', 'Loading image...')
      );
    }
    if (this.error) {
      return React.createElement(
        'div',
        { className: 'afe-image-viewer-status error' },
        nls.localize('ai-focused-editor/image-viewer/error', 'Could not open image: {0}', this.error)
      );
    }
    return React.createElement(
      'div',
      { className: 'afe-image-viewer' },
      this.dataUri ? this.renderToolbar() : undefined,
      React.createElement('div', { className: 'afe-image-viewer-stage' }, this.renderBody())
    );
  }

  protected renderToolbar(): React.ReactNode {
    const actual = this.fitMode === 'actual';
    return React.createElement(
      'div',
      { className: 'afe-image-viewer-toolbar' },
      React.createElement('span', { className: 'afe-image-viewer-name' }, this.uri.path.base),
      React.createElement('span', { className: 'afe-image-viewer-size' }, formatBytes(this.fileSize)),
      React.createElement(
        'button',
        {
          className: 'theia-button secondary afe-image-viewer-fit-toggle',
          type: 'button',
          onClick: () => this.toggleFit()
        },
        actual
          ? nls.localize('ai-focused-editor/image-viewer/zoom-to-fit', 'Zoom to fit')
          : nls.localize('ai-focused-editor/image-viewer/actual-size', 'Actual size')
      )
    );
  }

  protected renderBody(): React.ReactNode {
    if (this.unrenderable) {
      return this.renderMessagePanel(
        nls.localize(
          'ai-focused-editor/image-viewer/unrenderable',
          '«{0}» — this format ({1}) can\'t be shown in the browser. Convert it to PNG or JPEG.',
          this.uri.path.base,
          imageExtensionOf(this.uri.path.toString()) || '?'
        )
      );
    }
    if (this.oversize) {
      return this.renderMessagePanel(
        nls.localize(
          'ai-focused-editor/image-viewer/oversize',
          '«{0}» is too large to preview ({1}).',
          this.uri.path.base,
          formatBytes(this.fileSize)
        )
      );
    }
    if (this.dataUri) {
      return React.createElement('img', {
        className: `afe-image-viewer-img${this.fitMode === 'actual' ? ' actual-size' : ''}`,
        src: this.dataUri,
        alt: this.uri.path.base
      });
    }
    return this.renderMessagePanel(
      nls.localize('ai-focused-editor/image-viewer/read-failed', 'The image could not be read.')
    );
  }

  protected renderMessagePanel(message: string): React.ReactNode {
    return React.createElement(
      'div',
      { className: 'afe-image-viewer-message' },
      React.createElement('span', { className: 'codicon codicon-file-media afe-image-viewer-message-icon' }),
      React.createElement('div', { className: 'afe-image-viewer-message-text' }, message),
      React.createElement(
        'div',
        { className: 'afe-image-viewer-message-size' },
        nls.localize('ai-focused-editor/image-viewer/file-size', 'File size: {0}', formatBytes(this.fileSize))
      )
    );
  }
}
