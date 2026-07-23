import {
  Command,
  CommandRegistry,
  DisposableCollection,
  MenuModelRegistry,
  MenuPath,
  MessageService
} from '@theia/core/lib/common';
import { nls } from '@theia/core/lib/common/nls';
import URI from '@theia/core/lib/common/uri';
import {
  ApplicationShell,
  FrontendApplicationContribution,
  WidgetManager
} from '@theia/core/lib/browser';
import { Range } from '@theia/core/shared/vscode-languageserver-protocol';
import { EditorManager } from '@theia/editor/lib/browser/editor-manager';
import { EDITOR_CONTEXT_MENU } from '@theia/editor/lib/browser/editor-menu';
import type { TextEditor } from '@theia/editor/lib/browser/editor';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { ChatAgentService, ChatService } from '@theia/ai-chat/lib/common';
import { ChangeProposal, ChangeProposalService } from './change-proposal-service';
import { CustomAgentFactory } from '@theia/ai-chat/lib/browser/custom-agent-factory';
import { AgentService } from '@theia/ai-core';
import { inject, injectable } from '@theia/core/shared/inversify';
import {
  AiConnectionService,
  AiMode,
  AiModeApply,
  AiModeContext,
  AiModeRegistry,
  generateWithFailover,
  normalizeRange,
  resolveAiModeApply,
  wordAtOffset
} from '../common';
import { computeAgentDisplayName, computeAgentSignature } from '../common/ai/agent-signature';
import { MODE_AGENT_ID_PREFIX } from '../common/ai/agent-ids';
import { AiProfilePreferenceService } from '@ai-focused-editor/ai-connect-theia/lib/browser';
import { AiRequestLogService } from '@ai-focused-editor/ai-connect-theia/lib/browser';
import { AiHistoryService } from '@ai-focused-editor/ai-connect-theia/lib/browser';
import { AiConnectTheiaLanguageModel } from '@ai-focused-editor/ai-connect-theia/lib/browser';

const AI_MODES_CATEGORY = nls.localize('ai-focused-editor/ai-modes/modes-category', 'AI Modes');
const MODE_RUN_COMMAND_PREFIX = 'ai-focused-editor.mode.run.';
const AI_MODES_SUBMENU: MenuPath = [...EDITOR_CONTEXT_MENU, 'ai-focused-editor-modes'];
const AI_MODES_SUBMENU_LABEL = nls.localize('ai-focused-editor/ai-modes/submenu-label', 'AI Modes');
const REFRESH_DEBOUNCE_MS = 300;

/**
 * Author-defined AI modes as first-class editor commands, context-menu entries,
 * and chat agents (spec: author prompts/agents visible in ai-chat and context
 * menus, placed by context).
 *
 * A single {@link FrontendApplicationContribution} owns the whole lifecycle:
 * it (re)registers one command per `menu: true` mode into an "AI Modes" submenu
 * of the editor context menu, registers one chat `@agent` per `agent: true`
 * mode, and re-syncs both whenever `ai/prompts/custom-modes.yaml` changes.
 *
 * Menu commands look up the latest mode definition from the registry at
 * execution time, so editing a prompt without touching its label/context takes
 * effect without re-registration.
 */
@injectable()
export class AiModeDynamicContribution implements FrontendApplicationContribution {
  @inject(MessageService)
  protected readonly messages!: MessageService;

  @inject(CommandRegistry)
  protected readonly commandRegistry!: CommandRegistry;

  @inject(MenuModelRegistry)
  protected readonly menuRegistry!: MenuModelRegistry;

  @inject(EditorManager)
  protected readonly editorManager!: EditorManager;

  @inject(AiConnectionService)
  protected readonly aiConnection!: AiConnectionService;

  @inject(AiProfilePreferenceService)
  protected readonly aiProfilePreferences!: AiProfilePreferenceService;

  @inject(AiRequestLogService)
  protected readonly requestLog!: AiRequestLogService;

  @inject(AiModeRegistry)
  protected readonly aiModes!: AiModeRegistry;

  @inject(AiHistoryService)
  protected readonly aiHistory!: AiHistoryService;

  @inject(ChangeProposalService)
  protected readonly changeProposals!: ChangeProposalService;

  @inject(ChatService)
  protected readonly chatService!: ChatService;

  @inject(ChatAgentService)
  protected readonly chatAgentService!: ChatAgentService;

  @inject(AgentService)
  protected readonly agentService!: AgentService;

  @inject(CustomAgentFactory)
  protected readonly customAgentFactory!: CustomAgentFactory;

  @inject(FileService)
  protected readonly fileService!: FileService;

  @inject(WorkspaceService)
  protected readonly workspaceService!: WorkspaceService;

  @inject(ApplicationShell)
  protected readonly shell!: ApplicationShell;

  @inject(WidgetManager)
  protected readonly widgetManager!: WidgetManager;

  protected readonly toDispose = new DisposableCollection();
  protected commandMenuDisposables = new DisposableCollection();
  protected sourceWatcher = new DisposableCollection();
  protected watchedSourceUris: URI[] = [];

  /** Menu-relevant signature; guards against redundant re-registration. */
  protected menuSignature = '';
  /** Registered agent id -> definition signature. */
  protected readonly registeredAgents = new Map<string, string>();

  protected refreshPromise: Promise<void> | undefined;
  protected refreshTimer: ReturnType<typeof setTimeout> | undefined;

  async onStart(): Promise<void> {
    // The submenu shell is registered exactly once for the app lifetime; only
    // the actions inside it are added and removed as modes change.
    this.toDispose.push(this.menuRegistry.registerSubmenu(AI_MODES_SUBMENU, AI_MODES_SUBMENU_LABEL));
    this.toDispose.push(this.workspaceService.onWorkspaceChanged(() => this.scheduleRefresh()));
    this.toDispose.push(this.fileService.onDidFilesChange(event => {
      if (this.watchedSourceUris.some(uri => event.contains(uri))) {
        this.scheduleRefresh();
      }
    }));
    await this.refresh();
  }

  onStop(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    this.commandMenuDisposables.dispose();
    this.sourceWatcher.dispose();
    this.toDispose.dispose();
    for (const agentId of [...this.registeredAgents.keys()]) {
      this.unregisterAgent(agentId);
    }
    this.registeredAgents.clear();
  }

  protected scheduleRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh();
    }, REFRESH_DEBOUNCE_MS);
  }

  protected refresh(): Promise<void> {
    if (!this.refreshPromise) {
      this.refreshPromise = this.doRefresh().finally(() => {
        this.refreshPromise = undefined;
      });
    }
    return this.refreshPromise;
  }

  protected async doRefresh(): Promise<void> {
    const snapshot = await this.aiModes.refresh();
    this.syncCommandsAndMenus(snapshot.modes);
    this.syncAgents(snapshot.modes);
    this.updateSourceWatchers(snapshot.watchUris ?? (snapshot.sourceUri ? [snapshot.sourceUri] : []));
  }

  // --- Commands + context menu ---------------------------------------------

  protected syncCommandsAndMenus(modes: AiMode[]): void {
    const menuModes = modes.filter(mode => mode.menu);
    const signature = JSON.stringify(
      menuModes.map(mode => [mode.id, mode.label, mode.context ?? 'chat', resolveAiModeApply(mode), mode.icon ?? ''])
    );
    if (signature === this.menuSignature) {
      return;
    }
    this.menuSignature = signature;
    this.commandMenuDisposables.dispose();
    this.commandMenuDisposables = new DisposableCollection();

    for (const mode of menuModes) {
      const commandId = `${MODE_RUN_COMMAND_PREFIX}${mode.id}`;
      const context: AiModeContext = mode.context ?? 'chat';
      const modeId = mode.id;
      const iconClass = mode.icon ? `codicon codicon-${mode.icon}` : undefined;
      const command: Command = {
        id: commandId,
        category: AI_MODES_CATEGORY,
        label: mode.label,
        iconClass
      };
      // The item stays visible in the context menu (discoverable) but is only
      // enabled when its context applies (e.g. a selection mode needs a
      // selection); running it via the command palette re-checks the same way.
      this.commandMenuDisposables.push(this.commandRegistry.registerCommand(command, {
        execute: () => this.runModeById(modeId, commandId),
        isEnabled: () => this.isContextEnabled(context)
      }));
      this.commandMenuDisposables.push(this.menuRegistry.registerMenuAction(AI_MODES_SUBMENU, {
        commandId,
        label: mode.label,
        order: mode.label,
        icon: iconClass
      }));
    }
  }

  /** Synchronous enablement used by both the command and the context menu. */
  protected isContextEnabled(context: AiModeContext): boolean {
    const editor = this.activeEditor();
    switch (context) {
      case 'selection':
        return this.hasSelection(editor);
      case 'word':
        return this.wordUnderCursor(editor) !== undefined;
      case 'chapter':
        return !!editor && this.isMarkdown(editor);
      case 'chat':
      default:
        return true;
    }
  }

  // --- Chat agents ----------------------------------------------------------

  /**
   * Registers/updates/removes chat agents for `agent: true` modes.
   *
   * `@theia/ai-chat` and `@theia/ai-core` both expose programmatic
   * unregistration (`ChatAgentService.unregisterChatAgent` /
   * `AgentService.unregisterAgent`), so removed or edited agents are cleaned up
   * live — no application reload is required.
   */
  protected syncAgents(modes: AiMode[]): void {
    const agentModes = modes.filter(mode => mode.agent);
    const nextSignatures = new Map<string, string>();
    for (const mode of agentModes) {
      nextSignatures.set(this.agentId(mode.id), this.agentSignature(mode));
    }

    // Remove agents that disappeared or whose definition changed.
    for (const [agentId, signature] of [...this.registeredAgents]) {
      if (nextSignatures.get(agentId) !== signature) {
        this.unregisterAgent(agentId);
        this.registeredAgents.delete(agentId);
      }
    }

    // Register new or changed agents.
    for (const mode of agentModes) {
      const agentId = this.agentId(mode.id);
      if (this.registeredAgents.has(agentId)) {
        continue;
      }
      try {
        this.customAgentFactory(
          agentId,
          // The @mention dropdown and the AI capabilities/settings panels render
          // the agent NAME, so it carries the human-readable mode label (falling
          // back to the id). Mentions still resolve by the stable ASCII agent id:
          // the completion inserts the id as the token and the chat request parser
          // resolves `@<id>` via `ChatAgentService.getAgent(id)`, so a non-ASCII
          // label here is display-only and never has to satisfy the mention regex.
          this.agentDisplayName(mode),
          mode.description || nls.localize('ai-focused-editor/ai-modes/agent-description', 'Project AI mode agent: {0}', mode.id),
          [
            mode.systemPrompt,
            '',
            'The manuscript workspace context is available as the {{manuscript}} variable.'
          ].join('\n'),
          AiConnectTheiaLanguageModel.ID,
          true
        );
        this.registeredAgents.set(agentId, this.agentSignature(mode));
      } catch (error) {
        console.warn(`[ai-modes] Failed to register chat agent for mode "${mode.id}":`, error);
      }
    }
  }

  protected unregisterAgent(agentId: string): void {
    try {
      this.chatAgentService.unregisterChatAgent(agentId);
      this.agentService.unregisterAgent(agentId);
    } catch (error) {
      console.warn(`[ai-modes] Failed to unregister chat agent "${agentId}":`, error);
    }
  }

  protected agentId(modeId: string): string {
    return `${MODE_AGENT_ID_PREFIX}${modeId}`;
  }

  /**
   * Human-readable agent name shown in the chat `@mention` completion and the AI
   * capabilities/settings panels; falls back to the mode id when a label is
   * missing. This is display text only — mentions resolve by {@link agentId}.
   */
  protected agentDisplayName(mode: AiMode): string {
    return computeAgentDisplayName(mode);
  }

  protected agentSignature(mode: AiMode): string {
    return computeAgentSignature(mode);
  }

  // --- Execution ------------------------------------------------------------

  protected async runModeById(modeId: string, commandId: string): Promise<void> {
    const mode = await this.aiModes.getMode(modeId);
    if (!mode) {
      await this.messages.warn(nls.localize('ai-focused-editor/ai-modes/mode-unavailable', 'This AI mode is no longer available; reload the modes file.'));
      return;
    }
    await this.runMode(mode, commandId);
  }

  protected async runMode(mode: AiMode, commandId: string): Promise<void> {
    const editor = this.activeEditor();
    const context: AiModeContext = mode.context ?? 'chat';
    const apply = resolveAiModeApply(mode);

    let input = '';
    let targetRange: Range | undefined;

    if (context === 'selection') {
      if (!editor) {
        await this.messages.warn(nls.localize('ai-focused-editor/ai-modes/open-editor-first', 'Open an editor before running this AI mode.'));
        return;
      }
      const selection = this.copyRange(editor.selection);
      const selectedText = editor.document.getText(selection);
      if (!selectedText.trim()) {
        await this.messages.warn(nls.localize('ai-focused-editor/ai-modes/select-text-first', 'Select text before running "{0}".', mode.label));
        return;
      }
      input = selectedText;
      targetRange = selection;
    } else if (context === 'word') {
      if (!editor) {
        await this.messages.warn(nls.localize('ai-focused-editor/ai-modes/open-editor-first', 'Open an editor before running this AI mode.'));
        return;
      }
      const word = this.wordUnderCursor(editor);
      if (!word) {
        await this.messages.warn(nls.localize('ai-focused-editor/ai-modes/place-cursor-first', 'Place the cursor on a word before running "{0}".', mode.label));
        return;
      }
      input = word.text;
      targetRange = word.range;
    } else if (context === 'chapter') {
      if (!editor) {
        await this.messages.warn(nls.localize('ai-focused-editor/ai-modes/open-chapter-first', 'Open a chapter before running this AI mode.'));
        return;
      }
      input = editor.document.getText().trim();
      if (!input) {
        await this.messages.warn(nls.localize('ai-focused-editor/ai-modes/chapter-empty', 'The active chapter is empty.'));
        return;
      }
    }

    if (apply === 'chat') {
      await this.sendToChat(mode, context, input, editor?.uri.toString());
      return;
    }

    if (!editor || !targetRange) {
      // Writer's miss: selecting in the markdown preview does not select in Monaco.
      const domSelection = typeof window !== 'undefined' ? window.getSelection()?.toString().trim() : '';
      if (editor && domSelection) {
        await this.messages.warn(nls.localize(
          'ai-focused-editor/ai-modes/selection-elsewhere',
          'The selection is in the preview or another pane — select the text in the chapter editor itself.'
        ));
        return;
      }
      await this.messages.warn(nls.localize('ai-focused-editor/ai-modes/needs-selection', '"{0}" needs an editor selection or word to apply its result.', mode.label));
      return;
    }
    await this.applyEdit(mode, commandId, editor, targetRange, input, apply, context);
  }

  protected async sendToChat(
    mode: AiMode,
    context: AiModeContext,
    input: string,
    documentUri: string | undefined
  ): Promise<void> {
    const session = this.chatService.getSessions().find(candidate => candidate.isActive)
      ?? this.chatService.createSession();
    await this.revealChatView();

    const instruction = input
      ? `Use the "${mode.label}" instruction on this input:\n\n${input}`
      : `Use the "${mode.label}" instruction.`;
    // Reference the agent by its stable ASCII id (not its now-human-readable
    // name): the chat request parser resolves `@<id>` via getAgent(id), and the
    // id always satisfies the mention regex even when the label does not.
    const text = mode.agent ? `@${this.agentId(mode.id)} ${instruction}` : instruction;

    await this.chatService.sendRequest(session.id, { text });
    await this.logRun(mode, context, 'chat', documentUri, { chatSessionId: session.id });
  }

  protected async applyEdit(
    mode: AiMode,
    commandId: string,
    editor: TextEditor,
    targetRange: Range,
    input: string,
    apply: AiModeApply,
    context: AiModeContext
  ): Promise<void> {
    const documentUri = editor.uri.toString();
    const profile = await this.aiProfilePreferences.getConfiguredProfile(documentUri);
    if (!profile) {
      await this.messages.warn(nls.localize('ai-focused-editor/ai-modes/configure-profile-first', 'Configure an AI connection (add an endpoint and alias in the Model Config view) before running this AI mode.'));
      return;
    }

    const originalDocumentText = editor.document.getText();
    const progress = await this.messages.showProgress({
      text: nls.localize('ai-focused-editor/ai-modes/run-progress', 'AI Focused Editor: {0}...', mode.label)
    });
    try {
      const chain = await this.aiProfilePreferences.getFailoverChain(documentUri);
      const result = await generateWithFailover(this.aiConnection, chain.length > 0 ? chain : [profile], {
        messages: [
          {
            role: 'system',
            content: mode.systemPrompt
          },
          {
            role: 'user',
            content: [
              mode.userPrompt || undefined,
              `Document URI: ${documentUri}`,
              `Language: ${editor.document.languageId}`,
              `Mode context: ${context}`,
              '',
              'Input text:',
              input
            ].filter((line): line is string => line !== undefined).join('\n')
          }
        ],
        parameters: mode.parameters ?? { temperature: 0.2 },
        logContext: {
          command: commandId,
          aiModeId: mode.id,
          documentUri
        }
      }, this.requestLog.createRecorder(commandId, documentUri));

      const generated = result.text.trim();
      if (!generated) {
        await this.messages.info(nls.localize('ai-focused-editor/ai-modes/empty-result', '"{0}" returned an empty result.', mode.label));
        return;
      }

      const targetState = apply === 'replace'
        ? this.replaceRangeInText(originalDocumentText, targetRange, generated)
        : this.insertAfterRange(originalDocumentText, targetRange, generated);
      if (targetState === originalDocumentText) {
        await this.messages.info(nls.localize('ai-focused-editor/ai-modes/no-change', '"{0}" produced no change to apply.', mode.label));
        return;
      }

      const proposal: ChangeProposal = {
        uri: editor.uri.toString(),
        originalText: originalDocumentText,
        targetText: targetState,
        title: mode.label
      };
      await this.changeProposals.openDiff(proposal);
      this.changeProposals.notifyReady(proposal, nls.localize(
        'ai-focused-editor/ai-modes/result-ready',
        '"{0}" result is ready — review the diff, then Apply.', mode.label
      ));

      await this.logRun(mode, context, apply, documentUri, {
        action: 'diff-proposal',
        route: result.route,
        warnings: result.warnings,
        usage: result.usage
      });
    } catch (error) {
      await this.logRun(mode, context, apply, documentUri, {
        error: error instanceof Error ? error.message : String(error)
      });
      await this.messages.error(nls.localize('ai-focused-editor/ai-modes/mode-failed', '"{0}" failed: {1}', mode.label, error instanceof Error ? error.message : String(error)));
    } finally {
      progress.cancel();
    }
  }

  protected async logRun(
    mode: AiMode,
    context: AiModeContext,
    apply: AiModeApply,
    documentUri: string | undefined,
    data: Record<string, unknown> = {}
  ): Promise<void> {
    try {
      await this.aiHistory.appendChatEvent({
        kind: 'ai-mode-run',
        command: `${MODE_RUN_COMMAND_PREFIX}${mode.id}`,
        documentUri,
        data: {
          mode: mode.id,
          context,
          apply,
          ...data
        }
      });
    } catch {
      // History is append-only observability; command UX must not fail on it.
    }
  }

  // --- Editor helpers -------------------------------------------------------

  protected activeEditor(): TextEditor | undefined {
    return (this.editorManager.currentEditor ?? this.editorManager.activeEditor)?.editor;
  }

  protected hasSelection(editor: TextEditor | undefined): boolean {
    if (!editor) {
      return false;
    }
    const selection = editor.selection;
    return selection.start.line !== selection.end.line
      || selection.start.character !== selection.end.character;
  }

  protected wordUnderCursor(editor: TextEditor | undefined): { text: string; range: Range } | undefined {
    if (!editor) {
      return undefined;
    }
    try {
      const cursor = editor.cursor;
      const lineText = editor.document.getLineContent(cursor.line + 1);
      const found = wordAtOffset(lineText, cursor.character);
      if (!found) {
        return undefined;
      }
      return {
        text: found.word,
        range: Range.create(cursor.line, found.start, cursor.line, found.end)
      };
    } catch {
      return undefined;
    }
  }

  protected isMarkdown(editor: TextEditor): boolean {
    return editor.uri.path.ext.toLowerCase() === '.md' || editor.document.languageId === 'markdown';
  }

  protected replaceRangeInText(text: string, range: Range, replacement: string): string {
    const startOffset = this.offsetAt(text, range.start);
    const endOffset = this.offsetAt(text, range.end);
    return `${text.slice(0, startOffset)}${replacement}${text.slice(endOffset)}`;
  }

  protected insertAfterRange(text: string, range: Range, insertion: string): string {
    const endOffset = this.offsetAt(text, range.end);
    const before = text.slice(0, endOffset);
    // Avoid gluing the insertion onto a preceding word/selection.
    const glue = /\S$/.test(before) && /^\S/.test(insertion) ? ' ' : '';
    return `${before}${glue}${insertion}${text.slice(endOffset)}`;
  }

  protected offsetAt(text: string, position: Range['start']): number {
    let offset = 0;
    let line = 0;
    while (line < position.line && offset < text.length) {
      const nextLineBreak = text.indexOf('\n', offset);
      if (nextLineBreak === -1) {
        return text.length;
      }
      offset = nextLineBreak + 1;
      line++;
    }
    return Math.min(offset + position.character, text.length);
  }

  protected copyRange(range: Range): Range {
    // Normalizes too: an upward (rtl) selection arrives with start AFTER end
    // (Theia maps start=anchor, end=cursor) — splicing it raw duplicates text.
    return normalizeRange(range) as Range;
  }

  protected async revealChatView(): Promise<void> {
    try {
      const widget = await this.widgetManager.getOrCreateWidget('chat-view-widget');
      if (!widget.isAttached) {
        this.shell.addWidget(widget, { area: 'right' });
      }
      await this.shell.revealWidget(widget.id);
    } catch {
      // The chat UI is optional; the diff preview still carries the review flow.
    }
  }

  // --- Source file watcher --------------------------------------------------

  protected updateSourceWatchers(sourceUris: string[]): void {
    const next = [...new Set(sourceUris)].sort();
    const current = this.watchedSourceUris.map(uri => uri.toString()).sort();
    if (next.length === current.length && next.every((uri, index) => uri === current[index])) {
      return;
    }
    this.sourceWatcher.dispose();
    this.sourceWatcher = new DisposableCollection();
    this.watchedSourceUris = next.map(uri => new URI(uri));
    for (const uri of this.watchedSourceUris) {
      try {
        this.sourceWatcher.push(this.fileService.watch(uri.parent));
      } catch {
        // Missing prompt directories (e.g. no global config yet) must not
        // prevent the app from starting.
      }
    }
  }
}
