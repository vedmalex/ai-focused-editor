import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { FileUri } from '@theia/core/lib/common/file-uri';
import { findChromePath, renderHtmlToPdf } from '@ai-focused-editor/book-export';
import {
  NodeAiModeRegistryService,
  NodeNarrativeEntityService,
  NodeSourceLibraryService
} from './node-domain-knowledge-service';

// Resolve a real browser once so the real-PDF extraction test can skip gracefully
// on machines without Chrome/Chromium and run for real when one is present.
const CHROME = findChromePath();

/**
 * Build a minimal, valid, uncompressed single-page PDF containing `text`, with
 * correct xref byte offsets so pdf.js (via unpdf) parses it deterministically and
 * offline — no Chrome required.
 */
function buildMinimalPdf(text: string): Buffer {
  const header = '%PDF-1.4\n';
  const stream = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ];

  let body = header;
  const offsets: number[] = [];
  objects.forEach((content, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${content}\nendobj\n`;
  });
  const xrefStart = body.length;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    xref += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(body + xref + trailer, 'latin1');
}

const SCRATCH_BASE = process.env.CLAUDE_SCRATCHPAD_DIR
  || '/private/tmp/claude-501/-Users-vedmalex-work-ai-editor-3/8a15f000-cd38-4649-8fe4-b479e61f41c1/scratchpad/domain-services-test';

async function makeRoot(): Promise<string> {
  await fs.mkdir(SCRATCH_BASE.startsWith('/') ? SCRATCH_BASE : tmpdir(), { recursive: true });
  return fs.mkdtemp(join(SCRATCH_BASE.startsWith('/') ? SCRATCH_BASE : tmpdir(), 'afe-domain-'));
}

describe('NodeNarrativeEntityService', () => {
  let root: string;
  let service: NodeNarrativeEntityService;

  beforeEach(async () => {
    root = await makeRoot();
    service = new NodeNarrativeEntityService();
    await fs.mkdir(join(root, 'entities/characters'), { recursive: true });
    await fs.mkdir(join(root, 'entities/terms'), { recursive: true });
    await fs.mkdir(join(root, 'entities/artifacts'), { recursive: true });
    await fs.mkdir(join(root, 'entities/locations'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  test('returns an info diagnostic when no workspace is open', async () => {
    const snapshot = await service.getSnapshot(undefined);
    expect(snapshot.entities).toEqual([]);
    expect(snapshot.diagnostics).toEqual([{
      severity: 'info',
      source: 'narrative-entities',
      message: 'Open a manuscript workspace to view entity cards.'
    }]);
  });

  test('parses character labels, aliases and summary', async () => {
    await fs.writeFile(join(root, 'entities/characters/hero.yaml'), [
      'id: hero',
      'name: Главный Герой',
      'summary: Отважный путешественник',
      'aliases:',
      '  - Герой',
      '  - "  "',
      '  - Странник',
      ''
    ].join('\n'));

    const snapshot = await service.getSnapshot(root);
    const hero = snapshot.entities.find(entity => entity.id === 'hero');
    expect(hero).toBeDefined();
    expect(hero!.kind).toBe('character');
    expect(hero!.label).toBe('Главный Герой');
    expect(hero!.summary).toBe('Отважный путешественник');
    expect(hero!.aliases).toEqual(['Герой', 'Странник']);
    expect(hero!.path).toBe('entities/characters/hero.yaml');
    expect(hero!.uri.startsWith('file:')).toBe(true);
  });

  test('parses rich character fields (epithets, backstory, arc, speech patterns, notes)', async () => {
    await fs.writeFile(join(root, 'entities/characters/sage.yaml'), [
      'id: sage',
      'name: Мудрец',
      'epithets:',
      '  - Наставник',
      '  - "  "',
      '  - Провидец',
      'backstory: Долгий путь через изгнание.',
      'arc: От сомнения к решимости.',
      'speechPatterns:',
      '  - Отвечает вопросом на вопрос',
      '  - Говорит притчами',
      'notes: Ключевой голос главы.',
      ''
    ].join('\n'));

    const snapshot = await service.getSnapshot(root);
    const sage = snapshot.entities.find(entity => entity.id === 'sage');
    expect(sage).toBeDefined();
    expect(sage!.epithets).toEqual(['Наставник', 'Провидец']);
    expect(sage!.backstory).toBe('Долгий путь через изгнание.');
    expect(sage!.arc).toBe('От сомнения к решимости.');
    expect(sage!.speechPatterns).toEqual(['Отвечает вопросом на вопрос', 'Говорит притчами']);
    expect(sage!.notes).toBe('Ключевой голос главы.');
  });

  test('scans artifact and location entity directories', async () => {
    await fs.writeFile(join(root, 'entities/artifacts/bow.yaml'), [
      'id: bow',
      'name: Гандива',
      'epithets:',
      '  - Гром небес',
      'summary: Божественный лук.',
      ''
    ].join('\n'));
    await fs.writeFile(join(root, 'entities/locations/field.yml'), [
      'name: Курукшетра',
      'summary: Поле дхармы.',
      ''
    ].join('\n'));

    const snapshot = await service.getSnapshot(root);

    const artifact = snapshot.entities.find(entity => entity.kind === 'artifact');
    expect(artifact).toBeDefined();
    expect(artifact!.id).toBe('bow');
    expect(artifact!.label).toBe('Гандива');
    expect(artifact!.epithets).toEqual(['Гром небес']);
    expect(artifact!.summary).toBe('Божественный лук.');
    expect(artifact!.path).toBe('entities/artifacts/bow.yaml');

    const location = snapshot.entities.find(entity => entity.kind === 'location');
    expect(location).toBeDefined();
    expect(location!.id).toBe('field');
    expect(location!.label).toBe('Курукшетра');
    expect(location!.summary).toBe('Поле дхармы.');
  });

  test('defaults rich fields to empty when absent', async () => {
    await fs.writeFile(join(root, 'entities/characters/plain.yaml'), 'id: plain\nname: Plain\n');
    const snapshot = await service.getSnapshot(root);
    const plain = snapshot.entities.find(entity => entity.id === 'plain');
    expect(plain!.epithets).toEqual([]);
    expect(plain!.speechPatterns).toEqual([]);
    expect(plain!.backstory).toBe('');
    expect(plain!.arc).toBe('');
    expect(plain!.notes).toBe('');
  });

  test('falls back to term label field and filename id', async () => {
    await fs.writeFile(join(root, 'entities/terms/magic.yml'), 'term: Магия\n');
    const snapshot = await service.getSnapshot(root);
    const term = snapshot.entities.find(entity => entity.kind === 'term');
    expect(term).toBeDefined();
    expect(term!.id).toBe('magic');
    expect(term!.label).toBe('Магия');
    expect(term!.summary).toBe('');
    expect(term!.aliases).toEqual([]);
  });

  test('emits an error diagnostic for malformed YAML', async () => {
    await fs.writeFile(join(root, 'entities/characters/broken.yaml'), 'id: broken\n  : : :\n');
    const snapshot = await service.getSnapshot(root);
    const errors = snapshot.diagnostics.filter(diagnostic => diagnostic.severity === 'error');
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0].source).toBe('narrative-entities');
    expect(errors[0].message).toContain('Invalid character YAML');
  });

  test('emits an error diagnostic when the entity YAML is not an object', async () => {
    await fs.writeFile(join(root, 'entities/terms/list.yaml'), '- a\n- b\n');
    const snapshot = await service.getSnapshot(root);
    const error = snapshot.diagnostics.find(diagnostic => diagnostic.message.includes('term entity YAML must be an object'));
    expect(error?.severity).toBe('error');
  });

  test('emits an info diagnostic when an entity directory is missing', async () => {
    await fs.rm(join(root, 'entities/terms'), { recursive: true, force: true });
    const snapshot = await service.getSnapshot(root);
    const info = snapshot.diagnostics.find(diagnostic => diagnostic.message.includes('No term entity directory found'));
    expect(info?.severity).toBe('info');
  });
});

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

describe('NodeSourceLibraryService.extractSourceText', () => {
  let root: string;
  let service: NodeSourceLibraryService;

  beforeEach(async () => {
    root = await makeRoot();
    service = new NodeSourceLibraryService();
    await fs.mkdir(join(root, 'sources/documents'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  test('extracts text from a simple text-based PDF', async () => {
    await fs.writeFile(join(root, 'sources/documents/study.pdf'), buildMinimalPdf('Dharma Notes Token 4821'));
    const result = await service.extractSourceText(root, 'sources/documents/study.pdf');
    expect(result.ok).toBe(true);
    expect(result.text).toContain('Dharma Notes Token 4821');
    expect(result.detail).toBeUndefined();
  });

  test.skipIf(!CHROME)('extracts text from a Chrome-generated PDF', async () => {
    const pdfPath = join(root, 'sources/documents/generated.pdf');
    await renderHtmlToPdf(
      '<!doctype html><html><body><h1>Generated Source</h1><p>Unmistakable Token 90210 lives here.</p></body></html>',
      { outputPath: pdfPath, format: 'a4' }
    );
    const result = await service.extractSourceText(root, 'sources/documents/generated.pdf');
    expect(result.ok).toBe(true);
    expect(result.text).toContain('Unmistakable Token 90210');
  }, 60000);

  test('reads a non-PDF source file as UTF-8 text', async () => {
    await fs.writeFile(join(root, 'sources/documents/notes.md'), '# Notes\n\nPlain markdown body.\n');
    const result = await service.extractSourceText(root, 'sources/documents/notes.md');
    expect(result.ok).toBe(true);
    expect(result.text).toContain('Plain markdown body.');
  });

  test('reports a clear failure for a missing file without throwing', async () => {
    const result = await service.extractSourceText(root, 'sources/documents/does-not-exist.pdf');
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('not found');
  });

  test('rejects a path that escapes the workspace root', async () => {
    const result = await service.extractSourceText(root, '../secrets.pdf');
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('escapes the workspace root');
  });

  test('fails gracefully on a corrupt PDF instead of crashing', async () => {
    await fs.writeFile(join(root, 'sources/documents/broken.pdf'), '%PDF-1.4\nthis is not a real pdf body\n');
    const result = await service.extractSourceText(root, 'sources/documents/broken.pdf');
    expect(result.ok).toBe(false);
    expect(typeof result.detail).toBe('string');
  });

  test('reports a missing workspace root', async () => {
    const result = await service.extractSourceText('', 'sources/documents/study.pdf');
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('workspace');
  });
});

describe('NodeAiModeRegistryService', () => {
  let root: string;
  let service: NodeAiModeRegistryService;

  beforeEach(async () => {
    root = await makeRoot();
    service = new NodeAiModeRegistryService();
    // Isolate the bundled/global layers so these book-focused assertions see the
    // book layer only; layering is exercised in the dedicated describe below.
    service.configureModeSources({
      bundledModesPath: join(root, '__no_such_bundled__.yaml'),
      globalModesPath: join(root, '__no_such_global__.yaml')
    });
    await fs.mkdir(join(root, 'ai/prompts'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  test('returns an info diagnostic when no workspace is open', async () => {
    const snapshot = await service.getSnapshot(undefined);
    expect(snapshot.modes).toEqual([]);
    expect(snapshot.diagnostics[0].message).toBe('Open a manuscript workspace to load project AI modes.');
  });

  test('parses valid modes and reports duplicate and invalid entries', async () => {
    await fs.writeFile(join(root, 'ai/prompts/custom-modes.yaml'), [
      'modes:',
      '  - id: improve-selection',
      '    label: Improve',
      '    description: Improve the selection',
      '    systemPrompt: You improve text.',
      '    userPrompt: Improve this.',
      '    parameters:',
      '      temperature: 0.5',
      '  - id: legacy',
      '    prompt: Legacy prompt as systemPrompt',
      '  - id: improve-selection',
      '    systemPrompt: Duplicate',
      '  - label: no-id',
      '    systemPrompt: Missing id',
      ''
    ].join('\n'));

    const snapshot = await service.getSnapshot(root);
    expect(snapshot.modes.map(mode => mode.id)).toEqual(['improve-selection', 'legacy']);

    const improve = snapshot.modes[0];
    expect(improve.label).toBe('Improve');
    expect(improve.systemPrompt).toBe('You improve text.');
    expect(improve.userPrompt).toBe('Improve this.');
    expect(improve.parameters).toEqual({ temperature: 0.5 });

    const legacy = snapshot.modes[1];
    expect(legacy.label).toBe('legacy');
    expect(legacy.systemPrompt).toBe('Legacy prompt as systemPrompt');

    const warnings = snapshot.diagnostics.filter(diagnostic => diagnostic.severity === 'warning');
    expect(warnings.some(diagnostic => diagnostic.message.includes('duplicate AI mode id: improve-selection'))).toBe(true);
    expect(warnings.some(diagnostic => diagnostic.message.includes('id and systemPrompt are required'))).toBe(true);
    expect(snapshot.sourceUri.endsWith('ai/prompts/custom-modes.yaml')).toBe(true);
  });

  test('emits an info diagnostic when the modes file is absent', async () => {
    const snapshot = await service.getSnapshot(root);
    expect(snapshot.modes).toEqual([]);
    expect(snapshot.diagnostics[0].message).toContain('No project AI modes file found');
    expect(snapshot.diagnostics[0].severity).toBe('info');
  });

  test('emits an error diagnostic for malformed modes YAML', async () => {
    await fs.writeFile(join(root, 'ai/prompts/custom-modes.yaml'), 'modes:\n  - id: a\n : : :\n');
    const snapshot = await service.getSnapshot(root);
    expect(snapshot.diagnostics[0].severity).toBe('error');
    expect(snapshot.diagnostics[0].message).toContain('Invalid AI modes YAML');
  });

  test('warns when the modes file has no modes list', async () => {
    await fs.writeFile(join(root, 'ai/prompts/custom-modes.yaml'), 'modes: 5\n');
    const snapshot = await service.getSnapshot(root);
    const warning = snapshot.diagnostics.find(diagnostic => diagnostic.message.includes('must contain a modes list'));
    expect(warning?.severity).toBe('warning');
  });

  test('defaults context to chat, menu/agent to false and apply to chat', async () => {
    await fs.writeFile(join(root, 'ai/prompts/custom-modes.yaml'), [
      'modes:',
      '  - id: plain',
      '    systemPrompt: Do a thing.',
      ''
    ].join('\n'));

    const snapshot = await service.getSnapshot(root);
    const plain = snapshot.modes[0];
    expect(plain.context).toBe('chat');
    expect(plain.menu).toBe(false);
    expect(plain.agent).toBe(false);
    expect(plain.apply).toBe('chat');
    expect(plain.icon).toBeUndefined();
    expect(snapshot.diagnostics.filter(diagnostic => diagnostic.severity === 'warning')).toEqual([]);
  });

  test('defaults apply to replace for selection modes and parses menu/icon', async () => {
    await fs.writeFile(join(root, 'ai/prompts/custom-modes.yaml'), [
      'modes:',
      '  - id: rewrite',
      '    label: Rewrite',
      '    systemPrompt: Rewrite the selection.',
      '    context: selection',
      '    menu: true',
      '    icon: sparkle',
      ''
    ].join('\n'));

    const snapshot = await service.getSnapshot(root);
    const rewrite = snapshot.modes[0];
    expect(rewrite.context).toBe('selection');
    expect(rewrite.menu).toBe(true);
    expect(rewrite.apply).toBe('replace');
    expect(rewrite.icon).toBe('sparkle');
  });

  test('honours an explicit insert apply for word modes', async () => {
    await fs.writeFile(join(root, 'ai/prompts/custom-modes.yaml'), [
      'modes:',
      '  - id: define',
      '    systemPrompt: Define the word.',
      '    context: word',
      '    apply: insert',
      ''
    ].join('\n'));

    const snapshot = await service.getSnapshot(root);
    expect(snapshot.modes[0].apply).toBe('insert');
  });

  test('warns and defaults on an unknown context value', async () => {
    await fs.writeFile(join(root, 'ai/prompts/custom-modes.yaml'), [
      'modes:',
      '  - id: weird',
      '    systemPrompt: Prompt.',
      '    context: paragraph',
      ''
    ].join('\n'));

    const snapshot = await service.getSnapshot(root);
    expect(snapshot.modes[0].context).toBe('chat');
    const warning = snapshot.diagnostics.find(diagnostic => diagnostic.message.includes('unknown context "paragraph"'));
    expect(warning?.severity).toBe('warning');
  });

  test('warns and defaults on an unknown apply value', async () => {
    await fs.writeFile(join(root, 'ai/prompts/custom-modes.yaml'), [
      'modes:',
      '  - id: weird-apply',
      '    systemPrompt: Prompt.',
      '    context: selection',
      '    apply: overwrite',
      ''
    ].join('\n'));

    const snapshot = await service.getSnapshot(root);
    // Falls back to the selection default.
    expect(snapshot.modes[0].apply).toBe('replace');
    const warning = snapshot.diagnostics.find(diagnostic => diagnostic.message.includes('unknown apply "overwrite"'));
    expect(warning?.severity).toBe('warning');
  });

  test('warns when replace/insert is used with a non-editable context and falls back to chat', async () => {
    await fs.writeFile(join(root, 'ai/prompts/custom-modes.yaml'), [
      'modes:',
      '  - id: chapter-replace',
      '    systemPrompt: Prompt.',
      '    context: chapter',
      '    apply: replace',
      ''
    ].join('\n'));

    const snapshot = await service.getSnapshot(root);
    expect(snapshot.modes[0].apply).toBe('chat');
    const warning = snapshot.diagnostics.find(diagnostic =>
      diagnostic.message.includes('only selection/word modes can replace or insert'));
    expect(warning?.severity).toBe('warning');
  });

  test('parses the agent flag and ignores a non-boolean menu value', async () => {
    await fs.writeFile(join(root, 'ai/prompts/custom-modes.yaml'), [
      'modes:',
      '  - id: lore',
      '    systemPrompt: Answer world questions.',
      '    agent: true',
      '    menu: yes-please',
      ''
    ].join('\n'));

    const snapshot = await service.getSnapshot(root);
    const lore = snapshot.modes[0];
    expect(lore.agent).toBe(true);
    // A non-boolean menu value is treated as false rather than truthy.
    expect(lore.menu).toBe(false);
  });

  test('parses enabled:false and hides the mode from the consumer list', async () => {
    await fs.writeFile(join(root, 'ai/prompts/custom-modes.yaml'), [
      'modes:',
      '  - id: shown',
      '    systemPrompt: Visible.',
      '  - id: hidden',
      '    systemPrompt: Hidden.',
      '    enabled: false',
      ''
    ].join('\n'));

    const snapshot = await service.getSnapshot(root);
    // Consumer list excludes the disabled mode...
    expect(snapshot.modes.map(mode => mode.id)).toEqual(['shown']);
    // ...but the full resolution still carries it (for the form editor).
    expect(snapshot.resolved?.map(mode => mode.id)).toEqual(['shown', 'hidden']);
    expect(snapshot.resolved?.find(mode => mode.id === 'hidden')?.enabled).toBe(false);
    expect(snapshot.resolved?.every(mode => mode.origin === 'book')).toBe(true);
  });

  describe('three-layer merge (bundled/global/book)', () => {
    let bundledPath: string;
    let globalPath: string;

    beforeEach(async () => {
      bundledPath = join(root, 'fixtures/base-modes.yaml');
      globalPath = join(root, 'fixtures/global-modes.yaml');
      await fs.mkdir(join(root, 'fixtures'), { recursive: true });
      service.configureModeSources({ bundledModesPath: bundledPath, globalModesPath: globalPath });
    });

    test('resolves base + global + book with precedence book > global > bundled', async () => {
      await fs.writeFile(bundledPath, [
        'modes:',
        '  - id: base-only',
        '    label: Base Only',
        '    systemPrompt: base prompt',
        '  - id: shared',
        '    label: Base Shared',
        '    systemPrompt: base shared prompt',
        ''
      ].join('\n'));
      await fs.writeFile(globalPath, [
        'modes:',
        '  - id: global-only',
        '    label: Global Only',
        '    systemPrompt: global prompt',
        '  - id: shared',
        '    label: Global Shared',
        '    systemPrompt: global shared prompt',
        ''
      ].join('\n'));
      await fs.writeFile(join(root, 'ai/prompts/custom-modes.yaml'), [
        'modes:',
        '  - id: book-only',
        '    label: Book Only',
        '    systemPrompt: book prompt',
        '  - id: shared',
        '    label: Book Shared',
        '    systemPrompt: book shared prompt',
        ''
      ].join('\n'));

      const snapshot = await service.getSnapshot(root);
      const byId = new Map(snapshot.resolved!.map(mode => [mode.id, mode]));
      expect(byId.get('base-only')?.origin).toBe('built-in');
      expect(byId.get('global-only')?.origin).toBe('global');
      expect(byId.get('book-only')?.origin).toBe('book');

      const shared = byId.get('shared')!;
      expect(shared.origin).toBe('book');
      expect(shared.label).toBe('Book Shared');
      expect(shared.systemPrompt).toBe('book shared prompt');
      expect(shared.overrides).toBe('global');
    });

    test('a book enabled:false override hides a bundled base mode', async () => {
      await fs.writeFile(bundledPath, [
        'modes:',
        '  - id: base-mode',
        '    systemPrompt: base prompt',
        ''
      ].join('\n'));
      await fs.writeFile(join(root, 'ai/prompts/custom-modes.yaml'), [
        'modes:',
        '  - id: base-mode',
        '    systemPrompt: base prompt',
        '    enabled: false',
        ''
      ].join('\n'));

      const snapshot = await service.getSnapshot(root);
      expect(snapshot.modes.map(mode => mode.id)).toEqual([]);
      const resolved = snapshot.resolved!.find(mode => mode.id === 'base-mode')!;
      expect(resolved.enabled).toBe(false);
      expect(resolved.origin).toBe('book');
      expect(resolved.overrides).toBe('built-in');
    });

    test('exposes globalUri and watchUris (book + global, no bundled)', async () => {
      await fs.writeFile(bundledPath, 'modes: []\n');
      const snapshot = await service.getSnapshot(root);
      expect(snapshot.globalUri).toBe(FileUri.create(globalPath).toString());
      expect(snapshot.watchUris).toContain(snapshot.sourceUri!);
      expect(snapshot.watchUris).toContain(snapshot.globalUri!);
      expect(snapshot.watchUris).not.toContain(FileUri.create(bundledPath).toString());
    });

    test('the bundled base-modes.yaml shipped in the repo parses cleanly', async () => {
      const shipped = new NodeAiModeRegistryService();
      shipped.configureModeSources({ globalModesPath: join(root, '__none__.yaml') });
      const snapshot = await shipped.getSnapshot(root);
      const builtIns = snapshot.resolved!.filter(mode => mode.origin === 'built-in');
      // The bundled file ships several base modes and must load without errors.
      expect(builtIns.length).toBeGreaterThan(0);
      expect(snapshot.diagnostics.filter(diagnostic => diagnostic.severity === 'error')).toEqual([]);
    });
  });
});
