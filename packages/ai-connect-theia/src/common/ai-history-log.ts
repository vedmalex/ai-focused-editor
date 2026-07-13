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

// ---------------------------------------------------------------------------
// AI request-log records (per-leg provenance of the failover walk)
//
// One JSONL record is written per ATTEMPTED (or skipped) failover leg. Records
// share the generic AiHistoryLogRecord envelope (kind/command/data) so the same
// `parseHistoryJsonl` tolerates them alongside legacy chat events; the typed
// view below narrows a record to the leg shape. The sibling file layout
// (`ai/chat/requests-<date>.jsonl`) keeps these out of the chat day list.
// ---------------------------------------------------------------------------

/** Envelope `kind` marking a per-leg request-log record. */
export const AI_REQUEST_LEG_KIND = 'ai-request-leg';

/** Per-field truncation budget for `full`-mode payloads (~64 KB). */
export const REQUEST_LOG_FIELD_LIMIT = 64 * 1024;

/** Explicit marker appended to a truncated field. */
export const REQUEST_LOG_TRUNCATION_MARKER = '…truncated';

export type AiRequestLegOutcome = 'ok' | 'error' | 'skipped-window' | 'skipped-disabled';

export interface AiRequestLegMessage {
  role: string;
  content: string;
}

export interface AiRequestLogUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedReadTokens?: number;
}

/** Truncatable text blob stored at `full` logging level. */
export interface AiRequestLogPayload {
  text: string;
  truncated: boolean;
}

export interface AiRequestLogMessages {
  messages: AiRequestLegMessage[];
  truncated: boolean;
}

/** Typed view of a single request-log leg record. */
export interface AiRequestLogRecord {
  timestamp: string;
  requestId: string;
  /** Command / mode id / 'chat' that triggered the request. */
  source: string;
  aliasId: string;
  endpointId: string;
  model: string;
  provider: string;
  /** 0-based position of the leg within the failover walk. */
  legIndex: number;
  outcome: AiRequestLegOutcome;
  durationMs?: number;
  error?: string;
  usage?: AiRequestLogUsage;
  documentUri?: string;
  /** Present only at `full` logging level. */
  request?: AiRequestLogMessages;
  /** Present only at `full` logging level. */
  response?: AiRequestLogPayload;
}

/** Constructor input for one leg record. */
export interface AiRequestLegInput {
  timestamp?: string;
  requestId: string;
  source: string;
  documentUri?: string;
  aliasId: string;
  endpointId: string;
  model: string;
  provider: string;
  legIndex: number;
  outcome: AiRequestLegOutcome;
  durationMs?: number;
  error?: string;
  usage?: AiRequestLogUsage;
  /** When true the request messages + response text are stored (full level). */
  full?: boolean;
  messages?: AiRequestLegMessage[];
  responseText?: string;
}

/**
 * Truncate a single text field at `limit`, appending an explicit marker when
 * clipped so a reader can tell the payload is incomplete.
 */
export function truncateForLog(text: string, limit: number = REQUEST_LOG_FIELD_LIMIT): AiRequestLogPayload {
  if (text.length <= limit) {
    return { text, truncated: false };
  }
  return { text: `${text.slice(0, limit)}${REQUEST_LOG_TRUNCATION_MARKER}`, truncated: true };
}

/** Truncate the message list to a shared ~64 KB content budget. */
export function truncateMessagesForLog(
  messages: readonly AiRequestLegMessage[],
  limit: number = REQUEST_LOG_FIELD_LIMIT
): AiRequestLogMessages {
  const out: AiRequestLegMessage[] = [];
  let used = 0;
  let truncated = false;
  for (const message of messages) {
    if (used >= limit) {
      truncated = true;
      break;
    }
    const remaining = limit - used;
    const content = typeof message.content === 'string' ? message.content : String(message.content ?? '');
    if (content.length > remaining) {
      out.push({ role: message.role, content: `${content.slice(0, remaining)}${REQUEST_LOG_TRUNCATION_MARKER}` });
      truncated = true;
      used = limit;
    } else {
      out.push({ role: message.role, content });
      used += content.length;
    }
  }
  return { messages: out, truncated };
}

function pruneUsage(usage: AiRequestLogUsage): AiRequestLogUsage | undefined {
  const pruned: AiRequestLogUsage = {};
  if (typeof usage.inputTokens === 'number') { pruned.inputTokens = usage.inputTokens; }
  if (typeof usage.outputTokens === 'number') { pruned.outputTokens = usage.outputTokens; }
  if (typeof usage.cachedReadTokens === 'number') { pruned.cachedReadTokens = usage.cachedReadTokens; }
  return Object.keys(pruned).length > 0 ? pruned : undefined;
}

/**
 * Build a generic history-log envelope for one failover leg. `full` gates the
 * request/response payloads so `metadata` level never writes manuscript text.
 */
export function buildRequestLegHistoryRecord(input: AiRequestLegInput): AiHistoryLogRecord {
  const data: Record<string, unknown> = {
    requestId: input.requestId,
    source: input.source,
    aliasId: input.aliasId,
    endpointId: input.endpointId,
    model: input.model,
    provider: input.provider,
    legIndex: input.legIndex,
    outcome: input.outcome
  };
  if (typeof input.durationMs === 'number') {
    data.durationMs = input.durationMs;
  }
  if (input.error) {
    data.error = input.error;
  }
  const usage = input.usage ? pruneUsage(input.usage) : undefined;
  if (usage) {
    data.usage = usage;
  }
  if (input.full) {
    if (input.messages) {
      data.request = truncateMessagesForLog(input.messages);
    }
    if (typeof input.responseText === 'string') {
      data.response = truncateForLog(input.responseText);
    }
  }
  return {
    timestamp: input.timestamp,
    kind: AI_REQUEST_LEG_KIND,
    command: input.source,
    documentUri: input.documentUri,
    data
  };
}

function requestLegOutcome(value: unknown): AiRequestLegOutcome {
  return value === 'error' || value === 'skipped-window' || value === 'skipped-disabled' ? value : 'ok';
}

function requestLogMessages(value: unknown): AiRequestLogMessages | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const source = value as Record<string, unknown>;
  if (!Array.isArray(source.messages)) {
    return undefined;
  }
  const messages = source.messages
    .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
    .map(entry => ({ role: stringOrEmpty(entry.role), content: stringOrEmpty(entry.content) }));
  return { messages, truncated: source.truncated === true };
}

function requestLogPayload(value: unknown): AiRequestLogPayload | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const source = value as Record<string, unknown>;
  if (typeof source.text !== 'string') {
    return undefined;
  }
  return { text: source.text, truncated: source.truncated === true };
}

function requestLogUsage(value: unknown): AiRequestLogUsage | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const source = value as Record<string, unknown>;
  return pruneUsage({
    inputTokens: typeof source.inputTokens === 'number' ? source.inputTokens : undefined,
    outputTokens: typeof source.outputTokens === 'number' ? source.outputTokens : undefined,
    cachedReadTokens: typeof source.cachedReadTokens === 'number' ? source.cachedReadTokens : undefined
  });
}

/**
 * Narrow a generic history record to the typed leg shape, or `undefined` when
 * it is not a request-log record (e.g. a legacy chat event). This is what lets
 * a mixed file parse without loss.
 */
export function toRequestLogRecord(record: AiHistoryLogRecord): AiRequestLogRecord | undefined {
  if (record.kind !== AI_REQUEST_LEG_KIND) {
    return undefined;
  }
  const data = record.data;
  const result: AiRequestLogRecord = {
    timestamp: record.timestamp ?? '',
    requestId: stringOrEmpty(data.requestId),
    source: stringOrEmpty(data.source) || record.command,
    aliasId: stringOrEmpty(data.aliasId),
    endpointId: stringOrEmpty(data.endpointId),
    model: stringOrEmpty(data.model),
    provider: stringOrEmpty(data.provider),
    legIndex: typeof data.legIndex === 'number' ? data.legIndex : 0,
    outcome: requestLegOutcome(data.outcome)
  };
  if (typeof data.durationMs === 'number') {
    result.durationMs = data.durationMs;
  }
  const error = optionalString(data.error);
  if (error) {
    result.error = error;
  }
  const usage = requestLogUsage(data.usage);
  if (usage) {
    result.usage = usage;
  }
  if (record.documentUri) {
    result.documentUri = record.documentUri;
  }
  const request = requestLogMessages(data.request);
  if (request) {
    result.request = request;
  }
  const response = requestLogPayload(data.response);
  if (response) {
    result.response = response;
  }
  return result;
}

/**
 * Parse request-log JSONL into typed leg records, newest-first. Non-leg lines
 * (legacy chat events, malformed lines) are dropped; `limit` caps the returned
 * leg records (default 100; a negative limit disables the cap).
 */
export function parseRequestLogJsonl(text: string, limit: number = DEFAULT_HISTORY_LIMIT): AiRequestLogRecord[] {
  const all = parseHistoryJsonl(text, -1)
    .map(toRequestLogRecord)
    .filter((record): record is AiRequestLogRecord => record !== undefined);
  if (limit < 0) {
    return all;
  }
  return all.slice(0, limit);
}
