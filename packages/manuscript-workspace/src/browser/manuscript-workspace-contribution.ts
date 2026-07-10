import {
  Command,
  CommandContribution,
  CommandRegistry,
  MenuContribution,
  MenuModelRegistry,
  MessageService
} from '@theia/core/lib/common';
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
import type { NarrativeEntityService as NarrativeEntityServiceType } from '../common';
import {
  AI_FOCUSED_EDITOR_AI_API_KEY,
  AI_FOCUSED_EDITOR_AI_ENDPOINT_URL,
  AI_FOCUSED_EDITOR_AI_MODEL,
  AI_FOCUSED_EDITOR_AI_PROVIDER
} from './ai-focused-editor-preferences';
import { AiProfilePreferenceService } from './ai-profile-preference-service';
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
  export const VALIDATE_WORKSPACE: Command = {
    id: 'ai-focused-editor.workspace.validate',
    category: 'AI Focused Editor',
    label: 'Validate Manuscript Workspace'
  };

  export const IMPROVE_SELECTION: Command = {
    id: 'ai-focused-editor.ai.improveSelection',
    category: 'AI Focused Editor',
    label: 'Improve Selected Text'
  };

  export const CHECK_CONSISTENCY: Command = {
    id: 'ai-focused-editor.ai.checkConsistency',
    category: 'AI Focused Editor',
    label: 'Check Manuscript Consistency'
  };

  export const COPY_MANUSCRIPT_CONTEXT: Command = {
    id: 'ai-focused-editor.ai.copyManuscriptContext',
    category: 'AI Focused Editor',
    label: 'Copy Manuscript AI Context'
  };

  export const VERIFY_AI_PROFILE: Command = {
    id: 'ai-focused-editor.ai.verifyProfile',
    category: 'AI Focused Editor',
    label: 'Verify AI Profile'
  };

  export const TOGGLE_FOCUS_MODE: Command = {
    id: 'ai-focused-editor.focusMode.toggle',
    category: 'AI Focused Editor',
    label: 'Toggle Focus Mode'
  };

  export const SUGGEST_COREFERENCE: Command = {
    id: 'ai-focused-editor.ai.suggestCoreference',
    category: 'AI Focused Editor',
    label: 'Suggest Coreference Tags'
  };
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
      await this.messages.warn('Open a Markdown chapter before running coreference suggestions.');
      return;
    }

    const profile = await this.aiProfilePreferences.getConfiguredProfile();
    if (!profile) {
      await this.messages.warn('Configure the AI profile (Model Config view) before running coreference suggestions.');
      return;
    }

    const entitySnapshot = await this.narrativeEntities.getSnapshot();
    if (entitySnapshot.entities.length === 0) {
      await this.messages.warn('No entity cards found under entities/ — coreference tagging needs a knowledge base.');
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
      text: 'AI Focused Editor: suggesting coreference tags...'
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
        await this.messages.info('No coreference suggestions for this chapter.');
        return;
      }
      const ratio = updatedText.length / Math.max(originalText.length, 1);
      if (ratio < 0.7 || ratio > 1.6) {
        await this.messages.warn('Coreference response deviated too much from the source; discarded for safety.');
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
      session.model.changeSet.setTitle('Coreference Tag Suggestions');
      session.model.changeSet.addElements(changeSetElement);
      await this.revealChatView();
      await changeSetElement.openChange();
      this.messages.info('Coreference suggestions are ready for review in the diff and chat Change Set.');

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
      await this.messages.error(`Coreference suggestion failed: ${error instanceof Error ? error.message : String(error)}`);
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

    const message = `Manuscript workspace: ${files} content file(s), ${errors.length} error(s), ${warnings.length} warning(s).`;
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
      await this.messages.warn('Open a text editor before running Improve Selected.');
      return;
    }

    const selection = this.copyRange(editor.selection);
    const selectedText = editor.document.getText(selection);
    const selectedTextForPrompt = selectedText.trim();
    if (!selectedTextForPrompt) {
      await this.messages.warn('Select text in the active editor before running Improve Selected.');
      return;
    }
    const originalDocumentText = editor.document.getText();

    const profile = await this.aiProfilePreferences.getConfiguredProfile(editor.uri.toString());
    if (!profile) {
      await this.messages.warn(`Configure ${AI_FOCUSED_EDITOR_AI_PROVIDER}, ${AI_FOCUSED_EDITOR_AI_MODEL}, and ${AI_FOCUSED_EDITOR_AI_API_KEY} before running Improve Selected.`);
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
      text: 'AI Focused Editor: improving selected text...'
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
        await this.messages.warn('AI returned an empty improvement.');
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
        await this.messages.info('AI returned text identical to the current selection.');
        return;
      }

      // Surface the proposal through the native Change Set review UI in the chat view
      // (Accept/Reject controls), plus an immediate diff preview of the edit.
      session.model.changeSet.setTitle('Improve Selected Text');
      session.model.changeSet.addElements(changeSetElement);
      await this.revealChatView();
      await changeSetElement.openChange();
      this.messages.info(`AI improvement ready for review in the diff and chat Change Set: ${this.previewText(improvedText)}`);
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
      await this.messages.error(`Improve Selected failed: ${error instanceof Error ? error.message : String(error)}`);
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
    await this.messages.info(`Manuscript AI context copied to clipboard (${context.length} characters).`);
  }

  protected async checkManuscriptConsistency(): Promise<void> {
    const profile = await this.aiProfilePreferences.getConfiguredProfile();
    if (!profile) {
      await this.messages.warn('Configure the AI profile (Model Config view) before running the consistency check.');
      return;
    }

    const snapshot = await this.manuscriptWorkspace.getSnapshot();
    if (!snapshot.rootUri) {
      await this.messages.warn('Open a manuscript workspace folder before running the consistency check.');
      return;
    }

    const context = await this.manuscriptContextAssembler.assemble();
    const mode = await this.aiModes.getMode('consistency-check');
    const progress = await this.messages.showProgress({
      text: 'AI Focused Editor: checking manuscript consistency...'
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
        await this.messages.warn(`Consistency check returned an unstructured answer: ${this.previewText(result.text)}`);
      } else {
        this.publishConsistencyMarkers(snapshot.rootUri, findings);
        await this.messages.info(findings.length === 0
          ? 'AI consistency check found no issues.'
          : `AI consistency check reported ${findings.length} finding(s); see the Problems view.`);
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
      await this.messages.error(`Consistency check failed: ${error instanceof Error ? error.message : String(error)}`);
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

  protected async verifyAiProfile(): Promise<void> {
    const status = await this.aiProfilePreferences.getStatus();
    if (!status.profile) {
      await this.messages.warn(`AI profile is incomplete. Missing: ${status.missing.join(', ')}.`);
      return;
    }

    const progress = await this.messages.showProgress({
      text: 'AI Focused Editor: verifying AI profile...'
    });
    try {
      const result = await this.aiConnection.generate(status.profile, {
        messages: [
          {
            role: 'system',
            content: 'Reply with exactly: OK'
          },
          {
            role: 'user',
            content: 'Verify this AI connection.'
          }
        ],
        parameters: {
          maxTokens: 8,
          temperature: 0
        },
        logContext: {
          command: AiFocusedEditorCommands.VERIFY_AI_PROFILE.id
        }
      });
      await this.tryAppendChatEvent({
        kind: 'ai-profile-verify',
        command: AiFocusedEditorCommands.VERIFY_AI_PROFILE.id,
        data: {
          provider: status.profile.provider,
          model: status.profile.model,
          route: result.route,
          responseText: result.text,
          warnings: result.warnings,
          usage: result.usage
        }
      });
      await this.messages.info(`AI profile verified via ${result.route?.provider ?? status.profile.provider}/${result.route?.model ?? status.profile.model}: ${this.previewText(result.text)}`);
    } catch (error) {
      await this.tryAppendChatEvent({
        kind: 'ai-command-error',
        command: AiFocusedEditorCommands.VERIFY_AI_PROFILE.id,
        data: {
          provider: status.profile.provider,
          model: status.profile.model,
          error: error instanceof Error ? error.message : String(error)
        }
      });
      await this.messages.error(`AI profile verification failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      progress.cancel();
    }
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
    menus.registerSubmenu(AiFocusedEditorMenus.MAIN, AI_FOCUSED_EDITOR_MENU_LABEL);
    menus.registerSubmenu(AiFocusedEditorMenus.SEMANTIC_MARKDOWN, 'Semantic Markdown');
    menus.registerSubmenu(AiFocusedEditorMenus.BUILD, 'Build');
    menus.registerSubmenu(AiFocusedEditorMenus.KNOWLEDGE, 'Knowledge');
    menus.registerSubmenu(AiFocusedEditorMenus.SOURCES, 'Sources');
    menus.registerSubmenu(AiFocusedEditorMenus.AI_MODES, 'AI Modes');
    menus.registerSubmenu(AiFocusedEditorMenus.AI_DEBUG, 'AI Debug');
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
      label: 'Chapter Outline',
      order: '0a'
    });
    // Per-folder workbench layout is restored from local storage; a stale
    // folder can hide newer views (e.g. AI Chat). Give writers the built-in
    // reset right in the product menu.
    menus.registerMenuAction(menuPath, {
      commandId: 'reset.layout',
      label: 'Reset Workbench Layout (This Folder)',
      order: 'z9'
    });

    menus.registerMenuAction(menuPath, {
      commandId: AiFocusedEditorCommands.SUGGEST_COREFERENCE.id
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
