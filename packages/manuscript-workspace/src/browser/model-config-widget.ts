import {
  CommandService,
  Disposable,
  DisposableCollection,
  MessageService
} from '@theia/core/lib/common';
import {
  PreferenceScope,
  PreferenceService
} from '@theia/core/lib/common/preferences';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import {
  inject,
  injectable,
  postConstruct
} from '@theia/core/shared/inversify';
import React from '@theia/core/shared/react';
import {
  AiProfilePreferenceService,
  AiProfileStatus
} from './ai-profile-preference-service';
import {
  AI_FOCUSED_EDITOR_AI_API_KEY,
  AI_FOCUSED_EDITOR_AI_ENDPOINT_URL,
  AI_FOCUSED_EDITOR_AI_MODEL,
  AI_FOCUSED_EDITOR_AI_PROFILE_ID,
  AI_FOCUSED_EDITOR_AI_PROVIDER,
  AI_FOCUSED_EDITOR_AI_TRANSPORT_ID,
  AI_FOCUSED_EDITOR_AI_TRANSPORT_KIND
} from './ai-focused-editor-preferences';
import { AiFocusedEditorCommands } from './manuscript-workspace-contribution';

const AI_PROFILE_PREFERENCE_KEYS = [
  AI_FOCUSED_EDITOR_AI_PROVIDER,
  AI_FOCUSED_EDITOR_AI_MODEL,
  AI_FOCUSED_EDITOR_AI_API_KEY,
  AI_FOCUSED_EDITOR_AI_ENDPOINT_URL,
  AI_FOCUSED_EDITOR_AI_TRANSPORT_KIND,
  AI_FOCUSED_EDITOR_AI_TRANSPORT_ID,
  AI_FOCUSED_EDITOR_AI_PROFILE_ID
];

interface AiProfileDraft {
  provider: string;
  model: string;
  transportKind: string;
  transportId: string;
  profileId: string;
  endpointUrl: string;
  apiKey: string;
}

@injectable()
export class ModelConfigWidget extends ReactWidget {
  static readonly ID = 'ai-focused-editor.model-config';
  static readonly LABEL = 'AI Model Config';

  @inject(AiProfilePreferenceService)
  protected readonly aiProfilePreferences!: AiProfilePreferenceService;

  @inject(PreferenceService)
  protected readonly preferenceService!: PreferenceService;

  @inject(CommandService)
  protected readonly commandService!: CommandService;

  @inject(MessageService)
  protected readonly messages!: MessageService;

  @inject(WorkspaceService)
  protected readonly workspaceService!: WorkspaceService;

  protected status: AiProfileStatus | undefined;
  protected draft: AiProfileDraft = this.createEmptyDraft();
  protected readonly refreshDisposables = new DisposableCollection();

  @postConstruct()
  protected init(): void {
    this.id = ModelConfigWidget.ID;
    this.title.label = ModelConfigWidget.LABEL;
    this.title.caption = 'AI Focused Editor model/provider configuration';
    this.title.iconClass = 'fa fa-sliders';
    this.title.closable = true;
    this.addClass('afe-model-config-widget');

    this.toDispose.push(this.refreshDisposables);
    this.refreshDisposables.push(this.preferenceService.onPreferencesChanged(changes => {
      if (AI_PROFILE_PREFERENCE_KEYS.some(key => key in changes)) {
        void this.refresh();
      }
    }));
    this.toDispose.push(Disposable.create(() => this.refreshDisposables.dispose()));
    void this.refresh();
  }

  async refresh(): Promise<void> {
    this.status = await this.aiProfilePreferences.getStatus();
    this.draft = {
      provider: this.status.summary.provider,
      model: this.status.summary.model,
      transportKind: this.status.summary.transportKind || 'api',
      transportId: this.status.summary.transportId,
      profileId: this.status.summary.profileId,
      endpointUrl: this.status.summary.endpointUrl,
      apiKey: ''
    };
    this.update();
  }

  protected render(): React.ReactNode {
    const status = this.status;
    if (!status) {
      return React.createElement('div', { className: 'afe-model-config' }, 'Loading AI profile...');
    }

    const rows = [
      ['Provider', status.summary.provider || 'not set'],
      ['Model', status.summary.model || 'not set'],
      ['Transport', status.summary.transportKind || 'api'],
      ['Transport ID', status.summary.transportId || 'default'],
      ['Profile ID', status.summary.profileId || 'default'],
      ['Endpoint', status.summary.endpointUrl || 'provider default'],
      ['API Key', status.summary.hasApiKey ? 'configured' : 'missing']
    ];

    return React.createElement(
      'div',
      { className: 'afe-model-config' },
      React.createElement('h3', undefined, 'AI Profile'),
      React.createElement(
        'div',
        { className: status.configured ? 'afe-model-config-status ok' : 'afe-model-config-status missing' },
        status.configured ? 'Ready for configured ai-connect transport.' : `Incomplete: ${status.missing.join(', ')}`
      ),
      React.createElement(
        'table',
        { className: 'afe-model-config-table' },
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
      React.createElement(
        'form',
        {
          className: 'afe-model-config-form',
          onSubmit: (event: React.FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            void this.saveDraft();
          }
        },
        this.renderTextInput('Provider', 'provider', 'openai, anthropic, gemini, ...'),
        this.renderTextInput('Model', 'model', 'provider model id'),
        this.renderSelectInput('Transport', 'transportKind', ['api', 'proxy', 'acp', 'cli', 'server']),
        this.renderTextInput('Transport ID', 'transportId', 'optional transport id'),
        this.renderTextInput('Profile ID', 'profileId', 'optional account/profile id'),
        this.renderTextInput('Endpoint', 'endpointUrl', 'optional endpoint URL'),
        this.renderSecretInput(status.summary.hasApiKey),
        React.createElement(
          'div',
          { className: 'afe-model-config-actions' },
          React.createElement(
            'button',
            {
              className: 'theia-button main',
              type: 'submit'
            },
            'Save AI Profile'
          ),
          React.createElement(
            'button',
            {
              className: 'theia-button',
              type: 'button',
              disabled: !status.configured,
              onClick: () => this.commandService.executeCommand(AiFocusedEditorCommands.VERIFY_AI_PROFILE.id)
            },
            'Verify AI Profile'
          )
        )
      ),
      React.createElement(
        'p',
        { className: 'afe-model-config-help' },
        'Values are saved through Theia preferences under aiFocusedEditor.ai.*. Existing API keys are shown only as configured/missing and are not echoed back into the form.'
      )
    );
  }

  protected renderTextInput(label: string, field: keyof AiProfileDraft, placeholder: string): React.ReactNode {
    return React.createElement(
      'label',
      { className: 'afe-model-config-field' },
      React.createElement('span', undefined, label),
      React.createElement('input', {
        value: this.draft[field],
        placeholder,
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => this.updateDraft(field, event.currentTarget.value)
      })
    );
  }

  protected renderSelectInput(label: string, field: keyof AiProfileDraft, options: string[]): React.ReactNode {
    return React.createElement(
      'label',
      { className: 'afe-model-config-field' },
      React.createElement('span', undefined, label),
      React.createElement(
        'select',
        {
          value: this.draft[field],
          onChange: (event: React.ChangeEvent<HTMLSelectElement>) => this.updateDraft(field, event.currentTarget.value)
        },
        ...options.map(option => React.createElement('option', { key: option, value: option }, option))
      )
    );
  }

  protected renderSecretInput(hasApiKey: boolean): React.ReactNode {
    return React.createElement(
      'label',
      { className: 'afe-model-config-field' },
      React.createElement('span', undefined, hasApiKey ? 'API Key (configured)' : 'API Key'),
      React.createElement('input', {
        type: 'password',
        value: this.draft.apiKey,
        placeholder: hasApiKey ? 'leave blank to keep current key' : 'required',
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => this.updateDraft('apiKey', event.currentTarget.value)
      })
    );
  }

  protected updateDraft(field: keyof AiProfileDraft, value: string): void {
    this.draft = {
      ...this.draft,
      [field]: value
    };
    this.update();
  }

  protected async saveDraft(): Promise<void> {
    const resourceUri = await this.getPreferenceResourceUri();
    await Promise.all([
      this.setPreference(AI_FOCUSED_EDITOR_AI_PROVIDER, this.draft.provider.trim(), resourceUri),
      this.setPreference(AI_FOCUSED_EDITOR_AI_MODEL, this.draft.model.trim(), resourceUri),
      this.setPreference(AI_FOCUSED_EDITOR_AI_TRANSPORT_KIND, this.draft.transportKind.trim() || 'api', resourceUri),
      this.setPreference(AI_FOCUSED_EDITOR_AI_TRANSPORT_ID, this.draft.transportId.trim(), resourceUri),
      this.setPreference(AI_FOCUSED_EDITOR_AI_PROFILE_ID, this.draft.profileId.trim(), resourceUri),
      this.setPreference(AI_FOCUSED_EDITOR_AI_ENDPOINT_URL, this.draft.endpointUrl.trim(), resourceUri),
      this.shouldSaveApiKey()
        ? this.setPreference(AI_FOCUSED_EDITOR_AI_API_KEY, this.draft.apiKey.trim(), resourceUri)
        : Promise.resolve()
    ]);
    await this.refresh();
    await this.messages.info('AI profile preferences saved.');
  }

  protected shouldSaveApiKey(): boolean {
    return this.draft.apiKey.trim().length > 0 || !this.status?.summary.hasApiKey;
  }

  protected setPreference(preferenceName: string, value: string, resourceUri: string | undefined): Promise<void> {
    return resourceUri
      ? this.preferenceService.set(preferenceName, value, PreferenceScope.Folder, resourceUri)
      : this.preferenceService.updateValue(preferenceName, value);
  }

  protected async getPreferenceResourceUri(): Promise<string | undefined> {
    await this.workspaceService.ready;
    const root = this.workspaceService.tryGetRoots()[0] ?? (await this.workspaceService.roots)[0];
    return root?.resource.toString();
  }

  protected createEmptyDraft(): AiProfileDraft {
    return {
      provider: '',
      model: '',
      transportKind: 'api',
      transportId: '',
      profileId: '',
      endpointUrl: '',
      apiKey: ''
    };
  }
}
