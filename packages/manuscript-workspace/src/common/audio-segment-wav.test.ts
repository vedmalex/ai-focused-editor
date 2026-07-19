import { describe, expect, test } from 'bun:test';
import {
  PcmAudioData,
  WAV_HEADER_SIZE,
  encodeWavPcm16,
  extractSegmentWav,
  sliceSegmentSamples
} from './audio-segment-wav';

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += String.fromCharCode(bytes[offset + i]);
  }
  return out;
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

describe('encodeWavPcm16 — header correctness', () => {
  const mono: PcmAudioData = { sampleRate: 16000, channels: [new Float32Array([0, 0.5, -0.5, 1])] };

  test('writes the canonical 44-byte RIFF/WAVE PCM16 header', () => {
    const wav = encodeWavPcm16(mono);
    const dv = view(wav);
    const dataSize = 4 * 2; // 4 frames × 1 channel × 2 bytes

    expect(wav.byteLength).toBe(WAV_HEADER_SIZE + dataSize);
    expect(ascii(wav, 0, 4)).toBe('RIFF');
    expect(dv.getUint32(4, true)).toBe(36 + dataSize);
    expect(ascii(wav, 8, 4)).toBe('WAVE');
    expect(ascii(wav, 12, 4)).toBe('fmt ');
    expect(dv.getUint32(16, true)).toBe(16); // fmt chunk size
    expect(dv.getUint16(20, true)).toBe(1); // PCM
    expect(dv.getUint16(22, true)).toBe(1); // channels
    expect(dv.getUint32(24, true)).toBe(16000); // sample rate
    expect(dv.getUint32(28, true)).toBe(16000 * 2); // byte rate
    expect(dv.getUint16(32, true)).toBe(2); // block align
    expect(dv.getUint16(34, true)).toBe(16); // bits per sample
    expect(ascii(wav, 36, 4)).toBe('data');
    expect(dv.getUint32(40, true)).toBe(dataSize);
  });

  test('encodes PCM16 samples with asymmetric scaling and clamping', () => {
    const wav = encodeWavPcm16({ sampleRate: 8000, channels: [new Float32Array([0, 1, -1, 0.5, 2, -2])] });
    const dv = view(wav);
    expect(dv.getInt16(44, true)).toBe(0);
    expect(dv.getInt16(46, true)).toBe(0x7fff); // +1 → 32767
    expect(dv.getInt16(48, true)).toBe(-0x8000); // −1 → −32768
    expect(dv.getInt16(50, true)).toBe(0x3fff); // 0.5 × 0x7fff → 16383 (truncated)
    expect(dv.getInt16(52, true)).toBe(0x7fff); // clamped
    expect(dv.getInt16(54, true)).toBe(-0x8000); // clamped
  });

  test('stereo: interleaves frame-major and doubles block align', () => {
    const stereo: PcmAudioData = {
      sampleRate: 44100,
      channels: [new Float32Array([1, 1]), new Float32Array([-1, -1])]
    };
    const wav = encodeWavPcm16(stereo);
    const dv = view(wav);
    expect(dv.getUint16(22, true)).toBe(2);
    expect(dv.getUint16(32, true)).toBe(4); // block align 2ch × 2B
    expect(dv.getUint32(28, true)).toBe(44100 * 4);
    expect(dv.getUint32(40, true)).toBe(2 * 2 * 2);
    // L R L R
    expect(dv.getInt16(44, true)).toBe(0x7fff);
    expect(dv.getInt16(46, true)).toBe(-0x8000);
    expect(dv.getInt16(48, true)).toBe(0x7fff);
    expect(dv.getInt16(50, true)).toBe(-0x8000);
  });

  test('more than 2 channels are dropped (clamped to stereo, like the source)', () => {
    const wav = encodeWavPcm16({
      sampleRate: 8000,
      channels: [new Float32Array([0]), new Float32Array([0]), new Float32Array([0])]
    });
    expect(view(wav).getUint16(22, true)).toBe(2);
  });

  test('throws without channel data', () => {
    expect(() => encodeWavPcm16({ sampleRate: 8000, channels: [] })).toThrow('not available');
  });
});

describe('sliceSegmentSamples', () => {
  const audio: PcmAudioData = {
    sampleRate: 10, // 10 samples per second keeps the math obvious
    channels: [new Float32Array(Array.from({ length: 30 }, (_, i) => i / 100))]
  };

  test('slices [start, end] with floor/ceil frame rounding', () => {
    const slice = sliceSegmentSamples(audio, 1, 2);
    expect(slice.sampleRate).toBe(10);
    expect(slice.channels[0]).toHaveLength(10);
    expect(slice.channels[0][0]).toBeCloseTo(0.1);
    expect(slice.channels[0][9]).toBeCloseTo(0.19);
  });

  test('clamps out-of-range times into the buffer and forces ≥ 1 frame', () => {
    const clamped = sliceSegmentSamples(audio, -5, 100);
    expect(clamped.channels[0]).toHaveLength(30);
    const tiny = sliceSegmentSamples(audio, 2.9999, 2.9999);
    expect(tiny.channels[0].length).toBeGreaterThanOrEqual(1);
  });

  test('an inverted range still yields at least one frame', () => {
    const slice = sliceSegmentSamples(audio, 2, 1);
    expect(slice.channels[0].length).toBeGreaterThanOrEqual(1);
  });
});

describe('extractSegmentWav', () => {
  test('composes slice + encode: header sizes match the sliced range', () => {
    const audio: PcmAudioData = { sampleRate: 10, channels: [new Float32Array(30)] };
    const wav = extractSegmentWav(audio, 0, 1); // 10 frames
    expect(wav.byteLength).toBe(WAV_HEADER_SIZE + 10 * 2);
    expect(view(wav).getUint32(40, true)).toBe(20);
  });
});
