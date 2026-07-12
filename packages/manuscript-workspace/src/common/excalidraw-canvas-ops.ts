/**
 * Pure, framework-free geometry/text helpers backing the "canvas conveniences"
 * command set for the Excalidraw editor (see
 * `browser/excalidraw-canvas-ops-contribution.ts`).
 *
 * These functions are deliberately Theia- AND Excalidraw-free: they take a loose
 * element model and return plain DATA describing the transform. The browser
 * contribution turns that data into real Excalidraw elements via
 * `convertToExcalidrawElements` and applies it through the imperative API. Keeping
 * the maths here makes the tricky bits (multi-line split geometry, merge order,
 * bounding boxes, arrow centers, sticky sizing) unit-testable without a DOM.
 */

/**
 * Minimal, loosely-typed view of an Excalidraw element. Only the fields the
 * canvas ops read are modelled; everything else on a real element is ignored.
 */
export interface CanvasElement {
  id?: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
  fontSize?: number;
  lineHeight?: number;
  textAlign?: string;
  strokeColor?: string;
  backgroundColor?: string;
}

/** Axis-aligned rectangle, as returned by {@link boundingBox} / {@link boxAround}. */
export interface RectSpec {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A 2-D point (element center, arrow endpoint). */
export interface Point {
  x: number;
  y: number;
}

/**
 * Data describing a single text element produced by {@link splitTextByLines} or
 * consumed conceptually by {@link mergeTextElements}. Carries the styling worth
 * preserving across the transform; the browser layer maps it onto a text
 * skeleton.
 */
export interface TextSpec {
  text: string;
  x: number;
  y: number;
  fontSize: number;
  lineHeight: number;
  textAlign?: string;
  strokeColor?: string;
}

/**
 * Excalidraw's default font size (the "M" preset) — used when an element carries
 * no explicit `fontSize`.
 */
export const DEFAULT_FONT_SIZE = 20;

/**
 * Excalidraw's default line-height multiplier. Line advance in a multi-line text
 * element is `fontSize * lineHeight` pixels.
 */
export const DEFAULT_LINE_HEIGHT = 1.25;

function fontSizeOf(el: CanvasElement): number {
  return typeof el.fontSize === 'number' && el.fontSize > 0 ? el.fontSize : DEFAULT_FONT_SIZE;
}

function lineHeightOf(el: CanvasElement): number {
  return typeof el.lineHeight === 'number' && el.lineHeight > 0 ? el.lineHeight : DEFAULT_LINE_HEIGHT;
}

/** Center point of an element's bounding box. */
export function centerOf(el: CanvasElement): Point {
  return { x: el.x + el.width / 2, y: el.y + el.height / 2 };
}

/**
 * Split a text element into one {@link TextSpec} per line. Each line keeps the
 * element's `x` and styling; `y` advances by `fontSize * lineHeight` per line so
 * the stack visually matches the original block. Blank/trailing lines are
 * preserved as empty-`text` specs (so the vertical positions stay faithful and a
 * subsequent {@link mergeTextElements} round-trips); the browser layer may skip
 * materializing empty ones.
 */
export function splitTextByLines(textEl: CanvasElement): TextSpec[] {
  const fontSize = fontSizeOf(textEl);
  const lineHeight = lineHeightOf(textEl);
  const advance = fontSize * lineHeight;
  const lines = (textEl.text ?? '').split('\n');
  return lines.map((line, index) => ({
    text: line,
    x: textEl.x,
    y: textEl.y + index * advance,
    fontSize,
    lineHeight,
    textAlign: textEl.textAlign,
    strokeColor: textEl.strokeColor
  }));
}

/**
 * Merge several text elements into one multi-line {@link TextSpec}. Elements are
 * sorted top-to-bottom by `y` (ties broken by `x`, left-to-right) and their texts
 * joined with newlines. The result sits at the topmost element's position and
 * inherits its styling. Returns `undefined` for an empty input.
 */
export function mergeTextElements(textEls: readonly CanvasElement[]): TextSpec | undefined {
  if (textEls.length === 0) {
    return undefined;
  }
  const sorted = [...textEls].sort((a, b) => (a.y - b.y) || (a.x - b.x));
  const top = sorted[0];
  return {
    text: sorted.map(el => el.text ?? '').join('\n'),
    x: top.x,
    y: top.y,
    fontSize: fontSizeOf(top),
    lineHeight: lineHeightOf(top),
    textAlign: top.textAlign,
    strokeColor: top.strokeColor
  };
}

/**
 * Bounding box enclosing all given elements. Returns a zero-size box at the
 * origin for an empty input.
 */
export function boundingBox(elements: readonly CanvasElement[]): RectSpec {
  if (elements.length === 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const el of elements) {
    minX = Math.min(minX, el.x);
    minY = Math.min(minY, el.y);
    maxX = Math.max(maxX, el.x + el.width);
    maxY = Math.max(maxY, el.y + el.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Rectangle wrapping a bounding box with uniform `padding` on every side (grows
 * the box outward). Used by "Box Selected".
 */
export function boxAround(bbox: RectSpec, padding: number): RectSpec {
  return {
    x: bbox.x - padding,
    y: bbox.y - padding,
    width: bbox.width + padding * 2,
    height: bbox.height + padding * 2
  };
}

/** Straight arrow from the center of `a` to the center of `b`. */
export function arrowBetween(a: CanvasElement, b: CanvasElement): { start: Point; end: Point } {
  return { start: centerOf(a), end: centerOf(b) };
}

/**
 * Chain of center-to-center arrows connecting consecutive elements in the given
 * order (`[a→b, b→c, …]`). Fewer than two elements yields no arrows.
 */
export function chainArrows(elements: readonly CanvasElement[]): { start: Point; end: Point }[] {
  const arrows: { start: Point; end: Point }[] = [];
  for (let i = 0; i < elements.length - 1; i++) {
    arrows.push(arrowBetween(elements[i], elements[i + 1]));
  }
  return arrows;
}

/**
 * Sticky-note geometry for a text element: a rounded rectangle sized to the text
 * plus `padding` on every side, with the text placement unchanged (so the text
 * sits `padding` in from the rectangle's top-left corner).
 */
export function stickyForText(textEl: CanvasElement, padding: number): { rect: RectSpec; text: Point } {
  return {
    rect: {
      x: textEl.x - padding,
      y: textEl.y - padding,
      width: textEl.width + padding * 2,
      height: textEl.height + padding * 2
    },
    text: { x: textEl.x, y: textEl.y }
  };
}
