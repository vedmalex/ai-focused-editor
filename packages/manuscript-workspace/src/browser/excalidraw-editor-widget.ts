import URI from '@theia/core/lib/common/uri';
import { Emitter, Event, MessageService } from '@theia/core/lib/common';
import { Navigatable } from '@theia/core/lib/browser';
import { Saveable, SaveOptions } from '@theia/core/lib/browser/saveable';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { ThemeService } from '@theia/core/lib/browser/theming';
import { nls } from '@theia/core/lib/common/nls';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { inject, injectable } from '@theia/core/shared/inversify';
import React from '@theia/core/shared/react';

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
}
interface ExcalidrawModule {
  Excalidraw: React.ComponentType<Record<string, unknown>>;
  serializeAsJSON(
    elements: readonly unknown[],
    appState: Record<string, unknown>,
    files: Record<string, unknown>,
    type: 'local' | 'database'
  ): string;
}

/** Parsed `.excalidraw` scene passed to the component as `initialData`. */
interface ExcalidrawSceneData {
  elements: unknown[];
  appState: Record<string, unknown>;
  files: Record<string, unknown>;
}

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

  protected uri!: URI;
  protected loading = true;
  protected error: string | undefined;
  protected component: ExcalidrawModule | undefined;
  protected initialData: ExcalidrawSceneData | undefined;
  protected api: ExcalidrawImperativeApi | undefined;
  protected theme: 'light' | 'dark' = 'light';

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

  protected markDirty(): void {
    this.onContentChangedEmitter.fire();
    if (!this._dirty) {
      this._dirty = true;
      this.onDirtyChangedEmitter.fire();
    }
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
    if (this._dirty) {
      this._dirty = false;
      this.onDirtyChangedEmitter.fire();
    }
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
        onChange: () => this.markDirty()
      })
    );
  }
}
