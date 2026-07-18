import { describe, expect, it } from 'bun:test';
import {
  BROWSER_RENDERABLE_IMAGE_EXTENSIONS,
  IMAGE_MIME_BY_EXTENSION,
  imageExtensionOf,
  imageMimeForPath,
  isBrowserRenderableImage,
  isImagePath
} from './image-mime';

describe('imageExtensionOf', () => {
  it('lower-cases the final extension', () => {
    expect(imageExtensionOf('scans/Page.PNG')).toBe('png');
    expect(imageExtensionOf('a/b/c.WebP')).toBe('webp');
  });

  it('isolates only the last extension of a dotted name', () => {
    expect(imageExtensionOf('archive.backup.jpeg')).toBe('jpeg');
    expect(imageExtensionOf('my.photo.final.tiff')).toBe('tiff');
  });

  it('returns empty for no extension and for dot-files', () => {
    expect(imageExtensionOf('noext')).toBe('');
    expect(imageExtensionOf('folder/README')).toBe('');
    expect(imageExtensionOf('.gitignore')).toBe('');
    expect(imageExtensionOf('dir.with.dot/file')).toBe('');
  });
});

describe('IMAGE_MIME_BY_EXTENSION coverage', () => {
  it('maps every documented format to its mime', () => {
    expect(IMAGE_MIME_BY_EXTENSION).toMatchObject({
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
    });
  });
});

describe('imageMimeForPath', () => {
  it('resolves the mime for a recognised image', () => {
    expect(imageMimeForPath('cover.webp')).toBe('image/webp');
    expect(imageMimeForPath('page.TIFF')).toBe('image/tiff');
    expect(imageMimeForPath('icon.ico')).toBe('image/x-icon');
  });

  it('returns undefined for a non-image or extensionless path', () => {
    expect(imageMimeForPath('notes.md')).toBeUndefined();
    expect(imageMimeForPath('data.json')).toBeUndefined();
    expect(imageMimeForPath('LICENSE')).toBeUndefined();
  });
});

describe('isImagePath', () => {
  it('accepts every image format including non-renderable ones', () => {
    expect(isImagePath('a.png')).toBe(true);
    expect(isImagePath('a.WEBP')).toBe(true);
    expect(isImagePath('scan.tiff')).toBe(true);
    expect(isImagePath('photo.heic')).toBe(true);
  });

  it('rejects non-image paths', () => {
    expect(isImagePath('chapter.md')).toBe(false);
    expect(isImagePath('deck.pptx')).toBe(false);
    expect(isImagePath('noext')).toBe(false);
  });
});

describe('isBrowserRenderableImage', () => {
  it('accepts formats a Chromium <img> can paint', () => {
    for (const ext of ['png', 'apng', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif']) {
      expect(isBrowserRenderableImage(`file.${ext}`)).toBe(true);
      expect(BROWSER_RENDERABLE_IMAGE_EXTENSIONS.has(ext)).toBe(true);
    }
  });

  it('rejects tiff/heic even though they are images', () => {
    expect(isImagePath('scan.tiff')).toBe(true);
    expect(isBrowserRenderableImage('scan.tiff')).toBe(false);
    expect(isBrowserRenderableImage('scan.tif')).toBe(false);
    expect(isBrowserRenderableImage('photo.heic')).toBe(false);
    expect(isBrowserRenderableImage('photo.heif')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isBrowserRenderableImage('COVER.PNG')).toBe(true);
    expect(isBrowserRenderableImage('SCAN.TIFF')).toBe(false);
  });

  it('rejects non-image paths', () => {
    expect(isBrowserRenderableImage('notes.txt')).toBe(false);
  });
});
