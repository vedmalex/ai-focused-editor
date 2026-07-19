import {
  PreferenceContribution,
  PreferenceSchema,
  PreferenceScope
} from '@theia/core/lib/common/preferences';
import { nls } from '@theia/core/lib/common/nls';

/**
 * Product preferences owned by manuscript-workspace.
 *
 * The AI-connection keys (`apiKeys`, `endpoints`, `aliases`, `activeAlias`,
 * `pinnedEndpoint`, `requestLog`) are NOT registered here — they live in the
 * neutral `aiConnect.*` schema owned by `ai-connect-theia`. The owner retired the
 * legacy `aiFocusedEditor.ai.*` surface from our editor; see
 * `common/ai-settings-migration.ts` for the one-time value migration.
 *
 * `aiConnect.manuscriptOverview` is the one AI-related key that stays here: it is
 * manuscript-specific (how much of the whole-project overview the `{{manuscript}}`
 * context includes) and has no home in the generic `aiConnect.*` package, so this
 * package registers it under the neutral namespace.
 */
export const AI_CONNECT_MANUSCRIPT_OVERVIEW = 'aiConnect.manuscriptOverview';
export const AI_FOCUSED_EDITOR_PREVIEW_SHOW_TAG_CHIPS = 'aiFocusedEditor.preview.showTagChips';
export const AI_FOCUSED_EDITOR_WELCOME_SHOW_ON_STARTUP = 'aiFocusedEditor.welcome.showOnStartup';
export const AI_FOCUSED_EDITOR_LIBRARY_PATH = 'aiFocusedEditor.library.path';

/**
 * Media-transcription (Transcript Check backend pipeline) preference keys.
 * Machine-specific paths default to EMPTY — the backend `doctor()` report
 * tells the user which ones to set. The frontend reads these and passes the
 * values into `AudioConversionService` requests (the backend never reads
 * preferences directly).
 */
export const MEDIA_TRANSCRIPTION_FFMPEG_PATH = 'mediaTranscription.ffmpegPath';
export const MEDIA_TRANSCRIPTION_FFPROBE_PATH = 'mediaTranscription.ffprobePath';
export const MEDIA_TRANSCRIPTION_WHISPER_CLI_PATH = 'mediaTranscription.whisperCliPath';
export const MEDIA_TRANSCRIPTION_MODEL_PATH = 'mediaTranscription.modelPath';
export const MEDIA_TRANSCRIPTION_LANGUAGE = 'mediaTranscription.language';
export const MEDIA_TRANSCRIPTION_THREADS = 'mediaTranscription.threads';
export const MEDIA_TRANSCRIPTION_BACKEND = 'mediaTranscription.backend';
export const MEDIA_TRANSCRIPTION_GROQ_MODEL = 'mediaTranscription.groqModel';
export const MEDIA_TRANSCRIPTION_GROQ_API_KEY = 'mediaTranscription.groqApiKey';
export const MEDIA_TRANSCRIPTION_SEGMENT_SECONDS = 'mediaTranscription.segmentSeconds';

export const aiFocusedEditorPreferenceSchema: PreferenceSchema = {
  title: 'AI Focused Editor',
  scope: PreferenceScope.Folder,
  properties: {
    [AI_CONNECT_MANUSCRIPT_OVERVIEW]: {
      type: 'string',
      enum: ['full', 'compact'],
      default: 'full',
      enumDescriptions: [
        nls.localize('ai-focused-editor/chat-context/pref-overview-full', 'Full — the {{manuscript}} overview lists every entity and source (the historical format).'),
        nls.localize('ai-focused-editor/chat-context/pref-overview-compact', 'Compact — the {{manuscript}} overview keeps only the manifest structure plus entity/source/note counts, dropping the expanded listings.')
      ],
      description: nls.localize('ai-focused-editor/chat-context/pref-overview-desc', 'How much the {{manuscript}} whole-project overview includes. "full" lists every entity card and source file; "compact" keeps only the manifest structure skeleton and entity/source/note counts. Compact trims the always-on agent context for large books.')
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
    },
    [AI_FOCUSED_EDITOR_LIBRARY_PATH]: {
      type: 'string',
      default: '',
      scope: PreferenceScope.User,
      description: nls.localize('ai-focused-editor/ai-config/pref-library-path-desc', 'Folder that holds your books. When set, the welcome page shows a "My Books" catalog built by scanning this folder\'s immediate subfolders (one or two levels deep) for book folders (a folder containing manifest.yaml). Leave empty to hide the catalog. Set it from the welcome page with "Choose books folder...".')
    },
    [MEDIA_TRANSCRIPTION_FFMPEG_PATH]: {
      type: 'string',
      default: '',
      scope: PreferenceScope.User,
      description: nls.localize('ai-focused-editor/media-transcription/pref-ffmpeg-path-desc', 'Absolute path to the ffmpeg binary used by media transcription. Leave empty to use "ffmpeg" from PATH. Install with "brew install ffmpeg" on macOS.')
    },
    [MEDIA_TRANSCRIPTION_FFPROBE_PATH]: {
      type: 'string',
      default: '',
      scope: PreferenceScope.User,
      description: nls.localize('ai-focused-editor/media-transcription/pref-ffprobe-path-desc', 'Absolute path to the ffprobe binary used by media transcription. Leave empty to use "ffprobe" from PATH (ffprobe ships with ffmpeg).')
    },
    [MEDIA_TRANSCRIPTION_WHISPER_CLI_PATH]: {
      type: 'string',
      default: '',
      scope: PreferenceScope.User,
      description: nls.localize('ai-focused-editor/media-transcription/pref-whisper-cli-desc', 'Absolute path to whisper.cpp\'s whisper-cli binary (<whisper.cpp>/build/bin/whisper-cli) for the local transcription backend. Run the media-transcription doctor to verify.')
    },
    [MEDIA_TRANSCRIPTION_MODEL_PATH]: {
      type: 'string',
      default: '',
      scope: PreferenceScope.User,
      description: nls.localize('ai-focused-editor/media-transcription/pref-model-path-desc', 'Absolute path to the whisper ggml model file (models/ggml-<name>.bin) for the local transcription backend. Download one with whisper.cpp\'s models/download-ggml-model.sh.')
    },
    [MEDIA_TRANSCRIPTION_LANGUAGE]: {
      type: 'string',
      default: '',
      description: nls.localize('ai-focused-editor/media-transcription/pref-language-desc', 'Language hint for speech recognition (e.g. "ru", "en"). Leave empty for automatic detection.')
    },
    [MEDIA_TRANSCRIPTION_THREADS]: {
      type: 'number',
      default: 8,
      minimum: 1,
      description: nls.localize('ai-focused-editor/media-transcription/pref-threads-desc', 'Number of CPU threads for the local whisper transcription (whisper-cli -t).')
    },
    [MEDIA_TRANSCRIPTION_BACKEND]: {
      type: 'string',
      enum: ['local', 'groq'],
      default: 'local',
      description: nls.localize('ai-focused-editor/media-transcription/pref-backend-desc', 'Transcription backend: "local" runs whisper.cpp on this machine; "groq" sends the audio segments to the Groq API (requires an API key).')
    },
    [MEDIA_TRANSCRIPTION_GROQ_MODEL]: {
      type: 'string',
      default: 'whisper-large-v3-turbo',
      description: nls.localize('ai-focused-editor/media-transcription/pref-groq-model-desc', 'Groq transcription model (e.g. whisper-large-v3-turbo or whisper-large-v3).')
    },
    [MEDIA_TRANSCRIPTION_GROQ_API_KEY]: {
      type: 'string',
      default: '',
      scope: PreferenceScope.User,
      description: nls.localize('ai-focused-editor/media-transcription/pref-groq-key-desc', 'Groq API key (secret — stored in user settings, never logged). Comma-separate multiple keys to rotate on rate limits. Get a key at https://console.groq.com.')
    },
    [MEDIA_TRANSCRIPTION_SEGMENT_SECONDS]: {
      type: 'number',
      default: 600,
      minimum: 60,
      description: nls.localize('ai-focused-editor/media-transcription/pref-segment-seconds-desc', 'Target segment length in seconds for silence-aligned splitting of long recordings (cuts snap to the last silence in each bucket).')
    }
  }
};

export const AiFocusedEditorPreferenceContribution: PreferenceContribution = {
  schema: aiFocusedEditorPreferenceSchema
};
