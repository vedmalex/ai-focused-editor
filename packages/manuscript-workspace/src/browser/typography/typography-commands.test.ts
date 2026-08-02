import { describe, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';

/**
 * DOM bootstrap — MUST run before the Theia browser modules load (same rationale
 * and shape as `auto-typography-contribution.test.ts`): the command contribution
 * transitively imports monaco, `@theia/navigator` and `ConfirmDialog`, all of
 * which touch `document` at MODULE-EVALUATION time, and static ESM imports hoist
 * above any setup — so the imports below are DYNAMIC and deliberately sequenced
 * after this bootstrap.
 *
 * TEST LANE: this bootstrap installs PROCESS-WIDE DOM globals, which collide
 * with the `test:widget` suites (they build a fresh `Window` per test). The whole
 * `browser/typography` directory therefore runs in its own `test:typography` lane
 * (root package.json) and is excluded from `test:packages`.
 */
const domWindow = new Window() as unknown as Record<string, unknown>;
const globals = globalThis as unknown as Record<string, unknown>;
globals.window = domWindow;
globals.self = domWindow;
for (const name of Object.getOwnPropertyNames(domWindow)) {
  if (globals[name] !== undefined) {
    continue;
  }
  try {
    const value = domWindow[name];
    if (value !== undefined) {
      globals[name] = value;
    }
  } catch {
    // Some happy-dom accessors throw when read out of context — skip them.
  }
}

const { FrontendApplicationConfigProvider } = await import('@theia/core/lib/browser/frontend-application-config-provider');
FrontendApplicationConfigProvider.set({} as never);

const { default: URI } = await import('@theia/core/lib/common/uri');
// `@theia/monaco/lib/browser/*` is CJS and `require`s monaco synchronously, which
// Bun refuses for an async ESM module unless it is already resolved — so pull the
// monaco ESM entry in explicitly before anything that transitively requires it.
await import('@theia/monaco-editor-core');
await import('@theia/monaco/lib/browser/monaco-editor');
const { ConfirmDialog } = await import('@theia/core/lib/browser');
const { TypographyCommandContribution } = await import('./typography-commands');

type MultiFilePlan = import('../../common/typography/multi-file-runner').MultiFilePlan;
type TextRunResultType = import('../../common/typography/text-runner').TextRunResult;

/**
 * DST for the MULTI-FILE typography batch (TASK-019 W2, QA/ISS-254).
 *
 * `runTypographyOnFiles` is pure and well covered, but it only ever proves
 * "given these paths and this confirm callback, nothing is written without a
 * yes". Every risk that actually makes this command dangerous lives OUTSIDE it,
 * in `TypographyCommandContribution.applyToFiles`, and NONE of it had a test:
 *
 *  - dirty (unsaved) buffers must be EXCLUDED from the run — writing through the
 *    FileService past an open editor silently destroys unsaved work (ISS-246);
 *  - the MULTI_FILE_MAX ceiling must abort BEFORE a single read or write;
 *  - the `byPath` string→URI map is what turns the runner's opaque path keys back
 *    into real files — a miss feeds `undefined` to the FileService;
 *  - the confirm callback handed to the runner must be the REAL preview dialog,
 *    not a stub that always says yes.
 *
 * This suite drives the real `applyToFiles` against doubles for its four ports
 * (FileService, EditorManager, the enabled-rules source, the batch runner) and
 * observes only production-visible effects: which URIs were read, which were
 * written, and what the user was told. Writes here are git-only reversible in
 * production, so "no write happened" is asserted directly on the FileService
 * double, never on a flag the contribution sets.
 */

interface Recorded {
  reads: string[];
  writes: Array<{ uri: string; content: string }>;
  resolves: string[];
  warns: string[];
  infos: string[];
}

interface FsNode {
  /** Directory children (as absolute posix paths); undefined ⇒ a file. */
  children?: string[];
  /** File content; only meaningful for files. */
  content?: string;
}

class CommandsHarness extends TypographyCommandContribution {
  /** Every plan the production wiring handed to the confirm callback. */
  readonly confirmedPlans: MultiFilePlan[] = [];
  /** The `byPath` map the production wiring passed alongside the plan. */
  lastByPath?: Map<string, InstanceType<typeof URI>>;
  /** What the (overridden) dialog answers. */
  confirmResult = true;
  /** Stand-in for the active Monaco control; undefined ⇒ "no editor open". */
  fakeControl: unknown = { getModel: () => ({}) };

  protected override activeControl(): any {
    return this.fakeControl as any;
  }

  protected override async confirmMultiFile(
    plan: MultiFilePlan,
    byPath: Map<string, InstanceType<typeof URI>>
  ): Promise<boolean> {
    this.confirmedPlans.push(plan);
    this.lastByPath = byPath;
    return this.confirmResult;
  }
}

interface HarnessOptions {
  /** Virtual filesystem keyed by absolute posix path. */
  fs: Record<string, FsNode>;
  /** Paths of editors open with UNSAVED changes. */
  dirty?: string[];
  /** Paths of editors open and SAVED (must NOT be excluded). */
  clean?: string[];
  /** Rule ids the live seam reports as enabled. */
  enabledIds?: string[];
  /** Overrides the per-file batch result (defaults to a converged 1-edit run). */
  runOnText?: (text: string) => TextRunResultType;
  /** What the open-buffer `TypographyBatchService.applyTo` reports back. */
  batchResult?: { applied: number; passes: number; converged: boolean };
}

function fileUri(path: string): InstanceType<typeof URI> {
  return new URI(`file://${path}`);
}

function harness(options: HarnessOptions): { contribution: CommandsHarness; rec: Recorded } {
  const rec: Recorded = { reads: [], writes: [], resolves: [], warns: [], infos: [] };

  const fileService: any = {
    resolve: async (uri: InstanceType<typeof URI>) => {
      const path = uri.path.toString();
      rec.resolves.push(path);
      const node = options.fs[path];
      if (!node) {
        throw new Error(`ENOENT: ${path}`);
      }
      return node.children
        ? { isDirectory: true, children: node.children.map(child => ({ resource: fileUri(child) })) }
        : { isDirectory: false };
    },
    read: async (uri: InstanceType<typeof URI>) => {
      // A `byPath` MISS would arrive here as `undefined` and blow up on `.path`
      // — deliberately NOT defended against, so a mapping bug is loud (ISS-254).
      const path = uri.path.toString();
      rec.reads.push(path);
      const node = options.fs[path];
      if (!node || node.content === undefined) {
        throw new Error(`ENOENT: ${path}`);
      }
      return { value: node.content };
    },
    write: async (uri: InstanceType<typeof URI>, content: string) => {
      const path = uri.path.toString();
      rec.writes.push({ uri: path, content });
      options.fs[path] = { content };
    }
  };

  const editorWidget = (path: string, dirty: boolean) => ({
    editor: { uri: fileUri(path), document: { dirty } }
  });
  const editorManager: any = {
    all: [
      ...(options.dirty ?? []).map(path => editorWidget(path, true)),
      ...(options.clean ?? []).map(path => editorWidget(path, false))
    ]
  };

  const auto: any = {
    getEnabledRuleIds: () => new Set(options.enabledIds ?? ['collapse-multiple-spaces']),
    getLocale: () => 'ru'
  };

  const defaultRun = (text: string): TextRunResultType =>
    (text.length > 0
      ? { text: `${text}!`, editCount: 1, passes: 2, converged: true }
      : { text, editCount: 0, passes: 1, converged: true });
  const batch: any = {
    runOnText: (text: string) => (options.runOnText ?? defaultRun)(text),
    applyTo: () => options.batchResult ?? { applied: 0, passes: 1, converged: true }
  };

  const messages: any = {
    warn: (message: string) => { rec.warns.push(message); return Promise.resolve(undefined); },
    info: (message: string) => { rec.infos.push(message); return Promise.resolve(undefined); }
  };

  const contribution = new CommandsHarness();
  Object.assign(contribution as unknown as Record<string, unknown>, {
    fileService,
    editorManager,
    auto,
    batch,
    messages
  });
  return { contribution, rec };
}

/** Run the production `applyToFiles` entry point over the given selection. */
function applyToFiles(contribution: CommandsHarness, paths: string[]): Promise<void> {
  return (contribution as any).applyToFiles(paths.map(fileUri));
}

describe('applyToFiles — dirty buffers are EXCLUDED, never written past (ISS-246, ISS-254)', () => {
  test('CRITICAL: a file open with unsaved changes is never read and never written', async () => {
    const { contribution, rec } = harness({
      fs: { '/book/a.md': { content: 'aaa' }, '/book/b.md': { content: 'bbb' } },
      dirty: ['/book/a.md']
    });

    await applyToFiles(contribution, ['/book/a.md', '/book/b.md']);

    // The dirty file never reached the gateway at all — not the preview read,
    // not the TOCTOU re-read, and certainly not the write.
    expect(rec.reads).not.toContain('/book/a.md');
    expect(rec.writes.map(write => write.uri)).toEqual(['/book/b.md']);
    // The user's unsaved work is intact on disk.
    expect(rec.writes.map(write => write.uri)).not.toContain('/book/a.md');
    // …and the user was TOLD, with the right count (silently dropping files
    // would look like the command simply ignored them).
    expect(rec.warns.some(warn => warn.includes('skipped 1 file(s) with unsaved changes'))).toBe(true);
  });

  test('a SAVED open editor is NOT excluded (the filter keys on dirty, not on "open")', async () => {
    const { contribution, rec } = harness({
      fs: { '/book/a.md': { content: 'aaa' } },
      clean: ['/book/a.md']
    });

    await applyToFiles(contribution, ['/book/a.md']);

    expect(rec.writes.map(write => write.uri)).toEqual(['/book/a.md']);
    expect(rec.warns.some(warn => warn.includes('unsaved changes'))).toBe(false);
  });

  test('when EVERY selected file is dirty the run stops: no preview, no read, no write', async () => {
    const { contribution, rec } = harness({
      fs: { '/book/a.md': { content: 'aaa' } },
      dirty: ['/book/a.md']
    });

    await applyToFiles(contribution, ['/book/a.md']);

    expect(rec.reads).toHaveLength(0);
    expect(rec.writes).toHaveLength(0);
    expect(contribution.confirmedPlans).toHaveLength(0);
    expect(rec.warns.some(warn => warn.includes('unsaved changes'))).toBe(true);
  });
});

describe('applyToFiles — the MULTI_FILE_MAX ceiling aborts before any I/O (ISS-254, ISS-258)', () => {
  /** A folder holding `count` markdown files. */
  function folderOf(count: number): Record<string, FsNode> {
    const paths = Array.from({ length: count }, (_, i) => `/book/ch-${i}.md`);
    const fs: Record<string, FsNode> = { '/book': { children: paths } };
    for (const path of paths) {
      fs[path] = { content: 'text' };
    }
    return fs;
  }

  test('CRITICAL: a selection over the cap performs NOT ONE read and NOT ONE write', async () => {
    const { contribution, rec } = harness({ fs: folderOf(600) });

    await applyToFiles(contribution, ['/book']);

    expect(rec.reads).toHaveLength(0);
    expect(rec.writes).toHaveLength(0);
    expect(contribution.confirmedPlans).toHaveLength(0);
  });

  test('ISS-258: the warning does NOT claim a count the walk never measured', async () => {
    // `collectMarkdownFiles` aborts one past the ceiling, so the collected length
    // is ALWAYS 501 no matter how large the selection. The old message printed it
    // verbatim, telling a user with 5000 files that they had selected "501".
    const small = harness({ fs: folderOf(600) });
    await applyToFiles(small.contribution, ['/book']);
    const huge = harness({ fs: folderOf(5000) });
    await applyToFiles(huge.contribution, ['/book']);

    const smallWarning = small.rec.warns.find(warn => warn.includes('Narrow the selection'));
    const hugeWarning = huge.rec.warns.find(warn => warn.includes('Narrow the selection'));
    expect(smallWarning).toBeDefined();
    // Identical selections of wildly different sizes get the same honest text…
    expect(hugeWarning).toBe(smallWarning!);
    // …which states the LIMIT (the only number we know) and never the phantom 501.
    expect(smallWarning).toContain('more than 500 Markdown files');
    expect(smallWarning).not.toContain('501');
    expect(smallWarning).not.toContain('5000');
  });

  test('a selection AT the cap is processed normally (the guard is a ceiling, not an off-by-one)', async () => {
    const { contribution, rec } = harness({ fs: folderOf(500) });

    await applyToFiles(contribution, ['/book']);

    expect(contribution.confirmedPlans).toHaveLength(1);
    expect(rec.writes).toHaveLength(500);
    expect(rec.warns.some(warn => warn.includes('Narrow the selection'))).toBe(false);
  });

  /**
   * ISS-260. The ceiling used to be tested on `files.length` AFTER dirty buffers
   * were filtered out. Because `collectMarkdownFiles` aborts its walk at exactly
   * MULTI_FILE_MAX + 1, removing even ONE dirty file dropped the set to exactly
   * MULTI_FILE_MAX — under the ceiling, warning suppressed. The user then got
   * "wrote 500 file(s)" for a selection of 5000, with 4500 chapters silently
   * never visited. The signal has to come from the WALK, which is the only thing
   * that knows it stopped early; no post-filter count can reconstruct it.
   */
  test('CRITICAL: an over-cap selection still warns when a dirty buffer trims it back under the cap', async () => {
    const { contribution, rec } = harness({ fs: folderOf(600), dirty: ['/book/ch-0.md'] });

    await applyToFiles(contribution, ['/book']);

    // The cap warning is issued…
    expect(rec.warns.some(warn => warn.includes('more than 500 Markdown files'))).toBe(true);
    // …and it still aborts before ANY I/O, exactly as for a selection that no
    // dirty buffer happened to trim.
    expect(rec.reads).toHaveLength(0);
    expect(rec.writes).toHaveLength(0);
    expect(contribution.confirmedPlans).toHaveLength(0);
  });

  test('the truncation warning survives a dirty set large enough to hide it entirely', async () => {
    // 100 dirty files would leave 401 — comfortably under the ceiling, so the
    // old ordering had no chance of noticing.
    const dirty = Array.from({ length: 100 }, (_, i) => `/book/ch-${i}.md`);
    const { contribution, rec } = harness({ fs: folderOf(5000), dirty });

    await applyToFiles(contribution, ['/book']);

    expect(rec.warns.some(warn => warn.includes('more than 500 Markdown files'))).toBe(true);
    expect(rec.writes).toHaveLength(0);
  });

  test('ANTI-TAUTOLOGY: an UNDER-cap selection with a dirty buffer is not mistaken for truncation', async () => {
    const { contribution, rec } = harness({ fs: folderOf(10), dirty: ['/book/ch-0.md'] });

    await applyToFiles(contribution, ['/book']);

    expect(rec.warns.some(warn => warn.includes('Narrow the selection'))).toBe(false);
    // The dirty file is still excluded and reported, and the rest are written.
    expect(rec.warns.some(warn => warn.includes('skipped 1 file(s) with unsaved changes'))).toBe(true);
    expect(rec.writes).toHaveLength(9);
  });
});

describe('applyToActiveFile — an unfinished open-buffer run is not reported as success (ISS-259)', () => {
  /**
   * The open-buffer counterpart of ISS-255. `TypographyBatchService.applyTo` can
   * stop on BATCH_MAX_PASSES with fixes still pending, leaving the buffer in an
   * intermediate state; the command used to see only an edit count and announce
   * "applied N fix(es)" — a clean success message over a truncated run.
   */
  test('CRITICAL: a non-converged run warns as well as counting', async () => {
    const { contribution, rec } = harness({
      fs: {},
      batchResult: { applied: 8, passes: 8, converged: false }
    });

    (contribution as any).applyToActiveFile();

    // The count is still reported — a partial run is not a lost run…
    expect(rec.infos.some(info => info.includes('applied 8 fix(es)'))).toBe(true);
    // …but the user is told it did not finish.
    expect(rec.warns.some(warn => warn.includes('still pending when the pass limit was reached'))).toBe(true);
  });

  test('ANTI-TAUTOLOGY: a converged run emits the count and NO warning', async () => {
    const { contribution, rec } = harness({
      fs: {},
      batchResult: { applied: 3, passes: 2, converged: true }
    });

    (contribution as any).applyToActiveFile();

    expect(rec.infos.some(info => info.includes('applied 3 fix(es)'))).toBe(true);
    expect(rec.warns).toHaveLength(0);
  });

  test('a clean buffer says "nothing to fix" and does not warn', async () => {
    const { contribution, rec } = harness({
      fs: {},
      batchResult: { applied: 0, passes: 1, converged: true }
    });

    (contribution as any).applyToActiveFile();

    expect(rec.infos.some(info => info.includes('nothing to fix'))).toBe(true);
    expect(rec.warns).toHaveLength(0);
  });

  test('zero edits with work still outstanding is a WARNING, never "nothing to fix"', async () => {
    // The model refused every write: no fix landed, yet the document is not
    // clean. Announcing "nothing to fix" here would be an outright lie.
    const { contribution, rec } = harness({
      fs: {},
      batchResult: { applied: 0, passes: 8, converged: false }
    });

    (contribution as any).applyToActiveFile();

    expect(rec.infos.some(info => info.includes('nothing to fix'))).toBe(false);
    expect(rec.warns.some(warn => warn.includes('still pending when the pass limit was reached'))).toBe(true);
  });
});

describe('applyToFiles — the confirmation gate reaches the real FileService (ISS-219, ISS-254)', () => {
  test('CRITICAL: a declined confirmation calls FileService.write ZERO times', async () => {
    const { contribution, rec } = harness({
      fs: { '/book/a.md': { content: 'aaa' }, '/book/b.md': { content: 'bbb' } }
    });
    contribution.confirmResult = false;

    await applyToFiles(contribution, ['/book/a.md', '/book/b.md']);

    // The gate really was reached with a real plan…
    expect(contribution.confirmedPlans).toHaveLength(1);
    expect(contribution.confirmedPlans[0].totalFiles).toBe(2);
    // …the preview reads happened…
    expect(rec.reads.sort()).toEqual(['/book/a.md', '/book/b.md']);
    // …and NOTHING was written through the real port.
    expect(rec.writes).toHaveLength(0);
    expect(rec.infos.some(info => info.includes('cancelled'))).toBe(true);
  });

  test('an approved confirmation writes the transformed content through the FileService', async () => {
    const { contribution, rec } = harness({
      fs: { '/book/a.md': { content: 'aaa' }, '/book/b.md': { content: 'bbb' } }
    });

    await applyToFiles(contribution, ['/book/a.md', '/book/b.md']);

    expect(rec.writes).toEqual([
      { uri: '/book/a.md', content: 'aaa!' },
      { uri: '/book/b.md', content: 'bbb!' }
    ]);
    expect(rec.infos.some(info => info.includes('wrote 2 file(s), 2 fix(es) total'))).toBe(true);
  });

  test('no enabled rules → the command stops before touching the filesystem', async () => {
    const { contribution, rec } = harness({
      fs: { '/book/a.md': { content: 'aaa' } },
      enabledIds: []
    });

    await applyToFiles(contribution, ['/book/a.md']);

    expect(rec.resolves).toHaveLength(0);
    expect(rec.reads).toHaveLength(0);
    expect(rec.writes).toHaveLength(0);
  });
});

describe('applyToFiles — path→URI mapping survives nested folders (ISS-254)', () => {
  test('CRITICAL: identically-named files in different folders map back to the RIGHT URIs', async () => {
    // The runner works in opaque string keys; `byPath` is the only thing that
    // turns them back into files. Same basename, different folders, different
    // content: a miss or a collision writes one chapter's text over another's.
    const { contribution, rec } = harness({
      fs: {
        '/book': { children: ['/book/part-01', '/book/part-02'] },
        '/book/part-01': { children: ['/book/part-01/chapter-02.md'] },
        '/book/part-02': { children: ['/book/part-02/chapter-02.md'] },
        '/book/part-01/chapter-02.md': { content: 'one' },
        '/book/part-02/chapter-02.md': { content: 'two' }
      }
    });

    await applyToFiles(contribution, ['/book']);

    // Both nested files were discovered by the recursive walk…
    expect(rec.writes.map(write => write.uri).sort()).toEqual([
      '/book/part-01/chapter-02.md',
      '/book/part-02/chapter-02.md'
    ]);
    // …and each got ITS OWN transformed content, not the sibling's.
    const written = new Map(rec.writes.map(write => [write.uri, write.content]));
    expect(written.get('/book/part-01/chapter-02.md')).toBe('one!');
    expect(written.get('/book/part-02/chapter-02.md')).toBe('two!');

    // The map handed to the dialog resolves every planned path to a real URI —
    // this is what the preview labels are rendered from.
    const byPath = contribution.lastByPath!;
    for (const change of contribution.confirmedPlans[0].changes) {
      expect(byPath.get(change.path)).toBeDefined();
      expect(byPath.get(change.path)!.toString()).toBe(change.path);
    }
  });

  test('non-markdown files and unreadable entries are dropped by the walk, not by a later guard', async () => {
    const { contribution, rec } = harness({
      fs: {
        '/book': { children: ['/book/a.md', '/book/cover.png', '/book/notes.txt', '/book/gone.md'] },
        '/book/a.md': { content: 'aaa' },
        '/book/cover.png': { content: 'binary' },
        '/book/notes.txt': { content: 'text' }
        // `/book/gone.md` is missing from the fs: `resolve` throws for it.
      }
    });

    await applyToFiles(contribution, ['/book']);

    expect(rec.reads).toEqual(['/book/a.md', '/book/a.md']); // preview + TOCTOU re-read
    expect(rec.writes.map(write => write.uri)).toEqual(['/book/a.md']);
  });
});

describe('applyToFiles — a non-converged file is reported, not passed off as done (ISS-255)', () => {
  test('a file whose rules never reached a fixpoint produces an explicit warning', async () => {
    const { contribution, rec } = harness({
      fs: { '/book/a.md': { content: 'aaa' } },
      runOnText: text => ({ text: `${text}!`, editCount: 8, passes: 8, converged: false })
    });

    await applyToFiles(contribution, ['/book/a.md']);

    // The write still lands (a half-fixed file is better than a lost run)…
    expect(rec.writes.map(write => write.uri)).toEqual(['/book/a.md']);
    // …but it is NOT reported as a plain success.
    expect(rec.warns.some(warn => warn.includes('1 file(s) still had pending fixes'))).toBe(true);
  });

  test('ANTI-TAUTOLOGY: a converged run emits no such warning', async () => {
    const { contribution, rec } = harness({ fs: { '/book/a.md': { content: 'aaa' } } });

    await applyToFiles(contribution, ['/book/a.md']);

    expect(rec.writes).toHaveLength(1);
    expect(rec.warns.some(warn => warn.includes('pending fixes'))).toBe(false);
  });
});

describe('confirmMultiFile — the production callback IS the preview dialog (ISS-219, ISS-254)', () => {
  /**
   * Every test above overrides `confirmMultiFile`, which proves the WIRING but
   * not that the un-overridden method opens a real, blocking dialog. Without
   * this case a refactor that replaced the dialog with `async () => true` would
   * leave the whole suite green while removing the only thing standing between a
   * mis-click and an unrecoverable multi-file write.
   */
  const plan: MultiFilePlan = {
    changes: [{ path: 'file:///book/part-01/chapter-02.md', editCount: 3 }],
    totalFiles: 1,
    totalEdits: 3
  };
  const byPath = new Map([['file:///book/part-01/chapter-02.md', fileUri('/book/part-01/chapter-02.md')]]);

  test('it constructs a ConfirmDialog and returns the user\'s answer', async () => {
    const open = spyOn(ConfirmDialog.prototype, 'open').mockResolvedValue(true as never);
    try {
      const contribution = new TypographyCommandContribution();
      const approved = await (contribution as any).confirmMultiFile(plan, byPath);
      expect(open).toHaveBeenCalledTimes(1);
      expect(approved).toBe(true);
    } finally {
      open.mockRestore();
    }
  });

  test('a dismissed dialog (undefined) is a NO, not a truthy default', async () => {
    // `ConfirmDialog.open()` resolves `undefined` when the dialog is closed via
    // Escape or the window chrome — that MUST map to false.
    const open = spyOn(ConfirmDialog.prototype, 'open').mockResolvedValue(undefined as never);
    try {
      const contribution = new TypographyCommandContribution();
      expect(await (contribution as any).confirmMultiFile(plan, byPath)).toBe(false);
    } finally {
      open.mockRestore();
    }
  });

  test('the dialog text names the file, its edit count, and the git-only warning', async () => {
    let captured: { title: string; msg: HTMLElement; ok: string } | undefined;
    const open = spyOn(ConfirmDialog.prototype, 'open').mockImplementation(function (this: any) {
      captured = { title: this.title ?? '', msg: this.contentNode ?? this.msg, ok: '' };
      return Promise.resolve(false) as never;
    } as never);
    try {
      const contribution = new TypographyCommandContribution();
      await (contribution as any).confirmMultiFile(plan, byPath);
    } finally {
      open.mockRestore();
    }
    expect(captured).toBeDefined();
    const rendered = (captured!.msg?.textContent ?? '') as string;
    expect(rendered).toContain('chapter-02.md');
    expect(rendered).toContain('3');
    // The manuscript-safety sentence is the whole point of the gate.
    expect(rendered).toContain('git');
  });
});
