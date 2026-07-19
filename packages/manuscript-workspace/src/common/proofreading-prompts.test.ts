import { describe, expect, test } from 'bun:test';
import {
  IMAGE_ATTACHED_NOTE,
  PROOFREADING_PROMPTS,
  PROOFREAD_PROMPT,
  REOCR_PROMPT,
  TRANSLATE_PROMPT,
  TRANSLATION_QA_PROMPT,
  buildProofreadingMessages,
  buildCustomCommandMessages,
  CUSTOM_COMMAND_SYSTEM,
  splitDataUri
} from './proofreading-prompts';

describe('PROOFREADING_PROMPTS', () => {
  test('exposes the four default prompts keyed by action', () => {
    expect(PROOFREADING_PROMPTS.reOcr).toBe(REOCR_PROMPT);
    expect(PROOFREADING_PROMPTS.proofread).toBe(PROOFREAD_PROMPT);
    expect(PROOFREADING_PROMPTS.translate).toBe(TRANSLATE_PROMPT);
    expect(PROOFREADING_PROMPTS.translationQa).toBe(TRANSLATION_QA_PROMPT);
  });

  test('every prompt is a non-empty Russian-authored string', () => {
    for (const prompt of Object.values(PROOFREADING_PROMPTS)) {
      expect(prompt.length).toBeGreaterThan(0);
      // Contains Cyrillic characters (ScanCheck's prompts are Russian).
      expect(/[а-яё]/i.test(prompt)).toBe(true);
    }
  });
});

describe('buildProofreadingMessages', () => {
  test('reOcr sends only the image note as the user message', () => {
    const { system, user } = buildProofreadingMessages({
      kind: 'reOcr',
      currentText: 'old ocr text',
      hasImageAttachment: true
    });
    expect(system).toBe(REOCR_PROMPT);
    expect(user).toBe(IMAGE_ATTACHED_NOTE);
    // The stale OCR text must NOT be replayed for a re-recognition.
    expect(user).not.toContain('old ocr text');
  });

  test('reOcr without an image yields an empty user message', () => {
    const { user } = buildProofreadingMessages({ kind: 'reOcr', currentText: 'x' });
    expect(user).toBe('');
  });

  test('proofread carries the current OCR text and no image note', () => {
    const { system, user } = buildProofreadingMessages({
      kind: 'proofread',
      currentText: 'текст с ашибкой'
    });
    expect(system).toBe(PROOFREAD_PROMPT);
    expect(user).toContain('текст с ашибкой');
    expect(user).not.toContain(IMAGE_ATTACHED_NOTE);
  });

  test('translate carries the source text and the image note', () => {
    const { system, user } = buildProofreadingMessages({
      kind: 'translate',
      currentText: 'partial translation',
      sourceText: 'исходный текст',
      hasImageAttachment: true
    });
    expect(system).toBe(TRANSLATE_PROMPT);
    expect(user).toContain(IMAGE_ATTACHED_NOTE);
    expect(user).toContain('исходный текст');
  });

  test('translate falls back to currentText when no source is supplied', () => {
    const { user } = buildProofreadingMessages({ kind: 'translate', currentText: 'fallback source' });
    expect(user).toContain('fallback source');
  });

  test('translationQa carries both the original and the translation', () => {
    const { system, user } = buildProofreadingMessages({
      kind: 'translationQa',
      currentText: 'the translation',
      sourceText: 'the original',
      hasImageAttachment: true
    });
    expect(system).toBe(TRANSLATION_QA_PROMPT);
    expect(user).toContain(IMAGE_ATTACHED_NOTE);
    expect(user).toContain('the original');
    expect(user).toContain('the translation');
    // Original must appear before the translation in the assembled message.
    expect(user.indexOf('the original')).toBeLessThan(user.indexOf('the translation'));
  });
});

describe('buildCustomCommandMessages', () => {
  test('uses the custom-command system prompt', () => {
    const { system } = buildCustomCommandMessages('Make it formal', 'hey there');
    expect(system).toBe(CUSTOM_COMMAND_SYSTEM);
  });

  test('carries the instruction and the fragment, instruction first', () => {
    const { user } = buildCustomCommandMessages('  Make it formal  ', 'hey there');
    expect(user).toContain('Make it formal');
    expect(user).toContain('hey there');
    expect(user.indexOf('Make it formal')).toBeLessThan(user.indexOf('hey there'));
  });

  test('trims surrounding whitespace off the instruction', () => {
    const { user } = buildCustomCommandMessages('  Make it formal  ', 'x');
    expect(user).not.toContain('  Make it formal  ');
  });
});

describe('splitDataUri', () => {
  test('splits a base64 data URI into mimeType + base64', () => {
    expect(splitDataUri('data:image/png;base64,AAAB')).toEqual({ mimeType: 'image/png', base64: 'AAAB' });
    expect(splitDataUri('data:image/jpeg;base64,/9j/4AAQ')).toEqual({ mimeType: 'image/jpeg', base64: '/9j/4AAQ' });
  });

  test('returns undefined for non-data / non-base64 / half-missing URIs', () => {
    expect(splitDataUri('https://example.com/x.png')).toBeUndefined();
    expect(splitDataUri('data:image/png,rawnotbase64')).toBeUndefined();
    expect(splitDataUri('data:image/png;base64,')).toBeUndefined();
    expect(splitDataUri('data:;base64,AAAB')).toBeUndefined();
    expect(splitDataUri('')).toBeUndefined();
  });
});
