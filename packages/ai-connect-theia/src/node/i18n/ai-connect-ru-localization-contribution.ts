import { injectable } from '@theia/core/shared/inversify';
import type { LanguageInfo } from '@theia/core/lib/common/i18n/localization';
import {
  LocalizationContribution,
  LocalizationRegistry
} from '@theia/core/lib/node/i18n/localization-contribution';

import aiConfigRu from './ru/ai-config.json';
import aiLogRu from './ru/ai-log.json';
import aiUsageRu from './ru/ai-usage.json';

/**
 * Russian dictionary for the strings owned by the ai-connect package
 * (connection/config UI + request log). Mirrors the manuscript-workspace
 * localization contribution pattern; `languagePack: true` is required so the
 * frontend actually applies the translations. Key ids are unchanged from before
 * the extraction so there is no string churn.
 */
const RU: LanguageInfo = {
  languageId: 'ru',
  languageName: 'Russian',
  localizedLanguageName: 'Русский',
  languagePack: true
};

const AREA_BUNDLES: unknown[] = [aiConfigRu, aiLogRu, aiUsageRu];

@injectable()
export class AiConnectRuLocalizationContribution implements LocalizationContribution {
  async registerLocalizations(registry: LocalizationRegistry): Promise<void> {
    for (const bundle of AREA_BUNDLES) {
      registry.registerLocalizationFromRequire(RU, bundle);
    }
  }
}
