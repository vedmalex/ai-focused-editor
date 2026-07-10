export interface SemanticPosition {
  line: number;
  character: number;
}

export interface SemanticRange {
  start: SemanticPosition;
  end: SemanticPosition;
}

export interface SemanticTag {
  kind: string;
  id: string;
  label: string;
  raw: string;
  range: SemanticRange;
  labelRange: SemanticRange;
}

export interface SemanticMarkdownDocument {
  tags: SemanticTag[];
}

export interface SemanticMarkdownDiagnostic {
  severity: 'error' | 'warning';
  message: string;
  range: SemanticRange;
}

const SEMANTIC_TAG_PATTERN = /\[\[([a-z][\w-]*):([A-Za-z0-9_.:-]+)\|([^\]\n]+?)\]\]/g;
const SEMANTIC_TAG_EXACT_PATTERN = /^\[\[([a-z][\w-]*):([A-Za-z0-9_.:-]+)\|([^\]\n]+?)\]\]$/;

export function parseSemanticMarkdown(text: string): SemanticMarkdownDocument {
  const lineStarts = computeLineStarts(text);
  const tags: SemanticTag[] = [];
  let match: RegExpExecArray | null;

  SEMANTIC_TAG_PATTERN.lastIndex = 0;
  while ((match = SEMANTIC_TAG_PATTERN.exec(text)) !== null) {
    const [raw, kind, id, label] = match;
    const startOffset = match.index;
    const labelOffset = startOffset + raw.indexOf(label);

    tags.push({
      kind,
      id,
      label,
      raw,
      range: {
        start: offsetToPosition(lineStarts, startOffset),
        end: offsetToPosition(lineStarts, startOffset + raw.length)
      },
      labelRange: {
        start: offsetToPosition(lineStarts, labelOffset),
        end: offsetToPosition(lineStarts, labelOffset + label.length)
      }
    });
  }

  return { tags };
}

// GFM task-list marker at the start of a list item, e.g. `- [ ] todo` / `- [x] done`.
const TASK_LIST_ITEM_PATTERN = /^(\s*(?:[-*+]|\d+[.)])\s+)\[([ xX])\]\s+/gm;

/**
 * Render the portable preview Markdown shown in the Semantic Preview widget.
 *
 * Semantic `[[kind:id|label]]` tags collapse to bold label + muted meta, and GFM
 * task-list markers become ballot-box glyphs (☐ / ☑) so checkbox lists read
 * correctly through Theia's `html:false` Markdown renderer (which otherwise leaves
 * `[ ]` / `[x]` as literal text). Tables and strikethrough already render via
 * markdown-it's default preset, so they pass through untouched.
 */
export function renderSemanticMarkdownPreview(text: string): string {
  const { body, notes } = renderFootnotePreviewSections(text);
  const combined = notes ? `${body}\n\n${notes}` : body;
  const withTaskGlyphs = renderTaskListGlyphs(combined);
  SEMANTIC_TAG_PATTERN.lastIndex = 0;
  return withTaskGlyphs.replace(SEMANTIC_TAG_PATTERN, (_raw, kind: string, id: string, label: string) => {
    const escapedLabel = escapeMarkdownText(label);
    const escapedMeta = escapeMarkdownText(`${kind}:${id}`);
    return `**${escapedLabel}** _(${escapedMeta})_`;
  });
}

export function renderTaskListGlyphs(text: string): string {
  TASK_LIST_ITEM_PATTERN.lastIndex = 0;
  return text.replace(TASK_LIST_ITEM_PATTERN, (_raw, prefix: string, mark: string) =>
    `${prefix}${mark === ' ' ? '☐' : '☑'} `
  );
}

// Markdown footnote syntax: `[^id]` inline references and `[^id]: text` block
// definitions (definitions must start a line). Ids are non-whitespace runs so
// numeric (`[^1]`) and label ids (`[^note]`) both parse.
const FOOTNOTE_REFERENCE_PATTERN = /\[\^([^\]\s]+)\]/g;
const FOOTNOTE_DEFINITION_LINE_PATTERN = /^([ \t]*)\[\^([^\]\s]+)\]:[ \t]?(.*)$/;

export interface FootnoteReference {
  id: string;
  /** Range of the `[^id]` reference marker. */
  range: SemanticRange;
}

export interface FootnoteDefinition {
  id: string;
  /** Definition body text after the `[^id]:` marker. */
  text: string;
  /** Zero-based index of the line holding the definition. */
  line: number;
  /** Range of the `[^id]` marker at the start of the definition line. */
  range: SemanticRange;
}

export interface FootnoteDocument {
  references: FootnoteReference[];
  definitions: FootnoteDefinition[];
  /** Footnote id -> 1-based display number, assigned in definition order. */
  numbers: Map<string, number>;
}

/**
 * Parse markdown footnotes into their reference markers, block definitions, and
 * a stable id -> display-number map (numbered by definition order, so the
 * rendered "Notes" list reads 1..N regardless of the raw ids used).
 */
export function parseFootnotes(text: string): FootnoteDocument {
  const lineStarts = computeLineStarts(text);
  const lines = text.split('\n');
  const definitions: FootnoteDefinition[] = [];
  const definitionOffsets = new Set<number>();

  for (let index = 0; index < lines.length; index++) {
    const match = FOOTNOTE_DEFINITION_LINE_PATTERN.exec(lines[index]);
    if (!match) {
      continue;
    }
    const [, indent, id, body] = match;
    const markerOffset = lineStarts[index] + indent.length;
    definitionOffsets.add(markerOffset);
    const markerLength = id.length + 3; // `[^` + id + `]`
    definitions.push({
      id,
      text: body,
      line: index,
      range: {
        start: offsetToPosition(lineStarts, markerOffset),
        end: offsetToPosition(lineStarts, markerOffset + markerLength)
      }
    });
  }

  const references: FootnoteReference[] = [];
  FOOTNOTE_REFERENCE_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FOOTNOTE_REFERENCE_PATTERN.exec(text)) !== null) {
    // A `[^id]` at a definition's marker offset is the definition, not a reference.
    if (definitionOffsets.has(match.index)) {
      continue;
    }
    references.push({
      id: match[1],
      range: {
        start: offsetToPosition(lineStarts, match.index),
        end: offsetToPosition(lineStarts, match.index + match[0].length)
      }
    });
  }

  const numbers = new Map<string, number>();
  for (const definition of definitions) {
    if (!numbers.has(definition.id)) {
      numbers.set(definition.id, numbers.size + 1);
    }
  }

  return { references, definitions, numbers };
}

/**
 * Next free numeric footnote id for the document, so "Insert Footnote" never
 * collides with an existing `[^N]`. Label ids are ignored for the max.
 */
export function nextFootnoteNumber(text: string): number {
  const { references, definitions } = parseFootnotes(text);
  let max = 0;
  for (const { id } of [...references, ...definitions]) {
    const value = Number(id);
    if (Number.isInteger(value) && value > max) {
      max = value;
    }
  }
  return max + 1;
}

const SUPERSCRIPT_DIGITS = ['⁰', '¹', '²', '³', '⁴', '⁵', '⁶', '⁷', '⁸', '⁹'];

function toSuperscriptNumber(value: number): string {
  return String(value)
    .split('')
    .map(character => SUPERSCRIPT_DIGITS[Number(character)] ?? character)
    .join('');
}

/**
 * Split the document into preview body + a "Notes" section for footnotes.
 *
 * Theia's preview renderer runs with `html:false`, so raw `<sup>` would show as
 * literal text; the portable preview instead uses Unicode superscript digits for
 * references and a markdown ordered list for the definitions. Returns the input
 * unchanged when the document has no footnotes.
 */
function renderFootnotePreviewSections(text: string): { body: string; notes: string } {
  const { references, definitions, numbers } = parseFootnotes(text);
  if (references.length === 0 && definitions.length === 0) {
    return { body: text, notes: '' };
  }

  const definitionLines = new Set(definitions.map(definition => definition.line));
  const stripped = text
    .split('\n')
    .filter((_, index) => !definitionLines.has(index))
    .join('\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s+$/, '');

  FOOTNOTE_REFERENCE_PATTERN.lastIndex = 0;
  const body = stripped.replace(FOOTNOTE_REFERENCE_PATTERN, (raw, id: string) => {
    const number = numbers.get(id);
    return number ? toSuperscriptNumber(number) : raw;
  });

  const seen = new Set<string>();
  const items: string[] = [];
  for (const definition of definitions) {
    if (seen.has(definition.id)) {
      continue;
    }
    seen.add(definition.id);
    const number = numbers.get(definition.id) ?? seen.size;
    items.push(`${number}. ${definition.text}`.trimEnd());
  }

  return { body, notes: items.length > 0 ? `#### Notes\n\n${items.join('\n')}` : '' };
}

export function validateSemanticMarkdown(text: string): SemanticMarkdownDiagnostic[] {
  const lineStarts = computeLineStarts(text);
  const diagnostics: SemanticMarkdownDiagnostic[] = [];
  let offset = 0;

  while (offset < text.length) {
    const startOffset = text.indexOf('[[', offset);[]
    if (startOffset === -1) {
      break;
    }[]

    const endOffset = text.indexOf(']]', startOffset + 2);
    if (endOffset === -1) {
      diagnostics.push({
        severity: 'error',
        message: 'Unclosed semantic Markdown tag. Expected closing ]].',
        range: {
          start: offsetToPosition(lineStarts, startOffset),
          end: offsetToPosition(lineStarts, text.length)
        }
      });
      break;
    }

    const raw = text.slice(startOffset, endOffset + 2);
    if (!SEMANTIC_TAG_EXACT_PATTERN.test(raw)) {
      diagnostics.push({
        severity: 'error',
        message: 'Invalid semantic Markdown tag. Expected [[kind:id|label]] with single-line label and ASCII id.',
        range: {
          start: offsetToPosition(lineStarts, startOffset),
          end: offsetToPosition(lineStarts, endOffset + 2)
        }
      });
    }

    offset = endOffset + 2;
  }

  return diagnostics;
}

export function normalizeSemanticMarkdownTags(text: string): string {
  SEMANTIC_TAG_PATTERN.lastIndex = 0;
  return text.replace(SEMANTIC_TAG_PATTERN, (_raw, kind: string, id: string, label: string) =>
    `[[${kind.toLowerCase()}:${id.trim()}|${label.replace(/\s+/g, ' ').trim()}]]`
  );
}

function escapeMarkdownText(value: string): string {
  return value.replace(/[\\`*_{}[\]()#+\-.!|>]/g, character => `\\${character}`);
}

function computeLineStarts(text: string): number[] {
  const lineStarts = [0];
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) === 10) {
      lineStarts.push(index + 1);
    }
  }
  return lineStarts;
}

function offsetToPosition(lineStarts: number[], offset: number): SemanticPosition {
  let low = 0;
  let high = lineStarts.length - 1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const lineStart = lineStarts[middle];
    const nextLineStart = lineStarts[middle + 1] ?? Number.POSITIVE_INFINITY;

    if (offset < lineStart) {
      high = middle - 1;
    } else if (offset >= nextLineStart) {
      low = middle + 1;
    } else {
      return {
        line: middle,
        character: offset - lineStart
      };
    }
  }

  const lastLine = lineStarts.length - 1;
  return {
    line: lastLine,
    character: Math.max(0, offset - lineStarts[lastLine])
  };
}
