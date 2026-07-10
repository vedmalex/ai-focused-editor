import { describe, expect, test } from 'bun:test';
import { buildUnconfiguredAiProfileStatus } from './ai-profile-status';

/**
 * The middle "AI profile" layer was removed: the connection model is now exactly
 * ENDPOINT + ALIAS. When no alias exists there is NO active connection, and
 * `getStatus()` returns this explicit "not configured" snapshot the UI reads via
 * `notConfigured`. When an alias exists resolution always runs through the alias
 * chain, so `summary.aliasMode` is effectively always-true for a configured
 * connection and only this unconfigured snapshot carries `aliasMode: false`.
 * (The full DI-instantiated service cannot be imported under bun — it pulls in
 * Theia's DOM-dependent browser shell — so the pure builder that `getStatus()`
 * returns for the empty case is unit-tested directly.)
 */
describe('buildUnconfiguredAiProfileStatus', () => {
  test('reports an explicit not-configured state with no active connection', () => {
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
    // aliasMode is false ONLY in the unconfigured snapshot; any configured
    // connection resolves through an alias chain (aliasMode true).
    expect(summary.aliasMode).toBe(false);
    expect(summary.provider).toBe('');
    expect(summary.model).toBe('');
    expect(summary.hasApiKey).toBe(false);
    expect(summary.activeAlias).toBe('');
    expect(summary.activeAliasLabel).toBe('');
    expect(summary.activeEndpoint).toBe('');
    expect(summary.activeEndpointLabel).toBe('');
    expect(summary.pinnedEndpoint).toBe('');
    expect(summary.skipped).toEqual([]);
  });
});
