import { describe, expect, test } from 'bun:test';
import {
  TRANSCRIPT_PROOFREAD_SYSTEM_PROMPT,
  buildTranscriptProofreadMessages,
  extractJsonFromContent,
  normalizeProofreadPayload
} from './transcript-prompts';

describe('buildTranscriptProofreadMessages', () => {
  test('default system prompt states the JSON contract; user is the segment text verbatim', () => {
    const messages = buildTranscriptProofreadMessages('так говорил спикер');
    expect(messages.system).toBe(TRANSCRIPT_PROOFREAD_SYSTEM_PROMPT);
    expect(messages.system).toContain('correctedText');
    expect(messages.system).toContain('issues[]');
    expect(messages.user).toBe('так говорил спикер');
  });

  test('a custom system prompt overrides; a blank one falls back', () => {
    expect(buildTranscriptProofreadMessages('t', 'custom').system).toBe('custom');
    expect(buildTranscriptProofreadMessages('t', '   ').system).toBe(TRANSCRIPT_PROOFREAD_SYSTEM_PROMPT);
  });
});

describe('extractJsonFromContent', () => {
  test('parses strict JSON', () => {
    expect(extractJsonFromContent('{"correctedText":"a"}')).toEqual({ correctedText: 'a' });
  });

  test('falls back to the outermost {...} slice (prose / code fences)', () => {
    const wrapped = 'Here is the result:\n```json\n{"correctedText":"a","issues":[]}\n```\nDone.';
    expect(extractJsonFromContent(wrapped)).toEqual({ correctedText: 'a', issues: [] });
  });

  test('nested braces survive the slice', () => {
    const wrapped = 'prefix {"a":{"b":1}} suffix';
    expect(extractJsonFromContent(wrapped)).toEqual({ a: { b: 1 } });
  });

  test('throws on empty content', () => {
    expect(() => extractJsonFromContent('')).toThrow('Empty response');
    expect(() => extractJsonFromContent('   ')).toThrow('Empty response');
  });

  test('throws when no valid JSON can be found', () => {
    expect(() => extractJsonFromContent('no json here')).toThrow('did not return valid JSON');
    expect(() => extractJsonFromContent('{broken')).toThrow('did not return valid JSON');
  });
});

describe('normalizeProofreadPayload', () => {
  test('keeps well-formed fields and stamps sourceText', () => {
    const payload = normalizeProofreadPayload(
      { correctedText: 'fixed', summary: 'sum', issues: [{ message: 'x' }] },
      'orig'
    );
    expect(payload).toEqual({ correctedText: 'fixed', summary: 'sum', sourceText: 'orig', issues: [{ message: 'x' }] });
  });

  test('falls back to the source text on a missing/foreign payload', () => {
    expect(normalizeProofreadPayload(undefined, 'orig')).toEqual({
      correctedText: 'orig',
      summary: '',
      sourceText: 'orig',
      issues: []
    });
    expect(normalizeProofreadPayload({ correctedText: 42, issues: 'nope' }, 'orig').correctedText).toBe('orig');
  });
});
