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
import { nls } from '@theia/core/lib/common/nls';
import URI from '@theia/core/lib/common/uri';
import { inject, injectable } from '@theia/core/shared/inversify';
import { ApplicationShell, WidgetManager } from '@theia/core/lib/browser';
import type { TreeNode } from '@theia/core/lib/browser/tree';
import { EditorManager } from '@theia/editor/lib/browser/editor-manager';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { ChatService } from '@theia/ai-chat/lib/common';
import {
  IMAGE_CONTEXT_VARIABLE,
  ImageContextVariable
} from '@theia/ai-chat/lib/common/image-context-variable';
import { ILogger } from '@theia/core/lib/common/logger';
import type { AIVariable } from '@theia/ai-core';
import { FILE_VARIABLE } from '@theia/ai-core/lib/browser/file-variable-contribution';
import {
  attachableSourceKind,
  attachableSourceMimeType,
  buildChapterBundle,
  isAttachableSource,
  SourceLibraryService,
  type ChapterBundleItem,
  type ChapterBundleVariable,
  type SourceLibraryService as SourceLibraryServiceType
} from '../common';
import {
  AuthorMaterialTreeNode,
  ManuscriptTreeNode
} from './manuscript-tree';
import { ManuscriptTreeWidget } from './manuscript-tree-widget';
import { AiFocusedEditorMenus } from './ai-focused-editor-menu';
import {
  CHAPTER_CONTEXT_VARIABLE,
  CITATION_CONTEXT_VARIABLE,
  DIAGRAM_CONTEXT_VARIABLE,
  ENTITY_CONTEXT_VARIABLE,
  EXCERPT_CONTEXT_VARIABLE,
  ManuscriptContextVariableContribution,
  NOTE_CONTEXT_VARIABLE,
  SOURCE_CONTEXT_VARIABLE
} from './manuscript-context-variable-contribution';

const CATEGORY = 'AI Focused Editor';

/** Author-materials section kinds that map to an entity card (`#entity`). */
const ENTITY_SECTION_KINDS: ReadonlySet<string> = new Set(['characters', 'terms', 'artifacts', 'locations']);

/** Diagram files carry a text summary via `#diagram`, not the raw `#source` text. */
const DIAGRAM_EXTENSION = '.excalidraw';

export namespace ChatContextCommands {
  export const ADD_CONTEXT: Command = Command.toLocalizedCommand(
    { id: 'ai-focused-editor.chat.addContext', category: CATEGORY, label: 'Add to Chat Context...' },
    'ai-focused-editor/chat-context/add-context',
    'ai-focused-editor/chat-context/category'
  );
  export const SEND_SELECTION: Command = Command.toLocalizedCommand(
    { id: 'ai-focused-editor.chat.sendSelection', category: CATEGORY, label: 'Send to AI Chat' },
    'ai-focused-editor/chat-context/send-selection',
    'ai-focused-editor/chat-context/category'
  );
  export const CHAPTER_WORKING_SET: Command = Command.toLocalizedCommand(
    { id: 'ai-focused-editor.chat.chapterWorkingSet', category: CATEGORY, label: 'Work with Chapter...' },
    'ai-focused-editor/chat-context/chapter-working-set',
    'ai-focused-editor/chat-context/category'
  );
}

/** Map a bundle item's variable name to the chat-context variable it attaches through. */
const BUNDLE_VARIABLE: Record<ChapterBundleVariable, AIVariable> = {
  chapter: CHAPTER_CONTEXT_VARIABLE,
  entity: ENTITY_CONTEXT_VARIABLE,
  citation: CITATION_CONTEXT_VARIABLE,
  source: SOURCE_CONTEXT_VARIABLE
};

/** A resolved attach target: which context variable, and the argument to pass. */
interface ContextTarget {
  variable: AIVariable;
  arg: string;
}

interface CategoryPick extends QuickPickItem {
  category: 'chapters' | 'sources' | 'images' | 'entities' | 'notes' | 'citations' | 'excerpts' | 'diagrams' | 'book';
}

interface ArtifactPick extends QuickPickItem {
  variable: AIVariable;
  arg: string;
}

/** A row in the chapter working-set multi-select: a content item or an "Add …" action. */
interface BundlePickItem extends QuickPickItem {
  /** The attach target for a content row; absent on action rows. */
  target?: ContextTarget;
  /** Which extension picker an action row opens. */
  action?: 'add-source' | 'add-note';
}

/**
 * Two entry points for putting workspace artifacts into the AI chat context
 * WITHOUT typing a `#variable`:
 *  - a Manuscript-menu command that walks category → artifact and attaches it;
 *  - a "Send to AI Chat" action on the manuscript navigator's context menu that
 *    attaches the selected chapter/source/entity/note directly.
 *
 * Both reuse {@link ManuscriptContextVariableContribution}'s candidate
 * enumeration and attach via `chatService.getActiveSession().model.context`.
 *
 * The tree action gates itself with `isVisible` (not a menu `when` clause):
 * it is registered ONLY on the tree context menu, never in the product menu
 * bar, so hiding the command has no menu-bar side effect — unlike the create
 * actions, whose commands are ALSO menu-bar entries and therefore gate via
 * context-key `when` clauses instead.
 */
@injectable()
export class ChatContextActionsContribution implements CommandContribution, MenuContribution {
  @inject(ChatService)
  protected readonly chatService!: ChatService;

  @inject(QuickInputService)
  protected readonly quickInput!: QuickInputService;

  @inject(MessageService)
  protected readonly messages!: MessageService;

  @inject(WorkspaceService)
  protected readonly workspaceService!: WorkspaceService;

  @inject(WidgetManager)
  protected readonly widgetManager!: WidgetManager;

  @inject(ApplicationShell)
  protected readonly shell!: ApplicationShell;

  @inject(ManuscriptContextVariableContribution)
  protected readonly variables!: ManuscriptContextVariableContribution;

  @inject(SourceLibraryService)
  protected readonly sourceLibrary!: SourceLibraryServiceType;

  @inject(FileService)
  protected readonly fileService!: FileService;

  @inject(EditorManager)
  protected readonly editorManager!: EditorManager;

  @inject(ILogger)
  protected readonly logger!: ILogger;

  registerCommands(commands: CommandRegistry): void {
    commands.registerCommand(ChatContextCommands.ADD_CONTEXT, {
      execute: () => this.addContextInteractively()
    });
    commands.registerCommand(ChatContextCommands.SEND_SELECTION, {
      execute: () => this.sendSelectedNode(),
      isEnabled: () => this.selectedContextTarget() !== undefined,
      isVisible: () => this.selectedContextTarget() !== undefined
    });
    commands.registerCommand(ChatContextCommands.CHAPTER_WORKING_SET, {
      execute: () => this.chapterWorkingSet()
    });
  }

  registerMenus(menus: MenuModelRegistry): void {
    // Product menu bar: the interactive picker lives near the other AI entries.
    menus.registerMenuAction([...AiFocusedEditorMenus.MAIN, '1b_chat'], {
      commandId: ChatContextCommands.ADD_CONTEXT.id,
      order: '0'
    });
    menus.registerMenuAction([...AiFocusedEditorMenus.MAIN, '1b_chat'], {
      commandId: ChatContextCommands.CHAPTER_WORKING_SET.id,
      order: '1'
    });
    // Manuscript navigator context menu: a dedicated `3_chat` group after the
    // create (`1_create`) and book (`2_book`) groups.
    menus.registerMenuAction([...ManuscriptTreeWidget.CONTEXT_MENU, '3_chat'], {
      commandId: ChatContextCommands.SEND_SELECTION.id,
      order: '0'
    });
    menus.registerMenuAction([...ManuscriptTreeWidget.CONTEXT_MENU, '3_chat'], {
      commandId: ChatContextCommands.CHAPTER_WORKING_SET.id,
      order: '1'
    });
  }

  // --- Interactive category → artifact picker --------------------------------

  protected async addContextInteractively(): Promise<void> {
    const [chapters, sources, entities, notes, citations, excerpts, diagrams, book] = await Promise.all([
      this.variables.collectChapters(),
      this.variables.collectSources(),
      this.variables.collectEntities(),
      this.variables.collectNotes(),
      this.variables.collectCitations(),
      this.variables.collectExcerpts(),
      this.variables.collectDiagrams(),
      this.variables.collectBookFiles()
    ]);

    const images = sources.filter(source => isAttachableSource(source.path));

    const categories: CategoryPick[] = [
      {
        category: 'chapters',
        label: nls.localize('ai-focused-editor/chat-context/category-chapters', 'Chapters'),
        description: String(chapters.length)
      },
      {
        category: 'sources',
        label: nls.localize('ai-focused-editor/chat-context/category-sources', 'Sources'),
        description: String(sources.length)
      },
      {
        category: 'images',
        label: nls.localize('ai-focused-editor/chat-context/category-images', 'Attach as Image...'),
        description: String(images.length)
      },
      {
        category: 'entities',
        label: nls.localize('ai-focused-editor/chat-context/category-entities', 'Entities'),
        description: String(entities.length)
      },
      {
        category: 'notes',
        label: nls.localize('ai-focused-editor/chat-context/category-notes', 'Notes'),
        description: String(notes.length)
      },
      {
        category: 'citations',
        label: nls.localize('ai-focused-editor/chat-context/category-citations', 'Citations'),
        description: String(citations.length)
      },
      {
        category: 'excerpts',
        label: nls.localize('ai-focused-editor/chat-context/category-excerpts', 'Excerpts'),
        description: String(excerpts.length)
      },
      {
        category: 'diagrams',
        label: nls.localize('ai-focused-editor/chat-context/category-diagrams', 'Diagrams'),
        description: String(diagrams.length)
      },
      {
        category: 'book',
        label: nls.localize('ai-focused-editor/chat-context/category-book', 'Book'),
        description: String(book.length)
      }
    ];

    const pickedCategory = await this.quickInput.showQuickPick(categories, {
      title: nls.localize('ai-focused-editor/chat-context/add-context', 'Add to Chat Context...'),
      placeholder: nls.localize('ai-focused-editor/chat-context/pick-category', 'Choose a category')
    });
    if (!pickedCategory) {
      return;
    }

    const artifacts = this.artifactPicksFor(pickedCategory.category, {
      chapters, sources, images, entities, notes, citations, excerpts, diagrams, book
    });
    if (artifacts.length === 0) {
      this.messages.info(nls.localize(
        'ai-focused-editor/chat-context/category-empty',
        'Nothing to add in this category yet.'
      ));
      return;
    }

    const pickedArtifact = await this.quickInput.showQuickPick(artifacts, {
      title: pickedCategory.label,
      placeholder: nls.localize('ai-focused-editor/chat-context/pick-artifact', 'Choose an item to add')
    });
    if (!pickedArtifact) {
      return;
    }

    await this.attach({ variable: pickedArtifact.variable, arg: pickedArtifact.arg }, pickedArtifact.label);
  }

  protected artifactPicksFor(
    category: CategoryPick['category'],
    data: {
      chapters: { path: string; title: string }[];
      sources: { path: string; label: string }[];
      images: { path: string; label: string }[];
      entities: { id: string; label: string }[];
      notes: { path: string; label: string }[];
      citations: { id: string; label: string }[];
      excerpts: { id: string; preview: string }[];
      diagrams: { path: string; label: string }[];
      book: { path: string; label: string }[];
    }
  ): ArtifactPick[] {
    switch (category) {
      case 'chapters':
        return data.chapters.map(chapter => ({
          label: chapter.title,
          description: chapter.path,
          variable: CHAPTER_CONTEXT_VARIABLE,
          arg: chapter.path
        }));
      case 'sources':
        return data.sources.map(source => ({
          label: source.label,
          description: source.path,
          variable: SOURCE_CONTEXT_VARIABLE,
          arg: source.path
        }));
      case 'images':
        // Binary sources (image/PDF) attach as the real bytes through Theia's
        // `imageContext` variable; the raw path is the arg, resolved to a full
        // image-context argument in `attach`.
        return data.images.map(image => ({
          label: image.label,
          description: image.path,
          variable: IMAGE_CONTEXT_VARIABLE as AIVariable,
          arg: image.path
        }));
      case 'entities':
        return data.entities.map(entity => ({
          label: entity.label,
          description: entity.id,
          variable: ENTITY_CONTEXT_VARIABLE,
          arg: entity.id
        }));
      case 'notes':
        return data.notes.map(note => ({
          label: note.label,
          description: note.path,
          variable: NOTE_CONTEXT_VARIABLE,
          arg: note.path
        }));
      case 'citations':
        return data.citations.map(citation => ({
          label: citation.label,
          description: citation.id,
          variable: CITATION_CONTEXT_VARIABLE,
          arg: citation.id
        }));
      case 'excerpts':
        return data.excerpts.map(excerpt => ({
          label: excerpt.id,
          description: excerpt.preview,
          variable: EXCERPT_CONTEXT_VARIABLE,
          arg: excerpt.id
        }));
      case 'diagrams':
        return data.diagrams.map(diagram => ({
          label: diagram.label,
          description: diagram.path,
          variable: DIAGRAM_CONTEXT_VARIABLE,
          arg: diagram.path
        }));
      case 'book':
        return data.book.map(file => ({
          label: file.label,
          description: file.path,
          variable: FILE_VARIABLE,
          arg: file.path
        }));
    }
  }

  // --- Tree context-menu "Send to AI Chat" -----------------------------------

  protected async sendSelectedNode(): Promise<void> {
    const target = this.selectedContextTarget();
    if (!target) {
      return;
    }
    await this.attach(target, target.arg);
  }

  /** The attach target for the current manuscript-tree selection, if supported. */
  protected selectedContextTarget(): ContextTarget | undefined {
    const widget = this.widgetManager.tryGetWidget<ManuscriptTreeWidget>(ManuscriptTreeWidget.ID);
    const node = widget?.manuscriptModel.selectedNodes[0];
    return node ? this.contextTargetForNode(node) : undefined;
  }

  protected contextTargetForNode(node: TreeNode): ContextTarget | undefined {
    if (ManuscriptTreeNode.isFile(node)) {
      return { variable: CHAPTER_CONTEXT_VARIABLE, arg: node.manuscript.path };
    }
    if (AuthorMaterialTreeNode.is(node)) {
      if (ENTITY_SECTION_KINDS.has(node.sectionKind)) {
        const id = node.description ?? this.materialIdFromNodeId(node.id);
        return id ? { variable: ENTITY_CONTEXT_VARIABLE, arg: id } : undefined;
      }
      // Citations have no material URI; recover the id from the node id
      // (`material:citations:<id>`) so `#citation` gets the record.
      if (node.sectionKind === 'citations') {
        const id = this.materialIdFromNodeId(node.id);
        return id ? { variable: CITATION_CONTEXT_VARIABLE, arg: id } : undefined;
      }
      const relative = node.materialUri ? this.relativePath(node.materialUri) : undefined;
      if (!relative) {
        return undefined;
      }
      if (node.sectionKind === 'sources') {
        // Excalidraw diagrams attach as a text summary (`#diagram`), not the
        // raw binary source text (`#source`).
        if (relative.toLowerCase().endsWith(DIAGRAM_EXTENSION)) {
          return { variable: DIAGRAM_CONTEXT_VARIABLE, arg: relative };
        }
        // Images/PDFs attach as the actual bytes (`imageContext`) so a
        // vision-capable model sees them, not the text-extraction `#source`.
        if (isAttachableSource(relative)) {
          return { variable: IMAGE_CONTEXT_VARIABLE as AIVariable, arg: relative };
        }
        return { variable: SOURCE_CONTEXT_VARIABLE, arg: relative };
      }
      if (node.sectionKind === 'knowledge') {
        return { variable: NOTE_CONTEXT_VARIABLE, arg: relative };
      }
    }
    return undefined;
  }

  /** Recover the material id from a `material:<section>:<id>` tree node id (entity or citation). */
  protected materialIdFromNodeId(nodeId: string): string | undefined {
    const parts = nodeId.split(':');
    return parts.length >= 3 ? parts.slice(2).join(':') : undefined;
  }

  /** Workspace-relative path of a material URI, or undefined when outside the root. */
  protected relativePath(materialUri: string): string | undefined {
    const root = this.workspaceService.tryGetRoots()[0]?.resource;
    if (!root) {
      return undefined;
    }
    return root.relative(new URI(materialUri))?.toString();
  }

  // --- "Work with Chapter..." bundle -----------------------------------------

  /**
   * Build a chapter working set — the chapter plus the entities, citations, and
   * sources it references — and attach the author-approved subset to the chat.
   *
   * The chapter defaults to the manuscript-tree selection (when a file node is
   * selected) or the active editor; otherwise the author picks one. Everything
   * is preselected in a multi-select QuickPick so the author only unchecks
   * noise, and can extend the set with extra source/note pickers.
   */
  protected async chapterWorkingSet(): Promise<void> {
    const chapter = await this.chooseChapter();
    if (!chapter) {
      return;
    }
    const rootUri = this.workspaceService.tryGetRoots()[0]?.resource;
    if (!rootUri) {
      this.messages.info(nls.localize('ai-focused-editor/chat-context/no-workspace', 'Open a manuscript workspace folder first.'));
      return;
    }

    let chapterText: string;
    try {
      chapterText = (await this.fileService.read(rootUri.resolve(chapter.path))).value;
    } catch (error) {
      this.messages.error(nls.localize(
        'ai-focused-editor/chat-context/chapter-read-failed',
        'Could not read chapter {0}: {1}',
        chapter.path,
        error instanceof Error ? error.message : String(error)
      ));
      return;
    }

    const snapshot = await this.sourceLibrary.getSnapshot();
    const bundle = buildChapterBundle(chapterText, {
      chapterPath: chapter.path,
      chapterLabel: chapter.title,
      citations: snapshot.citations,
      excerpts: snapshot.excerpts
    });

    await this.attachChapterBundle(bundle);
  }

  /**
   * Resolve the chapter to work with, preselecting the tree selection or active
   * editor. Returns `undefined` when the author cancels or no chapters exist.
   */
  protected async chooseChapter(): Promise<{ path: string; title: string } | undefined> {
    const chapters = await this.variables.collectChapters();
    if (chapters.length === 0) {
      this.messages.info(nls.localize('ai-focused-editor/chat-context/no-chapters', 'This workspace has no Markdown chapters yet.'));
      return undefined;
    }
    const defaultPath = this.selectedChapterPath() ?? this.activeEditorChapterPath(chapters);
    const items = chapters.map(chapter => ({ label: chapter.title, description: chapter.path, value: chapter.path }));
    const activeItem = defaultPath ? items.find(item => item.value === defaultPath) : undefined;
    const picked = await this.quickInput.showQuickPick(items, {
      title: ChatContextCommands.CHAPTER_WORKING_SET.label,
      placeholder: nls.localize('ai-focused-editor/chat-context/pick-chapter', 'Select a chapter'),
      activeItem
    });
    if (!picked) {
      return undefined;
    }
    const match = chapters.find(chapter => chapter.path === picked.value);
    return match ? { path: match.path, title: match.title } : undefined;
  }

  /** Workspace-relative path of a selected manuscript-tree file node, if any. */
  protected selectedChapterPath(): string | undefined {
    const widget = this.widgetManager.tryGetWidget<ManuscriptTreeWidget>(ManuscriptTreeWidget.ID);
    const node = widget?.manuscriptModel.selectedNodes[0];
    return node && ManuscriptTreeNode.isFile(node) && node.manuscript.path.endsWith('.md')
      ? node.manuscript.path
      : undefined;
  }

  /** The active editor's path, when it matches a known chapter. */
  protected activeEditorChapterPath(chapters: { path: string; title: string }[]): string | undefined {
    const editor = this.editorManager.currentEditor?.editor ?? this.editorManager.activeEditor?.editor;
    if (!editor) {
      return undefined;
    }
    const relative = this.relativePath(editor.uri.toString());
    return relative && chapters.some(chapter => chapter.path === relative) ? relative : undefined;
  }

  /**
   * Present the bundle as a preselected multi-select QuickPick. Two extra rows
   * ("Add source…"/"Add note…") carry an inline button that opens the matching
   * picker to extend the set. On accept, the checked items are attached.
   */
  protected async attachChapterBundle(bundle: ChapterBundleItem[]): Promise<void> {
    const addButton = {
      iconClass: 'codicon codicon-add',
      tooltip: nls.localize('ai-focused-editor/chat-context/bundle-extend', 'Add to the working set')
    };
    const toRow = (target: ContextTarget, label: string, detail?: string): BundlePickItem =>
      ({ label, description: detail, target });

    const rows: BundlePickItem[] = bundle.map(item => toRow(
      { variable: BUNDLE_VARIABLE[item.variable], arg: item.arg },
      item.label,
      item.detail
    ));
    const addSourceRow: BundlePickItem = {
      label: nls.localize('ai-focused-editor/chat-context/bundle-add-source', 'Add source…'),
      alwaysShow: true,
      buttons: [addButton],
      action: 'add-source'
    };
    const addNoteRow: BundlePickItem = {
      label: nls.localize('ai-focused-editor/chat-context/bundle-add-note', 'Add note…'),
      alwaysShow: true,
      buttons: [addButton],
      action: 'add-note'
    };

    const quickPick = this.quickInput.createQuickPick<BundlePickItem>();
    quickPick.title = ChatContextCommands.CHAPTER_WORKING_SET.label;
    quickPick.canSelectMany = true;
    quickPick.placeholder = nls.localize(
      'ai-focused-editor/chat-context/bundle-placeholder',
      'Uncheck anything you do not want; the checked items are attached to the chat.'
    );
    quickPick.items = [...rows, addSourceRow, addNoteRow];
    quickPick.selectedItems = rows;

    quickPick.onDidTriggerItemButton(async event => {
      const added = await this.pickBundleExtension((event.item as BundlePickItem).action);
      if (!added) {
        return;
      }
      const contentRows = quickPick.items.filter((item): item is BundlePickItem =>
        QuickPickItem.is(item) && (item as BundlePickItem).target !== undefined);
      if (contentRows.some(row => row.target && this.sameTarget(row.target, added.target))) {
        return;
      }
      const newRow = toRow(added.target, added.label, added.detail);
      const selected = quickPick.selectedItems.filter((item): item is BundlePickItem => QuickPickItem.is(item));
      quickPick.items = [...contentRows, newRow, addSourceRow, addNoteRow];
      quickPick.selectedItems = [...selected, newRow];
    });

    return new Promise<void>(resolve => {
      let accepted = false;
      quickPick.onDidAccept(async () => {
        accepted = true;
        const targets = quickPick.selectedItems
          .filter((item): item is BundlePickItem => QuickPickItem.is(item) && (item as BundlePickItem).target !== undefined)
          .map(item => item.target!);
        quickPick.hide();
        if (targets.length > 0) {
          await this.attachMany(targets);
        }
        resolve();
      });
      quickPick.onDidHide(() => {
        quickPick.dispose();
        if (!accepted) {
          resolve();
        }
      });
      quickPick.show();
    });
  }

  /** Open the source/note picker for an "Add …" row; returns the new target. */
  protected async pickBundleExtension(
    action: BundlePickItem['action']
  ): Promise<{ target: ContextTarget; label: string; detail: string } | undefined> {
    if (action === 'add-source') {
      const path = await this.variables.pickSource();
      return path ? { target: { variable: SOURCE_CONTEXT_VARIABLE, arg: path }, label: this.baseName(path), detail: path } : undefined;
    }
    if (action === 'add-note') {
      const path = await this.variables.pickNote();
      return path ? { target: { variable: NOTE_CONTEXT_VARIABLE, arg: path }, label: this.baseName(path), detail: path } : undefined;
    }
    return undefined;
  }

  protected sameTarget(left: ContextTarget, right: ContextTarget): boolean {
    return left.variable.name === right.variable.name && left.arg === right.arg;
  }

  protected baseName(path: string): string {
    const slash = path.replace(/\/+$/, '').lastIndexOf('/');
    return slash < 0 ? path : path.slice(slash + 1);
  }

  // --- Attach + reveal -------------------------------------------------------

  /**
   * Public entry so other views (e.g. the Sources widget's per-row action) can
   * attach one source document to the chat context without re-implementing the
   * session/reveal plumbing.
   */
  async attachSource(path: string, label: string): Promise<void> {
    await this.attach({ variable: SOURCE_CONTEXT_VARIABLE, arg: path }, label);
  }

  /** Attach `{variable, arg}` to the active chat session and reveal the chat. */
  protected async attach(target: ContextTarget, label: string): Promise<void> {
    // Binary sources (image/PDF) carry a raw workspace-relative path as their
    // arg; turn it into a full `imageContext` argument (path-based for images,
    // inline bytes for PDF) before adding it to the session.
    let arg = target.arg;
    if (target.variable.id === IMAGE_CONTEXT_VARIABLE.id) {
      const built = await this.buildImageContextArg(target.arg);
      if (!built) {
        this.messages.error(nls.localize(
          'ai-focused-editor/chat-context/image-attach-failed',
          'Could not attach "{0}" as an image.',
          label
        ));
        return;
      }
      arg = built;
    }
    const session = this.chatService.getActiveSession() ?? this.chatService.createSession();
    session.model.context.addVariables({ variable: target.variable, arg });
    await this.revealChatView();
    this.messages.info(nls.localize(
      'ai-focused-editor/chat-context/attached',
      'Added "{0}" to the chat context.',
      label
    ));
  }

  /**
   * Build a Theia `imageContext` argument string for a binary source at the
   * workspace-relative `path`.
   *
   * Images use a path-based reference (`{ wsRelativePath, name }`) — Theia's
   * image resolver loads and base64-encodes the bytes on demand at send time,
   * so the session never holds megabytes inline. PDFs are inlined with their
   * bytes + an explicit `application/pdf` mime, because Theia's extension→mime
   * table does not know `.pdf` and would otherwise mislabel it as
   * `application/octet-stream`.
   */
  protected async buildImageContextArg(path: string): Promise<string | undefined> {
    const kind = attachableSourceKind(path);
    const mimeType = attachableSourceMimeType(path);
    if (!kind || !mimeType) {
      return undefined;
    }
    const name = this.baseName(path);
    if (kind === 'image') {
      return ImageContextVariable.createArgString({ wsRelativePath: path, name });
    }
    // PDF (document): read the bytes now and inline them with the correct mime.
    const rootUri = this.workspaceService.tryGetRoots()[0]?.resource;
    if (!rootUri) {
      return undefined;
    }
    try {
      const content = await this.fileService.readFile(rootUri.resolve(path));
      const data = this.toBase64(content.value.buffer);
      return ImageContextVariable.createArgString({ name, wsRelativePath: path, data, mimeType });
    } catch (error) {
      this.logger.error(`Failed to read binary source for chat attach: ${path}`, error);
      return undefined;
    }
  }

  /** Base64-encode raw bytes without a data-URL prefix. */
  protected toBase64(buffer: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < buffer.length; i++) {
      binary += String.fromCharCode(buffer[i]);
    }
    return btoa(binary);
  }

  /**
   * Attach several targets in one go (the chapter working set), then reveal the
   * chat and report a per-kind summary.
   */
  protected async attachMany(targets: ContextTarget[]): Promise<void> {
    const session = this.chatService.getActiveSession() ?? this.chatService.createSession();
    session.model.context.addVariables(...targets.map(target => ({ variable: target.variable, arg: target.arg })));
    await this.revealChatView();
    const count = (name: string): number => targets.filter(target => target.variable.name === name).length;
    this.messages.info(nls.localize(
      'ai-focused-editor/chat-context/bundle-attached',
      'Attached to chat: {0} chapter, {1} entities, {2} citations, {3} sources, {4} notes.',
      count('chapter'),
      count('entity'),
      count('citation'),
      count('source'),
      count('note')
    ));
  }

  protected async revealChatView(): Promise<void> {
    try {
      const widget = await this.widgetManager.getOrCreateWidget('chat-view-widget');
      if (!widget.isAttached) {
        this.shell.addWidget(widget, { area: 'right' });
      }
      await this.shell.revealWidget(widget.id);
    } catch {
      // The chat UI is optional; attaching the variable still succeeded.
    }
  }
}
