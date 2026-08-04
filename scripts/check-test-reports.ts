#!/usr/bin/env bun
/**
 * Assert that the JUnit reports the test lanes are supposed to emit ACTUALLY
 * EXIST and carry results (REQ-014).
 *
 * WHY THIS EXISTS, and why `mkdir -p` alone is not the fix.
 *
 * `bun test --reporter-outfile=<path>` writes the report on a BEST-EFFORT
 * basis: when the write fails it prints
 *
 *     JUnitReportFailed: Failed to write JUnit report to .test-reports/x.xml
 *     ENOENT: .test-reports/x.xml: No such file or directory (open())
 *
 * and then **exits 0**. `.test-reports/` is gitignored, so on a clean checkout
 * it does not exist — which means every lane silently produced NO report while
 * `bun run verify` reported EXIT 0. Observed, not theorised: this is exactly how
 * the first implementation of REQ-014 shipped, and it was caught only because a
 * work package happened to run on a fresh tree.
 *
 * The directory is now created before the lanes run, which fixes the known
 * cause. This check exists for the OTHER causes — a full disk, a permission
 * change, a lane whose `--reporter-outfile` gets dropped in an edit — because
 * every one of them fails the same silent way. A requirement whose only
 * evidence is "we passed the flag" is not verified; the artifact on disk is.
 *
 * Deliberately NOT asserted: that the reports are newer than this run. A
 * timestamp comparison would make the check depend on clock behaviour and on
 * lane ordering, and the failure it would catch (a stale report from a previous
 * run) cannot occur while the lanes always overwrite. Say what is checked; do
 * not imply more.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * One entry per lane that declares `--reporter-outfile` in `package.json`.
 *
 * Kept beside the scripts it mirrors rather than derived from them: deriving it
 * would make a lane that LOST its reporter flag pass this check silently, which
 * is one of the three failure modes the check is for.
 */
export const EXPECTED_REPORTS = [
  '.test-reports/packages.junit.xml',
  '.test-reports/widget.junit.xml',
  '.test-reports/typography.junit.xml',
  '.test-reports/scripts.junit.xml',
  '.test-reports/narrative-index.junit.xml'
] as const;

export interface ReportProblem {
  path: string;
  reason: 'missing' | 'empty' | 'unparsable' | 'no-cases';
  detail: string;
}

/** Number of `<testcase` elements, counted textually — no XML dependency. */
export function countTestCases(xml: string): number {
  return (xml.match(/<testcase\b/g) ?? []).length;
}

export function inspectReport(root: string, relPath: string): ReportProblem | undefined {
  const full = join(root, relPath);
  if (!existsSync(full)) {
    return {
      path: relPath,
      reason: 'missing',
      detail:
        'the lane ran but wrote no report — bun exits 0 when the report write ' +
        'fails, so this is invisible in the lane output'
    };
  }
  const xml = readFileSync(full, 'utf8');
  if (xml.trim().length === 0) {
    return { path: relPath, reason: 'empty', detail: 'the file exists but is empty' };
  }
  if (!xml.includes('<testsuite')) {
    return {
      path: relPath,
      reason: 'unparsable',
      detail: 'no <testsuite> element — this is not a JUnit report'
    };
  }
  const cases = countTestCases(xml);
  if (cases === 0) {
    return {
      path: relPath,
      reason: 'no-cases',
      detail: 'a JUnit report with zero <testcase> elements — the lane matched no tests'
    };
  }
  return undefined;
}

export function formatProblems(problems: readonly ReportProblem[]): string {
  const lines = problems.map(p => `  ${p.path}  [${p.reason}]  ${p.detail}`);
  return [
    `check-test-reports: ${problems.length} of ${EXPECTED_REPORTS.length} JUnit report(s) unusable`,
    ...lines,
    '',
    'REQ-014 requires the test lanes to emit machine-readable results. A lane',
    'that passes the reporter flag but writes nothing satisfies the flag and not',
    'the requirement — per-case durations are exactly what a summary line cannot',
    'give, and they are what this repository used to diagnose a flaky test.'
  ].join('\n');
}

function main(): void {
  const problems = EXPECTED_REPORTS.map(rel => inspectReport(repoRoot, rel)).filter(
    (p): p is ReportProblem => p !== undefined
  );
  if (problems.length > 0) {
    console.error(formatProblems(problems));
    process.exit(1);
  }
  const total = EXPECTED_REPORTS.reduce(
    (sum, rel) => sum + countTestCases(readFileSync(join(repoRoot, rel), 'utf8')),
    0
  );
  console.log(
    `check-test-reports: ${EXPECTED_REPORTS.length} JUnit report(s) present, ` +
      `${total.toLocaleString('en-US')} test case(s) recorded.`
  );
}

if (import.meta.main) {
  main();
}
