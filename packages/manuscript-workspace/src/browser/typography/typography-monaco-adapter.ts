/**
 * The ONLY place Monaco meets the pure typography core (TASK-019 §1.4/§2). It
 * builds a {@link TypographyContext} from a live `ITextModel` and applies a
 * computed edit list back as a discrete undo step. Everything Monaco-specific —
 * the `@internal` tokenizer cast, `pushEditOperations`, the drift guard — is
 * isolated here so the engine and rules never see an editor.
 */

import { injectable } from '@theia/core/shared/inversify';
import * as monaco from '@theia/monaco-editor-core';
import { parseChapterFrontMatter } from '../../common/chapter-front-matter';
import { computeCodeMask } from '../../common/typography/code-mask';
import {
  LineSnapshot,
  LineToken,
  Position,
  TextRange,
  TokenKind,
  TypographyContext,
  TypographyEdit
} from '../../common/typography/typography-types';

export interface BuildContextOptions {
  readonly changedRange: TextRange;
  readonly cursor: Position;
  readonly trigger: 'type' | 'paste' | 'batch';
  readonly locale: string;
  /** 1-based inclusive line window to snapshot (clamped to the model). */
  readonly windowStart: number;
  readonly windowEnd: number;
}

/** Monaco `StandardTokenType` numeric values (avoid importing the internal enum). */
const STANDARD_TOKEN_COMMENT = 1;
const STANDARD_TOKEN_STRING = 2;

/** Minimal structural view of the `@internal` tokenizer we defensively read. */
interface TokenizationLike {
  isCheapToTokenize?(lineNumber: number): boolean;
  forceTokenization?(lineNumber: number): void;
  getLineTokens?(lineNumber: number): LineTokensLike | undefined;
}

interface LineTokensLike {
  getCount(): number;
  getStandardTokenType(index: number): number;
  getStartOffset(index: number): number;
  getEndOffset(index: number): number;
}

@injectable()
export class TypographyMonacoAdapter {
  /**
   * Read the OPEN buffer's front-matter `type:` scalar (synchronous — the
   * document is already in memory). Drives the `chapters` scope gate without a
   * disk round-trip.
   */
  readFrontMatterType(model: monaco.editor.ITextModel): string | undefined {
    const parsed = parseChapterFrontMatter(model.getValue());
    if (!parsed.present) {
      return undefined;
    }
    const field = parsed.fields.find(candidate => candidate.key === 'type');
    if (!field) {
      return undefined;
    }
    if (field.value.kind === 'text') {
      return field.value.segments
        .map(segment => (segment.type === 'text' ? segment.value : segment.mention.label))
        .join('')
        .trim();
    }
    if (field.value.kind === 'raw') {
      return field.value.display.trim();
    }
    return undefined;
  }

  /**
   * Snapshot the given line window into a {@link TypographyContext}. The code
   * mask is computed over the WHOLE document (fence state carries across lines),
   * then only the window's lines become {@link LineSnapshot}s. Monaco's
   * tokenizer, when reachable, refines inline spans on top of the pure mask;
   * any failure there falls back to the pure detector (fail-open).
   */
  buildContext(model: monaco.editor.ITextModel, options: BuildContextOptions): TypographyContext {
    const allLines = model.getLinesContent();
    const mask = computeCodeMask(allLines);
    const lineCount = allLines.length;
    const start = Math.max(1, options.windowStart);
    const end = Math.min(lineCount, options.windowEnd);

    const lines: LineSnapshot[] = [];
    for (let lineNumber = start; lineNumber <= end; lineNumber++) {
      const idx = lineNumber - 1;
      const text = allLines[idx];
      const isCode = mask.isCode[idx] ?? false;
      const tokens: LineToken[] = isCode
        ? []
        : mask.inlineRanges[idx].map(range => ({
          startColumn: range.startCol + 1,
          endColumn: range.endCol + 1,
          kind: TokenKind.InlineCode
        }));
      if (!isCode) {
        this.refineWithMonaco(model, lineNumber, tokens);
      }
      lines.push({ lineNumber, text, tokens, isCode });
    }

    return {
      lines,
      changedRange: options.changedRange,
      cursor: options.cursor,
      locale: options.locale,
      trigger: options.trigger
    };
  }

  /**
   * Apply `edits` as a single discrete undo step (mirrors
   * `proofreading-widget.applyScopedEdit`: `pushStackElement` before/after so
   * one Ctrl+Z reverts exactly this auto-fix). A light drift guard skips any
   * edit whose range no longer fits the model. Returns true when it wrote.
   */
  applyEdits(model: monaco.editor.ITextModel, edits: readonly TypographyEdit[]): boolean {
    const operations = this.buildOperations(model, edits);
    if (operations.length === 0) {
      return false;
    }
    model.pushStackElement();
    model.pushEditOperations([], operations, () => null);
    model.pushStackElement();
    return true;
  }

  /**
   * Apply `edits` WITHOUT opening/closing an undo boundary of its own — the
   * caller owns the `pushStackElement` bracket. This is the batch primitive
   * (TASK-019 W1b §2): the batch service brackets a whole multi-pass run in ONE
   * `pushStackElement`…`pushStackElement` pair so the entire "apply to file /
   * selection" collapses into a SINGLE Ctrl+Z, however many internal passes it
   * took. The same drift guard applies. Returns true when it wrote.
   */
  applyEditsWithoutBoundary(model: monaco.editor.ITextModel, edits: readonly TypographyEdit[]): boolean {
    const operations = this.buildOperations(model, edits);
    if (operations.length === 0) {
      return false;
    }
    model.pushEditOperations([], operations, () => null);
    return true;
  }

  /** Map edits to Monaco operations, dropping any that no longer fit (drift guard). */
  private buildOperations(
    model: monaco.editor.ITextModel,
    edits: readonly TypographyEdit[]
  ): monaco.editor.IIdentifiedSingleEditOperation[] {
    const operations: monaco.editor.IIdentifiedSingleEditOperation[] = [];
    for (const edit of edits) {
      const range = this.toMonacoRange(edit.range);
      if (!this.rangeFits(model, range)) {
        // Drift guard: the buffer moved under us — drop this edit rather than
        // corrupt an unrelated span.
        continue;
      }
      operations.push({ range, text: edit.text });
    }
    return operations;
  }

  /** Derive the changed {@link TextRange} from a content-change event. */
  readChangedRange(event: monaco.editor.IModelContentChangedEvent): TextRange | undefined {
    const change = event.changes[0];
    if (!change) {
      return undefined;
    }
    const inserted = change.text.split('\n');
    const endLine = change.range.startLineNumber + inserted.length - 1;
    const endColumn = inserted.length === 1
      ? change.range.startColumn + inserted[0].length
      : inserted[inserted.length - 1].length + 1;
    return {
      start: { line: change.range.startLineNumber, column: change.range.startColumn },
      end: { line: endLine, column: endColumn }
    };
  }

  private toMonacoRange(range: TextRange): monaco.IRange {
    return {
      startLineNumber: range.start.line,
      startColumn: range.start.column,
      endLineNumber: range.end.line,
      endColumn: range.end.column
    };
  }

  private rangeFits(model: monaco.editor.ITextModel, range: monaco.IRange): boolean {
    const lineCount = model.getLineCount();
    if (range.startLineNumber < 1 || range.endLineNumber > lineCount) {
      return false;
    }
    const endLineMax = model.getLineMaxColumn(range.endLineNumber);
    return range.endColumn <= endLineMax;
  }

  /**
   * Best-effort Monaco token refinement. Adds InlineCode/Comment spans the pure
   * mask may miss (e.g. a code span Monaco resolves via the Markdown grammar).
   * Isolated behind a defensive cast + try/catch: on ANY failure the pure mask
   * stands (the `@internal` tokenizer is not part of the stable API).
   */
  private refineWithMonaco(model: monaco.editor.ITextModel, lineNumber: number, tokens: LineToken[]): void {
    try {
      const tokenization = (model as unknown as { tokenization?: TokenizationLike }).tokenization;
      if (!tokenization?.getLineTokens || !tokenization.forceTokenization) {
        return;
      }
      if (tokenization.isCheapToTokenize && !tokenization.isCheapToTokenize(lineNumber)) {
        // Too expensive right now — the pure mask already covers correctness.
        return;
      }
      tokenization.forceTokenization(lineNumber);
      const lineTokens = tokenization.getLineTokens(lineNumber);
      if (!lineTokens) {
        return;
      }
      const count = lineTokens.getCount();
      for (let i = 0; i < count; i++) {
        const standard = lineTokens.getStandardTokenType(i);
        const kind = standard === STANDARD_TOKEN_STRING
          ? TokenKind.InlineCode
          : standard === STANDARD_TOKEN_COMMENT
            ? TokenKind.Comment
            : undefined;
        if (!kind) {
          continue;
        }
        const startColumn = lineTokens.getStartOffset(i) + 1;
        const endColumn = lineTokens.getEndOffset(i) + 1;
        if (endColumn > startColumn) {
          tokens.push({ startColumn, endColumn, kind });
        }
      }
    } catch {
      // Fail-open: the pure code mask remains authoritative.
    }
  }
}
