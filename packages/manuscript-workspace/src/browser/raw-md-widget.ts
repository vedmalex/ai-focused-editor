import URI from '@theia/core/lib/common/uri';
import { Navigatable, open, OpenerService } from '@theia/core/lib/browser';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { MessageService } from '@theia/core/lib/common';
import { nls } from '@theia/core/lib/common/nls';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { FileChangesEvent } from '@theia/filesystem/lib/common/files';
import { Disposable } from '@theia/core/lib/common/disposable';
import { inject, injectable } from '@theia/core/shared/inversify';
import React from '@theia/core/shared/react';
import {
  RawMdParsedLine,
  TRANSCRIPTSET_FILE_NAME,
  parseRawMdLines,
  parseTimeAbsoluteToSeconds
} from '../common';
import { TranscriptCheckWidget } from './transcript-check-widget';

const h = React.createElement;

/** Debounce for the file-watch auto-reload (mirrors `TranscriptCheckWidget`). */
const REFRESH_DEBOUNCE_MS = 300;

/**
 * A READ-ONLY structural viewer for a set's flattened `raw.md` full text
 * (TASK-016 U4b / UR-004, UR-007 decision 1): renders each line's time /
 * speaker-change chip / text (via {@link parseRawMdLines}) instead of raw
 * Markdown source. It is {@link Navigatable} (participates in "reveal in
 * editor" / move) but deliberately NOT `Saveable` — two-way sync back into
 * segments is a follow-up task (UR-007); this widget only ever WRITES via the
 * explicit "Regenerate" action, which delegates to
 * `TranscriptCheckWidget.generateRawMdFile()`.
 *
 * Clicking a line opens (or reveals) the set's `transcriptset.yaml` sidecar
 * through the `OpenerService` — the `TranscriptCheckOpenHandler` (priority
 * 500) resolves that to the `TranscriptCheckWidget` — and asks it to jump to
 * the corresponding segment via the already-public
 * `TranscriptCheckWidget.revealRawMdSegment()` (ISS-160: a thin wrapper over
 * already-public `selectFile`/`jumpToSegmentIndex`, not a visibility fix).
 *
 * Re-reads `raw.md` on {@link FileService.onDidFilesChange} (debounced) —
 * covers both external edits AND the "Regenerate" action's own write (which
 * fires the same event on this file).
 */
@injectable()
export class RawMdWidget extends ReactWidget implements Navigatable {
  static readonly FACTORY_ID = 'ai-focused-editor.raw-md-viewer';

  @inject(FileService)
  protected readonly fileService!: FileService;

  @inject(OpenerService)
  protected readonly openerService!: OpenerService;

  @inject(MessageService)
  protected readonly messageService!: MessageService;

  protected uri!: URI;
  protected loading = true;
  protected error: string | undefined;
  protected lines: RawMdParsedLine[] = [];
  protected refreshHandle: ReturnType<typeof setTimeout> | undefined;

  configure(uri: URI): void {
    this.uri = uri;
    this.id = `${RawMdWidget.FACTORY_ID}:${uri.toString()}`;
    this.title.label = uri.parent.path.base || uri.path.base;
    this.title.caption = nls.localize('ai-focused-editor/transcript/raw-md-caption', 'Transcript Full Text: {0}', uri.path.fsPath());
    this.title.iconClass = 'codicon codicon-book';
    this.title.closable = true;
    this.addClass('afe-raw-md-widget');
    this.node.tabIndex = 0;
    this.toDispose.push(this.fileService.onDidFilesChange(event => this.onFilesChanged(event)));
    this.toDispose.push(Disposable.create(() => {
      if (this.refreshHandle !== undefined) {
        clearTimeout(this.refreshHandle);
        this.refreshHandle = undefined;
      }
    }));
    void this.load();
  }

  getResourceUri(): URI | undefined {
    return this.uri;
  }

  createMoveToUri(resourceUri: URI): URI | undefined {
    return resourceUri;
  }

  /** The set's sidecar (`transcription/<slug>/transcriptset.yaml`) — the `TranscriptCheckWidget` open target. */
  protected get sidecarUri(): URI {
    return this.uri.parent.resolve(TRANSCRIPTSET_FILE_NAME);
  }

  protected async load(): Promise<void> {
    this.loading = true;
    this.error = undefined;
    this.update();
    try {
      const content = await this.fileService.read(this.uri);
      this.lines = parseRawMdLines(content.value);
    } catch (error) {
      this.lines = [];
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.loading = false;
      this.update();
    }
  }

  protected onFilesChanged(event: FileChangesEvent): void {
    const path = this.uri.toString();
    const affects = event.changes.some(change => change.resource.toString() === path);
    if (affects) {
      this.scheduleRefresh();
    }
  }

  protected scheduleRefresh(): void {
    if (this.refreshHandle !== undefined) {
      clearTimeout(this.refreshHandle);
    }
    this.refreshHandle = setTimeout(() => {
      this.refreshHandle = undefined;
      void this.load();
    }, REFRESH_DEBOUNCE_MS);
  }

  /**
   * Open (or reveal) the `transcriptset.yaml` sidecar and, once resolved to a
   * `TranscriptCheckWidget`, jump it to the segment this line maps to.
   * Positional-first with a time-nearest fallback (`revealRawMdSegment`'s
   * contract) — `timeStr` is this line's own `HH:MM:SS.mmm` (undefined for a
   * foreign/edited line that lost its timestamp).
   */
  protected async revealSegment(lineIndex: number, timeStr: string | undefined): Promise<void> {
    const timeSeconds = timeStr !== undefined ? parseTimeAbsoluteToSeconds(timeStr) : undefined;
    try {
      const widget = await open(this.openerService, this.sidecarUri);
      if (widget instanceof TranscriptCheckWidget) {
        await widget.revealRawMdSegment(lineIndex, timeSeconds);
      }
    } catch (error) {
      void this.messageService.error(nls.localize(
        'ai-focused-editor/transcript/raw-md-reveal-failed',
        'Could not open the transcript segment: {0}',
        error instanceof Error ? error.message : String(error)
      ));
    }
  }

  /**
   * Regenerate `raw.md` from the current live segments — opens (WITHOUT
   * stealing focus from this viewer) the `transcriptset.yaml` sidecar and
   * calls its already-public `generateRawMdFile()`; this widget's own
   * file-watch then picks up the resulting write and re-renders.
   */
  protected async regenerate(): Promise<void> {
    try {
      const widget = await open(this.openerService, this.sidecarUri, { mode: 'open' });
      if (widget instanceof TranscriptCheckWidget) {
        await widget.generateRawMdFile();
      }
    } catch (error) {
      void this.messageService.error(nls.localize(
        'ai-focused-editor/transcript/raw-md-regenerate-failed',
        'Could not regenerate raw.md: {0}',
        error instanceof Error ? error.message : String(error)
      ));
    }
  }

  protected render(): React.ReactNode {
    if (this.loading) {
      return h(
        'div',
        { className: 'afe-raw-md-status' },
        nls.localize('ai-focused-editor/transcript/raw-md-loading', 'Loading raw.md...')
      );
    }
    if (this.error) {
      return h(
        'div',
        { className: 'afe-raw-md-status error' },
        nls.localize('ai-focused-editor/transcript/raw-md-error', 'Could not open raw.md: {0}', this.error)
      );
    }
    return h(
      'div',
      { className: 'afe-raw-md' },
      this.renderToolbar(),
      this.lines.length > 0
        ? h('div', { className: 'afe-raw-md-lines' }, this.lines.map((line, index) => this.renderLine(line, index)))
        : h(
          'div',
          { className: 'afe-raw-md-empty' },
          nls.localize('ai-focused-editor/transcript/raw-md-empty', 'raw.md is empty — generate it from the Transcript Check editor.')
        )
    );
  }

  protected renderToolbar(): React.ReactNode {
    return h(
      'div',
      { className: 'afe-raw-md-toolbar' },
      h('span', { className: 'afe-raw-md-toolbar-title' }, this.uri.path.base),
      h(
        'button',
        {
          className: 'theia-button afe-raw-md-regenerate',
          title: nls.localize(
            'ai-focused-editor/transcript/raw-md-regenerate-tooltip',
            'Regenerate raw.md from the current transcript segments'
          ),
          onClick: () => { void this.regenerate(); }
        },
        nls.localize('ai-focused-editor/transcript/raw-md-regenerate-label', 'Regenerate')
      )
    );
  }

  protected renderLine(line: RawMdParsedLine, index: number): React.ReactNode {
    return h(
      'div',
      {
        key: index,
        className: 'afe-raw-md-line',
        onClick: () => { void this.revealSegment(index, line.time); }
      },
      h('span', { className: 'afe-raw-md-line-time' }, line.time ?? ''),
      line.speakerLabel
        ? h('span', { className: 'afe-raw-md-line-speaker' }, line.speakerLabel)
        : undefined,
      h('span', { className: 'afe-raw-md-line-text' }, line.text)
    );
  }
}
