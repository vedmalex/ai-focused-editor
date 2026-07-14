import URI from '@theia/core/lib/common/uri';
import {
  PreferenceScope,
  PreferenceService
} from '@theia/core/lib/common/preferences';
import { inject, injectable } from '@theia/core/shared/inversify';
import type { MessageInput, UsageInfo } from '@vedmalex/ai-connect';
import {
  AiRequestLegMessage,
  AiRequestLegOutcome,
  AiRequestLogRecord,
  AiRequestLogUsage,
  buildRequestLegHistoryRecord,
  DEFAULT_HISTORY_LIMIT
} from '../common/ai-history-log';
import type {
  AiFailoverLegEvent,
  AiFailoverRecorder,
  AiGenerateRequest,
  AiGenerateResult,
  AiConnectionProfile,
  ResolvedChainSkip
} from '../common';
import { AiHistoryService } from './ai-history-service';
import { AiProfilePreferenceService } from './ai-profile-preference-service';
import {
  AI_CONNECT_REQUEST_LOG,
  LEGACY_AI_REQUEST_LOG
} from './ai-connect-preferences';

export type AiRequestLogMode = 'off' | 'metadata' | 'full';

let requestCounter = 0;

/**
 * A single AI request's logging session. Skipped legs are already written when
 * this is created; call `record` once per attempted leg (in walk order).
 */
export interface AiRequestLogSession {
  requestId: string;
  aliasId: string;
  /** True at `full` level — request/response payloads are stored. */
  full: boolean;
  /** Leg index the first attempted leg should use (after any skipped legs). */
  attemptedBase: number;
  record(
    legIndex: number,
    profile: AiConnectionProfile,
    outcome: 'ok' | 'error',
    durationMs: number,
    request: AiGenerateRequest,
    result?: AiGenerateResult,
    error?: string
  ): void;
}

/**
 * Records the per-leg provenance of the AI failover walk (what was sent and
 * received per endpoint/alias) into `ai/chat/requests-<date>.jsonl`, gated by
 * the `aiConnect.requestLog` preference. Also the read/enable surface
 * for the AI Debug view's "Requests" section.
 *
 * All writes are best-effort: AI features must never fail because debug logging
 * failed, so the recorder swallows its own errors.
 */
@injectable()
export class AiRequestLogService {
  @inject(PreferenceService)
  protected readonly preferenceService!: PreferenceService;

  @inject(AiHistoryService)
  protected readonly aiHistory!: AiHistoryService;

  @inject(AiProfilePreferenceService)
  protected readonly aiProfilePreferences!: AiProfilePreferenceService;

  getMode(resourceUri?: string): AiRequestLogMode {
    // Soft migration: new key wins when explicitly set, else legacy value.
    const neu = this.preferenceService.inspect<string>(AI_CONNECT_REQUEST_LOG, resourceUri);
    const legacy = this.preferenceService.inspect<string>(LEGACY_AI_REQUEST_LOG, resourceUri);
    const isSet = (i: typeof neu): boolean =>
      !!i && (i.globalValue !== undefined || i.workspaceValue !== undefined || i.workspaceFolderValue !== undefined);
    const value = isSet(neu) ? neu?.value : isSet(legacy) ? legacy?.value : 'off';
    return value === 'metadata' || value === 'full' ? value : 'off';
  }

  isEnabled(resourceUri?: string): boolean {
    return this.getMode(resourceUri) !== 'off';
  }

  /** Turn logging on (or off) from the viewer's one-click enable hint. */
  async setMode(mode: AiRequestLogMode): Promise<void> {
    await this.preferenceService.set(AI_CONNECT_REQUEST_LOG, mode, PreferenceScope.User);
  }

  /**
   * Start a logging session for one AI request, or `undefined` when logging is
   * off (so callers pay nothing). Skipped legs (disabled / out-of-window
   * endpoints) are known at resolution time and written immediately here.
   */
  beginRequest(source: string, documentUri?: string, aliasOverride?: string): AiRequestLogSession | undefined {
    const mode = this.getMode(documentUri);
    if (mode === 'off') {
      return undefined;
    }
    const full = mode === 'full';
    const requestId = this.newRequestId();
    // A per-alias model pins its own alias so the log records which alias-model
    // served the request; the default model passes none and uses the active alias.
    const detailed = this.aiProfilePreferences.resolveAliasChainDetailed(aliasOverride, new Date(), documentUri);
    const aliasId = detailed.aliasId ?? '';
    let legIndex = 0;
    for (const skip of detailed.skipped) {
      this.writeSkip(requestId, source, documentUri, aliasId, legIndex++, skip);
    }
    const attemptedBase = legIndex;
    const service = this;
    return {
      requestId,
      aliasId,
      full,
      attemptedBase,
      record(legIdx, profile, outcome, durationMs, request, result, error) {
        service.writeLeg(requestId, source, documentUri, aliasId, legIdx, full, {
          profile,
          index: legIdx,
          outcome,
          durationMs,
          request,
          result,
          error
        });
      }
    };
  }

  /**
   * Build a recorder for the pure failover helper, or `undefined` when logging
   * is off. Attempted legs are written as the returned recorder is invoked by
   * the failover walk.
   */
  createRecorder(source: string, documentUri?: string): AiFailoverRecorder | undefined {
    const session = this.beginRequest(source, documentUri);
    if (!session) {
      return undefined;
    }
    return (event: AiFailoverLegEvent) => {
      session.record(
        session.attemptedBase + event.index,
        event.profile,
        event.outcome,
        event.durationMs,
        event.request,
        event.result,
        event.error
      );
    };
  }

  newRequestId(): string {
    return `req-${Date.now().toString(36)}-${(requestCounter++).toString(36)}`;
  }

  // -- viewer surface --------------------------------------------------------

  async listDays(): Promise<string[]> {
    return this.aiHistory.listRequestLogDays();
  }

  async readDay(day: string, limit: number = DEFAULT_HISTORY_LIMIT): Promise<AiRequestLogRecord[]> {
    return this.aiHistory.readRequestLog(day, limit);
  }

  async deleteDay(day: string): Promise<void> {
    await this.aiHistory.deleteRequestLog(day);
  }

  async dayUri(day: string): Promise<URI | undefined> {
    return this.aiHistory.getRequestLogDayUri(day);
  }

  // -- internal --------------------------------------------------------------

  protected writeSkip(
    requestId: string,
    source: string,
    documentUri: string | undefined,
    aliasId: string,
    legIndex: number,
    skip: ResolvedChainSkip
  ): void {
    const outcome: AiRequestLegOutcome = skip.reason === 'outside-time-window'
      ? 'skipped-window'
      : 'skipped-disabled';
    const record = buildRequestLegHistoryRecord({
      requestId,
      source,
      documentUri,
      aliasId,
      endpointId: skip.endpointId,
      model: skip.model,
      provider: '',
      legIndex,
      outcome,
      error: skip.reason
    });
    void this.aiHistory.appendRequestLeg(record).catch(() => undefined);
  }

  protected writeLeg(
    requestId: string,
    source: string,
    documentUri: string | undefined,
    aliasId: string,
    legIndex: number,
    full: boolean,
    event: AiFailoverLegEvent
  ): void {
    const record = buildRequestLegHistoryRecord({
      requestId,
      source,
      documentUri,
      aliasId,
      endpointId: event.profile.id ?? event.profile.provider,
      model: event.profile.model ?? '',
      provider: event.profile.provider,
      legIndex,
      outcome: event.outcome,
      durationMs: event.durationMs,
      error: event.error,
      usage: toLogUsage(event.result?.usage),
      full,
      messages: full ? toLogMessages(event.request.messages) : undefined,
      responseText: full ? event.result?.text : undefined
    });
    void this.aiHistory.appendRequestLeg(record).catch(() => undefined);
  }
}

function toLogMessages(messages: MessageInput[]): AiRequestLegMessage[] {
  return messages.map(message => ({
    role: message.role,
    content: typeof message.content === 'string' ? message.content : String(message.content ?? '')
  }));
}

function toLogUsage(usage: UsageInfo | undefined): AiRequestLogUsage | undefined {
  if (!usage) {
    return undefined;
  }
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedReadTokens: usage.cachedReadTokens
  };
}
