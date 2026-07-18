/**
 * Single source of truth for image formats across the manuscript workspace.
 *
 * The image-viewer editor, the semantic-markdown preview (inline data URIs), and
 * the proofreading scan pane all classify image files and pick a data-URI mime
 * from HERE, so the set of recognised formats can never drift between them.
 *
 * Two axes matter and are kept separate:
 *  - {@link IMAGE_MIME_BY_EXTENSION} — every image extension we understand, so a
 *    file can be recognised as an image and given a correct `data:` mime.
 *  - {@link BROWSER_RENDERABLE_IMAGE_EXTENSIONS} — the subset a Chromium/Electron
 *    `<img>` can actually paint. `tiff`/`heic`/`heif` are images but NOT
 *    renderable, so the viewer shows a "convert to PNG/JPEG" panel for them
 *    instead of a broken `<img>`.
 */

/** Extension (lower-case, no dot) -> data-URI mime for every common image format. */
export const IMAGE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  png: 'image/png',
  apng: 'image/apng',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  heic: 'image/heic',
  heif: 'image/heif'
};

/**
 * Extensions a Chromium `<img>` (Electron renderer) can display natively. Notably
 * EXCLUDES `tiff`/`tif`/`heic`/`heif`, which the browser cannot decode — those are
 * still images (they are in {@link IMAGE_MIME_BY_EXTENSION}) but must be surfaced
 * with a "can't preview, convert it" message rather than rendered.
 */
export const BROWSER_RENDERABLE_IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  'png', 'apng', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'
]);

/**
 * Lower-case extension (no dot) of a POSIX-style path, or '' when there is none.
 * A leading-dot file name (`.gitignore`) has no extension. Mirrors the helper the
 * preview/proofreading widgets used before this module unified them.
 */
export function imageExtensionOf(path: string): string {
  const slash = path.lastIndexOf('/');
  const dot = path.lastIndexOf('.');
  if (dot <= slash + 1) {
    return '';
  }
  return path.slice(dot + 1).toLowerCase();
}

/** The data-URI mime for `path`'s extension, or `undefined` when it is not an image. */
export function imageMimeForPath(path: string): string | undefined {
  return IMAGE_MIME_BY_EXTENSION[imageExtensionOf(path)];
}

/** True when `path`'s extension is any recognised image format (renderable or not). */
export function isImagePath(path: string): boolean {
  return imageMimeForPath(path) !== undefined;
}

/** True when `path`'s extension is an image a Chromium `<img>` can actually paint. */
export function isBrowserRenderableImage(path: string): boolean {
  return BROWSER_RENDERABLE_IMAGE_EXTENSIONS.has(imageExtensionOf(path));
}
