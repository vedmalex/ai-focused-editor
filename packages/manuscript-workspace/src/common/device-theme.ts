/**
 * Per-device color-theme override resolution (pure, environment-free).
 *
 * The browser editor is served over the LAN to phones/tablets that share ONE
 * backend with the desktop, so the `workbench.colorTheme` user preference is
 * SHARED — changing it on the phone would restyle the desktop too. This module
 * computes a per-DEVICE override (persisted in the browser's own localStorage)
 * that is layered over `ThemeService` WITHOUT ever touching the shared
 * preference. See `browser/device-theme-contribution.ts` for the wiring.
 *
 * Kept as a pure function (no DOM, no ThemeService, no window) so it is unit
 * testable and the contribution stays a thin adapter around it.
 */

/** The `?theme=` alias that maps to the resolved dark default. */
export const DEVICE_THEME_ALIAS_DARK = 'dark';
/** The `?theme=` alias that maps to the resolved light default. */
export const DEVICE_THEME_ALIAS_LIGHT = 'light';

/**
 * Where the resolved device theme came from:
 * - `param`  — a `?theme=` URL parameter (highest precedence; also persisted).
 * - `stored` — a previously persisted per-device override still valid.
 * - `system` — following the OS `prefers-color-scheme` (dark only; see below).
 * - `none`   — no override; keep the app default theme untouched.
 */
export type DeviceThemeSource = 'param' | 'stored' | 'system' | 'none';

export interface DeviceThemeInput {
  /** Raw `?theme=` URL param value, if present. */
  readonly param?: string;
  /** Currently persisted per-device override id, if any. */
  readonly stored?: string;
  /** `matchMedia('(prefers-color-scheme: dark)').matches`. */
  readonly systemDark: boolean;
  /**
   * Whether the user has EXPLICITLY set `workbench.colorTheme` (user or
   * workspace scope). When true, system-following is suppressed — an explicit
   * choice wins over the OS hint.
   */
  readonly userThemeSet: boolean;
  /** Ids of the themes currently registered in ThemeService. */
  readonly availableIds: readonly string[];
  /** Theme id used for the `dark` alias and for system-dark following. */
  readonly darkDefault: string;
  /** Theme id used for the `light` alias. */
  readonly lightDefault: string;
}

export interface DeviceThemeResolution {
  /** The theme id to apply, or `undefined` to keep the app default. */
  readonly themeId?: string;
  /** Provenance of the decision. */
  readonly source: DeviceThemeSource;
  /**
   * localStorage side effect the caller should perform, if present:
   * - a string  — persist this id as the per-device override.
   * - `null`    — remove a stale/invalid persisted override.
   * - absent    — leave localStorage untouched.
   */
  readonly store?: string | null;
}

/**
 * Resolve the per-device theme override from device-local signals.
 *
 * Precedence:
 *  1. `?theme=` URL param WINS — an exact theme id, or the `dark`/`light`
 *     aliases mapping to `darkDefault`/`lightDefault`. It is also persisted
 *     (`store`). An unknown/unavailable param id is ignored (`source: 'none'`)
 *     and does NOT fall through to the stored override.
 *  2. Otherwise a persisted per-device override wins WHEN it is still an
 *     available theme id. A stale id is treated as absent and scheduled for
 *     cleanup (`store: null`).
 *  3. Otherwise, only when the user has NOT explicitly set a theme, follow the
 *     system: `systemDark` → `darkDefault`. A light system is NOT forced to a
 *     light theme — we keep the app default (`source: 'none'`) so we never
 *     override the product's own light default.
 */
export function resolveDeviceTheme(input: DeviceThemeInput): DeviceThemeResolution {
  const { param, stored, systemDark, userThemeSet, availableIds, darkDefault, lightDefault } = input;
  const isAvailable = (id: string | undefined): id is string =>
    typeof id === 'string' && id.length > 0 && availableIds.includes(id);

  // 1. URL param wins (and persists).
  const trimmedParam = param?.trim();
  if (trimmedParam) {
    const resolved =
      trimmedParam === DEVICE_THEME_ALIAS_DARK ? darkDefault :
      trimmedParam === DEVICE_THEME_ALIAS_LIGHT ? lightDefault :
      trimmedParam;
    if (isAvailable(resolved)) {
      return { themeId: resolved, source: 'param', store: resolved };
    }
    // Unknown / no-longer-available param id: ignore it. Param "wins", so we do
    // NOT fall through to a stored override; keep the app default.
    return { source: 'none' };
  }

  // 2. Persisted per-device override.
  const trimmedStored = stored?.trim();
  let staleCleanup = false;
  if (trimmedStored) {
    if (isAvailable(trimmedStored)) {
      return { themeId: trimmedStored, source: 'stored' };
    }
    // Stale id — treat as absent and clean it up.
    staleCleanup = true;
  }

  // 3. Follow the system only when the user has not explicitly chosen a theme.
  if (!userThemeSet && systemDark && isAvailable(darkDefault)) {
    return staleCleanup
      ? { themeId: darkDefault, source: 'system', store: null }
      : { themeId: darkDefault, source: 'system' };
  }

  // No override: keep the app default (never force a light theme).
  return staleCleanup ? { source: 'none', store: null } : { source: 'none' };
}
