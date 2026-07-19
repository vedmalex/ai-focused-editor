/**
 * PCM16/WAV encoding for transcript segments — a pure-TS port of
 * audio_transcript_check's `src/lib/audioSegment.js` (`extractSegmentWavBlob`),
 * DECOUPLED from the DOM: instead of an `AudioBuffer` + `Blob` it accepts plain
 * Float32Array channel data + a sample rate and returns a `Uint8Array` holding
 * a complete RIFF/WAVE file (44-byte canonical header + interleaved PCM16 LE).
 *
 * The browser layer wraps the result in a `Blob`/`File` for playback or as the
 * STT upload; the node layer can write it to disk as-is. Theia/DOM-free —
 * runs directly under `bun test`.
 */

/** MIME type of the encoded result. */
export const WAV_MIME_TYPE = 'audio/wav';

/** Size of the canonical RIFF/WAVE header this encoder writes. */
export const WAV_HEADER_SIZE = 44;

/** Plain decoded PCM audio: per-channel sample arrays (values in [-1, 1]) + rate. */
export interface PcmAudioData {
  sampleRate: number;
  /** One Float32Array per channel; all channels must share a length. */
  channels: readonly Float32Array[];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function writeString(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

function encodePcm16(samples: Float32Array, view: DataView, offset: number): void {
  let writeOffset = offset;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = clamp(samples[index], -1, 1);
    view.setInt16(writeOffset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    writeOffset += 2;
  }
}

/**
 * Slice the sample range for a `[startSec, endSec]` segment out of decoded
 * audio. Frame clamping is the exact port of `audioSegment.js:31-33`: start
 * floors, end ceils, the range is clamped into the buffer and forced to at
 * least one frame. Returns a new {@link PcmAudioData} (channels are copies).
 */
export function sliceSegmentSamples(audio: PcmAudioData, startSec: number, endSec: number): PcmAudioData {
  if (!audio || !Array.isArray(audio.channels as unknown[]) || audio.channels.length === 0) {
    throw new Error('Decoded audio data is not available.');
  }
  const sampleRate = audio.sampleRate;
  const totalFrames = audio.channels[0].length;
  const startFrame = clamp(Math.floor(startSec * sampleRate), 0, totalFrames);
  const endFrame = clamp(Math.ceil(endSec * sampleRate), startFrame + 1, totalFrames);
  const frameLength = Math.max(1, endFrame - startFrame);
  return {
    sampleRate,
    channels: audio.channels.map(channel => {
      const slice = new Float32Array(frameLength);
      for (let frameIndex = 0; frameIndex < frameLength; frameIndex += 1) {
        slice[frameIndex] = channel[startFrame + frameIndex] || 0;
      }
      return slice;
    })
  };
}

/**
 * Encode decoded PCM audio into a complete WAV file (PCM16 LE). Channel count
 * is clamped to 1–2 (extra channels are dropped, matching the source's
 * `Math.min(2, numberOfChannels)`), samples are interleaved frame-major, and
 * the canonical 44-byte header is written exactly as `audioSegment.js:45-65`.
 */
export function encodeWavPcm16(audio: PcmAudioData): Uint8Array {
  if (!audio || !Array.isArray(audio.channels as unknown[]) || audio.channels.length === 0) {
    throw new Error('Decoded audio data is not available.');
  }
  const sampleRate = audio.sampleRate;
  const frameLength = Math.max(1, audio.channels[0].length);
  const channelCount = Math.max(1, Math.min(2, audio.channels.length || 1));
  const interleaved = new Float32Array(frameLength * channelCount);

  for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
    const source = audio.channels[channelIndex];
    for (let frameIndex = 0; frameIndex < frameLength; frameIndex += 1) {
      interleaved[frameIndex * channelCount + channelIndex] = source[frameIndex] || 0;
    }
  }

  const bytesPerSample = 2;
  const blockAlign = channelCount * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = interleaved.length * bytesPerSample;
  const buffer = new ArrayBuffer(WAV_HEADER_SIZE + dataSize);
  const view = new DataView(buffer);

  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bytesPerSample * 8, true);
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);
  encodePcm16(interleaved, view, WAV_HEADER_SIZE);

  return new Uint8Array(buffer);
}

/**
 * Convenience composition of {@link sliceSegmentSamples} +
 * {@link encodeWavPcm16}: the WAV bytes for one `[startSec, endSec]` segment —
 * the functional equivalent of the source's `extractSegmentWavBlob`.
 */
export function extractSegmentWav(audio: PcmAudioData, startSec: number, endSec: number): Uint8Array {
  return encodeWavPcm16(sliceSegmentSamples(audio, startSec, endSec));
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Encode bytes to standard base64 (with `=` padding). Pure TS — no `btoa`
 * (browser-only, chokes past ~64k when spread into `String.fromCharCode`) and
 * no `Buffer` (node-only), so the SAME code runs in the widget, the backend,
 * and under `bun test`. Used to ship an in-memory WAV slice through the
 * `TranscribeSegmentFileRequest.audioBase64` field.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const byte0 = bytes[index];
    const byte1 = index + 1 < bytes.length ? bytes[index + 1] : 0;
    const byte2 = index + 2 < bytes.length ? bytes[index + 2] : 0;
    output += BASE64_ALPHABET[byte0 >> 2];
    output += BASE64_ALPHABET[((byte0 & 0x03) << 4) | (byte1 >> 4)];
    output += index + 1 < bytes.length ? BASE64_ALPHABET[((byte1 & 0x0f) << 2) | (byte2 >> 6)] : '=';
    output += index + 2 < bytes.length ? BASE64_ALPHABET[byte2 & 0x3f] : '=';
  }
  return output;
}
