import {
  PreferenceContribution,
  PreferenceSchema,
  PreferenceScope
} from '@theia/core/lib/common/preferences';
import { nls } from '@theia/core/lib/common/nls';

export const AI_FOCUSED_EDITOR_AI_API_KEYS = 'aiFocusedEditor.ai.apiKeys';
export const AI_FOCUSED_EDITOR_AI_ENDPOINTS = 'aiFocusedEditor.ai.endpoints';
export const AI_FOCUSED_EDITOR_AI_ALIASES = 'aiFocusedEditor.ai.aliases';
export const AI_FOCUSED_EDITOR_AI_ACTIVE_ALIAS = 'aiFocusedEditor.ai.activeAlias';
export const AI_FOCUSED_EDITOR_AI_PINNED_ENDPOINT = 'aiFocusedEditor.ai.pinnedEndpoint';
export const AI_FOCUSED_EDITOR_AI_REQUEST_LOG = 'aiFocusedEditor.ai.requestLog';
export const AI_FOCUSED_EDITOR_PREVIEW_SHOW_TAG_CHIPS = 'aiFocusedEditor.preview.showTagChips';
export const AI_FOCUSED_EDITOR_WELCOME_SHOW_ON_STARTUP = 'aiFocusedEditor.welcome.showOnStartup';

export const aiFocusedEditorPreferenceSchema: PreferenceSchema = {
  title: 'AI Focused Editor',
  scope: PreferenceScope.Folder,
  properties: {
    [AI_FOCUSED_EDITOR_AI_API_KEYS]: {
      type: 'object',
      default: {},
      additionalProperties: { type: 'string' },
      description: nls.localize('ai-focused-editor/ai-config/pref-api-keys-desc', 'API keys per endpoint id. Keep this in User scope (the Model Config view does this automatically) so secrets stay out of workspace files.')
    },
    [AI_FOCUSED_EDITOR_AI_ENDPOINTS]: {
      type: 'array',
      default: [],
      description: nls.localize('ai-focused-editor/ai-config/pref-endpoints-desc', 'AI ENDPOINTS (channels): where/how to reach a provider. Each entry: id, label, provider, transportKind/transportId, endpointUrl, command, authMethodId, env, allowedModels, timeWindows, enabled. Secrets are never stored here — API keys go in aiFocusedEditor.ai.apiKeys keyed by endpoint id. Endpoints are combined into chains by aiFocusedEditor.ai.aliases.'),
      items: {
        type: 'object',
        required: ['id', 'provider'],
        properties: {
          id: { type: 'string' },
          label: { type: 'string' },
          provider: { type: 'string' },
          transportKind: { type: 'string' },
          transportId: { type: 'string' },
          endpointUrl: { type: 'string' },
          command: { type: 'string' },
          authMethodId: { type: 'string' },
          allowedModels: {
            type: 'array',
            items: { type: 'string' },
            description: nls.localize('ai-focused-editor/ai-config/pref-endpoints-allowed-desc', 'Curated model shortlist for this endpoint. Offered as suggestions when picking the model for an alias leg. Empty/absent = no shortlist.')
          },
          env: {
            type: 'object',
            additionalProperties: { type: 'string' }
          },
          timeWindows: {
            type: 'array',
            items: { type: 'string' },
            description: nls.localize('ai-focused-editor/ai-config/pref-endpoints-windows-desc', 'Availability windows, e.g. "09:00-18:00", "1-5 09:00-18:00" (ISO weekday 1=Mon..7=Sun), "22:00-06:00" (overnight). Empty/absent = always available.')
          },
          enabled: { type: 'boolean' }
        }
      }
    },
    [AI_FOCUSED_EDITOR_AI_ALIASES]: {
      type: 'array',
      default: [],
      description: nls.localize('ai-focused-editor/ai-config/pref-aliases-desc', 'AI ALIASES (chains): ordered endpoint+model legs tried in failover order. Each entry: id, label, chain [{ endpointId, model }], enabled. The active alias (aiFocusedEditor.ai.activeAlias) is the user default; when no alias exists no AI connection is configured.'),
      items: {
        type: 'object',
        required: ['id', 'chain'],
        properties: {
          id: { type: 'string' },
          label: { type: 'string' },
          chain: {
            type: 'array',
            items: {
              type: 'object',
              required: ['endpointId', 'model'],
              properties: {
                endpointId: { type: 'string' },
                model: { type: 'string' }
              }
            }
          },
          enabled: { type: 'boolean' }
        }
      }
    },
    [AI_FOCUSED_EDITOR_AI_ACTIVE_ALIAS]: {
      type: 'string',
      default: '',
      description: nls.localize('ai-focused-editor/ai-config/pref-active-alias-desc', 'Id of the active AI alias (the user default). Its chain becomes the failover chain, skipping endpoints that are disabled or outside their availability window.')
    },
    [AI_FOCUSED_EDITOR_AI_PINNED_ENDPOINT]: {
      type: 'string',
      default: '',
      description: nls.localize('ai-focused-editor/ai-config/pref-pinned-endpoint-desc', 'Optional endpoint id pinned to the front of the active alias chain (Switch AI Endpoint...). Empty = no pin.')
    },
    [AI_FOCUSED_EDITOR_AI_REQUEST_LOG]: {
      type: 'string',
      enum: ['off', 'metadata', 'full'],
      default: 'off',
      enumDescriptions: [
        nls.localize('ai-focused-editor/ai-log/pref-request-log-off', 'Off — no AI request log is written.'),
        nls.localize('ai-focused-editor/ai-log/pref-request-log-metadata', 'Metadata — log one entry per failover leg (endpoint, alias, model, outcome, duration, tokens). No prompt or response text is stored.'),
        nls.localize('ai-focused-editor/ai-log/pref-request-log-full', 'Full — also store the request prompts and the response text. WARNING: this writes your manuscript text into ai/chat/requests-<date>.jsonl in the workspace.')
      ],
      description: nls.localize('ai-focused-editor/ai-log/pref-request-log-desc', 'Debug logging of AI requests to ai/chat/requests-<date>.jsonl (one record per failover leg: what was sent and received per endpoint/alias). "metadata" logs routing metadata only; "full" ALSO writes the prompts and response text — i.e. your manuscript content — into the workspace log file. Leave "off" unless you are diagnosing AI behavior.')
    },
    [AI_FOCUSED_EDITOR_PREVIEW_SHOW_TAG_CHIPS]: {
      type: 'boolean',
      default: true,
      description: nls.localize('ai-focused-editor/ai-config/pref-preview-tag-chips-desc', 'Show the semantic tag chips row at the top of the Semantic Preview. Turn this off for a plain-Markdown reading view.')
    },
    [AI_FOCUSED_EDITOR_WELCOME_SHOW_ON_STARTUP]: {
      type: 'boolean',
      default: true,
      description: nls.localize('ai-focused-editor/ai-config/pref-welcome-desc', 'Show the AI Focused Editor welcome page on startup when no files are open. Turn this off to start straight in the editor.')
    }
  }
};

export const AiFocusedEditorPreferenceContribution: PreferenceContribution = {
  schema: aiFocusedEditorPreferenceSchema
};
