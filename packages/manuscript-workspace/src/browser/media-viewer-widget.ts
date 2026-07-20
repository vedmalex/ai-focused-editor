import URI from '@theia/core/lib/common/uri';
import { Navigatable } from '@theia/core/lib/browser';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { nls } from '@theia/core/lib/common/nls';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { inject, injectable } from '@theia/core/shared/inversify';
import React from '@theia/core/shared/react';
import {
  isBrowserPlayableMedia,
  isVideoPath,
  mediaExtensionOf,
  mediaMimeForPath
} from '../common/media-mime';

/**
 * Skip loading any single media file whose bytes exceed this — the whole file
 * is read into memory (FileService -> Blob -> object URL; no streaming), so an
 * unbounded read could hang the renderer. MAX_SINGLE_IMAGE_BYTES's media
 * sibling, sized for long lecture recordings.
 */
const MAX_SINGLE_MEDIA_BYTES = 500 * 1024 * 1024;

/** Human-readable byte size (e.g. `3.4 MB`) for the panels (image-viewer copy). */
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

/**
 * A read-only audio/video player editor. Any media file (see
 * `common/media-mime.ts` — the same universe the transcript-check feature
 * ingests) opens here as a playable HTML5 `<audio>`/`<video>` instead of raw
 * bytes in the text editor. It is {@link Navigatable} (so it participates in
 * "reveal in editor" / move) but NOT `Saveable` — media is never edited.
 *
 * Playable formats (mp3/m4a/wav/ogg/flac/aac; mp4/m4v/mov/webm) are read
 * through the {@link FileService} (browser + electron safe; same discipline as
 * the transcript-check widget's audio loading), wrapped in a Blob, and handed
 * to the element via an object URL. The URL is created on load and revoked on
 * every reload and on dispose. Formats Chromium cannot demux (mkv/avi) get a
 * clear "cannot preview in the browser, open it externally" panel instead of a
 * broken player; oversize files get a "too large to preview" panel. The widget
 * never throws — every failure resolves to a message.
 *
 * This is a plain player on purpose: the transcript-check widget keeps its own
 * wavesurfer/transport machinery, which is NOT duplicated here.
 */
@injectable()
export class MediaViewerWidget extends ReactWidget implements Navigatable {
  static readonly FACTORY_ID = 'ai-focused-editor.media-viewer';

  @inject(FileService)
  protected readonly fileService!: FileService;

  protected uri!: URI;
  protected loading = true;
  protected error: string | undefined;
  /** Object URL for the loaded media Blob; '' while nothing is loaded. */
  protected objectUrl = '';
  /** True for recognised media the browser cannot play (mkv/avi). */
  protected unplayable = false;
  /** True when the file is over {@link MAX_SINGLE_MEDIA_BYTES}. */
  protected oversize = false;
  protected fileSize = 0;
  /** mtime of the last successful load, so a re-open of an unchanged file skips the re-read. */
  protected loadedMtime: number | undefined;

  configure(uri: URI): void {
    this.uri = uri;
    this.id = `${MediaViewerWidget.FACTORY_ID}:${uri.toString()}`;
    this.title.label = uri.path.base;
    this.title.caption = nls.localize('ai-focused-editor/media-viewer/caption', 'Media: {0}', uri.path.fsPath());
    this.title.iconClass = 'codicon codicon-play-circle';
    this.title.closable = true;
    this.addClass('afe-media-viewer-widget');
    void this.load();
  }

  getResourceUri(): URI | undefined {
    return this.uri;
  }

  createMoveToUri(resourceUri: URI): URI | undefined {
    return resourceUri;
  }

  /** True when this file should be played in a `<video>` element (else `<audio>`). */
  protected isVideo(): boolean {
    return isVideoPath(this.uri.path.toString());
  }

  protected async load(): Promise<void> {
    this.loading = true;
    this.error = undefined;
    this.unplayable = false;
    this.oversize = false;
    this.update();
    try {
      const path = this.uri.path.toString();
      const stat = await this.fileService.resolve(this.uri, { resolveMetadata: true });
      this.fileSize = stat.size;
      if (!isBrowserPlayableMedia(path)) {
        // Recognised-but-undemuxable media (mkv/avi): show the "open it
        // externally" panel rather than a player that silently errors.
        this.releaseObjectUrl();
        this.unplayable = true;
        return;
      }
      if (stat.size > MAX_SINGLE_MEDIA_BYTES) {
        this.releaseObjectUrl();
        this.oversize = true;
        return;
      }
      if (this.objectUrl && this.loadedMtime === stat.mtime) {
        // Unchanged file already loaded — keep the existing object URL.
        return;
      }
      const content = await this.fileService.readFile(this.uri);
      const bytes = content.value.buffer;
      // Copy into a plain ArrayBuffer for the Blob (transcript-widget discipline —
      // the BinaryBuffer's backing store may be a shared/offset view).
      const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      const blob = new Blob([copy], { type: mediaMimeForPath(path) ?? 'application/octet-stream' });
      // Revoke the previous URL only after the replacement is ready.
      this.releaseObjectUrl();
      this.objectUrl = URL.createObjectURL(blob);
      this.loadedMtime = stat.mtime;
    } catch (error) {
      this.releaseObjectUrl();
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.loading = false;
      this.update();
    }
  }

  /** Idempotent revoke of the current object URL (reload + dispose path). */
  protected releaseObjectUrl(): void {
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = '';
    }
    this.loadedMtime = undefined;
  }

  override dispose(): void {
    this.releaseObjectUrl();
    super.dispose();
  }

  protected render(): React.ReactNode {
    if (this.loading) {
      return React.createElement(
        'div',
        { className: 'afe-media-viewer-status' },
        nls.localize('ai-focused-editor/media-viewer/loading', 'Loading media...')
      );
    }
    if (this.error) {
      return React.createElement(
        'div',
        { className: 'afe-media-viewer-status error' },
        nls.localize('ai-focused-editor/media-viewer/error', 'Could not open media file: {0}', this.error)
      );
    }
    return React.createElement(
      'div',
      { className: 'afe-media-viewer' },
      this.renderToolbar(),
      React.createElement('div', { className: 'afe-media-viewer-stage' }, this.renderBody())
    );
  }

  protected renderToolbar(): React.ReactNode {
    return React.createElement(
      'div',
      { className: 'afe-media-viewer-toolbar' },
      React.createElement('span', { className: 'afe-media-viewer-name' }, this.uri.path.base),
      React.createElement('span', { className: 'afe-media-viewer-size' }, formatBytes(this.fileSize))
    );
  }

  protected renderBody(): React.ReactNode {
    if (this.unplayable) {
      return this.renderMessagePanel(
        nls.localize(
          'ai-focused-editor/media-viewer/unplayable',
          '«{0}» — this format ({1}) can\'t be played in the browser engine. Open it in an external player.',
          this.uri.path.base,
          mediaExtensionOf(this.uri.path.toString()) || '?'
        )
      );
    }
    if (this.oversize) {
      return this.renderMessagePanel(
        nls.localize(
          'ai-focused-editor/media-viewer/oversize',
          '«{0}» is too large to preview ({1}). Open it in an external player.',
          this.uri.path.base,
          formatBytes(this.fileSize)
        )
      );
    }
    if (this.objectUrl) {
      if (this.isVideo()) {
        return React.createElement('video', {
          className: 'afe-media-viewer-video',
          src: this.objectUrl,
          controls: true,
          preload: 'metadata'
        });
      }
      return React.createElement('audio', {
        className: 'afe-media-viewer-audio',
        src: this.objectUrl,
        controls: true,
        preload: 'metadata'
      });
    }
    return this.renderMessagePanel(
      nls.localize('ai-focused-editor/media-viewer/read-failed', 'The media file could not be read.')
    );
  }

  protected renderMessagePanel(message: string): React.ReactNode {
    return React.createElement(
      'div',
      { className: 'afe-media-viewer-message' },
      React.createElement('span', { className: 'codicon codicon-play-circle afe-media-viewer-message-icon' }),
      React.createElement('div', { className: 'afe-media-viewer-message-text' }, message),
      React.createElement(
        'div',
        { className: 'afe-media-viewer-message-size' },
        nls.localize('ai-focused-editor/media-viewer/file-size', 'File size: {0}', formatBytes(this.fileSize))
      )
    );
  }
}
