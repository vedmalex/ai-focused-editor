import {
  Command,
  CommandContribution,
  CommandRegistry,
  MenuContribution,
  MenuModelRegistry,
  QuickInputService,
  QuickPickItem
} from '@theia/core/lib/common';
import { nls } from '@theia/core/lib/common/nls';
import { PreferenceService } from '@theia/core/lib/common/preferences';
import { inject, injectable } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { FrontendApplicationStateService } from '@theia/core/lib/browser/frontend-application-state';
import { ThemeService } from '@theia/core/lib/browser/theming';
import { AiFocusedEditorMenus } from './ai-focused-editor-menu';
import { resolveDeviceTheme } from '../common/device-theme';

/**
 * localStorage key holding this device's theme override id. Device-local by
 * design: it is NEVER written into the shared `workbench.colorTheme` preference.
 */
export const DEVICE_THEME_STORAGE_KEY = 'aiFocusedEditor.deviceTheme';

/** The shared `workbench.colorTheme` preference key. */
const COLOR_THEME_PREFERENCE_KEY = 'workbench.colorTheme';

/**
 * Best-contrast bundled dark theme, used for the `?theme=dark` alias and for
 * system-dark following (see `bundled-color-themes-frontend-module.ts`).
 */
export const DEVICE_DARK_DEFAULT = 'one-dark-pro';
/** The app's own light default theme id (Theia built-in "Light"). */
export const DEVICE_LIGHT_DEFAULT = 'light';

/** Sentinel picked to clear the device override and follow the shared settings. */
const FOLLOW_SETTINGS_ITEM_ID = '__follow-settings__';

export namespace DeviceThemeCommands {
  export const OPEN: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.appearance.deviceTheme',
      label: 'Theme on This Device...',
      iconClass: 'codicon codicon-color-mode'
    },
    'ai-focused-editor/mobile/device-theme'
  );
}

interface ThemePickItem extends QuickPickItem {
  /** Theme id, or the follow-settings sentinel. */
  readonly themeId: string;
}

/**
 * Per-device color-theme override.
 *
 * Because phone and desktop share ONE backend, `workbench.colorTheme` is a
 * SHARED preference — restyling the phone via the normal Color Theme picker
 * would restyle the desktop too. This contribution layers a per-DEVICE override
 * (persisted only in this browser's localStorage) over {@link ThemeService}
 * WITHOUT persisting into the shared preference (`setCurrentTheme(id, false)`).
 *
 * On start it resolves the override from `?theme=`, the stored override, and
 * the OS `prefers-color-scheme` (see {@link resolveDeviceTheme}), applies it,
 * strips the URL param, and installs listeners that keep the override asserted
 * when the shared preference changes and re-follow the system live.
 */
@injectable()
export class DeviceThemeContribution implements FrontendApplicationContribution, CommandContribution, MenuContribution {

  @inject(ThemeService)
  protected readonly themeService!: ThemeService;

  @inject(PreferenceService)
  protected readonly preferences!: PreferenceService;

  @inject(QuickInputService)
  protected readonly quickInput!: QuickInputService;

  @inject(FrontendApplicationStateService)
  protected readonly stateService!: FrontendApplicationStateService;

  /**
   * Theme id we actively keep applied over the shared preference, or `undefined`
   * when there is no device override (the app default is left in charge).
   */
  protected enforcedThemeId: string | undefined;

  /**
   * Whether we are following the OS `prefers-color-scheme` (no explicit device
   * override and no explicit user preference). Drives the matchMedia listener.
   */
  protected followSystem = false;

  /** Re-entrancy guard so our own `setCurrentTheme` does not recurse. */
  protected applying = false;

  onStart(): void {
    // Read + strip the URL param SYNCHRONOUSLY (before anything rewrites the
    // URL), but defer resolution/application until all onStart contributions
    // ran: the bundled color themes register in ANOTHER contribution's onStart
    // (bundled-color-themes-frontend-module.ts) and the order between the two
    // is nondeterministic — resolving earlier would not find their ids.
    const param = this.readAndStripThemeParam();
    void this.stateService.reachedState('started_contributions')
      .then(() => this.initializeDeviceTheme(param))
      .catch(() => { /* a failed override just leaves the app default theme */ });
  }

  protected initializeDeviceTheme(param: string | undefined): void {
    try {
      const stored = this.readStored();
      const resolution = resolveDeviceTheme({
        param,
        stored,
        systemDark: this.systemPrefersDark(),
        userThemeSet: this.userThemeSet(),
        availableIds: this.availableIds(),
        darkDefault: DEVICE_DARK_DEFAULT,
        lightDefault: DEVICE_LIGHT_DEFAULT
      });
      this.persistStore(resolution.store);
      this.followSystem =
        resolution.source !== 'param' && resolution.source !== 'stored' && !this.userThemeSet();
      this.enforcedThemeId = resolution.themeId;
      if (resolution.themeId) {
        this.applyTheme(resolution.themeId);
      }

      // Re-assert the device override if the shared preference (or anything
      // else) later flips the active theme away from what this device wants.
      // Comparing ids guards against an infinite loop: our own re-apply fires
      // onDidColorThemeChange, but then newTheme.id === enforcedThemeId → skip.
      this.themeService.onDidColorThemeChange(event => {
        if (this.applying || !this.enforcedThemeId) {
          return;
        }
        if (event.newTheme.id !== this.enforcedThemeId) {
          this.applyTheme(this.enforcedThemeId);
        }
      });

      // Live-follow the system while we have no explicit override.
      this.installSystemThemeListener();
    } catch {
      // Never let theming break frontend start — a failed override just leaves
      // the app default theme in place.
    }
  }

  registerCommands(registry: CommandRegistry): void {
    registry.registerCommand(DeviceThemeCommands.OPEN, {
      execute: () => this.pickDeviceTheme()
    });
  }

  registerMenus(menus: MenuModelRegistry): void {
    menus.registerMenuAction(AiFocusedEditorMenus.MAIN, {
      commandId: DeviceThemeCommands.OPEN.id,
      // Right after Writing Mode ('1_writing-mode'), before the sub-menus.
      order: '1_writing-mode-2-appearance'
    });
  }

  /** Interactive picker: all color themes + a "follow settings" escape hatch. */
  protected async pickDeviceTheme(): Promise<void> {
    const current = this.themeService.getCurrentTheme();
    const followItem: ThemePickItem = {
      label: nls.localize('ai-focused-editor/mobile/device-theme-follow', '$(settings-gear) Follow settings (clear device override)'),
      themeId: FOLLOW_SETTINGS_ITEM_ID
    };
    const themeItems: ThemePickItem[] = this.themeService
      .getThemes()
      .slice()
      .sort((a, b) => a.label.localeCompare(b.label))
      .map(theme => ({
        label: `${theme.id === current.id ? '$(check) ' : ''}${theme.label}`,
        description: theme.id,
        themeId: theme.id
      }));

    const picked = await this.quickInput.showQuickPick([followItem, ...themeItems], {
      title: nls.localize('ai-focused-editor/mobile/device-theme-title', 'Theme on This Device'),
      placeholder: nls.localize(
        'ai-focused-editor/mobile/device-theme-placeholder',
        'Applies only to this device — does not change the shared settings'
      )
    });
    if (!picked) {
      return;
    }
    if (picked.themeId === FOLLOW_SETTINGS_ITEM_ID) {
      this.clearOverride();
      return;
    }
    this.setOverride(picked.themeId);
  }

  /** Persist a device override and apply it (no shared-preference write). */
  protected setOverride(themeId: string): void {
    try {
      window.localStorage.setItem(DEVICE_THEME_STORAGE_KEY, themeId);
    } catch {
      // best-effort persistence
    }
    this.followSystem = false;
    this.enforcedThemeId = themeId;
    this.applyTheme(themeId);
  }

  /** Remove the device override and fall back to the shared preference theme. */
  protected clearOverride(): void {
    try {
      window.localStorage.removeItem(DEVICE_THEME_STORAGE_KEY);
    } catch {
      // best-effort
    }
    this.enforcedThemeId = undefined;
    this.followSystem = !this.userThemeSet();
    // Re-resolve from the (now overrideless) signals so we either follow the
    // system or hand control back to the shared preference theme.
    const resolution = resolveDeviceTheme({
      stored: undefined,
      systemDark: this.systemPrefersDark(),
      userThemeSet: this.userThemeSet(),
      availableIds: this.availableIds(),
      darkDefault: DEVICE_DARK_DEFAULT,
      lightDefault: DEVICE_LIGHT_DEFAULT
    });
    if (resolution.themeId) {
      this.enforcedThemeId = resolution.themeId;
      this.applyTheme(resolution.themeId);
    } else {
      this.applyTheme(this.sharedThemeId());
    }
  }

  /**
   * Apply a theme WITHOUT persisting into the shared `workbench.colorTheme`
   * preference — the whole point of a per-device override. Wrapped by the
   * re-entrancy guard so the resulting change event does not re-enter.
   */
  protected applyTheme(themeId: string): void {
    if (this.themeService.getCurrentTheme().id === themeId) {
      return;
    }
    this.applying = true;
    try {
      this.themeService.setCurrentTheme(themeId, false);
    } finally {
      this.applying = false;
    }
  }

  /** The theme the shared preference / app default would show without us. */
  protected sharedThemeId(): string {
    const inspection = this.preferences.inspect<string>(COLOR_THEME_PREFERENCE_KEY);
    return (
      inspection?.globalValue ??
      inspection?.workspaceValue ??
      inspection?.defaultValue ??
      this.themeService.defaultTheme.id
    );
  }

  protected installSystemThemeListener(): void {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (event: MediaQueryListEvent): void => {
      if (!this.followSystem) {
        return;
      }
      const resolution = resolveDeviceTheme({
        stored: undefined,
        systemDark: event.matches,
        userThemeSet: this.userThemeSet(),
        availableIds: this.availableIds(),
        darkDefault: DEVICE_DARK_DEFAULT,
        lightDefault: DEVICE_LIGHT_DEFAULT
      });
      if (resolution.themeId) {
        this.enforcedThemeId = resolution.themeId;
        this.applyTheme(resolution.themeId);
      } else {
        // System went light: drop the override, hand back to the app default.
        this.enforcedThemeId = undefined;
        this.applyTheme(this.sharedThemeId());
      }
    };
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', handler);
    } else if (typeof media.addListener === 'function') {
      // Safari < 14 fallback.
      media.addListener(handler);
    }
  }

  /** Read `?theme=` and strip it from the URL so copied links stay clean. */
  protected readAndStripThemeParam(): string | undefined {
    if (typeof window === 'undefined' || !window.location) {
      return undefined;
    }
    let param: string | undefined;
    try {
      const url = new URL(window.location.href);
      param = url.searchParams.get('theme') ?? undefined;
      if (param !== undefined && typeof window.history?.replaceState === 'function') {
        url.searchParams.delete('theme');
        window.history.replaceState(null, '', url.toString());
      }
    } catch {
      return undefined;
    }
    return param;
  }

  protected readStored(): string | undefined {
    try {
      return window.localStorage.getItem(DEVICE_THEME_STORAGE_KEY) ?? undefined;
    } catch {
      return undefined;
    }
  }

  protected persistStore(store: string | null | undefined): void {
    if (store === undefined) {
      return;
    }
    try {
      if (store === null) {
        window.localStorage.removeItem(DEVICE_THEME_STORAGE_KEY);
      } else {
        window.localStorage.setItem(DEVICE_THEME_STORAGE_KEY, store);
      }
    } catch {
      // best-effort
    }
  }

  protected systemPrefersDark(): boolean {
    try {
      return typeof window !== 'undefined'
        && typeof window.matchMedia === 'function'
        && window.matchMedia('(prefers-color-scheme: dark)').matches;
    } catch {
      return false;
    }
  }

  /** True when the user explicitly set a theme (user or workspace scope). */
  protected userThemeSet(): boolean {
    const inspection = this.preferences.inspect<string>(COLOR_THEME_PREFERENCE_KEY);
    return inspection?.globalValue !== undefined || inspection?.workspaceValue !== undefined;
  }

  protected availableIds(): string[] {
    return this.themeService.getThemes().map(theme => theme.id);
  }
}
