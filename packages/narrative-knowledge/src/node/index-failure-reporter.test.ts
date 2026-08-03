/**
 * The four teeth of tech_spec ОВ-8, three of which live here (the fourth — one
 * localized key per failure code — is in `i18n/narrative-memory-ru-bundle.test.ts`,
 * beside the bundle it checks).
 */

import { describe, expect, test } from 'bun:test';
import { relative } from 'node:path';
import { INDEX_FAILURE_CODES } from '../common';
import { IndexFailureReporter, type IndexFailureLogEntry } from './index-failure-reporter';

const WORKSPACE = '/Users/nadia/manuscripts/mahabharata';

function makeReporter(): { reporter: IndexFailureReporter; log: IndexFailureLogEntry[] } {
  const log: IndexFailureLogEntry[] = [];
  let counter = 0;
  const reporter = new IndexFailureReporter({
    workspaceRoot: WORKSPACE,
    log: entry => log.push(entry),
    newIncidentId: () => `inc-${++counter}`
  });
  return { reporter, log };
}

/** A Node-shaped filesystem error: a `code`, a `path`, and a `message` that
 *  spells the absolute path out in full — which is what real ones do. */
function fsError(code: string, path: string): NodeJS.ErrnoException {
  const error = new Error(`${code}: no such file or directory, open '${path}'`) as NodeJS.ErrnoException;
  error.code = code;
  error.path = path;
  return error;
}

describe('ОВ-8 tooth 1 — nothing identifying survives to the wire', () => {
  // THE MAIN REJECTING CASE. Asserted on the SERIALIZED payload rather than on
  // the object, so that a non-enumerable or accidentally-attached field cannot
  // hide from the check.
  test('an absolute path in the message leaves no trace in JSON.stringify(reason)', () => {
    const { reporter } = makeReporter();
    const reason = reporter.report(fsError('EACCES', `${WORKSPACE}/chapters/01.md`));
    const serialized = JSON.stringify(reason);

    expect(serialized).not.toContain('/Users/');
    expect(serialized).not.toContain('nadia');
    expect(serialized).not.toContain('no such file');
    // And it is not empty of information either: the useful, safe part is there.
    expect(reason.relPath).toBe('chapters/01.md');
    expect(reason.code).toBe('permission-denied');
  });

  test('the message and stack go to the log — dropped from the wire, not dropped', () => {
    const { reporter, log } = makeReporter();
    const reason = reporter.report(fsError('EACCES', `${WORKSPACE}/chapters/01.md`));

    expect(log).toHaveLength(1);
    expect(log[0].incidentId).toBe(reason.incidentId);
    expect(log[0].absolutePath).toBe(`${WORKSPACE}/chapters/01.md`);
    expect(log[0].message).toContain('/Users/nadia');
    expect(log[0].stack).toBeDefined();
  });

  test('a non-Error throw is sanitized too', () => {
    const { reporter, log } = makeReporter();
    const reason = reporter.report(`boom at ${WORKSPACE}/secret.md`);
    expect(JSON.stringify(reason)).not.toContain('/Users/');
    expect(log[0].message).toContain('/Users/nadia');
  });
});

describe('ОВ-8 tooth 2 — outside the workspace means ABSENT, not ../..', () => {
  test('a file outside the workspace yields no relPath at all', () => {
    const { reporter } = makeReporter();
    const reason = reporter.report(fsError('EACCES', '/Users/nadia/.ssh/id_rsa'));

    expect(reason.relPath).toBeUndefined();
    expect('relPath' in reason).toBe(false);
    expect(JSON.stringify(reason)).not.toContain('..');
    expect(JSON.stringify(reason)).not.toContain('nadia');
  });

  // The rejecting case for the DECISION: a reporter that merely relativized
  // would have produced a usable trail back to the home directory.
  test('plain relativization WOULD have leaked the shape — which is why it is dropped', () => {
    const naive = relative(WORKSPACE, '/Users/nadia/.ssh/id_rsa');
    expect(naive.startsWith('..')).toBe(true);
    expect(naive).toContain('.ssh');
  });

  test('the workspace root itself yields no relPath either — a blank filename is worse than none', () => {
    const { reporter } = makeReporter();
    expect(reporter.report(fsError('EACCES', WORKSPACE)).relPath).toBeUndefined();
  });
});

describe('ОВ-8 tooth 4 — an unknown errno becomes internal AND is logged', () => {
  // BOTH assertions, not one. A collapse to `internal` without a log line is a
  // code nobody will ever add, because nobody will ever see it.
  test('an unrecognised code collapses to internal and names itself in the log', () => {
    const { reporter, log } = makeReporter();
    const reason = reporter.report(fsError('EMFILE', `${WORKSPACE}/chapters/01.md`));

    expect(reason.code).toBe('internal');
    expect(log).toHaveLength(1);
    expect(log[0].code).toBe('internal');
    expect(log[0].unmappedCode).toBe('EMFILE');
  });

  test('a recognised code does NOT report itself as unmapped', () => {
    const { reporter, log } = makeReporter();
    expect(reporter.report(fsError('ENOSPC', `${WORKSPACE}/x.db`)).code).toBe('disk-full');
    expect(log[0].unmappedCode).toBeUndefined();
  });

  test('the whole recognised mapping, one case each', () => {
    const { reporter } = makeReporter();
    const mapped = (code: string) => reporter.report(fsError(code, `${WORKSPACE}/x.db`)).code;

    expect(mapped('ENOSPC')).toBe('disk-full');
    expect(mapped('EACCES')).toBe('permission-denied');
    expect(mapped('EPERM')).toBe('permission-denied');
    expect(mapped('SQLITE_CORRUPT')).toBe('storage-corrupted');
    expect(mapped('SQLITE_NOTADB')).toBe('storage-corrupted');
    expect(mapped('SQLITE_CANTOPEN')).toBe('storage-unavailable');
  });

  test('every code the reporter can produce is a member of the closed union', () => {
    const { reporter } = makeReporter();
    for (const code of ['ENOSPC', 'EACCES', 'EPERM', 'SQLITE_CORRUPT', 'SQLITE_NOTADB', 'SQLITE_CANTOPEN', 'ENOTAMAPPEDCODE']) {
      expect(INDEX_FAILURE_CODES).toContain(reporter.report(fsError(code, `${WORKSPACE}/x.db`)).code);
    }
  });
});

describe('occurrences and incident ids', () => {
  test('occurrences counts this session, per code — a number, not a phrase', () => {
    const { reporter } = makeReporter();
    expect(reporter.report(fsError('ENOSPC', `${WORKSPACE}/a`)).occurrences).toBe(1);
    expect(reporter.report(fsError('ENOSPC', `${WORKSPACE}/b`)).occurrences).toBe(2);
    // A different code counts separately: the user is shown a count of THIS
    // failure, not of failures in general.
    expect(reporter.report(fsError('EACCES', `${WORKSPACE}/c`)).occurrences).toBe(1);
  });

  test('each incident gets its own id, and the log carries the same one', () => {
    const { reporter, log } = makeReporter();
    const first = reporter.report(fsError('ENOSPC', `${WORKSPACE}/a`));
    const second = reporter.report(fsError('ENOSPC', `${WORKSPACE}/b`));

    expect(first.incidentId).not.toBe(second.incidentId);
    expect(log.map(entry => entry.incidentId)).toEqual([first.incidentId, second.incidentId]);
  });

  test('a real reporter produces a non-empty id without being handed one', () => {
    const reason = new IndexFailureReporter({ workspaceRoot: WORKSPACE, log: () => undefined }).report(
      fsError('ENOSPC', `${WORKSPACE}/a`)
    );
    expect(reason.incidentId.length).toBeGreaterThan(0);
  });
});
