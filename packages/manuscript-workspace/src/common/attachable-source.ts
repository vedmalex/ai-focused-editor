// Pure helpers for deciding which files under a book's `sources/` folder can be
// attached to the AI chat as a *binary* payload the model actually sees (images
// and PDFs), as opposed to the text-extraction `#source` path.
//
// These are provider-agnostic and DOM-free so they live in `common/` and can be
// unit-tested without a browser. The browser contribution turns the resulting
// {kind, mimeType} into a Theia `imageContext` context-variable argument.

/**
 * How an attachable binary source is carried into the chat context.
 *  - `image`  — a raster/vector image Theia's own on-demand image resolver
 *               understands, so it can be attached path-based (no inline bytes
 *               stored in the session; resolved lazily at send time).
 *  - `document` — a PDF; Theia's extension→mime table does not know `.pdf`, so
 *               the bytes + an explicit `application/pdf` mime must be inlined
 *               for the model to receive a correctly-typed attachment.
 */
export type AttachableSourceKind = 'image' | 'document';

interface AttachableSourceType {
  mimeType: string;
  kind: AttachableSourceKind;
}

/**
 * Extension (lower-case, with leading dot) → { mimeType, kind } for every binary
 * source that can be attached as an image/PDF. The image entries mirror Theia's
 * `getMimeTypeFromExtension`; `.pdf` is the book-specific addition.
 */
export const ATTACHABLE_SOURCE_TYPES: Readonly<Record<string, AttachableSourceType>> = {
  '.png': { mimeType: 'image/png', kind: 'image' },
  '.jpg': { mimeType: 'image/jpeg', kind: 'image' },
  '.jpeg': { mimeType: 'image/jpeg', kind: 'image' },
  '.webp': { mimeType: 'image/webp', kind: 'image' },
  '.gif': { mimeType: 'image/gif', kind: 'image' },
  '.bmp': { mimeType: 'image/bmp', kind: 'image' },
  '.svg': { mimeType: 'image/svg+xml', kind: 'image' },
  '.pdf': { mimeType: 'application/pdf', kind: 'document' }
};

/** Lower-case extension including the leading dot (`sources/Paper.PDF` → `.pdf`), or `''`. */
export function fileExtension(path: string): string {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const name = slash < 0 ? path : path.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot).toLowerCase();
}

/** The attach descriptor for `path`, or `undefined` when it is not an attachable binary source. */
export function attachableSourceType(path: string): AttachableSourceType | undefined {
  return ATTACHABLE_SOURCE_TYPES[fileExtension(path)];
}

/** MIME type for an attachable binary source, or `undefined` when `path` is not attachable. */
export function attachableSourceMimeType(path: string): string | undefined {
  return attachableSourceType(path)?.mimeType;
}

/** How the source should be carried (`image` = path-based, `document` = inline), or `undefined`. */
export function attachableSourceKind(path: string): AttachableSourceKind | undefined {
  return attachableSourceType(path)?.kind;
}

/** Whether `path` names a file that can be attached to the chat as an image/PDF. */
export function isAttachableSource(path: string): boolean {
  return attachableSourceType(path) !== undefined;
}
