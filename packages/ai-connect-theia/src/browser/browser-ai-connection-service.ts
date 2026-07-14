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
  AiModelDiscoveryResult,
  AiStreamEvent,
  AiStreamOptions,
  AiTransportKind,
  LocalAiConnectionService,
  LocalAiStreamWireEvent
} from '../common';
import { LocalAiConnectionService as LocalAiConnectionServiceSymbol, toPortableFileInputs } from '../common';
import { LocalAiStreamClientImpl } from './local-ai-stream-client';
import {
  buildAiConnectConfigInput,
  getAiConnectTransportKind
} from '../common/ai-connect-config';

@injectable()
export class BrowserAiConnectionService implements AiConnectionService {
  @inject(LocalAiConnectionServiceSymbol)
  protected readonly localAiConnection!: LocalAiConnectionService;

  @inject(LocalAiStreamClientImpl)
  protected readonly localStreamClient!: LocalAiStreamClientImpl;

  protected streamCounter = 0;

  getTransportKind(profile: AiConnectionProfile): AiTransportKind {
    return getAiConnectTransportKind(profile);
  }

  async generate(profile: AiConnectionProfile, request: AiGenerateRequest): Promise<AiGenerateResult> {
    const transportKind = this.getTransportKind(profile);
    if (transportKind !== 'api') {
      return this.localAiConnection.generate(profile, this.stripClientTools(request));
    }

    const client = createBrowserClient(defineConfig(buildAiConnectConfigInput(profile)));
    const result = await client.generate({
      operation: 'text',
      messages: request.messages,
      parameters: request.parameters,
      workingDirectory: request.workingDirectory,
      logContext: request.logContext,
      clientTools: request.clientTools,
      attachments: toPortableFileInputs(request.attachments)
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

  async *streamText(
    profile: AiConnectionProfile,
    request: AiGenerateRequest,
    options?: AiStreamOptions
  ): AsyncIterable<AiStreamEvent> {
    const transportKind = this.getTransportKind(profile);
    if (transportKind !== 'api') {
      yield* this.streamLocalTransport(profile, request, options);
      return;
    }

    const client = createBrowserClient(defineConfig(buildAiConnectConfigInput(profile)));
    const callOptions = options?.signal || options?.pauseSignal
      ? {
          ...(options.signal ? { signal: options.signal } : {}),
          ...(options.pauseSignal ? { pauseSignal: options.pauseSignal } : {})
        }
      : undefined;
    const stream = client.stream({
      operation: 'text',
      messages: request.messages,
      parameters: request.parameters,
      workingDirectory: request.workingDirectory,
      logContext: request.logContext,
      clientTools: request.clientTools,
      attachments: toPortableFileInputs(request.attachments)
    }, callOptions);

    for await (const event of stream) {
      if (event.type === 'delta') {
        yield { type: 'delta', text: event.text };
        continue;
      }
      if (event.type === 'tool-call') {
        yield { type: 'tool-call', toolCall: event.toolCall };
        continue;
      }
      if (event.type === 'tool-result') {
        yield { type: 'tool-result', toolCallId: event.toolCallId, name: event.name, isError: event.isError };
        continue;
      }
      if (event.type === 'result' || event.type === 'paused') {
        yield {
          type: 'result',
          result: {
            text: event.result.text ?? '',
            route: event.result.route
              ? {
                  id: event.result.route.id,
                  provider: event.result.route.provider,
                  transportKind: event.result.route.transport.kind,
                  transportId: event.result.route.transport.id,
                  accountId: event.result.route.accountId,
                  model: event.result.route.model,
                  profileId: event.result.route.profileId
                }
              : undefined,
            warnings: event.result.warnings,
            attempts: event.result.attempts,
            usage: event.result.usage
          }
        };
      }
    }
  }

  /**
   * Streams a local-transport (acp/cli/server) request through the backend:
   * startStream runs the ai-connect stream server-side and pushes wire events
   * back over the JSON-RPC client channel, keyed by a unique streamId.
   */
  protected async *streamLocalTransport(
    profile: AiConnectionProfile,
    request: AiGenerateRequest,
    options?: AiStreamOptions
  ): AsyncIterable<AiStreamEvent> {
    const streamId = `afe-stream-${Date.now()}-${this.streamCounter++}`;
    const queue: LocalAiStreamWireEvent[] = [];
    let notify: (() => void) | undefined;
    const push = (event: LocalAiStreamWireEvent) => {
      queue.push(event);
      notify?.();
      notify = undefined;
    };

    this.localStreamClient.register(streamId, push);
    const onAbort = () => { void this.localAiConnection.cancelStream(streamId); };
    options?.signal?.addEventListener('abort', onAbort, { once: true });

    // A transport error before the stream starts surfaces as an error event.
    void this.localAiConnection.startStream(streamId, profile, this.stripClientTools(request)).catch(error => {
      push({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    });

    try {
      while (true) {
        while (queue.length > 0) {
          const event = queue.shift()!;
          if (event.type === 'end') {
            return;
          }
          if (event.type === 'error') {
            throw new Error(event.message);
          }
          yield event;
        }
        await new Promise<void>(resolve => { notify = resolve; });
      }
    } finally {
      this.localStreamClient.unregister(streamId);
      options?.signal?.removeEventListener('abort', onAbort);
    }
  }

  /** Functions cannot cross the JSON-RPC boundary; drop tools for local transports. */
  protected stripClientTools(request: AiGenerateRequest): AiGenerateRequest {
    if (!request.clientTools) {
      return request;
    }
    const { clientTools, ...rest } = request;
    return rest;
  }

  async discoverModels(profile: AiConnectionProfile): Promise<AiModelDiscoveryResult> {
    const transportKind = this.getTransportKind(profile);
    if (transportKind !== 'api') {
      return this.localAiConnection.discoverModels(profile);
    }

    const client = createBrowserClient(defineConfig(buildAiConnectConfigInput(profile)));
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
  }
}
