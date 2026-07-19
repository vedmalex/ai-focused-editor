import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_IMAGE_EXTENSIONS,
  DEFAULT_TEXT_EXTENSIONS,
  ProofreadingSet,
  computeProgress,
  getBaseName,
  getEditableRelativePath,
  isProofsetPath,
  isTranslationMode,
  matchPairs,
  pairHasImage,
  pairHasSource
} from './proofreading-model';

describe('isProofsetPath', () => {
  test('matches proofset.yaml under a proofreading/ segment', () => {
    expect(isProofsetPath('proofreading/set-1/proofset.yaml')).toBe(true);
    expect(isProofsetPath('/book/proofreading/set-1/proofset.yaml')).toBe(true);
    expect(isProofsetPath('file:///Users/x/book/Proofreading/S/proofset.yaml')).toBe(true);
  });

  test('rejects the wrong basename or a proofset.yaml outside proofreading/', () => {
    expect(isProofsetPath('proofreading/set-1/other.yaml')).toBe(false);
    expect(isProofsetPath('content/proofset.yaml')).toBe(false);
    expect(isProofsetPath('proofset.yaml')).toBe(false);
    expect(isProofsetPath('')).toBe(false);
  });
});

describe('getBaseName', () => {
  test('strips only the LAST extension, preserving dotted names', () => {
    expect(getBaseName('page.01.jpg')).toBe('page.01');
  });

  test('a simple single-extension name', () => {
    expect(getBaseName('cover.png')).toBe('cover');
  });

  test('a name with no dot is returned whole', () => {
    expect(getBaseName('README')).toBe('README');
  });
});

describe('isTranslationMode', () => {
  test('derives from the presence of sourceTextFolder', () => {
    expect(isTranslationMode({ sourceTextFolder: 'proofreading/set/source' })).toBe(true);
    expect(isTranslationMode({ sourceTextFolder: undefined })).toBe(false);
    expect(isTranslationMode({ sourceTextFolder: '' })).toBe(false);
  });
});

const OCR_FOLDERS = { imagesFolder: 'proofreading/set/images', textFolder: 'proofreading/set/text' };

describe('matchPairs', () => {
  test('pairs a dotted-name image with its dotted-name text file', () => {
    const pairs = matchPairs(
      ['page.01.jpg'],
      ['page.01.txt'],
      undefined,
      OCR_FOLDERS,
      DEFAULT_IMAGE_EXTENSIONS,
      DEFAULT_TEXT_EXTENSIONS
    );
    expect(pairs).toEqual([
      {
        base: 'page.01',
        imageRelPath: 'proofreading/set/images/page.01.jpg',
        textRelPath: 'proofreading/set/text/page.01.txt',
        missing: false
      }
    ]);
  });

  test('flags a missing text file and points at the expected text path', () => {
    const pairs = matchPairs(['page.02.png'], [], undefined, OCR_FOLDERS, DEFAULT_IMAGE_EXTENSIONS, DEFAULT_TEXT_EXTENSIONS);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].missing).toBe(true);
    // preferred text ext is the first of textExts (.txt)
    expect(pairs[0].textRelPath).toBe('proofreading/set/text/page.02.txt');
  });

  test('produces ONE entry per image and sorts numerically by base', () => {
    const pairs = matchPairs(
      ['page.10.jpg', 'page.2.jpg', 'page.1.jpg'],
      ['page.1.txt', 'page.2.txt', 'page.10.txt'],
      undefined,
      OCR_FOLDERS,
      DEFAULT_IMAGE_EXTENSIONS,
      DEFAULT_TEXT_EXTENSIONS
    );
    expect(pairs.map(pair => pair.base)).toEqual(['page.1', 'page.2', 'page.10']);
  });

  test('filters out names whose extension is not in the ext lists', () => {
    const pairs = matchPairs(
      ['page.01.jpg', 'notes.gif', 'thumbs.db'],
      ['page.01.txt', 'ignore.rtf'],
      undefined,
      OCR_FOLDERS,
      DEFAULT_IMAGE_EXTENSIONS,
      DEFAULT_TEXT_EXTENSIONS
    );
    expect(pairs.map(pair => pair.base)).toEqual(['page.01']);
    expect(pairs[0].missing).toBe(false);
  });

  test('extension matching is case-insensitive', () => {
    const pairs = matchPairs(['PAGE.01.JPG'], ['PAGE.01.TXT'], undefined, OCR_FOLDERS, DEFAULT_IMAGE_EXTENSIONS, DEFAULT_TEXT_EXTENSIONS);
    expect(pairs[0].missing).toBe(false);
  });

  test('translation mode: resolves the source text path and marks it', () => {
    const folders = {
      imagesFolder: 'proofreading/set/images',
      textFolder: 'proofreading/set/translation',
      sourceTextFolder: 'proofreading/set/source'
    };
    const pairs = matchPairs(
      ['page.01.jpg'],
      ['page.01.md'],
      ['page.01.md'],
      folders,
      DEFAULT_IMAGE_EXTENSIONS,
      DEFAULT_TEXT_EXTENSIONS
    );
    expect(pairs[0].sourceTextRelPath).toBe('proofreading/set/source/page.01.md');
    expect(pairs[0].textRelPath).toBe('proofreading/set/translation/page.01.md');
  });

  test('no sourceTextFolder ⇒ no sourceTextRelPath key', () => {
    const pairs = matchPairs(['page.01.jpg'], ['page.01.txt'], undefined, OCR_FOLDERS, DEFAULT_IMAGE_EXTENSIONS, DEFAULT_TEXT_EXTENSIONS);
    expect('sourceTextRelPath' in pairs[0]).toBe(false);
  });

  test('first text file wins on a duplicate base', () => {
    const pairs = matchPairs(
      ['page.01.jpg'],
      ['page.01.txt', 'page.01.md'],
      undefined,
      OCR_FOLDERS,
      DEFAULT_IMAGE_EXTENSIONS,
      DEFAULT_TEXT_EXTENSIONS
    );
    expect(pairs[0].textRelPath).toBe('proofreading/set/text/page.01.txt');
  });
});

const TRANSLATION_FOLDERS = {
  imagesFolder: 'proofreading/set/images',
  textFolder: 'proofreading/set/translation',
  sourceTextFolder: 'proofreading/set/source'
};

describe('matchPairs — adaptive driver (scans optional)', () => {
  test('translation with ZERO images: source↔text pairs, no imageRelPath', () => {
    const pairs = matchPairs(
      [],
      ['chapter-01.md', 'chapter-02.md'],
      ['chapter-01.md', 'chapter-02.md'],
      TRANSLATION_FOLDERS,
      DEFAULT_IMAGE_EXTENSIONS,
      DEFAULT_TEXT_EXTENSIONS
    );
    expect(pairs.map(pair => pair.base)).toEqual(['chapter-01', 'chapter-02']);
    for (const pair of pairs) {
      expect('imageRelPath' in pair).toBe(false);
      expect(pairHasImage(pair)).toBe(false);
      expect(pair.missing).toBe(false);
    }
    expect(pairs[0].sourceTextRelPath).toBe('proofreading/set/source/chapter-01.md');
    expect(pairs[0].textRelPath).toBe('proofreading/set/translation/chapter-01.md');
    expect(pairHasSource(pairs[0])).toBe(true);
  });

  test('translation WITH images: 3-way pair carries image + source + text', () => {
    const pairs = matchPairs(
      ['chapter-01.jpg'],
      ['chapter-01.md'],
      ['chapter-01.md'],
      TRANSLATION_FOLDERS,
      DEFAULT_IMAGE_EXTENSIONS,
      DEFAULT_TEXT_EXTENSIONS
    );
    expect(pairs).toHaveLength(1);
    expect(pairHasImage(pairs[0])).toBe(true);
    expect(pairHasSource(pairs[0])).toBe(true);
    expect(pairs[0].imageRelPath).toBe('proofreading/set/images/chapter-01.jpg');
    expect(pairs[0].sourceTextRelPath).toBe('proofreading/set/source/chapter-01.md');
    expect(pairs[0].textRelPath).toBe('proofreading/set/translation/chapter-01.md');
  });

  test('translation: source present but translation text missing ⇒ pair with missing:true, no image', () => {
    const pairs = matchPairs(
      [],
      [],
      ['chapter-01.md'],
      TRANSLATION_FOLDERS,
      DEFAULT_IMAGE_EXTENSIONS,
      DEFAULT_TEXT_EXTENSIONS
    );
    expect(pairs).toHaveLength(1);
    expect(pairs[0].missing).toBe(true);
    // no matching text file ⇒ expected path uses the preferred (first) text ext
    expect(pairs[0].textRelPath).toBe('proofreading/set/translation/chapter-01.txt');
    expect(pairs[0].sourceTextRelPath).toBe('proofreading/set/source/chapter-01.md');
    expect('imageRelPath' in pairs[0]).toBe(false);
  });

  test('translation: a source with no matching translation gets NO sourceTextRelPath on the reverse-missing side', () => {
    // text-only base (no source) still shows, without a source pane path
    const pairs = matchPairs(
      [],
      ['chapter-99.md'],
      [],
      TRANSLATION_FOLDERS,
      DEFAULT_IMAGE_EXTENSIONS,
      DEFAULT_TEXT_EXTENSIONS
    );
    expect(pairs).toHaveLength(1);
    expect(pairHasSource(pairs[0])).toBe(false);
    expect('sourceTextRelPath' in pairs[0]).toBe(false);
    expect(pairs[0].missing).toBe(false);
  });

  test('translation mismatched counts (19 source vs 20 text) ⇒ union = 20 pairs', () => {
    const sourceNames = Array.from({ length: 19 }, (_, i) => `chapter-${String(i + 1).padStart(2, '0')}.md`);
    const textNames = Array.from({ length: 20 }, (_, i) => `chapter-${String(i + 1).padStart(2, '0')}.md`);
    const pairs = matchPairs([], textNames, sourceNames, TRANSLATION_FOLDERS, DEFAULT_IMAGE_EXTENSIONS, DEFAULT_TEXT_EXTENSIONS);
    expect(pairs).toHaveLength(20);
    // chapter-20 has text but no source
    const last = pairs[pairs.length - 1];
    expect(last.base).toBe('chapter-20');
    expect(pairHasSource(last)).toBe(false);
    expect(last.missing).toBe(false);
    // sorted numeric-aware, no image anywhere
    expect(pairs.every(pair => !pairHasImage(pair))).toBe(true);
    expect(pairs[9].base).toBe('chapter-10');
  });

  test('OCR: union(images, text) — a scan without text and a text without scan both show', () => {
    const pairs = matchPairs(
      ['page.01.jpg', 'page.03.jpg'],
      ['page.01.txt', 'page.02.txt'],
      undefined,
      OCR_FOLDERS,
      DEFAULT_IMAGE_EXTENSIONS,
      DEFAULT_TEXT_EXTENSIONS
    );
    expect(pairs.map(pair => pair.base)).toEqual(['page.01', 'page.02', 'page.03']);
    // page.02: text only, no image
    const p2 = pairs.find(pair => pair.base === 'page.02')!;
    expect(pairHasImage(p2)).toBe(false);
    expect(p2.missing).toBe(false);
    // page.03: image only, text missing
    const p3 = pairs.find(pair => pair.base === 'page.03')!;
    expect(pairHasImage(p3)).toBe(true);
    expect(p3.missing).toBe(true);
  });

  test('dotted names survive the union driver', () => {
    const pairs = matchPairs(
      [],
      ['part.1.chapter.01.md'],
      ['part.1.chapter.01.md'],
      TRANSLATION_FOLDERS,
      DEFAULT_IMAGE_EXTENSIONS,
      DEFAULT_TEXT_EXTENSIONS
    );
    expect(pairs[0].base).toBe('part.1.chapter.01');
    expect(pairs[0].sourceTextRelPath).toBe('proofreading/set/source/part.1.chapter.01.md');
  });
});

describe('pairHasImage / pairHasSource', () => {
  test('reflect the presence of the optional paths', () => {
    expect(pairHasImage({ imageRelPath: 'a/b.jpg' })).toBe(true);
    expect(pairHasImage({ imageRelPath: undefined })).toBe(false);
    expect(pairHasSource({ sourceTextRelPath: 'a/b.md' })).toBe(true);
    expect(pairHasSource({ sourceTextRelPath: undefined })).toBe(false);
  });
});

describe('getEditableRelativePath', () => {
  test('uses textFolder + the first configured text extension', () => {
    const set = { textFolder: 'proofreading/set/text', textExtensions: ['.md', '.txt'] };
    expect(getEditableRelativePath(set, 'page.01')).toBe('proofreading/set/text/page.01.md');
  });

  test('falls back to the default text extension when none configured', () => {
    const set = { textFolder: 'proofreading/set/text', textExtensions: [] as string[] };
    expect(getEditableRelativePath(set, 'page.01')).toBe(`proofreading/set/text/page.01${DEFAULT_TEXT_EXTENSIONS[0]}`);
  });

  test('does not branch on mode — translation editable file lives in textFolder', () => {
    const set = { textFolder: 'proofreading/set/translation', textExtensions: ['.md'] };
    expect(getEditableRelativePath(set, 'page.05')).toBe('proofreading/set/translation/page.05.md');
  });
});

describe('computeProgress', () => {
  const set = (pages: ProofreadingSet['pages']): Pick<ProofreadingSet, 'pages'> => ({ pages });

  test('counts verified / needsRework and rounds the percent', () => {
    const progress = computeProgress(
      set([
        { base: 'p1', verified: true, needsRework: false },
        { base: 'p2', verified: true, needsRework: false },
        { base: 'p3', verified: false, needsRework: true }
      ])
    );
    expect(progress).toEqual({ verified: 2, needsRework: 1, total: 3, percent: 67 });
  });

  test('empty set is 0% with zero counts (no divide-by-zero)', () => {
    expect(computeProgress(set([]))).toEqual({ verified: 0, needsRework: 0, total: 0, percent: 0 });
  });

  test('all verified is 100%', () => {
    const progress = computeProgress(
      set([
        { base: 'p1', verified: true, needsRework: false },
        { base: 'p2', verified: true, needsRework: false }
      ])
    );
    expect(progress.percent).toBe(100);
  });
});

describe('default extension lists', () => {
  test('image + text defaults match the ScanCheck defaults', () => {
    expect(DEFAULT_IMAGE_EXTENSIONS).toEqual(['.jpg', '.jpeg', '.png', '.webp', '.tiff', '.bmp']);
    expect(DEFAULT_TEXT_EXTENSIONS).toEqual(['.txt', '.md']);
  });
});
