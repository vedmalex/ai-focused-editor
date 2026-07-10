import {
  CommandService,
  Disposable,
  DisposableCollection,
  MessageService
} from '@theia/core/lib/common';
import URI from '@theia/core/lib/common/uri';
import { PreferenceService } from '@theia/core/lib/common/preferences';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { FileDialogService } from '@theia/filesystem/lib/browser';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import {
  inject,
  injectable,
  postConstruct
} from '@theia/core/shared/inversify';
import React from '@theia/core/shared/react';
import type {
  AiAliasDescriptor,
  AiConnectionProfile,
  AiEndpointDescriptor,
  AiModelDiscoveryResult,
  AiProfileDescriptor,
  StoredAiAlias,
  StoredAiEndpoint,
  StoredAiProfile,
  V1AliasesFile,
  V1EndpointsFile
} from '../common';
import { AiConnectionService, parseV1Import } from '../common';
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
  AI_FOCUSED_EDITOR_AI_ACTIVE_ALIAS,
  AI_FOCUSED_EDITOR_AI_ACTIVE_PROFILE,
  AI_FOCUSED_EDITOR_AI_ALIASES,
  AI_FOCUSED_EDITOR_AI_API_KEY,
  AI_FOCUSED_EDITOR_AI_API_KEYS,
  AI_FOCUSED_EDITOR_AI_ENDPOINT_URL,
  AI_FOCUSED_EDITOR_AI_ENDPOINTS,
  AI_FOCUSED_EDITOR_AI_MODEL,
  AI_FOCUSED_EDITOR_AI_PINNED_ENDPOINT,
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
  AI_FOCUSED_EDITOR_AI_API_KEYS,
  AI_FOCUSED_EDITOR_AI_ENDPOINTS,
  AI_FOCUSED_EDITOR_AI_ALIASES,
  AI_FOCUSED_EDITOR_AI_ACTIVE_ALIAS,
  AI_FOCUSED_EDITOR_AI_PINNED_ENDPOINT
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

interface AiEndpointDraft {
  id: string;
  /** Original id when editing an existing endpoint ('' for a new one). */
  originalId: string;
  label: string;
  provider: string;
  transportKind: string;
  transportId: string;
  endpointUrl: string;
  command: string;
  timeWindows: string;
  apiKey: string;
  verifyModel: string;
  enabled: boolean;
}

interface AliasLegDraft {
  endpointId: string;
  model: string;
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

  @inject(FileDialogService)
  protected readonly fileDialogService!: FileDialogService;

  @inject(FileService)
  protected readonly fileService!: FileService;

  protected readonly providerCatalog: AiProviderCatalogEntry[] = getAiProviderCatalog();
  protected status: AiProfileStatus | undefined;
  protected descriptors: AiProfileDescriptor[] = [];
  protected selectedId: string | undefined;
  protected draft: AiProfileDraft = this.createEmptyDraft();
  protected discovering = false;
  protected discovery: AiModelDiscoveryResult | undefined;
  // Endpoints + aliases (two-level connection model).
  protected endpoints: AiEndpointDescriptor[] = [];
  protected aliases: AiAliasDescriptor[] = [];
  protected endpointDraft: AiEndpointDraft = this.createEmptyEndpointDraft();
  protected selectedEndpointId: string | undefined;
  protected verifyingEndpoint = false;
  protected newAliasId = '';
  protected legDrafts: Record<string, AliasLegDraft> = {};
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
    this.endpoints = await this.aiProfilePreferences.listEndpoints();
    this.aliases = await this.aiProfilePreferences.listAliases();
    const stored = this.aiProfilePreferences.getStoredProfileList();
    const selected = stored.find(profile => profile.id === this.selectedId)
      ?? stored.find(profile => this.descriptors.find(d => d.active)?.id === profile.id)
      ?? stored[0];
    this.selectedId = selected?.id;
    this.draft = selected ? this.toDraft(selected) : this.createEmptyDraft();

    // Keep an in-progress "new endpoint" draft; only rebuild when a selected
    // endpoint still exists (or vanished from under us).
    if (this.selectedEndpointId) {
      const storedEndpoint = this.aiProfilePreferences.readEndpoints().find(endpoint => endpoint.id === this.selectedEndpointId);
      if (storedEndpoint) {
        this.endpointDraft = this.toEndpointDraft(storedEndpoint);
      } else {
        this.selectedEndpointId = undefined;
        this.endpointDraft = this.createEmptyEndpointDraft();
      }
    }
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
      return React.createElement('div', { className: 'afe-model-config' }, 'Loading AI connection...');
    }

    return React.createElement(
      'div',
      { className: 'afe-model-config' },
      React.createElement('h3', undefined, 'AI Connections'),
      this.renderTopStatus(status),
      this.renderEndpointsSection(),
      this.renderAliasesSection(),
      this.renderImportSection(),
      this.renderLegacyProfilesSection(status)
    );
  }

  protected renderTopStatus(status: AiProfileStatus): React.ReactNode {
    const summary = status.summary;
    let message: string;
    if (!status.configured) {
      message = `Active connection incomplete: ${status.missing.join(', ')}`;
    } else if (summary.aliasMode) {
      const endpoint = summary.activeEndpointLabel || summary.activeEndpoint;
      const pin = summary.pinnedEndpoint ? `, pinned: ${summary.pinnedEndpoint}` : '';
      message = `Alias "${summary.activeAliasLabel}" → ${endpoint} ready (${summary.chainLength} endpoint(s) available${pin}).`;
    } else {
      message = `Active profile ready (${summary.chainLength} profile(s) in the failover chain).`;
    }
    return React.createElement(
      'div',
      { className: status.configured ? 'afe-model-config-status ok' : 'afe-model-config-status missing' },
      message
    );
  }

  protected renderLegacyProfilesSection(status: AiProfileStatus): React.ReactNode {
    return React.createElement(
      'div',
      { className: 'afe-model-config-section afe-model-config-legacy' },
      React.createElement('h3', undefined, 'Legacy AI Profiles'),
      React.createElement(
        'p',
        { className: 'afe-model-config-help' },
        'Aliases (above) supersede these single profiles: whenever at least one alias exists, resolution runs through the active alias chain. Profiles remain as a fallback when no alias is defined.'
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

  // ===========================================================================
  // Endpoints (channels)
  // ===========================================================================

  protected renderEndpointsSection(): React.ReactNode {
    return React.createElement(
      'div',
      { className: 'afe-model-config-section' },
      React.createElement('h3', undefined, 'Endpoints'),
      React.createElement(
        'p',
        { className: 'afe-model-config-help' },
        'Endpoints are channels (where/how to reach a provider). Combine them into aliases below. API keys are stored per endpoint in user settings; availability windows gate when an endpoint is used.'
      ),
      React.createElement(
        'ul',
        { className: 'afe-model-config-profiles afe-endpoint-list' },
        ...this.endpoints.map((endpoint, index) => this.renderEndpointRow(endpoint, index)),
        React.createElement(
          'li',
          { key: '__new_endpoint__' },
          React.createElement('button', {
            className: 'theia-button secondary',
            type: 'button',
            onClick: () => this.newEndpoint()
          }, '+ New Endpoint')
        )
      ),
      this.renderEndpointForm()
    );
  }

  protected renderEndpointRow(endpoint: AiEndpointDescriptor, index: number): React.ReactNode {
    const badge = endpoint.availableNow ? '● now' : '○ off-window';
    const badgeTitle = endpoint.availableNow
      ? 'Available now'
      : (endpoint.enabled ? 'Outside its availability window right now' : 'Disabled');
    const notes: string[] = [];
    if (!endpoint.enabled) {
      notes.push('disabled');
    }
    if (!endpoint.hasApiKey && (endpoint.transportKind === 'api' || endpoint.transportKind === 'proxy')) {
      notes.push('no key');
    }
    if (endpoint.windowWarning) {
      notes.push('bad window');
    }
    return React.createElement(
      'li',
      { key: endpoint.id, className: endpoint.id === this.selectedEndpointId ? 'selected' : undefined },
      React.createElement(
        'span',
        { className: `afe-endpoint-badge ${endpoint.availableNow ? 'ok' : 'off'}`, title: badgeTitle },
        badge
      ),
      React.createElement(
        'button',
        {
          className: 'afe-model-config-profile-name',
          type: 'button',
          title: 'Edit this endpoint',
          onClick: () => this.selectEndpoint(endpoint.id)
        },
        `${endpoint.label} — ${endpoint.provider || '?'} / ${endpoint.transportKind}${notes.length > 0 ? ` [${notes.join(', ')}]` : ''}`
      ),
      React.createElement('button', {
        className: 'theia-button secondary',
        type: 'button',
        disabled: index === 0,
        title: 'Move up',
        onClick: () => { void this.moveEndpoint(endpoint.id, -1); }
      }, '↑'),
      React.createElement('button', {
        className: 'theia-button secondary',
        type: 'button',
        disabled: index === this.endpoints.length - 1,
        title: 'Move down',
        onClick: () => { void this.moveEndpoint(endpoint.id, 1); }
      }, '↓'),
      React.createElement('button', {
        className: 'theia-button secondary',
        type: 'button',
        title: 'Delete endpoint',
        onClick: () => { void this.deleteEndpoint(endpoint.id); }
      }, '✕')
    );
  }

  protected renderEndpointForm(): React.ReactNode {
    const editing = Boolean(this.endpointDraft.originalId);
    return React.createElement(
      'form',
      {
        className: 'afe-model-config-form',
        onSubmit: (event: React.FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          void this.saveEndpointDraft();
        }
      },
      React.createElement('h4', undefined, editing ? `Edit Endpoint: ${this.endpointDraft.label || this.endpointDraft.originalId}` : 'New Endpoint'),
      this.renderEndpointTextInput('Endpoint ID', 'id', 'unique id, e.g. gateway-claude', editing),
      this.renderEndpointTextInput('Label', 'label', 'display name'),
      this.renderEndpointProviderInput(),
      this.renderEndpointTransportInput(),
      this.renderEndpointTextInput('Endpoint URL', 'endpointUrl', 'optional endpoint URL'),
      this.renderEndpointTextInput('Command', 'command', 'optional command (acp/cli transports)'),
      this.renderEndpointTextInput('Availability Windows', 'timeWindows', 'e.g. 1-5 09:00-18:00, 6,7 10:00-14:00 (blank = always)'),
      this.renderEndpointSecretInput(),
      this.renderEndpointCheckbox(),
      this.renderEndpointTextInput('Verify Model', 'verifyModel', 'model id to test-connect with'),
      React.createElement(
        'div',
        { className: 'afe-model-config-actions' },
        React.createElement('button', { className: 'theia-button main', type: 'submit' }, 'Save Endpoint'),
        React.createElement(
          'button',
          {
            className: 'theia-button',
            type: 'button',
            disabled: this.verifyingEndpoint || !this.endpointDraft.provider.trim() || !this.endpointDraft.verifyModel.trim(),
            title: 'Test-connect this endpoint with the verify model, without saving or activating',
            onClick: () => { void this.verifyEndpointDraft(); }
          },
          this.verifyingEndpoint ? 'Verifying...' : 'Verify'
        ),
        React.createElement(
          'button',
          {
            className: 'theia-button',
            type: 'button',
            title: 'Fill endpoint URL for a local ai-connect proxy on 127.0.0.1:8045',
            onClick: () => this.applyEndpointLocalProxyDefaults()
          },
          'Use Local Proxy'
        )
      )
    );
  }

  protected renderEndpointProviderInput(): React.ReactNode {
    const provider = this.endpointDraft.provider.trim();
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
          onChange: (event: React.ChangeEvent<HTMLSelectElement>) => this.onEndpointProviderSelected(event.currentTarget.value)
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
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => this.updateEndpointDraft('provider', event.currentTarget.value)
      }));
    }
    return React.createElement('label', { className: 'afe-model-config-field' }, ...children);
  }

  protected onEndpointProviderSelected(value: string): void {
    if (value === CUSTOM_PROVIDER_OPTION) {
      this.endpointDraft = { ...this.endpointDraft, provider: '', transportId: '' };
      this.update();
      return;
    }
    const catalogEntry = this.providerCatalog.find(entry => entry.providerId === value);
    const defaultTransport = catalogEntry?.transports.find(transport => transport.transportKind === 'api')
      ?? catalogEntry?.transports[0];
    this.endpointDraft = {
      ...this.endpointDraft,
      provider: value,
      transportId: '',
      transportKind: defaultTransport?.transportKind ?? this.endpointDraft.transportKind,
      verifyModel: this.endpointDraft.verifyModel || defaultTransport?.defaultModel || ''
    };
    this.update();
  }

  protected renderEndpointTransportInput(): React.ReactNode {
    const provider = this.endpointDraft.provider.trim();
    const catalogEntry = this.providerCatalog.find(entry => entry.providerId === provider);
    if (!catalogEntry) {
      return React.createElement(
        'label',
        { className: 'afe-model-config-field' },
        React.createElement('span', undefined, 'Transport'),
        React.createElement(
          'select',
          {
            value: this.endpointDraft.transportKind || 'api',
            onChange: (event: React.ChangeEvent<HTMLSelectElement>) => this.updateEndpointDraft('transportKind', event.currentTarget.value)
          },
          ...GENERIC_TRANSPORT_KINDS.map(option => React.createElement('option', { key: option, value: option }, option))
        )
      );
    }
    return React.createElement(
      'label',
      { className: 'afe-model-config-field' },
      React.createElement('span', undefined, 'Transport'),
      React.createElement(
        'select',
        {
          value: this.endpointDraft.transportId.trim(),
          onChange: (event: React.ChangeEvent<HTMLSelectElement>) => this.onEndpointTransportSelected(catalogEntry, event.currentTarget.value)
        },
        React.createElement('option', { key: '', value: '' }, `default (${this.endpointDraft.transportKind || 'api'})`),
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

  protected onEndpointTransportSelected(catalogEntry: AiProviderCatalogEntry, transportId: string): void {
    const transport = catalogEntry.transports.find(entry => entry.transportId === transportId);
    this.endpointDraft = {
      ...this.endpointDraft,
      transportId,
      transportKind: transport?.transportKind ?? this.endpointDraft.transportKind,
      verifyModel: this.endpointDraft.verifyModel || transport?.defaultModel || ''
    };
    this.update();
  }

  protected renderEndpointTextInput(label: string, field: keyof AiEndpointDraft, placeholder: string, disabled = false): React.ReactNode {
    return React.createElement(
      'label',
      { className: 'afe-model-config-field' },
      React.createElement('span', undefined, label),
      React.createElement('input', {
        value: String(this.endpointDraft[field] ?? ''),
        placeholder,
        disabled,
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => this.updateEndpointDraft(field, event.currentTarget.value)
      })
    );
  }

  protected renderEndpointSecretInput(): React.ReactNode {
    const descriptor = this.endpoints.find(candidate => candidate.id === this.endpointDraft.originalId);
    const hasApiKey = descriptor?.hasApiKey ?? false;
    const apiTransport = (this.endpointDraft.transportKind || 'api') === 'api' || this.endpointDraft.transportKind === 'proxy';
    return React.createElement(
      'label',
      { className: 'afe-model-config-field' },
      React.createElement('span', undefined, hasApiKey ? 'API Key (configured)' : 'API Key'),
      React.createElement('input', {
        type: 'password',
        value: this.endpointDraft.apiKey,
        placeholder: hasApiKey
          ? 'leave blank to keep current key'
          : apiTransport ? 'required for api transport' : 'not needed for this transport',
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => this.updateEndpointDraft('apiKey', event.currentTarget.value)
      })
    );
  }

  protected renderEndpointCheckbox(): React.ReactNode {
    return React.createElement(
      'label',
      { className: 'afe-model-config-field afe-model-config-checkbox' },
      React.createElement('input', {
        type: 'checkbox',
        checked: this.endpointDraft.enabled,
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => this.updateEndpointDraft('enabled', event.currentTarget.checked)
      }),
      React.createElement('span', undefined, 'Enabled')
    );
  }

  protected updateEndpointDraft(field: keyof AiEndpointDraft, value: string | boolean): void {
    this.endpointDraft = { ...this.endpointDraft, [field]: value };
    this.update();
  }

  protected applyEndpointLocalProxyDefaults(): void {
    const provider = this.endpointDraft.provider.trim() || 'openai';
    const defaults = getLocalProxyEndpointDefaults(provider);
    this.endpointDraft = {
      ...this.endpointDraft,
      provider,
      transportKind: 'api',
      transportId: '',
      endpointUrl: defaults.url,
      verifyModel: this.endpointDraft.verifyModel || defaults.model
    };
    this.update();
  }

  protected newEndpoint(): void {
    this.selectedEndpointId = undefined;
    this.endpointDraft = this.createEmptyEndpointDraft();
    this.update();
  }

  protected selectEndpoint(id: string): void {
    const stored = this.aiProfilePreferences.readEndpoints().find(endpoint => endpoint.id === id);
    if (!stored) {
      return;
    }
    this.selectedEndpointId = id;
    this.endpointDraft = this.toEndpointDraft(stored);
    this.update();
  }

  protected async saveEndpointDraft(): Promise<void> {
    const provider = this.endpointDraft.provider.trim();
    if (!provider) {
      await this.messages.warn('A provider is required to save an endpoint.');
      return;
    }
    const isNew = !this.endpointDraft.originalId;
    const id = this.endpointDraft.id.trim() || this.uniqueEndpointId(provider);
    const endpoint = this.endpointDraftToStored(id);

    await this.aiProfilePreferences.upsertEndpoint(endpoint);
    const apiKey = this.endpointDraft.apiKey.trim();
    if (apiKey) {
      await this.aiProfilePreferences.setApiKey(id, apiKey);
    }
    this.selectedEndpointId = id;
    await this.refresh();
    await this.messages.info(`Endpoint "${endpoint.label || id}" saved.`);

    // Verify-on-configure: after saving a NEW endpoint, auto-run a non-blocking
    // verify ping (result surfaces as a notification).
    if (isNew && this.endpointDraft.verifyModel.trim()) {
      void this.verifyEndpoint(endpoint, this.endpointDraft.verifyModel.trim(), apiKey, true);
    }
  }

  protected async deleteEndpoint(id: string): Promise<void> {
    await this.aiProfilePreferences.deleteEndpoint(id);
    if (this.selectedEndpointId === id) {
      this.selectedEndpointId = undefined;
      this.endpointDraft = this.createEmptyEndpointDraft();
    }
    await this.refresh();
    await this.messages.info(`Endpoint "${id}" deleted.`);
  }

  protected async moveEndpoint(id: string, delta: -1 | 1): Promise<void> {
    await this.aiProfilePreferences.moveEndpoint(id, delta);
    await this.refresh();
  }

  protected async verifyEndpointDraft(): Promise<void> {
    const provider = this.endpointDraft.provider.trim();
    const model = this.endpointDraft.verifyModel.trim();
    if (!provider || !model) {
      await this.messages.warn('Provider and a verify model are required to verify an endpoint.');
      return;
    }
    const endpoint = this.endpointDraftToStored(this.endpointDraft.id.trim() || provider);
    await this.verifyEndpoint(endpoint, model, this.endpointDraft.apiKey.trim(), false);
  }

  /** Test-connect an endpoint + model without saving/activating. */
  protected async verifyEndpoint(endpoint: StoredAiEndpoint, model: string, overrideSecret: string, background: boolean): Promise<void> {
    const profile = this.aiProfilePreferences.buildEndpointProbeProfile(endpoint, model, overrideSecret);
    this.verifyingEndpoint = true;
    this.update();
    const progress = background ? undefined : await this.messages.showProgress({ text: `Verifying endpoint "${endpoint.id}"...` });
    try {
      const result = await this.aiConnection.generate(profile, {
        messages: [
          { role: 'system', content: 'Reply with exactly: OK' },
          { role: 'user', content: 'Verify this AI connection.' }
        ],
        parameters: { maxTokens: 8, temperature: 0 },
        logContext: { command: 'ai-focused-editor.ai.verifyEndpoint', endpointId: endpoint.id }
      });
      await this.messages.info(`Endpoint "${endpoint.id}" verified via ${result.route?.provider ?? profile.provider}/${result.route?.model ?? model}: ${this.previewText(result.text)}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.messages.error(`Endpoint "${endpoint.id}" verification failed: ${detail}`);
    } finally {
      progress?.cancel();
      this.verifyingEndpoint = false;
      this.update();
    }
  }

  protected previewText(text: string): string {
    const singleLine = text.replace(/\s+/g, ' ').trim();
    return singleLine.length <= 200 ? singleLine : `${singleLine.slice(0, 199)}...`;
  }

  protected endpointDraftToStored(id: string): StoredAiEndpoint {
    const timeWindows = this.parseTimeWindowsInput(this.endpointDraft.timeWindows);
    return {
      id,
      label: this.endpointDraft.label.trim() || undefined,
      provider: this.endpointDraft.provider.trim(),
      transportKind: this.endpointDraft.transportKind.trim() || 'api',
      transportId: this.endpointDraft.transportId.trim() || undefined,
      endpointUrl: this.endpointDraft.endpointUrl.trim() || undefined,
      command: this.endpointDraft.command.trim() || undefined,
      timeWindows: timeWindows.length > 0 ? timeWindows : undefined,
      enabled: this.endpointDraft.enabled ? undefined : false
    };
  }

  protected parseTimeWindowsInput(value: string): string[] {
    return value
      .split(/[\n,]/)
      .map(entry => entry.trim())
      .filter(entry => entry.length > 0);
  }

  protected toEndpointDraft(endpoint: StoredAiEndpoint): AiEndpointDraft {
    return {
      id: endpoint.id,
      originalId: endpoint.id,
      label: endpoint.label ?? '',
      provider: endpoint.provider ?? '',
      transportKind: endpoint.transportKind || 'api',
      transportId: endpoint.transportId ?? '',
      endpointUrl: endpoint.endpointUrl ?? '',
      command: endpoint.command ?? '',
      timeWindows: (endpoint.timeWindows ?? []).join(', '),
      apiKey: '',
      verifyModel: this.endpointDraft.originalId === endpoint.id ? this.endpointDraft.verifyModel : '',
      enabled: endpoint.enabled !== false
    };
  }

  protected uniqueEndpointId(base: string): string {
    const existing = new Set(this.endpoints.map(endpoint => endpoint.id));
    const slug = base.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'endpoint';
    if (!existing.has(slug)) {
      return slug;
    }
    let counter = 2;
    while (existing.has(`${slug}-${counter}`)) {
      counter += 1;
    }
    return `${slug}-${counter}`;
  }

  protected createEmptyEndpointDraft(): AiEndpointDraft {
    return {
      id: '',
      originalId: '',
      label: '',
      provider: '',
      transportKind: 'api',
      transportId: '',
      endpointUrl: '',
      command: '',
      timeWindows: '',
      apiKey: '',
      verifyModel: '',
      enabled: true
    };
  }

  // ===========================================================================
  // Aliases (chains)
  // ===========================================================================

  protected renderAliasesSection(): React.ReactNode {
    return React.createElement(
      'div',
      { className: 'afe-model-config-section' },
      React.createElement('h3', undefined, 'Aliases'),
      React.createElement(
        'p',
        { className: 'afe-model-config-help' },
        'Aliases are ordered chains of endpoint → model legs tried in failover order. The active alias (radio) is the default; endpoints that are disabled or outside their availability window are skipped.'
      ),
      React.createElement(
        'ul',
        { className: 'afe-alias-list' },
        ...this.aliases.map((alias, index) => this.renderAliasRow(alias, index))
      ),
      React.createElement(
        'div',
        { className: 'afe-model-config-actions' },
        React.createElement('input', {
          value: this.newAliasId,
          placeholder: 'new alias id, e.g. fable',
          onChange: (event: React.ChangeEvent<HTMLInputElement>) => { this.newAliasId = event.currentTarget.value; this.update(); }
        }),
        React.createElement('button', {
          className: 'theia-button secondary',
          type: 'button',
          onClick: () => { void this.addAlias(); }
        }, '+ Add Alias')
      )
    );
  }

  protected renderAliasRow(alias: AiAliasDescriptor, index: number): React.ReactNode {
    return React.createElement(
      'li',
      { key: alias.id, className: 'afe-alias-row' },
      React.createElement(
        'div',
        { className: 'afe-alias-header' },
        React.createElement('input', {
          type: 'radio',
          name: 'afe-active-alias',
          checked: alias.active,
          title: 'Set as active alias',
          onChange: () => { void this.setActiveAlias(alias.id); }
        }),
        React.createElement('span', { className: 'afe-alias-name' },
          `${alias.label} (${alias.availableLegs}/${alias.chain.length} available now)${alias.enabled ? '' : ' [disabled]'}`),
        React.createElement('button', {
          className: 'theia-button secondary',
          type: 'button',
          disabled: index === 0,
          title: 'Move alias up',
          onClick: () => { void this.moveAlias(alias.id, -1); }
        }, '↑'),
        React.createElement('button', {
          className: 'theia-button secondary',
          type: 'button',
          disabled: index === this.aliases.length - 1,
          title: 'Move alias down',
          onClick: () => { void this.moveAlias(alias.id, 1); }
        }, '↓'),
        React.createElement('button', {
          className: 'theia-button secondary',
          type: 'button',
          title: 'Delete alias',
          onClick: () => { void this.deleteAlias(alias.id); }
        }, '✕')
      ),
      React.createElement(
        'ul',
        { className: 'afe-alias-legs' },
        ...alias.chain.map((leg, legIndex) => React.createElement(
          'li',
          { key: `${leg.endpointId}-${legIndex}`, className: 'afe-alias-leg' },
          React.createElement('span', { className: 'afe-alias-leg-text' }, `${leg.endpointId} → ${leg.model || '(no model)'}`),
          React.createElement('button', {
            className: 'theia-button secondary',
            type: 'button',
            disabled: legIndex === 0,
            title: 'Move leg up',
            onClick: () => { void this.moveAliasLeg(alias.id, legIndex, -1); }
          }, '↑'),
          React.createElement('button', {
            className: 'theia-button secondary',
            type: 'button',
            disabled: legIndex === alias.chain.length - 1,
            title: 'Move leg down',
            onClick: () => { void this.moveAliasLeg(alias.id, legIndex, 1); }
          }, '↓'),
          React.createElement('button', {
            className: 'theia-button secondary',
            type: 'button',
            title: 'Remove leg',
            onClick: () => { void this.removeAliasLeg(alias.id, legIndex); }
          }, '✕')
        )),
        this.renderAddLegControls(alias)
      )
    );
  }

  protected renderAddLegControls(alias: AiAliasDescriptor): React.ReactNode {
    const draft = this.legDrafts[alias.id] ?? { endpointId: '', model: '' };
    return React.createElement(
      'li',
      { key: '__add_leg__', className: 'afe-alias-add-leg' },
      React.createElement(
        'select',
        {
          value: draft.endpointId,
          onChange: (event: React.ChangeEvent<HTMLSelectElement>) => this.updateLegDraft(alias.id, 'endpointId', event.currentTarget.value)
        },
        React.createElement('option', { key: '', value: '' }, 'select endpoint'),
        ...this.endpoints.map(endpoint =>
          React.createElement('option', { key: endpoint.id, value: endpoint.id }, `${endpoint.label} (${endpoint.id})`)
        )
      ),
      React.createElement('input', {
        value: draft.model,
        placeholder: 'model id',
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => this.updateLegDraft(alias.id, 'model', event.currentTarget.value)
      }),
      React.createElement('button', {
        className: 'theia-button secondary',
        type: 'button',
        onClick: () => { void this.addAliasLeg(alias.id); }
      }, '+ leg')
    );
  }

  protected updateLegDraft(aliasId: string, field: keyof AliasLegDraft, value: string): void {
    const current = this.legDrafts[aliasId] ?? { endpointId: '', model: '' };
    this.legDrafts = { ...this.legDrafts, [aliasId]: { ...current, [field]: value } };
    this.update();
  }

  protected async addAlias(): Promise<void> {
    const id = this.uniqueAliasId(this.newAliasId.trim() || 'alias');
    await this.aiProfilePreferences.upsertAlias({ id, label: this.newAliasId.trim() || undefined, chain: [] });
    this.newAliasId = '';
    await this.refresh();
    await this.messages.info(`Alias "${id}" added.`);
  }

  protected async deleteAlias(id: string): Promise<void> {
    await this.aiProfilePreferences.deleteAlias(id);
    await this.refresh();
    await this.messages.info(`Alias "${id}" deleted.`);
  }

  protected async moveAlias(id: string, delta: -1 | 1): Promise<void> {
    await this.aiProfilePreferences.moveAlias(id, delta);
    await this.refresh();
  }

  protected async setActiveAlias(id: string): Promise<void> {
    await this.aiProfilePreferences.setActiveAlias(id);
    await this.refresh();
  }

  protected async addAliasLeg(aliasId: string): Promise<void> {
    const draft = this.legDrafts[aliasId] ?? { endpointId: '', model: '' };
    const endpointId = draft.endpointId.trim();
    const model = draft.model.trim();
    if (!endpointId || !model) {
      await this.messages.warn('Select an endpoint and enter a model id to add a chain leg.');
      return;
    }
    await this.aiProfilePreferences.addAliasLeg(aliasId, { endpointId, model });
    this.legDrafts = { ...this.legDrafts, [aliasId]: { endpointId: '', model: '' } };
    await this.refresh();
  }

  protected async removeAliasLeg(aliasId: string, legIndex: number): Promise<void> {
    await this.aiProfilePreferences.removeAliasLeg(aliasId, legIndex);
    await this.refresh();
  }

  protected async moveAliasLeg(aliasId: string, legIndex: number, delta: -1 | 1): Promise<void> {
    await this.aiProfilePreferences.moveAliasLeg(aliasId, legIndex, delta);
    await this.refresh();
  }

  protected uniqueAliasId(base: string): string {
    const existing = new Set(this.aliases.map(alias => alias.id));
    const slug = base.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'alias';
    if (!existing.has(slug)) {
      return slug;
    }
    let counter = 2;
    while (existing.has(`${slug}-${counter}`)) {
      counter += 1;
    }
    return `${slug}-${counter}`;
  }

  // ===========================================================================
  // ai-editor v1 import
  // ===========================================================================

  protected renderImportSection(): React.ReactNode {
    return React.createElement(
      'div',
      { className: 'afe-model-config-section afe-model-config-import' },
      React.createElement('button', {
        className: 'theia-button secondary',
        type: 'button',
        onClick: () => { void this.importV1Settings(); }
      }, 'Import ai-editor v1 Settings...'),
      React.createElement(
        'span',
        { className: 'afe-model-config-help' },
        'Reads .config/rag-endpoints.json + rag-aliases.json and creates endpoints (keys → user settings) and aliases.'
      )
    );
  }

  protected async importV1Settings(): Promise<void> {
    const selection = await this.fileDialogService.showOpenDialog({
      title: 'Import ai-editor v1 Settings (pick the .config folder or the two JSON files)',
      canSelectFiles: true,
      canSelectFolders: true,
      canSelectMany: true
    });
    if (!selection) {
      return;
    }
    const selected = Array.isArray(selection) ? selection : [selection];
    const located = await this.locateV1Files(selected);
    if (!located.endpointsUri && !located.aliasesUri) {
      await this.messages.warn('Could not find rag-endpoints.json or rag-aliases.json in the selection.');
      return;
    }

    const endpointsFile = await this.readJsonFile<V1EndpointsFile>(located.endpointsUri);
    const aliasesFile = await this.readJsonFile<V1AliasesFile>(located.aliasesUri);
    const result = parseV1Import(endpointsFile, aliasesFile);

    for (const endpoint of result.endpoints) {
      await this.aiProfilePreferences.upsertEndpoint(endpoint);
    }
    for (const id of Object.keys(result.keys)) {
      await this.aiProfilePreferences.setApiKey(id, result.keys[id]);
    }
    for (const alias of result.aliases) {
      await this.aiProfilePreferences.upsertAlias(alias);
    }

    await this.refresh();
    await this.messages.info(
      `Imported ${result.endpoints.length} endpoint(s), ${result.aliases.length} alias(es), ${Object.keys(result.keys).length} key(s) from ai-editor v1.`
    );
  }

  protected async locateV1Files(selected: URI[]): Promise<{ endpointsUri?: URI; aliasesUri?: URI }> {
    let endpointsUri: URI | undefined;
    let aliasesUri: URI | undefined;
    for (const uri of selected) {
      const base = uri.path.base;
      if (base === 'rag-endpoints.json') {
        endpointsUri = endpointsUri ?? uri;
        continue;
      }
      if (base === 'rag-aliases.json') {
        aliasesUri = aliasesUri ?? uri;
        continue;
      }
      // Otherwise treat it as a folder; probe it and its .config subfolder.
      for (const dir of [uri, uri.resolve('.config')]) {
        const endpointCandidate = dir.resolve('rag-endpoints.json');
        const aliasCandidate = dir.resolve('rag-aliases.json');
        if (!endpointsUri && await this.fileService.exists(endpointCandidate)) {
          endpointsUri = endpointCandidate;
        }
        if (!aliasesUri && await this.fileService.exists(aliasCandidate)) {
          aliasesUri = aliasCandidate;
        }
      }
    }
    return { endpointsUri, aliasesUri };
  }

  protected async readJsonFile<T>(uri: URI | undefined): Promise<T | undefined> {
    if (!uri) {
      return undefined;
    }
    try {
      const content = await this.fileService.read(uri);
      return JSON.parse(content.value) as T;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.messages.warn(`Could not read ${uri.path.base}: ${detail}`);
      return undefined;
    }
  }
}
