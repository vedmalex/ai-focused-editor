/**
 * Runtime preference-schema builder for auto-typography (TASK-019 §1.2). The
 * KEY property (UR-002): the settings surface is GENERATED from the same
 * `TypographyRule` registry the engine runs — add a rule (one binding) and its
 * `aiFocusedEditor.typography.<id>.enabled` toggle appears automatically, no
 * second source to keep in sync.
 *
 * This module lives in `common/` but the DI/preference glue it needs
 * (`@theia/core/lib/common` nls + preference types) is Theia-COMMON, not
 * Theia-browser — the pure algorithm modules (types/engine/rules/code-mask/
 * scope-predicate) stay dependency-free.
 */

import { PreferenceDataProperty, PreferenceScope } from '@theia/core/lib/common/preferences';
import { nls } from '@theia/core/lib/common/nls';
import { TypographyRule } from './typography-types';

/** The `properties` shape of a Theia `PreferenceSchema` (keyed data properties). */
export type TypographySchemaProperties = { [preferenceName: string]: PreferenceDataProperty };

// Re-export the DI token so seam/module code has a single import site.
export { TypographyRule } from './typography-types';

/**
 * Shared stem of EVERY auto-typography preference key. Single source of truth:
 * the master keys and each per-rule key derive from it. The docs-inventory
 * extractor (`scripts/extract-feature-inventory.mjs`) mirrors this literal to
 * register the runtime-built schema as a dynamic preference family (ISS-239) —
 * keep the two in sync (the extractor cannot import this Theia-dependent module).
 */
export const TYPOGRAPHY_PREFERENCE_PREFIX = 'aiFocusedEditor.typography.';

/** Master on/off for the whole auto-typography feature. */
export const TYPOGRAPHY_ENABLED_KEY = `${TYPOGRAPHY_PREFERENCE_PREFIX}enabled`;
/** Where auto-typography runs: `chapters` (default) or `all-md`. */
export const TYPOGRAPHY_SCOPE_KEY = `${TYPOGRAPHY_PREFERENCE_PREFIX}scope`;

export type TypographyScope = 'chapters' | 'all-md';

/** The per-rule enable preference key for a given rule id. */
export function ruleEnabledKey(ruleId: string): string {
  return `${TYPOGRAPHY_PREFERENCE_PREFIX}${ruleId}.enabled`;
}

/** `collapse-multiple-spaces` -> `Collapse multiple spaces` (English fallback text). */
function humanizeId(ruleId: string): string {
  const words = ruleId.replace(/-+/g, ' ').trim();
  return words.length === 0 ? ruleId : `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

/**
 * Build the `aiFocusedEditor.typography.*` preference properties from the live
 * rule set: a master toggle, a scope enum, and one boolean per rule (default =
 * the rule's `defaultEnabled`, description via the rule's nls key with a
 * humanised English fallback until translations land).
 */
export function buildTypographySchema(rules: readonly TypographyRule[]): TypographySchemaProperties {
  const properties: TypographySchemaProperties = {
    [TYPOGRAPHY_ENABLED_KEY]: {
      type: 'boolean',
      default: true,
      scope: PreferenceScope.Folder,
      description: nls.localize(
        'ai-focused-editor/typography/enabled-desc',
        'Automatically fix typography (spacing, punctuation, quotes, capitalization) as you type in chapter prose. Each rule below can be toggled individually; Ctrl+Z undoes any single auto-fix.'
      )
    },
    [TYPOGRAPHY_SCOPE_KEY]: {
      type: 'string',
      enum: ['chapters', 'all-md'],
      default: 'chapters',
      scope: PreferenceScope.Folder,
      description: nls.localize(
        'ai-focused-editor/typography/scope-desc',
        'Where auto-typography runs. "chapters" (default) limits it to chapter prose (front-matter type: chapter or a manifest-listed file); "all-md" runs it in every Markdown document except structural sidecars.'
      )
    }
  };

  for (const rule of rules) {
    properties[ruleEnabledKey(rule.id)] = {
      type: 'boolean',
      default: rule.defaultEnabled,
      scope: PreferenceScope.Folder,
      description: nls.localize(
        rule.descriptionKey,
        `Auto-typography rule "${humanizeId(rule.id)}".`
      )
    };
  }

  return properties;
}
