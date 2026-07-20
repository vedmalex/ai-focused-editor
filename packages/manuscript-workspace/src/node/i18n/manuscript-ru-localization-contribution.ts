import { injectable } from '@theia/core/shared/inversify';
import type { LanguageInfo } from '@theia/core/lib/common/i18n/localization';
import {
  LocalizationContribution,
  LocalizationRegistry
} from '@theia/core/lib/node/i18n/localization-contribution';

// Each area owns its OWN JSON file under ./ru/<area>.json so parallel agents
// never touch the same file. To add a new area: drop ./ru/<area>.json, add an
// import below, and push it into AREA_BUNDLES. Nothing else changes.
import manuscriptTreeRu from './ru/manuscript-tree.json';
import menuRu from './ru/menu.json';
import createRu from './ru/create.json';
import buildRu from './ru/build.json';
import bookConfigRu from './ru/book-config.json';
import sourcesRu from './ru/sources.json';
import entitiesRu from './ru/entities.json';
import entityTypesRu from './ru/entity-types.json';
import aiConfigRu from './ru/ai-config.json';
import aiModesRu from './ru/ai-modes.json';
import editorRu from './ru/editor.json';
import doctorRu from './ru/doctor.json';
import welcomeRu from './ru/welcome.json';
import workspaceRu from './ru/workspace.json';
import knowledgeRu from './ru/knowledge.json';
import gitRu from './ru/git.json';
import chatCapabilitiesRu from './ru/chat-capabilities.json';
import chatContextRu from './ru/chat-context.json';
import officeRu from './ru/office.json';
import excalidrawRu from './ru/excalidraw.json';
import imageViewerRu from './ru/image-viewer.json';
import mediaViewerRu from './ru/media-viewer.json';
import proofreadingRu from './ru/proofreading.json';
import transcriptCheckRu from './ru/transcript-check.json';
import transcriptionSettingsRu from './ru/transcription-settings.json';
import mcpRu from './ru/mcp.json';
import authRu from './ru/auth.json';
import mobileRu from './ru/mobile.json';
import fileDialogRu from './ru/file-dialog.json';

/**
 * Language descriptor for our Russian dictionary.
 *
 * `languagePack: true` is REQUIRED. The frontend i18n preloader
 * (@theia/core .../preload/i18n-preload-contribution) only assigns
 * `nls.localization` (i.e. actually applies translations) when the merged
 * localization reports `languagePack: true`; otherwise it resets the locale
 * back to the default. Because @theia/core's node localization provider merges
 * ALL localizations sharing a `languageId` and folds `languagePack ||= ...`,
 * registering ru with this flag also unlocks core's own bundled ru strings
 * (i18n/nls.ru.json) — see the research notes on partial-ru coverage.
 */
const RU: LanguageInfo = {
  languageId: 'ru',
  languageName: 'Russian',
  localizedLanguageName: 'Русский',
  languagePack: true
};

// Explicit enumeration — the merge is order-independent because each bundle
// carries its full `ai-focused-editor/<area>/...` key path (see i18n/README.md).
const AREA_BUNDLES: unknown[] = [
  manuscriptTreeRu, menuRu,
  createRu, buildRu, bookConfigRu, sourcesRu, entitiesRu, entityTypesRu,
  aiConfigRu, aiModesRu, editorRu, doctorRu, welcomeRu,
  workspaceRu, knowledgeRu, gitRu, chatCapabilitiesRu, chatContextRu, officeRu,
  excalidrawRu, imageViewerRu, mediaViewerRu, proofreadingRu, transcriptCheckRu, transcriptionSettingsRu,
  mobileRu, mcpRu, authRu, fileDialogRu
];

@injectable()
export class ManuscriptRuLocalizationContribution implements LocalizationContribution {
  async registerLocalizations(registry: LocalizationRegistry): Promise<void> {
    for (const bundle of AREA_BUNDLES) {
      registry.registerLocalizationFromRequire(RU, bundle);
    }
  }
}
