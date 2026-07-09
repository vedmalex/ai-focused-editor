import {
  Command,
  CommandContribution,
  CommandRegistry,
  MenuContribution,
  MenuModelRegistry,
  MessageService
} from '@theia/core/lib/common';
import { ClipboardService } from '@theia/core/lib/browser/clipboard-service';
import URI from '@theia/core/lib/common/uri';
import {
  Diagnostic,
  DiagnosticSeverity,
  Range
} from '@theia/core/shared/vscode-languageserver-protocol';
import { EditorManager } from '@theia/editor/lib/browser/editor-manager';
import type { TextEditor } from '@theia/editor/lib/browser/editor';
import { ProblemManager } from '@theia/markers/lib/browser/problem/problem-manager';
import { inject, injectable } from '@theia/core/shared/inversify';
import {
  AiConnectionService,
  AiModeRegistry,
  ManuscriptNode,
  ManuscriptWorkspaceService,
  WorkspaceDiagnostic
} from '../common';
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

const WORKSPACE_VALIDATION_OWNER = 'ai-focused-editor.workspace';
const MAX_SELECTION_PREVIEW_LENGTH = 240;
const REPLACE_SELECTION_ACTION = 'Replace Selection';
const COPY_AGAIN_ACTION = 'Copy Again';

export namespace AiFocusedEditorCommands {
  export const VALIDATE_WORKSPACE: Command = {
    id: 'ai-focused-editor.workspace.validate',
    label: 'AI Focused Editor: Validate Manuscript Workspace'
  };

  export const IMPROVE_SELECTION: Command = {
    id: 'ai-focused-editor.ai.improveSelection',
    label: 'AI Focused Editor: Improve Selected Text'
  };

  export const CHECK_CONSISTENCY: Command = {
    id: 'ai-focused-editor.ai.checkConsistency',
    label: 'AI Focused Editor: Check Manuscript Consistency'
  };

  export const COPY_MANUSCRIPT_CONTEXT: Command = {
    id: 'ai-focused-editor.ai.copyManuscriptContext',
    label: 'AI Focused Editor: Copy Manuscript AI Context'
  };

  export const VERIFY_AI_PROFILE: Command = {
    id: 'ai-focused-editor.ai.verifyProfile',
    label: 'AI Focused Editor: Verify AI Profile'
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

  protected readonly previousDiagnosticUris = new Set<string>();

  registerCommands(registry: CommandRegistry): void {
    registry.registerCommand(AiFocusedEditorCommands.VALIDATE_WORKSPACE, {
      execute: () => this.validateWorkspace()
    });

    registry.registerCommand(AiFocusedEditorCommands.IMPROVE_SELECTION, {
      execute: () => this.improveSelectedText()
    });

    registry.registerCommand(AiFocusedEditorCommands.CHECK_CONSISTENCY, {
      execute: () => this.messages.info('Consistency Check is registered; next step is publishing findings through Theia markers/diagnostics.')
    });

    registry.registerCommand(AiFocusedEditorCommands.COPY_MANUSCRIPT_CONTEXT, {
      execute: () => this.copyManuscriptContext()
    });

    registry.registerCommand(AiFocusedEditorCommands.VERIFY_AI_PROFILE, {
      execute: () => this.verifyAiProfile()
    });
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
    const selectedText = editor.document.getText(selection).trim();
    if (!selectedText) {
      await this.messages.warn('Select text in the active editor before running Improve Selected.');
      return;
    }

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
      const result = await this.aiConnection.generate(profile, {
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
              selectedText
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

      // TODO: Refactor to Theia AI ChangeSets (FR-009)
      // Instead of manual clipboard and editor.replaceText call, use the ChangeSetService from @theia/ai-core
      // to create a ChangeSet, add text edits, and call changeSetService.preview(changeSet) to open the native diff UI.
      await this.clipboardService.writeText(improvedText);
      const action = await this.messages.info(
        `Improved text copied to clipboard: ${this.previewText(improvedText)}`,
        REPLACE_SELECTION_ACTION,
        COPY_AGAIN_ACTION
      );
      let replaced = false;
      if (action === REPLACE_SELECTION_ACTION) {
        replaced = await this.replaceSelection(editor, selection, improvedText);
      } else if (action === COPY_AGAIN_ACTION) {
        await this.clipboardService.writeText(improvedText);
      }
      await this.tryAppendChatEvent({
        kind: 'ai-improve-selection',
        command: AiFocusedEditorCommands.IMPROVE_SELECTION.id,
        documentUri: editor.uri.toString(),
        data: {
          selectedText,
          improvedText,
          action: action ?? 'copied',
          replaced,
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

  protected async replaceSelection(editor: TextEditor, selection: Range, text: string): Promise<boolean> {
    const replaced = await editor.replaceText({
      source: AiFocusedEditorCommands.IMPROVE_SELECTION.id,
      replaceOperations: [{
        range: selection,
        text
      }]
    });
    if (replaced) {
      await this.messages.info('Selected text replaced with AI improvement.');
    } else {
      await this.messages.warn('Theia editor did not apply the AI replacement.');
    }
    return replaced;
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
    const menuPath = ['ai-focused-editor'];
    menus.registerSubmenu(menuPath, 'AI Focused Editor');
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
  }
}
