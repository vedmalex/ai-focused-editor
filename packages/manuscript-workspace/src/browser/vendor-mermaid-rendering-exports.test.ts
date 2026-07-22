import { promises as fs } from 'fs';
import { join } from 'path';
import { describe, expect, test } from 'bun:test';

/**
 * Insurance against `@theia/ai-chat-ui`'s mermaid renderer moving or being
 * renamed upstream (research §"Итоговая рекомендация": this task deep-imports
 * an UNDOCUMENTED module — `@theia/ai-chat-ui/lib/browser/chat-response-renderer/
 * mermaid-rendering` — that both the chapter preview and, indirectly (via
 * `sanitizeDiagram`), the welcome guide depend on). If a future `@theia/ai-chat-ui`
 * upgrade relocates or renames any of these six exports, THIS is the test that
 * should turn red before either surface's own tests do.
 *
 * WHY A FILE-CONTENT CHECK, NOT A REAL IMPORT. Actually `import()`-ing this
 * module pulls in `@theia/monaco`'s `MonacoEditorProvider`, which at module
 * load reaches into `monaco-editor-core`'s GPU decoration/DOM-measurement
 * code — real browser APIs (`Element.append`, computed layout) this
 * repository's test environment does not, and by design will not, provide (no
 * jsdom/happy-dom — the same limit `welcome-docs-renderer.test.ts` documents).
 * A static check over the SHIPPED FILES (the exact bytes the app bundles)
 * still catches the risk this test exists for — an export renamed, removed, or
 * moved to a different file — without needing a browser to prove it.
 *
 * Resolved via a path relative to `import.meta.dir`, the same convention
 * `docs-style.test.ts` uses for `docs.css`: this package's own
 * `node_modules/@theia/ai-chat-ui` symlink (added in this task's `package.json`),
 * not a hunt up the workspace tree.
 */

const PACKAGE_ROOT = join(import.meta.dir, '../..');
const MODULE_DIR = join(PACKAGE_ROOT, 'node_modules/@theia/ai-chat-ui/lib/browser/chat-response-renderer');

const EXPECTED_EXPORTS = [
  'sanitizeDiagram',
  'MermaidDiagram',
  'useThemeMode',
  'splitMermaidSegments',
  'MermaidViewer',
  'MarkdownWithMermaid'
] as const;

describe('the @theia/ai-chat-ui mermaid-rendering deep import this task relies on', () => {
  test('the module resolves inside this package\'s own node_modules', async () => {
    // `fs.access` REJECTS (ENOENT) rather than resolving to a falsy value, so
    // an un-awaited call here would fail loudly on its own if the file were
    // missing; awaiting just makes that failure surface as THIS test's own.
    await fs.access(join(MODULE_DIR, 'mermaid-rendering.d.ts'));
    await fs.access(join(MODULE_DIR, 'mermaid-rendering.js'));
  });

  test('every export this task deep-imports is still DECLARED in the .d.ts', async () => {
    const dts = await fs.readFile(join(MODULE_DIR, 'mermaid-rendering.d.ts'), 'utf8');
    for (const name of EXPECTED_EXPORTS) {
      expect(dts).toMatch(new RegExp(`export declare (?:const|function) ${name}\\b`));
    }
  });

  test('every export this task deep-imports is still ASSIGNED in the compiled .js (what actually ships)', async () => {
    const js = await fs.readFile(join(MODULE_DIR, 'mermaid-rendering.js'), 'utf8');
    for (const name of EXPECTED_EXPORTS) {
      expect(js).toMatch(new RegExp(`exports\\.${name}\\s*=`));
    }
  });

  test('splitMermaidSegments\' declared signature still takes one string and returns segments', async () => {
    // Loose on purpose (a full type-checker is out of scope for a text scan):
    // enough to catch a signature shape change (e.g. an added required
    // argument) that would break this task's call sites at compile time.
    const dts = await fs.readFile(join(MODULE_DIR, 'mermaid-rendering.d.ts'), 'utf8');
    expect(dts).toMatch(/splitMermaidSegments: \(text: string\) => MarkdownMermaidSegment\[\]/);
  });
});
