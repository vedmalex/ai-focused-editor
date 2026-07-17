// Pure, DOM-free decision helper for routing a binary source (PDF) into the AI
// chat as either extracted TEXT or a VISION (image) payload — or refusing when
// neither works. Lives in `common/` so it is unit-testable without a browser.
//
// The rule is deliberately simple and honest: we never OCR or render PDF pages.
// "Is there meaningful extractable text?" is the only signal. A born-digital PDF
// yields plenty of text (route as text — cheaper, works on any model); a scanned
// PDF yields little/none (needs a vision-capable model, or it is blocked).

/** Where a source attachment should be routed. */
export type SourceAttachRoute = 'text' | 'vision' | 'blocked';

/**
 * Minimum count of non-whitespace characters an extraction must yield to be
 * treated as "substantial" text worth attaching instead of the raw image/vision
 * payload. Short extractions (a scanned page's stray OCR-less bytes, a title
 * page) fall through to the vision/blocked branches.
 */
export const MIN_EXTRACTABLE_TEXT_CHARS = 200;

/** Count non-whitespace characters in `text` (the "meaningful text" measure). */
export function countNonWhitespace(text: string): number {
  let count = 0;
  for (const char of text) {
    if (!/\s/.test(char)) {
      count++;
    }
  }
  return count;
}

/**
 * Decide how to attach a PDF source given whether the active model has vision
 * and how much text extraction yielded:
 *  - substantial extractable text (>= {@link MIN_EXTRACTABLE_TEXT_CHARS}) → `text`
 *    (attach via the text-extraction `#source` path — cheapest, model-agnostic);
 *  - otherwise, if the model has vision → `vision` (attach the bytes as an image);
 *  - otherwise → `blocked` (a scanned PDF with no vision model can't be read).
 *
 * `hasVision` should be `true` when the model supports image input OR when
 * capabilities are unknown — an unknown model is never blocked here (the caller
 * decides not to block on unknown capabilities).
 */
export function decideSourceAttachRoute(input: {
  hasVision: boolean;
  extractedTextLength: number;
}): SourceAttachRoute {
  if (input.extractedTextLength >= MIN_EXTRACTABLE_TEXT_CHARS) {
    return 'text';
  }
  return input.hasVision ? 'vision' : 'blocked';
}
