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
import { FileUri } from '@theia/core/lib/common/file-uri';
import { NodeAiModeRegistryService } from './node-domain-knowledge-service';

const SCRATCH_BASE = process.env.CLAUDE_SCRATCHPAD_DIR
  || '/private/tmp/claude-501/-Users-vedmalex-work-ai-editor-3/8a15f000-cd38-4649-8fe4-b479e61f41c1/scratchpad/domain-services-test';

async function makeRoot(): Promise<string> {
  await fs.mkdir(SCRATCH_BASE.startsWith('/') ? SCRATCH_BASE : tmpdir(), { recursive: true });
  return fs.mkdtemp(join(SCRATCH_BASE.startsWith('/') ? SCRATCH_BASE : tmpdir(), 'afe-domain-'));
}

describe('NodeAiModeRegistryService', () => {
  let root: string;
  let service: NodeAiModeRegistryService;

  beforeEach(async () => {
    root = await makeRoot();
    service = new NodeAiModeRegistryService();
    // Isolate the bundled/global layers so these book-focused assertions see the
    // book layer only; layering is exercised in the dedicated describe below.
    service.configureModeSources({
      bundledModesPath: join(root, '__no_such_bundled__.yaml'),
      globalModesPath: join(root, '__no_such_global__.yaml')
    });
    await fs.mkdir(join(root, 'ai/prompts'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  test('returns an info diagnostic when no workspace is open', async () => {
    const snapshot = await service.getSnapshot(undefined);
    expect(snapshot.modes).toEqual([]);
    expect(snapshot.diagnostics[0].message).toBe('Open a manuscript workspace to load project AI modes.');
  });

  test('parses valid modes and reports duplicate and invalid entries', async () => {
    await fs.writeFile(join(root, 'ai/prompts/custom-modes.yaml'), [
      'modes:',
      '  - id: improve-selection',
      '    label: Improve',
      '    description: Improve the selection',
      '    systemPrompt: You improve text.',
      '    userPrompt: Improve this.',
      '    parameters:',
      '      temperature: 0.5',
      '  - id: legacy',
      '    prompt: Legacy prompt as systemPrompt',
      '  - id: improve-selection',
      '    systemPrompt: Duplicate',
      '  - label: no-id',
      '    systemPrompt: Missing id',
      ''
    ].join('\n'));

    const snapshot = await service.getSnapshot(root);
    expect(snapshot.modes.map(mode => mode.id)).toEqual(['improve-selection', 'legacy']);

    const improve = snapshot.modes[0];
    expect(improve.label).toBe('Improve');
    expect(improve.systemPrompt).toBe('You improve text.');
    expect(improve.userPrompt).toBe('Improve this.');
    expect(improve.parameters).toEqual({ temperature: 0.5 });

    const legacy = snapshot.modes[1];
    expect(legacy.label).toBe('legacy');
    expect(legacy.systemPrompt).toBe('Legacy prompt as systemPrompt');

    const warnings = snapshot.diagnostics.filter(diagnostic => diagnostic.severity === 'warning');
    expect(warnings.some(diagnostic => diagnostic.message.includes('duplicate AI mode id: improve-selection'))).toBe(true);
    expect(warnings.some(diagnostic => diagnostic.message.includes('id and systemPrompt are required'))).toBe(true);
    expect(snapshot.sourceUri.endsWith('ai/prompts/custom-modes.yaml')).toBe(true);
  });

  test('emits an info diagnostic when the modes file is absent', async () => {
    const snapshot = await service.getSnapshot(root);
    expect(snapshot.modes).toEqual([]);
    expect(snapshot.diagnostics[0].message).toContain('No project AI modes file found');
    expect(snapshot.diagnostics[0].severity).toBe('info');
  });

  test('emits an error diagnostic for malformed modes YAML', async () => {
    await fs.writeFile(join(root, 'ai/prompts/custom-modes.yaml'), 'modes:\n  - id: a\n : : :\n');
    const snapshot = await service.getSnapshot(root);
    expect(snapshot.diagnostics[0].severity).toBe('error');
    expect(snapshot.diagnostics[0].message).toContain('Invalid AI modes YAML');
  });

  test('warns when the modes file has no modes list', async () => {
    await fs.writeFile(join(root, 'ai/prompts/custom-modes.yaml'), 'modes: 5\n');
    const snapshot = await service.getSnapshot(root);
    const warning = snapshot.diagnostics.find(diagnostic => diagnostic.message.includes('must contain a modes list'));
    expect(warning?.severity).toBe('warning');
  });

  test('defaults context to chat, menu/agent to false and apply to chat', async () => {
    await fs.writeFile(join(root, 'ai/prompts/custom-modes.yaml'), [
      'modes:',
      '  - id: plain',
      '    systemPrompt: Do a thing.',
      ''
    ].join('\n'));

    const snapshot = await service.getSnapshot(root);
    const plain = snapshot.modes[0];
    expect(plain.context).toBe('chat');
    expect(plain.menu).toBe(false);
    expect(plain.agent).toBe(false);
    expect(plain.apply).toBe('chat');
    expect(plain.icon).toBeUndefined();
    expect(snapshot.diagnostics.filter(diagnostic => diagnostic.severity === 'warning')).toEqual([]);
  });

  test('defaults apply to replace for selection modes and parses menu/icon', async () => {
    await fs.writeFile(join(root, 'ai/prompts/custom-modes.yaml'), [
      'modes:',
      '  - id: rewrite',
      '    label: Rewrite',
      '    systemPrompt: Rewrite the selection.',
      '    context: selection',
      '    menu: true',
      '    icon: sparkle',
      ''
    ].join('\n'));

    const snapshot = await service.getSnapshot(root);
    const rewrite = snapshot.modes[0];
    expect(rewrite.context).toBe('selection');
    expect(rewrite.menu).toBe(true);
    expect(rewrite.apply).toBe('replace');
    expect(rewrite.icon).toBe('sparkle');
  });

  test('honours an explicit insert apply for word modes', async () => {
    await fs.writeFile(join(root, 'ai/prompts/custom-modes.yaml'), [
      'modes:',
      '  - id: define',
      '    systemPrompt: Define the word.',
      '    context: word',
      '    apply: insert',
      ''
    ].join('\n'));

    const snapshot = await service.getSnapshot(root);
    expect(snapshot.modes[0].apply).toBe('insert');
  });

  test('warns and defaults on an unknown context value', async () => {
    await fs.writeFile(join(root, 'ai/prompts/custom-modes.yaml'), [
      'modes:',
      '  - id: weird',
      '    systemPrompt: Prompt.',
      '    context: paragraph',
      ''
    ].join('\n'));

    const snapshot = await service.getSnapshot(root);
    expect(snapshot.modes[0].context).toBe('chat');
    const warning = snapshot.diagnostics.find(diagnostic => diagnostic.message.includes('unknown context "paragraph"'));
    expect(warning?.severity).toBe('warning');
  });

  test('warns and defaults on an unknown apply value', async () => {
    await fs.writeFile(join(root, 'ai/prompts/custom-modes.yaml'), [
      'modes:',
      '  - id: weird-apply',
      '    systemPrompt: Prompt.',
      '    context: selection',
      '    apply: overwrite',
      ''
    ].join('\n'));

    const snapshot = await service.getSnapshot(root);
    // Falls back to the selection default.
    expect(snapshot.modes[0].apply).toBe('replace');
    const warning = snapshot.diagnostics.find(diagnostic => diagnostic.message.includes('unknown apply "overwrite"'));
    expect(warning?.severity).toBe('warning');
  });

  test('warns when replace/insert is used with a non-editable context and falls back to chat', async () => {
    await fs.writeFile(join(root, 'ai/prompts/custom-modes.yaml'), [
      'modes:',
      '  - id: chapter-replace',
      '    systemPrompt: Prompt.',
      '    context: chapter',
      '    apply: replace',
      ''
    ].join('\n'));

    const snapshot = await service.getSnapshot(root);
    expect(snapshot.modes[0].apply).toBe('chat');
    const warning = snapshot.diagnostics.find(diagnostic =>
      diagnostic.message.includes('only selection/word modes can replace or insert'));
    expect(warning?.severity).toBe('warning');
  });

  test('parses the agent flag and ignores a non-boolean menu value', async () => {
    await fs.writeFile(join(root, 'ai/prompts/custom-modes.yaml'), [
      'modes:',
      '  - id: lore',
      '    systemPrompt: Answer world questions.',
      '    agent: true',
      '    menu: yes-please',
      ''
    ].join('\n'));

    const snapshot = await service.getSnapshot(root);
    const lore = snapshot.modes[0];
    expect(lore.agent).toBe(true);
    // A non-boolean menu value is treated as false rather than truthy.
    expect(lore.menu).toBe(false);
  });

  test('parses enabled:false and hides the mode from the consumer list', async () => {
    await fs.writeFile(join(root, 'ai/prompts/custom-modes.yaml'), [
      'modes:',
      '  - id: shown',
      '    systemPrompt: Visible.',
      '  - id: hidden',
      '    systemPrompt: Hidden.',
      '    enabled: false',
      ''
    ].join('\n'));

    const snapshot = await service.getSnapshot(root);
    // Consumer list excludes the disabled mode...
    expect(snapshot.modes.map(mode => mode.id)).toEqual(['shown']);
    // ...but the full resolution still carries it (for the form editor).
    expect(snapshot.resolved?.map(mode => mode.id)).toEqual(['shown', 'hidden']);
    expect(snapshot.resolved?.find(mode => mode.id === 'hidden')?.enabled).toBe(false);
    expect(snapshot.resolved?.every(mode => mode.origin === 'book')).toBe(true);
  });

  describe('three-layer merge (bundled/global/book)', () => {
    let bundledPath: string;
    let globalPath: string;

    beforeEach(async () => {
      bundledPath = join(root, 'fixtures/base-modes.yaml');
      globalPath = join(root, 'fixtures/global-modes.yaml');
      await fs.mkdir(join(root, 'fixtures'), { recursive: true });
      service.configureModeSources({ bundledModesPath: bundledPath, globalModesPath: globalPath });
    });

    test('resolves base + global + book with precedence book > global > bundled', async () => {
      await fs.writeFile(bundledPath, [
        'modes:',
        '  - id: base-only',
        '    label: Base Only',
        '    systemPrompt: base prompt',
        '  - id: shared',
        '    label: Base Shared',
        '    systemPrompt: base shared prompt',
        ''
      ].join('\n'));
      await fs.writeFile(globalPath, [
        'modes:',
        '  - id: global-only',
        '    label: Global Only',
        '    systemPrompt: global prompt',
        '  - id: shared',
        '    label: Global Shared',
        '    systemPrompt: global shared prompt',
        ''
      ].join('\n'));
      await fs.writeFile(join(root, 'ai/prompts/custom-modes.yaml'), [
        'modes:',
        '  - id: book-only',
        '    label: Book Only',
        '    systemPrompt: book prompt',
        '  - id: shared',
        '    label: Book Shared',
        '    systemPrompt: book shared prompt',
        ''
      ].join('\n'));

      const snapshot = await service.getSnapshot(root);
      const byId = new Map(snapshot.resolved!.map(mode => [mode.id, mode]));
      expect(byId.get('base-only')?.origin).toBe('built-in');
      expect(byId.get('global-only')?.origin).toBe('global');
      expect(byId.get('book-only')?.origin).toBe('book');

      const shared = byId.get('shared')!;
      expect(shared.origin).toBe('book');
      expect(shared.label).toBe('Book Shared');
      expect(shared.systemPrompt).toBe('book shared prompt');
      expect(shared.overrides).toBe('global');
    });

    test('a book enabled:false override hides a bundled base mode', async () => {
      await fs.writeFile(bundledPath, [
        'modes:',
        '  - id: base-mode',
        '    systemPrompt: base prompt',
        ''
      ].join('\n'));
      await fs.writeFile(join(root, 'ai/prompts/custom-modes.yaml'), [
        'modes:',
        '  - id: base-mode',
        '    systemPrompt: base prompt',
        '    enabled: false',
        ''
      ].join('\n'));

      const snapshot = await service.getSnapshot(root);
      expect(snapshot.modes.map(mode => mode.id)).toEqual([]);
      const resolved = snapshot.resolved!.find(mode => mode.id === 'base-mode')!;
      expect(resolved.enabled).toBe(false);
      expect(resolved.origin).toBe('book');
      expect(resolved.overrides).toBe('built-in');
    });

    test('exposes globalUri and watchUris (book + global, no bundled)', async () => {
      await fs.writeFile(bundledPath, 'modes: []\n');
      const snapshot = await service.getSnapshot(root);
      expect(snapshot.globalUri).toBe(FileUri.create(globalPath).toString());
      expect(snapshot.watchUris).toContain(snapshot.sourceUri!);
      expect(snapshot.watchUris).toContain(snapshot.globalUri!);
      expect(snapshot.watchUris).not.toContain(FileUri.create(bundledPath).toString());
    });

    test('the bundled base-modes.yaml shipped in the repo parses cleanly', async () => {
      const shipped = new NodeAiModeRegistryService();
      shipped.configureModeSources({ globalModesPath: join(root, '__none__.yaml') });
      const snapshot = await shipped.getSnapshot(root);
      const builtIns = snapshot.resolved!.filter(mode => mode.origin === 'built-in');
      // The bundled file ships several base modes and must load without errors.
      expect(builtIns.length).toBeGreaterThan(0);
      expect(snapshot.diagnostics.filter(diagnostic => diagnostic.severity === 'error')).toEqual([]);
    });
  });
});
