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
 *
 * STAGE 2 (this change) adds the DYNAMIC seam on top of the same shape:
 * {@link parseEntityTypesYaml} loads author-declared descriptors from a book's
 * `entities/types.yaml`, {@link mergeEntityTypes} appends them to the built-in
 * set (author types NEVER override a built-in — a collision is a validation
 * problem), and {@link EffectiveEntityType} tags each descriptor's origin. All
 * of the STAGE 1 literal-typed exports below are kept intact so compile-time
 * base ergonomics are unchanged; dynamic consumers read the string-typed
 * effective list instead.
 */

import { parse } from 'yaml';

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

// ---------------------------------------------------------------------------
// STAGE 2 — the DYNAMIC registry seam (author-declared types)
// ---------------------------------------------------------------------------

/**
 * A resolved entity type in the EFFECTIVE list — a plain {@link EntityTypeDescriptor}
 * plus its provenance. `built-in` types come from {@link BASE_ENTITY_TYPES};
 * `book` types were declared in the book's `entities/types.yaml`. The descriptor
 * shape is identical so a single display/form component renders both.
 */
export type EffectiveEntityType = EntityTypeDescriptor & { origin: 'built-in' | 'book' };

/**
 * Default field schema an author type inherits when it declares no `fields` of
 * its own: the shared `id`, a `name` display label, and the `aliases` / `summary`
 * / `notes` subset of the base rich-entity fields. Authors get a usable form
 * without spelling out a schema.
 */
export const DEFAULT_AUTHOR_FIELDS: readonly EntityFieldDescriptor[] = [
  { name: 'id', kind: 'text', labelKey: `${ENTITY_FIELD_LABEL_KEY_PREFIX}field-id`, role: 'id' },
  { name: 'name', kind: 'text', labelKey: `${ENTITY_FIELD_LABEL_KEY_PREFIX}field-name`, role: 'label' },
  { name: 'aliases', kind: 'list', labelKey: `${ENTITY_FIELD_LABEL_KEY_PREFIX}field-aliases` },
  { name: 'summary', kind: 'textarea', labelKey: `${ENTITY_FIELD_LABEL_KEY_PREFIX}field-summary` },
  { name: 'notes', kind: 'textarea', labelKey: `${ENTITY_FIELD_LABEL_KEY_PREFIX}field-notes` }
];

/** Default codicon for an author type that declares no `icon` / `sectionIcon`. */
const DEFAULT_AUTHOR_ICON = 'codicon codicon-symbol-misc';
const DEFAULT_AUTHOR_SECTION_ICON = 'codicon codicon-symbol-namespace';

/** Machine-readable code for each kind of `entities/types.yaml` validation problem. */
export type EntityTypeProblemCode =
  /** The file/root was not a list (or a `{ types: [...] }` object). */
  | 'invalid-shape'
  /** A list entry was not an object. */
  | 'invalid-entry'
  /** Entry has no `id` (or it is blank). */
  | 'missing-id'
  /** `id` is not a kebab-case token (`^[a-z][a-z0-9]*(-[a-z0-9]+)*$`). */
  | 'invalid-id'
  /** Entry has no `label` (or it is blank). */
  | 'missing-label'
  /** Another author entry already declared this `id`. */
  | 'duplicate-id'
  /** Another author entry already declared this `tagKind`. */
  | 'duplicate-tag-kind'
  /** Another author entry already declared this `directory`. */
  | 'duplicate-directory'
  /** `id` collides with a built-in type's id (built-ins cannot be overridden). */
  | 'reserved-id'
  /** `tagKind` collides with a built-in type's tagKind. */
  | 'reserved-tag-kind'
  /** `directory` collides with a built-in type's directory. */
  | 'reserved-directory';

/** One validation problem found while parsing `entities/types.yaml`. */
export interface EntityTypeProblem {
  code: EntityTypeProblemCode;
  /** Human-readable, English message (i18n happens at the presentation layer). */
  message: string;
  /** The offending entry's declared id, when one was present. */
  id?: string;
  /** Zero-based index of the entry in the source list, when applicable. */
  index?: number;
}

const KEBAB_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Parse one author `fields:` list into field descriptors. Tolerant: entries
 * without a string `name` are dropped; `kind` defaults to `text` (only the
 * three known controls are honoured); `labelKey` defaults to a per-name base
 * key; `role` is honoured only for the two structural roles. The result is
 * normalised so it always has exactly one `id` field (prepended if missing) and
 * one `label` field (the first non-id field is promoted, else a `name` label is
 * appended). An absent/empty/invalid list yields {@link DEFAULT_AUTHOR_FIELDS}.
 */
function parseAuthorFields(value: unknown): EntityFieldDescriptor[] {
  if (!Array.isArray(value)) {
    return [...DEFAULT_AUTHOR_FIELDS];
  }
  const parsed: EntityFieldDescriptor[] = [];
  for (const raw of value) {
    if (!isPlainRecord(raw)) {
      continue;
    }
    const name = asTrimmedString(raw.name);
    if (!name) {
      continue;
    }
    const kindValue = asTrimmedString(raw.kind);
    const kind: EntityFieldKind = kindValue === 'textarea' || kindValue === 'list' ? kindValue : 'text';
    const roleValue = asTrimmedString(raw.role);
    const role = roleValue === 'id' || roleValue === 'label' ? roleValue : undefined;
    parsed.push({
      name,
      kind,
      labelKey: asTrimmedString(raw.labelKey) || `${ENTITY_FIELD_LABEL_KEY_PREFIX}field-${name}`,
      ...(role ? { role } : {})
    });
  }
  if (parsed.length === 0) {
    return [...DEFAULT_AUTHOR_FIELDS];
  }
  // Guarantee exactly one id field.
  if (!parsed.some(field => field.role === 'id')) {
    parsed.unshift({ name: 'id', kind: 'text', labelKey: `${ENTITY_FIELD_LABEL_KEY_PREFIX}field-id`, role: 'id' });
  }
  // Guarantee exactly one label field: promote the first non-id field, else append `name`.
  if (!parsed.some(field => field.role === 'label')) {
    const promotable = parsed.find(field => field.role !== 'id');
    if (promotable) {
      promotable.role = 'label';
    } else {
      parsed.push({ name: 'name', kind: 'text', labelKey: `${ENTITY_FIELD_LABEL_KEY_PREFIX}field-name`, role: 'label' });
    }
  }
  return parsed;
}

/**
 * Parse the text of a book's `entities/types.yaml` into author {@link EntityTypeDescriptor}s
 * plus a list of validation {@link EntityTypeProblem}s. The document may be a bare
 * list of type entries or a `{ types: [...] }` object. Every problem is reported
 * with a machine code; a problem entry is EXCLUDED from `types` so the returned
 * descriptors are always safe to append. An empty / whitespace / null-document
 * file yields no types and no problems.
 *
 * Per-entry defaults: `tagKind` and `directory` both default to `id`; `icon`,
 * `sectionIcon`, `sectionKind`, `accentClass`, and `fields` fall back to sensible
 * defaults ({@link DEFAULT_AUTHOR_FIELDS} for the schema). Collisions with a
 * built-in type (id/tagKind/directory) and among author entries are validation
 * problems — built-ins are never overridden at this stage.
 */
export function parseEntityTypesYaml(text: string): { types: EntityTypeDescriptor[]; problems: EntityTypeProblem[] } {
  const problems: EntityTypeProblem[] = [];
  const types: EntityTypeDescriptor[] = [];

  if (typeof text !== 'string' || text.trim().length === 0) {
    return { types, problems };
  }

  let document: unknown;
  try {
    document = parse(text);
  } catch (error) {
    problems.push({
      code: 'invalid-shape',
      message: `Invalid entities/types.yaml: ${error instanceof Error ? error.message : String(error)}`
    });
    return { types, problems };
  }

  // An empty document (null) is a legitimate "no author types" file.
  if (document === null || document === undefined) {
    return { types, problems };
  }

  const entries = Array.isArray(document)
    ? document
    : isPlainRecord(document) && Array.isArray(document.types)
      ? document.types
      : undefined;

  if (!Array.isArray(entries)) {
    problems.push({
      code: 'invalid-shape',
      message: 'entities/types.yaml must be a list of entity types (or a { types: [...] } object).'
    });
    return { types, problems };
  }

  const baseIds = new Set<string>(BASE_ENTITY_TYPES.map(type => type.id));
  const baseTags = new Set<string>(BASE_ENTITY_TYPES.map(type => type.tagKind));
  const baseDirs = new Set<string>(BASE_ENTITY_TYPES.map(type => type.directory));
  const seenIds = new Set<string>();
  const seenTags = new Set<string>();
  const seenDirs = new Set<string>();

  for (let index = 0; index < entries.length; index++) {
    const raw = entries[index];
    if (!isPlainRecord(raw)) {
      problems.push({ code: 'invalid-entry', index, message: `Entity type ${index + 1}: expected an object.` });
      continue;
    }

    const id = asTrimmedString(raw.id);
    if (!id) {
      problems.push({ code: 'missing-id', index, message: `Entity type ${index + 1}: an "id" is required.` });
      continue;
    }
    if (!KEBAB_ID.test(id)) {
      problems.push({ code: 'invalid-id', index, id, message: `Entity type "${id}": id must be a kebab-case token (lowercase letters, digits, hyphens).` });
      continue;
    }

    const label = asTrimmedString(raw.label);
    if (!label) {
      problems.push({ code: 'missing-label', index, id, message: `Entity type "${id}": a "label" is required.` });
      continue;
    }

    const tagKind = asTrimmedString(raw.tagKind) || id;
    const directory = asTrimmedString(raw.directory) || id;

    // Built-ins are authoritative — an author type may never shadow one.
    if (baseIds.has(id)) {
      problems.push({ code: 'reserved-id', index, id, message: `Entity type "${id}": id collides with a built-in type; built-in types cannot be overridden.` });
      continue;
    }
    if (baseTags.has(tagKind)) {
      problems.push({ code: 'reserved-tag-kind', index, id, message: `Entity type "${id}": tagKind "${tagKind}" collides with a built-in type.` });
      continue;
    }
    if (baseDirs.has(directory)) {
      problems.push({ code: 'reserved-directory', index, id, message: `Entity type "${id}": directory "${directory}" collides with a built-in type.` });
      continue;
    }

    // Author-vs-author uniqueness.
    if (seenIds.has(id)) {
      problems.push({ code: 'duplicate-id', index, id, message: `Entity type "${id}": duplicate id.` });
      continue;
    }
    if (seenTags.has(tagKind)) {
      problems.push({ code: 'duplicate-tag-kind', index, id, message: `Entity type "${id}": tagKind "${tagKind}" is already used by another author type.` });
      continue;
    }
    if (seenDirs.has(directory)) {
      problems.push({ code: 'duplicate-directory', index, id, message: `Entity type "${id}": directory "${directory}" is already used by another author type.` });
      continue;
    }

    seenIds.add(id);
    seenTags.add(tagKind);
    seenDirs.add(directory);

    const icon = asTrimmedString(raw.icon) || DEFAULT_AUTHOR_ICON;
    types.push({
      id,
      tagKind,
      directory,
      label,
      sectionKind: asTrimmedString(raw.sectionKind) || directory,
      icon,
      sectionIcon: asTrimmedString(raw.sectionIcon) || DEFAULT_AUTHOR_SECTION_ICON,
      ...(asTrimmedString(raw.accentClass) ? { accentClass: asTrimmedString(raw.accentClass) } : {}),
      fields: parseAuthorFields(raw.fields)
    });
  }

  return { types, problems };
}

/**
 * Merge the built-in base types with author-declared types into the EFFECTIVE
 * list. Built-ins come first (origin `built-in`); author types APPEND (origin
 * `book`). Overriding a built-in is not allowed this stage, so any author type
 * whose id/tagKind/directory collides with a built-in (or with an earlier
 * author type) is DEFENSIVELY skipped here — {@link parseEntityTypesYaml} owns
 * the problem reporting, so merge stays quiet and only produces a clean list.
 */
export function mergeEntityTypes(
  base: readonly EntityTypeDescriptor[],
  author: readonly EntityTypeDescriptor[]
): EffectiveEntityType[] {
  const effective: EffectiveEntityType[] = base.map(type => ({ ...type, origin: 'built-in' as const }));
  const usedIds = new Set<string>(base.map(type => type.id));
  const usedTags = new Set<string>(base.map(type => type.tagKind));
  const usedDirs = new Set<string>(base.map(type => type.directory));

  for (const type of author) {
    if (usedIds.has(type.id) || usedTags.has(type.tagKind) || usedDirs.has(type.directory)) {
      continue;
    }
    usedIds.add(type.id);
    usedTags.add(type.tagKind);
    usedDirs.add(type.directory);
    effective.push({ ...type, origin: 'book' });
  }

  return effective;
}
