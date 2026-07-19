/**
 * Pure naming logic for the image editor's "Save fragment" action.
 *
 * A cropped fragment is always written as a NEW sibling PNG next to the
 * original (non-destructive editing): `<base>-crop.png` where `<base>` is the
 * original file name without its extension, falling back to
 * `<base>-crop-1.png`, `<base>-crop-2.png`, ... when the candidate already
 * exists. Kept in `common/` (no browser APIs) so it is unit-testable.
 */

/** `photo.png` -> `photo`; a leading-dot name (`.pic`) or no-dot name is kept whole. */
export function stripImageExtension(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(0, dot) : fileName;
}

/**
 * The `attempt`-th candidate name for a cropped fragment of `originalFileName`:
 * attempt 0 -> `<base>-crop.png`, attempt N -> `<base>-crop-N.png`. The output
 * is always `.png` regardless of the source format (lossless, universal).
 */
export function cropFileName(originalFileName: string, attempt = 0): string {
  const base = stripImageExtension(originalFileName);
  return attempt === 0 ? `${base}-crop.png` : `${base}-crop-${attempt}.png`;
}

/**
 * First candidate crop name for which `exists` reports false. `exists` receives
 * the bare candidate file name (no directory) — the caller resolves it against
 * the original's parent. Throws after `maxAttempts` candidates so a pathological
 * directory can never loop forever.
 */
export async function uniqueCropFileName(
  originalFileName: string,
  exists: (candidate: string) => Promise<boolean>,
  maxAttempts = 10_000
): Promise<string> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const candidate = cropFileName(originalFileName, attempt);
    if (!(await exists(candidate))) {
      return candidate;
    }
  }
  throw new Error(`No free crop file name found for: ${originalFileName}`);
}
