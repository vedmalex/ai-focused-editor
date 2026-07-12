/**
 * Pure builder for the semantic-tag hover preview. Given a card's YAML text and
 * the entity type's field schema, it renders the FULL entity card as Markdown —
 * every schema field (author types included), extra unknown top-level keys, and a
 * clickable "open card" footer — so hovering a `[[kind:id|label]]` tag surfaces
 * the whole card, not just the three fields the decoration hover used to show.
 *
 * Kept Theia/Monaco/DOM-free and i18n-agnostic (all human-facing strings come in
 * through the {@link EntityHoverLocalizeHooks}) so it is byte-stable and directly
 * exercised by `bun test`. The browser `SemanticEntityHoverContribution` wires the
 * Monaco provider, the FileService read, and the `nls.localize` hooks on top.
 */

import { parse } from 'yaml';
import type { EntityFieldDescriptor, EntityTypeDescriptor } from './entity-type-registry';

/** Localization seam so this common module stays i18n-agnostic and byte-stable. */
export interface EntityHoverLocalizeHooks {
  /** Localized label for a schema field (the form's `nls.localize(labelKey, default)`). */
  fieldLabel(field: EntityFieldDescriptor): string;
  /** Localized display label for the entity type (e.g. `Character`, `Шлока`). */
  typeLabel(type: EntityTypeDescriptor): string;
  /** Label for the footer "open card" navigation link. */
  openLabel: string;
  /** Fallback body text when the card is missing/empty/malformed. */
  missingCardText: string;
}

export interface EntityHoverInput {
  /** Raw YAML text of the entity card. May be empty, malformed, or `undefined`. */
  cardYaml: string | undefined;
  /** The effective entity type descriptor (built-in or author) — supplies the schema. */
  descriptor: EntityTypeDescriptor;
  /** The tag's label text, used as the header label when the card has none. */
  tagLabel: string;
  /** The referenced entity id, used in the header when the card has none. */
  id: string;
  /** Already-encoded `command:` URI for the footer link, or `undefined` for no link. */
  openCommandUri?: string;
  localize: EntityHoverLocalizeHooks;
}

/** Textarea values longer than this are truncated (on a word boundary) with an ellipsis. */
const TEXTAREA_TRUNCATE_AT = 280;

/**
 * Render the hover Markdown for one entity tag. Never throws: a malformed/empty
 * card degrades to the header line plus {@link EntityHoverLocalizeHooks.missingCardText}.
 *
 * Shape:
 * - header: `**<card label or tag label>** — <type label> · <id>`
 * - each schema field in order (empty skipped; id/label roles fold into header):
 *   - `list`     → `Label: a, b, c`
 *   - `textarea` → `Label:` paragraph + the value truncated to ~280 chars
 *   - `text`     → `Label: value`
 * - extra top-level YAML scalars/lists not in the schema → `key: value` after them
 * - footer: `[<openLabel>](<openCommandUri>)` when an open URI is given
 *
 * Values are minimally escaped (`[ ] < >` backslash-escaped) so a card cannot
 * inject links or HTML into the trusted hover.
 */
export function buildEntityHoverMarkdown(input: EntityHoverInput): string {
  const { descriptor, localize } = input;
  const blocks: string[] = [];

  const labelFieldName = descriptor.fields.find(field => field.role === 'label')?.name;
  const idFieldName = descriptor.fields.find(field => field.role === 'id')?.name ?? 'id';

  const record = parseCard(input.cardYaml);

  const cardLabel = record && labelFieldName ? scalarToString(record[labelFieldName]) : '';
  const cardId = record ? scalarToString(record[idFieldName]) : '';
  const headerLabel = cardLabel || input.tagLabel;
  const headerId = cardId || input.id;
  blocks.push(`**${escapeValue(headerLabel)}** — ${localize.typeLabel(descriptor)} · ${escapeValue(headerId)}`);

  if (!record) {
    // Malformed / empty / missing card: header + fallback, still linkable.
    blocks.push(localize.missingCardText);
    return finalize(blocks, input.openCommandUri, localize.openLabel);
  }

  const ownedKeys = new Set<string>();
  for (const field of descriptor.fields) {
    ownedKeys.add(field.name);
    if (field.role === 'id' || field.role === 'label') {
      continue;
    }
    const label = localize.fieldLabel(field);
    if (field.kind === 'list') {
      const items = listToItems(record[field.name]);
      if (items.length > 0) {
        blocks.push(`${label}: ${items.map(escapeValue).join(', ')}`);
      }
    } else if (field.kind === 'textarea') {
      const value = scalarToString(record[field.name]);
      if (value) {
        blocks.push(`${label}:`);
        blocks.push(escapeValue(truncateOnWord(value, TEXTAREA_TRUNCATE_AT)));
      }
    } else {
      const value = scalarToString(record[field.name]);
      if (value) {
        blocks.push(`${label}: ${escapeValue(value)}`);
      }
    }
  }

  // Unknown top-level keys the form preserves — show them so the hover matches disk.
  for (const key of Object.keys(record)) {
    if (ownedKeys.has(key)) {
      continue;
    }
    const raw = record[key];
    if (Array.isArray(raw)) {
      const items = listToItems(raw);
      if (items.length > 0) {
        blocks.push(`${escapeValue(key)}: ${items.map(escapeValue).join(', ')}`);
      }
    } else {
      const value = scalarToString(raw);
      if (value) {
        blocks.push(`${escapeValue(key)}: ${escapeValue(value)}`);
      }
    }
  }

  return finalize(blocks, input.openCommandUri, localize.openLabel);
}

function finalize(blocks: string[], openCommandUri: string | undefined, openLabel: string): string {
  const body = blocks.join('\n\n');
  return openCommandUri ? `${body}\n\n[${openLabel}](${openCommandUri})` : body;
}

/** Parse the card YAML into a plain record, or `undefined` for empty/malformed/non-object. */
function parseCard(text: string | undefined): Record<string, unknown> | undefined {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return undefined;
  }
  try {
    const parsed = parse(text);
    return isPlainRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Trim strings; stringify finite numbers/booleans; everything else → `''`. */
function scalarToString(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === 'boolean') {
    return String(value);
  }
  return '';
}

/** Coerce a YAML list into a clean array of non-empty scalar strings. */
function listToItems(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map(scalarToString).filter(item => item.length > 0);
}

/** Backslash-escape the markdown-sensitive chars so cards cannot inject links/HTML. */
function escapeValue(value: string): string {
  return value.replace(/[\[\]<>]/g, char => `\\${char}`);
}

/** Truncate to at most `max` chars on a word boundary, appending an ellipsis. */
function truncateOnWord(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  const slice = value.slice(0, max);
  const lastSpace = slice.lastIndexOf(' ');
  const cut = lastSpace > 0 ? slice.slice(0, lastSpace) : slice;
  return `${cut.trimEnd()}…`;
}
