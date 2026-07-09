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
  command?: string;
  env?: Record<string, string>;
}

export interface AiGenerateRequest {
  messages: MessageInput[];
  parameters?: GenerateParameters;
  workingDirectory?: string;
  logContext?: Record<string, unknown>;
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

export interface AiConnectionService {
  getTransportKind(profile: AiConnectionProfile): AiTransportKind;
  generate(profile: AiConnectionProfile, request: AiGenerateRequest): Promise<AiGenerateResult>;
}

export interface LocalAiConnectionService {
  generate(profile: AiConnectionProfile, request: AiGenerateRequest): Promise<AiGenerateResult>;
}
