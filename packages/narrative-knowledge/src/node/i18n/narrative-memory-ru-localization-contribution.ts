import { injectable } from '@theia/core/shared/inversify';
import type { LanguageInfo } from '@theia/core/lib/common/i18n/localization';
import {
  LocalizationContribution,
  LocalizationRegistry
} from '@theia/core/lib/node/i18n/localization-contribution';

import narrativeMemoryRu from './ru/narrative-memory.json';

/**
 * Russian dictionary for the strings this package owns (TASK-022 WP-5).
 *
 * THE PACKAGE OWNS ITS OWN BUNDLE, and the precedent is deliberate rather than
 * incidental: `ai-connect-theia` registers three of its own from
 * `src/node/i18n/ru/` through `AiConnectRuLocalizationContribution`, bound in
 * `ai-connect-backend-module.ts:47-48`. Putting these phrases in the workspace
 * package's dictionary instead would give a package this one must not import
 * (prohibition (f)) a piece of this package's behaviour.
 *
 * WHY IT IS A NODE CONTRIBUTION FOR STRINGS A FRONTEND RENDERS. Theia collects
 * localizations on the backend and ships the resolved bundle to the frontend;
 * `languagePack: true` is what makes the frontend actually apply them, and its
 * absence is a silent failure — every phrase falls back to the English default
 * at the call site, which is precisely the shape ISS-258 shipped into a
 * Russian-first product with every test green.
 *
 * The JSON file itself was created by WP-1, because the "every
 * `IndexFailureCode` has a phrase" tooth was assigned there (ОВ-8 tooth 3). It
 * had no registration until now: a bundle nothing binds is a file, not a
 * translation.
 */
const RU: LanguageInfo = {
  languageId: 'ru',
  languageName: 'Russian',
  localizedLanguageName: 'Русский',
  languagePack: true
};

@injectable()
export class NarrativeMemoryRuLocalizationContribution implements LocalizationContribution {
  async registerLocalizations(registry: LocalizationRegistry): Promise<void> {
    registry.registerLocalizationFromRequire(RU, narrativeMemoryRu);
  }
}
