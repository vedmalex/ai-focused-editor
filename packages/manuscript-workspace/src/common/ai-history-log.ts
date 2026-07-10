/**
 * Pure JSONL parsing/normalization helpers for the append-only AI history logs
 * (`ai/chat/*.jsonl` and `ai/context-snapshots/*.jsonl`).
 *
 * This module MUST stay free of Theia imports so it can be unit-tested in
 * isolation with `bun test`. The browser-side `AiHistoryService` imports it by
 * relative path.
 */

export interface AiHistoryLogRecord {
  timestamp?: string;
  kind: string;
  command: string;
  documentUri?: string;
  data: Record<string, unknown>;
}

export const DEFAULT_HISTORY_LIMIT = 100;

/**
 * Parses append-only JSONL history text into normalized records.
 *
 * Rules:
 * - one JSON object per line; blank/whitespace-only lines are ignored;
 * - malformed lines (invalid JSON or non-object values) are skipped, never thrown;
 * - records are returned newest-first (the file is written oldest-first);
 * - at most `limit` records are returned (default 100). A negative limit
 *   disables the cap; a limit of 0 returns an empty list.
 */
export function parseHistoryJsonl(text: string, limit: number = DEFAULT_HISTORY_LIMIT): AiHistoryLogRecord[] {
  const records: AiHistoryLogRecord[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const record = normalizeRecord(parsed);
    if (record) {
      records.push(record);
    }
  }

  records.reverse();
  if (limit >= 0 && records.length > limit) {
    records.length = limit;
  }
  return records;
}

function normalizeRecord(value: unknown): AiHistoryLogRecord | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const source = value as Record<string, unknown>;
  return {
    timestamp: optionalString(source.timestamp),
    kind: stringOrEmpty(source.kind),
    command: stringOrEmpty(source.command),
    documentUri: optionalString(source.documentUri),
    data: asRecord(source.data)
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function stringOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
