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

export function renderSemanticMarkdownPreview(text: string): string {
  SEMANTIC_TAG_PATTERN.lastIndex = 0;
  return text.replace(SEMANTIC_TAG_PATTERN, (_raw, kind: string, id: string, label: string) => {
    const escapedLabel = escapeMarkdownText(label);
    const escapedMeta = escapeMarkdownText(`${kind}:${id}`);
    return `**${escapedLabel}** _(${escapedMeta})_`;
  });
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
