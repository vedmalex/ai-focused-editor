import { injectable, inject } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { PreferenceService } from '@theia/core/lib/common/preferences';
import { LanguageModelAliasRegistry } from '@theia/ai-core/lib/common/language-model-alias';
import { AiConnectTheiaLanguageModel } from './ai-connect-theia-language-model';
import { planDefaultAliasUpdates } from '../common/default-alias-plan';
import { AI_CONNECT_PROVIDE_DEFAULT_MODELS } from './ai-connect-preferences';

/**
 * Makes Theia AI agents work with ai-connect OUT OF THE BOX.
 *
 * Agents resolve their models through `default/*` aliases, which Theia seeds
 * with official provider ids only (anthropic/openai/google) — without keys for
 * those, every agent fails with "Couldn't find a ready language model". This
 * contribution prepends the always-ready ai-connect current-alias model to
 * each `default/*` alias, so any agent runs through the active alias unless
 * the user maps something else explicitly (the AI Configuration pick —
 * `selectedModelId` — always wins and is never touched here).
 *
 * Gated by the `aiConnect.provideDefaultModels` preference (default: on);
 * disabling it removes our id from the default lists again.
 */
@injectable()
export class AiConnectDefaultModelsContribution implements FrontendApplicationContribution {

  @inject(LanguageModelAliasRegistry)
  protected readonly aliasRegistry!: LanguageModelAliasRegistry;

  @inject(PreferenceService)
  protected readonly preferences!: PreferenceService;

  onStart(): void {
    void this.preferences.ready
      .then(() => this.aliasRegistry.ready)
      .then(() => {
        this.apply();
        this.preferences.onPreferenceChanged(event => {
          if (event.preferenceName === AI_CONNECT_PROVIDE_DEFAULT_MODELS) {
            this.apply();
          }
        });
      })
      .catch(() => { /* agents just stay unmapped — never break startup */ });
  }

  protected apply(): void {
    const enabled = this.preferences.get<boolean>(AI_CONNECT_PROVIDE_DEFAULT_MODELS, true);
    const updates = planDefaultAliasUpdates(
      this.aliasRegistry.getAliases(),
      AiConnectTheiaLanguageModel.ID,
      enabled
    );
    for (const alias of updates) {
      this.aliasRegistry.addAlias(alias);
    }
  }
}
