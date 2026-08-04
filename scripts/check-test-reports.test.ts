/**
 * Tests for the JUnit-report presence check (see `check-test-reports.ts`).
 *
 * The end-to-end tooth — delete `.test-reports/`, watch `bun run verify` go red
 * — is exercised by hand and recorded in the task. What is asserted here is the
 * part that can regress silently: that each of the four "unusable" reasons is
 * actually distinguished, and that a real report passes.
 *
 * Fixtures are built in a throwaway directory rather than against the live
 * `.test-reports/`, so these assert the behaviour instead of the state of
 * whatever tree they happen to run in — the same reason the control-byte guard's
 * listing tests build their own repository.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import {
  EXPECTED_REPORTS,
  countTestCases,
  formatProblems,
  inspectReport
} from './check-test-reports';

const REAL_REPORT =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<testsuites name="bun test" tests="2" failures="0">\n' +
  '  <testsuite name="x.test.ts" tests="2">\n' +
  '    <testcase name="one" time="0.001"/>\n' +
  '    <testcase name="two" time="0.002"/>\n' +
  '  </testsuite>\n' +
  '</testsuites>\n';

const withScratchRoot = (body: (root: string) => void): void => {
  const root = mkdtempSync(join(tmpdir(), 'check-test-reports-'));
  try {
    mkdirSync(join(root, '.test-reports'), { recursive: true });
    body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const REL = EXPECTED_REPORTS[0];

describe('inspectReport — the four ways a report is unusable', () => {
  test('MISSING: the lane wrote nothing, which is how bun fails — silently, at exit 0', () => {
    withScratchRoot(root => {
      expect(inspectReport(root, REL)?.reason).toBe('missing');
    });
  });

  test('EMPTY: the file exists but has no content', () => {
    withScratchRoot(root => {
      writeFileSync(join(root, REL), '   \n');
      expect(inspectReport(root, REL)?.reason).toBe('empty');
    });
  });

  test('UNPARSABLE: content that is not a JUnit report at all', () => {
    withScratchRoot(root => {
      writeFileSync(join(root, REL), 'ENOENT: could not open the report\n');
      expect(inspectReport(root, REL)?.reason).toBe('unparsable');
    });
  });

  test('NO-CASES: a well-formed report that recorded nothing — a lane matching no tests', () => {
    withScratchRoot(root => {
      writeFileSync(
        join(root, REL),
        '<testsuites tests="0"><testsuite name="none" tests="0"></testsuite></testsuites>'
      );
      expect(inspectReport(root, REL)?.reason).toBe('no-cases');
    });
  });

  test('a real report passes — without this the check could reject everything and look strict', () => {
    withScratchRoot(root => {
      writeFileSync(join(root, REL), REAL_REPORT);
      expect(inspectReport(root, REL)).toBeUndefined();
    });
  });
});

describe('countTestCases', () => {
  test('counts every case element', () => {
    expect(countTestCases(REAL_REPORT)).toBe(2);
  });

  test('does not count a testsuite as a case', () => {
    expect(countTestCases('<testsuites><testsuite name="a"></testsuite></testsuites>')).toBe(0);
  });

  test('does not match a longer element that merely starts with the same letters', () => {
    expect(countTestCases('<testcases-summary/>')).toBe(0);
  });
});

describe('the failure message', () => {
  test('names every unusable report, its reason and why it matters', () => {
    const message = formatProblems([
      { path: REL, reason: 'missing', detail: 'the lane ran but wrote no report' }
    ]);
    expect(message).toContain(REL);
    expect(message).toContain('missing');
    expect(message).toContain('REQ-014');
    expect(message).toContain(String(EXPECTED_REPORTS.length));
  });
});

describe('the expected set', () => {
  test('covers one report per lane that declares a reporter outfile', () => {
    // Hand-kept ON PURPOSE: deriving this from package.json would let a lane
    // that LOST its --reporter-outfile flag pass silently, which is one of the
    // failure modes the check exists for.
    expect(EXPECTED_REPORTS).toEqual([
      '.test-reports/packages.junit.xml',
      '.test-reports/widget.junit.xml',
      '.test-reports/typography.junit.xml',
      '.test-reports/scripts.junit.xml',
      '.test-reports/narrative-index.junit.xml'
    ]);
  });
});
