/**
 * SPLIT OUT OF `node-domain-knowledge-service.test.ts` (TASK-022 WP-7).
 *
 * The original file held FOUR unrelated `describe` blocks over three unrelated
 * services, and WP-7 touches exactly one of them. The plan's rule is that the
 * unit of decision is the `describe` BLOCK and not the FILE, so the file is
 * SPLIT FIRST and the fate of each block is decided afterwards, one at a time.
 * Nothing below is rewritten by the split: the assertions, the fixtures and
 * their order are byte-identical to the block this file was carved from.
 *
 * `makeRoot`/`SCRATCH_BASE` are REPEATED in each of the four files rather than
 * lifted into a shared module. `tsconfig.json` excludes test files and NOTHING
 * else, so a shared helper under `src/` would compile into `lib/` and ship as
 * production surface — for eight lines of `mkdtemp`. Repetition is the smaller
 * cost, and it keeps each file runnable on its own.
 */

import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { NodeNarrativeEntityService } from './node-domain-knowledge-service';

const SCRATCH_BASE = process.env.CLAUDE_SCRATCHPAD_DIR
  || '/private/tmp/claude-501/-Users-vedmalex-work-ai-editor-3/8a15f000-cd38-4649-8fe4-b479e61f41c1/scratchpad/domain-services-test';

async function makeRoot(): Promise<string> {
  await fs.mkdir(SCRATCH_BASE.startsWith('/') ? SCRATCH_BASE : tmpdir(), { recursive: true });
  return fs.mkdtemp(join(SCRATCH_BASE.startsWith('/') ? SCRATCH_BASE : tmpdir(), 'afe-domain-'));
}

describe('NodeNarrativeEntityService', () => {
  let root: string;
  let service: NodeNarrativeEntityService;

  beforeEach(async () => {
    root = await makeRoot();
    service = new NodeNarrativeEntityService();
    await fs.mkdir(join(root, 'entities/characters'), { recursive: true });
    await fs.mkdir(join(root, 'entities/terms'), { recursive: true });
    await fs.mkdir(join(root, 'entities/artifacts'), { recursive: true });
    await fs.mkdir(join(root, 'entities/locations'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

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
    await fs.writeFile(join(root, 'entities/characters/hero.yaml'), [
      'id: hero',
      'name: Главный Герой',
      'summary: Отважный путешественник',
      'aliases:',
      '  - Герой',
      '  - "  "',
      '  - Странник',
      ''
    ].join('\n'));

    const snapshot = await service.getSnapshot(root);
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
    await fs.writeFile(join(root, 'entities/characters/sage.yaml'), [
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

    const snapshot = await service.getSnapshot(root);
    const sage = snapshot.entities.find(entity => entity.id === 'sage');
    expect(sage).toBeDefined();
    expect(sage!.epithets).toEqual(['Наставник', 'Провидец']);
    expect(sage!.backstory).toBe('Долгий путь через изгнание.');
    expect(sage!.arc).toBe('От сомнения к решимости.');
    expect(sage!.speechPatterns).toEqual(['Отвечает вопросом на вопрос', 'Говорит притчами']);
    expect(sage!.notes).toBe('Ключевой голос главы.');
  });

  test('scans artifact and location entity directories', async () => {
    await fs.writeFile(join(root, 'entities/artifacts/bow.yaml'), [
      'id: bow',
      'name: Гандива',
      'epithets:',
      '  - Гром небес',
      'summary: Божественный лук.',
      ''
    ].join('\n'));
    await fs.writeFile(join(root, 'entities/locations/field.yml'), [
      'name: Курукшетра',
      'summary: Поле дхармы.',
      ''
    ].join('\n'));

    const snapshot = await service.getSnapshot(root);

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

  test('defaults rich fields to empty when absent', async () => {
    await fs.writeFile(join(root, 'entities/characters/plain.yaml'), 'id: plain\nname: Plain\n');
    const snapshot = await service.getSnapshot(root);
    const plain = snapshot.entities.find(entity => entity.id === 'plain');
    expect(plain!.epithets).toEqual([]);
    expect(plain!.speechPatterns).toEqual([]);
    expect(plain!.backstory).toBe('');
    expect(plain!.arc).toBe('');
    expect(plain!.notes).toBe('');
  });

  test('falls back to term label field and filename id', async () => {
    await fs.writeFile(join(root, 'entities/terms/magic.yml'), 'term: Магия\n');
    const snapshot = await service.getSnapshot(root);
    const term = snapshot.entities.find(entity => entity.kind === 'term');
    expect(term).toBeDefined();
    expect(term!.id).toBe('magic');
    expect(term!.label).toBe('Магия');
    expect(term!.summary).toBe('');
    expect(term!.aliases).toEqual([]);
  });

  test('emits an error diagnostic for malformed YAML', async () => {
    await fs.writeFile(join(root, 'entities/characters/broken.yaml'), 'id: broken\n  : : :\n');
    const snapshot = await service.getSnapshot(root);
    const errors = snapshot.diagnostics.filter(diagnostic => diagnostic.severity === 'error');
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0].source).toBe('narrative-entities');
    expect(errors[0].message).toContain('Invalid character YAML');
  });

  test('emits an error diagnostic when the entity YAML is not an object', async () => {
    await fs.writeFile(join(root, 'entities/terms/list.yaml'), '- a\n- b\n');
    const snapshot = await service.getSnapshot(root);
    const error = snapshot.diagnostics.find(diagnostic => diagnostic.message.includes('term entity YAML must be an object'));
    expect(error?.severity).toBe('error');
  });

  test('emits an info diagnostic when an entity directory is missing', async () => {
    await fs.rm(join(root, 'entities/terms'), { recursive: true, force: true });
    const snapshot = await service.getSnapshot(root);
    const info = snapshot.diagnostics.find(diagnostic => diagnostic.message.includes('No term entity directory found'));
    expect(info?.severity).toBe('info');
  });

  test('carries the built-in effective types when no types.yaml is present', async () => {
    const snapshot = await service.getSnapshot(root);
    expect(snapshot.effectiveEntityTypes?.map(type => type.id)).toEqual(['character', 'term', 'artifact', 'location']);
    expect(snapshot.effectiveEntityTypes?.every(type => type.origin === 'built-in')).toBe(true);
    expect(snapshot.typeProblems).toEqual([]);
  });

  test('loads author types from entities/types.yaml and scans their directories', async () => {
    await fs.writeFile(join(root, 'entities/types.yaml'), [
      '- id: faction',
      '  label: Faction',
      '  directory: factions',
      ''
    ].join('\n'));
    await fs.mkdir(join(root, 'entities/factions'), { recursive: true });
    await fs.writeFile(join(root, 'entities/factions/guild.yaml'), 'id: guild\nname: Merchants Guild\nsummary: Traders.\n');

    const snapshot = await service.getSnapshot(root);

    // The effective type list appends the author type tagged `book`.
    const faction = snapshot.effectiveEntityTypes?.find(type => type.id === 'faction');
    expect(faction?.origin).toBe('book');
    expect(faction?.directory).toBe('factions');

    // Its directory was scanned; the entity's runtime kind is the author id.
    const guild = snapshot.entities.find(entity => entity.id === 'guild');
    expect(guild).toBeDefined();
    expect(guild!.kind).toBe('faction');
    expect(guild!.label).toBe('Merchants Guild');
    expect(guild!.summary).toBe('Traders.');
    expect(guild!.path).toBe('entities/factions/guild.yaml');
  });

  test('surfaces types.yaml validation problems as warnings and in typeProblems', async () => {
    await fs.writeFile(join(root, 'entities/types.yaml'), [
      '- id: character',
      '  label: Hijacked',
      ''
    ].join('\n'));

    const snapshot = await service.getSnapshot(root);
    expect(snapshot.typeProblems?.map(problem => problem.code)).toEqual(['reserved-id']);
    const warning = snapshot.diagnostics.find(diagnostic => diagnostic.source === 'entity-types');
    expect(warning?.severity).toBe('warning');
    // The built-in character type is never overridden.
    expect(snapshot.effectiveEntityTypes?.filter(type => type.id === 'character')).toHaveLength(1);
    expect(snapshot.effectiveEntityTypes?.find(type => type.id === 'character')?.origin).toBe('built-in');
  });
});
