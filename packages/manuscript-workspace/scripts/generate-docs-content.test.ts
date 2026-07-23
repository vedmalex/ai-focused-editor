/**
 * Teeth of the documentation generator (tech_spec §F.3 + §F.9, WP-2).
 *
 * EVERY rule test runs the real script as a subprocess over a TEMPORARY
 * FIXTURE REPOSITORY that declares its own inventory, its own allowlist and its
 * own request queue (§F.3 preamble, F-D8-7). Nothing here depends on the
 * production `docs/coverage-exceptions.jsonc` or on the real source tree: a
 * rule verified against the real tree changes meaning whenever the product
 * changes, and `OWN_PREFIXES` is DERIVED FROM THE INVENTORY (§4.1.1), so a
 * fixture that pinned only the two exception files would be green or red for
 * reasons unrelated to the rule under test.
 *
 * The only assertions aimed at the real tree are the CONTROL NUMBERS at the
 * bottom, where that coupling is the point — and they are tolerant of growth
 * (`>=`), because the product keeps adding commands while this task runs.
 *
 * Per §F.0 every negative asserts the MESSAGE, not just a non-zero exit code
 * (a script that fails to start also exits non-zero), and every negative has a
 * paired positive on the corrected fixture (a test that fails on every input is
 * as useless as one that never fails).
 */

import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { computeSourceFingerprint } from '../src/node/docs/source-scan';
import { hashSourceRef } from '../src/node/docs/source-refs';

/**
 * Fixture trees and generator output live in the OS temp directory, never in the
 * working tree: a test that leaves an artefact behind shows up in `git status`,
 * misleads the next reader and invites an accidental commit.
 */
const TEST_ROOT = join(tmpdir(), 'generate-docs-content-test');

const SCRIPT_PATH = join(import.meta.dir, 'generate-docs-content.mjs');

/** …/packages/manuscript-workspace/scripts → the repository root. */
const REPO_ROOT = join(import.meta.dir, '../../..');

const PACKAGE_DIR = 'packages/manuscript-workspace';
const CONTENT_DIR = `${PACKAGE_DIR}/src/browser/docs/content`;
const INVENTORY_PATH = `${PACKAGE_DIR}/docs-inventory.generated.json`;
const MODULE_PATH = `${PACKAGE_DIR}/src/browser/docs/docs-content.generated.ts`;

const SOURCE_DIRS = [
  `${PACKAGE_DIR}/src`,
  'packages/ai-connect-theia/src',
  'packages/document-preview-theia/src'
];

interface InventorySpec {
  commands?: string[];
  /** Repeated entries of ONE id — the 173-vs-167 case of the real tree. */
  commandEntries?: { id: string; file?: string; line?: number; kind?: 'command' | 'unclassified' }[];
  preferences?: string[];
  namespaces?: string[];
  dynamicPrefixes?: string[];
  codeReferencedIds?: string[];
  skipped?: { why: string; file: string; line: number; text: string; staticPrefix?: string }[];
  /** Entity universe (§3 WP-U3-5). */
  promptFragments?: { id: string; name?: string; description?: string; file?: string; line?: number }[];
  agents?: { id: string; label?: string; description?: string; file?: string; modeId?: string }[];
  skills?: { id: string; name?: string; description?: string; file?: string }[];
}

type SourceRefSpec =
  | { path: string }
  | { path: string; symbol: string }
  | { path: string; mode: string };

interface PageSpec {
  id: string;
  lang?: 'ru' | 'en';
  title?: string;
  order?: number;
  section?: string;
  covers?: (string | { pattern: string; reason: string })[];
  sourceRefs?: (SourceRefSpec | unknown)[];
  body?: string;
  /** Raw file text, bypassing the frontmatter builder (malformed-input tests). */
  raw?: string;
}

interface RepoSpec {
  inventory?: InventorySpec;
  exceptions?: unknown[];
  requests?: unknown[];
  pages?: PageSpec[];
  /** Committed blessed baseline; when omitted no file is written (absent = empty). */
  blessed?: { version?: number; pages?: Record<string, Record<string, { hash: string; blessedAt?: string }>> };
  /** Extra source files, written BEFORE the fingerprint so the inventory stays fresh. */
  sources?: { path: string; content: string }[];
}

interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
  report?: string;
  module?: string;
}

async function write(repoRoot: string, relativePath: string, contents: string): Promise<void> {
  const absolutePath = join(repoRoot, relativePath);
  await fs.mkdir(join(absolutePath, '..'), { recursive: true });
  await fs.writeFile(absolutePath, contents, 'utf8');
}

function frontmatter(page: PageSpec): string {
  const lines = ['---', `title: ${page.title ?? `Page ${page.id}`}`, `order: ${page.order ?? 10}`];
  if (page.section !== undefined) {
    lines.push(`section: ${page.section}`);
  }
  if (page.covers !== undefined) {
    lines.push(`covers: ${JSON.stringify(page.covers)}`);
  }
  if (page.sourceRefs !== undefined) {
    lines.push(`sourceRefs: ${JSON.stringify(page.sourceRefs)}`);
  }
  lines.push('---', '');
  return `${lines.join('\n')}${page.body ?? 'Текст страницы.'}\n`;
}

/**
 * A self-contained repository: the three traversal roots, a `workspaces`
 * manifest, an inventory the fixture fully determines, both exception files and
 * the pages.
 */
async function makeRepo(name: string, spec: RepoSpec = {}): Promise<string> {
  const repoRoot = join(TEST_ROOT, name);
  await fs.rm(repoRoot, { recursive: true, force: true });
  for (const dir of SOURCE_DIRS) {
    await fs.mkdir(join(repoRoot, dir), { recursive: true });
  }
  await fs.writeFile(
    join(repoRoot, 'package.json'),
    JSON.stringify({ name: 'fixture-repo', workspaces: ['packages/*'] }, null, 2),
    'utf8'
  );
  // The obligatory entity source (§3 WP-U3-0, R2): written BEFORE the fingerprint
  // below so the generator re-computes the same value over the same tree.
  await write(
    repoRoot,
    'packages/manuscript-workspace/src/node/ai/base-modes.yaml',
    'version: 1\nmodes: []\n'
  );
  // Extra source files FIRST, so the fingerprint the inventory records below
  // already accounts for them (a file added afterwards would stale the inventory).
  for (const source of spec.sources ?? []) {
    await write(repoRoot, source.path, source.content);
  }

  const inventorySpec = spec.inventory ?? {};
  const commandEntries =
    inventorySpec.commandEntries ??
    (inventorySpec.commands ?? []).map(id => ({ id, file: `${PACKAGE_DIR}/src/browser/x.ts`, line: 1 }));
  const inventory = {
    version: 2,
    sourceFingerprint: `sha256:${await computeSourceFingerprint(repoRoot)}`,
    packages: ['manuscript-workspace', 'ai-connect-theia', 'document-preview-theia'],
    // Pinned, not inherited: `OWN_PREFIXES` is derived from these two inputs.
    namespaces: inventorySpec.namespaces ?? ['ai-focused-editor.', 'ai-connect.'],
    commands: commandEntries.map(entry => ({
      id: entry.id,
      file: entry.file ?? `${PACKAGE_DIR}/src/browser/x.ts`,
      line: entry.line ?? 1,
      kind: entry.kind ?? 'command'
    })),
    preferences: (inventorySpec.preferences ?? []).map(key => ({
      key,
      file: `${PACKAGE_DIR}/src/browser/prefs.ts`,
      line: 1,
      schema: 'fixtureSchema'
    })),
    skipped: inventorySpec.skipped ?? [],
    dynamicPrefixes: inventorySpec.dynamicPrefixes ?? [],
    codeReferencedIds: inventorySpec.codeReferencedIds ?? [],
    promptFragments: (inventorySpec.promptFragments ?? []).map(fragment => ({
      kind: 'promptFragment',
      id: fragment.id,
      ...(fragment.name !== undefined ? { name: fragment.name } : {}),
      ...(fragment.description !== undefined ? { description: fragment.description } : {}),
      file: fragment.file ?? `${PACKAGE_DIR}/src/browser/frag.ts`,
      line: fragment.line ?? 1
    })),
    agents: (inventorySpec.agents ?? []).map(agent => ({
      kind: 'agent',
      id: agent.id,
      label: agent.label ?? agent.id,
      description: agent.description ?? '',
      file: agent.file ?? `${PACKAGE_DIR}/src/node/ai/base-modes.yaml`,
      modeId: agent.modeId ?? agent.id
    })),
    skills: (inventorySpec.skills ?? []).map(skill => ({
      kind: 'skill',
      id: skill.id,
      name: skill.name ?? skill.id,
      description: skill.description ?? '',
      file: skill.file ?? '.claude/skills/x/SKILL.md'
    })),
    entityDynamicPrefixes: []
  };
  await write(repoRoot, INVENTORY_PATH, `${JSON.stringify(inventory, null, 2)}\n`);
  if (spec.blessed !== undefined) {
    await write(
      repoRoot,
      'docs/docs-source-refs.blessed.json',
      `${JSON.stringify({ version: spec.blessed.version ?? 1, pages: spec.blessed.pages ?? {} }, null, 2)}\n`
    );
  }
  await write(
    repoRoot,
    'docs/coverage-exceptions.jsonc',
    `${JSON.stringify({ exceptions: spec.exceptions ?? [] }, null, 2)}\n`
  );
  await write(
    repoRoot,
    'docs/coverage-exceptions.requests.jsonc',
    `${JSON.stringify({ requests: spec.requests ?? [] }, null, 2)}\n`
  );
  for (const page of spec.pages ?? []) {
    await write(
      repoRoot,
      `${CONTENT_DIR}/${page.lang ?? 'ru'}/${page.id}.md`,
      page.raw ?? frontmatter(page)
    );
  }
  return repoRoot;
}

/** Runs the real entry point as a subprocess — the same way the build does. */
async function run(repoRoot: string, ...args: string[]): Promise<Run> {
  const child = Bun.spawn(['bun', SCRIPT_PATH, `--repo-root=${repoRoot}`, ...args], {
    stdout: 'pipe',
    stderr: 'pipe'
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited
  ]);
  const read = async (relativePath: string): Promise<string | undefined> => {
    try {
      return await fs.readFile(join(repoRoot, relativePath), 'utf8');
    } catch {
      return undefined;
    }
  };
  return {
    exitCode,
    stdout,
    stderr,
    report: await read('docs/coverage-report.md'),
    module: await read(MODULE_PATH)
  };
}

const strict = (repoRoot: string): Promise<Run> => run(repoRoot, '--coverage=strict');
const warn = (repoRoot: string): Promise<Run> => run(repoRoot, '--coverage=warn');

/** A fence/discipline violation must bite in BOTH modes — `warn` softens only completeness. */
async function expectFailsInBothModes(repoRoot: string, fragment: string): Promise<void> {
  for (const result of [await strict(repoRoot), await warn(repoRoot)]) {
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(fragment);
  }
}

/**
 * With a NON-EMPTY queue, `warn` is the discriminating mode: `strict` refuses
 * to build over a pending queue at all (§4.3), so its message names the queue,
 * not the fence. Assert the fence where it can actually be observed, and assert
 * that `strict` still fails.
 */
async function expectFenceRejectsInWarn(repoRoot: string, fragment: string): Promise<void> {
  const warned = await warn(repoRoot);
  expect(warned.exitCode).not.toBe(0);
  expect(warned.stderr).toContain(fragment);
  expect((await strict(repoRoot)).exitCode).not.toBe(0);
}

async function expectPassesInBothModes(repoRoot: string): Promise<void> {
  for (const result of [await strict(repoRoot), await warn(repoRoot)]) {
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  }
}

/** `| Metric | 12 |` → `12`. */
function metric(report: string | undefined, name: string): string {
  const match = report?.match(new RegExp(`^\\| ${name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')} \\| (.*) \\|$`, 'm'));
  return match?.[1] ?? '';
}

const ACTION = (command: string): string => `:action[Кнопка]{command="${command}"}`;
const SETTINGS = (query: string): string => `:settings[Настройка]{query="${query}"}`;

beforeEach(async () => {
  await fs.mkdir(TEST_ROOT, { recursive: true });
});

afterEach(async () => {
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

// --------------------------------------------------------------------------

describe('fence `command=` (§C.5)', () => {
  test('neg: a command that is in no inventory and no allowlist fails in BOTH modes', async () => {
    const repoRoot = await makeRepo('cmd-unknown', {
      inventory: { commands: ['ai-focused-editor.a'] },
      pages: [{ id: 'home', covers: ['ai-focused-editor.a'], body: ACTION('ai-focused-editor.nope') }]
    });
    await expectFailsInBothModes(repoRoot, 'unknown command "ai-focused-editor.nope"');
  });

  test('pos: the same page with the real id passes — the fence is not "always reject"', async () => {
    const repoRoot = await makeRepo('cmd-known', {
      inventory: { commands: ['ai-focused-editor.a'] },
      pages: [{ id: 'home', body: ACTION('ai-focused-editor.a') }]
    });
    await expectPassesInBothModes(repoRoot);
  });
});

describe('fence `query=` (§C.5, F-D5-8)', () => {
  test('neg: a query matching no preference key fails in BOTH modes', async () => {
    const repoRoot = await makeRepo('query-unknown', {
      inventory: { preferences: ['aiFocusedEditor.welcome.showOnStartup'] },
      pages: [
        {
          id: 'home',
          covers: ['aiFocusedEditor.welcome.showOnStartup'],
          body: SETTINGS('totally.unknown')
        }
      ]
    });
    await expectFailsInBothModes(repoRoot, 'unknown settings query "totally.unknown"');
  });

  test('neg: the fence is PREFIX-based, not substring — "Path" does not ride on ffmpegPath', async () => {
    const repoRoot = await makeRepo('query-substring', {
      inventory: { preferences: ['aiFocusedEditor.ffmpegPath', 'aiFocusedEditor.modelPath'] },
      pages: [
        {
          id: 'home',
          covers: ['aiFocusedEditor.ffmpegPath', 'aiFocusedEditor.modelPath'],
          body: SETTINGS('Path')
        }
      ]
    });
    await expectFailsInBothModes(repoRoot, 'unknown settings query "Path"');
  });

  test('neg: a prefix inside a segment ("aiFocusedEditor.w") is not a prefix ON a boundary', async () => {
    const repoRoot = await makeRepo('query-mid-segment', {
      inventory: { preferences: ['aiFocusedEditor.welcome.showOnStartup'] },
      pages: [
        {
          id: 'home',
          covers: ['aiFocusedEditor.welcome.showOnStartup'],
          body: SETTINGS('aiFocusedEditor.w')
        }
      ]
    });
    await expectFailsInBothModes(repoRoot, 'unknown settings query "aiFocusedEditor.w"');
  });

  test('pos: the same key on a segment boundary passes', async () => {
    // `covers` carries the COMPLETENESS half here: since ISS-096 a prefix
    // `query=` no longer credits the key, and this test is about the FENCE —
    // without the explicit claim it would fail for an unrelated reason.
    const repoRoot = await makeRepo('query-boundary', {
      inventory: { preferences: ['aiFocusedEditor.welcome.showOnStartup'] },
      pages: [
        {
          id: 'home',
          covers: ['aiFocusedEditor.welcome.showOnStartup'],
          body: SETTINGS('aiFocusedEditor.welcome')
        }
      ]
    });
    await expectPassesInBothModes(repoRoot);
  });

  test('pos: a FOREIGN key passes through an adjudicated allowlist entry (П5)', async () => {
    const repoRoot = await makeRepo('query-external-allowlist', {
      inventory: { preferences: ['aiFocusedEditor.welcome.showOnStartup'] },
      exceptions: [
        {
          pattern: 'ai-features.mcp',
          kind: 'external',
          reason: 'ключ @theia/ai-mcp; наша страница ведёт в чужие настройки',
          added: '2026-07-22'
        }
      ],
      pages: [
        {
          id: 'home',
          covers: ['aiFocusedEditor.welcome.showOnStartup'],
          body: SETTINGS('ai-features.mcp')
        }
      ]
    });
    await expectPassesInBothModes(repoRoot);
  });
});

describe('the §4.4 route through the pending queue', () => {
  const mcpRequest = {
    pattern: 'ai-features.mcp',
    kind: 'external',
    reason: 'ключ @theia/ai-mcp — чужой namespace',
    requestedBy: 'WP-11',
    added: '2026-07-22'
  };

  test('pos in warn / fail in strict: a pending external request satisfies `query=` but never ships', async () => {
    const repoRoot = await makeRepo('queue-query', {
      inventory: { preferences: ['aiFocusedEditor.welcome.showOnStartup'] },
      requests: [mcpRequest],
      pages: [
        {
          id: 'home',
          covers: ['aiFocusedEditor.welcome.showOnStartup'],
          body: SETTINGS('ai-features.mcp')
        }
      ]
    });
    const warned = await warn(repoRoot);
    expect(warned.exitCode).toBe(0);
    expect(metric(warned.report, 'Passed via pending external request')).toBe('1');

    const strictRun = await strict(repoRoot);
    expect(strictRun.exitCode).not.toBe(0);
    expect(strictRun.stderr).toContain('unapplied coverage-exception request(s)');
  });

  test('pos in warn: the same route carries `command=` (the tools/git case)', async () => {
    const repoRoot = await makeRepo('queue-command', {
      inventory: { commands: ['ai-focused-editor.a'] },
      requests: [
        {
          pattern: 'git.*',
          kind: 'external',
          reason: 'команды форка theia-git-fork — вне корней §C.1',
          requestedBy: 'WP-11',
          added: '2026-07-22'
        }
      ],
      pages: [{ id: 'home', covers: ['ai-focused-editor.a'], body: ACTION('git.commit.all') }]
    });
    expect((await warn(repoRoot)).exitCode).toBe(0);
  });

  test('neg: `kind:"exempt"` in the queue never satisfies a fence — it is a claim NOT to document', async () => {
    const repoRoot = await makeRepo('queue-exempt', {
      inventory: { commands: ['ai-focused-editor.a'] },
      requests: [
        {
          pattern: 'git.*',
          kind: 'exempt',
          reason: 'не пользовательская поверхность',
          requestedBy: 'WP-11',
          added: '2026-07-22'
        }
      ],
      pages: [{ id: 'home', covers: ['ai-focused-editor.a'], body: ACTION('git.commit.all') }]
    });
    await expectFenceRejectsInWarn(repoRoot, 'unknown command "git.commit.all"');
  });

  test('pos in warn: a NEW dynamic family has a route too (F-D7-8)', async () => {
    const repoRoot = await makeRepo('queue-dynamic', {
      inventory: { commands: ['ai-focused-editor.a'], dynamicPrefixes: ['ai-focused-editor.mode.run.'] },
      requests: [
        {
          pattern: 'ai-focused-editor.mode.run.*',
          kind: 'dynamic',
          reason: 'семейство режимов регистрируется в рантайме',
          requestedBy: 'WP-11',
          added: '2026-07-22'
        }
      ],
      pages: [
        { id: 'home', covers: ['ai-focused-editor.a'], body: ACTION('ai-focused-editor.mode.run.x') }
      ]
    });
    expect((await warn(repoRoot)).exitCode).toBe(0);
    expect((await strict(repoRoot)).stderr).toContain('unapplied coverage-exception request(s)');
  });

  test('neg: the same dynamic value with `kind:"exempt"` in the queue still fails', async () => {
    const repoRoot = await makeRepo('queue-dynamic-exempt', {
      inventory: { commands: ['ai-focused-editor.a'] },
      requests: [
        {
          pattern: 'ai-focused-editor.mode.run.*',
          kind: 'exempt',
          reason: 'внутреннее',
          requestedBy: 'WP-11',
          added: '2026-07-22'
        }
      ],
      pages: [
        { id: 'home', covers: ['ai-focused-editor.a'], body: ACTION('ai-focused-editor.mode.run.x') }
      ]
    });
    await expectFenceRejectsInWarn(repoRoot, 'unknown command "ai-focused-editor.mode.run.x"');
  });
});

describe('OWN_PREFIXES (§4.1.1, F-D6-2/F-D7-3)', () => {
  test('neg: an `external` request over OUR command namespace is refused', async () => {
    const repoRoot = await makeRepo('own-queue-command', {
      inventory: { commands: ['ai-focused-editor.a'] },
      requests: [
        {
          pattern: 'ai-focused-editor.foo',
          kind: 'external',
          reason: 'якобы чужая',
          requestedBy: 'WP-11',
          added: '2026-07-22'
        }
      ],
      pages: [{ id: 'home', covers: ['ai-focused-editor.a'] }]
    });
    await expectFailsInBothModes(repoRoot, 'targets an OWN prefix (ai-focused-editor.)');
  });

  test('neg: the same ban holds in the ALLOWLIST, not only in the queue', async () => {
    const repoRoot = await makeRepo('own-allowlist-command', {
      inventory: { commands: ['ai-focused-editor.a'] },
      exceptions: [
        { pattern: 'ai-connect.bar', kind: 'external', reason: 'якобы чужая', added: '2026-07-22' }
      ],
      pages: [{ id: 'home', covers: ['ai-focused-editor.a'] }]
    });
    await expectFailsInBothModes(repoRoot, 'targets an OWN prefix (ai-connect.)');
  });

  test('neg: a PREFERENCE first segment is an own prefix too — camelCase, not only kebab (allowlist)', async () => {
    const repoRoot = await makeRepo('own-allowlist-pref', {
      inventory: { preferences: ['aiFocusedEditor.welcome.showOnStartup'] },
      exceptions: [
        {
          pattern: 'aiFocusedEditor.wellcome',
          kind: 'external',
          reason: 'опечатка, притворившаяся чужим ключом',
          added: '2026-07-22'
        }
      ],
      pages: [{ id: 'home', covers: ['aiFocusedEditor.welcome.showOnStartup'] }]
    });
    await expectFailsInBothModes(repoRoot, 'targets an OWN prefix (aiFocusedEditor.)');
  });

  test('neg: … and symmetrically in the queue', async () => {
    const repoRoot = await makeRepo('own-queue-pref', {
      inventory: { preferences: ['aiFocusedEditor.welcome.showOnStartup'] },
      requests: [
        {
          pattern: 'aiFocusedEditor.wellcome',
          kind: 'external',
          reason: 'опечатка',
          requestedBy: 'WP-11',
          added: '2026-07-22'
        }
      ],
      pages: [{ id: 'home', covers: ['aiFocusedEditor.welcome.showOnStartup'] }]
    });
    await expectFailsInBothModes(repoRoot, 'targets an OWN prefix (aiFocusedEditor.)');
  });

  test('pos: a genuinely foreign prefix is accepted — the rule did not become "ban everything"', async () => {
    const repoRoot = await makeRepo('own-foreign-ok', {
      inventory: { preferences: ['aiFocusedEditor.welcome.showOnStartup'] },
      exceptions: [
        {
          pattern: 'ai-features.mcp',
          kind: 'external',
          reason: 'чужой ключ @theia/ai-mcp',
          added: '2026-07-22'
        }
      ],
      pages: [
        {
          id: 'home',
          covers: ['aiFocusedEditor.welcome.showOnStartup'],
          body: SETTINGS('ai-features.mcp')
        }
      ]
    });
    await expectPassesInBothModes(repoRoot);
  });
});

describe('completeness (§C.7) and the two modes', () => {
  test('neg in strict / pos in warn: an uncovered id', async () => {
    const repoRoot = await makeRepo('uncovered', {
      inventory: { commands: ['ai-focused-editor.a', 'ai-focused-editor.b'] },
      pages: [{ id: 'home', covers: ['ai-focused-editor.a'] }]
    });
    const strictRun = await strict(repoRoot);
    expect(strictRun.exitCode).not.toBe(0);
    expect(strictRun.stderr).toContain('1 uncovered id(s)');

    const warnRun = await warn(repoRoot);
    expect(warnRun.exitCode).toBe(0);
    expect(metric(warnRun.report, 'Uncovered')).toBe('1');
    expect(warnRun.report).toContain('- ai-focused-editor.b');
  });

  test('pos: an id covered ONLY by a directive occurrence is covered (§C.7 п.3)', async () => {
    const repoRoot = await makeRepo('directive-coverage', {
      inventory: { commands: ['ai-focused-editor.a'] },
      pages: [{ id: 'home', body: ACTION('ai-focused-editor.a') }]
    });
    const result = await strict(repoRoot);
    expect(result.exitCode).toBe(0);
    expect(metric(result.report, 'Uncovered')).toBe('0');
    expect(metric(result.report, 'Covered by directive occurrence')).toBe('1');
    expect(result.report).toContain('| ai-focused-editor.a | home |');
  });

  test('neg: the same fixture without the directive is uncovered — the test is not "always covered"', async () => {
    const repoRoot = await makeRepo('directive-coverage-neg', {
      inventory: { commands: ['ai-focused-editor.a'] },
      pages: [{ id: 'home' }]
    });
    expect((await strict(repoRoot)).stderr).toContain('1 uncovered id(s)');
  });

  test('pos: a preference key covered by a `:settings` that NAMES it exactly', async () => {
    const repoRoot = await makeRepo('directive-coverage-pref', {
      inventory: { preferences: ['aiFocusedEditor.welcome.showOnStartup'] },
      pages: [{ id: 'home', body: SETTINGS('aiFocusedEditor.welcome.showOnStartup') }]
    });
    const result = await strict(repoRoot);
    expect(result.exitCode).toBe(0);
    expect(metric(result.report, 'Covered by directive occurrence')).toBe('1');
  });

  // -------------------------------------------------------------------------
  // ISS-096 — a PREFIX `query=` is an affordance, not a coverage claim.
  //
  // The prototype found the hole by measuring it: `::settings{query="aiConnect"}`
  // and `::settings{query="mediaTranscription"}` reported 18 preference keys as
  // covered on a page that names none of them. The rule now credits only the
  // unit an occurrence NAMES, which is what §C.7 п.3 always claimed it did.
  // -------------------------------------------------------------------------

  test('neg: THE DEFECT — two prefix buttons no longer close 18 keys', async () => {
    const keys = [
      ...Array.from({ length: 8 }, (_, index) => `aiConnect.k${index}`),
      ...Array.from({ length: 10 }, (_, index) => `mediaTranscription.k${index}`)
    ];
    const repoRoot = await makeRepo('prefix-no-credit', {
      inventory: { preferences: keys },
      pages: [{ id: 'home', body: `${SETTINGS('aiConnect')}\n\n${SETTINGS('mediaTranscription')}` }]
    });
    const strictRun = await strict(repoRoot);
    expect(strictRun.exitCode).not.toBe(0);
    expect(strictRun.stderr).toContain('18 uncovered id(s)');
    expect(metric(strictRun.report, 'Covered by directive occurrence')).toBe('0');
    expect(metric(strictRun.report, 'Uncovered')).toBe('18');
  });

  test('pos: the same two buttons on a page that DESCRIBES the keys still build', async () => {
    // The paired positive, and the point of the whole choice: the fix removes
    // the free credit, it does not forbid the button. `covers` is the surface
    // where the claim is made, reviewed and stale-checked.
    const keys = ['aiConnect.k0', 'aiConnect.k1', 'mediaTranscription.k0'];
    const repoRoot = await makeRepo('prefix-with-covers', {
      inventory: { preferences: keys },
      pages: [
        {
          id: 'home',
          covers: keys,
          body: `${SETTINGS('aiConnect')}\n\n${SETTINGS('mediaTranscription')}`
        }
      ]
    });
    const result = await strict(repoRoot);
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    expect(metric(result.report, 'Covered by exact id')).toBe('3');
    expect(metric(result.report, 'Covered by directive occurrence')).toBe('0');
  });

  test('a prefix occurrence says so at its source position instead of failing silently', async () => {
    const repoRoot = await makeRepo('prefix-note', {
      inventory: { preferences: ['aiConnect.k0', 'aiConnect.k1'] },
      pages: [{ id: 'home', body: SETTINGS('aiConnect') }]
    });
    const result = await warn(repoRoot);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('NOTE :settings{query="aiConnect"}');
    expect(result.stdout).toContain('is a segment prefix of 2 preference key(s) and covers none of them');
    expect(result.stdout).toContain('(2 of them uncovered)');
    expect(result.stdout).toContain('packages/manuscript-workspace/src/browser/docs/content/ru/home.md:');
  });

  test('the note is ADVISORY — an exactly-naming occurrence produces none', async () => {
    const repoRoot = await makeRepo('prefix-note-neg', {
      inventory: { preferences: ['aiConnect.k0'] },
      pages: [{ id: 'home', body: SETTINGS('aiConnect.k0') }]
    });
    const result = await strict(repoRoot);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain('NOTE :settings');
  });

  test('a prefix `query=` still PASSES the fence — the button is legal, it just does not pay', async () => {
    // Separating the two is the whole design: §C.5 validates the reference,
    // §C.7 decides what it covers. Collapsing them would forbid a legitimate
    // "open this settings group" button.
    const repoRoot = await makeRepo('prefix-fence-ok', {
      inventory: { preferences: ['aiConnect.k0'] },
      pages: [{ id: 'home', covers: ['aiConnect.k0'], body: SETTINGS('aiConnect') }]
    });
    const result = await strict(repoRoot);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
  });

  test('the `command=` fence accepts a kind:"unclassified" id — a DECIDED limit, pinned here', async () => {
    // `kind` is a syntactic guess (§C.2): branch 3 only recognises a literal
    // registered by identifier IN THE SAME FILE, so the real tree carries 44
    // `unclassified` entries that MIX menu/toolbar paths with genuine commands
    // registered across files (`…proofreading.proofreadSelection`,
    // `…transcript.playPause`). Fencing on `kind` would stop the proofreading
    // page from linking the command it is about. A menu id that slips through
    // is handled at runtime instead — line 1 of the no-dead-buttons contract
    // renders it `disabled` with a tooltip (§D.5).
    const repoRoot = await makeRepo('unclassified-fence', {
      inventory: {
        commandEntries: [{ id: 'ai-focused-editor.proofreading.proofreadSelection', kind: 'unclassified' }]
      },
      pages: [{ id: 'home', body: ACTION('ai-focused-editor.proofreading.proofreadSelection') }]
    });
    const result = await strict(repoRoot);
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    expect(metric(result.report, 'Covered by directive occurrence')).toBe('1');
  });

  test('a key added to the product later cannot arrive already documented', async () => {
    // The property a per-occurrence CEILING would not have given: under the old
    // rule a new key inside an already-buttoned namespace was covered the day it
    // was declared, which is precisely the signal completeness exists to raise.
    const before = await makeRepo('growth-before', {
      inventory: { preferences: ['aiConnect.k0'] },
      pages: [{ id: 'home', covers: ['aiConnect.k0'], body: SETTINGS('aiConnect') }]
    });
    expect((await strict(before)).exitCode).toBe(0);

    const after = await makeRepo('growth-after', {
      inventory: { preferences: ['aiConnect.k0', 'aiConnect.k1'] },
      pages: [{ id: 'home', covers: ['aiConnect.k0'], body: SETTINGS('aiConnect') }]
    });
    const result = await strict(after);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('1 uncovered id(s)');
    expect(result.report).toContain('- aiConnect.k1');
  });

  test('an id claimed BOTH ways is counted once, by the lower-numbered source (§C.7 priority)', async () => {
    const repoRoot = await makeRepo('priority', {
      inventory: { commands: ['ai-focused-editor.a'] },
      pages: [{ id: 'home', covers: ['ai-focused-editor.a'], body: ACTION('ai-focused-editor.a') }]
    });
    const result = await strict(repoRoot);
    expect(result.exitCode).toBe(0);
    expect(metric(result.report, 'Covered by exact id')).toBe('1');
    expect(metric(result.report, 'Covered by directive occurrence')).toBe('0');
  });

  test('|INV| counts DISTINCT ids: one capability declared twice is one unit, covered once', async () => {
    // The real tree has 173 command ENTRIES for 167 distinct ids. Sizing the
    // universe by entry count makes the §B.6 accounting invariant unsatisfiable
    // and kills the build regardless of the content.
    const repoRoot = await makeRepo('dedup', {
      inventory: {
        commandEntries: [
          { id: 'ai-focused-editor.a', file: 'packages/manuscript-workspace/src/browser/one.ts', line: 10 },
          { id: 'ai-focused-editor.a', file: 'packages/manuscript-workspace/src/browser/two.ts', line: 20 },
          { id: 'ai-focused-editor.b', file: 'packages/manuscript-workspace/src/browser/two.ts', line: 30 }
        ]
      },
      pages: [{ id: 'home', covers: ['ai-focused-editor.a', 'ai-focused-editor.b'] }]
    });
    const result = await strict(repoRoot);
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    expect(metric(result.report, 'Inventory ids \\(commands\\)')).toBe('2');
    expect(metric(result.report, 'Covered by exact id')).toBe('2');
    expect(metric(result.report, 'Uncovered')).toBe('0');
  });
});

describe('the `covers` discipline (§2a/F-D2-1, §B.3)', () => {
  const inventoryOfNine: InventorySpec = {
    commands: Array.from({ length: 9 }, (_, index) => `ai-focused-editor.fam.c${index}`)
  };

  test('neg: a BARE string glob has no reason and is refused', async () => {
    const repoRoot = await makeRepo('bare-glob', {
      inventory: { commands: ['ai-focused-editor.a'] },
      pages: [{ id: 'home', covers: ['ai-focused-editor.*'] }]
    });
    await expectFailsInBothModes(repoRoot, 'bare glob "ai-focused-editor.*"');
  });

  test('neg: a glob absorbing 9 ids breaks the ceiling N=8', async () => {
    const repoRoot = await makeRepo('ceiling', {
      inventory: inventoryOfNine,
      pages: [
        {
          id: 'home',
          covers: [{ pattern: 'ai-focused-editor.fam.*', reason: 'одно семейство, описано целиком' }]
        }
      ]
    });
    await expectFailsInBothModes(repoRoot, 'matches 9 ids, above the ceiling N=8');
  });

  test('neg: the ceiling counts the RAW match set, not the post-priority bucket (F-D6-4)', async () => {
    const repoRoot = await makeRepo('ceiling-mixed', {
      inventory: inventoryOfNine,
      pages: [
        {
          id: 'home',
          covers: [
            'ai-focused-editor.fam.c0',
            'ai-focused-editor.fam.c1',
            { pattern: 'ai-focused-editor.fam.*', reason: 'остальное семейство' }
          ]
        }
      ]
    });
    // The post-priority bucket would be 7 and would slip under the ceiling —
    // which is exactly how a wide glob would be smuggled in.
    await expectFailsInBothModes(repoRoot, 'matches 9 ids, above the ceiling N=8');
  });

  test('pos: 7 absorbed ids under N=8 pass, and the report shows the absorption', async () => {
    const repoRoot = await makeRepo('ceiling-ok', {
      inventory: { commands: Array.from({ length: 7 }, (_, index) => `ai-focused-editor.fam.c${index}`) },
      pages: [
        { id: 'home', covers: [{ pattern: 'ai-focused-editor.fam.*', reason: 'семейство целиком' }] }
      ]
    });
    const result = await strict(repoRoot);
    expect(result.exitCode).toBe(0);
    expect(metric(result.report, 'Absorbed by glob')).toBe('7');
    expect(result.report).toContain('| ai-focused-editor.fam.* | home | 7 |');
  });

  test('pos: the ceiling does NOT apply to directive occurrences — 9 buttons are fine', async () => {
    const repoRoot = await makeRepo('ceiling-directives', {
      inventory: inventoryOfNine,
      pages: [
        {
          id: 'home',
          body: (inventoryOfNine.commands ?? []).map(id => ACTION(id)).join('\n\n')
        }
      ]
    });
    const result = await strict(repoRoot);
    expect(result.exitCode).toBe(0);
    expect(metric(result.report, 'Covered by directive occurrence')).toBe('9');
  });

  test('neg: `*` in the middle of a pattern', async () => {
    const repoRoot = await makeRepo('mid-star', {
      inventory: { commands: ['ai-focused-editor.a'] },
      pages: [{ id: 'home', covers: [{ pattern: 'ai-*.a', reason: 'что угодно' }] }]
    });
    await expectFailsInBothModes(repoRoot, "'*' is only allowed as the last character");
  });

  test('neg: a glob without a reason', async () => {
    const repoRoot = await makeRepo('glob-no-reason', {
      inventory: { commands: ['ai-focused-editor.a'] },
      pages: [{ id: 'home', covers: [{ pattern: 'ai-focused-editor.*', reason: '  ' }] }]
    });
    await expectFailsInBothModes(repoRoot, 'needs a non-empty reason');
  });

  test('neg: an exact id in `covers` that is not in the inventory (a typo, not silent non-coverage)', async () => {
    const repoRoot = await makeRepo('covers-typo', {
      inventory: { commands: ['ai-focused-editor.a'] },
      pages: [{ id: 'home', covers: ['ai-focused-editor.aa'] }]
    });
    await expectFailsInBothModes(repoRoot, 'covers id "ai-focused-editor.aa" is not in the inventory');
  });

  test('neg: a `covers` glob matching nothing at all is stale', async () => {
    const repoRoot = await makeRepo('covers-stale', {
      inventory: { commands: ['ai-focused-editor.a'] },
      pages: [
        {
          id: 'home',
          covers: ['ai-focused-editor.a', { pattern: 'ai-focused-editor.gone.*', reason: 'семейство' }]
        }
      ]
    });
    await expectFailsInBothModes(repoRoot, 'stale covers glob "ai-focused-editor.gone.*"');
  });

  test('pos: a glob whose matches are ALSO covered exactly is NOT stale (raw match set, F-D6-4)', async () => {
    const repoRoot = await makeRepo('covers-glob-shadowed', {
      inventory: { commands: ['ai-focused-editor.fam.a', 'ai-focused-editor.fam.b'] },
      pages: [
        {
          id: 'home',
          covers: [
            'ai-focused-editor.fam.a',
            'ai-focused-editor.fam.b',
            { pattern: 'ai-focused-editor.fam.*', reason: 'семейство целиком' }
          ]
        }
      ]
    });
    const result = await strict(repoRoot);
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    // Post-priority the glob absorbs nothing, yet it is alive — the staleness
    // detector reads the RAW set.
    expect(metric(result.report, 'Absorbed by glob')).toBe('0');
  });
});

describe('staleness of allowlist entries, per `kind` (§B.5.1)', () => {
  test('POSITIVE CONTROL: the shipped three-entry allowlist is green on empty content, both modes', async () => {
    // The blocker test of F-D7-1/F-D8-1: on the previous single-subject rule
    // ALL THREE shipped entries were stale, so `docs:dev` — the group-D working
    // command — was dead before the first page was written.
    const repoRoot = await makeRepo('startup-allowlist', {
      inventory: {
        dynamicPrefixes: ['ai-focused-editor.mode.run.'],
        codeReferencedIds: ['preferences:open', 'workbench.action.openGlobalSettings']
      },
      exceptions: [
        {
          pattern: 'ai-focused-editor.mode.run.*',
          kind: 'dynamic',
          reason: 'команды режимов регистрируются в рантайме',
          added: '2026-07-22'
        },
        {
          pattern: 'preferences:open',
          kind: 'external',
          usedBy: 'code',
          reason: 'команда Theia, вызывается из кода',
          added: '2026-07-22'
        },
        {
          pattern: 'workbench.action.openGlobalSettings',
          kind: 'external',
          usedBy: 'code',
          reason: 'фолбэк Theia, тоже из кода',
          added: '2026-07-22'
        }
      ]
    });
    await expectPassesInBothModes(repoRoot);
  });

  test('neg: a `dynamic` entry whose family is gone from the code is stale', async () => {
    const repoRoot = await makeRepo('stale-dynamic', {
      inventory: { dynamicPrefixes: ['ai-focused-editor.mode.run.'] },
      exceptions: [
        {
          pattern: 'ai-focused-editor.ghost.run.*',
          kind: 'dynamic',
          reason: 'семейство, которого больше нет',
          added: '2026-07-22'
        }
      ]
    });
    await expectFailsInBothModes(repoRoot, 'stale exception "ai-focused-editor.ghost.run.*" (kind=dynamic)');
  });

  test('neg: an `external` + `usedBy:"code"` entry with no call left in the code is stale', async () => {
    const repoRoot = await makeRepo('stale-code', {
      inventory: { codeReferencedIds: ['preferences:open'] },
      exceptions: [
        {
          pattern: 'workbench.action.gone',
          kind: 'external',
          usedBy: 'code',
          reason: 'вызов убрали',
          added: '2026-07-22'
        }
      ]
    });
    await expectFailsInBothModes(repoRoot, 'matches nothing in codeReferencedIds[]');
  });

  test('neg: an `external` + `usedBy:"content"` entry is checked once the default set is NON-empty', async () => {
    const repoRoot = await makeRepo('stale-content', {
      inventory: { commands: ['ai-focused-editor.a'] },
      exceptions: [
        { pattern: 'git.*', kind: 'external', reason: 'кнопки git на странице', added: '2026-07-22' }
      ],
      pages: [{ id: 'home', covers: ['ai-focused-editor.a'] }]
    });
    await expectFailsInBothModes(repoRoot, 'stale exception "git.*" (kind=external)');
  });

  test('pos: the same entry with an EMPTY default set is not stale — exactly the WP-2 situation', async () => {
    const repoRoot = await makeRepo('stale-content-empty', {
      inventory: { commands: [] },
      exceptions: [
        { pattern: 'git.*', kind: 'external', reason: 'кнопки git на будущей странице', added: '2026-07-22' }
      ]
    });
    await expectPassesInBothModes(repoRoot);
  });

  test('neg: an `exempt` entry matching no inventory id is stale (the mechanism is NOT weakened)', async () => {
    const repoRoot = await makeRepo('stale-exempt', {
      inventory: { commands: ['ai-focused-editor.a'] },
      exceptions: [
        {
          pattern: 'ai-focused-editor.removed',
          kind: 'exempt',
          reason: 'внутренний хелпер, не пользовательская поверхность',
          added: '2026-07-22'
        }
      ],
      pages: [{ id: 'home', covers: ['ai-focused-editor.a'] }]
    });
    await expectFailsInBothModes(repoRoot, 'stale exception "ai-focused-editor.removed" (kind=exempt)');
  });

  test('pos: staleness does NOT reach the QUEUE — the queue is temporary by construction', async () => {
    const repoRoot = await makeRepo('stale-queue-exempt', {
      inventory: { commands: ['ai-focused-editor.a'] },
      requests: [
        {
          pattern: 'ai-focused-editor.removed',
          kind: 'exempt',
          reason: 'внутренний хелпер',
          requestedBy: 'WP-11',
          added: '2026-07-22'
        }
      ],
      pages: [{ id: 'home', covers: ['ai-focused-editor.a'] }]
    });
    expect((await warn(repoRoot)).exitCode).toBe(0);
  });
});

/**
 * `kind:"deferred"` (§B.5) — the honest route for an id that IS a user-facing
 * surface and WILL be described, on a page another task owes.
 *
 * Three rules carry the whole weight of the kind, and each has a negative here
 * plus a positive on the corrected fixture:
 *   1. `deferredTo` is MANDATORY and non-empty — without an owner the entry is
 *      an open-ended excuse, i.e. exactly the `exempt` abuse F-D2-2 policed;
 *   2. the stale detector reaches it, on the SAME subject as `exempt` (the
 *      inventory) — a deleted command must not leave a row promising a page;
 *   3. it is NOT counted as documentation — it gets its own summary row and its
 *      own report section, never a `Covered …` row.
 */
describe('`kind:"deferred"` — scheduled documentation debt (§B.5, §B.6)', () => {
  const DEFERRED = {
    pattern: 'ai-focused-editor.b',
    kind: 'deferred',
    deferredTo: 'TASK-010',
    reason: 'кнопка редактора схем — описывается на странице tools/diagrams',
    added: '2026-07-22'
  };

  const repo = (name: string, entry: Record<string, unknown>): Promise<string> =>
    makeRepo(name, {
      inventory: { commands: ['ai-focused-editor.a', 'ai-focused-editor.b'] },
      exceptions: [entry],
      pages: [{ id: 'home', covers: ['ai-focused-editor.a'] }]
    });

  test('pos: a complete entry unblocks strict — an undescribed surface stops failing the build', async () => {
    const repoRoot = await repo('deferred-ok', DEFERRED);
    await expectPassesInBothModes(repoRoot);
  });

  test('neg: RULE 1 — no `deferredTo` at all fails the build in BOTH modes', async () => {
    const { deferredTo: _omitted, ...withoutOwner } = DEFERRED;
    const repoRoot = await repo('deferred-no-owner', withoutOwner);
    await expectFailsInBothModes(
      repoRoot,
      'kind:"deferred" entry "ai-focused-editor.b" needs a non-empty deferredTo'
    );
  });

  test('neg: RULE 1 — a BLANK `deferredTo` fails too (whitespace is not a task)', async () => {
    const repoRoot = await repo('deferred-blank-owner', { ...DEFERRED, deferredTo: '   ' });
    await expectFailsInBothModes(
      repoRoot,
      'kind:"deferred" entry "ai-focused-editor.b" needs a non-empty deferredTo'
    );
  });

  test('neg: RULE 1 — `deferredTo` on any OTHER kind is refused, not silently ignored', async () => {
    // Otherwise an `exempt` entry could wear a task reference and read as a
    // deferral while being counted as a permanent exemption.
    const repoRoot = await repo('deferred-to-on-exempt', {
      pattern: 'ai-focused-editor.b',
      kind: 'exempt',
      deferredTo: 'TASK-010',
      reason: 'внутренний хелпер, не пользовательская поверхность',
      added: '2026-07-22'
    });
    await expectFailsInBothModes(
      repoRoot,
      'deferredTo is only valid with kind:"deferred" — "ai-focused-editor.b" is kind:"exempt"'
    );
  });

  /**
   * RULE 1b (§B.5.2, closes F-D9-4 as far as a hermetic build can).
   *
   * `deferredTo` must be a RESOLVABLE task id, not prose. Free text names no
   * one: it cannot be looked up, so the promise the entry encodes can never be
   * checked by a human either — which is the whole point of preferring
   * `deferred` over `exempt`.
   *
   * The paired positive below is what keeps this rule honest: it must accept a
   * well-formed id, so the negatives cannot pass by rejecting everything.
   */
  test('neg: RULE 1b — a PROSE `deferredTo` is refused (an owner must be resolvable)', async () => {
    const repoRoot = await repo('deferred-prose-owner', { ...DEFERRED, deferredTo: 'позже' });
    await expectFailsInBothModes(
      repoRoot,
      'invalid deferredTo "позже" for "ai-focused-editor.b"'
    );
  });

  test('neg: RULE 1b — a near-miss id shape is refused too (TASK-010 vs task_010)', async () => {
    // The dangerous case is not obvious garbage but something that LOOKS like
    // an id: a typo that reads fine to a reviewer skimming the allowlist.
    // NB: 'TASK-010 ' is deliberately NOT here — surrounding whitespace is
    // trimmed before the check, so it is a VALID id and is asserted as such in
    // the paired positive below.
    for (const bad of ['task-010', 'TASK-', 'TASK010', 'ISS-010', 'TASK-10a', 'TASK-010,TASK-011']) {
      const repoRoot = await repo(`deferred-badshape-${bad.replace(/\W/g, '_')}`, {
        ...DEFERRED,
        deferredTo: bad
      });
      await expectFailsInBothModes(repoRoot, 'expected a task id of the form TASK-123');
    }
  });

  test('pos: RULE 1b — a well-formed id is accepted, and surrounding whitespace is trimmed', async () => {
    // Paired positive: proves the rule discriminates rather than just rejecting.
    for (const good of ['TASK-010', 'TASK-1', 'TASK-1234', '  TASK-010  ']) {
      const repoRoot = await repo(`deferred-goodshape-${good.trim()}`, {
        ...DEFERRED,
        deferredTo: good
      });
      await expectPassesInBothModes(repoRoot);
    }
  });

  test('neg: RULE 2 — a deferred entry whose command is gone from the product is stale', async () => {
    const repoRoot = await makeRepo('deferred-stale', {
      inventory: { commands: ['ai-focused-editor.a'] },
      exceptions: [{ ...DEFERRED, pattern: 'ai-focused-editor.removed' }],
      pages: [{ id: 'home', covers: ['ai-focused-editor.a'] }]
    });
    await expectFailsInBothModes(
      repoRoot,
      'stale exception "ai-focused-editor.removed" (kind=deferred) matches nothing in the inventory'
    );
  });

  test('neg: RULE 3 — deferring an id does NOT count as describing it', async () => {
    const repoRoot = await repo('deferred-not-coverage', DEFERRED);
    const report = (await strict(repoRoot)).report ?? '';

    // Its own row, and NONE of the three coverage rows moved: the page covers
    // exactly one id, and deferring the second did not silently make it two.
    expect(metric(report, 'Deferred to a task')).toBe('1');
    expect(metric(report, 'Covered by exact id')).toBe('1');
    expect(metric(report, 'Covered by directive occurrence')).toBe('0');
    expect(metric(report, 'Absorbed by glob')).toBe('0');
    // …and not folded into the exempt row either — the two claims are opposite.
    expect(metric(report, 'Allowlisted: exempt')).toBe('0');
    expect(metric(report, 'Uncovered')).toBe('0');

    // Visible BY NAME with its owner, not just as a number.
    expect(report).toContain('## Deferred coverage');
    expect(report).toMatch(/\| ai-focused-editor\.b \| TASK-010 \|/);
    // And it is nowhere in the "covered" section.
    const covered = report.split('## Covered by directive occurrence')[1]?.split('\n## ')[0] ?? '';
    expect(covered).not.toContain('ai-focused-editor.b');
  });

  test('the accounting invariant still totals the inventory with a deferred bucket present', async () => {
    const repoRoot = await repo('deferred-accounting', DEFERRED);
    const report = (await strict(repoRoot)).report ?? '';
    const value = (name: string): number => Number(metric(report, name));
    const sum =
      value('Covered by exact id') +
      value('Covered by directive occurrence') +
      value('Absorbed by glob') +
      value('Allowlisted: external') +
      value('Allowlisted: dynamic') +
      value('Allowlisted: exempt') +
      value('Deferred to a task') +
      value('Uncovered');
    expect(sum).toBe(value('Inventory ids \\(commands\\)') + value('Inventory keys \\(preferences\\)'));
  });
});

describe('the request queue (§4.1, §4.3)', () => {
  test('neg in strict / pos in warn: a non-empty queue is not shippable but does not block authoring', async () => {
    const repoRoot = await makeRepo('queue-block', {
      inventory: { commands: ['ai-focused-editor.a'] },
      requests: [
        {
          pattern: 'git.*',
          kind: 'external',
          reason: 'чужой namespace',
          requestedBy: 'WP-11',
          added: '2026-07-22'
        }
      ],
      pages: [{ id: 'home', covers: ['ai-focused-editor.a'] }]
    });
    const strictRun = await strict(repoRoot);
    expect(strictRun.exitCode).not.toBe(0);
    expect(strictRun.stderr).toContain('1 unapplied coverage-exception request(s)');

    const warnRun = await warn(repoRoot);
    expect(warnRun.exitCode).toBe(0);
    expect(metric(warnRun.report, 'Pending exception requests')).toBe('1');
  });

  test('neg: a `kind` outside the closed set', async () => {
    const repoRoot = await makeRepo('queue-bogus-kind', {
      inventory: { commands: ['ai-focused-editor.a'] },
      requests: [
        { pattern: 'git.*', kind: 'bogus', reason: 'x', requestedBy: 'WP-11', added: '2026-07-22' }
      ],
      pages: [{ id: 'home', covers: ['ai-focused-editor.a'] }]
    });
    await expectFailsInBothModes(
      repoRoot,
      'invalid request kind "bogus" (expected external|dynamic|exempt|deferred)'
    );
  });

  test('neg: `usedBy` with a non-`external` kind — validated in the QUEUE too (F-D8-6)', async () => {
    const repoRoot = await makeRepo('queue-usedby-exempt', {
      inventory: { commands: ['ai-focused-editor.a'] },
      requests: [
        {
          pattern: 'ai-focused-editor.internal',
          kind: 'exempt',
          usedBy: 'code',
          reason: 'внутреннее',
          requestedBy: 'WP-11',
          added: '2026-07-22'
        }
      ],
      pages: [{ id: 'home', covers: ['ai-focused-editor.a'] }]
    });
    await expectFailsInBothModes(repoRoot, 'usedBy is only valid with kind:"external"');
  });

  test('neg: an out-of-set `usedBy` value in the ALLOWLIST', async () => {
    const repoRoot = await makeRepo('allowlist-usedby-bogus', {
      inventory: { commands: ['ai-focused-editor.a'] },
      exceptions: [
        { pattern: 'git.*', kind: 'external', usedBy: 'humans', reason: 'x', added: '2026-07-22' }
      ],
      pages: [{ id: 'home', covers: ['ai-focused-editor.a'] }]
    });
    await expectFailsInBothModes(repoRoot, 'invalid usedBy "humans" (expected content|code)');
  });

  test('neg: a request without `requestedBy` — the queue must say who asked', async () => {
    const repoRoot = await makeRepo('queue-no-requester', {
      inventory: { commands: ['ai-focused-editor.a'] },
      requests: [{ pattern: 'git.*', kind: 'external', reason: 'x', added: '2026-07-22' }],
      pages: [{ id: 'home', covers: ['ai-focused-editor.a'] }]
    });
    await expectFailsInBothModes(repoRoot, 'needs a non-empty requestedBy');
  });
});

describe('fence 4 — referential integrity (§3)', () => {
  test('neg: a page in `content/en` missing from the default set (4a), in BOTH modes', async () => {
    const repoRoot = await makeRepo('fence4a', {
      pages: [
        { id: 'home', lang: 'ru' },
        { id: 'home', lang: 'en' },
        { id: 'ghost', lang: 'en' }
      ]
    });
    await expectFailsInBothModes(repoRoot, 'page "ghost" exists in content/en but is missing from the default set content/ru');
  });

  test('neg: a `:doc` pointing at a page that does not exist (4b), in BOTH modes', async () => {
    const repoRoot = await makeRepo('fence4b', {
      pages: [{ id: 'home', body: 'См. :doc[Экспорт]{page="book/export"} далее.' }]
    });
    await expectFailsInBothModes(repoRoot, 'targets a page missing from content/ru');
  });

  test('pos: a consistent set passes — fence 4 is not "always fail"', async () => {
    const repoRoot = await makeRepo('fence4-positive', {
      pages: [
        { id: 'home', body: 'См. :doc[Экспорт]{page="book/export"} далее.' },
        { id: 'book/export', title: 'Экспорт', order: 20, section: 'Книга' },
        { id: 'home', lang: 'en', title: 'Home' }
      ]
    });
    await expectPassesInBothModes(repoRoot);
  });

  test('neg: `:::scenario` outside the guide root page (§A.7)', async () => {
    const repoRoot = await makeRepo('scenario-elsewhere', {
      pages: [
        { id: 'home' },
        {
          id: 'book/export',
          body: ':::scenario{page="home"}\nКарточка сценария.\n:::'
        }
      ]
    });
    await expectFailsInBothModes(repoRoot, ':::scenario is only allowed on the guide root page (home)');
  });

  test('pos: the same directive ON the root page', async () => {
    const repoRoot = await makeRepo('scenario-home', {
      pages: [
        { id: 'home', body: ':::scenario{page="book/export"}\nКарточка сценария.\n:::' },
        { id: 'book/export' }
      ]
    });
    await expectPassesInBothModes(repoRoot);
  });
});

describe('directive diagnostics are fatal at build time (§A.4, §A.5)', () => {
  const failsWithLabel = async (name: string, label: string, fragment: string): Promise<void> => {
    const repoRoot = await makeRepo(name, {
      inventory: { commands: ['ai-focused-editor.a'] },
      pages: [
        {
          id: 'home',
          covers: ['ai-focused-editor.a'],
          body: `:action[${label}]{command="ai-focused-editor.a"}`
        }
      ]
    });
    await expectFailsInBothModes(repoRoot, fragment);
  };

  test('neg: emphasis, code span, strikethrough and a link opener in a label', async () => {
    await failsWithLabel('label-star', 'a*b', "metacharacter '*'");
    await failsWithLabel('label-code', 'a`b`', "metacharacter '`'");
    await failsWithLabel('label-tilde', 'a~b~', "metacharacter '~'");
    // One unescaped `]` only: the label decodes to «см. [тут» and the `[`
    // survives into the decoded text, which is what §A.5 п.4 forbids.
    await failsWithLabel('label-bracket', 'см. [тут', "metacharacter '['");
  });

  test('neg: a character reference in a label (CommonMark decodes it, we do not)', async () => {
    await failsWithLabel('label-amp-named', 'знак &amp; тут', "metacharacter '&'");
    await failsWithLabel('label-amp-numeric', 'код &#65;', "metacharacter '&'");
  });

  test('neg: inline HTML and an autolink in a label', async () => {
    await failsWithLabel('label-html', '<b>жирный</b>', "metacharacter '<'");
    await failsWithLabel('label-autolink', '<https://a.example>', "metacharacter '<'");
  });

  test('neg: braces in a label (the MDX branch of §A.5 п.9)', async () => {
    await failsWithLabel('label-brace-open', 'a{x}', "metacharacter '{'");
    await failsWithLabel('label-brace-close', 'b}c', "metacharacter '}'");
  });

  test('pos: legitimate Russian prose with `<`, `&` and an escaped bracket passes', async () => {
    const repoRoot = await makeRepo('label-legit', {
      inventory: { commands: ['ai-focused-editor.a', 'ai-focused-editor.b'] },
      pages: [
        {
          id: 'home',
          body:
            ':action[если x < y и a & b]{command="ai-focused-editor.a"}\n\n' +
            ':action[Открыть «Сверку» — режим \\] & <проверка>]{command="ai-focused-editor.b"}'
        }
      ]
    });
    await expectPassesInBothModes(repoRoot);
  });

  test('neg: a DEGRADABLE finding (a bad `icon`) also fails the BUILD — `ok:true` is not enough', async () => {
    // Three rows of the §A.4 table come back as `ok: true` + warnings. A
    // generator that only checked `ok` would implement four of seven rules.
    const repoRoot = await makeRepo('icon-degraded', {
      pages: [
        {
          id: 'home',
          body: ':::scenario{page="home" icon="evil onerror="}\nКарточка.\n:::'
        }
      ]
    });
    await expectFailsInBothModes(repoRoot, "attribute 'icon'");
  });

  test('neg: an unknown ATTRIBUTE is degradable at runtime and fatal at build time', async () => {
    const repoRoot = await makeRepo('unknown-attribute', {
      inventory: { commands: ['ai-focused-editor.a'] },
      pages: [
        {
          id: 'home',
          covers: ['ai-focused-editor.a'],
          body: ':action[Кнопка]{command="ai-focused-editor.a" tooltip="нет такого"}'
        }
      ]
    });
    await expectFailsInBothModes(repoRoot, "unknown attribute 'tooltip'");
  });

  test('neg: a fatal parse error (unknown directive name)', async () => {
    const repoRoot = await makeRepo('unknown-directive', {
      pages: [{ id: 'home', body: ':actoin[Кнопка]{command="x"}' }]
    });
    await expectFailsInBothModes(repoRoot, "unknown directive 'actoin'");
  });

  test('a diagnostic position is reported in FILE coordinates, past the frontmatter', async () => {
    const repoRoot = await makeRepo('diagnostic-position', {
      pages: [{ id: 'home', body: 'Первая строка.\n\n:actoin[Кнопка]{command="x"}' }]
    });
    const result = await strict(repoRoot);
    // Four frontmatter lines are consumed before the body, so the third body
    // line is file line 7 — a diagnostic reported at body coordinates would
    // send the author three lines up.
    expect(result.stderr).toContain(`${CONTENT_DIR}/ru/home.md:7:`);
  });
});

describe('frontmatter (§B.3)', () => {
  test('neg: no `title`', async () => {
    const repoRoot = await makeRepo('front-no-title', {
      pages: [{ id: 'home', raw: '---\norder: 10\n---\n\nТекст.\n' }]
    });
    await expectFailsInBothModes(repoRoot, 'frontmatter key "title" must be a non-empty string');
  });

  test('neg: a non-numeric `order`', async () => {
    const repoRoot = await makeRepo('front-bad-order', {
      pages: [{ id: 'home', raw: '---\ntitle: Дом\norder: "x"\n---\n\nТекст.\n' }]
    });
    await expectFailsInBothModes(repoRoot, 'frontmatter key "order" must be an integer >= 0');
  });

  test('neg: no frontmatter at all', async () => {
    const repoRoot = await makeRepo('front-missing', {
      pages: [{ id: 'home', raw: 'Просто текст без заголовка.\n' }]
    });
    await expectFailsInBothModes(repoRoot, 'has no frontmatter');
  });

  test('neg: an unknown frontmatter key (a typo would otherwise be silently ignored)', async () => {
    const repoRoot = await makeRepo('front-unknown-key', {
      pages: [{ id: 'home', raw: '---\ntitle: Дом\norder: 10\ncoverz: []\n---\n\nТекст.\n' }]
    });
    await expectFailsInBothModes(repoRoot, 'unknown frontmatter key "coverz"');
  });
});

describe('inventory freshness (§1.5) and CLI modes (§1.3)', () => {
  test('neg: a missing inventory names the command that produces it', async () => {
    const repoRoot = await makeRepo('inventory-missing');
    await fs.rm(join(repoRoot, INVENTORY_PATH));
    const result = await strict(repoRoot);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('inventory missing — run "bun run docs:inventory" first');
  });

  test('neg: an inventory whose fingerprint no longer matches the sources', async () => {
    const repoRoot = await makeRepo('inventory-stale', { inventory: { commands: [] } });
    await write(repoRoot, `${PACKAGE_DIR}/src/browser/new-file.ts`, 'export const X = 1;\n');
    const result = await strict(repoRoot);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('inventory is stale (source fingerprint mismatch)');
  });

  test('the fingerprint is compared in a NORMALISED form — `sha256:`-prefixed matches bare hex', async () => {
    // The extractor writes `sha256:<hex>` (§B.4) while `computeSourceFingerprint`
    // returns bare hex (§1.5). Comparing raw strings would fail on every run.
    const repoRoot = await makeRepo('fingerprint-forms', { inventory: { commands: [] } });
    const inventory = JSON.parse(await fs.readFile(join(repoRoot, INVENTORY_PATH), 'utf8'));
    expect(inventory.sourceFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect((await strict(repoRoot)).exitCode).toBe(0);

    inventory.sourceFingerprint = inventory.sourceFingerprint.replace('sha256:', '');
    await write(repoRoot, INVENTORY_PATH, `${JSON.stringify(inventory, null, 2)}\n`);
    expect((await strict(repoRoot)).exitCode).toBe(0);
  });

  test('neg: an unsupported inventory version', async () => {
    const repoRoot = await makeRepo('inventory-version', { inventory: { commands: [] } });
    const inventory = JSON.parse(await fs.readFile(join(repoRoot, INVENTORY_PATH), 'utf8'));
    inventory.version = 3;
    await write(repoRoot, INVENTORY_PATH, `${JSON.stringify(inventory, null, 2)}\n`);
    const result = await strict(repoRoot);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('inventory version 3 is not supported');
  });

  test('neg: NO `--coverage` on an uncovered id fails — the default is strict (§1.3)', async () => {
    const repoRoot = await makeRepo('default-mode', {
      inventory: { commands: ['ai-focused-editor.a'] }
    });
    const result = await run(repoRoot);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('1 uncovered id(s)');
  });

  test('neg: an out-of-set `--coverage` value, and a bare `--coverage`', async () => {
    const repoRoot = await makeRepo('bad-mode', { inventory: { commands: [] } });
    const loose = await run(repoRoot, '--coverage=loose');
    expect(loose.exitCode).toBe(2);
    expect(loose.stderr).toContain(`invalid --coverage value 'loose' (expected "strict" or "warn")`);

    const bare = await run(repoRoot, '--coverage');
    expect(bare.exitCode).toBe(2);
    expect(bare.stderr).toContain('invalid --coverage value');
  });

  test('neg: an unusable repository root is refused, not guessed at', async () => {
    const repoRoot = await makeRepo('bad-root', { inventory: { commands: [] } });
    await fs.rm(join(repoRoot, 'package.json'));
    const result = await strict(repoRoot);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('cannot locate repository root');
  });
});

describe('emission and the report (§B.2, §B.6)', () => {
  const richRepo = (name: string): Promise<string> =>
    makeRepo(name, {
      inventory: {
        commands: ['ai-focused-editor.a', 'ai-focused-editor.fam.x', 'ai-focused-editor.fam.y'],
        preferences: ['aiFocusedEditor.welcome.showOnStartup'],
        skipped: [
          {
            why: 'template-literal-id',
            file: 'packages/manuscript-workspace/src/browser/dyn.ts',
            line: 206,
            text: 'id: commandId',
            staticPrefix: 'ai-focused-editor.mode.run.'
          }
        ],
        dynamicPrefixes: ['ai-focused-editor.mode.run.']
      },
      exceptions: [
        {
          pattern: 'ai-focused-editor.mode.run.*',
          kind: 'dynamic',
          reason: 'рантайм-регистрация',
          added: '2026-07-22'
        }
      ],
      pages: [
        {
          id: 'home',
          title: 'Дом',
          order: 0,
          covers: [{ pattern: 'ai-focused-editor.fam.*', reason: 'семейство целиком' }],
          // The EXACT key, not the `aiFocusedEditor.welcome` prefix it used to
          // be: since ISS-096 an occurrence covers only the unit it names.
          body: `${ACTION('ai-focused-editor.a')}\n\n${SETTINGS('aiFocusedEditor.welcome.showOnStartup')}`
        },
        { id: 'book/export', title: 'Экспорт', order: 20, section: 'Книга' },
        { id: 'start', title: 'Начало', order: 5 }
      ]
    });

  test('the generated module implements the contract and is TOTAL over DocsLang', async () => {
    const repoRoot = await richRepo('emission');
    const result = await strict(repoRoot);
    expect(result.exitCode).toBe(0);
    const module = result.module ?? '';
    expect(module).toContain('// AUTOGENERATED by scripts/generate-docs-content.mjs — do not edit.');
    expect(module).toContain("from '../../common/docs/docs-contract'");
    expect(module).toContain('export const generatedDocsContentProvider: DocsContentProvider');
    // A key for EVERY language, even the empty one — that totality is what
    // makes a `?? DOCS_MANIFEST['ru']` guard unnecessary (F-D6-1).
    expect(module).toMatch(/"ru": \{/);
    expect(module).toMatch(/"en": \{/);
    expect(module).toContain('"markdown"');
    expect(module).toContain('"covers"');
  });

  test('the manifest is sorted by §B.3: section-less first, then groups by minimum order', async () => {
    const repoRoot = await richRepo('manifest-order');
    const module = (await strict(repoRoot)).module ?? '';
    const manifest = module.slice(module.indexOf('DOCS_MANIFEST'));
    const order = [...manifest.matchAll(/"id": "([^"]+)"/g)].map(match => match[1]);
    expect(order.slice(0, 3)).toEqual(['home', 'start', 'book/export']);
  });

  test('the report carries the seven sections in the normative order', async () => {
    const repoRoot = await richRepo('report-shape');
    const report = (await strict(repoRoot)).report ?? '';
    expect(report.startsWith('<!-- AUTOGENERATED by scripts/generate-docs-content.mjs')).toBe(true);
    expect([...report.matchAll(/^## (.+)$/gm)].map(match => match[1])).toEqual([
      'Summary',
      'Covered by directive occurrence',
      'Glob absorption',
      'Allowlist',
      'Deferred coverage',
      'Uncovered ids',
      'Uncovered entities',
      'Skipped declarations (not extractable)'
    ]);
    expect(report).toContain('| packages/manuscript-workspace/src/browser/dyn.ts | 206 | template-literal-id |');
    expect(report).toContain('_(none)_');
  });

  test('the accounting invariant holds: the buckets sum to the DISTINCT inventory size (§B.6)', async () => {
    const repoRoot = await richRepo('accounting');
    const report = (await strict(repoRoot)).report ?? '';
    const value = (name: string): number => Number(metric(report, name));
    const sum =
      value('Covered by exact id') +
      value('Covered by directive occurrence') +
      value('Absorbed by glob') +
      value('Allowlisted: external') +
      value('Allowlisted: dynamic') +
      value('Allowlisted: exempt') +
      value('Deferred to a task') +
      value('Uncovered');
    expect(sum).toBe(value('Inventory ids \\(commands\\)') + value('Inventory keys \\(preferences\\)'));
  });

  /**
   * F-D9-8. The namespace list is the SCOPE of the whole completeness
   * guarantee, and it is frozen in a literal. A command registered in a third
   * namespace never enters the inventory at all — so it is never required to be
   * described and, unlike a template-literal id, it does not even appear under
   * `Skipped declarations`. Printing the active list into the committed report
   * does not close that hole; it makes widening the scope show up as a diff line.
   */
  test('the report NAMES the active inventory namespaces (scope is visible in the diff)', async () => {
    const repoRoot = await richRepo('namespaces-visible');
    const result = await strict(repoRoot);
    expect(result.exitCode).toBe(0);
    expect(metric(result.report, 'Inventory namespaces')).toContain('ai-focused-editor.');
  });

  /**
   * Same rationale one layer up (§F.9): the package list is the SCOPE of the
   * source traversal itself. A package added to the walk without a matching
   * entry here would be a silent widening of what the whole guarantee looks
   * at, so it must show up as a diff line in the committed report too.
   */
  test('the report NAMES the scanned inventory packages (scope is visible in the diff)', async () => {
    const repoRoot = await richRepo('packages-visible');
    const result = await strict(repoRoot);
    expect(result.exitCode).toBe(0);
    expect(metric(result.report, 'Inventory packages')).toContain('manuscript-workspace');
  });

  /**
   * F-QA9-4. There is no fenced ceiling on the generated module's size — this
   * is VISIBILITY, not a hard gate, same rationale as the namespace/package
   * rows above one level down (bytes instead of scope): silent growth of the
   * bundle now shows up as a diff line in the committed report.
   */
  test('the report NAMES the generated docs-content module size (visibility, not a hard gate)', async () => {
    const repoRoot = await richRepo('content-size-visible');
    const result = await strict(repoRoot);
    expect(result.exitCode).toBe(0);
    const reportedKB = Number.parseFloat(metric(result.report, 'Docs content size'));
    expect(reportedKB).toBeGreaterThan(0);
    const actualKB = Buffer.byteLength(result.module ?? '', 'utf8') / 1024;
    expect(reportedKB).toBeCloseTo(actualKB, 1);
  });

  test('the report has NO timestamp: two runs over one input are byte-identical', async () => {
    const repoRoot = await richRepo('determinism');
    const first = await strict(repoRoot);
    const second = await strict(repoRoot);
    expect(second.report).toBe(first.report);
    expect(second.module).toBe(first.module);
    expect(first.report).not.toMatch(/20\d\d-\d\d-\d\dT/);
  });

  test('a fully consistent fixture exits 0 in BOTH modes — the control positive (§F.0)', async () => {
    const repoRoot = await richRepo('control-positive');
    await expectPassesInBothModes(repoRoot);
  });
});

// --------------------------------------------------------------------------
// TASK-018 S4/S5 — entity universe, drift gate, scaffold enforcement
// --------------------------------------------------------------------------

const driftFatal = (repoRoot: string): Promise<Run> => run(repoRoot, '--coverage=warn', '--drift=fatal');

/** The doc-target source file the drift fixtures pin a `{path}` ref to. */
const TARGET_PATH = `${PACKAGE_DIR}/src/browser/doc-target.ts`;

describe('entity coverage gate (§3 WP-U3-5, §6 F-D2.1-1)', () => {
  test('neg in strict / pos in warn: an uncovered prompt fragment', async () => {
    const repoRoot = await makeRepo('entity-uncovered', {
      inventory: { promptFragments: [{ id: 'ai-focused-editor.my-fragment' }] },
      pages: [{ id: 'home' }]
    });
    const strictRun = await strict(repoRoot);
    expect(strictRun.exitCode).not.toBe(0);
    expect(strictRun.stderr).toContain('1 uncovered entity(ies)');
    expect(strictRun.stderr).toContain('ai-focused-editor.my-fragment');

    const warnRun = await warn(repoRoot);
    expect(warnRun.exitCode).toBe(0);
    expect(metric(warnRun.report, 'Uncovered entities')).toBe('1');
    expect(warnRun.report).toContain('- ai-focused-editor.my-fragment');
  });

  test('pos: an entity covered by an exact covers claim passes strict', async () => {
    const repoRoot = await makeRepo('entity-covered', {
      inventory: {
        promptFragments: [{ id: 'ai-focused-editor.my-fragment' }],
        agents: [{ id: 'ai-focused-editor.mode.gv-x', modeId: 'gv-x' }],
        skills: [{ id: 'skill:my-skill' }]
      },
      pages: [
        {
          id: 'home',
          covers: ['ai-focused-editor.my-fragment', 'ai-focused-editor.mode.gv-x', 'skill:my-skill'],
          body: 'Описание.\n\n## Зачем и когда\n\nПолезно, когда нужно X.'
        }
      ]
    });
    const result = await strict(repoRoot);
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    expect(metric(result.report, 'Entities covered by exact id')).toBe('3');
    expect(metric(result.report, 'Uncovered entities')).toBe('0');
  });

  test('pos: an entity excused by an exempt/deferred allowlist entry is not uncovered', async () => {
    const repoRoot = await makeRepo('entity-excused', {
      inventory: {
        promptFragments: [{ id: 'ai-focused-editor.internal-fragment' }],
        skills: [{ id: 'skill:owed' }]
      },
      exceptions: [
        {
          pattern: 'ai-focused-editor.internal-fragment',
          kind: 'exempt',
          reason: 'внутренний фрагмент, не пользовательская поверхность',
          added: '2026-07-23'
        },
        {
          pattern: 'skill:owed',
          kind: 'deferred',
          deferredTo: 'TASK-999',
          reason: 'скилл будет описан на отдельной странице',
          added: '2026-07-23'
        }
      ],
      pages: [{ id: 'home' }]
    });
    const result = await strict(repoRoot);
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    expect(metric(result.report, 'Entities allowlisted: exempt')).toBe('1');
    expect(metric(result.report, 'Entities allowlisted: deferred')).toBe('1');
    expect(metric(result.report, 'Uncovered entities')).toBe('0');
  });

  test('ENTITY INVARIANT: an id in BOTH the command and the entity universe is a hard config error (ISS-186, double-count)', async () => {
    // The double-count guard (§6 F-D2.1-1). If a fragment id ever re-entered
    // commands[], one page's covers claim would satisfy two universes at once.
    const repoRoot = await makeRepo('entity-doublecount', {
      inventory: {
        commands: ['ai-focused-editor.dup'],
        promptFragments: [{ id: 'ai-focused-editor.dup' }]
      },
      pages: [{ id: 'home', covers: ['ai-focused-editor.dup'] }]
    });
    const result = await strict(repoRoot);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('counted in BOTH');
  });
});

describe('source-ref drift gate (§3 WP-U4-3, §2.4)', () => {
  const driftRepo = async (
    name: string,
    opts: { blessedHash?: 'correct' | 'wrong' | 'absent'; refPath?: string }
  ): Promise<string> => {
    const refPath = opts.refPath ?? TARGET_PATH;
    const repoRoot = await makeRepo(name, {
      sources: [{ path: TARGET_PATH, content: 'export const DOC_TARGET = 1;\n' }],
      pages: [{ id: 'home', sourceRefs: [{ path: refPath }] }]
    });
    if (opts.blessedHash !== 'absent') {
      const current = await hashSourceRef(repoRoot, { path: refPath });
      const hash = opts.blessedHash === 'wrong' ? 'sha256:deadbeef' : current;
      await write(
        repoRoot,
        'docs/docs-source-refs.blessed.json',
        `${JSON.stringify(
          { version: 1, pages: { home: { [refPath]: { hash, blessedAt: '2026-07-23' } } } },
          null,
          2
        )}\n`
      );
    }
    return repoRoot;
  };

  test('fresh: a matching blessed hash passes even under --drift=fatal', async () => {
    const repoRoot = await driftRepo('drift-fresh', { blessedHash: 'correct' });
    const result = await driftFatal(repoRoot);
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    expect(metric(result.report, 'Fresh source refs')).toBe('1');
    expect(metric(result.report, 'Drifted source refs')).toBe('0');
  });

  test('drift: a mismatched hash is fatal under --drift=fatal, a NOTE (exit 0) by default', async () => {
    const repoRoot = await driftRepo('drift-mismatch', { blessedHash: 'wrong' });

    const fatalRun = await driftFatal(repoRoot);
    expect(fatalRun.exitCode).not.toBe(0);
    expect(fatalRun.stderr).toContain('has drifted from its blessed baseline');

    const warnRun = await warn(repoRoot); // default --drift=warn
    expect(warnRun.exitCode).toBe(0);
    expect(warnRun.stdout).toContain('NOTE source ref');
    expect(metric(warnRun.report, 'Drifted source refs')).toBe('1');
  });

  test('unblessed: a declared ref with no baseline is fatal in BOTH modes', async () => {
    const repoRoot = await driftRepo('drift-unblessed', { blessedHash: 'absent' });
    expect((await warn(repoRoot)).stderr).toContain('unblessed source ref');
    expect((await warn(repoRoot)).exitCode).not.toBe(0);
    expect((await strict(repoRoot)).stderr).toContain('unblessed source ref');
  });

  test('stale: a ref whose target file is gone is fatal in BOTH modes', async () => {
    const repoRoot = await driftRepo('drift-stale', {
      blessedHash: 'absent',
      refPath: `${PACKAGE_DIR}/src/browser/vanished.ts`
    });
    expect((await warn(repoRoot)).stderr).toContain('stale source ref');
    expect((await warn(repoRoot)).exitCode).not.toBe(0);
    expect((await strict(repoRoot)).stderr).toContain('stale source ref');
  });

  test('a malformed sourceRefs entry is refused like a bad covers entry', async () => {
    const repoRoot = await makeRepo('sourcerefs-malformed', {
      pages: [{ id: 'home', sourceRefs: [{ path: 'a.ts', symbol: 'S', mode: 'm' }] }]
    });
    await expectFailsInBothModes(repoRoot, 'cannot carry both "symbol" and "mode"');
  });
});

describe('scaffold placeholder enforcement (§3 WP-U3-6)', () => {
  const entityRepo = (name: string, body: string): Promise<string> =>
    makeRepo(name, {
      inventory: { promptFragments: [{ id: 'ai-focused-editor.scaffolded' }] },
      pages: [{ id: 'ai/scaffolded', covers: ['ai-focused-editor.scaffolded'], body }]
    });

  test('neg in strict: a page still carrying SCAFFOLD-TODO fails', async () => {
    const repoRoot = await entityRepo('scaffold-todo', 'Что это.\n\n## Зачем и когда\n\n<!-- SCAFFOLD-TODO -->');
    const result = await strict(repoRoot);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('SCAFFOLD-TODO placeholder');
  });

  test('neg in strict: a page whose «Зачем и когда» section is empty fails', async () => {
    const repoRoot = await entityRepo('scaffold-empty', 'Что это.\n\n## Зачем и когда\n');
    const result = await strict(repoRoot);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('no non-empty «Зачем и когда» section');
  });

  test('pos: a filled page passes strict — the enforce is not "always fail"', async () => {
    const repoRoot = await entityRepo('scaffold-filled', 'Что это.\n\n## Зачем и когда\n\nПрименяйте, когда нужно X.');
    const result = await strict(repoRoot);
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  });

  test('pos in warn: an unfilled scaffold does not block authoring (strict-only teeth)', async () => {
    const repoRoot = await entityRepo('scaffold-warn', 'Что это.\n\n## Зачем и когда\n\n<!-- SCAFFOLD-TODO -->');
    expect((await warn(repoRoot)).exitCode).toBe(0);
  });
});

describe('control numbers on the REAL tree (§1.7, F-D8-5)', () => {
  const scratch = (name: string): string[] => [
    `--module=${join(TEST_ROOT, `${name}.generated.ts`)}`,
    `--report=${join(TEST_ROOT, `${name}.md`)}`
  ];

  test('`docs:dev` (warn) is GREEN on the real tree with the shipped allowlist', async () => {
    // The group-D working command must be alive from the moment WP-2 lands —
    // this is the real-tree half of the F-D7-1/F-D8-1 blocker.
    const result = await run(REPO_ROOT, '--coverage=warn', ...scratch('real-warn'));
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    expect(Number(metric(result.report, 'Inventory ids \\(commands\\)'))).toBeGreaterThanOrEqual(165);
    expect(metric(result.report, 'Inventory keys \\(preferences\\)')).toBe('22');
    expect(metric(result.report, 'Uncovered')).toBe('0');
  });

  test('`build` (strict) is GREEN on the real tree — the entity universe is covered and blessed', async () => {
    // POST-P3 GREEN (TASK-018 S4/S5). This assertion USED to require a
    // transitional RED, back when the NEW entity universe (prompt fragments,
    // agents, skills) had no content pages yet. The transition is over: P3 (the
    // author-checkpoint) wrote the four entity pages — ai/diagram-author,
    // ai/gv-opponent, ai/gv-essay, contributing/docs-workflow — and blessed
    // their source refs into docs/docs-source-refs.blessed.json, so strict now
    // ships clean. Both universes are green: `Uncovered` === 0 (commands /
    // preferences) AND `Uncovered entities` === 0. A future regression (a new
    // entity landing without a page, or an unblessed ref) is still visible as a
    // diff on this exact assertion, not a silent reinterpretation.
    const result = await run(REPO_ROOT, '--coverage=strict', ...scratch('real-strict'));
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    // The command/preference universe stays green, and entities are now covered.
    expect(metric(result.report, 'Uncovered')).toBe('0');
    expect(metric(result.report, 'Uncovered entities')).toBe('0');
  });

  test('the TASK-010 deferred debt is paid off: zero deferred, and the section stays empty-but-present', async () => {
    // This assertion USED to require `deferred > 0` with one row per id, back
    // when the six TASK-010 pages (tools/git, tools/office, tools/diagrams,
    // tools/mcp, settings, remote) did not exist yet and their 18 ids sat in
    // `coverage-exceptions.jsonc` under `kind:"deferred"`. The transition is
    // over: those six pages are written, WP-13 adjudicated every deferred
    // entry into real coverage, and the allowlist no longer carries any
    // `kind:"deferred"` row. `Deferred to a task` is honestly `0` — not because
    // the debt was hidden (that would be the `exempt`-style lie §2a polices
    // against), but because it was paid. The section HEADER still renders with
    // zero rows, so a future regression (a new deferred entry landing without
    // a page) is still visible as a diff on this exact assertion, not a silent
    // reinterpretation of an empty table.
    const result = await run(REPO_ROOT, '--coverage=warn', ...scratch('real-deferred'));
    const deferred = Number(metric(result.report, 'Deferred to a task'));
    expect(deferred).toBe(0);

    const section = (result.report ?? '').split('## Deferred coverage')[1]?.split('\n## ')[0] ?? '';
    const rows = section.trim().split('\n').slice(2);
    expect(rows).toHaveLength(0);
    for (const row of rows) {
      // Kept for symmetry / future regression: if a deferred entry ever comes
      // back, each row still has to name its owning task by pattern.
      expect(row.split('|')[2]?.trim()).toMatch(/^TASK-\d+$/);
    }
  });

  test('the shipped exception files parse and validate against the real inventory', async () => {
    const result = await run(REPO_ROOT, '--coverage=warn', ...scratch('real-exceptions'));
    expect(result.stderr).not.toContain('stale exception');
    expect(result.stderr).not.toContain('OWN prefix');
    expect(metric(result.report, 'Pending exception requests')).toBe('0');
  });
});
