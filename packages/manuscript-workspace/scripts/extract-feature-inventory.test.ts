import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { computeSourceFingerprint } from '../src/node/docs/source-scan';

/**
 * Fixture trees and extractor output live in the OS temp directory, never in the
 * working tree: a test that leaves an artefact behind shows up in `git status`,
 * misleads the next reader and invites an accidental commit.
 */
const TEST_ROOT = join(tmpdir(), 'afe-extract-inventory-test');

const SCRIPT_PATH = join(import.meta.dir, 'extract-feature-inventory.mjs');

/** Keeps concurrent runs from overwriting each other's output file. */
let outCounter = 0;

/** …/packages/manuscript-workspace/scripts → the repository root. */
const REPO_ROOT = join(import.meta.dir, '../../..');

const PACKAGE_SOURCE_DIRS = [
  'packages/manuscript-workspace/src',
  'packages/ai-connect-theia/src',
  'packages/document-preview-theia/src'
];

/** Where a fixture's own sources go, so a test never depends on the real tree. */
const FIXTURE_SOURCE_DIR = 'packages/manuscript-workspace/src/browser';

/** The obligatory entity source every fixture writes (§3 WP-U3-0, R2). */
const BASE_MODES_RELATIVE_PATH = 'packages/manuscript-workspace/src/node/ai/base-modes.yaml';

interface Inventory {
  version: number;
  sourceFingerprint: string;
  packages: string[];
  namespaces: string[];
  commands: { id: string; file: string; line: number; kind: string }[];
  preferences: { key: string; file: string; line: number; schema?: string }[];
  skipped: { why: string; file: string; line: number; text: string; staticPrefix?: string }[];
  dynamicPrefixes: string[];
  codeReferencedIds: string[];
  promptFragments: { kind: string; id: string; name?: string; description?: string; file: string; line: number }[];
  agents: { kind: string; id: string; label: string; description: string; file: string; modeId: string }[];
  skills: { kind: string; id: string; name: string; description: string; file: string }[];
  entityDynamicPrefixes: string[];
}

interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
  inventory?: Inventory;
}

async function write(repoRoot: string, relativePath: string, contents: string): Promise<void> {
  const absolutePath = join(repoRoot, relativePath);
  await fs.mkdir(join(absolutePath, '..'), { recursive: true });
  await fs.writeFile(absolutePath, contents, 'utf8');
}

/**
 * A self-contained repository holding all three declared roots and nothing
 * else.
 *
 * Every rule test runs against a fixture whose entire inventory it declares
 * itself. A rule verified against the real tree would silently change meaning
 * whenever the product changes — the only assertions aimed at the real tree
 * here are the CONTROL NUMBERS, where that coupling is the point.
 */
async function makeRepo(name: string): Promise<string> {
  const repoRoot = join(TEST_ROOT, name);
  await fs.rm(repoRoot, { recursive: true, force: true });
  for (const dir of PACKAGE_SOURCE_DIRS) {
    await fs.mkdir(join(repoRoot, dir), { recursive: true });
  }
  await fs.writeFile(
    join(repoRoot, 'package.json'),
    JSON.stringify({ name: 'fixture-repo', workspaces: ['packages/*'] }, null, 2),
    'utf8'
  );
  // The obligatory entity source (§3 WP-U3-0, R2): without it the fingerprint
  // rejects. Agent/skill tests overwrite it (or add SKILL.md files) as needed.
  await write(repoRoot, BASE_MODES_RELATIVE_PATH, 'version: 1\nmodes: []\n');
  return repoRoot;
}

/** Runs the real entry point as a subprocess — the same way the build does. */
async function runExtractor(repoRoot: string): Promise<Run> {
  // Never `join(repoRoot, …)`: for the real-tree control-number tests repoRoot IS
  // the repository, and the run would drop an untracked inventory.json in its root.
  const outPath = join(TEST_ROOT, `inventory-${outCounter++}.json`);
  const child = Bun.spawn(['bun', SCRIPT_PATH, `--repo-root=${repoRoot}`, `--out=${outPath}`], {
    stdout: 'pipe',
    stderr: 'pipe'
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited
  ]);
  let inventory: Inventory | undefined;
  try {
    inventory = JSON.parse(await fs.readFile(outPath, 'utf8')) as Inventory;
  } catch {
    inventory = undefined;
  }
  return { exitCode, stdout, stderr, inventory };
}

/** Extracts a fixture and asserts it succeeded, returning the inventory. */
async function extract(repoRoot: string): Promise<Inventory> {
  const run = await runExtractor(repoRoot);
  expect(run.stderr).toBe('');
  expect(run.exitCode).toBe(0);
  return run.inventory!;
}

function ids(inventory: Inventory): string[] {
  return inventory.commands.map(command => command.id);
}

beforeEach(async () => {
  await fs.mkdir(TEST_ROOT, { recursive: true });
});

afterEach(async () => {
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

describe('command extraction (§C.2)', () => {
  test('collects ids from both product namespaces', async () => {
    const repoRoot = await makeRepo('namespaces');
    await write(
      repoRoot,
      `${FIXTURE_SOURCE_DIR}/commands.ts`,
      `import { Command } from '@theia/core';
export const A: Command = { id: 'ai-focused-editor.book.newBook', label: 'New' };
export const B: Command = { id: 'ai-focused-editor.book.export', label: 'Export' };
export const C: Command = { id: 'ai-connect.usage.show', label: 'Usage' };
`
    );

    const inventory = await extract(repoRoot);
    expect(ids(inventory)).toEqual([
      'ai-connect.usage.show',
      'ai-focused-editor.book.export',
      'ai-focused-editor.book.newBook'
    ]);
    expect(inventory.namespaces).toEqual(['ai-focused-editor.', 'ai-connect.']);
  });

  test('neg: the namespace filter keeps out ids that are not ours (ФАКТ-ПОПРАВКА П1)', async () => {
    const repoRoot = await makeRepo('namespace-filter');
    await write(
      repoRoot,
      `${FIXTURE_SOURCE_DIR}/noise.ts`,
      `import { Command } from '@theia/core';
// Capability presets, bundled colour-theme ids and a placeholder — the three
// real shapes that a filter-free rule drags into the inventory.
export const PRESETS = [{ id: 'minimum' }, { id: 'book-world' }, { id: 'everything' }];
export const THEMES = [{ id: 'ai-focused-editor-dark' }, { id: 'light-plus' }];
export const PLACEHOLDER = { id: '' };
export const REAL: Command = { id: 'ai-focused-editor.book.newBook', label: 'New' };
`
    );

    const inventory = await extract(repoRoot);
    expect(ids(inventory)).toEqual(['ai-focused-editor.book.newBook']);
  });

  test('an id given as a resolvable const lands in commands, not in skipped (§C.6)', async () => {
    const repoRoot = await makeRepo('resolvable-const');
    await write(
      repoRoot,
      `${FIXTURE_SOURCE_DIR}/doctor.ts`,
      `import { Command } from '@theia/core';
const BOOK_DOCTOR_COMMAND_ID = 'ai-focused-editor.book.doctor';
export const BOOK_DOCTOR_COMMAND = Command.toLocalizedCommand(
  { id: BOOK_DOCTOR_COMMAND_ID, label: 'Doctor' },
  'ai-focused-editor/book/doctor'
);
`
    );

    const inventory = await extract(repoRoot);
    expect(inventory.commands).toEqual([
      {
        id: 'ai-focused-editor.book.doctor',
        file: 'packages/manuscript-workspace/src/browser/doctor.ts',
        line: 4,
        kind: 'command'
      }
    ]);
    expect(inventory.skipped).toEqual([]);
  });

  test('resolves an id const imported from another file (§C.3 step 2)', async () => {
    const repoRoot = await makeRepo('imported-id-const');
    await write(
      repoRoot,
      `${FIXTURE_SOURCE_DIR}/ids.ts`,
      `export const SHARED_COMMAND_ID = 'ai-focused-editor.shared.run';
`
    );
    await write(
      repoRoot,
      `${FIXTURE_SOURCE_DIR}/uses-ids.ts`,
      `import { Command } from '@theia/core';
import { SHARED_COMMAND_ID } from './ids';
export const SHARED: Command = { id: SHARED_COMMAND_ID, label: 'Shared' };
`
    );

    const inventory = await extract(repoRoot);
    expect(ids(inventory)).toEqual(['ai-focused-editor.shared.run']);
  });
});

describe('ancestry classification — the three branches (§C.2)', () => {
  test('branch 1: an object literal passed straight to a declaration call', async () => {
    const repoRoot = await makeRepo('branch-1');
    await write(
      repoRoot,
      `${FIXTURE_SOURCE_DIR}/branch1.ts`,
      `import { Command } from '@theia/core';
export const VIA_LOCALIZED = Command.toLocalizedCommand({ id: 'ai-focused-editor.a', label: 'A' }, 'k');
export const VIA_DEFAULT = Command.toDefaultLocalizedCommand({ id: 'ai-focused-editor.b', label: 'B' }, 'k');
export class Contribution {
  registerCommands(registry: unknown): void {
    // Any receiver — the predicate keys on the member name, not on a variable
    // named \`commandRegistry\`.
    (registry as any).registerCommand({ id: 'ai-focused-editor.c', label: 'C' }, { execute: () => 0 });
  }
}
`
    );

    const inventory = await extract(repoRoot);
    expect(inventory.commands.map(command => [command.id, command.kind])).toEqual([
      ['ai-focused-editor.a', 'command'],
      ['ai-focused-editor.b', 'command'],
      ['ai-focused-editor.c', 'command']
    ]);
  });

  test('branch 2: assigned to a variable annotated `: Command`', async () => {
    const repoRoot = await makeRepo('branch-2');
    await write(
      repoRoot,
      `${FIXTURE_SOURCE_DIR}/branch2.ts`,
      `import { Command } from '@theia/core';
export function build(label: string): Command {
  const command: Command = { id: 'ai-focused-editor.mode.run.fixed', label };
  return command;
}
`
    );

    const inventory = await extract(repoRoot);
    expect(inventory.commands.map(command => [command.id, command.kind])).toEqual([
      ['ai-focused-editor.mode.run.fixed', 'command']
    ]);
  });

  test('branch 3: unannotated variable, registered by identifier in the same file (F-D6-6)', async () => {
    const repoRoot = await makeRepo('branch-3');
    await write(
      repoRoot,
      `${FIXTURE_SOURCE_DIR}/branch3.ts`,
      `export class Contribution {
  registerCommands(registry: any): void {
    const c = { id: 'ai-focused-editor.z', label: 'Z' };
    registry.registerCommand(c, { execute: () => 0 });
  }
}
`
    );

    const inventory = await extract(repoRoot);
    expect(inventory.commands.map(command => [command.id, command.kind])).toEqual([
      ['ai-focused-editor.z', 'command']
    ]);
  });

  test('neg: an id in a plain config object is unclassified, not a command', async () => {
    const repoRoot = await makeRepo('unclassified');
    await write(
      repoRoot,
      `${FIXTURE_SOURCE_DIR}/factory.ts`,
      `export const ROOT = { id: 'ai-focused-editor.manuscript-tree.root', name: 'Manuscript' };
`
    );

    const inventory = await extract(repoRoot);
    expect(inventory.commands.map(command => [command.id, command.kind])).toEqual([
      ['ai-focused-editor.manuscript-tree.root', 'unclassified']
    ]);
  });
});

describe('visibility of what could not be extracted (§C.6)', () => {
  test('a template-literal id inside a registered command is skipped, not dropped (F-D5-2)', async () => {
    const repoRoot = await makeRepo('template-id');
    // The `id:` line carries NO namespace substring — deliberately the shape of
    // `ai-mode-dynamic-contribution.ts:206`. A substring-based filter reports
    // nothing here and the report's skipped section looks clean while being blind.
    await write(
      repoRoot,
      `${FIXTURE_SOURCE_DIR}/dynamic.ts`,
      `import { Command } from '@theia/core';
const MODE_RUN_COMMAND_PREFIX = 'ai-focused-editor.mode.run.';
export class Contribution {
  refresh(registry: any, modes: { id: string; label: string }[]): void {
    for (const mode of modes) {
      const commandId = \`\${MODE_RUN_COMMAND_PREFIX}\${mode.id}\`;
      const command: Command = { id: commandId, label: mode.label };
      registry.registerCommand(command, { execute: () => 0 });
    }
  }
}
`
    );

    const inventory = await extract(repoRoot);
    expect(inventory.commands).toEqual([]);
    expect(inventory.skipped).toEqual([
      {
        why: 'template-literal-id',
        file: 'packages/manuscript-workspace/src/browser/dynamic.ts',
        line: 7,
        text: 'id: commandId',
        staticPrefix: 'ai-focused-editor.mode.run.'
      }
    ]);
    expect(inventory.dynamicPrefixes).toEqual(['ai-focused-editor.mode.run.']);
  });

  test('the leading static run is derived through the §C.3 resolver', async () => {
    const repoRoot = await makeRepo('static-prefix');
    await write(
      repoRoot,
      `${FIXTURE_SOURCE_DIR}/prefixes.ts`,
      `import { Command } from '@theia/core';
const P = 'ai-focused-editor.family.';
export function build(x: string, y: string): void {
  const inline: Command = { id: \`\${P}\${x}\`, label: x };
  const concatenated: Command = { id: P + y, label: y };
  void inline;
  void concatenated;
}
`
    );

    const inventory = await extract(repoRoot);
    expect(inventory.skipped.map(entry => [entry.why, entry.staticPrefix])).toEqual([
      ['template-literal-id', 'ai-focused-editor.family.'],
      ['concatenated-id', 'ai-focused-editor.family.']
    ]);
    expect(inventory.dynamicPrefixes).toEqual(['ai-focused-editor.family.']);
  });

  test('an unresolvable leading part still yields a skipped entry, and does not fail the run', async () => {
    const repoRoot = await makeRepo('unresolvable-prefix');
    await write(
      repoRoot,
      `${FIXTURE_SOURCE_DIR}/opaque.ts`,
      `import { Command } from '@theia/core';
export function build(base: { prefix: string }, x: string): void {
  const command: Command = { id: \`\${base.prefix}\${x}\`, label: x };
  void command;
}
`
    );

    const inventory = await extract(repoRoot);
    expect(inventory.skipped).toHaveLength(1);
    expect(inventory.skipped[0].why).toBe('template-literal-id');
    expect(inventory.skipped[0]).not.toHaveProperty('staticPrefix');
    expect(inventory.dynamicPrefixes).toEqual([]);
  });

  test('neg: a non-literal id outside a command position is silent — no commands, no skipped', async () => {
    const repoRoot = await makeRepo('quiet-noise');
    await write(
      repoRoot,
      `${FIXTURE_SOURCE_DIR}/config.ts`,
      `export function build(someVar: string): unknown {
  return { id: someVar, kind: 'tree-node' };
}
`
    );

    const inventory = await extract(repoRoot);
    expect(inventory.commands).toEqual([]);
    expect(inventory.skipped).toEqual([]);
  });

  test('a bare command-like const is not a property assignment, so it is not skipped (П6)', async () => {
    const repoRoot = await makeRepo('bare-const');
    await write(
      repoRoot,
      `${FIXTURE_SOURCE_DIR}/log-labels.ts`,
      `const PROOFREAD_COMMAND_ID = 'ai-focused-editor.transcript.proofread';
export function record(log: any): void {
  log.createRecorder(PROOFREAD_COMMAND_ID);
}
`
    );

    const inventory = await extract(repoRoot);
    expect(inventory.commands).toEqual([]);
    expect(inventory.skipped).toEqual([]);
  });
});

describe('preferences (§C.3)', () => {
  test('extracts keys from string-literal and locally computed names', async () => {
    const repoRoot = await makeRepo('preferences-local');
    await write(
      repoRoot,
      `${FIXTURE_SOURCE_DIR}/prefs.ts`,
      `import { PreferenceSchema } from '@theia/core/lib/common/preferences';
export const WELCOME = 'aiFocusedEditor.welcome.showOnStartup';
export const schema: PreferenceSchema = {
  title: 'AI Focused Editor',
  properties: {
    [WELCOME]: { type: 'boolean', default: true },
    'aiFocusedEditor.library.path': { type: 'string', default: '' }
  }
};
`
    );

    const inventory = await extract(repoRoot);
    expect(inventory.preferences).toEqual([
      {
        key: 'aiFocusedEditor.library.path',
        file: 'packages/manuscript-workspace/src/browser/prefs.ts',
        line: 7,
        schema: 'schema'
      },
      {
        key: 'aiFocusedEditor.welcome.showOnStartup',
        file: 'packages/manuscript-workspace/src/browser/prefs.ts',
        line: 6,
        schema: 'schema'
      }
    ]);
  });

  test('resolves a computed key whose const is IMPORTED (ФАКТ-ПОПРАВКА П3)', async () => {
    const repoRoot = await makeRepo('preferences-imported');
    await write(
      repoRoot,
      `${FIXTURE_SOURCE_DIR}/live-validation-contribution.ts`,
      `export const LIVE_VALIDATION_PREFERENCE = 'aiFocusedEditor.validation.live';
`
    );
    await write(
      repoRoot,
      `${FIXTURE_SOURCE_DIR}/live-validation-frontend-module.ts`,
      `import { PreferenceSchema } from '@theia/core/lib/common/preferences';
import { LIVE_VALIDATION_PREFERENCE } from './live-validation-contribution';
const liveValidationPreferenceSchema: PreferenceSchema = {
  title: 'AI Focused Editor',
  properties: {
    [LIVE_VALIDATION_PREFERENCE]: { type: 'boolean', default: true }
  }
};
export default liveValidationPreferenceSchema;
`
    );

    const inventory = await extract(repoRoot);
    expect(inventory.preferences.map(preference => preference.key)).toEqual([
      'aiFocusedEditor.validation.live'
    ]);
    expect(inventory.preferences[0].schema).toBe('liveValidationPreferenceSchema');
  });

  test('neg: a const declared but never placed in `properties` is not a preference', async () => {
    const repoRoot = await makeRepo('preferences-legacy');
    await write(
      repoRoot,
      `${FIXTURE_SOURCE_DIR}/prefs.ts`,
      `import { PreferenceSchema } from '@theia/core/lib/common/preferences';
export const LEGACY_API_KEY = 'aiConnect.legacy.apiKey';
export const LEGACY_BASE_URL = 'aiConnect.legacy.baseUrl';
export const ACTIVE = 'aiConnect.provider';
export const schema: PreferenceSchema = {
  title: 'AI Connect',
  properties: {
    [ACTIVE]: { type: 'string', default: '' }
  }
};
`
    );

    const inventory = await extract(repoRoot);
    expect(inventory.preferences.map(preference => preference.key)).toEqual(['aiConnect.provider']);
  });

  test('neg: a computed key resolvable neither locally nor through an import FAILS the run', async () => {
    const repoRoot = await makeRepo('preferences-unresolvable');
    await write(
      repoRoot,
      `${FIXTURE_SOURCE_DIR}/prefs.ts`,
      `import { PreferenceSchema } from '@theia/core/lib/common/preferences';
import { EXTERNAL_KEY } from '@somewhere/else';
export const schema: PreferenceSchema = {
  title: 'AI Focused Editor',
  properties: {
    [EXTERNAL_KEY]: { type: 'boolean', default: true }
  }
};
`
    );

    const run = await runExtractor(repoRoot);
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain('docs-inventory: unresolvable preference key');
    expect(run.stderr).toContain('packages/manuscript-workspace/src/browser/prefs.ts:6');
    expect(run.inventory).toBeUndefined();
  });

  test('poz: the same schema with the key resolvable succeeds — the failure is the defect, not the fixture', async () => {
    const repoRoot = await makeRepo('preferences-unresolvable-fixed');
    await write(
      repoRoot,
      `${FIXTURE_SOURCE_DIR}/prefs.ts`,
      `import { PreferenceSchema } from '@theia/core/lib/common/preferences';
const EXTERNAL_KEY = 'aiFocusedEditor.validation.live';
export const schema: PreferenceSchema = {
  title: 'AI Focused Editor',
  properties: {
    [EXTERNAL_KEY]: { type: 'boolean', default: true }
  }
};
`
    );

    const inventory = await extract(repoRoot);
    expect(inventory.preferences.map(preference => preference.key)).toEqual([
      'aiFocusedEditor.validation.live'
    ]);
  });

  test('neg: a spread inside `properties` FAILS rather than hiding an unknown number of keys', async () => {
    const repoRoot = await makeRepo('preferences-spread');
    await write(
      repoRoot,
      `${FIXTURE_SOURCE_DIR}/prefs.ts`,
      `import { PreferenceSchema } from '@theia/core/lib/common/preferences';
const SHARED = { 'aiFocusedEditor.hidden': { type: 'boolean' } };
export const schema: PreferenceSchema = {
  title: 'AI Focused Editor',
  properties: {
    ...SHARED
  }
};
`
    );

    const run = await runExtractor(repoRoot);
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain('docs-inventory: unextractable preference key');
  });
});

describe('foreign ids called from code (§C.8)', () => {
  test('found through ANY receiver and through a resolvable const (F-D8-2)', async () => {
    const repoRoot = await makeRepo('code-referenced');
    // Deliberately the shape of `mcp-controls-contribution.ts:349-360`: the
    // receiver is `this.commands`, not `commandRegistry`, and both arguments
    // are consts rather than inline literals. A predicate keyed on the receiver
    // name — or one that only reads string literals — returns nothing here, and
    // `codeReferencedIds` ships empty.
    await write(
      repoRoot,
      `${FIXTURE_SOURCE_DIR}/mcp-controls-contribution.ts`,
      `const OPEN_PREFERENCES_COMMAND_ID = 'preferences:open';
const OPEN_USER_PREFERENCES_COMMAND_ID = 'workbench.action.openGlobalSettings';
const MCP_PREFERENCE_QUERY = 'ai-features.mcp';
export class Contribution {
  protected commands: any;
  protected async openSettings(): Promise<void> {
    if (this.commands.getCommand(OPEN_PREFERENCES_COMMAND_ID)) {
      await this.commands.executeCommand(OPEN_PREFERENCES_COMMAND_ID, MCP_PREFERENCE_QUERY);
      return;
    }
    if (this.commands.isEnabled(OPEN_USER_PREFERENCES_COMMAND_ID)) {
      await this.commands.executeCommand(OPEN_USER_PREFERENCES_COMMAND_ID);
    }
  }
}
`
    );

    const inventory = await extract(repoRoot);
    expect(inventory.codeReferencedIds).toEqual([
      'preferences:open',
      'workbench.action.openGlobalSettings'
    ]);
  });

  test('neg: our OWN ids are not "foreign" and stay out of the set', async () => {
    const repoRoot = await makeRepo('code-referenced-own');
    await write(
      repoRoot,
      `${FIXTURE_SOURCE_DIR}/caller.ts`,
      `export class Contribution {
  protected commands: any;
  run(): void {
    this.commands.executeCommand('ai-focused-editor.book.newBook');
    this.commands.executeCommand('some.foreign.command');
  }
}
`
    );

    const inventory = await extract(repoRoot);
    expect(inventory.codeReferencedIds).toEqual(['some.foreign.command']);
  });

  test('neg: an unrelated call with the same first argument is not a command reference', async () => {
    const repoRoot = await makeRepo('code-referenced-noise');
    await write(
      repoRoot,
      `${FIXTURE_SOURCE_DIR}/noise.ts`,
      `export class Contribution {
  protected logger: any;
  run(): void {
    this.logger.info('preferences:open');
    this.logger.record({ command: 'workbench.action.openGlobalSettings' });
  }
}
`
    );

    const inventory = await extract(repoRoot);
    expect(inventory.codeReferencedIds).toEqual([]);
  });
});

describe('entity readers — prompt fragments, agents, skills (§3 WP-U3-2/3/4)', () => {
  test('a static prompt fragment lands in promptFragments[] with its resolvable id', async () => {
    const repoRoot = await makeRepo('fragment-static');
    await write(
      repoRoot,
      `${FIXTURE_SOURCE_DIR}/frag.ts`,
      `const FRAGMENT_ID = 'ai-focused-editor.my-fragment';
export class C {
  s: any;
  onStart(): void {
    this.s.addBuiltInPromptFragment({
      id: FRAGMENT_ID,
      name: 'My Fragment',
      description: 'Does a thing',
      template: 'hi'
    });
  }
}
`
    );

    const inventory = await extract(repoRoot);
    expect(inventory.promptFragments).toEqual([
      {
        kind: 'promptFragment',
        id: 'ai-focused-editor.my-fragment',
        name: 'My Fragment',
        description: 'Does a thing',
        file: 'packages/manuscript-workspace/src/browser/frag.ts',
        line: 6
      }
    ]);
  });

  test('DOUBLE-COUNT FIX: a fragment id (even with isCommand:true) lives ONLY in promptFragments[], not commands[]', async () => {
    // The diagram-author shape (§6 F-D2.1-1): `addBuiltInPromptFragment({ id, …,
    // isCommand: true, commandName: 'afe-…' })`. `id` is the PROMPT-FRAGMENT id, not
    // a Theia command id (the slash command is the separate `commandName`), and no
    // `registerCommand` declares it. It must not leak into commands[], or one page's
    // covers claim would satisfy two coverage universes at once.
    const repoRoot = await makeRepo('fragment-not-command');
    await write(
      repoRoot,
      `${FIXTURE_SOURCE_DIR}/frag.ts`,
      `const FRAGMENT_ID = 'ai-focused-editor.dual';
export class C {
  s: any;
  onStart(): void {
    this.s.addBuiltInPromptFragment({
      id: FRAGMENT_ID,
      name: 'Dual',
      template: 'hi',
      isCommand: true,
      commandName: 'afe-dual'
    });
  }
}
`
    );

    const inventory = await extract(repoRoot);
    expect(inventory.promptFragments.map(fragment => fragment.id)).toContain('ai-focused-editor.dual');
    expect(inventory.commands.map(command => command.id)).not.toContain('ai-focused-editor.dual');
  });

  test('name/description that are nls.localize() calls are OMITTED, not failed (§5 п.3)', async () => {
    const repoRoot = await makeRepo('fragment-localized');
    await write(
      repoRoot,
      `${FIXTURE_SOURCE_DIR}/frag.ts`,
      `export class C {
  s: any;
  onStart(): void {
    this.s.addBuiltInPromptFragment({
      id: 'ai-focused-editor.localized',
      name: nls.localize('k', 'X'),
      description: nls.localize('k2', 'Y'),
      template: 't'
    });
  }
}
`
    );

    const inventory = await extract(repoRoot);
    expect(inventory.promptFragments).toEqual([
      {
        kind: 'promptFragment',
        id: 'ai-focused-editor.localized',
        file: 'packages/manuscript-workspace/src/browser/frag.ts',
        line: 5
      }
    ]);
  });

  test('a dynamic prompt fragment (call-expression arg) is skipped and contributes the project-mode prefix (Q1)', async () => {
    const repoRoot = await makeRepo('fragment-dynamic');
    await write(
      repoRoot,
      `${FIXTURE_SOURCE_DIR}/dyn-frag.ts`,
      `export class C {
  s: any;
  sync(modes: any[]): void {
    for (const mode of modes) {
      this.s.addBuiltInPromptFragment(this.toFragment(mode));
    }
  }
  toFragment(mode: any): any { return { id: mode.id }; }
}
`
    );

    const inventory = await extract(repoRoot);
    expect(inventory.promptFragments).toEqual([]);
    expect(inventory.dynamicPrefixes).toContain('ai-focused-editor.project-mode.');
    expect(inventory.skipped.map(entry => [entry.why, entry.staticPrefix])).toContainEqual([
      'call-expression-id',
      'ai-focused-editor.project-mode.'
    ]);
  });

  test('base-modes.yaml: agent:true modes become agents[], agent:false and absent are ignored', async () => {
    const repoRoot = await makeRepo('agents');
    await write(
      repoRoot,
      BASE_MODES_RELATIVE_PATH,
      `version: 1
modes:
  - id: gv-opp
    label: Opponent
    description: Challenges
    agent: true
    systemPrompt: sp1
  - id: gv-plain
    label: Plain
    agent: false
    systemPrompt: sp2
  - id: gv-none
    label: None
    systemPrompt: sp3
`
    );

    const inventory = await extract(repoRoot);
    expect(inventory.agents).toEqual([
      {
        kind: 'agent',
        id: 'ai-focused-editor.mode.gv-opp',
        label: 'Opponent',
        description: 'Challenges',
        file: 'packages/manuscript-workspace/src/node/ai/base-modes.yaml',
        modeId: 'gv-opp'
      }
    ]);
  });

  test('SKILL.md manifests become skills[] keyed by directory', async () => {
    const repoRoot = await makeRepo('skills');
    await write(
      repoRoot,
      '.claude/skills/my-skill/SKILL.md',
      `---
name: my-skill
description: A test skill
---
Body.
`
    );

    const inventory = await extract(repoRoot);
    expect(inventory.skills).toEqual([
      {
        kind: 'skill',
        id: 'skill:my-skill',
        name: 'my-skill',
        description: 'A test skill',
        file: '.claude/skills/my-skill/SKILL.md'
      }
    ]);
  });

  test('the artifact is version 2 with the entity arrays present', async () => {
    const repoRoot = await makeRepo('entity-shape');
    await write(
      repoRoot,
      `${FIXTURE_SOURCE_DIR}/a.ts`,
      `import { Command } from '@theia/core';
export const A: Command = { id: 'ai-focused-editor.a', label: 'A' };
`
    );

    const inventory = await extract(repoRoot);
    expect(inventory.version).toBe(2);
    expect(inventory.promptFragments).toEqual([]);
    expect(inventory.agents).toEqual([]);
    expect(inventory.skills).toEqual([]);
    expect(inventory.entityDynamicPrefixes).toEqual([]);
  });
});

describe('traversal boundary and artifact shape', () => {
  test('a `.test.ts` beside a fixture contributes nothing (§C.1)', async () => {
    const repoRoot = await makeRepo('excluded-tests');
    await write(
      repoRoot,
      `${FIXTURE_SOURCE_DIR}/real.ts`,
      `import { Command } from '@theia/core';
export const REAL: Command = { id: 'ai-focused-editor.real', label: 'Real' };
`
    );
    await write(
      repoRoot,
      `${FIXTURE_SOURCE_DIR}/real.test.ts`,
      `import { Command } from '@theia/core';
export const FROM_TEST: Command = { id: 'ai-focused-editor.from-test', label: 'Test' };
`
    );

    const inventory = await extract(repoRoot);
    expect(ids(inventory)).toEqual(['ai-focused-editor.real']);
  });

  test('the artifact declares version, packages and namespaces (§B.4)', async () => {
    const repoRoot = await makeRepo('artifact-shape');
    await write(
      repoRoot,
      `${FIXTURE_SOURCE_DIR}/a.ts`,
      `import { Command } from '@theia/core';
export const A: Command = { id: 'ai-focused-editor.a', label: 'A' };
`
    );

    const inventory = await extract(repoRoot);
    expect(inventory.version).toBe(2);
    expect(inventory.packages).toEqual([
      'manuscript-workspace',
      'ai-connect-theia',
      'document-preview-theia'
    ]);
    expect(inventory.sourceFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test('a fixture pins its own OWN_PREFIXES inputs — no dependency on the real tree (F-D8-7)', async () => {
    const repoRoot = await makeRepo('own-prefixes');
    await write(
      repoRoot,
      `${FIXTURE_SOURCE_DIR}/all.ts`,
      `import { Command } from '@theia/core';
import { PreferenceSchema } from '@theia/core/lib/common/preferences';
export const A: Command = { id: 'ai-focused-editor.a', label: 'A' };
export const B: Command = { id: 'ai-connect.b', label: 'B' };
export const schema: PreferenceSchema = {
  title: 'T',
  properties: {
    'aiFocusedEditor.one': { type: 'boolean' },
    'aiConnect.two': { type: 'boolean' },
    'mediaTranscription.three': { type: 'string' }
  }
};
`
    );

    const inventory = await extract(repoRoot);
    // The two inputs §4.1.1 derives OWN_PREFIXES from, both fully determined by
    // this fixture: the command namespaces (kebab-case) and the first segment of
    // every preference key (camelCase). The two notations differ, which is why
    // the command namespaces alone are not the whole set.
    expect(inventory.namespaces).toEqual(['ai-focused-editor.', 'ai-connect.']);
    expect([
      ...new Set(inventory.preferences.map(preference => `${preference.key.split('.')[0]}.`))
    ].sort()).toEqual(['aiConnect.', 'aiFocusedEditor.', 'mediaTranscription.']);
  });

  test('output is deterministic — two runs over an untouched tree are byte-identical', async () => {
    const repoRoot = await makeRepo('deterministic');
    await write(
      repoRoot,
      `${FIXTURE_SOURCE_DIR}/z.ts`,
      `import { Command } from '@theia/core';
export const Z: Command = { id: 'ai-focused-editor.z', label: 'Z' };
export const A: Command = { id: 'ai-focused-editor.a', label: 'A' };
`
    );

    const first = await extract(repoRoot);
    const second = await extract(repoRoot);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(ids(first)).toEqual(['ai-focused-editor.a', 'ai-focused-editor.z']);
  });

  test('neg: an unusable repo root is refused with the diagnostic, not guessed at', async () => {
    const repoRoot = await makeRepo('bad-root');
    await fs.rm(join(repoRoot, 'package.json'));

    const run = await runExtractor(repoRoot);
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain('docs-inventory: cannot locate repository root');
    expect(run.stderr).toContain('pass --repo-root');
  });
});

describe('staleness fingerprint (§1.5)', () => {
  test('is stable without edits and moves after one', async () => {
    const repoRoot = await makeRepo('fingerprint');
    const sourcePath = `${FIXTURE_SOURCE_DIR}/a.ts`;
    await write(
      repoRoot,
      sourcePath,
      `import { Command } from '@theia/core';
export const A: Command = { id: 'ai-focused-editor.a', label: 'A' };
`
    );

    const before = (await extract(repoRoot)).sourceFingerprint;
    expect((await extract(repoRoot)).sourceFingerprint).toBe(before);

    await write(
      repoRoot,
      sourcePath,
      `import { Command } from '@theia/core';
export const A: Command = { id: 'ai-focused-editor.a', label: 'Renamed' };
`
    );
    expect((await extract(repoRoot)).sourceFingerprint).not.toBe(before);
  });

  test('is byte-identical to the one the generator computes over the same tree (F-D5-10)', async () => {
    const repoRoot = await makeRepo('shared-walk');
    await write(
      repoRoot,
      `${FIXTURE_SOURCE_DIR}/a.ts`,
      `import { Command } from '@theia/core';
export const A: Command = { id: 'ai-focused-editor.a', label: 'A' };
`
    );
    await write(repoRoot, 'packages/ai-connect-theia/src/b.ts', 'export const B = 1;\n');

    const inventory = await extract(repoRoot);
    // The generator's freshness check calls exactly this function (§1.5). A
    // second glob list in either script would show up right here.
    expect(inventory.sourceFingerprint).toBe(`sha256:${await computeSourceFingerprint(repoRoot)}`);
  });
});

describe('control numbers on the REAL tree (§F.2/§F.9)', () => {
  let cached: Promise<Inventory> | undefined;
  const realInventory = (): Promise<Inventory> => (cached ??= extract(REPO_ROOT));

  test('commands >= 165 and preferences === 22 (§C.2/§C.3)', async () => {
    const inventory = await realInventory();
    expect(inventory.commands.length).toBeGreaterThanOrEqual(165);
    expect(inventory.preferences).toHaveLength(22);
  });

  test('all three packages contribute, and both namespaces are present (П2)', async () => {
    const inventory = await realInventory();
    const packages = new Set(inventory.commands.map(command => command.file.split('/')[1]));
    expect([...packages].sort()).toEqual([
      'ai-connect-theia',
      'document-preview-theia',
      'manuscript-workspace'
    ]);
    expect(inventory.commands.some(command => command.id.startsWith('ai-connect.'))).toBe(true);
  });

  test('two skipped declarations: the dynamic command and the dynamic prompt-fragment site (§C.6, WP-U3-2)', async () => {
    const inventory = await realInventory();
    // Sorted by file then line: `ai-mode-dynamic` precedes `ai-mode-prompt-fragment`.
    // The command line tracks the current source position (the A2 refactor that
    // dropped a local const moved `id: commandId` from 206 to 207).
    expect(inventory.skipped).toEqual([
      {
        why: 'template-literal-id',
        file: 'packages/manuscript-workspace/src/browser/ai-mode-dynamic-contribution.ts',
        line: 207,
        text: 'id: commandId',
        staticPrefix: 'ai-focused-editor.mode.run.'
      },
      {
        why: 'call-expression-id',
        file: 'packages/manuscript-workspace/src/browser/ai-mode-prompt-fragment-contribution.ts',
        line: 78,
        text: 'this.promptService.addBuiltInPromptFragment(this.toPromptFragment(mode))',
        staticPrefix: 'ai-focused-editor.project-mode.'
      }
    ]);
  });

  test('dynamicPrefixes covers both dynamic families — the subject for kind:"dynamic" (F-D7-1, WP-U3-2)', async () => {
    const inventory = await realInventory();
    expect(inventory.dynamicPrefixes).toEqual([
      'ai-focused-editor.mode.run.',
      'ai-focused-editor.project-mode.'
    ]);
  });

  test('codeReferencedIds covers the two Theia settings commands — the subject for usedBy:"code" (§C.8)', async () => {
    const inventory = await realInventory();
    expect(inventory.codeReferencedIds).toEqual(expect.arrayContaining([
      'preferences:open',
      'workbench.action.openGlobalSettings'
    ]));
    // Ours never belong here: the set exists to justify allowlisting FOREIGN ids.
    expect(inventory.codeReferencedIds.some(id => id.startsWith('ai-focused-editor.'))).toBe(false);
  });

  test('every preference key is reported at a real schema, and none is a legacy const', async () => {
    const inventory = await realInventory();
    expect(inventory.preferences.every(preference => !!preference.schema)).toBe(true);
    expect(inventory.preferences.some(preference => preference.key.includes('legacy'))).toBe(false);
    expect(inventory.preferences.map(preference => preference.key)).toContain(
      'aiFocusedEditor.validation.live'
    );
  });

  test('the three entity families are exposed (WP-U3-2/3/4)', async () => {
    const inventory = await realInventory();
    expect(inventory.promptFragments.map(fragment => fragment.id)).toContain(
      'ai-focused-editor.diagram-author'
    );
    expect(inventory.agents.map(agent => agent.id).sort()).toEqual([
      'ai-focused-editor.mode.gv-essay',
      'ai-focused-editor.mode.gv-opponent'
    ]);
    expect(inventory.skills.map(skill => skill.id)).toContain('skill:docs-workflow');
  });

  test('no id from outside our namespaces slipped in (П1)', async () => {
    const inventory = await realInventory();
    const foreign = inventory.commands.filter(
      command =>
        !command.id.startsWith('ai-focused-editor.') && !command.id.startsWith('ai-connect.')
    );
    expect(foreign).toEqual([]);
  });
});
