import {
  nextFootnoteNumber,
  normalizeSemanticMarkdownTags,
  parseFootnotes,
  parseSemanticMarkdown
} from '@ai-focused-editor/semantic-markdown';
import {
  Command,
  CommandContribution,
  CommandRegistry,
  MenuContribution,
  MenuModelRegistry,
  MessageService,
  QuickInputService
} from '@theia/core/lib/common';
import { nls } from '@theia/core/lib/common/nls';
import URI from '@theia/core/lib/common/uri';
import { ClipboardService } from '@theia/core/lib/browser/clipboard-service';
import { open, OpenerService } from '@theia/core/lib/browser';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { EditorManager } from '@theia/editor/lib/browser/editor-manager';
import type { TextEditor } from '@theia/editor/lib/browser/editor';
import {
  EDITOR_CONTEXT_MENU,
  EditorContextMenu
} from '@theia/editor/lib/browser/editor-menu';
import { inject, injectable } from '@theia/core/shared/inversify';
import {
  AI_FOCUSED_EDITOR_MENU_LABEL,
  AiFocusedEditorMenus
} from './ai-focused-editor-menu';
import {
  buildEntityYaml,
  createSemanticEntityId,
  CreatableEntityKind,
  entityRelativePath,
  ENTITY_KIND_LABEL,
  ENTITY_KIND_TAG,
  selectionToSummary,
  shouldWrapSelectionAsTag,
  suggestEntityName,
  uniqueRelativePath
} from '../common/entity-creation';
import type { NarrativeEntityTagKindFromRegistry } from '../common/entity-type-registry';
import { normalizeRange } from '../common/text-range';

/** Semantic tag kinds the wrap quick-actions operate on (registry tag kinds). */
type SemanticQuickActionKind = NarrativeEntityTagKindFromRegistry;

export namespace SemanticMarkdownActionCommands {
  // en labels stay inline as the source of truth; ru comes from
  // i18n/ru/editor.json keyed by `ai-focused-editor/editor/*`. These commands
  // carry the product-name prefix inside the label (not a `category`), so only a
  // label key is passed to `Command.toLocalizedCommand`.
  export const WRAP_SELECTION_AS_CHARACTER: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.semanticMarkdown.wrapSelectionAsCharacter',
      label: 'AI Focused Editor: Wrap Selection as Character Tag'
    },
    'ai-focused-editor/editor/wrap-selection-as-character'
  );

  export const WRAP_SELECTION_AS_TERM: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.semanticMarkdown.wrapSelectionAsTerm',
      label: 'AI Focused Editor: Wrap Selection as Term Tag'
    },
    'ai-focused-editor/editor/wrap-selection-as-term'
  );

  export const WRAP_SELECTION_AS_ARTIFACT: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.semanticMarkdown.wrapSelectionAsArtifact',
      label: 'AI Focused Editor: Wrap Selection as Artifact Tag'
    },
    'ai-focused-editor/editor/wrap-selection-as-artifact'
  );

  export const WRAP_SELECTION_AS_LOCATION: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.semanticMarkdown.wrapSelectionAsLocation',
      label: 'AI Focused Editor: Wrap Selection as Location Tag'
    },
    'ai-focused-editor/editor/wrap-selection-as-location'
  );

  export const SAVE_SELECTION_AS_CHARACTER: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.semanticMarkdown.saveSelectionAsCharacter',
      label: 'AI Focused Editor: Save Selection as New Character...'
    },
    'ai-focused-editor/editor/save-selection-as-character'
  );

  export const SAVE_SELECTION_AS_TERM: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.semanticMarkdown.saveSelectionAsTerm',
      label: 'AI Focused Editor: Save Selection as New Term...'
    },
    'ai-focused-editor/editor/save-selection-as-term'
  );

  export const SAVE_SELECTION_AS_ARTIFACT: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.semanticMarkdown.saveSelectionAsArtifact',
      label: 'AI Focused Editor: Save Selection as New Artifact...'
    },
    'ai-focused-editor/editor/save-selection-as-artifact'
  );

  export const SAVE_SELECTION_AS_LOCATION: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.semanticMarkdown.saveSelectionAsLocation',
      label: 'AI Focused Editor: Save Selection as New Location...'
    },
    'ai-focused-editor/editor/save-selection-as-location'
  );

  export const COPY_TAG_SUMMARY: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.semanticMarkdown.copyTagSummary',
      label: 'AI Focused Editor: Copy Semantic Tag Summary'
    },
    'ai-focused-editor/editor/copy-tag-summary'
  );

  export const NORMALIZE_TAGS: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.semanticMarkdown.normalizeTags',
      label: 'AI Focused Editor: Normalize Semantic Markdown Tags'
    },
    'ai-focused-editor/editor/normalize-tags'
  );

  export const INSERT_FOOTNOTE: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.semanticMarkdown.insertFootnote',
      label: 'AI Focused Editor: Insert Footnote'
    },
    'ai-focused-editor/editor/insert-footnote'
  );

  /**
   * Internal jump target used by the footnote link provider's `command:` links;
   * intentionally kept out of menus and the command palette.
   */
  export const REVEAL_FOOTNOTE: Command = {
    id: 'ai-focused-editor.semanticMarkdown.revealFootnote'
  };
}

@injectable()
export class SemanticMarkdownActionsContribution implements CommandContribution, MenuContribution {
  @inject(EditorManager)
  protected readonly editorManager!: EditorManager;

  @inject(MessageService)
  protected readonly messages!: MessageService;

  @inject(ClipboardService)
  protected readonly clipboard!: ClipboardService;

  @inject(QuickInputService)
  protected readonly quickInput!: QuickInputService;

  @inject(FileService)
  protected readonly fileService!: FileService;

  @inject(WorkspaceService)
  protected readonly workspaceService!: WorkspaceService;

  @inject(OpenerService)
  protected readonly openerService!: OpenerService;

  registerCommands(registry: CommandRegistry): void {
    registry.registerCommand(SemanticMarkdownActionCommands.WRAP_SELECTION_AS_CHARACTER, {
      execute: () => this.wrapSelection('char')
    });
    registry.registerCommand(SemanticMarkdownActionCommands.WRAP_SELECTION_AS_TERM, {
      execute: () => this.wrapSelection('term')
    });
    registry.registerCommand(SemanticMarkdownActionCommands.WRAP_SELECTION_AS_ARTIFACT, {
      execute: () => this.wrapSelection('artifact')
    });
    registry.registerCommand(SemanticMarkdownActionCommands.WRAP_SELECTION_AS_LOCATION, {
      execute: () => this.wrapSelection('location')
    });
    registry.registerCommand(SemanticMarkdownActionCommands.SAVE_SELECTION_AS_CHARACTER, {
      execute: () => this.saveSelectionAsEntity('character'),
      isEnabled: () => this.hasMarkdownSelection(),
      isVisible: () => this.hasMarkdownSelection()
    });
    registry.registerCommand(SemanticMarkdownActionCommands.SAVE_SELECTION_AS_TERM, {
      execute: () => this.saveSelectionAsEntity('term'),
      isEnabled: () => this.hasMarkdownSelection(),
      isVisible: () => this.hasMarkdownSelection()
    });
    registry.registerCommand(SemanticMarkdownActionCommands.SAVE_SELECTION_AS_ARTIFACT, {
      execute: () => this.saveSelectionAsEntity('artifact'),
      isEnabled: () => this.hasMarkdownSelection(),
      isVisible: () => this.hasMarkdownSelection()
    });
    registry.registerCommand(SemanticMarkdownActionCommands.SAVE_SELECTION_AS_LOCATION, {
      execute: () => this.saveSelectionAsEntity('location'),
      isEnabled: () => this.hasMarkdownSelection(),
      isVisible: () => this.hasMarkdownSelection()
    });
    registry.registerCommand(SemanticMarkdownActionCommands.COPY_TAG_SUMMARY, {
      execute: () => this.copyTagSummary()
    });
    registry.registerCommand(SemanticMarkdownActionCommands.NORMALIZE_TAGS, {
      execute: () => this.normalizeTags()
    });
    registry.registerCommand(SemanticMarkdownActionCommands.INSERT_FOOTNOTE, {
      execute: () => this.insertFootnote()
    });
    registry.registerCommand(SemanticMarkdownActionCommands.REVEAL_FOOTNOTE, {
      execute: (uri?: string, line?: number, character?: number) => this.revealFootnote(uri, line, character)
    });
  }

  registerMenus(menus: MenuModelRegistry): void {
    const menuPath = AiFocusedEditorMenus.SEMANTIC_MARKDOWN;
    for (const command of [
      SemanticMarkdownActionCommands.WRAP_SELECTION_AS_CHARACTER,
      SemanticMarkdownActionCommands.WRAP_SELECTION_AS_TERM,
      SemanticMarkdownActionCommands.WRAP_SELECTION_AS_ARTIFACT,
      SemanticMarkdownActionCommands.WRAP_SELECTION_AS_LOCATION,
      SemanticMarkdownActionCommands.SAVE_SELECTION_AS_CHARACTER,
      SemanticMarkdownActionCommands.SAVE_SELECTION_AS_TERM,
      SemanticMarkdownActionCommands.SAVE_SELECTION_AS_ARTIFACT,
      SemanticMarkdownActionCommands.SAVE_SELECTION_AS_LOCATION,
      SemanticMarkdownActionCommands.INSERT_FOOTNOTE,
      SemanticMarkdownActionCommands.COPY_TAG_SUMMARY,
      SemanticMarkdownActionCommands.NORMALIZE_TAGS
    ]) {
      menus.registerMenuAction(menuPath, {
        commandId: command.id
      });
    }

    const editorMenuPath = [...EDITOR_CONTEXT_MENU, ...EditorContextMenu.MODIFICATION];
    for (const command of [
      SemanticMarkdownActionCommands.WRAP_SELECTION_AS_CHARACTER,
      SemanticMarkdownActionCommands.WRAP_SELECTION_AS_TERM,
      SemanticMarkdownActionCommands.WRAP_SELECTION_AS_ARTIFACT,
      SemanticMarkdownActionCommands.WRAP_SELECTION_AS_LOCATION,
      SemanticMarkdownActionCommands.SAVE_SELECTION_AS_CHARACTER,
      SemanticMarkdownActionCommands.SAVE_SELECTION_AS_TERM,
      SemanticMarkdownActionCommands.SAVE_SELECTION_AS_ARTIFACT,
      SemanticMarkdownActionCommands.SAVE_SELECTION_AS_LOCATION,
      SemanticMarkdownActionCommands.INSERT_FOOTNOTE,
      SemanticMarkdownActionCommands.NORMALIZE_TAGS
    ]) {
      menus.registerMenuAction(editorMenuPath, {
        commandId: command.id
      });
    }
  }

  protected async wrapSelection(kind: SemanticQuickActionKind): Promise<void> {
    const editor = this.getMarkdownEditor();
    if (!editor) {
      await this.messages.warn(nls.localize(
        'ai-focused-editor/editor/wrap-open-editor',
        'Open a Markdown editor before wrapping a semantic tag.'
      ));
      return;
    }

    const selectedText = editor.document.getText(normalizeRange(editor.selection));
    const label = selectedText.trim();
    if (!label) {
      await this.messages.warn(nls.localize(
        'ai-focused-editor/editor/wrap-select-text',
        'Select text before wrapping it as a semantic tag.'
      ));
      return;
    }
    if (/[\r\n]/.test(label)) {
      await this.messages.warn(nls.localize(
        'ai-focused-editor/editor/wrap-single-line-only',
        'Semantic tag quick actions support single-line selections only.'
      ));
      return;
    }
    if (label.startsWith('[[') && label.endsWith(']]')) {
      await this.messages.warn(nls.localize(
        'ai-focused-editor/editor/wrap-already-tag',
        'Selection already looks like a semantic tag.'
      ));
      return;
    }

    const safeLabel = label.replace(/[|\[\]]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!safeLabel) {
      await this.messages.warn(nls.localize(
        'ai-focused-editor/editor/wrap-invalid-label',
        'Selection cannot be converted to a semantic tag label.'
      ));
      return;
    }

    const leading = selectedText.match(/^\s*/)?.[0] ?? '';
    const trailing = selectedText.match(/\s*$/)?.[0] ?? '';
    const id = this.createSemanticId(kind, safeLabel);
    const replacement = `${leading}[[${kind}:${id}|${safeLabel}]]${trailing}`;
    const replaced = await editor.replaceText({
      source: `ai-focused-editor.semanticMarkdown.wrap.${kind}`,
      replaceOperations: [{
        range: normalizeRange(editor.selection),
        text: replacement
      }]
    });

    if (replaced) {
      await this.messages.info(nls.localize(
        'ai-focused-editor/editor/wrap-success',
        'Wrapped selection as {0} tag: {1}',
        this.getKindLabel(kind),
        `${kind}:${id}`
      ));
    } else {
      await this.messages.warn(nls.localize(
        'ai-focused-editor/editor/wrap-not-applied',
        'Theia editor did not apply the semantic tag replacement.'
      ));
    }
  }

  /**
   * "Save Selection as New <Kind>...": take the active Markdown editor's
   * selection, ask for an entity name (prefilled from the leading words), then
   * write a new `entities/<dir>/<id>.yaml` file, optionally wrap the selection
   * as a `[[kind:id|label]]` semantic tag pointing at it, open the created file
   * in the entity form editor, and report the result. Mirrors the "Save
   * Selection as Citation..." UX in `source-library-view-contribution.ts`.
   *
   * The yaml `id` is always kept equal to the final filename stem — when a name
   * collides on disk `uniqueRelativePath` suffixes the filename, and the tag we
   * write points at that suffixed id so tags and files agree.
   */
  protected async saveSelectionAsEntity(kind: CreatableEntityKind): Promise<void> {
    const editor = this.getMarkdownEditor();
    if (!editor) {
      await this.messages.warn(nls.localize(
        'ai-focused-editor/editor/save-open-editor',
        'Open a Markdown editor before saving a selection as an entity.'
      ));
      return;
    }

    const selection = normalizeRange(editor.selection);
    const selectedText = editor.document.getText(selection);
    if (!selectedText.trim()) {
      await this.messages.warn(nls.localize(
        'ai-focused-editor/editor/save-select-text',
        'Select text before saving it as a new entity.'
      ));
      return;
    }

    const root = await this.getRoot();
    if (!root) {
      await this.messages.warn(nls.localize(
        'ai-focused-editor/editor/save-open-workspace',
        'Open a manuscript workspace before saving a selection as an entity.'
      ));
      return;
    }

    // `kindLabel` is the English entity-kind noun from `common/entity-creation`
    // (out of scope for ru this wave); passed as `{0}` so the surrounding
    // sentence localizes while the noun stays as the source-of-truth English.
    const kindLabel = ENTITY_KIND_LABEL[kind];
    const rawName = await this.quickInput.input({
      title: nls.localize('ai-focused-editor/editor/save-entity-title', 'Save Selection as New {0}', kindLabel),
      prompt: nls.localize('ai-focused-editor/editor/save-entity-name-prompt', '{0} name', kindLabel),
      value: suggestEntityName(selectedText),
      validateInput: async value => (value.trim()
        ? undefined
        : nls.localize('ai-focused-editor/editor/save-entity-name-empty', '{0} name cannot be empty.', kindLabel))
    });
    if (rawName === undefined) {
      return;
    }
    const name = rawName.trim();
    if (!name) {
      return;
    }

    const tagKind = ENTITY_KIND_TAG[kind];
    const desiredPath = entityRelativePath(kind, createSemanticEntityId(tagKind, name));
    const dirRelative = desiredPath.slice(0, desiredPath.lastIndexOf('/'));

    // Snapshot the target directory so `uniqueRelativePath` can resolve a
    // collision-free filename against a synchronous existence check.
    const existing = new Set<string>();
    const dirStat = await this.fileService.resolve(root.resolve(dirRelative)).catch(() => undefined);
    for (const child of dirStat?.children ?? []) {
      existing.add(`${dirRelative}/${child.name}`);
    }
    const finalPath = uniqueRelativePath(desiredPath, candidate => existing.has(candidate));
    const finalId = finalPath.slice(finalPath.lastIndexOf('/') + 1).replace(/\.yaml$/, '');
    const fileUri = root.resolve(finalPath);

    try {
      await this.ensureFolder(root.resolve(dirRelative));
      await this.fileService.create(fileUri, buildEntityYaml({
        id: finalId,
        name,
        summary: selectionToSummary(selectedText, name)
      }));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.messages.error(nls.localize(
        'ai-focused-editor/editor/save-entity-failed',
        'Could not save {0}: {1}',
        kindLabel.toLowerCase(),
        detail
      ));
      return;
    }

    if (shouldWrapSelectionAsTag(selectedText)) {
      const safeLabel = selectedText.trim().replace(/[|\[\]]/g, ' ').replace(/\s+/g, ' ').trim();
      if (safeLabel) {
        const leading = selectedText.match(/^\s*/)?.[0] ?? '';
        const trailing = selectedText.match(/\s*$/)?.[0] ?? '';
        await editor.replaceText({
          source: `ai-focused-editor.semanticMarkdown.saveSelectionAs.${kind}`,
          replaceOperations: [{
            range: selection,
            text: `${leading}[[${tagKind}:${finalId}|${safeLabel}]]${trailing}`
          }]
        });
      }
    }

    await open(this.openerService, fileUri);
    await this.messages.info(nls.localize(
      'ai-focused-editor/editor/save-entity-success',
      'Saved selection as {0} {1}',
      kindLabel.toLowerCase(),
      `${tagKind}:${finalId}`
    ));
  }

  protected async copyTagSummary(): Promise<void> {
    const editor = this.getMarkdownEditor();
    if (!editor) {
      await this.messages.warn(nls.localize(
        'ai-focused-editor/editor/copy-open-editor',
        'Open a Markdown editor before copying semantic tag summary.'
      ));
      return;
    }

    const tags = parseSemanticMarkdown(editor.document.getText()).tags;
    if (tags.length === 0) {
      await this.messages.warn(nls.localize(
        'ai-focused-editor/editor/copy-no-tags',
        'No semantic tags found in the active Markdown editor.'
      ));
      return;
    }

    const lines = [
      `# ${nls.localize('ai-focused-editor/editor/copy-summary-heading', 'Semantic Tags: {0}', editor.uri.path.base)}`,
      '',
      ...tags.map(tag => `- ${tag.kind}:${tag.id} -> ${tag.label} (${nls.localize(
        'ai-focused-editor/editor/copy-summary-line',
        'line {0}',
        tag.range.start.line + 1
      )})`)
    ];
    await this.clipboard.writeText(lines.join('\n'));
    await this.messages.info(nls.localize(
      'ai-focused-editor/editor/copy-success',
      'Copied {0} semantic tag(s) to clipboard.',
      tags.length
    ));
  }

  protected async normalizeTags(): Promise<void> {
    const editor = this.getMarkdownEditor();
    if (!editor) {
      await this.messages.warn(nls.localize(
        'ai-focused-editor/editor/normalize-open-editor',
        'Open a Markdown editor before normalizing semantic tags.'
      ));
      return;
    }

    const text = editor.document.getText();
    const normalized = normalizeSemanticMarkdownTags(text);
    if (normalized === text) {
      await this.messages.info(nls.localize(
        'ai-focused-editor/editor/normalize-already',
        'Semantic Markdown tags are already normalized.'
      ));
      return;
    }

    const replaced = await editor.replaceText({
      source: SemanticMarkdownActionCommands.NORMALIZE_TAGS.id,
      replaceOperations: [{
        range: this.fullDocumentRange(text),
        text: normalized
      }]
    });

    if (replaced) {
      await this.messages.info(nls.localize(
        'ai-focused-editor/editor/normalize-done',
        'Semantic Markdown tags normalized.'
      ));
    } else {
      await this.messages.warn(nls.localize(
        'ai-focused-editor/editor/normalize-not-applied',
        'Theia editor did not apply semantic tag normalization.'
      ));
    }
  }

  /**
   * Insert a `[^N]` reference at the caret (N = next free numeric footnote id),
   * append a matching `[^N]:` definition after the last existing definition (or at
   * the document end), and drop the caret into the definition so the writer can type.
   */
  protected async insertFootnote(): Promise<void> {
    const editor = this.getMarkdownEditor();
    if (!editor) {
      await this.messages.warn(nls.localize(
        'ai-focused-editor/editor/footnote-open-editor',
        'Open a Markdown editor before inserting a footnote.'
      ));
      return;
    }

    const number = nextFootnoteNumber(editor.document.getText());
    const definitionMarker = `[^${number}]: `;

    // Reference first, at the collapsed caret; leaves any selection in place.
    const caret = editor.cursor;
    const referenceApplied = await editor.replaceText({
      source: SemanticMarkdownActionCommands.INSERT_FOOTNOTE.id,
      replaceOperations: [{
        range: { start: caret, end: caret },
        text: `[^${number}]`
      }]
    });
    if (!referenceApplied) {
      await this.messages.warn(nls.localize(
        'ai-focused-editor/editor/footnote-reference-not-applied',
        'Theia editor did not insert the footnote reference.'
      ));
      return;
    }

    // Recompute against the post-insert text so the definition lands correctly.
    const text = editor.document.getText();
    const lines = text.split(/\n/);
    const { definitions } = parseFootnotes(text);
    let insertAt: TextEditor['selection']['start'];
    let definitionText: string;
    if (definitions.length > 0) {
      const lastLine = Math.max(...definitions.map(definition => definition.line));
      insertAt = { line: lastLine, character: lines[lastLine]?.length ?? 0 };
      definitionText = `\n${definitionMarker}`;
    } else {
      const lastLine = Math.max(0, lines.length - 1);
      insertAt = { line: lastLine, character: lines[lastLine]?.length ?? 0 };
      definitionText = `${text.endsWith('\n') ? '\n' : '\n\n'}${definitionMarker}`;
    }

    const definitionApplied = await editor.replaceText({
      source: SemanticMarkdownActionCommands.INSERT_FOOTNOTE.id,
      replaceOperations: [{
        range: { start: insertAt, end: insertAt },
        text: definitionText
      }]
    });
    if (!definitionApplied) {
      await this.messages.warn(nls.localize(
        'ai-focused-editor/editor/footnote-definition-not-applied',
        'Theia editor did not insert the footnote definition.'
      ));
      return;
    }

    this.moveCaretToDefinition(editor, definitionMarker);
    await this.messages.info(nls.localize(
      'ai-focused-editor/editor/footnote-inserted',
      'Inserted footnote [^{0}]; type the note after the marker.',
      number
    ));
  }

  protected moveCaretToDefinition(editor: TextEditor, definitionMarker: string): void {
    const lines = editor.document.getText().split(/\n/);
    for (let line = lines.length - 1; line >= 0; line--) {
      const column = lines[line].indexOf(definitionMarker);
      if (column >= 0) {
        const position = { line, character: column + definitionMarker.length };
        editor.cursor = position;
        editor.revealPosition(position);
        editor.focus();
        return;
      }
    }
  }

  /** Jump target for footnote link `command:` URIs (reference <-> definition). */
  protected async revealFootnote(uri?: string, line?: number, character?: number): Promise<void> {
    if (typeof uri !== 'string' || typeof line !== 'number') {
      return;
    }
    const position = { line, character: typeof character === 'number' ? character : 0 };
    await this.editorManager.open(new URI(uri), {
      mode: 'reveal',
      selection: { start: position, end: position }
    });
  }

  protected getMarkdownEditor(): TextEditor | undefined {
    const editor = this.editorManager.currentEditor?.editor ?? this.editorManager.activeEditor?.editor;
    if (!editor || !this.isMarkdownEditor(editor)) {
      return undefined;
    }
    return editor;
  }

  /** True when a Markdown editor is active and its selection has non-blank text. */
  protected hasMarkdownSelection(): boolean {
    const editor = this.getMarkdownEditor();
    if (!editor) {
      return false;
    }
    return editor.document.getText(normalizeRange(editor.selection)).trim().length > 0;
  }

  protected async getRoot(): Promise<URI | undefined> {
    await this.workspaceService.ready;
    const root = this.workspaceService.tryGetRoots()[0] ?? (await this.workspaceService.roots)[0];
    return root?.resource;
  }

  protected async ensureFolder(uri: URI): Promise<void> {
    try {
      await this.fileService.createFolder(uri);
    } catch {
      // Folder already exists — expected.
    }
  }

  protected isMarkdownEditor(editor: TextEditor): boolean {
    return editor.uri.path.ext.toLowerCase() === '.md' || editor.document.languageId === 'markdown';
  }

  /**
   * Thin wrapper over the shared, Theia-free `createSemanticEntityId` in
   * `common/entity-creation.ts` (which mirrors this file's former local slug/hash
   * pair byte-for-byte) so tag ids and the entity files they point at are
   * generated by a single source of truth.
   */
  protected createSemanticId(kind: SemanticQuickActionKind, label: string): string {
    return createSemanticEntityId(kind, label);
  }

  protected getKindLabel(kind: SemanticQuickActionKind): string {
    switch (kind) {
      case 'char':
        return nls.localize('ai-focused-editor/editor/kind-character', 'character');
      case 'term':
        return nls.localize('ai-focused-editor/editor/kind-term', 'term');
      case 'artifact':
        return nls.localize('ai-focused-editor/editor/kind-artifact', 'artifact');
      case 'location':
        return nls.localize('ai-focused-editor/editor/kind-location', 'location');
    }
  }

  protected fullDocumentRange(text: string): TextEditor['selection'] {
    const lines = text.split(/\r?\n/);
    const lastLine = Math.max(0, lines.length - 1);
    return {
      start: {
        line: 0,
        character: 0
      },
      end: {
        line: lastLine,
        character: lines[lastLine]?.length ?? 0
      },
      direction: 'ltr'
    };
  }
}
