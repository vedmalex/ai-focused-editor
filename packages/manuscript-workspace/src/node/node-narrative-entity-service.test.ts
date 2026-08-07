import { tmpdir } from 'os';
/**
 * RESTORED, ADAPTED TO THE MIGRATED PATH (TASK-022 WP-7, review finding 2 on
 * this task).
 *
 * The original version of this file (SPLIT OUT OF
 * `node-domain-knowledge-service.test.ts`, then deleted in the same WP-7 pass
 * that added `narrative-knowledge-single-authority.test.ts`) held twelve
 * BEHAVIOURAL characterizations of `NodeNarrativeEntityService.getSnapshot()`.
 * The deletion was justified as arithmetic (twelve tests removed, seven
 * structural checks added) — arithmetic is not a justification, and the seven
 * structural checks in `narrative-knowledge-single-authority.test.ts` do not
 * cover this class at all: they assert that the THREE MIGRATED CONSUMERS
 * (`entity-cards-widget.ts`, `manuscript-tools-contribution.ts`,
 * `book-doctor-contribution.ts`) hold no legacy reference and no independent
 * FS scan. `NodeNarrativeEntityService` is neither — it is the class WP-7's
 * own tech_spec (TECH_SPEC WP-7 §1) freezes exactly BECAUSE its ELEVEN
 * untouched downstream consumers still inject `NarrativeEntityService` and
 * still receive `LegacyNarrativeEntity`-shaped data (see its doc comment in
 * `node-domain-knowledge-service.ts`). Before this file was restored, that
 * thin adapter — still live, still depended on by eleven consumers — had ZERO
 * test coverage of its own.
 *
 * WHAT CHANGED ON THE MIGRATED PATH, ADAPTED HERE RATHER THAN GLOSSED OVER:
 *  - the class no longer scans `entities/**` itself; it delegates to
 *    `NarrativeKnowledgeService.findEntities`/`getEntityTypeRegistry`, so the
 *    fixture below builds a REAL index (`InMemoryNarrativeIndexStore` +
 *    `NarrativeIndexSession.rebuild()` over `scanWorkspaceFiles()`) instead of
 *    writing loose YAML the old scan read directly — the same technique
 *    `narrative-consumer-baseline.test.ts` uses for the three migrated
 *    consumers, and for the same reason (real extraction code, not a second
 *    hand-rolled parser);
 *  - "defaults rich fields to empty when absent" is a GENUINE REGRESSION,
 *    surfaced rather than silently adapted: the old scan defaulted
 *    `epithets`/`speechPatterns` to `[]` and `backstory`/`arc`/`notes` to
 *    `''`; `toLegacyNarrativeEntity` (`@ai-focused-editor/narrative-knowledge`)
 *    leaves them `undefined` (ABSENT — key omitted) instead. Any of the eleven
 *    untouched consumers that read one of these fields unconditionally (e.g.
 *    `entity.epithets.join(', ')`, assuming the old always-`[]` contract) can
 *    now throw on a card that omits the field. Flagged in the review report
 *    for this task rather than fixed here — fixing it means touching
 *    `toLegacyNarrativeEntity` or this adapter, which is outside the two
 *    findings this pass closes;
 *  - three of the twelve (malformed YAML, non-object YAML, missing entity
 *    directory) are behaviour that GENUINELY NO LONGER EXISTS at this seam —
 *    not moved, not renamed. `NodeNarrativeEntityService`'s own doc comment
 *    names the reason and what replaced it: those problems ARE still
 *    collected during extraction (`EntityCardProblem`,
 *    `NarrativeRebuildReport.problems.cards` on the index side) but this
 *    adapter only calls the two lightweight envelope queries
 *    (`findEntities`/`getEntityTypeRegistry`), neither of which carries
 *    card-level problems — "there is no cheap non-rebuild query for them yet".
 *    Below, that gap is a PASSING test asserting the dropped behaviour stays
 *    dropped, not a comment claiming it — if a query is ever added and wired
 *    up, these three tests are exactly what needs to flip.
 *
 * `makeRoot`/`SCRATCH_BASE`/`buildFixtureKnowledgeService` are REPEATED here
 * rather than imported from `narrative-consumer-baseline.test.ts` — same rule
 * as the original split (this file's own history): a shared helper under
 * `src/` would compile into `lib/` and ship as production surface, and the
 * two files live in different tracks (`test:packages` here, the browser-only
 * `test:widget` there) that must stay independently runnable.
 */

import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { promises as fs } from 'fs';
import { join } from 'path';
import { FileUri } from '@theia/core/lib/common/file-uri';
import {
  InMemoryNarrativeIndexStore,
  NarrativeIndexSession,
  resolveEffectiveEntityTypes,
  envelope,
  type NarrativeKnowledgeService as NarrativeKnowledgeServiceType
} from '@ai-focused-editor/narrative-knowledge';
import { scanWorkspaceFiles } from '@ai-focused-editor/narrative-knowledge/lib/node/narrative-workspace-scan';
import { NARRATIVE_INDEX_SCHEMA_VERSION } from '@ai-focused-editor/narrative-knowledge/lib/node/narrative-index-schema';
import { NodeNarrativeEntityService } from './node-domain-knowledge-service';

const SCRATCH_BASE = process.env.CLAUDE_SCRATCHPAD_DIR
  || tmpdir();

async function makeRoot(): Promise<string> {
  const base = SCRATCH_BASE.startsWith('/') ? SCRATCH_BASE : tmpdir();
  await fs.mkdir(base, { recursive: true });
  return fs.mkdtemp(join(base, 'afe-entity-adapter-'));
}

async function write(root: string, relative: string, content: string): Promise<void> {
  const path = join(root, relative);
  await fs.mkdir(join(path, '..'), { recursive: true });
  await fs.writeFile(path, content);
}

function toFsPath(rootUri: string): string {
  return rootUri.startsWith('file:') ? FileUri.fsPath(rootUri) : rootUri;
}

/**
 * The same fixture double `narrative-consumer-baseline.test.ts` builds for the
 * three migrated consumers (see that file's own comment for why: real files
 * read off disk through `scanWorkspaceFiles`, indexed through
 * `NarrativeIndexSession.rebuild()` over `InMemoryNarrativeIndexStore` — not
 * `node:sqlite`, which `bun test` cannot resolve).
 */
function buildFixtureKnowledgeService(): Pick<NarrativeKnowledgeServiceType, 'findEntities' | 'getEntityTypeRegistry'> {
  const sessions = new Map<string, InstanceType<typeof NarrativeIndexSession>>();

  const sessionFor = (rootPath: string): InstanceType<typeof NarrativeIndexSession> => {
    const existing = sessions.get(rootPath);
    if (existing) {
      return existing;
    }
    const store = new InMemoryNarrativeIndexStore();
    const session = new NarrativeIndexSession({ store, schemaVersion: NARRATIVE_INDEX_SCHEMA_VERSION });
    session.rebuild(scanWorkspaceFiles(rootPath));
    sessions.set(rootPath, session);
    return session;
  };

  return {
    async findEntities(rootUri: string) {
      return sessionFor(toFsPath(rootUri)).findEntities();
    },
    async getEntityTypeRegistry(rootUri: string) {
      const rootPath = toFsPath(rootUri);
      const session = sessionFor(rootPath);
      let text: string | undefined;
      try {
        text = await fs.readFile(join(rootPath, 'entities/types.yaml'), 'utf8');
      } catch {
        text = undefined;
      }
      return envelope(session.state(), resolveEffectiveEntityTypes(text));
    }
  } as Pick<NarrativeKnowledgeServiceType, 'findEntities' | 'getEntityTypeRegistry'>;
}

describe('NodeNarrativeEntityService (WP-7 thin adapter, eleven untouched consumers)', () => {
  let root: string;
  let service: NodeNarrativeEntityService;

  beforeEach(async () => {
    root = await makeRoot();
    service = new NodeNarrativeEntityService();
    (service as unknown as { knowledge: unknown }).knowledge = buildFixtureKnowledgeService();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const rootUri = (): string => FileUri.create(root).toString();

  test('returns an info diagnostic when no workspace is open', async () => {
    const snapshot = await service.getSnapshot(undefined);
    expect(snapshot.entities).toEqual([]);
    expect(snapshot.diagnostics).toEqual([{
      severity: 'info',
      source: 'narrative-entities',
      message: 'Open a manuscript workspace to view entity cards.'
    }]);
  });

  test('parses character labels, aliases and summary', async () => {
    await write(root, 'entities/characters/hero.yaml', [
      'id: hero',
      'name: Главный Герой',
      'summary: Отважный путешественник',
      'aliases:',
      '  - Герой',
      '  - "  "',
      '  - Странник',
      ''
    ].join('\n'));

    const snapshot = await service.getSnapshot(rootUri());
    const hero = snapshot.entities.find(entity => entity.id === 'hero');
    expect(hero).toBeDefined();
    expect(hero!.kind).toBe('character');
    expect(hero!.label).toBe('Главный Герой');
    expect(hero!.summary).toBe('Отважный путешественник');
    expect(hero!.aliases).toEqual(['Герой', 'Странник']);
    expect(hero!.path).toBe('entities/characters/hero.yaml');
    expect(hero!.uri.startsWith('file:')).toBe(true);
  });

  test('parses rich character fields (epithets, backstory, arc, speech patterns, notes)', async () => {
    await write(root, 'entities/characters/sage.yaml', [
      'id: sage',
      'name: Мудрец',
      'epithets:',
      '  - Наставник',
      '  - "  "',
      '  - Провидец',
      'backstory: Долгий путь через изгнание.',
      'arc: От сомнения к решимости.',
      'speechPatterns:',
      '  - Отвечает вопросом на вопрос',
      '  - Говорит притчами',
      'notes: Ключевой голос главы.',
      ''
    ].join('\n'));

    const snapshot = await service.getSnapshot(rootUri());
    const sage = snapshot.entities.find(entity => entity.id === 'sage');
    expect(sage).toBeDefined();
    expect(sage!.epithets).toEqual(['Наставник', 'Провидец']);
    expect(sage!.backstory).toBe('Долгий путь через изгнание.');
    expect(sage!.arc).toBe('От сомнения к решимости.');
    expect(sage!.speechPatterns).toEqual(['Отвечает вопросом на вопрос', 'Говорит притчами']);
    expect(sage!.notes).toBe('Ключевой голос главы.');
  });

  test('scans artifact and location entity directories', async () => {
    await write(root, 'entities/artifacts/bow.yaml', [
      'id: bow',
      'name: Гандива',
      'epithets:',
      '  - Гром небес',
      'summary: Божественный лук.',
      ''
    ].join('\n'));
    await write(root, 'entities/locations/field.yml', [
      'name: Курукшетра',
      'summary: Поле дхармы.',
      ''
    ].join('\n'));

    const snapshot = await service.getSnapshot(rootUri());

    const artifact = snapshot.entities.find(entity => entity.kind === 'artifact');
    expect(artifact).toBeDefined();
    expect(artifact!.id).toBe('bow');
    expect(artifact!.label).toBe('Гандива');
    expect(artifact!.epithets).toEqual(['Гром небес']);
    expect(artifact!.summary).toBe('Божественный лук.');
    expect(artifact!.path).toBe('entities/artifacts/bow.yaml');

    const location = snapshot.entities.find(entity => entity.kind === 'location');
    expect(location).toBeDefined();
    expect(location!.id).toBe('field');
    expect(location!.label).toBe('Курукшетра');
    expect(location!.summary).toBe('Поле дхармы.');
  });

  test('defaults rich fields to ABSENT when absent (WP-7 regression, recorded not silently adapted)', async () => {
    // ПЕРЕИМЕНОВАНИЕ ПОВЕДЕНИЯ, ЗАПИСАННОЕ ЗДЕСЬ, А НЕ ПРОПУЩЕННОЕ (review
    // finding 2). До WP-7 этот же тест утверждал `epithets: []`,
    // `speechPatterns: []`, `backstory: ''`, `arc: ''`, `notes: ''` — старый
    // скан ВСЕГДА заполнял эти поля, даже когда карточка их не объявляла.
    // `toLegacyNarrativeEntity` (`@ai-focused-editor/narrative-knowledge`)
    // оставляет их `undefined` (ключа нет вовсе), а не синтезирует пустые
    // значения. Одиннадцать НЕТРОНУТЫХ потребителей этого класса были написаны
    // против СТАРОГО контракта; любой из них, читающий `entity.epithets.join`
    // или `entity.backstory.length` безусловно, теперь может упасть на
    // карточке без этого поля. Это НЕ исправлено здесь (см. заголовочный
    // комментарий файла) — только зафиксировано как реальное поведение.
    await write(root, 'entities/characters/plain.yaml', 'id: plain\nname: Plain\n');
    const snapshot = await service.getSnapshot(rootUri());
    const plain = snapshot.entities.find(entity => entity.id === 'plain');
    expect(plain).toBeDefined();
    expect(plain!.epithets).toBeUndefined();
    expect(plain!.speechPatterns).toBeUndefined();
    expect(plain!.backstory).toBeUndefined();
    expect(plain!.arc).toBeUndefined();
    expect(plain!.notes).toBeUndefined();
    // `aliases` is the one exception: `LegacyNarrativeEntity.aliases` is NOT
    // optional, and `NarrativeEntity.aliases` is never absent either — this
    // one field's legacy contract (always an array) survives unchanged.
    expect(plain!.aliases).toEqual([]);
  });

  test('falls back to term label field and filename id', async () => {
    await write(root, 'entities/terms/magic.yml', 'term: Магия\n');
    const snapshot = await service.getSnapshot(rootUri());
    const term = snapshot.entities.find(entity => entity.kind === 'term');
    expect(term).toBeDefined();
    expect(term!.id).toBe('magic');
    expect(term!.label).toBe('Магия');
    expect(term!.summary).toBeUndefined();
    expect(term!.aliases).toEqual([]);
  });

  test('a malformed entity YAML no longer surfaces a diagnostic here — known gap (tech_spec WP-7 §1)', async () => {
    // ЧЕГО БОЛЬШЕ НЕТ, И ЧТО НАЗВАНО ВМЕСТО ТЕСТА (review finding 2). Старый
    // скан эмитировал `error`-диагностику с текстом `Invalid character YAML`.
    // Разбор карточки (`parseEntityCard`, `entity-card-extraction.ts`) СЕГОДНЯ
    // производит СТРУКТУРНО ТОТ ЖЕ проблемный код (`invalid-yaml`, сообщение
    // `Invalid ${type.id} YAML: …`) — он просто больше НЕ ДОЕЗЖАЕТ до
    // `getSnapshot()`: `NodeNarrativeEntityService` вызывает только
    // `findEntities`/`getEntityTypeRegistry`, ни один из которых переносит
    // `EntityCardProblem`. Карточка молча ВЫПАДАЕТ из списка сущностей, без
    // диагностики какого-либо рода. Это утверждение красное, если кто-то
    // подключит недорогой запрос к `NarrativeRebuildReport.problems.cards` и
    // забудет обновить этот тест — то есть оно ловит именно ту регрессию,
    // которую якобы должно ловить: молчаливое возвращение старого поведения
    // без обновления утверждения, а не только его исчезновение.
    await write(root, 'entities/characters/broken.yaml', 'id: broken\n  : : :\n');
    const snapshot = await service.getSnapshot(rootUri());
    expect(snapshot.entities.some(entity => entity.id === 'broken')).toBe(false);
    expect(snapshot.diagnostics.some(diagnostic => diagnostic.severity === 'error')).toBe(false);
  });

  test('a non-object entity YAML no longer surfaces a diagnostic here — known gap (tech_spec WP-7 §1)', async () => {
    // Same seam as the malformed-YAML case above: `parseEntityCard` still
    // detects `not-a-mapping` and returns no card; `getSnapshot()` still has
    // nowhere to put that problem.
    await write(root, 'entities/terms/list.yaml', '- a\n- b\n');
    const snapshot = await service.getSnapshot(rootUri());
    expect(snapshot.entities.some(entity => entity.kind === 'term')).toBe(false);
    expect(snapshot.diagnostics.some(diagnostic => diagnostic.message.includes('must be'))).toBe(false);
  });

  test('a missing entity directory no longer surfaces a diagnostic here — known gap (tech_spec WP-7 §1)', async () => {
    // The old scan `readdir`'d each type directory itself and emitted an
    // `info` diagnostic when one was absent. `scanWorkspaceFiles` walks the
    // whole workspace once; a type directory that does not exist on disk
    // simply contributes zero files — there is no per-directory existence
    // check left to fail, and so nothing to report. No `entities/terms`
    // directory is created in this fixture at all (unlike the old scan's
    // `beforeEach`, which pre-created all four).
    const snapshot = await service.getSnapshot(rootUri());
    expect(snapshot.entities.some(entity => entity.kind === 'term')).toBe(false);
    expect(snapshot.diagnostics.some(diagnostic => diagnostic.message.includes('directory'))).toBe(false);
  });

  test('carries the built-in effective types when no types.yaml is present', async () => {
    const snapshot = await service.getSnapshot(rootUri());
    expect(snapshot.effectiveEntityTypes?.map(type => type.id)).toEqual(['character', 'term', 'artifact', 'location']);
    expect(snapshot.effectiveEntityTypes?.every(type => type.origin === 'built-in')).toBe(true);
    expect(snapshot.typeProblems).toEqual([]);
  });

  test('loads author types from entities/types.yaml and scans their directories', async () => {
    await write(root, 'entities/types.yaml', [
      '- id: faction',
      '  label: Faction',
      '  directory: factions',
      ''
    ].join('\n'));
    await write(root, 'entities/factions/guild.yaml', 'id: guild\nname: Merchants Guild\nsummary: Traders.\n');

    const snapshot = await service.getSnapshot(rootUri());

    // The effective type list appends the author type tagged `book`.
    const faction = snapshot.effectiveEntityTypes?.find(type => type.id === 'faction');
    expect(faction?.origin).toBe('book');
    expect(faction?.directory).toBe('factions');

    // Its directory was scanned; the entity's runtime kind is the author id.
    const guild = snapshot.entities.find(entity => entity.id === 'guild');
    expect(guild).toBeDefined();
    expect(guild!.kind as unknown as string).toBe('faction');
    expect(guild!.label).toBe('Merchants Guild');
    expect(guild!.summary).toBe('Traders.');
    expect(guild!.path).toBe('entities/factions/guild.yaml');
  });

  test('surfaces types.yaml validation problems as warnings and in typeProblems', async () => {
    await write(root, 'entities/types.yaml', [
      '- id: character',
      '  label: Hijacked',
      ''
    ].join('\n'));

    const snapshot = await service.getSnapshot(rootUri());
    expect(snapshot.typeProblems?.map(problem => problem.code)).toEqual(['reserved-id']);
    const warning = snapshot.diagnostics.find(diagnostic => diagnostic.source === 'entity-types');
    expect(warning?.severity).toBe('warning');
    // The built-in character type is never overridden.
    expect(snapshot.effectiveEntityTypes?.filter(type => type.id === 'character')).toHaveLength(1);
    expect(snapshot.effectiveEntityTypes?.find(type => type.id === 'character')?.origin).toBe('built-in');
  });
});
