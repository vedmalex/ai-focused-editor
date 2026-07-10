import { ClipboardService } from '@theia/core/lib/browser/clipboard-service';
import { MessageService } from '@theia/core/lib/common';
import { nls } from '@theia/core/lib/common/nls';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { open, OpenerService } from '@theia/core/lib/browser';
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
import {
  AiHistoryKind,
  AiHistoryRecord,
  AiHistoryService
} from './ai-history-service';

interface AiDebugSnapshot {
  profile: AiProfileStatus;
  modes: AiMode[];
  modeDiagnostics: WorkspaceDiagnostic[];
  activeEditorUri?: string;
  selectedTextLength: number;
  selectedTextPreview: string;
  manuscriptContext: string;
}

interface AiHistoryLogState {
  kind: AiHistoryKind;
  days: string[];
  selectedDay?: string;
  entries: AiHistoryRecord[];
  loading: boolean;
}

const MAX_CONTEXT_PREVIEW = 12000;
const MAX_SELECTION_PREVIEW = 500;
const HISTORY_LOG_LIMIT = 100;

const HISTORY_KIND_LABELS: Array<{ kind: AiHistoryKind; label: string }> = [
  { kind: 'chat', label: nls.localize('ai-focused-editor/ai-config/history-chat', 'Chat requests') },
  { kind: 'context-snapshots', label: nls.localize('ai-focused-editor/ai-config/history-context-snapshots', 'Context snapshots') }
];

@injectable()
export class AiDebugWidget extends ReactWidget {
  static readonly ID = 'ai-focused-editor.ai-debug';
  static readonly LABEL = nls.localize('ai-focused-editor/ai-config/debug-label', 'AI Debug');

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

  @inject(AiHistoryService)
  protected readonly aiHistory!: AiHistoryService;

  @inject(OpenerService)
  protected readonly openerService!: OpenerService;

  protected snapshot: AiDebugSnapshot | undefined;

  protected logState: AiHistoryLogState = {
    kind: 'chat',
    days: [],
    entries: [],
    loading: false
  };

  @postConstruct()
  protected init(): void {
    this.id = AiDebugWidget.ID;
    this.title.label = AiDebugWidget.LABEL;
    this.title.caption = nls.localize('ai-focused-editor/ai-config/debug-caption', 'AI Focused Editor prompt/context/provider inspection');
    this.title.iconClass = 'fa fa-bug';
    this.title.closable = true;
    this.addClass('afe-ai-debug-widget');
    void this.refresh();
    void this.refreshLog();
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
    await this.messages.info(nls.localize('ai-focused-editor/ai-config/snapshot-copied', 'AI debug snapshot copied to clipboard.'));
  }

  async refreshLog(): Promise<void> {
    this.logState = { ...this.logState, loading: true };
    this.update();
    const kind = this.logState.kind;
    const days = await this.aiHistory.listHistoryDays(kind);
    const selectedDay = days.includes(this.logState.selectedDay ?? '')
      ? this.logState.selectedDay
      : days[0];
    const entries = selectedDay
      ? await this.aiHistory.readHistoryEntries(kind, selectedDay, HISTORY_LOG_LIMIT)
      : [];
    // Guard against a kind switch that raced with this async load.
    if (this.logState.kind !== kind) {
      return;
    }
    this.logState = { kind, days, selectedDay, entries, loading: false };
    this.update();
  }

  async selectLogKind(kind: AiHistoryKind): Promise<void> {
    if (kind === this.logState.kind) {
      return;
    }
    this.logState = { kind, days: [], selectedDay: undefined, entries: [], loading: false };
    await this.refreshLog();
  }

  async selectLogDay(day: string): Promise<void> {
    if (day === this.logState.selectedDay) {
      return;
    }
    this.logState = { ...this.logState, selectedDay: day, loading: true };
    this.update();
    const kind = this.logState.kind;
    const entries = await this.aiHistory.readHistoryEntries(kind, day, HISTORY_LOG_LIMIT);
    if (this.logState.kind !== kind || this.logState.selectedDay !== day) {
      return;
    }
    this.logState = { ...this.logState, entries, loading: false };
    this.update();
  }

  async openLogFile(): Promise<void> {
    const { kind, selectedDay } = this.logState;
    if (!selectedDay) {
      return;
    }
    const fileUri = await this.aiHistory.getHistoryDayUri(kind, selectedDay);
    if (!fileUri) {
      return;
    }
    await open(this.openerService, fileUri).catch(async () => {
      await this.messages.warn(nls.localize('ai-focused-editor/ai-config/open-jsonl-failed', 'Could not open the history JSONL file.'));
    });
  }

  async copyLogEntry(record: AiHistoryRecord): Promise<void> {
    await this.clipboard.writeText(JSON.stringify(record, undefined, 2));
    await this.messages.info(nls.localize('ai-focused-editor/ai-config/history-entry-copied', 'AI history entry copied to clipboard.'));
  }

  protected render(): React.ReactNode {
    const snapshot = this.snapshot;
    if (!snapshot) {
      return React.createElement('div', { className: 'afe-ai-debug' }, nls.localize('ai-focused-editor/ai-config/loading-debug', 'Loading AI debug state...'));
    }

    return React.createElement(
      'div',
      { className: 'afe-ai-debug' },
      React.createElement(
        'div',
        { className: 'afe-ai-debug-actions' },
        React.createElement('h3', undefined, nls.localize('ai-focused-editor/ai-config/debug-heading', 'AI Debug')),
        React.createElement(
          'button',
          { className: 'theia-button', onClick: () => this.refresh() },
          nls.localize('ai-focused-editor/ai-config/refresh', 'Refresh')
        ),
        React.createElement(
          'button',
          { className: 'theia-button main', onClick: () => this.copySnapshot() },
          nls.localize('ai-focused-editor/ai-config/copy-snapshot', 'Copy Snapshot')
        )
      ),
      this.renderProfile(snapshot.profile),
      this.renderModes(snapshot.modes, snapshot.modeDiagnostics),
      this.renderActiveEditor(snapshot),
      React.createElement('h4', undefined, nls.localize('ai-focused-editor/ai-config/manuscript-context', 'Manuscript Context ({0} chars)', snapshot.manuscriptContext.length)),
      React.createElement('pre', { className: 'afe-ai-debug-context' }, this.truncate(snapshot.manuscriptContext, MAX_CONTEXT_PREVIEW)),
      this.renderRequestLog()
    );
  }

  protected renderRequestLog(): React.ReactNode {
    const { kind, days, selectedDay, entries, loading } = this.logState;
    return React.createElement(
      'details',
      { className: 'afe-ai-debug-section afe-ai-debug-log', open: true },
      React.createElement('summary', undefined, nls.localize('ai-focused-editor/ai-config/request-log', 'Request Log ({0})', entries.length)),
      React.createElement(
        'div',
        { className: 'afe-ai-debug-log-controls' },
        React.createElement(
          'select',
          {
            className: 'theia-select',
            value: kind,
            'aria-label': nls.localize('ai-focused-editor/ai-config/history-kind-aria', 'History log kind'),
            onChange: (event: React.ChangeEvent<HTMLSelectElement>) => this.selectLogKind(event.target.value as AiHistoryKind)
          },
          ...HISTORY_KIND_LABELS.map(entry => React.createElement('option', { key: entry.kind, value: entry.kind }, entry.label))
        ),
        days.length > 0
          ? React.createElement(
            'select',
            {
              className: 'theia-select',
              value: selectedDay ?? '',
              'aria-label': nls.localize('ai-focused-editor/ai-config/history-day-aria', 'History log day'),
              onChange: (event: React.ChangeEvent<HTMLSelectElement>) => this.selectLogDay(event.target.value)
            },
            ...days.map(day => React.createElement('option', { key: day, value: day }, day))
          )
          : undefined,
        React.createElement(
          'button',
          { className: 'theia-button', onClick: () => this.refreshLog() },
          nls.localize('ai-focused-editor/ai-config/refresh', 'Refresh')
        ),
        React.createElement(
          'button',
          {
            className: 'theia-button',
            disabled: !selectedDay,
            onClick: () => this.openLogFile()
          },
          nls.localize('ai-focused-editor/ai-config/open-jsonl', 'Open JSONL')
        )
      ),
      this.renderRequestLogBody(entries, loading)
    );
  }

  protected renderRequestLogBody(entries: AiHistoryRecord[], loading: boolean): React.ReactNode {
    if (loading && entries.length === 0) {
      return React.createElement('p', { className: 'afe-ai-debug-log-empty' }, nls.localize('ai-focused-editor/ai-config/loading-history', 'Loading history...'));
    }
    if (this.logState.days.length === 0) {
      return React.createElement('p', { className: 'afe-ai-debug-log-empty' }, nls.localize('ai-focused-editor/ai-config/history-empty', 'AI actions will be logged here as you use AI features.'));
    }
    if (entries.length === 0) {
      return React.createElement('p', { className: 'afe-ai-debug-log-empty' }, nls.localize('ai-focused-editor/ai-config/history-no-entries', 'No entries recorded for this day.'));
    }
    return React.createElement(
      'div',
      { className: 'afe-ai-debug-log-entries' },
      ...entries.map((entry, index) => this.renderRequestLogEntry(entry, index))
    );
  }

  protected renderRequestLogEntry(record: AiHistoryRecord, index: number): React.ReactNode {
    const route = this.extractRoute(record);
    return React.createElement(
      'details',
      { className: 'afe-ai-debug-log-entry', key: `${record.timestamp ?? 'entry'}-${index}` },
      React.createElement(
        'summary',
        { className: 'afe-ai-debug-log-summary' },
        React.createElement('span', { className: 'afe-ai-debug-log-time' }, this.formatTime(record.timestamp)),
        React.createElement('span', { className: 'afe-ai-debug-log-badge' }, record.kind || nls.localize('ai-focused-editor/ai-config/unknown', 'unknown')),
        React.createElement('span', { className: 'afe-ai-debug-log-command' }, record.command || nls.localize('ai-focused-editor/ai-config/no-command', '(no command)')),
        route
          ? React.createElement('span', { className: 'afe-ai-debug-log-route' }, route)
          : undefined,
        React.createElement(
          'button',
          {
            className: 'theia-button afe-ai-debug-log-copy',
            onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
              event.preventDefault();
              event.stopPropagation();
              void this.copyLogEntry(record);
            }
          },
          nls.localize('ai-focused-editor/ai-config/copy', 'Copy')
        )
      ),
      React.createElement('pre', { className: 'afe-ai-debug-log-json' }, JSON.stringify(record, undefined, 2))
    );
  }

  protected extractRoute(record: AiHistoryRecord): string | undefined {
    const route = record.data?.route;
    if (typeof route !== 'object' || route === null) {
      return undefined;
    }
    const routeRecord = route as Record<string, unknown>;
    const provider = typeof routeRecord.provider === 'string' ? routeRecord.provider : undefined;
    const model = typeof routeRecord.model === 'string' ? routeRecord.model : undefined;
    if (!provider && !model) {
      return undefined;
    }
    return [provider, model].filter(Boolean).join('/');
  }

  protected formatTime(timestamp?: string): string {
    if (!timestamp) {
      return '--:--:--';
    }
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) {
      return timestamp.slice(11, 19) || '--:--:--';
    }
    const pad = (value: number) => value.toString().padStart(2, '0');
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  protected renderProfile(profile: AiProfileStatus): React.ReactNode {
    const rows = [
      [nls.localize('ai-focused-editor/ai-config/row-configured', 'Configured'), profile.configured ? nls.localize('ai-focused-editor/ai-config/value-yes', 'yes') : nls.localize('ai-focused-editor/ai-config/value-no', 'no')],
      [nls.localize('ai-focused-editor/ai-config/row-provider', 'Provider'), profile.summary.provider || nls.localize('ai-focused-editor/ai-config/not-set', 'not set')],
      [nls.localize('ai-focused-editor/ai-config/row-model', 'Model'), profile.summary.model || nls.localize('ai-focused-editor/ai-config/not-set', 'not set')],
      [nls.localize('ai-focused-editor/ai-config/row-transport', 'Transport'), profile.summary.transportKind || 'api'],
      [nls.localize('ai-focused-editor/ai-config/row-transport-id', 'Transport ID'), profile.summary.transportId || nls.localize('ai-focused-editor/ai-config/value-default', 'default')],
      [nls.localize('ai-focused-editor/ai-config/row-profile-id', 'Profile ID'), profile.summary.profileId || nls.localize('ai-focused-editor/ai-config/value-default', 'default')],
      [nls.localize('ai-focused-editor/ai-config/row-endpoint', 'Endpoint'), profile.summary.endpointUrl || nls.localize('ai-focused-editor/ai-config/value-provider-default', 'provider default')],
      [nls.localize('ai-focused-editor/ai-config/row-api-key', 'API Key'), profile.summary.hasApiKey ? nls.localize('ai-focused-editor/ai-config/value-configured', 'configured') : nls.localize('ai-focused-editor/ai-config/value-missing', 'missing')]
    ];
    return React.createElement(
      'section',
      { className: 'afe-ai-debug-section' },
      React.createElement('h4', undefined, nls.localize('ai-focused-editor/ai-config/provider-profile-heading', 'Provider/Profile')),
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
        ? React.createElement('p', { className: 'afe-ai-debug-warning' }, nls.localize('ai-focused-editor/ai-config/missing-label', 'Missing: {0}', profile.missing.join(', ')))
        : undefined
    );
  }

  protected renderModes(modes: AiMode[], diagnostics: WorkspaceDiagnostic[]): React.ReactNode {
    return React.createElement(
      'section',
      { className: 'afe-ai-debug-section' },
      React.createElement('h4', undefined, nls.localize('ai-focused-editor/ai-config/project-ai-modes', 'Project AI Modes ({0})', modes.length)),
      modes.length === 0
        ? React.createElement('p', undefined, nls.localize('ai-focused-editor/ai-config/no-project-modes', 'No project AI modes loaded.'))
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
      React.createElement('h4', undefined, nls.localize('ai-focused-editor/ai-config/active-editor', 'Active Editor')),
      React.createElement('p', undefined, snapshot.activeEditorUri ?? nls.localize('ai-focused-editor/ai-config/no-active-editor', 'No active editor.')),
      React.createElement('p', undefined, nls.localize('ai-focused-editor/ai-config/selected-text', 'Selected text: {0} chars', snapshot.selectedTextLength)),
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
