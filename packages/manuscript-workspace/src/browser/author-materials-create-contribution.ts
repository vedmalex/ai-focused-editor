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
import { inject, injectable } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution, open, OpenerService, WidgetManager } from '@theia/core/lib/browser';
import { ContextKey, ContextKeyService } from '@theia/core/lib/browser/context-key-service';
import type { TreeNode } from '@theia/core/lib/browser/tree';
import { FileDialogService } from '@theia/filesystem/lib/browser';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { Document, isSeq, parseDocument, YAMLSeq } from 'yaml';
import type { AuthorMaterialsSectionKind } from '../common/author-materials';
import {
  buildEntityYaml,
  buildKnowledgeNoteMarkdown,
  createSemanticEntityId,
  CreatableEntityKind,
  CREATABLE_ENTITY_KINDS,
  ENTITY_KIND_DIRECTORY,
  ENTITY_KIND_LABEL,
  ENTITY_KIND_TAG,
  entityRelativePath,
  KNOWLEDGE_CATEGORIES,
  knowledgeNoteRelativePath,
  uniqueRelativePath
} from '../common/entity-creation';
import { ManuscriptTreeWidget } from './manuscript-tree-widget';
import {
  AFE_MANUSCRIPT_SECTION_CONTEXT_KEY,
  AUTHOR_MATERIALS_ENTITY_GROUP_KIND,
  AuthorMaterialFolderTreeNode,
  AuthorMaterialsSectionGroupTreeNode,
  AuthorMaterialsSectionTreeNode,
  AuthorMaterialTreeNode,
  ManuscriptTreeNode
} from './manuscript-tree';
import { AiFocusedEditorMenus } from './ai-focused-editor-menu';

const CATEGORY = 'AI Focused Editor';

export namespace AuthorMaterialsCommands {
  // en labels stay inline as the source of truth; ru comes from
  // i18n/ru/create.json keyed by `ai-focused-editor/create/*`. The entity-kind
  // label defaults ('Character', …) mirror ENTITY_KIND_LABEL (kept in the
  // Theia-free common module, English this wave) so the product menu-bar text is
  // byte-identical to the previous `New ${ENTITY_KIND_LABEL.kind}...` literals.
  const CATEGORY_KEY = 'ai-focused-editor/create/category';

  export const NEW_CHARACTER: Command = Command.toLocalizedCommand(
    { id: 'ai-focused-editor.authorMaterials.newCharacter', category: CATEGORY, label: 'New Character...' },
    'ai-focused-editor/create/new-character',
    CATEGORY_KEY
  );
  export const NEW_TERM: Command = Command.toLocalizedCommand(
    { id: 'ai-focused-editor.authorMaterials.newTerm', category: CATEGORY, label: 'New Term...' },
    'ai-focused-editor/create/new-term',
    CATEGORY_KEY
  );
  export const NEW_ARTIFACT: Command = Command.toLocalizedCommand(
    { id: 'ai-focused-editor.authorMaterials.newArtifact', category: CATEGORY, label: 'New Artifact...' },
    'ai-focused-editor/create/new-artifact',
    CATEGORY_KEY
  );
  export const NEW_LOCATION: Command = Command.toLocalizedCommand(
    { id: 'ai-focused-editor.authorMaterials.newLocation', category: CATEGORY, label: 'New Location...' },
    'ai-focused-editor/create/new-location',
    CATEGORY_KEY
  );
  export const NEW_CITATION: Command = Command.toLocalizedCommand(
    { id: 'ai-focused-editor.authorMaterials.newCitation', category: CATEGORY, label: 'New Citation...' },
    'ai-focused-editor/create/new-citation',
    CATEGORY_KEY
  );
  export const NEW_KNOWLEDGE_NOTE: Command = Command.toLocalizedCommand(
    { id: 'ai-focused-editor.authorMaterials.newKnowledgeNote', category: CATEGORY, label: 'New Knowledge Note...' },
    'ai-focused-editor/create/new-knowledge-note',
    CATEGORY_KEY
  );
  export const ADD_SOURCE_FILE: Command = Command.toLocalizedCommand(
    { id: 'ai-focused-editor.authorMaterials.addSourceFile', category: CATEGORY, label: 'Add Source File...' },
    'ai-focused-editor/create/add-source-file',
    CATEGORY_KEY
  );
}

/** Command for each creatable entity kind, keyed for iteration. */
const ENTITY_COMMAND: Record<CreatableEntityKind, Command> = {
  character: AuthorMaterialsCommands.NEW_CHARACTER,
  term: AuthorMaterialsCommands.NEW_TERM,
  artifact: AuthorMaterialsCommands.NEW_ARTIFACT,
  location: AuthorMaterialsCommands.NEW_LOCATION
};

/** Navigator section each entity kind's create command belongs to. */
const ENTITY_SECTION: Record<CreatableEntityKind, AuthorMaterialsSectionKind> = {
  character: 'characters',
  term: 'terms',
  artifact: 'artifacts',
  location: 'locations'
};

/**
 * Sections nested under the entities group. Their create actions also fire when
 * the group node itself is selected, so right-clicking the group offers New
 * Character/Term/Artifact/Location; citations/knowledge/sources are NOT in the
 * group and so never match its `entities` context value.
 */
const ENTITY_GROUP_SECTIONS: ReadonlySet<AuthorMaterialsSectionKind> = new Set(
  Object.values(ENTITY_SECTION)
);

interface KnowledgeCategoryPick extends QuickPickItem {
  /** `undefined` files the note directly under `knowledge/`. */
  category: string | undefined;
}

/**
 * Per-section "New <artifact>" creation commands for the manuscript navigator.
 *
 * Every author-materials section can create its own artifact kind: characters,
 * terms, artifacts and locations create the matching entity YAML (opened in the
 * entity form editor); citations, knowledge notes and source files create their
 * respective content. Each command is exposed both in the manuscript tree
 * context menu (visible only on the matching section / its descendants) and in
 * the product menu bar (always discoverable when a workspace is open).
 *
 * All heavy id/YAML/path logic lives in the Theia-free `entity-creation`
 * contract module; this contribution only layers QuickInput prompts, FileService
 * writes and tree refresh on top — mirroring the "Save Selection as Citation..."
 * UX in `source-library-view-contribution.ts`.
 */
@injectable()
export class AuthorMaterialsCreateContribution
  implements CommandContribution, MenuContribution, FrontendApplicationContribution {
  @inject(QuickInputService)
  protected readonly quickInput!: QuickInputService;

  @inject(MessageService)
  protected readonly messages!: MessageService;

  @inject(FileService)
  protected readonly fileService!: FileService;

  @inject(WorkspaceService)
  protected readonly workspaceService!: WorkspaceService;

  @inject(OpenerService)
  protected readonly openerService!: OpenerService;

  @inject(WidgetManager)
  protected readonly widgetManager!: WidgetManager;

  @inject(FileDialogService)
  protected readonly fileDialogService!: FileDialogService;

  @inject(ContextKeyService)
  protected readonly contextKeyService!: ContextKeyService;

  /** Tracks the manuscript tree selection; drives the create-action `when` clauses. */
  protected sectionKey: ContextKey<string> | undefined;

  /**
   * Create the section context key and keep it in sync with the manuscript
   * tree's selection. The tree widget may already exist (it opens on the
   * writer-first startup layout) or be created later, so both are handled.
   */
  onStart(): void {
    this.sectionKey = this.contextKeyService.createKey<string>(AFE_MANUSCRIPT_SECTION_CONTEXT_KEY, 'none');
    for (const widget of this.widgetManager.getWidgets(ManuscriptTreeWidget.ID)) {
      if (widget instanceof ManuscriptTreeWidget) {
        this.trackTreeWidget(widget);
      }
    }
    this.widgetManager.onDidCreateWidget(({ factoryId, widget }) => {
      if (factoryId === ManuscriptTreeWidget.ID && widget instanceof ManuscriptTreeWidget) {
        this.trackTreeWidget(widget);
      }
    });
  }

  /**
   * Mirror one manuscript tree widget's selection into the section context key,
   * resetting to `none` when the widget is disposed.
   */
  protected trackTreeWidget(widget: ManuscriptTreeWidget): void {
    const model = widget.manuscriptModel;
    const sync = () => this.sectionKey?.set(this.sectionKeyFor(model.selectedNodes[0]));
    sync();
    const selectionListener = model.onSelectionChanged(() => sync());
    const disposeListener = widget.onDidDispose(() => {
      selectionListener.dispose();
      disposeListener.dispose();
      this.sectionKey?.set('none');
    });
  }

  /** Section context-key value for the current tree selection. */
  protected sectionKeyFor(node: TreeNode | undefined): string {
    if (node === undefined) {
      return 'none';
    }
    if (ManuscriptTreeNode.is(node) || AuthorMaterialsSectionTreeNode.isManuscript(node)) {
      return 'manuscript';
    }
    // The entities group maps to its own value so right-clicking it offers all
    // four entity create actions (see sectionWhenClause).
    if (AuthorMaterialsSectionGroupTreeNode.is(node)) {
      return AUTHOR_MATERIALS_ENTITY_GROUP_KIND;
    }
    if (AuthorMaterialsSectionTreeNode.is(node)
      || AuthorMaterialTreeNode.is(node)
      || AuthorMaterialFolderTreeNode.is(node)) {
      return node.sectionKind;
    }
    return 'none';
  }

  registerCommands(commands: CommandRegistry): void {
    // Section gating lives in the menu-action `when` clauses (registerMenus), not
    // in command.isVisible: a hidden command also disappears from the product menu
    // bar (DynamicMenuWidget honors command visibility), which is the bug this
    // fixes. Commands stay always-visible; only `isEnabled` guards a workspace.
    for (const kind of CREATABLE_ENTITY_KINDS) {
      commands.registerCommand(ENTITY_COMMAND[kind], {
        execute: () => this.createEntity(kind),
        isEnabled: () => this.hasWorkspace()
      });
    }
    commands.registerCommand(AuthorMaterialsCommands.NEW_CITATION, {
      execute: () => this.createCitation(),
      isEnabled: () => this.hasWorkspace()
    });
    commands.registerCommand(AuthorMaterialsCommands.NEW_KNOWLEDGE_NOTE, {
      execute: () => this.createKnowledgeNote(),
      isEnabled: () => this.hasWorkspace()
    });
    commands.registerCommand(AuthorMaterialsCommands.ADD_SOURCE_FILE, {
      execute: () => this.addSourceFile(),
      isEnabled: () => this.hasWorkspace()
    });
  }

  registerMenus(menus: MenuModelRegistry): void {
    // registerMenuAction ONLY: the submenu tree is owned centrally by
    // ManuscriptWorkspaceMenuContribution (registering a submenu for the same
    // path twice duplicates the menu bar). Unlabeled group segments below need
    // no registration.
    const contextGroup = [...ManuscriptTreeWidget.CONTEXT_MENU, '1_create'];
    const mainGroup = [...AiFocusedEditorMenus.MAIN, '1a_create'];

    let order = 0;
    for (const { command, section } of this.orderedCreateActions()) {
      const orderKey = String(order);
      // Tree context menu: section-gated via a `when` clause on the selection
      // context key. Product menu bar: never gated, so every create action stays
      // discoverable regardless of what (if anything) the tree has selected.
      menus.registerMenuAction(contextGroup, {
        commandId: command.id,
        order: orderKey,
        when: sectionWhenClause(section)
      });
      menus.registerMenuAction(mainGroup, { commandId: command.id, order: orderKey });
      order++;
    }
  }

  /**
   * Stable creation order (entity kinds first, then citation, knowledge, source)
   * paired with the navigator section that gates each action in the tree context
   * menu.
   */
  protected orderedCreateActions(): { command: Command; section: AuthorMaterialsSectionKind }[] {
    return [
      ...CREATABLE_ENTITY_KINDS.map(kind => ({ command: ENTITY_COMMAND[kind], section: ENTITY_SECTION[kind] })),
      { command: AuthorMaterialsCommands.NEW_CITATION, section: 'citations' },
      { command: AuthorMaterialsCommands.NEW_KNOWLEDGE_NOTE, section: 'knowledge' },
      { command: AuthorMaterialsCommands.ADD_SOURCE_FILE, section: 'sources' }
    ];
  }

  /**
   * Create a narrative entity (`entities/<dir>/<id>.yaml`) from a prompted name
   * and open it in the entity form editor (registered at priority 500 so
   * `OpenerService` selects it automatically).
   */
  protected async createEntity(kind: CreatableEntityKind): Promise<void> {
    const label = ENTITY_KIND_LABEL[kind];
    const root = await this.getRoot();
    if (!root) {
      this.messages.warn(nls.localize(
        'ai-focused-editor/create/create-entity-no-workspace',
        'Open a manuscript workspace before creating a {0}.',
        label.toLowerCase()
      ));
      return;
    }

    const name = await this.quickInput.input({
      title: nls.localize('ai-focused-editor/create/create-entity-title', 'New {0}', label),
      prompt: nls.localize('ai-focused-editor/create/create-entity-prompt', '{0} name', label),
      placeHolder: nls.localize(
        'ai-focused-editor/create/entity-placeholder',
        'e.g. {0}',
        this.entityPlaceholder(kind)
      ),
      validateInput: async value => (value.trim()
        ? undefined
        : nls.localize('ai-focused-editor/create/create-entity-empty', '{0} name cannot be empty.', label))
    });
    const trimmed = name?.trim();
    if (!trimmed) {
      return;
    }

    const id = createSemanticEntityId(ENTITY_KIND_TAG[kind], trimmed);
    const relDir = `entities/${ENTITY_KIND_DIRECTORY[kind]}`;
    const existing = await this.collectExistingRelPaths(root, relDir);
    const relPath = uniqueRelativePath(entityRelativePath(kind, id), candidate => existing.has(candidate));

    await this.ensureFolder(root.resolve('entities'));
    await this.ensureFolder(root.resolve(relDir));

    const fileUri = root.resolve(relPath);
    try {
      await this.fileService.create(fileUri, buildEntityYaml({ id, name: trimmed }), { overwrite: false });
    } catch (error) {
      this.messages.warn(nls.localize(
        'ai-focused-editor/create/create-entity-failed',
        'Could not create {0}: {1}',
        label.toLowerCase(),
        this.detail(error)
      ));
      return;
    }

    await this.openAndRefresh(fileUri);
    this.messages.info(nls.localize(
      'ai-focused-editor/create/entity-created',
      'Created {0} "{1}".',
      label.toLowerCase(),
      trimmed
    ));
  }

  /**
   * Append a `{ id, title }` citation into `sources/citations.yaml` via the YAML
   * Document API (comment/entry preserving) and open the file so the citation
   * form editor takes over.
   */
  protected async createCitation(): Promise<void> {
    const root = await this.getRoot();
    if (!root) {
      this.messages.warn(nls.localize(
        'ai-focused-editor/create/citation-no-workspace',
        'Open a manuscript workspace before creating a citation.'
      ));
      return;
    }

    const title = await this.quickInput.input({
      title: nls.localize('ai-focused-editor/create/citation-title', 'New Citation'),
      prompt: nls.localize('ai-focused-editor/create/citation-prompt', 'Citation title'),
      placeHolder: nls.localize('ai-focused-editor/create/citation-placeholder', 'e.g. Bhagavad Gita 2.47'),
      validateInput: async value => (value.trim()
        ? undefined
        : nls.localize('ai-focused-editor/create/citation-empty', 'Citation title cannot be empty.'))
    });
    const trimmed = title?.trim();
    if (!trimmed) {
      return;
    }

    const id = createSemanticEntityId('cite', trimmed);
    const sourcesDir = root.resolve('sources');
    await this.ensureFolder(sourcesDir);

    const fileUri = sourcesDir.resolve('citations.yaml');
    try {
      await this.appendCitation(fileUri, id, trimmed);
    } catch (error) {
      this.messages.error(nls.localize(
        'ai-focused-editor/create/citation-failed',
        'Could not create citation: {0}',
        this.detail(error)
      ));
      return;
    }

    await this.openAndRefresh(fileUri);
    this.messages.info(nls.localize('ai-focused-editor/create/citation-added', 'Added citation "{0}".', trimmed));
  }

  /**
   * Create a knowledge note under an author-chosen category (or `knowledge/`
   * directly) and open it in the editor.
   */
  protected async createKnowledgeNote(): Promise<void> {
    const root = await this.getRoot();
    if (!root) {
      this.messages.warn(nls.localize(
        'ai-focused-editor/create/note-no-workspace',
        'Open a manuscript workspace before creating a knowledge note.'
      ));
      return;
    }

    const picks: KnowledgeCategoryPick[] = [
      ...KNOWLEDGE_CATEGORIES.map(category => ({ label: category, category })),
      {
        label: nls.localize('ai-focused-editor/create/knowledge-root-label', '(knowledge root)'),
        description: 'knowledge/',
        category: undefined
      }
    ];
    const picked = await this.quickInput.showQuickPick(picks, {
      title: nls.localize('ai-focused-editor/create/note-title', 'New Knowledge Note'),
      placeholder: nls.localize('ai-focused-editor/create/note-category-placeholder', 'Choose a category for the note')
    });
    if (!picked) {
      return;
    }
    const category = picked.category;

    const title = await this.quickInput.input({
      title: nls.localize('ai-focused-editor/create/note-title', 'New Knowledge Note'),
      prompt: nls.localize('ai-focused-editor/create/note-prompt', 'Note title'),
      placeHolder: nls.localize('ai-focused-editor/create/note-placeholder', 'e.g. Chapter 3 outline'),
      validateInput: async value => (value.trim()
        ? undefined
        : nls.localize('ai-focused-editor/create/note-empty', 'Note title cannot be empty.'))
    });
    const trimmed = title?.trim();
    if (!trimmed) {
      return;
    }

    const relDir = category ? `knowledge/${category}` : 'knowledge';
    const existing = await this.collectExistingRelPaths(root, relDir);
    const relPath = uniqueRelativePath(
      knowledgeNoteRelativePath(category, trimmed),
      candidate => existing.has(candidate)
    );

    await this.ensureFolder(root.resolve('knowledge'));
    if (category) {
      await this.ensureFolder(root.resolve(relDir));
    }

    const fileUri = root.resolve(relPath);
    try {
      await this.fileService.create(fileUri, buildKnowledgeNoteMarkdown(trimmed), { overwrite: false });
    } catch (error) {
      this.messages.warn(nls.localize(
        'ai-focused-editor/create/note-failed',
        'Could not create knowledge note: {0}',
        this.detail(error)
      ));
      return;
    }

    await this.openAndRefresh(fileUri);
    this.messages.info(nls.localize('ai-focused-editor/create/note-created', 'Created knowledge note "{0}".', trimmed));
  }

  /**
   * Copy author-picked files into `sources/`, giving each a collision-free
   * basename and skipping files that are already inside `sources/`.
   */
  protected async addSourceFile(): Promise<void> {
    const root = await this.getRoot();
    if (!root) {
      this.messages.warn(nls.localize(
        'ai-focused-editor/create/source-no-workspace',
        'Open a manuscript workspace before adding a source file.'
      ));
      return;
    }

    const selected = await this.fileDialogService.showOpenDialog({
      title: nls.localize('ai-focused-editor/create/add-source-title', 'Add Source File'),
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: true
    });
    const picks = Array.isArray(selected) ? selected : selected ? [selected] : [];
    if (picks.length === 0) {
      return;
    }

    const sourcesDir = root.resolve('sources');
    await this.ensureFolder(sourcesDir);

    // Seed with the on-disk source basenames so within-batch collisions also get
    // a unique suffix.
    const taken = await this.collectExistingRelPaths(root, 'sources');
    let added = 0;
    const skipped: string[] = [];
    for (const source of picks) {
      if (sourcesDir.isEqualOrParent(source)) {
        skipped.push(source.path.base);
        continue;
      }
      const relPath = uniqueRelativePath(`sources/${source.path.base}`, candidate => taken.has(candidate));
      taken.add(relPath);
      const target = root.resolve(relPath);
      try {
        await this.fileService.copy(source, target, { overwrite: false });
        added++;
      } catch (error) {
        this.messages.warn(nls.localize(
          'ai-focused-editor/create/source-add-failed',
          'Could not add {0}: {1}',
          source.path.base,
          this.detail(error)
        ));
      }
    }

    await this.refreshTree();

    if (added === 0 && skipped.length > 0) {
      this.messages.info(nls.localize(
        'ai-focused-editor/create/sources-all-existing',
        'All selected file(s) are already under sources/.'
      ));
      return;
    }
    const summary = [nls.localize(
      'ai-focused-editor/create/sources-added',
      'Added {0} source file(s) to sources/.',
      added
    )];
    if (skipped.length > 0) {
      summary.push(nls.localize(
        'ai-focused-editor/create/sources-skipped',
        'Skipped {0} already under sources/.',
        skipped.length
      ));
    }
    this.messages.info(summary.join(' '));
  }

  /**
   * Merge one citation into `sources/citations.yaml` with the YAML Document API,
   * preserving existing comments and entries. A missing/empty file is seeded
   * with `{ version: 1, citations: [] }`. Local re-implementation of the
   * comment-preserving merge in `source-library-view-contribution.ts`
   * (whose method is protected and not importable).
   */
  protected async appendCitation(fileUri: URI, id: string, title: string): Promise<void> {
    const existing = await this.readTextIfExists(fileUri);
    const document = existing !== undefined && existing.trim().length > 0
      ? parseDocument(existing)
      : new Document({ version: 1, citations: [] });

    let seq: YAMLSeq;
    if (isSeq(document.contents)) {
      seq = document.contents;
    } else {
      const current = document.get('citations');
      if (isSeq(current)) {
        seq = current;
      } else {
        seq = new YAMLSeq();
        document.set('citations', seq);
      }
    }

    seq.add(document.createNode({ id, title }));
    await this.fileService.create(fileUri, document.toString(), { overwrite: true });
  }

  protected async openAndRefresh(fileUri: URI): Promise<void> {
    try {
      await open(this.openerService, fileUri);
    } catch (error) {
      this.messages.warn(nls.localize(
        'ai-focused-editor/create/open-failed',
        'Created the file but could not open it: {0}',
        this.detail(error)
      ));
    }
    await this.refreshTree();
  }

  /** Refresh the manuscript navigator; a missing widget is a no-op. */
  protected async refreshTree(): Promise<void> {
    const widget = this.widgetManager.tryGetWidget<ManuscriptTreeWidget>(ManuscriptTreeWidget.ID);
    if (widget) {
      await widget.refreshWorkspace();
    }
  }

  /** Workspace-relative paths of the direct children of `relDir` (empty when absent). */
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

  protected hasWorkspace(): boolean {
    return this.workspaceService.tryGetRoots().length > 0;
  }

  protected async getRoot(): Promise<URI | undefined> {
    await this.workspaceService.ready;
    const root = this.workspaceService.tryGetRoots()[0] ?? (await this.workspaceService.roots)[0];
    return root?.resource;
  }

  protected entityPlaceholder(kind: CreatableEntityKind): string {
    switch (kind) {
      case 'character':
        return nls.localize('ai-focused-editor/create/placeholder-character', 'Arjuna');
      case 'term':
        return nls.localize('ai-focused-editor/create/placeholder-term', 'Dharma');
      case 'artifact':
        return nls.localize('ai-focused-editor/create/placeholder-artifact', 'Gandiva');
      case 'location':
        return nls.localize('ai-focused-editor/create/placeholder-location', 'Kurukshetra');
    }
  }

  protected detail(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * `when` clause keeping a create action visible in the tree context menu only
 * when nothing is selected (`none`), the matching section is selected, or — for
 * the four entity sections — the entities group node is selected.
 */
function sectionWhenClause(section: AuthorMaterialsSectionKind): string {
  const key = AFE_MANUSCRIPT_SECTION_CONTEXT_KEY;
  const clauses = [`${key} == 'none'`, `${key} == '${section}'`];
  if (ENTITY_GROUP_SECTIONS.has(section)) {
    clauses.push(`${key} == '${AUTHOR_MATERIALS_ENTITY_GROUP_KIND}'`);
  }
  return clauses.join(' || ');
}
