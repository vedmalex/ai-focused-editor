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
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { ChatService } from '@theia/ai-chat/lib/common';
import type { AIContextVariable } from '@theia/ai-core';
import {
  AuthorMaterialTreeNode,
  ManuscriptTreeNode
} from './manuscript-tree';
import { ManuscriptTreeWidget } from './manuscript-tree-widget';
import { AiFocusedEditorMenus } from './ai-focused-editor-menu';
import {
  CHAPTER_CONTEXT_VARIABLE,
  ENTITY_CONTEXT_VARIABLE,
  ManuscriptContextVariableContribution,
  NOTE_CONTEXT_VARIABLE,
  SOURCE_CONTEXT_VARIABLE
} from './manuscript-context-variable-contribution';

const CATEGORY = 'AI Focused Editor';

/** Author-materials section kinds that map to an entity card (`#entity`). */
const ENTITY_SECTION_KINDS: ReadonlySet<string> = new Set(['characters', 'terms', 'artifacts', 'locations']);

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
}

/** A resolved attach target: which context variable, and the argument to pass. */
interface ContextTarget {
  variable: AIContextVariable;
  arg: string;
}

interface CategoryPick extends QuickPickItem {
  category: 'chapters' | 'sources' | 'entities' | 'notes';
}

interface ArtifactPick extends QuickPickItem {
  variable: AIContextVariable;
  arg: string;
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

  registerCommands(commands: CommandRegistry): void {
    commands.registerCommand(ChatContextCommands.ADD_CONTEXT, {
      execute: () => this.addContextInteractively()
    });
    commands.registerCommand(ChatContextCommands.SEND_SELECTION, {
      execute: () => this.sendSelectedNode(),
      isEnabled: () => this.selectedContextTarget() !== undefined,
      isVisible: () => this.selectedContextTarget() !== undefined
    });
  }

  registerMenus(menus: MenuModelRegistry): void {
    // Product menu bar: the interactive picker lives near the other AI entries.
    menus.registerMenuAction([...AiFocusedEditorMenus.MAIN, '1b_chat'], {
      commandId: ChatContextCommands.ADD_CONTEXT.id,
      order: '0'
    });
    // Manuscript navigator context menu: a dedicated `3_chat` group after the
    // create (`1_create`) and book (`2_book`) groups.
    menus.registerMenuAction([...ManuscriptTreeWidget.CONTEXT_MENU, '3_chat'], {
      commandId: ChatContextCommands.SEND_SELECTION.id,
      order: '0'
    });
  }

  // --- Interactive category → artifact picker --------------------------------

  protected async addContextInteractively(): Promise<void> {
    const [chapters, sources, entities, notes] = await Promise.all([
      this.variables.collectChapters(),
      this.variables.collectSources(),
      this.variables.collectEntities(),
      this.variables.collectNotes()
    ]);

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
        category: 'entities',
        label: nls.localize('ai-focused-editor/chat-context/category-entities', 'Entities'),
        description: String(entities.length)
      },
      {
        category: 'notes',
        label: nls.localize('ai-focused-editor/chat-context/category-notes', 'Notes'),
        description: String(notes.length)
      }
    ];

    const pickedCategory = await this.quickInput.showQuickPick(categories, {
      title: nls.localize('ai-focused-editor/chat-context/add-context', 'Add to Chat Context...'),
      placeholder: nls.localize('ai-focused-editor/chat-context/pick-category', 'Choose a category')
    });
    if (!pickedCategory) {
      return;
    }

    const artifacts = this.artifactPicksFor(pickedCategory.category, { chapters, sources, entities, notes });
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
      entities: { id: string; label: string }[];
      notes: { path: string; label: string }[];
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
        const id = node.description ?? this.entityIdFromNodeId(node.id);
        return id ? { variable: ENTITY_CONTEXT_VARIABLE, arg: id } : undefined;
      }
      const relative = node.materialUri ? this.relativePath(node.materialUri) : undefined;
      if (!relative) {
        return undefined;
      }
      if (node.sectionKind === 'sources') {
        return { variable: SOURCE_CONTEXT_VARIABLE, arg: relative };
      }
      if (node.sectionKind === 'knowledge') {
        return { variable: NOTE_CONTEXT_VARIABLE, arg: relative };
      }
    }
    return undefined;
  }

  /** Recover the entity id from a `material:<section>:<id>` tree node id. */
  protected entityIdFromNodeId(nodeId: string): string | undefined {
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
    const session = this.chatService.getActiveSession() ?? this.chatService.createSession();
    session.model.context.addVariables({ variable: target.variable, arg: target.arg });
    await this.revealChatView();
    this.messages.info(nls.localize(
      'ai-focused-editor/chat-context/attached',
      'Added "{0}" to the chat context.',
      label
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
