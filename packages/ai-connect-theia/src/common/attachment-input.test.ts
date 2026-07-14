import { describe, expect, test } from 'bun:test';
import type { Base64ImageContent, UrlImageContent } from '@theia/ai-core';
import { imageMessageToAttachment, toPortableFileInput } from './attachment-input';

describe('toPortableFileInput', () => {
  test('passes a data-URL through verbatim', () => {
    const dataUrl = 'data:image/png;base64,AAAA';
    expect(toPortableFileInput({ dataUrl })).toBe(dataUrl);
  });

  test('assembles base64 + mimeType into a data-URL', () => {
    expect(toPortableFileInput({ base64: 'AAAA', mimeType: 'application/pdf' }))
      .toBe('data:application/pdf;base64,AAAA');
  });

  test('passes a remote url through verbatim', () => {
    expect(toPortableFileInput({ url: 'https://example.com/x.png' }))
      .toBe('https://example.com/x.png');
  });

  test('prefers dataUrl over base64 and url', () => {
    expect(toPortableFileInput({
      dataUrl: 'data:image/png;base64,ZZZ',
      base64: 'AAAA',
      mimeType: 'image/png',
      url: 'https://example.com/x.png'
    })).toBe('data:image/png;base64,ZZZ');
  });

  test('returns undefined for an empty attachment', () => {
    expect(toPortableFileInput({})).toBeUndefined();
  });

  test('returns undefined for base64 without a mimeType', () => {
    expect(toPortableFileInput({ base64: 'AAAA' })).toBeUndefined();
  });
});

describe('imageMessageToAttachment', () => {
  test('maps a UrlImageContent to { url }', () => {
    const image: UrlImageContent = { url: 'https://example.com/pic.png' };
    expect(imageMessageToAttachment(image)).toEqual({ url: 'https://example.com/pic.png' });
  });

  test('maps a Base64ImageContent to { base64, mimeType }', () => {
    const image: Base64ImageContent = { base64data: 'BBBB', mimeType: 'image/jpeg' };
    expect(imageMessageToAttachment(image)).toEqual({ base64: 'BBBB', mimeType: 'image/jpeg' });
  });

  test('a mapped base64 image round-trips into a data-URL', () => {
    const image: Base64ImageContent = { base64data: 'BBBB', mimeType: 'image/jpeg' };
    expect(toPortableFileInput(imageMessageToAttachment(image)))
      .toBe('data:image/jpeg;base64,BBBB');
  });
});
