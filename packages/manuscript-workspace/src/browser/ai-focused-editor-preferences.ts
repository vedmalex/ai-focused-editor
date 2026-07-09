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
      description: 'API key for the configured provider. MVP browser mode stores this in Theia preferences.'
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
    }
  }
};

export const AiFocusedEditorPreferenceContribution: PreferenceContribution = {
  schema: aiFocusedEditorPreferenceSchema
};
