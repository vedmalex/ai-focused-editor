import URI from '@theia/core/lib/common/uri';
import { Disposable, Emitter, Event, InMemoryResources, MessageService } from '@theia/core/lib/common';
import { Navigatable, StatefulWidget } from '@theia/core/lib/browser';
import { Saveable, SaveOptions } from '@theia/core/lib/browser/saveable';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { Message } from '@theia/core/shared/@lumino/messaging';
import { nls } from '@theia/core/lib/common/nls';
import { MonacoEditorProvider } from '@theia/monaco/lib/browser/monaco-editor-provider';
import { MonacoEditor } from '@theia/monaco/lib/browser/monaco-editor';
import { MonacoTextModelService } from '@theia/monaco/lib/browser/monaco-text-model-service';
import { MonacoEditorModel } from '@theia/monaco/lib/browser/monaco-editor-model';
import { IReference } from '@theia/monaco-editor-core/esm/vs/base/common/lifecycle';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { FileChangesEvent } from '@theia/filesystem/lib/common/files';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { inject, injectable } from '@theia/core/shared/inversify';
import React from '@theia/core/shared/react';
import {
  computeProgress,
  isTranslationMode,
  matchPairs,
  pairHasImage,
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
import { imageMimeForPath } from '../common/image-mime';

/** Skip inlining any single scan whose bytes exceed this (preview-widget parity). */
const MAX_SINGLE_IMAGE_BYTES = 10 * 1024 * 1024;

/** Debounce for the folder-watch auto-refresh (mirrors ManuscriptTreeModel). */
const REFRESH_DEBOUNCE_MS = 300;

/**
 * In-memory URI scheme for the per-page editable Monaco models. Each base gets
 * one stable model URI; the model (and thus its undo/redo stack) is kept alive
 * across page navigation so the edit history survives forward/back.
 */
const PROOFREADING_EDIT_SCHEME = 'afe-proofreading-edit';

/** Character budget for an adjacent-page text preview. */
const ADJACENT_TEXT_PREVIEW_CHARS = 200;

/** Session-persisted pane-visibility toggles. */
interface ProofreadingViewOptions {
  showScanPane: boolean;
  showSourcePane: boolean;
  showAdjacentPages: boolean;
}

/** A lazily-loaded preview of an adjacent page (thumbnail or text snippet). */
type AdjacentPreview =
  | { kind: 'image'; dataUri: string }
  | { kind: 'text'; snippet: string };

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
export class ProofreadingWidget extends ReactWidget implements Navigatable, Saveable, StatefulWidget {
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

  @inject(MonacoEditorProvider)
  protected readonly editorProvider!: MonacoEditorProvider;

  @inject(MonacoTextModelService)
  protected readonly monacoModels!: MonacoTextModelService;

  @inject(InMemoryResources)
  protected readonly inMemoryResources!: InMemoryResources;

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

  /** Pane-visibility toggles (session state); the editable text pane is always shown. */
  protected showScanPane = true;
  protected showSourcePane = true;
  /** When on, show a preview of the previous page above and the next page below. */
  protected showAdjacentPages = false;

  // --- embedded Monaco text editor (the editable text pane) ---

  /**
   * The single embedded Monaco editor. Its DOM host node ({@link editorHostNode})
   * is widget-owned and reparented across React re-renders, so the editor DOM is
   * never wiped by React's reconciliation.
   */
  protected monacoEditor: MonacoEditor | undefined;
  /** Widget-owned, created-once DOM host the editor lives in (see the ref callback). */
  protected editorHostNode: HTMLDivElement | undefined;
  /** Guards against creating the editor twice while its async creation is in flight. */
  protected editorCreating = false;
  /** Base whose model is currently shown in the editor. */
  protected currentEditorBase: string | undefined;
  /**
   * Per-base editable Monaco model references. Keeping every reference alive keeps
   * each model's undo/redo stack alive, so switching pages and back preserves the
   * edit history. The reference (not just the model) is stored so it can be
   * disposed on widget close.
   */
  protected readonly editorModels = new Map<string, IReference<MonacoEditorModel>>();
  /** Content-change listeners for the per-base models, disposed with the widget. */
  protected readonly editorModelListeners = new Map<string, Disposable>();
  /**
   * Bases whose model is being seeded programmatically (initial value / disk
   * refresh). Their content-change events must NOT mark the set dirty.
   */
  protected readonly seedingBases = new Set<string>();

  /** Lazily-loaded previews for the adjacent-page strip (Unit 2). */
  protected prevPreview: AdjacentPreview | undefined;
  protected nextPreview: AdjacentPreview | undefined;

  /** Pending folder-watch refresh timer; cleared on dispose. */
  protected refreshHandle: ReturnType<typeof setTimeout> | undefined;

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
    // Auto-refresh: re-resolve pairs when the set's folders change on disk.
    this.toDispose.push(this.fileService.onDidFilesChange(event => this.onFilesChanged(event)));
    this.toDispose.push(Disposable.create(() => {
      if (this.refreshHandle !== undefined) {
        clearTimeout(this.refreshHandle);
        this.refreshHandle = undefined;
      }
    }));
    // Dispose every per-base model listener + reference on widget close (no leaks).
    this.toDispose.push(Disposable.create(() => this.disposeEditorModels()));
    void this.load();
  }

  /** Dispose all per-base model listeners and references (the editor is in toDispose). */
  protected disposeEditorModels(): void {
    for (const listener of this.editorModelListeners.values()) {
      listener.dispose();
    }
    this.editorModelListeners.clear();
    for (const reference of this.editorModels.values()) {
      reference.dispose();
    }
    this.editorModels.clear();
  }

  // --- StatefulWidget (session-persist the pane toggles) ---

  storeState(): ProofreadingViewOptions {
    return {
      showScanPane: this.showScanPane,
      showSourcePane: this.showSourcePane,
      showAdjacentPages: this.showAdjacentPages
    };
  }

  restoreState(state: object | undefined): void {
    const options = state as Partial<ProofreadingViewOptions> | undefined;
    if (options && typeof options.showScanPane === 'boolean') {
      this.showScanPane = options.showScanPane;
    }
    if (options && typeof options.showSourcePane === 'boolean') {
      this.showSourcePane = options.showSourcePane;
    }
    if (options && typeof options.showAdjacentPages === 'boolean') {
      this.showAdjacentPages = options.showAdjacentPages;
    }
    this.update();
    if (this.showAdjacentPages) {
      void this.loadAdjacentPreviews();
    }
  }

  getResourceUri(): URI | undefined {
    return this.uri;
  }

  createMoveToUri(resourceUri: URI): URI | undefined {
    return resourceUri;
  }

  protected override onActivateRequest(msg: Message): void {
    super.onActivateRequest(msg);
    if (this.monacoEditor) {
      this.monacoEditor.focus();
    } else {
      this.node.focus();
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

  /** True when ANY page in the set has a matched scan (gates the scan pane + its toggle). */
  protected get hasAnyScans(): boolean {
    return this.pairs.some(pairHasImage);
  }

  // --- auto-refresh (folder watch) ---

  /** Absolute URI strings of the set's page-defining folders. */
  protected watchedFolderUris(): string[] {
    const set = this.set;
    if (!set) {
      return [];
    }
    const rel = [set.imagesFolder, set.textFolder, set.sourceTextFolder];
    const uris: string[] = [];
    for (const folder of rel) {
      if (!folder) {
        continue;
      }
      const uri = this.toUri(folder);
      if (uri) {
        uris.push(uri.toString());
      }
    }
    return uris;
  }

  /** Debounced re-resolve when a file changes under one of the watched folders. */
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
   * Re-resolve the pairs from the current folder contents and re-render, WITHOUT
   * touching dirty state: unsaved edits survive (the `editBuffers`/`dirtyBases`
   * are keyed by base and {@link loadPage} keeps dirty pages), and the selection
   * is preserved by base where the page still exists.
   */
  protected async refreshPairs(): Promise<void> {
    if (!this.set || !this.rootUri) {
      return;
    }
    const previousBase = this.currentPair?.base;
    this.pairs = await this.resolvePairs(this.set);
    let index = 0;
    if (previousBase !== undefined) {
      const found = this.pairs.findIndex(pair => pair.base === previousBase);
      if (found >= 0) {
        index = found;
      }
    }
    this.currentIndex = this.pairs.length === 0 ? 0 : Math.min(index, this.pairs.length - 1);
    if (this.pairs.length > 0) {
      await this.loadPage(this.currentIndex);
    } else {
      this.currentImageDataUri = undefined;
      this.currentImageError = undefined;
      this.currentSourceText = undefined;
    }
    this.update();
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
    // Reflect a clean page's on-disk text (e.g. an applied AI ChangeProposal) into
    // its live model. Dirty pages keep their unsaved edits (and undo history).
    if (!isDirty && this.editorModels.has(pair.base)) {
      this.seedModel(pair.base, this.editBuffers.get(pair.base) ?? '');
    }

    // Read-only source text (translation mode only).
    if (pair.sourceTextRelPath) {
      const sourceUri = this.toUri(pair.sourceTextRelPath);
      this.currentSourceText = sourceUri ? await this.readTextIfExists(sourceUri) : undefined;
    }

    // Left scan image as a base64 data URI — only when this page has a matched scan.
    const imageUri = pair.imageRelPath ? this.toUri(pair.imageRelPath) : undefined;
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
    // Point the embedded editor at this page (undo history is per-model, preserved).
    // Awaited so navigation deterministically completes the model swap.
    await this.showModel(pair.base);
    if (this.showAdjacentPages) {
      void this.loadAdjacentPreviews();
    }
  }

  /**
   * Read a scan image and return its `data:` URI, using the mtime-keyed cache to
   * skip re-reading unchanged files. Returns undefined when the file is missing,
   * over {@link MAX_SINGLE_IMAGE_BYTES}, or unreadable (preview-widget parity).
   */
  protected async readImageDataUri(uri: URI): Promise<string | undefined> {
    const mime = imageMimeForPath(uri.path.toString()) ?? 'application/octet-stream';
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

  // --- embedded Monaco editor (editable text pane) ---

  /**
   * Stable in-memory model URI for a page. Keyed by the full workspace-relative
   * text path (NOT just the base) so two proofreading sets open at once with a
   * shared page base (e.g. `chapter-01`) never collide on one shared model. The
   * real extension is preserved as the URI suffix for Monaco language detection
   * (`encodeURIComponent` leaves `.` intact, only escaping the `/` separators).
   */
  protected editModelUri(base: string): URI {
    const pair = this.pairs.find(candidate => candidate.base === base);
    const rel = pair?.textRelPath ?? `${this.set?.textFolder ?? ''}/${base}.md`;
    return new URI(`${PROOFREADING_EDIT_SCHEME}:/${encodeURIComponent(rel)}`);
  }

  /**
   * Ensure a live editable Monaco model exists for a base, seeded from its edit
   * buffer. The model reference is cached and kept alive so its undo/redo stack
   * survives page navigation; a content listener mirrors edits into the buffer.
   */
  protected async ensureModelRef(base: string): Promise<IReference<MonacoEditorModel>> {
    const existing = this.editorModels.get(base);
    if (existing) {
      return existing;
    }
    const uri = this.editModelUri(base);
    const content = this.editBuffers.get(base) ?? '';
    try {
      this.inMemoryResources.add(uri, content);
    } catch {
      this.inMemoryResources.update(uri, content);
    }
    const reference = await this.monacoModels.createModelReference(uri);
    this.editorModels.set(base, reference);
    const listener = reference.object.textEditorModel.onDidChangeContent(() => this.onEditorModelChanged(base));
    this.editorModelListeners.set(base, listener);
    return reference;
  }

  /** Mirror a user edit in the base's model into its edit buffer + dirty state. */
  protected onEditorModelChanged(base: string): void {
    if (this.seedingBases.has(base)) {
      return;
    }
    const reference = this.editorModels.get(base);
    if (!reference) {
      return;
    }
    this.editBuffers.set(base, reference.object.textEditorModel.getValue());
    if (!this.ready) {
      return;
    }
    this.dirtyBases.add(base);
    this.setDirty(true);
    // Deliberately no this.update(): re-rendering would fight the live editor. The
    // dirty indicator is driven by the Saveable events fired from setDirty().
  }

  /** Programmatically set a base's model value without marking it dirty (seeding). */
  protected seedModel(base: string, value: string): void {
    const reference = this.editorModels.get(base);
    if (!reference) {
      return;
    }
    const model = reference.object.textEditorModel;
    if (model.getValue() === value) {
      return;
    }
    this.seedingBases.add(base);
    try {
      model.setValue(value);
    } finally {
      this.seedingBases.delete(base);
    }
  }

  /** Create the embedded editor once, over the current page's model. */
  protected async ensureEditor(): Promise<void> {
    if (this.monacoEditor || this.editorCreating || !this.editorHostNode) {
      return;
    }
    const base = this.currentPair?.base;
    if (base === undefined) {
      return;
    }
    this.editorCreating = true;
    try {
      await this.ensureModelRef(base);
      const editor = await this.editorProvider.createInline(this.editModelUri(base), this.editorHostNode, {
        readOnly: false,
        lineNumbers: 'on',
        wordWrap: 'on',
        automaticLayout: true,
        scrollBeyondLastLine: false,
        minimap: { enabled: false }
      });
      if (this.isDisposed) {
        editor.dispose();
        return;
      }
      this.monacoEditor = editor;
      this.currentEditorBase = base;
      this.toDispose.push(editor);
      editor.getControl().layout();
    } finally {
      this.editorCreating = false;
    }
  }

  /** Swap the editor to show a base's model (keeps that model's undo history). */
  protected async showModel(base: string): Promise<void> {
    const reference = await this.ensureModelRef(base);
    if (!this.monacoEditor) {
      return;
    }
    const model = reference.object.textEditorModel;
    const control = this.monacoEditor.getControl();
    if (this.currentEditorBase !== base || control.getModel() !== model) {
      control.setModel(model);
      this.currentEditorBase = base;
    }
    control.layout();
  }

  /** Ensure the editor exists and shows the current page (called from the host ref). */
  protected async ensureEditorForCurrentPage(): Promise<void> {
    await this.ensureEditor();
    const base = this.currentPair?.base;
    if (base !== undefined) {
      await this.showModel(base);
    }
  }

  /**
   * React ref for the editor-pane placeholder: appends the widget-owned host node
   * (a move that preserves Monaco's DOM) and lazily creates/points the editor.
   */
  protected readonly attachEditorHost = (placeholder: HTMLDivElement | null): void => {
    if (!placeholder) {
      return;
    }
    if (!this.editorHostNode) {
      this.editorHostNode = document.createElement('div');
      this.editorHostNode.className = 'afe-proofreading-editor-host-node';
    }
    if (this.editorHostNode.parentElement !== placeholder) {
      placeholder.appendChild(this.editorHostNode);
    }
    void this.ensureEditorForCurrentPage();
  };

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
      this.renderAdjacent('prev'),
      this.renderPanes(),
      this.renderAdjacent('next')
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
      this.renderViewControls(translation),
      this.renderAiActions(translation, !!pair)
    );
  }

  /**
   * Pane-visibility toggles + a manual Refresh button. The scan toggle is offered
   * only when the set has any scans; the source toggle only in translation mode.
   * The editable text pane is always visible, so it has no toggle.
   */
  protected renderViewControls(translation: boolean): React.ReactNode {
    const controls: React.ReactNode[] = [];
    if (this.hasAnyScans) {
      controls.push(React.createElement(
        'button',
        {
          key: 'toggle-scan',
          className: `theia-button secondary afe-proofreading-toggle${this.showScanPane ? ' active' : ''}`,
          type: 'button',
          title: nls.localize('ai-focused-editor/proofreading/toggle-scan-tooltip', 'Show or hide the scan pane'),
          onClick: () => this.togglePane('scan')
        },
        React.createElement('span', { className: 'codicon codicon-file-media' }),
        ' ',
        nls.localize('ai-focused-editor/proofreading/toggle-scan', 'Scan')
      ));
    }
    if (translation) {
      controls.push(React.createElement(
        'button',
        {
          key: 'toggle-source',
          className: `theia-button secondary afe-proofreading-toggle${this.showSourcePane ? ' active' : ''}`,
          type: 'button',
          title: nls.localize('ai-focused-editor/proofreading/toggle-source-tooltip', 'Show or hide the source-text pane'),
          onClick: () => this.togglePane('source')
        },
        React.createElement('span', { className: 'codicon codicon-book' }),
        ' ',
        nls.localize('ai-focused-editor/proofreading/toggle-source', 'Source')
      ));
    }
    controls.push(React.createElement(
      'button',
      {
        key: 'toggle-adjacent',
        className: `theia-button secondary afe-proofreading-toggle${this.showAdjacentPages ? ' active' : ''}`,
        type: 'button',
        title: nls.localize('ai-focused-editor/proofreading/adjacent-pages-tooltip', 'Show a preview of the previous and next pages'),
        onClick: () => this.toggleAdjacentPages()
      },
      React.createElement('span', { className: 'codicon codicon-list-flat' }),
      ' ',
      nls.localize('ai-focused-editor/proofreading/adjacent-pages', 'Adjacent pages')
    ));
    controls.push(React.createElement(
      'button',
      {
        key: 'refresh',
        className: 'theia-button secondary afe-proofreading-refresh',
        type: 'button',
        title: nls.localize('ai-focused-editor/proofreading/refresh-tooltip', 'Re-scan the folders for added or removed files'),
        onClick: () => { void this.refreshPairs(); }
      },
      React.createElement('span', { className: 'codicon codicon-refresh' }),
      ' ',
      nls.localize('ai-focused-editor/proofreading/refresh', 'Refresh')
    ));
    return React.createElement('div', { className: 'afe-proofreading-view-controls' }, ...controls);
  }

  protected togglePane(pane: 'scan' | 'source'): void {
    if (pane === 'scan') {
      this.showScanPane = !this.showScanPane;
    } else {
      this.showSourcePane = !this.showSourcePane;
    }
    this.update();
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

    // Adaptive panes: render the scan pane only when THIS page has a matched scan
    // and the scan toggle is on; the source pane only in translation mode with the
    // source toggle on; the editable text pane always. So a translation set with no
    // scans shows two panes (source + translation); with scans, three.
    const panes: React.ReactNode[] = [];
    if (pairHasImage(pair) && this.showScanPane) {
      panes.push(this.renderImagePane(translation));
    }
    if (translation && this.showSourcePane) {
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
      // Stable-key placeholder; the widget-owned Monaco host node is appended into
      // it via the ref (a DOM move React never reconciles), so the editor — and its
      // per-page undo/redo history — survives every re-render and page navigation.
      React.createElement('div', {
        key: 'editor-host',
        className: 'afe-proofreading-editor-host',
        ref: this.attachEditorHost
      })
    );
  }

  // --- adjacent-pages preview strip (Unit 2) ---

  protected toggleAdjacentPages(): void {
    this.showAdjacentPages = !this.showAdjacentPages;
    this.prevPreview = undefined;
    this.nextPreview = undefined;
    this.update();
    if (this.showAdjacentPages) {
      void this.loadAdjacentPreviews();
    }
  }

  /**
   * Load previews for the pages immediately before/after the current one (thumbnail
   * when the adjacent page has a scan, else a short text snippet). Never blocks the
   * main page load; race-guarded so a stale async read cannot clobber a newer page.
   */
  protected async loadAdjacentPreviews(): Promise<void> {
    if (!this.showAdjacentPages) {
      return;
    }
    const indexAtCall = this.currentIndex;
    const [prev, next] = await Promise.all([
      this.buildAdjacentPreview(this.pairs[indexAtCall - 1]),
      this.buildAdjacentPreview(this.pairs[indexAtCall + 1])
    ]);
    if (this.currentIndex !== indexAtCall || !this.showAdjacentPages) {
      return;
    }
    this.prevPreview = prev;
    this.nextPreview = next;
    this.update();
  }

  /** Build one adjacent-page preview (image thumbnail or clamped text snippet). */
  protected async buildAdjacentPreview(pair: ProofreadingPair | undefined): Promise<AdjacentPreview | undefined> {
    if (!pair) {
      return undefined;
    }
    if (pairHasImage(pair) && pair.imageRelPath) {
      const imageUri = this.toUri(pair.imageRelPath);
      const dataUri = imageUri ? await this.readImageDataUri(imageUri) : undefined;
      if (dataUri) {
        return { kind: 'image', dataUri };
      }
    }
    // Prefer the live edit buffer (the editable target — in translation mode this is
    // the translation, the most useful linkage); fall back to reading the file.
    let text = this.editBuffers.get(pair.base);
    if (text === undefined && !pair.missing) {
      const textUri = this.toUri(pair.textRelPath);
      text = textUri ? await this.readTextIfExists(textUri) : undefined;
    }
    const snippet = (text ?? '').replace(/\s+/g, ' ').trim().slice(0, ADJACENT_TEXT_PREVIEW_CHARS);
    return { kind: 'text', snippet };
  }

  /**
   * Render the adjacent-page block for one side, or nothing when there is no page
   * on that side. Clicking (or Enter/Space) navigates to that page.
   */
  protected renderAdjacent(side: 'prev' | 'next'): React.ReactNode {
    if (!this.showAdjacentPages || this.pairs.length === 0) {
      return undefined;
    }
    const index = side === 'prev' ? this.currentIndex - 1 : this.currentIndex + 1;
    const pair = this.pairs[index];
    if (!pair) {
      return undefined;
    }
    const preview = side === 'prev' ? this.prevPreview : this.nextPreview;
    const label = side === 'prev'
      ? `◀ ${nls.localize('ai-focused-editor/proofreading/adjacent-page', 'page {0}', index + 1)}`
      : `${nls.localize('ai-focused-editor/proofreading/adjacent-page', 'page {0}', index + 1)} ▶`;
    let body: React.ReactNode;
    if (preview?.kind === 'image') {
      body = React.createElement('img', {
        className: 'afe-proofreading-adjacent-thumb',
        src: preview.dataUri,
        alt: label
      });
    } else if (preview?.kind === 'text') {
      body = React.createElement('div', { className: 'afe-proofreading-adjacent-text' }, preview.snippet);
    } else {
      body = React.createElement('div', { className: 'afe-proofreading-adjacent-text' },
        nls.localize('ai-focused-editor/proofreading/adjacent-loading', 'Loading preview...'));
    }
    return React.createElement(
      'div',
      {
        key: `adjacent-${side}`,
        className: `afe-proofreading-adjacent ${side}`,
        role: 'button',
        tabIndex: 0,
        title: label,
        onClick: () => { void this.goToPage(index); },
        onKeyDown: (event: React.KeyboardEvent) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            void this.goToPage(index);
          }
        }
      },
      React.createElement('span', { className: 'afe-proofreading-adjacent-label' }, label, ` · ${pair.base}`),
      body
    );
  }
}
