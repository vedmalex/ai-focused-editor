import URI from '@theia/core/lib/common/uri';
import { Disposable, Emitter, Event, MessageService } from '@theia/core/lib/common';
import { Navigatable, StatefulWidget } from '@theia/core/lib/browser';
import { Saveable, SaveOptions } from '@theia/core/lib/browser/saveable';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { StorageService } from '@theia/core/lib/browser/storage-service';
import { Message } from '@theia/core/shared/@lumino/messaging';
import { Widget } from '@theia/core/shared/@lumino/widgets';
import { nls } from '@theia/core/lib/common/nls';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { FileChangesEvent } from '@theia/filesystem/lib/common/files';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { QuickInputService } from '@theia/core/lib/browser/quick-input/quick-input-service';
import { inject, injectable } from '@theia/core/shared/inversify';
import React from '@theia/core/shared/react';
import WaveSurfer from 'wavesurfer.js';
import RegionsPlugin from 'wavesurfer.js/dist/plugins/regions.js';
import {
  RAW_MD_FILE_NAME,
  RawMdSourceFile,
  SegmentHistoryEntry,
  TranscriptDocument,
  TranscriptPair,
  TranscriptSegment,
  TranscriptSet,
  TranscriptSidecarProblem,
  TranscriptSpeaker,
  VALID_PLAYBACK_RATES,
  createHistoryEntry,
  computeTranscriptProgress,
  ensureSegmentIds,
  ensureSpeakerByName,
  ensureTranscriptMetadata,
  generateRawMd,
  getSegmentHistory,
  getSegmentProofread,
  getSegmentSpeakerId,
  getSegmentTranscription,
  matchTranscriptPairs,
  migrateLegacySpeakerFields,
  normalizeSpeakerLabel,
  normalizeSpeakerRegistry,
  parseTranscriptsetYaml,
  recordSegmentTextChange,
  resolveEffectiveSpeaker,
  restoreSegmentHistoryEntry,
  setSegmentProofreadResult,
  setSegmentTranscriptionResult,
  setTranscriptFileNeedsRework,
  setTranscriptFileVerified,
  speakerNameById,
  withSegmentCollection,
  writeTranscriptsetYaml
} from '../common';
import { TranscriptSpeakersService } from './transcript-speakers-service';
import { TranscriptCheckAiService } from './transcript-check-ai-service';

const h = React.createElement;

/**
 * Context key set to `true` (by `TranscriptCheckCommandContribution`) while a
 * Transcript Check widget is the shell's current widget — the `when` gate of
 * every transcript keybinding (mirror of `PROOFREADING_EDITOR_CONTEXT_KEY`).
 */
export const TRANSCRIPT_EDITOR_CONTEXT_KEY = 'afeTranscriptEditor';

/** Debounce for the folder-watch auto-refresh (mirrors ProofreadingWidget). */
const REFRESH_DEBOUNCE_MS = 300;

/** Warn (but still load) when a media file exceeds this (MAX_SINGLE_IMAGE_BYTES's audio sibling). */
const MAX_MEDIA_WARN_BYTES = 200 * 1024 * 1024;

/** Peaks resolution for the per-segment mini waveforms (source: 4096 bins). */
const PEAKS_BINS = 4096;

/** Auto-save fires only after editing has been active this long (source: 2000ms). */
const AUTO_SAVE_MIN_EDIT_MS = 2000;

/** ...and only when the user has not typed for this long (source: 1000ms). */
const AUTO_SAVE_TYPING_QUIET_MS = 1000;

/** Duration of the merge/split pulse feedback (source: 920ms). */
const OPERATION_FEEDBACK_MS = 920;

/** Waveform + region colors (the source app's "lotus" theme; readable on light & dark). */
const WAVE_COLOR = '#95a3b8';
const WAVE_PROGRESS_COLOR = '#16a34a';
const WAVE_CURSOR_COLOR = '#14532d';
const REGION_FILLED = 'rgba(34, 197, 94, 0.10)';
const REGION_ACTIVE = 'rgba(34, 197, 94, 0.24)';
const REGION_EMPTY = 'rgba(239, 68, 68, 0.24)';

/** Session-persisted view state. */
interface TranscriptViewOptions {
  showFilesPane: boolean;
  showOutlinePane: boolean;
  selectedBase?: string;
}

/** `MM:SS` clock (port of Player.jsx `formatTime`). */
export function formatTime(seconds: number): string {
  if (!seconds || !Number.isFinite(seconds)) {
    return '00:00';
  }
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins < 10 ? '0' : ''}${mins}:${secs < 10 ? '0' : ''}${secs}`;
}

/** Fraction-style rate label (`3/4x`, `1x`) — port of Player.jsx `formatRate`. */
export function formatRate(rate: number): string {
  const denominatorBase = 24;
  const numeratorBase = Math.round(rate * denominatorBase);
  const normalizedRate = numeratorBase / denominatorBase;
  if (Math.abs(rate - normalizedRate) > 0.0001) {
    return `${rate.toFixed(3).replace(/\.?0+$/, '')}x`;
  }
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const divisor = gcd(Math.abs(numeratorBase), denominatorBase);
  const numerator = numeratorBase / divisor;
  const denominator = denominatorBase / divisor;
  return denominator === 1 ? `${numerator}x` : `${numerator}/${denominator}x`;
}

/** Numeric `[start, end]` bounds of a segment, or undefined when degenerate. */
function getSegmentBounds(segment: TranscriptSegment | undefined): { start: number; end: number } | undefined {
  if (!segment) {
    return undefined;
  }
  const start = typeof segment.start === 'number' ? segment.start : parseFloat(String(segment.start ?? ''));
  const end = typeof segment.end === 'number' ? segment.end : parseFloat(String(segment.end ?? ''));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return undefined;
  }
  return { start, end };
}

/** Seek target just inside a segment (source `getSegmentSeekTime`). */
function getSegmentSeekTime(segment: TranscriptSegment | undefined, epsilon = 0.01): number {
  const bounds = getSegmentBounds(segment);
  if (!bounds) {
    return 0;
  }
  return Math.min(bounds.end, bounds.start + Math.max(0, epsilon));
}

/** Word-ratio text division for split-at-position (source `splitSegmentTextByRatio`). */
export function splitSegmentTextByRatio(textValue: unknown, ratio: number): { firstText: string; secondText: string } {
  const sourceText = typeof textValue === 'string' ? textValue : '';
  const trimmed = sourceText.trim();
  if (!trimmed) {
    return { firstText: '', secondText: '' };
  }
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length <= 1) {
    return { firstText: trimmed, secondText: '' };
  }
  const normalizedRatio = Math.max(0.05, Math.min(0.95, Number(ratio) || 0.5));
  const splitIndex = Math.max(1, Math.min(words.length, Math.round(words.length * normalizedRatio)));
  return {
    firstText: words.slice(0, splitIndex).join(' '),
    secondText: words.slice(splitIndex).join(' ')
  };
}

/** True when the segment explicitly marks a speaker turn (source `getSegmentSpeakerTurn`). */
function getSegmentSpeakerTurn(segment: TranscriptSegment | undefined): boolean {
  if (!segment || typeof segment !== 'object') {
    return false;
  }
  if (typeof segment.speakerTurn === 'boolean') {
    return segment.speakerTurn;
  }
  if (typeof segment['speaker_turn'] === 'boolean') {
    return segment['speaker_turn'] as boolean;
  }
  if (typeof segment['turn'] === 'boolean') {
    return segment['turn'] as boolean;
  }
  return false;
}

/**
 * Add registry entries (auto-named `Speaker N`) for segment `speakerId`s the
 * registry does not know (source `ensureSpeakerRegistryForSegmentIds`).
 */
function ensureSpeakerRegistryForSegmentIds(
  segments: readonly TranscriptSegment[],
  speakers: readonly TranscriptSpeaker[]
): { speakers: TranscriptSpeaker[]; changed: boolean } {
  let nextSpeakers = normalizeSpeakerRegistry(speakers);
  const knownIds = new Set(nextSpeakers.map(speaker => speaker.id));
  const knownNames = new Set(nextSpeakers.map(speaker => normalizeSpeakerLabel(speaker.name).toLowerCase()));
  let changed = false;
  let speakerCounter = nextSpeakers.length + 1;

  for (const segment of segments) {
    const speakerId = getSegmentSpeakerId(segment);
    if (!speakerId || knownIds.has(speakerId)) {
      continue;
    }
    let generatedName = `Speaker ${speakerCounter}`;
    while (knownNames.has(generatedName.toLowerCase())) {
      speakerCounter += 1;
      generatedName = `Speaker ${speakerCounter}`;
    }
    nextSpeakers = [...nextSpeakers, { id: speakerId, name: generatedName }];
    knownIds.add(speakerId);
    knownNames.add(generatedName.toLowerCase());
    speakerCounter += 1;
    changed = true;
  }
  return { speakers: nextSpeakers, changed };
}

/** Max-abs peaks over the first channel (source `buildWavePeaks`, 4096 bins). */
function buildWavePeaks(decodedData: AudioBuffer | null | undefined, bins = PEAKS_BINS): Float32Array | undefined {
  if (!decodedData || decodedData.numberOfChannels < 1) {
    return undefined;
  }
  const channelData = decodedData.getChannelData(0);
  if (!channelData || channelData.length === 0) {
    return undefined;
  }
  const peaks = new Float32Array(bins);
  const samplesPerBin = Math.max(1, Math.floor(channelData.length / bins));
  for (let i = 0; i < bins; i++) {
    const start = i * samplesPerBin;
    const end = i === bins - 1 ? channelData.length : Math.min(channelData.length, start + samplesPerBin);
    let max = 0;
    for (let j = start; j < end; j++) {
      const value = Math.abs(channelData[j]);
      if (value > max) {
        max = value;
      }
    }
    peaks[i] = max;
  }
  return peaks;
}

/** MIME type for a media path (blob typing only; playback works regardless). */
function mediaMimeForPath(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.mp3')) { return 'audio/mpeg'; }
  if (lower.endsWith('.m4a')) { return 'audio/mp4'; }
  if (lower.endsWith('.wav')) { return 'audio/wav'; }
  if (lower.endsWith('.ogg')) { return 'audio/ogg'; }
  if (lower.endsWith('.flac')) { return 'audio/flac'; }
  if (lower.endsWith('.aac')) { return 'audio/aac'; }
  if (lower.endsWith('.mp4')) { return 'video/mp4'; }
  if (lower.endsWith('.m4v')) { return 'video/x-m4v'; }
  if (lower.endsWith('.mov')) { return 'video/quicktime'; }
  if (lower.endsWith('.mkv')) { return 'video/x-matroska'; }
  if (lower.endsWith('.webm')) { return 'video/webm'; }
  if (lower.endsWith('.avi')) { return 'video/x-msvideo'; }
  return 'application/octet-stream';
}

/**
 * The Transcript Check editor over a `transcription/<set>/transcriptset.yaml`
 * sidecar — the audio_transcript_check screen rebuilt on the proofreading
 * widget's Theia discipline. LEFT = the set's media↔transcript file list;
 * CENTER = sticky player (transport, 13 playback rates, search, speakers, the
 * wavesurfer waveform) above the segment card list; RIGHT = clickable outline.
 *
 * WAVESURFER LIFECYCLE (the Monaco-host discipline): the WaveSurfer instance
 * lives in a widget-owned host node ({@link waveformHostNode}) that a React ref
 * merely re-appends — React re-renders never destroy the instance. It is
 * (re)created per media file ({@link rebuildWaveSurfer}), destroyed on file
 * switch and dispose, relaid out from Theia's {@link onResize} via
 * `setOptions({})`, and object URLs are revoked deterministically.
 *
 * Saveable: dirty on ANY transcript mutation. `save()` writes every dirty
 * `<base>.json`, the comment-preserving sidecar, and (when changed)
 * `speakers.yaml`. `raw.md` is NOT written on save — it regenerates through an
 * explicit action ({@link generateRawMdFile}) to avoid watcher churn.
 */
@injectable()
export class TranscriptCheckWidget extends ReactWidget implements Navigatable, Saveable, StatefulWidget {
  static readonly FACTORY_ID = 'ai-focused-editor.transcript-check-editor';

  @inject(FileService)
  protected readonly fileService!: FileService;

  @inject(WorkspaceService)
  protected readonly workspaceService!: WorkspaceService;

  @inject(MessageService)
  protected readonly messageService!: MessageService;

  @inject(QuickInputService)
  protected readonly quickInput!: QuickInputService;

  @inject(StorageService)
  protected readonly storageService!: StorageService;

  @inject(TranscriptSpeakersService)
  protected readonly speakersService!: TranscriptSpeakersService;

  @inject(TranscriptCheckAiService)
  protected readonly aiService!: TranscriptCheckAiService;

  protected uri!: URI;
  protected rootUri: URI | undefined;
  protected loading = true;
  protected error: string | undefined;

  protected set: TranscriptSet | undefined;
  protected problems: TranscriptSidecarProblem[] = [];
  protected pairs: TranscriptPair[] = [];
  /** Raw sidecar text kept for comment-preserving round-trips on save. */
  protected existingSidecarText: string | undefined;

  /** Selected file base (the per-URI selection unit; pairs are keyed by base). */
  protected currentBase: string | undefined;
  /** Restored (StatefulWidget) selection applied by the initial {@link load}. */
  protected pendingSelectedBase: string | undefined;

  /** In-memory transcripts keyed by base (the SoT; disk writes happen on save). */
  protected readonly transcripts = new Map<string, TranscriptDocument>();
  /** Bases whose transcript diverges from disk and must be re-written on save. */
  protected readonly dirtyBases = new Set<string>();

  // --- speakers ---
  protected speakers: TranscriptSpeaker[] = [];
  protected speakersExistingText: string | undefined;
  protected speakersDirty = false;
  /** Effective speaker carried in from the files BEFORE the current one. */
  protected inheritedSpeakerId = '';

  // --- playback (widget-owned <audio>, the source app's engine) ---
  protected audio: HTMLAudioElement | undefined;
  protected audioObjectUrl = '';
  protected audioBlob: Blob | undefined;
  protected audioDuration = 0;
  protected currentTime = 0;
  protected playbackRate = 1.0;
  protected isPlaying = false;
  /** Seek to apply once the new file's metadata is loaded. */
  protected pendingSeekTime: number | undefined;

  // --- wavesurfer ---
  /** Widget-owned, created-once DOM host the waveform lives in (Monaco-host pattern). */
  protected waveformHostNode: HTMLDivElement | undefined;
  protected waveSurfer: WaveSurfer | undefined;
  protected regionsPlugin: RegionsPlugin | undefined;
  /** Monotonic token guarding async wavesurfer/file-load races. */
  protected loadToken = 0;
  protected lastRegionSignature = '';
  /** Decoded audio kept for the mini waveforms + later WAV slicing (Phase 5). */
  protected decodedAudioBuffer: AudioBuffer | undefined;
  protected audioPeaks: Float32Array | undefined;

  // --- editing / UX state (ported from App.jsx) ---
  protected editingIndex: number | null = null;
  protected segmentEditedDuringPlayback: number | null = null;
  protected prevTimeSegmentIndex: number = -1;
  protected editingStartTime: number | null = null;
  protected editingStartTimestamp: number | null = null;
  protected lastTextChangeTimestamp: number | null = null;
  protected searchQuery = '';
  protected searchResultIndex = -1;
  protected isMergeMode = false;
  protected mergeSelection: number[] = [];
  protected splitModeSegmentIndex: number | null = null;
  protected operationFeedback: { segmentIndex: number; kind: 'merge' | 'split' } | undefined;
  protected operationFeedbackTimer: ReturnType<typeof setTimeout> | undefined;
  protected mediaSizeWarnedBases = new Set<string>();
  /** In-flight per-segment AI action (one at a time; buttons disable meanwhile). */
  protected aiRunning: { segmentIndex: number; kind: 'proofread' | 'retranscribe' } | undefined;

  // --- panes (StatefulWidget) ---
  protected showFilesPane = true;
  protected showOutlinePane = true;

  // --- DOM registries for imperative bits (scroll, canvases, search input) ---
  protected searchInputNode: HTMLInputElement | undefined;
  protected readonly segmentCardNodes = new Map<number, HTMLDivElement>();
  protected readonly segmentWaveCanvases = new Map<number, HTMLCanvasElement>();
  protected lastScrolledActiveIndex = -1;

  /** Pending folder-watch refresh timer; cleared on dispose. */
  protected refreshHandle: ReturnType<typeof setTimeout> | undefined;

  /** False during {@link load}; mutations no-op so the initial paint stays clean. */
  protected ready = false;

  // --- Saveable ---
  protected _dirty = false;
  protected readonly onDirtyChangedEmitter = new Emitter<void>();
  protected readonly onContentChangedEmitter = new Emitter<void>();
  readonly onDirtyChanged: Event<void> = this.onDirtyChangedEmitter.event;
  readonly onContentChanged: Event<void> = this.onContentChangedEmitter.event;

  get dirty(): boolean {
    return this._dirty;
  }

  configure(uri: URI): void {
    this.uri = uri;
    this.id = `${TranscriptCheckWidget.FACTORY_ID}:${uri.toString()}`;
    this.title.label = uri.parent.path.base || uri.path.base;
    this.title.caption = nls.localize('ai-focused-editor/transcript/caption', 'Transcript Check: {0}', uri.path.fsPath());
    this.title.iconClass = 'codicon codicon-mic';
    this.title.closable = true;
    this.addClass('afe-transcript-widget');
    this.node.tabIndex = 0;
    this.toDispose.push(this.onDirtyChangedEmitter);
    this.toDispose.push(this.onContentChangedEmitter);
    this.toDispose.push(this.fileService.onDidFilesChange(event => this.onFilesChanged(event)));
    this.toDispose.push(Disposable.create(() => this.teardownMedia()));
    this.toDispose.push(Disposable.create(() => {
      if (this.refreshHandle !== undefined) {
        clearTimeout(this.refreshHandle);
        this.refreshHandle = undefined;
      }
      if (this.operationFeedbackTimer !== undefined) {
        clearTimeout(this.operationFeedbackTimer);
        this.operationFeedbackTimer = undefined;
      }
    }));
    this.setupAudioElement();
    void this.load();
  }

  /** The set slug (`transcription/<slug>/transcriptset.yaml`). */
  protected get slug(): string {
    return this.uri.parent.path.base;
  }

  getResourceUri(): URI | undefined {
    return this.uri;
  }

  createMoveToUri(resourceUri: URI): URI | undefined {
    return resourceUri;
  }

  protected override onActivateRequest(msg: Message): void {
    super.onActivateRequest(msg);
    this.node.focus();
  }

  /** Theia resize → wavesurfer relayout (the documented v7 `setOptions({})` trick). */
  protected override onResize(msg: Widget.ResizeMessage): void {
    super.onResize(msg);
    try {
      this.waveSurfer?.setOptions({});
    } catch {
      // Transient while the waveform initializes — safe to ignore.
    }
  }

  protected setDirty(dirty: boolean): void {
    if (dirty !== this._dirty) {
      this._dirty = dirty;
      this.onDirtyChangedEmitter.fire();
    }
    if (dirty) {
      this.onContentChangedEmitter.fire();
    }
  }

  // --- StatefulWidget ---

  storeState(): TranscriptViewOptions {
    return {
      showFilesPane: this.showFilesPane,
      showOutlinePane: this.showOutlinePane,
      selectedBase: this.currentBase
    };
  }

  restoreState(state: object | undefined): void {
    const options = state as Partial<TranscriptViewOptions> | undefined;
    if (options && typeof options.showFilesPane === 'boolean') {
      this.showFilesPane = options.showFilesPane;
    }
    if (options && typeof options.showOutlinePane === 'boolean') {
      this.showOutlinePane = options.showOutlinePane;
    }
    if (options && typeof options.selectedBase === 'string') {
      this.pendingSelectedBase = options.selectedBase;
      // Restore may land after load() picked the first file — re-apply.
      if (this.ready && this.pendingSelectedBase !== this.currentBase
        && this.pairs.some(pair => pair.base === this.pendingSelectedBase)) {
        void this.selectFile(this.pendingSelectedBase);
      }
    }
    this.update();
  }

  // --- loading ---

  protected async resolveRootUri(): Promise<URI | undefined> {
    await this.workspaceService.ready;
    const root = this.workspaceService.tryGetRoots()[0] ?? (await this.workspaceService.roots)[0];
    return root ? new URI(root.resource.toString()) : undefined;
  }

  protected toUri(relPath: string): URI | undefined {
    return this.rootUri?.resolve(relPath);
  }

  protected async readTextIfExists(resource: URI): Promise<string | undefined> {
    try {
      return (await this.fileService.read(resource)).value;
    } catch {
      return undefined;
    }
  }

  protected async listFolderNames(relFolder: string): Promise<string[]> {
    const folderUri = this.toUri(relFolder);
    if (!folderUri) {
      return [];
    }
    try {
      const stat = await this.fileService.resolve(folderUri);
      return (stat.children ?? []).filter(child => !child.isDirectory).map(child => child.name);
    } catch {
      return [];
    }
  }

  protected async load(): Promise<void> {
    this.loading = true;
    this.ready = false;
    this.error = undefined;
    this.transcripts.clear();
    this.dirtyBases.clear();
    this.speakersDirty = false;
    this.update();
    try {
      this.rootUri = await this.resolveRootUri();
      this.existingSidecarText = await this.readTextIfExists(this.uri);
      const { set, problems } = parseTranscriptsetYaml(this.existingSidecarText ?? '');
      this.problems = problems;
      this.set = set;
      this.pairs = set && this.rootUri ? await this.resolvePairs(set) : [];
      // Speakers registry for the whole set.
      const speakersRead = await this.speakersService.read(this.uri.parent);
      this.speakers = speakersRead.speakers;
      this.speakersExistingText = speakersRead.existingText;

      const initialBase = this.pendingSelectedBase && this.pairs.some(pair => pair.base === this.pendingSelectedBase)
        ? this.pendingSelectedBase
        : this.pairs[0]?.base;
      this.currentBase = undefined;
      if (initialBase !== undefined) {
        await this.selectFile(initialBase);
      }
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.loading = false;
      this.setDirty(false);
      this.ready = true;
      this.update();
    }
  }

  protected async resolvePairs(set: TranscriptSet): Promise<TranscriptPair[]> {
    const [mediaNames, transcriptNames] = await Promise.all([
      this.listFolderNames(set.audioFolder),
      this.listFolderNames(set.transcriptFolder)
    ]);
    return matchTranscriptPairs(
      mediaNames,
      transcriptNames,
      { audioFolder: set.audioFolder, transcriptFolder: set.transcriptFolder },
      set.mediaExtensions
    );
  }

  // --- auto-refresh (folder watch) ---

  protected watchedFolderUris(): string[] {
    const set = this.set;
    if (!set) {
      return [];
    }
    const uris: string[] = [];
    for (const folder of [set.audioFolder, set.transcriptFolder]) {
      const uri = this.toUri(folder);
      if (uri) {
        uris.push(uri.toString());
      }
    }
    return uris;
  }

  protected onFilesChanged(event: FileChangesEvent): void {
    if (!this.ready || !this.set || !this.rootUri) {
      return;
    }
    const folders = this.watchedFolderUris();
    if (folders.length === 0) {
      return;
    }
    const affects = event.changes.some(change => {
      const path = change.resource.toString();
      return folders.some(folder => path === folder || path.startsWith(`${folder}/`));
    });
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
      void this.refreshPairs();
    }, REFRESH_DEBOUNCE_MS);
  }

  /**
   * Re-resolve the pairs from the current folder contents WITHOUT touching
   * dirty state: unsaved transcripts (keyed by base) survive, the selection is
   * preserved by base where it still exists (proofreading `refreshPairs`).
   */
  async refreshPairs(): Promise<void> {
    if (!this.set || !this.rootUri) {
      return;
    }
    const previousBase = this.currentBase;
    this.pairs = await this.resolvePairs(this.set);
    if (previousBase !== undefined && this.pairs.some(pair => pair.base === previousBase)) {
      // A clean current transcript may have changed on disk — re-read it.
      if (!this.dirtyBases.has(previousBase)) {
        const pair = this.pairs.find(candidate => candidate.base === previousBase)!;
        const document = await this.readTranscriptFromDisk(pair);
        if (document) {
          this.transcripts.set(previousBase, document);
        }
      }
      this.update();
      return;
    }
    const fallback = this.pairs[0]?.base;
    if (fallback !== undefined) {
      await this.selectFile(fallback);
    } else {
      this.currentBase = undefined;
      this.teardownWaveSurfer();
      this.update();
    }
  }

  // --- transcripts ---

  protected get currentPair(): TranscriptPair | undefined {
    return this.pairs.find(pair => pair.base === this.currentBase);
  }

  protected get currentTranscript(): TranscriptDocument | undefined {
    return this.currentBase !== undefined ? this.transcripts.get(this.currentBase) : undefined;
  }

  protected get segments(): TranscriptSegment[] {
    return this.currentTranscript?.segments ?? [];
  }

  /**
   * Read + normalize one transcript from disk (segment ids, `_transcriber`
   * metadata, legacy speaker-field migration). Normalization stays IN MEMORY —
   * nothing is auto-written on open (Saveable discipline; the source app
   * auto-saved instead). Registry additions mark {@link speakersDirty} so the
   * next explicit save persists them.
   */
  protected async readTranscriptFromDisk(pair: TranscriptPair): Promise<TranscriptDocument | undefined> {
    if (pair.missing) {
      return undefined;
    }
    const uri = this.toUri(pair.transcriptRelPath);
    const text = uri ? await this.readTextIfExists(uri) : undefined;
    if (text === undefined) {
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return undefined;
    }
    const document = parsed && typeof parsed === 'object' ? parsed as TranscriptDocument : { segments: [] };
    const rawSegments = Array.isArray(document.segments) ? document.segments : [];
    const migrated = migrateLegacySpeakerFields(rawSegments, this.speakers);
    if (migrated.speakersChanged) {
      this.speakers = migrated.speakers;
      this.speakersDirty = true;
    }
    const ensuredIds = ensureSpeakerRegistryForSegmentIds(migrated.segments, this.speakers);
    if (ensuredIds.changed) {
      this.speakers = ensuredIds.speakers;
      this.speakersDirty = true;
    }
    const withIds = ensureSegmentIds(migrated.segments);
    const { transcript } = ensureTranscriptMetadata({ ...document, segments: withIds });
    return transcript;
  }

  /** Effective-speaker carry across files BEFORE `base` (source `resolveInheritedSpeakerFromPreviousFiles`). */
  protected async resolveInheritedSpeaker(base: string): Promise<string> {
    let carried = '';
    for (const pair of this.pairs) {
      if (pair.base === base) {
        break;
      }
      let document = this.transcripts.get(pair.base);
      if (!document) {
        document = await this.readTranscriptFromDisk(pair);
        if (document) {
          this.transcripts.set(pair.base, document);
        }
      }
      if (!document) {
        continue;
      }
      carried = resolveEffectiveSpeaker(document.segments, carried).lastSpeakerId;
    }
    return carried;
  }

  // --- playback rate/position persistence (StorageService) ---

  protected storageKey(kind: 'pos' | 'rate', mediaRelPath: string): string {
    return `afe-transcript:${kind}:${mediaRelPath}`;
  }

  protected persistPlaybackState(): void {
    const pair = this.currentPair;
    if (!pair?.mediaRelPath) {
      return;
    }
    void this.storageService.setData(this.storageKey('pos', pair.mediaRelPath), this.currentTime);
    void this.storageService.setData(this.storageKey('rate', pair.mediaRelPath), this.playbackRate);
  }

  // --- file selection ---

  async selectFile(base: string, autoPlay = false): Promise<void> {
    if (!this.pairs.some(pair => pair.base === base)) {
      return;
    }
    const token = ++this.loadToken;
    // Save progress + rate of the previous file.
    this.persistPlaybackState();

    // Reset per-file state (source `selectFile` clears everything first).
    this.setPlaying(false);
    this.editingIndex = null;
    this.segmentEditedDuringPlayback = null;
    this.prevTimeSegmentIndex = -1;
    this.editingStartTime = null;
    this.editingStartTimestamp = null;
    this.lastTextChangeTimestamp = null;
    this.searchQuery = '';
    this.searchResultIndex = -1;
    this.isMergeMode = false;
    this.mergeSelection = [];
    this.splitModeSegmentIndex = null;
    this.operationFeedback = undefined;
    this.aiRunning = undefined;
    this.currentTime = 0;
    this.audioDuration = 0;
    this.audioPeaks = undefined;
    this.decodedAudioBuffer = undefined;
    this.lastScrolledActiveIndex = -1;
    this.currentBase = base;
    this.update();

    const pair = this.pairs.find(candidate => candidate.base === base);
    if (!pair) {
      return;
    }

    // Transcript: keep unsaved in-memory edits; (re)read clean files from disk.
    if (!this.transcripts.has(base) || !this.dirtyBases.has(base)) {
      const document = await this.readTranscriptFromDisk(pair);
      if (token !== this.loadToken) {
        return;
      }
      if (document) {
        this.transcripts.set(base, document);
      } else if (!this.dirtyBases.has(base)) {
        this.transcripts.set(base, ensureTranscriptMetadata({ segments: [] }).transcript);
      }
    }

    this.inheritedSpeakerId = await this.resolveInheritedSpeaker(base);
    if (token !== this.loadToken) {
      return;
    }

    // Media over FileService (browser+electron safe): bytes -> Blob -> object URL.
    this.teardownWaveSurfer();
    this.audioBlob = undefined;
    if (pair.mediaRelPath) {
      const mediaUri = this.toUri(pair.mediaRelPath);
      if (mediaUri) {
        try {
          const stat = await this.fileService.resolve(mediaUri, { resolveMetadata: true });
          if (stat.size > MAX_MEDIA_WARN_BYTES && !this.mediaSizeWarnedBases.has(base)) {
            this.mediaSizeWarnedBases.add(base);
            void this.messageService.warn(nls.localize(
              'ai-focused-editor/transcript/media-too-large',
              'The media file "{0}" is very large ({1} MB) — loading and waveform decoding may be slow.',
              pair.mediaRelPath,
              Math.round(stat.size / (1024 * 1024))
            ));
          }
          const content = await this.fileService.readFile(mediaUri);
          if (token !== this.loadToken) {
            return;
          }
          const bytes = content.value.buffer;
          const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
          this.audioBlob = new Blob([copy], { type: mediaMimeForPath(pair.mediaRelPath) });
        } catch {
          this.audioBlob = undefined;
        }
      }
    }

    // Restore per-media playback position + rate.
    let savedTime = 0;
    let savedRate = 1.0;
    if (pair.mediaRelPath) {
      savedTime = (await this.storageService.getData<number>(this.storageKey('pos', pair.mediaRelPath))) ?? 0;
      savedRate = (await this.storageService.getData<number>(this.storageKey('rate', pair.mediaRelPath))) ?? 1.0;
    }
    if (token !== this.loadToken) {
      return;
    }
    this.playbackRate = this.normalizeRate(savedRate);
    this.pendingSeekTime = Number.isFinite(savedTime) && savedTime > 0 ? savedTime : undefined;

    this.applyAudioSource();
    this.rebuildWaveSurfer();
    if (autoPlay) {
      this.setPlaying(true);
    }
    this.update();
  }

  protected normalizeRate(rate: number): number {
    const value = typeof rate === 'number' && Number.isFinite(rate) ? rate : 1.0;
    if (VALID_PLAYBACK_RATES.includes(value)) {
      return value;
    }
    return VALID_PLAYBACK_RATES.reduce(
      (prev, curr) => (Math.abs(curr - value) < Math.abs(prev - value) ? curr : prev),
      1.0
    );
  }

  // --- audio element (playback engine) ---

  protected setupAudioElement(): void {
    const audio = new Audio();
    audio.preload = 'auto';
    audio.addEventListener('timeupdate', this.handleTimeUpdate);
    audio.addEventListener('loadedmetadata', this.handleLoadedMetadata);
    audio.addEventListener('ended', this.handleEnded);
    audio.addEventListener('play', this.handleAudioPlay);
    audio.addEventListener('pause', this.handleAudioPause);
    this.audio = audio;
  }

  protected teardownMedia(): void {
    this.persistPlaybackState();
    this.teardownWaveSurfer();
    const audio = this.audio;
    if (audio) {
      audio.pause();
      audio.removeEventListener('timeupdate', this.handleTimeUpdate);
      audio.removeEventListener('loadedmetadata', this.handleLoadedMetadata);
      audio.removeEventListener('ended', this.handleEnded);
      audio.removeEventListener('play', this.handleAudioPlay);
      audio.removeEventListener('pause', this.handleAudioPause);
      audio.removeAttribute('src');
      audio.load();
    }
    this.revokeAudioObjectUrl();
    this.audio = undefined;
    this.audioBlob = undefined;
    this.decodedAudioBuffer = undefined;
    this.audioPeaks = undefined;
  }

  protected revokeAudioObjectUrl(): void {
    if (this.audioObjectUrl) {
      URL.revokeObjectURL(this.audioObjectUrl);
      this.audioObjectUrl = '';
    }
  }

  /** Point the `<audio>` element at the freshly-loaded blob (revoking the old URL). */
  protected applyAudioSource(): void {
    const audio = this.audio;
    if (!audio) {
      return;
    }
    this.revokeAudioObjectUrl();
    if (this.audioBlob) {
      this.audioObjectUrl = URL.createObjectURL(this.audioBlob);
      audio.src = this.audioObjectUrl;
      audio.load();
    } else {
      audio.removeAttribute('src');
      audio.load();
    }
  }

  protected readonly handleLoadedMetadata = (): void => {
    const audio = this.audio;
    if (!audio) {
      return;
    }
    audio.playbackRate = this.playbackRate;
    if (this.pendingSeekTime !== undefined) {
      const target = Math.min(this.pendingSeekTime, audio.duration || this.pendingSeekTime);
      this.pendingSeekTime = undefined;
      audio.currentTime = target;
      this.currentTime = target;
    }
    if (!this.audioDuration && Number.isFinite(audio.duration)) {
      this.audioDuration = audio.duration;
    }
    this.update();
  };

  protected readonly handleEnded = (): void => {
    const index = this.pairs.findIndex(pair => pair.base === this.currentBase);
    const next = this.pairs[index + 1];
    if (next) {
      void this.selectFile(next.base, true);
    } else {
      this.setPlaying(false);
    }
  };

  protected readonly handleAudioPlay = (): void => {
    if (!this.isPlaying) {
      this.isPlaying = true;
      this.update();
    }
  };

  protected readonly handleAudioPause = (): void => {
    if (this.isPlaying) {
      this.isPlaying = false;
      this.update();
    }
  };

  /**
   * The per-tick heart of the ported playback UX: sync time into the waveform,
   * auto-save when playback leaves an actively-edited segment (with the
   * source's 2s/1s debounce), replay-once a segment that was edited during
   * playback, and loop back into the editing segment while editing.
   */
  protected readonly handleTimeUpdate = (): void => {
    const audio = this.audio;
    if (!audio) {
      return;
    }
    this.currentTime = audio.currentTime;
    try {
      this.waveSurfer?.setTime(this.currentTime);
    } catch {
      // Waveform may still be initializing.
    }

    const segments = this.segments;
    const timeIndex = segments.findIndex(seg => this.currentTime >= seg.start && this.currentTime <= seg.end);
    const prevIndex = this.prevTimeSegmentIndex;
    this.prevTimeSegmentIndex = timeIndex;

    // Auto-save: playback moved to a different segment while editing.
    if (this.editingIndex !== null && timeIndex !== -1 && timeIndex !== this.editingIndex) {
      const sinceEditStart = this.editingStartTimestamp ? Date.now() - this.editingStartTimestamp : Infinity;
      const sinceLastType = this.lastTextChangeTimestamp ? Date.now() - this.lastTextChangeTimestamp : Infinity;
      if (sinceEditStart > AUTO_SAVE_MIN_EDIT_MS && sinceLastType > AUTO_SAVE_TYPING_QUIET_MS) {
        this.finishEditing('auto');
      }
    }

    // Replay-once: a segment edited during playback ends -> replay it once.
    if (
      prevIndex !== -1 &&
      timeIndex !== prevIndex &&
      this.segmentEditedDuringPlayback === prevIndex &&
      this.editingIndex === null &&
      this.isPlaying
    ) {
      const seg = segments[prevIndex];
      if (seg && audio) {
        audio.currentTime = seg.start;
        this.currentTime = seg.start;
        this.segmentEditedDuringPlayback = null;
      }
    } else if (
      prevIndex !== -1 &&
      timeIndex !== prevIndex &&
      this.segmentEditedDuringPlayback !== null &&
      this.segmentEditedDuringPlayback !== prevIndex
    ) {
      // Listened through a different segment — clear the stale flag.
      this.segmentEditedDuringPlayback = null;
    }

    // Loop-back while editing: keep playback inside the editing segment.
    if (this.editingIndex !== null && timeIndex !== this.editingIndex && this.isPlaying) {
      const editingSeg = segments[this.editingIndex];
      if (editingSeg && audio) {
        audio.currentTime = editingSeg.start;
        this.currentTime = editingSeg.start;
      }
    }

    this.update();
    this.scrollToActiveSegment(timeIndex);
  };

  protected scrollToActiveSegment(timeIndex: number): void {
    if (this.editingIndex !== null || timeIndex === -1 || timeIndex === this.lastScrolledActiveIndex) {
      return;
    }
    this.lastScrolledActiveIndex = timeIndex;
    const node = this.segmentCardNodes.get(timeIndex);
    node?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  // --- playback controls (public: dispatched from the keybinding commands) ---

  setPlaying(playing: boolean): void {
    const audio = this.audio;
    this.isPlaying = playing;
    if (audio) {
      if (playing) {
        void audio.play().catch(() => { /* autoplay policy */ });
      } else {
        audio.pause();
      }
    }
    this.update();
  }

  togglePlayPause(): void {
    this.setPlaying(!this.isPlaying);
  }

  skipTime(seconds: number): void {
    const audio = this.audio;
    if (audio) {
      audio.currentTime = Math.max(0, audio.currentTime + seconds);
      this.currentTime = audio.currentTime;
      this.update();
    }
  }

  setRate(rate: number): void {
    this.playbackRate = this.normalizeRate(rate);
    if (this.audio) {
      this.audio.playbackRate = this.playbackRate;
    }
    this.persistPlaybackState();
    this.update();
  }

  /** Up/Down rate stepping over the 13 valid rates (source arrow handling). */
  stepRate(direction: 1 | -1): void {
    let index = VALID_PLAYBACK_RATES.findIndex(rate => Math.abs(rate - this.playbackRate) < 0.01);
    if (index === -1) {
      index = VALID_PLAYBACK_RATES.findIndex(rate => rate > this.playbackRate);
      index = direction > 0 ? Math.max(0, index - 1) : (index === -1 ? VALID_PLAYBACK_RATES.length - 1 : index);
    }
    const next = index + direction;
    if (next >= 0 && next < VALID_PLAYBACK_RATES.length) {
      this.setRate(VALID_PLAYBACK_RATES[next]);
    }
  }

  protected seekTo(seconds: number): void {
    const audio = this.audio;
    if (audio) {
      audio.currentTime = seconds;
    }
    this.currentTime = seconds;
    try {
      this.waveSurfer?.setTime(seconds);
    } catch { /* initializing */ }
    this.update();
  }

  // --- segment navigation ---

  protected get timeBasedActiveSegmentIndex(): number {
    return this.segments.findIndex(seg => this.currentTime >= seg.start && this.currentTime <= seg.end);
  }

  protected get activeSegmentIndex(): number {
    return this.editingIndex !== null ? this.editingIndex : this.timeBasedActiveSegmentIndex;
  }

  protected get emptySegmentIndices(): number[] {
    const result: number[] = [];
    this.segments.forEach((seg, idx) => {
      if (!seg.text || !seg.text.trim()) {
        result.push(idx);
      }
    });
    return result;
  }

  jumpToSegmentIndex(segmentIndex: number, options: { seekInside?: boolean } = {}): void {
    const seg = this.segments[segmentIndex];
    if (!seg) {
      return;
    }
    const seekTime = options.seekInside ? getSegmentSeekTime(seg, 0.01) : (Number(seg.start) || 0);
    this.editingIndex = null;
    this.lastScrolledActiveIndex = -1;
    this.seekTo(seekTime);
    this.scrollToActiveSegment(segmentIndex);
  }

  /** Base index the navigation starts from when between segments (source logic). */
  protected navigationBaseIndex(): number {
    const active = this.activeSegmentIndex;
    if (active !== -1) {
      return active;
    }
    const now = this.audio?.currentTime ?? 0;
    let nearest = -1;
    for (let i = 0; i < this.segments.length; i++) {
      if (this.segments[i].start <= now) {
        nearest = i;
      } else {
        break;
      }
    }
    return nearest;
  }

  navigateSegment(direction: 1 | -1): void {
    if (this.segments.length === 0) {
      return;
    }
    let next = this.navigationBaseIndex() + direction;
    next = Math.max(0, Math.min(this.segments.length - 1, next));
    this.jumpToSegmentIndex(next);
  }

  navigateEmptySegment(direction: 1 | -1): void {
    const empty = this.emptySegmentIndices;
    if (empty.length === 0) {
      return;
    }
    const base = this.navigationBaseIndex();
    let target = -1;
    if (direction > 0) {
      target = empty.find(idx => idx > base) ?? empty[0];
    } else {
      for (let i = empty.length - 1; i >= 0; i--) {
        if (empty[i] < base) {
          target = empty[i];
          break;
        }
      }
      if (target === -1) {
        target = empty[empty.length - 1];
      }
    }
    if (target !== -1) {
      this.jumpToSegmentIndex(target);
    }
  }

  navigateFile(direction: 1 | -1): void {
    const index = this.pairs.findIndex(pair => pair.base === this.currentBase);
    const next = this.pairs[index + direction];
    if (next) {
      void this.selectFile(next.base);
    }
  }

  // --- search ---

  protected get searchTerms(): string[] {
    return this.searchQuery.trim().toLowerCase().split(/\s+/).filter(Boolean);
  }

  protected get searchMatches(): number[] {
    const terms = this.searchTerms;
    if (terms.length === 0) {
      return [];
    }
    const matches: number[] = [];
    this.segments.forEach((seg, idx) => {
      const text = (seg.text || '').toLowerCase();
      if (text && terms.every(term => text.includes(term))) {
        matches.push(idx);
      }
    });
    return matches;
  }

  focusSearch(): void {
    this.searchInputNode?.focus();
    this.searchInputNode?.select();
  }

  protected jumpToSearchResult(targetResultIndex: number): void {
    const matches = this.searchMatches;
    if (matches.length === 0) {
      return;
    }
    const normalized = ((targetResultIndex % matches.length) + matches.length) % matches.length;
    this.searchResultIndex = normalized;
    this.jumpToSegmentIndex(matches[normalized], { seekInside: true });
  }

  goToNextSearchResult(): void {
    const matches = this.searchMatches;
    if (matches.length === 0) {
      return;
    }
    this.jumpToSearchResult(this.searchResultIndex < 0 ? 0 : (this.searchResultIndex + 1) % matches.length);
  }

  goToPrevSearchResult(): void {
    const matches = this.searchMatches;
    if (matches.length === 0) {
      return;
    }
    this.jumpToSearchResult(this.searchResultIndex < 0
      ? matches.length - 1
      : (this.searchResultIndex - 1 + matches.length) % matches.length);
  }

  // --- editing ---

  /** True when plain-key shortcuts (Space/arrows/Enter) may act (source guard). */
  canHandlePlainKeys(): boolean {
    return this.editingIndex === null;
  }

  protected mutateTranscript(mutator: (document: TranscriptDocument) => TranscriptDocument | undefined): void {
    const base = this.currentBase;
    if (base === undefined || !this.ready) {
      return;
    }
    const document = this.transcripts.get(base);
    if (!document) {
      return;
    }
    const next = mutator(document);
    if (!next || next === document) {
      return;
    }
    this.transcripts.set(base, next);
    this.dirtyBases.add(base);
    this.setDirty(true);
    this.update();
  }

  startEditingSegment(index: number): void {
    const seg = this.segments[index];
    if (!seg) {
      return;
    }
    const isActiveSegment = index === this.activeSegmentIndex;
    this.editingStartTimestamp = Date.now();
    const audio = this.audio;
    if (audio) {
      if (isActiveSegment) {
        this.editingStartTime = audio.currentTime;
      } else {
        audio.currentTime = seg.start;
        this.currentTime = seg.start;
        this.editingStartTime = seg.start;
      }
    }
    // Pause when entering editing, unless playback is slowed below 1x.
    if (this.playbackRate >= 1.0) {
      this.setPlaying(false);
    }
    this.editingIndex = index;
    this.update();
  }

  /** Enter (no shift) from the global key layer: edit the active segment. */
  editActiveSegment(): void {
    const index = this.timeBasedActiveSegmentIndex;
    if (index === -1) {
      return;
    }
    const audio = this.audio;
    if (!this.segments[index] || !audio) {
      return;
    }
    this.editingStartTimestamp = Date.now();
    this.editingStartTime = audio.currentTime;
    if (this.playbackRate >= 1.0) {
      this.setPlaying(false);
    }
    this.editingIndex = index;
    this.update();
  }

  /** Click: merge-select in merge mode; select+play on first click; edit on second. */
  protected handleSegmentClick(index: number): void {
    if (this.isMergeMode) {
      this.toggleMergeSelection(index);
      return;
    }
    const seg = this.segments[index];
    if (!seg) {
      return;
    }
    if (index === this.activeSegmentIndex) {
      this.startEditingSegment(index);
      return;
    }
    this.seekTo(seg.start);
    this.setPlaying(true);
  }

  protected handleSegmentDoubleClick(index: number): void {
    if (this.isMergeMode) {
      return;
    }
    this.startEditingSegment(index);
  }

  protected handleTextChange(index: number, nextText: string): void {
    this.mutateTranscript(document => {
      if (!document.segments[index]) {
        return undefined;
      }
      const segments = [...document.segments];
      segments[index] = { ...segments[index], text: nextText };
      return { ...document, segments };
    });
    this.lastTextChangeTimestamp = Date.now();
  }

  /**
   * Finish the current segment edit: record a capped history entry
   * (`manual-save`), restore the playback position, arm the replay-once flag,
   * and (manual only) resume playback if it was running (source `saveChanges`
   * / the auto-save path). Disk writes stay deferred to {@link save}.
   */
  protected finishEditing(kind: 'manual' | 'auto'): void {
    const editingIdx = this.editingIndex;
    const base = this.currentBase;
    if (editingIdx === null || base === undefined) {
      return;
    }
    const audio = this.audio;
    const wasPlaying = !!audio && !audio.paused;
    const note = kind === 'manual' ? 'Saved from segment editor' : 'Auto-saved after leaving segment';
    this.mutateTranscript(document => recordSegmentTextChange(
      document,
      editingIdx,
      document.segments[editingIdx]?.text || '',
      { source: 'manual-save', note }
    ));

    if (kind === 'manual') {
      const seg = this.segments[editingIdx];
      const wasActiveSegment = editingIdx === this.timeBasedActiveSegmentIndex;
      if (seg && audio) {
        if (wasActiveSegment && this.editingStartTime !== null) {
          audio.currentTime = this.editingStartTime;
          this.currentTime = this.editingStartTime;
        } else {
          audio.currentTime = seg.start;
          this.currentTime = seg.start;
        }
      }
      this.segmentEditedDuringPlayback = editingIdx;
    }

    this.editingIndex = null;
    this.editingStartTime = null;
    this.editingStartTimestamp = null;
    this.lastTextChangeTimestamp = null;

    if (kind === 'manual' && wasPlaying) {
      this.setPlaying(true);
    }
    this.update();
  }

  /** Escape: leave editing (text kept in memory), exit merge mode, clear search. */
  handleEscape(): void {
    if (this.editingIndex !== null) {
      this.editingIndex = null;
      this.editingStartTime = null;
      this.editingStartTimestamp = null;
      this.splitModeSegmentIndex = null;
      this.update();
      return;
    }
    if (this.isMergeMode) {
      this.isMergeMode = false;
      this.mergeSelection = [];
      this.update();
      return;
    }
    if (this.searchQuery) {
      this.searchQuery = '';
      this.searchResultIndex = -1;
      this.update();
    }
  }

  /** Textarea key handling (local, the source `handleKeyDownInEdit` + Escape). */
  protected handleEditKeyDown(event: React.KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.finishEditing('manual');
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.handleEscape();
    }
  }

  // --- split / merge ---

  protected triggerOperationFeedback(segmentIndex: number, kind: 'merge' | 'split'): void {
    if (this.operationFeedbackTimer !== undefined) {
      clearTimeout(this.operationFeedbackTimer);
      this.operationFeedbackTimer = undefined;
    }
    this.operationFeedback = undefined;
    requestAnimationFrame(() => {
      this.operationFeedback = { segmentIndex, kind };
      this.update();
      this.operationFeedbackTimer = setTimeout(() => {
        this.operationFeedback = undefined;
        this.operationFeedbackTimer = undefined;
        this.update();
      }, OPERATION_FEEDBACK_MS);
    });
  }

  protected focusAndPlaySegment(segment: TranscriptSegment): void {
    const bounds = getSegmentBounds(segment);
    if (!bounds) {
      return;
    }
    this.editingIndex = null;
    this.seekTo(bounds.start);
    this.setPlaying(true);
  }

  beginSplitMode(segmentIndex: number): void {
    this.splitModeSegmentIndex = segmentIndex;
    this.editingIndex = segmentIndex;
    const seg = this.segments[segmentIndex];
    const bounds = getSegmentBounds(seg);
    if (!bounds) {
      return;
    }
    if (this.currentTime < bounds.start || this.currentTime > bounds.end) {
      this.seekTo(bounds.start);
    }
    this.update();
  }

  cancelSplitMode(): void {
    this.splitModeSegmentIndex = null;
    this.update();
  }

  applySplitMode(): void {
    if (this.splitModeSegmentIndex === null) {
      return;
    }
    if (this.splitSegmentByAudio(this.splitModeSegmentIndex)) {
      this.splitModeSegmentIndex = null;
      this.update();
    }
  }

  /** Split at the playback position with word-ratio text division (source port). */
  protected splitSegmentByAudio(segmentIndex: number): boolean {
    const minDuration = 0.12;
    const document = this.currentTranscript;
    const sourceSegment = document?.segments?.[segmentIndex];
    if (!document || !sourceSegment) {
      return false;
    }
    const bounds = getSegmentBounds(sourceSegment);
    if (!bounds) {
      return false;
    }
    const duration = bounds.end - bounds.start;
    if (duration <= minDuration * 2) {
      return false;
    }
    const inSegmentNow = this.currentTime > bounds.start + minDuration && this.currentTime < bounds.end - minDuration;
    const splitAt = inSegmentNow ? this.currentTime : bounds.start + duration / 2;
    if (splitAt <= bounds.start + minDuration || splitAt >= bounds.end - minDuration) {
      return false;
    }
    const ratio = (splitAt - bounds.start) / duration;
    const { firstText, secondText } = splitSegmentTextByRatio(sourceSegment.text, ratio);

    const firstSegment: TranscriptSegment = { ...sourceSegment, end: splitAt, text: firstText, _id: crypto.randomUUID() };
    const secondSegment: TranscriptSegment = { ...sourceSegment, start: splitAt, text: secondText, _id: crypto.randomUUID() };
    delete secondSegment.speakerTurn;
    delete secondSegment['speaker_turn'];
    delete secondSegment['turn'];

    const nextSegments = [...document.segments];
    nextSegments.splice(segmentIndex, 1, firstSegment, secondSegment);
    const sourceHistory = getSegmentHistory(document, sourceSegment._id);
    const baseHistory: SegmentHistoryEntry[] = sourceHistory.length > 0
      ? sourceHistory
      : [createHistoryEntry(sourceSegment.text || '', 'initial')];
    this.mutateTranscript(current => withSegmentCollection(current, nextSegments, {
      historyEntriesBySegmentId: {
        [firstSegment._id!]: [...baseHistory, createHistoryEntry(firstText, 'split', { note: `Split from segment ${segmentIndex + 1}` })],
        [secondSegment._id!]: [...baseHistory, createHistoryEntry(secondText, 'split', { note: `Split from segment ${segmentIndex + 1}` })]
      }
    }));
    this.editingIndex = null;
    this.focusAndPlaySegment(firstSegment);
    this.triggerOperationFeedback(segmentIndex, 'split');
    this.lastTextChangeTimestamp = Date.now();
    return true;
  }

  toggleMergeMode(): void {
    this.isMergeMode = !this.isMergeMode;
    if (!this.isMergeMode) {
      this.mergeSelection = [];
    }
    this.splitModeSegmentIndex = null;
    this.editingIndex = null;
    this.update();
  }

  protected toggleMergeSelection(segmentIndex: number): void {
    if (!this.isMergeMode) {
      return;
    }
    const next = this.mergeSelection.includes(segmentIndex)
      ? this.mergeSelection.filter(index => index !== segmentIndex)
      : [...this.mergeSelection, segmentIndex];
    this.mergeSelection = next.sort((a, b) => a - b);
    this.update();
  }

  protected get mergeSelectionIsContiguous(): boolean {
    if (this.mergeSelection.length < 2) {
      return false;
    }
    const sorted = [...this.mergeSelection].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] !== sorted[i - 1] + 1) {
        return false;
      }
    }
    return true;
  }

  applyMergeSelection(): void {
    const document = this.currentTranscript;
    if (this.mergeSelection.length < 2 || !this.mergeSelectionIsContiguous || !document?.segments?.length) {
      return;
    }
    const sorted = [...this.mergeSelection].sort((a, b) => a - b);
    const startIndex = sorted[0];
    const endIndex = sorted[sorted.length - 1];
    if (endIndex >= document.segments.length) {
      return;
    }
    const selectedSegments = document.segments.slice(startIndex, endIndex + 1);
    if (selectedSegments.length < 2) {
      return;
    }
    const first = selectedSegments[0];
    const firstBounds = getSegmentBounds(first);
    const lastBounds = getSegmentBounds(selectedSegments[selectedSegments.length - 1]);
    if (!firstBounds || !lastBounds) {
      return;
    }
    const mergedText = selectedSegments
      .map(segment => (typeof segment.text === 'string' ? segment.text.trim() : ''))
      .filter(Boolean)
      .join(' ')
      .trim();
    const mergedSpeaker = selectedSegments.map(segment => getSegmentSpeakerId(segment)).find(Boolean) || '';
    const merged: TranscriptSegment = {
      ...first,
      start: firstBounds.start,
      end: lastBounds.end,
      text: mergedText,
      _id: crypto.randomUUID()
    };
    if (mergedSpeaker) {
      merged.speakerId = mergedSpeaker;
    }
    const nextSegments = [...document.segments];
    nextSegments.splice(startIndex, selectedSegments.length, merged);
    const mergedBaseHistory = getSegmentHistory(document, first._id);
    this.mutateTranscript(current => withSegmentCollection(current, nextSegments, {
      historyEntriesBySegmentId: {
        [merged._id!]: [
          ...(mergedBaseHistory.length > 0 ? mergedBaseHistory : [createHistoryEntry(first.text || '', 'initial')]),
          createHistoryEntry(mergedText, 'merge', { note: `Merged segments ${startIndex + 1}-${endIndex + 1}` })
        ]
      }
    }));
    this.focusAndPlaySegment(merged);
    this.triggerOperationFeedback(startIndex, 'merge');
    this.mergeSelection = [];
    this.isMergeMode = false;
    this.lastTextChangeTimestamp = Date.now();
  }

  // --- speakers ---

  protected updateSegmentSpeaker(segmentIndex: number, speakerId: string): void {
    const normalized = String(speakerId || '').trim();
    this.mutateTranscript(document => {
      if (!document.segments[segmentIndex]) {
        return undefined;
      }
      const segments = [...document.segments];
      const next: TranscriptSegment = { ...segments[segmentIndex] };
      if (normalized) {
        next.speakerId = normalized;
      } else {
        delete next.speakerId;
      }
      delete next['speaker_id'];
      delete next['speaker'];
      delete next['speakerLabel'];
      delete next['author'];
      segments[segmentIndex] = next;
      return { ...document, segments };
    });
    this.lastTextChangeTimestamp = Date.now();
  }

  protected updateSegmentSpeakerTurn(segmentIndex: number, hasTurnChange: boolean): void {
    this.mutateTranscript(document => {
      if (!document.segments[segmentIndex]) {
        return undefined;
      }
      const segments = [...document.segments];
      const next: TranscriptSegment = { ...segments[segmentIndex] };
      if (hasTurnChange) {
        next.speakerTurn = true;
      } else {
        delete next.speakerTurn;
      }
      segments[segmentIndex] = next;
      return { ...document, segments };
    });
    this.lastTextChangeTimestamp = Date.now();
  }

  /** SpeakerDialog "create" — a QuickInput single-field modal. */
  protected async openCreateSpeakerDialog(): Promise<void> {
    const value = await this.quickInput.input({
      prompt: nls.localize('ai-focused-editor/transcript/speaker-new-prompt', 'New speaker name'),
      placeHolder: nls.localize('ai-focused-editor/transcript/speaker-placeholder', 'Speaker name')
    });
    const name = normalizeSpeakerLabel(value);
    if (!name) {
      return;
    }
    const ensured = ensureSpeakerByName(this.speakers, name);
    this.speakers = ensured.speakers;
    if (ensured.changed) {
      this.speakersDirty = true;
      this.setDirty(true);
    }
    this.update();
  }

  /** SpeakerDialog "rename". */
  protected async openRenameSpeakerDialog(speakerId: string): Promise<void> {
    const current = this.speakers.find(speaker => speaker.id === speakerId);
    if (!current) {
      return;
    }
    const value = await this.quickInput.input({
      prompt: nls.localize('ai-focused-editor/transcript/speaker-rename-prompt', 'Rename speaker (ID: {0})', speakerId),
      value: current.name
    });
    const name = normalizeSpeakerLabel(value);
    if (!name || name === current.name) {
      return;
    }
    const duplicate = this.speakers.find(speaker => speaker.id !== speakerId
      && normalizeSpeakerLabel(speaker.name).toLowerCase() === name.toLowerCase());
    if (duplicate) {
      void this.messageService.warn(nls.localize(
        'ai-focused-editor/transcript/speaker-duplicate',
        'A speaker named "{0}" already exists.',
        name
      ));
      return;
    }
    this.speakers = this.speakers.map(speaker => (speaker.id === speakerId ? { ...speaker, name } : speaker));
    this.speakersDirty = true;
    this.setDirty(true);
    this.update();
  }

  // --- verified / needs-rework toggles (sidecar) ---

  protected isVerified(base: string): boolean {
    return this.set?.files.find(file => file.base === base)?.verified === true;
  }

  protected needsRework(base: string): boolean {
    return this.set?.files.find(file => file.base === base)?.needsRework === true;
  }

  toggleVerified(): void {
    const base = this.currentBase;
    if (!this.ready || !this.set || base === undefined) {
      return;
    }
    this.set = setTranscriptFileVerified(this.set, base, !this.isVerified(base));
    this.setDirty(true);
    this.update();
  }

  toggleNeedsRework(): void {
    const base = this.currentBase;
    if (!this.ready || !this.set || base === undefined) {
      return;
    }
    this.set = setTranscriptFileNeedsRework(this.set, base, !this.needsRework(base));
    this.setDirty(true);
    this.update();
  }

  // --- AI actions (Phase 4 proofread / Phase 5 STT re-recognition) ---

  protected async runProofreadForSegment(segmentIndex: number): Promise<void> {
    const seg = this.segments[segmentIndex];
    const bounds = getSegmentBounds(seg);
    if (!seg?._id || !bounds || this.aiRunning) {
      return;
    }
    const base = this.currentBase;
    const ticket = { segmentIndex, kind: 'proofread' as const };
    this.aiRunning = ticket;
    this.update();
    try {
      const result = await this.aiService.proofreadSegment({
        startSec: bounds.start,
        endSec: bounds.end,
        sourceText: seg.text || '',
        language: this.set?.language
      });
      if (this.isDisposed) {
        return;
      }
      for (const warning of result.warnings ?? []) {
        void this.messageService.warn(warning);
      }
      if (result.error) {
        void this.messageService.error(result.error);
        return;
      }
      // Guard against a file switch while the request was in flight: the
      // result belongs to `base`'s transcript, and mutateTranscript writes
      // into the CURRENT one.
      if (result.result && this.currentBase === base) {
        const stored = result.result;
        this.mutateTranscript(document => setSegmentProofreadResult(document, seg._id!, stored));
      }
    } finally {
      if (this.aiRunning === ticket) {
        this.aiRunning = undefined;
      }
      if (!this.isDisposed) {
        this.update();
      }
    }
  }

  protected async runRetranscribeForSegment(segmentIndex: number): Promise<void> {
    const seg = this.segments[segmentIndex];
    const bounds = getSegmentBounds(seg);
    if (!seg?._id || !bounds || this.aiRunning) {
      return;
    }
    const base = this.currentBase;
    const ticket = { segmentIndex, kind: 'retranscribe' as const };
    this.aiRunning = ticket;
    this.update();
    try {
      // Project the cached decoded AudioBuffer to plain channel arrays; the
      // service slices [start, end] to a WAV and ships it to the backend.
      const decoded = this.decodedAudioBuffer;
      const audio = decoded && decoded.numberOfChannels > 0
        ? {
          sampleRate: decoded.sampleRate,
          channels: Array.from(
            { length: Math.min(2, decoded.numberOfChannels) },
            (_, channelIndex) => decoded.getChannelData(channelIndex)
          )
        }
        : undefined;
      const result = await this.aiService.retranscribeSegment({
        mediaRelPath: this.currentPair?.mediaRelPath,
        startSec: bounds.start,
        endSec: bounds.end,
        sourceText: seg.text || '',
        language: this.set?.language,
        audio
      });
      if (this.isDisposed) {
        return;
      }
      for (const warning of result.warnings ?? []) {
        void this.messageService.warn(warning);
      }
      if (result.error) {
        void this.messageService.error(result.error);
        return;
      }
      if (result.result && this.currentBase === base) {
        const stored = result.result;
        this.mutateTranscript(document => setSegmentTranscriptionResult(document, seg._id!, {
          provider: stored.provider,
          model: stored.model,
          text: stored.suggestedText,
          sourceText: stored.sourceText,
          updatedAt: stored.updatedAt,
          raw: stored.raw
        }));
      }
    } finally {
      if (this.aiRunning === ticket) {
        this.aiRunning = undefined;
      }
      if (!this.isDisposed) {
        this.update();
      }
    }
  }

  protected applyProofreadSuggestion(segmentIndex: number): void {
    this.mutateTranscript(document => {
      const segment = document.segments[segmentIndex];
      if (!segment?._id) {
        return undefined;
      }
      const proofread = getSegmentProofread(document, segment._id);
      if (!proofread?.correctedText) {
        return undefined;
      }
      const updated = recordSegmentTextChange(document, segmentIndex, proofread.correctedText, {
        source: 'proofread',
        note: proofread.summary || 'Applied AI proofreading suggestion'
      });
      return setSegmentProofreadResult(updated, segment._id, {
        ...proofread,
        sourceText: proofread.correctedText,
        correctedText: proofread.correctedText
      });
    });
    this.lastTextChangeTimestamp = Date.now();
  }

  protected applyTranscriptionSuggestion(segmentIndex: number): void {
    this.mutateTranscript(document => {
      const segment = document.segments[segmentIndex];
      if (!segment?._id) {
        return undefined;
      }
      const transcription = getSegmentTranscription(document, segment._id);
      if (!transcription?.suggestedText) {
        return undefined;
      }
      const updated = recordSegmentTextChange(document, segmentIndex, transcription.suggestedText, {
        source: 'retranscribe',
        note: `Applied ${transcription.provider || 'AI'} recognition result`
      });
      return setSegmentTranscriptionResult(updated, segment._id, {
        ...transcription,
        sourceText: transcription.suggestedText,
        text: transcription.suggestedText
      });
    });
    this.lastTextChangeTimestamp = Date.now();
  }

  protected restoreHistoryEntry(segmentIndex: number, entry: SegmentHistoryEntry): void {
    this.mutateTranscript(document => restoreSegmentHistoryEntry(document, segmentIndex, entry));
    this.lastTextChangeTimestamp = Date.now();
  }

  // --- wavesurfer lifecycle ---

  /**
   * React ref for the waveform placeholder: appends the widget-owned host node
   * (a DOM move React never reconciles) and lazily (re)creates the instance —
   * the exact proofreading Monaco-host discipline.
   */
  protected readonly attachWaveformHost = (placeholder: HTMLDivElement | null): void => {
    if (!placeholder) {
      return;
    }
    if (!this.waveformHostNode) {
      this.waveformHostNode = document.createElement('div');
      this.waveformHostNode.className = 'afe-transcript-waveform-host-node';
    }
    if (this.waveformHostNode.parentElement !== placeholder) {
      placeholder.appendChild(this.waveformHostNode);
    }
    if (!this.waveSurfer && this.audioBlob) {
      this.rebuildWaveSurfer();
    }
  };

  protected teardownWaveSurfer(): void {
    if (this.waveSurfer) {
      try {
        this.waveSurfer.destroy();
      } catch { /* already gone */ }
    }
    this.waveSurfer = undefined;
    this.regionsPlugin = undefined;
    this.lastRegionSignature = '';
  }

  /**
   * Create ONE WaveSurfer instance for the current media blob inside the
   * widget-owned host: RegionsPlugin registered, `ready`/`decode` capture the
   * duration + the 4096-bin peaks + the decoded AudioBuffer (kept for the
   * mini waveforms and later Phase-5 WAV slicing), `interaction` seeks the
   * `<audio>` engine. Token-guarded against file-switch races.
   */
  protected rebuildWaveSurfer(): void {
    this.teardownWaveSurfer();
    const host = this.waveformHostNode;
    const blob = this.audioBlob;
    if (!host || !blob || this.isDisposed) {
      return;
    }
    const token = this.loadToken;
    const waveSurfer = WaveSurfer.create({
      container: host,
      height: 72,
      normalize: true,
      // Decode at 16 kHz (wavesurfer's default is 8 kHz): the decoded buffer
      // feeds the Phase-5 WAV slices, and whisper.cpp's classic WAV reader
      // REQUIRES 16 kHz input (Groq accepts any rate). Playback itself runs
      // through the <audio> element and is unaffected.
      sampleRate: 16000,
      waveColor: WAVE_COLOR,
      progressColor: WAVE_PROGRESS_COLOR,
      cursorColor: WAVE_CURSOR_COLOR,
      cursorWidth: 1,
      barWidth: 2,
      barGap: 1,
      barRadius: 2,
      interact: true,
      dragToSeek: true,
      autoScroll: false
    });
    const regions = waveSurfer.registerPlugin(RegionsPlugin.create());
    this.waveSurfer = waveSurfer;
    this.regionsPlugin = regions;
    this.lastRegionSignature = '';

    const capture = (): void => {
      if (token !== this.loadToken) {
        return;
      }
      const decoded = waveSurfer.getDecodedData();
      if (decoded) {
        this.decodedAudioBuffer = decoded;
        const peaks = buildWavePeaks(decoded, PEAKS_BINS);
        if (peaks) {
          this.audioPeaks = peaks;
        }
      }
      this.audioDuration = waveSurfer.getDuration() || this.audioDuration;
      this.repaintRegions();
      this.update();
    };
    waveSurfer.on('ready', capture);
    waveSurfer.on('decode', () => capture());
    waveSurfer.on('error', () => { /* handled silently (source parity) */ });
    waveSurfer.on('interaction', () => {
      if (token !== this.loadToken) {
        return;
      }
      const targetTime = waveSurfer.getCurrentTime();
      const audio = this.audio;
      if (audio) {
        audio.currentTime = targetTime;
      }
      this.currentTime = targetTime;
      this.update();
    });
    void waveSurfer.loadBlob(blob).catch(() => { /* decode failure — waveform stays empty */ });
  }

  /**
   * Paint one region per segment, keyed on a render signature so repaints run
   * only when segments/active state actually changed (source
   * `regionRenderSignature`): green = filled, brighter green = active,
   * red = empty; clicking a region seeks to its start.
   */
  protected repaintRegions(): void {
    const regions = this.regionsPlugin;
    if (!regions) {
      return;
    }
    const segments = this.segments;
    const activeIndex = this.activeSegmentIndex;
    const signature = `${activeIndex}|${segments
      .map(segment => {
        const bounds = getSegmentBounds(segment);
        if (!bounds) {
          return 'x';
        }
        const isEmpty = (segment.text || '').trim().length === 0 ? 1 : 0;
        return `${bounds.start}-${bounds.end}-${isEmpty}`;
      })
      .join('|')}`;
    if (signature === this.lastRegionSignature) {
      return;
    }
    this.lastRegionSignature = signature;
    regions.getRegions().forEach(region => region.remove());
    segments.forEach((segment, idx) => {
      const bounds = getSegmentBounds(segment);
      if (!bounds) {
        return;
      }
      const isActive = idx === activeIndex;
      const isEmpty = (segment.text || '').trim().length === 0;
      let color = REGION_FILLED;
      if (isEmpty) {
        color = REGION_EMPTY;
      }
      if (isActive) {
        color = REGION_ACTIVE;
      }
      const region = regions.addRegion({
        id: `segment-${idx}`,
        start: bounds.start,
        end: bounds.end,
        drag: false,
        resize: false,
        color
      });
      region.on('click', event => {
        event?.stopPropagation?.();
        this.editingIndex = null;
        this.seekTo(bounds.start);
      });
    });
  }

  protected override onUpdateRequest(msg: Message): void {
    super.onUpdateRequest(msg);
    // Post-render imperative sync: regions + the per-segment mini waveforms.
    requestAnimationFrame(() => {
      if (this.isDisposed) {
        return;
      }
      this.repaintRegions();
      this.drawSegmentWaves();
    });
  }

  // --- per-segment mini waveform (SegmentProgressNavigator port) ---

  protected drawSegmentWaves(): void {
    for (const [idx, canvas] of this.segmentWaveCanvases) {
      const segment = this.segments[idx];
      if (segment && canvas.isConnected) {
        this.drawSegmentWave(canvas, segment);
      }
    }
  }

  protected drawSegmentWave(canvas: HTMLCanvasElement, segment: TranscriptSegment): void {
    const bounds = getSegmentBounds(segment);
    const container = canvas.parentElement;
    if (!bounds || !container) {
      return;
    }
    const cssWidth = Math.max(1, Math.floor(container.clientWidth));
    const cssHeight = Math.max(1, Math.floor(container.clientHeight));
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const pixelWidth = Math.max(1, Math.floor(cssWidth * dpr));
    const pixelHeight = Math.max(1, Math.floor(cssHeight * dpr));
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
      canvas.style.width = `${cssWidth}px`;
      canvas.style.height = `${cssHeight}px`;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }
    const segStart = bounds.start;
    const segEnd = bounds.end;
    const segmentDuration = Math.max(0.001, segEnd - segStart);
    const relativeCurrent = Math.max(0, Math.min(segmentDuration, this.currentTime - segStart));
    const progressRatio = Math.max(0, Math.min(1, relativeCurrent / segmentDuration));

    const waveBg = '#e2e8f0';
    const wave = '#cbd5e1';
    const waveProgress = WAVE_PROGRESS_COLOR;
    const waveCursor = '#1e293b';

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);
    ctx.fillStyle = waveBg;
    ctx.fillRect(0, 0, cssWidth, cssHeight);

    let segmentPeaks: Float32Array | undefined;
    const peaks = this.audioPeaks;
    if (peaks && peaks.length > 0 && Number.isFinite(this.audioDuration) && this.audioDuration > 0) {
      const total = peaks.length;
      const startIdx = Math.max(0, Math.min(total - 1, Math.floor((segStart / this.audioDuration) * total)));
      const endIdx = Math.max(startIdx + 1, Math.min(total, Math.ceil((segEnd / this.audioDuration) * total)));
      segmentPeaks = peaks.subarray(startIdx, endIdx);
    }

    const barWidth = 2;
    const barGap = 1;
    const barStep = barWidth + barGap;
    const totalBars = Math.max(1, Math.floor((cssWidth + barGap) / barStep));
    const centerY = cssHeight / 2;
    const maxBarHeight = Math.max(2, cssHeight - 4);

    if (segmentPeaks && segmentPeaks.length > 0) {
      for (let bar = 0; bar < totalBars; bar++) {
        const x = bar * barStep;
        const peakIndex = Math.min(segmentPeaks.length - 1, Math.floor((bar / totalBars) * segmentPeaks.length));
        const amplitude = Math.max(0.02, Math.min(1, segmentPeaks[peakIndex] || 0));
        const barHeight = Math.max(2, amplitude * maxBarHeight);
        ctx.fillStyle = bar / totalBars <= progressRatio ? waveProgress : wave;
        ctx.fillRect(x, centerY - barHeight / 2, barWidth, barHeight);
      }
    } else {
      ctx.fillStyle = wave;
      ctx.fillRect(0, centerY - 1, cssWidth, 2);
      ctx.fillStyle = waveProgress;
      ctx.fillRect(0, centerY - 1, cssWidth * progressRatio, 2);
    }

    const cursorX = Math.min(cssWidth - 1, Math.max(0, progressRatio * cssWidth));
    ctx.fillStyle = waveCursor;
    ctx.fillRect(cursorX, 0, 1, cssHeight);
  }

  /** Click-to-seek within a segment's mini waveform (clamped to its bounds). */
  protected handleSegmentWaveClick(event: React.MouseEvent, segment: TranscriptSegment): void {
    event.stopPropagation();
    const bounds = getSegmentBounds(segment);
    if (!bounds) {
      return;
    }
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / (rect.width || 1)));
    const target = bounds.start + ratio * (bounds.end - bounds.start);
    this.seekTo(Math.max(bounds.start, Math.min(bounds.end, target)));
  }

  protected handlePlayPauseSegment(segment: TranscriptSegment): void {
    const audio = this.audio;
    const bounds = getSegmentBounds(segment);
    if (!audio || !bounds) {
      return;
    }
    const audioIsPlaying = !audio.paused && !audio.ended;
    const ct = audio.currentTime;
    const isInSegment = ct >= bounds.start && ct <= bounds.end;
    if (audioIsPlaying && isInSegment) {
      this.setPlaying(false);
    } else {
      let startTime = Math.max(bounds.start, Math.min(bounds.end, ct));
      if (ct < bounds.start || ct > bounds.end) {
        startTime = bounds.start;
      }
      this.seekTo(startTime);
      this.setPlaying(true);
    }
  }

  protected handleSkipInSegment(segment: TranscriptSegment, delta: number): void {
    const audio = this.audio;
    const bounds = getSegmentBounds(segment);
    if (!audio || !bounds) {
      return;
    }
    const newTime = delta < 0
      ? Math.max(bounds.start, audio.currentTime + delta)
      : Math.min(bounds.end, audio.currentTime + delta);
    this.seekTo(newTime);
  }

  // --- raw.md (explicit action — never on save, to avoid watcher churn) ---

  async generateRawMdFile(): Promise<void> {
    if (!this.set || !this.rootUri) {
      return;
    }
    try {
      const files: RawMdSourceFile[] = [];
      for (const pair of this.pairs) {
        let document = this.transcripts.get(pair.base);
        if (!document) {
          document = await this.readTranscriptFromDisk(pair);
          if (document) {
            this.transcripts.set(pair.base, document);
          }
        }
        if (!document || document.segments.length === 0) {
          continue;
        }
        files.push({ name: pair.base, offsetMs: pair.offsetMs, segments: document.segments });
      }
      const text = generateRawMd(files, this.speakers);
      const target = this.uri.parent.resolve(RAW_MD_FILE_NAME);
      await this.fileService.write(target, text);
      void this.messageService.info(nls.localize(
        'ai-focused-editor/transcript/raw-md-generated',
        'raw.md regenerated for "{0}".',
        this.slug
      ));
    } catch (error) {
      void this.messageService.error(nls.localize(
        'ai-focused-editor/transcript/raw-md-failed',
        'Could not generate raw.md: {0}',
        error instanceof Error ? error.message : String(error)
      ));
    }
  }

  // --- Saveable ---

  async save(_options?: SaveOptions): Promise<void> {
    if (!this.set) {
      return;
    }
    try {
      // Finalize an in-flight segment edit first (source `saveCurrentFile`).
      if (this.editingIndex !== null) {
        this.finishEditing('manual');
      }
      for (const base of [...this.dirtyBases]) {
        const pair = this.pairs.find(candidate => candidate.base === base);
        const document = this.transcripts.get(base);
        const target = pair ? this.toUri(pair.transcriptRelPath) : undefined;
        if (target && document) {
          await this.fileService.write(target, `${JSON.stringify(document, undefined, 2)}\n`);
        }
      }
      const yamlText = writeTranscriptsetYaml(this.existingSidecarText, this.set);
      await this.fileService.write(this.uri, yamlText);
      this.existingSidecarText = yamlText;
      if (this.speakersDirty) {
        this.speakersExistingText = await this.speakersService.write(this.uri.parent, this.speakersExistingText, this.speakers);
        this.speakersDirty = false;
      }
      this.dirtyBases.clear();
      this.setDirty(false);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.messageService.error(nls.localize(
        'ai-focused-editor/transcript/save-failed',
        'Could not save the transcript set: {0}',
        detail
      ));
    }
  }

  async revert(): Promise<void> {
    await this.load();
  }

  override dispose(): void {
    this.segmentCardNodes.clear();
    this.segmentWaveCanvases.clear();
    super.dispose();
  }

  // --- rendering ---

  protected render(): React.ReactNode {
    if (this.loading) {
      return h('div', { className: 'afe-transcript-status' },
        nls.localize('ai-focused-editor/transcript/loading', 'Loading transcript set...'));
    }
    if (this.error) {
      return h('div', { className: 'afe-transcript-status error' },
        nls.localize('ai-focused-editor/transcript/error', 'Could not open the transcript set: {0}', this.error));
    }
    if (!this.set) {
      return h('div', { className: 'afe-transcript-shell' },
        this.renderProblems(),
        h('div', { className: 'afe-transcript-status error' },
          nls.localize(
            'ai-focused-editor/transcript/invalid-sidecar',
            'transcriptset.yaml is missing required fields; open it as raw YAML to fix it.'
          )));
    }
    return h('div', { className: 'afe-transcript-shell' },
      this.showFilesPane ? this.renderFilesPane() : undefined,
      this.renderMain(),
      this.showOutlinePane ? this.renderOutline() : undefined);
  }

  protected renderProblems(): React.ReactNode {
    if (this.problems.length === 0) {
      return undefined;
    }
    return h('ul', { className: 'afe-transcript-problems' },
      ...this.problems.map((problem, index) => h('li', { key: index, className: 'afe-transcript-problem error' }, problem.message)));
  }

  // LEFT: the set's file list (replaces the source Sidebar).
  protected renderFilesPane(): React.ReactNode {
    const progress = computeTranscriptProgress(this.set!.files);
    return h('div', { className: 'afe-transcript-files' },
      h('div', { className: 'afe-transcript-files-header' },
        h('span', undefined, nls.localize('ai-focused-editor/transcript/files-label', 'Files')),
        h('span', { className: 'afe-transcript-files-progress' }, `${progress.verified}/${progress.total} ✓`)),
      h('div', { className: 'afe-transcript-files-list' },
        ...this.pairs.map(pair => {
          const isActive = pair.base === this.currentBase;
          const verified = this.isVerified(pair.base);
          const rework = this.needsRework(pair.base);
          return h('div', {
            key: pair.base,
            className: `afe-transcript-file-item${isActive ? ' is-active' : ''}`,
            role: 'button',
            tabIndex: 0,
            title: pair.mediaRelPath ?? pair.transcriptRelPath,
            onClick: () => { void this.selectFile(pair.base); },
            onKeyDown: (event: React.KeyboardEvent) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                void this.selectFile(pair.base);
              }
            }
          },
          h('span', { className: 'afe-transcript-file-name' }, pair.base),
          h('span', { className: 'afe-transcript-file-chips' },
            pair.offsetMs !== null
              ? h('span', { className: 'afe-transcript-file-chip' }, formatTime(pair.offsetMs / 1000))
              : undefined,
            pair.missing
              ? h('span', { className: 'afe-transcript-file-chip missing' },
                nls.localize('ai-focused-editor/transcript/file-missing', 'no transcript'))
              : undefined,
            verified ? h('span', { className: 'afe-transcript-file-chip verified' }, '✓') : undefined,
            rework ? h('span', { className: 'afe-transcript-file-chip rework' }, '⚠') : undefined));
        })));
  }

  protected renderMain(): React.ReactNode {
    const pair = this.currentPair;
    return h('div', { className: 'afe-transcript-main' },
      this.renderProblems(),
      pair
        ? h(React.Fragment, undefined, this.renderPlayer(pair), this.renderSegments())
        : h('div', { className: 'afe-transcript-status' },
          nls.localize('ai-focused-editor/transcript/no-files', 'No media files found for this set. Add audio to the media folder.')));
  }

  // CENTER: sticky player (transport + rates + search + speakers + waveform).
  protected renderPlayer(pair: TranscriptPair): React.ReactNode {
    const emptyCount = this.emptySegmentIndices.length;
    const matches = this.searchMatches;
    const counterText = this.searchTerms.length === 0
      ? '—'
      : matches.length === 0
        ? '0/0'
        : `${this.searchResultIndex < 0 ? 0 : Math.min(this.searchResultIndex + 1, matches.length)}/${matches.length}`;
    const verified = this.isVerified(pair.base);
    const rework = this.needsRework(pair.base);

    return h('div', { className: 'afe-transcript-player' },
      h('div', { className: 'afe-transcript-title-row' },
        h('h2', { className: 'afe-transcript-title' }, pair.base),
        h('div', { className: 'afe-transcript-title-actions' },
          h('button', {
            className: `theia-button secondary afe-transcript-toggle${verified ? ' active' : ''}`,
            type: 'button',
            onClick: () => this.toggleVerified()
          }, '✅ ', nls.localize('ai-focused-editor/transcript/verified', 'Verified')),
          h('button', {
            className: `theia-button secondary afe-transcript-toggle${rework ? ' active' : ''}`,
            type: 'button',
            onClick: () => this.toggleNeedsRework()
          }, nls.localize('ai-focused-editor/transcript/needs-rework', 'Needs rework')),
          h('button', {
            className: `theia-button secondary afe-transcript-toggle${this.showFilesPane ? ' active' : ''}`,
            type: 'button',
            title: nls.localize('ai-focused-editor/transcript/toggle-files-tooltip', 'Show or hide the file list'),
            onClick: () => { this.showFilesPane = !this.showFilesPane; this.update(); }
          }, nls.localize('ai-focused-editor/transcript/toggle-files', 'Files')),
          h('button', {
            className: `theia-button secondary afe-transcript-toggle${this.showOutlinePane ? ' active' : ''}`,
            type: 'button',
            title: nls.localize('ai-focused-editor/transcript/toggle-outline-tooltip', 'Show or hide the outline'),
            onClick: () => { this.showOutlinePane = !this.showOutlinePane; this.update(); }
          }, nls.localize('ai-focused-editor/transcript/toggle-outline', 'Outline')),
          h('button', {
            className: 'theia-button secondary',
            type: 'button',
            title: nls.localize('ai-focused-editor/transcript/raw-md-tooltip', 'Regenerate the flattened raw.md full text from the segments'),
            onClick: () => { void this.generateRawMdFile(); }
          }, 'raw.md'))),
      this.renderSearchRow(counterText, matches.length),
      this.renderTransportRow(emptyCount),
      this.renderRatesRow(),
      this.renderSpeakersRow(),
      this.renderWaveformBlock());
  }

  protected renderSearchRow(counterText: string, matchCount: number): React.ReactNode {
    return h('div', { className: 'afe-transcript-search-row' },
      h('input', {
        type: 'text',
        className: 'theia-input afe-transcript-search-input',
        value: this.searchQuery,
        placeholder: nls.localize('ai-focused-editor/transcript/search-placeholder', 'Find in transcript...'),
        'aria-label': nls.localize('ai-focused-editor/transcript/search-placeholder', 'Find in transcript...'),
        ref: (node: HTMLInputElement | null) => { this.searchInputNode = node ?? undefined; },
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
          this.searchQuery = event.target.value;
          this.searchResultIndex = -1;
          this.update();
        },
        onKeyDown: (event: React.KeyboardEvent) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            if (event.shiftKey) {
              this.goToPrevSearchResult();
            } else {
              this.goToNextSearchResult();
            }
          } else if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            this.searchQuery = '';
            this.searchResultIndex = -1;
            this.update();
          }
        }
      }),
      h('button', {
        className: 'theia-button secondary',
        type: 'button',
        disabled: matchCount === 0,
        title: nls.localize('ai-focused-editor/transcript/search-prev-tooltip', 'Previous match (Shift+Enter)'),
        onClick: () => this.goToPrevSearchResult()
      }, nls.localize('ai-focused-editor/transcript/search-prev', 'Prev')),
      h('button', {
        className: 'theia-button secondary',
        type: 'button',
        disabled: matchCount === 0,
        title: nls.localize('ai-focused-editor/transcript/search-next-tooltip', 'Next match (Enter)'),
        onClick: () => this.goToNextSearchResult()
      }, nls.localize('ai-focused-editor/transcript/search-next', 'Next')),
      h('span', { className: 'afe-transcript-search-counter' }, counterText));
  }

  protected renderTransportRow(emptyCount: number): React.ReactNode {
    return h('div', { className: 'afe-transcript-transport' },
      h('button', { className: 'theia-button secondary', type: 'button', onClick: () => this.navigateSegment(-1) },
        nls.localize('ai-focused-editor/transcript/prev-seg', 'Prev Seg')),
      h('button', { className: 'theia-button secondary', type: 'button', onClick: () => this.skipTime(-5) }, '-5s'),
      h('button', {
        className: 'afe-transcript-play-button',
        type: 'button',
        'aria-label': this.isPlaying
          ? nls.localize('ai-focused-editor/transcript/pause', 'Pause')
          : nls.localize('ai-focused-editor/transcript/play', 'Play'),
        onClick: () => this.togglePlayPause()
      }, h('span', { className: `codicon codicon-${this.isPlaying ? 'debug-pause' : 'play'}` })),
      h('button', {
        className: 'theia-button secondary',
        type: 'button',
        onClick: () => { this.setPlaying(false); }
      }, nls.localize('ai-focused-editor/transcript/stop', 'Stop')),
      h('button', { className: 'theia-button secondary', type: 'button', onClick: () => this.skipTime(5) }, '+5s'),
      h('button', { className: 'theia-button secondary', type: 'button', onClick: () => this.navigateSegment(1) },
        nls.localize('ai-focused-editor/transcript/next-seg', 'Next Seg')),
      h('button', {
        className: `theia-button secondary afe-transcript-toggle${this.isMergeMode ? ' active' : ''}`,
        type: 'button',
        title: nls.localize('ai-focused-editor/transcript/merge-tooltip', 'Toggle merge mode'),
        onClick: () => this.toggleMergeMode()
      }, nls.localize('ai-focused-editor/transcript/merge', 'Merge')),
      this.isMergeMode
        ? h(React.Fragment, undefined,
          h('span', { className: 'afe-transcript-chip merge' },
            nls.localize('ai-focused-editor/transcript/merge-selected', 'Selected: {0}', this.mergeSelection.length)),
          h('button', {
            className: 'theia-button secondary',
            type: 'button',
            disabled: this.mergeSelection.length < 2 || !this.mergeSelectionIsContiguous,
            title: nls.localize('ai-focused-editor/transcript/merge-apply-tooltip', 'Apply merge for selected adjacent segments'),
            onClick: () => this.applyMergeSelection()
          }, nls.localize('ai-focused-editor/transcript/apply', 'Apply')),
          h('button', {
            className: 'theia-button secondary',
            type: 'button',
            onClick: () => { this.mergeSelection = []; this.isMergeMode = false; this.update(); }
          }, nls.localize('ai-focused-editor/transcript/cancel', 'Cancel')))
        : undefined,
      h('button', {
        className: 'theia-button secondary',
        type: 'button',
        disabled: emptyCount === 0,
        title: nls.localize('ai-focused-editor/transcript/prev-empty-tooltip', 'Previous empty segment'),
        onClick: () => this.navigateEmptySegment(-1)
      }, nls.localize('ai-focused-editor/transcript/prev-empty', 'Prev Empty')),
      h('button', {
        className: 'theia-button secondary',
        type: 'button',
        disabled: emptyCount === 0,
        title: nls.localize('ai-focused-editor/transcript/next-empty-tooltip', 'Next empty segment'),
        onClick: () => this.navigateEmptySegment(1)
      }, nls.localize('ai-focused-editor/transcript/next-empty', 'Next Empty')),
      h('span', { className: 'afe-transcript-chip empty' },
        nls.localize('ai-focused-editor/transcript/empty-count', 'Empty: {0}', emptyCount)));
  }

  protected renderRatesRow(): React.ReactNode {
    return h('div', { className: 'afe-transcript-rates' },
      h('span', { className: 'afe-transcript-rates-label' },
        nls.localize('ai-focused-editor/transcript/speed', 'Speed:')),
      ...VALID_PLAYBACK_RATES.map(rate => {
        const isActive = Math.abs(rate - this.playbackRate) < 0.0001;
        const isWholeRate = Math.abs(rate - Math.round(rate)) < 0.0001;
        return h('button', {
          key: rate,
          type: 'button',
          className: `afe-transcript-rate-btn${isActive ? ' is-active' : ''}${isWholeRate ? ' is-whole' : ''}`,
          onClick: () => this.setRate(rate)
        }, formatRate(rate));
      }));
  }

  protected renderSpeakersRow(): React.ReactNode {
    return h('div', { className: 'afe-transcript-speakers' },
      h('span', { className: 'afe-transcript-speakers-label' },
        nls.localize('ai-focused-editor/transcript/speakers', 'Speakers')),
      h('button', {
        className: 'theia-button secondary afe-transcript-speaker-add',
        type: 'button',
        title: nls.localize('ai-focused-editor/transcript/speaker-add', 'Add speaker'),
        'aria-label': nls.localize('ai-focused-editor/transcript/speaker-add', 'Add speaker'),
        onClick: () => { void this.openCreateSpeakerDialog(); }
      }, '+'),
      this.speakers.length === 0
        ? h('span', { className: 'afe-transcript-speakers-empty' },
          nls.localize('ai-focused-editor/transcript/no-speakers', 'No speakers yet'))
        : h(React.Fragment, undefined,
          ...this.speakers.map(speaker => h('span', { key: speaker.id, className: 'afe-transcript-speaker-entry' },
            h('span', { className: 'afe-transcript-badge speaker' }, speaker.name),
            h('button', {
              className: 'theia-button secondary afe-transcript-speaker-edit',
              type: 'button',
              title: nls.localize('ai-focused-editor/transcript/speaker-rename-tooltip', 'Rename speaker (ID: {0})', speaker.id),
              onClick: () => { void this.openRenameSpeakerDialog(speaker.id); }
            }, nls.localize('ai-focused-editor/transcript/speaker-edit', 'Edit'))))));
  }

  protected renderWaveformBlock(): React.ReactNode {
    return h('div', { className: 'afe-transcript-waveform-block' },
      h('div', {
        className: 'afe-transcript-waveform',
        role: 'img',
        'aria-label': nls.localize('ai-focused-editor/transcript/waveform-aria', 'Audio waveform — click to seek'),
        ref: this.attachWaveformHost
      }),
      h('div', { className: 'afe-transcript-wave-times' },
        h('span', undefined, formatTime(this.currentTime)),
        h('span', undefined, formatTime(this.audioDuration || this.audio?.duration || 0))),
      h('div', { className: 'afe-transcript-wave-hint' },
        nls.localize(
          'ai-focused-editor/transcript/waveform-hint',
          'Waveform navigation: click to seek; click a highlighted fragment to jump to its segment. Filled: green. Empty: red.'
        )));
  }

  // CENTER: the segment card list.
  protected renderSegments(): React.ReactNode {
    const segments = this.segments;
    const pair = this.currentPair;
    if (segments.length === 0) {
      return h('div', { className: 'afe-transcript-segments' },
        h('div', { className: 'afe-transcript-status' },
          pair?.missing
            ? nls.localize('ai-focused-editor/transcript/no-transcript', 'No transcript yet for this file — it will appear after transcription.')
            : nls.localize('ai-focused-editor/transcript/no-segments', 'The transcript has no segments.')));
    }
    const timeIndex = this.timeBasedActiveSegmentIndex;
    const matchesSet = new Set(this.searchMatches);
    const emptySet = new Set(this.emptySegmentIndices);
    const speakerResolution = resolveEffectiveSpeaker(segments, this.inheritedSpeakerId);
    const nameById = speakerNameById(this.speakers);
    const matches = this.searchMatches;
    return h('div', { className: 'afe-transcript-segments' },
      ...segments.map((seg, idx) => this.renderSegmentCard(
        seg, idx, timeIndex, matchesSet, emptySet,
        speakerResolution.timeline[idx], nameById,
        matches.length > 0 && this.searchResultIndex >= 0 && matches[this.searchResultIndex] === idx
      )));
  }

  protected renderSegmentCard(
    seg: TranscriptSegment,
    idx: number,
    timeIndex: number,
    matchesSet: ReadonlySet<number>,
    emptySet: ReadonlySet<number>,
    speakerState: { explicitSpeakerId: string; effectiveSpeakerId: string } | undefined,
    nameById: ReadonlyMap<string, string>,
    isCurrentSearchMatch: boolean
  ): React.ReactNode {
    const isCurrentSegment = idx === timeIndex;
    const isEditing = idx === this.editingIndex;
    const isMergeSelected = this.mergeSelection.includes(idx);
    const isSearchMatch = matchesSet.has(idx);
    const isEmptySegment = emptySet.has(idx);
    const explicitSpeakerId = speakerState?.explicitSpeakerId || '';
    const resolvedSpeakerId = speakerState?.effectiveSpeakerId || '';
    const speakerLabel = nameById.get(resolvedSpeakerId) || '';
    const hasSpeakerTurn = getSegmentSpeakerTurn(seg);
    const showSpeakerControls = !this.isMergeMode && (isCurrentSegment || isEditing);
    const opKind = this.operationFeedback?.segmentIndex === idx ? this.operationFeedback.kind : undefined;
    const document = this.currentTranscript;
    const proofread = getSegmentProofread(document, seg._id);
    const transcription = getSegmentTranscription(document, seg._id);
    const history = getSegmentHistory(document, seg._id);
    const audio = this.audio;
    const isAudioPlayingInSegment = !!(isEditing && audio && !audio.paused && !audio.ended
      && audio.currentTime >= seg.start && audio.currentTime <= seg.end);

    const classNames = ['afe-transcript-segment-card'];
    if (isMergeSelected) { classNames.push('is-merge-selected'); }
    else if (isCurrentSegment) { classNames.push('is-current'); if (isEditing) { classNames.push('is-editing'); } }
    else if (isCurrentSearchMatch) { classNames.push('is-current-search-match'); }
    else if (isSearchMatch) { classNames.push('is-search-match'); }
    else if (isEmptySegment) { classNames.push('is-empty'); }
    if (isEditing && !classNames.includes('is-editing')) { classNames.push('is-editing'); }
    if (isEmptySegment && !classNames.includes('is-empty')) { classNames.push('is-empty'); }
    if (opKind) { classNames.push(`op-${opKind}`); }

    const children: React.ReactNode[] = [];

    // Time + badges row.
    children.push(h('div', { key: 'time', className: 'afe-transcript-seg-time' },
      `[${formatTime(seg.start)} - ${formatTime(seg.end)}]`,
      speakerLabel
        ? h('span', {
          className: 'afe-transcript-badge speaker',
          title: explicitSpeakerId
            ? nls.localize('ai-focused-editor/transcript/speaker-explicit-tooltip', 'Speaker set explicitly for this segment')
            : nls.localize('ai-focused-editor/transcript/speaker-inherited-tooltip', 'Speaker inherited from previous segment/file')
        }, `SPK: ${speakerLabel}${explicitSpeakerId ? '' : ` ${nls.localize('ai-focused-editor/transcript/inherited', '[inherited]')}`}`)
        : undefined,
      hasSpeakerTurn ? h('span', { className: 'afe-transcript-badge turn' }, 'TURN') : undefined,
      isEmptySegment
        ? h('span', { className: 'afe-transcript-badge empty' },
          nls.localize('ai-focused-editor/transcript/empty-badge', 'EMPTY'))
        : undefined));

    // Speaker chips editor.
    if (showSpeakerControls) {
      children.push(this.renderSpeakerTurnEditor(seg, idx, explicitSpeakerId, resolvedSpeakerId));
    }

    // Mini waveform for the playing (non-editing) segment.
    if (isCurrentSegment && !isEditing && this.editingIndex === null) {
      children.push(this.renderSegmentWave(seg, idx));
    }

    // Editing controls + mini waveform.
    if (isEditing) {
      children.push(this.renderEditControls(seg, idx));
      children.push(this.renderSegmentWave(seg, idx, isAudioPlayingInSegment));
    }

    // Text: textarea while editing, styled paragraph otherwise.
    if (isEditing) {
      children.push(h('textarea', {
        key: 'textarea',
        className: 'theia-input afe-transcript-textarea',
        rows: 3,
        autoFocus: true,
        value: seg.text || '',
        placeholder: nls.localize('ai-focused-editor/transcript/text-placeholder', 'Enter transcript text here...'),
        onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => this.handleTextChange(idx, event.target.value),
        onKeyDown: (event: React.KeyboardEvent) => this.handleEditKeyDown(event),
        onClick: (event: React.MouseEvent) => event.stopPropagation()
      }));
    } else {
      children.push(h('p', { key: 'text', className: 'afe-transcript-seg-text' },
        seg.text
          ? seg.text
          : h('span', { className: 'afe-transcript-empty-hint' },
            nls.localize('ai-focused-editor/transcript/empty-hint', 'No text — select to focus, then activate to edit'))));
    }

    // AI panels + history (editing only, source parity).
    if (isEditing && proofread) {
      children.push(this.renderProofreadPanel(seg, idx, proofread));
    }
    if (isEditing && transcription) {
      children.push(this.renderTranscriptionPanel(seg, idx, transcription));
    }
    if (isEditing && history.length > 0) {
      children.push(this.renderHistoryPanel(idx, history));
    }

    return h('div', {
      key: seg._id || idx,
      className: classNames.join(' '),
      role: 'button',
      tabIndex: 0,
      'aria-label': `Segment ${idx + 1}: ${formatTime(seg.start)} to ${formatTime(seg.end)}`,
      ref: (node: HTMLDivElement | null) => {
        if (node) {
          this.segmentCardNodes.set(idx, node);
        } else {
          this.segmentCardNodes.delete(idx);
        }
      },
      onClick: () => { if (!isEditing) { this.handleSegmentClick(idx); } },
      onDoubleClick: () => { if (!isEditing) { this.handleSegmentDoubleClick(idx); } },
      onKeyDown: (event: React.KeyboardEvent) => {
        if (!isEditing && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          this.handleSegmentClick(idx);
        }
      }
    }, ...children);
  }

  protected renderSpeakerTurnEditor(seg: TranscriptSegment, idx: number, explicitSpeakerId: string, resolvedSpeakerId: string): React.ReactNode {
    const hasTurn = getSegmentSpeakerTurn(seg);
    return h('div', {
      key: 'speaker-editor',
      className: 'afe-transcript-speaker-editor',
      onClick: (event: React.MouseEvent) => event.stopPropagation()
    },
    h('span', { className: 'afe-transcript-speakers-label' },
      nls.localize('ai-focused-editor/transcript/speaker', 'Speaker')),
    h('button', {
      type: 'button',
      className: `afe-transcript-speaker-chip${!explicitSpeakerId ? ' is-active is-explicit' : ''}`,
      onClick: () => this.updateSegmentSpeaker(idx, '')
    }, nls.localize('ai-focused-editor/transcript/speaker-inherit', 'Inherit')),
    this.speakers.length === 0
      ? h('span', { className: 'afe-transcript-speakers-empty' },
        nls.localize('ai-focused-editor/transcript/add-speaker-hint', 'Add speaker via + on top panel'))
      : h(React.Fragment, undefined,
        ...this.speakers.map(speaker => h('button', {
          key: `${idx}-${speaker.id}`,
          type: 'button',
          className: `afe-transcript-speaker-chip${speaker.id === resolvedSpeakerId ? ' is-active' : ''}${speaker.id === explicitSpeakerId ? ' is-explicit' : ''}`,
          title: `Speaker ID: ${speaker.id}`,
          onClick: () => this.updateSegmentSpeaker(idx, speaker.id)
        }, speaker.name))),
    h('span', { className: 'afe-transcript-turn-buttons' },
      h('button', {
        type: 'button',
        className: `afe-transcript-turn-btn${!hasTurn ? ' is-active' : ''}`,
        onClick: () => this.updateSegmentSpeakerTurn(idx, false)
      }, nls.localize('ai-focused-editor/transcript/same-voice', 'Same Voice')),
      h('button', {
        type: 'button',
        className: `afe-transcript-turn-btn${hasTurn ? ' is-active' : ''}`,
        onClick: () => this.updateSegmentSpeakerTurn(idx, true)
      }, nls.localize('ai-focused-editor/transcript/voice-changed', 'Voice Changed'))));
  }

  protected renderSegmentWave(seg: TranscriptSegment, idx: number, _playing = false): React.ReactNode {
    const bounds = getSegmentBounds(seg);
    if (!bounds) {
      return undefined;
    }
    const segmentDuration = Math.max(0.001, bounds.end - bounds.start);
    const relativeCurrent = Math.max(0, Math.min(segmentDuration, this.currentTime - bounds.start));
    return h('div', { key: 'segwave', className: 'afe-transcript-segwave-block' },
      h('div', {
        className: 'afe-transcript-segwave',
        onClick: (event: React.MouseEvent) => this.handleSegmentWaveClick(event, seg)
      },
      h('canvas', {
        ref: (node: HTMLCanvasElement | null) => {
          if (node) {
            this.segmentWaveCanvases.set(idx, node);
            this.drawSegmentWave(node, seg);
          } else {
            this.segmentWaveCanvases.delete(idx);
          }
        }
      })),
      h('div', { className: 'afe-transcript-segwave-times' },
        h('span', undefined, formatTime(relativeCurrent)),
        h('span', undefined, formatTime(segmentDuration))));
  }

  protected renderEditControls(seg: TranscriptSegment, idx: number): React.ReactNode {
    const audio = this.audio;
    const playingInSegment = !!(audio && !audio.paused && !audio.ended
      && audio.currentTime >= seg.start && audio.currentTime <= seg.end);
    const inSplitMode = this.splitModeSegmentIndex === idx;
    return h('div', { key: 'edit-controls', className: 'afe-transcript-edit-controls' },
      h('div', { className: 'afe-transcript-edit-buttons' },
        h('button', {
          className: 'theia-button afe-transcript-seg-play',
          type: 'button',
          onClick: (event: React.MouseEvent) => { event.stopPropagation(); this.handlePlayPauseSegment(seg); }
        }, playingInSegment
          ? `⏸ ${nls.localize('ai-focused-editor/transcript/pause', 'Pause')}`
          : `▶ ${nls.localize('ai-focused-editor/transcript/play', 'Play')}`),
        h('button', {
          className: 'theia-button secondary',
          type: 'button',
          onClick: (event: React.MouseEvent) => { event.stopPropagation(); this.handleSkipInSegment(seg, -5); }
        }, '-5s'),
        h('button', {
          className: 'theia-button secondary',
          type: 'button',
          onClick: (event: React.MouseEvent) => { event.stopPropagation(); this.handleSkipInSegment(seg, 5); }
        }, '+5s'),
        h('button', {
          className: `theia-button secondary afe-transcript-toggle${inSplitMode ? ' active' : ''}`,
          type: 'button',
          title: nls.localize('ai-focused-editor/transcript/split-tooltip', 'Split mode: position on waveform and apply'),
          onClick: (event: React.MouseEvent) => { event.stopPropagation(); this.beginSplitMode(idx); }
        }, nls.localize('ai-focused-editor/transcript/split', 'Split')),
        inSplitMode
          ? h(React.Fragment, undefined,
            h('button', {
              className: 'theia-button secondary',
              type: 'button',
              title: nls.localize('ai-focused-editor/transcript/split-apply-tooltip', 'Apply split at current waveform position'),
              onClick: (event: React.MouseEvent) => { event.stopPropagation(); this.applySplitMode(); }
            }, nls.localize('ai-focused-editor/transcript/apply', 'Apply')),
            h('button', {
              className: 'theia-button secondary',
              type: 'button',
              onClick: (event: React.MouseEvent) => { event.stopPropagation(); this.cancelSplitMode(); }
            }, nls.localize('ai-focused-editor/transcript/cancel', 'Cancel')))
          : undefined,
        h('button', {
          className: 'theia-button secondary afe-transcript-ai-btn',
          type: 'button',
          disabled: !!this.aiRunning,
          onClick: (event: React.MouseEvent) => { event.stopPropagation(); void this.runProofreadForSegment(idx); }
        }, this.aiRunning?.kind === 'proofread' && this.aiRunning.segmentIndex === idx
          ? nls.localize('ai-focused-editor/transcript/proofreading-busy', 'Proofreading…')
          : nls.localize('ai-focused-editor/transcript/proofread', 'Proofread')),
        h('button', {
          className: 'theia-button secondary afe-transcript-ai-btn',
          type: 'button',
          disabled: !!this.aiRunning,
          onClick: (event: React.MouseEvent) => { event.stopPropagation(); void this.runRetranscribeForSegment(idx); }
        }, this.aiRunning?.kind === 'retranscribe' && this.aiRunning.segmentIndex === idx
          ? nls.localize('ai-focused-editor/transcript/re-recognizing-busy', 'Recognizing…')
          : nls.localize('ai-focused-editor/transcript/re-recognize', 'Re-recognize'))),
      inSplitMode
        ? h('div', { className: 'afe-transcript-split-hint' },
          nls.localize('ai-focused-editor/transcript/split-hint', 'Split mode: move position on waveform, then press Apply.'))
        : undefined);
  }

  protected renderProofreadPanel(seg: TranscriptSegment, idx: number, proofread: NonNullable<ReturnType<typeof getSegmentProofread>>): React.ReactNode {
    const isStale = proofread.sourceText !== (seg.text || '');
    return h('div', { key: 'proofread', className: 'afe-transcript-ai-panel proofread', onClick: (event: React.MouseEvent) => event.stopPropagation() },
      h('div', { className: 'afe-transcript-ai-panel-head' },
        h('span', { className: 'afe-transcript-ai-panel-title' },
          nls.localize('ai-focused-editor/transcript/ai-proofread-title', 'AI proofread')),
        proofread.model ? h('span', { className: 'afe-transcript-ai-pill' }, proofread.model) : undefined,
        isStale
          ? h('span', { className: 'afe-transcript-ai-pill' },
            nls.localize('ai-focused-editor/transcript/outdated', 'Outdated'))
          : undefined),
      proofread.summary ? h('p', { className: 'afe-transcript-ai-summary' }, proofread.summary) : undefined,
      proofread.issues.length > 0
        ? h('div', { className: 'afe-transcript-ai-issues' },
          ...proofread.issues.slice(0, 5).map(issue => h('div', { key: issue.id, className: 'afe-transcript-ai-issue' },
            h('div', { className: 'afe-transcript-ai-issue-message' }, issue.message),
            issue.excerpt ? h('div', { className: 'afe-transcript-ai-issue-detail' }, `${nls.localize('ai-focused-editor/transcript/excerpt', 'Excerpt')}: ${issue.excerpt}`) : undefined,
            issue.suggestion ? h('div', { className: 'afe-transcript-ai-issue-detail' }, `${nls.localize('ai-focused-editor/transcript/suggestion', 'Suggestion')}: ${issue.suggestion}`) : undefined)))
        : undefined,
      proofread.correctedText && proofread.correctedText !== (seg.text || '')
        ? h('div', { className: 'afe-transcript-ai-result' },
          h('div', { className: 'afe-transcript-ai-corrected' }, proofread.correctedText),
          h('button', {
            className: 'theia-button',
            type: 'button',
            onClick: (event: React.MouseEvent) => { event.stopPropagation(); this.applyProofreadSuggestion(idx); }
          }, nls.localize('ai-focused-editor/transcript/apply-proofread', 'Apply proofread result')))
        : undefined);
  }

  protected renderTranscriptionPanel(seg: TranscriptSegment, idx: number, transcription: NonNullable<ReturnType<typeof getSegmentTranscription>>): React.ReactNode {
    const isStale = transcription.sourceText !== (seg.text || '');
    return h('div', { key: 'transcription', className: 'afe-transcript-ai-panel transcription', onClick: (event: React.MouseEvent) => event.stopPropagation() },
      h('div', { className: 'afe-transcript-ai-panel-head' },
        h('span', { className: 'afe-transcript-ai-panel-title' },
          nls.localize('ai-focused-editor/transcript/ai-recognition-title', 'Re-recognition')),
        transcription.model ? h('span', { className: 'afe-transcript-ai-pill' }, transcription.model) : undefined,
        isStale
          ? h('span', { className: 'afe-transcript-ai-pill' },
            nls.localize('ai-focused-editor/transcript/outdated', 'Outdated'))
          : undefined),
      transcription.suggestedText
        ? h('div', { className: 'afe-transcript-ai-result' },
          h('div', { className: 'afe-transcript-ai-corrected' }, transcription.suggestedText),
          transcription.suggestedText !== (seg.text || '')
            ? h('button', {
              className: 'theia-button',
              type: 'button',
              onClick: (event: React.MouseEvent) => { event.stopPropagation(); this.applyTranscriptionSuggestion(idx); }
            }, nls.localize('ai-focused-editor/transcript/apply-recognition', 'Apply recognition result'))
            : undefined)
        : h('p', { className: 'afe-transcript-ai-summary' },
          nls.localize('ai-focused-editor/transcript/no-recognition', 'No recognition result stored yet.')));
  }

  protected renderHistoryPanel(idx: number, history: SegmentHistoryEntry[]): React.ReactNode {
    return h('div', { key: 'history', className: 'afe-transcript-history', onClick: (event: React.MouseEvent) => event.stopPropagation() },
      h('div', { className: 'afe-transcript-history-head' },
        h('span', { className: 'afe-transcript-ai-panel-title' },
          nls.localize('ai-focused-editor/transcript/history-title', 'Block history')),
        h('span', { className: 'afe-transcript-history-count' },
          nls.localize('ai-focused-editor/transcript/history-versions', '{0} versions', history.length))),
      ...[...history].reverse().slice(0, 6).map(entry => h('div', { key: entry.id, className: 'afe-transcript-history-entry' },
        h('div', { className: 'afe-transcript-history-entry-head' },
          h('span', { className: 'afe-transcript-history-source' }, entry.source || 'manual'),
          h('button', {
            className: 'theia-button secondary afe-transcript-history-restore',
            type: 'button',
            onClick: (event: React.MouseEvent) => { event.stopPropagation(); this.restoreHistoryEntry(idx, entry); }
          }, nls.localize('ai-focused-editor/transcript/restore', 'Restore'))),
        h('div', { className: 'afe-transcript-history-date' }, entry.createdAt),
        entry.note ? h('div', { className: 'afe-transcript-history-note' }, entry.note) : undefined,
        h('div', { className: 'afe-transcript-history-text' },
          entry.text || nls.localize('ai-focused-editor/transcript/history-empty', 'Empty')))));
  }

  // RIGHT: clickable outline (WorkspaceInspector's document canvas).
  protected renderOutline(): React.ReactNode {
    const segments = this.segments;
    const activeIndex = this.activeSegmentIndex;
    return h('div', { className: 'afe-transcript-outline' },
      h('div', { className: 'afe-transcript-outline-header' },
        h('span', undefined, nls.localize('ai-focused-editor/transcript/outline-label', 'Outline')),
        h('span', { className: 'afe-transcript-outline-count' },
          nls.localize('ai-focused-editor/transcript/outline-blocks', '{0} blocks', segments.length))),
      h('div', { className: 'afe-transcript-outline-list' },
        ...segments.map((seg, idx) => h('button', {
          key: seg._id || idx,
          type: 'button',
          className: `afe-transcript-outline-item${idx === activeIndex ? ' is-active' : ''}`,
          onClick: () => this.jumpToSegmentIndex(idx, { seekInside: true })
        },
        h('div', { className: 'afe-transcript-outline-item-head' },
          h('span', undefined, `#${idx + 1}`),
          h('span', undefined, `${formatTime(seg.start)} - ${formatTime(seg.end)}`)),
        h('div', { className: 'afe-transcript-outline-item-text' },
          seg.text || nls.localize('ai-focused-editor/transcript/outline-empty', 'Empty segment'))))));
  }
}
