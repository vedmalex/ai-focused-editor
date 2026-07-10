import {
  Disposable,
  DisposableCollection,
  MessageService
} from '@theia/core/lib/common';
import URI from '@theia/core/lib/common/uri';
import { nls } from '@theia/core/lib/common/nls';
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
  AiEndpointDescriptor,
  AliasCheckVerdict,
  AliasLegVerdict,
  EndpointCheckVerdict,
  StoredAiEndpoint,
  V1AliasesFile,
  V1EndpointsFile
} from '../common';
import { AiConnectionService, parseV1Import } from '../common';
import { AiVerificationService } from './ai-verification-service';
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
  AI_FOCUSED_EDITOR_AI_ALIASES,
  AI_FOCUSED_EDITOR_AI_API_KEYS,
  AI_FOCUSED_EDITOR_AI_ENDPOINTS,
  AI_FOCUSED_EDITOR_AI_PINNED_ENDPOINT
} from './ai-focused-editor-preferences';
const AI_PROFILE_PREFERENCE_KEYS = [
  AI_FOCUSED_EDITOR_AI_API_KEYS,
  AI_FOCUSED_EDITOR_AI_ENDPOINTS,
  AI_FOCUSED_EDITOR_AI_ALIASES,
  AI_FOCUSED_EDITOR_AI_ACTIVE_ALIAS,
  AI_FOCUSED_EDITOR_AI_PINNED_ENDPOINT
];

const CUSTOM_PROVIDER_OPTION = '__custom__';
const GENERIC_TRANSPORT_KINDS = ['api', 'proxy', 'acp', 'cli', 'server'];

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
  allowedModels: string;
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
  static readonly LABEL = nls.localize('ai-focused-editor/ai-config/model-config-label', 'AI Model Config');

  @inject(AiProfilePreferenceService)
  protected readonly aiProfilePreferences!: AiProfilePreferenceService;

  @inject(AiConnectionService)
  protected readonly aiConnection!: AiConnectionService;

  @inject(AiVerificationService)
  protected readonly verification!: AiVerificationService;

  @inject(PreferenceService)
  protected readonly preferenceService!: PreferenceService;

  @inject(MessageService)
  protected readonly messages!: MessageService;

  @inject(FileDialogService)
  protected readonly fileDialogService!: FileDialogService;

  @inject(FileService)
  protected readonly fileService!: FileService;

  protected readonly providerCatalog: AiProviderCatalogEntry[] = getAiProviderCatalog();
  protected status: AiProfileStatus | undefined;
  // Endpoints + aliases (two-level connection model).
  protected endpoints: AiEndpointDescriptor[] = [];
  protected aliases: AiAliasDescriptor[] = [];
  protected endpointDraft: AiEndpointDraft = this.createEmptyEndpointDraft();
  protected selectedEndpointId: string | undefined;
  protected verifyingEndpoint = false;
  // Stage 1: last per-endpoint connection check (reachability + discovered models).
  protected checkingConnection = false;
  protected endpointCheck: EndpointCheckVerdict | undefined;
  protected newAliasId = '';
  protected legDrafts: Record<string, AliasLegDraft> = {};
  // Stage 2: last per-alias check result, keyed by alias id.
  protected aliasChecks: Record<string, AliasCheckVerdict> = {};
  protected checkingAliasId: string | undefined;
  protected readonly refreshDisposables = new DisposableCollection();

  @postConstruct()
  protected init(): void {
    this.id = ModelConfigWidget.ID;
    this.title.label = ModelConfigWidget.LABEL;
    this.title.caption = nls.localize('ai-focused-editor/ai-config/model-config-caption', 'AI Focused Editor model/provider configuration');
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
    this.endpoints = await this.aiProfilePreferences.listEndpoints();
    this.aliases = await this.aiProfilePreferences.listAliases();

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

  protected render(): React.ReactNode {
    const status = this.status;
    if (!status) {
      return React.createElement('div', { className: 'afe-model-config' }, nls.localize('ai-focused-editor/ai-config/loading', 'Loading AI connection...'));
    }

    return React.createElement(
      'div',
      { className: 'afe-model-config' },
      React.createElement('h3', undefined, nls.localize('ai-focused-editor/ai-config/connections-heading', 'AI Connections')),
      this.renderTopStatus(status),
      this.renderEndpointsSection(),
      this.renderAliasesSection(),
      this.renderImportSection()
    );
  }

  protected renderTopStatus(status: AiProfileStatus): React.ReactNode {
    const summary = status.summary;
    let message: string;
    if (status.notConfigured) {
      message = nls.localize('ai-focused-editor/ai-config/status-not-configured', 'No AI connection configured yet — add an endpoint and an alias below.');
    } else if (!status.configured) {
      message = nls.localize('ai-focused-editor/ai-config/status-incomplete', 'Active connection incomplete: {0}', status.missing.join(', '));
    } else {
      const endpoint = summary.activeEndpointLabel || summary.activeEndpoint;
      const pin = summary.pinnedEndpoint
        ? nls.localize('ai-focused-editor/ai-config/status-pin-suffix', ', pinned: {0}', summary.pinnedEndpoint)
        : '';
      message = nls.localize('ai-focused-editor/ai-config/status-alias-ready', 'Alias "{0}" → {1} ready ({2} endpoint(s) available{3}).', summary.activeAliasLabel, endpoint, summary.chainLength, pin);
    }
    return React.createElement(
      'div',
      { className: status.configured ? 'afe-model-config-status ok' : 'afe-model-config-status missing' },
      message
    );
  }

  // ===========================================================================
  // Endpoints (channels)
  // ===========================================================================

  protected renderEndpointsSection(): React.ReactNode {
    return React.createElement(
      'div',
      { className: 'afe-model-config-section' },
      React.createElement('h3', undefined, nls.localize('ai-focused-editor/ai-config/endpoints-heading', 'Endpoints')),
      React.createElement(
        'p',
        { className: 'afe-model-config-help' },
        nls.localize('ai-focused-editor/ai-config/endpoints-help', 'Endpoints are channels (where/how to reach a provider). Combine them into aliases below. API keys are stored per endpoint in user settings; availability windows gate when an endpoint is used.')
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
          }, nls.localize('ai-focused-editor/ai-config/new-endpoint-button', '+ New Endpoint'))
        )
      ),
      this.renderEndpointForm()
    );
  }

  protected renderEndpointRow(endpoint: AiEndpointDescriptor, index: number): React.ReactNode {
    const badge = endpoint.availableNow
      ? nls.localize('ai-focused-editor/ai-config/badge-now', '● now')
      : nls.localize('ai-focused-editor/ai-config/badge-off-window', '○ off-window');
    const badgeTitle = endpoint.availableNow
      ? nls.localize('ai-focused-editor/ai-config/available-now-title', 'Available now')
      : (endpoint.enabled
        ? nls.localize('ai-focused-editor/ai-config/outside-window-title', 'Outside its availability window right now')
        : nls.localize('ai-focused-editor/ai-config/disabled-title', 'Disabled'));
    const notes: string[] = [];
    if (!endpoint.enabled) {
      notes.push(nls.localize('ai-focused-editor/ai-config/note-disabled', 'disabled'));
    }
    if (!endpoint.hasApiKey && (endpoint.transportKind === 'api' || endpoint.transportKind === 'proxy')) {
      notes.push(nls.localize('ai-focused-editor/ai-config/note-no-key', 'no key'));
    }
    if (endpoint.windowWarning) {
      notes.push(nls.localize('ai-focused-editor/ai-config/note-bad-window', 'bad window'));
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
          title: nls.localize('ai-focused-editor/ai-config/edit-endpoint-title', 'Edit this endpoint'),
          onClick: () => this.selectEndpoint(endpoint.id)
        },
        `${endpoint.label} — ${endpoint.provider || '?'} / ${endpoint.transportKind}${notes.length > 0 ? ` [${notes.join(', ')}]` : ''}`
      ),
      React.createElement('button', {
        className: 'theia-button secondary',
        type: 'button',
        disabled: index === 0,
        title: nls.localize('ai-focused-editor/ai-config/move-up-generic-title', 'Move up'),
        onClick: () => { void this.moveEndpoint(endpoint.id, -1); }
      }, '↑'),
      React.createElement('button', {
        className: 'theia-button secondary',
        type: 'button',
        disabled: index === this.endpoints.length - 1,
        title: nls.localize('ai-focused-editor/ai-config/move-down-generic-title', 'Move down'),
        onClick: () => { void this.moveEndpoint(endpoint.id, 1); }
      }, '↓'),
      React.createElement('button', {
        className: 'theia-button secondary',
        type: 'button',
        title: nls.localize('ai-focused-editor/ai-config/delete-endpoint-title', 'Delete endpoint'),
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
      React.createElement('h4', undefined, editing
        ? nls.localize('ai-focused-editor/ai-config/edit-endpoint', 'Edit Endpoint: {0}', this.endpointDraft.label || this.endpointDraft.originalId)
        : nls.localize('ai-focused-editor/ai-config/new-endpoint', 'New Endpoint')),
      this.renderEndpointTextInput(nls.localize('ai-focused-editor/ai-config/field-endpoint-id', 'Endpoint ID'), 'id', nls.localize('ai-focused-editor/ai-config/field-endpoint-id-ph', 'unique id, e.g. gateway-claude'), editing),
      this.renderEndpointTextInput(nls.localize('ai-focused-editor/ai-config/field-label', 'Label'), 'label', nls.localize('ai-focused-editor/ai-config/field-label-ph', 'display name')),
      this.renderEndpointProviderInput(),
      this.renderEndpointTransportInput(),
      this.renderEndpointTextInput(nls.localize('ai-focused-editor/ai-config/field-endpoint-url', 'Endpoint URL'), 'endpointUrl', nls.localize('ai-focused-editor/ai-config/field-endpoint-url-ph', 'optional endpoint URL')),
      this.renderEndpointTextInput(nls.localize('ai-focused-editor/ai-config/field-command', 'Command'), 'command', nls.localize('ai-focused-editor/ai-config/field-command-ph', 'optional command (acp/cli transports)')),
      this.renderEndpointTextInput(nls.localize('ai-focused-editor/ai-config/field-allowed-models', 'Allowed Models'), 'allowedModels', nls.localize('ai-focused-editor/ai-config/field-allowed-models-ph', 'optional comma-separated shortlist')),
      this.renderEndpointTextInput(nls.localize('ai-focused-editor/ai-config/field-windows', 'Availability Windows'), 'timeWindows', nls.localize('ai-focused-editor/ai-config/field-windows-ph', 'e.g. 1-5 09:00-18:00, 6,7 10:00-14:00 (blank = always)')),
      this.renderEndpointSecretInput(),
      this.renderEndpointCheckbox(),
      this.renderEndpointTextInput(nls.localize('ai-focused-editor/ai-config/field-verify-model', 'Verify Model'), 'verifyModel', nls.localize('ai-focused-editor/ai-config/field-verify-model-ph', 'model id to test-connect with')),
      React.createElement(
        'div',
        { className: 'afe-model-config-actions' },
        React.createElement('button', { className: 'theia-button main', type: 'submit' }, nls.localize('ai-focused-editor/ai-config/save-endpoint', 'Save Endpoint')),
        React.createElement(
          'button',
          {
            className: 'theia-button',
            type: 'button',
            disabled: this.checkingConnection || !this.endpointDraft.provider.trim(),
            title: nls.localize('ai-focused-editor/ai-config/check-endpoint-title', 'Stage 1: reach this endpoint and fetch its model list (connection check, without saving)'),
            onClick: () => { void this.checkEndpointDraft(); }
          },
          this.checkingConnection
            ? nls.localize('ai-focused-editor/ai-config/checking-connection', 'Checking connection...')
            : nls.localize('ai-focused-editor/ai-config/check-connection', 'Check Connection')
        ),
        React.createElement(
          'button',
          {
            className: 'theia-button',
            type: 'button',
            disabled: this.verifyingEndpoint || !this.endpointDraft.provider.trim() || !this.endpointDraft.verifyModel.trim(),
            title: nls.localize('ai-focused-editor/ai-config/verify-endpoint-title', 'Test-connect this endpoint with the verify model, without saving or activating'),
            onClick: () => { void this.verifyEndpointDraft(); }
          },
          this.verifyingEndpoint
            ? nls.localize('ai-focused-editor/ai-config/verifying', 'Verifying...')
            : nls.localize('ai-focused-editor/ai-config/verify', 'Verify')
        ),
        React.createElement(
          'button',
          {
            className: 'theia-button',
            type: 'button',
            title: nls.localize('ai-focused-editor/ai-config/use-local-proxy-endpoint-title', 'Fill endpoint URL for a local ai-connect proxy on 127.0.0.1:8045'),
            onClick: () => this.applyEndpointLocalProxyDefaults()
          },
          nls.localize('ai-focused-editor/ai-config/use-local-proxy', 'Use Local Proxy')
        )
      ),
      this.renderEndpointCheckResult()
    );
  }

  /** Stage-1 result block: reachability + discovered models (click to add to the shortlist). */
  protected renderEndpointCheckResult(): React.ReactNode {
    const check = this.endpointCheck;
    if (!check) {
      return undefined;
    }
    const header = check.reachable
      ? React.createElement('div', { className: 'afe-endpoint-check-line ok' },
          nls.localize('ai-focused-editor/ai-config/endpoint-check-result-reachable', '✓ Connection established. Models discovered: {0}.', check.modelCount))
      : React.createElement('div', { className: 'afe-endpoint-check-line fail' },
          nls.localize('ai-focused-editor/ai-config/endpoint-check-result-unreachable', '✗ Connection failed: {0}',
            check.detail || nls.localize('ai-focused-editor/ai-config/value-unknown-error', 'unknown error')));
    const modelsNode = check.models.length > 0
      ? React.createElement(
          'div',
          { className: 'afe-endpoint-check-models' },
          React.createElement('span', { className: 'afe-model-config-help' },
            nls.localize('ai-focused-editor/ai-config/endpoint-check-models-heading', 'Discovered models (click to add to the shortlist):')),
          React.createElement(
            'div',
            { className: 'afe-endpoint-check-chips' },
            ...check.models.map(model => React.createElement('button', {
              key: model,
              className: 'theia-button secondary afe-model-chip',
              type: 'button',
              title: nls.localize('ai-focused-editor/ai-config/endpoint-check-add-model-title', 'Add "{0}" to the allowed-model shortlist', model),
              onClick: () => this.applyDiscoveredModel(model)
            }, model))
          )
        )
      : (check.reachable
        ? React.createElement('div', { className: 'afe-model-config-help' },
            nls.localize('ai-focused-editor/ai-config/endpoint-check-no-models', 'No models were reported by this endpoint.'))
        : undefined);
    return React.createElement('div', { className: 'afe-endpoint-check-result' }, header, modelsNode);
  }

  protected renderEndpointProviderInput(): React.ReactNode {
    const provider = this.endpointDraft.provider.trim();
    const catalogEntry = this.providerCatalog.find(entry => entry.providerId === provider);
    const isCustom = provider.length > 0 && !catalogEntry;
    const selectValue = isCustom ? CUSTOM_PROVIDER_OPTION : provider;
    const children: React.ReactNode[] = [
      React.createElement('span', { key: 'label' }, nls.localize('ai-focused-editor/ai-config/field-provider', 'Provider')),
      React.createElement(
        'select',
        {
          key: 'select',
          value: selectValue,
          onChange: (event: React.ChangeEvent<HTMLSelectElement>) => this.onEndpointProviderSelected(event.currentTarget.value)
        },
        React.createElement('option', { key: '', value: '' }, nls.localize('ai-focused-editor/ai-config/select-provider-option', 'select provider')),
        ...this.providerCatalog.map(entry =>
          React.createElement('option', { key: entry.providerId, value: entry.providerId }, `${entry.label} (${entry.providerId})`)
        ),
        React.createElement('option', { key: CUSTOM_PROVIDER_OPTION, value: CUSTOM_PROVIDER_OPTION }, nls.localize('ai-focused-editor/ai-config/custom-provider-option', 'custom provider...'))
      )
    ];
    if (isCustom || selectValue === CUSTOM_PROVIDER_OPTION) {
      children.push(React.createElement('input', {
        key: 'custom',
        value: provider,
        placeholder: nls.localize('ai-focused-editor/ai-config/custom-provider-ph', 'custom provider id, e.g. my-agent'),
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
        React.createElement('span', undefined, nls.localize('ai-focused-editor/ai-config/field-transport', 'Transport')),
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
      React.createElement('span', undefined, nls.localize('ai-focused-editor/ai-config/field-transport', 'Transport')),
      React.createElement(
        'select',
        {
          value: this.endpointDraft.transportId.trim(),
          onChange: (event: React.ChangeEvent<HTMLSelectElement>) => this.onEndpointTransportSelected(catalogEntry, event.currentTarget.value)
        },
        React.createElement('option', { key: '', value: '' }, nls.localize('ai-focused-editor/ai-config/transport-default-option', 'default ({0})', this.endpointDraft.transportKind || 'api')),
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
      React.createElement('span', undefined, hasApiKey
        ? nls.localize('ai-focused-editor/ai-config/api-key-configured', 'API Key (configured)')
        : nls.localize('ai-focused-editor/ai-config/api-key', 'API Key')),
      React.createElement('input', {
        type: 'password',
        value: this.endpointDraft.apiKey,
        placeholder: hasApiKey
          ? nls.localize('ai-focused-editor/ai-config/api-key-keep-ph', 'leave blank to keep current key')
          : apiTransport
            ? nls.localize('ai-focused-editor/ai-config/api-key-required-ph', 'required for api transport')
            : nls.localize('ai-focused-editor/ai-config/api-key-not-needed-ph', 'not needed for this transport'),
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
      React.createElement('span', undefined, nls.localize('ai-focused-editor/ai-config/enabled', 'Enabled'))
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
    this.endpointCheck = undefined;
    this.update();
  }

  protected selectEndpoint(id: string): void {
    const stored = this.aiProfilePreferences.readEndpoints().find(endpoint => endpoint.id === id);
    if (!stored) {
      return;
    }
    this.selectedEndpointId = id;
    this.endpointDraft = this.toEndpointDraft(stored);
    this.endpointCheck = undefined;
    this.update();
  }

  protected async saveEndpointDraft(): Promise<void> {
    const provider = this.endpointDraft.provider.trim();
    if (!provider) {
      await this.messages.warn(nls.localize('ai-focused-editor/ai-config/endpoint-provider-required', 'A provider is required to save an endpoint.'));
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
    await this.messages.info(nls.localize('ai-focused-editor/ai-config/endpoint-saved', 'Endpoint "{0}" saved.', endpoint.label || id));

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
    await this.messages.info(nls.localize('ai-focused-editor/ai-config/endpoint-deleted', 'Endpoint "{0}" deleted.', id));
  }

  protected async moveEndpoint(id: string, delta: -1 | 1): Promise<void> {
    await this.aiProfilePreferences.moveEndpoint(id, delta);
    await this.refresh();
  }

  /** Stage 1: reach the draft endpoint and fetch its model list (no save/activate). */
  protected async checkEndpointDraft(): Promise<void> {
    const provider = this.endpointDraft.provider.trim();
    if (!provider) {
      await this.messages.warn(nls.localize('ai-focused-editor/ai-config/check-endpoint-required', 'A provider is required to check the connection.'));
      return;
    }
    const endpoint = this.endpointDraftToStored(this.endpointDraft.id.trim() || provider);
    const profile = this.aiProfilePreferences.buildEndpointProbeProfile(endpoint, this.endpointDraft.verifyModel.trim(), this.endpointDraft.apiKey.trim());
    this.checkingConnection = true;
    this.endpointCheck = undefined;
    this.update();
    const progress = await this.messages.showProgress({ text: nls.localize('ai-focused-editor/ai-config/checking-endpoint-progress', 'Checking connection to endpoint "{0}"...', endpoint.id) });
    try {
      const verdict = await this.verification.checkEndpoint(profile);
      this.endpointCheck = verdict;
      if (verdict.reachable) {
        await this.messages.info(nls.localize('ai-focused-editor/ai-config/endpoint-check-ok', 'Endpoint "{0}" reachable: {1} model(s) discovered.', endpoint.id, verdict.modelCount));
      } else {
        await this.messages.error(nls.localize('ai-focused-editor/ai-config/endpoint-check-unreachable', 'Endpoint "{0}" unreachable: {1}', endpoint.id, verdict.detail || nls.localize('ai-focused-editor/ai-config/value-unknown-error', 'unknown error')));
      }
    } finally {
      progress.cancel();
      this.checkingConnection = false;
      this.update();
    }
  }

  /** Merge a discovered model into the draft's allowed-model shortlist (not saved). */
  protected applyDiscoveredModel(model: string): void {
    const current = this.parseAllowedModels(this.endpointDraft.allowedModels) ?? [];
    const nextAllowed = current.includes(model) ? current : [...current, model];
    this.endpointDraft = {
      ...this.endpointDraft,
      allowedModels: nextAllowed.join(', '),
      verifyModel: this.endpointDraft.verifyModel.trim() || model
    };
    this.update();
  }

  protected async verifyEndpointDraft(): Promise<void> {
    const provider = this.endpointDraft.provider.trim();
    const model = this.endpointDraft.verifyModel.trim();
    if (!provider || !model) {
      await this.messages.warn(nls.localize('ai-focused-editor/ai-config/endpoint-verify-required', 'Provider and a verify model are required to verify an endpoint.'));
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
    const progress = background ? undefined : await this.messages.showProgress({ text: nls.localize('ai-focused-editor/ai-config/verifying-endpoint-progress', 'Verifying endpoint "{0}"...', endpoint.id) });
    try {
      const result = await this.aiConnection.generate(profile, {
        messages: [
          { role: 'system', content: 'Reply with exactly: OK' },
          { role: 'user', content: 'Verify this AI connection.' }
        ],
        parameters: { maxTokens: 8, temperature: 0 },
        logContext: { command: 'ai-focused-editor.ai.verifyEndpoint', endpointId: endpoint.id }
      });
      await this.messages.info(nls.localize('ai-focused-editor/ai-config/endpoint-verified', 'Endpoint "{0}" verified via {1}/{2}: {3}', endpoint.id, result.route?.provider ?? profile.provider, result.route?.model ?? model, this.previewText(result.text)));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.messages.error(nls.localize('ai-focused-editor/ai-config/endpoint-verify-failed', 'Endpoint "{0}" verification failed: {1}', endpoint.id, detail));
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
      allowedModels: this.parseAllowedModels(this.endpointDraft.allowedModels),
      timeWindows: timeWindows.length > 0 ? timeWindows : undefined,
      enabled: this.endpointDraft.enabled ? undefined : false
    };
  }

  protected parseAllowedModels(value: string): string[] | undefined {
    const models = value.split(',').map(model => model.trim()).filter(model => model.length > 0);
    return models.length > 0 ? models : undefined;
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
      allowedModels: (endpoint.allowedModels ?? []).join(', '),
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
      allowedModels: '',
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
      React.createElement('h3', undefined, nls.localize('ai-focused-editor/ai-config/aliases-heading', 'Aliases')),
      React.createElement(
        'p',
        { className: 'afe-model-config-help' },
        nls.localize('ai-focused-editor/ai-config/aliases-help', 'Aliases are ordered chains of endpoint → model legs tried in failover order. The active alias (radio) is the default; endpoints that are disabled or outside their availability window are skipped.')
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
          placeholder: nls.localize('ai-focused-editor/ai-config/new-alias-ph', 'new alias id, e.g. fable'),
          onChange: (event: React.ChangeEvent<HTMLInputElement>) => { this.newAliasId = event.currentTarget.value; this.update(); }
        }),
        React.createElement('button', {
          className: 'theia-button secondary',
          type: 'button',
          onClick: () => { void this.addAlias(); }
        }, nls.localize('ai-focused-editor/ai-config/add-alias-button', '+ Add Alias'))
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
          title: nls.localize('ai-focused-editor/ai-config/set-active-alias-title', 'Set as active alias'),
          onChange: () => { void this.setActiveAlias(alias.id); }
        }),
        React.createElement('span', { className: 'afe-alias-name' },
          `${alias.label} (${alias.availableLegs}/${alias.chain.length} ${nls.localize('ai-focused-editor/ai-config/available-now-label', 'available now')})${alias.enabled ? '' : nls.localize('ai-focused-editor/ai-config/disabled-suffix', ' [disabled]')}`),
        React.createElement('button', {
          className: 'theia-button secondary',
          type: 'button',
          disabled: index === 0,
          title: nls.localize('ai-focused-editor/ai-config/move-alias-up-title', 'Move alias up'),
          onClick: () => { void this.moveAlias(alias.id, -1); }
        }, '↑'),
        React.createElement('button', {
          className: 'theia-button secondary',
          type: 'button',
          disabled: index === this.aliases.length - 1,
          title: nls.localize('ai-focused-editor/ai-config/move-alias-down-title', 'Move alias down'),
          onClick: () => { void this.moveAlias(alias.id, 1); }
        }, '↓'),
        React.createElement('button', {
          className: 'theia-button',
          type: 'button',
          disabled: Boolean(this.checkingAliasId) || alias.chain.length === 0,
          title: nls.localize('ai-focused-editor/ai-config/check-alias-title', 'Check each leg of this alias: connection, model presence, and a test generation'),
          onClick: () => { void this.checkAlias(alias.id); }
        }, this.checkingAliasId === alias.id
          ? nls.localize('ai-focused-editor/ai-config/checking-alias', 'Checking...')
          : nls.localize('ai-focused-editor/ai-config/check-alias', 'Check Alias')),
        React.createElement('button', {
          className: 'theia-button secondary',
          type: 'button',
          title: nls.localize('ai-focused-editor/ai-config/delete-alias-title', 'Delete alias'),
          onClick: () => { void this.deleteAlias(alias.id); }
        }, '✕')
      ),
      React.createElement(
        'ul',
        { className: 'afe-alias-legs' },
        ...alias.chain.map((leg, legIndex) => React.createElement(
          'li',
          { key: `${leg.endpointId}-${legIndex}`, className: 'afe-alias-leg' },
          React.createElement('span', { className: 'afe-alias-leg-text' }, `${leg.endpointId} → ${leg.model || nls.localize('ai-focused-editor/ai-config/no-model', '(no model)')}`),
          React.createElement('button', {
            className: 'theia-button secondary',
            type: 'button',
            disabled: legIndex === 0,
            title: nls.localize('ai-focused-editor/ai-config/move-leg-up-title', 'Move leg up'),
            onClick: () => { void this.moveAliasLeg(alias.id, legIndex, -1); }
          }, '↑'),
          React.createElement('button', {
            className: 'theia-button secondary',
            type: 'button',
            disabled: legIndex === alias.chain.length - 1,
            title: nls.localize('ai-focused-editor/ai-config/move-leg-down-title', 'Move leg down'),
            onClick: () => { void this.moveAliasLeg(alias.id, legIndex, 1); }
          }, '↓'),
          React.createElement('button', {
            className: 'theia-button secondary',
            type: 'button',
            title: nls.localize('ai-focused-editor/ai-config/remove-leg-title', 'Remove leg'),
            onClick: () => { void this.removeAliasLeg(alias.id, legIndex); }
          }, '✕')
        )),
        this.renderAddLegControls(alias)
      ),
      this.renderAliasCheckResult(alias.id)
    );
  }

  /** Stage-2 result block: per-leg verdict rows plus an overall verdict for the alias. */
  protected renderAliasCheckResult(aliasId: string): React.ReactNode {
    const verdict = this.aliasChecks[aliasId];
    if (!verdict) {
      return undefined;
    }
    const overall = this.aliasOverallMessage(verdict);
    return React.createElement(
      'div',
      { className: 'afe-alias-check-result' },
      React.createElement('div', { className: `afe-alias-check-overall ${verdict.overall === 'ok' ? 'ok' : 'fail'}` }, overall),
      React.createElement(
        'ul',
        { className: 'afe-alias-check-legs' },
        ...verdict.legs.map(leg => this.renderAliasCheckLeg(leg))
      )
    );
  }

  protected aliasOverallMessage(verdict: AliasCheckVerdict): string {
    switch (verdict.overall) {
      case 'ok':
        return nls.localize('ai-focused-editor/ai-config/alias-check-ok', '✓ Alias "{0}" works.', verdict.aliasLabel);
      case 'failed':
        return nls.localize('ai-focused-editor/ai-config/alias-check-failed', '✗ Alias "{0}": no leg passed verification.', verdict.aliasLabel);
      case 'unavailable':
        return nls.localize('ai-focused-editor/ai-config/alias-check-unavailable', 'Alias "{0}": no legs are available right now.', verdict.aliasLabel);
      default:
        return nls.localize('ai-focused-editor/ai-config/alias-check-empty', 'Alias "{0}": the chain is empty.', verdict.aliasLabel);
    }
  }

  protected renderAliasCheckLeg(leg: AliasLegVerdict): React.ReactNode {
    const title = `${leg.endpointId} → ${leg.model || nls.localize('ai-focused-editor/ai-config/no-model', '(no model)')}`;
    const parts: React.ReactNode[] = [
      React.createElement('span', { key: 'title', className: 'afe-alias-leg-text' }, title)
    ];
    if (leg.skipped) {
      parts.push(React.createElement('span', { key: 'skip', className: 'afe-leg-badge skip' }, this.legSkipLabel(leg.skipped)));
      return React.createElement('li', { key: leg.index, className: 'afe-alias-check-leg' }, ...parts);
    }
    parts.push(React.createElement('span', {
      key: 'conn',
      className: `afe-leg-badge ${leg.connection === 'ok' ? 'ok' : 'fail'}`
    }, leg.connection === 'ok'
      ? nls.localize('ai-focused-editor/ai-config/leg-connection-ok', '✓ connection')
      : nls.localize('ai-focused-editor/ai-config/leg-connection-fail', '✗ connection')));
    parts.push(React.createElement('span', {
      key: 'model',
      className: `afe-leg-badge ${leg.modelState === 'present' ? 'ok' : leg.modelState === 'absent' ? 'fail' : 'unknown'}`
    }, leg.modelState === 'present'
      ? nls.localize('ai-focused-editor/ai-config/leg-model-present', '✓ model')
      : leg.modelState === 'absent'
        ? nls.localize('ai-focused-editor/ai-config/leg-model-absent', '✗ model')
        : nls.localize('ai-focused-editor/ai-config/leg-model-unknown', '? model')));
    if (leg.generation) {
      parts.push(React.createElement('span', {
        key: 'gen',
        className: `afe-leg-badge ${leg.generation === 'ok' ? 'ok' : 'fail'}`
      }, leg.generation === 'ok'
        ? nls.localize('ai-focused-editor/ai-config/leg-generation-ok', '✓ generation')
        : nls.localize('ai-focused-editor/ai-config/leg-generation-fail', '✗ generation')));
    }
    const detail = leg.generationError || leg.connectionDetail;
    const children: React.ReactNode[] = [
      React.createElement('div', { key: 'row', className: 'afe-alias-check-leg-row' }, ...parts)
    ];
    if (detail) {
      children.push(React.createElement('div', { key: 'detail', className: 'afe-alias-check-leg-detail' }, detail));
    }
    return React.createElement('li', { key: leg.index, className: 'afe-alias-check-leg' }, ...children);
  }

  protected legSkipLabel(reason: AliasLegVerdict['skipped']): string {
    switch (reason) {
      case 'missing-endpoint':
        return nls.localize('ai-focused-editor/ai-config/leg-skipped-missing', 'skipped: endpoint not found');
      case 'disabled':
        return nls.localize('ai-focused-editor/ai-config/leg-skipped-disabled', 'skipped: endpoint disabled');
      default:
        return nls.localize('ai-focused-editor/ai-config/leg-skipped-window', 'skipped: outside availability window');
    }
  }

  protected async checkAlias(aliasId: string): Promise<void> {
    this.checkingAliasId = aliasId;
    this.update();
    const label = this.aliases.find(alias => alias.id === aliasId)?.label || aliasId;
    const progress = await this.messages.showProgress({ text: nls.localize('ai-focused-editor/ai-config/checking-alias-progress', 'Checking alias "{0}"...', label) });
    try {
      const verdict = await this.verification.checkAlias(aliasId);
      this.aliasChecks = { ...this.aliasChecks, [aliasId]: verdict };
      if (verdict.overall === 'ok') {
        await this.messages.info(this.aliasOverallMessage(verdict));
      } else if (verdict.overall === 'failed') {
        await this.messages.error(this.aliasOverallMessage(verdict));
      } else {
        await this.messages.warn(this.aliasOverallMessage(verdict));
      }
    } finally {
      progress.cancel();
      this.checkingAliasId = undefined;
      this.update();
    }
  }

  protected renderAddLegControls(alias: AiAliasDescriptor): React.ReactNode {
    const draft = this.legDrafts[alias.id] ?? { endpointId: '', model: '' };
    // Offer the selected endpoint's curated model shortlist as suggestions.
    const selectedEndpoint = this.endpoints.find(endpoint => endpoint.id === draft.endpointId);
    const modelSuggestions = selectedEndpoint?.allowedModels ?? [];
    const modelListId = `afe-alias-leg-models-${alias.id}`;
    return React.createElement(
      'li',
      { key: '__add_leg__', className: 'afe-alias-add-leg' },
      React.createElement(
        'select',
        {
          value: draft.endpointId,
          onChange: (event: React.ChangeEvent<HTMLSelectElement>) => this.updateLegDraft(alias.id, 'endpointId', event.currentTarget.value)
        },
        React.createElement('option', { key: '', value: '' }, nls.localize('ai-focused-editor/ai-config/select-endpoint-option', 'select endpoint')),
        ...this.endpoints.map(endpoint =>
          React.createElement('option', { key: endpoint.id, value: endpoint.id }, `${endpoint.label} (${endpoint.id})`)
        )
      ),
      React.createElement('input', {
        value: draft.model,
        placeholder: nls.localize('ai-focused-editor/ai-config/leg-model-ph', 'model id'),
        list: modelSuggestions.length > 0 ? modelListId : undefined,
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => this.updateLegDraft(alias.id, 'model', event.currentTarget.value)
      }),
      modelSuggestions.length > 0
        ? React.createElement(
            'datalist',
            { id: modelListId },
            ...modelSuggestions.map(model => React.createElement('option', { key: model, value: model }))
          )
        : undefined,
      React.createElement('button', {
        className: 'theia-button secondary',
        type: 'button',
        onClick: () => { void this.addAliasLeg(alias.id); }
      }, nls.localize('ai-focused-editor/ai-config/add-leg-button', '+ leg'))
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
    await this.messages.info(nls.localize('ai-focused-editor/ai-config/alias-added', 'Alias "{0}" added.', id));
  }

  protected async deleteAlias(id: string): Promise<void> {
    await this.aiProfilePreferences.deleteAlias(id);
    await this.refresh();
    await this.messages.info(nls.localize('ai-focused-editor/ai-config/alias-deleted', 'Alias "{0}" deleted.', id));
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
      await this.messages.warn(nls.localize('ai-focused-editor/ai-config/add-leg-required', 'Select an endpoint and enter a model id to add a chain leg.'));
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
      }, nls.localize('ai-focused-editor/ai-config/import-v1', 'Import ai-editor v1 Settings...')),
      React.createElement(
        'span',
        { className: 'afe-model-config-help' },
        nls.localize('ai-focused-editor/ai-config/import-v1-help', 'Reads .config/rag-endpoints.json + rag-aliases.json and creates endpoints (keys → user settings) and aliases.')
      )
    );
  }

  protected async importV1Settings(): Promise<void> {
    const selection = await this.fileDialogService.showOpenDialog({
      title: nls.localize('ai-focused-editor/ai-config/import-v1-dialog-title', 'Import ai-editor v1 Settings (pick the .config folder or the two JSON files)'),
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
      await this.messages.warn(nls.localize('ai-focused-editor/ai-config/import-v1-not-found', 'Could not find rag-endpoints.json or rag-aliases.json in the selection.'));
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
      nls.localize('ai-focused-editor/ai-config/import-v1-done', 'Imported {0} endpoint(s), {1} alias(es), {2} key(s) from ai-editor v1.', result.endpoints.length, result.aliases.length, Object.keys(result.keys).length)
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
      await this.messages.warn(nls.localize('ai-focused-editor/ai-config/read-file-failed', 'Could not read {0}: {1}', uri.path.base, detail));
      return undefined;
    }
  }
}
