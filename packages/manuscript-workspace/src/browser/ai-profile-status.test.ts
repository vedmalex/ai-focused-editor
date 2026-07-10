import { describe, expect, test } from 'bun:test';
import { buildUnconfiguredAiProfileStatus } from './ai-profile-status';

/**
 * Legacy single-profile mode was removed: when no named profile (and no alias)
 * exists there is NO active connection, and the status is an explicit
 * "not configured" snapshot the UI reads via `notConfigured`. This locks in that
 * empty-profiles shape. (The full DI-instantiated service cannot be imported
 * under bun — it pulls in Theia's DOM-dependent browser shell — so the pure
 * builder that `getStatus()` returns for the empty case is unit-tested directly.)
 */
describe('buildUnconfiguredAiProfileStatus', () => {
  test('reports an explicit not-configured state with no active profile', () => {
    const status = buildUnconfiguredAiProfileStatus();

    expect(status.notConfigured).toBe(true);
    expect(status.configured).toBe(false);
    expect(status.profile).toBeUndefined();
    expect(status.missing).toEqual(['no AI profile configured']);
  });

  test('surfaces an empty summary the UI can render as "not configured"', () => {
    const { summary } = buildUnconfiguredAiProfileStatus();

    expect(summary.activeProfileLabel).toBe('');
    expect(summary.chainLength).toBe(0);
    expect(summary.aliasMode).toBe(false);
    expect(summary.provider).toBe('');
    expect(summary.model).toBe('');
    expect(summary.hasApiKey).toBe(false);
    expect(summary.activeAlias).toBe('');
    expect(summary.activeEndpoint).toBe('');
    expect(summary.pinnedEndpoint).toBe('');
    expect(summary.skipped).toEqual([]);
  });
});
