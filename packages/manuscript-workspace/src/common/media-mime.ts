/**
 * Single source of truth for audio/video formats across the manuscript
 * workspace (the `common/image-mime.ts` pattern applied to media).
 *
 * The media-viewer editor classifies media files and picks a blob mime from
 * HERE. The extension universe is kept consistent with
 * `DEFAULT_MEDIA_EXTENSIONS` in `common/transcript-set-model.ts` — the same
 * media files the transcript-check feature ingests are the ones the viewer
 * must recognise (a test asserts this stays true).
 *
 * Two axes matter and are kept separate:
 *  - {@link AUDIO_MIME_BY_EXTENSION} / {@link VIDEO_MIME_BY_EXTENSION} — every
 *    media extension we understand, so a file can be recognised as media and
 *    given a correct blob mime.
 *  - {@link BROWSER_PLAYABLE_MEDIA_EXTENSIONS} — the subset a Chromium/Electron
 *    `<audio>`/`<video>` can actually play. `mkv`/`avi` are media but NOT
 *    playable in the browser engine, so the viewer shows a "cannot preview,
 *    open externally" panel for them instead of a broken player.
 */

/** Extension (lower-case, no dot) -> blob mime for every supported audio format. */
export const AUDIO_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  aac: 'audio/aac'
};

/** Extension (lower-case, no dot) -> blob mime for every supported video format. */
export const VIDEO_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  webm: 'video/webm',
  avi: 'video/x-msvideo'
};

/**
 * Extensions a Chromium `<audio>`/`<video>` (Electron renderer) can play
 * natively. Notably EXCLUDES `mkv`/`avi` — the browser engine has no demuxer
 * for them, so those are still media (they are in the mime maps) but must be
 * surfaced with a "cannot preview, open it externally" message rather than a
 * player that silently errors. `m4v` is an MP4-container variant and plays.
 */
export const BROWSER_PLAYABLE_MEDIA_EXTENSIONS: ReadonlySet<string> = new Set([
  // audio
  'mp3', 'm4a', 'wav', 'ogg', 'flac', 'aac',
  // video
  'mp4', 'm4v', 'mov', 'webm'
]);

/**
 * Lower-case extension (no dot) of a POSIX-style path, or '' when there is
 * none. A leading-dot file name (`.gitignore`) has no extension. Same contract
 * as `imageExtensionOf` in `common/image-mime.ts`.
 */
export function mediaExtensionOf(path: string): string {
  const slash = path.lastIndexOf('/');
  const dot = path.lastIndexOf('.');
  if (dot <= slash + 1) {
    return '';
  }
  return path.slice(dot + 1).toLowerCase();
}

/** The blob mime for `path`'s extension, or `undefined` when it is not media. */
export function mediaMimeForPath(path: string): string | undefined {
  const ext = mediaExtensionOf(path);
  return AUDIO_MIME_BY_EXTENSION[ext] ?? VIDEO_MIME_BY_EXTENSION[ext];
}

/** True when `path`'s extension is a recognised AUDIO format. */
export function isAudioPath(path: string): boolean {
  return AUDIO_MIME_BY_EXTENSION[mediaExtensionOf(path)] !== undefined;
}

/** True when `path`'s extension is a recognised VIDEO format. */
export function isVideoPath(path: string): boolean {
  return VIDEO_MIME_BY_EXTENSION[mediaExtensionOf(path)] !== undefined;
}

/** True when `path`'s extension is any recognised media format (playable or not). */
export function isMediaPath(path: string): boolean {
  return isAudioPath(path) || isVideoPath(path);
}

/** True when `path`'s extension is media a Chromium `<audio>`/`<video>` can play. */
export function isBrowserPlayableMedia(path: string): boolean {
  return BROWSER_PLAYABLE_MEDIA_EXTENSIONS.has(mediaExtensionOf(path));
}
