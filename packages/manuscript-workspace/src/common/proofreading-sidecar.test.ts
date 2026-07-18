import { describe, expect, test } from 'bun:test';
import { DEFAULT_IMAGE_EXTENSIONS, DEFAULT_TEXT_EXTENSIONS, ProofreadingSet } from './proofreading-model';
import {
  ProofsetSchemaValidator,
  parseProofsetYaml,
  setPageNeedsRework,
  setPageVerified,
  writeProofsetYaml
} from './proofreading-sidecar';

const VALID_OCR = ['mode: ocr', 'imagesFolder: proofreading/set/images', 'textFolder: proofreading/set/text', ''].join('\n');

describe('parseProofsetYaml — valid', () => {
  test('parses a minimal OCR set and fills default extensions + empty pages', () => {
    const { set, problems } = parseProofsetYaml(VALID_OCR);
    expect(problems).toEqual([]);
    expect(set).toBeDefined();
    expect(set!.mode).toBe('ocr');
    expect(set!.imagesFolder).toBe('proofreading/set/images');
    expect(set!.textFolder).toBe('proofreading/set/text');
    expect(set!.sourceTextFolder).toBeUndefined();
    expect(set!.imageExtensions).toEqual([...DEFAULT_IMAGE_EXTENSIONS]);
    expect(set!.textExtensions).toEqual([...DEFAULT_TEXT_EXTENSIONS]);
    expect(set!.pages).toEqual([]);
  });

  test('parses a translation set with pages', () => {
    const text = [
      'mode: translation',
      'imagesFolder: p/images',
      'textFolder: p/translation',
      'sourceTextFolder: p/source',
      'pages:',
      '  - base: page.01',
      '    verified: true',
      '    needsRework: false'
    ].join('\n');
    const { set, problems } = parseProofsetYaml(text);
    expect(problems).toEqual([]);
    expect(set!.sourceTextFolder).toBe('p/source');
    expect(set!.pages).toEqual([{ base: 'page.01', verified: true, needsRework: false }]);
  });

  test('honors explicit extension lists', () => {
    const text = [VALID_OCR, 'imageExtensions:', '  - .png', 'textExtensions:', '  - .md'].join('\n');
    const { set } = parseProofsetYaml(text);
    expect(set!.imageExtensions).toEqual(['.png']);
    expect(set!.textExtensions).toEqual(['.md']);
  });
});

describe('parseProofsetYaml — each problem code', () => {
  test('invalid-shape: empty file', () => {
    expect(parseProofsetYaml('').problems.map(p => p.code)).toEqual(['invalid-shape']);
  });

  test('invalid-shape: unparseable YAML', () => {
    expect(parseProofsetYaml('mode: [unterminated').problems.map(p => p.code)).toEqual(['invalid-shape']);
  });

  test('invalid-shape: non-mapping root', () => {
    expect(parseProofsetYaml('- just a list\n').problems.map(p => p.code)).toEqual(['invalid-shape']);
  });

  test('missing-mode', () => {
    const { set, problems } = parseProofsetYaml('imagesFolder: a\ntextFolder: b\n');
    expect(set).toBeUndefined();
    expect(problems.map(p => p.code)).toEqual(['missing-mode']);
  });

  test('invalid-mode', () => {
    expect(parseProofsetYaml('mode: nonsense\nimagesFolder: a\ntextFolder: b\n').problems.map(p => p.code)).toEqual([
      'invalid-mode'
    ]);
  });

  test('missing-images-folder', () => {
    expect(parseProofsetYaml('mode: ocr\ntextFolder: b\n').problems.map(p => p.code)).toEqual(['missing-images-folder']);
  });

  test('missing-text-folder', () => {
    expect(parseProofsetYaml('mode: ocr\nimagesFolder: a\n').problems.map(p => p.code)).toEqual(['missing-text-folder']);
  });

  test('missing-source-text-folder (translation mode)', () => {
    const { problems } = parseProofsetYaml('mode: translation\nimagesFolder: a\ntextFolder: b\n');
    expect(problems.map(p => p.code)).toEqual(['missing-source-text-folder']);
  });

  test('invalid-extensions (non-blocking: set still returned with defaults)', () => {
    const text = [VALID_OCR, 'imageExtensions: not-a-list'].join('\n');
    const { set, problems } = parseProofsetYaml(text);
    expect(problems.map(p => p.code)).toEqual(['invalid-extensions']);
    expect(set).toBeDefined();
    expect(set!.imageExtensions).toEqual([...DEFAULT_IMAGE_EXTENSIONS]);
  });

  test('invalid-page (non-blocking: bad entry dropped, good ones kept)', () => {
    const text = [
      VALID_OCR,
      'pages:',
      '  - base: good',
      '    verified: true',
      '  - verified: true',
      '  - base: bad-flag',
      '    verified: yes'
    ].join('\n');
    const { set, problems } = parseProofsetYaml(text);
    expect(problems.map(p => p.code)).toEqual(['invalid-page', 'invalid-page']);
    expect(set!.pages).toEqual([{ base: 'good', verified: true, needsRework: false }]);
  });
});

describe('writeProofsetYaml — comment + unknown-key preservation', () => {
  const baseSet: ProofreadingSet = {
    mode: 'ocr',
    imagesFolder: 'p/images',
    textFolder: 'p/text',
    imageExtensions: ['.png'],
    textExtensions: ['.md'],
    pages: [{ base: 'page.01', verified: true, needsRework: false }]
  };

  test('round-trip keeps a leading comment and an unknown key', () => {
    const existing = ['# hand-written header comment', 'mode: ocr', 'imagesFolder: old/images', 'textFolder: old/text', 'reviewer: vedmalex'].join(
      '\n'
    );
    const output = writeProofsetYaml(existing, baseSet);
    expect(output).toContain('# hand-written header comment');
    expect(output).toContain('reviewer: vedmalex');
    // derived fields were updated
    expect(output).toContain('imagesFolder: p/images');
    expect(output).toContain('textFolder: p/text');
    // and the result re-parses to the written set
    const { set } = parseProofsetYaml(output);
    expect(set!.imagesFolder).toBe('p/images');
    expect(set!.pages).toEqual([{ base: 'page.01', verified: true, needsRework: false }]);
  });

  test('writes a fresh document when no existing text', () => {
    const { set } = parseProofsetYaml(writeProofsetYaml(undefined, baseSet));
    expect(set!.mode).toBe('ocr');
    expect(set!.imageExtensions).toEqual(['.png']);
  });

  test('drops sourceTextFolder when the set has none', () => {
    const existing = 'mode: translation\nsourceTextFolder: p/source\nimagesFolder: a\ntextFolder: b\n';
    const output = writeProofsetYaml(existing, baseSet);
    expect(output).not.toContain('sourceTextFolder');
  });

  test('writes sourceTextFolder for a translation set', () => {
    const translationSet: ProofreadingSet = { ...baseSet, mode: 'translation', sourceTextFolder: 'p/source' };
    const output = writeProofsetYaml(undefined, translationSet);
    expect(output).toContain('sourceTextFolder: p/source');
  });
});

describe('page mutation by base name (not index)', () => {
  const set: ProofreadingSet = {
    mode: 'ocr',
    imagesFolder: 'p/images',
    textFolder: 'p/text',
    imageExtensions: ['.png'],
    textExtensions: ['.md'],
    pages: [
      { base: 'page.01', verified: false, needsRework: false },
      { base: 'page.02', verified: false, needsRework: false }
    ]
  };

  test('setPageVerified updates the matching base immutably', () => {
    const next = setPageVerified(set, 'page.02', true);
    expect(next).not.toBe(set);
    expect(set.pages[1].verified).toBe(false); // original untouched
    expect(next.pages.find(p => p.base === 'page.02')!.verified).toBe(true);
    expect(next.pages.find(p => p.base === 'page.01')!.verified).toBe(false);
  });

  test('setPageNeedsRework updates the matching base', () => {
    const next = setPageNeedsRework(set, 'page.01', true);
    expect(next.pages.find(p => p.base === 'page.01')!.needsRework).toBe(true);
  });

  test('adds a new page when the base is absent', () => {
    const next = setPageVerified(set, 'page.99', true);
    expect(next.pages).toHaveLength(3);
    expect(next.pages.find(p => p.base === 'page.99')).toEqual({ base: 'page.99', verified: true, needsRework: false });
  });
});

describe('ProofsetSchemaValidator (AJV)', () => {
  const validator = new ProofsetSchemaValidator();

  test('accepts a valid set object', () => {
    expect(
      validator.validate('proofset.yaml', {
        mode: 'ocr',
        imagesFolder: 'a',
        textFolder: 'b',
        pages: [{ base: 'page.01', verified: true }]
      })
    ).toEqual([]);
  });

  test('rejects a bad mode and a missing required folder', () => {
    const badMode = validator.validate('proofset.yaml', { mode: 'nope', imagesFolder: 'a', textFolder: 'b' });
    expect(badMode.length).toBeGreaterThan(0);

    const missing = validator.validate('proofset.yaml', { mode: 'ocr', imagesFolder: 'a' });
    expect(missing.length).toBeGreaterThan(0);
    expect(missing[0].message).toContain('textFolder');
  });
});
