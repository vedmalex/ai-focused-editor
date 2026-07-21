import { beforeAll, describe, expect, mock, test } from 'bun:test';
import { PreferenceScope } from '@theia/core/lib/common/preferences';
import type { PreferenceInspection } from '@theia/core/lib/common/preferences';
import {
  AI_CONNECT_ACTIVE_ALIAS,
  AI_CONNECT_ALIASES,
  AI_CONNECT_API_KEYS,
  AI_CONNECT_ENDPOINTS,
  AI_CONNECT_PINNED_ENDPOINT
} from './ai-connect-preferences';
import type { StoredAiAlias, StoredAiEndpoint } from '../common';

/**
 * `ai-profile-preference-service.ts` imports `WorkspaceService` from
 * `@theia/workspace/lib/browser/workspace-service`, which transitively pulls
 * in the `@theia/core/lib/browser` barrel (application-shell -> lumino
 * widgets -> lumino domutils) and throws "document is not defined" at MODULE
 * LOAD TIME under `bun test` (no DOM available) — the same limitation noted
 * in `ai-profile-status.test.ts`. Per tech-spec R5 we still need to exercise
 * the real `AiProfilePreferenceService` class (instantiated without
 * inversify, fakes assigned to its `preferenceService`/`workspaceService`
 * fields directly), so only the WORKSPACE-SERVICE MODULE SPECIFIER is
 * swapped for a side-effect-free stub before import. The stub class is never
 * used by any test below — every test assigns its own fake `workspaceService`
 * instance to the constructed service.
 */
mock.module('@theia/workspace/lib/browser/workspace-service', () => ({
  WorkspaceService: class {}
}));

type SetCall = { name: string; value: unknown; scope: PreferenceScope | undefined; resourceUri: string | undefined };

interface FakePreferenceService {
  ready: Promise<void>;
  set: (name: string, value: unknown, scope?: PreferenceScope, resourceUri?: string) => Promise<void>;
  updateValue: (name: string, value: unknown) => Promise<void>;
  inspect: (name: string, resourceUri?: string) => PreferenceInspection<unknown> | undefined;
  setCalls: SetCall[];
  inspections: Map<string, PreferenceInspection<unknown>>;
}

function createFakePreferenceService(): FakePreferenceService {
  const setCalls: SetCall[] = [];
  const inspections = new Map<string, PreferenceInspection<unknown>>();
  return {
    ready: Promise.resolve(),
    setCalls,
    inspections,
    async set(name, value, scope, resourceUri) {
      setCalls.push({ name, value, scope, resourceUri });
    },
    async updateValue() {
      // Only reached when there is no workspace root; unused by these tests.
    },
    inspect(name) {
      return inspections.get(name);
    }
  };
}

function inspectionOf<T>(value: T, at: 'default' | 'workspace' | 'workspaceFolder' | 'user'): PreferenceInspection<T> {
  const base: PreferenceInspection<T> = {
    preferenceName: 'test',
    defaultValue: undefined,
    globalValue: undefined,
    workspaceValue: undefined,
    workspaceFolderValue: undefined,
    value
  };
  if (at === 'default') {
    return { ...base, defaultValue: value };
  }
  if (at === 'user') {
    return { ...base, globalValue: value };
  }
  if (at === 'workspace') {
    return { ...base, workspaceValue: value };
  }
  return { ...base, workspaceFolderValue: value };
}

function createFakeWorkspaceService(roots: Array<{ resource: { toString(): string } }>) {
  return {
    ready: Promise.resolve(),
    tryGetRoots: () => roots,
    roots: Promise.resolve(roots)
  };
}

const ROOT_URI = 'file:///workspace/root';

let AiProfilePreferenceServiceCtor: typeof import('./ai-profile-preference-service').AiProfilePreferenceService;

beforeAll(async () => {
  ({ AiProfilePreferenceService: AiProfilePreferenceServiceCtor } = await import('./ai-profile-preference-service'));
});

function createService(hasRoot = true) {
  const preferenceService = createFakePreferenceService();
  const workspaceService = createFakeWorkspaceService(
    hasRoot ? [{ resource: { toString: () => ROOT_URI } }] : []
  );
  const service = new AiProfilePreferenceServiceCtor();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (service as any).preferenceService = preferenceService;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (service as any).workspaceService = workspaceService;
  return { service, preferenceService, workspaceService };
}

describe('AiProfilePreferenceService — writeScope (Б4-service)', () => {
  test('(a) default writeScope is "folder": a plain call writes PreferenceScope.Folder at the workspace root, byte-for-byte today\'s behavior', async () => {
    const { service, preferenceService } = createService();
    expect(service.getWriteScope()).toBe('folder');

    const endpoint: StoredAiEndpoint = { id: 'ep-1', provider: 'openai', label: 'Endpoint One' };
    await service.upsertEndpoint(endpoint);

    const call = preferenceService.setCalls.find(c => c.name === AI_CONNECT_ENDPOINTS);
    expect(call).toBeDefined();
    expect(call!.value).toEqual([endpoint]);
    expect(call!.scope).toBe(PreferenceScope.Folder);
    expect(call!.resourceUri).toBe(ROOT_URI);
  });

  test('(a2) with no workspace root, the default scope falls back to updateValue (unchanged legacy behavior)', async () => {
    const preferenceService = createFakePreferenceService();
    const updateValueCalls: Array<[string, unknown]> = [];
    preferenceService.updateValue = async (name, value) => {
      updateValueCalls.push([name, value]);
    };
    const workspaceService = createFakeWorkspaceService([]);
    const service = new AiProfilePreferenceServiceCtor();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).preferenceService = preferenceService;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).workspaceService = workspaceService;

    await service.setPinnedEndpoint('ep-1');

    expect(preferenceService.setCalls.find(c => c.name === AI_CONNECT_PINNED_ENDPOINT)).toBeUndefined();
    expect(updateValueCalls).toEqual([[AI_CONNECT_PINNED_ENDPOINT, 'ep-1']]);
  });

  test('(b) setWriteScope("user") redirects a plain call to PreferenceScope.User with NO resourceUri, without touching the call site', async () => {
    const { service, preferenceService } = createService();

    service.setWriteScope('user');
    expect(service.getWriteScope()).toBe('user');

    await service.setPinnedEndpoint('ep-2');

    const call = preferenceService.setCalls.find(c => c.name === AI_CONNECT_PINNED_ENDPOINT);
    expect(call).toBeDefined();
    expect(call!.value).toBe('ep-2');
    expect(call!.scope).toBe(PreferenceScope.User);
    expect(call!.resourceUri).toBeUndefined();
  });

  test('(b2) setWriteScope round-trips through every non-secret call site (endpoints, aliases, active alias)', async () => {
    const { service, preferenceService } = createService();
    service.setWriteScope('user');

    await service.setActiveAlias('alias-1');
    await service.upsertEndpoint({ id: 'ep-1', provider: 'openai' });
    await service.upsertAlias({ id: 'alias-1', chain: [{ endpointId: 'ep-1', model: 'gpt-4' }] });

    const userCalls = preferenceService.setCalls.filter(c => c.name !== AI_CONNECT_API_KEYS);
    expect(userCalls.length).toBeGreaterThan(0);
    for (const call of userCalls) {
      expect(call.scope).toBe(PreferenceScope.User);
      expect(call.resourceUri).toBeUndefined();
    }
  });

  test('(c) setApiKey ALWAYS writes PreferenceScope.User, independent of writeScope="folder" (the surprising, security-relevant case)', async () => {
    const { service, preferenceService } = createService();
    expect(service.getWriteScope()).toBe('folder'); // explicit: folder is active, not user

    await service.setApiKey('ep-1', 'sk-secret-123');

    const call = preferenceService.setCalls.find(c => c.name === AI_CONNECT_API_KEYS);
    expect(call).toBeDefined();
    expect(call!.value).toEqual({ 'ep-1': 'sk-secret-123' });
    expect(call!.scope).toBe(PreferenceScope.User);
    expect(call!.resourceUri).toBeUndefined();
  });

  test('(c2) setApiKey ALSO writes PreferenceScope.User when writeScope is explicitly "user" (not a coincidence of the default)', async () => {
    const { service, preferenceService } = createService();
    service.setWriteScope('user');

    await service.setApiKey('ep-1', 'sk-secret-456');

    const call = preferenceService.setCalls.find(c => c.name === AI_CONNECT_API_KEYS);
    expect(call!.scope).toBe(PreferenceScope.User);
  });

  test('(c3) deleteEndpoint\'s key cleanup ALSO hardcodes PreferenceScope.User for the secret, while the endpoint-list write follows writeScope="folder"', async () => {
    const { service, preferenceService } = createService();
    preferenceService.inspections.set(
      AI_CONNECT_ENDPOINTS,
      inspectionOf<StoredAiEndpoint[]>([{ id: 'ep-1', provider: 'openai' }], 'workspaceFolder')
    );
    preferenceService.inspections.set(AI_CONNECT_API_KEYS, inspectionOf<Record<string, string>>({ 'ep-1': 'sk-secret' }, 'user'));

    await service.deleteEndpoint('ep-1');

    const endpointsCall = preferenceService.setCalls.find(c => c.name === AI_CONNECT_ENDPOINTS);
    const keysCall = preferenceService.setCalls.find(c => c.name === AI_CONNECT_API_KEYS);
    expect(endpointsCall).toBeDefined();
    expect(endpointsCall!.value).toEqual([]);
    expect(endpointsCall!.scope).toBe(PreferenceScope.Folder); // writeScope='folder' default, unaffected by the secret rule
    expect(keysCall).toBeDefined();
    expect(keysCall!.value).toEqual({});
    expect(keysCall!.scope).toBe(PreferenceScope.User); // hardcoded, regardless of writeScope
  });

  test('(d) getPreferenceEffectiveScope resolves folder > workspace > user > default, mirroring inspect() precedence', () => {
    const { service, preferenceService } = createService();

    preferenceService.inspections.set('pref.folder', inspectionOf('folder-value', 'workspaceFolder'));
    expect(service.getPreferenceEffectiveScope('pref.folder')).toBe('folder');

    preferenceService.inspections.set('pref.workspace', inspectionOf('ws-value', 'workspace'));
    expect(service.getPreferenceEffectiveScope('pref.workspace')).toBe('workspace');

    preferenceService.inspections.set('pref.user', inspectionOf('user-value', 'user'));
    expect(service.getPreferenceEffectiveScope('pref.user')).toBe('user');

    preferenceService.inspections.set('pref.default', inspectionOf('default-value', 'default'));
    expect(service.getPreferenceEffectiveScope('pref.default')).toBe('default');

    // No inspection at all (unknown preference name) also resolves to 'default'.
    expect(service.getPreferenceEffectiveScope('pref.unknown')).toBe('default');
  });

  test('(d2) folder wins over workspace and user when multiple scopes carry a value simultaneously', () => {
    const { service, preferenceService } = createService();
    preferenceService.inspections.set('pref.mixed', {
      preferenceName: 'pref.mixed',
      defaultValue: 'd',
      globalValue: 'u',
      workspaceValue: 'w',
      workspaceFolderValue: 'f',
      value: 'f'
    });
    expect(service.getPreferenceEffectiveScope('pref.mixed')).toBe('folder');
  });

  test('smoke: read paths (listAliases, getStatus, getFailoverChainForAlias) are identical for writeScope="folder" vs "user" — writeScope only governs writes', async () => {
    const endpoint: StoredAiEndpoint = { id: 'ep-1', provider: 'openai', label: 'Endpoint One', allowedModels: ['gpt-4'] };
    const alias: StoredAiAlias = { id: 'alias-1', label: 'Alias One', chain: [{ endpointId: 'ep-1', model: 'gpt-4' }] };
    const buildInspectedService = (writeScope: 'folder' | 'user') => {
      const { service, preferenceService } = createService();
      preferenceService.inspections.set(AI_CONNECT_ENDPOINTS, inspectionOf<StoredAiEndpoint[]>([endpoint], 'workspaceFolder'));
      preferenceService.inspections.set(AI_CONNECT_ALIASES, inspectionOf<StoredAiAlias[]>([alias], 'workspaceFolder'));
      preferenceService.inspections.set(AI_CONNECT_ACTIVE_ALIAS, inspectionOf('alias-1', 'workspaceFolder'));
      preferenceService.inspections.set(AI_CONNECT_API_KEYS, inspectionOf<Record<string, string>>({ 'ep-1': 'sk-secret' }, 'user'));
      service.setWriteScope(writeScope);
      return service;
    };

    const folderScoped = buildInspectedService('folder');
    const userScoped = buildInspectedService('user');

    const [aliasesFolder, aliasesUser] = await Promise.all([folderScoped.listAliases(), userScoped.listAliases()]);
    expect(aliasesUser).toEqual(aliasesFolder);
    expect(aliasesFolder).toEqual([
      { id: 'alias-1', label: 'Alias One', active: true, enabled: true, chain: alias.chain, availableLegs: 1 }
    ]);

    const [statusFolder, statusUser] = await Promise.all([folderScoped.getStatus(), userScoped.getStatus()]);
    expect(statusUser).toEqual(statusFolder);
    expect(statusFolder.configured).toBe(true);

    const [chainFolder, chainUser] = await Promise.all([
      folderScoped.getFailoverChainForAlias('alias-1'),
      userScoped.getFailoverChainForAlias('alias-1')
    ]);
    expect(chainUser).toEqual(chainFolder);
    expect(chainFolder).toHaveLength(1);
    expect(chainFolder[0].id).toBe('ep-1');
  });
});
