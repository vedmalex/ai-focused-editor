import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parse } from 'yaml';
import { YamlSchemaValidator } from '../common/yaml-schema-validator';
import { NodeManuscriptWorkspaceService } from './node-manuscript-workspace-service';

const SCRATCH_BASE = process.env.CLAUDE_SCRATCHPAD_DIR
  || '/private/tmp/claude-501/-Users-vedmalex-work-ai-editor-3/8a15f000-cd38-4649-8fe4-b479e61f41c1/scratchpad';

function createService(): NodeManuscriptWorkspaceService {
  const service = new NodeManuscriptWorkspaceService();
  (service as unknown as { yamlSchemaValidator: YamlSchemaValidator }).yamlSchemaValidator = new YamlSchemaValidator();
  return service;
}

describe('NodeManuscriptWorkspaceService manifest mutations', () => {
  let root: string;
  let service: NodeManuscriptWorkspaceService;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(SCRATCH_BASE.startsWith('/') ? SCRATCH_BASE : tmpdir(), 'afe-ws-'));
    service = createService();

    await fs.mkdir(join(root, 'content/part-01'), { recursive: true });
    await fs.writeFile(join(root, 'metadata.yaml'), 'title: Test Book\nlanguage: ru\n');
    await fs.writeFile(join(root, 'content/chapter-01.md'), '# Глава 1\n');
    await fs.writeFile(join(root, 'content/chapter-02.md'), '# Глава 2\n');
    await fs.writeFile(join(root, 'content/part-01/chapter-03.md'), '# Глава 3\n');
    await fs.writeFile(join(root, 'manifest.yaml'), [
      'version: 1',
      'content:',
      '  # keep chapter one first',
      '  - path: content/chapter-01.md',
      '    title: Глава 1',
      '  - path: content/chapter-02.md',
      '    title: Глава 2',
      '  - path: content/part-01',
      '    title: Часть 1',
      '    children:',
      '      - path: content/part-01/chapter-03.md',
      '        title: Глава 3',
      ''
    ].join('\n'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function manifest(): Promise<Record<string, any>> {
    return parse(await fs.readFile(join(root, 'manifest.yaml'), 'utf8'));
  }

  test('reorders entries within the root list', async () => {
    const result = await service.moveManuscriptEntry(root, 'content/chapter-02.md', { index: 0 });
    expect(result.ok).toBe(true);
    const doc = await manifest();
    expect(doc.content.map((entry: any) => entry.path)).toEqual([
      'content/chapter-02.md',
      'content/chapter-01.md',
      'content/part-01'
    ]);
    expect(result.snapshot.content[0].path).toBe('content/chapter-02.md');
  });

  test('keeps YAML comments when rewriting the manifest', async () => {
    await service.moveManuscriptEntry(root, 'content/chapter-02.md', { index: 0 });
    const text = await fs.readFile(join(root, 'manifest.yaml'), 'utf8');
    expect(text).toContain('# keep chapter one first');
  });

  test('moves a chapter into a folder entry and relocates the file', async () => {
    const result = await service.moveManuscriptEntry(root, 'content/chapter-02.md', {
      parentPath: 'content/part-01',
      index: 0
    });
    expect(result.ok).toBe(true);
    const doc = await manifest();
    const part = doc.content.find((entry: any) => entry.path === 'content/part-01');
    expect(part.children.map((entry: any) => entry.path)).toEqual([
      'content/part-01/chapter-02.md',
      'content/part-01/chapter-03.md'
    ]);
    await fs.access(join(root, 'content/part-01/chapter-02.md'));
    await expect(fs.access(join(root, 'content/chapter-02.md'))).rejects.toBeDefined();
  });

  test('rejects moving an entry into itself and unknown targets', async () => {
    const self = await service.moveManuscriptEntry(root, 'content/part-01', {
      parentPath: 'content/part-01',
      index: 0
    });
    expect(self.ok).toBe(false);

    const missing = await service.moveManuscriptEntry(root, 'content/nope.md', { index: 0 });
    expect(missing.ok).toBe(false);
    expect(missing.message).toContain('not found');
  });

  test('rejects moves that would overwrite an existing file', async () => {
    await fs.writeFile(join(root, 'content/part-01/chapter-02.md'), 'existing');
    const result = await service.moveManuscriptEntry(root, 'content/chapter-02.md', {
      parentPath: 'content/part-01',
      index: 0
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('already contains');
  });

  test('toggles build inclusion by writing include: false and removing it again', async () => {
    const excluded = await service.setManuscriptBuildInclusion(root, 'content/chapter-02.md', false);
    expect(excluded.ok).toBe(true);
    let doc = await manifest();
    expect(doc.content[1].include).toBe(false);

    const included = await service.setManuscriptBuildInclusion(root, 'content/chapter-02.md', true);
    expect(included.ok).toBe(true);
    doc = await manifest();
    expect('include' in doc.content[1]).toBe(false);
  });

  test('creates a chapter file with a unicode-aware slug and manifest entry', async () => {
    const result = await service.createManuscriptChapter(root, undefined, 'Новая глава: испытание');
    expect(result.ok).toBe(true);
    const doc = await manifest();
    const created = doc.content[doc.content.length - 1];
    expect(created.path).toBe('content/новая-глава-испытание.md');
    expect(created.title).toBe('Новая глава: испытание');
    const text = await fs.readFile(join(root, created.path), 'utf8');
    expect(text).toBe('# Новая глава: испытание\n');
  });

  test('creates chapters inside folder entries', async () => {
    const result = await service.createManuscriptChapter(root, 'content/part-01', 'Глава 4');
    expect(result.ok).toBe(true);
    const doc = await manifest();
    const part = doc.content.find((entry: any) => entry.path === 'content/part-01');
    expect(part.children[part.children.length - 1].path).toBe('content/part-01/глава-4.md');
  });

  test('reports duplicate manifest paths as diagnostics with unique node ids', async () => {
    await fs.appendFile(join(root, 'manifest.yaml'), '  - path: content/chapter-01.md\n    title: Дубликат\n');
    const snapshot = await service.getSnapshot(root);
    const duplicateWarnings = snapshot.diagnostics.filter(diagnostic => diagnostic.message.includes('Duplicate manifest path'));
    expect(duplicateWarnings.length).toBe(1);
    const ids = snapshot.content.map(node => node.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
