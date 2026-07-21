import { beforeAll, describe, expect, mock, test } from 'bun:test';
import { keysToSecretsFragment } from '../common';
import type { RegistryFileLayer } from '../common';

/**
 * `model-config-widget.ts` extends `ReactWidget` (`@theia/core/lib/browser/widgets/react-widget`)
 * and also imports `ConfirmDialog` from the `@theia/core/lib/browser` barrel, plus
 * `WorkspaceService` (`@theia/workspace/lib/browser/workspace-service`) and the
 * filesystem browser surface (`@theia/filesystem/lib/browser`,
 * `@theia/filesystem/lib/browser/file-service`). Each of these transitively pulls
 * in the `@theia/core/lib/browser` shell (application-shell -> lumino widgets ->
 * lumino domutils), which touches `document` at MODULE LOAD TIME and throws
 * "document is not defined" under `bun test` (no DOM). Per the same pattern as
 * `ai-profile-preference-service.scope.test.ts` (group C) and
 * `ai-profile-status.test.ts`, only these MODULE SPECIFIERS are swapped for
 * side-effect-free stubs before the widget is imported — every test below
 * assigns its OWN fakes onto the constructed instance's fields directly, so the
 * stub classes themselves are never exercised except `ConfirmDialog`, whose
 * `open()` result each test controls explicitly.
 */
mock.module('@theia/workspace/lib/browser/workspace-service', () => ({
  WorkspaceService: class {}
}));
mock.module('@theia/core/lib/browser/widgets/react-widget', () => ({
  ReactWidget: class {
    toDispose = { push: () => { /* no-op */ } };
    title: Record<string, unknown> = {};
    update(): void { /* no-op */ }
  }
}));

let confirmResult = false;
let confirmCtorCalls: unknown[] = [];
mock.module('@theia/core/lib/browser', () => ({
  ConfirmDialog: class {
    constructor(props: unknown) {
      confirmCtorCalls.push(props);
    }
    async open(): Promise<boolean> {
      return confirmResult;
    }
  }
}));
mock.module('@theia/filesystem/lib/browser', () => ({
  FileDialogService: class {}
}));
mock.module('@theia/filesystem/lib/browser/file-service', () => ({
  FileService: class {}
}));

let ModelConfigWidgetCtor: typeof import('./model-config-widget').ModelConfigWidget;

beforeAll(async () => {
  ({ ModelConfigWidget: ModelConfigWidgetCtor } = await import('./model-config-widget'));
});

interface FakeRegistryFiles {
  saveSecretsToLayerCalls: Array<{ layer: RegistryFileLayer; fragment: unknown; mode: string; opts: unknown }>;
  saveToLayerCalls: Array<{ layer: RegistryFileLayer; registry: unknown; mode: string; opts: unknown }>;
  saveSecretsToLayer: (layer: RegistryFileLayer, fragment: unknown, mode: 'merge' | 'replace', opts?: unknown) => Promise<{ path: string; mode: 'merge' | 'replace'; created: boolean }>;
  saveToLayer: (layer: RegistryFileLayer, registry: unknown, mode: 'merge' | 'replace', opts?: unknown) => Promise<{ path: string; mode: 'merge' | 'replace'; created: boolean; strippedFields: string[]; backupPath?: string }>;
}

function createFakeRegistryFiles(): FakeRegistryFiles {
  const saveSecretsToLayerCalls: FakeRegistryFiles['saveSecretsToLayerCalls'] = [];
  const saveToLayerCalls: FakeRegistryFiles['saveToLayerCalls'] = [];
  return {
    saveSecretsToLayerCalls,
    saveToLayerCalls,
    async saveSecretsToLayer(layer, fragment, mode, opts) {
      saveSecretsToLayerCalls.push({ layer, fragment, mode, opts });
      return { path: '/fake/connections.secrets.json', mode, created: false };
    },
    async saveToLayer(layer, registry, mode, opts) {
      saveToLayerCalls.push({ layer, registry, mode, opts });
      return { path: '/fake/connections.json', mode, created: false, strippedFields: [] };
    }
  };
}

interface FakeMessages {
  warnCalls: unknown[];
  infoCalls: unknown[];
  errorCalls: unknown[];
  warn: (...args: unknown[]) => Promise<undefined>;
  info: (...args: unknown[]) => Promise<undefined>;
  error: (...args: unknown[]) => Promise<undefined>;
}

function createFakeMessages(): FakeMessages {
  const warnCalls: unknown[] = [];
  const infoCalls: unknown[] = [];
  const errorCalls: unknown[] = [];
  return {
    warnCalls,
    infoCalls,
    errorCalls,
    async warn(...args) { warnCalls.push(args); return undefined; },
    async info(...args) { infoCalls.push(args); return undefined; },
    async error(...args) { errorCalls.push(args); return undefined; }
  };
}

function createWidget(apiKeys: Record<string, string>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const widget = new (ModelConfigWidgetCtor as any)();
  const registryFiles = createFakeRegistryFiles();
  const messages = createFakeMessages();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (widget as any).registryFiles = registryFiles;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (widget as any).messages = messages;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (widget as any).aiProfilePreferences = {
    getApiKeys: () => apiKeys,
    readEndpoints: () => [],
    readAliases: () => [],
    getActiveAliasId: () => undefined
  };
  // exportConnections() reads getProjectCwd() unconditionally (for `opts.cwd`);
  // registryLayerChoice defaults to 'user' so currentRegistryLayer() never needs
  // a workspace root, but getProjectCwd() itself still calls workspaceService.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (widget as any).workspaceService = { tryGetRoots: () => [] };
  return { widget, registryFiles, messages };
}

const LAYER: RegistryFileLayer = 'project';
const CWD = '/fake/project';
const REGISTRY_PATH = '/fake/project/.config/ai-connect/connections.json';

describe('ModelConfigWidget — double consent-gate on secrets export (F-B-1)', () => {
  test('(a) exportSecretsConsent=false — the REAL exportConnections() entry point never reaches exportSecrets/saveSecretsToLayer, even though the main connections.json export still runs', async () => {
    // Gate 1 (the checkbox) lives in exportConnections, NOT in exportSecrets
    // itself (`if (this.exportSecretsConsent) { await this.exportSecrets(...); }`).
    // Calling exportSecrets directly would bypass gate 1 entirely and this test
    // would pass vacuously even if the checkbox check were deleted from
    // exportConnections — so this test drives the REAL public entry point the
    // "Export connections.json…" button calls.
    const { widget, registryFiles } = createWidget({ 'ep-1': 'sk-secret' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (widget as any).exportSecretsConsent = false;
    confirmResult = true; // even if the dialog WOULD confirm, it must never be asked
    confirmCtorCalls = [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (widget as any).exportConnections();

    expect(registryFiles.saveToLayerCalls).toHaveLength(1); // the main (non-secret) export DID run
    expect(registryFiles.saveSecretsToLayerCalls).toHaveLength(0); // but secrets never touched
    expect(confirmCtorCalls).toHaveLength(0); // gate 2 was never even reached
  });

  test('(b) exportSecretsConsent=true but ConfirmDialog.open() resolves false — saveSecretsToLayer is NOT called (early return before the write)', async () => {
    const { widget, registryFiles, messages } = createWidget({ 'ep-1': 'sk-secret' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (widget as any).exportSecretsConsent = true;
    confirmResult = false;
    confirmCtorCalls = [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (widget as any).exportSecrets(LAYER, CWD, REGISTRY_PATH);

    expect(confirmCtorCalls).toHaveLength(1); // the dialog WAS shown (gate 2 was reached)
    expect(registryFiles.saveSecretsToLayerCalls).toHaveLength(0); // but declined -> no write
    expect(messages.infoCalls.some(call => String(call).includes('Wrote'))).toBe(false);
  });

  test('(c) both gates pass (consent=true, ConfirmDialog.open()->true) — saveSecretsToLayer is called EXACTLY once with keysToSecretsFragment(getApiKeys())', async () => {
    const apiKeys = { 'ep-1': 'sk-secret-abc', 'ep-2': 'sk-secret-def' };
    const { widget, registryFiles } = createWidget(apiKeys);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (widget as any).exportSecretsConsent = true;
    confirmResult = true;
    confirmCtorCalls = [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (widget as any).exportSecrets(LAYER, CWD, REGISTRY_PATH);

    expect(confirmCtorCalls).toHaveLength(1);
    expect(registryFiles.saveSecretsToLayerCalls).toHaveLength(1);
    const call = registryFiles.saveSecretsToLayerCalls[0];
    expect(call.layer).toBe(LAYER);
    expect(call.fragment).toEqual(keysToSecretsFragment(apiKeys));
    expect(call.mode).toBe('merge');
    expect(call.opts).toEqual({ cwd: CWD });
  });

  test('(d) no API keys configured (getApiKeys -> {}) — saveSecretsToLayer is NOT called and the dialog is never shown (warn instead)', async () => {
    const { widget, registryFiles, messages } = createWidget({});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (widget as any).exportSecretsConsent = true;
    confirmResult = true; // would confirm if asked -> proves the early empty-keys return fires first
    confirmCtorCalls = [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (widget as any).exportSecrets(LAYER, CWD, REGISTRY_PATH);

    expect(confirmCtorCalls).toHaveLength(0); // never reached the confirm gate
    expect(registryFiles.saveSecretsToLayerCalls).toHaveLength(0);
    expect(messages.warnCalls).toHaveLength(1);
  });

  test('(d2) API keys with only blank/whitespace values count as zero secrets — same as (d)', async () => {
    const { widget, registryFiles, messages } = createWidget({ 'ep-1': '   ', 'ep-2': '' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (widget as any).exportSecretsConsent = true;
    confirmResult = true;
    confirmCtorCalls = [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (widget as any).exportSecrets(LAYER, CWD, REGISTRY_PATH);

    expect(confirmCtorCalls).toHaveLength(0);
    expect(registryFiles.saveSecretsToLayerCalls).toHaveLength(0);
    expect(messages.warnCalls).toHaveLength(1);
  });
});

describe('ModelConfigWidget — strippedFields diagnostic on export (F-QA-2)', () => {
  test('a non-empty result.strippedFields from saveToLayer surfaces a neutral messages.info notice', async () => {
    // storedToRegistry's whitelist should never emit secret fields on its own, so a
    // non-empty strippedFields is normally a foreign on-disk inline secret (benign,
    // 'merge' mode). But if storedToRegistry ever regresses and starts emitting
    // auth.token itself, THIS is the only place that would notice — the library
    // silently drops the field before writing, so nothing else observes the leak.
    // Pin the diagnostic wiring: saveToLayer -> strippedFields -> messages.info.
    const { widget, registryFiles, messages } = createWidget({});
    // consent=false so the secrets branch is never reached — isolates the
    // strippedFields diagnostic from the unrelated secrets-export gate.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (widget as any).exportSecretsConsent = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (widget as any).registryFiles.saveToLayer = async (
      layer: RegistryFileLayer, registry: unknown, mode: string, opts: unknown
    ) => {
      registryFiles.saveToLayerCalls.push({ layer, registry, mode, opts });
      return { path: '/fake/connections.json', mode, created: false, strippedFields: ['auth.token'] };
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (widget as any).exportConnections();

    expect(registryFiles.saveToLayerCalls).toHaveLength(1);
    const strippedNotice = messages.infoCalls.find(call => String(call).includes('auth.token'));
    expect(strippedNotice).toBeDefined(); // the diagnostic notice fired with the stripped field name
  });

  test('an empty result.strippedFields — the default fake behavior — does NOT trigger the diagnostic notice', async () => {
    // Companion negative case: proves the assertion above is actually discriminating
    // on strippedFields.length, not firing unconditionally on every export.
    const { widget, registryFiles, messages } = createWidget({});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (widget as any).exportSecretsConsent = false;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (widget as any).exportConnections();

    expect(registryFiles.saveToLayerCalls).toHaveLength(1);
    expect(messages.infoCalls.some(call => String(call).includes('auth.token'))).toBe(false);
  });
});

describe('ModelConfigWidget — hadActiveAlias guard on import (F-QA-3)', () => {
  function registryWithDefaultAlias() {
    return {
      version: 2 as const,
      endpoints: [{ id: 'gw', provider: 'openai', transport: 'api', baseUrl: 'http://g/v1' }],
      aliases: [{ id: 'a1', chain: [{ endpointId: 'gw', model: 'm1' }] }],
      defaults: { alias: 'a1' }
    };
  }

  function createImportWidget(activeAliasIdBeforeImport: string | undefined) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const widget = new (ModelConfigWidgetCtor as any)();
    const setActiveAliasCalls: unknown[] = [];
    const upsertEndpointCalls: unknown[] = [];
    const upsertAliasCalls: unknown[] = [];
    const setApiKeyCalls: unknown[] = [];
    const aiProfilePreferences = {
      getApiKeys: () => ({}),
      readEndpoints: () => [],
      readAliases: () => [],
      getActiveAliasId: () => activeAliasIdBeforeImport,
      upsertEndpoint: async (ep: unknown) => { upsertEndpointCalls.push(ep); },
      upsertAlias: async (al: unknown) => { upsertAliasCalls.push(al); },
      setApiKey: async (id: string, key: string) => { setApiKeyCalls.push([id, key]); },
      setActiveAlias: async (aliasId: string) => { setActiveAliasCalls.push(aliasId); }
    };
    const registryFiles = {
      loadFromLayer: async () => ({
        found: true,
        registry: registryWithDefaultAlias(),
        path: '/fake/project/.config/ai-connect/connections.json',
        issues: [],
        notes: []
      })
    };
    const messages = createFakeMessages();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (widget as any).registryFiles = registryFiles;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (widget as any).messages = messages;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (widget as any).aiProfilePreferences = aiProfilePreferences;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (widget as any).workspaceService = { tryGetRoots: () => [] };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (widget as any).refresh = async () => { /* no-op */ };
    return { widget, setActiveAliasCalls };
  }

  test('(i) an active alias already exists — the imported defaults.alias does NOT override the user\'s choice', async () => {
    const { widget, setActiveAliasCalls } = createImportWidget('user-picked-alias');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (widget as any).importConnections();

    // RED-before: if the `!hadActiveAlias` guard were removed from importConnections,
    // this would call setActiveAlias('a1') and the assertion below would fail —
    // this is the guard actually being exercised, not a vacuous pass.
    expect(setActiveAliasCalls).toHaveLength(0);
  });

  test('(ii) no active alias before import — the imported defaults.alias IS applied via setActiveAlias', async () => {
    const { widget, setActiveAliasCalls } = createImportWidget(undefined);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (widget as any).importConnections();

    expect(setActiveAliasCalls).toEqual(['a1']);
  });
});
