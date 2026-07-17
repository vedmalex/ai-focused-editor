/**
 * Pure aggregation over the per-leg AI request-log records into a token-usage
 * report: grand totals plus breakdowns by day, alias, and source/agent.
 *
 * This module MUST stay free of Theia imports so it can be unit-tested in
 * isolation with `bun test`. The browser-side usage widget imports it by
 * relative path, feeding it the records read back from `requests-<date>.jsonl`.
 *
 * Robustness rules (see `rollupUsage`):
 * - a missing usage field is treated as `0` (never NaN, never thrown);
 * - only a leg that carries a `usage` object counts toward `requests`
 *   (usage-bearing calls); skipped/error legs with no usage do not;
 * - a leg whose outcome is `ok` or `error` counts as an `attempt`, whether or
 *   not usage was reported (skipped legs never do);
 * - token fields are summed field-by-field exactly as reported — `totalTokens`
 *   is NOT synthesized from input+output, so a provider that omits it sums 0.
 */

import { AiRequestLogRecord } from './ai-history-log';

/** Summed token counters + call counts for a set of legs. */
export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningTokens: number;
  cachedReadTokens: number;
  /** Legs that carried a `usage` object (usage-bearing calls). */
  requests: number;
  /** Legs whose outcome was `ok` or `error` (an attempted call). */
  attempts: number;
}

/** One row of a dimension breakdown, keyed by the dimension value. */
export interface UsageBreakdownEntry extends UsageTotals {
  key: string;
}

/** The full token-usage report: grand totals + three dimension breakdowns. */
export interface UsageRollup {
  totals: UsageTotals;
  /** By calendar day (YYYY-MM-DD), newest day first. */
  byDay: UsageBreakdownEntry[];
  /** By alias id, most tokens first. */
  byAlias: UsageBreakdownEntry[];
  /** By source (command / mode id / 'chat'), most tokens first. */
  bySource: UsageBreakdownEntry[];
}

/** Placeholder key used when a dimension value is empty/absent. */
export const USAGE_ROLLUP_NONE_KEY = '(none)';

function emptyTotals(): UsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    reasoningTokens: 0,
    cachedReadTokens: 0,
    requests: 0,
    attempts: 0
  };
}

function num(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function accumulate(target: UsageTotals, record: AiRequestLogRecord): void {
  const usage = record.usage;
  if (usage) {
    target.inputTokens += num(usage.inputTokens);
    target.outputTokens += num(usage.outputTokens);
    target.totalTokens += num(usage.totalTokens);
    target.reasoningTokens += num(usage.reasoningTokens);
    target.cachedReadTokens += num(usage.cachedReadTokens);
    target.requests += 1;
  }
  if (record.outcome === 'ok' || record.outcome === 'error') {
    target.attempts += 1;
  }
}

/** Does this record contribute anything worth a breakdown row? */
function isCounted(record: AiRequestLogRecord): boolean {
  return !!record.usage || record.outcome === 'ok' || record.outcome === 'error';
}

function dayKey(record: AiRequestLogRecord): string {
  const day = (record.timestamp ?? '').slice(0, 10);
  return day || USAGE_ROLLUP_NONE_KEY;
}

function bucketInto(
  buckets: Map<string, UsageTotals>,
  key: string,
  record: AiRequestLogRecord
): void {
  let totals = buckets.get(key);
  if (!totals) {
    totals = emptyTotals();
    buckets.set(key, totals);
  }
  accumulate(totals, record);
}

function toEntries(
  buckets: Map<string, UsageTotals>,
  sort: (left: UsageBreakdownEntry, right: UsageBreakdownEntry) => number
): UsageBreakdownEntry[] {
  const entries = [...buckets.entries()].map(([key, totals]) => ({ key, ...totals }));
  entries.sort(sort);
  return entries;
}

function byTokensDesc(left: UsageBreakdownEntry, right: UsageBreakdownEntry): number {
  if (right.totalTokens !== left.totalTokens) {
    return right.totalTokens - left.totalTokens;
  }
  const rightIo = right.inputTokens + right.outputTokens;
  const leftIo = left.inputTokens + left.outputTokens;
  if (rightIo !== leftIo) {
    return rightIo - leftIo;
  }
  return left.key.localeCompare(right.key);
}

/**
 * Aggregate an array of logged-leg records into grand totals and breakdowns by
 * day, alias, and source. Records may be in any order and may include skipped /
 * error / usage-less legs; the counters stay robust to missing fields.
 */
export function rollupUsage(records: readonly AiRequestLogRecord[]): UsageRollup {
  const totals = emptyTotals();
  const byDay = new Map<string, UsageTotals>();
  const byAlias = new Map<string, UsageTotals>();
  const bySource = new Map<string, UsageTotals>();

  for (const record of records) {
    if (!isCounted(record)) {
      continue;
    }
    accumulate(totals, record);
    bucketInto(byDay, dayKey(record), record);
    bucketInto(byAlias, record.aliasId || USAGE_ROLLUP_NONE_KEY, record);
    bucketInto(bySource, record.source || USAGE_ROLLUP_NONE_KEY, record);
  }

  return {
    totals,
    // Days newest-first, matching the rest of the request-log surface.
    byDay: toEntries(byDay, (left, right) => right.key.localeCompare(left.key)),
    byAlias: toEntries(byAlias, byTokensDesc),
    bySource: toEntries(bySource, byTokensDesc)
  };
}
