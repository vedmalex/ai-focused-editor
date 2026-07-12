import { parseSemanticMarkdown } from '@ai-focused-editor/semantic-markdown';
import {
  Command,
  CommandRegistry,
  DisposableCollection
} from '@theia/core/lib/common';
import { nls } from '@theia/core/lib/common/nls';
import URI from '@theia/core/lib/common/uri';
import {
  FrontendApplicationContribution,
  open,
  OpenerService
} from '@theia/core/lib/browser';
import { EditorManager } from '@theia/editor/lib/browser/editor-manager';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { inject, injectable } from '@theia/core/shared/inversify';
import * as monaco from '@theia/monaco-editor-core';
import type { NarrativeEntity } from '../common';
import { NarrativeEntityService } from '../common';
import {
  findHeadingLine,
  parseBareEntityTags,
  resolveRelativeLink,
  semanticTagLinkRange,
  tagKindToEntityKind,
  type ResolvedRelativeLink
} from '../common/link-navigation';
import { EntityTypeRegistryService } from './entity-type-registry-service';

const ENTITY_CACHE_TTL_MS = 5000;

// Standard Markdown inline link `[text](target "optional title")`. The link text
// forbids `]`, so `[[kind:id|label]]` tags, `[@cite:id]`, and `[^footnote]`
// markers (none of which are followed by `(target)`) never match here.
const MARKDOWN_LINK_PATTERN = /\[[^\]\n]*\]\(([^)\s]+)(?:[ \t]+"[^"\n]*")?\)/g;

export namespace SemanticLinkCommands {
  /**
   * Internal opener target for the semantic/relative link `command:` URIs; kept
   * out of menus and the command palette. Args: `(uri: string, anchor?: string)`.
   */
  export const OPEN_TARGET: Command = {
    id: 'ai-focused-editor.semanticLink.openTarget'
  };
}

/**
 * Clickable Markdown navigation (spec: "навигация по кликам по ссылкам, терминам
 * и артефактам"). Registers a single Monaco link provider for `markdown` that
 * turns two things into links, both routed through the internal
 * {@link SemanticLinkCommands.OPEN_TARGET} command so activation does not fight
 * Monaco's default URL handling (mirrors the footnote link provider's technique):
 *
 * 1. Semantic entity tags — `[[kind:id|label]]` (only the `[[kind:id` portion is
 *    linkified, keeping the label editable), plus bare `[[id]]` / unlabeled
 *    `[[kind:id]]` — open the entity's YAML through the {@link OpenerService}, so
 *    the entity form editor wins. Unknown ids get no link.
 * 2. Relative Markdown links — `[text](path.md#anchor)` that resolve inside the
 *    workspace root open the target; a trailing `#anchor` reveals the matching
 *    heading.
 *
 * Coexists with the `[@cite:id]` and footnote link providers: Monaco merges
 * providers, and the three syntaxes never share a range.
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

  protected readonly toDispose = new DisposableCollection();
  protected cachedEntities: NarrativeEntity[] = [];
  protected cacheExpiresAt = 0;

  onStart(): void {
    this.toDispose.push(this.commands.registerCommand(SemanticLinkCommands.OPEN_TARGET, {
      execute: (uri?: string, anchor?: string) => this.openTarget(uri, anchor)
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

    this.collectEntityLinks(model, text, await this.getEntities(), links);
    this.collectRelativeLinks(model, text, links);

    return { links };
  }

  /** Linkify labeled, unlabeled, and bare semantic entity tags to their cards. */
  protected collectEntityLinks(
    model: monaco.editor.ITextModel,
    text: string,
    entities: NarrativeEntity[],
    links: monaco.languages.ILink[]
  ): void {
    if (entities.length === 0) {
      return;
    }

    for (const tag of parseSemanticMarkdown(text).tags) {
      const entity = this.resolveEntity(entities, tag.kind, tag.id);
      if (!entity) {
        continue;
      }
      links.push({
        range: this.toMonacoRange(semanticTagLinkRange(tag)),
        url: this.openTargetUri(entity.uri),
        tooltip: this.entityTooltip(entity)
      });
    }

    for (const bare of parseBareEntityTags(text)) {
      const entity = this.resolveEntity(entities, bare.kind, bare.id);
      if (!entity) {
        continue;
      }
      const start = model.getPositionAt(bare.start);
      const end = model.getPositionAt(bare.end);
      links.push({
        range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
        url: this.openTargetUri(entity.uri),
        tooltip: this.entityTooltip(entity)
      });
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

  protected resolveEntity(
    entities: NarrativeEntity[],
    kind: string | undefined,
    id: string
  ): NarrativeEntity | undefined {
    if (kind) {
      const entityKind = this.tagKindToEntityKind(kind);
      return entities.find(entity => entity.kind === entityKind && entity.id === id);
    }
    return entities.find(entity => entity.id === id);
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

  protected openTargetUri(uri: string, anchor?: string): monaco.Uri {
    const args = encodeURIComponent(JSON.stringify(anchor ? [uri, anchor] : [uri]));
    return monaco.Uri.parse(`command:${SemanticLinkCommands.OPEN_TARGET.id}?${args}`);
  }

  protected toMonacoRange(range: ReturnType<typeof semanticTagLinkRange>): monaco.Range {
    return new monaco.Range(
      range.start.line + 1,
      range.start.character + 1,
      range.end.line + 1,
      range.end.character + 1
    );
  }

  /**
   * Opener for both link kinds. With an anchor, open the target as a text editor
   * and reveal the matching heading; otherwise open through the OpenerService so
   * the entity form editor wins for entity YAML.
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
