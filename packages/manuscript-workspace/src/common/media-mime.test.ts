import { describe, expect, it } from 'bun:test';
import {
  AUDIO_MIME_BY_EXTENSION,
  BROWSER_PLAYABLE_MEDIA_EXTENSIONS,
  VIDEO_MIME_BY_EXTENSION,
  isAudioPath,
  isBrowserPlayableMedia,
  isMediaPath,
  isVideoPath,
  mediaExtensionOf,
  mediaMimeForPath
} from './media-mime';
import { DEFAULT_MEDIA_EXTENSIONS } from './transcript-set-model';

describe('mediaExtensionOf', () => {
  it('lower-cases the final extension', () => {
    expect(mediaExtensionOf('audio/Lecture.MP3')).toBe('mp3');
    expect(mediaExtensionOf('a/b/c.WebM')).toBe('webm');
  });

  it('isolates only the last extension of a dotted name', () => {
    expect(mediaExtensionOf('talk.backup.wav')).toBe('wav');
    expect(mediaExtensionOf('my.session.final.mkv')).toBe('mkv');
  });

  it('returns empty for no extension and for dot-files', () => {
    expect(mediaExtensionOf('noext')).toBe('');
    expect(mediaExtensionOf('folder/README')).toBe('');
    expect(mediaExtensionOf('.gitignore')).toBe('');
    expect(mediaExtensionOf('dir.with.dot/file')).toBe('');
  });
});

describe('mime tables coverage', () => {
  it('maps every documented audio format to its mime', () => {
    expect(AUDIO_MIME_BY_EXTENSION).toMatchObject({
      mp3: 'audio/mpeg',
      m4a: 'audio/mp4',
      wav: 'audio/wav',
      ogg: 'audio/ogg',
      flac: 'audio/flac',
      aac: 'audio/aac'
    });
  });

  it('maps every documented video format to its mime', () => {
    expect(VIDEO_MIME_BY_EXTENSION).toMatchObject({
      mp4: 'video/mp4',
      m4v: 'video/x-m4v',
      mov: 'video/quicktime',
      mkv: 'video/x-matroska',
      webm: 'video/webm',
      avi: 'video/x-msvideo'
    });
  });

  it('audio and video extension sets do not overlap', () => {
    for (const ext of Object.keys(AUDIO_MIME_BY_EXTENSION)) {
      expect(VIDEO_MIME_BY_EXTENSION[ext]).toBeUndefined();
    }
  });

  it('covers exactly the transcript feature\'s DEFAULT_MEDIA_EXTENSIONS universe', () => {
    // The transcript-check ingest and the media viewer must never drift apart.
    const recognised = new Set([
      ...Object.keys(AUDIO_MIME_BY_EXTENSION),
      ...Object.keys(VIDEO_MIME_BY_EXTENSION)
    ]);
    const transcriptUniverse = new Set(DEFAULT_MEDIA_EXTENSIONS.map(ext => ext.replace(/^\./, '')));
    expect(recognised).toEqual(transcriptUniverse);
    for (const ext of DEFAULT_MEDIA_EXTENSIONS) {
      expect(isMediaPath(`recording${ext}`)).toBe(true);
    }
  });
});

describe('mediaMimeForPath', () => {
  it('resolves the mime for recognised media', () => {
    expect(mediaMimeForPath('lecture.mp3')).toBe('audio/mpeg');
    expect(mediaMimeForPath('voice.M4A')).toBe('audio/mp4');
    expect(mediaMimeForPath('talk.wav')).toBe('audio/wav');
    expect(mediaMimeForPath('clip.mp4')).toBe('video/mp4');
    expect(mediaMimeForPath('clip.MOV')).toBe('video/quicktime');
    expect(mediaMimeForPath('clip.mkv')).toBe('video/x-matroska');
  });

  it('returns undefined for a non-media or extensionless path', () => {
    expect(mediaMimeForPath('notes.md')).toBeUndefined();
    expect(mediaMimeForPath('cover.png')).toBeUndefined();
    expect(mediaMimeForPath('LICENSE')).toBeUndefined();
  });
});

describe('isAudioPath / isVideoPath / isMediaPath', () => {
  it('classifies audio extensions as audio, not video', () => {
    for (const ext of ['mp3', 'm4a', 'wav', 'ogg', 'flac', 'aac']) {
      expect(isAudioPath(`a.${ext}`)).toBe(true);
      expect(isVideoPath(`a.${ext}`)).toBe(false);
      expect(isMediaPath(`a.${ext}`)).toBe(true);
    }
  });

  it('classifies video extensions as video, not audio', () => {
    for (const ext of ['mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi']) {
      expect(isVideoPath(`v.${ext}`)).toBe(true);
      expect(isAudioPath(`v.${ext}`)).toBe(false);
      expect(isMediaPath(`v.${ext}`)).toBe(true);
    }
  });

  it('is case-insensitive', () => {
    expect(isAudioPath('LECTURE.MP3')).toBe(true);
    expect(isVideoPath('CLIP.MKV')).toBe(true);
  });

  it('rejects non-media paths', () => {
    expect(isMediaPath('chapter.md')).toBe(false);
    expect(isMediaPath('cover.png')).toBe(false);
    expect(isMediaPath('noext')).toBe(false);
    expect(isMediaPath('transcriptset.yaml')).toBe(false);
  });
});

describe('isBrowserPlayableMedia', () => {
  it('accepts formats a Chromium <audio>/<video> can play', () => {
    for (const ext of ['mp3', 'm4a', 'wav', 'ogg', 'flac', 'aac', 'mp4', 'm4v', 'mov', 'webm']) {
      expect(isBrowserPlayableMedia(`file.${ext}`)).toBe(true);
      expect(BROWSER_PLAYABLE_MEDIA_EXTENSIONS.has(ext)).toBe(true);
    }
  });

  it('rejects mkv/avi even though they are media', () => {
    expect(isMediaPath('session.mkv')).toBe(true);
    expect(isBrowserPlayableMedia('session.mkv')).toBe(false);
    expect(isMediaPath('session.avi')).toBe(true);
    expect(isBrowserPlayableMedia('session.avi')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isBrowserPlayableMedia('TALK.WAV')).toBe(true);
    expect(isBrowserPlayableMedia('TALK.MKV')).toBe(false);
  });

  it('rejects non-media paths', () => {
    expect(isBrowserPlayableMedia('notes.txt')).toBe(false);
  });

  it('every playable extension is a recognised media extension', () => {
    for (const ext of BROWSER_PLAYABLE_MEDIA_EXTENSIONS) {
      expect(isMediaPath(`f.${ext}`)).toBe(true);
    }
  });
});
