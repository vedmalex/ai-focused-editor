import type {
  AiConnectionProfile,
  AiConnectionService,
  AiGenerateRequest,
  AiGenerateResult
} from './ai-connection-protocol';

export interface AiFailoverResult extends AiGenerateResult {
  /** The profile that produced the successful response. */
  profileUsed: AiConnectionProfile;
  /** Failures collected from earlier profiles in the chain. */
  failedAttempts: { profileId: string; error: string }[];
}

/** One attempted leg of the failover walk, reported to an optional recorder. */
export interface AiFailoverLegEvent {
  profile: AiConnectionProfile;
  /** 0-based position within the resolved chain. */
  index: number;
  outcome: 'ok' | 'error';
  durationMs: number;
  request: AiGenerateRequest;
  result?: AiGenerateResult;
  error?: string;
}

/**
 * Best-effort per-leg observer. Invoked synchronously for every attempted leg
 * (never for skipped legs — those are known at resolution time, not here).
 * Implementations MUST NOT throw; the failover walk does not guard the call.
 */
export type AiFailoverRecorder = (event: AiFailoverLegEvent) => void;

/**
 * FR-013 failover: try each profile in chain order until one succeeds.
 * Throws an aggregate error only when every profile in the chain failed.
 *
 * When a `recorder` is supplied it receives one event per attempted leg — this
 * is the observation point for the request log (per-leg outcomes are only known
 * here, as the walk proceeds).
 */
export async function generateWithFailover(
  service: AiConnectionService,
  chain: AiConnectionProfile[],
  request: AiGenerateRequest,
  recorder?: AiFailoverRecorder
): Promise<AiFailoverResult> {
  if (chain.length === 0) {
    throw new Error('No configured AI profiles available for this request.');
  }

  const failedAttempts: { profileId: string; error: string }[] = [];
  for (const [index, profile] of chain.entries()) {
    const startedAt = Date.now();
    try {
      const result = await service.generate(profile, request);
      recorder?.({ profile, index, outcome: 'ok', durationMs: Date.now() - startedAt, request, result });
      return {
        ...result,
        profileUsed: profile,
        failedAttempts
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      recorder?.({ profile, index, outcome: 'error', durationMs: Date.now() - startedAt, request, error: message });
      failedAttempts.push({
        profileId: profile.id ?? profile.provider,
        error: message
      });
    }
  }

  throw new Error(`All ${chain.length} AI profile(s) failed: ${failedAttempts
    .map(attempt => `${attempt.profileId}: ${attempt.error}`)
    .join('; ')}`);
}
