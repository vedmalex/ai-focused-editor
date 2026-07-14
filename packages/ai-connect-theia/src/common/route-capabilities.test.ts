import { describe, expect, test } from 'bun:test';
import type { PublicRouteCapabilities } from '@vedmalex/ai-connect';
import {
  CONSERVATIVE_LOCAL_CAPABILITIES,
  mergeRouteCapabilities,
  resolveCandidateCapabilities,
  toAiRouteCapabilities,
  type AiRouteCapabilities
} from './route-capabilities';

const ALL_TRUE: PublicRouteCapabilities = {
  browserSafe: true,
  supportsStreaming: true,
  supportsToolSchema: true,
  supportsToolExecution: true,
  supportsClientToolExecution: true,
  supportsFileUpload: true,
  supportsFileOutput: true,
  supportsImageInput: true,
  supportsImageOutput: true
};

const ALL_FALSE: PublicRouteCapabilities = {
  browserSafe: false,
  supportsStreaming: false,
  supportsToolSchema: false,
  supportsToolExecution: false,
  supportsClientToolExecution: false,
  supportsFileUpload: false,
  supportsFileOutput: false,
  supportsImageInput: false,
  supportsImageOutput: false
};

describe('toAiRouteCapabilities', () => {
  test('copies all nine flags verbatim', () => {
    expect(toAiRouteCapabilities(ALL_TRUE)).toEqual(ALL_TRUE);
    expect(toAiRouteCapabilities(ALL_FALSE)).toEqual(ALL_FALSE);
  });

  test('does not carry extra fields beyond the nine flags', () => {
    const withExtra = { ...ALL_TRUE, localOnly: true, requiresFilesystem: true } as unknown as PublicRouteCapabilities;
    expect(Object.keys(toAiRouteCapabilities(withExtra)).sort()).toEqual(Object.keys(ALL_TRUE).sort());
  });
});

describe('mergeRouteCapabilities', () => {
  test('returns undefined for an empty list', () => {
    expect(mergeRouteCapabilities([])).toBeUndefined();
  });

  test('ORs flags across candidates', () => {
    const a: AiRouteCapabilities = { ...toAiRouteCapabilities(ALL_FALSE), supportsStreaming: true, supportsImageInput: true };
    const b: AiRouteCapabilities = { ...toAiRouteCapabilities(ALL_FALSE), supportsToolSchema: true };
    expect(mergeRouteCapabilities([a, b])).toEqual({
      ...toAiRouteCapabilities(ALL_FALSE),
      supportsStreaming: true,
      supportsImageInput: true,
      supportsToolSchema: true
    });
  });

  test('a single set round-trips unchanged', () => {
    expect(mergeRouteCapabilities([toAiRouteCapabilities(ALL_TRUE)])).toEqual(toAiRouteCapabilities(ALL_TRUE));
  });
});

describe('resolveCandidateCapabilities', () => {
  test('returns undefined when there are no candidates', () => {
    expect(resolveCandidateCapabilities([], 'gpt-4o')).toBeUndefined();
  });

  test('picks the exact model match', () => {
    const caps = resolveCandidateCapabilities([
      { model: 'gpt-4o', capabilities: { ...ALL_FALSE, supportsImageInput: true } },
      { model: 'other', capabilities: ALL_TRUE }
    ], 'gpt-4o');
    expect(caps?.supportsImageInput).toBe(true);
    expect(caps?.browserSafe).toBe(false);
  });

  test('falls back to the OR-merge when the model is absent', () => {
    const caps = resolveCandidateCapabilities([
      { model: 'a', capabilities: { ...ALL_FALSE, supportsImageInput: true } },
      { model: 'b', capabilities: { ...ALL_FALSE, supportsToolSchema: true } }
    ], 'not-listed');
    expect(caps).toEqual({
      ...toAiRouteCapabilities(ALL_FALSE),
      supportsImageInput: true,
      supportsToolSchema: true
    });
  });

  test('falls back to the OR-merge when no model is given', () => {
    const caps = resolveCandidateCapabilities([
      { model: 'a', capabilities: { ...ALL_FALSE, supportsStreaming: true } }
    ], undefined);
    expect(caps?.supportsStreaming).toBe(true);
  });
});

describe('CONSERVATIVE_LOCAL_CAPABILITIES', () => {
  test('assumes streaming only', () => {
    expect(CONSERVATIVE_LOCAL_CAPABILITIES.supportsStreaming).toBe(true);
    expect(CONSERVATIVE_LOCAL_CAPABILITIES.supportsImageInput).toBe(false);
    expect(CONSERVATIVE_LOCAL_CAPABILITIES.supportsFileUpload).toBe(false);
  });
});
