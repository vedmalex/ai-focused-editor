import { describe, expect, test } from 'bun:test';
import { parseHistoryJsonl } from './ai-history-log';

describe('parseHistoryJsonl', () => {
  test('parses valid JSONL lines into normalized records', () => {
    const text = [
      JSON.stringify({
        timestamp: '2026-07-10T09:00:00.000Z',
        kind: 'theia-ai-language-model-request',
        command: 'chat',
        documentUri: 'file:///book/content/ch-1.md',
        data: { route: { provider: 'anthropic', model: 'claude-sonnet-4-6' } }
      }),
      JSON.stringify({
        timestamp: '2026-07-10T09:05:00.000Z',
        kind: 'context-snapshot',
        command: 'assemble',
        data: { chars: 1200 }
      })
    ].join('\n');

    const records = parseHistoryJsonl(text);

    expect(records).toHaveLength(2);
    // Newest-first: the second line comes back first.
    expect(records[0].command).toBe('assemble');
    expect(records[0].kind).toBe('context-snapshot');
    expect(records[1].command).toBe('chat');
    expect(records[1].documentUri).toBe('file:///book/content/ch-1.md');
    expect((records[1].data.route as Record<string, unknown>).provider).toBe('anthropic');
  });

  test('skips malformed lines without throwing', () => {
    const text = [
      JSON.stringify({ kind: 'a', command: 'first', data: {} }),
      '{ this is not valid json',
      '',
      '   ',
      '42',
      '["array", "not", "object"]',
      JSON.stringify({ kind: 'b', command: 'second', data: {} })
    ].join('\n');

    const records = parseHistoryJsonl(text);

    expect(records).toHaveLength(2);
    expect(records.map(record => record.command)).toEqual(['second', 'first']);
  });

  test('returns records newest-first (reverse of append order)', () => {
    const text = [
      JSON.stringify({ kind: 'k', command: 'oldest', data: {} }),
      JSON.stringify({ kind: 'k', command: 'middle', data: {} }),
      JSON.stringify({ kind: 'k', command: 'newest', data: {} })
    ].join('\n');

    const records = parseHistoryJsonl(text);

    expect(records.map(record => record.command)).toEqual(['newest', 'middle', 'oldest']);
  });

  test('honors the limit, keeping the newest entries', () => {
    const text = Array.from({ length: 5 }, (_, index) =>
      JSON.stringify({ kind: 'k', command: `entry-${index}`, data: {} })
    ).join('\n');

    const records = parseHistoryJsonl(text, 2);

    expect(records).toHaveLength(2);
    expect(records.map(record => record.command)).toEqual(['entry-4', 'entry-3']);
  });

  test('defaults to a limit of 100', () => {
    const text = Array.from({ length: 150 }, (_, index) =>
      JSON.stringify({ kind: 'k', command: `entry-${index}`, data: {} })
    ).join('\n');

    const records = parseHistoryJsonl(text);

    expect(records).toHaveLength(100);
    expect(records[0].command).toBe('entry-149');
  });

  test('returns an empty list for empty text', () => {
    expect(parseHistoryJsonl('')).toEqual([]);
    expect(parseHistoryJsonl('   \n  \n')).toEqual([]);
  });

  test('normalizes missing fields defensively', () => {
    const text = JSON.stringify({ kind: 'k', command: 'c' });

    const [record] = parseHistoryJsonl(text);

    expect(record.data).toEqual({});
    expect(record.timestamp).toBeUndefined();
    expect(record.documentUri).toBeUndefined();
  });
});
