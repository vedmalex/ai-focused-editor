import type { ImageContent } from '@theia/ai-core';
import type { AiConnectAttachment } from './ai-connection-protocol';

/** A reference to a file already uploaded to a provider's Files API. */
export interface PortableFileReference {
  providerFileId: string;
  mimeType?: string;
  name?: string;
}

/** Every carrier {@link toPortableFileInput} can emit for ai-connect. */
export type PortableFileInputLike = string | PortableFileReference;

/**
 * Converts a portable {@link AiConnectAttachment} into an ai-connect
 * `PortableFileInput`. Precedence: a `providerFileId` becomes a remote
 * file reference (re-references an already-uploaded file without re-sending
 * bytes); else an explicit `dataUrl` is passed verbatim; else `base64` +
 * `mimeType` are assembled into a `data:` URL; else a remote `url` is passed
 * verbatim. An attachment carrying none of these (or base64 without a
 * mimeType) yields `undefined` so callers can drop it.
 */
export function toPortableFileInput(att: AiConnectAttachment): PortableFileInputLike | undefined {
  if (att.providerFileId) {
    return { providerFileId: att.providerFileId, mimeType: att.mimeType, name: att.name };
  }
  if (att.dataUrl) {
    return att.dataUrl;
  }
  if (att.base64 && att.mimeType) {
    return `data:${att.mimeType};base64,${att.base64}`;
  }
  if (att.url) {
    return att.url;
  }
  return undefined;
}

/**
 * Converts a list of portable attachments into ai-connect `PortableFileInput`
 * strings, dropping any attachment that carries no usable carrier. Returns
 * `undefined` when there is nothing to send (so the field is omitted).
 */
export function toPortableFileInputs(attachments: AiConnectAttachment[] | undefined): PortableFileInputLike[] | undefined {
  if (!attachments || attachments.length === 0) {
    return undefined;
  }
  const inputs = attachments
    .map(toPortableFileInput)
    .filter((input): input is PortableFileInputLike => input !== undefined);
  return inputs.length > 0 ? inputs : undefined;
}

/**
 * Maps a Theia {@link ImageContent} to a portable {@link AiConnectAttachment}:
 * a `UrlImageContent` becomes `{ url }`; a `Base64ImageContent` becomes
 * `{ base64, mimeType }`.
 */
export function imageMessageToAttachment(image: ImageContent): AiConnectAttachment {
  if ('url' in image) {
    return { url: image.url };
  }
  return { base64: image.base64data, mimeType: image.mimeType };
}
