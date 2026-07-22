import { injectable, inject } from '@theia/core/shared/inversify';
import { Emitter, Event } from '@theia/core/lib/common/event';
import { DisposableCollection } from '@theia/core/lib/common';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import URI from '@theia/core/lib/common/uri';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { FileSearchService } from '@theia/file-search/lib/common/file-search-service';
import { buildNoteIndex, extractNoteTitle, registerNoteTitle, type NoteIndex } from '../common/note-index';

/** Vault-wide markdown glob — the note-link resolution source for TASK-013 (UR-003/UR-004: "all .md in the workspace", flat + case-insensitive). */
const MARKDOWN_GLOB = '**/*.md';

/**
 * Rebuild-coalescing window for bursts of filesystem changes. Mirrors the
 * 300ms `AUTO_REFRESH_DELAY_MS` used by `ManuscriptTreeModel` for its own
 * FileService-driven rebuilds; sits inside the plan's 300-500ms band.
 */
const REBUILD_DEBOUNCE_MS = 400;

/**
 * Safety-net rebuild interval (plan §3: "страховочный TTL"). Catches drift
 * from any filesystem change the watcher/debounce path might miss (e.g. a
 * provider that does not emit `onDidFilesChange` for a given mutation). Not a
 * substitute for the change-driven rebuild — just a backstop.
 */
const SAFETY_NET_TTL_MS = 5 * 60 * 1000;

/** Generous upper bound on indexed notes; bounds the FileSearchService call rather than expressing an expected vault size. */
const INDEX_RESULT_LIMIT = 20000;

/**
 * Browser-side singleton maintaining a vault-wide index of markdown notes for
 * Obsidian-style `[[note]]` link resolution (TASK-013 §3).
 *
 * Source of truth: `FileSearchService.find('', {includePatterns:['**\/*.md']})`
 * — confirmed by the ISS-141 smoke-spike (see the U3 implementation report) to
 * return the FULL vault-wide `.md` listing for an empty search pattern, both
 * in the node (ripgrep `--files`) and browser-only (recursive `FileService`
 * walk) `FileSearchService` implementations bundled at `@theia/file-search`
 * 1.73.1 — no bespoke `FileService` walk fallback was needed.
 *
 * Rebuild triggers are INTENTIONALLY limited to: `onStart` (initial load),
 * `FileService.onDidFilesChange` (debounced), and the safety-net TTL. It NEVER
 * rebuilds on editor text changes (`EditorManager`/`onDocumentContentChanged`
 * are never touched here) — a keystroke only ever does an in-memory
 * `index.byBasename.get(...)`, so decorations/link resolution stay off the
 * filesystem on the hot path (plan §3 "Производительность keystroke").
 *
 * No consumers exist yet (U4-U7 land afterwards); this unit only builds and
 * exposes the index plus the lazy title-resolution hook they will use.
 */
@injectable()
export class NoteIndexService implements FrontendApplicationContribution {
  @inject(FileSearchService)
  protected readonly fileSearch!: FileSearchService;

  @inject(FileService)
  protected readonly fileService!: FileService;

  @inject(WorkspaceService)
  protected readonly workspaceService!: WorkspaceService;

  protected readonly toDispose = new DisposableCollection();
  protected readonly onDidChangeEmitter = new Emitter<void>();
  /** Fires after every completed rebuild (initial load, debounced FS-change rebuild, or safety-net tick) — never on a per-keystroke basis. */
  readonly onDidChange: Event<void> = this.onDidChangeEmitter.event;

  protected index: NoteIndex = buildNoteIndex([]);
  protected rebuildTimer: ReturnType<typeof setTimeout> | undefined;
  protected safetyNetTimer: ReturnType<typeof setInterval> | undefined;
  protected rebuildInFlight: Promise<void> | undefined;
  protected rebuildAgainAfter = false;

  /** Lazy title-resolution cache, keyed by note path; invalidated per-entry by mtime (TASK-013 §3/UR-005). */
  protected readonly titleCache = new Map<string, { mtime: number; title: string | undefined }>();

  onStart(): void {
    this.toDispose.push(this.fileService.onDidFilesChange(() => this.scheduleRebuild()));
    this.safetyNetTimer = setInterval(() => this.scheduleRebuild(), SAFETY_NET_TTL_MS);
    this.toDispose.push({ dispose: () => this.clearSafetyNetTimer() });
    void this.rebuild();
  }

  onStop(): void {
    this.toDispose.dispose();
    this.clearSafetyNetTimer();
    if (this.rebuildTimer !== undefined) {
      clearTimeout(this.rebuildTimer);
      this.rebuildTimer = undefined;
    }
  }

  /** The current note index snapshot (basename lookup + flat entries + lazily-populated title lookup). Never undefined — starts empty until the first rebuild resolves. */
  getIndex(): NoteIndex {
    return this.index;
  }

  /**
   * Lazily resolve a display title for `path` on a basename-lookup miss:
   * front-matter `title` first (via {@link extractNoteTitle}, which itself
   * reuses `parseChapterFrontMatter`), then the first `# ` H1. Cached by
   * mtime, so a repeated miss against an unchanged file re-reads nothing.
   * Successful resolutions are folded into `getIndex().titleIndex` via
   * {@link registerNoteTitle} so a later exact-title lookup is free too.
   * Returns `undefined` when the file cannot be stat'd/read, or has neither.
   */
  async resolveTitleLazily(path: string): Promise<string | undefined> {
    const uri = new URI(path);
    let mtime: number;
    try {
      const stat = await this.fileService.resolve(uri, { resolveMetadata: true });
      mtime = stat.mtime;
    } catch {
      return undefined;
    }

    const cached = this.titleCache.get(path);
    if (cached && cached.mtime === mtime) {
      return cached.title;
    }

    let title: string | undefined;
    try {
      const content = await this.fileService.read(uri);
      title = extractNoteTitle(content.value);
    } catch {
      title = undefined;
    }

    this.titleCache.set(path, { mtime, title });
    if (title) {
      registerNoteTitle(this.index, title, path);
    }
    return title;
  }

  protected scheduleRebuild(): void {
    if (this.rebuildTimer !== undefined) {
      clearTimeout(this.rebuildTimer);
    }
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = undefined;
      void this.rebuild();
    }, REBUILD_DEBOUNCE_MS);
  }

  /** Coalesces concurrent rebuild triggers (e.g. a safety-net tick landing mid-rebuild) into a single pass, re-running once more if a trigger arrived during the in-flight rebuild. */
  protected async rebuild(): Promise<void> {
    if (this.rebuildInFlight) {
      this.rebuildAgainAfter = true;
      return this.rebuildInFlight;
    }
    this.rebuildInFlight = this.doRebuild();
    try {
      await this.rebuildInFlight;
    } finally {
      this.rebuildInFlight = undefined;
      if (this.rebuildAgainAfter) {
        this.rebuildAgainAfter = false;
        void this.rebuild();
      }
    }
  }

  protected async doRebuild(): Promise<void> {
    try {
      await this.workspaceService.ready;
      const rootUris = this.workspaceService.tryGetRoots().map(root => root.resource.toString());
      if (rootUris.length === 0) {
        this.index = buildNoteIndex([]);
        this.onDidChangeEmitter.fire();
        return;
      }
      const uris = await this.fileSearch.find('', {
        rootUris,
        includePatterns: [MARKDOWN_GLOB],
        useGitIgnore: true,
        limit: INDEX_RESULT_LIMIT
      });
      this.index = buildNoteIndex(uris);
      this.onDidChangeEmitter.fire();
    } catch {
      // Keep the previous index on a transient FileSearchService/FS error
      // rather than clearing every note link's resolution mid-session.
    }
  }

  protected clearSafetyNetTimer(): void {
    if (this.safetyNetTimer !== undefined) {
      clearInterval(this.safetyNetTimer);
      this.safetyNetTimer = undefined;
    }
  }
}
