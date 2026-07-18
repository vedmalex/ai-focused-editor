import { describe, expect, test } from 'bun:test';
import {
  GENERATED_IMAGES_FOLDER,
  buildGeneratedImageFilename,
  generatedImageRelativePath,
  generatedImageSlug,
  imageAltFromPrompt,
  mimeTypeToImageExtension
} from './generated-image';

describe('mimeTypeToImageExtension', () => {
  test('maps the common image MIME types', () => {
    expect(mimeTypeToImageExtension('image/png')).toBe('png');
    expect(mimeTypeToImageExtension('image/jpeg')).toBe('jpg');
    expect(mimeTypeToImageExtension('image/jpg')).toBe('jpg');
    expect(mimeTypeToImageExtension('image/webp')).toBe('webp');
    expect(mimeTypeToImageExtension('image/gif')).toBe('gif');
    expect(mimeTypeToImageExtension('image/svg+xml')).toBe('svg');
  });

  test('normalizes case, whitespace, and charset parameter', () => {
    expect(mimeTypeToImageExtension('  IMAGE/PNG  ')).toBe('png');
    expect(mimeTypeToImageExtension('image/jpeg; charset=binary')).toBe('jpg');
  });

  test('falls back to png for unknown or empty MIME types', () => {
    expect(mimeTypeToImageExtension('')).toBe('png');
    expect(mimeTypeToImageExtension('application/octet-stream')).toBe('png');
    expect(mimeTypeToImageExtension(undefined as unknown as string)).toBe('png');
  });
});

describe('generatedImageSlug', () => {
  test('transliterates Cyrillic prompts to a Latin slug', () => {
    expect(generatedImageSlug('Замок на холме')).toBe('zamok-na-holme');
  });

  test('collapses punctuation/whitespace runs and lowercases', () => {
    expect(generatedImageSlug('A Dark   Forest!!')).toBe('a-dark-forest');
  });

  test('falls back to an image-<hash> stem for a slug that would be empty', () => {
    const slug = generatedImageSlug('日本語');
    expect(slug.startsWith('image-')).toBe(true);
    expect(slug.length).toBeGreaterThan('image-'.length);
  });
});

describe('buildGeneratedImageFilename', () => {
  test('builds <slug>-<n>.<ext> with a 1-based suffix', () => {
    expect(buildGeneratedImageFilename('Замок на холме', 0, 'image/png')).toBe('zamok-na-holme-1.png');
    expect(buildGeneratedImageFilename('Замок на холме', 1, 'image/jpeg')).toBe('zamok-na-holme-2.jpg');
  });

  test('clamps a negative index to the first suffix', () => {
    expect(buildGeneratedImageFilename('forest', -3, 'image/png')).toBe('forest-1.png');
  });
});

describe('generatedImageRelativePath', () => {
  test('prefixes the generated-sources folder', () => {
    expect(generatedImageRelativePath('forest', 0, 'image/png')).toBe(`${GENERATED_IMAGES_FOLDER}/forest-1.png`);
    expect(GENERATED_IMAGES_FOLDER).toBe('sources/generated');
  });
});

describe('imageAltFromPrompt', () => {
  test('collapses whitespace to a single line', () => {
    expect(imageAltFromPrompt('a  castle\non   a hill')).toBe('a castle on a hill');
  });

  test('truncates a long prompt with an ellipsis', () => {
    const alt = imageAltFromPrompt('x'.repeat(200), 10);
    expect(alt.length).toBe(10);
    expect(alt.endsWith('…')).toBe(true);
  });

  test('leaves a short prompt untouched', () => {
    expect(imageAltFromPrompt('short prompt', 80)).toBe('short prompt');
  });
});
