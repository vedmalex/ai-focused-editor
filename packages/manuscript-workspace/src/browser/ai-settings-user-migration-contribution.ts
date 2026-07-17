import { inject, injectable } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import { MessageService } from '@theia/core/lib/common/message-service';
import { nls } from '@theia/core/lib/common/nls';
import { PreferenceScope, PreferenceService } from '@theia/core/lib/common/preferences';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { migrateAiSettingsText, scanLegacyAiSettings } from '../common/ai-settings-migration';

/**
 * One-time, on-start migration of the retired `aiFocusedEditor.ai.*` keys in the
 * USER settings file to their neutral `aiConnect.*` twins.
 *
 * Theia 1.73 note (verified against `@theia/core` `PreferenceServiceImpl` +
 * `@theia/core`'s `PreferenceProviderImpl.getParsedContent`): a resource
 * preference provider stores the FULL parsed `settings.json` map WITHOUT
 * filtering by the registered schema, and `PreferenceService.inspect`/`get` read
 * straight from that map — so a value under an unregistered key (like our removed
 * legacy keys) IS still served through `PreferenceService.inspect(...).globalValue`.
 *
 * We nonetheless migrate by REWRITING the user `settings.json` FILE directly
 * (located via `getConfigUri(User)`), because: (a) it preserves the file's
 * comments/formatting and touches only the migrated keys (jsonc-parser surgical
 * edits), and (b) it avoids `PreferenceService.set` on now-unregistered keys.
 * This is idempotent, and never destructive — the neutral twin is written before
 * the legacy key is removed. A malformed settings file is left untouched.
 */
@injectable()
export class AiSettingsUserMigrationContribution implements FrontendApplicationContribution {
  @inject(PreferenceService)
  protected readonly preferenceService!: PreferenceService;

  @inject(FileService)
  protected readonly fileService!: FileService;

  @inject(MessageService)
  protected readonly messageService!: MessageService;

  async onStart(): Promise<void> {
    // Best-effort: a migration hiccup must never block application startup.
    try {
      await this.migrateUserSettings();
    } catch {
      /* ignore — the doctor can still migrate the workspace file on demand */
    }
  }

  protected async migrateUserSettings(): Promise<void> {
    await this.preferenceService.ready;
    const configUri = this.preferenceService.getConfigUri(PreferenceScope.User);
    if (!configUri) {
      return;
    }
    if (!(await this.fileService.exists(configUri))) {
      return;
    }
    const text = (await this.fileService.read(configUri)).value;
    const scan = scanLegacyAiSettings(text);
    // Nothing to migrate, or a malformed file we must not rewrite.
    if (scan.malformed || scan.legacyKeys.length === 0) {
      return;
    }
    const result = migrateAiSettingsText(text);
    if (!result.ok || !result.changed) {
      return;
    }
    await this.fileService.write(configUri, result.text);
    await this.messageService.info(nls.localize(
      'ai-focused-editor/ai-config/settings-migrated',
      'AI settings migrated to aiConnect.*'
    ));
  }
}
