import { ContainerModule, inject, injectable } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { ILogger } from '@theia/core/lib/common/logger';
import { MonacoThemingService } from '@theia/monaco/lib/browser/monaco-theming-service';
import type * as monaco from '@theia/monaco-editor-core';

type BuiltinTheme = monaco.editor.BuiltinTheme;

import draculaJson from './themes/dracula.json';
import nordJson from './themes/nord.json';
import oneDarkProJson from './themes/one-dark-pro.json';
import solarizedLightJson from './themes/solarized-light.json';
import gruvboxDarkMediumJson from './themes/gruvbox-dark-medium.json';

/**
 * A bundled, vendored VS Code color theme ready to hand to
 * {@link MonacoThemingService.registerParsedTheme}.
 *
 * `json` is the already-parsed theme object (imported directly, inlined into
 * the frontend bundle by esbuild's json loader), so no runtime file read or
 * URI resolution is needed — the "object route" of the Monaco theming API.
 */
interface BundledTheme {
  /** Stable theme id + css selector base (see {@link MonacoThemingService}). */
  readonly id: string;
  /** Label shown in the `File > Settings > Color Theme` quick pick. */
  readonly label: string;
  /** `vs` (light base), `vs-dark` (dark base), etc. */
  readonly uiTheme: BuiltinTheme;
  /** Parsed VS Code color-theme document (`colors` + `tokenColors`). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly json: any;
}

/**
 * Vendored open-source themes bundled with the editor. Each JSON file is the
 * upstream artifact (see `themes/THEMES.md` for source URLs, versions and
 * licenses — all MIT). Order here is the order they are registered in.
 */
export const BUNDLED_THEMES: readonly BundledTheme[] = [
  { id: 'dracula', label: 'Dracula', uiTheme: 'vs-dark', json: draculaJson },
  { id: 'nord', label: 'Nord', uiTheme: 'vs-dark', json: nordJson },
  { id: 'one-dark-pro', label: 'One Dark Pro', uiTheme: 'vs-dark', json: oneDarkProJson },
  { id: 'solarized-light', label: 'Solarized Light', uiTheme: 'vs', json: solarizedLightJson },
  { id: 'gruvbox-dark-medium', label: 'Gruvbox Dark Medium', uiTheme: 'vs-dark', json: gruvboxDarkMediumJson }
];

/**
 * Registers the bundled color themes the Theia-native way: through
 * {@link MonacoThemingService.registerParsedTheme}, which feeds both the Monaco
 * token-color registry and the core `ThemeService` so each theme shows up in the
 * `Color Theme` quick pick (`workbench.action.selectTheme`).
 *
 * Registration happens in `onStart` — once the DI container is fully built and
 * Monaco's built-in base themes (`vs` / `vs-dark`) are available — rather than
 * at module load, because the 1.73 API is instance-based. The default
 * light/dark theme is deliberately left unchanged; these are purely additive.
 */
@injectable()
export class BundledColorThemesContribution implements FrontendApplicationContribution {
  @inject(MonacoThemingService)
  protected readonly monacoThemingService!: MonacoThemingService;

  @inject(ILogger)
  protected readonly logger!: ILogger;

  onStart(): void {
    for (const theme of BUNDLED_THEMES) {
      try {
        this.monacoThemingService.registerParsedTheme({
          id: theme.id,
          label: theme.label,
          uiTheme: theme.uiTheme,
          json: theme.json
        });
      } catch (e) {
        this.logger.error(`Failed to register bundled color theme '${theme.label}'`, e);
      }
    }
  }
}

export default new ContainerModule(bind => {
  bind(BundledColorThemesContribution).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(BundledColorThemesContribution);
});
