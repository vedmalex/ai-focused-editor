import { describe, expect, it } from 'bun:test';
import { encodeQrSvgDataUrl } from './qr-encode';

function decodeSvg(dataUrl: string): string {
  const prefix = 'data:image/svg+xml;base64,';
  expect(dataUrl.startsWith(prefix)).toBe(true);
  return Buffer.from(dataUrl.slice(prefix.length), 'base64').toString('utf8');
}

describe('encodeQrSvgDataUrl', () => {
  it('produces a valid SVG data URL for a login URL', () => {
    const url = 'http://192.168.1.42:3000/auth/qr-login?token=deadbeefdeadbeefdeadbeef';
    const dataUrl = encodeQrSvgDataUrl(url);
    const svg = decodeSvg(dataUrl);
    expect(svg).toContain('<svg');
    expect(svg).toContain('viewBox="0 0');
    expect(svg).toContain('<path');
    // Must contain dark modules.
    expect(svg).toContain('fill="#000000"');
  });

  it('is deterministic for the same input', () => {
    const a = encodeQrSvgDataUrl('hello');
    const b = encodeQrSvgDataUrl('hello');
    expect(a).toBe(b);
  });

  it('scales up the version for longer input', () => {
    const short = decodeSvg(encodeQrSvgDataUrl('a'));
    const long = decodeSvg(encodeQrSvgDataUrl('a'.repeat(300)));
    const dim = (svg: string): number => {
      const m = svg.match(/viewBox="0 0 (\d+) /);
      return m ? Number.parseInt(m[1], 10) : 0;
    };
    expect(dim(long)).toBeGreaterThan(dim(short));
  });

  it('does not throw for a long URL near capacity', () => {
    expect(() => encodeQrSvgDataUrl('x'.repeat(1000))).not.toThrow();
  });
});
