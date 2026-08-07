import { StorageService } from '@theia/core/lib/browser/storage-service';

/**
 * UR-040: bump this whenever a NEW `FrontendApplicationContribution`
 * side panel needs a one-time backfill into shell layouts that were saved by
 * an OLDER version of the app, one that predates the panel and therefore
 * never serialized it. Each call site tracks its OWN per-widget marker (see
 * {@link ensurePanelMigrated}'s doc comment for why a shared/global marker
 * would be wrong) — bumping this number does not by itself replay anything;
 * a given call site only replays once, the first time it observes a stored
 * marker below this number.
 */
export const CURRENT_LAYOUT_MIGRATION_VERSION = 1;

/**
 * UR-040 migration: add a panel to the shell AT MOST ONCE EVER for a given
 * workspace, keyed by a per-widget version marker in `StorageService` (which
 * `WorkspaceStorageService` prefixes per-workspace — see
 * `@theia/workspace/lib/browser/workspace-frontend-module.js`:
 * `rebind(StorageService).toService(WorkspaceStorageService)`, confirmed by
 * an actual run, not just reading the source: the resulting localStorage key
 * is `theia:<pathname>:<file:///path/to/workspace>:<key>`).
 *
 * THE BOUNDARY THIS EXISTS TO ENFORCE: a panel the author closed
 * deliberately AFTER this migration ran must never come back. A naive
 * "is the widget currently attached to the shell? add it if not" check run
 * on every startup cannot tell that state apart from "this workspace never
 * saw the panel" — both look like "not attached" from the shell's
 * perspective. The marker makes the two states different IN THE STORED
 * STATE ITSELF: once `migrationKey`'s stored value is
 * >= {@link CURRENT_LAYOUT_MIGRATION_VERSION}, `addPanel` is NEVER invoked
 * again for that widget in that workspace, no matter how many times the
 * widget is opened and closed afterwards.
 *
 * WHY NOT Theia's own `ApplicationShellLayoutMigration`
 * (`@theia/core/lib/browser/shell/shell-layout-restorer.ts`): verified by
 * reading `ShellLayoutRestorer.inflate()`/`parse()`. At the point a
 * migration's `onWillInflateLayout(context)` runs, `context.layout`'s
 * `widgets` arrays are still EMPTY placeholder arrays returned by
 * `ParseContext.filteredArray()` — the real `Widget` instances are filled
 * into them later, asynchronously, by closures that `parse()` queued
 * ONE-TO-ONE against the `WidgetDescription`s that were ALREADY PRESENT in
 * the serialized JSON. There is no hook that constructs a widget that was
 * never in the saved JSON to begin with. Confirms this reading: every
 * shipped `ApplicationShellLayoutMigration` in this tree
 * (`NavigatorLayoutVersion3Migration`, `NavigatorLayoutVersion5Migration`,
 * `ProblemLayoutVersion3Migration`, `ScmLayoutVersion3/5Migration`, …) only
 * renames or re-wraps an EXISTING `WidgetDescription` from
 * `onWillInflateWidget`, never adds a new one. It is a structural-transform
 * hook keyed to Theia's OWN shell-structure version
 * (`applicationShellLayoutVersion`, currently `5.0`, bumped by Theia core
 * across its own releases) — not a widget-provisioning hook, and not a
 * version number this app owns. It cannot do UR-040's job, so this function
 * uses a separate, app-owned marker instead.
 *
 * @param storageService the (per-workspace) storage service to read/write the marker in
 * @param migrationKey a key unique to the panel being migrated, stable across app versions
 * @param addPanel attaches the panel to the shell; called at most once per workspace
 */
export async function ensurePanelMigrated(
  storageService: StorageService,
  migrationKey: string,
  addPanel: () => Promise<unknown>
): Promise<void> {
  const migratedVersion = await storageService.getData<number>(migrationKey, 0);
  if (migratedVersion >= CURRENT_LAYOUT_MIGRATION_VERSION) {
    return;
  }
  await addPanel();
  await storageService.setData(migrationKey, CURRENT_LAYOUT_MIGRATION_VERSION);
}
