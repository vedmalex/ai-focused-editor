import { describe, expect, it } from 'bun:test';
import { isLoopbackAddress, parseCookies, shouldGateConnection } from './browser-auth-gate';

describe('isLoopbackAddress', () => {
  it('recognizes IPv4 loopback range', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('127.1.2.3')).toBe(true);
  });
  it('recognizes IPv6 loopback and IPv4-mapped', () => {
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::1%lo0')).toBe(true);
  });
  it('treats remote and undefined as non-loopback', () => {
    expect(isLoopbackAddress('10.0.0.5')).toBe(false);
    expect(isLoopbackAddress('192.168.1.10')).toBe(false);
    expect(isLoopbackAddress('::ffff:10.0.0.1')).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });
});

describe('parseCookies', () => {
  it('parses multiple cookies and decodes values', () => {
    const c = parseCookies('a=1; afe_session=abc.def; b=%20x%20');
    expect(c.a).toBe('1');
    expect(c.afe_session).toBe('abc.def');
    expect(c.b).toBe(' x ');
  });
  it('tolerates empty/malformed input', () => {
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies('')).toEqual({});
    expect(parseCookies('novalue; =orphan')).toEqual({});
  });
});

describe('shouldGateConnection', () => {
  it('never gates when disabled', () => {
    expect(shouldGateConnection({ enabled: false, forceEnabled: false, remoteAddress: '10.0.0.1' })).toBe(false);
    expect(shouldGateConnection({ enabled: false, forceEnabled: true, remoteAddress: '10.0.0.1' })).toBe(false);
  });
  it('passes loopback through unless force-enabled', () => {
    expect(shouldGateConnection({ enabled: true, forceEnabled: false, remoteAddress: '127.0.0.1' })).toBe(false);
    expect(shouldGateConnection({ enabled: true, forceEnabled: false, remoteAddress: '::1' })).toBe(false);
    expect(shouldGateConnection({ enabled: true, forceEnabled: true, remoteAddress: '127.0.0.1' })).toBe(true);
  });
  it('gates remote connections when enabled', () => {
    expect(shouldGateConnection({ enabled: true, forceEnabled: false, remoteAddress: '10.0.0.1' })).toBe(true);
  });
});
