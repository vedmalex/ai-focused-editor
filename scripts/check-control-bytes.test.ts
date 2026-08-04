/**
 * Tests for the raw-control-byte guard (see `check-control-bytes.ts`).
 *
 * The end-to-end teeth — inject a byte, watch `bun run verify` go red — are
 * exercised by hand and recorded in the task. What is asserted here is the part
 * that can regress silently: which bytes are rejected, which are allowed, that a
 * genuine binary is not flagged, and that the failure message actually locates
 * the byte rather than merely announcing one.
 *
 * Every fixture below builds its bytes numerically. Writing a literal control
 * byte into this file would reproduce the exact defect under test.
 */

import { describe, expect, test } from 'bun:test';

import {
  ALLOWED_CONTROL_BYTES,
  controlByteName,
  formatReport,
  isUtf8Text,
  scanBytes,
  suggestedEscape
} from './check-control-bytes';

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

/** Splice a raw byte into ASCII text without typing one into this source file. */
const withByte = (before: string, byte: number, after: string): Uint8Array =>
  Uint8Array.from([...bytesOf(before), byte, ...bytesOf(after)]);

describe('scanBytes — rejected bytes', () => {
  test('flags a NUL and reports its offset, line and column', () => {
    const findings = scanBytes(withByte('const key = `a', 0x00, 'b`;'));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      byte: 0x00,
      name: 'NUL',
      offset: 14,
      line: 1,
      column: 15,
      escape: '\\u0000'
    });
  });

  test('counts lines so the column restarts after each LF', () => {
    const findings = scanBytes(withByte('one\ntwo\nthr', 0x01, 'ee\n'));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ byte: 0x01, name: 'SOH', line: 3, column: 4, offset: 11 });
  });

  test('flags form feed and ESC, which are deliberately not in the allowed set', () => {
    expect(scanBytes(withByte('a', 0x0c, 'b'))[0]).toMatchObject({ byte: 0x0c, name: 'FF' });
    expect(scanBytes(withByte('a', 0x1b, 'b'))[0]).toMatchObject({ byte: 0x1b, name: 'ESC' });
  });

  test('flags every C0 byte outside the allowed set, and only those', () => {
    const flagged: number[] = [];
    for (let byte = 0x00; byte <= 0x1f; byte++) {
      if (scanBytes(Uint8Array.from([0x61, byte, 0x62])).length > 0) {
        flagged.push(byte);
      }
    }
    const expected = Array.from({ length: 0x20 }, (_, b) => b).filter(
      b => !ALLOWED_CONTROL_BYTES.has(b)
    );
    expect(flagged).toEqual(expected);
    expect(flagged).toHaveLength(29);
  });

  test('reports each occurrence, not just the first', () => {
    const bytes = Uint8Array.from([...bytesOf('a'), 0x00, ...bytesOf('b'), 0x00, ...bytesOf('c')]);
    expect(scanBytes(bytes).map(f => f.offset)).toEqual([1, 3]);
  });
});

describe('scanBytes — allowed bytes', () => {
  test('passes TAB, LF and CR', () => {
    expect(scanBytes(bytesOf('a\tb\r\nc\n'))).toEqual([]);
  });

  test('passes ordinary source, including non-ASCII and emoji', () => {
    expect(scanBytes(bytesOf('const s = "обычный текст — ok ✅";\n'))).toEqual([]);
  });

  test('passes a file that merely mentions the escape in text', () => {
    expect(scanBytes(bytesOf('const key = `${a}\\u0000${b}`;\n'))).toEqual([]);
  });
});

describe('isUtf8Text — the text/binary question', () => {
  test('a PNG header is not text, so genuine binaries are skipped', () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(isUtf8Text(png)).toBe(false);
  });

  test('a lone continuation byte is not text', () => {
    expect(isUtf8Text(Uint8Array.from([0x80, 0x81]))).toBe(false);
  });

  test('UTF-8 prose is text', () => {
    expect(isUtf8Text(bytesOf('Гладь — smooth. 漢字. 🙂'))).toBe(true);
  });

  test('a NUL-bearing source file still counts as text, which is the whole point', () => {
    // git would call this binary and skip it; the guard must not.
    expect(isUtf8Text(withByte('const key = `a', 0x00, 'b`;'))).toBe(true);
  });
});

describe('failure message', () => {
  test('names the file, the byte and the offset', () => {
    const message = formatReport({
      scanned: 10,
      skippedBinary: 1,
      findings: [
        {
          file: 'packages/x/src/y.ts',
          offset: 4213,
          line: 101,
          column: 45,
          byte: 0x00,
          name: 'NUL',
          escape: '\\u0000'
        }
      ]
    });
    expect(message).toContain('packages/x/src/y.ts:101:45');
    expect(message).toContain('0x00 (NUL)');
    expect(message).toContain('offset 4213');
    expect(message).toContain('\\u0000');
  });
});

describe('naming helpers', () => {
  test('maps the C0 block to its mnemonics', () => {
    expect(controlByteName(0x00)).toBe('NUL');
    expect(controlByteName(0x1b)).toBe('ESC');
    expect(controlByteName(0x1f)).toBe('US');
  });

  test('suggests a four-digit unicode escape, which never collides with a following digit', () => {
    expect(suggestedEscape(0x00)).toBe('\\u0000');
    expect(suggestedEscape(0x1b)).toBe('\\u001b');
  });
});
