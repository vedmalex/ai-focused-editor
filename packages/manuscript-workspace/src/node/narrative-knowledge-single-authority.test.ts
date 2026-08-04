/**
 * WP-7's two machine checks over the "Проверка готовности" block (TASK-022
 * plan, WP-7 — "Абсорбция старых сервисов", UR-007):
 *
 *   1. Отсутствие двоевластия по СИМВОЛАМ — a migrated consumer may not still
 *      reference the legacy `NarrativeEntityService`/`NarrativeGraphService`
 *      family.
 *   2. Отсутствие независимого скана ФС (ISS-307) — no module outside
 *      `packages/narrative-knowledge` reads `entities/**` or calls
 *      `parseSemanticMarkdown`/`parseEntityTypesYaml` to build KNOWLEDGE.
 *
 * SCOPE, STATED RATHER THAN HIDDEN. Only THREE of the four WP-7 consumers are
 * migrated as of this check: Entity Cards, `manuscript_find_entities`, Book
 * Doctor. Narrative Map (`narrative-map-widget.ts`, `NodeNarrativeGraphService`,
 * the `NarrativeGraphService` stack) is NOT migrated — see tech_spec
 * TECH_SPEC WP-7 §7 for why and for the design a follow-up session needs. This
 * check covers exactly the three that ARE done; it does not claim Narrative
 * Map and does not gate on work this pass did not attempt. When Narrative Map
 * is migrated, `narrative-map-widget.ts` joins `MIGRATED_CONSUMERS` below and
 * `NodeNarrativeGraphService` joins the thin-adapter exception the same way
 * `NodeNarrativeEntityService` already does.
 *
 * THE FROZEN EXCEPTION LIST (tech_spec TECH_SPEC WP-7 §1) is exactly the set
 * of files exempted below — nothing is exempted that is not named in that
 * section, and the reasons are the same ones stated there.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const browserRoot = join(import.meta.dir, '../browser');
const nodeRoot = import.meta.dir;

function read(relativeToDir: string, file: string): string {
  return readFileSync(join(relativeToDir, file), 'utf8');
}

/**
 * Strip `/* … *\/` block comments and `// …` line comments before either
 * check scans a file's text.
 *
 * WHY. Both checks below are about CODE, not PROSE — a doc comment explaining
 * "this class no longer injects `NarrativeGraphService`" or a user-facing
 * message string containing the literal `entities/types.yaml:` (Book Doctor's
 * own finding label) is not a violation of either readiness item, and a
 * detector that could not tell the two apart would force every explanatory
 * comment in this migration's own diff to avoid naming what it replaced —
 * exactly the kind of comment tech_spec TECH_SPEC WP-7 and this migration's
 * own source rely on throughout. Stripping comments first is what lets the
 * rejecting cases below stay about REAL code (an `@inject(...)` line, a
 * `resolve('entities/types.yaml')` call) without also flagging the sentence
 * that explains why that code is gone.
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

// ---------------------------------------------------------------------------
// Check 1 — no dual authority by SYMBOL
// ---------------------------------------------------------------------------

/** The legacy symbols a migrated consumer must no longer reference. */
const LEGACY_SYMBOLS = [
  'NarrativeEntityService',
  'NarrativeEntityBackendService',
  'NarrativeGraphService',
  'NarrativeGraphBackendService'
] as const;

/**
 * Whether `text` still references one of the legacy symbols AS AN IDENTIFIER
 * (word-bounded, so a doc-comment mentioning the name in prose is not itself
 * a false negative's cause — but see the rejecting case below: a real `@inject`
 * or type reference always uses the bare identifier too, so word-boundary
 * matching does not miss it).
 */
function referencesLegacySymbol(text: string): string[] {
  const code = stripComments(text);
  return LEGACY_SYMBOLS.filter(symbol => new RegExp(`\\b${symbol}\\b`).test(code));
}

/** The three WP-7 consumers migrated onto `NarrativeKnowledgeService` directly. */
const MIGRATED_CONSUMERS: Array<{ dir: string; file: string }> = [
  { dir: browserRoot, file: 'entity-cards-widget.ts' },
  { dir: browserRoot, file: 'manuscript-tools-contribution.ts' },
  { dir: browserRoot, file: 'book-doctor-contribution.ts' }
];

describe('WP-7 machine check 1 — отсутствие двоевластия по символам', () => {
  test('none of the migrated consumers reference the legacy NarrativeEntityService/NarrativeGraphService family', () => {
    const offenders = MIGRATED_CONSUMERS
      .map(({ dir, file }) => ({ file, hits: referencesLegacySymbol(read(dir, file)) }))
      .filter(entry => entry.hits.length > 0);
    expect(offenders).toEqual([]);
  });

  // Отвергающий случай (план, WP-7, «Отвергающий случай для №1»): a leftover
  // reference outside the frozen list MUST make the check red. Proven directly
  // against the detector rather than by editing a real file mid-test-run.
  test('rejecting case — a leftover @inject(NarrativeEntityService) is detected', () => {
    const withLeftover = [
      "import { NarrativeEntityService } from '../common';",
      '@injectable()',
      'export class SomeWidget {',
      '  @inject(NarrativeEntityService)',
      '  protected readonly entities!: unknown;',
      '}'
    ].join('\n');
    expect(referencesLegacySymbol(withLeftover)).toContain('NarrativeEntityService');
  });

  test('a doc comment explaining the migration by naming the old symbol is NOT flagged', () => {
    // The real consumers' own doc comments do exactly this (e.g.
    // `manuscript-tools-contribution.ts`'s "may NOT be a thin adapter over the
    // legacy NarrativeEntityService/LegacyNarrativeEntity bridge"). A detector
    // that could not tell prose from code would force every migration
    // doc-comment to avoid naming what it replaced.
    const prose = '// No longer injects NarrativeGraphService — see tech_spec.';
    expect(referencesLegacySymbol(prose)).toEqual([]);
  });

  test('the same leftover, disguised as a trailing comment on a real import line, is still detected', () => {
    // Guards against a stripComments regression that ate too much or too
    // little: the CODE half of a mixed line must still be seen.
    const mixed = "import { NarrativeEntityService } from '../common'; // kept for X";
    expect(referencesLegacySymbol(mixed)).toContain('NarrativeEntityService');
  });
});

// ---------------------------------------------------------------------------
// Check 2 — no independent FS scan (ISS-307)
// ---------------------------------------------------------------------------

/**
 * Patterns that mean "this module is independently reading `entities/**` or
 * independently parsing prose/YAML to build KNOWLEDGE" — the thing exactly one
 * package, `@ai-focused-editor/narrative-knowledge`, is allowed to do.
 *
 * `entityTagOccurrences`' feeder (`collectManuscriptData`/`foldEntityTags`) is
 * NOT a violation of this check: it still walks the WHOLE workspace (not just
 * `content/`, by design — tech_spec TECH_SPEC WP-7 §1/§6, the `outside-content.md`
 * rejecting case) and folds tags via `parseSemanticMarkdown`/
 * `collectUnlabeledWikiEntityMatches` — but both are now imported FROM
 * `@ai-focused-editor/narrative-knowledge`, not from `@ai-focused-editor/semantic-markdown`
 * directly. That import-source change is what this check actually verifies for
 * that feeder; the pattern below matches the OLD, disallowed import path.
 */
const INDEPENDENT_SCAN_PATTERNS: Array<{ id: string; pattern: RegExp }> = [
  // Requires the FS-CALL CONTEXT (`resolve(`/`join(`), not a bare mention —
  // Book Doctor's own finding label `'entities/types.yaml: problem with …'`
  // is a user-facing STRING, not a path resolution, and must not trip this.
  { id: 'entities/types.yaml resolved as a path', pattern: /(resolve|join)\(\s*[^)]*[`'"]entities\/types\.yaml/ },
  { id: 'entities/<dir> resolve() literal', pattern: /resolve\(\s*[`'"]entities\// },
  { id: 'parseEntityTypesYaml import/call', pattern: /\bparseEntityTypesYaml\b/ },
  { id: 'mergeEntityTypes import/call', pattern: /\bmergeEntityTypes\b/ },
  { id: 'parseSemanticMarkdown imported from semantic-markdown directly', pattern: /from '@ai-focused-editor\/semantic-markdown'/ }
];

function independentScanHits(text: string): string[] {
  const code = stripComments(text);
  return INDEPENDENT_SCAN_PATTERNS.filter(({ pattern }) => pattern.test(code)).map(({ id }) => id);
}

/** The two files that USED TO scan independently and are now checked clean. */
const NO_LONGER_SCANNING: Array<{ dir: string; file: string }> = [
  { dir: browserRoot, file: 'book-doctor-contribution.ts' },
  { dir: nodeRoot, file: 'node-domain-knowledge-service.ts' }
];

describe('WP-7 machine check 2 — отсутствие независимого скана ФС (ISS-307)', () => {
  test('neither Book Doctor nor the entity-service thin adapter parses entity types or prose independently', () => {
    const offenders = NO_LONGER_SCANNING
      .map(({ dir, file }) => ({ file, hits: independentScanHits(read(dir, file)) }))
      .filter(entry => entry.hits.length > 0);
    expect(offenders).toEqual([]);
  });

  // Отвергающий случай (план, WP-7): "восстановленный вызов
  // collectExistingEntityCards() в Book Doctor обязан сделать проверку
  // красной" — i.e. reverting that method to its pre-WP-7 body (which resolved
  // `entities/${type.directory}` directly) must be caught.
  test('rejecting case — the pre-WP-7 collectExistingEntityCards body is detected', () => {
    const restored = [
      '  protected async collectExistingEntityCards(root: URI, effectiveTypes: readonly EffectiveEntityType[]): Promise<EntityCardRef[]> {',
      '    for (const type of effectiveTypes) {',
      "      const dir = root.resolve(`entities/${type.directory}`);",
      '      const stat = await this.fileService.resolve(dir).catch(() => undefined);',
      '    }',
      '  }'
    ].join('\n');
    expect(independentScanHits(restored)).toContain('entities/<dir> resolve() literal');
  });

  test('rejecting case — importing parseSemanticMarkdown straight from semantic-markdown is detected', () => {
    const restored = "import { parseSemanticMarkdown } from '@ai-focused-editor/semantic-markdown';";
    expect(independentScanHits(restored)).toContain('parseSemanticMarkdown imported from semantic-markdown directly');
  });
});
