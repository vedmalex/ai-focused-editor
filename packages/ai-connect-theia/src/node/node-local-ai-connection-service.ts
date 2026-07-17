import { defineConfig, type GenerateResult } from '@vedmalex/ai-connect';
import { createLocalClient } from '@vedmalex/ai-connect/local';
import { injectable } from '@theia/core/shared/inversify';
import {
  AiConnectionProfile,
  AiGenerateRequest,
  AiGenerateResult,
  AiModelDiscoveryResult,
  AiRouteCapabilities,
  CONSERVATIVE_LOCAL_CAPABILITIES,
  LocalAiConnectionService,
  LocalAiStreamClient,
  LocalAiStreamWireEvent,
  resolveCandidateCapabilities,
  toPortableFileInputs
} from '../common';
import {
  buildAiConnectConfigInput,
  getAiConnectTransportKind
} from '../common/ai-connect-config';

@injectable()
export class NodeLocalAiConnectionService implements LocalAiConnectionService {
  /** Connected frontend windows; stream events are routed by streamId. */
  protected readonly clients = new Set<LocalAiStreamClient>();
  protected readonly activeStreams = new Map<string, AbortController>();

  addClient(client: LocalAiStreamClient): void {
    this.clients.add(client);
  }

  removeClient(client: LocalAiStreamClient): void {
    this.clients.delete(client);
  }

  async startStream(streamId: string, profile: AiConnectionProfile, request: AiGenerateRequest): Promise<void> {
    const abortController = new AbortController();
    this.activeStreams.set(streamId, abortController);
    const client = createLocalClient(
      defineConfig(buildAiConnectConfigInput(profile)),
      this.buildLocalClientOptions(profile)
    );

    try {
      const stream = client.stream({
        operation: 'text',
        messages: request.messages,
        parameters: request.parameters,
        workingDirectory: request.workingDirectory,
        logContext: request.logContext,
        // data-URL/base64/url attachments are plain strings, so they cross the
        // JSON-RPC boundary intact (only function-carrying clientTools cannot).
        attachments: toPortableFileInputs(request.attachments)
      }, { signal: abortController.signal });

      for await (const event of stream) {
        if (event.type === 'delta') {
          this.emit(streamId, { type: 'delta', text: event.text });
          continue;
        }
        if (event.type === 'result' || event.type === 'paused') {
          this.emit(streamId, { type: 'result', result: this.toGenerateResult(event.result) });
        }
      }
      this.emit(streamId, { type: 'end' });
    } catch (error) {
      this.emit(streamId, {
        type: 'error',
        message: error instanceof Error ? error.message : String(error)
      });
    } finally {
      this.activeStreams.delete(streamId);
      await client.dispose();
    }
  }

  async cancelStream(streamId: string): Promise<void> {
    this.activeStreams.get(streamId)?.abort();
  }

  protected emit(streamId: string, event: LocalAiStreamWireEvent): void {
    for (const client of this.clients) {
      try {
        client.onLocalAiStreamEvent(streamId, event);
      } catch {
        this.clients.delete(client);
      }
    }
  }

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
        logContext: request.logContext,
        attachments: toPortableFileInputs(request.attachments)
      });

      return this.toGenerateResult(result);
    } finally {
      await client.dispose();
    }
  }

  protected toGenerateResult(result: GenerateResult): AiGenerateResult {
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

  async discoverModels(profile: AiConnectionProfile): Promise<AiModelDiscoveryResult> {
    const client = createLocalClient(
      defineConfig(buildAiConnectConfigInput(profile)),
      this.buildLocalClientOptions(profile)
    );

    try {
      const report = await client.discoverModels();
      const models = report.routes
        .flatMap(route => route.availableModels)
        .map(model => ({
          modelId: model.modelId,
          name: model.name,
          description: model.description,
          contextLength: model.contextLength
        }));
      const failedRoutes = report.routes.filter(route => !route.ok);
      return {
        ok: report.ok,
        models,
        detail: failedRoutes.length > 0
          ? failedRoutes.map(route => `${route.routeId}: ${route.error?.message ?? 'model discovery failed'}`).join('; ')
          : undefined
      };
    } finally {
      await client.dispose();
    }
  }

  /**
   * Read the local route's capabilities via the local client's synchronous,
   * no-I/O `listCandidateModels` projector — no process is spawned. Falls back
   * to the conservative local default (streaming only) when the route reports no
   * candidates or the projection throws, so callers always get an honest answer.
   */
  async getCapabilities(profile: AiConnectionProfile): Promise<AiRouteCapabilities | undefined> {
    const client = createLocalClient(
      defineConfig(buildAiConnectConfigInput(profile)),
      this.buildLocalClientOptions(profile)
    );
    try {
      const candidates = client.listCandidateModels({ operation: 'text' });
      return resolveCandidateCapabilities(candidates, profile.model) ?? CONSERVATIVE_LOCAL_CAPABILITIES;
    } catch {
      return CONSERVATIVE_LOCAL_CAPABILITIES;
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
