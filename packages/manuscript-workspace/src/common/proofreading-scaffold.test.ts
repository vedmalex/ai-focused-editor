import { describe, expect, test } from 'bun:test';
import { formatProgressChip } from './proofreading-model';
import {
  buildProofreadingSetSkeleton,
  PROOFREADING_AREA,
  proofreadingSetFolder,
  proofreadingSetFolders,
  proofsetRelPath,
  SCANS_AREA,
  seedPagesFromImageNames
} from './proofreading-scaffold';

describe('proofreadingSetFolders', () => {
  test('ocr mode derives images + text folders, no source folder', () => {
    expect(proofreadingSetFolders('war-and-peace', 'ocr')).toEqual({
      imagesFolder: 'sources/scans/war-and-peace',
      textFolder: 'proofreading/war-and-peace/text'
    });
  });

  test('translation mode adds a source-text folder', () => {
    expect(proofreadingSetFolders('war-and-peace', 'translation')).toEqual({
      imagesFolder: 'sources/scans/war-and-peace',
      textFolder: 'proofreading/war-and-peace/text',
      sourceTextFolder: 'proofreading/war-and-peace/source'
    });
  });

  test('area constants and path derivations line up', () => {
    expect(SCANS_AREA).toBe('sources/scans');
    expect(PROOFREADING_AREA).toBe('proofreading');
    expect(proofreadingSetFolder('ch1')).toBe('proofreading/ch1');
    expect(proofsetRelPath('ch1')).toBe('proofreading/ch1/proofset.yaml');
  });
});

describe('seedPagesFromImageNames', () => {
  test('one unverified page per image basename, numeric-sorted', () => {
    const pages = seedPagesFromImageNames(['page.10.jpg', 'page.2.jpg', 'page.1.png']);
    expect(pages).toEqual([
      { base: 'page.1', verified: false, needsRework: false },
      { base: 'page.2', verified: false, needsRework: false },
      { base: 'page.10', verified: false, needsRework: false }
    ]);
  });

  test('ignores non-image files and de-duplicates on base (first wins)', () => {
    const pages = seedPagesFromImageNames(['a.jpg', 'a.png', 'notes.txt', 'b.webp']);
    expect(pages.map(page => page.base)).toEqual(['a', 'b']);
  });

  test('no scans yet => empty pages', () => {
    expect(seedPagesFromImageNames([])).toEqual([]);
  });
});

describe('buildProofreadingSetSkeleton', () => {
  test('ocr skeleton: derived folders, default extensions, seeded pages', () => {
    const set = buildProofreadingSetSkeleton({
      slug: 'ch1',
      mode: 'ocr',
      imageNames: ['001.jpg', '002.jpg']
    });
    expect(set.mode).toBe('ocr');
    expect(set.imagesFolder).toBe('sources/scans/ch1');
    expect(set.textFolder).toBe('proofreading/ch1/text');
    expect(set.sourceTextFolder).toBeUndefined();
    expect(set.imageExtensions).toContain('.jpg');
    expect(set.textExtensions).toContain('.txt');
    expect(set.pages.map(page => page.base)).toEqual(['001', '002']);
  });

  test('translation skeleton carries a source-text folder', () => {
    const set = buildProofreadingSetSkeleton({ slug: 'ch1', mode: 'translation' });
    expect(set.sourceTextFolder).toBe('proofreading/ch1/source');
    expect(set.pages).toEqual([]);
  });

  test('extension overrides drive both the set and the page seeding filter', () => {
    const set = buildProofreadingSetSkeleton({
      slug: 'ch1',
      mode: 'ocr',
      imageNames: ['scan.tif', 'ignore.jpg'],
      imageExtensions: ['.tif']
    });
    expect(set.imageExtensions).toEqual(['.tif']);
    expect(set.pages.map(page => page.base)).toEqual(['scan']);
  });
});

describe('formatProgressChip', () => {
  test('renders the verified/total ✓ shape', () => {
    expect(formatProgressChip({ verified: 3, total: 10 })).toBe('3/10 ✓');
    expect(formatProgressChip({ verified: 0, total: 0 })).toBe('0/0 ✓');
  });
});
