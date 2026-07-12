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
import { inject, injectable } from '@theia/core/shared/inversify';
import { ApplicationShell, WidgetManager } from '@theia/core/lib/browser';
import * as monaco from '@theia/monaco-editor-core';
import {
  AIContextVariable,
  AIVariableContext,
  AIVariableContribution,
  AIVariableResolutionRequest,
  AIVariableResolver,
  AIVariableService,
  ResolvedAIContextVariable
} from '@theia/ai-core';
import { AIVariableCompletionContext } from '@theia/ai-core/lib/browser';
import { ChatService } from '@theia/ai-chat/lib/common';
import {
  CONTEXT_SETS_PATH,
  findContextSet,
  hasBlockingProblems,
  parseContextSets,
  slugifyContextSetId,
  upsertContextSetInYaml,
  validateContextSet,
  ManuscriptWorkspaceService,
  type ContextSet,
  type ContextSetItem,
  type ContextSetsDocument,
  type ManuscriptWorkspaceService as ManuscriptWorkspaceServiceType
} from '../common';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { AiFocusedEditorMenus } from './ai-focused-editor-menu';

const CATEGORY = 'AI Focused Editor';

/** Shared `add-context-variable` command (provided by `@theia/ai-chat`). */
const ADD_CONTEXT_VARIABLE_COMMAND_ID = 'add-context-variable';

/**
 * Total character budget for an expanded `#set`. Members are concatenated under
 * `## <label>` headers until this cap, then a truncation marker is appended.
 */
const SET_MAX_CHARS = 64000;

export const SET_CONTEXT_VARIABLE: AIContextVariable = {
  id: 'ai-focused-editor.set-context',
  name: 'set',
  label: nls.localize('ai-focused-editor/chat-context/var-set-label', 'Context Set'),
  description: nls.localize(
    'ai-focused-editor/chat-context/var-set-description',
    'A saved named context set by id (#set:chapter-3-research) — expands to all its member variables in one chip.'
  ),
  iconClasses: ['fa', 'fa-clone'],
  isContextVariable: true,
  args: [{
    name: 'id',
    description: nls.localize(
      'ai-focused-editor/chat-context/var-set-arg-id',
      'Context-set id from ai/context-sets.yaml, e.g. chapter-3-research.'
    )
  }]
};

export namespace ContextSetsCommands {
  export const SAVE: Command = Command.toLocalizedCommand(
    { id: 'ai-focused-editor.chat.saveContextSet', category: CATEGORY, label: 'Save Context as Set...' },
    'ai-focused-editor/chat-context/save-set',
    'ai-focused-editor/chat-context/category'
  );
  export const APPLY: Command = Command.toLocalizedCommand(
    { id: 'ai-focused-editor.chat.applyContextSet', category: CATEGORY, label: 'Apply Context Set...' },
    'ai-focused-editor/chat-context/apply-set',
    'ai-focused-editor/chat-context/category'
  );
}

/** Guard field stashed on the resolution context to break `#set` → `#set` cycles. */
interface SetResolutionContext extends AIVariableContext {
  __resolvingContextSets?: Set<string>;
}

/**
 * Named context sets (`ai/context-sets.yaml`): save the active chat's context
 * variables as a reusable set, apply a set back onto the chat, and expand a set
 * inline via the `#set:<id>` mention. The set file is edited comment-preserving
 * through {@link upsertContextSetInYaml}; the mention resolver expands each
 * member through the {@link AIVariableService} and concatenates the results.
 */
@injectable()
export class ChatContextSetsContribution
  implements AIVariableContribution, AIVariableResolver, CommandContribution, MenuContribution {

  @inject(ChatService)
  protected readonly chatService!: ChatService;

  @inject(QuickInputService)
  protected readonly quickInput!: QuickInputService;

  @inject(MessageService)
  protected readonly messages!: MessageService;

  @inject(ManuscriptWorkspaceService)
  protected readonly manuscriptWorkspace!: ManuscriptWorkspaceServiceType;

  @inject(FileService)
  protected readonly fileService!: FileService;

  @inject(WidgetManager)
  protected readonly widgetManager!: WidgetManager;

  @inject(ApplicationShell)
  protected readonly shell!: ApplicationShell;

  /** Captured in {@link registerVariables} so the resolver/commands can resolve members. */
  protected variableService!: AIVariableService;

  // --- AIVariableContribution ------------------------------------------------

  registerVariables(service: AIVariableService): void {
    this.variableService = service;
    service.registerVariable(SET_CONTEXT_VARIABLE);
    service.registerResolver(SET_CONTEXT_VARIABLE, this);
    service.registerArgumentPicker(SET_CONTEXT_VARIABLE, () => this.pickSet());
    service.registerArgumentCompletionProvider(
      SET_CONTEXT_VARIABLE,
      (model, position, match) => this.completeSet(model, position, match)
    );
  }

  canResolve(request: AIVariableResolutionRequest): number {
    return request.variable.name === SET_CONTEXT_VARIABLE.name ? 100 : 0;
  }

  async resolve(
    request: AIVariableResolutionRequest,
    context: AIVariableContext
  ): Promise<ResolvedAIContextVariable | undefined> {
    const value = await this.resolveSet(request.arg?.trim(), context);
    return { variable: request.variable, arg: request.arg, value, contextValue: value };
  }

  /** Expand a set into concatenated member sections, capped at {@link SET_MAX_CHARS}. */
  protected async resolveSet(arg: string | undefined, context: AIVariableContext): Promise<string> {
    if (!arg) {
      return nls.localize('ai-focused-editor/chat-context/set-needs-id', 'Pass a set id, e.g. #set:chapter-3-research');
    }
    const document = await this.loadSets();
    const set = findContextSet(document, arg);
    if (!set) {
      const known = document.sets.map(candidate => candidate.id).join(', ');
      return nls.localize(
        'ai-focused-editor/chat-context/set-not-found',
        'No context set "{0}".{1}',
        arg,
        known ? nls.localize('ai-focused-editor/chat-context/set-known-ids', ' Known sets: {0}', known) : ''
      );
    }

    const guard = context as SetResolutionContext;
    guard.__resolvingContextSets ??= new Set<string>();
    if (guard.__resolvingContextSets.has(set.id)) {
      return nls.localize('ai-focused-editor/chat-context/set-cycle', '(context set "{0}" is already being expanded)', set.id);
    }
    guard.__resolvingContextSets.add(set.id);

    try {
      const header = `# ${nls.localize('ai-focused-editor/chat-context/set-header', 'Context set')}: ${set.label}`;
      const parts: string[] = [header];
      let total = header.length;
      let truncated = false;

      for (const item of set.items) {
        const value = await this.resolveMember(item, context);
        const section = `\n\n## ${this.memberLabel(item)}\n${value}`;
        if (total + section.length > SET_MAX_CHARS) {
          const remaining = SET_MAX_CHARS - total;
          if (remaining > 0) {
            parts.push(section.slice(0, remaining));
            total += remaining;
          }
          truncated = true;
          break;
        }
        parts.push(section);
        total += section.length;
      }

      if (truncated) {
        parts.push(`\n\n${nls.localize('ai-focused-editor/chat-context/set-truncated', '[...context set truncated]')}`);
      }
      return parts.join('');
    } finally {
      guard.__resolvingContextSets.delete(set.id);
    }
  }

  /** Resolve one set member's value through the variable service (friendly text on failure). */
  protected async resolveMember(item: ContextSetItem, context: AIVariableContext): Promise<string> {
    try {
      const resolved = await this.variableService.resolveVariable(
        { variable: item.variable, arg: item.arg },
        context
      );
      if (resolved?.value !== undefined) {
        return resolved.value;
      }
    } catch {
      // Fall through to the friendly placeholder below.
    }
    return nls.localize(
      'ai-focused-editor/chat-context/set-member-unresolved',
      '(could not resolve #{0}{1})',
      item.variable,
      item.arg ? `:${item.arg}` : ''
    );
  }

  /** A human header for a member: its variable label plus the argument, when any. */
  protected memberLabel(item: ContextSetItem): string {
    const label = this.variableService.getVariable(item.variable)?.label ?? item.variable;
    return item.arg ? `${label} — ${item.arg}` : label;
  }

  // --- Commands --------------------------------------------------------------

  registerCommands(commands: CommandRegistry): void {
    commands.registerCommand(ContextSetsCommands.SAVE, { execute: () => this.saveContextAsSet() });
    commands.registerCommand(ContextSetsCommands.APPLY, { execute: () => this.applyContextSet() });
  }

  registerMenus(menus: MenuModelRegistry): void {
    menus.registerMenuAction([...AiFocusedEditorMenus.MAIN, '1b_chat'], {
      commandId: ContextSetsCommands.SAVE.id,
      order: '2'
    });
    menus.registerMenuAction([...AiFocusedEditorMenus.MAIN, '1b_chat'], {
      commandId: ContextSetsCommands.APPLY.id,
      order: '3'
    });
  }

  /** Save the active chat's context variables as a named set. */
  protected async saveContextAsSet(): Promise<void> {
    const session = this.chatService.getActiveSession();
    const variables = session?.model.context.getVariables() ?? [];
    if (variables.length === 0) {
      this.messages.info(nls.localize(
        'ai-focused-editor/chat-context/save-set-empty',
        'The active chat has no context variables to save. Attach some context first.'
      ));
      return;
    }
    const items: ContextSetItem[] = variables.map(request => (
      request.arg ? { variable: request.variable.name, arg: request.arg } : { variable: request.variable.name }
    ));

    const label = await this.quickInput.input({
      title: ContextSetsCommands.SAVE.label,
      placeHolder: nls.localize('ai-focused-editor/chat-context/save-set-placeholder', 'e.g. Chapter 3 research'),
      prompt: nls.localize('ai-focused-editor/chat-context/save-set-prompt', 'Name for this context set ({0} items)', String(items.length))
    });
    if (!label || !label.trim()) {
      return;
    }
    const id = slugifyContextSetId(label);
    const set: ContextSet = { id, label: label.trim(), items };

    const rootUri = await this.rootUri();
    if (!rootUri) {
      this.messages.info(nls.localize('ai-focused-editor/chat-context/no-workspace', 'Open a manuscript workspace folder first.'));
      return;
    }
    const fileUri = rootUri.resolve(CONTEXT_SETS_PATH);
    const existingText = await this.readTextIfExists(fileUri);
    const document = parseContextSets(existingText);

    if (findContextSet(document, id) && !(await this.confirmOverwrite(id))) {
      return;
    }
    const otherIds = document.sets.filter(existing => existing.id !== id).map(existing => existing.id);
    const problems = validateContextSet(set, this.knownVariableNames(), otherIds);
    if (hasBlockingProblems(problems)) {
      this.messages.error(nls.localize(
        'ai-focused-editor/chat-context/save-set-invalid',
        'Could not save the context set: {0}',
        problems.filter(problem => problem.severity === 'error').map(problem => problem.message).join('; ')
      ));
      return;
    }

    try {
      await this.ensureFolder(rootUri.resolve('ai'));
      await this.fileService.create(fileUri, upsertContextSetInYaml(existingText, set), { overwrite: true });
    } catch (error) {
      this.messages.error(nls.localize(
        'ai-focused-editor/chat-context/save-set-failed',
        'Could not write the context set: {0}',
        error instanceof Error ? error.message : String(error)
      ));
      return;
    }
    this.messages.info(nls.localize(
      'ai-focused-editor/chat-context/save-set-done',
      'Saved context set "{0}" (#set:{1}).',
      set.label,
      id
    ));
  }

  /** Apply a saved set: attach every member to the active chat and reveal it. */
  protected async applyContextSet(): Promise<void> {
    const document = await this.loadSets();
    if (document.sets.length === 0) {
      this.messages.info(nls.localize(
        'ai-focused-editor/chat-context/apply-set-empty',
        'No context sets saved yet. Use "Save Context as Set..." first.'
      ));
      return;
    }
    const picked = await this.quickInput.showQuickPick(
      document.sets.map(set => ({
        label: set.label,
        description: set.id,
        detail: nls.localize('ai-focused-editor/chat-context/apply-set-count', '{0} items', String(set.items.length)),
        value: set.id
      })),
      {
        title: ContextSetsCommands.APPLY.label,
        placeholder: nls.localize('ai-focused-editor/chat-context/apply-set-pick', 'Select a context set to apply')
      }
    );
    if (!picked) {
      return;
    }
    const set = findContextSet(document, picked.value);
    if (!set) {
      return;
    }

    const requests: AIVariableResolutionRequest[] = [];
    let skipped = 0;
    for (const item of set.items) {
      const variable = this.variableService.getVariable(item.variable);
      if (!variable) {
        skipped += 1;
        continue;
      }
      requests.push(item.arg ? { variable, arg: item.arg } : { variable });
    }
    if (requests.length === 0) {
      this.messages.info(nls.localize(
        'ai-focused-editor/chat-context/apply-set-nothing',
        'Context set "{0}" has no resolvable members.',
        set.label
      ));
      return;
    }

    const chatSession = this.chatService.getActiveSession() ?? this.chatService.createSession();
    chatSession.model.context.addVariables(...requests);
    await this.revealChatView();
    this.messages.info(skipped > 0
      ? nls.localize(
          'ai-focused-editor/chat-context/apply-set-done-skipped',
          'Applied context set "{0}" ({1} items, {2} unknown skipped).',
          set.label, String(requests.length), String(skipped)
        )
      : nls.localize(
          'ai-focused-editor/chat-context/apply-set-done',
          'Applied context set "{0}" ({1} items).',
          set.label, String(requests.length)
        ));
  }

  protected async confirmOverwrite(id: string): Promise<boolean> {
    const overwrite = nls.localize('ai-focused-editor/chat-context/save-set-overwrite', 'Overwrite');
    const cancel = nls.localize('ai-focused-editor/chat-context/save-set-cancel', 'Cancel');
    const picked = await this.quickInput.showQuickPick(
      [{ label: overwrite, value: true }, { label: cancel, value: false }],
      {
        title: ContextSetsCommands.SAVE.label,
        placeholder: nls.localize('ai-focused-editor/chat-context/save-set-exists', 'A set "{0}" already exists — overwrite it?', id)
      }
    );
    return picked?.value === true;
  }

  // --- #set argument picker + completion -------------------------------------

  protected async pickSet(): Promise<string | undefined> {
    const document = await this.loadSets();
    if (document.sets.length === 0) {
      return undefined;
    }
    const picked = await this.quickInput.showQuickPick(
      document.sets.map(set => ({ label: set.label, description: set.id, value: set.id })),
      { placeholder: nls.localize('ai-focused-editor/chat-context/pick-set', 'Select a context set') }
    );
    return picked?.value;
  }

  protected async completeSet(
    model: monaco.editor.ITextModel,
    position: monaco.Position,
    matchString?: string
  ): Promise<monaco.languages.CompletionItem[] | undefined> {
    const context = AIVariableCompletionContext.get(SET_CONTEXT_VARIABLE.name, model, position, matchString);
    if (!context) {
      return undefined;
    }
    const { userInput, range, prefix } = context;
    const lowered = userInput.toLowerCase();
    const document = await this.loadSets();
    return document.sets
      .filter(set => !userInput || set.id.toLowerCase().includes(lowered) || set.label.toLowerCase().includes(lowered))
      .map((set, index) => ({
        label: set.label,
        kind: monaco.languages.CompletionItemKind.Value,
        range,
        insertText: `${prefix}${set.id}`,
        detail: set.id,
        filterText: userInput ? `${set.label} ${set.id}` : undefined,
        sortText: `ZZ${index.toString().padStart(4, '0')}`,
        command: {
          title: nls.localize('ai-focused-editor/chat-context/attach', 'Attach to Chat Context'),
          id: ADD_CONTEXT_VARIABLE_COMMAND_ID,
          arguments: [SET_CONTEXT_VARIABLE.name, set.id]
        }
      }));
  }

  // --- Helpers ---------------------------------------------------------------

  /** Names of every registered chat-context variable (for save validation). */
  protected knownVariableNames(): string[] {
    return this.variableService.getVariables().map(variable => variable.name);
  }

  protected async loadSets(): Promise<ContextSetsDocument> {
    const rootUri = await this.rootUri();
    if (!rootUri) {
      return { version: 1, sets: [] };
    }
    const text = await this.readTextIfExists(rootUri.resolve(CONTEXT_SETS_PATH));
    return parseContextSets(text);
  }

  protected async rootUri(): Promise<URI | undefined> {
    const snapshot = await this.manuscriptWorkspace.getSnapshot();
    return snapshot.rootUri ? new URI(snapshot.rootUri) : undefined;
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

  protected async revealChatView(): Promise<void> {
    try {
      const widget = await this.widgetManager.getOrCreateWidget('chat-view-widget');
      if (!widget.isAttached) {
        this.shell.addWidget(widget, { area: 'right' });
      }
      await this.shell.revealWidget(widget.id);
    } catch {
      // The chat UI is optional; attaching the variables still succeeded.
    }
  }
}
