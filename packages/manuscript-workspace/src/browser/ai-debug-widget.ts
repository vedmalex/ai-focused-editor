import { ClipboardService } from '@theia/core/lib/browser/clipboard-service';
import { MessageService } from '@theia/core/lib/common';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { EditorManager } from '@theia/editor/lib/browser/editor-manager';
import {
  inject,
  injectable,
  postConstruct
} from '@theia/core/shared/inversify';
import React from '@theia/core/shared/react';
import {
  AiMode,
  WorkspaceDiagnostic
} from '../common';
import {
  AiProfilePreferenceService,
  AiProfileStatus
} from './ai-profile-preference-service';
import { AiModeRegistry } from '../common';
import { ManuscriptAiContextAssembler } from './manuscript-ai-context-assembler';

interface AiDebugSnapshot {
  profile: AiProfileStatus;
  modes: AiMode[];
  modeDiagnostics: WorkspaceDiagnostic[];
  activeEditorUri?: string;
  selectedTextLength: number;
  selectedTextPreview: string;
  manuscriptContext: string;
}

const MAX_CONTEXT_PREVIEW = 12000;
const MAX_SELECTION_PREVIEW = 500;

@injectable()
export class AiDebugWidget extends ReactWidget {
  static readonly ID = 'ai-focused-editor.ai-debug';
  static readonly LABEL = 'AI Debug';

  @inject(AiProfilePreferenceService)
  protected readonly aiProfilePreferences!: AiProfilePreferenceService;

  @inject(AiModeRegistry)
  protected readonly aiModes!: AiModeRegistry;

  @inject(ManuscriptAiContextAssembler)
  protected readonly contextAssembler!: ManuscriptAiContextAssembler;

  @inject(EditorManager)
  protected readonly editorManager!: EditorManager;

  @inject(ClipboardService)
  protected readonly clipboard!: ClipboardService;

  @inject(MessageService)
  protected readonly messages!: MessageService;

  protected snapshot: AiDebugSnapshot | undefined;

  @postConstruct()
  protected init(): void {
    this.id = AiDebugWidget.ID;
    this.title.label = AiDebugWidget.LABEL;
    this.title.caption = 'AI Focused Editor prompt/context/provider inspection';
    this.title.iconClass = 'fa fa-bug';
    this.title.closable = true;
    this.addClass('afe-ai-debug-widget');
    void this.refresh();
  }

  async refresh(): Promise<void> {
    const [profile, modeSnapshot, manuscriptContext] = await Promise.all([
      this.aiProfilePreferences.getStatus(),
      this.aiModes.refresh(),
      this.contextAssembler.assemble()
    ]);
    const editor = this.editorManager.currentEditor?.editor ?? this.editorManager.activeEditor?.editor;
    const selectedText = editor?.document.getText(editor.selection).trim() ?? '';
    this.snapshot = {
      profile,
      modes: modeSnapshot.modes,
      modeDiagnostics: modeSnapshot.diagnostics,
      activeEditorUri: editor?.uri.toString(),
      selectedTextLength: selectedText.length,
      selectedTextPreview: this.truncate(selectedText, MAX_SELECTION_PREVIEW),
      manuscriptContext
    };
    this.update();
  }

  async copySnapshot(): Promise<void> {
    if (!this.snapshot) {
      await this.refresh();
    }
    if (!this.snapshot) {
      return;
    }
    await this.clipboard.writeText(this.formatSnapshot(this.snapshot));
    await this.messages.info('AI debug snapshot copied to clipboard.');
  }

  protected render(): React.ReactNode {
    const snapshot = this.snapshot;
    if (!snapshot) {
      return React.createElement('div', { className: 'afe-ai-debug' }, 'Loading AI debug state...');
    }

    return React.createElement(
      'div',
      { className: 'afe-ai-debug' },
      React.createElement(
        'div',
        { className: 'afe-ai-debug-actions' },
        React.createElement('h3', undefined, 'AI Debug'),
        React.createElement(
          'button',
          { className: 'theia-button', onClick: () => this.refresh() },
          'Refresh'
        ),
        React.createElement(
          'button',
          { className: 'theia-button main', onClick: () => this.copySnapshot() },
          'Copy Snapshot'
        )
      ),
      this.renderProfile(snapshot.profile),
      this.renderModes(snapshot.modes, snapshot.modeDiagnostics),
      this.renderActiveEditor(snapshot),
      React.createElement('h4', undefined, `Manuscript Context (${snapshot.manuscriptContext.length} chars)`),
      React.createElement('pre', { className: 'afe-ai-debug-context' }, this.truncate(snapshot.manuscriptContext, MAX_CONTEXT_PREVIEW))
    );
  }

  protected renderProfile(profile: AiProfileStatus): React.ReactNode {
    const rows = [
      ['Configured', profile.configured ? 'yes' : 'no'],
      ['Provider', profile.summary.provider || 'not set'],
      ['Model', profile.summary.model || 'not set'],
      ['Transport', profile.summary.transportKind || 'api'],
      ['Transport ID', profile.summary.transportId || 'default'],
      ['Profile ID', profile.summary.profileId || 'default'],
      ['Endpoint', profile.summary.endpointUrl || 'provider default'],
      ['API Key', profile.summary.hasApiKey ? 'configured' : 'missing']
    ];
    return React.createElement(
      'section',
      { className: 'afe-ai-debug-section' },
      React.createElement('h4', undefined, 'Provider/Profile'),
      React.createElement(
        'table',
        undefined,
        React.createElement(
          'tbody',
          undefined,
          ...rows.map(([label, value]) => React.createElement(
            'tr',
            { key: label },
            React.createElement('th', undefined, label),
            React.createElement('td', undefined, value)
          ))
        )
      ),
      profile.missing.length > 0
        ? React.createElement('p', { className: 'afe-ai-debug-warning' }, `Missing: ${profile.missing.join(', ')}`)
        : undefined
    );
  }

  protected renderModes(modes: AiMode[], diagnostics: WorkspaceDiagnostic[]): React.ReactNode {
    return React.createElement(
      'section',
      { className: 'afe-ai-debug-section' },
      React.createElement('h4', undefined, `Project AI Modes (${modes.length})`),
      modes.length === 0
        ? React.createElement('p', undefined, 'No project AI modes loaded.')
        : React.createElement(
          'ul',
          undefined,
          ...modes.map(mode => React.createElement(
            'li',
            { key: mode.id },
            `${mode.id}: ${mode.label}${mode.parameters ? ` ${JSON.stringify(mode.parameters)}` : ''}`
          ))
        ),
      diagnostics.length > 0
        ? React.createElement(
          'ul',
          { className: 'afe-ai-debug-diagnostics' },
          ...diagnostics.map((diagnostic, index) => React.createElement(
            'li',
            { key: `${diagnostic.source}-${index}` },
            `${diagnostic.severity}: ${diagnostic.message}`
          ))
        )
        : undefined
    );
  }

  protected renderActiveEditor(snapshot: AiDebugSnapshot): React.ReactNode {
    return React.createElement(
      'section',
      { className: 'afe-ai-debug-section' },
      React.createElement('h4', undefined, 'Active Editor'),
      React.createElement('p', undefined, snapshot.activeEditorUri ?? 'No active editor.'),
      React.createElement('p', undefined, `Selected text: ${snapshot.selectedTextLength} chars`),
      snapshot.selectedTextPreview
        ? React.createElement('pre', undefined, snapshot.selectedTextPreview)
        : undefined
    );
  }

  protected formatSnapshot(snapshot: AiDebugSnapshot): string {
    return [
      '# AI Debug Snapshot',
      '',
      '## Profile',
      `configured: ${snapshot.profile.configured}`,
      `provider: ${snapshot.profile.summary.provider || 'not set'}`,
      `model: ${snapshot.profile.summary.model || 'not set'}`,
      `transport: ${snapshot.profile.summary.transportKind || 'api'}`,
      `endpoint: ${snapshot.profile.summary.endpointUrl || 'provider default'}`,
      `apiKey: ${snapshot.profile.summary.hasApiKey ? 'configured' : 'missing'}`,
      '',
      '## Project AI Modes',
      ...snapshot.modes.map(mode => `- ${mode.id}: ${mode.label}`),
      '',
      '## Active Editor',
      snapshot.activeEditorUri ?? 'No active editor.',
      `Selected text length: ${snapshot.selectedTextLength}`,
      '',
      '## Manuscript Context',
      snapshot.manuscriptContext
    ].join('\n');
  }

  protected truncate(text: string, maxLength: number): string {
    return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}...`;
  }
}
