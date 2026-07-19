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
import { entityKindSections } from '../common/entity-type-registry';
import type { EffectiveEntityType } from '../common/entity-type-registry';
import { EntityTypeRegistryService } from './entity-type-registry-service';
import {
  buildKnowledgeNoteBody,
  KNOWLEDGE_TEMPLATE_KINDS,
  KnowledgeTemplateKind
} from '../common/knowledge-templates';
import {
  buildEntityYaml,
  buildSkillMarkdown,
  createSemanticEntityId,
  CreatableEntityKind,
  CREATABLE_ENTITY_KINDS,
  ENTITY_KIND_DIRECTORY,
  ENTITY_KIND_LABEL,
  ENTITY_KIND_TAG,
  KNOWLEDGE_CATEGORIES,
  knowledgeNoteRelativePath,
  skillFolderRelativePath,
  uniqueRelativePath
} from '../common/entity-creation';
import {
  AUDIO_SOURCES_AREA,
  TRANSCRIPTION_AREA,
  appendGitignoreEntry,
  buildProofreadingSetSkeleton,
  buildTranscriptsetSkeleton,
  proofreadingSetFolder,
  proofreadingSetFolders,
  proofsetRelPath,
  transcriptSetFolder,
  transcriptSetFolders,
  transcriptsetRelPath,
  writeProofsetYaml,
  writeTranscriptsetYaml,
  type ProofreadingMode
} from '../common';
import { ManuscriptTreeWidget } from './manuscript-tree-widget';
import {
  AFE_MANUSCRIPT_SECTION_CONTEXT_KEY,
  AFE_MANUSCRIPT_SECTION_IS_ENTITY_CONTEXT_KEY,
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

  // Generic "create any entity type" command: offers a quick pick over ALL
  // effective types (the built-in four plus author-declared types), then runs the
  // same name -> slug -> create-yaml -> open flow. The four dedicated commands
  // below stay for direct, per-section creation.
  export const NEW_ENTITY: Command = Command.toLocalizedCommand(
    { id: 'ai-focused-editor.authorMaterials.newEntity', category: CATEGORY, label: 'New Entity...' },
    'ai-focused-editor/create/new-entity',
    CATEGORY_KEY
  );

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
  export const NEW_DIAGRAM: Command = Command.toLocalizedCommand(
    { id: 'ai-focused-editor.authorMaterials.newDiagram', category: CATEGORY, label: 'New Diagram...' },
    'ai-focused-editor/create/new-diagram',
    CATEGORY_KEY
  );
  export const NEW_SKILL: Command = Command.toLocalizedCommand(
    { id: 'ai-focused-editor.authorMaterials.newSkill', category: CATEGORY, label: 'New Skill...' },
    'ai-focused-editor/create/new-skill',
    CATEGORY_KEY
  );
  export const NEW_PROOFREADING_SET: Command = Command.toLocalizedCommand(
    { id: 'ai-focused-editor.proofreading.newSet', category: CATEGORY, label: 'New Proofreading Set...' },
    'ai-focused-editor/proofreading/new-set',
    CATEGORY_KEY
  );
  export const NEW_TRANSCRIPT_SET: Command = Command.toLocalizedCommand(
    { id: 'ai-focused-editor.transcript.newSet', category: CATEGORY, label: 'New Transcript Set...' },
    'ai-focused-editor/transcript/new-set',
    CATEGORY_KEY
  );
}

/**
 * A blank, valid Excalidraw scene. The `.excalidraw` open handler (priority 500)
 * opens this in the diagram editor; the widget's loader tolerates an empty scene
 * too, but seeding the canonical shape keeps the file self-describing and lets
 * "Open With..." render sensible raw JSON.
 */
const BLANK_EXCALIDRAW_SCENE = JSON.stringify(
  {
    type: 'excalidraw',
    version: 2,
    source: 'ai-focused-editor',
    elements: [],
    appState: { gridSize: null, viewBackgroundColor: '#ffffff' },
    files: {}
  },
  undefined,
  2
) + '\n';

/** Command for each creatable entity kind, keyed for iteration. */
const ENTITY_COMMAND: Record<CreatableEntityKind, Command> = {
  character: AuthorMaterialsCommands.NEW_CHARACTER,
  term: AuthorMaterialsCommands.NEW_TERM,
  artifact: AuthorMaterialsCommands.NEW_ARTIFACT,
  location: AuthorMaterialsCommands.NEW_LOCATION
};

/** Navigator section each entity kind's create command belongs to. */
const ENTITY_SECTION: Record<CreatableEntityKind, AuthorMaterialsSectionKind> =
  entityKindSections() as Record<CreatableEntityKind, AuthorMaterialsSectionKind>;

/**
 * Sections nested under the entities group. Their create actions also fire when
 * the group node itself is selected, so right-clicking the group offers New
 * Character/Term/Artifact/Location; citations/knowledge/sources are NOT in the
 * group and so never match its `entities` context value.
 */
const ENTITY_GROUP_SECTIONS: ReadonlySet<AuthorMaterialsSectionKind> = new Set(
  Object.values(ENTITY_SECTION)
);

interface EntityTypePick extends QuickPickItem {
  /** The effective type this pick creates (`type` is reserved by QuickPickItem). */
  entityType: EffectiveEntityType;
}

interface KnowledgeCategoryPick extends QuickPickItem {
  /** `undefined` files the note directly under `knowledge/`. */
  category: string | undefined;
}

interface KnowledgeTemplatePick extends QuickPickItem {
  /** Which body skeleton to seed the new note with. */
  template: KnowledgeTemplateKind;
}

/** Localized label/description for each knowledge-note template. */
function knowledgeTemplatePicks(): KnowledgeTemplatePick[] {
  const meta: Record<KnowledgeTemplateKind, { label: string; description: string }> = {
    'empty': {
      label: nls.localize('ai-focused-editor/create/template-empty', 'Empty note'),
      description: nls.localize('ai-focused-editor/create/template-empty-detail', 'Just a title and a blank page')
    },
    'book-brief': {
      label: nls.localize('ai-focused-editor/create/template-book-brief', 'Book brief'),
      description: nls.localize('ai-focused-editor/create/template-book-brief-detail', 'Idea, audience, genre, conflict, resolution')
    },
    'book-plan': {
      label: nls.localize('ai-focused-editor/create/template-book-plan', 'Book plan'),
      description: nls.localize('ai-focused-editor/create/template-book-plan-detail', 'Parts and chapters skeleton')
    },
    'sample-contents': {
      label: nls.localize('ai-focused-editor/create/template-sample-contents', 'Sample contents'),
      description: nls.localize('ai-focused-editor/create/template-sample-contents-detail', 'A numbered table-of-contents outline')
    }
  };
  return KNOWLEDGE_TEMPLATE_KINDS.map(template => ({ template, ...meta[template] }));
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

  @inject(EntityTypeRegistryService)
  protected readonly entityTypeRegistry!: EntityTypeRegistryService;

  /** Tracks the manuscript tree selection; drives the create-action `when` clauses. */
  protected sectionKey: ContextKey<string> | undefined;

  /**
   * Boolean companion to {@link sectionKey}: true when the selection is any entity
   * surface (group / built-in or author entity section / an item within one). The
   * generic create action's `when` clause reads it so author (dynamic) section
   * kinds are covered without enumerating their string values.
   */
  protected sectionIsEntityKey: ContextKey<boolean> | undefined;

  /**
   * Create the section context key and keep it in sync with the manuscript
   * tree's selection. The tree widget may already exist (it opens on the
   * writer-first startup layout) or be created later, so both are handled.
   */
  onStart(): void {
    this.sectionKey = this.contextKeyService.createKey<string>(AFE_MANUSCRIPT_SECTION_CONTEXT_KEY, 'none');
    this.sectionIsEntityKey = this.contextKeyService.createKey<boolean>(
      AFE_MANUSCRIPT_SECTION_IS_ENTITY_CONTEXT_KEY,
      false
    );
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
    const sync = () => {
      const node = model.selectedNodes[0];
      this.sectionKey?.set(this.sectionKeyFor(node));
      this.sectionIsEntityKey?.set(this.isEntitySelection(node));
    };
    sync();
    const selectionListener = model.onSelectionChanged(() => sync());
    const disposeListener = widget.onDidDispose(() => {
      selectionListener.dispose();
      disposeListener.dispose();
      this.sectionKey?.set('none');
      this.sectionIsEntityKey?.set(false);
    });
  }

  /**
   * True when `node` is any entity surface: the entities group, its
   * `entities/types.yaml` leaf, or a section/item/folder whose section kind is an
   * effective entity type's section kind (built-in OR author-declared). Read to
   * gate the generic create action across dynamic author section kinds.
   */
  protected isEntitySelection(node: TreeNode | undefined): boolean {
    if (node === undefined) {
      return false;
    }
    if (AuthorMaterialsSectionGroupTreeNode.is(node)) {
      return true;
    }
    if (AuthorMaterialsSectionTreeNode.is(node)
      || AuthorMaterialTreeNode.is(node)
      || AuthorMaterialFolderTreeNode.is(node)) {
      const kind = node.sectionKind;
      if (kind === AUTHOR_MATERIALS_ENTITY_GROUP_KIND) {
        return true;
      }
      return this.entityTypeRegistry.getEffectiveTypes().some(type => type.sectionKind === kind);
    }
    return false;
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
    commands.registerCommand(AuthorMaterialsCommands.NEW_ENTITY, {
      execute: () => this.createEntityGeneric(),
      isEnabled: () => this.hasWorkspace()
    });
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
    commands.registerCommand(AuthorMaterialsCommands.NEW_DIAGRAM, {
      execute: () => this.createDiagram(),
      isEnabled: () => this.hasWorkspace()
    });
    commands.registerCommand(AuthorMaterialsCommands.NEW_SKILL, {
      execute: () => this.createSkill(),
      isEnabled: () => this.hasWorkspace()
    });
    commands.registerCommand(AuthorMaterialsCommands.NEW_PROOFREADING_SET, {
      execute: () => this.createProofreadingSet(),
      isEnabled: () => this.hasWorkspace()
    });
    commands.registerCommand(AuthorMaterialsCommands.NEW_TRANSCRIPT_SET, {
      // An optional string argument skips the name prompt (programmatic/testing
      // callers can pass the set name directly).
      execute: (name?: unknown) =>
        this.createTranscriptSet(typeof name === 'string' ? name : undefined),
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

    // Generic "New Entity..." first (order '0'). Its context-menu `when` covers
    // ANY entity surface via the boolean is-entity key (built-in + author section
    // kinds), plus the empty (`none`) selection; the product menu bar is ungated.
    const entityWhen = `${AFE_MANUSCRIPT_SECTION_CONTEXT_KEY} == 'none' || ${AFE_MANUSCRIPT_SECTION_IS_ENTITY_CONTEXT_KEY}`;
    menus.registerMenuAction(contextGroup, {
      commandId: AuthorMaterialsCommands.NEW_ENTITY.id,
      order: '0',
      when: entityWhen
    });
    menus.registerMenuAction(mainGroup, { commandId: AuthorMaterialsCommands.NEW_ENTITY.id, order: '0' });

    let order = 1;
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
      { command: AuthorMaterialsCommands.ADD_SOURCE_FILE, section: 'sources' },
      { command: AuthorMaterialsCommands.NEW_DIAGRAM, section: 'sources' },
      { command: AuthorMaterialsCommands.NEW_SKILL, section: 'skills' },
      { command: AuthorMaterialsCommands.NEW_PROOFREADING_SET, section: 'proofreading' },
      { command: AuthorMaterialsCommands.NEW_TRANSCRIPT_SET, section: 'transcription' }
    ];
  }

  /**
   * Create a built-in narrative entity from a prompted name and open it in the
   * entity form editor. Delegates to {@link performEntityCreate} with the kind's
   * registry-derived label/tag/directory and a per-kind example placeholder.
   */
  protected async createEntity(kind: CreatableEntityKind): Promise<void> {
    await this.performEntityCreate({
      label: ENTITY_KIND_LABEL[kind],
      tagKind: ENTITY_KIND_TAG[kind],
      directory: ENTITY_KIND_DIRECTORY[kind],
      placeholder: this.entityPlaceholder(kind)
    });
  }

  /**
   * Generic entity creation: pick any effective type (built-in four localized +
   * author-declared types verbatim, each with its icon), then run the shared
   * name -> slug -> create-yaml -> open flow. `buildEntityYaml` works for any
   * kind and the file lands in `entities/<directory>/`.
   */
  protected async createEntityGeneric(): Promise<void> {
    const types = this.entityTypeRegistry.getEffectiveTypes();
    if (types.length === 0) {
      return;
    }
    const picks: EntityTypePick[] = types.map(type => ({
      label: this.entityTypeLabel(type),
      description: type.origin === 'book'
        ? nls.localize('ai-focused-editor/create/entity-type-author', 'Author type')
        : undefined,
      iconClasses: this.entityTypeIconClasses(type),
      entityType: type
    }));
    const picked = await this.quickInput.showQuickPick(picks, {
      title: nls.localize('ai-focused-editor/create/new-entity-title', 'New Entity'),
      placeholder: nls.localize('ai-focused-editor/create/entity-type-placeholder', 'Choose an entity type to create')
    });
    if (!picked) {
      return;
    }
    await this.performEntityCreate({
      label: this.entityTypeLabel(picked.entityType),
      tagKind: picked.entityType.tagKind,
      directory: picked.entityType.directory
    });
  }

  /**
   * Prompt for a name and create `entities/<directory>/<slug>.yaml`, then open it
   * in the entity form editor (registered at priority 500 so `OpenerService`
   * selects it automatically). Shared by the four dedicated commands and the
   * generic quick-pick flow.
   */
  protected async performEntityCreate(spec: {
    label: string;
    tagKind: string;
    directory: string;
    placeholder?: string;
  }): Promise<void> {
    const { label, tagKind, directory } = spec;
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
      placeHolder: spec.placeholder
        ? nls.localize('ai-focused-editor/create/entity-placeholder', 'e.g. {0}', spec.placeholder)
        : undefined,
      validateInput: async value => (value.trim()
        ? undefined
        : nls.localize('ai-focused-editor/create/create-entity-empty', '{0} name cannot be empty.', label))
    });
    const trimmed = name?.trim();
    if (!trimmed) {
      return;
    }

    const id = createSemanticEntityId(tagKind, trimmed);
    const relDir = `entities/${directory}`;
    const existing = await this.collectExistingRelPaths(root, relDir);
    const relPath = uniqueRelativePath(`${relDir}/${id}.yaml`, candidate => existing.has(candidate));

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
   * Display label for an effective type in the picker: author types show their
   * declared label VERBATIM (the author's language); the built-in four are
   * localized (`Персонаж`/`Character`, …) via the registry `id`.
   */
  protected entityTypeLabel(type: EffectiveEntityType): string {
    if (type.origin === 'book') {
      return type.label;
    }
    return nls.localize(`ai-focused-editor/create/type-${type.id}`, type.label);
  }

  /** Codicon classes (+ accent) for a type's picker icon. */
  protected entityTypeIconClasses(type: EffectiveEntityType): string[] {
    const classes = type.icon.split(/\s+/).filter(Boolean);
    if (type.accentClass) {
      classes.push(type.accentClass);
    }
    return classes;
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

    const pickedTemplate = await this.quickInput.showQuickPick(knowledgeTemplatePicks(), {
      title: nls.localize('ai-focused-editor/create/note-title', 'New Knowledge Note'),
      placeholder: nls.localize('ai-focused-editor/create/note-template-placeholder', 'Choose a starting template for the note')
    });
    if (!pickedTemplate) {
      return;
    }
    const template = pickedTemplate.template;

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
      await this.fileService.create(fileUri, buildKnowledgeNoteBody(template, trimmed), { overwrite: false });
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
   * Create a blank Excalidraw diagram (`sources/<slug>.excalidraw`) from a
   * prompted name and open it in the diagram editor (the `.excalidraw` open
   * handler wins at priority 500). Diagrams live alongside other research
   * material under `sources/`.
   */
  protected async createDiagram(): Promise<void> {
    const root = await this.getRoot();
    if (!root) {
      this.messages.warn(nls.localize(
        'ai-focused-editor/create/diagram-no-workspace',
        'Open a manuscript workspace before creating a diagram.'
      ));
      return;
    }

    const name = await this.quickInput.input({
      title: nls.localize('ai-focused-editor/create/diagram-title', 'New Diagram'),
      prompt: nls.localize('ai-focused-editor/create/diagram-prompt', 'Diagram name'),
      placeHolder: nls.localize('ai-focused-editor/create/diagram-placeholder', 'e.g. Story map'),
      validateInput: async value => (value.trim()
        ? undefined
        : nls.localize('ai-focused-editor/create/diagram-empty', 'Diagram name cannot be empty.'))
    });
    const trimmed = name?.trim();
    if (!trimmed) {
      return;
    }

    const slug = createSemanticEntityId('diagram', trimmed);
    const existing = await this.collectExistingRelPaths(root, 'sources');
    const relPath = uniqueRelativePath(`sources/${slug}.excalidraw`, candidate => existing.has(candidate));

    await this.ensureFolder(root.resolve('sources'));

    const fileUri = root.resolve(relPath);
    try {
      await this.fileService.create(fileUri, BLANK_EXCALIDRAW_SCENE, { overwrite: false });
    } catch (error) {
      this.messages.warn(nls.localize(
        'ai-focused-editor/create/diagram-failed',
        'Could not create diagram: {0}',
        this.detail(error)
      ));
      return;
    }

    await this.openAndRefresh(fileUri);
    this.messages.info(nls.localize('ai-focused-editor/create/diagram-created', 'Created diagram "{0}".', trimmed));
  }

  /**
   * Create a book-local AI skill (`.prompts/skills/<slug>/SKILL.md`) from a
   * prompted name and an optional one-line description, then open the SKILL.md
   * in the editor. The folder is unique-suffixed on collision so two skills with
   * the same name never share a directory. Theia's SkillService discovers the
   * new file automatically; this is only the authoring surface.
   */
  protected async createSkill(): Promise<void> {
    const root = await this.getRoot();
    if (!root) {
      this.messages.warn(nls.localize(
        'ai-focused-editor/create/skill-no-workspace',
        'Open a manuscript workspace before creating a skill.'
      ));
      return;
    }

    const name = await this.quickInput.input({
      title: nls.localize('ai-focused-editor/create/skill-title', 'New Skill'),
      prompt: nls.localize('ai-focused-editor/create/skill-prompt', 'Skill name'),
      placeHolder: nls.localize('ai-focused-editor/create/skill-placeholder', 'e.g. Style guide'),
      validateInput: async value => (value.trim()
        ? undefined
        : nls.localize('ai-focused-editor/create/skill-empty', 'Skill name cannot be empty.'))
    });
    const trimmedName = name?.trim();
    if (!trimmedName) {
      return;
    }

    // Optional one-line description; Enter with an empty box skips it.
    const description = await this.quickInput.input({
      title: nls.localize('ai-focused-editor/create/skill-title', 'New Skill'),
      prompt: nls.localize('ai-focused-editor/create/skill-description-prompt', 'Skill description (optional)'),
      placeHolder: nls.localize(
        'ai-focused-editor/create/skill-description-placeholder',
        'What this skill tells the AI to do — press Enter to skip'
      )
    });
    const trimmedDescription = description?.trim()
      || nls.localize('ai-focused-editor/create/skill-description-default', 'What this skill tells the AI to do.');

    const slug = createSemanticEntityId('skill', trimmedName);
    const existing = await this.collectExistingRelPaths(root, '.prompts/skills');
    const relFolder = uniqueRelativePath(
      skillFolderRelativePath(slug),
      candidate => existing.has(candidate)
    );
    const finalSlug = relFolder.slice(relFolder.lastIndexOf('/') + 1);

    await this.ensureFolder(root.resolve('.prompts'));
    await this.ensureFolder(root.resolve('.prompts/skills'));
    await this.ensureFolder(root.resolve(relFolder));

    const fileUri = root.resolve(`${relFolder}/SKILL.md`);
    try {
      await this.fileService.create(
        fileUri,
        buildSkillMarkdown(finalSlug, trimmedName, trimmedDescription),
        { overwrite: false }
      );
    } catch (error) {
      this.messages.warn(nls.localize(
        'ai-focused-editor/create/skill-failed',
        'Could not create skill: {0}',
        this.detail(error)
      ));
      return;
    }

    await this.openAndRefresh(fileUri);
    this.messages.info(nls.localize('ai-focused-editor/create/skill-created', 'Created skill "{0}".', trimmedName));
  }

  /**
   * Create a proofreading set: prompt for a name and OCR/translation mode, slug
   * the name, then scaffold the book-native folders — `sources/scans/<slug>/` for
   * scans and `proofreading/<slug>/text/` (+ `source/` in translation mode) for the
   * working copy — and write `proofreading/<slug>/proofset.yaml`. When scans have
   * already been dropped into the images folder, `pages[]` is seeded from them
   * (verified:false); otherwise it starts empty and the widget populates on open.
   * The sidecar opens in the priority-500 Proofreading editor.
   */
  protected async createProofreadingSet(): Promise<void> {
    const root = await this.getRoot();
    if (!root) {
      this.messages.warn(nls.localize(
        'ai-focused-editor/proofreading/new-set-no-workspace',
        'Open a manuscript workspace before creating a proofreading set.'
      ));
      return;
    }

    const name = await this.quickInput.input({
      title: nls.localize('ai-focused-editor/proofreading/new-set-title', 'New Proofreading Set'),
      prompt: nls.localize('ai-focused-editor/proofreading/new-set-prompt', 'Proofreading set name'),
      placeHolder: nls.localize('ai-focused-editor/proofreading/new-set-placeholder', 'e.g. Chapter 1 scans'),
      validateInput: async value => (value.trim()
        ? undefined
        : nls.localize('ai-focused-editor/proofreading/new-set-empty', 'Proofreading set name cannot be empty.'))
    });
    const trimmed = name?.trim();
    if (!trimmed) {
      return;
    }

    const mode = await this.pickProofreadingMode();
    if (!mode) {
      return;
    }

    const slug = createSemanticEntityId('proofset', trimmed);
    const existing = await this.collectExistingRelPaths(root, 'proofreading');
    const relFolder = uniqueRelativePath(proofreadingSetFolder(slug), candidate => existing.has(candidate));
    const finalSlug = relFolder.slice(relFolder.lastIndexOf('/') + 1);
    const folders = proofreadingSetFolders(finalSlug, mode);

    // Scans usually arrive first: seed pages[] from any images already dropped.
    const imageNames = await this.listFolderFileNames(root, folders.imagesFolder);
    const set = buildProofreadingSetSkeleton({ slug: finalSlug, mode, imageNames });

    await this.ensureFolder(root.resolve('proofreading'));
    await this.ensureFolder(root.resolve('sources'));
    await this.ensureFolder(root.resolve('sources/scans'));
    await this.ensureFolder(root.resolve(folders.imagesFolder));
    await this.ensureFolder(root.resolve(relFolder));
    await this.ensureFolder(root.resolve(folders.textFolder));
    if (folders.sourceTextFolder) {
      await this.ensureFolder(root.resolve(folders.sourceTextFolder));
    }

    const fileUri = root.resolve(proofsetRelPath(finalSlug));
    try {
      await this.fileService.create(fileUri, writeProofsetYaml(undefined, set), { overwrite: false });
    } catch (error) {
      this.messages.warn(nls.localize(
        'ai-focused-editor/proofreading/new-set-failed',
        'Could not create proofreading set: {0}',
        this.detail(error)
      ));
      return;
    }

    await this.openAndRefresh(fileUri);
    this.messages.info(nls.localize(
      'ai-focused-editor/proofreading/new-set-created',
      'Created proofreading set "{0}". Drop scans into {1}/ and OCR/text into {2}/.',
      trimmed,
      folders.imagesFolder,
      folders.textFolder
    ));
  }

  /** Quick-pick the proofreading workflow (OCR vs translation). */
  protected async pickProofreadingMode(): Promise<ProofreadingMode | undefined> {
    interface ModePick extends QuickPickItem {
      mode: ProofreadingMode;
    }
    const picks: ModePick[] = [
      {
        label: nls.localize('ai-focused-editor/proofreading/mode-ocr', 'OCR proofreading'),
        description: nls.localize('ai-focused-editor/proofreading/mode-ocr-detail', 'Correct recognized text against the scan'),
        mode: 'ocr'
      },
      {
        label: nls.localize('ai-focused-editor/proofreading/mode-translation', 'Translation proofreading'),
        description: nls.localize('ai-focused-editor/proofreading/mode-translation-detail', 'Review a translation against the original text and scan'),
        mode: 'translation'
      }
    ];
    const picked = await this.quickInput.showQuickPick(picks, {
      title: nls.localize('ai-focused-editor/proofreading/new-set-title', 'New Proofreading Set'),
      placeholder: nls.localize('ai-focused-editor/proofreading/mode-placeholder', 'Choose a proofreading mode')
    });
    return picked?.mode;
  }

  /**
   * Create a transcript set (the transcript twin of
   * {@link createProofreadingSet}): prompt for a name (skipped when `presetName`
   * is provided), slug it, then scaffold the book-native folders —
   * `sources/audio/<slug>/` for the media and `transcription/<slug>/transcripts/`
   * for the working copy — and write `transcription/<slug>/transcriptset.yaml`.
   * When media has already been dropped into the audio folder, `files[]` is
   * seeded from it (verified:false); otherwise it starts empty and the widget
   * populates on open. The sidecar opens in the priority-500 Transcript editor.
   *
   * OWNER DECISION: the `sources/audio/` media area is appended to the book's
   * `.gitignore` (idempotently; the file is created when absent) — audio/video
   * files are heavy and stay out of git by default, user-managed afterwards.
   */
  protected async createTranscriptSet(presetName?: string): Promise<void> {
    const root = await this.getRoot();
    if (!root) {
      this.messages.warn(nls.localize(
        'ai-focused-editor/transcript/new-set-no-workspace',
        'Open a manuscript workspace before creating a transcript set.'
      ));
      return;
    }

    let trimmed = presetName?.trim();
    if (!trimmed) {
      const name = await this.quickInput.input({
        title: nls.localize('ai-focused-editor/transcript/new-set-title', 'New Transcript Set'),
        prompt: nls.localize('ai-focused-editor/transcript/new-set-prompt', 'Transcript set name'),
        placeHolder: nls.localize('ai-focused-editor/transcript/new-set-placeholder', 'e.g. Lecture 1'),
        validateInput: async value => (value.trim()
          ? undefined
          : nls.localize('ai-focused-editor/transcript/new-set-empty', 'Transcript set name cannot be empty.'))
      });
      trimmed = name?.trim();
    }
    if (!trimmed) {
      return;
    }

    const slug = createSemanticEntityId('transcriptset', trimmed);
    const existing = await this.collectExistingRelPaths(root, TRANSCRIPTION_AREA);
    const relFolder = uniqueRelativePath(transcriptSetFolder(slug), candidate => existing.has(candidate));
    const finalSlug = relFolder.slice(relFolder.lastIndexOf('/') + 1);
    const folders = transcriptSetFolders(finalSlug);

    // Media usually arrives first: seed files[] from any audio already dropped.
    const mediaNames = await this.listFolderFileNames(root, folders.audioFolder);
    const set = buildTranscriptsetSkeleton({ slug: finalSlug, mediaNames });

    await this.ensureFolder(root.resolve(TRANSCRIPTION_AREA));
    await this.ensureFolder(root.resolve('sources'));
    await this.ensureFolder(root.resolve(AUDIO_SOURCES_AREA));
    await this.ensureFolder(root.resolve(folders.audioFolder));
    await this.ensureFolder(root.resolve(relFolder));
    await this.ensureFolder(root.resolve(folders.transcriptFolder));

    const fileUri = root.resolve(transcriptsetRelPath(finalSlug));
    try {
      await this.fileService.create(fileUri, writeTranscriptsetYaml(undefined, set), { overwrite: false });
    } catch (error) {
      this.messages.warn(nls.localize(
        'ai-focused-editor/transcript/new-set-failed',
        'Could not create transcript set: {0}',
        this.detail(error)
      ));
      return;
    }

    // Keep the heavy media out of git (idempotent; a failure never blocks the set).
    await this.ensureAudioAreaGitignored(root);

    await this.openAndRefresh(fileUri);
    this.messages.info(nls.localize(
      'ai-focused-editor/transcript/new-set-created',
      'Created transcript set "{0}". Drop audio/video into {1}/ — transcripts land in {2}/.',
      trimmed,
      folders.audioFolder,
      folders.transcriptFolder
    ));
  }

  /**
   * Idempotently append the `sources/audio/` media area to the workspace-root
   * `.gitignore` (creating the file when absent), via the pure
   * {@link appendGitignoreEntry} helper. Errors degrade to a warning toast —
   * a read-only filesystem must never block set creation.
   */
  protected async ensureAudioAreaGitignored(root: URI): Promise<void> {
    const gitignoreUri = root.resolve('.gitignore');
    try {
      const existing = await this.readTextIfExists(gitignoreUri);
      const result = appendGitignoreEntry(
        existing,
        `${AUDIO_SOURCES_AREA}/`,
        'Transcript media (audio/video) — heavy files, kept out of git'
      );
      if (!result.added) {
        return;
      }
      await this.fileService.write(gitignoreUri, result.text);
      this.messages.info(nls.localize(
        'ai-focused-editor/transcript/gitignore-added',
        'Added {0}/ to .gitignore so heavy media stays out of git.',
        AUDIO_SOURCES_AREA
      ));
    } catch (error) {
      this.messages.warn(nls.localize(
        'ai-focused-editor/transcript/gitignore-failed',
        'Could not update .gitignore: {0}',
        this.detail(error)
      ));
    }
  }

  /** Base file names (non-directory) directly under a workspace-relative folder ([] when absent). */
  protected async listFolderFileNames(root: URI, relFolder: string): Promise<string[]> {
    const stat = await this.fileService.resolve(root.resolve(relFolder)).catch(() => undefined);
    return (stat?.children ?? []).filter(child => !child.isDirectory).map(child => child.name);
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
