import { describe, expect, test } from 'bun:test';
import { FileGateway, MultiFilePlan, runTypographyOnFiles } from './multi-file-runner';

/** A fake gateway recording reads and writes, backed by an in-memory map. */
function fakeGateway(initial: Record<string, string>): {
  gateway: FileGateway;
  writes: Array<{ path: string; content: string }>;
  reads: string[];
  content: Record<string, string>;
} {
  const content = { ...initial };
  const writes: Array<{ path: string; content: string }> = [];
  const reads: string[] = [];
  const gateway: FileGateway = {
    read: async path => { reads.push(path); return content[path]; },
    write: async (path, next) => { writes.push({ path, content: next }); content[path] = next; }
  };
  return { gateway, writes, reads, content };
}

/** A run function that appends "!" per non-empty file (deterministic, 1 edit). */
const bang = (text: string) => (text.length > 0 ? { text: `${text}!`, editCount: 1 } : { text, editCount: 0 });

describe('runTypographyOnFiles — mandatory preview/confirm gate (ISS-219)', () => {
  test('CRITICAL: a declined confirmation writes NOTHING', async () => {
    const { gateway, writes } = fakeGateway({ 'a.md': 'aaa', 'b.md': 'bbb' });
    let sawPlan: MultiFilePlan | undefined;
    const result = await runTypographyOnFiles(
      ['a.md', 'b.md'],
      gateway,
      bang,
      async plan => { sawPlan = plan; return false; } // user says NO
    );
    // The gate was shown a real plan…
    expect(sawPlan?.totalFiles).toBe(2);
    expect(sawPlan?.totalEdits).toBe(2);
    // …and NOT ONE write happened.
    expect(writes).toHaveLength(0);
    expect(result.written).toBe(0);
    expect(result.cancelled).toBe(true);
    expect(result.confirmed).toBe(false);
  });

  test('an approved confirmation writes exactly the changed files', async () => {
    const { gateway, writes, content } = fakeGateway({ 'a.md': 'aaa', 'b.md': 'bbb' });
    const result = await runTypographyOnFiles(['a.md', 'b.md'], gateway, bang, async () => true);
    expect(writes.map(w => w.path).sort()).toEqual(['a.md', 'b.md']);
    expect(content['a.md']).toBe('aaa!');
    expect(content['b.md']).toBe('bbb!');
    expect(result.written).toBe(2);
    expect(result.confirmed).toBe(true);
  });

  test('confirm is called AFTER the plan reads and BEFORE any write', async () => {
    const order: string[] = [];
    const gateway: FileGateway = {
      read: async path => { order.push(`read:${path}`); return 'x'; },
      write: async path => { order.push(`write:${path}`); }
    };
    await runTypographyOnFiles(['a.md', 'b.md'], gateway, bang, async () => { order.push('confirm'); return true; });
    // Plan reads, the gate, then a TOCTOU re-read immediately before each write.
    expect(order).toEqual([
      'read:a.md', 'read:b.md',
      'confirm',
      'read:a.md', 'write:a.md',
      'read:b.md', 'write:b.md'
    ]);
    // The invariant, asserted independently of the exact read schedule.
    expect(order.findIndex(step => step.startsWith('write:'))).toBeGreaterThan(order.indexOf('confirm'));
  });

  test('no changed files → no prompt, no write', async () => {
    const { gateway, writes } = fakeGateway({ 'a.md': '', 'b.md': '' });
    let confirmed = false;
    const result = await runTypographyOnFiles(['a.md', 'b.md'], gateway, bang, async () => { confirmed = true; return true; });
    expect(confirmed).toBe(false);
    expect(writes).toHaveLength(0);
    expect(result.planned).toBe(0);
    expect(result.cancelled).toBe(false);
  });

  test('only files that actually change appear in the plan and get written', async () => {
    const { gateway, writes } = fakeGateway({ 'changes.md': 'text', 'empty.md': '' });
    let sawPlan: MultiFilePlan | undefined;
    await runTypographyOnFiles(['changes.md', 'empty.md'], gateway, bang, async plan => { sawPlan = plan; return true; });
    expect(sawPlan?.changes.map(c => c.path)).toEqual(['changes.md']);
    expect(writes.map(w => w.path)).toEqual(['changes.md']);
  });

  test('progress is reported once per written file, after approval', async () => {
    const { gateway } = fakeGateway({ 'a.md': 'aaa', 'b.md': 'bbb' });
    const progress: Array<[number, number]> = [];
    await runTypographyOnFiles(['a.md', 'b.md'], gateway, bang, async () => true, (done, total) => progress.push([done, total]));
    expect(progress).toEqual([[1, 2], [2, 2]]);
  });
});

describe('runTypographyOnFiles — TOCTOU and partial failure (ISS-246)', () => {
  test('CRITICAL: a file edited while the dialog was open is SKIPPED, not clobbered', async () => {
    // `b.md` returns different text on its SECOND read — exactly what happens when
    // an autosave or another tool rewrites the file while the user reads the preview.
    const content: Record<string, string> = { 'a.md': 'aaa', 'b.md': 'bbb', 'c.md': 'ccc' };
    const readCounts: Record<string, number> = {};
    const writes: Array<{ path: string; content: string }> = [];
    const gateway: FileGateway = {
      read: async path => {
        readCounts[path] = (readCounts[path] ?? 0) + 1;
        if (path === 'b.md' && readCounts[path] > 1) {
          return 'bbb EDITED BY SOMEONE ELSE';
        }
        return content[path];
      },
      write: async (path, next) => { writes.push({ path, content: next }); content[path] = next; }
    };

    const result = await runTypographyOnFiles(['a.md', 'b.md', 'c.md'], gateway, bang, async () => true);

    // The drifted file was NOT written — the other user's edit survives verbatim.
    expect(writes.map(w => w.path)).toEqual(['a.md', 'c.md']);
    expect(content['b.md']).toBe('bbb');
    // …and it is reported, not swallowed.
    expect(result.skipped).toBe(1);
    expect(result.skippedPaths).toEqual(['b.md']);
    expect(result.written).toBe(2);
    expect(result.planned).toBe(3);
    // The preview promised 3 edits; only 2 landed, and the result says so.
    expect(result.totalEdits).toBe(3);
    expect(result.writtenEdits).toBe(2);
    expect(result.failed).toBe(0);
  });

  test('an unchanged file is still written (the TOCTOU guard is not a blanket refusal)', async () => {
    const { gateway, writes, content } = fakeGateway({ 'a.md': 'aaa' });
    const result = await runTypographyOnFiles(['a.md'], gateway, bang, async () => true);
    expect(writes.map(w => w.path)).toEqual(['a.md']);
    expect(content['a.md']).toBe('aaa!');
    expect(result.skipped).toBe(0);
    expect(result.writtenEdits).toBe(1);
  });

  test('a write that throws mid-run does NOT abort the batch; the rest still apply', async () => {
    const content: Record<string, string> = { 'a.md': 'aaa', 'b.md': 'bbb', 'c.md': 'ccc' };
    const writes: string[] = [];
    const gateway: FileGateway = {
      read: async path => content[path],
      write: async (path, next) => {
        if (path === 'b.md') {
          throw new Error('EACCES: read-only file system');
        }
        writes.push(path);
        content[path] = next;
      }
    };

    const result = await runTypographyOnFiles(['a.md', 'b.md', 'c.md'], gateway, bang, async () => true);

    // No throw escaped, and the file AFTER the failure was still processed.
    expect(writes).toEqual(['a.md', 'c.md']);
    expect(content['c.md']).toBe('ccc!');
    expect(result.written).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.failedPaths).toEqual(['b.md']);
    expect(result.skipped).toBe(0);
    expect(result.writtenEdits).toBe(2);
    expect(result.confirmed).toBe(true);
  });

  test('a re-read that throws is a failure, not a silent write of the stale snapshot', async () => {
    const content: Record<string, string> = { 'a.md': 'aaa', 'b.md': 'bbb' };
    const readCounts: Record<string, number> = {};
    const writes: string[] = [];
    const gateway: FileGateway = {
      read: async path => {
        readCounts[path] = (readCounts[path] ?? 0) + 1;
        if (path === 'a.md' && readCounts[path] > 1) {
          throw new Error('ENOENT: file was deleted');
        }
        return content[path];
      },
      write: async (path, next) => { writes.push(path); content[path] = next; }
    };

    const result = await runTypographyOnFiles(['a.md', 'b.md'], gateway, bang, async () => true);

    expect(writes).toEqual(['b.md']);
    expect(result.failedPaths).toEqual(['a.md']);
    expect(result.written).toBe(1);
  });

  test('a declined confirmation still writes NOTHING and does no re-reads', async () => {
    const reads: string[] = [];
    const writes: string[] = [];
    const gateway: FileGateway = {
      read: async path => { reads.push(path); return 'x'; },
      write: async path => { writes.push(path); }
    };
    const result = await runTypographyOnFiles(['a.md', 'b.md'], gateway, bang, async () => false);
    expect(writes).toHaveLength(0);
    expect(reads).toEqual(['a.md', 'b.md']); // plan reads only — no verify pass
    expect(result.cancelled).toBe(true);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.writtenEdits).toBe(0);
  });

  test('F-D5-3: an unreadable file in phase 1 does NOT abort the preview for the rest', async () => {
    // `b.md` throws on every read (permissions error, deleted file, whatever) —
    // exactly the "one nechitaemy file out of forty" scenario from the DA
    // finding. The preview must still form over `a.md` and `c.md`, and `b.md`
    // must be named as the culprit rather than silently swallowing the whole
    // run before the user ever sees a plan.
    const content: Record<string, string> = { 'a.md': 'aaa', 'c.md': 'ccc' };
    const gateway: FileGateway = {
      read: async path => {
        if (path === 'b.md') {
          throw new Error('EACCES: permission denied');
        }
        return content[path];
      },
      write: async (path, next) => { content[path] = next; }
    };

    let sawPlan: MultiFilePlan | undefined;
    const result = await runTypographyOnFiles(
      ['a.md', 'b.md', 'c.md'],
      gateway,
      bang,
      async plan => { sawPlan = plan; return true; }
    );

    // The preview formed over the two READABLE files — b.md never blocked it.
    expect(sawPlan?.changes.map(c => c.path)).toEqual(['a.md', 'c.md']);
    expect(content['a.md']).toBe('aaa!');
    expect(content['c.md']).toBe('ccc!');
    // b.md is named as failed, not silently dropped.
    expect(result.failed).toBe(1);
    expect(result.failedPaths).toEqual(['b.md']);
    expect(result.planned).toBe(2);
    expect(result.written).toBe(2);
  });

  test('F-D5-3: an unreadable file among files with NO changes still returns a clean early result', async () => {
    const gateway: FileGateway = {
      read: async path => {
        if (path === 'broken.md') {
          throw new Error('ENOENT');
        }
        return '';
      },
      write: async () => { throw new Error('must not be called'); }
    };
    let confirmed = false;
    const result = await runTypographyOnFiles(
      ['empty.md', 'broken.md'],
      gateway,
      bang,
      async () => { confirmed = true; return true; }
    );
    expect(confirmed).toBe(false); // nothing changes among the readable files → no prompt
    expect(result.planned).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.failedPaths).toEqual(['broken.md']);
  });

  test('progress counts only files that actually landed', async () => {
    const content: Record<string, string> = { 'a.md': 'aaa', 'b.md': 'bbb', 'c.md': 'ccc' };
    const readCounts: Record<string, number> = {};
    const progress: Array<[number, number, string]> = [];
    const gateway: FileGateway = {
      read: async path => {
        readCounts[path] = (readCounts[path] ?? 0) + 1;
        return path === 'b.md' && readCounts[path] > 1 ? 'drifted' : content[path];
      },
      write: async (path, next) => { content[path] = next; }
    };
    await runTypographyOnFiles(
      ['a.md', 'b.md', 'c.md'],
      gateway,
      bang,
      async () => true,
      (done, total, path) => progress.push([done, total, path])
    );
    expect(progress).toEqual([[1, 3, 'a.md'], [2, 3, 'c.md']]);
  });
});
