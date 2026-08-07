import { tmpdir } from 'os';
/**
 * SPLIT OUT OF `node-domain-knowledge-service.test.ts` (TASK-022 WP-7).
 *
 * The original file held FOUR unrelated `describe` blocks over three unrelated
 * services, and WP-7 touches exactly one of them. The plan's rule is that the
 * unit of decision is the `describe` BLOCK and not the FILE, so the file is
 * SPLIT FIRST and the fate of each block is decided afterwards, one at a time.
 * Nothing below is rewritten by the split: the assertions, the fixtures and
 * their order are byte-identical to the block this file was carved from.
 *
 * `makeRoot`/`SCRATCH_BASE` are REPEATED in each of the four files rather than
 * lifted into a shared module. `tsconfig.json` excludes test files and NOTHING
 * else, so a shared helper under `src/` would compile into `lib/` and ship as
 * production surface — for eight lines of `mkdtemp`. Repetition is the smaller
 * cost, and it keeps each file runnable on its own.
 */

import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { promises as fs } from 'fs';
import { join } from 'path';
import { NodeSourceLibraryService } from './node-domain-knowledge-service';

const SCRATCH_BASE = process.env.CLAUDE_SCRATCHPAD_DIR
  || tmpdir();

async function makeRoot(): Promise<string> {
  await fs.mkdir(SCRATCH_BASE.startsWith('/') ? SCRATCH_BASE : tmpdir(), { recursive: true });
  return fs.mkdtemp(join(SCRATCH_BASE.startsWith('/') ? SCRATCH_BASE : tmpdir(), 'afe-domain-'));
}

describe('NodeSourceLibraryService', () => {
  let root: string;
  let service: NodeSourceLibraryService;

  beforeEach(async () => {
    root = await makeRoot();
    service = new NodeSourceLibraryService();
    await fs.mkdir(join(root, 'sources'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  test('returns an info diagnostic when no workspace is open', async () => {
    const snapshot = await service.getSnapshot(undefined);
    expect(snapshot.items).toEqual([]);
    expect(snapshot.citations).toEqual([]);
    expect(snapshot.excerpts).toEqual([]);
    expect(snapshot.diagnostics[0].message).toBe('Open a manuscript workspace to view sources.');
  });

  test('lists source items excluding citations.yaml and parses citations', async () => {
    await fs.mkdir(join(root, 'sources/pdfs'), { recursive: true });
    await fs.mkdir(join(root, 'sources/empty'), { recursive: true });
    await fs.writeFile(join(root, 'sources/notes.md'), 'notes');
    await fs.writeFile(join(root, 'sources/pdfs/study.pdf'), 'pdf');
    await fs.writeFile(join(root, 'sources/.gitignore'), 'build');
    await fs.writeFile(join(root, 'sources/citations.yaml'), [
      'citations:',
      '  - id: smith2020',
      '    title: A Study',
      '    source: Journal',
      '    note: page 5',
      '  - id: missing-title',
      '  - not-an-object',
      ''
    ].join('\n'));

    const snapshot = await service.getSnapshot(root);
    // Recursive listing: allowed files survive (nested included), dotfiles and
    // empty directories are dropped, index files are managed separately.
    expect(snapshot.items.map(item => item.name)).toEqual(['notes.md', 'pdfs', 'study.pdf']);
    const dir = snapshot.items.find(item => item.name === 'pdfs');
    expect(dir!.type).toBe('directory');
    expect(dir!.path).toBe('sources/pdfs');
    const nested = snapshot.items.find(item => item.name === 'study.pdf');
    expect(nested!.path).toBe('sources/pdfs/study.pdf');

    expect(snapshot.citations).toEqual([{
      id: 'smith2020',
      title: 'A Study',
      source: 'Journal',
      note: 'page 5'
    }]);
    const warnings = snapshot.diagnostics.filter(diagnostic => diagnostic.severity === 'warning');
    expect(warnings.some(diagnostic => diagnostic.message.includes('id and title are required'))).toBe(true);
    expect(warnings.some(diagnostic => diagnostic.message.includes('expected object'))).toBe(true);
  });

  test('accepts a top-level citations array', async () => {
    await fs.writeFile(join(root, 'sources/citations.yaml'), [
      '- id: one',
      '  title: First',
      ''
    ].join('\n'));
    const snapshot = await service.getSnapshot(root);
    expect(snapshot.citations).toEqual([{ id: 'one', title: 'First', source: undefined, note: undefined }]);
  });

  test('warns on invalid citations YAML shape', async () => {
    await fs.writeFile(join(root, 'sources/citations.yaml'), 'citations: 42\n');
    const snapshot = await service.getSnapshot(root);
    const warning = snapshot.diagnostics.find(diagnostic => diagnostic.message.includes('should contain a citations list'));
    expect(warning?.severity).toBe('warning');
  });

  test('errors on malformed citations YAML', async () => {
    await fs.writeFile(join(root, 'sources/citations.yaml'), 'citations:\n  - id: a\n : : :\n');
    const snapshot = await service.getSnapshot(root);
    const error = snapshot.diagnostics.find(diagnostic => diagnostic.message.includes('Invalid citations.yaml'));
    expect(error?.severity).toBe('error');
  });

  test('emits an info diagnostic when sources/ is missing', async () => {
    await fs.rm(join(root, 'sources'), { recursive: true, force: true });
    const snapshot = await service.getSnapshot(root);
    expect(snapshot.diagnostics.some(diagnostic => diagnostic.message.includes('sources/ directory is not present yet'))).toBe(true);
    expect(snapshot.diagnostics.some(diagnostic => diagnostic.message.includes('No sources/citations.yaml file found'))).toBe(true);
  });

  test('derives a workspace-relative path for citations whose source is a file', async () => {
    await fs.writeFile(join(root, 'sources/citations.yaml'), [
      'citations:',
      '  - id: doc-cite',
      '    title: Cited document',
      '    source: documents/gita-notes.md',
      '  - id: label-cite',
      '    title: Plain label',
      '    source: Journal of Notes',
      ''
    ].join('\n'));

    const snapshot = await service.getSnapshot(root);
    const docCite = snapshot.citations.find(citation => citation.id === 'doc-cite');
    expect(docCite!.path).toBe('sources/documents/gita-notes.md');
    const labelCite = snapshot.citations.find(citation => citation.id === 'label-cite');
    expect(labelCite!.path).toBeUndefined();
  });

  test('parses valid excerpts including a manuscript target link', async () => {
    await fs.writeFile(join(root, 'sources/excerpts.jsonl'), [
      JSON.stringify({
        id: 'dharma-context',
        text: 'Dharma shifts with speaker and scene.',
        source: 'glossary-dharma',
        sourcePath: 'sources/documents/gita-notes.md',
        note: 'context note',
        targetPath: 'content/chapter-01.md',
        targetAnchor: 'the-field-of-decision',
        targetLine: 9
      }),
      JSON.stringify({ text: 'Bare excerpt with no id and no target.' }),
      ''
    ].join('\n'));

    const snapshot = await service.getSnapshot(root);
    expect(snapshot.excerpts).toHaveLength(2);

    const linked = snapshot.excerpts.find(excerpt => excerpt.id === 'dharma-context');
    expect(linked).toEqual({
      id: 'dharma-context',
      sourceId: 'glossary-dharma',
      sourcePath: 'sources/documents/gita-notes.md',
      text: 'Dharma shifts with speaker and scene.',
      note: 'context note',
      targetPath: 'content/chapter-01.md',
      targetAnchor: 'the-field-of-decision',
      targetLine: 9
    });

    const bare = snapshot.excerpts.find(excerpt => excerpt.text.startsWith('Bare'));
    expect(bare!.id).toBe('excerpt-2');
    expect(bare!.targetPath).toBeUndefined();
    expect(bare!.sourceId).toBeUndefined();
  });

  test('skips malformed excerpt lines with a warning diagnostic', async () => {
    await fs.writeFile(join(root, 'sources/excerpts.jsonl'), [
      JSON.stringify({ id: 'ok', text: 'A valid excerpt.' }),
      '{ this is not json ',
      JSON.stringify(['not', 'an', 'object']),
      JSON.stringify({ id: 'no-text', note: 'missing text' }),
      ''
    ].join('\n'));

    const snapshot = await service.getSnapshot(root);
    expect(snapshot.excerpts.map(excerpt => excerpt.id)).toEqual(['ok']);

    const warnings = snapshot.diagnostics.filter(diagnostic => diagnostic.severity === 'warning');
    expect(warnings.some(diagnostic => diagnostic.message.includes('line 2: invalid JSON'))).toBe(true);
    expect(warnings.some(diagnostic => diagnostic.message.includes('line 3: expected a JSON object'))).toBe(true);
    expect(warnings.some(diagnostic => diagnostic.message.includes('line 4: text is required'))).toBe(true);
  });

  test('treats an empty excerpts file as no excerpts without diagnostics', async () => {
    await fs.writeFile(join(root, 'sources/excerpts.jsonl'), '\n  \n');
    const snapshot = await service.getSnapshot(root);
    expect(snapshot.excerpts).toEqual([]);
    expect(snapshot.diagnostics.some(diagnostic =>
      diagnostic.message.includes('excerpt') && diagnostic.severity !== 'info')).toBe(false);
  });

  test('emits an info diagnostic when excerpts.jsonl is missing', async () => {
    const snapshot = await service.getSnapshot(root);
    const info = snapshot.diagnostics.find(diagnostic => diagnostic.message.includes('No sources/excerpts.jsonl file found'));
    expect(info?.severity).toBe('info');
    expect(snapshot.excerpts).toEqual([]);
  });
});
