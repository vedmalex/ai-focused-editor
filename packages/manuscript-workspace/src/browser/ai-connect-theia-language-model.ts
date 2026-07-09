import type {
  LanguageModel,
  LanguageModelMessage,
  LanguageModelResponse,
  TextMessage,
  UsageResponsePart,
  UserRequest
} from '@theia/ai-core';
import type {
  MessageInput,
  MessageRole,
  UsageInfo
} from '@vedmalex/ai-connect';
import { inject, injectable } from '@theia/core/shared/inversify';
import {
  AiConnectionService,
  AiGenerateResult
} from '../common';
import { AiHistoryService } from './ai-history-service';
import { AiProfilePreferenceService } from './ai-profile-preference-service';

@injectable()
export class AiConnectTheiaLanguageModel implements LanguageModel {
  static readonly ID = 'ai-focused-editor.ai-connect';

  readonly id = AiConnectTheiaLanguageModel.ID;
  readonly name = 'AI Focused Editor ai-connect';
  readonly vendor = '@vedmalex/ai-connect';
  readonly family = 'ai-connect';
  readonly status = {
    status: 'ready' as const,
    message: 'Delegates Theia AI requests to the configured AI Focused Editor ai-connect profile.'
  };

  @inject(AiConnectionService)
  protected readonly aiConnection!: AiConnectionService;

  @inject(AiProfilePreferenceService)
  protected readonly aiProfilePreferences!: AiProfilePreferenceService;

  @inject(AiHistoryService)
  protected readonly aiHistory!: AiHistoryService;

  async request(request: UserRequest): Promise<LanguageModelResponse> {
    const profile = await this.aiProfilePreferences.getConfiguredProfile();
    if (!profile) {
      throw new Error('AI Focused Editor ai-connect profile is incomplete. Configure provider, model, and API key in preferences.');
    }

    const result = await this.aiConnection.generate(profile, {
      messages: this.toAiConnectMessages(request.messages),
      parameters: request.settings,
      logContext: {
        command: 'theia-ai-language-model-request',
        sessionId: request.sessionId,
        requestId: request.requestId,
        agentId: request.agentId,
        promptVariantId: request.promptVariantId
      }
    });

    await this.tryAppendChatEvent(request, result);

    return {
      text: result.text,
      usage: this.toTheiaUsage(result.usage)
    };
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
          content: (message as TextMessage).text
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

  protected async tryAppendChatEvent(request: UserRequest, result: AiGenerateResult): Promise<void> {
    try {
      await this.aiHistory.appendChatEvent({
        kind: 'theia-ai-language-model-request',
        command: 'theia-ai-language-model-request',
        data: {
          sessionId: request.sessionId,
          requestId: request.requestId,
          agentId: request.agentId,
          promptVariantId: request.promptVariantId,
          route: result.route,
          warnings: result.warnings,
          usage: result.usage
        }
      });
    } catch {
      // Theia AI must not fail because best-effort local history logging failed.
    }
  }
}
