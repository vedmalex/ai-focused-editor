import type {
  LanguageModel,
  LanguageModelMessage,
  LanguageModelResponse,
  LanguageModelStatus,
  LanguageModelStreamResponsePart,
  TextMessage,
  ToolRequest,
  UsageResponsePart,
  UserRequest
} from '@theia/ai-core';
import type { CancellationToken } from '@theia/core/lib/common/cancellation';
import type {
  MessageInput,
  MessageRole,
  UsageInfo
} from '@vedmalex/ai-connect';
import { inject, injectable } from '@theia/core/shared/inversify';
import {
  AiClientToolDefinition,
  AiConnectionProfile,
  AiConnectionService,
  AiGenerateRequest,
  AiGenerateResult
} from '../common';
import { AiHistoryService } from './ai-history-service';
import { AiProfilePreferenceService } from './ai-profile-preference-service';
import { AiRequestLogService, AiRequestLogSession } from './ai-request-log-service';

/**
 * Shared engine for every ai-connect-backed Theia LanguageModel: message
 * conversion, tool adaptation, streaming failover, request logging, and local
 * history. Subclasses only supply their identity metadata and — crucially —
 * WHICH failover chain a request routes through:
 *   - {@link AiConnectTheiaLanguageModel} routes through the active alias
 *     (the editor's back-compat "current alias" model).
 *   - the per-alias model pins EVERY request to its own alias.
 */
@injectable()
export abstract class AiConnectLanguageModelBase implements LanguageModel {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly vendor: string;
  abstract readonly family: string;
  abstract readonly status: LanguageModelStatus;

  @inject(AiConnectionService)
  protected readonly aiConnection!: AiConnectionService;

  @inject(AiProfilePreferenceService)
  protected readonly aiProfilePreferences!: AiProfilePreferenceService;

  @inject(AiHistoryService)
  protected readonly aiHistory!: AiHistoryService;

  @inject(AiRequestLogService)
  protected readonly requestLog!: AiRequestLogService;

  /** The failover chain this model routes through (active alias vs a pinned alias). */
  protected abstract resolveFailoverChain(): Promise<AiConnectionProfile[]>;

  /**
   * Alias id to stamp on the request log, or `undefined` to let the log use the
   * active alias. The per-alias model returns its pinned alias so the log
   * records which alias-model served each request.
   */
  protected aliasForLog(): string | undefined {
    return undefined;
  }

  /** Human error hint when this model has no usable chain. */
  protected emptyChainMessage(): string {
    return 'AI Focused Editor ai-connect profile is incomplete. Configure provider, model, and API key in the Model Config view.';
  }

  async request(request: UserRequest, cancellationToken?: CancellationToken): Promise<LanguageModelResponse> {
    const chain = await this.resolveFailoverChain();
    if (chain.length === 0) {
      throw new Error(this.emptyChainMessage());
    }

    const generateRequest: AiGenerateRequest = {
      messages: this.toAiConnectMessages(request.messages),
      parameters: request.settings,
      clientTools: this.toClientTools(request.tools),
      logContext: {
        command: 'theia-ai-language-model-request',
        modelId: this.id,
        sessionId: request.sessionId,
        requestId: request.requestId,
        agentId: request.agentId,
        promptVariantId: request.promptVariantId
      }
    };

    const abortController = new AbortController();
    const token = cancellationToken ?? request.cancellationToken;
    if (token) {
      if (token.isCancellationRequested) {
        abortController.abort();
      }
      token.onCancellationRequested(() => abortController.abort());
    }

    const logSession = this.requestLog.beginRequest(request.agentId || 'chat', undefined, this.aliasForLog());

    return {
      stream: this.streamResponseParts(chain, request, generateRequest, abortController.signal, logSession)
    };
  }


  /**
   * FR-013 failover while streaming: profiles are tried in chain order; a
   * failure is retried on the next profile only while nothing has been
   * emitted yet (a half-streamed answer must not restart mid-response).
   */
  protected async *streamResponseParts(
    chain: AiConnectionProfile[],
    request: UserRequest,
    generateRequest: AiGenerateRequest,
    signal: AbortSignal,
    logSession?: AiRequestLogSession
  ): AsyncIterable<LanguageModelStreamResponsePart> {
    const failures: string[] = [];
    for (const [index, profile] of chain.entries()) {
      const legIndex = (logSession?.attemptedBase ?? 0) + index;
      const startedAt = Date.now();
      let emitted = false;
      try {
        for await (const event of this.aiConnection.streamText(profile, generateRequest, { signal })) {
          if (event.type === 'delta') {
            if (event.text.length > 0) {
              emitted = true;
              yield { content: event.text };
            }
            continue;
          }
          // ai-connect >= 0.10 streams the client-tool loop: surface activity as
          // Theia tool-call parts (the tool already RAN in-process — mark emitted
          // so failover never replays a round with side effects on another leg).
          if (event.type === 'tool-call') {
            emitted = true;
            yield {
              tool_calls: [{
                id: event.toolCall.id,
                function: { name: event.toolCall.name, arguments: JSON.stringify(event.toolCall.arguments ?? {}) },
                finished: false
              }]
            };
            continue;
          }
          if (event.type === 'tool-result') {
            emitted = true;
            yield {
              tool_calls: [{
                id: event.toolCallId,
                function: { name: event.name },
                finished: true,
                ...(event.isError ? { result: { content: [{ type: 'text', text: 'tool failed' }], isError: true } } : {})
              }]
            };
            continue;
          }

          logSession?.record(legIndex, profile, 'ok', Date.now() - startedAt, generateRequest, event.result);
          await this.tryAppendChatEvent(request, event.result, generateRequest);
          const usage = this.toTheiaUsage(event.result.usage);
          if (usage) {
            yield usage;
          }
        }
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSession?.record(legIndex, profile, 'error', Date.now() - startedAt, generateRequest, undefined, message);
        failures.push(`${profile.label ?? profile.id ?? profile.provider}: ${message}`);
        const isLast = index === chain.length - 1;
        if (emitted || signal.aborted || isLast) {
          throw new Error(failures.length > 1
            ? `All AI profiles failed. ${failures.join('; ')}`
            : message);
        }
      }
    }
  }

  /** Bounded copy of the outgoing messages for the provenance log. */
  protected toLoggedMessages(messages: MessageInput[]): { role: string; content: string }[] {
    const MAX_MESSAGE_CHARS = 4000;
    return messages.map(message => ({
      role: message.role,
      content: message.content.length > MAX_MESSAGE_CHARS
        ? `${message.content.slice(0, MAX_MESSAGE_CHARS)}…[+${message.content.length - MAX_MESSAGE_CHARS} chars]`
        : message.content
    }));
  }

  /**
   * Theia AI tools become ai-connect client tools (spec §3.5 Tools/Function
   * Calling); the ai-connect client runs the tool loop and invokes the Theia
   * tool handlers in-process. Only effective on api-transport profiles —
   * tools are stripped before requests cross the JSON-RPC boundary.
   */
  protected toClientTools(tools?: ToolRequest[]): AiClientToolDefinition[] | undefined {
    if (!tools || tools.length === 0) {
      return undefined;
    }
    return tools.map(tool => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters as unknown as Record<string, unknown>
      },
      execute: async (args: Record<string, unknown>) => {
        try {
          const result = await tool.handler(JSON.stringify(args ?? {}));
          if (typeof result === 'string') {
            return result;
          }
          return { content: JSON.stringify(result ?? '') };
        } catch (error) {
          return {
            content: error instanceof Error ? error.message : String(error),
            isError: true
          };
        }
      }
    }));
  }

  protected toAiConnectMessages(messages: LanguageModelMessage[]): MessageInput[] {
    const mapped = messages
      .map(message => this.toAiConnectMessage(message))
      .filter((message): message is MessageInput => message !== undefined && message.content.trim().length > 0);

    return mapped.length > 0
      ? mapped
      : [{
          role: 'user',
          content: ''
        }];
  }

  protected toAiConnectMessage(message: LanguageModelMessage): MessageInput | undefined {
    switch (message.type) {
      case 'text':
        return {
          role: this.toAiConnectRole(message.actor),
          content: (message as TextMessage).text ?? ''
        };
      case 'tool_result':
        return {
          role: 'tool',
          content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? ''),
          toolCallId: message.tool_use_id,
          toolName: message.name,
          isError: message.is_error
        };
      case 'tool_use':
        return {
          role: 'assistant',
          content: JSON.stringify({
            tool: message.name,
            input: message.input
          })
        };
      case 'server_tool_use':
        return {
          role: 'assistant',
          content: JSON.stringify({
            serverTool: message.name,
            input: message.input,
            result: message.result
          })
        };
      case 'thinking':
        return undefined;
      case 'image':
        return {
          role: this.toAiConnectRole(message.actor),
          content: '[Image content omitted by the AI Focused Editor ai-connect text adapter.]'
        };
    }
  }

  protected toAiConnectRole(actor: LanguageModelMessage['actor']): MessageRole {
    switch (actor) {
      case 'ai':
        return 'assistant';
      case 'system':
        return 'system';
      case 'user':
        return 'user';
    }
  }

  protected toTheiaUsage(usage: UsageInfo | undefined): UsageResponsePart | undefined {
    if (!usage) {
      return undefined;
    }
    return {
      input_tokens: usage.inputTokens ?? 0,
      output_tokens: usage.outputTokens ?? 0,
      cache_read_input_tokens: usage.cachedReadTokens
    };
  }

  protected async tryAppendChatEvent(
    request: UserRequest,
    result: AiGenerateResult,
    generateRequest: AiGenerateRequest
  ): Promise<void> {
    try {
      const MAX_RESPONSE_CHARS = 12000;
      await this.aiHistory.appendChatEvent({
        kind: 'theia-ai-language-model-request',
        command: 'theia-ai-language-model-request',
        data: {
          modelId: this.id,
          sessionId: request.sessionId,
          requestId: request.requestId,
          agentId: request.agentId,
          promptVariantId: request.promptVariantId,
          route: result.route,
          // Full provenance: WHAT was sent (bounded messages) and WHERE it
          // went (route above), plus the model's answer.
          messages: this.toLoggedMessages(generateRequest.messages),
          tools: (generateRequest.clientTools ?? []).map(tool => tool.function.name),
          responseText: (result.text ?? '').length > MAX_RESPONSE_CHARS
            ? `${result.text.slice(0, MAX_RESPONSE_CHARS)}…[+${result.text.length - MAX_RESPONSE_CHARS} chars]`
            : result.text,
          warnings: result.warnings,
          usage: result.usage
        }
      });
    } catch {
      // Theia AI must not fail because best-effort local history logging failed.
    }
  }
}
