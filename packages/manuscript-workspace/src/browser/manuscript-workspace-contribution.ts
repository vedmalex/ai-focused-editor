import {
  Command,
  CommandContribution,
  CommandRegistry,
  MenuContribution,
  MenuModelRegistry,
  MessageService
} from '@theia/core/lib/common';
import { nls } from '@theia/core/lib/common/nls';
import { ClipboardService } from '@theia/core/lib/browser/clipboard-service';
import { ApplicationShell } from '@theia/core/lib/browser/shell/application-shell';
import { WidgetManager } from '@theia/core/lib/browser/widget-manager';
import {
  KeybindingContribution,
  KeybindingRegistry
} from '@theia/core/lib/browser/keybinding';
import URI from '@theia/core/lib/common/uri';
import {
  Diagnostic,
  DiagnosticSeverity,
  Range
} from '@theia/core/shared/vscode-languageserver-protocol';
import { EditorManager } from '@theia/editor/lib/browser/editor-manager';
import { EDITOR_CONTEXT_MENU, EditorContextMenu } from '@theia/editor/lib/browser/editor-menu';
import type { TextEditor } from '@theia/editor/lib/browser/editor';
import { ProblemManager } from '@theia/markers/lib/browser/problem/problem-manager';
import {
  ChangeSetFileElement,
  ChangeSetFileElementFactory
} from '@theia/ai-chat/lib/browser/change-set-file-element';
import { ChatService } from '@theia/ai-chat/lib/common';
import { inject, injectable } from '@theia/core/shared/inversify';
import {
  AiConnectionService,
  AiModeRegistry,
  generateWithFailover,
  ManuscriptNode,
  ManuscriptWorkspaceService,
  NarrativeEntityService,
  WorkspaceDiagnostic
} from '../common';
import type { AliasCheckVerdict, AliasLegVerdict, NarrativeEntityService as NarrativeEntityServiceType } from '../common';
import { AiProfilePreferenceService } from './ai-profile-preference-service';
import { AiVerificationService } from './ai-verification-service';
import {
  AiHistoryRecord,
  AiHistoryService
} from './ai-history-service';
import { ManuscriptAiContextAssembler } from './manuscript-ai-context-assembler';
import {
  AI_FOCUSED_EDITOR_MENU_LABEL,
  AiFocusedEditorMenus
} from './ai-focused-editor-menu';

const WORKSPACE_VALIDATION_OWNER = 'ai-focused-editor.workspace';
const MAX_SELECTION_PREVIEW_LENGTH = 240;

export namespace AiFocusedEditorCommands {
  // en labels stay inline as the source of truth; ru comes from
  // i18n/ru/workspace.json keyed by `ai-focused-editor/workspace/*`.
  const CATEGORY_KEY = 'ai-focused-editor/workspace/category';

  export const VALIDATE_WORKSPACE: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.workspace.validate',
      category: 'AI Focused Editor',
      label: 'Validate Manuscript Workspace'
    },
    'ai-focused-editor/workspace/validate',
    CATEGORY_KEY
  );

  export const IMPROVE_SELECTION: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.ai.improveSelection',
      category: 'AI Focused Editor',
      label: 'Improve Selected Text'
    },
    'ai-focused-editor/workspace/improve-selection',
    CATEGORY_KEY
  );

  export const CHECK_CONSISTENCY: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.ai.checkConsistency',
      category: 'AI Focused Editor',
      label: 'Check Manuscript Consistency'
    },
    'ai-focused-editor/workspace/check-consistency',
    CATEGORY_KEY
  );

  export const COPY_MANUSCRIPT_CONTEXT: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.ai.copyManuscriptContext',
      category: 'AI Focused Editor',
      label: 'Copy Manuscript AI Context'
    },
    'ai-focused-editor/workspace/copy-context',
    CATEGORY_KEY
  );

  // NOTE: command id kept as 'ai-focused-editor.ai.verifyProfile' so existing
  // keybindings/menu wiring keep working; only the user-facing label changed.
  export const VERIFY_AI_PROFILE: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.ai.verifyProfile',
      category: 'AI Focused Editor',
      label: 'Verify AI Connection...'
    },
    'ai-focused-editor/workspace/verify-profile',
    CATEGORY_KEY
  );

  export const TOGGLE_FOCUS_MODE: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.focusMode.toggle',
      category: 'AI Focused Editor',
      label: 'Toggle Focus Mode'
    },
    'ai-focused-editor/workspace/toggle-focus-mode',
    CATEGORY_KEY
  );

  export const SUGGEST_COREFERENCE: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.ai.suggestCoreference',
      category: 'AI Focused Editor',
      label: 'Suggest Coreference Tags'
    },
    'ai-focused-editor/workspace/suggest-coreference',
    CATEGORY_KEY
  );

  export const AI_REVIEW_CHAPTER: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.ai.reviewChapter',
      category: 'AI Focused Editor',
      label: 'AI Review Current Chapter'
    },
    'ai-focused-editor/workspace/review-chapter',
    CATEGORY_KEY
  );
}

@injectable()
export class ManuscriptWorkspaceCommandContribution implements CommandContribution {
  @inject(MessageService)
  protected readonly messages!: MessageService;

  @inject(ManuscriptWorkspaceService)
  protected readonly manuscriptWorkspace!: ManuscriptWorkspaceService;

  @inject(AiConnectionService)
  protected readonly aiConnection!: AiConnectionService;

  @inject(EditorManager)
  protected readonly editorManager!: EditorManager;

  @inject(AiProfilePreferenceService)
  protected readonly aiProfilePreferences!: AiProfilePreferenceService;

  @inject(AiVerificationService)
  protected readonly aiVerification!: AiVerificationService;

  @inject(ClipboardService)
  protected readonly clipboardService!: ClipboardService;

  @inject(ManuscriptAiContextAssembler)
  protected readonly manuscriptContextAssembler!: ManuscriptAiContextAssembler;

  @inject(AiHistoryService)
  protected readonly aiHistory!: AiHistoryService;

  @inject(ProblemManager)
  protected readonly problemManager!: ProblemManager;

  @inject(AiModeRegistry)
  protected readonly aiModes!: AiModeRegistry;

  @inject(ChangeSetFileElementFactory)
  protected readonly changeSetFileElementFactory!: ChangeSetFileElementFactory;

  @inject(ChatService)
  protected readonly chatService!: ChatService;

  @inject(NarrativeEntityService)
  protected readonly narrativeEntities!: NarrativeEntityServiceType;

  @inject(ApplicationShell)
  protected readonly shell!: ApplicationShell;

  @inject(WidgetManager)
  protected readonly widgetManager!: WidgetManager;

  protected readonly previousDiagnosticUris = new Set<string>();

  registerCommands(registry: CommandRegistry): void {
    registry.registerCommand(AiFocusedEditorCommands.VALIDATE_WORKSPACE, {
      execute: () => this.validateWorkspace()
    });

    registry.registerCommand(AiFocusedEditorCommands.IMPROVE_SELECTION, {
      execute: () => this.improveSelectedText()
    });

    registry.registerCommand(AiFocusedEditorCommands.CHECK_CONSISTENCY, {
      execute: () => this.checkManuscriptConsistency()
    });

    registry.registerCommand(AiFocusedEditorCommands.COPY_MANUSCRIPT_CONTEXT, {
      execute: () => this.copyManuscriptContext()
    });

    registry.registerCommand(AiFocusedEditorCommands.VERIFY_AI_PROFILE, {
      execute: () => this.verifyAiProfile()
    });

    registry.registerCommand(AiFocusedEditorCommands.TOGGLE_FOCUS_MODE, {
      execute: () => this.toggleFocusMode()
    });

    registry.registerCommand(AiFocusedEditorCommands.SUGGEST_COREFERENCE, {
      execute: () => this.suggestCoreferenceTags()
    });

    registry.registerCommand(AiFocusedEditorCommands.AI_REVIEW_CHAPTER, {
      execute: () => this.aiReviewCurrentChapter()
    });
  }

  /**
   * Chapter review through the Theia AI chat pipeline: the request goes to the
   * Manuscript agent with the #chapter and #entities context variables, so the
   * review streams into the chat view with full provenance and tool access.
   */
  protected async aiReviewCurrentChapter(): Promise<void> {
    const editorWidget = this.editorManager.currentEditor ?? this.editorManager.activeEditor;
    const editor = editorWidget?.editor;
    if (!editor || !editor.uri.path.toString().endsWith('.md')) {
      await this.messages.warn(nls.localize(
        'ai-focused-editor/workspace/review-needs-markdown',
        'Open a Markdown chapter before requesting an AI review.'
      ));
      return;
    }

    const session = this.chatService.getSessions().find(candidate => candidate.isActive)
      ?? this.chatService.createSession();
    await this.revealChatView();
    const text = [
      'Review the current chapter critically as an experienced literary editor:',
      '- style, clarity, rhythm, and repetitions;',
      '- scene logic and pacing;',
      '- consistency with the entity roster (names, epithets, facts);',
      '- concrete, actionable suggestions — quote the fragment, propose a fix.',
      'Answer in the language the chapter is written in.',
      '',
      '#chapter #entities'
    ].join('\n');
    await this.chatService.sendRequest(session.id, { text });
  }

  /**
   * FR-010: propose [[kind:id|surface]] tags for untagged references to known
   * entities in the active chapter. The result arrives as a Change Set — the
   * writer reviews a diff and accepts/rejects, never an automatic rewrite.
   */
  protected async suggestCoreferenceTags(): Promise<void> {
    const editorWidget = this.editorManager.currentEditor ?? this.editorManager.activeEditor;
    const editor = editorWidget?.editor;
    if (!editor || !editor.uri.path.toString().endsWith('.md')) {
      await this.messages.warn(nls.localize(
        'ai-focused-editor/workspace/coref-needs-markdown',
        'Open a Markdown chapter before running coreference suggestions.'
      ));
      return;
    }

    const profile = await this.aiProfilePreferences.getConfiguredProfile();
    if (!profile) {
      await this.messages.warn(nls.localize(
        'ai-focused-editor/workspace/coref-needs-profile',
        'Configure an AI connection (add an endpoint and alias in the Model Config view) before running coreference suggestions.'
      ));
      return;
    }

    const entitySnapshot = await this.narrativeEntities.getSnapshot();
    if (entitySnapshot.entities.length === 0) {
      await this.messages.warn(nls.localize(
        'ai-focused-editor/workspace/coref-needs-entities',
        'No entity cards found under entities/ — coreference tagging needs a knowledge base.'
      ));
      return;
    }

    const originalText = editor.document.getText();
    const roster = entitySnapshot.entities.map(entity => ({
      tagKind: entity.kind === 'character' ? 'char' : entity.kind,
      id: entity.id,
      label: entity.label,
      aliases: entity.aliases,
      epithets: entity.epithets ?? []
    }));
    const mode = await this.aiModes.getMode('coreference-tags');
    const progress = await this.messages.showProgress({
      text: nls.localize('ai-focused-editor/workspace/coref-progress', 'AI Focused Editor: suggesting coreference tags...')
    });

    try {
      const chain = await this.aiProfilePreferences.getFailoverChain();
      const result = await generateWithFailover(this.aiConnection, chain.length > 0 ? chain : [profile], {
        messages: [
          {
            role: 'system',
            content: mode?.systemPrompt || [
              'You add semantic coreference tags to a Markdown manuscript chapter.',
              'Given a roster of known entities, wrap clear references to them as [[kind:id|surface text]] — names, aliases, epithets, and unambiguous pronouns.',
              'Rules: never change any other text; keep existing [[...]] tags untouched; skip ambiguous references; keep the surface text exactly as written.',
              'Return ONLY the complete updated Markdown document. No explanations.'
            ].join('\n')
          },
          {
            role: 'user',
            content: [
              `Entity roster (tagKind:id — label; aliases; epithets):`,
              ...roster.map(entry => `${entry.tagKind}:${entry.id} — ${entry.label}; ${entry.aliases.join(', ') || '-'}; ${entry.epithets.join(', ') || '-'}`),
              '',
              'Chapter:',
              originalText
            ].join('\n')
          }
        ],
        parameters: mode?.parameters ?? { temperature: 0 },
        logContext: {
          command: AiFocusedEditorCommands.SUGGEST_COREFERENCE.id,
          documentUri: editor.uri.toString()
        }
      });

      const updatedText = this.extractMarkdownPayload(result.text);
      if (!updatedText || updatedText === originalText) {
        await this.messages.info(nls.localize(
          'ai-focused-editor/workspace/coref-none',
          'No coreference suggestions for this chapter.'
        ));
        return;
      }
      const ratio = updatedText.length / Math.max(originalText.length, 1);
      if (ratio < 0.7 || ratio > 1.6) {
        await this.messages.warn(nls.localize(
          'ai-focused-editor/workspace/coref-deviated',
          'Coreference response deviated too much from the source; discarded for safety.'
        ));
        return;
      }

      const session = this.chatService.getSessions().find(candidate => candidate.isActive)
        ?? this.chatService.createSession();
      const requestId = `${AiFocusedEditorCommands.SUGGEST_COREFERENCE.id}.${Date.now()}`;
      const changeSetElement = this.changeSetFileElementFactory({
        uri: editor.uri,
        chatSessionId: session.id,
        requestId,
        type: 'modify',
        state: 'pending',
        originalState: originalText,
        targetState: updatedText,
        data: {
          command: AiFocusedEditorCommands.SUGGEST_COREFERENCE.id,
          requestId
        }
      });
      session.model.changeSet.setTitle(nls.localize(
        'ai-focused-editor/workspace/coref-title',
        'Coreference Tag Suggestions'
      ));
      session.model.changeSet.addElements(changeSetElement);
      await this.revealChatView();
      await changeSetElement.openChange();
      this.messages.info(nls.localize(
        'ai-focused-editor/workspace/coref-ready',
        'Coreference suggestions are ready for review in the diff and chat Change Set.'
      ));

      await this.tryAppendChatEvent({
        kind: 'ai-coreference-suggestion',
        command: AiFocusedEditorCommands.SUGGEST_COREFERENCE.id,
        documentUri: editor.uri.toString(),
        data: {
          chatSessionId: session.id,
          entityCount: roster.length,
          route: result.route,
          warnings: result.warnings,
          usage: result.usage
        }
      });
    } catch (error) {
      await this.tryAppendChatEvent({
        kind: 'ai-command-error',
        command: AiFocusedEditorCommands.SUGGEST_COREFERENCE.id,
        documentUri: editor.uri.toString(),
        data: {
          error: error instanceof Error ? error.message : String(error)
        }
      });
      await this.messages.error(nls.localize(
        'ai-focused-editor/workspace/coref-failed',
        'Coreference suggestion failed: {0}',
        error instanceof Error ? error.message : String(error)
      ));
    } finally {
      progress.cancel();
    }
  }

  /** Strips a ```markdown fence if the model wrapped the whole document in one. */
  protected extractMarkdownPayload(text: string): string {
    const trimmed = text.trim();
    const fenceMatch = trimmed.match(/^```(?:markdown|md)?\n([\s\S]*)\n```$/);
    return (fenceMatch ? fenceMatch[1] : trimmed).trim() + '\n';
  }

  protected focusModeRestore: { left: boolean; right: boolean; bottom: boolean } | undefined;

  /**
   * Focus Mode (spec §2 Primary Workbench Modes): collapse the workbench chrome
   * around the editor; toggling again restores the previously open panels.
   */
  protected toggleFocusMode(): void {
    if (this.focusModeRestore) {
      const restore = this.focusModeRestore;
      this.focusModeRestore = undefined;
      if (restore.left) {
        this.shell.expandPanel('left');
      }
      if (restore.right) {
        this.shell.expandPanel('right');
      }
      if (restore.bottom) {
        this.shell.expandPanel('bottom');
      }
      return;
    }

    this.focusModeRestore = {
      left: this.shell.isExpanded('left'),
      right: this.shell.isExpanded('right'),
      bottom: this.shell.isExpanded('bottom')
    };
    this.shell.collapsePanel('left');
    this.shell.collapsePanel('right');
    this.shell.collapsePanel('bottom');
  }

  protected async validateWorkspace(): Promise<void> {
    const snapshot = await this.manuscriptWorkspace.refresh();
    this.publishDiagnostics(snapshot.diagnostics);

    const errors = snapshot.diagnostics.filter(diagnostic => diagnostic.severity === 'error');
    const warnings = snapshot.diagnostics.filter(diagnostic => diagnostic.severity === 'warning');
    const files = this.countFiles(snapshot.content);

    const message = nls.localize(
      'ai-focused-editor/workspace/validate-summary',
      'Manuscript workspace: {0} content file(s), {1} error(s), {2} warning(s).',
      files,
      errors.length,
      warnings.length
    );
    if (errors.length > 0) {
      await this.messages.error(message);
      return;
    }
    if (warnings.length > 0) {
      await this.messages.warn(message);
      return;
    }
    await this.messages.info(message);
  }

  protected async improveSelectedText(): Promise<void> {
    const editorWidget = this.editorManager.currentEditor ?? this.editorManager.activeEditor;
    const editor = editorWidget?.editor;
    if (!editor) {
      await this.messages.warn(nls.localize(
        'ai-focused-editor/workspace/improve-needs-editor',
        'Open a text editor before running Improve Selected.'
      ));
      return;
    }

    const selection = this.copyRange(editor.selection);
    const selectedText = editor.document.getText(selection);
    const selectedTextForPrompt = selectedText.trim();
    if (!selectedTextForPrompt) {
      await this.messages.warn(nls.localize(
        'ai-focused-editor/workspace/improve-needs-selection',
        'Select text in the active editor before running Improve Selected.'
      ));
      return;
    }
    const originalDocumentText = editor.document.getText();

    const profile = await this.aiProfilePreferences.getConfiguredProfile(editor.uri.toString());
    if (!profile) {
      await this.messages.warn(nls.localize(
        'ai-focused-editor/workspace/improve-needs-profile',
        'Configure an AI connection (profile or alias) in AI Model Config before running Improve Selected.'
      ));
      return;
    }

    const snapshot = await this.manuscriptWorkspace.getSnapshot();
    const improveMode = await this.aiModes.getMode('improve-selection');
    const contextSnapshot = await this.manuscriptContextAssembler.assemble();
    await this.tryAppendContextSnapshot({
      kind: 'context-snapshot',
      command: AiFocusedEditorCommands.IMPROVE_SELECTION.id,
      documentUri: editor.uri.toString(),
      data: {
        context: contextSnapshot
      }
    });
    const progress = await this.messages.showProgress({
      text: nls.localize('ai-focused-editor/workspace/improve-progress', 'AI Focused Editor: improving selected text...')
    });

    try {
      const chain = await this.aiProfilePreferences.getFailoverChain();
      const result = await generateWithFailover(this.aiConnection, chain.length > 0 ? chain : [profile], {
        messages: [
          {
            role: 'system',
            content: improveMode?.systemPrompt || [
              'You are an editorial assistant for a Markdown manuscript editor.',
              'Improve the selected text while preserving its language, meaning, Markdown structure, and semantic inline tags.',
              'Return only the improved replacement text. Do not add explanations.'
            ].join('\n')
          },
          {
            role: 'user',
            content: [
              improveMode?.userPrompt,
              `Document URI: ${editor.uri.toString()}`,
              `Language: ${editor.document.languageId}`,
              snapshot.rootUri ? `Workspace root: ${snapshot.rootUri}` : undefined,
              '',
              'Selected text:',
              selectedTextForPrompt
            ].filter((line): line is string => line !== undefined).join('\n')
          }
        ],
        parameters: improveMode?.parameters ?? {
          temperature: 0.2
        },
        logContext: {
          command: AiFocusedEditorCommands.IMPROVE_SELECTION.id,
          aiModeId: improveMode?.id ?? 'builtin-improve-selection',
          documentUri: editor.uri.toString(),
          workspaceRootUri: snapshot.rootUri
        }
      });

      const improvedText = result.text.trim();
      if (!improvedText) {
        await this.messages.warn(nls.localize(
          'ai-focused-editor/workspace/improve-empty',
          'AI returned an empty improvement.'
        ));
        return;
      }

      const session = this.chatService.getSessions().find(candidate => candidate.isActive)
        ?? this.chatService.createSession();
      const changeSetElement = this.createImproveSelectionChangeSetElement(
        editor,
        selection,
        originalDocumentText,
        improvedText,
        session.id
      );
      if (changeSetElement.targetState === originalDocumentText) {
        await this.messages.info(nls.localize(
          'ai-focused-editor/workspace/improve-identical',
          'AI returned text identical to the current selection.'
        ));
        return;
      }

      // Surface the proposal through the native Change Set review UI in the chat view
      // (Accept/Reject controls), plus an immediate diff preview of the edit.
      session.model.changeSet.setTitle(nls.localize(
        'ai-focused-editor/workspace/improve-title',
        'Improve Selected Text'
      ));
      session.model.changeSet.addElements(changeSetElement);
      await this.revealChatView();
      await changeSetElement.openChange();
      this.messages.info(nls.localize(
        'ai-focused-editor/workspace/improve-ready',
        'AI improvement ready for review in the diff and chat Change Set: {0}',
        this.previewText(improvedText)
      ));
      await this.tryAppendChatEvent({
        kind: 'ai-improve-selection',
        command: AiFocusedEditorCommands.IMPROVE_SELECTION.id,
        documentUri: editor.uri.toString(),
        data: {
          selectedText,
          improvedText,
          action: 'change-set-review',
          chatSessionId: session.id,
          aiModeId: improveMode?.id ?? 'builtin-improve-selection',
          route: result.route,
          warnings: result.warnings,
          usage: result.usage
        }
      });
    } catch (error) {
      await this.tryAppendChatEvent({
        kind: 'ai-command-error',
        command: AiFocusedEditorCommands.IMPROVE_SELECTION.id,
        documentUri: editor.uri.toString(),
        data: {
          error: error instanceof Error ? error.message : String(error)
        }
      });
      await this.messages.error(nls.localize(
        'ai-focused-editor/workspace/improve-failed',
        'Improve Selected failed: {0}',
        error instanceof Error ? error.message : String(error)
      ));
    } finally {
      progress.cancel();
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
      // The chat UI is optional; the diff preview still carries the review flow.
    }
  }

  protected createImproveSelectionChangeSetElement(
    editor: TextEditor,
    selection: Range,
    originalDocumentText: string,
    improvedText: string,
    chatSessionId: string
  ): ChangeSetFileElement {
    const targetState = this.replaceRangeInText(originalDocumentText, selection, improvedText);
    const requestId = `${AiFocusedEditorCommands.IMPROVE_SELECTION.id}.${Date.now()}`;
    return this.changeSetFileElementFactory({
      uri: editor.uri,
      chatSessionId,
      requestId,
      type: 'modify',
      state: 'pending',
      originalState: originalDocumentText,
      targetState,
      data: {
        command: AiFocusedEditorCommands.IMPROVE_SELECTION.id,
        requestId
      }
    });
  }

  protected replaceRangeInText(text: string, range: Range, replacement: string): string {
    const startOffset = this.offsetAt(text, range.start);
    const endOffset = this.offsetAt(text, range.end);
    return `${text.slice(0, startOffset)}${replacement}${text.slice(endOffset)}`;
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
    return {
      start: {
        line: range.start.line,
        character: range.start.character
      },
      end: {
        line: range.end.line,
        character: range.end.character
      }
    };
  }

  protected async copyManuscriptContext(): Promise<void> {
    const context = await this.manuscriptContextAssembler.assemble();
    await this.tryAppendContextSnapshot({
      kind: 'context-snapshot',
      command: AiFocusedEditorCommands.COPY_MANUSCRIPT_CONTEXT.id,
      data: {
        context
      }
    });
    await this.clipboardService.writeText(context);
    await this.messages.info(nls.localize(
      'ai-focused-editor/workspace/context-copied',
      'Manuscript AI context copied to clipboard ({0} characters).',
      context.length
    ));
  }

  protected async checkManuscriptConsistency(): Promise<void> {
    const profile = await this.aiProfilePreferences.getConfiguredProfile();
    if (!profile) {
      await this.messages.warn(nls.localize(
        'ai-focused-editor/workspace/consistency-needs-profile',
        'Configure an AI connection (add an endpoint and alias in the Model Config view) before running the consistency check.'
      ));
      return;
    }

    const snapshot = await this.manuscriptWorkspace.getSnapshot();
    if (!snapshot.rootUri) {
      await this.messages.warn(nls.localize(
        'ai-focused-editor/workspace/consistency-needs-workspace',
        'Open a manuscript workspace folder before running the consistency check.'
      ));
      return;
    }

    const context = await this.manuscriptContextAssembler.assemble();
    const mode = await this.aiModes.getMode('consistency-check');
    const progress = await this.messages.showProgress({
      text: nls.localize('ai-focused-editor/workspace/consistency-progress', 'AI Focused Editor: checking manuscript consistency...')
    });

    try {
      const chain = await this.aiProfilePreferences.getFailoverChain();
      const result = await generateWithFailover(this.aiConnection, chain.length > 0 ? chain : [profile], {
        messages: [
          {
            role: 'system',
            content: mode?.systemPrompt || [
              'You are a narrative consistency reviewer for a Markdown manuscript with [[kind:id|label]] semantic tags.',
              'Find contradictions: character facts, artifact ownership, timeline breaks, terminology drift, unresolved references.',
              'Respond ONLY with a JSON array. Each item: {"path": "<workspace-relative file>", "line": <1-based line or null>, "severity": "info"|"warning", "message": "<finding>"}.',
              'Return [] when the manuscript is consistent. No prose outside the JSON.'
            ].join('\n')
          },
          {
            role: 'user',
            content: [
              mode?.userPrompt,
              'Manuscript context:',
              context
            ].filter((line): line is string => line !== undefined).join('\n\n')
          }
        ],
        parameters: mode?.parameters ?? { temperature: 0 },
        logContext: {
          command: AiFocusedEditorCommands.CHECK_CONSISTENCY.id,
          workspaceRootUri: snapshot.rootUri
        }
      });

      const findings = this.parseConsistencyFindings(result.text);
      if (findings === undefined) {
        await this.messages.warn(nls.localize(
          'ai-focused-editor/workspace/consistency-unstructured',
          'Consistency check returned an unstructured answer: {0}',
          this.previewText(result.text)
        ));
      } else {
        this.publishConsistencyMarkers(snapshot.rootUri, findings);
        await this.messages.info(findings.length === 0
          ? nls.localize('ai-focused-editor/workspace/consistency-none', 'AI consistency check found no issues.')
          : nls.localize(
              'ai-focused-editor/workspace/consistency-found',
              'AI consistency check reported {0} finding(s); see the Problems view.',
              findings.length
            ));
      }

      await this.tryAppendChatEvent({
        kind: 'ai-consistency-check',
        command: AiFocusedEditorCommands.CHECK_CONSISTENCY.id,
        data: {
          findings: findings ?? result.text,
          route: result.route,
          warnings: result.warnings,
          usage: result.usage
        }
      });
    } catch (error) {
      await this.tryAppendChatEvent({
        kind: 'ai-command-error',
        command: AiFocusedEditorCommands.CHECK_CONSISTENCY.id,
        data: {
          error: error instanceof Error ? error.message : String(error)
        }
      });
      await this.messages.error(nls.localize(
        'ai-focused-editor/workspace/consistency-failed',
        'Consistency check failed: {0}',
        error instanceof Error ? error.message : String(error)
      ));
    } finally {
      progress.cancel();
    }
  }

  protected parseConsistencyFindings(text: string): { path?: string; line?: number; severity?: string; message: string }[] | undefined {
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      return undefined;
    }
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(parsed)) {
        return undefined;
      }
      return parsed
        .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
        .map(item => ({
          path: typeof item.path === 'string' ? item.path : undefined,
          line: typeof item.line === 'number' && item.line > 0 ? item.line : undefined,
          severity: typeof item.severity === 'string' ? item.severity : undefined,
          message: typeof item.message === 'string' ? item.message : JSON.stringify(item)
        }));
    } catch {
      return undefined;
    }
  }

  protected readonly previousConsistencyUris = new Set<string>();

  protected publishConsistencyMarkers(
    rootUri: string,
    findings: { path?: string; line?: number; severity?: string; message: string }[]
  ): void {
    const owner = 'ai-focused-editor.consistency';
    for (const uri of this.previousConsistencyUris) {
      this.problemManager.setMarkers(new URI(uri), owner, []);
    }
    this.previousConsistencyUris.clear();

    const byUri = new Map<string, Diagnostic[]>();
    for (const finding of findings) {
      const target = finding.path
        ? new URI(rootUri).resolve(finding.path).toString()
        : rootUri;
      const line = Math.max(0, (finding.line ?? 1) - 1);
      const diagnostic: Diagnostic = {
        severity: finding.severity === 'warning' ? DiagnosticSeverity.Warning : DiagnosticSeverity.Information,
        source: 'ai-consistency',
        message: finding.message,
        range: Range.create(line, 0, line, 1000)
      };
      const bucket = byUri.get(target) ?? [];
      bucket.push(diagnostic);
      byUri.set(target, bucket);
    }

    for (const [uri, diagnostics] of byUri.entries()) {
      this.problemManager.setMarkers(new URI(uri), owner, diagnostics);
      this.previousConsistencyUris.add(uri);
    }
  }

  /**
   * Verifies the ACTIVE alias with the two-stage per-leg report: for each chain
   * leg in order — connection reachability, model presence, and a minimal
   * single-leg test generation — plus an overall verdict.
   */
  protected async verifyAiProfile(): Promise<void> {
    const status = await this.aiProfilePreferences.getStatus();
    if (status.notConfigured) {
      await this.messages.warn(nls.localize(
        'ai-focused-editor/workspace/verify-not-configured',
        'No AI connection configured yet — add an endpoint and an alias in AI Model Config.'
      ));
      return;
    }

    const progress = await this.messages.showProgress({
      text: nls.localize('ai-focused-editor/workspace/verify-progress', 'AI Focused Editor: verifying AI connection...')
    });
    try {
      const verdict = await this.aiVerification.checkAlias();
      await this.tryAppendChatEvent({
        kind: 'ai-profile-verify',
        command: AiFocusedEditorCommands.VERIFY_AI_PROFILE.id,
        data: {
          alias: verdict.aliasId,
          overall: verdict.overall,
          legs: verdict.legs
        }
      });
      const report = this.formatAliasVerdictReport(verdict);
      if (verdict.overall === 'ok') {
        await this.messages.info(report);
      } else if (verdict.overall === 'failed') {
        await this.messages.error(report);
      } else {
        await this.messages.warn(report);
      }
    } catch (error) {
      await this.tryAppendChatEvent({
        kind: 'ai-command-error',
        command: AiFocusedEditorCommands.VERIFY_AI_PROFILE.id,
        data: {
          error: error instanceof Error ? error.message : String(error)
        }
      });
      await this.messages.error(nls.localize(
        'ai-focused-editor/workspace/verify-failed',
        'AI connection verification failed: {0}',
        error instanceof Error ? error.message : String(error)
      ));
    } finally {
      progress.cancel();
    }
  }

  /** One-line-per-leg verdict report for the active-alias verification message. */
  protected formatAliasVerdictReport(verdict: AliasCheckVerdict): string {
    const overall = verdict.overall === 'ok'
      ? nls.localize('ai-focused-editor/workspace/verify-alias-ok', 'AI alias "{0}" works.', verdict.aliasLabel)
      : verdict.overall === 'failed'
        ? nls.localize('ai-focused-editor/workspace/verify-alias-failed', 'AI alias "{0}": no leg passed verification.', verdict.aliasLabel)
        : verdict.overall === 'unavailable'
          ? nls.localize('ai-focused-editor/workspace/verify-alias-unavailable', 'AI alias "{0}": no legs are available right now.', verdict.aliasLabel)
          : nls.localize('ai-focused-editor/workspace/verify-alias-empty', 'AI alias "{0}": the chain is empty.', verdict.aliasLabel);
    const lines = verdict.legs.map(leg => this.formatLegLine(leg));
    return lines.length > 0 ? `${overall}\n${lines.join('\n')}` : overall;
  }

  protected formatLegLine(leg: AliasLegVerdict): string {
    const head = `${leg.endpointId} → ${leg.model || nls.localize('ai-focused-editor/workspace/verify-leg-no-model', '(no model)')}`;
    if (leg.skipped) {
      const reason = leg.skipped === 'missing-endpoint'
        ? nls.localize('ai-focused-editor/workspace/verify-leg-skip-missing', 'endpoint not found')
        : leg.skipped === 'disabled'
          ? nls.localize('ai-focused-editor/workspace/verify-leg-skip-disabled', 'endpoint disabled')
          : nls.localize('ai-focused-editor/workspace/verify-leg-skip-window', 'outside availability window');
      return nls.localize('ai-focused-editor/workspace/verify-leg-skipped', '• {0} — skipped: {1}', head, reason);
    }
    const connection = leg.connection === 'ok' ? '✓' : '✗';
    const model = leg.modelState === 'present' ? '✓' : leg.modelState === 'absent' ? '✗' : '?';
    const generation = leg.generation === 'ok' ? '✓' : '✗';
    const marks = nls.localize('ai-focused-editor/workspace/verify-leg-marks', '{0} connection, {1} model, {2} generation', connection, model, generation);
    const detail = leg.generationError || leg.connectionDetail;
    const base = nls.localize('ai-focused-editor/workspace/verify-leg-row', '• {0} — {1}', head, marks);
    return detail ? `${base} (${detail})` : base;
  }

  protected async tryAppendChatEvent(record: AiHistoryRecord): Promise<void> {
    try {
      await this.aiHistory.appendChatEvent(record);
    } catch {
      // History is append-only observability; command UX should not fail when logging fails.
    }
  }

  protected async tryAppendContextSnapshot(record: AiHistoryRecord): Promise<void> {
    try {
      await this.aiHistory.appendContextSnapshot(record);
    } catch {
      // History is append-only observability; command UX should not fail when logging fails.
    }
  }

  protected previewText(text: string): string {
    const singleLine = text.replace(/\s+/g, ' ').trim();
    if (singleLine.length <= MAX_SELECTION_PREVIEW_LENGTH) {
      return singleLine;
    }
    return `${singleLine.slice(0, MAX_SELECTION_PREVIEW_LENGTH - 1)}...`;
  }

  protected publishDiagnostics(diagnostics: WorkspaceDiagnostic[]): void {
    for (const uri of this.previousDiagnosticUris) {
      this.problemManager.setMarkers(new URI(uri), WORKSPACE_VALIDATION_OWNER, []);
    }
    this.previousDiagnosticUris.clear();

    const grouped = new Map<string, Diagnostic[]>();
    for (const diagnostic of diagnostics) {
      if (!diagnostic.uri) {
        continue;
      }

      const markers = grouped.get(diagnostic.uri) ?? [];
      markers.push({
        message: diagnostic.message,
        source: diagnostic.source,
        severity: this.toDiagnosticSeverity(diagnostic.severity),
        range: diagnostic.range ?? {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 1 }
        }
      });
      grouped.set(diagnostic.uri, markers);
    }

    for (const [uri, markers] of grouped) {
      this.problemManager.setMarkers(new URI(uri), WORKSPACE_VALIDATION_OWNER, markers);
      this.previousDiagnosticUris.add(uri);
    }
  }

  protected toDiagnosticSeverity(severity: WorkspaceDiagnostic['severity']): DiagnosticSeverity {
    switch (severity) {
      case 'error':
        return DiagnosticSeverity.Error;
      case 'warning':
        return DiagnosticSeverity.Warning;
      case 'info':
        return DiagnosticSeverity.Information;
    }
  }

  protected countFiles(nodes: ManuscriptNode[]): number {
    return nodes.reduce((count, node) => {
      const own = node.type === 'file' ? 1 : 0;
      const children = Array.isArray(node.children) ? this.countFiles(node.children) : 0;
      return count + own + children;
    }, 0);
  }
}

@injectable()
export class ManuscriptWorkspaceMenuContribution implements MenuContribution {
  registerMenus(menus: MenuModelRegistry): void {
    const menuPath = AiFocusedEditorMenus.MAIN;
    // The product menu tree is registered EXACTLY ONCE here: repeated
    // registerSubmenu calls for the same path create duplicate menu bar
    // entries in the current Theia menu model.
    // registerSubmenu stores the label statically; it is resolved here once at
    // frontend startup, AFTER the i18n preloader applied the active locale. A
    // locale switch always triggers a full window reload, so the label is
    // re-resolved for the new locale — no per-locale re-registration needed.
    menus.registerSubmenu(
      AiFocusedEditorMenus.MAIN,
      nls.localize('ai-focused-editor/menu/manuscript', AI_FOCUSED_EDITOR_MENU_LABEL)
    );
    menus.registerSubmenu(
      AiFocusedEditorMenus.SEMANTIC_MARKDOWN,
      nls.localize('ai-focused-editor/workspace/submenu-semantic-markdown', 'Semantic Markdown')
    );
    menus.registerSubmenu(AiFocusedEditorMenus.BUILD, nls.localize('ai-focused-editor/workspace/submenu-build', 'Build'));
    menus.registerSubmenu(
      AiFocusedEditorMenus.KNOWLEDGE,
      nls.localize('ai-focused-editor/workspace/submenu-knowledge', 'Knowledge')
    );
    menus.registerSubmenu(AiFocusedEditorMenus.SOURCES, nls.localize('ai-focused-editor/workspace/submenu-sources', 'Sources'));
    menus.registerSubmenu(AiFocusedEditorMenus.AI_MODES, nls.localize('ai-focused-editor/workspace/submenu-ai-modes', 'AI Modes'));
    menus.registerSubmenu(AiFocusedEditorMenus.AI_DEBUG, nls.localize('ai-focused-editor/workspace/submenu-ai-debug', 'AI Debug'));
    menus.registerMenuAction(menuPath, {
      commandId: AiFocusedEditorCommands.VALIDATE_WORKSPACE.id
    });
    menus.registerMenuAction(menuPath, {
      commandId: AiFocusedEditorCommands.IMPROVE_SELECTION.id
    });
    menus.registerMenuAction(menuPath, {
      commandId: AiFocusedEditorCommands.CHECK_CONSISTENCY.id
    });
    menus.registerMenuAction(menuPath, {
      commandId: AiFocusedEditorCommands.COPY_MANUSCRIPT_CONTEXT.id
    });
    menus.registerMenuAction(menuPath, {
      commandId: AiFocusedEditorCommands.VERIFY_AI_PROFILE.id
    });
    menus.registerMenuAction(menuPath, {
      commandId: AiFocusedEditorCommands.TOGGLE_FOCUS_MODE.id,
      order: '0'
    });
    // The chapter outline (headings + entities) lives in the standard
    // Outline view; surface its toggle in the product menu.
    menus.registerMenuAction(menuPath, {
      commandId: 'outlineView:toggle',
      label: nls.localize('ai-focused-editor/workspace/chapter-outline', 'Chapter Outline'),
      order: '0a'
    });
    // Per-folder workbench layout is restored from local storage; a stale
    // folder can hide newer views (e.g. AI Chat). Give writers the built-in
    // reset right in the product menu.
    menus.registerMenuAction(menuPath, {
      commandId: 'reset.layout',
      label: nls.localize('ai-focused-editor/workspace/reset-layout', 'Reset Workbench Layout (This Folder)'),
      order: 'z9'
    });

    menus.registerMenuAction(menuPath, {
      commandId: AiFocusedEditorCommands.SUGGEST_COREFERENCE.id
    });
    menus.registerMenuAction(menuPath, {
      commandId: AiFocusedEditorCommands.AI_REVIEW_CHAPTER.id
    });

    // Writer-facing AI actions belong in the editor context menu (spec FR-009).
    const editorAiMenuPath = [...EDITOR_CONTEXT_MENU, ...EditorContextMenu.MODIFICATION];
    menus.registerMenuAction(editorAiMenuPath, {
      commandId: AiFocusedEditorCommands.IMPROVE_SELECTION.id,
      order: 'z1'
    });
    menus.registerMenuAction(editorAiMenuPath, {
      commandId: AiFocusedEditorCommands.SUGGEST_COREFERENCE.id,
      order: 'z2'
    });
    menus.registerMenuAction(editorAiMenuPath, {
      commandId: AiFocusedEditorCommands.AI_REVIEW_CHAPTER.id,
      order: 'z3'
    });
  }
}

@injectable()
export class ManuscriptWorkspaceKeybindingContribution implements KeybindingContribution {
  registerKeybindings(keybindings: KeybindingRegistry): void {
    keybindings.registerKeybinding({
      command: AiFocusedEditorCommands.IMPROVE_SELECTION.id,
      keybinding: 'ctrlcmd+alt+i',
      when: 'editorTextFocus'
    });
    keybindings.registerKeybinding({
      command: AiFocusedEditorCommands.VALIDATE_WORKSPACE.id,
      keybinding: 'ctrlcmd+alt+v'
    });
    keybindings.registerKeybinding({
      command: AiFocusedEditorCommands.TOGGLE_FOCUS_MODE.id,
      keybinding: 'ctrlcmd+alt+f'
    });
  }
}
