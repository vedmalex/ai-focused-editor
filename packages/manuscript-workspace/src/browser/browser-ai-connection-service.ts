import {
  createBrowserClient,
  defineConfig
} from '@vedmalex/ai-connect/browser';
import { inject, injectable } from '@theia/core/shared/inversify';
import type {
  AiConnectionProfile,
  AiConnectionService,
  AiGenerateRequest,
  AiGenerateResult,
  AiTransportKind,
  LocalAiConnectionService
} from '../common';
import { LocalAiConnectionService as LocalAiConnectionServiceSymbol } from '../common';
import {
  buildAiConnectConfigInput,
  getAiConnectTransportKind
} from '../common/ai-connect-config';

@injectable()
export class BrowserAiConnectionService implements AiConnectionService {
  @inject(LocalAiConnectionServiceSymbol)
  protected readonly localAiConnection!: LocalAiConnectionService;

  getTransportKind(profile: AiConnectionProfile): AiTransportKind {
    return getAiConnectTransportKind(profile);
  }

  async generate(profile: AiConnectionProfile, request: AiGenerateRequest): Promise<AiGenerateResult> {
    const transportKind = this.getTransportKind(profile);
    if (transportKind !== 'api') {
      return this.localAiConnection.generate(profile, request);
    }

    const client = createBrowserClient(defineConfig(buildAiConnectConfigInput(profile)));
    const result = await client.generate({
      operation: 'text',
      messages: request.messages,
      parameters: request.parameters,
      workingDirectory: request.workingDirectory,
      logContext: request.logContext
    });

    return {
      text: result.text ?? '',
      route: result.route
        ? {
            id: result.route.id,
            provider: result.route.provider,
            transportKind: result.route.transport.kind,
            transportId: result.route.transport.id,
            accountId: result.route.accountId,
            model: result.route.model,
            profileId: result.route.profileId
          }
        : undefined,
      warnings: result.warnings,
      attempts: result.attempts,
      usage: result.usage
    };
  }
}
