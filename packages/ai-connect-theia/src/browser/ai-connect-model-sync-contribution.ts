import { LanguageModelRegistry } from '@theia/ai-core';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { PreferenceService } from '@theia/core/lib/common/preferences';
import { inject, injectable } from '@theia/core/shared/inversify';
import { diffAliasModels, isAliasModelId } from '../common';
import {
  AI_CONNECT_ALIASES,
  LEGACY_AI_ALIASES
} from './ai-connect-preferences';
import { AiConnectAliasModelFactory } from './ai-connect-alias-language-model';
import { AiProfilePreferenceService } from './ai-profile-preference-service';

/** Preference keys whose change alters the alias LIST (not just the active one). */
const ALIAS_LIST_PREFERENCES: ReadonlySet<string> = new Set([AI_CONNECT_ALIASES, LEGACY_AI_ALIASES]);

/**
 * Keeps one LanguageModel per ai-connect alias registered in the Theia AI
 * registry. On start and on every alias-list preference change it reconciles
 * the registry via {@link diffAliasModels}: new aliases get a pinned model
 * added, removed aliases get their model disposed. The back-compat
 * current-alias model (`ai-focused-editor.ai-connect`, registered via
 * LanguageModelProvider) is never touched — its id is not an alias-model id.
 */
@injectable()
export class AiConnectModelSyncContribution implements FrontendApplicationContribution {
  @inject(LanguageModelRegistry)
  protected readonly registry!: LanguageModelRegistry;

  @inject(AiProfilePreferenceService)
  protected readonly aiProfilePreferences!: AiProfilePreferenceService;

  @inject(PreferenceService)
  protected readonly preferenceService!: PreferenceService;

  @inject(AiConnectAliasModelFactory)
  protected readonly createAliasModel!: AiConnectAliasModelFactory;

  /** Reconciles run one-at-a-time so concurrent triggers cannot double-register. */
  protected pending: Promise<void> = Promise.resolve();

  onStart(): void {
    this.schedule();
    this.preferenceService.onPreferenceChanged(event => {
      if (ALIAS_LIST_PREFERENCES.has(event.preferenceName)) {
        this.schedule();
      }
    });
  }

  /** Queue a reconcile after any in-flight one; swallow errors (best-effort sync). */
  protected schedule(): void {
    this.pending = this.pending
      .catch(() => undefined)
      .then(() => this.reconcile())
      .catch(error => console.error('[ai-connect] alias model sync failed', error));
  }

  protected async reconcile(): Promise<void> {
    const aliases = await this.aiProfilePreferences.listAliases();
    const labelByAlias = new Map(aliases.map(alias => [alias.id, alias.label]));

    const models = await this.registry.getLanguageModels();
    const currentAliasIds = models.map(model => model.id).filter(isAliasModelId);

    const diff = diffAliasModels(currentAliasIds, aliases.map(alias => alias.id));

    if (diff.toAdd.length > 0) {
      const added = diff.toAdd.map(({ alias }) => this.createAliasModel(alias, labelByAlias.get(alias)));
      this.registry.addLanguageModels(added);
    }
    if (diff.toRemove.length > 0) {
      this.registry.removeLanguageModels(diff.toRemove);
    }
  }
}
