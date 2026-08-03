/**
 * TASK-022 WP-8 (UR-008) — the provenance DECISION, tested where it is pure.
 *
 * This file covers the rule; `browser/ai-write-provenance-tools.test.ts` covers
 * what the three tools actually put on disk, by reading the files back. The
 * split is deliberate: the rule has many branches and no filesystem, the tools
 * have one path each and nothing worth asserting except the bytes.
 */
import { describe, expect, test } from 'bun:test';
import { parse } from 'yaml';
import { NARRATIVE_ORIGINS } from '@ai-focused-editor/narrative-knowledge/lib/common/graph';
import { NarrativeSchemaValidator } from '@ai-focused-editor/narrative-knowledge/lib/common/narrative-schema';
import {
  buildAiEntityCardYaml,
  decideAiWriteProvenance,
  evidencePathProblem,
  provenanceRecord,
  provenanceYamlBlock,
  withProvenanceFrontMatter
} from './ai-write-provenance';

const CHAPTER = 'content/chapter-01.md';
const RANGE = { start: { line: 3, character: 0 }, end: { line: 3, character: 12 } };

function decided(rawEvidence: unknown) {
  const decision = decideAiWriteProvenance(rawEvidence);
  if (!decision.ok) {
    throw new Error(`expected a stamp, got refusal: ${decision.error}`);
  }
  return decision.provenance;
}

function refusal(rawEvidence: unknown): string {
  const decision = decideAiWriteProvenance(rawEvidence);
  if (decision.ok) {
    throw new Error(`expected a refusal, got origin=${decision.provenance.origin}`);
  }
  return decision.error;
}

describe('decideAiWriteProvenance — the three outcomes', () => {
  test('ABSENT evidence is an ai-candidate, not an error', () => {
    for (const absent of [undefined, null]) {
      const provenance = decided(absent);
      expect(provenance.origin).toBe('ai-candidate');
      expect(provenance.evidence).toBeUndefined();
    }
  });

  test('a bare path string is whole-file evidence and makes the write explicit', () => {
    const provenance = decided(CHAPTER);
    expect(provenance.origin).toBe('explicit');
    expect(provenance.evidence).toEqual({ path: CHAPTER, evidenceKind: 'whole-file' });
  });

  test('an object without a range is whole-file evidence', () => {
    expect(decided({ path: CHAPTER }).evidence).toEqual({ path: CHAPTER, evidenceKind: 'whole-file' });
    expect(decided({ path: CHAPTER, range: null }).evidence).toEqual({ path: CHAPTER, evidenceKind: 'whole-file' });
  });

  test('an object with a range is range evidence, coordinates verbatim', () => {
    const provenance = decided({ path: CHAPTER, range: RANGE });
    expect(provenance.origin).toBe('explicit');
    expect(provenance.evidence).toEqual({ path: CHAPTER, evidenceKind: 'range', range: RANGE });
  });

  test('MALFORMED evidence is REFUSED, never degraded to ai-candidate', () => {
    // Each of these is a caller that TRIED to cite something. Answering any of
    // them with a quiet `ai-candidate` would hide the caller's bug behind a
    // state that looks like a deliberate choice.
    const malformed: unknown[] = [
      {},                                                   // no path at all
      { path: 42 },                                         // path not a string
      { path: '   ' },                                      // blank path
      '   ',                                                // blank bare string
      { path: '../outside/secrets.md' },                    // escapes the workspace
      { path: '/etc/passwd' },                              // absolute
      { path: 'C:\\Windows\\win.ini' },                     // absolute, Windows
      { path: CHAPTER, range: 'line 3' },                   // range not an object
      { path: CHAPTER, range: { start: RANGE.start } },     // half a range
      { path: CHAPTER, range: { start: { line: -1, character: 0 }, end: RANGE.end } },
      { path: CHAPTER, range: { start: { line: 1.5, character: 0 }, end: RANGE.end } },
      { path: CHAPTER, range: { start: { line: '1', character: 0 }, end: RANGE.end } },
      [CHAPTER],                                            // an array is not evidence
      7
    ];
    for (const value of malformed) {
      expect(refusal(value)).toMatch(/\S/);
    }
  });

  test('the origin a write tool can produce is a member of the closed domain union', () => {
    for (const raw of [undefined, CHAPTER]) {
      expect(NARRATIVE_ORIGINS).toContain(decided(raw).origin);
    }
    // ...and `derived` is not among them: nothing here computes a fact from
    // other indexed facts, so a write tool must never claim that origin.
    expect([decided(undefined).origin, decided(CHAPTER).origin]).not.toContain('derived');
  });
});

describe('evidencePathProblem', () => {
  test('accepts a workspace-relative path', () => {
    expect(evidencePathProblem(CHAPTER)).toBeUndefined();
    expect(evidencePathProblem('entities/characters/krishna.yaml')).toBeUndefined();
  });

  test('rejects blank, traversing, and absolute paths', () => {
    expect(evidencePathProblem('')).toBeDefined();
    expect(evidencePathProblem('a/../../b.md')).toBeDefined();
    expect(evidencePathProblem('/abs.md')).toBeDefined();
    expect(evidencePathProblem('D:/abs.md')).toBeDefined();
  });
});

describe('the stamp the author sees is the stamp that is written', () => {
  test('provenanceYamlBlock is a literal substring of the entity card', () => {
    for (const raw of [undefined, CHAPTER, { path: CHAPTER, range: RANGE }]) {
      const provenance = decided(raw);
      const card = buildAiEntityCardYaml({ id: 'krishna', name: 'Krishna' }, provenance);
      expect(card).toContain(provenanceYamlBlock(provenance));
    }
  });

  test('provenanceYamlBlock is a literal substring of the stamped note', () => {
    const provenance = decided({ path: CHAPTER, range: RANGE });
    const stamped = withProvenanceFrontMatter('# Title\n\nbody\n', provenance);
    expect(stamped.ok).toBe(true);
    expect(stamped.ok && stamped.content).toContain(provenanceYamlBlock(provenance));
  });

  test('the rendered block parses back into exactly the record', () => {
    for (const raw of [undefined, CHAPTER, { path: CHAPTER, range: RANGE }]) {
      const provenance = decided(raw);
      expect(parse(provenanceYamlBlock(provenance))).toEqual(provenanceRecord(provenance));
    }
  });
});

describe('buildAiEntityCardYaml', () => {
  test('keeps the card shape and appends the stamp', () => {
    const provenance = decided(undefined);
    const card = buildAiEntityCardYaml({ id: 'krishna', name: 'Krishna', summary: 'Charioteer.' }, provenance);
    expect(parse(card)).toEqual({
      id: 'krishna',
      name: 'Krishna',
      aliases: [],
      summary: 'Charioteer.',
      origin: 'ai-candidate'
    });
  });

  test('a sourced card carries the evidence pointer', () => {
    const provenance = decided({ path: CHAPTER, range: RANGE });
    expect(parse(buildAiEntityCardYaml({ id: 'krishna', name: 'Krishna' }, provenance))).toEqual({
      id: 'krishna',
      name: 'Krishna',
      aliases: [],
      origin: 'explicit',
      evidence: { path: CHAPTER, evidenceKind: 'range', range: RANGE }
    });
  });

  test('the written evidence is a valid EvidenceRef by WP-1 own schema', () => {
    // The point of this one: the shape this package writes and the shape the
    // narrative-knowledge read boundary accepts must be the SAME shape. Two
    // packages agreeing by eye is how `evidence_kind` would quietly become a
    // field only one side understands.
    const validator = new NarrativeSchemaValidator();
    for (const raw of [CHAPTER, { path: CHAPTER, range: RANGE }]) {
      const evidence = decided(raw).evidence;
      expect(validator.problems('evidence', evidence)).toEqual([]);
    }
  });
});

describe('withProvenanceFrontMatter', () => {
  test('prepends a fence when the note has none, leaving the body untouched', () => {
    const provenance = decided(undefined);
    const result = withProvenanceFrontMatter('# Plan\n\nfirst line\n', provenance);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.content).toBe('---\norigin: ai-candidate\n---\n\n# Plan\n\nfirst line\n');
  });

  test('splices into an existing fence, keeping every existing key and comment', () => {
    const provenance = decided(CHAPTER);
    const markdown = '---\ntitle: Plan\n# a comment the model wrote\nlanguage: ru\n---\n\n# Plan\n';
    const result = withProvenanceFrontMatter(markdown, provenance);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.content).toContain('# a comment the model wrote');
    expect(result.content).toContain('title: Plan');
    expect(result.content.endsWith('\n# Plan\n')).toBe(true);
    expect(parse(result.content.split('---')[1])).toEqual({
      title: 'Plan',
      language: 'ru',
      origin: 'explicit',
      evidence: { path: CHAPTER, evidenceKind: 'whole-file' }
    });
  });

  test('REFUSES a note whose front matter already claims its own provenance', () => {
    // A model that stamps itself `explicit` would be grading its own homework,
    // and splicing on top would leave a duplicate key whose winner is the
    // parser's business rather than the author's.
    for (const claim of ['origin: explicit', 'evidence:\n  path: content/chapter-01.md']) {
      const result = withProvenanceFrontMatter(`---\n${claim}\n---\n\nbody\n`, decided(undefined));
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error).toContain('provenance is recorded by the editor');
    }
  });

  test('refuses a front matter that is not readable YAML or not a mapping', () => {
    expect(withProvenanceFrontMatter('---\n: :\n---\nbody\n', decided(undefined)).ok).toBe(false);
    expect(withProvenanceFrontMatter('---\n- a\n- b\n---\nbody\n', decided(undefined)).ok).toBe(false);
  });

  test('an empty fence is still a fence and is spliced, not duplicated', () => {
    const result = withProvenanceFrontMatter('---\n---\nbody\n', decided(undefined));
    expect(result.ok).toBe(true);
    expect(result.ok && result.content).toBe('---\norigin: ai-candidate\n---\nbody\n');
  });
});
