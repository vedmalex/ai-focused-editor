import { inject, injectable } from '@theia/core/shared/inversify';
import type {
  AiConnectionProfile,
  AiConnectionService,
  AliasLegProbe,
  AliasCheckVerdict,
  AliasLegVerdict,
  EndpointCheckVerdict,
  EndpointDiscoveryOutcome
} from '../common';
import {
  AiConnectionService as AiConnectionServiceSymbol,
  assembleAliasCheckVerdict,
  assembleAliasLegVerdict,
  assembleEndpointCheckVerdict,
  classifyChainLegSkip
} from '../common';
import { AiProfilePreferenceService } from './ai-profile-preference-service';

/** The 8-token probe reused across both verification stages. */
const VERIFY_MESSAGES = [
  { role: 'system' as const, content: 'Reply with exactly: OK' },
  { role: 'user' as const, content: 'Verify this AI connection.' }
];
const VERIFY_PARAMETERS = { maxTokens: 8, temperature: 0 };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs the two-stage AI-connection verification against live endpoints/aliases.
 * The RPC (model discovery + a minimal test generation) lives here; the verdict
 * assembly is delegated to the pure `ai-verification` helpers so it stays
 * unit-testable. Shared by the Model Config widget and the global
 * "Verify AI Connection..." command.
 */
@injectable()
export class AiVerificationService {
  @inject(AiProfilePreferenceService)
  protected readonly aiProfilePreferences!: AiProfilePreferenceService;

  @inject(AiConnectionServiceSymbol)
  protected readonly aiConnection!: AiConnectionService;

  /**
   * Stage 1 — reach an endpoint and fetch its model list. Never throws: a
   * transport error resolves to an unreachable verdict carrying the detail.
   */
  async checkEndpoint(profile: AiConnectionProfile): Promise<EndpointCheckVerdict> {
    return assembleEndpointCheckVerdict(await this.discover(profile));
  }

  /**
   * Stage 2 — verify each leg of an alias chain in order (connection + model
   * presence + a single-leg test generation), plus an overall verdict.
   * Defaults to the active alias.
   */
  async checkAlias(aliasId?: string, now: Date = new Date()): Promise<AliasCheckVerdict> {
    const aliases = this.aiProfilePreferences.readAliases();
    const activeId = aliasId || this.aiProfilePreferences.getActiveAliasId();
    const alias = aliases.find(candidate => candidate.id === activeId) ?? aliases[0];
    if (!alias) {
      return assembleAliasCheckVerdict(activeId || '', activeId || '', []);
    }

    const endpointsById = new Map(this.aiProfilePreferences.readEndpoints().map(endpoint => [endpoint.id, endpoint]));
    const chain = Array.isArray(alias.chain) ? alias.chain : [];
    const legs: AliasLegVerdict[] = [];

    for (let index = 0; index < chain.length; index++) {
      const leg = chain[index];
      const endpoint = endpointsById.get(leg.endpointId);
      const skip = classifyChainLegSkip(endpoint, now);
      const probe: AliasLegProbe = { index, endpointId: leg.endpointId, model: leg.model };
      if (skip || !endpoint) {
        probe.skip = skip ?? 'missing-endpoint';
        legs.push(assembleAliasLegVerdict(probe));
        continue;
      }

      // Build a one-off profile for THIS leg only (endpoint + leg model) so the
      // generation exercises exactly this leg, not the whole chain failover.
      const profile = this.aiProfilePreferences.buildEndpointProbeProfile(endpoint, leg.model);
      probe.discovery = await this.discover(profile);
      probe.generation = await this.generateLeg(profile);
      legs.push(assembleAliasLegVerdict(probe));
    }

    return assembleAliasCheckVerdict(alias.id, alias.label || alias.id, legs);
  }

  protected async discover(profile: AiConnectionProfile): Promise<EndpointDiscoveryOutcome> {
    try {
      const report = await this.aiConnection.discoverModels(profile);
      return {
        ok: report.ok,
        models: report.models.map(model => model.modelId),
        detail: report.detail
      };
    } catch (error) {
      return { ok: false, models: [], detail: errorMessage(error) };
    }
  }

  protected async generateLeg(profile: AiConnectionProfile): Promise<{ ok: boolean; text?: string; error?: string }> {
    try {
      const result = await this.aiConnection.generate(profile, {
        messages: VERIFY_MESSAGES,
        parameters: VERIFY_PARAMETERS,
        logContext: { command: 'ai-focused-editor.ai.verifyAliasLeg', endpointId: profile.id, model: profile.model }
      });
      return { ok: true, text: result.text };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }
}
