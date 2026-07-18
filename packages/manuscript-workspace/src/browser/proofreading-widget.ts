import URI from '@theia/core/lib/common/uri';
import { Emitter, Event, MessageService } from '@theia/core/lib/common';
import { Navigatable } from '@theia/core/lib/browser';
import { Saveable, SaveOptions } from '@theia/core/lib/browser/saveable';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { nls } from '@theia/core/lib/common/nls';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { inject, injectable } from '@theia/core/shared/inversify';
import React from '@theia/core/shared/react';
import {
  computeProgress,
  isTranslationMode,
  matchPairs,
  ProofreadingActionKind,
  ProofreadingPair,
  ProofreadingSet,
  ProofreadingSidecarProblem,
  parseProofsetYaml,
  setPageNeedsRework,
  setPageVerified,
  splitDataUri,
  writeProofsetYaml
} from '../common';
import { ChangeProposal, ChangeProposalService } from './change-proposal-service';
import { ProofreadingAiContext, ProofreadingAiService } from './proofreading-ai-service';

/** Extension → MIME for the left scan pane (mirrors the preview widget's map). */
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  tiff: 'image/tiff',
  tif: 'image/tiff',
  svg: 'image/svg+xml'
};

/** Skip inlining any single scan whose bytes exceed this (preview-widget parity). */
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

/** Lower-case extension (no dot) of a POSIX path, or '' when there is none. */
function extensionOf(path: string): string {
  const slash = path.lastIndexOf('/');
  const dot = path.lastIndexOf('.');
  if (dot <= slash + 1) {
    return '';
  }
  return path.slice(dot + 1).toLowerCase();
}

/**
 * Two/three-pane Proofreading editor over a `proofreading/<set>/proofset.yaml`
 * sidecar. Left = the scan image (base64 data URI, the repo's only image
 * convention — see `semantic-markdown-preview-widget.ts`); in translation mode a
 * fixed read-only middle pane shows the original source text; right = a
 * controlled `<textarea>` bound to the editable WORKING-COPY text file
 * (`getEditableRelativePath` → the paired `textFolder` file).
 *
 * Saveable: dirty on text edits AND verified/needs-rework toggles. Per-page edits
 * live in an in-memory `base → text` buffer so switching pages never loses
 * unsaved work; `save()` writes every buffered/dirty text file AND the
 * comment-preserving sidecar. The `ready` guard (the excalidraw version-baseline
 * trick) keeps the initial load from marking a freshly-opened set dirty.
 */
@injectable()
export class ProofreadingWidget extends ReactWidget implements Navigatable, Saveable {
  static readonly FACTORY_ID = 'ai-focused-editor.proofreading-editor';

  @inject(FileService)
  protected readonly fileService!: FileService;

  @inject(WorkspaceService)
  protected readonly workspaceService!: WorkspaceService;

  @inject(MessageService)
  protected readonly messageService!: MessageService;

  @inject(ChangeProposalService)
  protected readonly changeProposals!: ChangeProposalService;

  @inject(ProofreadingAiService)
  protected readonly aiService!: ProofreadingAiService;

  protected uri!: URI;
  protected rootUri: URI | undefined;
  protected loading = true;
  protected error: string | undefined;

  protected set: ProofreadingSet | undefined;
  protected problems: ProofreadingSidecarProblem[] = [];
  protected pairs: ProofreadingPair[] = [];
  protected currentIndex = 0;

  /** Raw sidecar text kept for comment-preserving round-trips on save. */
  protected existingSidecarText: string | undefined;

  /** Per-page editable text, keyed by page base (the SoT for the right pane). */
  protected readonly editBuffers = new Map<string, string>();
  /** Bases whose text buffer diverges from disk and must be re-written on save. */
  protected readonly dirtyBases = new Set<string>();

  /** mtime-keyed data-URI cache for the left scan pane. */
  protected readonly imageCache = new Map<string, { mtime: number; dataUri: string }>();
  protected currentImageDataUri: string | undefined;
  protected currentImageError: string | undefined;
  /** Read-only original text for the translation-mode middle pane. */
  protected currentSourceText: string | undefined;

  /** True while an AI action is in flight (disables the action buttons). */
  protected aiRunning = false;

  /**
   * Set false during {@link load}; mutation handlers no-op until it flips true so
   * the initial paint never marks a clean set dirty (excalidraw baseline trick).
   */
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
    this.id = `${ProofreadingWidget.FACTORY_ID}:${uri.toString()}`;
    this.title.label = uri.parent.path.base || uri.path.base;
    this.title.caption = nls.localize('ai-focused-editor/proofreading/caption', 'Proofreading: {0}', uri.path.fsPath());
    this.title.iconClass = 'codicon codicon-checklist';
    this.title.closable = true;
    this.addClass('afe-proofreading-widget');
    this.toDispose.push(this.onDirtyChangedEmitter);
    this.toDispose.push(this.onContentChangedEmitter);
    void this.load();
  }

  getResourceUri(): URI | undefined {
    return this.uri;
  }

  createMoveToUri(resourceUri: URI): URI | undefined {
    return resourceUri;
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

  protected async resolveRootUri(): Promise<URI | undefined> {
    await this.workspaceService.ready;
    const root = this.workspaceService.tryGetRoots()[0] ?? (await this.workspaceService.roots)[0];
    return root ? new URI(root.resource.toString()) : undefined;
  }

  /** Resolve a workspace-relative folder/file path against the book root. */
  protected toUri(relPath: string): URI | undefined {
    return this.rootUri?.resolve(relPath);
  }

  protected async load(): Promise<void> {
    this.loading = true;
    this.ready = false;
    this.error = undefined;
    this.currentImageDataUri = undefined;
    this.currentImageError = undefined;
    this.currentSourceText = undefined;
    this.editBuffers.clear();
    this.dirtyBases.clear();
    this.update();
    try {
      this.rootUri = await this.resolveRootUri();
      this.existingSidecarText = await this.readTextIfExists(this.uri);
      const { set, problems } = parseProofsetYaml(this.existingSidecarText ?? '');
      this.problems = problems;
      this.set = set;
      this.pairs = set && this.rootUri ? await this.resolvePairs(set) : [];
      this.currentIndex = 0;
      if (this.pairs.length > 0) {
        await this.loadPage(this.currentIndex);
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

  protected async readTextIfExists(resource: URI): Promise<string | undefined> {
    try {
      return (await this.fileService.read(resource)).value;
    } catch {
      return undefined;
    }
  }

  /** List the non-directory file names in a workspace-relative folder ([] on error). */
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

  protected async resolvePairs(set: ProofreadingSet): Promise<ProofreadingPair[]> {
    const [imageNames, textNames, sourceNames] = await Promise.all([
      this.listFolderNames(set.imagesFolder),
      this.listFolderNames(set.textFolder),
      set.sourceTextFolder ? this.listFolderNames(set.sourceTextFolder) : Promise.resolve<string[]>([])
    ]);
    return matchPairs(
      imageNames,
      textNames,
      set.sourceTextFolder ? sourceNames : undefined,
      { imagesFolder: set.imagesFolder, textFolder: set.textFolder, sourceTextFolder: set.sourceTextFolder },
      set.imageExtensions,
      set.textExtensions
    );
  }

  protected get currentPair(): ProofreadingPair | undefined {
    return this.pairs[this.currentIndex];
  }

  /** Load the image, editable text (into the buffer), and source text for a page. */
  protected async loadPage(index: number): Promise<void> {
    const pair = this.pairs[index];
    if (!pair) {
      return;
    }
    this.currentImageDataUri = undefined;
    this.currentImageError = undefined;
    this.currentSourceText = undefined;

    // Editable text: keep unsaved manual edits (dirty pages), but re-read a clean
    // page from disk so an applied AI ChangeProposal (written to the working-copy
    // file) is reflected on the next navigation to that page.
    const isDirty = this.dirtyBases.has(pair.base);
    if (!this.editBuffers.has(pair.base) || !isDirty) {
      const text = pair.missing ? undefined : await this.readTextIfExists(this.toUri(pair.textRelPath)!);
      this.editBuffers.set(pair.base, text ?? this.editBuffers.get(pair.base) ?? '');
    }

    // Read-only source text (translation mode only).
    if (pair.sourceTextRelPath) {
      const sourceUri = this.toUri(pair.sourceTextRelPath);
      this.currentSourceText = sourceUri ? await this.readTextIfExists(sourceUri) : undefined;
    }

    // Left scan image as a base64 data URI.
    const imageUri = this.toUri(pair.imageRelPath);
    if (imageUri) {
      const resolved = await this.readImageDataUri(imageUri);
      if (resolved) {
        this.currentImageDataUri = resolved;
      } else {
        this.currentImageError = nls.localize(
          'ai-focused-editor/proofreading/image-unavailable',
          'The scan image could not be loaded (missing or over the size limit).'
        );
      }
    }
    this.update();
  }

  /**
   * Read a scan image and return its `data:` URI, using the mtime-keyed cache to
   * skip re-reading unchanged files. Returns undefined when the file is missing,
   * over {@link MAX_SINGLE_IMAGE_BYTES}, or unreadable (preview-widget parity).
   */
  protected async readImageDataUri(uri: URI): Promise<string | undefined> {
    const mime = IMAGE_MIME_BY_EXT[extensionOf(uri.path.toString())] ?? 'application/octet-stream';
    try {
      const stat = await this.fileService.resolve(uri, { resolveMetadata: true });
      if (stat.size > MAX_SINGLE_IMAGE_BYTES) {
        return undefined;
      }
      const key = uri.toString();
      const cached = this.imageCache.get(key);
      if (cached && cached.mtime === stat.mtime) {
        return cached.dataUri;
      }
      const content = await this.fileService.readFile(uri);
      const bytes = content.value.buffer;
      if (bytes.length > MAX_SINGLE_IMAGE_BYTES) {
        return undefined;
      }
      const dataUri = `data:${mime};base64,${bytesToBase64(bytes)}`;
      this.imageCache.set(key, { mtime: stat.mtime, dataUri });
      return dataUri;
    } catch {
      return undefined;
    }
  }

  // --- navigation ---

  protected async goToPage(index: number): Promise<void> {
    if (index < 0 || index >= this.pairs.length || index === this.currentIndex) {
      return;
    }
    this.currentIndex = index;
    await this.loadPage(index);
  }

  protected handleKeyDown(event: React.KeyboardEvent): void {
    if (!(event.metaKey || event.ctrlKey)) {
      return;
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      void this.goToPage(this.currentIndex - 1);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      void this.goToPage(this.currentIndex + 1);
    }
  }

  // --- text edits ---

  protected onTextChanged(value: string): void {
    const pair = this.currentPair;
    if (!this.ready || !pair) {
      return;
    }
    this.editBuffers.set(pair.base, value);
    this.dirtyBases.add(pair.base);
    this.setDirty(true);
    this.update();
  }

  // --- verified / needs-rework toggles ---

  protected isVerified(base: string): boolean {
    return this.set?.pages.find(page => page.base === base)?.verified === true;
  }

  protected needsRework(base: string): boolean {
    return this.set?.pages.find(page => page.base === base)?.needsRework === true;
  }

  protected toggleVerified(): void {
    const pair = this.currentPair;
    if (!this.ready || !this.set || !pair) {
      return;
    }
    this.set = setPageVerified(this.set, pair.base, !this.isVerified(pair.base));
    this.setDirty(true);
    this.update();
  }

  protected toggleNeedsRework(): void {
    const pair = this.currentPair;
    if (!this.ready || !this.set || !pair) {
      return;
    }
    this.set = setPageNeedsRework(this.set, pair.base, !this.needsRework(pair.base));
    this.setDirty(true);
    this.update();
  }

  // --- AI actions ---

  /** Human label for an AI action button / proposal title. */
  protected aiActionLabel(kind: ProofreadingActionKind): string {
    switch (kind) {
      case 'reOcr':
        return nls.localize('ai-focused-editor/proofreading/ai-reocr', 'Re-OCR');
      case 'proofread':
        return nls.localize('ai-focused-editor/proofreading/ai-proofread', 'Proofread');
      case 'translate':
        return nls.localize('ai-focused-editor/proofreading/ai-translate', 'Translate');
      case 'translationQa':
        return nls.localize('ai-focused-editor/proofreading/ai-translation-qa', 'Translation QA');
    }
  }

  /**
   * Run one AI action for the current page: read the current text (+ source text
   * and scan-image bytes), call the service, then offer the whole-page result as a
   * ChangeProposal diff+Apply against the working-copy text file. Errors and
   * warnings are surfaced via the message service; the flow never throws.
   */
  protected async runAiAction(kind: ProofreadingActionKind): Promise<void> {
    const pair = this.currentPair;
    if (!pair || !this.set || this.aiRunning) {
      return;
    }
    this.aiRunning = true;
    this.update();
    try {
      const currentText = this.editBuffers.get(pair.base) ?? '';
      const ctx: ProofreadingAiContext = { currentText, sourceText: this.currentSourceText };
      // Image-input actions reuse the exact bytes the left pane already loaded.
      if (kind !== 'proofread' && this.currentImageDataUri) {
        const parts = splitDataUri(this.currentImageDataUri);
        if (parts) {
          ctx.imageAttachment = { base64: parts.base64, mimeType: parts.mimeType };
        }
      }

      const result = await this.dispatchAiAction(kind, ctx);
      if (result.error) {
        await this.messageService.error(nls.localize(
          'ai-focused-editor/proofreading/ai-failed',
          '{0} failed: {1}',
          this.aiActionLabel(kind),
          result.error
        ));
        return;
      }
      if (result.warnings.length > 0) {
        await this.messageService.warn(result.warnings.join('\n'));
      }

      const text = result.text ?? '';
      if (!text || text === currentText) {
        await this.messageService.info(nls.localize(
          'ai-focused-editor/proofreading/ai-no-change',
          '{0}: no changes proposed for this page.',
          this.aiActionLabel(kind)
        ));
        return;
      }

      const target = this.toUri(pair.textRelPath);
      if (!target) {
        return;
      }
      const proposal: ChangeProposal = {
        uri: target.toString(),
        originalText: currentText,
        targetText: text,
        title: this.aiActionLabel(kind)
      };
      this.changeProposals.notifyReady(proposal, nls.localize(
        'ai-focused-editor/proofreading/ai-ready',
        '{0} is ready — review the diff, then Apply.',
        this.aiActionLabel(kind)
      ));
    } finally {
      this.aiRunning = false;
      this.update();
    }
  }

  /** Route to the matching service method (keeps `runAiAction` type-safe). */
  protected dispatchAiAction(kind: ProofreadingActionKind, ctx: ProofreadingAiContext): ReturnType<ProofreadingAiService['reOcr']> {
    switch (kind) {
      case 'reOcr':
        return this.aiService.reOcr(ctx);
      case 'proofread':
        return this.aiService.proofread(ctx);
      case 'translate':
        return this.aiService.translate(ctx);
      case 'translationQa':
        return this.aiService.translationQa(ctx);
    }
  }

  // --- Saveable ---

  async save(_options?: SaveOptions): Promise<void> {
    if (!this.set) {
      return;
    }
    try {
      // Persist every dirty page's working-copy text file (creates missing ones).
      for (const base of this.dirtyBases) {
        const pair = this.pairs.find(candidate => candidate.base === base);
        const target = pair ? this.toUri(pair.textRelPath) : undefined;
        if (target) {
          await this.fileService.write(target, this.editBuffers.get(base) ?? '');
        }
      }
      // Persist the comment-preserving sidecar.
      const yamlText = writeProofsetYaml(this.existingSidecarText, this.set);
      await this.fileService.write(this.uri, yamlText);
      this.existingSidecarText = yamlText;
      this.dirtyBases.clear();
      this.setDirty(false);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.messageService.error(nls.localize(
        'ai-focused-editor/proofreading/save-failed',
        'Could not save the proofreading set: {0}',
        detail
      ));
    }
  }

  async revert(): Promise<void> {
    await this.load();
  }

  // --- rendering ---

  protected render(): React.ReactNode {
    if (this.loading) {
      return React.createElement(
        'div',
        { className: 'afe-proofreading-status' },
        nls.localize('ai-focused-editor/proofreading/loading', 'Loading proofreading set...')
      );
    }
    if (this.error) {
      return React.createElement(
        'div',
        { className: 'afe-proofreading-status error' },
        nls.localize('ai-focused-editor/proofreading/error', 'Could not open the proofreading set: {0}', this.error)
      );
    }
    if (!this.set) {
      return React.createElement(
        'div',
        { className: 'afe-proofreading-shell' },
        this.renderProblems(),
        React.createElement(
          'div',
          { className: 'afe-proofreading-status error' },
          nls.localize('ai-focused-editor/proofreading/invalid-sidecar', 'proofset.yaml is missing required fields; open it as raw YAML to fix it.')
        )
      );
    }

    return React.createElement(
      'div',
      { className: 'afe-proofreading-shell', tabIndex: 0, onKeyDown: (event: React.KeyboardEvent) => this.handleKeyDown(event) },
      this.renderHeader(),
      this.renderProblems(),
      this.renderPanes()
    );
  }

  protected renderProblems(): React.ReactNode {
    if (this.problems.length === 0) {
      return undefined;
    }
    return React.createElement(
      'ul',
      { className: 'afe-proofreading-problems' },
      ...this.problems.map((problem, index) => React.createElement(
        'li',
        { key: index, className: 'afe-proofreading-problem error' },
        problem.message
      ))
    );
  }

  protected renderHeader(): React.ReactNode {
    const set = this.set!;
    const translation = isTranslationMode(set);
    const total = this.pairs.length;
    const pair = this.currentPair;
    const progress = computeProgress(set);
    const verified = pair ? this.isVerified(pair.base) : false;
    const rework = pair ? this.needsRework(pair.base) : false;

    return React.createElement(
      'div',
      { className: 'afe-proofreading-header' },
      React.createElement(
        'div',
        { className: 'afe-proofreading-nav' },
        React.createElement(
          'button',
          {
            className: 'theia-button secondary',
            type: 'button',
            title: nls.localize('ai-focused-editor/proofreading/prev', 'Previous page (⌘←)'),
            disabled: this.currentIndex <= 0,
            onClick: () => { void this.goToPage(this.currentIndex - 1); }
          },
          React.createElement('span', { className: 'codicon codicon-chevron-left' })
        ),
        React.createElement(
          'span',
          { className: 'afe-proofreading-page-indicator' },
          total === 0 ? '0 / 0' : `${this.currentIndex + 1} / ${total}`
        ),
        React.createElement(
          'button',
          {
            className: 'theia-button secondary',
            type: 'button',
            title: nls.localize('ai-focused-editor/proofreading/next', 'Next page (⌘→)'),
            disabled: this.currentIndex >= total - 1,
            onClick: () => { void this.goToPage(this.currentIndex + 1); }
          },
          React.createElement('span', { className: 'codicon codicon-chevron-right' })
        )
      ),
      React.createElement(
        'div',
        { className: 'afe-proofreading-toggles' },
        React.createElement(
          'button',
          {
            className: `theia-button secondary afe-proofreading-toggle${verified ? ' active' : ''}`,
            type: 'button',
            disabled: !pair,
            onClick: () => this.toggleVerified()
          },
          '✅ ',
          nls.localize('ai-focused-editor/proofreading/verified', 'Verified')
        ),
        React.createElement(
          'button',
          {
            className: `theia-button secondary afe-proofreading-toggle${rework ? ' active' : ''}`,
            type: 'button',
            disabled: !pair,
            onClick: () => this.toggleNeedsRework()
          },
          translation
            ? nls.localize('ai-focused-editor/proofreading/needs-rework-translation', 'Needs rework')
            : nls.localize('ai-focused-editor/proofreading/needs-rework', 'Needs rework')
        )
      ),
      React.createElement(
        'span',
        { className: 'afe-proofreading-progress' },
        nls.localize(
          'ai-focused-editor/proofreading/progress',
          '{0}/{1} verified · {2}%',
          progress.verified,
          progress.total,
          progress.percent
        )
      ),
      this.renderAiActions(translation, !!pair)
    );
  }

  /**
   * Mode-gated AI action buttons (ScanCheck's #ocrAiActionsRow vs
   * #translationAiActionsRow): OCR mode exposes Re-OCR + Proofread, translation
   * mode exposes Translate + Translation QA. Disabled with no current page or
   * while an action is in flight; a spinner shows the running state.
   */
  protected renderAiActions(translation: boolean, hasPair: boolean): React.ReactNode {
    const kinds: ProofreadingActionKind[] = translation
      ? ['translate', 'translationQa']
      : ['reOcr', 'proofread'];
    return React.createElement(
      'div',
      { className: 'afe-proofreading-ai-actions', 'data-placeholder': 'ai-actions' },
      ...kinds.map(kind => React.createElement(
        'button',
        {
          key: kind,
          className: 'theia-button afe-proofreading-ai-button',
          type: 'button',
          disabled: !hasPair || this.aiRunning,
          onClick: () => { void this.runAiAction(kind); }
        },
        this.aiActionLabel(kind)
      )),
      this.aiRunning
        ? React.createElement(
          'span',
          { className: 'afe-proofreading-ai-running' },
          React.createElement('span', { className: 'codicon codicon-loading codicon-modifier-spin' }),
          ' ',
          nls.localize('ai-focused-editor/proofreading/ai-running', 'Running AI action...')
        )
        : undefined
    );
  }

  protected renderPanes(): React.ReactNode {
    const set = this.set!;
    const translation = isTranslationMode(set);
    const pair = this.currentPair;

    if (!pair) {
      return React.createElement(
        'div',
        { className: 'afe-proofreading-status' },
        nls.localize('ai-focused-editor/proofreading/no-pages', 'No pages found for this set. Add scan images to the images folder.')
      );
    }

    const panes: React.ReactNode[] = [this.renderImagePane(translation)];
    if (translation) {
      panes.push(this.renderSourcePane());
    }
    panes.push(this.renderTextPane(translation, pair));

    return React.createElement('div', { className: 'afe-proofreading-panes' }, ...panes);
  }

  protected renderImagePane(translation: boolean): React.ReactNode {
    const label = translation
      ? nls.localize('ai-focused-editor/proofreading/original-label', 'Original')
      : nls.localize('ai-focused-editor/proofreading/image-label', 'Image');
    let body: React.ReactNode;
    if (this.currentImageDataUri) {
      body = React.createElement('img', {
        className: 'afe-proofreading-image',
        src: this.currentImageDataUri,
        alt: label
      });
    } else {
      body = React.createElement(
        'div',
        { className: 'afe-proofreading-image-missing' },
        this.currentImageError ?? nls.localize('ai-focused-editor/proofreading/image-loading', 'Loading image...')
      );
    }
    return React.createElement(
      'div',
      { key: 'image', className: 'afe-proofreading-pane afe-proofreading-image-pane' },
      React.createElement('div', { className: 'afe-proofreading-pane-label' }, label),
      React.createElement('div', { className: 'afe-proofreading-image-frame' }, body)
    );
  }

  protected renderSourcePane(): React.ReactNode {
    return React.createElement(
      'div',
      { key: 'source', className: 'afe-proofreading-pane afe-proofreading-source-pane' },
      React.createElement(
        'div',
        { className: 'afe-proofreading-pane-label' },
        nls.localize('ai-focused-editor/proofreading/source-label', 'Original text')
      ),
      React.createElement(
        'pre',
        { className: 'afe-proofreading-source' },
        this.currentSourceText ?? nls.localize('ai-focused-editor/proofreading/no-source', 'No original text for this page.')
      )
    );
  }

  protected renderTextPane(translation: boolean, pair: ProofreadingPair): React.ReactNode {
    const label = translation
      ? nls.localize('ai-focused-editor/proofreading/translation-label', 'Translation')
      : nls.localize('ai-focused-editor/proofreading/text-label', 'Text')
    ;
    const value = this.editBuffers.get(pair.base) ?? '';
    return React.createElement(
      'div',
      { key: 'text', className: 'afe-proofreading-pane afe-proofreading-text-pane' },
      React.createElement(
        'div',
        { className: 'afe-proofreading-pane-label' },
        label,
        pair.missing
          ? React.createElement(
            'span',
            { className: 'afe-proofreading-missing-badge' },
            nls.localize('ai-focused-editor/proofreading/no-text-yet', 'no text yet')
          )
          : undefined
      ),
      React.createElement('textarea', {
        className: 'afe-proofreading-textarea',
        value,
        spellCheck: false,
        placeholder: pair.missing
          ? nls.localize('ai-focused-editor/proofreading/text-placeholder', 'No text file yet — start typing to create it on save.')
          : undefined,
        onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => this.onTextChanged(event.currentTarget.value)
      })
    );
  }
}
