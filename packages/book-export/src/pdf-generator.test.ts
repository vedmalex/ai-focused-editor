import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CHROME_NOT_FOUND_MESSAGE,
  findChromePath,
  renderHtmlToPdf
} from './index';

const SCRATCH =
  '/private/tmp/claude-501/-Users-vedmalex-work-ai-editor-3/8a15f000-cd38-4649-8fe4-b479e61f41c1/scratchpad/pdf-test';

// Resolve a real browser once so the integration test can skip gracefully on
// machines without Chrome/Chromium (test.skipIf), and actually render when present.
const CHROME = findChromePath();

beforeAll(async () => {
  await rm(SCRATCH, { recursive: true, force: true });
  await mkdir(SCRATCH, { recursive: true });
});

afterAll(async () => {
  await rm(SCRATCH, { recursive: true, force: true });
});

describe('findChromePath', () => {
  test('CHROME_PATH env override wins when it points to an existing file', async () => {
    const fakeChrome = join(SCRATCH, 'fake-chrome');
    await writeFile(fakeChrome, '#!/bin/sh\n');
    // Empty candidate list proves the override, not a probed path, was returned.
    expect(findChromePath({ CHROME_PATH: fakeChrome }, [])).toBe(fakeChrome);
  });

  test('a bogus CHROME_PATH does not fabricate a result', () => {
    expect(findChromePath({ CHROME_PATH: join(SCRATCH, 'does-not-exist') }, [])).toBeUndefined();
  });

  test('returns undefined when nothing is found (no env, no existing path)', () => {
    expect(findChromePath({}, ['/nonexistent/google-chrome', '/nope/chromium'])).toBeUndefined();
  });

  test('probes the standard candidate paths when no override is set', async () => {
    const fakeChrome = join(SCRATCH, 'probed-chrome');
    await writeFile(fakeChrome, '#!/bin/sh\n');
    expect(findChromePath({}, ['/nonexistent/one', fakeChrome])).toBe(fakeChrome);
  });
});

describe('renderHtmlToPdf chrome guard', () => {
  test('rejects with the single clear diagnostic when no browser can be located', async () => {
    expect(CHROME_NOT_FOUND_MESSAGE).toBe(
      'PDF export requires a Chrome/Chromium installation (set CHROME_PATH to your browser binary).'
    );
    await expect(
      renderHtmlToPdf('<!doctype html><html><body><p>x</p></body></html>', {
        outputPath: join(SCRATCH, 'never-written.pdf'),
        env: {},
        candidatePaths: []
      })
    ).rejects.toThrow(CHROME_NOT_FOUND_MESSAGE);
  });
});

const SAMPLE_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>PDF Sample</title>
<style>body{font-family:serif;}main{max-width:820px;margin:0 auto;}</style></head>
<body><main>
<h1>PDF Sample</h1>
<nav><h2>Table of Contents</h2><ul><li><a href="#chapter-one">Chapter One</a></li></ul></nav>
<section id="chapter-one"><h2>Chapter One</h2><p>${'Body text. '.repeat(80)}</p></section>
</main></body></html>`;

describe('renderHtmlToPdf integration', () => {
  test.skipIf(!CHROME)('renders HTML to a valid, non-trivial PDF file', async () => {
    const outputPath = join(SCRATCH, 'sample.pdf');
    await renderHtmlToPdf(SAMPLE_HTML, { outputPath, format: 'a4' });

    const bytes = await readFile(outputPath);
    // A PDF always begins with the "%PDF-" magic header.
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    // Non-trivial: a real one-page rendering is comfortably over 1 KiB.
    expect((await stat(outputPath)).size).toBeGreaterThan(1024);
  }, 60000);
});
