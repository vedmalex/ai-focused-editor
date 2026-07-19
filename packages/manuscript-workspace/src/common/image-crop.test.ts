import { describe, expect, it } from 'bun:test';
import { cropFileName, stripImageExtension, uniqueCropFileName } from './image-crop';

describe('stripImageExtension', () => {
  it('strips a regular extension', () => {
    expect(stripImageExtension('photo.png')).toBe('photo');
    expect(stripImageExtension('cover.jpeg')).toBe('cover');
  });

  it('strips only the last extension', () => {
    expect(stripImageExtension('archive.tar.png')).toBe('archive.tar');
  });

  it('keeps a no-extension name whole', () => {
    expect(stripImageExtension('README')).toBe('README');
  });

  it('keeps a leading-dot name whole', () => {
    expect(stripImageExtension('.hidden')).toBe('.hidden');
  });
});

describe('cropFileName', () => {
  it('derives <base>-crop.png for the first attempt', () => {
    expect(cropFileName('photo.png')).toBe('photo-crop.png');
    expect(cropFileName('cover.jpg', 0)).toBe('cover-crop.png');
  });

  it('derives <base>-crop-N.png for later attempts', () => {
    expect(cropFileName('photo.png', 1)).toBe('photo-crop-1.png');
    expect(cropFileName('photo.png', 2)).toBe('photo-crop-2.png');
  });

  it('always outputs .png regardless of the source format', () => {
    expect(cropFileName('scan.webp')).toBe('scan-crop.png');
    expect(cropFileName('icon.svg', 3)).toBe('icon-crop-3.png');
  });
});

describe('uniqueCropFileName', () => {
  const existsIn = (taken: string[]) => (candidate: string) => Promise.resolve(taken.includes(candidate));

  it('returns <base>-crop.png when free', async () => {
    expect(await uniqueCropFileName('photo.png', existsIn([]))).toBe('photo-crop.png');
  });

  it('skips to -1 when -crop.png is taken', async () => {
    expect(await uniqueCropFileName('photo.png', existsIn(['photo-crop.png']))).toBe('photo-crop-1.png');
  });

  it('skips over a run of taken names', async () => {
    const taken = ['photo-crop.png', 'photo-crop-1.png', 'photo-crop-2.png'];
    expect(await uniqueCropFileName('photo.png', existsIn(taken))).toBe('photo-crop-3.png');
  });

  it('throws when every candidate is taken', async () => {
    await expect(uniqueCropFileName('photo.png', () => Promise.resolve(true), 5)).rejects.toThrow(/No free crop file name/);
  });
});
