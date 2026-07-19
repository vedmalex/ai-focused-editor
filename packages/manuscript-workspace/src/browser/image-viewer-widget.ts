import Cropper from 'cropperjs';
import URI from '@theia/core/lib/common/uri';
import { MessageService } from '@theia/core/lib/common';
import { BinaryBuffer } from '@theia/core/lib/common/buffer';
import { Navigatable } from '@theia/core/lib/browser';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { nls } from '@theia/core/lib/common/nls';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { inject, injectable } from '@theia/core/shared/inversify';
import React from '@theia/core/shared/react';
import { uniqueCropFileName } from '../common/image-crop';
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
 *
 * EDIT MODE (basic image editor): for browser-renderable images the toolbar
 * offers an "Edit" toggle that swaps the static `<img>` for a Cropper.js
 * instance (crop box + rotate/flip). The original file is NEVER modified —
 * "Save fragment" writes the cropped canvas as a NEW sibling PNG
 * (`<base>-crop.png`, `-crop-1`, ... — see `common/image-crop.ts`). The Cropper
 * lives on a widget-owned host node that the React ref re-appends, mirroring the
 * Excalidraw/wavesurfer host discipline, so React re-renders never destroy it;
 * the instance is created on entering edit mode and destroyed on exit/dispose.
 */
@injectable()
export class ImageViewerWidget extends ReactWidget implements Navigatable {
  static readonly FACTORY_ID = 'ai-focused-editor.image-viewer';

  @inject(FileService)
  protected readonly fileService!: FileService;

  @inject(MessageService)
  protected readonly messageService!: MessageService;

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

  // --- edit mode (Cropper.js) ---
  protected editMode = false;
  /** In-flight "Save fragment" guard so a double click can't write twice. */
  protected saving = false;
  /** The live Cropper instance while in edit mode; undefined otherwise. */
  protected cropper: Cropper | undefined;
  /**
   * Widget-owned DOM subtree Cropper attaches to. Created on entering edit mode,
   * (re-)appended into the React tree by {@link attachEditHost} on every render,
   * torn down only by {@link destroyCropper} — so a React re-render (e.g. a
   * toolbar update) can never wipe the Cropper DOM.
   */
  protected editHostNode: HTMLDivElement | undefined;
  protected editImageEl: HTMLImageElement | undefined;
  /** Flip state for scaleX/scaleY (Cropper toggles sign, we track it). */
  protected flippedX = false;
  protected flippedY = false;

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
    // A (re)load invalidates the edit session: the Cropper was created over the
    // previous image data.
    this.destroyCropper();
    this.editMode = false;
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

  // ------------------------------------------------------------------
  // Edit mode (Cropper.js lifecycle)
  // ------------------------------------------------------------------

  /** Editing is only offered for images a `<canvas>` can decode. */
  protected canEdit(): boolean {
    return !!this.dataUri && isBrowserRenderableImage(this.uri.path.toString());
  }

  /**
   * Enter edit mode: build the widget-owned host (`<div><img/></div>`) over the
   * CURRENT data URI. The Cropper instance itself is created by
   * {@link attachEditHost} once React has mounted the host into the document —
   * Cropper sizes itself from the parent element, so it must be in the DOM.
   */
  protected enterEditMode(): void {
    if (this.editMode || !this.canEdit()) {
      return;
    }
    const host = document.createElement('div');
    host.className = 'afe-image-editor-host';
    const image = document.createElement('img');
    image.src = this.dataUri!;
    image.alt = this.uri.path.base;
    host.appendChild(image);
    this.editHostNode = host;
    this.editImageEl = image;
    this.editMode = true;
    this.update();
  }

  /** Leave edit mode (Done/Cancel): destroy the Cropper, back to the static view. */
  protected exitEditMode(): void {
    if (!this.editMode) {
      return;
    }
    this.destroyCropper();
    this.editMode = false;
    this.update();
  }

  /**
   * React ref callback for the edit stage: re-appends the SAME widget-owned host
   * node on every render (so re-renders never recreate the Cropper DOM) and
   * lazily creates the Cropper on first mount. Double-create is guarded by the
   * `cropper` field; re-entry after exit builds a fresh host + instance.
   */
  protected attachEditHost(container: HTMLDivElement | null): void {
    if (!container || !this.editHostNode) {
      return;
    }
    if (this.editHostNode.parentElement !== container) {
      container.appendChild(this.editHostNode);
    }
    this.ensureCropper();
  }

  protected ensureCropper(): void {
    if (this.cropper || !this.editImageEl) {
      return;
    }
    this.flippedX = false;
    this.flippedY = false;
    this.cropper = new Cropper(this.editImageEl, {
      // Keep the crop box within the image canvas; movable + zoomable defaults on.
      viewMode: 1,
      autoCropArea: 0.8,
      // The stage already provides the checkerboard-free editing surface.
      background: true,
      responsive: true,
      checkCrossOrigin: false
    });
  }

  /** Idempotent teardown of the Cropper instance and its host subtree. */
  protected destroyCropper(): void {
    if (this.cropper) {
      this.cropper.destroy();
      this.cropper = undefined;
    }
    if (this.editHostNode) {
      this.editHostNode.remove();
      this.editHostNode = undefined;
    }
    this.editImageEl = undefined;
    this.flippedX = false;
    this.flippedY = false;
    this.saving = false;
  }

  override dispose(): void {
    this.destroyCropper();
    super.dispose();
  }

  protected rotate(degrees: number): void {
    this.cropper?.rotate(degrees);
  }

  protected flipHorizontal(): void {
    if (!this.cropper) {
      return;
    }
    this.flippedX = !this.flippedX;
    this.cropper.scaleX(this.flippedX ? -1 : 1);
  }

  protected flipVertical(): void {
    if (!this.cropper) {
      return;
    }
    this.flippedY = !this.flippedY;
    this.cropper.scaleY(this.flippedY ? -1 : 1);
  }

  protected resetEdit(): void {
    if (!this.cropper) {
      return;
    }
    // `reset()` restores the initial canvas/crop box but keeps scaleX/scaleY,
    // so undo the flips explicitly.
    this.cropper.reset();
    if (this.flippedX) {
      this.cropper.scaleX(1);
      this.flippedX = false;
    }
    if (this.flippedY) {
      this.cropper.scaleY(1);
      this.flippedY = false;
    }
  }

  /**
   * "Save fragment": render the current crop (rotation/flip applied) to a
   * canvas, encode as PNG, and write it as a NEW file next to the original —
   * `<base>-crop.png` or the first free `<base>-crop-N.png`. The original file
   * is never touched; `createFile` (no overwrite) backstops the exists-check.
   */
  protected async saveFragment(): Promise<void> {
    const cropper = this.cropper;
    if (!cropper || this.saving) {
      return;
    }
    this.saving = true;
    this.update();
    try {
      const canvas = cropper.getCroppedCanvas();
      if (!canvas || canvas.width === 0 || canvas.height === 0) {
        throw new Error(nls.localize(
          'ai-focused-editor/image-viewer/empty-crop',
          'The crop selection is empty.'
        ));
      }
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          result => result
            ? resolve(result)
            : reject(new Error(nls.localize(
              'ai-focused-editor/image-viewer/encode-failed',
              'The cropped image could not be encoded as PNG.'
            ))),
          'image/png'
        );
      });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const parent = this.uri.parent;
      const name = await uniqueCropFileName(
        this.uri.path.base,
        candidate => this.fileService.exists(parent.resolve(candidate))
      );
      await this.fileService.createFile(parent.resolve(name), BinaryBuffer.wrap(bytes));
      this.messageService.info(nls.localize(
        'ai-focused-editor/image-viewer/fragment-saved',
        'Cropped fragment saved as «{0}» next to the original.',
        name
      ));
    } catch (error) {
      this.messageService.error(nls.localize(
        'ai-focused-editor/image-viewer/fragment-save-failed',
        'Could not save the cropped fragment: {0}',
        error instanceof Error ? error.message : String(error)
      ));
    } finally {
      this.saving = false;
      this.update();
    }
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
    if (this.editMode) {
      return React.createElement(
        'div',
        { className: 'afe-image-viewer editing' },
        this.renderEditToolbar(),
        React.createElement('div', {
          className: 'afe-image-viewer-stage editing',
          ref: (container: HTMLDivElement | null) => this.attachEditHost(container)
        })
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
      this.canEdit()
        ? React.createElement(
          'button',
          {
            className: 'theia-button secondary afe-image-editor-toggle',
            type: 'button',
            onClick: () => this.enterEditMode()
          },
          nls.localize('ai-focused-editor/image-viewer/edit', 'Edit')
        )
        : undefined,
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

  /** Toolbar while editing: rotate/flip/reset on the left, save/cancel on the right. */
  protected renderEditToolbar(): React.ReactNode {
    const button = (
      className: string,
      label: string,
      onClick: () => void,
      options: { disabled?: boolean; primary?: boolean } = {}
    ) => React.createElement(
      'button',
      {
        className: `theia-button ${options.primary ? 'main' : 'secondary'} ${className}`,
        type: 'button',
        disabled: options.disabled === true,
        onClick
      },
      label
    );
    return React.createElement(
      'div',
      { className: 'afe-image-viewer-toolbar afe-image-editor-toolbar' },
      React.createElement('span', { className: 'afe-image-viewer-name' }, this.uri.path.base),
      button(
        'afe-image-editor-rotate-left',
        nls.localize('ai-focused-editor/image-viewer/rotate-left', 'Rotate left'),
        () => this.rotate(-90)
      ),
      button(
        'afe-image-editor-rotate-right',
        nls.localize('ai-focused-editor/image-viewer/rotate-right', 'Rotate right'),
        () => this.rotate(90)
      ),
      button(
        'afe-image-editor-flip-h',
        nls.localize('ai-focused-editor/image-viewer/flip-horizontal', 'Flip horizontal'),
        () => this.flipHorizontal()
      ),
      button(
        'afe-image-editor-flip-v',
        nls.localize('ai-focused-editor/image-viewer/flip-vertical', 'Flip vertical'),
        () => this.flipVertical()
      ),
      button(
        'afe-image-editor-reset',
        nls.localize('ai-focused-editor/image-viewer/reset', 'Reset'),
        () => this.resetEdit()
      ),
      React.createElement(
        'span',
        { className: 'afe-image-editor-actions' },
        button(
          'afe-image-editor-save',
          this.saving
            ? nls.localize('ai-focused-editor/image-viewer/saving-fragment', 'Saving...')
            : nls.localize('ai-focused-editor/image-viewer/save-fragment', 'Save fragment'),
          () => { void this.saveFragment(); },
          { disabled: this.saving, primary: true }
        ),
        button(
          'afe-image-editor-cancel',
          nls.localize('ai-focused-editor/image-viewer/done', 'Done'),
          () => this.exitEditMode(),
          { disabled: this.saving }
        )
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
