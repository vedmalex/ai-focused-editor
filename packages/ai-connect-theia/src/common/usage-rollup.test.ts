import { describe, expect, test } from 'bun:test';
import { AiRequestLogRecord } from './ai-history-log';
import { rollupUsage, USAGE_ROLLUP_NONE_KEY } from './usage-rollup';

function leg(overrides: Partial<AiRequestLogRecord>): AiRequestLogRecord {
  return {
    timestamp: '2026-07-10T09:00:00.000Z',
    requestId: 'req-1',
    source: 'chat',
    aliasId: 'fable',
    endpointId: 'gateway',
    model: 'model-x',
    provider: 'anthropic',
    legIndex: 0,
    outcome: 'ok',
    ...overrides
  };
}

describe('rollupUsage', () => {
  test('empty input yields zeroed totals and no breakdown rows', () => {
    const rollup = rollupUsage([]);
    expect(rollup.totals).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      reasoningTokens: 0,
      cachedReadTokens: 0,
      requests: 0,
      attempts: 0
    });
    expect(rollup.byDay).toEqual([]);
    expect(rollup.byAlias).toEqual([]);
    expect(rollup.bySource).toEqual([]);
  });

  test('aggregates totals and breakdowns across days, aliases, and sources', () => {
    const records: AiRequestLogRecord[] = [
      leg({
        timestamp: '2026-07-10T09:00:00.000Z',
        aliasId: 'fable',
        source: 'chat',
        usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, reasoningTokens: 5, cachedReadTokens: 10 }
      }),
      leg({
        timestamp: '2026-07-10T10:00:00.000Z',
        aliasId: 'opus',
        source: 'rewrite',
        usage: { inputTokens: 200, outputTokens: 50, totalTokens: 250, reasoningTokens: 15 }
      }),
      leg({
        timestamp: '2026-07-11T09:00:00.000Z',
        aliasId: 'fable',
        source: 'chat',
        usage: { inputTokens: 300, outputTokens: 60, totalTokens: 360 }
      })
    ];

    const rollup = rollupUsage(records);

    expect(rollup.totals).toEqual({
      inputTokens: 600,
      outputTokens: 130,
      totalTokens: 730,
      reasoningTokens: 20,
      cachedReadTokens: 10,
      requests: 3,
      attempts: 3
    });

    // Days: newest first.
    expect(rollup.byDay.map(entry => entry.key)).toEqual(['2026-07-11', '2026-07-10']);
    const day10 = rollup.byDay.find(entry => entry.key === '2026-07-10');
    expect(day10?.totalTokens).toBe(370);
    expect(day10?.requests).toBe(2);

    // Alias: fable (480) outranks opus (250) by total tokens.
    expect(rollup.byAlias.map(entry => entry.key)).toEqual(['fable', 'opus']);
    const fable = rollup.byAlias[0];
    expect(fable.inputTokens).toBe(400);
    expect(fable.outputTokens).toBe(80);
    expect(fable.totalTokens).toBe(480);
    expect(fable.requests).toBe(2);

    // Source: chat (480) outranks rewrite (250).
    expect(rollup.bySource.map(entry => entry.key)).toEqual(['chat', 'rewrite']);
  });

  test('skipped/error legs without usage do not count as requests but errors count as attempts', () => {
    const records: AiRequestLogRecord[] = [
      leg({ outcome: 'skipped-disabled', usage: undefined }),
      leg({ outcome: 'skipped-window', usage: undefined }),
      leg({ outcome: 'error', usage: undefined, error: 'boom' }),
      leg({ outcome: 'ok', usage: { inputTokens: 10, outputTokens: 4 } })
    ];

    const rollup = rollupUsage(records);

    // Only the ok leg carried usage.
    expect(rollup.totals.requests).toBe(1);
    // ok + error are attempts; the two skipped legs are not.
    expect(rollup.totals.attempts).toBe(2);
    expect(rollup.totals.inputTokens).toBe(10);
    expect(rollup.totals.outputTokens).toBe(4);
    // totalTokens absent on the ok leg → summed as 0 (not synthesized).
    expect(rollup.totals.totalTokens).toBe(0);
  });

  test('treats missing token fields as zero and falls back on empty dimension keys', () => {
    const records: AiRequestLogRecord[] = [
      leg({ aliasId: '', source: '', timestamp: '', usage: { inputTokens: 7 } })
    ];

    const rollup = rollupUsage(records);

    expect(rollup.totals.inputTokens).toBe(7);
    expect(rollup.totals.outputTokens).toBe(0);
    expect(rollup.byAlias[0].key).toBe(USAGE_ROLLUP_NONE_KEY);
    expect(rollup.bySource[0].key).toBe(USAGE_ROLLUP_NONE_KEY);
    expect(rollup.byDay[0].key).toBe(USAGE_ROLLUP_NONE_KEY);
  });
});
