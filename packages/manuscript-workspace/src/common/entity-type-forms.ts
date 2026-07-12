/**
 * Pure (Theia-free) row/field models for the entity-types form editor
 * (`entities/types.yaml`).
 *
 * These helpers translate between the parsed author {@link EntityTypeDescriptor}s
 * (the output of {@link parseEntityTypesYaml}) and the flat rows the React widget
 * renders, plus the YAML-patch semantics (which keys are written vs. omitted
 * because they equal a registry default) and validation.
 *
 * There is exactly ONE validation brain: {@link validateTypeRows} round-trips the
 * rows back through {@link parseEntityTypesYaml} and surfaces its problems, so the
 * reserved-id / duplicate-tag-kind / bad-kebab rules are never duplicated here.
 *
 * The on-disk rewrite goes through the `yaml` Document API
 * ({@link serializeTypesDocument}) so the document header, the `version` key, and
 * comments survive a round-trip — only the `types` sequence is rebuilt from the
 * form rows. All defaults are read from the registry
 * ({@link DEFAULT_AUTHOR_FIELDS}, {@link DEFAULT_AUTHOR_ICON}) so this module never
 * re-declares a default.
 */

import { Document, isSeq, YAMLSeq } from 'yaml';
import {
  DEFAULT_AUTHOR_FIELDS,
  DEFAULT_AUTHOR_ICON,
  ENTITY_FIELD_LABEL_KEY_PREFIX_EXPORT,
  parseEntityTypesYaml,
  type EntityFieldDescriptor,
  type EntityFieldKind,
  type EntityTypeDescriptor,
  type EntityTypeProblem
} from './entity-type-registry';

/**
 * One editable field row of an author entity type. `label` carries the field's
 * `labelKey` value (an i18n key; author fields rarely have a translation, so the
 * key itself shows). The structural role is POSITIONAL: row 0 is always the `id`
 * field and row 1 is always the display-`label` field — the widget pins those two
 * at the top and only the rows below them reorder.
 */
export interface FieldRow {
  name: string;
  kind: EntityFieldKind;
  label: string;
}

/**
 * One editable author entity type. Mirrors the recognized subset of an
 * `entities/types.yaml` entry; `sectionKind`/`sectionIcon` are intentionally not
 * surfaced (they default off `directory`/the section icon) so the form owns a
 * small, predictable key set.
 */
export interface AuthorTypeRow {
  id: string;
  label: string;
  tagKind: string;
  directory: string;
  icon: string;
  accentClass?: string;
  fields: FieldRow[];
}

function toFieldRow(field: EntityFieldDescriptor): FieldRow {
  return { name: field.name, kind: field.kind, label: field.labelKey };
}

/** The DEFAULT author field schema expressed as rows, for the default-omission check. */
export const DEFAULT_AUTHOR_FIELD_ROWS: readonly FieldRow[] = DEFAULT_AUTHOR_FIELDS.map(toFieldRow);

/** A fresh field row list for a brand-new type — a copy of the registry defaults. */
export function defaultFieldRows(): FieldRow[] {
  return DEFAULT_AUTHOR_FIELD_ROWS.map(row => ({ ...row }));
}

/** An empty author type seeded by "Add Type" (starts with the default field schema). */
export function emptyAuthorTypeRow(): AuthorTypeRow {
  return { id: '', label: '', tagKind: '', directory: '', icon: '', fields: defaultFieldRows() };
}

/**
 * Reorder a descriptor's fields so the `id`-role field is first and the
 * `label`-role field is second (the two structural roles the widget pins),
 * followed by the remaining fields in their original order.
 */
function orderedFields(fields: readonly EntityFieldDescriptor[]): EntityFieldDescriptor[] {
  const idField = fields.find(field => field.role === 'id');
  const labelField = fields.find(field => field.role === 'label');
  const rest = fields.filter(field => field.role !== 'id' && field.role !== 'label');
  const ordered: EntityFieldDescriptor[] = [];
  if (idField) {
    ordered.push(idField);
  }
  if (labelField) {
    ordered.push(labelField);
  }
  ordered.push(...rest);
  return ordered;
}

/**
 * Flatten parsed author descriptors into editable rows. The descriptors are the
 * output of {@link parseEntityTypesYaml} (so their defaults are already resolved:
 * `tagKind`/`directory` fall back to `id`, `icon` to {@link DEFAULT_AUTHOR_ICON},
 * `fields` to {@link DEFAULT_AUTHOR_FIELDS}). Field order is normalised to
 * id-then-label-then-rest so the widget can pin the two role fields at the top.
 */
export function typesToRows(parsed: readonly EntityTypeDescriptor[]): AuthorTypeRow[] {
  return parsed.map(type => ({
    id: type.id,
    label: type.label,
    tagKind: type.tagKind,
    directory: type.directory,
    icon: type.icon,
    ...(type.accentClass ? { accentClass: type.accentClass } : {}),
    fields: orderedFields(type.fields).map(toFieldRow)
  }));
}

/** Whether a row's field schema equals the registry default (so `fields` is omitted). */
export function fieldsEqualDefault(fields: readonly FieldRow[]): boolean {
  if (fields.length !== DEFAULT_AUTHOR_FIELD_ROWS.length) {
    return false;
  }
  return fields.every((field, index) => {
    const base = DEFAULT_AUTHOR_FIELD_ROWS[index];
    return field.name.trim() === base.name
      && field.kind === base.kind
      && field.label.trim() === base.label;
  });
}

/**
 * Assign the positional structural role: row 0 is the `id` field, row 1 is the
 * display-`label` field, everything below is a plain field.
 */
function roleForIndex(index: number): 'id' | 'label' | undefined {
  if (index === 0) {
    return 'id';
  }
  if (index === 1) {
    return 'label';
  }
  return undefined;
}

/** Serialize one field row into its YAML object (name, kind, optional labelKey/role). */
function fieldRowToYaml(field: FieldRow, index: number): Record<string, unknown> {
  const name = field.name.trim();
  const entry: Record<string, unknown> = { name, kind: field.kind };
  const label = field.label.trim();
  // Omit the labelKey when it equals the per-name default parseAuthorFields would
  // synthesise anyway (`<prefix>field-<name>`), so a plain field stays terse.
  if (label && label !== `${ENTITY_FIELD_LABEL_KEY_PREFIX_EXPORT}field-${name}`) {
    entry.labelKey = label;
  }
  const role = roleForIndex(index);
  if (role) {
    entry.role = role;
  }
  return entry;
}

/**
 * Build the ordered YAML object for one type. Only NON-default keys are written:
 * `tagKind` is omitted when it equals `id`, `directory` when it equals `id`,
 * `icon` when it equals {@link DEFAULT_AUTHOR_ICON}, `accentClass` when blank, and
 * `fields` when the schema equals {@link DEFAULT_AUTHOR_FIELDS}. `id` and `label`
 * are always written (both are required).
 */
export function rowToYamlPatch(row: AuthorTypeRow): Record<string, unknown> {
  const id = row.id.trim();
  const patch: Record<string, unknown> = { id, label: row.label.trim() };

  const tagKind = row.tagKind.trim();
  if (tagKind && tagKind !== id) {
    patch.tagKind = tagKind;
  }
  const directory = row.directory.trim();
  if (directory && directory !== id) {
    patch.directory = directory;
  }
  const icon = row.icon.trim();
  if (icon && icon !== DEFAULT_AUTHOR_ICON) {
    patch.icon = icon;
  }
  const accentClass = (row.accentClass ?? '').trim();
  if (accentClass) {
    patch.accentClass = accentClass;
  }
  if (!fieldsEqualDefault(row.fields)) {
    patch.fields = row.fields.map((field, index) => fieldRowToYaml(field, index));
  }
  return patch;
}

/**
 * Rewrite the `types` sequence from the current rows while keeping the document
 * header, the `version` key, and any sibling keys/comments intact. Mirrors the
 * AI-modes editor's serialize: only the sequence is rebuilt.
 */
export function serializeTypesDocument(document: Document | undefined, rows: readonly AuthorTypeRow[]): string {
  const doc = document && document.contents != null
    ? document
    : new Document({ version: 1, types: [] });

  let seq: YAMLSeq;
  if (isSeq(doc.contents)) {
    // A bare-list document (`- id: ...`): the list itself is the sequence.
    seq = doc.contents;
  } else {
    const current = doc.get('types');
    if (isSeq(current)) {
      seq = current;
    } else {
      seq = new YAMLSeq();
      doc.set('types', seq);
    }
  }

  seq.items = [];
  for (const row of rows) {
    seq.add(doc.createNode(rowToYamlPatch(row)));
  }
  return doc.toString();
}

/**
 * Validate the rows by ROUND-TRIPPING them back through the registry parser: the
 * rows are serialized to YAML and re-parsed, and {@link parseEntityTypesYaml}'s
 * problems are returned verbatim. This keeps a single validation brain — the
 * reserved-id / duplicate-* / bad-kebab / missing-label rules live only in the
 * registry. Each problem's `index` maps directly to the row index (the rows are
 * serialized in order).
 */
export function validateTypeRows(rows: readonly AuthorTypeRow[]): EntityTypeProblem[] {
  const text = serializeTypesDocument(new Document({ version: 1, types: [] }), rows);
  return parseEntityTypesYaml(text).problems;
}

/**
 * Whether the rows are safe to save. Every {@link EntityTypeProblem} the registry
 * reports EXCLUDES its entry from the parsed types (saving would silently drop
 * that type), so any problem blocks the save.
 */
export function hasBlockingTypeProblems(problems: readonly EntityTypeProblem[]): boolean {
  return problems.length > 0;
}
