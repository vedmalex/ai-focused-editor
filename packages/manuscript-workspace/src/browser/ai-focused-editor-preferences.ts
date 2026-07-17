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
    }
  }
};

export const AiFocusedEditorPreferenceContribution: PreferenceContribution = {
  schema: aiFocusedEditorPreferenceSchema
};
