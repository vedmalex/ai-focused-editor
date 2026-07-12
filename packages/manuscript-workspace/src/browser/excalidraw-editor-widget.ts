import URI from '@theia/core/lib/common/uri';
import { Emitter, Event, MessageService } from '@theia/core/lib/common';
import { Navigatable, open, OpenerService } from '@theia/core/lib/browser';
import { Saveable, SaveOptions } from '@theia/core/lib/browser/saveable';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { ThemeService } from '@theia/core/lib/browser/theming';
import { nls } from '@theia/core/lib/common/nls';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { inject, injectable } from '@theia/core/shared/inversify';
import React from '@theia/core/shared/react';
import { NarrativeEntityService, parseEntityLink } from '../common';

/**
 * Minimal shape of the parts of the `@excalidraw/excalidraw` module and its
 * imperative API that this widget touches. The real package types are pulled in
 * against React 19's JSX runtime, which would fight our ES2017 `.ts` compile, so
 * the dynamic import is cast to this local contract instead.
 */
interface ExcalidrawImperativeApi {
  getSceneElements(): readonly unknown[];
  getAppState(): Record<string, unknown>;
  getFiles(): Record<string, unknown>;
  updateScene(scene: { elements?: readonly unknown[]; appState?: Record<string, unknown> }): void;
}

/**
 * The imperative-API surface the canvas-conveniences commands need: read the
 * current selection + scene and push a replacement scene back. Exposed via
 * {@link ExcalidrawEditorWidget.getApi} so the command contribution never
 * re-imports Excalidraw or reaches into widget internals.
 */
export interface ExcalidrawCanvasApi {
  getSceneElements(): readonly unknown[];
  getAppState(): Record<string, unknown>;
  updateScene(scene: { elements?: readonly unknown[]; appState?: Record<string, unknown> }): void;
}
interface ExcalidrawModule {
  Excalidraw: React.ComponentType<Record<string, unknown>>;
  serializeAsJSON(
    elements: readonly unknown[],
    appState: Record<string, unknown>,
    files: Record<string, unknown>,
    type: 'local' | 'database'
  ): string;
  /**
   * Idiomatic scene-version hash: a monotonically-derived number over the scene
   * elements' individual versions. Stable across the mount/render `onChange`
   * echoes that Excalidraw fires without a real edit, so it is the reliable
   * dirty-tracking signal (a blank scene hashes to `0`).
   */
  getSceneVersion(elements: readonly unknown[]): number;
  exportToBlob(opts: {
    elements: readonly unknown[];
    appState?: Record<string, unknown>;
    files: Record<string, unknown> | null;
    exportPadding?: number;
    mimeType?: string;
    quality?: number;
  }): Promise<Blob>;
  exportToSvg(opts: {
    elements: readonly unknown[];
    appState?: Record<string, unknown>;
    files: Record<string, unknown> | null;
    exportPadding?: number;
  }): Promise<SVGSVGElement>;
  /**
   * Turns a lightweight element "skeleton" (e.g. `{type:'text', x, y, text}`)
   * into a fully-formed Excalidraw element, filling in ids, seeds, versions and
   * binding metadata. The canvas-conveniences commands build their new elements
   * through this so they never hand-fill `versionNonce`/`seed`.
   */
  convertToExcalidrawElements(
    skeleton: readonly Record<string, unknown>[],
    opts?: { regenerateIds?: boolean }
  ): unknown[];
}

/** Subset of {@link ExcalidrawModule} the canvas-conveniences commands consume. */
export type ExcalidrawCanvasModule = Pick<ExcalidrawModule, 'convertToExcalidrawElements'>;

/** Parsed `.excalidraw` scene passed to the component as `initialData`. */
interface ExcalidrawSceneData {
  elements: unknown[];
  appState: Record<string, unknown>;
  files: Record<string, unknown>;
}

/** Live scene snapshot handed to the export commands (see `getExportSource`). */
export interface ExcalidrawExportSource {
  elements: readonly unknown[];
  appState: Record<string, unknown>;
  files: Record<string, unknown>;
}

/** Subset of {@link ExcalidrawModule} the export commands consume. */
export type ExcalidrawExportModule = Pick<ExcalidrawModule, 'exportToBlob' | 'exportToSvg'>;

/**
 * Path (relative to the served frontend root) where the browser app copies the
 * self-hosted Excalidraw fonts and stylesheet during `theia build`
 * (see `apps/browser/esbuild.mjs`). Setting `window.EXCALIDRAW_ASSET_PATH` to
 * this before the component loads keeps font loading OFFLINE — Excalidraw would
 * otherwise fetch woff2 files from its `esm.sh` CDN fallback.
 */
const EXCALIDRAW_ASSET_PATH = './excalidraw-assets/';

let excalidrawModulePromise: Promise<ExcalidrawModule> | undefined;

/**
 * Wire the offline asset path + stylesheet exactly once, then lazy-load the
 * (heavy) Excalidraw bundle. The stylesheet is injected from the served copy
 * rather than imported into the JS bundle: its `./index.css` package export only
 * exposes `development`/`production` conditions (no `default`), which the
 * `theia build` esbuild run cannot resolve. The served copy also keeps the
 * `@font-face url("./fonts/...")` references resolving to our self-hosted fonts.
 */
function loadExcalidraw(): Promise<ExcalidrawModule> {
  if (!excalidrawModulePromise) {
    const globalWindow = window as unknown as { EXCALIDRAW_ASSET_PATH?: string };
    if (!globalWindow.EXCALIDRAW_ASSET_PATH) {
      globalWindow.EXCALIDRAW_ASSET_PATH = EXCALIDRAW_ASSET_PATH;
    }
    if (!document.getElementById('afe-excalidraw-styles')) {
      const link = document.createElement('link');
      link.id = 'afe-excalidraw-styles';
      link.rel = 'stylesheet';
      link.href = `${EXCALIDRAW_ASSET_PATH}index.css`;
      document.head.appendChild(link);
    }
    excalidrawModulePromise = import('@excalidraw/excalidraw') as unknown as Promise<ExcalidrawModule>;
  }
  return excalidrawModulePromise;
}

/**
 * Public accessor for the lazily-loaded Excalidraw module's `convertToExcalidrawElements`
 * helper, reusing the same cached module promise the widget uses (no second
 * dynamic import if a diagram is already open). Lets a contribution build real
 * Excalidraw elements — e.g. the relations-map generator — without an open widget.
 */
export function loadExcalidrawCanvasModule(): Promise<ExcalidrawCanvasModule> {
  return loadExcalidraw();
}

/**
 * A ReactWidget editor for `.excalidraw` diagram files. De-risking spike:
 * proves the `@excalidraw/excalidraw` React component bundles under the Theia
 * esbuild pipeline and renders inside a Theia widget, editing and saving the
 * JSON scene through the {@link FileService}.
 *
 * The component is lazy-loaded via {@link loadExcalidraw} so the heavy bundle
 * stays out of the startup path and the bundler surface is isolated behind a
 * single dynamic import.
 */
@injectable()
export class ExcalidrawEditorWidget extends ReactWidget implements Navigatable, Saveable {
  static readonly FACTORY_ID = 'ai-focused-editor.excalidraw-editor';

  @inject(FileService)
  protected readonly fileService!: FileService;

  @inject(ThemeService)
  protected readonly themeService!: ThemeService;

  @inject(MessageService)
  protected readonly messageService!: MessageService;

  @inject(NarrativeEntityService)
  protected readonly narrativeEntities!: NarrativeEntityService;

  @inject(OpenerService)
  protected readonly openerService!: OpenerService;

  protected uri!: URI;
  protected loading = true;
  protected error: string | undefined;
  protected component: ExcalidrawModule | undefined;
  protected initialData: ExcalidrawSceneData | undefined;
  protected api: ExcalidrawImperativeApi | undefined;
  protected theme: 'light' | 'dark' = 'light';

  /**
   * Scene version last persisted to disk (0 for a blank/new scene). `onChange`
   * only dirties the widget when the current scene version diverges from this, so
   * merely opening a diagram — or the mount/render echo `onChange` — never marks
   * it dirty (which previously let Theia autoSave rewrite the file on open).
   */
  protected lastSavedSceneVersion = 0;

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
    this.id = `${ExcalidrawEditorWidget.FACTORY_ID}:${uri.toString()}`;
    this.title.label = uri.path.base;
    this.title.caption = nls.localize('ai-focused-editor/excalidraw/caption', 'Excalidraw: {0}', uri.path.fsPath());
    this.title.iconClass = 'codicon codicon-pencil';
    this.title.closable = true;
    this.addClass('afe-excalidraw-widget');
    this.theme = this.currentTheme();
    this.toDispose.push(this.themeService.onDidColorThemeChange(() => {
      this.theme = this.currentTheme();
      this.update();
    }));
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

  protected currentTheme(): 'light' | 'dark' {
    return this.themeService.getCurrentTheme().type === 'light' ? 'light' : 'dark';
  }

  protected async load(): Promise<void> {
    this.loading = true;
    this.error = undefined;
    this.update();
    try {
      const [module, sceneData] = await Promise.all([
        loadExcalidraw(),
        this.readScene()
      ]);
      this.component = module;
      this.initialData = sceneData;
      // Baseline the saved version from the loaded elements so the scene opens
      // clean; a blank/new scene hashes to 0.
      this.lastSavedSceneVersion = module.getSceneVersion(sceneData.elements);
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.loading = false;
      this.update();
    }
  }

  /**
   * Read and parse the `.excalidraw` JSON. Empty or brand-new files start from a
   * blank scene rather than surfacing a parse error.
   */
  protected async readScene(): Promise<ExcalidrawSceneData> {
    let raw = '';
    try {
      raw = (await this.fileService.read(this.uri)).value;
    } catch {
      // New/unwritten file — start blank.
      return { elements: [], appState: {}, files: {} };
    }
    const trimmed = raw.trim();
    if (!trimmed) {
      return { elements: [], appState: {}, files: {} };
    }
    const parsed = JSON.parse(trimmed) as Partial<ExcalidrawSceneData>;
    return {
      elements: Array.isArray(parsed.elements) ? parsed.elements : [],
      appState: parsed.appState && typeof parsed.appState === 'object' ? parsed.appState : {},
      files: parsed.files && typeof parsed.files === 'object' ? parsed.files : {}
    };
  }

  /**
   * Excalidraw fires `onChange` on mount and on every render, not only on real
   * edits. Comparing the scene version against the last-saved baseline keeps the
   * open/echo `onChange` from dirtying the widget (and triggering autoSave); only
   * a genuine change to the scene flips `dirty` and fires the content/dirty
   * events. The very first echo after mount always matches the baseline, so it is
   * a no-op by construction.
   */
  protected handleSceneChange(elements: readonly unknown[]): void {
    if (!this.component) {
      return;
    }
    const version = this.component.getSceneVersion(elements);
    const dirty = version !== this.lastSavedSceneVersion;
    if (dirty) {
      this.onContentChangedEmitter.fire();
    }
    if (dirty !== this._dirty) {
      this._dirty = dirty;
      this.onDirtyChangedEmitter.fire();
    }
  }

  /**
   * Intercept clicks on an element's `link`. When the link is one of our
   * `afe-entity://kind/id` entity links, take over navigation (preventDefault)
   * and open the entity's card through the {@link OpenerService} — mirroring the
   * semantic-link contribution's resolution so the entity form editor wins. Any
   * other link (external URL, a plain note link) keeps Excalidraw's default
   * behavior. Works in EVERY `.excalidraw`, not just the generated relations map.
   */
  protected handleLinkOpen(element: { link?: string | null }, event: CustomEvent): void {
    const parsed = parseEntityLink(element.link ?? undefined);
    if (!parsed) {
      return;
    }
    event.preventDefault();
    void this.openEntity(parsed.kind, parsed.id);
  }

  protected async openEntity(kind: string, id: string): Promise<void> {
    let uri: string | undefined;
    try {
      const snapshot = await this.narrativeEntities.getSnapshot();
      uri = snapshot.entities.find(entity => entity.kind === kind && entity.id === id)?.uri;
    } catch {
      // Fall through to the "not found" warning below.
    }
    if (!uri) {
      await this.messageService.warn(nls.localize(
        'ai-focused-editor/excalidraw/entity-link-missing',
        'This entity is no longer in the book: {0}:{1}',
        kind,
        id
      ));
      return;
    }
    await open(this.openerService, new URI(uri));
  }

  async save(_options?: SaveOptions): Promise<void> {
    if (!this.api || !this.component) {
      return;
    }
    const elements = this.api.getSceneElements();
    const appState = this.api.getAppState();
    const files = this.api.getFiles();
    const json = this.component.serializeAsJSON(elements, appState, files, 'local');
    await this.fileService.write(this.uri, `${json}\n`);
    // Re-baseline against the just-saved scene so a save clears dirty and any
    // subsequent no-op echo stays clean.
    this.lastSavedSceneVersion = this.component.getSceneVersion(elements);
    if (this._dirty) {
      this._dirty = false;
      this.onDirtyChangedEmitter.fire();
    }
  }

  /**
   * The live Excalidraw module once loaded — exposed so the export commands can
   * reuse the widget's already-resolved bundle instead of triggering a second
   * dynamic import.
   */
  getExportModule(): ExcalidrawExportModule | undefined {
    return this.component;
  }

  /**
   * The `convertToExcalidrawElements` helper from the already-resolved module,
   * for building new elements in the canvas-conveniences commands.
   */
  getCanvasModule(): ExcalidrawCanvasModule | undefined {
    return this.component;
  }

  /**
   * The live imperative API (selection read + `updateScene`) once the component
   * has mounted, or `undefined` before it is ready. Kept separate from
   * {@link getExportModule} so the export accessors stay untouched.
   */
  getApi(): ExcalidrawCanvasApi | undefined {
    return this.api;
  }

  /** Current scene snapshot for export, or `undefined` before the API is ready. */
  getExportSource(): ExcalidrawExportSource | undefined {
    if (!this.api) {
      return undefined;
    }
    return {
      elements: this.api.getSceneElements(),
      appState: this.api.getAppState(),
      files: this.api.getFiles()
    };
  }

  async revert(): Promise<void> {
    await this.load();
    if (this._dirty) {
      this._dirty = false;
      this.onDirtyChangedEmitter.fire();
    }
  }

  protected render(): React.ReactNode {
    if (this.loading) {
      return React.createElement(
        'div',
        { className: 'afe-excalidraw-status' },
        nls.localize('ai-focused-editor/excalidraw/loading', 'Loading Excalidraw...')
      );
    }
    if (this.error || !this.component) {
      return React.createElement(
        'div',
        { className: 'afe-excalidraw-status error' },
        nls.localize('ai-focused-editor/excalidraw/error', 'Could not open diagram: {0}', this.error ?? 'unknown error')
      );
    }
    return React.createElement(
      'div',
      { className: 'afe-excalidraw-canvas' },
      React.createElement(this.component.Excalidraw, {
        initialData: this.initialData,
        theme: this.theme,
        excalidrawAPI: (api: ExcalidrawImperativeApi) => {
          this.api = api;
        },
        onChange: (elements: readonly unknown[]) => this.handleSceneChange(elements),
        onLinkOpen: (element: { link?: string | null }, event: CustomEvent) =>
          this.handleLinkOpen(element, event)
      })
    );
  }
}
