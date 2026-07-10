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

/**
 * FR-013 failover: try each profile in chain order until one succeeds.
 * Throws an aggregate error only when every profile in the chain failed.
 */
export async function generateWithFailover(
  service: AiConnectionService,
  chain: AiConnectionProfile[],
  request: AiGenerateRequest
): Promise<AiFailoverResult> {
  if (chain.length === 0) {
    throw new Error('No configured AI profiles available for this request.');
  }

  const failedAttempts: { profileId: string; error: string }[] = [];
  for (const profile of chain) {
    try {
      const result = await service.generate(profile, request);
      return {
        ...result,
        profileUsed: profile,
        failedAttempts
      };
    } catch (error) {
      failedAttempts.push({
        profileId: profile.id ?? profile.provider,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  throw new Error(`All ${chain.length} AI profile(s) failed: ${failedAttempts
    .map(attempt => `${attempt.profileId}: ${attempt.error}`)
    .join('; ')}`);
}
