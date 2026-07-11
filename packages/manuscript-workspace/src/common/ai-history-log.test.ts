import { describe, expect, test } from 'bun:test';
import {
  AI_REQUEST_LEG_KIND,
  AiRequestLegInput,
  buildRequestLegHistoryRecord,
  parseHistoryJsonl,
  parseRequestLogJsonl,
  REQUEST_LOG_FIELD_LIMIT,
  REQUEST_LOG_TRUNCATION_MARKER,
  toRequestLogRecord,
  truncateForLog,
  truncateMessagesForLog
} from './ai-history-log';

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

describe('truncateForLog', () => {
  test('returns the text unchanged when under the limit', () => {
    expect(truncateForLog('short')).toEqual({ text: 'short', truncated: false });
  });

  test('clips and marks over-limit text', () => {
    const result = truncateForLog('x'.repeat(REQUEST_LOG_FIELD_LIMIT + 10));
    expect(result.truncated).toBe(true);
    expect(result.text.endsWith(REQUEST_LOG_TRUNCATION_MARKER)).toBe(true);
    expect(result.text.length).toBe(REQUEST_LOG_FIELD_LIMIT + REQUEST_LOG_TRUNCATION_MARKER.length);
  });
});

describe('truncateMessagesForLog', () => {
  test('caps the combined message content at the budget', () => {
    const result = truncateMessagesForLog([
      { role: 'system', content: 'a'.repeat(REQUEST_LOG_FIELD_LIMIT - 5) },
      { role: 'user', content: 'b'.repeat(100) }
    ]);
    expect(result.truncated).toBe(true);
    const total = result.messages.reduce((sum, message) => sum + message.content.length, 0);
    // The over-budget message is clipped (+marker), so total stays bounded.
    expect(total).toBeLessThanOrEqual(REQUEST_LOG_FIELD_LIMIT + REQUEST_LOG_TRUNCATION_MARKER.length);
  });
});

describe('request-log records', () => {
  const baseInput: AiRequestLegInput = {
    timestamp: '2026-07-11T10:00:00.000Z',
    requestId: 'req-1',
    source: 'ai-focused-editor.improveSelection',
    documentUri: 'file:///book/ch-1.md',
    aliasId: 'primary',
    endpointId: 'anthropic-main',
    model: 'claude-sonnet-4-6',
    provider: 'anthropic',
    legIndex: 0,
    outcome: 'ok',
    durationMs: 1234,
    usage: { inputTokens: 120, outputTokens: 45 }
  };

  test('metadata record round-trips through the parser without payloads', () => {
    const record = buildRequestLegHistoryRecord(baseInput);
    expect(record.kind).toBe(AI_REQUEST_LEG_KIND);

    const line = JSON.stringify(record);
    const [parsed] = parseRequestLogJsonl(line);

    expect(parsed.requestId).toBe('req-1');
    expect(parsed.source).toBe('ai-focused-editor.improveSelection');
    expect(parsed.aliasId).toBe('primary');
    expect(parsed.endpointId).toBe('anthropic-main');
    expect(parsed.model).toBe('claude-sonnet-4-6');
    expect(parsed.provider).toBe('anthropic');
    expect(parsed.outcome).toBe('ok');
    expect(parsed.durationMs).toBe(1234);
    expect(parsed.usage).toEqual({ inputTokens: 120, outputTokens: 45 });
    expect(parsed.documentUri).toBe('file:///book/ch-1.md');
    // Metadata level never carries prompt/response text.
    expect(parsed.request).toBeUndefined();
    expect(parsed.response).toBeUndefined();
  });

  test('full record round-trips request messages and response text', () => {
    const record = buildRequestLegHistoryRecord({
      ...baseInput,
      full: true,
      messages: [
        { role: 'system', content: 'You are an editor.' },
        { role: 'user', content: 'Improve this.' }
      ],
      responseText: 'Improved text.'
    });

    const [parsed] = parseRequestLogJsonl(JSON.stringify(record));

    expect(parsed.request?.messages).toEqual([
      { role: 'system', content: 'You are an editor.' },
      { role: 'user', content: 'Improve this.' }
    ]);
    expect(parsed.request?.truncated).toBe(false);
    expect(parsed.response).toEqual({ text: 'Improved text.', truncated: false });
  });

  test('skipped legs carry the skip reason as the error and no payloads', () => {
    const record = buildRequestLegHistoryRecord({
      ...baseInput,
      outcome: 'skipped-window',
      durationMs: undefined,
      usage: undefined,
      error: 'outside-time-window'
    });
    const [parsed] = parseRequestLogJsonl(JSON.stringify(record));
    expect(parsed.outcome).toBe('skipped-window');
    expect(parsed.error).toBe('outside-time-window');
    expect(parsed.durationMs).toBeUndefined();
  });

  test('tolerates a file mixing legacy chat events and new leg records', () => {
    const text = [
      // legacy chat event (old format) — must still parse via parseHistoryJsonl
      JSON.stringify({
        timestamp: '2026-07-11T09:00:00.000Z',
        kind: 'theia-ai-language-model-request',
        command: 'chat',
        data: { route: { provider: 'anthropic', model: 'claude-sonnet-4-6' } }
      }),
      JSON.stringify(buildRequestLegHistoryRecord({ ...baseInput, requestId: 'req-2', legIndex: 0 })),
      '{ not valid json',
      JSON.stringify(buildRequestLegHistoryRecord({ ...baseInput, requestId: 'req-2', legIndex: 1, outcome: 'error', error: 'boom' }))
    ].join('\n');

    // Old chat events still parse in the generic reader.
    const generic = parseHistoryJsonl(text);
    expect(generic.some(record => record.command === 'chat')).toBe(true);

    // The typed reader keeps only the leg records, newest-first.
    const legs = parseRequestLogJsonl(text);
    expect(legs).toHaveLength(2);
    expect(legs.map(leg => leg.outcome)).toEqual(['error', 'ok']);
    expect(legs.every(leg => leg.requestId === 'req-2')).toBe(true);
  });

  test('toRequestLogRecord ignores non-leg records', () => {
    const [chat] = parseHistoryJsonl(JSON.stringify({ kind: 'chat', command: 'c', data: {} }));
    expect(toRequestLogRecord(chat)).toBeUndefined();
  });

  test('honors the leg-record limit newest-first', () => {
    const text = Array.from({ length: 5 }, (_, index) =>
      JSON.stringify(buildRequestLegHistoryRecord({ ...baseInput, requestId: `req-${index}`, legIndex: 0 }))
    ).join('\n');
    const legs = parseRequestLogJsonl(text, 2);
    expect(legs).toHaveLength(2);
    expect(legs.map(leg => leg.requestId)).toEqual(['req-4', 'req-3']);
  });
});
