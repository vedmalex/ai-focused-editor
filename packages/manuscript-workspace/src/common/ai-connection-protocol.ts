import type {
  GenerateParameters,
  MessageInput,
  RouteAttempt,
  TransportKind,
  UsageInfo
} from '@vedmalex/ai-connect';

export const AiConnectionService = Symbol('AiConnectionService');
export const LocalAiConnectionService = Symbol('LocalAiConnectionService');
export const LocalAiConnectionServicePath = '/services/ai-focused-editor/local-ai-connection';

export type AiTransportKind = TransportKind;

export interface AiConnectionProfile {
  id?: string;
  label?: string;
  provider: string;
  transportKind?: AiTransportKind | 'proxy';
  transportId?: string;
  connectorType?: string;
  connectorRef?: string;
  authMethodId?: string;
  endpointUrl?: string;
  endpoint?: string;
  url?: string;
  secretValue?: string;
  model?: string;
  allowedModels?: string[];
  command?: string;
  env?: Record<string, string>;
}

/**
 * Function tool exposed to the model; the ai-connect client runs the tool
 * loop and calls `execute` in-process. Tools carry functions, so they only
 * work on the browser api transport — they are stripped before requests cross
 * the JSON-RPC boundary to local transports.
 */
export interface AiClientToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
  execute: (args: Record<string, unknown>) => string | { content?: string; isError?: boolean } | Promise<string | { content?: string; isError?: boolean }>;
}

export interface AiGenerateRequest {
  messages: MessageInput[];
  parameters?: GenerateParameters;
  workingDirectory?: string;
  logContext?: Record<string, unknown>;
  clientTools?: AiClientToolDefinition[];
}

export interface AiGenerateResult {
  text: string;
  route?: {
    id: string;
    provider: string;
    transportKind: AiTransportKind;
    transportId: string;
    accountId: string;
    model: string;
    profileId?: string;
  };
  warnings: string[];
  attempts: RouteAttempt[];
  usage?: UsageInfo;
}

export interface AiDiscoveredModel {
  modelId: string;
  name: string;
  description?: string;
  contextLength?: number;
}

export interface AiModelDiscoveryResult {
  ok: boolean;
  models: AiDiscoveredModel[];
  detail?: string;
}

export type AiStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'result'; result: AiGenerateResult };

export interface AiStreamOptions {
  signal?: AbortSignal;
}

export interface AiConnectionService {
  getTransportKind(profile: AiConnectionProfile): AiTransportKind;
  generate(profile: AiConnectionProfile, request: AiGenerateRequest): Promise<AiGenerateResult>;
  discoverModels(profile: AiConnectionProfile): Promise<AiModelDiscoveryResult>;
  /**
   * Streams text deltas for api-transport profiles; transports that cannot
   * stream (acp/cli/server over JSON-RPC) degrade to a single delta+result.
   */
  streamText(profile: AiConnectionProfile, request: AiGenerateRequest, options?: AiStreamOptions): AsyncIterable<AiStreamEvent>;
}

/** Wire events pushed from the backend to the frontend during a local-transport stream. */
export type LocalAiStreamWireEvent =
  | AiStreamEvent
  | { type: 'error'; message: string }
  | { type: 'end' };

/** Frontend callback surface the backend invokes over the JSON-RPC channel. */
export interface LocalAiStreamClient {
  onLocalAiStreamEvent(streamId: string, event: LocalAiStreamWireEvent): void;
}

export interface LocalAiConnectionService {
  generate(profile: AiConnectionProfile, request: AiGenerateRequest): Promise<AiGenerateResult>;
  discoverModels(profile: AiConnectionProfile): Promise<AiModelDiscoveryResult>;
  /**
   * Starts a backend stream for acp/cli/server transports; deltas arrive via
   * LocalAiStreamClient callbacks keyed by streamId. Resolves when the stream
   * finishes (after the terminal 'end'/'error' event was pushed).
   */
  startStream(streamId: string, profile: AiConnectionProfile, request: AiGenerateRequest): Promise<void>;
  cancelStream(streamId: string): Promise<void>;
}
