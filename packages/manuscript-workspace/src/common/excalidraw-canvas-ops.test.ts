import { describe, expect, test } from 'bun:test';
import {
  CanvasElement,
  DEFAULT_FONT_SIZE,
  DEFAULT_LINE_HEIGHT,
  arrowBetween,
  boundingBox,
  boxAround,
  centerOf,
  chainArrows,
  mergeTextElements,
  splitTextByLines,
  stickyForText
} from './excalidraw-canvas-ops';

function text(partial: Partial<CanvasElement>): CanvasElement {
  return {
    type: 'text',
    x: 0,
    y: 0,
    width: 100,
    height: 25,
    text: '',
    ...partial
  };
}

function rect(partial: Partial<CanvasElement>): CanvasElement {
  return {
    type: 'rectangle',
    x: 0,
    y: 0,
    width: 50,
    height: 50,
    ...partial
  };
}

describe('splitTextByLines', () => {
  test('splits a multi-line block into one spec per line, advancing y by fontSize*lineHeight', () => {
    const el = text({ x: 10, y: 100, fontSize: 20, lineHeight: 1.25, text: 'one\ntwo\nthree' });
    const advance = 20 * 1.25; // 25
    expect(splitTextByLines(el)).toEqual([
      { text: 'one', x: 10, y: 100, fontSize: 20, lineHeight: 1.25, textAlign: undefined, strokeColor: undefined },
      { text: 'two', x: 10, y: 100 + advance, fontSize: 20, lineHeight: 1.25, textAlign: undefined, strokeColor: undefined },
      { text: 'three', x: 10, y: 100 + advance * 2, fontSize: 20, lineHeight: 1.25, textAlign: undefined, strokeColor: undefined }
    ]);
  });

  test('preserves x, textAlign and strokeColor on every line', () => {
    const el = text({ x: 42, text: 'a\nb', textAlign: 'center', strokeColor: '#ff0000' });
    const result = splitTextByLines(el);
    for (const spec of result) {
      expect(spec.x).toBe(42);
      expect(spec.textAlign).toBe('center');
      expect(spec.strokeColor).toBe('#ff0000');
    }
  });

  test('keeps interior blank lines as empty-text specs at their true y', () => {
    const el = text({ x: 0, y: 0, fontSize: 10, lineHeight: 2, text: 'a\n\nb' });
    const advance = 10 * 2; // 20
    const result = splitTextByLines(el);
    expect(result.map(s => s.text)).toEqual(['a', '', 'b']);
    expect(result.map(s => s.y)).toEqual([0, advance, advance * 2]);
  });

  test('keeps a trailing newline as a final empty line (round-trips with merge)', () => {
    const el = text({ text: 'a\nb\n' });
    const result = splitTextByLines(el);
    expect(result.map(s => s.text)).toEqual(['a', 'b', '']);
  });

  test('single line with no newline yields exactly one spec at the original y', () => {
    const el = text({ x: 5, y: 7, text: 'solo' });
    expect(splitTextByLines(el)).toEqual([
      { text: 'solo', x: 5, y: 7, fontSize: DEFAULT_FONT_SIZE, lineHeight: DEFAULT_LINE_HEIGHT, textAlign: undefined, strokeColor: undefined }
    ]);
  });

  test('falls back to default font size and line height when absent', () => {
    const el = text({ x: 0, y: 0, text: 'x\ny', fontSize: undefined, lineHeight: undefined });
    const advance = DEFAULT_FONT_SIZE * DEFAULT_LINE_HEIGHT;
    const result = splitTextByLines(el);
    expect(result[0].fontSize).toBe(DEFAULT_FONT_SIZE);
    expect(result[1].y).toBe(advance);
  });
});

describe('mergeTextElements', () => {
  test('joins texts in top-to-bottom order regardless of input order', () => {
    const els = [
      text({ x: 0, y: 200, text: 'bottom' }),
      text({ x: 0, y: 0, text: 'top' }),
      text({ x: 0, y: 100, text: 'middle' })
    ];
    const merged = mergeTextElements(els);
    expect(merged?.text).toBe('top\nmiddle\nbottom');
  });

  test('positions the merged element at the topmost element and inherits its styling', () => {
    const els = [
      text({ x: 50, y: 100, text: 'lower', fontSize: 16, textAlign: 'right', strokeColor: '#00f' }),
      text({ x: 10, y: 5, text: 'upper', fontSize: 30, textAlign: 'left', strokeColor: '#0f0' })
    ];
    const merged = mergeTextElements(els);
    expect(merged).toMatchObject({ x: 10, y: 5, fontSize: 30, textAlign: 'left', strokeColor: '#0f0' });
  });

  test('breaks y ties left-to-right by x', () => {
    const els = [
      text({ x: 300, y: 0, text: 'right' }),
      text({ x: 0, y: 0, text: 'left' }),
      text({ x: 150, y: 0, text: 'center' })
    ];
    expect(mergeTextElements(els)?.text).toBe('left\ncenter\nright');
  });

  test('is the inverse of splitTextByLines for a simple block', () => {
    const original = text({ x: 12, y: 34, fontSize: 20, lineHeight: 1.25, text: 'a\nb\nc' });
    const parts = splitTextByLines(original).map(spec => text({
      x: spec.x,
      y: spec.y,
      fontSize: spec.fontSize,
      lineHeight: spec.lineHeight,
      text: spec.text
    }));
    const merged = mergeTextElements(parts);
    expect(merged?.text).toBe('a\nb\nc');
    expect(merged).toMatchObject({ x: 12, y: 34 });
  });

  test('returns undefined for an empty selection', () => {
    expect(mergeTextElements([])).toBeUndefined();
  });
});

describe('boundingBox', () => {
  test('encloses a mix of element types and positions', () => {
    const els = [
      rect({ x: 10, y: 20, width: 30, height: 40 }), // spans x 10..40, y 20..60
      text({ x: -5, y: 100, width: 50, height: 10 }), // spans x -5..45, y 100..110
      rect({ x: 200, y: 0, width: 5, height: 5 }) // spans x 200..205, y 0..5
    ];
    expect(boundingBox(els)).toEqual({ x: -5, y: 0, width: 210, height: 110 });
  });

  test('single element bbox equals that element', () => {
    expect(boundingBox([rect({ x: 3, y: 4, width: 7, height: 8 })])).toEqual({ x: 3, y: 4, width: 7, height: 8 });
  });

  test('empty input yields a zero box at origin', () => {
    expect(boundingBox([])).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
});

describe('boxAround', () => {
  test('pads the bounding box outward on all sides', () => {
    const bbox = { x: 10, y: 20, width: 100, height: 50 };
    expect(boxAround(bbox, 8)).toEqual({ x: 2, y: 12, width: 116, height: 66 });
  });

  test('zero padding is a no-op', () => {
    const bbox = { x: 1, y: 2, width: 3, height: 4 };
    expect(boxAround(bbox, 0)).toEqual(bbox);
  });
});

describe('centerOf / arrowBetween', () => {
  test('centerOf returns the box center', () => {
    expect(centerOf(rect({ x: 0, y: 0, width: 100, height: 40 }))).toEqual({ x: 50, y: 20 });
  });

  test('arrowBetween connects the two centers', () => {
    const a = rect({ x: 0, y: 0, width: 20, height: 20 }); // center 10,10
    const b = rect({ x: 100, y: 60, width: 40, height: 40 }); // center 120,80
    expect(arrowBetween(a, b)).toEqual({ start: { x: 10, y: 10 }, end: { x: 120, y: 80 } });
  });
});

describe('chainArrows', () => {
  test('chains consecutive elements in selection order', () => {
    const a = rect({ x: 0, y: 0, width: 10, height: 10 }); // c 5,5
    const b = rect({ x: 100, y: 0, width: 10, height: 10 }); // c 105,5
    const c = rect({ x: 100, y: 100, width: 10, height: 10 }); // c 105,105
    expect(chainArrows([a, b, c])).toEqual([
      { start: { x: 5, y: 5 }, end: { x: 105, y: 5 } },
      { start: { x: 105, y: 5 }, end: { x: 105, y: 105 } }
    ]);
  });

  test('fewer than two elements yields no arrows', () => {
    expect(chainArrows([])).toEqual([]);
    expect(chainArrows([rect({})])).toEqual([]);
  });
});

describe('stickyForText', () => {
  test('sizes the rounded rectangle to the text plus padding, leaving the text in place', () => {
    const el = text({ x: 30, y: 40, width: 80, height: 24 });
    expect(stickyForText(el, 12)).toEqual({
      rect: { x: 18, y: 28, width: 104, height: 48 },
      text: { x: 30, y: 40 }
    });
  });

  test('zero padding wraps the text exactly', () => {
    const el = text({ x: 0, y: 0, width: 60, height: 20 });
    expect(stickyForText(el, 0)).toEqual({
      rect: { x: 0, y: 0, width: 60, height: 20 },
      text: { x: 0, y: 0 }
    });
  });
});
