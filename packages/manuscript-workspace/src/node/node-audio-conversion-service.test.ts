import { spawnSync } from 'child_process';
import { promises as fs } from 'fs';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MediaPipelineJobState, MediaPipelineRequest, TranscriptionOptions } from '../common/audio-conversion-protocol';
import {
  CommandOutcome,
  CommandRunner,
  GroqKeyManager,
  GroqTransport,
  NodeAudioConversionService,
  RunCommandOptions,
  defaultCommandRunner,
  summarizeCommandOutput
} from './node-audio-conversion-service';

const TEST_ROOT = '/private/tmp/claude-501/-Users-vedmalex-work-ai-editor-3/8a15f000-cd38-4649-8fe4-b479e61f41c1/scratchpad/audio-conversion-test';

// Real-ffmpeg availability for the integration smoke (skips gracefully without it).
const FFMPEG_AVAILABLE = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

interface RecordedCall {
  command: string;
  args: string[];
}

type ScriptHandler = (
  command: string,
  args: string[],
  options: RunCommandOptions
) => CommandOutcome | Promise<CommandOutcome> | undefined;

/** Scripted CommandRunner: records every call, delegates to the handler. */
function scriptedRunner(handler: ScriptHandler): { runner: CommandRunner; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const runner: CommandRunner = async (command, args, options = {}) => {
    calls.push({ command, args: [...args] });
    const outcome = await handler(command, args, options);
    return outcome ?? { ok: true, code: 0, stdout: '', stderr: '' };
  };
  return { runner, calls };
}

/** Fast-retry service exposing the protected Groq backoff. */
class TestService extends NodeAudioConversionService {
  constructor(runner?: CommandRunner, transport?: GroqTransport) {
    super(runner ?? defaultCommandRunner, transport);
    this.groqRetryDelayMs = 1;
  }
}

async function waitForJob(service: NodeAudioConversionService, jobId: string): Promise<MediaPipelineJobState> {
  for (let i = 0; i < 400; i++) {
    const state = await service.pollJob(jobId);
    if (state.status !== 'running') {
      return state;
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 5));
  }
  throw new Error('job did not settle');
}

function ffprobeHandler(durationStdout: string, codecStdout: string): ScriptHandler {
  return (command, args) => {
    if (command === 'ffprobe' && args.includes('format=duration')) {
      return { ok: true, code: 0, stdout: durationStdout, stderr: '' };
    }
    if (command === 'ffprobe' && args.includes('stream=codec_type')) {
      return { ok: true, code: 0, stdout: codecStdout, stderr: '' };
    }
    return undefined;
  };
}

beforeAll(async () => {
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
  await fs.mkdir(TEST_ROOT, { recursive: true });
});

afterAll(async () => {
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

describe('GroqKeyManager', () => {
  test('flattens comma-separated entries and rotates through the whole ring', () => {
    const manager = new GroqKeyManager(['k1, k2', 'k3']);
    expect(manager.keyCount).toBe(3);
    const seen = new Set<string>([manager.getCurrentKey()]);
    seen.add(manager.rotateKey());
    seen.add(manager.rotateKey());
    expect(seen).toEqual(new Set(['k1', 'k2', 'k3']));
    // Full cycle returns to the starting key.
    const start = manager.getCurrentKey();
    manager.rotateKey();
    manager.rotateKey();
    expect(manager.rotateKey()).toBe(start);
  });

  test('throws on an empty/blank key list', () => {
    expect(() => new GroqKeyManager([])).toThrow();
    expect(() => new GroqKeyManager([' ', ','])).toThrow();
  });
});

describe('summarizeCommandOutput', () => {
  test('caps at 12 trimmed lines with a counter', () => {
    const output = Array.from({ length: 20 }, (_, i) => `  line ${i} `).join('\n');
    const summary = summarizeCommandOutput(output);
    expect(summary.split('\n')).toHaveLength(13);
    expect(summary).toContain('line 0');
    expect(summary).toContain('8 more lines');
    expect(summarizeCommandOutput('   \n \n')).toBe('');
  });
});

describe('doctor', () => {
  test('reports missing configured paths with advice', async () => {
    const { runner } = scriptedRunner(() => ({ ok: false, code: 1, stdout: '', stderr: '' }));
    const service = new TestService(runner);
    const report = await service.doctor({
      backend: 'local',
      ffmpegPath: join(TEST_ROOT, 'no-such-ffmpeg'),
      whisperCliPath: join(TEST_ROOT, 'no-such-whisper-cli'),
      modelPath: join(TEST_ROOT, 'no-such-model.bin')
    });
    expect(report.ok).toBe(false);
    const byId = new Map(report.checks.map(check => [check.id, check]));
    expect(byId.get('ffmpeg')?.ok).toBe(false);
    expect(byId.get('ffmpeg')?.advice).toContain('brew install ffmpeg');
    expect(byId.get('ffprobe')?.ok).toBe(false); // PATH probe scripted to fail
    expect(byId.get('whisper-cli')?.ok).toBe(false);
    expect(byId.get('whisper-cli')?.advice).toContain('cmake --build');
    expect(byId.get('model')?.ok).toBe(false);
    expect(byId.get('model')?.advice).toContain('download-ggml-model.sh');
    expect(byId.has('groq-api-key')).toBe(false);
  });

  test('local backend passes when binaries probe ok and files exist+executable', async () => {
    const whisperCli = join(TEST_ROOT, 'fake-whisper-cli');
    const model = join(TEST_ROOT, 'ggml-fake.bin');
    await fs.writeFile(whisperCli, '#!/bin/sh\n', { mode: 0o755 });
    await fs.writeFile(model, 'model');
    const { runner, calls } = scriptedRunner(() => ({ ok: true, code: 0, stdout: 'ffmpeg version 7', stderr: '' }));
    const service = new TestService(runner);
    const report = await service.doctor({ backend: 'local', whisperCliPath: whisperCli, modelPath: model });
    expect(report.ok).toBe(true);
    // PATH probes ran as `<binary> -version`
    expect(calls).toEqual([
      { command: 'ffmpeg', args: ['-version'] },
      { command: 'ffprobe', args: ['-version'] }
    ]);
  });

  test('groq backend checks the key list instead of whisper', async () => {
    const { runner } = scriptedRunner(() => ({ ok: true, code: 0, stdout: '', stderr: '' }));
    const service = new TestService(runner);
    const empty = await service.doctor({ backend: 'groq', groqApiKeys: ['  '] });
    const emptyCheck = empty.checks.find(check => check.id === 'groq-api-key');
    expect(emptyCheck?.ok).toBe(false);
    expect(emptyCheck?.advice).toContain('console.groq.com');
    expect(empty.checks.some(check => check.id === 'whisper-cli')).toBe(false);

    const withKeys = await service.doctor({ backend: 'groq', groqApiKeys: ['a,b'] });
    const keyCheck = withKeys.checks.find(check => check.id === 'groq-api-key');
    expect(keyCheck?.ok).toBe(true);
    expect(keyCheck?.detail).toBe('2 key(s) configured');
    // The detail never echoes the keys themselves.
    expect(JSON.stringify(withKeys)).not.toContain('a,b');
  });
});

describe('convert pipeline (scripted ffmpeg/ffprobe wiring)', () => {
  test('short AUDIO file: ffprobe probes, direct cut, mp3 encode — exact arg vectors', async () => {
    const inputFile = join(TEST_ROOT, 'короткая лекция time[test].mp3');
    await fs.writeFile(inputFile, 'fake-media');
    const outDir = join(TEST_ROOT, 'out-short');
    const { runner, calls } = scriptedRunner(ffprobeHandler('5.2\n', 'audio\n'));
    const service = new TestService(runner);

    const { jobId } = await service.startPipeline({
      inputFiles: [inputFile],
      conversion: { outputDirectory: outDir }
    });
    const state = await waitForJob(service, jobId);

    expect(state.status).toBe('completed');
    expect(state.results).toHaveLength(1);
    const result = state.results![0];
    expect(result.error).toBeUndefined();
    const segmentDir = join(outDir, 'короткая_лекция_time[test]');
    expect(result.outputDir).toBe(segmentDir);
    expect(result.segments).toEqual([
      { path: join(segmentDir, 'full.mp3'), baseName: 'full', startSec: 0, endSec: 6, wavFallback: false }
    ]);

    // Exact spawn arg vectors (ARG ARRAYS, never a shell string).
    expect(calls[0]).toEqual({
      command: 'ffprobe',
      args: ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', inputFile]
    });
    expect(calls[1]).toEqual({
      command: 'ffprobe',
      args: ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', inputFile]
    });
    const tempWav = join(segmentDir, 'full_temp.wav');
    expect(calls[2]).toEqual({
      command: 'ffmpeg',
      args: [
        '-hide_banner', '-nostdin', '-y', '-v', 'error', '-xerror',
        '-i', inputFile, '-ss', '0', '-to', '6',
        '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', tempWav
      ]
    });
    expect(calls[3]).toEqual({
      command: 'ffmpeg',
      args: [
        '-hide_banner', '-nostdin', '-y', '-v', 'error', '-xerror',
        '-i', tempWav, '-codec:a', 'libmp3lame', '-qscale:a', '2', join(segmentDir, 'full.mp3')
      ]
    });
    expect(calls).toHaveLength(4);

    // Progress events cover the stage + segment lifecycle.
    const kinds = state.events.map(event => event.kind);
    expect(kinds).toContain('file-start');
    expect(kinds).toContain('stage-start');
    expect(kinds).toContain('segment-start');
    expect(kinds).toContain('segment-end');
    expect(kinds).toContain('file-end');
  });

  test('long file: silencedetect drives silence-aligned segment names + cut args', async () => {
    const inputFile = join(TEST_ROOT, 'long lecture.mp3');
    await fs.writeFile(inputFile, 'fake-media');
    const outDir = join(TEST_ROOT, 'out-long');
    const probe = ffprobeHandler('1500.0\n', 'audio\n');
    const { runner, calls } = scriptedRunner((command, args, options) => {
      const probed = probe(command, args, options);
      if (probed) {
        return probed;
      }
      if (command === 'ffmpeg' && args.some(arg => arg.startsWith('silencedetect='))) {
        options.onStderrLine?.('[silencedetect @ 0x7f8] silence_start: 550.7');
        options.onStderrLine?.('[silencedetect @ 0x7f8] silence_end: 552.0 | silence_duration: 1.3');
        options.onStderrLine?.('[silencedetect @ 0x7f8] silence_start: 1100.9');
        options.onStderrLine?.('[silencedetect @ 0x7f8] silence_end: 1102.2 | silence_duration: 1.3');
        return { ok: true, code: 0, stdout: '', stderr: '' };
      }
      return undefined;
    });
    const service = new TestService(runner);

    const { jobId } = await service.startPipeline({
      inputFiles: [inputFile],
      conversion: { outputDirectory: outDir }
    });
    const state = await waitForJob(service, jobId);
    expect(state.status).toBe('completed');
    const result = state.results![0];
    expect(result.error).toBeUndefined();

    // Cut points 551 and 1101 + the appended duration 1500.
    expect(result.segments.map(segment => segment.baseName)).toEqual([
      'time[00:09:11][551]',
      'time[00:18:21][1101]',
      'time[00:25:00][1500]'
    ]);
    expect(result.segments.map(segment => [segment.startSec, segment.endSec])).toEqual([
      [0, 551], [551, 1101], [1101, 1500]
    ]);

    const silenceCall = calls.find(call => call.args.some(arg => arg.startsWith('silencedetect=')));
    expect(silenceCall).toEqual({
      command: 'ffmpeg',
      args: [
        '-hide_banner', '-nostdin', '-nostats', '-v', 'info',
        '-i', inputFile, '-af', 'silencedetect=noise=-30dB:d=1', '-f', 'null', '-'
      ]
    });
    const cutCalls = calls.filter(call => call.args.includes('-ss'));
    expect(cutCalls.map(call => [call.args[call.args.indexOf('-ss') + 1], call.args[call.args.indexOf('-to') + 1]])).toEqual([
      ['0', '551'], ['551', '1101'], ['1101', '1500']
    ]);
  });

  test('VIDEO input: one cached full-audio extraction, cuts read the cache', async () => {
    const inputFile = join(TEST_ROOT, 'talk.mp4');
    await fs.writeFile(inputFile, 'fake-video');
    const outDir = join(TEST_ROOT, 'out-video');
    const { runner, calls } = scriptedRunner(ffprobeHandler('120.0\n', 'video\naudio\n'));
    const service = new TestService(runner);

    const { jobId } = await service.startPipeline({
      inputFiles: [inputFile],
      conversion: { outputDirectory: outDir }
    });
    const state = await waitForJob(service, jobId);
    expect(state.status).toBe('completed');
    expect(state.results![0].error).toBeUndefined();

    const segmentDir = join(outDir, 'talk');
    const fullExtract = join(segmentDir, '__full_extract_temp.wav');
    const extractCalls = calls.filter(call => call.args.includes('-map'));
    expect(extractCalls).toHaveLength(1); // cached ONCE (the O(n) deviation)
    expect(extractCalls[0]).toEqual({
      command: 'ffmpeg',
      args: [
        '-hide_banner', '-nostdin', '-y', '-v', 'error', '-xerror',
        '-i', inputFile, '-map', '0:a:0', '-vn', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1', fullExtract
      ]
    });
    const cutCall = calls.find(call => call.args.includes('-ss'));
    expect(cutCall).toBeDefined();
    expect(cutCall!.args[cutCall!.args.indexOf('-i') + 1]).toBe(fullExtract);
  });

  test('input without an audio stream fails that file but completes the job', async () => {
    const inputFile = join(TEST_ROOT, 'mute.mp4');
    await fs.writeFile(inputFile, 'fake');
    const { runner } = scriptedRunner(ffprobeHandler('100.0\n', 'video\n'));
    const service = new TestService(runner);
    const { jobId } = await service.startPipeline({
      inputFiles: [inputFile],
      conversion: { outputDirectory: join(TEST_ROOT, 'out-mute') }
    });
    const state = await waitForJob(service, jobId);
    expect(state.status).toBe('completed');
    expect(state.results![0].error).toContain('does not contain an audio stream');
    expect(state.events.some(event => event.kind === 'error')).toBe(true);
  });

  test('cancelJob flips the job to cancelled', async () => {
    const inputFile = join(TEST_ROOT, 'to-cancel.mp3');
    await fs.writeFile(inputFile, 'fake');
    const { runner } = scriptedRunner(async () => {
      await new Promise(resolvePromise => setTimeout(resolvePromise, 40));
      return { ok: true, code: 0, stdout: '999.0\n', stderr: '' };
    });
    const service = new TestService(runner);
    const { jobId } = await service.startPipeline({
      inputFiles: [inputFile],
      conversion: { outputDirectory: join(TEST_ROOT, 'out-cancel') }
    });
    expect(await service.cancelJob(jobId)).toBe(true);
    const state = await waitForJob(service, jobId);
    expect(state.status).toBe('cancelled');
    expect(await service.cancelJob(jobId)).toBe(false); // already settled
  });

  test('pollJob sinceSeq returns only newer events', async () => {
    const inputFile = join(TEST_ROOT, 'poll.mp3');
    await fs.writeFile(inputFile, 'fake');
    const { runner } = scriptedRunner(ffprobeHandler('5.0\n', 'audio\n'));
    const service = new TestService(runner);
    const { jobId } = await service.startPipeline({
      inputFiles: [inputFile],
      conversion: { outputDirectory: join(TEST_ROOT, 'out-poll') }
    });
    const finished = await waitForJob(service, jobId);
    expect(finished.events.length).toBeGreaterThan(0);
    const again = await service.pollJob(jobId, finished.nextSeq);
    expect(again.events).toEqual([]);
    expect(again.nextSeq).toBe(finished.nextSeq);
  });
});

describe('transcription + normalize + raw.md (skip-existing conversion)', () => {
  const whisperShapedJson = {
    params: { language: 'auto' },
    result: { language: 'ru' },
    transcription: [
      { offsets: { from: 0, to: 2500 }, text: ' привет' },
      { offsets: { from: 2500, to: 5000 }, text: ' мир' }
    ]
  };

  async function runSkipExistingPipeline(name: string, transcription: TranscriptionOptions, jsonBody: unknown) {
    const inputFile = join(TEST_ROOT, `${name}.mp3`);
    await fs.writeFile(inputFile, 'fake');
    const outDir = join(TEST_ROOT, `out-${name}`);
    const segmentDir = join(outDir, name);
    await fs.mkdir(segmentDir, { recursive: true });
    await fs.writeFile(join(segmentDir, 'full.mp3'), 'fake-mp3');
    await fs.writeFile(join(segmentDir, 'full.json'), JSON.stringify(jsonBody), 'utf8');

    const { runner } = scriptedRunner(ffprobeHandler('400.0\n', 'audio\n'));
    const service = new TestService(runner);
    const request: MediaPipelineRequest = {
      inputFiles: [inputFile],
      conversion: { outputDirectory: outDir },
      transcription
    };
    const { jobId } = await service.startPipeline(request);
    const state = await waitForJob(service, jobId);
    return { state, segmentDir };
  }

  test('normalizes existing whisper-shaped json and writes the merged raw.md', async () => {
    const { state, segmentDir } = await runSkipExistingPipeline(
      'skipmerge',
      { backend: 'local', whisperCliPath: '/dev/null', modelPath: '/dev/null' },
      whisperShapedJson
    );
    expect(state.status).toBe('completed');
    const result = state.results![0];
    expect(result.skippedExisting).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.transcripts).toEqual([join(segmentDir, 'full.json')]);

    // STAGE 2b rewrote the file into the normalized {text, language, segments} shape.
    const normalized = JSON.parse(await fs.readFile(join(segmentDir, 'full.json'), 'utf8'));
    expect(normalized.language).toBe('ru');
    expect(normalized.segments).toHaveLength(2);
    expect(normalized.segments[0]).toMatchObject({ id: 0, seek: 0, start: 0, end: 2.5, text: ' привет' });
    expect(normalized.segments[1]).toMatchObject({ seek: 2500, start: 2.5, end: 5 });

    // STAGE 3 merged the toolchain-format raw.md (start-stamped lines + end line).
    expect(result.rawMdPath).toBe(join(segmentDir, 'raw.md'));
    const rawMd = await fs.readFile(result.rawMdPath!, 'utf8');
    expect(rawMd).toBe('00:00:00.000: привет\n00:00:02.500: мир\n00:00:05.000');
  });

  test('a transcript carrying editor _transcriber metadata is left untouched', async () => {
    const editorJson = {
      text: 'привет мир',
      language: 'ru',
      segments: [{ id: 0, seek: 0, start: 0, end: 5, text: 'привет мир', tokens: [], temperature: 0, avg_logprob: 0, compression_ratio: 0, no_speech_prob: 0, _id: 'seg-1' }],
      _transcriber: { version: 2, segmentHistory: {} }
    };
    const { state, segmentDir } = await runSkipExistingPipeline(
      'skipeditor',
      { backend: 'local', whisperCliPath: '/dev/null', modelPath: '/dev/null' },
      editorJson
    );
    expect(state.status).toBe('completed');
    const onDisk = JSON.parse(await fs.readFile(join(segmentDir, 'full.json'), 'utf8'));
    expect(onDisk).toEqual(editorJson); // _transcriber + _id preserved
  });
});

describe('whisper-cli wiring (transcribeSegmentFile, local backend)', () => {
  test('spawns the exact whisper arg vector and returns the normalized text', async () => {
    const segmentPath = join(TEST_ROOT, 'segment time[00:10:00][600].mp3');
    await fs.writeFile(segmentPath, 'fake-audio');
    let whisperCall: RecordedCall | undefined;
    const { runner } = scriptedRunner(async (command, args) => {
      if (command === '/fake/whisper-cli') {
        whisperCall = { command, args: [...args] };
        const ofIndex = args.indexOf('-of');
        await fs.writeFile(`${args[ofIndex + 1]}.json`, JSON.stringify({
          result: { language: 'ru' },
          transcription: [{ offsets: { from: 0, to: 1500 }, text: ' проверка' }]
        }), 'utf8');
        return { ok: true, code: 0, stdout: '', stderr: '' };
      }
      return undefined;
    });
    const service = new TestService(runner);
    const result = await service.transcribeSegmentFile({
      segmentPath,
      transcription: {
        backend: 'local',
        whisperCliPath: '/fake/whisper-cli',
        modelPath: '/fake/models/ggml-large-v3-turbo.bin',
        language: 'ru',
        threads: 4
      }
    });
    expect(result.ok).toBe(true);
    expect(result.text).toBe('проверка');
    expect(result.transcription?.segments[0]).toMatchObject({ start: 0, end: 1.5, seek: 0 });

    expect(whisperCall).toBeDefined();
    const args = whisperCall!.args;
    expect(args[0]).toBe('-m');
    expect(args[1]).toBe('/fake/models/ggml-large-v3-turbo.bin');
    expect(args[2]).toBe('-f');
    expect(args[3]).toBe(segmentPath);
    expect(args[4]).toBe('-l');
    expect(args[5]).toBe('ru');
    expect(args[6]).toBe('-t');
    expect(args[7]).toBe('4');
    expect(args[8]).toBe('-oj');
    expect(args[9]).toBe('-of');
    expect(args[10]).toMatch(/\.whisper_tmp$/);
    expect(args[11]).toBe('-np');
    // The whisper tmp sidecar was cleaned up.
    expect(await fs.readdir(TEST_ROOT).then(entries => entries.filter(entry => entry.includes('whisper_tmp')))).toEqual([]);
  });

  test('defaults language=auto and threads=8; empty whisper output → ok:false', async () => {
    const segmentPath = join(TEST_ROOT, 'empty-out.mp3');
    await fs.writeFile(segmentPath, 'fake');
    let seenArgs: string[] = [];
    const { runner } = scriptedRunner((command, args) => {
      if (command === '/fake/whisper-cli') {
        seenArgs = [...args];
        return { ok: true, code: 0, stdout: '', stderr: '' }; // writes NO json
      }
      return undefined;
    });
    const service = new TestService(runner);
    const result = await service.transcribeSegmentFile({
      segmentPath,
      transcription: { backend: 'local', whisperCliPath: '/fake/whisper-cli', modelPath: '/fake/model.bin' }
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('no output');
    expect(seenArgs[seenArgs.indexOf('-l') + 1]).toBe('auto');
    expect(seenArgs[seenArgs.indexOf('-t') + 1]).toBe('8');
  });

  test('audioBase64: materializes a temp WAV, transcribes it, and cleans it up', async () => {
    const wavBytes = Buffer.from('RIFFfake-wav-payload');
    let fileArg: string | undefined;
    let bytesAtCallTime: Buffer | undefined;
    const { runner } = scriptedRunner(async (command, args) => {
      if (command === '/fake/whisper-cli') {
        fileArg = args[args.indexOf('-f') + 1];
        bytesAtCallTime = await fs.readFile(fileArg);
        const ofIndex = args.indexOf('-of');
        await fs.writeFile(`${args[ofIndex + 1]}.json`, JSON.stringify({
          result: { language: 'ru' },
          transcription: [{ offsets: { from: 0, to: 900 }, text: ' повторное распознавание' }]
        }), 'utf8');
        return { ok: true, code: 0, stdout: '', stderr: '' };
      }
      return undefined;
    });
    const service = new TestService(runner);
    const result = await service.transcribeSegmentFile({
      audioBase64: wavBytes.toString('base64'),
      audioFileName: 'segment.wav',
      transcription: { backend: 'local', whisperCliPath: '/fake/whisper-cli', modelPath: '/fake/model.bin', language: 'ru' }
    });
    expect(result.ok).toBe(true);
    expect(result.text).toBe('повторное распознавание');
    // The temp file carried the decoded bytes and lived in the OS temp dir...
    expect(fileArg).toMatch(/ai-editor-segment-.*\.wav$/);
    expect(bytesAtCallTime!.equals(wavBytes)).toBe(true);
    // ...and was deleted after the call.
    expect(await fs.access(fileArg!).then(() => true, () => false)).toBe(false);
  });

  test('audioBase64: zero-byte decode and missing-both-sources fail cleanly', async () => {
    const service = new TestService(scriptedRunner(() => undefined).runner);
    const empty = await service.transcribeSegmentFile({
      audioBase64: '!!!',
      transcription: { backend: 'local', whisperCliPath: '/x', modelPath: '/y' }
    });
    expect(empty.ok).toBe(false);
    expect(empty.error).toContain('zero bytes');
    const neither = await service.transcribeSegmentFile({
      transcription: { backend: 'local', whisperCliPath: '/x', modelPath: '/y' }
    });
    expect(neither.ok).toBe(false);
    expect(neither.error).toContain('segmentPath or audioBase64');
  });

  test('missing whisperCliPath/modelPath fail with actionable errors', async () => {
    const segmentPath = join(TEST_ROOT, 'noconf.mp3');
    await fs.writeFile(segmentPath, 'fake');
    const service = new TestService(scriptedRunner(() => undefined).runner);
    const noCli = await service.transcribeSegmentFile({ segmentPath, transcription: { backend: 'local' } });
    expect(noCli.ok).toBe(false);
    expect(noCli.error).toContain('whisperCliPath');
    const noModel = await service.transcribeSegmentFile({
      segmentPath,
      transcription: { backend: 'local', whisperCliPath: '/fake/cli' }
    });
    expect(noModel.ok).toBe(false);
    expect(noModel.error).toContain('modelPath');
  });
});

describe('Groq backend (fake transport, keys never logged)', () => {
  test('rotates to the next key on a quota error and succeeds', async () => {
    const segmentPath = join(TEST_ROOT, 'groq-seg.mp3');
    await fs.writeFile(segmentPath, 'fake');
    const usedKeys: string[] = [];
    const failedKeys = new Set<string>();
    const transport: GroqTransport = async (_file, apiKey, model) => {
      usedKeys.push(apiKey);
      expect(model).toBe('whisper-large-v3-turbo');
      if (failedKeys.size === 0) {
        failedKeys.add(apiKey);
        throw new Error('429 rate limit reached for this key');
      }
      return { language: 'ru', text: 'из groq', segments: [{ id: 0, start: 0, end: 2, text: 'из groq' }] };
    };
    const service = new TestService(undefined, transport);
    const result = await service.transcribeSegmentFile({
      segmentPath,
      transcription: { backend: 'groq', groqApiKeys: ['key-one,key-two'] }
    });
    expect(result.ok).toBe(true);
    expect(result.text).toBe('из groq');
    expect(result.transcription?.segments[0]).toMatchObject({ id: 0, start: 0, end: 2, seek: 0 });
    // One failed attempt + one successful attempt after key rotation. (The
    // source semantics pick a RANDOM key on each fresh attempt, so the retry
    // key is not guaranteed distinct — only the retry itself is.)
    expect(usedKeys.length).toBe(2);
    // Never leaked into the result surface.
    expect(JSON.stringify(result)).not.toContain('key-one');
    expect(JSON.stringify(result)).not.toContain('key-two');
  });

  test('retries connection errors on the SAME key before giving up', async () => {
    const segmentPath = join(TEST_ROOT, 'groq-conn.mp3');
    await fs.writeFile(segmentPath, 'fake');
    const usedKeys: string[] = [];
    let failures = 0;
    const transport: GroqTransport = async (_file, apiKey) => {
      usedKeys.push(apiKey);
      if (failures < 2) {
        failures++;
        throw new Error('fetch failed');
      }
      return { text: 'ок', language: 'ru', segments: [] };
    };
    const service = new TestService(undefined, transport);
    const result = await service.transcribeSegmentFile({
      segmentPath,
      transcription: { backend: 'groq', groqApiKeys: ['solo-key'] }
    });
    expect(result.ok).toBe(true);
    expect(usedKeys).toEqual(['solo-key', 'solo-key', 'solo-key']);
  });

  test('exhausted keys surface the last error without the key material', async () => {
    const segmentPath = join(TEST_ROOT, 'groq-fail.mp3');
    await fs.writeFile(segmentPath, 'fake');
    const transport: GroqTransport = async () => {
      throw new Error('Groq transcription failed: 401 Unauthorized');
    };
    const service = new TestService(undefined, transport);
    const result = await service.transcribeSegmentFile({
      segmentPath,
      transcription: { backend: 'groq', groqApiKeys: ['secret-a', 'secret-b'] }
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('401');
    expect(result.error).not.toContain('secret-a');
    expect(result.error).not.toContain('secret-b');
  });
});

describe('integration smoke (real ffmpeg)', () => {
  test.skipIf(!FFMPEG_AVAILABLE)('converts a synthesized 1s wav into full.mp3', async () => {
    const inputFile = join(TEST_ROOT, 'sine tone.wav');
    const synth = spawnSync('ffmpeg', [
      '-hide_banner', '-nostdin', '-y', '-v', 'error',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', inputFile
    ], { stdio: 'ignore' });
    expect(synth.status).toBe(0);

    const outDir = join(TEST_ROOT, 'out-smoke');
    const service = new NodeAudioConversionService(); // REAL runner
    const { jobId } = await service.startPipeline({
      inputFiles: [inputFile],
      conversion: { outputDirectory: outDir }
    });
    const state = await waitForJob(service, jobId);
    expect(state.status).toBe('completed');
    const result = state.results![0];
    expect(result.error).toBeUndefined();
    const produced = result.segments[0]?.path;
    expect(produced).toBe(join(outDir, 'sine_tone', 'full.mp3'));
    const stat = await fs.stat(produced!);
    expect(stat.size).toBeGreaterThan(0);
    // No temp wavs left behind.
    const leftovers = (await fs.readdir(join(outDir, 'sine_tone'))).filter(name => name.endsWith('.wav'));
    expect(leftovers).toEqual([]);
  }, 30_000);
});
