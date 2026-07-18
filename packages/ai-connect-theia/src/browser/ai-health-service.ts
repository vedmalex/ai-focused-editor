import { inject, injectable } from '@theia/core/shared/inversify';
import type {
  AiAliasDescriptor,
  AiConnectionProfile,
  AiConnectionService,
  AiEndpointHealth
} from '../common';
import {
  AiConnectionService as AiConnectionServiceSymbol,
  aggregateHealthLatency,
  deriveHealthStatus,
  summarizeHealthReport
} from '../common';
import { AiProfilePreferenceService } from './ai-profile-preference-service';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs a live health check across every CONFIGURED alias and returns one
 * {@link AiEndpointHealth} per alias (an overall status + best latency + a short
 * detail). Health is a live action, so there is NO cache — every call re-probes.
 * Book-agnostic and reusable in any Theia app: it only depends on the alias
 * registry ({@link AiProfilePreferenceService}) and the connection service's
 * {@link AiConnectionService.checkHealth}. Never throws — a failed check for one
 * alias surfaces as an `unreachable` entry carrying the error text, and the
 * other aliases are still reported.
 */
@injectable()
export class AiHealthService {
  @inject(AiProfilePreferenceService)
  protected readonly aiProfilePreferences!: AiProfilePreferenceService;

  @inject(AiConnectionServiceSymbol)
  protected readonly connectionService!: AiConnectionService;

  /** Live health of every configured alias (empty when none are configured). */
  async checkAll(): Promise<AiEndpointHealth[]> {
    const aliases = await this.aiProfilePreferences.listAliases();
    return Promise.all(aliases.map(alias => this.checkAlias(alias)));
  }

  /** Health of a single alias, resolving its representative failover leg first. */
  protected async checkAlias(alias: AiAliasDescriptor): Promise<AiEndpointHealth> {
    const label = alias.label || alias.id;
    let profile: AiConnectionProfile | undefined;
    try {
      const chain = await this.aiProfilePreferences.getFailoverChainForAlias(alias.id);
      // Prefer the first fully-usable leg (the one that will actually serve);
      // fall back to the head of the chain so we still report something.
      profile = chain.find(leg => Boolean(leg.provider) && Boolean(leg.model)) ?? chain[0];
    } catch (error) {
      return { id: alias.id, label, status: 'unreachable', detail: errorMessage(error) };
    }
    if (!profile) {
      return {
        id: alias.id,
        label,
        status: 'unreachable',
        detail: 'no usable endpoint in the alias chain'
      };
    }
    try {
      const report = await this.connectionService.checkHealth(profile);
      return {
        id: alias.id,
        label,
        status: deriveHealthStatus(report),
        latencyMs: aggregateHealthLatency(report),
        detail: summarizeHealthReport(report)
      };
    } catch (error) {
      return { id: alias.id, label, status: 'unreachable', detail: errorMessage(error) };
    }
  }
}
