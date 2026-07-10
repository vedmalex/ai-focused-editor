import {
  CommandService,
  Disposable,
  DisposableCollection,
  MessageService
} from '@theia/core/lib/common';
import { PreferenceService } from '@theia/core/lib/common/preferences';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import {
  inject,
  injectable,
  postConstruct
} from '@theia/core/shared/inversify';
import React from '@theia/core/shared/react';
import type {
  AiConnectionProfile,
  AiModelDiscoveryResult,
  AiProfileDescriptor,
  StoredAiProfile
} from '../common';
import { AiConnectionService } from '../common';
import {
  AiProviderCatalogEntry,
  getAiProviderCatalog,
  getLocalProxyEndpointDefaults
} from '../common/ai-connect-config';
import {
  AiProfilePreferenceService,
  AiProfileStatus
} from './ai-profile-preference-service';
import {
  AI_FOCUSED_EDITOR_AI_ACTIVE_PROFILE,
  AI_FOCUSED_EDITOR_AI_API_KEY,
  AI_FOCUSED_EDITOR_AI_API_KEYS,
  AI_FOCUSED_EDITOR_AI_ENDPOINT_URL,
  AI_FOCUSED_EDITOR_AI_MODEL,
  AI_FOCUSED_EDITOR_AI_PROFILE_ID,
  AI_FOCUSED_EDITOR_AI_PROFILES,
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
  AI_FOCUSED_EDITOR_AI_PROFILE_ID,
  AI_FOCUSED_EDITOR_AI_PROFILES,
  AI_FOCUSED_EDITOR_AI_ACTIVE_PROFILE,
  AI_FOCUSED_EDITOR_AI_API_KEYS
];

const CUSTOM_PROVIDER_OPTION = '__custom__';
const GENERIC_TRANSPORT_KINDS = ['api', 'proxy', 'acp', 'cli', 'server'];

interface AiProfileDraft {
  id: string;
  label: string;
  provider: string;
  model: string;
  transportKind: string;
  transportId: string;
  profileId: string;
  endpointUrl: string;
  apiKey: string;
  allowedModels: string;
  enabled: boolean;
}

@injectable()
export class ModelConfigWidget extends ReactWidget {
  static readonly ID = 'ai-focused-editor.model-config';
  static readonly LABEL = 'AI Model Config';

  @inject(AiProfilePreferenceService)
  protected readonly aiProfilePreferences!: AiProfilePreferenceService;

  @inject(AiConnectionService)
  protected readonly aiConnection!: AiConnectionService;

  @inject(PreferenceService)
  protected readonly preferenceService!: PreferenceService;

  @inject(CommandService)
  protected readonly commandService!: CommandService;

  @inject(MessageService)
  protected readonly messages!: MessageService;

  protected readonly providerCatalog: AiProviderCatalogEntry[] = getAiProviderCatalog();
  protected status: AiProfileStatus | undefined;
  protected descriptors: AiProfileDescriptor[] = [];
  protected selectedId: string | undefined;
  protected draft: AiProfileDraft = this.createEmptyDraft();
  protected discovering = false;
  protected discovery: AiModelDiscoveryResult | undefined;
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
    this.descriptors = await this.aiProfilePreferences.listProfiles();
    const stored = this.aiProfilePreferences.getStoredProfileList();
    const selected = stored.find(profile => profile.id === this.selectedId)
      ?? stored.find(profile => this.descriptors.find(d => d.active)?.id === profile.id)
      ?? stored[0];
    this.selectedId = selected?.id;
    this.draft = selected ? this.toDraft(selected) : this.createEmptyDraft();
    this.update();
  }

  protected toDraft(profile: StoredAiProfile): AiProfileDraft {
    return {
      id: profile.id,
      label: profile.label ?? '',
      provider: profile.provider ?? '',
      model: profile.model ?? '',
      transportKind: profile.transportKind || 'api',
      transportId: profile.transportId ?? '',
      profileId: profile.profileId ?? '',
      endpointUrl: profile.endpointUrl ?? '',
      apiKey: '',
      allowedModels: (profile.allowedModels ?? []).join(', '),
      enabled: profile.enabled !== false
    };
  }

  protected render(): React.ReactNode {
    const status = this.status;
    if (!status) {
      return React.createElement('div', { className: 'afe-model-config' }, 'Loading AI profile...');
    }

    return React.createElement(
      'div',
      { className: 'afe-model-config' },
      React.createElement('h3', undefined, 'AI Profiles'),
      React.createElement(
        'div',
        { className: status.configured ? 'afe-model-config-status ok' : 'afe-model-config-status missing' },
        status.configured
          ? `Active profile ready (${status.summary.chainLength} profile(s) in the failover chain).`
          : `Active profile incomplete: ${status.missing.join(', ')}`
      ),
      this.renderProfileList(),
      React.createElement('h4', undefined, this.draft.id ? `Edit Profile: ${this.draft.label || this.draft.id}` : 'New Profile'),
      React.createElement(
        'form',
        {
          className: 'afe-model-config-form',
          onSubmit: (event: React.FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            void this.saveDraft();
          }
        },
        this.renderTextInput('Profile Label', 'label', 'display name, e.g. Local Proxy / Anthropic'),
        this.renderProviderInput(),
        this.renderModelInput(),
        this.renderTransportInput(),
        this.renderTextInput('Account ID', 'profileId', 'optional ai-connect account id'),
        this.renderTextInput('Endpoint', 'endpointUrl', 'optional endpoint URL'),
        this.renderTextInput('Allowed Models', 'allowedModels', 'optional comma-separated shortlist'),
        this.renderSecretInput(),
        React.createElement(
          'div',
          { className: 'afe-model-config-actions' },
          React.createElement('button', { className: 'theia-button main', type: 'submit' }, 'Save Profile'),
          React.createElement(
            'button',
            {
              className: 'theia-button',
              type: 'button',
              disabled: !status.configured,
              onClick: () => this.commandService.executeCommand(AiFocusedEditorCommands.VERIFY_AI_PROFILE.id)
            },
            'Verify Active'
          ),
          React.createElement(
            'button',
            {
              className: 'theia-button',
              type: 'button',
              title: 'Fill endpoint and model for a local ai-connect proxy on 127.0.0.1:8045',
              onClick: () => this.applyLocalProxyDefaults()
            },
            'Use Local Proxy'
          ),
          React.createElement(
            'button',
            {
              className: 'theia-button',
              type: 'button',
              disabled: this.discovering || !this.draft.provider.trim(),
              title: 'Query the configured endpoint for its available models',
              onClick: () => { void this.discoverModels(); }
            },
            this.discovering ? 'Discovering...' : 'Discover Models'
          )
        )
      ),
      this.renderDiscoveryResults(),
      React.createElement(
        'p',
        { className: 'afe-model-config-help' },
        'Profiles are saved in workspace settings; API keys are saved per profile in user settings and never echoed back. An API key is only required for the api transport (acp/cli/server authorize through the underlying agent). The failover chain tries the active profile first, then the remaining enabled profiles in list order.'
      )
    );
  }

  protected dragProfileId: string | undefined;

  protected renderProfileList(): React.ReactNode {
    if (this.descriptors.length === 0) {
      return undefined;
    }
    return React.createElement(
      'ul',
      { className: 'afe-model-config-profiles' },
      ...this.descriptors.map((descriptor, index) => React.createElement(
        'li',
        {
          key: descriptor.id,
          className: descriptor.id === this.selectedId ? 'selected' : undefined,
          // FR-020: drag a profile row to a new position in the failover order.
          draggable: true,
          onDragStart: (event: React.DragEvent) => {
            this.dragProfileId = descriptor.id;
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', descriptor.id);
          },
          onDragOver: (event: React.DragEvent) => {
            if (this.dragProfileId && this.dragProfileId !== descriptor.id) {
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
            }
          },
          onDrop: (event: React.DragEvent) => {
            event.preventDefault();
            const sourceId = this.dragProfileId;
            this.dragProfileId = undefined;
            if (sourceId && sourceId !== descriptor.id) {
              void this.aiProfilePreferences.reorderProfile(sourceId, index).then(() => this.refresh());
            }
          },
          onDragEnd: () => { this.dragProfileId = undefined; }
        },
        React.createElement('input', {
          type: 'radio',
          name: 'afe-active-profile',
          checked: descriptor.active,
          title: 'Set as active profile',
          onChange: () => { void this.setActive(descriptor.id); }
        }),
        React.createElement(
          'button',
          {
            className: 'afe-model-config-profile-name',
            type: 'button',
            title: descriptor.configured ? 'Edit this profile' : `Incomplete: ${descriptor.missing.join(', ')}`,
            onClick: () => this.selectProfile(descriptor.id)
          },
          `${descriptor.label} — ${descriptor.provider || '?'} / ${descriptor.model || '?'} (${descriptor.transportKind})${descriptor.configured ? '' : ' ⚠'}${descriptor.enabled ? '' : ' [disabled]'}`
        ),
        React.createElement('button', {
          className: 'theia-button secondary',
          type: 'button',
          disabled: index === 0,
          title: 'Move up in the failover order',
          onClick: () => { void this.moveProfile(descriptor.id, -1); }
        }, '↑'),
        React.createElement('button', {
          className: 'theia-button secondary',
          type: 'button',
          disabled: index === this.descriptors.length - 1,
          title: 'Move down in the failover order',
          onClick: () => { void this.moveProfile(descriptor.id, 1); }
        }, '↓'),
        React.createElement('button', {
          className: 'theia-button secondary',
          type: 'button',
          title: 'Clone profile',
          onClick: () => this.cloneProfile(descriptor.id)
        }, '⧉'),
        React.createElement('button', {
          className: 'theia-button secondary',
          type: 'button',
          title: 'Delete profile',
          onClick: () => { void this.deleteProfile(descriptor.id); }
        }, '✕')
      )),
      React.createElement(
        'li',
        { key: '__new__' },
        React.createElement('button', {
          className: 'theia-button secondary',
          type: 'button',
          onClick: () => this.newProfile()
        }, '+ New Profile')
      )
    );
  }

  protected selectProfile(id: string): void {
    this.selectedId = id;
    const stored = this.aiProfilePreferences.getStoredProfileList().find(profile => profile.id === id);
    if (stored) {
      this.draft = this.toDraft(stored);
      this.discovery = undefined;
    }
    this.update();
  }

  protected newProfile(): void {
    this.selectedId = undefined;
    this.draft = this.createEmptyDraft();
    this.discovery = undefined;
    this.update();
  }

  protected cloneProfile(id: string): void {
    const stored = this.aiProfilePreferences.getStoredProfileList().find(profile => profile.id === id);
    if (!stored) {
      return;
    }
    this.selectedId = undefined;
    this.draft = {
      ...this.toDraft(stored),
      id: this.uniqueProfileId(`${stored.id}-copy`),
      label: stored.label ? `${stored.label} (copy)` : ''
    };
    this.discovery = undefined;
    this.update();
  }

  protected async setActive(id: string): Promise<void> {
    await this.aiProfilePreferences.setActiveProfile(id);
    await this.refresh();
  }

  protected async moveProfile(id: string, delta: -1 | 1): Promise<void> {
    await this.aiProfilePreferences.moveProfile(id, delta);
    await this.refresh();
  }

  protected async deleteProfile(id: string): Promise<void> {
    await this.aiProfilePreferences.deleteProfile(id);
    if (this.selectedId === id) {
      this.selectedId = undefined;
    }
    await this.refresh();
    this.messages.info(`AI profile "${id}" deleted.`);
  }

  protected async saveDraft(): Promise<void> {
    const provider = this.draft.provider.trim();
    const model = this.draft.model.trim();
    if (!provider || !model) {
      await this.messages.warn('Provider and model are required to save an AI profile.');
      return;
    }

    const id = this.draft.id.trim() || this.uniqueProfileId(provider);
    const profile: StoredAiProfile = {
      id,
      label: this.draft.label.trim() || undefined,
      provider,
      model,
      transportKind: this.draft.transportKind.trim() || 'api',
      transportId: this.draft.transportId.trim() || undefined,
      profileId: this.draft.profileId.trim() || undefined,
      endpointUrl: this.draft.endpointUrl.trim() || undefined,
      allowedModels: this.parseAllowedModels(this.draft.allowedModels),
      enabled: this.draft.enabled
    };

    await this.aiProfilePreferences.upsertProfile(profile);
    const apiKey = this.draft.apiKey.trim();
    if (apiKey) {
      await this.aiProfilePreferences.setApiKey(id, apiKey);
    }
    this.selectedId = id;
    await this.refresh();
    await this.messages.info(`AI profile "${profile.label || id}" saved.`);
  }

  protected parseAllowedModels(value: string): string[] | undefined {
    const models = value.split(',').map(model => model.trim()).filter(model => model.length > 0);
    return models.length > 0 ? models : undefined;
  }

  protected uniqueProfileId(base: string): string {
    const existing = new Set(this.descriptors.map(descriptor => descriptor.id));
    const slug = base.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'profile';
    if (!existing.has(slug)) {
      return slug;
    }
    let counter = 2;
    while (existing.has(`${slug}-${counter}`)) {
      counter += 1;
    }
    return `${slug}-${counter}`;
  }

  protected renderProviderInput(): React.ReactNode {
    const provider = this.draft.provider.trim();
    const catalogEntry = this.providerCatalog.find(entry => entry.providerId === provider);
    const isCustom = provider.length > 0 && !catalogEntry;
    const selectValue = isCustom ? CUSTOM_PROVIDER_OPTION : provider;

    const children: React.ReactNode[] = [
      React.createElement('span', { key: 'label' }, 'Provider'),
      React.createElement(
        'select',
        {
          key: 'select',
          value: selectValue,
          onChange: (event: React.ChangeEvent<HTMLSelectElement>) => this.onProviderSelected(event.currentTarget.value)
        },
        React.createElement('option', { key: '', value: '' }, 'select provider'),
        ...this.providerCatalog.map(entry =>
          React.createElement('option', { key: entry.providerId, value: entry.providerId }, `${entry.label} (${entry.providerId})`)
        ),
        React.createElement('option', { key: CUSTOM_PROVIDER_OPTION, value: CUSTOM_PROVIDER_OPTION }, 'custom provider...')
      )
    ];
    if (isCustom || selectValue === CUSTOM_PROVIDER_OPTION) {
      children.push(React.createElement('input', {
        key: 'custom',
        value: provider,
        placeholder: 'custom provider id, e.g. my-agent',
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => this.updateDraft('provider', event.currentTarget.value)
      }));
    }

    return React.createElement('label', { className: 'afe-model-config-field' }, ...children);
  }

  protected renderModelInput(): React.ReactNode {
    return React.createElement(
      'label',
      { className: 'afe-model-config-field' },
      React.createElement('span', undefined, 'Model'),
      React.createElement('input', {
        value: this.draft.model,
        placeholder: 'provider model id',
        list: 'afe-model-config-model-options',
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => this.updateDraft('model', event.currentTarget.value)
      }),
      React.createElement(
        'datalist',
        { id: 'afe-model-config-model-options' },
        ...(this.discovery?.models ?? []).map(model =>
          React.createElement('option', { key: model.modelId, value: model.modelId }, model.name)
        )
      )
    );
  }

  protected renderTransportInput(): React.ReactNode {
    const provider = this.draft.provider.trim();
    const catalogEntry = this.providerCatalog.find(entry => entry.providerId === provider);
    if (!catalogEntry) {
      return this.renderSelectInput('Transport', 'transportKind', GENERIC_TRANSPORT_KINDS);
    }

    const selectedTransportId = this.draft.transportId.trim();
    return React.createElement(
      'label',
      { className: 'afe-model-config-field' },
      React.createElement('span', undefined, 'Transport'),
      React.createElement(
        'select',
        {
          value: selectedTransportId,
          onChange: (event: React.ChangeEvent<HTMLSelectElement>) => this.onTransportSelected(catalogEntry, event.currentTarget.value)
        },
        React.createElement('option', { key: '', value: '' }, `default (${this.draft.transportKind || 'api'})`),
        ...catalogEntry.transports.map(transport =>
          React.createElement(
            'option',
            { key: transport.transportId, value: transport.transportId },
            `${transport.transportLabel} — ${transport.transportKind}`
          )
        )
      )
    );
  }

  protected renderDiscoveryResults(): React.ReactNode {
    const discovery = this.discovery;
    if (!discovery) {
      return undefined;
    }

    if (discovery.models.length === 0) {
      return React.createElement(
        'div',
        { className: 'afe-model-config-discovery' },
        React.createElement('h4', undefined, 'Discovered Models'),
        React.createElement('p', undefined, discovery.detail || 'No models reported by the endpoint.')
      );
    }

    return React.createElement(
      'div',
      { className: 'afe-model-config-discovery' },
      React.createElement('h4', undefined, `Discovered Models (${discovery.models.length})`),
      discovery.detail
        ? React.createElement('p', { className: 'afe-model-config-discovery-detail' }, discovery.detail)
        : undefined,
      React.createElement(
        'ul',
        { className: 'afe-model-config-discovery-list' },
        ...discovery.models.map(model => React.createElement(
          'li',
          { key: model.modelId },
          React.createElement(
            'button',
            {
              className: 'theia-button secondary',
              type: 'button',
              title: model.description || `Use ${model.modelId}`,
              onClick: () => this.updateDraft('model', model.modelId)
            },
            model.contextLength
              ? `${model.modelId} · ${Math.round(model.contextLength / 1024)}k ctx`
              : model.modelId
          ),
          React.createElement(
            'button',
            {
              className: 'theia-button secondary',
              type: 'button',
              title: 'Add to the allowed models shortlist',
              onClick: () => this.addAllowedModel(model.modelId)
            },
            '+allow'
          )
        ))
      )
    );
  }

  protected addAllowedModel(modelId: string): void {
    const current = this.parseAllowedModels(this.draft.allowedModels) ?? [];
    if (!current.includes(modelId)) {
      current.push(modelId);
    }
    this.updateDraft('allowedModels', current.join(', '));
  }

  protected onProviderSelected(value: string): void {
    if (value === CUSTOM_PROVIDER_OPTION) {
      this.draft = { ...this.draft, provider: '', transportId: '' };
      this.update();
      return;
    }

    const catalogEntry = this.providerCatalog.find(entry => entry.providerId === value);
    const defaultTransport = catalogEntry?.transports.find(transport => transport.transportKind === 'api')
      ?? catalogEntry?.transports[0];
    this.draft = {
      ...this.draft,
      provider: value,
      transportId: '',
      transportKind: defaultTransport?.transportKind ?? this.draft.transportKind,
      model: this.draft.model || defaultTransport?.defaultModel || ''
    };
    this.discovery = undefined;
    this.update();
  }

  protected onTransportSelected(catalogEntry: AiProviderCatalogEntry, transportId: string): void {
    const transport = catalogEntry.transports.find(entry => entry.transportId === transportId);
    this.draft = {
      ...this.draft,
      transportId,
      transportKind: transport?.transportKind ?? this.draft.transportKind,
      model: this.draft.model || transport?.defaultModel || ''
    };
    this.update();
  }

  protected applyLocalProxyDefaults(): void {
    const provider = this.draft.provider.trim() || 'openai';
    const defaults = getLocalProxyEndpointDefaults(provider);
    this.draft = {
      ...this.draft,
      provider,
      transportKind: 'api',
      transportId: '',
      endpointUrl: defaults.url,
      model: defaults.model
    };
    this.update();
  }

  protected async discoverModels(): Promise<void> {
    const profile = await this.buildDiscoveryProfile();
    this.discovering = true;
    this.discovery = undefined;
    this.update();
    try {
      this.discovery = await this.aiConnection.discoverModels(profile);
      if (!this.discovery.ok && this.discovery.models.length === 0) {
        await this.messages.warn(`Model discovery failed: ${this.discovery.detail || 'endpoint did not report models'}`);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.discovery = { ok: false, models: [], detail };
      await this.messages.error(`Model discovery failed: ${detail}`);
    } finally {
      this.discovering = false;
      this.update();
    }
  }

  protected async buildDiscoveryProfile(): Promise<AiConnectionProfile> {
    const chain = await this.aiProfilePreferences.getFailoverChain();
    const saved = chain.find(profile => profile.id === (this.draft.profileId.trim() || this.draft.id.trim()))
      ?? chain[0];
    const apiKey = this.draft.apiKey.trim() || saved?.secretValue || '';
    return {
      id: this.draft.profileId.trim() || this.draft.id.trim() || undefined,
      provider: this.draft.provider.trim(),
      model: this.draft.model.trim() || undefined,
      transportKind: (this.draft.transportKind.trim() || 'api') as AiConnectionProfile['transportKind'],
      transportId: this.draft.transportId.trim() || undefined,
      endpointUrl: this.draft.endpointUrl.trim() || undefined,
      secretValue: apiKey || undefined
    };
  }

  protected renderTextInput(label: string, field: keyof AiProfileDraft, placeholder: string): React.ReactNode {
    return React.createElement(
      'label',
      { className: 'afe-model-config-field' },
      React.createElement('span', undefined, label),
      React.createElement('input', {
        value: String(this.draft[field] ?? ''),
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
          value: String(this.draft[field] ?? ''),
          onChange: (event: React.ChangeEvent<HTMLSelectElement>) => this.updateDraft(field, event.currentTarget.value)
        },
        ...options.map(option => React.createElement('option', { key: option, value: option }, option))
      )
    );
  }

  protected renderSecretInput(): React.ReactNode {
    const descriptor = this.descriptors.find(candidate => candidate.id === this.draft.id);
    const hasApiKey = descriptor?.hasApiKey ?? false;
    const apiTransport = (this.draft.transportKind || 'api') === 'api' || this.draft.transportKind === 'proxy';
    return React.createElement(
      'label',
      { className: 'afe-model-config-field' },
      React.createElement('span', undefined, hasApiKey ? 'API Key (configured)' : 'API Key'),
      React.createElement('input', {
        type: 'password',
        value: this.draft.apiKey,
        placeholder: hasApiKey
          ? 'leave blank to keep current key'
          : apiTransport ? 'required for api transport' : 'not needed for this transport',
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => this.updateDraft('apiKey', event.currentTarget.value)
      })
    );
  }

  protected updateDraft(field: keyof AiProfileDraft, value: string | boolean): void {
    this.draft = {
      ...this.draft,
      [field]: value
    };
    this.update();
  }

  protected createEmptyDraft(): AiProfileDraft {
    return {
      id: '',
      label: '',
      provider: '',
      model: '',
      transportKind: 'api',
      transportId: '',
      profileId: '',
      endpointUrl: '',
      apiKey: '',
      allowedModels: '',
      enabled: true
    };
  }
}
