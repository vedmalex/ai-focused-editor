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
export const AI_FOCUSED_EDITOR_PREVIEW_SHOW_TAG_CHIPS = 'aiFocusedEditor.preview.showTagChips';

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
      description: 'API keys per profile id. Keep this in User scope (the Model Config view does this automatically) so secrets stay out of workspace files.'
    },
    [AI_FOCUSED_EDITOR_PREVIEW_SHOW_TAG_CHIPS]: {
      type: 'boolean',
      default: true,
      description: 'Show the semantic tag chips row at the top of the Semantic Preview. Turn this off for a plain-Markdown reading view.'
    }
  }
};

export const AiFocusedEditorPreferenceContribution: PreferenceContribution = {
  schema: aiFocusedEditorPreferenceSchema
};
