import { promises as fs } from 'fs';
import { dirname, join } from 'path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { findChromePath } from '@ai-focused-editor/book-export';
import {
  NodeBookBuildService,
  createSlugger,
  naturalCompare,
  slugifyBase
} from './node-book-build-service';

// Resolve a real browser once so PDF integration assertions skip gracefully on
// machines without Chrome/Chromium and run for real when one is present.
const CHROME = findChromePath();

const WORKSPACE_ROOT = '/private/tmp/claude-501/-Users-vedmalex-work-ai-editor-3/8a15f000-cd38-4649-8fe4-b479e61f41c1/scratchpad/bookbuild-test';

const service = new NodeBookBuildService();

async function createWorkspace(name: string, files: Record<string, string>): Promise<string> {
  const rootPath = join(WORKSPACE_ROOT, name);
  await fs.rm(rootPath, { recursive: true, force: true });
  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = join(rootPath, relativePath);
    await fs.mkdir(dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, contents, 'utf8');
  }
  return rootPath;
}

async function buildMarkdown(name: string, files: Record<string, string>) {
  const rootPath = await createWorkspace(name, files);
  const result = await service.buildMarkdown({ rootUri: rootPath });
  const output = result.contentLength > 0 ? await fs.readFile(result.outputPath, 'utf8') : '';
  return { result, output };
}

beforeAll(async () => {
  await fs.rm(WORKSPACE_ROOT, { recursive: true, force: true });
  await fs.mkdir(WORKSPACE_ROOT, { recursive: true });
});

afterAll(async () => {
  await fs.rm(WORKSPACE_ROOT, { recursive: true, force: true });
});

describe('slugifyBase', () => {
  test('keeps Latin words as a hyphenated slug', () => {
    expect(slugifyBase('Hello, World!')).toBe('hello-world');
    expect(slugifyBase('  Leading  and trailing  ')).toBe('leading-and-trailing');
    expect(slugifyBase('A — B')).toBe('a-b');
  });

  test('keeps Cyrillic letters instead of collapsing to section', () => {
    expect(slugifyBase('Глава Первая')).toBe('глава-первая');
    expect(slugifyBase('Пролог')).toBe('пролог');
  });

  test('keeps CJK letters', () => {
    expect(slugifyBase('第一章')).toBe('第一章');
    expect(slugifyBase('第一章 序')).toBe('第一章-序');
  });

  test('keeps Unicode digits and mixed scripts', () => {
    expect(slugifyBase('Chapter 12')).toBe('chapter-12');
    expect(slugifyBase('Глава 3: Битва')).toBe('глава-3-битва');
  });

  test('returns empty string for punctuation/emoji-only titles', () => {
    expect(slugifyBase('🚀🚀🚀')).toBe('');
    expect(slugifyBase('!!!???')).toBe('');
    expect(slugifyBase('— · —')).toBe('');
  });
});

describe('createSlugger', () => {
  test('deduplicates repeated slugs with numeric counters', () => {
    const slug = createSlugger();
    expect(slug('Intro')).toBe('intro');
    expect(slug('Intro')).toBe('intro-2');
    expect(slug('Intro')).toBe('intro-3');
  });

  test('deduplicates non-Latin slugs distinctly (no shared section anchor)', () => {
    const slug = createSlugger();
    expect(slug('第一章')).toBe('第一章');
    expect(slug('第一章')).toBe('第一章-2');
  });

  test('falls back to section + counter for empty slugs', () => {
    const slug = createSlugger();
    expect(slug('🚀')).toBe('section');
    expect(slug('!!!')).toBe('section-2');
    expect(slug('???')).toBe('section-3');
  });

  test('avoids colliding a dedupe suffix with a natural slug', () => {
    const slug = createSlugger();
    expect(slug('Intro 2')).toBe('intro-2');
    expect(slug('Intro')).toBe('intro');
    expect(slug('Intro')).toBe('intro-3');
  });
});

describe('naturalCompare', () => {
  test('orders numeric suffixes naturally', () => {
    expect(naturalCompare('chapter-2', 'chapter-10')).toBeLessThan(0);
    const sorted = ['chapter-10.md', 'chapter-2.md', 'chapter-1.md'].sort(naturalCompare);
    expect(sorted).toEqual(['chapter-1.md', 'chapter-2.md', 'chapter-10.md']);
  });
});

describe('nested manifest hierarchy', () => {
  test('emits folder headings and a hierarchical TOC', async () => {
    const { result, output } = await buildMarkdown('nested', {
      'manifest.yaml': [
        'version: 1',
        'content:',
        '  - path: content/part-one',
        '    title: Part One',
        '    children:',
        '      - path: content/part-one/chapter-a.md',
        '        title: Chapter A',
        '      - path: content/part-one/chapter-b.md',
        '        title: Chapter B',
        '  - path: content/epilogue.md',
        '    title: Epilogue',
        ''
      ].join('\n'),
      'content/part-one/chapter-a.md': 'Body of chapter A.\n',
      'content/part-one/chapter-b.md': 'Body of chapter B.\n',
      'content/epilogue.md': 'The end.\n'
    });

    expect(result.diagnostics.some(d => d.severity === 'error')).toBe(false);
    expect(result.chapters.map(c => c.title)).toEqual(['Chapter A', 'Chapter B', 'Epilogue']);

    // Hierarchical TOC: folder at top level, chapters indented beneath it.
    expect(output).toContain('- [Part One](#part-one)');
    expect(output).toContain('  - [Chapter A](#chapter-a)');
    expect(output).toContain('  - [Chapter B](#chapter-b)');
    expect(output).toContain('- [Epilogue](#epilogue)');

    // Folder heading (depth 0 -> h2) and nested chapter heading (depth 1 -> h3).
    expect(output).toContain('## Part One');
    expect(output).toContain('### Chapter A');
    expect(output).toContain('### Chapter B');
    // Top-level chapter stays at h2.
    expect(output).toContain('## Epilogue');

    // Anchors exist for the TOC links.
    expect(output).toContain('<a id="part-one"></a>');
    expect(output).toContain('<a id="chapter-a"></a>');
  });

  test('produces nested <ul> in the HTML TOC and nested sections', async () => {
    const rootPath = await createWorkspace('nested-html', {
      'manifest.yaml': [
        'version: 1',
        'content:',
        '  - path: content/part-one',
        '    title: Part One',
        '    children:',
        '      - path: content/part-one/chapter-a.md',
        '        title: Chapter A',
        ''
      ].join('\n'),
      'content/part-one/chapter-a.md': 'Body of chapter A.\n'
    });
    const result = await service.buildHtml({ rootUri: rootPath });
    const html = await fs.readFile(result.outputPath, 'utf8');

    expect(html).toContain('<li><a href="#part-one">Part One</a><ul>');
    expect(html).toContain('<a href="#chapter-a">Chapter A</a>');
    expect(html).toContain('<section id="part-one">');
    expect(html).toContain('<h2>Part One</h2>');
    expect(html).toContain('<section id="chapter-a">');
  });
});

describe('include:false gating', () => {
  test('excludes whole folders and keeps siblings', async () => {
    const { result, output } = await buildMarkdown('excluded-folder', {
      'manifest.yaml': [
        'version: 1',
        'content:',
        '  - path: content/hidden',
        '    title: Hidden Part',
        '    include: false',
        '    children:',
        '      - path: content/hidden/secret.md',
        '        title: Secret Chapter',
        '  - path: content/visible.md',
        '    title: Visible Chapter',
        ''
      ].join('\n'),
      'content/hidden/secret.md': 'This is secret content.\n',
      'content/visible.md': 'This is visible content.\n'
    });

    expect(result.chapters.map(c => c.title)).toEqual(['Visible Chapter']);
    expect(output).toContain('Visible Chapter');
    expect(output).not.toContain('Hidden Part');
    expect(output).not.toContain('Secret Chapter');
    expect(output).not.toContain('secret content');
  });
});

describe('fallback content scan', () => {
  test('orders chapters numerically, not lexicographically', async () => {
    const { result } = await buildMarkdown('fallback-order', {
      'content/chapter-1.md': 'One.\n',
      'content/chapter-2.md': 'Two.\n',
      'content/chapter-10.md': 'Ten.\n'
    });

    expect(result.chapters.map(c => c.path)).toEqual([
      'content/chapter-1.md',
      'content/chapter-2.md',
      'content/chapter-10.md'
    ]);
    // Missing manifest is surfaced as a warning, not an error.
    expect(result.diagnostics.some(d => d.severity === 'error')).toBe(false);
    expect(result.diagnostics.some(d => d.severity === 'warning')).toBe(true);
  });
});

describe('semantic-markdown diagnostics', () => {
  test('surfaces tag syntax errors as non-blocking warnings with position', async () => {
    const { result } = await buildMarkdown('semantic-diagnostics', {
      'manifest.yaml': [
        'version: 1',
        'content:',
        '  - path: content/chapter-01.md',
        '    title: Chapter One',
        ''
      ].join('\n'),
      'content/chapter-01.md': 'Intro line.\nA broken [[char:krishna Krishna]] tag here.\n'
    });

    const semantic = result.diagnostics.filter(d => d.source === 'semantic-markdown');
    expect(semantic.length).toBeGreaterThan(0);
    expect(semantic[0].severity).toBe('warning');
    expect(semantic[0].uri).toContain('chapter-01.md');
    expect(semantic[0].range).toBeDefined();
    expect(semantic[0].range!.start.line).toBe(1);

    // Semantic warnings must NOT block the build.
    expect(result.diagnostics.some(d => d.severity === 'error')).toBe(false);
    expect(result.contentLength).toBeGreaterThan(0);
  });
});

describe('unicode titles end-to-end', () => {
  test('generates readable Cyrillic anchors and unique duplicates', async () => {
    const { result, output } = await buildMarkdown('unicode', {
      'manifest.yaml': [
        'version: 1',
        'content:',
        '  - path: content/glava-1.md',
        '    title: Глава Первая',
        '  - path: content/glava-1-dup.md',
        '    title: Глава Первая',
        ''
      ].join('\n'),
      'content/glava-1.md': 'Текст первой главы.\n',
      'content/glava-1-dup.md': 'Ещё одна глава.\n'
    });

    expect(result.diagnostics.some(d => d.severity === 'error')).toBe(false);
    expect(output).toContain('- [Глава Первая](#глава-первая)');
    expect(output).toContain('- [Глава Первая](#глава-первая-2)');
    expect(output).toContain('<a id="глава-первая"></a>');
    expect(output).toContain('<a id="глава-первая-2"></a>');
    // The old behaviour collapsed both to #section.
    expect(output).not.toContain('(#section)');
  });
});

describe('GFM rendering (HTML export)', () => {
  test('renders GFM tables, strikethrough, and task lists in book.html', async () => {
    const rootPath = await createWorkspace('gfm-html', {
      'metadata.yaml': ['title: GFM Book', 'language: en', ''].join('\n'),
      'manifest.yaml': ['version: 1', 'content:', '  - path: content/chapter-01.md', '    title: Chapter One', ''].join('\n'),
      'content/chapter-01.md': [
        '# Chapter One',
        '',
        '| Stance | Outcome |',
        '| --- | --- |',
        '| Attachment | Bondage |',
        '| Karma-yoga | ~~Bondage~~ Freedom |',
        '',
        '- [x] done item',
        '- [ ] open item',
        ''
      ].join('\n')
    });

    const result = await service.buildHtml({ rootUri: rootPath });
    const html = await fs.readFile(result.outputPath, 'utf8');

    expect(result.diagnostics.some(d => d.severity === 'error')).toBe(false);
    // GFM table renders to a real <table> (markdown-it default preset).
    expect(html).toContain('<table>');
    expect(html).toContain('<th>Stance</th>');
    expect(html).toContain('<td>Attachment</td>');
    // GFM strikethrough renders to <s> (markdown-it default preset).
    expect(html).toContain('<s>Bondage</s>');
    // GFM task lists render to disabled checkbox inputs (hand-rolled plugin).
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('checked="checked"');
    expect(html).toContain('class="task-list-item"');
    // The literal marker text must not leak through.
    expect(html).not.toContain('[x] done item');
    expect(html).not.toContain('[ ] open item');
  });
});

function unzipEntry(path: string, entry: string): string {
  return Bun.spawnSync(['unzip', '-p', path, entry]).stdout.toString();
}

function unzipList(path: string): string {
  return Bun.spawnSync(['unzip', '-l', path]).stdout.toString();
}

describe('EPUB export', () => {
  test('produces build/book.epub with nested NCX, respects include:false, strips semantic tags', async () => {
    const rootPath = await createWorkspace('epub-nested', {
      'metadata.yaml': ['title: Sample Book', 'language: en', 'author: Test Author', ''].join('\n'),
      'manifest.yaml': [
        'version: 1',
        'content:',
        '  - path: content/chapter-01.md',
        '    title: Chapter One',
        '  - path: content/part-01',
        '    title: Part One',
        '    children:',
        '      - path: content/part-01/chapter-02.md',
        '        title: Chapter Two',
        '      - path: content/part-01/chapter-03.md',
        '        title: Chapter Three',
        '  - path: content/notes-draft.md',
        '    title: Draft Notes',
        '    include: false',
        ''
      ].join('\n'),
      'content/chapter-01.md':
        '# Chapter One\n\nOn the field, [[char:krishna|Krishna]] speaks about [[term:dharma|dharma]].\n\n## Глава Первая\n\nUnicode heading body.\n',
      'content/part-01/chapter-02.md': '# Chapter Two\n\nThe teaching begins.\n',
      'content/part-01/chapter-03.md': '# Chapter Three\n\nThe bow is raised again.\n',
      'content/notes-draft.md': '# Draft Notes\n\nSecret draft content.\n'
    });

    const result = await service.buildEpub({ rootUri: rootPath });

    // No fatal errors; the EPUB file exists and is non-empty.
    expect(result.diagnostics.some(d => d.severity === 'error')).toBe(false);
    expect(result.format).toBe('epub');
    expect(result.outputPath.endsWith('build/book.epub')).toBe(true);
    expect(result.contentLength).toBeGreaterThan(0);
    expect((await fs.stat(result.outputPath)).size).toBe(result.contentLength);

    // include:false chapter is excluded from the chapter list.
    expect(result.chapters.map(c => c.title)).toEqual(['Chapter One', 'Chapter Two', 'Chapter Three']);

    const listing = unzipList(result.outputPath);
    for (const entry of [
      'mimetype',
      'META-INF/container.xml',
      'OEBPS/content.opf',
      'OEBPS/toc.ncx',
      'OEBPS/chapter-1.html',
      'OEBPS/chapter-2.html',
      'OEBPS/chapter-3.html'
    ]) {
      expect(listing).toContain(entry);
    }
    // The excluded draft would be a 4th chapter; it must not be emitted.
    expect(listing).not.toContain('OEBPS/chapter-4.html');

    const ncx = unzipEntry(result.outputPath, 'OEBPS/toc.ncx');
    // Nested folders become nested navPoints: Part One wraps Chapter Two/Three.
    expect(ncx).toContain('<text>Part One</text>');
    const partIndex = ncx.indexOf('<text>Part One</text>');
    const chapterTwoIndex = ncx.indexOf('<text>Chapter Two</text>');
    const chapterThreeIndex = ncx.indexOf('<text>Chapter Three</text>');
    expect(partIndex).toBeLessThan(chapterTwoIndex);
    expect(chapterTwoIndex).toBeLessThan(chapterThreeIndex);
    // Excluded draft is absent from navigation too.
    expect(ncx).not.toContain('Draft Notes');

    // Semantic tags are stripped to their labels before EPUB conversion.
    const chapterOneHtml = unzipEntry(result.outputPath, 'OEBPS/chapter-1.html');
    expect(chapterOneHtml).toContain('Krishna');
    expect(chapterOneHtml).toContain('dharma');
    expect(chapterOneHtml).not.toContain('[[char:');
    expect(chapterOneHtml).not.toContain('[[term:');

    // Unicode heading anchors match slugifyBase, consistent with md/html exports.
    const expectedAnchor = slugifyBase('Глава Первая');
    expect(expectedAnchor).toBe('глава-первая');
    expect(chapterOneHtml).toContain(`id="${expectedAnchor}"`);
    expect(ncx).toContain(`chapter-1.html#${expectedAnchor}`);
  });

  test('blocks EPUB export on fatal diagnostics (no included chapters)', async () => {
    const rootPath = await createWorkspace('epub-empty', {
      'metadata.yaml': 'title: Empty Book\n',
      'manifest.yaml': ['version: 1', 'content: []', ''].join('\n')
    });

    const result = await service.buildEpub({ rootUri: rootPath });
    expect(result.diagnostics.some(d => d.severity === 'error')).toBe(true);
    expect(result.contentLength).toBe(0);
    await expect(fs.stat(result.outputPath)).rejects.toBeDefined();
  });

  test('rewrites in-build cross-chapter links, degrades excluded links, keeps external links', async () => {
    const rootPath = await createWorkspace('epub-links', {
      'metadata.yaml': ['title: Linked Book', 'language: en', 'author: Test Author', ''].join('\n'),
      'manifest.yaml': [
        'version: 1',
        'content:',
        '  - path: content/chapter-01.md',
        '    title: Chapter One',
        '  - path: content/part-01',
        '    title: Part One',
        '    children:',
        '      - path: content/part-01/chapter-02.md',
        '        title: Chapter Two',
        '  - path: content/notes-draft.md',
        '    title: Draft Notes',
        '    include: false',
        ''
      ].join('\n'),
      'content/chapter-01.md':
        '# Chapter One\n\nGo to [the teaching](part-01/chapter-02.md).\n\n## The Field\n\nThe [draft notes](notes-draft.md) were cut. See [home](https://example.com).\n',
      'content/part-01/chapter-02.md':
        '# Chapter Two\n\nBack to [the field](../chapter-01.md#the-field).\n',
      'content/notes-draft.md': '# Draft Notes\n\nSecret draft content.\n'
    });

    const result = await service.buildEpub({ rootUri: rootPath });
    expect(result.diagnostics.some(d => d.severity === 'error')).toBe(false);

    const chapterOne = unzipEntry(result.outputPath, 'OEBPS/chapter-1.html');
    // In-build cross-chapter link → chapter-2.html (chapter-02 is the 2nd chapter).
    expect(chapterOne).toContain('href="chapter-2.html"');
    expect(chapterOne).not.toContain('chapter-02.md');
    // Excluded (include:false) target degrades to plain text.
    expect(chapterOne).toContain('draft notes');
    expect(chapterOne).not.toContain('notes-draft.md');
    // External link untouched.
    expect(chapterOne).toContain('href="https://example.com"');
    // The forward-linked subheading exists as an anchor in chapter one.
    expect(chapterOne).toContain(`id="${slugifyBase('The Field')}"`);

    // Back-link with anchor resolves to chapter-1.html + slugified anchor.
    const chapterTwo = unzipEntry(result.outputPath, 'OEBPS/chapter-2.html');
    expect(chapterTwo).toContain(`href="chapter-1.html#${slugifyBase('The Field')}"`);
  });
});

describe('EPUB cover image', () => {
  const TINY_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64'
  );

  test('embeds the cover in the zip + OPF when metadata declares a cover', async () => {
    const rootPath = await createWorkspace('epub-cover', {
      'metadata.yaml': ['title: Covered Book', 'language: en', 'author: Test Author', 'cover: cover.png', ''].join('\n'),
      'manifest.yaml': ['version: 1', 'content:', '  - path: content/chapter-01.md', '    title: Chapter One', ''].join('\n'),
      'content/chapter-01.md': '# Chapter One\n\nBody.\n'
    });
    await fs.writeFile(join(rootPath, 'cover.png'), TINY_PNG);

    const result = await service.buildEpub({ rootUri: rootPath });
    expect(result.diagnostics.some(d => d.severity === 'error')).toBe(false);
    // No cover warning when the cover exists.
    expect(result.diagnostics.some(d => d.severity === 'warning' && /cover/i.test(d.message))).toBe(false);

    const listing = unzipList(result.outputPath);
    expect(listing).toContain('OEBPS/images/cover.png');
    expect(listing).toContain('OEBPS/cover.xhtml');

    const opf = unzipEntry(result.outputPath, 'OEBPS/content.opf');
    expect(opf).toContain('properties="cover-image"');
    expect(opf).toContain('href="images/cover.png"');
    expect(opf).toContain('<meta name="cover" content="cover-image"/>');
    // Cover page fronts the spine, before the first chapter.
    const coverSpineIndex = opf.indexOf('idref="cover"');
    const chapterSpineIndex = opf.indexOf('idref="chapter-1"');
    expect(coverSpineIndex).toBeGreaterThan(-1);
    expect(coverSpineIndex).toBeLessThan(chapterSpineIndex);
  });

  test('warns and builds without a cover when the cover path is missing', async () => {
    const rootPath = await createWorkspace('epub-cover-missing', {
      'metadata.yaml': ['title: Missing Cover Book', 'language: en', 'cover: cover.png', ''].join('\n'),
      'manifest.yaml': ['version: 1', 'content:', '  - path: content/chapter-01.md', '    title: Chapter One', ''].join('\n'),
      'content/chapter-01.md': '# Chapter One\n\nBody.\n'
    });

    const result = await service.buildEpub({ rootUri: rootPath });
    // Missing cover is a warning, not an error; the build still completes.
    expect(result.diagnostics.some(d => d.severity === 'error')).toBe(false);
    expect(result.contentLength).toBeGreaterThan(0);
    const coverWarning = result.diagnostics.find(d => d.severity === 'warning' && /cover/i.test(d.message));
    expect(coverWarning).toBeDefined();

    const listing = unzipList(result.outputPath);
    expect(listing).not.toContain('OEBPS/images/cover.png');
    const opf = unzipEntry(result.outputPath, 'OEBPS/content.opf');
    expect(opf).not.toContain('cover-image');
  });
});

describe('PDF export', () => {
  test.skipIf(!CHROME)('produces a valid build/book.pdf from the manifest tree', async () => {
    const rootPath = await createWorkspace('pdf-nested', {
      'metadata.yaml': ['title: Sample Book', 'language: en', 'author: Test Author', ''].join('\n'),
      'manifest.yaml': [
        'version: 1',
        'content:',
        '  - path: content/chapter-01.md',
        '    title: Chapter One',
        '  - path: content/part-01',
        '    title: Part One',
        '    children:',
        '      - path: content/part-01/chapter-02.md',
        '        title: Chapter Two',
        ''
      ].join('\n'),
      'content/chapter-01.md':
        '# Chapter One\n\nOn the field, [[char:krishna|Krishna]] speaks about [[term:dharma|dharma]].\n',
      'content/part-01/chapter-02.md': '# Chapter Two\n\nThe teaching begins.\n'
    });

    const result = await service.buildPdf({ rootUri: rootPath });

    expect(result.diagnostics.some(d => d.severity === 'error')).toBe(false);
    expect(result.format).toBe('pdf');
    expect(result.outputPath.endsWith('build/book.pdf')).toBe(true);
    expect(result.chapters.map(c => c.title)).toEqual(['Chapter One', 'Chapter Two']);

    const bytes = await fs.readFile(result.outputPath);
    // Valid PDFs start with the "%PDF-" magic header and are non-trivially sized.
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect((await fs.stat(result.outputPath)).size).toBeGreaterThan(1024);
    expect(result.contentLength).toBe((await fs.stat(result.outputPath)).size);
  }, 60000);
});
