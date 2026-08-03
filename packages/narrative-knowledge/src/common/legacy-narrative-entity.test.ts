/**
 * The rename seam of tech_spec ОВ-5, held to its two teeth.
 *
 * Tooth 2 is PURELY TYPE-LEVEL and therefore only has teeth under `tsc`:
 * `bun test` strips types and would run an `@ts-expect-error` file happily
 * either way. `tsconfig.typecheck.json` (wired into `bun run verify` as
 * `typecheck:narrative-knowledge`) is what compiles this file — and an
 * `@ts-expect-error` that stops being an error becomes an "unused directive"
 * COMPILE ERROR, so the assertion fails loudly in exactly the case it exists
 * for: someone putting `kind`/`label`/`uri` back.
 */

import { describe, expect, test } from 'bun:test';
import {
  toLegacyNarrativeEntity,
  toNarrativeEntity,
  type LegacyNarrativeEntity
} from './legacy-narrative-entity';
import type { NarrativeEntity } from './graph';

const entity: NarrativeEntity = {
  id: 'krishna',
  type: 'character',
  name: 'Кришна',
  sourcePath: 'entities/characters/krishna.yaml',
  sourceUri: 'file:///workspace/entities/characters/krishna.yaml',
  origin: 'ai-candidate',
  evidence: { path: 'entities/characters/krishna.yaml', evidenceKind: 'whole-file' },
  summary: 'Восьмое воплощение.',
  aliases: ['Говинда'],
  epithets: ['Мурлидхара'],
  backstory: 'Вриндаван.',
  arc: 'от пастуха к царю',
  speechPatterns: ['цитирует шастры'],
  notes: 'проверить главу 4'
};

const legacy: LegacyNarrativeEntity = {
  kind: 'artifact',
  id: 'sudarshana',
  label: 'Сударшана',
  path: 'entities/artifacts/sudarshana.yaml',
  uri: 'file:///workspace/entities/artifacts/sudarshana.yaml',
  aliases: []
};

describe('ОВ-5 — the rename seam', () => {
  // Tooth 1. The round trip is the identity on EVERYTHING except `origin` and
  // `evidence`, and the loss of exactly those two is asserted, not implied.
  test('a round trip through the legacy shape preserves every field but two', () => {
    const returned = toNarrativeEntity(toLegacyNarrativeEntity(entity));

    const { origin, evidence, ...survivors } = entity;
    const { origin: returnedOrigin, evidence: returnedEvidence, ...returnedSurvivors } = returned;

    expect(returnedSurvivors).toEqual(survivors);

    // And here is the loss, named. `origin` collapses to the default —
    // `ai-candidate` went in, `explicit` came out — and `evidence` is gone
    // entirely rather than invented from the path.
    expect(origin).toBe('ai-candidate');
    expect(returnedOrigin).toBe('explicit');
    expect(evidence).toBeDefined();
    expect(returnedEvidence).toBeUndefined();
  });

  test('the conversion table itself: three renames and one survivor', () => {
    const converted = toNarrativeEntity(legacy);
    expect(converted.type).toBe(legacy.kind);
    expect(converted.name).toBe(legacy.label);
    expect(converted.sourceUri).toBe(legacy.uri);
    // `path` survives as `sourcePath` rather than collapsing into `sourceUri`:
    // the index keys documents by workspace-relative path, and deriving one
    // from the other needs a workspace root this layer does not have.
    expect(converted.sourcePath).toBe(legacy.path);
  });

  test('optional fields absent in the legacy value stay absent, not undefined-valued', () => {
    const converted = toNarrativeEntity(legacy);
    expect(Object.keys(converted).sort()).toEqual([
      'aliases',
      'id',
      'name',
      'origin',
      'sourcePath',
      'sourceUri',
      'type'
    ]);
  });

  // Tooth 2. The old names are GONE, and the compiler is the one saying so.
  test('NarrativeEntity has no kind/label/uri — checked by the compiler, not by eye', () => {
    // @ts-expect-error `kind` was REMOVED by ОВ-5, not deprecated.
    const noKind = entity.kind;
    // @ts-expect-error `label` was REMOVED by ОВ-5; the field is `name`.
    const noLabel = entity.label;
    // @ts-expect-error `uri` was REMOVED by ОВ-5; the field is `sourceUri`.
    const noUri = entity.uri;

    // At runtime they are simply absent, which is the same statement said twice
    // — once to the compiler, once to the test runner that does not typecheck.
    expect([noKind, noLabel, noUri]).toEqual([undefined, undefined, undefined]);
  });
});
