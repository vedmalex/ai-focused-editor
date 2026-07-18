import { describe, expect, test } from 'bun:test';
import type { PortableFilePayload } from '@vedmalex/ai-connect';
import { toGeneratedImage } from './ai-image';

function payload(overrides: Partial<PortableFilePayload> = {}): PortableFilePayload {
  return {
    category: 'image',
    mimeType: 'image/png',
    name: 'out.png',
    base64: 'aGVsbG8=',
    ...overrides
  } as PortableFilePayload;
}

describe('toGeneratedImage', () => {
  test('maps base64 + mimeType + name', () => {
    expect(toGeneratedImage(payload())).toEqual({ base64: 'aGVsbG8=', mimeType: 'image/png', name: 'out.png' });
  });

  test('drops the name when empty', () => {
    expect(toGeneratedImage(payload({ name: '' }))).toEqual({ base64: 'aGVsbG8=', mimeType: 'image/png', name: undefined });
  });

  test('returns undefined when there are no base64 bytes', () => {
    expect(toGeneratedImage(payload({ base64: undefined, uri: 'https://x/y.png' }))).toBeUndefined();
  });
});
