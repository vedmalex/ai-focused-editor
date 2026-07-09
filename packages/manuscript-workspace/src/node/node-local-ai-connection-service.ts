import { defineConfig } from '@vedmalex/ai-connect';
import { createLocalClient } from '@vedmalex/ai-connect/local';
import { injectable } from '@theia/core/shared/inversify';
import {
  AiConnectionProfile,
  AiGenerateRequest,
  AiGenerateResult,
  LocalAiConnectionService
} from '../common';
import {
  buildAiConnectConfigInput,
  getAiConnectTransportKind
} from '../common/ai-connect-config';

@injectable()
export class NodeLocalAiConnectionService implements LocalAiConnectionService {
  async generate(profile: AiConnectionProfile, request: AiGenerateRequest): Promise<AiGenerateResult> {
    const client = createLocalClient(
      defineConfig(buildAiConnectConfigInput(profile)),
      this.buildLocalClientOptions(profile)
    );

    try {
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
    } finally {
      await client.dispose();
    }
  }

  protected buildLocalClientOptions(profile: AiConnectionProfile) {
    const env = profile.env && typeof profile.env === 'object' ? profile.env : {};
    const transportKind = getAiConnectTransportKind(profile);
    return {
      acp: {
        permissionMode: 'approve-reads' as const,
        env
      },
      cli: {
        env
      },
      server: {
        env
      },
      runtime: {
        kind: 'local' as const,
        cwd: process.cwd()
      },
      logContext: {
        transportKind
      }
    };
  }
}
