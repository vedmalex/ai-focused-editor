import { describe, expect, test } from 'bun:test';
import { resolveDeviceTheme, type DeviceThemeInput } from './device-theme';

const AVAILABLE = ['light', 'dark', 'dracula', 'nord', 'one-dark-pro', 'solarized-light', 'gruvbox-dark-medium'];

function base(overrides: Partial<DeviceThemeInput> = {}): DeviceThemeInput {
  return {
    systemDark: false,
    userThemeSet: false,
    availableIds: AVAILABLE,
    darkDefault: 'one-dark-pro',
    lightDefault: 'light',
    ...overrides
  };
}

describe('resolveDeviceTheme — URL param', () => {
  test('exact available theme id wins and persists', () => {
    expect(resolveDeviceTheme(base({ param: 'nord' }))).toEqual({
      themeId: 'nord',
      source: 'param',
      store: 'nord'
    });
  });

  test("alias 'dark' maps to darkDefault and persists the resolved id", () => {
    expect(resolveDeviceTheme(base({ param: 'dark' }))).toEqual({
      themeId: 'one-dark-pro',
      source: 'param',
      store: 'one-dark-pro'
    });
  });

  test("alias 'light' maps to lightDefault and persists the resolved id", () => {
    expect(resolveDeviceTheme(base({ param: 'light' }))).toEqual({
      themeId: 'light',
      source: 'param',
      store: 'light'
    });
  });

  test('unknown param id is ignored (source none), does not persist', () => {
    expect(resolveDeviceTheme(base({ param: 'no-such-theme' }))).toEqual({ source: 'none' });
  });

  test('param wins even when a valid stored override exists (does not fall through)', () => {
    const res = resolveDeviceTheme(base({ param: 'dracula', stored: 'nord' }));
    expect(res).toEqual({ themeId: 'dracula', source: 'param', store: 'dracula' });
  });

  test('unknown param does NOT fall through to a stored override', () => {
    // param present but invalid -> app default, stored ignored.
    expect(resolveDeviceTheme(base({ param: 'bogus', stored: 'nord' }))).toEqual({ source: 'none' });
  });

  test('whitespace-only param is treated as absent', () => {
    expect(resolveDeviceTheme(base({ param: '   ', stored: 'nord' }))).toEqual({
      themeId: 'nord',
      source: 'stored'
    });
  });

  test('param is trimmed before resolving', () => {
    expect(resolveDeviceTheme(base({ param: '  dracula ' }))).toEqual({
      themeId: 'dracula',
      source: 'param',
      store: 'dracula'
    });
  });
});

describe('resolveDeviceTheme — stored override', () => {
  test('valid stored override wins, no store side effect', () => {
    const res = resolveDeviceTheme(base({ stored: 'gruvbox-dark-medium' }));
    expect(res).toEqual({ themeId: 'gruvbox-dark-medium', source: 'stored' });
    expect('store' in res).toBe(false);
  });

  test('stored override wins over system-dark following', () => {
    expect(resolveDeviceTheme(base({ stored: 'solarized-light', systemDark: true }))).toEqual({
      themeId: 'solarized-light',
      source: 'stored'
    });
  });

  test('stored override wins even when the user set a theme (device is explicit)', () => {
    expect(resolveDeviceTheme(base({ stored: 'nord', userThemeSet: true }))).toEqual({
      themeId: 'nord',
      source: 'stored'
    });
  });

  test('stale stored id is cleaned up (store: null) and falls through to app default', () => {
    expect(resolveDeviceTheme(base({ stored: 'deleted-theme' }))).toEqual({
      source: 'none',
      store: null
    });
  });

  test('stale stored id + system dark -> follows system AND cleans up', () => {
    expect(resolveDeviceTheme(base({ stored: 'deleted-theme', systemDark: true }))).toEqual({
      themeId: 'one-dark-pro',
      source: 'system',
      store: null
    });
  });
});

describe('resolveDeviceTheme — system following', () => {
  test('system dark + no explicit user theme -> darkDefault', () => {
    expect(resolveDeviceTheme(base({ systemDark: true }))).toEqual({
      themeId: 'one-dark-pro',
      source: 'system'
    });
  });

  test('system light -> no override (keep app default), never forces a light theme', () => {
    expect(resolveDeviceTheme(base({ systemDark: false }))).toEqual({ source: 'none' });
  });

  test('userThemeSet suppresses system-dark following', () => {
    expect(resolveDeviceTheme(base({ systemDark: true, userThemeSet: true }))).toEqual({ source: 'none' });
  });

  test('system-dark ignored when darkDefault is not an available id', () => {
    expect(resolveDeviceTheme(base({ systemDark: true, darkDefault: 'missing-dark' }))).toEqual({
      source: 'none'
    });
  });
});

describe('resolveDeviceTheme — nothing set', () => {
  test('no param, no stored, system light, no user theme -> app default', () => {
    expect(resolveDeviceTheme(base())).toEqual({ source: 'none' });
  });
});
