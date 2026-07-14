import { describe, expect, it } from 'bun:test';
import {
  countNonWhitespace,
  decideSourceAttachRoute,
  MIN_EXTRACTABLE_TEXT_CHARS
} from './source-attach-routing';

describe('countNonWhitespace', () => {
  it('counts only non-whitespace characters', () => {
    expect(countNonWhitespace('')).toBe(0);
    expect(countNonWhitespace('   \n\t  ')).toBe(0);
    expect(countNonWhitespace('abc')).toBe(3);
    expect(countNonWhitespace('a b\tc\nd')).toBe(4);
    expect(countNonWhitespace('  hello  world  ')).toBe(10);
  });

  it('counts unicode letters as single characters', () => {
    expect(countNonWhitespace('привет мир')).toBe(9);
  });
});

describe('decideSourceAttachRoute', () => {
  const long = 'x'.repeat(MIN_EXTRACTABLE_TEXT_CHARS);
  const longer = 'x'.repeat(MIN_EXTRACTABLE_TEXT_CHARS + 500);
  const short = 'x'.repeat(MIN_EXTRACTABLE_TEXT_CHARS - 1);

  it('routes substantial text to `text` regardless of vision', () => {
    expect(decideSourceAttachRoute({ hasVision: false, extractedTextLength: longer.length })).toBe('text');
    expect(decideSourceAttachRoute({ hasVision: true, extractedTextLength: longer.length })).toBe('text');
  });

  it('treats exactly the threshold as substantial (>=)', () => {
    expect(decideSourceAttachRoute({ hasVision: false, extractedTextLength: long.length })).toBe('text');
  });

  it('falls back to `vision` when text is thin but the model has vision', () => {
    expect(decideSourceAttachRoute({ hasVision: true, extractedTextLength: short.length })).toBe('vision');
    expect(decideSourceAttachRoute({ hasVision: true, extractedTextLength: 0 })).toBe('vision');
  });

  it('blocks a scanned PDF (thin text) when the model has no vision', () => {
    expect(decideSourceAttachRoute({ hasVision: false, extractedTextLength: short.length })).toBe('blocked');
    expect(decideSourceAttachRoute({ hasVision: false, extractedTextLength: 0 })).toBe('blocked');
  });
});
