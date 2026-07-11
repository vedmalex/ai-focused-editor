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
import aiConfigRu from './ru/ai-config.json';
import aiLogRu from './ru/ai-log.json';
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
import mcpRu from './ru/mcp.json';

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
  createRu, buildRu, bookConfigRu, sourcesRu, entitiesRu,
  aiConfigRu, aiLogRu, aiModesRu, editorRu, doctorRu, welcomeRu,
  workspaceRu, knowledgeRu, gitRu, chatCapabilitiesRu, chatContextRu, officeRu,
];

@injectable()
export class ManuscriptRuLocalizationContribution implements LocalizationContribution {
  async registerLocalizations(registry: LocalizationRegistry): Promise<void> {
    for (const bundle of AREA_BUNDLES) {
      registry.registerLocalizationFromRequire(RU, bundle);
    }
  }
}
