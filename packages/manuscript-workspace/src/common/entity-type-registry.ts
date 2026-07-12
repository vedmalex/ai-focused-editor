/**
 * Single source of truth for the narrative entity types (STAGE 1 of the
 * author-defined-entity-types generalization).
 *
 * Today the four built-in kinds — character, term, artifact, location — are
 * hardcoded as literal unions and scattered `Record` maps across the common,
 * browser, and node layers. This module declares them ONCE as data
 * ({@link BASE_ENTITY_TYPES}) and exposes derivations so every previously
 * hardcoded site can read from here instead of duplicating the literals.
 *
 * The module is intentionally Theia/Node/DOM-free (pure data + helpers) so it is
 * exercised directly by `bun test`. Later stages (2-4) layer YAML-loaded author
 * types, a schema-driven form component, and obsidian-style link generality on
 * top of this same descriptor shape; STAGE 1 changes ZERO behavior — the
 * derivations below reproduce the current literals byte-for-byte.
 */

/** Editor control the entity form renders for a field. */
export type EntityFieldKind = 'text' | 'textarea' | 'list';

/**
 * One field of an entity type's form schema. Mirrors the fields the entity form
 * editor (`browser/entity-editor-widget.ts`) renders today, in the same order.
 * `name` is the YAML property key; `kind` is the control (single-line text,
 * multi-line textarea, or newline-delimited list → string[]); `labelKey` is the
 * i18n key whose English default the form supplies inline. `role` marks the two
 * structural fields — the stable `id` and the display-label field (whose YAML
 * key differs per type: `name` for most, `term` for terms).
 */
export interface EntityFieldDescriptor {
  /** YAML property key this field reads/writes (e.g. `name`, `aliases`). */
  name: string;
  /** Editor control the entity form renders for this field. */
  kind: EntityFieldKind;
  /** i18n key for the field label (English default lives in the form/i18n). */
  labelKey: string;
  /** Structural role, if any: the id field and the display-label field. */
  role?: 'id' | 'label';
}

/**
 * A narrative entity type. The base set below is the four built-in kinds; a
 * later stage adds author-defined descriptors of the same shape loaded from
 * YAML.
 */
export interface EntityTypeDescriptor {
  /** The {@link EntityTypeDescriptor} id — the `NarrativeEntityKind` value (e.g. `character`). */
  id: string;
  /** The `[[tagKind:id]]` token kind — `char` for character, else equal to `id`. */
  tagKind: string;
  /** Directory under `entities/` this type's YAML files live in (e.g. `characters`). */
  directory: string;
  /** English display label (Russian lives in i18n keyed by field/section keys). */
  label: string;
  /** Author-materials navigator section kind this type maps to (e.g. `characters`). */
  sectionKind: string;
  /** Codicon class for a tree item of this type (e.g. `codicon codicon-person`). */
  icon: string;
  /** Codicon class for this type's navigator section header (e.g. `codicon codicon-account`). */
  sectionIcon: string;
  /** `afe-ico-*` accent class shared by the section and item icons. */
  accentClass?: string;
  /** Form schema for the future schema-driven entity form (mirrors the current fields). */
  fields: EntityFieldDescriptor[];
}

const ENTITY_FIELD_LABEL_KEY_PREFIX = 'ai-focused-editor/entities/';

/**
 * Build the ordered field schema shared by every entity type. Only the
 * display-label field differs per type (`name` vs `term`), so it is threaded in.
 * Order matches the render order in `entity-editor-widget.ts`.
 */
function entityFields(labelFieldName: string, labelFieldKey: string): EntityFieldDescriptor[] {
  return [
    { name: 'id', kind: 'text', labelKey: `${ENTITY_FIELD_LABEL_KEY_PREFIX}field-id`, role: 'id' },
    { name: labelFieldName, kind: 'text', labelKey: labelFieldKey, role: 'label' },
    { name: 'aliases', kind: 'list', labelKey: `${ENTITY_FIELD_LABEL_KEY_PREFIX}field-aliases` },
    { name: 'epithets', kind: 'list', labelKey: `${ENTITY_FIELD_LABEL_KEY_PREFIX}field-epithets` },
    { name: 'summary', kind: 'textarea', labelKey: `${ENTITY_FIELD_LABEL_KEY_PREFIX}field-summary` },
    { name: 'backstory', kind: 'textarea', labelKey: `${ENTITY_FIELD_LABEL_KEY_PREFIX}field-backstory` },
    { name: 'arc', kind: 'textarea', labelKey: `${ENTITY_FIELD_LABEL_KEY_PREFIX}field-arc` },
    { name: 'speechPatterns', kind: 'list', labelKey: `${ENTITY_FIELD_LABEL_KEY_PREFIX}field-speech-patterns` },
    { name: 'notes', kind: 'textarea', labelKey: `${ENTITY_FIELD_LABEL_KEY_PREFIX}field-notes` }
  ];
}

/**
 * The four built-in narrative entity types, in their canonical display/iteration
 * order (character, term, artifact, location). `as const satisfies` keeps the
 * `id`/`tagKind` string LITERALS alive (so downstream literal unions do not
 * widen to `string`) while still structurally validating each descriptor.
 */
export const BASE_ENTITY_TYPES = [
  {
    id: 'character',
    tagKind: 'char',
    directory: 'characters',
    label: 'Character',
    sectionKind: 'characters',
    icon: 'codicon codicon-person',
    sectionIcon: 'codicon codicon-account',
    accentClass: 'afe-ico-characters',
    fields: entityFields('name', `${ENTITY_FIELD_LABEL_KEY_PREFIX}field-name`)
  },
  {
    id: 'term',
    tagKind: 'term',
    directory: 'terms',
    label: 'Term',
    sectionKind: 'terms',
    icon: 'codicon codicon-symbol-string',
    sectionIcon: 'codicon codicon-symbol-key',
    accentClass: 'afe-ico-terms',
    fields: entityFields('term', `${ENTITY_FIELD_LABEL_KEY_PREFIX}field-term`)
  },
  {
    id: 'artifact',
    tagKind: 'artifact',
    directory: 'artifacts',
    label: 'Artifact',
    sectionKind: 'artifacts',
    icon: 'codicon codicon-symbol-misc',
    sectionIcon: 'codicon codicon-package',
    accentClass: 'afe-ico-artifacts',
    fields: entityFields('name', `${ENTITY_FIELD_LABEL_KEY_PREFIX}field-name`)
  },
  {
    id: 'location',
    tagKind: 'location',
    directory: 'locations',
    label: 'Location',
    sectionKind: 'locations',
    icon: 'codicon codicon-milestone',
    sectionIcon: 'codicon codicon-location',
    accentClass: 'afe-ico-locations',
    fields: entityFields('name', `${ENTITY_FIELD_LABEL_KEY_PREFIX}field-name`)
  }
] as const satisfies readonly EntityTypeDescriptor[];

/**
 * The narrative entity kind union, derived from the registry `id` literals. Kept
 * as a distinct exported type so `NarrativeEntityKind` (and every downstream
 * literal union) can be `= this type` without widening to `string`.
 */
export type NarrativeEntityKindFromRegistry = typeof BASE_ENTITY_TYPES[number]['id'];

/** The `[[tagKind:...]]` kind union, derived from the registry `tagKind` literals. */
export type NarrativeEntityTagKindFromRegistry = typeof BASE_ENTITY_TYPES[number]['tagKind'];

/** All entity kind ids, in registry (display/iteration) order. */
export const ENTITY_KIND_IDS: readonly NarrativeEntityKindFromRegistry[] =
  BASE_ENTITY_TYPES.map(type => type.id);

/** All entity tag kinds, in registry order (`char`, `term`, `artifact`, `location`). */
export const ENTITY_TAG_KINDS: readonly NarrativeEntityTagKindFromRegistry[] =
  BASE_ENTITY_TYPES.map(type => type.tagKind);

/** Look up a descriptor by its kind id (e.g. `character`). */
export function entityTypeById(id: string): EntityTypeDescriptor | undefined {
  return BASE_ENTITY_TYPES.find(type => type.id === id);
}

/** Look up a descriptor by its tag kind (e.g. `char`). */
export function entityTypeByTagKind(tagKind: string): EntityTypeDescriptor | undefined {
  return BASE_ENTITY_TYPES.find(type => type.tagKind === tagKind);
}

/** Look up a descriptor by its `entities/` subdirectory (e.g. `characters`). */
export function entityTypeByDirectory(directory: string): EntityTypeDescriptor | undefined {
  return BASE_ENTITY_TYPES.find(type => type.directory === directory);
}

/**
 * Map a semantic tag kind to its entity kind id: `char` → `character`, every
 * built-in kind verbatim, and — critically — any UNKNOWN tag kind passed through
 * verbatim so link navigation keeps resolving author/obsidian-style tags exactly
 * as it does today (`link-navigation.ts` tests pin this passthrough).
 */
export function tagKindToEntityKind(tagKind: string): string {
  return entityTypeByTagKind(tagKind)?.id ?? tagKind;
}

/** Derived `{ kindId: directory }` map (directory is the bare `entities/` subdir name). */
export function entityKindDirectories(): Record<string, string> {
  return Object.fromEntries(BASE_ENTITY_TYPES.map(type => [type.id, type.directory]));
}

/** Derived `{ kindId: tagKind }` map. */
export function entityKindTags(): Record<string, string> {
  return Object.fromEntries(BASE_ENTITY_TYPES.map(type => [type.id, type.tagKind]));
}

/** Derived `{ kindId: label }` map (English display labels). */
export function entityKindLabels(): Record<string, string> {
  return Object.fromEntries(BASE_ENTITY_TYPES.map(type => [type.id, type.label]));
}

/** Derived `{ kindId: sectionKind }` map. */
export function entityKindSections(): Record<string, string> {
  return Object.fromEntries(BASE_ENTITY_TYPES.map(type => [type.id, type.sectionKind]));
}

/**
 * Derived `{ kindId: labelFieldName }` map — the YAML key of each type's display
 * label field (`name` for most, `term` for terms), read off the `role: 'label'`
 * field of the type's schema.
 */
export function entityKindLabelFields(): Record<string, string> {
  return Object.fromEntries(
    BASE_ENTITY_TYPES.map(type => [type.id, type.fields.find(field => field.role === 'label')?.name ?? 'name'])
  );
}
