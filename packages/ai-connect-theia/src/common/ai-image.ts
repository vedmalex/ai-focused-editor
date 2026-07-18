import type { PortableFilePayload } from '@vedmalex/ai-connect';

/**
 * A single generated image, book-agnostic and JSON-RPC-safe: raw `base64`
 * (no data-url prefix) plus its `mimeType` and an optional file name. Consumers
 * (a book-side command, a preview widget) build a data-url or write bytes as
 * they see fit.
 */
export interface AiGeneratedImage {
  base64: string;
  mimeType: string;
  name?: string;
}

/** Result of an image-generation request: the images plus any non-fatal warnings. */
export interface AiImageGenerationResult {
  images: AiGeneratedImage[];
  warnings: string[];
}

/** Options a consumer may pass to steer image generation (all optional). */
export interface AiImageGenerationOptions {
  size?: string;
  aspectRatio?: string;
  style?: string;
}

/**
 * Map a materialized {@link PortableFilePayload} to an {@link AiGeneratedImage}.
 * Returns undefined when the payload carries no raw `base64` bytes (e.g. a
 * remote-uri-only or text payload) so callers can drop it and record a warning.
 */
export function toGeneratedImage(payload: PortableFilePayload): AiGeneratedImage | undefined {
  if (!payload.base64) {
    return undefined;
  }
  return {
    base64: payload.base64,
    mimeType: payload.mimeType,
    name: payload.name || undefined
  };
}
