/**
 * Pure (Theia-free) migration of the product-specific `aiFocusedEditor.ai.*`
 * preference keys to the neutral `aiConnect.*` keys.
 *
 * The owner retired the legacy surface from OUR editor: the deprecated schema is
 * gone and the neutral keys are the only ones registered. Two callers use this
 * module to sweep legacy values that may still sit physically in a `settings.json`
 * file into their neutral twin:
 *
 *  - the User-scope one-time auto-migration (frontend, on start), and
 *  - the Book Doctor's workspace `.theia/settings.json` migration.
 *
 * Both read a raw JSONC text and rewrite it with `jsonc-parser`'s
 * `modify`/`applyEdits` so untouched keys, formatting, and comments survive.
 *
 * Kept free of Theia imports so the mapping table + decision logic can be unit
 * tested in isolation with `bun test`.
 *
 * ┌──────────────────────────────────────────────┬──────────────────────────────┐
 * │ LEGACY key (removed from our editor)           │ NEW neutral key               │
 * ├──────────────────────────────────────────────┼──────────────────────────────┤
 * │ aiFocusedEditor.ai.apiKeys                     │ aiConnect.apiKeys             │
 * │ aiFocusedEditor.ai.endpoints                   │ aiConnect.endpoints           │
 * │ aiFocusedEditor.ai.aliases                     │ aiConnect.aliases             │
 * │ aiFocusedEditor.ai.activeAlias                 │ aiConnect.activeAlias         │
 * │ aiFocusedEditor.ai.pinnedEndpoint              │ aiConnect.pinnedEndpoint      │
 * │ aiFocusedEditor.ai.requestLog                  │ aiConnect.requestLog          │
 * │ aiFocusedEditor.ai.manuscriptOverview          │ aiConnect.manuscriptOverview  │
 * └──────────────────────────────────────────────┴──────────────────────────────┘
 */

import { applyEdits, modify, parse, type FormattingOptions, type ParseError } from 'jsonc-parser';

/** One legacy → neutral key rename. */
export interface AiSettingsKeyMapping {
  /** Legacy product-specific key our editor no longer registers. */
  legacy: string;
  /** Neutral `aiConnect.*` replacement. */
  next: string;
}

/**
 * Canonical legacy → neutral mapping for OUR editor. This is the single source of
 * truth the doctor fix and the User-scope auto-migration both consume. The
 * reusable `ai-connect-theia` package keeps its own generic `resolveWithLegacy`
 * mapping (for other apps); this list additionally carries the manuscript-only
 * `manuscriptOverview` key, which has no home in the generic package.
 */
export const AI_SETTINGS_KEY_MIGRATION: readonly AiSettingsKeyMapping[] = Object.freeze([
  { legacy: 'aiFocusedEditor.ai.apiKeys', next: 'aiConnect.apiKeys' },
  { legacy: 'aiFocusedEditor.ai.endpoints', next: 'aiConnect.endpoints' },
  { legacy: 'aiFocusedEditor.ai.aliases', next: 'aiConnect.aliases' },
  { legacy: 'aiFocusedEditor.ai.activeAlias', next: 'aiConnect.activeAlias' },
  { legacy: 'aiFocusedEditor.ai.pinnedEndpoint', next: 'aiConnect.pinnedEndpoint' },
  { legacy: 'aiFocusedEditor.ai.requestLog', next: 'aiConnect.requestLog' },
  { legacy: 'aiFocusedEditor.ai.manuscriptOverview', next: 'aiConnect.manuscriptOverview' }
]);

/** Every legacy key, in mapping order. */
export const LEGACY_AI_SETTING_KEYS: readonly string[] = Object.freeze(
  AI_SETTINGS_KEY_MIGRATION.map(mapping => mapping.legacy)
);

/** Result of {@link scanLegacyAiSettings}. */
export interface LegacyAiSettingsScan {
  /** Legacy keys present at the top level of the settings object (mapping order). */
  legacyKeys: string[];
  /** True when the text is non-empty but not a parseable JSON object. */
  malformed: boolean;
}

/** True when `value` is a plain (non-array) object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parse a settings text as a tolerant JSONC object. Returns the object plus a
 * `malformed` flag (true when the text is non-empty but not a JSON object, or the
 * parser reported a structural error). An empty/whitespace text is a well-formed
 * empty object.
 */
function parseSettingsObject(text: string | undefined): { object?: Record<string, unknown>; malformed: boolean } {
  if (text === undefined || text.trim() === '') {
    return { object: {}, malformed: false };
  }
  const errors: ParseError[] = [];
  const parsed = parse(text, errors, { allowTrailingComma: true });
  if (errors.length > 0 || !isPlainObject(parsed)) {
    return { malformed: true };
  }
  return { object: parsed, malformed: false };
}

/**
 * Which legacy keys are physically present in a settings text, and whether the
 * text is malformed. Used by the doctor to raise the report finding + fix.
 */
export function scanLegacyAiSettings(text: string | undefined): LegacyAiSettingsScan {
  const { object, malformed } = parseSettingsObject(text);
  if (malformed || !object) {
    return { legacyKeys: [], malformed };
  }
  const legacyKeys = LEGACY_AI_SETTING_KEYS.filter(key =>
    Object.prototype.hasOwnProperty.call(object, key)
  );
  return { legacyKeys, malformed: false };
}

/** Input row for {@link planKeyMigrations}: whether each side of a pair is set. */
export interface KeyMigrationDecisionInput extends AiSettingsKeyMapping {
  /** Legacy key explicitly present in the target file/scope. */
  legacySet: boolean;
  /** Neutral twin explicitly present in the target file/scope. */
  newSet: boolean;
}

/** Output of {@link planKeyMigrations}. */
export interface KeyMigrationPlan {
  /** Legacy set + twin unset: copy the value to the twin, then drop the legacy. */
  move: AiSettingsKeyMapping[];
  /** Legacy set + twin already set: the twin wins, so just drop the shadowed legacy. */
  drop: AiSettingsKeyMapping[];
}

/**
 * Pure decision core (unit tested): given the {legacySet, newSet} state of each
 * key pair, decide which legacy values to MOVE into their neutral twin and which
 * to merely DROP because the twin already holds a value. An unset legacy key is
 * left untouched. Never destructive — a move always writes the replacement before
 * the legacy key is removed (enforced by {@link migrateAiSettingsText}).
 */
export function planKeyMigrations(entries: readonly KeyMigrationDecisionInput[]): KeyMigrationPlan {
  const move: AiSettingsKeyMapping[] = [];
  const drop: AiSettingsKeyMapping[] = [];
  for (const entry of entries) {
    if (!entry.legacySet) {
      continue;
    }
    const mapping: AiSettingsKeyMapping = { legacy: entry.legacy, next: entry.next };
    if (entry.newSet) {
      drop.push(mapping);
    } else {
      move.push(mapping);
    }
  }
  return { move, drop };
}

/** Result of {@link migrateAiSettingsText}. */
export interface AiSettingsMigrationResult {
  /** False only when the source is malformed (then nothing is rewritten). */
  ok: boolean;
  /** True when the source text is not a parseable JSON object. */
  malformed: boolean;
  /** Rewritten text (identical to the input when nothing changed or malformed). */
  text: string;
  /** True when `text` differs from the input. */
  changed: boolean;
  /** Legacy keys whose value was copied into their neutral twin (twin was unset). */
  movedKeys: string[];
  /** Legacy keys removed because the twin already held a value (twin wins). */
  droppedKeys: string[];
}

/**
 * Detect the indentation of a JSON(C) text so a surgical edit re-indents to
 * match. Looks at the first indented line; defaults to 4 spaces (the Theia
 * `settings.json` default) when no indentation is found.
 */
function detectFormatting(text: string): FormattingOptions {
  for (const rawLine of text.split(/\r?\n/)) {
    const match = /^(\t+|[ ]+)\S/.exec(rawLine);
    if (match) {
      const indent = match[1];
      if (indent.startsWith('\t')) {
        return { tabSize: 1, insertSpaces: false };
      }
      return { tabSize: indent.length, insertSpaces: true };
    }
  }
  return { tabSize: 4, insertSpaces: true };
}

/**
 * Rewrite a settings text, migrating every legacy `aiFocusedEditor.ai.*` key to
 * its neutral `aiConnect.*` twin. A legacy value is copied to the twin only when
 * the twin is unset (a MOVE); when the twin already exists the legacy key is
 * dropped as shadowed (a DROP). Edits are applied with `jsonc-parser` so every
 * other key, and the file's comments/formatting, survive. A malformed source is
 * returned untouched with `ok: false` (the caller reports, never writes).
 *
 * Idempotent: a second run over already-migrated text is a no-op (`changed:false`).
 */
export function migrateAiSettingsText(text: string): AiSettingsMigrationResult {
  const { object, malformed } = parseSettingsObject(text);
  if (malformed || !object) {
    return { ok: false, malformed: true, text, changed: false, movedKeys: [], droppedKeys: [] };
  }

  const has = (key: string): boolean => Object.prototype.hasOwnProperty.call(object, key);
  const plan = planKeyMigrations(
    AI_SETTINGS_KEY_MIGRATION.map(mapping => ({
      ...mapping,
      legacySet: has(mapping.legacy),
      newSet: has(mapping.next)
    }))
  );

  const formattingOptions = detectFormatting(text);
  let out = text;

  // MOVE: write the neutral twin FIRST (never destructive), then drop the legacy.
  for (const { legacy, next } of plan.move) {
    out = applyEdits(out, modify(out, [next], object[legacy], { formattingOptions }));
    out = applyEdits(out, modify(out, [legacy], undefined, { formattingOptions }));
  }
  // DROP: the twin already holds a value — remove the shadowed legacy key only.
  for (const { legacy } of plan.drop) {
    out = applyEdits(out, modify(out, [legacy], undefined, { formattingOptions }));
  }

  return {
    ok: true,
    malformed: false,
    text: out,
    changed: out !== text,
    movedKeys: plan.move.map(mapping => mapping.legacy),
    droppedKeys: plan.drop.map(mapping => mapping.legacy)
  };
}
