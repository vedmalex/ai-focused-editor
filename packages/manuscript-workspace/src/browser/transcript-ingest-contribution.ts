/**
 * The "Transcribe…" INGEST WIZARD — importing existing (legacy) transcriptions
 * into the book and running the media-transcription pipeline from the UI.
 *
 * One multi-step QuickInput wizard (command `ai-focused-editor.transcript.transcribe`):
 *
 *  STEP 1  what to do — IMPORT existing transcriptions | CREATE new transcription(s);
 *
 *  IMPORT  pick a folder → scan it with the pure `legacy-transcript-import`
 *          detector (one level down included) → pick which found sets →
 *          pick the FILE MODE (copy | move | reference in place) → execute:
 *          scaffold `transcription/<slug>/` + `sources/audio/<slug>/`, place
 *          the `time[…]` chunk media + `.json` transcripts, write
 *          `transcriptset.yaml` (with `sourceMedia`), REGENERATE `raw.md`
 *          from the imported segments via `generateRawMd` (the canonical
 *          projection — the legacy raw.md is never copied);
 *
 *  CREATE  pick one or more audio/video files → name the set → run the
 *          backend pipeline (`startPipeline`: convert → transcribe →
 *          normalize) with the `mediaTranscription.*` preferences, polling
 *          `pollJob` behind a CANCELABLE progress toast; the produced chunks
 *          land in `sources/audio/<slug>/`, the jsons in
 *          `transcription/<slug>/transcripts/`, the SOURCE media is NOT
 *          copied — its absolute path is recorded in the sidecar
 *          `sourceMedia` field (owner decision).
 *
 * FILE MODES (owner decision — all three offered):
 *  - copy       chunk media + json are COPIED into the book;
 *  - move       chunk media + json are MOVED into the book (the legacy source
 *               media file itself always stays in place — only `sourceMedia`
 *               records it);
 *  - reference  only the small `.json` transcripts are copied; the audio stays
 *               EXTERNAL (recorded via `sourceMedia`) — the editor's media
 *               loading is workspace-relative, so playback/waveform is
 *               unavailable until the audio is copied in (stated in the
 *               completion message).
 *
 * When MULTIPLE media files are picked for a NEW transcription, ONE SET PER
 * FILE is created (a set models ONE recording — chunk offsets are per-file
 * and would interleave in raw.md otherwise); the entered name goes to the
 * first set, the rest derive from their file names.
 *
 * PROGRAMMATIC INVOCATION (tests / probes): the command accepts a
 * {@link TranscribeWizardArgs} object that pre-answers any wizard step.
 */

import {
  Command,
  CommandContribution,
  CommandRegistry,
  MenuContribution,
  MenuModelRegistry,
  MessageService,
  QuickInputService,
  QuickPickItem
} from '@theia/core/lib/common';
import URI from '@theia/core/lib/common/uri';
import { nls } from '@theia/core/lib/common/nls';
import { PreferenceService } from '@theia/core/lib/common/preferences';
import { inject, injectable } from '@theia/core/shared/inversify';
import { open, OpenerService, WidgetManager } from '@theia/core/lib/browser';
import { FileDialogService } from '@theia/filesystem/lib/browser';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import {
  AUDIO_SOURCES_AREA,
  AudioConversionService,
  DEFAULT_MEDIA_EXTENSIONS,
  LegacyImportPlan,
  MediaPipelineFileResult,
  MediaPipelineJobState,
  MediaPipelineProgressEvent,
  MediaPipelineRequest,
  MediaTranscriptionDoctorRequest,
  RawMdSourceFile,
  ScannedDirectory,
  TRANSCRIPTION_AREA,
  TranscriptionOptions,
  appendGitignoreEntry,
  buildTranscriptsetSkeleton,
  detectLegacyTranscriptSets,
  generateRawMd,
  legacySetSlug,
  normalizeWhisperJson,
  parseOffsetFromFilename,
  rawMdRelPath,
  transcriptSetFolder,
  transcriptSetFolders,
  transcriptsetRelPath,
  writeTranscriptsetYaml
} from '../common';
import { getBaseName } from '../common/proofreading-model';
import { createSemanticEntityId, uniqueRelativePath } from '../common/entity-creation';
import {
  MEDIA_TRANSCRIPTION_BACKEND,
  MEDIA_TRANSCRIPTION_FFMPEG_PATH,
  MEDIA_TRANSCRIPTION_FFPROBE_PATH,
  MEDIA_TRANSCRIPTION_GROQ_API_KEY,
  MEDIA_TRANSCRIPTION_GROQ_MODEL,
  MEDIA_TRANSCRIPTION_LANGUAGE,
  MEDIA_TRANSCRIPTION_MODEL_PATH,
  MEDIA_TRANSCRIPTION_SEGMENT_SECONDS,
  MEDIA_TRANSCRIPTION_THREADS,
  MEDIA_TRANSCRIPTION_WHISPER_CLI_PATH
} from './ai-focused-editor-preferences';
import { ManuscriptTreeWidget } from './manuscript-tree-widget';
import { AFE_MANUSCRIPT_SECTION_CONTEXT_KEY } from './manuscript-tree';
import { AiFocusedEditorMenus } from './ai-focused-editor-menu';

const CATEGORY = 'AI Focused Editor';

export namespace TranscriptIngestCommands {
  export const TRANSCRIBE: Command = Command.toLocalizedCommand(
    { id: 'ai-focused-editor.transcript.transcribe', category: CATEGORY, label: 'Transcribe...' },
    'ai-focused-editor/transcript/transcribe',
    'ai-focused-editor/create/category'
  );
}

/** How imported legacy files reach the book. */
export type LegacyImportFileMode = 'copy' | 'move' | 'reference';

/** Programmatic answers for the wizard steps (tests / probes / power users). */
export interface TranscribeWizardArgs {
  mode?: 'import' | 'new';
  /** IMPORT: absolute path (or file URI string) of the folder to scan. */
  importFolder?: string;
  /** IMPORT: also scan one level down. Default true. */
  scanChildDirectories?: boolean;
  /** IMPORT: skip the set multi-pick and import every found set. */
  selectAllSets?: boolean;
  /** IMPORT: the file mode (copy | move | reference). */
  fileMode?: LegacyImportFileMode;
  /** CREATE: absolute paths of the media files (skips the file dialog). */
  inputFiles?: string[];
  /** CREATE: the set name (skips the name prompt). */
  setName?: string;
}

interface ImportedSetOutcome {
  slug: string;
  sidecarUri: URI;
  importedMedia: number;
  importedJson: number;
  problems: string[];
}

const POLL_INTERVAL_MS = 800;
const MAX_POLL_FAILURES = 5;

@injectable()
export class TranscriptIngestContribution implements CommandContribution, MenuContribution {
  @inject(QuickInputService)
  protected readonly quickInput!: QuickInputService;

  @inject(MessageService)
  protected readonly messages!: MessageService;

  @inject(FileService)
  protected readonly fileService!: FileService;

  @inject(FileDialogService)
  protected readonly fileDialogService!: FileDialogService;

  @inject(WorkspaceService)
  protected readonly workspaceService!: WorkspaceService;

  @inject(OpenerService)
  protected readonly openerService!: OpenerService;

  @inject(WidgetManager)
  protected readonly widgetManager!: WidgetManager;

  @inject(PreferenceService)
  protected readonly preferences!: PreferenceService;

  @inject(AudioConversionService)
  protected readonly audioConversion!: AudioConversionService;

  registerCommands(commands: CommandRegistry): void {
    commands.registerCommand(TranscriptIngestCommands.TRANSCRIBE, {
      execute: (args?: unknown) => this.runWizard(isWizardArgs(args) ? args : undefined),
      isEnabled: () => this.workspaceService.tryGetRoots().length > 0
    });
  }

  registerMenus(menus: MenuModelRegistry): void {
    // Tree context menu on the Transcription section (and empty selection) +
    // the product Manuscript menu — the same groups the create actions use.
    menus.registerMenuAction([...ManuscriptTreeWidget.CONTEXT_MENU, '1_create'], {
      commandId: TranscriptIngestCommands.TRANSCRIBE.id,
      order: '98',
      when: `${AFE_MANUSCRIPT_SECTION_CONTEXT_KEY} == 'none' || ${AFE_MANUSCRIPT_SECTION_CONTEXT_KEY} == 'transcription'`
    });
    menus.registerMenuAction([...AiFocusedEditorMenus.MAIN, '1a_create'], {
      commandId: TranscriptIngestCommands.TRANSCRIBE.id,
      order: '98'
    });
  }

  /* ---------------------------------------------------------------------- *
   * The wizard
   * ---------------------------------------------------------------------- */

  protected async runWizard(args: TranscribeWizardArgs = {}): Promise<void> {
    const root = await this.getRoot();
    if (!root) {
      this.messages.warn(nls.localize(
        'ai-focused-editor/transcript/transcribe-no-workspace',
        'Open a manuscript workspace before transcribing.'
      ));
      return;
    }

    let mode = args.mode;
    if (!mode) {
      interface ModePick extends QuickPickItem {
        mode: 'import' | 'new';
      }
      const picks: ModePick[] = [
        {
          label: nls.localize('ai-focused-editor/transcript/wizard-import', 'Import existing transcriptions'),
          description: nls.localize(
            'ai-focused-editor/transcript/wizard-import-detail',
            'Scan a folder for legacy time[…] chunk transcriptions and bring them into the book'
          ),
          mode: 'import'
        },
        {
          label: nls.localize('ai-focused-editor/transcript/wizard-new', 'Create new transcription(s)'),
          description: nls.localize(
            'ai-focused-editor/transcript/wizard-new-detail',
            'Pick audio/video files and run the conversion + speech-to-text pipeline'
          ),
          mode: 'new'
        }
      ];
      const picked = await this.quickInput.showQuickPick(picks, {
        title: nls.localize('ai-focused-editor/transcript/wizard-title', 'Transcribe'),
        placeholder: nls.localize('ai-focused-editor/transcript/wizard-placeholder', 'What would you like to do?')
      });
      mode = picked?.mode;
    }
    if (!mode) {
      return;
    }

    try {
      if (mode === 'import') {
        await this.runImportBranch(root, args);
      } else {
        await this.runNewTranscriptionBranch(root, args);
      }
    } catch (error) {
      this.messages.error(nls.localize(
        'ai-focused-editor/transcript/transcribe-failed',
        'Transcribe failed: {0}',
        this.detail(error)
      ));
    }
  }

  /* ---------------------------------------------------------------------- *
   * IMPORT branch
   * ---------------------------------------------------------------------- */

  protected async runImportBranch(root: URI, args: TranscribeWizardArgs): Promise<void> {
    // STEP: pick the folder to scan.
    let folderUri: URI | undefined;
    if (args.importFolder) {
      folderUri = args.importFolder.startsWith('file://')
        ? new URI(args.importFolder)
        : root.withPath(args.importFolder);
    } else {
      const selected = await this.fileDialogService.showOpenDialog({
        title: nls.localize('ai-focused-editor/transcript/import-pick-folder', 'Import Transcriptions: Pick a Folder'),
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false
      });
      folderUri = Array.isArray(selected) ? selected[0] : selected;
    }
    if (!folderUri) {
      return;
    }

    // Importing from the book's own transcript areas would import a set into
    // itself — refuse with a clear message.
    const transcriptionArea = root.resolve(TRANSCRIPTION_AREA);
    const audioArea = root.resolve(AUDIO_SOURCES_AREA);
    if (transcriptionArea.isEqualOrParent(folderUri) || audioArea.isEqualOrParent(folderUri)) {
      this.messages.warn(nls.localize(
        'ai-focused-editor/transcript/import-inside-book',
        'This folder is already part of the book\'s transcription areas ({0}/, {1}/) — pick the external folder that holds the legacy transcriptions.',
        TRANSCRIPTION_AREA,
        AUDIO_SOURCES_AREA
      ));
      return;
    }

    // STEP: scan (the chosen folder + one level down).
    const listing = await this.scanDirectory(folderUri, 2);
    const plans = detectLegacyTranscriptSets(listing, {
      scanChildDirectories: args.scanChildDirectories !== false
    });
    if (plans.length === 0) {
      this.messages.info(nls.localize(
        'ai-focused-editor/transcript/import-none-found',
        'No legacy transcriptions found in "{0}". Expected: a media file with a sibling folder (spaces as underscores) holding time[…] audio + json pairs, or such a chunk folder directly.',
        folderUri.path.base || folderUri.path.toString()
      ));
      return;
    }

    // STEP: pick which sets (multi-pick when several were found).
    let chosen: LegacyImportPlan[];
    if (plans.length === 1 || args.selectAllSets) {
      chosen = plans;
    } else {
      chosen = await this.pickSets(plans);
    }
    if (chosen.length === 0) {
      return;
    }

    // STEP: pick the file mode.
    const fileMode = args.fileMode ?? await this.pickFileMode();
    if (!fileMode) {
      return;
    }

    // EXECUTE.
    const outcomes: ImportedSetOutcome[] = [];
    for (const plan of chosen) {
      outcomes.push(await this.importLegacySet(root, plan, fileMode));
    }
    await this.ensureAudioAreaGitignored(root);
    await this.refreshTree();

    const problems = outcomes.flatMap(outcome => outcome.problems);
    for (const problem of problems.slice(0, 5)) {
      this.messages.warn(problem);
    }
    const first = outcomes[0];
    if (first) {
      await this.openSet(first.sidecarUri);
    }
    const summary = nls.localize(
      'ai-focused-editor/transcript/import-done',
      'Imported {0} transcript set(s): {1}.',
      String(outcomes.length),
      outcomes.map(outcome => outcome.slug).join(', ')
    );
    if (fileMode === 'reference') {
      this.messages.info(`${summary} ${nls.localize(
        'ai-focused-editor/transcript/import-reference-note',
        'The audio files stay in their original folder (recorded in the sidecar sourceMedia); playback and waveforms are unavailable until the audio is copied into the book.'
      )}`);
    } else {
      this.messages.info(summary);
    }
  }

  /** Multi-pick over the found sets via a canSelectMany QuickPick (all preselected). */
  protected pickSets(plans: LegacyImportPlan[]): Promise<LegacyImportPlan[]> {
    interface SetPick extends QuickPickItem {
      plan: LegacyImportPlan;
    }
    return new Promise<LegacyImportPlan[]>(resolvePicks => {
      const picker = this.quickInput.createQuickPick<SetPick>();
      picker.title = nls.localize('ai-focused-editor/transcript/import-pick-sets', 'Import Transcriptions: Found Sets');
      picker.placeholder = nls.localize(
        'ai-focused-editor/transcript/import-pick-sets-placeholder',
        'Select the sets to import (Space toggles, Enter confirms)'
      );
      picker.canSelectMany = true;
      const items: SetPick[] = plans.map(plan => ({
        label: plan.displayName,
        description: nls.localize(
          'ai-focused-editor/transcript/import-set-description',
          '{0} chunk(s){1}',
          String(plan.pairs.length),
          plan.warnings.length > 0 ? ` — ${plan.warnings.length} warning(s)` : ''
        ),
        plan
      }));
      picker.items = items;
      picker.selectedItems = items;
      let done = false;
      picker.onDidAccept(() => {
        done = true;
        const selection = picker.selectedItems.map(item => item.plan);
        picker.hide();
        resolvePicks(selection);
      });
      picker.onDidHide(() => {
        if (!done) {
          resolvePicks([]);
        }
      });
      picker.show();
    });
  }

  /** Quick-pick the file mode: copy | move | reference in place. */
  protected async pickFileMode(): Promise<LegacyImportFileMode | undefined> {
    interface ModePick extends QuickPickItem {
      fileMode: LegacyImportFileMode;
    }
    const picks: ModePick[] = [
      {
        label: nls.localize('ai-focused-editor/transcript/file-mode-copy', 'Copy into the book'),
        description: nls.localize(
          'ai-focused-editor/transcript/file-mode-copy-detail',
          'Audio chunks and transcripts are copied; the original folder stays untouched'
        ),
        fileMode: 'copy'
      },
      {
        label: nls.localize('ai-focused-editor/transcript/file-mode-move', 'Move into the book'),
        description: nls.localize(
          'ai-focused-editor/transcript/file-mode-move-detail',
          'Audio chunks and transcripts are moved out of the original folder'
        ),
        fileMode: 'move'
      },
      {
        label: nls.localize('ai-focused-editor/transcript/file-mode-reference', 'Reference in place'),
        description: nls.localize(
          'ai-focused-editor/transcript/file-mode-reference-detail',
          'Only the small transcript jsons are copied; the audio stays external (no playback until copied)'
        ),
        fileMode: 'reference'
      }
    ];
    const picked = await this.quickInput.showQuickPick(picks, {
      title: nls.localize('ai-focused-editor/transcript/file-mode-title', 'Import Transcriptions: File Mode'),
      placeholder: nls.localize('ai-focused-editor/transcript/file-mode-placeholder', 'How should the legacy files reach the book?')
    });
    return picked?.fileMode;
  }

  /** Execute ONE legacy-set import plan. Never throws — problems are collected. */
  protected async importLegacySet(root: URI, plan: LegacyImportPlan, fileMode: LegacyImportFileMode): Promise<ImportedSetOutcome> {
    const problems: string[] = [];

    // Unique slug within transcription/.
    const existing = await this.collectExistingRelPaths(root, TRANSCRIPTION_AREA);
    const relFolder = uniqueRelativePath(transcriptSetFolder(plan.slug), candidate => existing.has(candidate));
    const slug = relFolder.slice(relFolder.lastIndexOf('/') + 1);
    const folders = transcriptSetFolders(slug);

    await this.ensureFolder(root.resolve(TRANSCRIPTION_AREA));
    await this.ensureFolder(root.resolve('sources'));
    await this.ensureFolder(root.resolve(AUDIO_SOURCES_AREA));
    await this.ensureFolder(root.resolve(folders.audioFolder));
    await this.ensureFolder(root.resolve(relFolder));
    await this.ensureFolder(root.resolve(folders.transcriptFolder));

    const chunkDirUri = root.withPath(plan.chunkDir);
    let importedMedia = 0;
    let importedJson = 0;
    const importedMediaNames: string[] = [];

    for (const pair of plan.pairs) {
      if (pair.mediaName && fileMode !== 'reference') {
        const source = chunkDirUri.resolve(pair.mediaName);
        const target = root.resolve(`${folders.audioFolder}/${pair.mediaName}`);
        try {
          if (fileMode === 'move') {
            await this.fileService.move(source, target, { overwrite: true });
          } else {
            await this.fileService.copy(source, target, { overwrite: true });
          }
          importedMedia++;
          importedMediaNames.push(pair.mediaName);
        } catch (error) {
          problems.push(nls.localize(
            'ai-focused-editor/transcript/import-media-failed',
            'Could not import audio chunk {0}: {1}',
            pair.mediaName,
            this.detail(error)
          ));
        }
      } else if (pair.mediaName) {
        importedMediaNames.push(pair.mediaName);
      }
      if (pair.jsonName) {
        const source = chunkDirUri.resolve(pair.jsonName);
        const target = root.resolve(`${folders.transcriptFolder}/${pair.jsonName}`);
        try {
          if (fileMode === 'move') {
            await this.fileService.move(source, target, { overwrite: true });
          } else {
            await this.fileService.copy(source, target, { overwrite: true });
          }
          importedJson++;
        } catch (error) {
          problems.push(nls.localize(
            'ai-focused-editor/transcript/import-json-failed',
            'Could not import transcript {0}: {1}',
            pair.jsonName,
            this.detail(error)
          ));
        }
      }
    }

    // Regenerate raw.md from the imported segments + detect the STT language.
    const { rawMdText, language } = await this.buildRawMdFromTranscripts(root, folders.transcriptFolder);
    try {
      await this.fileService.write(root.resolve(rawMdRelPath(slug)), rawMdText);
    } catch (error) {
      problems.push(nls.localize(
        'ai-focused-editor/transcript/import-raw-md-failed',
        'Could not generate raw.md for "{0}": {1}',
        slug,
        this.detail(error)
      ));
    }

    // Sidecar with sourceMedia: the source media file when known; for a
    // reference import without one, the external chunk dir itself.
    const sourceMedia = plan.sourceMediaPath ?? (fileMode === 'reference' ? plan.chunkDir : undefined);
    const set = buildTranscriptsetSkeleton({
      slug,
      mediaNames: importedMediaNames,
      language,
      sourceMedia
    });
    const sidecarUri = root.resolve(transcriptsetRelPath(slug));
    try {
      await this.fileService.write(sidecarUri, writeTranscriptsetYaml(undefined, set));
    } catch (error) {
      problems.push(nls.localize(
        'ai-focused-editor/transcript/import-sidecar-failed',
        'Could not write transcriptset.yaml for "{0}": {1}',
        slug,
        this.detail(error)
      ));
    }

    return { slug, sidecarUri, importedMedia, importedJson, problems };
  }

  /* ---------------------------------------------------------------------- *
   * CREATE (new transcription) branch
   * ---------------------------------------------------------------------- */

  protected async runNewTranscriptionBranch(root: URI, args: TranscribeWizardArgs): Promise<void> {
    // STEP: pick the media files.
    let inputUris: URI[];
    if (args.inputFiles && args.inputFiles.length > 0) {
      inputUris = args.inputFiles.map(path => path.startsWith('file://') ? new URI(path) : root.withPath(path));
    } else {
      const selected = await this.fileDialogService.showOpenDialog({
        title: nls.localize('ai-focused-editor/transcript/new-pick-media', 'Transcribe: Pick Audio/Video Files'),
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: true
      });
      inputUris = Array.isArray(selected) ? selected : selected ? [selected] : [];
    }
    const mediaUris = inputUris.filter(uri =>
      DEFAULT_MEDIA_EXTENSIONS.some(ext => uri.path.toString().toLowerCase().endsWith(ext)));
    if (mediaUris.length === 0) {
      if (inputUris.length > 0) {
        this.messages.warn(nls.localize(
          'ai-focused-editor/transcript/new-no-media',
          'None of the selected files is a supported audio/video file ({0}).',
          DEFAULT_MEDIA_EXTENSIONS.join(', ')
        ));
      }
      return;
    }

    // STEP: set name (default from the first file).
    const defaultName = getBaseName(mediaUris[0].path.base);
    let setName = args.setName?.trim();
    if (!setName) {
      const name = await this.quickInput.input({
        title: nls.localize('ai-focused-editor/transcript/new-name-title', 'Transcribe: Set Name'),
        prompt: nls.localize('ai-focused-editor/transcript/new-name-prompt', 'Transcript set name'),
        value: defaultName,
        validateInput: async value => (value.trim()
          ? undefined
          : nls.localize('ai-focused-editor/transcript/new-set-empty', 'Transcript set name cannot be empty.'))
      });
      setName = name?.trim();
    }
    if (!setName) {
      return;
    }

    // Toolchain sanity check first — a clear doctor report beats a mid-run failure.
    const transcription = this.readTranscriptionOptions();
    const configError = this.validateTranscriptionOptions(transcription);
    if (configError) {
      this.messages.error(configError);
      return;
    }
    try {
      const report = await this.audioConversion.doctor(this.buildDoctorRequest(transcription));
      const failed = report.checks.filter(check => !check.ok);
      if (!report.ok) {
        this.messages.error(nls.localize(
          'ai-focused-editor/transcript/new-doctor-failed',
          'The transcription toolchain is not ready: {0}',
          failed.map(check => `${check.label} — ${check.advice ?? check.detail}`).join('; ')
        ));
        return;
      }
    } catch (error) {
      this.messages.error(nls.localize(
        'ai-focused-editor/transcript/new-doctor-error',
        'Could not check the transcription toolchain: {0}',
        this.detail(error)
      ));
      return;
    }

    // One set per media file (a set models ONE recording): the entered name
    // names the first set, the rest derive from their file names.
    const existing = await this.collectExistingRelPaths(root, TRANSCRIPTION_AREA);
    const sets: { inputUri: URI; slug: string }[] = [];
    for (let index = 0; index < mediaUris.length; index++) {
      const baseName = index === 0 ? setName : getBaseName(mediaUris[index].path.base);
      const idSlug = createSemanticEntityId('transcriptset', baseName) || legacySetSlug(baseName);
      const relFolder = uniqueRelativePath(transcriptSetFolder(idSlug), candidate => existing.has(candidate));
      existing.add(relFolder);
      sets.push({ inputUri: mediaUris[index], slug: relFolder.slice(relFolder.lastIndexOf('/') + 1) });
    }

    // Run the pipeline into a staging folder, then distribute into our layout.
    const stagingRel = `${TRANSCRIPTION_AREA}/.pipeline-${Date.now().toString(36)}`;
    const stagingUri = root.resolve(stagingRel);
    const request: MediaPipelineRequest = {
      inputFiles: mediaUris.map(uri => uri.path.toString()),
      conversion: {
        outputDirectory: stagingUri.path.toString(),
        segmentSeconds: this.preferences.get<number>(MEDIA_TRANSCRIPTION_SEGMENT_SECONDS, 600),
        audioFormat: 'mp3',
        skipExisting: false,
        ffmpegPath: (this.preferences.get<string>(MEDIA_TRANSCRIPTION_FFMPEG_PATH, '') || '').trim() || undefined,
        ffprobePath: (this.preferences.get<string>(MEDIA_TRANSCRIPTION_FFPROBE_PATH, '') || '').trim() || undefined
      },
      transcription,
      generateRawMd: false // the editor regenerates its own canonical raw.md below
    };

    let finalState: MediaPipelineJobState | undefined;
    try {
      finalState = await this.runPipelineWithProgress(request);
    } finally {
      if (!finalState || finalState.status !== 'completed') {
        await this.deleteIfExists(stagingUri);
      }
    }
    if (!finalState) {
      return;
    }
    if (finalState.status === 'cancelled') {
      this.messages.info(nls.localize('ai-focused-editor/transcript/new-cancelled', 'Transcription cancelled.'));
      return;
    }
    if (finalState.status !== 'completed') {
      this.messages.error(nls.localize(
        'ai-focused-editor/transcript/new-pipeline-failed',
        'The transcription pipeline failed: {0}',
        finalState.error ?? 'unknown error'
      ));
      return;
    }

    // Distribute the produced chunks + jsons into each file's set.
    const outcomes: ImportedSetOutcome[] = [];
    const results = finalState.results ?? [];
    for (const { inputUri, slug } of sets) {
      const result = results.find(candidate => candidate.inputFile === inputUri.path.toString());
      if (!result) {
        this.messages.warn(nls.localize(
          'ai-focused-editor/transcript/new-no-result',
          'The pipeline produced no result for {0}.',
          inputUri.path.base
        ));
        continue;
      }
      if (result.error) {
        this.messages.warn(nls.localize(
          'ai-focused-editor/transcript/new-file-failed',
          '{0}: {1}',
          inputUri.path.base,
          result.error
        ));
      }
      outcomes.push(await this.adoptPipelineResult(root, slug, inputUri, result));
    }
    await this.deleteIfExists(stagingUri);
    await this.ensureAudioAreaGitignored(root);
    await this.refreshTree();

    const first = outcomes[0];
    if (first) {
      await this.openSet(first.sidecarUri);
    }
    if (outcomes.length > 0) {
      this.messages.info(nls.localize(
        'ai-focused-editor/transcript/new-done',
        'Transcribed {0} file(s) into set(s): {1}.',
        String(outcomes.length),
        outcomes.map(outcome => outcome.slug).join(', ')
      ));
    }
  }

  /** Move one pipeline file-result's chunks + jsons into the set's folders. */
  protected async adoptPipelineResult(
    root: URI,
    slug: string,
    inputUri: URI,
    result: MediaPipelineFileResult
  ): Promise<ImportedSetOutcome> {
    const problems: string[] = [];
    const folders = transcriptSetFolders(slug);
    await this.ensureFolder(root.resolve(TRANSCRIPTION_AREA));
    await this.ensureFolder(root.resolve('sources'));
    await this.ensureFolder(root.resolve(AUDIO_SOURCES_AREA));
    await this.ensureFolder(root.resolve(folders.audioFolder));
    await this.ensureFolder(root.resolve(transcriptSetFolder(slug)));
    await this.ensureFolder(root.resolve(folders.transcriptFolder));

    const mediaNames: string[] = [];
    let importedMedia = 0;
    for (const segment of result.segments) {
      const name = segment.path.split('/').pop() ?? segment.path;
      try {
        await this.fileService.move(root.withPath(segment.path), root.resolve(`${folders.audioFolder}/${name}`), { overwrite: true });
        mediaNames.push(name);
        importedMedia++;
      } catch (error) {
        problems.push(nls.localize(
          'ai-focused-editor/transcript/new-move-media-failed',
          'Could not place audio chunk {0}: {1}',
          name,
          this.detail(error)
        ));
      }
    }
    let importedJson = 0;
    for (const transcript of result.transcripts) {
      const name = transcript.split('/').pop() ?? transcript;
      try {
        await this.fileService.move(root.withPath(transcript), root.resolve(`${folders.transcriptFolder}/${name}`), { overwrite: true });
        importedJson++;
      } catch (error) {
        problems.push(nls.localize(
          'ai-focused-editor/transcript/new-move-json-failed',
          'Could not place transcript {0}: {1}',
          name,
          this.detail(error)
        ));
      }
    }

    const { rawMdText, language } = await this.buildRawMdFromTranscripts(root, folders.transcriptFolder);
    try {
      await this.fileService.write(root.resolve(rawMdRelPath(slug)), rawMdText);
    } catch (error) {
      problems.push(nls.localize(
        'ai-focused-editor/transcript/import-raw-md-failed',
        'Could not generate raw.md for "{0}": {1}',
        slug,
        this.detail(error)
      ));
    }

    // OWNER DECISION: the source media is NOT copied — its absolute path is
    // recorded in the sidecar for information / re-runs.
    const set = buildTranscriptsetSkeleton({
      slug,
      mediaNames,
      language,
      sourceMedia: inputUri.path.toString()
    });
    const sidecarUri = root.resolve(transcriptsetRelPath(slug));
    try {
      await this.fileService.write(sidecarUri, writeTranscriptsetYaml(undefined, set));
    } catch (error) {
      problems.push(nls.localize(
        'ai-focused-editor/transcript/import-sidecar-failed',
        'Could not write transcriptset.yaml for "{0}": {1}',
        slug,
        this.detail(error)
      ));
    }
    for (const problem of problems.slice(0, 5)) {
      this.messages.warn(problem);
    }
    return { slug, sidecarUri, importedMedia, importedJson, problems };
  }

  /** Start the pipeline and poll it behind a cancelable progress toast. */
  protected async runPipelineWithProgress(request: MediaPipelineRequest): Promise<MediaPipelineJobState | undefined> {
    let jobId: string;
    try {
      ({ jobId } = await this.audioConversion.startPipeline(request));
    } catch (error) {
      this.messages.error(nls.localize(
        'ai-focused-editor/transcript/new-start-failed',
        'Could not start the transcription pipeline: {0}',
        this.detail(error)
      ));
      return undefined;
    }

    let cancelled = false;
    const progress = await this.messages.showProgress(
      {
        text: nls.localize('ai-focused-editor/transcript/new-progress', 'Transcribing media...'),
        options: { cancelable: true }
      },
      () => {
        cancelled = true;
        this.audioConversion.cancelJob(jobId).catch(() => undefined);
      }
    );

    try {
      let sinceSeq = 0;
      let pollFailures = 0;
      // Poll until the job leaves `running`; the loop never blocks the UI.
      for (;;) {
        await new Promise(resolveSleep => setTimeout(resolveSleep, POLL_INTERVAL_MS));
        let state: MediaPipelineJobState;
        try {
          state = await this.audioConversion.pollJob(jobId, sinceSeq);
          pollFailures = 0;
        } catch (error) {
          if (++pollFailures >= MAX_POLL_FAILURES) {
            this.messages.error(nls.localize(
              'ai-focused-editor/transcript/new-poll-failed',
              'Lost contact with the transcription job: {0}',
              this.detail(error)
            ));
            return undefined;
          }
          continue;
        }
        sinceSeq = state.nextSeq;
        const message = this.describeProgress(state.events);
        if (message) {
          progress.report({ message });
        }
        if (state.status !== 'running') {
          return state;
        }
        if (cancelled) {
          // Keep polling: the backend flips the job to `cancelled` after the
          // active child process dies.
          continue;
        }
      }
    } finally {
      progress.cancel();
    }
  }

  /** Human progress line from the newest useful pipeline events. */
  protected describeProgress(events: MediaPipelineProgressEvent[]): string | undefined {
    for (let index = events.length - 1; index >= 0; index--) {
      const event = events[index];
      if (event.kind === 'segment-start' || event.kind === 'segment-end') {
        const stage = event.stage === 'transcribe'
          ? nls.localize('ai-focused-editor/transcript/new-stage-transcribe', 'Recognizing')
          : nls.localize('ai-focused-editor/transcript/new-stage-convert', 'Converting');
        const counts = event.index !== undefined && event.total !== undefined ? ` ${event.index}/${event.total}` : '';
        return `${stage}${counts}${event.file ? ` — ${event.file.split('/').pop()}` : ''}`;
      }
      if (event.kind === 'stage-start' && event.stage) {
        return event.stage;
      }
      if (event.kind === 'file-start' && event.file) {
        return event.file.split('/').pop();
      }
    }
    return undefined;
  }

  /* ---------------------------------------------------------------------- *
   * Shared helpers
   * ---------------------------------------------------------------------- */

  /**
   * Read every `<base>.json` under `transcriptFolder`, normalize it and build
   * the canonical `raw.md` text via {@link generateRawMd} (no speakers yet on a
   * fresh import). Also derives the set language from the first transcript
   * that reports one. Unreadable jsons are skipped.
   */
  protected async buildRawMdFromTranscripts(
    root: URI,
    transcriptFolder: string
  ): Promise<{ rawMdText: string; language?: string }> {
    const folderUri = root.resolve(transcriptFolder);
    const stat = await this.fileService.resolve(folderUri).catch(() => undefined);
    const files: RawMdSourceFile[] = [];
    let language: string | undefined;
    for (const child of stat?.children ?? []) {
      if (child.isDirectory || !child.name.toLowerCase().endsWith('.json')) {
        continue;
      }
      try {
        const text = (await this.fileService.read(child.resource)).value;
        const normalized = normalizeWhisperJson(JSON.parse(text));
        const base = getBaseName(child.name);
        // NormalizedTranscriptionSegment is structurally a TranscriptSegment
        // ({start, end, text} + known extras) — only the index signature differs.
        const segments = normalized.segments.map(segment => ({ ...segment }));
        files.push({ name: base, offsetMs: parseOffsetFromFilename(base), segments });
        if (!language && normalized.language && normalized.language !== 'auto') {
          language = normalized.language;
        }
      } catch {
        // Unreadable / non-JSON transcript — raw.md simply omits it.
      }
    }
    return { rawMdText: generateRawMd(files, []), language };
  }

  /** Recursively list a directory into the pure detector's input shape. */
  protected async scanDirectory(uri: URI, depth: number): Promise<ScannedDirectory> {
    const stat = await this.fileService.resolve(uri).catch(() => undefined);
    const files: string[] = [];
    const directories: ScannedDirectory[] = [];
    for (const child of stat?.children ?? []) {
      if (child.isDirectory) {
        if (depth > 0) {
          directories.push(await this.scanDirectory(child.resource, depth - 1));
        }
      } else {
        files.push(child.name);
      }
    }
    return { path: uri.path.toString(), name: uri.path.base, files, directories };
  }

  /** Project the `mediaTranscription.*` preferences into {@link TranscriptionOptions}. */
  protected readTranscriptionOptions(): TranscriptionOptions {
    const backend = this.preferences.get<string>(MEDIA_TRANSCRIPTION_BACKEND, 'local') === 'groq' ? 'groq' : 'local';
    const language = (this.preferences.get<string>(MEDIA_TRANSCRIPTION_LANGUAGE, '') || '').trim();
    const groqApiKey = (this.preferences.get<string>(MEDIA_TRANSCRIPTION_GROQ_API_KEY, '') || '').trim();
    const options: TranscriptionOptions = {
      backend,
      whisperCliPath: (this.preferences.get<string>(MEDIA_TRANSCRIPTION_WHISPER_CLI_PATH, '') || '').trim(),
      modelPath: (this.preferences.get<string>(MEDIA_TRANSCRIPTION_MODEL_PATH, '') || '').trim(),
      threads: this.preferences.get<number>(MEDIA_TRANSCRIPTION_THREADS, 8),
      groqModel: (this.preferences.get<string>(MEDIA_TRANSCRIPTION_GROQ_MODEL, '') || '').trim() || undefined,
      groqApiKeys: groqApiKey ? [groqApiKey] : [],
      skipExisting: false
    };
    if (language) {
      options.language = language;
    }
    return options;
  }

  /** A friendly not-configured message, or undefined when the backend can run. */
  protected validateTranscriptionOptions(options: TranscriptionOptions): string | undefined {
    if (options.backend === 'groq') {
      if (!options.groqApiKeys || options.groqApiKeys.length === 0) {
        return nls.localize(
          'ai-focused-editor/transcript/ai-groq-not-configured',
          'The Groq STT backend is not configured — set mediaTranscription.groqApiKey in Settings (get a key at console.groq.com).'
        );
      }
      return undefined;
    }
    if (!options.whisperCliPath || !options.modelPath) {
      return nls.localize(
        'ai-focused-editor/transcript/ai-local-stt-not-configured',
        'The local STT backend is not configured — set mediaTranscription.whisperCliPath and mediaTranscription.modelPath in Settings (or switch mediaTranscription.backend to "groq").'
      );
    }
    return undefined;
  }

  protected buildDoctorRequest(options: TranscriptionOptions): MediaTranscriptionDoctorRequest {
    return {
      backend: options.backend,
      ffmpegPath: (this.preferences.get<string>(MEDIA_TRANSCRIPTION_FFMPEG_PATH, '') || '').trim() || undefined,
      ffprobePath: (this.preferences.get<string>(MEDIA_TRANSCRIPTION_FFPROBE_PATH, '') || '').trim() || undefined,
      whisperCliPath: options.whisperCliPath || undefined,
      modelPath: options.modelPath || undefined,
      groqApiKeys: options.groqApiKeys
    };
  }

  /** Idempotently append `sources/audio/` to the book `.gitignore` (never blocks). */
  protected async ensureAudioAreaGitignored(root: URI): Promise<void> {
    const gitignoreUri = root.resolve('.gitignore');
    try {
      const existing = await this.readTextIfExists(gitignoreUri);
      const result = appendGitignoreEntry(
        existing,
        `${AUDIO_SOURCES_AREA}/`,
        'Transcript media (audio/video) — heavy files, kept out of git'
      );
      if (result.added) {
        await this.fileService.write(gitignoreUri, result.text);
      }
    } catch (error) {
      this.messages.warn(nls.localize(
        'ai-focused-editor/transcript/gitignore-failed',
        'Could not update .gitignore: {0}',
        this.detail(error)
      ));
    }
  }

  protected async openSet(sidecarUri: URI): Promise<void> {
    try {
      await open(this.openerService, sidecarUri);
    } catch (error) {
      this.messages.warn(nls.localize(
        'ai-focused-editor/transcript/import-open-failed',
        'Imported the set but could not open it: {0}',
        this.detail(error)
      ));
    }
  }

  protected async refreshTree(): Promise<void> {
    const widget = this.widgetManager.tryGetWidget<ManuscriptTreeWidget>(ManuscriptTreeWidget.ID);
    if (widget) {
      await widget.refreshWorkspace();
    }
  }

  protected async collectExistingRelPaths(root: URI, relDir: string): Promise<Set<string>> {
    const set = new Set<string>();
    const stat = await this.fileService.resolve(root.resolve(relDir)).catch(() => undefined);
    for (const child of stat?.children ?? []) {
      const relative = root.relative(child.resource);
      if (relative) {
        set.add(relative.toString());
      }
    }
    return set;
  }

  protected async readTextIfExists(resource: URI): Promise<string | undefined> {
    try {
      return (await this.fileService.read(resource)).value;
    } catch {
      return undefined;
    }
  }

  protected async ensureFolder(uri: URI): Promise<void> {
    try {
      await this.fileService.createFolder(uri);
    } catch {
      // Folder already exists — expected.
    }
  }

  protected async deleteIfExists(uri: URI): Promise<void> {
    try {
      await this.fileService.delete(uri, { recursive: true });
    } catch {
      // Nothing to clean up.
    }
  }

  protected async getRoot(): Promise<URI | undefined> {
    await this.workspaceService.ready;
    const root = this.workspaceService.tryGetRoots()[0] ?? (await this.workspaceService.roots)[0];
    return root?.resource;
  }

  protected detail(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

function isWizardArgs(value: unknown): value is TranscribeWizardArgs {
  return typeof value === 'object' && value !== null;
}
