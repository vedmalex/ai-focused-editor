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

describe('NodeManuscriptWorkspaceService.validateDocumentText', () => {
  const root = '/tmp/afe-live-root';
  let service: NodeManuscriptWorkspaceService;

  beforeEach(() => {
    service = createService();
  });

  function expectUriEndsWith(diagnostics: Awaited<ReturnType<NodeManuscriptWorkspaceService['validateDocumentText']>>, suffix: string): void {
    for (const diagnostic of diagnostics) {
      expect(diagnostic.uri?.endsWith(suffix)).toBe(true);
    }
  }

  test('lints Markdown text and returns diagnostics with ranges on the file uri', async () => {
    // An empty semantic tag label ("[[char:hero|]]") is a semantic-markdown lint error.
    const diagnostics = await service.validateDocumentText(root, 'content/chapter-01.md', 'Text [[char:hero|]] more.\n');
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics.every(diagnostic => diagnostic.source === 'semantic-markdown')).toBe(true);
    expect(diagnostics[0].range).toBeDefined();
    expect(typeof diagnostics[0].range?.start.line).toBe('number');
    expectUriEndsWith(diagnostics, 'content/chapter-01.md');
  });

  test('returns no diagnostics for clean Markdown', async () => {
    const diagnostics = await service.validateDocumentText(root, 'content/chapter-01.md', '# Title\n\nPlain paragraph.\n');
    expect(diagnostics).toEqual([]);
  });

  test('accepts a valid character entity YAML against the schema', async () => {
    const diagnostics = await service.validateDocumentText(
      root,
      'entities/characters/hero.yaml',
      'id: hero\nname: Hero\naliases:\n  - The Brave\n'
    );
    expect(diagnostics).toEqual([]);
  });

  test('flags a character entity YAML missing required fields', async () => {
    const diagnostics = await service.validateDocumentText(
      root,
      'entities/characters/hero.yaml',
      'name: Hero\n'
    );
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics.every(diagnostic => diagnostic.source === 'yaml-schema')).toBe(true);
    expect(diagnostics.some(diagnostic => diagnostic.message.includes('character entity'))).toBe(true);
    expectUriEndsWith(diagnostics, 'entities/characters/hero.yaml');
  });

  test('routes a .yml term entity extension to the term schema', async () => {
    const valid = await service.validateDocumentText(root, 'entities/terms/relic.yml', 'id: relic\nterm: Relic\n');
    expect(valid).toEqual([]);
    const invalid = await service.validateDocumentText(root, 'entities/terms/relic.yml', 'id: relic\n');
    expect(invalid.length).toBeGreaterThan(0);
    expect(invalid.some(diagnostic => diagnostic.message.includes('term entity'))).toBe(true);
  });

  test('validates manifest.yaml and metadata.yaml against their schemas', async () => {
    const manifestOk = await service.validateDocumentText(root, 'manifest.yaml', 'version: 1\ncontent: []\n');
    expect(manifestOk).toEqual([]);
    const manifestBad = await service.validateDocumentText(root, 'manifest.yaml', 'content: []\n');
    expect(manifestBad.some(diagnostic => diagnostic.message.includes('manifest.yaml'))).toBe(true);

    const metadataOk = await service.validateDocumentText(root, 'metadata.yaml', 'title: Book\nlanguage: en\n');
    expect(metadataOk).toEqual([]);
    const metadataBad = await service.validateDocumentText(root, 'metadata.yaml', 'title: Book\n');
    expect(metadataBad.some(diagnostic => diagnostic.message.includes('metadata.yaml'))).toBe(true);
  });

  test('returns a single parse-error diagnostic for malformed YAML', async () => {
    const diagnostics = await service.validateDocumentText(
      root,
      'entities/characters/hero.yaml',
      'id: hero\nname: "unterminated\n'
    );
    expect(diagnostics.length).toBe(1);
    expect(diagnostics[0].source).toBe('yaml-parser');
    expect(diagnostics[0].severity).toBe('error');
    expect(diagnostics[0].message).toContain('Invalid YAML');
  });

  test('yields no diagnostics for paths outside the schema routing', async () => {
    expect(await service.validateDocumentText(root, 'notes.txt', 'anything')).toEqual([]);
    // A YAML file outside the recognised entity folders is not schema-backed.
    expect(await service.validateDocumentText(root, 'entities/unknown/thing.yaml', 'id: x\n')).toEqual([]);
    expect(await service.validateDocumentText(root, 'ai/config.yaml', 'foo: bar\n')).toEqual([]);
  });
});
