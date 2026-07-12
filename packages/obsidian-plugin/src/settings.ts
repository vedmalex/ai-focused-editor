/**
 * Settings tab: the YAML-card-view toggle (with its vault-wide warning), the
 * books-folder override, and the plugin UI language. Changes persist via the
 * plugin's `saveSettings`, which re-applies language + re-registers the YAML view.
 */

import { PluginSettingTab, Setting, type App } from 'obsidian';
import type { AfeCompanionPlugin } from './main';

export class AfeSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: AfeCompanionPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const t = this.plugin.t;

    new Setting(containerEl)
      .setName(t('settings.yamlView.name'))
      .setDesc(t('settings.yamlView.desc'))
      .addToggle(toggle =>
        toggle.setValue(this.plugin.settings.yamlCardView).onChange(async value => {
          this.plugin.settings.yamlCardView = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName(t('settings.booksFolder.name'))
      .setDesc(t('settings.booksFolder.desc'))
      .addText(text =>
        text
          .setPlaceholder('books')
          .setValue(this.plugin.settings.booksFolder)
          .onChange(async value => {
            this.plugin.settings.booksFolder = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t('settings.language.name'))
      .setDesc(t('settings.language.desc'))
      .addDropdown(dropdown =>
        dropdown
          .addOption('auto', t('settings.language.auto'))
          .addOption('ru', 'Русский')
          .addOption('en', 'English')
          .setValue(this.plugin.settings.lang)
          .onChange(async value => {
            this.plugin.settings.lang = value as 'auto' | 'ru' | 'en';
            await this.plugin.saveSettings();
            this.display();
          })
      );
  }
}
