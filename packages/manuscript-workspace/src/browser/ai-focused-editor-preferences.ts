import {
  PreferenceContribution,
  PreferenceSchema,
  PreferenceScope
} from '@theia/core/lib/common/preferences';

export const AI_FOCUSED_EDITOR_AI_PROVIDER = 'aiFocusedEditor.ai.provider';
export const AI_FOCUSED_EDITOR_AI_MODEL = 'aiFocusedEditor.ai.model';
export const AI_FOCUSED_EDITOR_AI_API_KEY = 'aiFocusedEditor.ai.apiKey';
export const AI_FOCUSED_EDITOR_AI_ENDPOINT_URL = 'aiFocusedEditor.ai.endpointUrl';
export const AI_FOCUSED_EDITOR_AI_TRANSPORT_KIND = 'aiFocusedEditor.ai.transportKind';
export const AI_FOCUSED_EDITOR_AI_TRANSPORT_ID = 'aiFocusedEditor.ai.transportId';
export const AI_FOCUSED_EDITOR_AI_PROFILE_ID = 'aiFocusedEditor.ai.profileId';
export const AI_FOCUSED_EDITOR_AI_PROFILES = 'aiFocusedEditor.ai.profiles';
export const AI_FOCUSED_EDITOR_AI_ACTIVE_PROFILE = 'aiFocusedEditor.ai.activeProfile';
export const AI_FOCUSED_EDITOR_AI_API_KEYS = 'aiFocusedEditor.ai.apiKeys';
export const AI_FOCUSED_EDITOR_AI_ENDPOINTS = 'aiFocusedEditor.ai.endpoints';
export const AI_FOCUSED_EDITOR_AI_ALIASES = 'aiFocusedEditor.ai.aliases';
export const AI_FOCUSED_EDITOR_AI_ACTIVE_ALIAS = 'aiFocusedEditor.ai.activeAlias';
export const AI_FOCUSED_EDITOR_AI_PINNED_ENDPOINT = 'aiFocusedEditor.ai.pinnedEndpoint';
export const AI_FOCUSED_EDITOR_PREVIEW_SHOW_TAG_CHIPS = 'aiFocusedEditor.preview.showTagChips';
export const AI_FOCUSED_EDITOR_WELCOME_SHOW_ON_STARTUP = 'aiFocusedEditor.welcome.showOnStartup';

export const aiFocusedEditorPreferenceSchema: PreferenceSchema = {
  title: 'AI Focused Editor',
  scope: PreferenceScope.Folder,
  properties: {
    [AI_FOCUSED_EDITOR_AI_PROVIDER]: {
      type: 'string',
      default: '',
      description: 'ai-connect provider id for browser-safe API calls, for example openai, anthropic, or gemini.'
    },
    [AI_FOCUSED_EDITOR_AI_MODEL]: {
      type: 'string',
      default: '',
      description: 'Model id used by AI Focused Editor commands.'
    },
    [AI_FOCUSED_EDITOR_AI_API_KEY]: {
      type: 'string',
      default: '',
      description: 'API key for the configured provider. Only needed for the api transport; store it in User scope (the Model Config view does this automatically) so it stays out of workspace files.'
    },
    [AI_FOCUSED_EDITOR_AI_ENDPOINT_URL]: {
      type: 'string',
      default: '',
      description: 'Optional custom provider endpoint URL.'
    },
    [AI_FOCUSED_EDITOR_AI_TRANSPORT_KIND]: {
      type: 'string',
      enum: ['api', 'proxy', 'acp', 'cli', 'server'],
      default: 'api',
      description: 'ai-connect transport kind. Browser commands currently execute only api/proxy routes.'
    },
    [AI_FOCUSED_EDITOR_AI_TRANSPORT_ID]: {
      type: 'string',
      default: '',
      description: 'Optional ai-connect transport id override.'
    },
    [AI_FOCUSED_EDITOR_AI_PROFILE_ID]: {
      type: 'string',
      default: '',
      description: 'Optional ai-connect account/profile id.'
    },
    [AI_FOCUSED_EDITOR_AI_PROFILES]: {
      type: 'array',
      default: [],
      description: 'Named AI profiles (aliases). Each entry: id, label, provider, model, transportKind/transportId, endpointUrl, allowedModels, enabled. Secrets are never stored here. When empty, the single legacy aiFocusedEditor.ai.* keys apply.',
      items: {
        type: 'object',
        required: ['id', 'provider', 'model'],
        properties: {
          id: { type: 'string' },
          label: { type: 'string' },
          provider: { type: 'string' },
          model: { type: 'string' },
          transportKind: { type: 'string' },
          transportId: { type: 'string' },
          profileId: { type: 'string' },
          endpointUrl: { type: 'string' },
          command: { type: 'string' },
          authMethodId: { type: 'string' },
          allowedModels: {
            type: 'array',
            items: { type: 'string' }
          },
          enabled: { type: 'boolean' }
        }
      }
    },
    [AI_FOCUSED_EDITOR_AI_ACTIVE_PROFILE]: {
      type: 'string',
      default: '',
      description: 'Id of the active AI profile from aiFocusedEditor.ai.profiles. The failover chain is the active profile first, then the remaining enabled profiles in list order.'
    },
    [AI_FOCUSED_EDITOR_AI_API_KEYS]: {
      type: 'object',
      default: {},
      additionalProperties: { type: 'string' },
      description: 'API keys per profile OR endpoint id. Keep this in User scope (the Model Config view does this automatically) so secrets stay out of workspace files.'
    },
    [AI_FOCUSED_EDITOR_AI_ENDPOINTS]: {
      type: 'array',
      default: [],
      description: 'AI ENDPOINTS (channels): where/how to reach a provider. Each entry: id, label, provider, transportKind/transportId, endpointUrl, command, authMethodId, env, timeWindows, enabled. Secrets are never stored here — API keys go in aiFocusedEditor.ai.apiKeys keyed by endpoint id. Endpoints are combined into chains by aiFocusedEditor.ai.aliases.',
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
          env: {
            type: 'object',
            additionalProperties: { type: 'string' }
          },
          timeWindows: {
            type: 'array',
            items: { type: 'string' },
            description: 'Availability windows, e.g. "09:00-18:00", "1-5 09:00-18:00" (ISO weekday 1=Mon..7=Sun), "22:00-06:00" (overnight). Empty/absent = always available.'
          },
          enabled: { type: 'boolean' }
        }
      }
    },
    [AI_FOCUSED_EDITOR_AI_ALIASES]: {
      type: 'array',
      default: [],
      description: 'AI ALIASES (chains): ordered endpoint+model legs tried in failover order. Each entry: id, label, chain [{ endpointId, model }], enabled. When any alias exists, the active alias supersedes aiFocusedEditor.ai.profiles.',
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
      description: 'Id of the active AI alias (the user default). Its chain becomes the failover chain, skipping endpoints that are disabled or outside their availability window.'
    },
    [AI_FOCUSED_EDITOR_AI_PINNED_ENDPOINT]: {
      type: 'string',
      default: '',
      description: 'Optional endpoint id pinned to the front of the active alias chain (Switch AI Endpoint...). Empty = no pin.'
    },
    [AI_FOCUSED_EDITOR_PREVIEW_SHOW_TAG_CHIPS]: {
      type: 'boolean',
      default: true,
      description: 'Show the semantic tag chips row at the top of the Semantic Preview. Turn this off for a plain-Markdown reading view.'
    },
    [AI_FOCUSED_EDITOR_WELCOME_SHOW_ON_STARTUP]: {
      type: 'boolean',
      default: true,
      description: 'Show the AI Focused Editor welcome page on startup when no files are open. Turn this off to start straight in the editor.'
    }
  }
};

export const AiFocusedEditorPreferenceContribution: PreferenceContribution = {
  schema: aiFocusedEditorPreferenceSchema
};
