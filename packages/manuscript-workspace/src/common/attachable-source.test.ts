import { describe, expect, it } from 'bun:test';
import {
  ATTACHABLE_SOURCE_TYPES,
  attachableSourceKind,
  attachableSourceMimeType,
  attachableSourceType,
  fileExtension,
  isAttachableSource
} from './attachable-source';

describe('fileExtension', () => {
  it('lower-cases and keeps the leading dot', () => {
    expect(fileExtension('sources/Paper.PDF')).toBe('.pdf');
    expect(fileExtension('sources/photo.JPEG')).toBe('.jpeg');
  });

  it('uses only the final segment and final dot', () => {
    expect(fileExtension('a.b/c.d/diagram.map.png')).toBe('.png');
    expect(fileExtension('nested/dir.with.dots/file.svg')).toBe('.svg');
  });

  it('returns empty string for dotfiles and extensionless names', () => {
    expect(fileExtension('sources/.gitkeep')).toBe('');
    expect(fileExtension('README')).toBe('');
    expect(fileExtension('sources/archive')).toBe('');
  });

  it('handles backslash separators', () => {
    expect(fileExtension('sources\\scan.png')).toBe('.png');
  });
});

describe('attachableSourceType / predicates', () => {
  it('recognizes every image extension as kind "image"', () => {
    for (const ext of ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg']) {
      expect(attachableSourceKind(`sources/x${ext}`)).toBe('image');
    }
  });

  it('recognizes pdf as kind "document" with application/pdf', () => {
    expect(attachableSourceKind('sources/paper.pdf')).toBe('document');
    expect(attachableSourceMimeType('sources/paper.pdf')).toBe('application/pdf');
  });

  it('maps jpg and jpeg both to image/jpeg', () => {
    expect(attachableSourceMimeType('a.jpg')).toBe('image/jpeg');
    expect(attachableSourceMimeType('a.jpeg')).toBe('image/jpeg');
  });

  it('maps svg to image/svg+xml', () => {
    expect(attachableSourceMimeType('map.svg')).toBe('image/svg+xml');
  });

  it('rejects non-attachable formats (text, office, excalidraw)', () => {
    for (const path of ['notes.md', 'sources/paper.docx', 'sources/data.csv', 'sources/rel.excalidraw', 'sources/x.txt']) {
      expect(isAttachableSource(path)).toBe(false);
      expect(attachableSourceType(path)).toBeUndefined();
      expect(attachableSourceMimeType(path)).toBeUndefined();
      expect(attachableSourceKind(path)).toBeUndefined();
    }
  });

  it('is case-insensitive on the extension', () => {
    expect(isAttachableSource('sources/SCAN.PNG')).toBe(true);
    expect(attachableSourceMimeType('sources/SCAN.PNG')).toBe('image/png');
  });

  it('exposes a frozen-shape table covering the documented extensions', () => {
    expect(Object.keys(ATTACHABLE_SOURCE_TYPES).sort()).toEqual(
      ['.bmp', '.gif', '.jpeg', '.jpg', '.pdf', '.png', '.svg', '.webp']
    );
  });
});
