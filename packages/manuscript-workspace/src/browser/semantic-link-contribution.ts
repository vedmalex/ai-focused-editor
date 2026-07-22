import {
  Command,
  CommandRegistry,
  DisposableCollection,
  MessageService,
  QuickInputService,
  QuickPickItem
} from '@theia/core/lib/common';
import { nls } from '@theia/core/lib/common/nls';
import URI from '@theia/core/lib/common/uri';
import {
  FrontendApplicationContribution,
  open,
  OpenerService
} from '@theia/core/lib/browser';
import { EditorManager } from '@theia/editor/lib/browser/editor-manager';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { inject, injectable } from '@theia/core/shared/inversify';
import * as monaco from '@theia/monaco-editor-core';
import type { NarrativeEntity } from '../common';
import { NarrativeEntityService } from '../common';
import {
  findHeadingLine,
  noteCreateContent,
  noteCreatePath,
  parseWikiLinks,
  resolveNoteLink,
  resolveRelativeLink,
  tagKindToEntityKind,
  type ResolvedNoteLink,
  type ResolvedRelativeLink,
  type WikiLinkMatch,
  type WikiLinkOffsetRange
} from '../common/link-navigation';
import type { NoteIndex } from '../common/note-index';
import { EntityTypeRegistryService } from './entity-type-registry-service';
import { NoteIndexService } from './note-index-service';

const ENTITY_CACHE_TTL_MS = 5000;

// Standard Markdown inline link `[text](target "optional title")`. The link text
// forbids `]`, so `[[kind:id|label]]` tags, `[@cite:id]`, and `[^footnote]`
// markers (none of which are followed by `(target)`) never match here.
const MARKDOWN_LINK_PATTERN = /\[[^\]\n]*\]\(([^)\s]+)(?:[ \t]+"[^"\n]*")?\)/g;

export namespace SemanticLinkCommands {
  /**
   * Internal opener target for the semantic/relative/note link `command:` URIs;
   * kept out of menus and the command palette. Args: `(uri: string, anchor?: string)`.
   */
  export const OPEN_TARGET: Command = {
    id: 'ai-focused-editor.semanticLink.openTarget'
  };

  /**
   * Click target for an equal-distance-tie note link (plan §2/UR-005(1)): shows a
   * picker over the tied candidates, then opens the choice. Args:
   * `(candidates: string[], anchor?: string)`.
   */
  export const PICK_NOTE: Command = {
    id: 'ai-focused-editor.semanticLink.pickNote'
  };

  /**
   * Click target for an unresolved `[[note]]` reference (plan §2/UR-004(3)/
   * UR-005(4)): retries resolution (including the async title/H1 fallback), and
   * on a genuine miss creates the file at `noteCreatePath` with `noteCreateContent`
   * before opening it. Args: `(notePath: string, documentUri: string, anchor?: string)` —
   * `documentUri` is the FULL `model.uri.toString()` (ISS-144), matching the
   * representation `NoteIndexService`'s candidates are stored in; the
   * scheme-less plain path `noteCreatePath` needs is derived from it locally
   * (see {@link SemanticLinkContribution.openOrCreateNote}), never threaded
   * through the command args as a second string.
   */
  export const CREATE_NOTE: Command = {
    id: 'ai-focused-editor.semanticLink.createNote'
  };
}

/** One `QuickInputService.showQuickPick` row for the equal-distance-tie picker (UR-005(1)). */
interface NotePickItem extends QuickPickItem {
  path: string;
}

/**
 * Chain-resolution outcome for one already-classified (`entity`/`note`, never
 * `invalid`) `parseWikiLinks` token (plan §3's canonical chain). Independent of
 * Monaco/Theia so {@link resolveWikiToken} is directly unit-testable.
 */
export type WikiTokenResolution =
  | { type: 'entity'; entity: NarrativeEntity }
  | { type: 'note'; notePath: string; resolved: ResolvedNoteLink }
  | { type: 'unresolved'; notePath: string };

/**
 * Resolve one classified `[[...]]` token through the plan §3 chain: entity by
 * kind+id (`entity`-class tokens) or by bare id (`note`-class tokens, e.g.
 * `[[sharan-108]]` — UR-002/UR-003(a) backward compatibility with the
 * pre-TASK-013 bare-entity corpus) FIRST; then note basename/path/title
 * resolution (`resolveNoteLink`, which already folds in whatever the lazily-
 * populated title index knows); else `unresolved`. `mapTagKind` plugs in the
 * caller's tag-kind -> entity-kind mapping (author-declared types, TASK-012)
 * without this function needing the registry service itself.
 *
 * Pure: takes the already-warm entity list and note index as plain arguments, so
 * it needs no Theia service and is directly unit-testable in isolation from
 * Monaco/DI (TASK-013 U4, ISS-139 test-plan item (d)).
 */
export function resolveWikiToken(
  token: WikiLinkMatch,
  entities: readonly NarrativeEntity[],
  mapTagKind: (kind: string) => string,
  index: NoteIndex,
  documentPath: string
): WikiTokenResolution {
  const bareId = token.class === 'entity' ? token.id! : token.notePath!;
  const entity = findEntityById(entities, token.class === 'entity' ? token.kind : undefined, bareId, mapTagKind);
  if (entity) {
    return { type: 'entity', entity };
  }

  const notePath = token.class === 'entity' ? `${token.kind}:${token.id}` : token.notePath!;
  const resolved = resolveNoteLink(notePath, documentPath, index.byBasename, index.titleIndex);
  if (resolved) {
    return { type: 'note', notePath, resolved };
  }
  return { type: 'unresolved', notePath };
}

function findEntityById(
  entities: readonly NarrativeEntity[],
  kind: string | undefined,
  id: string,
  mapTagKind: (kind: string) => string
): NarrativeEntity | undefined {
  if (kind) {
    const entityKind = mapTagKind(kind);
    return entities.find(entity => entity.kind === entityKind && entity.id === id);
  }
  return entities.find(entity => entity.id === id);
}

/**
 * Clickable/linkable range for a classified `[[...]]` token: the whole token,
 * except when an alias (`|label`) is present — the range then stops right before
 * the `|`, keeping the display label directly editable/non-navigational. This
 * generalizes the pre-TASK-013 `semanticTagLinkRange` rule (labeled entity tags
 * only) to every alias-bearing token, entity or note, since `parseWikiLinks` is
 * now the single classification source for both (U4, ISS-138).
 */
export function wikiTokenLinkRange(token: WikiLinkMatch): WikiLinkOffsetRange {
  if (token.alias === undefined) {
    return token.range;
  }
  const pipeOffset = token.raw.indexOf('|');
  return { start: token.range.start, end: token.range.start + pipeOffset };
}

/**
 * Retry a still-unresolved note reference through the async title/H1 fallback
 * (plan §3 step 3 / UR-005(2)): `resolveTitleLazily` is called once per indexed
 * note (in index order); each call's mtime-cached read is allowed to mutate the
 * shared `index.titleIndex` (via `NoteIndexService.resolveTitleLazily`'s own
 * `registerNoteTitle` side effect), and `resolveNoteLink` is retried after every
 * single resolution — short-circuiting the moment a match appears rather than
 * exhausting the whole vault.
 *
 * Only ever invoked from the click-time open/create-note flow, never from the
 * Monaco link-provider hot path (`collectWikiLinks` stays synchronous/in-memory
 * only) — this is the one place TASK-013 §3/rule 6 permits filesystem reads
 * while resolving a wiki-link, precisely because it runs once per user click,
 * not once per keystroke.
 *
 * Pure aside from the injected `resolveTitleLazily` callback, so it is directly
 * unit-testable with a fake index + a fake resolver that mutates `titleIndex`
 * the same way the real service does.
 */
export async function resolveNoteWithTitleFallback(
  notePath: string,
  documentPath: string,
  index: NoteIndex,
  resolveTitleLazily: (path: string) => Promise<string | undefined>
): Promise<ResolvedNoteLink | undefined> {
  const direct = resolveNoteLink(notePath, documentPath, index.byBasename, index.titleIndex);
  if (direct) {
    return direct;
  }
  for (const entry of index.entries) {
    await resolveTitleLazily(entry.path);
    const retried = resolveNoteLink(notePath, documentPath, index.byBasename, index.titleIndex);
    if (retried) {
      return retried;
    }
  }
  return undefined;
}

/**
 * Clickable Markdown navigation (spec: "навигация по кликам по ссылкам, терминам
 * и артефактам"). Registers a single Monaco link provider for `markdown` that
 * turns three things into links, all routed through internal `command:` URIs so
 * activation does not fight Monaco's default URL handling (mirrors the footnote
 * link provider's technique):
 *
 * 1. Semantic entity tags — `[[kind:id|label]]` (only the `[[kind:id` portion is
 *    linkified, keeping the label editable), plus bare `[[id]]` / unlabeled
 *    `[[kind:id]]` — open the entity's YAML through the {@link OpenerService}, so
 *    the entity form editor wins. Unknown ids get no link (TASK-013 §2: an
 *    `entity`-class token whose id fails BOTH entity and note-path resolution is
 *    left unlinked — a `kind:id` string is never a sane note path, so no
 *    create-note offer is made for it either; see {@link collectWikiLinks}).
 * 2. Obsidian-style `[[note]]` wiki-links (TASK-013) — resolved via the plan §3
 *    chain (entity by kind+id/bare id FIRST, then `NoteIndexService`'s vault-wide
 *    basename/title index): a clear match opens the file (`#anchor` reveals the
 *    matching heading via `slugifyBase`/`findHeadingLine`, same as relative
 *    links); an equal-distance tie (UR-005(1)) opens a `QuickInputService` picker
 *    over the tied candidates; an unresolved note-class token offers to create
 *    the file (`noteCreatePath`/`noteCreateContent`, UR-004(3)/UR-005(4)) then
 *    opens it.
 * 3. Relative Markdown links — `[text](path.md#anchor)` that resolve inside the
 *    workspace root open the target; a trailing `#anchor` reveals the matching
 *    heading.
 *
 * Coexists with the `[@cite:id]` and footnote link providers: Monaco merges
 * providers, and these syntaxes never share a range.
 */
@injectable()
export class SemanticLinkContribution implements FrontendApplicationContribution {
  @inject(NarrativeEntityService)
  protected readonly narrativeEntities!: NarrativeEntityService;

  @inject(EditorManager)
  protected readonly editorManager!: EditorManager;

  @inject(OpenerService)
  protected readonly openerService!: OpenerService;

  @inject(WorkspaceService)
  protected readonly workspaceService!: WorkspaceService;

  @inject(CommandRegistry)
  protected readonly commands!: CommandRegistry;

  @inject(EntityTypeRegistryService)
  protected readonly entityTypeRegistry!: EntityTypeRegistryService;

  @inject(NoteIndexService)
  protected readonly noteIndex!: NoteIndexService;

  @inject(FileService)
  protected readonly fileService!: FileService;

  @inject(QuickInputService)
  protected readonly quickInput!: QuickInputService;

  @inject(MessageService)
  protected readonly messages!: MessageService;

  protected readonly toDispose = new DisposableCollection();
  protected cachedEntities: NarrativeEntity[] = [];
  protected cacheExpiresAt = 0;

  onStart(): void {
    this.toDispose.push(this.commands.registerCommand(SemanticLinkCommands.OPEN_TARGET, {
      execute: (uri?: string, anchor?: string) => this.openTarget(uri, anchor)
    }));
    this.toDispose.push(this.commands.registerCommand(SemanticLinkCommands.PICK_NOTE, {
      execute: (candidates?: string[], anchor?: string) => this.pickNoteTarget(candidates, anchor)
    }));
    this.toDispose.push(this.commands.registerCommand(SemanticLinkCommands.CREATE_NOTE, {
      execute: (notePath?: string, documentUri?: string, anchor?: string) =>
        this.openOrCreateNote(notePath, documentUri, anchor)
    }));
    this.toDispose.push(monaco.languages.registerLinkProvider(
      { language: 'markdown' },
      { provideLinks: model => this.provideLinks(model) }
    ));
  }

  onStop(): void {
    this.toDispose.dispose();
  }

  protected async provideLinks(model: monaco.editor.ITextModel): Promise<monaco.languages.ILinksList> {
    const text = model.getValue();
    const links: monaco.languages.ILink[] = [];

    this.collectWikiLinks(model, text, await this.getEntities(), links);
    this.collectRelativeLinks(model, text, links);

    return { links };
  }

  /**
   * Linkify every classified `[[...]]` token (plan §2/§3) via a single
   * `parseWikiLinks` scan — the TASK-013 U4 migration off the two-scan
   * `parseSemanticMarkdown`(labeled)/`parseBareEntityTags`(bare) split (ISS-138).
   * Stays synchronous/in-memory only (`NoteIndexService.getIndex()` + the 5s
   * entity cache) — no filesystem reads on this hot path (rule 6); the async
   * title/H1 fallback only ever runs from the click handlers below.
   *
   * `documentUri` is `model.uri.toString()` — the FULL, percent-encoded URI
   * string, NOT the bare `.path` (ISS-144 fix). `NoteIndexService`'s index
   * candidates are `FileSearchService.find` results, i.e. full `file://...`
   * strings (same convention `semantic-markdown-decoration-service.ts` and
   * `semantic-markdown-preview-widget.ts` already use for their own
   * `resolveNoteLink`/`resolveWikiToken` calls). Passing the scheme-less
   * `.path` here instead — as this method used to — desyncs `resolveNoteLink`'s
   * directory-distance tie-break (`pathDistance` never finds a common ancestor
   * between a `file:///...` candidate and a scheme-less document path, so the
   * "closest to this chapter" tie-break degenerates into a bare alphabetical
   * pick) and, for a resolved note, produced a broken double-scheme open target
   * (`root.withPath(<full file:// URI>)`). A resolved note's target is now
   * opened via `new URI(resolved.path)` directly — `resolved.path` IS already a
   * complete file URI, exactly like `semantic-markdown-preview-widget.ts`'s
   * `openNoteTarget` — so no workspace root is needed to build it.
   */
  protected collectWikiLinks(
    model: monaco.editor.ITextModel,
    text: string,
    entities: NarrativeEntity[],
    links: monaco.languages.ILink[]
  ): void {
    const documentUri = model.uri.toString();
    const index = this.noteIndex.getIndex();

    for (const token of parseWikiLinks(text)) {
      if (token.class === 'invalid') {
        continue;
      }
      const resolution = resolveWikiToken(
        token,
        entities,
        kind => this.tagKindToEntityKind(kind),
        index,
        documentUri
      );
      const range = this.toMonacoTokenRange(model, token);

      if (resolution.type === 'entity') {
        links.push({
          range,
          url: this.openTargetUri(resolution.entity.uri),
          tooltip: this.entityTooltip(resolution.entity)
        });
        continue;
      }

      if (resolution.type === 'note') {
        const { resolved } = resolution;
        if (resolved.ambiguous && resolved.candidates) {
          links.push({
            range,
            url: this.pickNoteUri(resolved.candidates, token.anchor),
            tooltip: this.ambiguousNoteTooltip()
          });
          continue;
        }
        links.push({
          range,
          url: this.openTargetUri(new URI(resolved.path).toString(), token.anchor),
          tooltip: this.noteTooltip(resolved.path, token.anchor)
        });
        continue;
      }

      // `unresolved`: only a genuine `note`-class token (a human note name/path)
      // gets a create-note link. An `entity`-class token that failed both entity
      // and note resolution stays unlinked — its reconstructed `kind:id` path is
      // never a sane note name (`:` is invalid in mac/win filenames, plan §1),
      // and the historical contract for an unknown entity id is "no link".
      if (token.class === 'note') {
        links.push({
          range,
          url: this.createNoteUri(resolution.notePath, documentUri, token.anchor),
          tooltip: this.unresolvedNoteTooltip(resolution.notePath)
        });
      }
    }
  }

  /** Linkify relative `[text](path#anchor)` targets that stay inside the workspace. */
  protected collectRelativeLinks(
    model: monaco.editor.ITextModel,
    text: string,
    links: monaco.languages.ILink[]
  ): void {
    const root = this.getWorkspaceRoot();
    if (!root) {
      return;
    }
    const documentPath = model.uri.path;
    const rootPath = root.path.toString();

    MARKDOWN_LINK_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = MARKDOWN_LINK_PATTERN.exec(text)) !== null) {
      // Leave image sources (`![alt](src)`) to their own rendering.
      if (match.index > 0 && text.charCodeAt(match.index - 1) === 33 /* ! */) {
        continue;
      }
      const target = match[1];
      const resolved = resolveRelativeLink(target, documentPath, rootPath);
      if (!resolved) {
        continue;
      }
      const targetOffset = match.index + match[0].indexOf('](') + 2;
      const start = model.getPositionAt(targetOffset);
      const end = model.getPositionAt(targetOffset + target.length);
      links.push({
        range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
        url: this.openTargetUri(root.withPath(resolved.path).toString(), resolved.anchor),
        tooltip: this.relativeTooltip(resolved)
      });
    }
  }

  /**
   * Map a tag kind to its entity kind via the EFFECTIVE type list (built-in +
   * author-declared), so an author type whose tag kind differs from its id (e.g.
   * `[[sl:...]]` → the `sloka` kind) resolves to its cards. When no effective type
   * claims the tag kind, fall back to the registry passthrough
   * ({@link tagKindToEntityKind}) — base behavior is unchanged: `char` → `character`,
   * every other built-in verbatim, and truly unknown kinds pass through untouched.
   */
  protected tagKindToEntityKind(tagKind: string): string {
    const descriptor = this.entityTypeRegistry.getEffectiveTypes().find(type => type.tagKind === tagKind);
    return descriptor?.id ?? tagKindToEntityKind(tagKind);
  }

  protected entityTooltip(entity: NarrativeEntity): string {
    // `entity.kind` is a data enum value (semantic tag kind), left untranslated.
    return nls.localize('ai-focused-editor/editor/link-open-entity', 'Open {0} ({1})', entity.label, entity.kind);
  }

  protected relativeTooltip(resolved: ResolvedRelativeLink): string {
    const name = resolved.path.slice(resolved.path.lastIndexOf('/') + 1);
    return resolved.anchor
      ? nls.localize('ai-focused-editor/editor/link-open-anchor', 'Open {0}#{1}', name, resolved.anchor)
      : nls.localize('ai-focused-editor/editor/link-open-file', 'Open {0}', name);
  }

  protected noteTooltip(path: string, anchor?: string): string {
    const name = path.slice(path.lastIndexOf('/') + 1);
    return anchor
      ? nls.localize('ai-focused-editor/editor/link-open-note-anchor', 'Open {0}#{1}', name, anchor)
      : nls.localize('ai-focused-editor/editor/link-open-note', 'Open {0}', name);
  }

  protected ambiguousNoteTooltip(): string {
    return nls.localize(
      'ai-focused-editor/editor/link-ambiguous-note',
      'Ambiguous note link — multiple files match; click to choose.'
    );
  }

  protected unresolvedNoteTooltip(notePath: string): string {
    return nls.localize(
      'ai-focused-editor/editor/link-unresolved-note',
      'Note "{0}" not found — click to create it.',
      notePath
    );
  }

  protected openTargetUri(uri: string, anchor?: string): monaco.Uri {
    const args = encodeURIComponent(JSON.stringify(anchor ? [uri, anchor] : [uri]));
    return monaco.Uri.parse(`command:${SemanticLinkCommands.OPEN_TARGET.id}?${args}`);
  }

  protected pickNoteUri(candidates: string[], anchor?: string): monaco.Uri {
    const args = encodeURIComponent(JSON.stringify(anchor ? [candidates, anchor] : [candidates]));
    return monaco.Uri.parse(`command:${SemanticLinkCommands.PICK_NOTE.id}?${args}`);
  }

  protected createNoteUri(notePath: string, documentUri: string, anchor?: string): monaco.Uri {
    const args = encodeURIComponent(JSON.stringify(anchor ? [notePath, documentUri, anchor] : [notePath, documentUri]));
    return monaco.Uri.parse(`command:${SemanticLinkCommands.CREATE_NOTE.id}?${args}`);
  }

  protected toMonacoTokenRange(model: monaco.editor.ITextModel, token: WikiLinkMatch): monaco.Range {
    const range = wikiTokenLinkRange(token);
    const start = model.getPositionAt(range.start);
    const end = model.getPositionAt(range.end);
    return new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column);
  }

  /**
   * Opener for every link kind (entity, resolved note, created note, relative
   * link). With an anchor, open the target as a text editor and reveal the
   * matching heading; otherwise open through the OpenerService so the entity
   * form editor wins for entity YAML.
   */
  protected async openTarget(uri?: string, anchor?: string): Promise<void> {
    if (typeof uri !== 'string' || uri.length === 0) {
      return;
    }
    const target = new URI(uri);
    if (typeof anchor === 'string' && anchor.length > 0) {
      const widget = await this.editorManager.open(target, { mode: 'reveal' });
      const editor = widget?.editor;
      if (editor) {
        const line = findHeadingLine(editor.document.getText(), anchor);
        if (line !== undefined) {
          const position = { line, character: 0 };
          editor.cursor = position;
          editor.revealPosition(position);
        }
      }
      return;
    }
    await open(this.openerService, target);
  }

  /**
   * Click handler for an equal-distance-tie note link (UR-005(1)): pick one of
   * the tied candidates, then open it. `candidates` entries are full workspace
   * file URIs, as stored in `NoteIndexService`'s index (ISS-144) — opened via
   * `new URI(picked.path)` directly, same as {@link collectWikiLinks}'s
   * resolved-note branch and `semantic-markdown-preview-widget.ts`'s
   * `openNoteTarget`; no workspace root needed to build the target.
   */
  protected async pickNoteTarget(candidates?: string[], anchor?: string): Promise<void> {
    if (!Array.isArray(candidates) || candidates.length === 0) {
      return;
    }
    const picked = await this.quickInput.showQuickPick<NotePickItem>(
      candidates.map(path => ({ label: this.noteBasename(path), description: path, path })),
      {
        title: nls.localize('ai-focused-editor/editor/link-pick-note-title', 'Ambiguous Note Link'),
        placeholder: nls.localize(
          'ai-focused-editor/editor/link-pick-note-placeholder',
          'Multiple notes match this link — choose one'
        )
      }
    );
    if (!picked) {
      return;
    }
    await this.openTarget(new URI(picked.path).toString(), anchor);
  }

  /**
   * Click handler for an unresolved `[[note]]` reference (plan §2/UR-004(3)/
   * UR-005(4)): retries resolution once more — including the async title/H1
   * fallback (the one place it runs, per rule 6; the index may also simply have
   * rebuilt since the link was last rendered). Still unresolved -> create the
   * file at `noteCreatePath` with `noteCreateContent` (`# Имя`, no front matter),
   * then open it.
   *
   * `documentUri` is the FULL `model.uri.toString()` threaded through
   * {@link SemanticLinkCommands.CREATE_NOTE} (ISS-144) — it, not a scheme-less
   * path, is what `resolveNoteWithTitleFallback`/`resolveNoteLink` need to
   * match `NoteIndexService`'s full-URI index candidates for a meaningful
   * directory-distance tie-break. `noteCreatePath`, by contrast, does plain
   * POSIX path arithmetic against `rootPath` (`root.path.toString()`, itself
   * scheme-less) — so the scheme-less form it needs is derived locally from
   * `documentUri` via `new URI(documentUri).path.toString()`, never threaded
   * through the command args as a second representation.
   */
  protected async openOrCreateNote(notePath?: string, documentUri?: string, anchor?: string): Promise<void> {
    if (typeof notePath !== 'string' || typeof documentUri !== 'string') {
      return;
    }
    const root = this.getWorkspaceRoot();
    if (!root) {
      return;
    }

    const index = this.noteIndex.getIndex();
    const resolved = await resolveNoteWithTitleFallback(
      notePath,
      documentUri,
      index,
      path => this.noteIndex.resolveTitleLazily(path)
    );
    if (resolved) {
      if (resolved.ambiguous && resolved.candidates) {
        await this.pickNoteTarget(resolved.candidates, anchor);
        return;
      }
      await this.openTarget(new URI(resolved.path).toString(), anchor);
      return;
    }

    const documentPath = new URI(documentUri).path.toString();
    const createPath = noteCreatePath(notePath, documentPath, root.path.toString());
    const fileUri = root.withPath(createPath);
    try {
      await this.ensureFolder(fileUri.parent);
      await this.fileService.create(fileUri, noteCreateContent(notePath), { overwrite: false });
    } catch (error) {
      this.messages.warn(nls.localize(
        'ai-focused-editor/editor/link-create-note-failed',
        'Could not create note {0}: {1}',
        fileUri.path.base,
        this.detail(error)
      ));
      return;
    }
    await this.openTarget(fileUri.toString(), anchor);
  }

  protected async ensureFolder(uri: URI): Promise<void> {
    try {
      await this.fileService.createFolder(uri);
    } catch {
      // Folder already exists — expected.
    }
  }

  protected detail(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  protected noteBasename(path: string): string {
    return path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '');
  }

  protected getWorkspaceRoot(): URI | undefined {
    return this.workspaceService.tryGetRoots()[0]?.resource;
  }

  /** Refresh the 5s entity cache; kept warm so `provideLinks` stays synchronous. */
  protected async getEntities(): Promise<NarrativeEntity[]> {
    const now = Date.now();
    if (now < this.cacheExpiresAt) {
      return this.cachedEntities;
    }
    try {
      const snapshot = await this.narrativeEntities.getSnapshot();
      this.cachedEntities = snapshot.entities;
    } catch {
      // Keep the previous cache if the snapshot RPC fails.
    }
    this.cacheExpiresAt = now + ENTITY_CACHE_TTL_MS;
    return this.cachedEntities;
  }
}
