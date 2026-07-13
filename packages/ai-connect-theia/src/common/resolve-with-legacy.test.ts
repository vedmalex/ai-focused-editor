import { describe, expect, it } from 'bun:test';
import { resolveWithLegacy } from './resolve-with-legacy';

describe('resolveWithLegacy', () => {
  it('returns the default when neither key is set', () => {
    expect(resolveWithLegacy({
      newValue: 'off', newSet: false,
      legacyValue: 'off', legacySet: false,
      defaultValue: 'off'
    })).toBe('off');
  });

  it('uses the legacy value when only the legacy key is set', () => {
    expect(resolveWithLegacy({
      newValue: undefined, newSet: false,
      legacyValue: 'full', legacySet: true,
      defaultValue: 'off'
    })).toBe('full');
  });

  it('the new key wins when it is explicitly set, even if legacy is also set', () => {
    expect(resolveWithLegacy({
      newValue: 'metadata', newSet: true,
      legacyValue: 'full', legacySet: true,
      defaultValue: 'off'
    })).toBe('metadata');
  });

  it('uses the new value when only the new key is set', () => {
    expect(resolveWithLegacy({
      newValue: 'metadata', newSet: true,
      legacyValue: undefined, legacySet: false,
      defaultValue: 'off'
    })).toBe('metadata');
  });

  it('honours an explicit new key whose value equals the default (explicit reset wins over legacy)', () => {
    expect(resolveWithLegacy({
      newValue: 'off', newSet: true,
      legacyValue: 'full', legacySet: true,
      defaultValue: 'off'
    })).toBe('off');
  });

  it('works with array/object values (endpoints/aliases)', () => {
    const legacy = [{ id: 'a' }];
    expect(resolveWithLegacy({
      newValue: [], newSet: false,
      legacyValue: legacy, legacySet: true,
      defaultValue: []
    })).toBe(legacy);
    const fresh = [{ id: 'b' }];
    expect(resolveWithLegacy({
      newValue: fresh, newSet: true,
      legacyValue: legacy, legacySet: true,
      defaultValue: []
    })).toBe(fresh);
  });

  it('falls back to default when the set value is undefined', () => {
    expect(resolveWithLegacy({
      newValue: undefined, newSet: true,
      legacyValue: undefined, legacySet: false,
      defaultValue: 'off'
    })).toBe('off');
  });
});
