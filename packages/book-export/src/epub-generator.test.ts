import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { EpubGenerator, slugifyBase, type EpubNavPoint } from './index';

const SCRATCH =
  '/private/tmp/claude-501/-Users-vedmalex-work-ai-editor-3/8a15f000-cd38-4649-8fe4-b479e61f41c1/scratchpad/epub-test';

beforeAll(async () => {
  await rm(SCRATCH, { recursive: true, force: true });
  await mkdir(SCRATCH, { recursive: true });
});

afterAll(async () => {
  await rm(SCRATCH, { recursive: true, force: true });
});

function unzipList(path: string): string {
  const result = Bun.spawnSync(['unzip', '-l', path]);
  return result.stdout.toString();
}

function unzipEntry(path: string, entry: string): string {
  const result = Bun.spawnSync(['unzip', '-p', path, entry]);
  return result.stdout.toString();
}

/**
 * Build a small EPUB with a nested part (folder) holding two chapters plus a
 * top-level chapter, mirroring the manifest walk the backend drives.
 */
async function buildSampleEpub(name: string, zipStrategy: 'auto' | 'manual'): Promise<string> {
  const outputPath = join(SCRATCH, `${name}.epub`);
  const generator = new EpubGenerator({
    outputPath,
    title: 'Sample Manuscript',
    author: 'Test Author',
    language: 'en',
    identifier: 'urn:test:sample',
    zipStrategy
  });

  const chapterA = generator.addChapterFromContent({
    title: 'Chapter A',
    content: '# Chapter A\n\nBody of chapter A.\n\n## Глава Первая\n\nUnicode heading section.\n'
  });
  const chapterB = generator.addChapterFromContent({
    title: 'Chapter B',
    content: '# Chapter B\n\nBody of chapter B.\n'
  });
  const epilogue = generator.addChapterFromContent({
    title: 'Epilogue',
    content: '# Epilogue\n\nThe end.\n'
  });

  const navTree: EpubNavPoint[] = [
    {
      title: 'Part One',
      children: [
        { title: 'Chapter A', chapterId: chapterA, children: [] },
        { title: 'Chapter B', chapterId: chapterB, children: [] }
      ]
    },
    { title: 'Epilogue', chapterId: epilogue, children: [] }
  ];
  generator.setNavTree(navTree);

  await generator.generate();
  return outputPath;
}

describe('EpubGenerator zip structure', () => {
  test('produces a valid EPUB container (auto zip strategy)', async () => {
    const path = await buildSampleEpub('auto', 'auto');
    expect((await stat(path)).size).toBeGreaterThan(0);

    const listing = unzipList(path);
    expect(listing).toContain('mimetype');
    expect(listing).toContain('META-INF/container.xml');
    expect(listing).toContain('OEBPS/content.opf');
    expect(listing).toContain('OEBPS/toc.ncx');
    expect(listing).toContain('OEBPS/chapter-1.html');
    expect(listing).toContain('OEBPS/chapter-2.html');
    expect(listing).toContain('OEBPS/chapter-3.html');

    expect(unzipEntry(path, 'mimetype').trim()).toBe('application/epub+zip');
    expect(unzipEntry(path, 'META-INF/container.xml')).toContain('OEBPS/content.opf');
    expect(unzipEntry(path, 'OEBPS/content.opf')).toContain('<dc:title>Sample Manuscript</dc:title>');
  });

  test('built-in Node ZIP writer (manual strategy) produces a valid EPUB with mimetype first', async () => {
    const path = await buildSampleEpub('manual', 'manual');
    expect((await stat(path)).size).toBeGreaterThan(0);

    const listing = unzipList(path);
    expect(listing).toContain('mimetype');
    expect(listing).toContain('OEBPS/content.opf');
    expect(listing).toContain('OEBPS/toc.ncx');

    // mimetype must be the first archive entry per the EPUB spec.
    const lines = listing
      .split('\n')
      .map(line => line.trim())
      .filter(line => /\.(html|opf|ncx|css|xml)$/.test(line) || line.endsWith('mimetype'));
    const firstFile = lines.find(line => line.endsWith('mimetype') || line.includes('OEBPS/') || line.includes('META-INF/'));
    expect(firstFile?.endsWith('mimetype')).toBe(true);

    expect(unzipEntry(path, 'mimetype').trim()).toBe('application/epub+zip');
  });
});

describe('EpubGenerator nested NCX', () => {
  test('nested folders become nested navPoints wrapping their chapters', async () => {
    const path = await buildSampleEpub('nested-ncx', 'manual');
    const ncx = unzipEntry(path, 'OEBPS/toc.ncx');

    // Part navPoint present and points at its first descendant chapter.
    expect(ncx).toContain('<text>Part One</text>');
    expect(ncx).toContain('<text>Chapter A</text>');
    expect(ncx).toContain('<text>Chapter B</text>');
    expect(ncx).toContain('<text>Epilogue</text>');

    // "Chapter A" nests inside "Part One": the Part navPoint opens before the
    // chapter navPoint and only closes after it.
    const partIndex = ncx.indexOf('<text>Part One</text>');
    const chapterAIndex = ncx.indexOf('<text>Chapter A</text>');
    const epilogueIndex = ncx.indexOf('<text>Epilogue</text>');
    expect(partIndex).toBeLessThan(chapterAIndex);
    expect(chapterAIndex).toBeLessThan(epilogueIndex);

    // The Part folder navPoint borrows its first chapter's html as content src.
    expect(ncx).toContain('<content src="chapter-1.html"/>');
  });
});

describe('EpubGenerator unicode anchors', () => {
  test('heading ids and NCX anchors both use the slugifyBase convention', async () => {
    const path = await buildSampleEpub('unicode', 'manual');
    const expectedAnchor = slugifyBase('Глава Первая');
    expect(expectedAnchor).toBe('глава-первая');

    const chapterHtml = unzipEntry(path, 'OEBPS/chapter-1.html');
    // markdownConverter assigns the heading id from the shared slug convention.
    expect(chapterHtml).toContain(`id="${expectedAnchor}"`);

    const ncx = unzipEntry(path, 'OEBPS/toc.ncx');
    // The within-chapter heading is nested under the chapter with a matching anchor.
    expect(ncx).toContain(`chapter-1.html#${expectedAnchor}`);
  });
});

describe('EpubGenerator cross-chapter link rewriting (in-memory flow)', () => {
  test('rewrites .md links, degrades excluded links, leaves external links', async () => {
    const outputPath = join(SCRATCH, 'links.epub');
    const generator = new EpubGenerator({
      outputPath,
      title: 'Linked Manuscript',
      author: 'Test Author',
      language: 'en',
      identifier: 'urn:test:links',
      zipStrategy: 'manual'
    });

    // chapterPathMap keys are the chapters' absolute source paths.
    generator.setChapterPathMap({
      [join(SCRATCH, 'chapter-a.md')]: 'chapter-1.html',
      [join(SCRATCH, 'chapter-b.md')]: 'chapter-2.html'
    });

    const chapterA = generator.addChapterFromContent({
      title: 'Chapter A',
      sourcePath: join(SCRATCH, 'chapter-a.md'),
      content: [
        '# Chapter A',
        '',
        'Continue to [the teaching](./chapter-b.md#target-heading).',
        '',
        'The [old notes](./notes.md) were cut from the book.',
        '',
        'See [the project home](https://example.com) for more.',
        ''
      ].join('\n')
    });
    const chapterB = generator.addChapterFromContent({
      title: 'Chapter B',
      sourcePath: join(SCRATCH, 'chapter-b.md'),
      content: '# Chapter B\n\n## Target Heading\n\nBody.\n'
    });

    generator.setNavTree([
      { title: 'Chapter A', chapterId: chapterA, children: [] },
      { title: 'Chapter B', chapterId: chapterB, children: [] }
    ]);

    await generator.generate();

    const chapterOne = unzipEntry(outputPath, 'OEBPS/chapter-1.html');
    // Cross-chapter .md link → target chapter file + slugified anchor.
    expect(chapterOne).toContain('href="chapter-2.html#target-heading"');
    expect(chapterOne).not.toContain('chapter-b.md');
    // Excluded/unknown target degrades to plain text (link text kept, no dead href).
    expect(chapterOne).toContain('old notes');
    expect(chapterOne).not.toContain('notes.md');
    // External link untouched.
    expect(chapterOne).toContain('href="https://example.com"');

    // The rewritten anchor matches the target heading id emitted in chapter B.
    const chapterTwo = unzipEntry(outputPath, 'OEBPS/chapter-2.html');
    expect(chapterTwo).toContain(`id="${slugifyBase('Target Heading')}"`);
  });
});

describe('EpubGenerator cover image', () => {
  const TINY_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64'
  );

  test('embeds cover image, cover page, and OPF cover metadata/spine', async () => {
    const coverPath = join(SCRATCH, 'my-cover.png');
    await Bun.write(coverPath, TINY_PNG);

    const outputPath = join(SCRATCH, 'cover.epub');
    const generator = new EpubGenerator({
      outputPath,
      title: 'Covered Manuscript',
      author: 'Test Author',
      language: 'en',
      identifier: 'urn:test:cover',
      cover: coverPath,
      zipStrategy: 'manual'
    });
    generator.addChapterFromContent({ title: 'Chapter A', content: '# Chapter A\n\nBody.\n' });
    await generator.generate();

    const listing = unzipList(outputPath);
    expect(listing).toContain('OEBPS/images/cover.png');
    expect(listing).toContain('OEBPS/cover.xhtml');

    const opf = unzipEntry(outputPath, 'OEBPS/content.opf');
    expect(opf).toContain('properties="cover-image"');
    expect(opf).toContain('href="images/cover.png"');
    expect(opf).toContain('<meta name="cover" content="cover-image"/>');
    // Cover page fronts the spine, before the first chapter.
    const coverSpineIndex = opf.indexOf('idref="cover"');
    const chapterSpineIndex = opf.indexOf('idref="chapter-1"');
    expect(coverSpineIndex).toBeGreaterThan(-1);
    expect(coverSpineIndex).toBeLessThan(chapterSpineIndex);
  });

  test('skips a nonexistent cover without emitting cover files', async () => {
    const outputPath = join(SCRATCH, 'no-cover.epub');
    const generator = new EpubGenerator({
      outputPath,
      title: 'Uncovered Manuscript',
      author: 'Test Author',
      language: 'en',
      identifier: 'urn:test:no-cover',
      cover: join(SCRATCH, 'does-not-exist.png'),
      zipStrategy: 'manual'
    });
    generator.addChapterFromContent({ title: 'Chapter A', content: '# Chapter A\n\nBody.\n' });
    await generator.generate();

    const listing = unzipList(outputPath);
    expect(listing).not.toContain('OEBPS/images/');
    const opf = unzipEntry(outputPath, 'OEBPS/content.opf');
    expect(opf).not.toContain('cover-image');
  });
});
