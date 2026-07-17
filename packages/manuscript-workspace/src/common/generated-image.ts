import { createSemanticEntityId } from './entity-creation';

/**
 * Book-side helpers for landing an AI-generated image as a real book source.
 * Kept Theia-free (pure functions) so they unit-test in isolation; the browser
 * contribution wires them to FileService + the active editor.
 */

/** Workspace-relative folder generated images are written into. */
export const GENERATED_IMAGES_FOLDER = 'sources/generated';

/**
 * Map an image MIME type to a file extension (no leading dot). Normalizes case,
 * whitespace, and a trailing `;charset=...` parameter. Anything unrecognized
 * falls back to `png` — the near-universal default for image generators — so a
 * novel/blank MIME still yields a usable filename rather than throwing.
 */
export function mimeTypeToImageExtension(mimeType: string): string {
  const normalized = (mimeType || '').trim().toLowerCase().split(';')[0].trim();
  switch (normalized) {
    case 'image/png':
      return 'png';
    case 'image/jpeg':
    case 'image/jpg':
      return 'jpg';
    case 'image/webp':
      return 'webp';
    case 'image/gif':
      return 'gif';
    case 'image/svg+xml':
      return 'svg';
    default:
      return 'png';
  }
}

/**
 * Slug derived from the image prompt, reusing the shared semantic-id pipeline
 * (Cyrillic transliteration → NFKD → allowed-character collapse → 48-char cap,
 * with an `image-<hash>` fallback for a slug that would otherwise be empty).
 * Guarantees a filesystem-safe, non-empty stem.
 */
export function generatedImageSlug(prompt: string): string {
  return createSemanticEntityId('image', prompt);
}

/**
 * Filename for the `index`-th generated image (0-based `index`, 1-based `-n`
 * suffix), e.g. `zamok-na-holme-1.png`.
 */
export function buildGeneratedImageFilename(prompt: string, index: number, mimeType: string): string {
  const suffix = Math.max(0, Math.trunc(index)) + 1;
  return `${generatedImageSlug(prompt)}-${suffix}.${mimeTypeToImageExtension(mimeType)}`;
}

/** Workspace-relative path (`sources/generated/<slug>-<n>.<ext>`) for a generated image. */
export function generatedImageRelativePath(prompt: string, index: number, mimeType: string): string {
  return `${GENERATED_IMAGES_FOLDER}/${buildGeneratedImageFilename(prompt, index, mimeType)}`;
}

/**
 * Short single-line excerpt of the prompt for a Markdown image `alt` text,
 * whitespace-collapsed and capped so a long paragraph prompt does not bloat the
 * inserted `![...]` tag.
 */
export function imageAltFromPrompt(prompt: string, maxLength = 80): string {
  const singleLine = (prompt || '').replace(/\s+/g, ' ').trim();
  if (singleLine.length <= maxLength) {
    return singleLine;
  }
  return `${singleLine.slice(0, Math.max(1, maxLength - 1))}…`;
}
