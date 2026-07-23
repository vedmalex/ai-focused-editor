import { promises as fs } from 'fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'path';
import { FileUri } from '@theia/core/lib/common/file-uri';
import { injectable } from '@theia/core/shared/inversify';
import {
  parseFootnotes,
  splitMathSegments,
  validateSemanticMarkdown
} from '@ai-focused-editor/semantic-markdown';
import type { FootnoteDocument, MathSegment } from '@ai-focused-editor/semantic-markdown';
import {
  CHROME_NOT_FOUND_MESSAGE,
  EpubGenerator,
  createSlugger,
  findChromePath,
  getKatexCss,
  processInlineMarkdown,
  renderHtmlToPdf,
  renderMathToHtml,
  renderMathToMathML,
  slugifyBase
} from '@ai-focused-editor/book-export';
import type { EpubNavPoint, TelegraphNode } from '@ai-focused-editor/book-export';
import MarkdownIt from 'markdown-it';
import { parse } from 'yaml';
// Pure, Theia-free front-matter parser reused as-is from the browser FM panel
// (TASK-015 UR-006): strips a chapter's leading `---`...`---` fence before
// HTML/EPUB rendering so raw YAML never leaks into rendered output (a bare
// `---`...`---` block followed by non-blank lines is otherwise misparsed by
// both markdown-it and the EPUB Markdown converter as a setext heading /
// thematic break, surfacing the front-matter keys as literal prose). Imported
// directly (not via the `../common` barrel, which does not re-export it) so
// this stays a read-only reuse with zero edits to `common/chapter-front-matter.ts`.
import { parseChapterFrontMatter } from '../common/chapter-front-matter';
import type {
  BookBuildChapter,
  BookBuildFormat,
  BookBuildRequest,
  BookBuildResult,
  BookBuildService,
  WorkspaceDiagnostic
} from '../common';

// slugifyBase / createSlugger now live in @ai-focused-editor/book-export so the
// Markdown, HTML, and EPUB exporters share one anchor convention. Re-exported
// here to preserve the existing import surface.
export { createSlugger, slugifyBase };

interface ManifestContentEntry {
  path?: unknown;
  title?: unknown;
  include?: unknown;
  children?: unknown;
}

interface ChapterNode {
  kind: 'chapter';
  absolutePath: string;
  path: string;
  title: string;
  included: boolean;
  depth: number;
}

interface FolderNode {
  kind: 'folder';
  path: string;
  title: string;
  included: boolean;
  depth: number;
  children: BuildNode[];
}

type BuildNode = ChapterNode | FolderNode;

const MAX_HEADING_LEVEL = 6;

/**
 * Minimal GFM task-list plugin for markdown-it, reimplemented compactly from
 * `markdown-it-task-lists` (Revin Guillen, MIT). Renders `- [ ]` / `- [x]` list
 * items as disabled checkbox inputs so book.html / book.pdf show real GFM
 * checkboxes. Tables and strikethrough already come from markdown-it's default
 * preset, so this is the only GFM piece we hand-roll here.
 */
export function markdownItTaskLists(md: MarkdownIt): void {
  md.core.ruler.after('inline', 'afe-task-lists', state => {
    const tokens = state.tokens;
    for (let i = 2; i < tokens.length; i++) {
      const inline = tokens[i];
      if (inline.type !== 'inline'
        || tokens[i - 1].type !== 'paragraph_open'
        || tokens[i - 2].type !== 'list_item_open') {
        continue;
      }
      const marker = /^\[([ xX])\]\s+/.exec(inline.content);
      if (!marker) {
        continue;
      }
      const checked = marker[1] !== ' ';
      inline.content = inline.content.slice(marker[0].length);
      const firstChild = inline.children?.[0];
      if (firstChild && firstChild.type === 'text') {
        firstChild.content = firstChild.content.replace(/^\[([ xX])\]\s+/, '');
      }
      const checkbox = new state.Token('html_inline', '', 0);
      checkbox.content = `<input class="task-list-item-checkbox"${checked ? ' checked="checked"' : ''} disabled="disabled" type="checkbox"> `;
      inline.children?.unshift(checkbox);
      tokens[i - 2].attrJoin('class', 'task-list-item');
      for (let j = i - 2; j >= 0; j--) {
        if (tokens[j].type === 'bullet_list_open' || tokens[j].type === 'ordered_list_open') {
          if (!(tokens[j].attrGet('class') || '').includes('contains-task-list')) {
            tokens[j].attrJoin('class', 'contains-task-list');
          }
          break;
        }
      }
    }
    return false;
  });
}

/**
 * Numeric-aware comparison so that `chapter-2` sorts before `chapter-10`.
 */
export function naturalCompare(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'variant' });
}

interface BookMetadata {
  title: string;
  author?: string;
  language?: string;
  /** Workspace-relative path to a cover image (png/jpg), from `cover:` in metadata.yaml. */
  cover?: string;
}

const SUPPORTED_COVER_EXTENSIONS = ['.png', '.jpg', '.jpeg'];

interface YamlReadResult {
  exists: boolean;
  value?: unknown;
}

const DEFAULT_MARKDOWN_OUTPUT_PATH = 'build/book.md';
const DEFAULT_HTML_OUTPUT_PATH = 'build/book.html';
const DEFAULT_EPUB_OUTPUT_PATH = 'build/book.epub';
const DEFAULT_PDF_OUTPUT_PATH = 'build/book.pdf';

@injectable()
export class NodeBookBuildService implements BookBuildService {
  // Default preset already enables GFM tables + strikethrough; the task-list
  // plugin adds GFM checkbox lists so book.html / book.pdf render all three.
  protected readonly markdownRenderer = new MarkdownIt({
    html: false,
    linkify: true,
    typographer: true
  }).use(markdownItTaskLists);

  // Private-use sentinels bracketing a math-segment index. Math is detected on the
  // raw Markdown (via the shared `splitMathSegments`), swapped for a sentinel that
  // survives the Markdown/AST pass untouched, then restored to KaTeX markup -- the
  // same technique footnote references use (U+E000/U+E001), on disjoint code points
  // (U+E002/U+E003) so the two never collide.
  protected readonly MATH_SENTINEL_OPEN = '\uE002';
  protected readonly MATH_SENTINEL_CLOSE = '\uE003';
  protected readonly MATH_SENTINEL_RE = /\uE002(\d+)\uE003/g;

  async buildMarkdown(request: BookBuildRequest = {}): Promise<BookBuildResult> {
    return this.build(request, 'markdown');
  }

  async buildHtml(request: BookBuildRequest = {}): Promise<BookBuildResult> {
    return this.build(request, 'html');
  }

  async buildEpub(request: BookBuildRequest = {}): Promise<BookBuildResult> {
    return this.build(request, 'epub');
  }

  async buildPdf(request: BookBuildRequest = {}): Promise<BookBuildResult> {
    return this.build(request, 'pdf');
  }

  protected async build(request: BookBuildRequest, format: BookBuildFormat): Promise<BookBuildResult> {
    const rootPath = this.toRootPath(request.rootUri);
    const rootUri = FileUri.create(rootPath).toString();
    const generatedAt = new Date().toISOString();
    const diagnostics: WorkspaceDiagnostic[] = [];
    const outputPath = this.resolveOutputPath(rootPath, request.outputPath, format);
    const metadata = await this.readMetadata(rootPath, diagnostics);
    const tree = await this.readChapterNodes(rootPath, diagnostics);
    const renderTree = this.buildRenderTree(tree);
    const includedChapters = this.collectChapters(renderTree);

    if (includedChapters.length === 0) {
      diagnostics.push({
        severity: 'error',
        source: 'book-build',
        uri: rootUri,
        message: 'No included Markdown chapters were found for book export.'
      });
    }

    if (this.hasErrors(diagnostics)) {
      return this.createFailedResult(rootUri, outputPath, format, metadata.title, diagnostics, generatedAt);
    }

    const chapters: BookBuildChapter[] = [];
    const texts = new Map<string, string>();
    for (const chapter of includedChapters) {
      const text = await this.readText(chapter.absolutePath, diagnostics);
      if (text !== undefined) {
        texts.set(chapter.path, text);
        this.collectSemanticDiagnostics(chapter, text, diagnostics);
        chapters.push({
          path: chapter.path,
          title: chapter.title,
          uri: FileUri.create(chapter.absolutePath).toString(),
          included: chapter.included,
          bytes: Buffer.byteLength(text)
        });
      }
    }

    if (this.hasErrors(diagnostics)) {
      return this.createFailedResult(rootUri, outputPath, format, metadata.title, diagnostics, generatedAt);
    }

    if (format === 'epub') {
      return this.writeEpub(rootPath, rootUri, outputPath, metadata, generatedAt, renderTree, texts, chapters, diagnostics);
    }

    const slugs = new Map<BuildNode, string>();
    this.assignSlugs(renderTree, createSlugger(), slugs);

    if (format === 'pdf') {
      return this.writePdf(rootUri, outputPath, metadata, generatedAt, renderTree, slugs, texts, chapters, diagnostics);
    }

    const content = format === 'html'
      ? this.renderHtml(metadata, generatedAt, renderTree, slugs, texts)
      : this.renderMarkdown(metadata, generatedAt, renderTree, slugs, texts);

    await fs.mkdir(dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, content, 'utf8');

    return {
      rootUri,
      outputUri: FileUri.create(outputPath).toString(),
      outputPath,
      format,
      title: metadata.title,
      chapters,
      diagnostics,
      generatedAt,
      contentLength: content.length
    };
  }

  /**
   * Drive the extracted EpubGenerator to write `build/book.epub`.
   *
   * Reuses the same manifest-walked BuildNode tree (nested parts!) as Markdown/HTML:
   * folders become nested NCX navPoints, `.md` files become chapter xhtml. Chapter
   * text is stripped of semantic `[[kind:id|label]]` tags before conversion, and
   * heading anchors use the shared `slugifyBase` convention.
   */
  protected async writeEpub(
    rootPath: string,
    rootUri: string,
    outputPath: string,
    metadata: BookMetadata,
    generatedAt: string,
    renderTree: BuildNode[],
    texts: Map<string, string>,
    chapters: BookBuildChapter[],
    diagnostics: WorkspaceDiagnostic[]
  ): Promise<BookBuildResult> {
    const coverPath = await this.resolveCoverPath(rootPath, metadata.cover, diagnostics);

    const generator = new EpubGenerator({
      outputPath,
      title: metadata.title,
      author: metadata.author ?? '',
      language: metadata.language ?? 'en',
      cover: coverPath
    });

    // Map each included chapter's absolute source path to its EPUB html file, in
    // the same DFS order the nav tree walk adds chapters, so cross-chapter `.md`
    // links can be rewritten to `chapter-N.html` inside the generator.
    const chapterPathMap: Record<string, string> = {};
    this.collectChapters(renderTree).forEach((chapter, index) => {
      chapterPathMap[chapter.absolutePath] = `chapter-${index + 1}.html`;
    });
    generator.setChapterPathMap(chapterPathMap);

    // Footnote anchor ids are prefixed with a per-chapter slug (deduped across the
    // book) so `[^N]` references and their Notes entries stay unique inside each
    // chapter's XHTML file, mirroring the HTML export's chapter-slug prefixing.
    const footnoteSlugger = createSlugger();
    const navTree = this.buildEpubNavTree(renderTree, texts, generator, footnoteSlugger);
    generator.setNavTree(navTree);

    await fs.mkdir(dirname(outputPath), { recursive: true });
    await generator.generate();
    const stat = await fs.stat(outputPath);

    return {
      rootUri,
      outputUri: FileUri.create(outputPath).toString(),
      outputPath,
      format: 'epub',
      title: metadata.title,
      chapters,
      diagnostics,
      generatedAt,
      contentLength: stat.size
    };
  }

  /**
   * Render `build/book.pdf` by feeding the SAME canonical `book.html` output into
   * headless Chrome via the extracted `renderHtmlToPdf` wrapper. Reusing the HTML
   * export keeps one rendering path (unified anchors, nested TOC, resolved
   * semantic labels) instead of a second markdown->HTML converter.
   *
   * Graceful degradation: when no Chrome/Chromium binary can be located the build
   * fails with a single clear diagnostic rather than a puppeteer stack trace.
   */
  protected async writePdf(
    rootUri: string,
    outputPath: string,
    metadata: BookMetadata,
    generatedAt: string,
    renderTree: BuildNode[],
    slugs: Map<BuildNode, string>,
    texts: Map<string, string>,
    chapters: BookBuildChapter[],
    diagnostics: WorkspaceDiagnostic[]
  ): Promise<BookBuildResult> {
    if (!findChromePath()) {
      diagnostics.push({
        severity: 'error',
        source: 'book-build',
        uri: rootUri,
        message: CHROME_NOT_FOUND_MESSAGE
      });
      return this.createFailedResult(rootUri, outputPath, 'pdf', metadata.title, diagnostics, generatedAt);
    }

    const html = this.renderHtml(metadata, generatedAt, renderTree, slugs, texts);

    await fs.mkdir(dirname(outputPath), { recursive: true });
    try {
      await renderHtmlToPdf(html, { outputPath, format: 'a4' });
    } catch (error) {
      diagnostics.push({
        severity: 'error',
        source: 'book-build',
        uri: rootUri,
        message: `PDF export failed: ${error instanceof Error ? error.message : String(error)}`
      });
      return this.createFailedResult(rootUri, outputPath, 'pdf', metadata.title, diagnostics, generatedAt);
    }

    const stat = await fs.stat(outputPath);
    return {
      rootUri,
      outputUri: FileUri.create(outputPath).toString(),
      outputPath,
      format: 'pdf',
      title: metadata.title,
      chapters,
      diagnostics,
      generatedAt,
      contentLength: stat.size
    };
  }

  /**
   * Map the included BuildNode tree onto an EPUB nav tree, adding each chapter's
   * semantic-stripped Markdown to the generator and wiring returned chapter ids
   * back into the nav points so nested folders become nested navPoints.
   */
  protected buildEpubNavTree(
    nodes: BuildNode[],
    texts: Map<string, string>,
    generator: EpubGenerator,
    footnoteSlugger: (title: string) => string
  ): EpubNavPoint[] {
    const navPoints: EpubNavPoint[] = [];
    for (const node of nodes) {
      if (node.kind === 'folder') {
        navPoints.push({
          title: node.title,
          children: this.buildEpubNavTree(node.children, texts, generator, footnoteSlugger)
        });
      } else {
        const rawText = texts.get(node.path) ?? '';
        const chapterBody = parseChapterFrontMatter(rawText).body;
        const anchorPrefix = footnoteSlugger(node.title);
        const prepared = this.prepareEpubChapterContent(this.renderSemanticLabels(chapterBody), anchorPrefix);
        const chapterId = generator.addChapterFromContent({
          title: node.title,
          content: prepared.content,
          transformNodes: prepared.transformNodes,
          // Absolute source path lets the generator resolve this chapter's local
          // `.md` links against its real on-disk location before rewriting them.
          sourcePath: node.absolutePath
        });
        navPoints.push({ title: node.title, chapterId, children: [] });
      }
    }
    return navPoints;
  }

  /**
   * Pre-process one chapter's Markdown for EPUB footnote + math rendering.
   *
   * The EPUB path converts Markdown into a TelegraphNode AST that only serializes
   * known tags, so `[^N]` references / `[^N]:` definitions and `$...$` / `$$...$$`
   * formulas would otherwise pass through as literal text. Both are handled with the
   * same sentinel technique: math is detected first (via extractMath, which never
   * touches code blocks) and swapped for a private-use sentinel; footnote definition
   * lines are stripped and each reference swapped for its own sentinel. The returned
   * transformNodes post-pass restores math sentinels to KaTeX MathML raw nodes (a
   * display formula's paragraph is unwrapped to a centered block) and footnote
   * sentinels to inline <sup> anchors, then appends the "Notes" list. Chapters with
   * neither are returned unchanged so their conversion path is untouched.
   */
  protected prepareEpubChapterContent(
    markdown: string,
    anchorPrefix: string
  ): { content: string; transformNodes?: (nodes: TelegraphNode[]) => TelegraphNode[] } {
    const footnotes = parseFootnotes(markdown);
    const hasFootnotes = footnotes.definitions.length > 0 || footnotes.references.length > 0;

    let body = markdown;
    if (hasFootnotes) {
      const definitionLines = new Set(footnotes.definitions.map(definition => definition.line));
      body = markdown
        .split('\n')
        .filter((_, index) => !definitionLines.has(index))
        .join('\n');
    }

    const { text: mathText, segments: mathSegments } = this.extractMath(body);

    if (!hasFootnotes && mathSegments.length === 0) {
      return { content: markdown };
    }

    let content = mathText;
    if (hasFootnotes) {
      content = content.replace(/\[\^([^\]\s]+)\]/g, (raw, id: string) => {
        const number = footnotes.numbers.get(id);
        return number ? `${number}` : raw;
      });
    }

    const transformNodes = (nodes: TelegraphNode[]): TelegraphNode[] => {
      let out = nodes;
      if (mathSegments.length > 0) {
        out = out.map(node => this.replaceMathSentinelsInNode(node, mathSegments));
      }
      if (hasFootnotes) {
        out = out.map(node => this.replaceFootnoteSentinelsInNode(node, anchorPrefix));
        const notes = this.buildEpubFootnoteNotes(footnotes, anchorPrefix);
        if (notes) {
          out = [...out, notes];
        }
      }
      return out;
    };

    return { content, transformNodes };
  }

  /**
   * Recursively restore math sentinels in a node's text children to KaTeX MathML
   * raw nodes. A paragraph whose only content is a single display formula is
   * replaced by that centered block <div> directly, avoiding an invalid
   * <p><div>...</div></p> nesting in the EPUB XHTML.
   */
  protected replaceMathSentinelsInNode(node: TelegraphNode, segments: MathSegment[]): TelegraphNode {
    if (node.raw !== undefined || !node.children || node.children.length === 0) {
      return node;
    }
    const children: (string | TelegraphNode)[] = [];
    for (const child of node.children) {
      if (typeof child === 'string') {
        children.push(...this.splitMathSentinels(child, segments));
      } else {
        children.push(this.replaceMathSentinelsInNode(child, segments));
      }
    }
    if (node.tag === 'p') {
      const meaningful = children.filter(child => !(typeof child === 'string' && child.trim() === ''));
      const only = meaningful[0];
      if (meaningful.length === 1 && typeof only === 'object'
        && (only.raw ?? '').startsWith('<div class="afe-math-block"')) {
        return { raw: only.raw };
      }
    }
    return { ...node, children };
  }

  /** Split a text run on math sentinels, emitting KaTeX MathML raw nodes (inline/block). */
  protected splitMathSentinels(text: string, segments: MathSegment[]): (string | TelegraphNode)[] {
    if (!text.includes(this.MATH_SENTINEL_OPEN)) {
      return [text];
    }
    const parts: (string | TelegraphNode)[] = [];
    const pattern = new RegExp(this.MATH_SENTINEL_RE.source, 'g');
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      if (match.index > lastIndex) {
        parts.push(text.slice(lastIndex, match.index));
      }
      const segment = segments[Number(match[1])];
      if (segment) {
        parts.push({ raw: renderMathToMathML(segment.value, segment.type === 'block') });
      }
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) {
      parts.push(text.slice(lastIndex));
    }
    return parts;
  }

  /** Recursively swap footnote-reference sentinels in a node's text children for `<sup>` nodes. */
  protected replaceFootnoteSentinelsInNode(node: TelegraphNode, anchorPrefix: string): TelegraphNode {
    if (!node.children || node.children.length === 0) {
      return node;
    }
    const children: (string | TelegraphNode)[] = [];
    for (const child of node.children) {
      if (typeof child === 'string') {
        children.push(...this.splitFootnoteSentinels(child, anchorPrefix));
      } else {
        children.push(this.replaceFootnoteSentinelsInNode(child, anchorPrefix));
      }
    }
    return { ...node, children };
  }

  /** Split a text run on `N` sentinels, emitting inline footnote `<sup>` nodes. */
  protected splitFootnoteSentinels(text: string, anchorPrefix: string): (string | TelegraphNode)[] {
    if (!text.includes('')) {
      return [text];
    }
    const parts: (string | TelegraphNode)[] = [];
    const pattern = /(\d+)/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      if (match.index > lastIndex) {
        parts.push(text.slice(lastIndex, match.index));
      }
      const number = Number(match[1]);
      parts.push({
        tag: 'sup',
        attrs: { class: 'afe-footnote-ref', id: `${anchorPrefix}-fnref-${number}` },
        children: [{ tag: 'a', attrs: { href: `#${anchorPrefix}-fn-${number}` }, children: [`[${number}]`] }]
      });
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) {
      parts.push(text.slice(lastIndex));
    }
    return parts;
  }

  /**
   * Build the end-of-chapter "Notes" section (`<section class="afe-footnotes">` →
   * `<ol>` of `<li>` items with back-links) as TelegraphNodes. Definition bodies are
   * rendered with the shared inline Markdown grammar. Returns undefined when there
   * are no definitions to list.
   */
  protected buildEpubFootnoteNotes(footnotes: FootnoteDocument, anchorPrefix: string): TelegraphNode | undefined {
    const referencedIds = new Set(footnotes.references.map(reference => reference.id));
    const seen = new Set<string>();
    const items: TelegraphNode[] = [];
    for (const definition of footnotes.definitions) {
      if (seen.has(definition.id)) {
        continue;
      }
      seen.add(definition.id);
      const number = footnotes.numbers.get(definition.id) ?? seen.size;
      const children: (string | TelegraphNode)[] = [...processInlineMarkdown(definition.text)];
      if (referencedIds.has(definition.id)) {
        children.push(' ', {
          tag: 'a',
          attrs: { class: 'afe-footnote-backref', href: `#${anchorPrefix}-fnref-${number}` },
          children: ['↩']
        });
      }
      items.push({ tag: 'li', attrs: { id: `${anchorPrefix}-fn-${number}` }, children });
    }
    if (items.length === 0) {
      return undefined;
    }
    return {
      tag: 'section',
      attrs: { class: 'afe-footnotes' },
      children: [
        { tag: 'h2', children: ['Notes'] },
        { tag: 'ol', children: items }
      ]
    };
  }

  /**
   * Validate the optional `cover:` metadata path for EPUB export. Returns the
   * absolute image path when it exists and is a supported type (png/jpg); otherwise
   * pushes a non-blocking warning and returns undefined so the build continues
   * without a cover.
   */
  protected async resolveCoverPath(
    rootPath: string,
    cover: string | undefined,
    diagnostics: WorkspaceDiagnostic[]
  ): Promise<string | undefined> {
    if (!cover) {
      return undefined;
    }

    const absoluteCover = resolve(rootPath, cover);
    const coverUri = FileUri.create(absoluteCover).toString();

    if (!this.isInside(rootPath, absoluteCover)) {
      diagnostics.push({
        severity: 'warning',
        source: 'book-build',
        uri: coverUri,
        message: `Cover image path escapes the workspace root; building without a cover: ${cover}`
      });
      return undefined;
    }

    const stat = await this.statIfExists(absoluteCover);
    if (!stat?.isFile()) {
      diagnostics.push({
        severity: 'warning',
        source: 'book-build',
        uri: coverUri,
        message: `Cover image not found; building without a cover: ${cover}`
      });
      return undefined;
    }

    const ext = extname(absoluteCover).toLowerCase();
    if (!SUPPORTED_COVER_EXTENSIONS.includes(ext)) {
      diagnostics.push({
        severity: 'warning',
        source: 'book-build',
        uri: coverUri,
        message: `Unsupported cover image type "${ext}" (expected .png or .jpg); building without a cover: ${cover}`
      });
      return undefined;
    }

    return absoluteCover;
  }

  protected renderMarkdown(
    metadata: BookMetadata,
    generatedAt: string,
    renderTree: BuildNode[],
    slugs: Map<BuildNode, string>,
    texts: Map<string, string>
  ): string {
    const parts: string[] = [
      this.renderFrontMatter(metadata, generatedAt),
      `# ${metadata.title}`,
      '',
      '## Table of Contents',
      '',
      ...this.renderMarkdownToc(renderTree, slugs, 0),
      '',
      ...this.renderMarkdownBody(renderTree, slugs, texts)
    ];

    return `${parts.join('\n').replace(/\n{4,}/g, '\n\n\n').trimEnd()}\n`;
  }

  protected renderMarkdownToc(nodes: BuildNode[], slugs: Map<BuildNode, string>, depth: number): string[] {
    const indent = '  '.repeat(depth);
    const lines: string[] = [];
    for (const node of nodes) {
      lines.push(`${indent}- [${node.title}](#${slugs.get(node) ?? ''})`);
      if (node.kind === 'folder') {
        lines.push(...this.renderMarkdownToc(node.children, slugs, depth + 1));
      }
    }
    return lines;
  }

  protected renderMarkdownBody(nodes: BuildNode[], slugs: Map<BuildNode, string>, texts: Map<string, string>): string[] {
    const parts: string[] = [];
    for (const node of nodes) {
      const slug = slugs.get(node) ?? '';
      const heading = '#'.repeat(Math.min(node.depth + 2, MAX_HEADING_LEVEL));
      if (node.kind === 'folder') {
        parts.push(`<a id="${slug}"></a>`, '', `${heading} ${node.title}`, '');
        parts.push(...this.renderMarkdownBody(node.children, slugs, texts));
      } else {
        const text = texts.get(node.path) ?? '';
        parts.push(`<!-- Source: ${node.path} -->`, `<a id="${slug}"></a>`, '');
        if (!this.startsWithHeading(text)) {
          parts.push(`${heading} ${node.title}`, '');
        }
        parts.push(text.trimEnd(), '');
      }
    }
    return parts;
  }

  protected renderHtml(
    metadata: BookMetadata,
    generatedAt: string,
    renderTree: BuildNode[],
    slugs: Map<BuildNode, string>,
    texts: Map<string, string>
  ): string {
    // Only pay the (font-embedded) KaTeX stylesheet cost when the book actually
    // contains a formula. Headless Chrome renders the PDF from this same HTML string
    // with no external asset host, so the fonts must be embedded (see getKatexCss).
    const katexStyle = this.bookHasMath(texts) ? `<style>${getKatexCss()}</style>` : '';
    const bodyParts: string[] = [
      '<!doctype html>',
      `<html lang="${this.escapeHtml(metadata.language || 'en')}">`,
      '<head>',
      '<meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      `<title>${this.escapeHtml(metadata.title)}</title>`,
      '<style>',
      'body{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.65;margin:0;background:#f8f8f5;color:#202124;}',
      'main{max-width:820px;margin:0 auto;padding:48px 24px 72px;background:#fff;min-height:100vh;}',
      'h1,h2,h3{line-height:1.25;}',
      'nav{border:1px solid #ddd;padding:16px 20px;margin:32px 0;background:#fbfbfa;}',
      'nav ul{margin:0;}',
      'section{margin-top:40px;}',
      '.metadata{color:#5f6368;font-size:0.92rem;}',
      '.source{color:#70757a;font-size:0.85rem;margin-bottom:12px;}',
      'code{background:#f1f3f4;padding:0.1em 0.3em;border-radius:3px;}',
      'table{border-collapse:collapse;margin:16px 0;}',
      'th,td{border:1px solid #d0d0d0;padding:6px 12px;text-align:left;}',
      'th{background:#f1f3f4;}',
      'ul.contains-task-list{list-style:none;padding-left:1.2em;}',
      'li.task-list-item{margin-left:-1.2em;}',
      'li.task-list-item .task-list-item-checkbox{margin-right:0.5em;}',
      'sup.afe-footnote-ref{font-size:0.75em;line-height:0;}',
      'sup.afe-footnote-ref a{text-decoration:none;}',
      'section.afe-footnotes{margin-top:40px;border-top:1px solid #ddd;padding-top:12px;font-size:0.92rem;}',
      'section.afe-footnotes h2{font-size:1.1rem;}',
      'a.afe-footnote-backref{text-decoration:none;margin-left:4px;}',
      '.katex-display{overflow-x:auto;overflow-y:hidden;}',
      '</style>',
      katexStyle,
      '</head>',
      '<body>',
      '<main>',
      `<h1>${this.escapeHtml(metadata.title)}</h1>`,
      `<p class="metadata">Generated ${this.escapeHtml(generatedAt)}${metadata.author ? ` · ${this.escapeHtml(metadata.author)}` : ''}</p>`,
      '<nav>',
      '<h2>Table of Contents</h2>',
      this.renderHtmlToc(renderTree, slugs),
      '</nav>',
      ...this.renderHtmlBody(renderTree, slugs, texts),
      '</main>',
      '</body>',
      '</html>'
    ];

    return `${bodyParts.join('\n')}\n`;
  }

  protected renderHtmlToc(nodes: BuildNode[], slugs: Map<BuildNode, string>): string {
    const items = nodes.map(node => {
      const link = `<a href="#${this.escapeHtml(slugs.get(node) ?? '')}">${this.escapeHtml(node.title)}</a>`;
      const nested = node.kind === 'folder' ? this.renderHtmlToc(node.children, slugs) : '';
      return `<li>${link}${nested}</li>`;
    });
    return `<ul>\n${items.join('\n')}\n</ul>`;
  }

  protected renderHtmlBody(nodes: BuildNode[], slugs: Map<BuildNode, string>, texts: Map<string, string>): string[] {
    const parts: string[] = [];
    for (const node of nodes) {
      const slug = this.escapeHtml(slugs.get(node) ?? '');
      const level = Math.min(node.depth + 2, MAX_HEADING_LEVEL);
      if (node.kind === 'folder') {
        parts.push(
          `<section id="${slug}">`,
          `<h${level}>${this.escapeHtml(node.title)}</h${level}>`,
          ...this.renderHtmlBody(node.children, slugs, texts),
          '</section>'
        );
      } else {
        const text = texts.get(node.path) ?? '';
        const body = parseChapterFrontMatter(text).body;
        const markdown = this.startsWithHeading(body)
          ? body.trimEnd()
          : `${'#'.repeat(level)} ${node.title}\n\n${body.trimEnd()}`;
        parts.push(
          `<section id="${slug}">`,
          `<p class="source">Source: ${this.escapeHtml(node.path)}</p>`,
          this.renderChapterHtml(this.renderSemanticLabels(markdown), slugs.get(node) ?? ''),
          '</section>'
        );
      }
    }
    return parts;
  }

  protected assignSlugs(nodes: BuildNode[], slugger: (title: string) => string, slugs: Map<BuildNode, string>): void {
    for (const node of nodes) {
      slugs.set(node, slugger(node.title));
      if (node.kind === 'folder') {
        this.assignSlugs(node.children, slugger, slugs);
      }
    }
  }

  protected buildRenderTree(nodes: BuildNode[]): BuildNode[] {
    const result: BuildNode[] = [];
    for (const node of nodes) {
      if (!node.included) {
        continue;
      }
      if (node.kind === 'folder') {
        const children = this.buildRenderTree(node.children);
        if (children.length > 0) {
          result.push({ ...node, children });
        }
      } else {
        result.push(node);
      }
    }
    return result;
  }

  protected collectChapters(nodes: BuildNode[]): ChapterNode[] {
    const chapters: ChapterNode[] = [];
    for (const node of nodes) {
      if (node.kind === 'folder') {
        chapters.push(...this.collectChapters(node.children));
      } else {
        chapters.push(node);
      }
    }
    return chapters;
  }

  protected collectSemanticDiagnostics(chapter: ChapterNode, text: string, diagnostics: WorkspaceDiagnostic[]): void {
    const uri = FileUri.create(chapter.absolutePath).toString();
    for (const diagnostic of validateSemanticMarkdown(text)) {
      diagnostics.push({
        severity: 'warning',
        source: 'semantic-markdown',
        uri,
        message: diagnostic.message,
        range: diagnostic.range
      });
    }
  }

  protected async readMetadata(rootPath: string, diagnostics: WorkspaceDiagnostic[]): Promise<BookMetadata> {
    const metadataPath = join(rootPath, 'metadata.yaml');
    const metadata = (await this.readYaml(metadataPath, diagnostics, false)).value;
    if (!this.isRecord(metadata)) {
      return {
        title: basename(rootPath)
      };
    }

    return {
      title: this.asNonEmptyString(metadata.title) ?? basename(rootPath),
      author: this.asNonEmptyString(metadata.author),
      language: this.asNonEmptyString(metadata.language),
      cover: this.asNonEmptyString(metadata.cover)
    };
  }

  protected async readChapterNodes(rootPath: string, diagnostics: WorkspaceDiagnostic[]): Promise<BuildNode[]> {
    const manifestPath = join(rootPath, 'manifest.yaml');
    const manifestRead = await this.readYaml(manifestPath, diagnostics, false);
    if (!manifestRead.exists) {
      diagnostics.push({
        severity: 'warning',
        source: 'book-build',
        uri: FileUri.create(manifestPath).toString(),
        message: 'Missing manifest.yaml; falling back to sorted content/**/*.md export.'
      });
      return this.scanContentNodes(rootPath, join(rootPath, 'content'), true, 0, diagnostics);
    }

    const manifest = manifestRead.value;
    if (manifest === undefined) {
      return [];
    }

    if (!this.isRecord(manifest) || !Array.isArray(manifest.content)) {
      diagnostics.push({
        severity: 'error',
        source: 'book-build',
        uri: FileUri.create(manifestPath).toString(),
        message: 'manifest.yaml must contain a content list before book export can run.'
      });
      return [];
    }

    const nodes: BuildNode[] = [];
    for (const [index, entry] of manifest.content.entries()) {
      nodes.push(...await this.manifestEntryToNodes(rootPath, manifestPath, entry, true, 0, index, diagnostics));
    }
    return nodes;
  }

  protected async manifestEntryToNodes(
    rootPath: string,
    manifestPath: string,
    entry: unknown,
    inheritedInclude: boolean,
    depth: number,
    index: number,
    diagnostics: WorkspaceDiagnostic[]
  ): Promise<BuildNode[]> {
    if (!this.isRecord(entry)) {
      diagnostics.push({
        severity: 'warning',
        source: 'book-build',
        uri: FileUri.create(manifestPath).toString(),
        message: `Ignoring manifest content entry ${index + 1}: expected object.`
      });
      return [];
    }

    const manifestEntry = entry as ManifestContentEntry;
    const rawPath = this.asNonEmptyString(manifestEntry.path);
    if (!rawPath) {
      diagnostics.push({
        severity: 'warning',
        source: 'book-build',
        uri: FileUri.create(manifestPath).toString(),
        message: `Ignoring manifest content entry ${index + 1}: missing path.`
      });
      return [];
    }

    const absolutePath = resolve(rootPath, rawPath);
    if (!this.isInside(rootPath, absolutePath)) {
      diagnostics.push({
        severity: 'error',
        source: 'book-build',
        uri: FileUri.create(manifestPath).toString(),
        message: `Manifest path escapes the workspace root: ${rawPath}`
      });
      return [];
    }

    const included = inheritedInclude && manifestEntry.include !== false;
    const stat = await this.statIfExists(absolutePath);
    if (!stat) {
      diagnostics.push({
        severity: 'error',
        source: 'book-build',
        uri: FileUri.create(absolutePath).toString(),
        message: `Manifest path does not exist: ${rawPath}`
      });
      return [];
    }

    if (stat.isDirectory()) {
      const title = this.asNonEmptyString(manifestEntry.title) ?? this.titleFromPath(rawPath);
      let children: BuildNode[];
      if (Array.isArray(manifestEntry.children)) {
        children = [];
        for (const [childIndex, child] of manifestEntry.children.entries()) {
          children.push(...await this.manifestEntryToNodes(rootPath, manifestPath, child, included, depth + 1, childIndex, diagnostics));
        }
      } else {
        children = await this.scanContentNodes(rootPath, absolutePath, included, depth + 1, diagnostics);
      }
      return [{
        kind: 'folder',
        path: this.toWorkspacePath(rootPath, absolutePath),
        title,
        included,
        depth,
        children
      }];
    }

    if (!stat.isFile() || !rawPath.endsWith('.md')) {
      diagnostics.push({
        severity: 'warning',
        source: 'book-build',
        uri: FileUri.create(absolutePath).toString(),
        message: `Skipping non-Markdown manifest entry: ${rawPath}`
      });
      return [];
    }

    return [{
      kind: 'chapter',
      absolutePath,
      path: this.toWorkspacePath(rootPath, absolutePath),
      title: this.asNonEmptyString(manifestEntry.title) ?? this.titleFromPath(rawPath),
      included,
      depth
    }];
  }

  protected async scanContentNodes(
    rootPath: string,
    directoryPath: string,
    included: boolean,
    depth: number,
    diagnostics: WorkspaceDiagnostic[]
  ): Promise<BuildNode[]> {
    const stat = await this.statIfExists(directoryPath);
    if (!stat?.isDirectory()) {
      diagnostics.push({
        severity: 'error',
        source: 'book-build',
        uri: FileUri.create(directoryPath).toString(),
        message: 'Missing content directory for book export.'
      });
      return [];
    }

    const entries = await fs.readdir(directoryPath, { withFileTypes: true });
    const nodes: BuildNode[] = [];
    for (const entry of entries.sort((left, right) => naturalCompare(left.name, right.name))) {
      const childPath = join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        const children = await this.scanContentNodes(rootPath, childPath, included, depth + 1, diagnostics);
        nodes.push({
          kind: 'folder',
          path: this.toWorkspacePath(rootPath, childPath),
          title: this.titleFromPath(entry.name),
          included,
          depth,
          children
        });
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        nodes.push({
          kind: 'chapter',
          absolutePath: childPath,
          path: this.toWorkspacePath(rootPath, childPath),
          title: this.titleFromPath(entry.name),
          included,
          depth
        });
      }
    }
    return nodes;
  }

  protected renderFrontMatter(metadata: BookMetadata, generatedAt: string): string {
    const lines = [
      '---',
      `title: ${JSON.stringify(metadata.title)}`
    ];
    if (metadata.author) {
      lines.push(`author: ${JSON.stringify(metadata.author)}`);
    }
    if (metadata.language) {
      lines.push(`language: ${JSON.stringify(metadata.language)}`);
    }
    lines.push(`generated: ${JSON.stringify(generatedAt)}`);
    lines.push('---');
    return lines.join('\n');
  }

  protected async readYaml(path: string, diagnostics: WorkspaceDiagnostic[], required: boolean): Promise<YamlReadResult> {
    let text: string;
    try {
      text = await fs.readFile(path, 'utf8');
    } catch {
      if (required) {
        diagnostics.push({
          severity: 'error',
          source: 'book-build',
          uri: FileUri.create(path).toString(),
          message: `Missing YAML file: ${this.toDisplayPath(path)}`
        });
      }
      return { exists: false };
    }

    try {
      return {
        exists: true,
        value: parse(text)
      };
    } catch (error) {
      diagnostics.push({
        severity: 'error',
        source: 'book-build',
        uri: FileUri.create(path).toString(),
        message: `Invalid YAML: ${error instanceof Error ? error.message : String(error)}`
      });
      return { exists: true };
    }
  }

  protected async readText(path: string, diagnostics: WorkspaceDiagnostic[]): Promise<string | undefined> {
    try {
      return await fs.readFile(path, 'utf8');
    } catch (error) {
      diagnostics.push({
        severity: 'error',
        source: 'book-build',
        uri: FileUri.create(path).toString(),
        message: `Failed to read chapter: ${error instanceof Error ? error.message : String(error)}`
      });
      return undefined;
    }
  }

  protected async statIfExists(path: string): Promise<import('fs').Stats | undefined> {
    try {
      return await fs.stat(path);
    } catch {
      return undefined;
    }
  }

  protected toRootPath(rootUri: string | undefined): string {
    if (!rootUri) {
      return process.cwd();
    }
    if (rootUri.startsWith('file:')) {
      return FileUri.fsPath(rootUri);
    }
    return isAbsolute(rootUri) ? rootUri : resolve(process.cwd(), rootUri);
  }

  protected resolveOutputPath(rootPath: string, outputPath: string | undefined, format: BookBuildFormat): string {
    const defaultOutputPath = format === 'epub'
      ? DEFAULT_EPUB_OUTPUT_PATH
      : format === 'pdf'
        ? DEFAULT_PDF_OUTPUT_PATH
        : format === 'html'
          ? DEFAULT_HTML_OUTPUT_PATH
          : DEFAULT_MARKDOWN_OUTPUT_PATH;
    const requested = outputPath?.trim() || defaultOutputPath;
    const absolutePath = isAbsolute(requested) ? requested : resolve(rootPath, requested);
    if (!this.isInside(rootPath, absolutePath)) {
      return resolve(rootPath, defaultOutputPath);
    }
    return absolutePath;
  }

  protected isInside(rootPath: string, path: string): boolean {
    const relativePath = relative(rootPath, path);
    return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
  }

  protected toWorkspacePath(rootPath: string, path: string): string {
    return relative(rootPath, path).split(sep).join('/');
  }

  protected titleFromPath(path: string): string {
    return basename(path, '.md')
      .replace(/[-_]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\b\w/g, character => character.toUpperCase());
  }

  protected startsWithHeading(text: string): boolean {
    return /^#{1,6}\s+\S/m.test(text.trimStart().split(/\r?\n/, 1)[0] ?? '');
  }

  protected hasErrors(diagnostics: WorkspaceDiagnostic[]): boolean {
    return diagnostics.some(diagnostic => diagnostic.severity === 'error');
  }

  protected createFailedResult(
    rootUri: string,
    outputPath: string,
    format: BookBuildFormat,
    title: string,
    diagnostics: WorkspaceDiagnostic[],
    generatedAt: string
  ): BookBuildResult {
    return {
      rootUri,
      outputUri: FileUri.create(outputPath).toString(),
      outputPath,
      format,
      title,
      chapters: [],
      diagnostics,
      generatedAt,
      contentLength: 0
    };
  }

  protected asNonEmptyString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
  }

  protected isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  /**
   * Strip labeled semantic entity tags `[[kind:id|label]]` down to `label` before
   * HTML/EPUB rendering. `kind`'s first-character class is `\p{L}` (any script,
   * upper or lower) rather than the canonical validator's Unicode-lowercase-only
   * `\p{Ll}` (TASK-015 UR-006 fix): this is a strict WIDENING of the pre-TASK-013
   * ASCII `[a-zA-Z]` this regex already accepted (case-insensitive `i` flag), so it
   * cannot regress any previously-stripped tag, while now also covering TASK-013's
   * Cyrillic/other-script `kind` grammar (e.g. `[[персонаж:ivan|Иван]]`) that this
   * export-local stripper had not been updated to recognize — such a tag used to
   * pass through as raw `[[...]]` text in book.html/book.epub.
   */
  protected renderSemanticLabels(markdown: string): string {
    return markdown.replace(/\[\[\p{L}[\p{L}\p{N}_-]*:[^\]|\s]+?\|([^\]]+?)\]\]/gu, '$1');
  }

  /** True when any chapter's Markdown carries an inline/block formula. */
  protected bookHasMath(texts: Map<string, string>): boolean {
    for (const text of texts.values()) {
      if (splitMathSegments(text).some(segment => segment.type !== 'text')) {
        return true;
      }
    }
    return false;
  }

  /**
   * Detect math on the raw Markdown with the shared {@link splitMathSegments} and
   * swap each formula for a `MATH_SENTINEL`-bracketed index, returning the rewritten
   * text plus the ordered segments. `$` inside fenced/inline code is left intact by
   * the detector, so code blocks are never corrupted. Returns the input untouched
   * when the chapter has no math.
   */
  protected extractMath(markdown: string): { text: string; segments: MathSegment[] } {
    const parts = splitMathSegments(markdown);
    if (!parts.some(part => part.type !== 'text')) {
      return { text: markdown, segments: [] };
    }
    const segments: MathSegment[] = [];
    let text = '';
    for (const part of parts) {
      if (part.type === 'text') {
        text += part.value;
      } else {
        text += `${this.MATH_SENTINEL_OPEN}${segments.length}${this.MATH_SENTINEL_CLOSE}`;
        segments.push(part);
      }
    }
    return { text, segments };
  }

  /** Restore math sentinels in already-rendered HTML to KaTeX HTML (inline/display). */
  protected restoreMathHtml(rendered: string, segments: MathSegment[]): string {
    if (segments.length === 0) {
      return rendered;
    }
    return rendered.replace(this.MATH_SENTINEL_RE, (whole, index: string) => {
      const segment = segments[Number(index)];
      return segment ? renderMathToHtml(segment.value, segment.type === 'block') : whole;
    });
  }

  /**
   * Render one chapter's Markdown to HTML with footnote + math support.
   *
   * `markdown-it` runs with `html:false`, so neither `<sup>` footnote markers nor
   * KaTeX markup can come from the Markdown source directly. Both use the same
   * sentinel technique: math is detected first (via {@link extractMath}, which never
   * touches code blocks) and each `[^id]` reference is swapped for a private-use
   * sentinel; the body is rendered once, then the sentinels are restored to a real
   * superscript link / KaTeX HTML. Footnote definition lines are pulled out of the
   * body and re-emitted as an end-of-chapter "Notes" list. Anchors are prefixed with
   * the chapter slug so ids stay unique across the book.
   */
  protected renderChapterHtml(markdown: string, anchorPrefix: string): string {
    const footnotes = parseFootnotes(markdown);
    const hasFootnotes = footnotes.definitions.length > 0 || footnotes.references.length > 0;

    let body = markdown;
    if (hasFootnotes) {
      const definitionLines = new Set(footnotes.definitions.map(definition => definition.line));
      body = markdown
        .split('\n')
        .filter((_, index) => !definitionLines.has(index))
        .join('\n');
    }

    const { text: mathText, segments: mathSegments } = this.extractMath(body);

    let source = mathText;
    if (hasFootnotes) {
      source = source.replace(/\[\^([^\]\s]+)\]/g, (raw, id: string) => {
        const number = footnotes.numbers.get(id);
        return number ? `\uE000${number}\uE001` : raw;
      });
    }

    let rendered = this.markdownRenderer.render(source);

    if (hasFootnotes) {
      rendered = rendered.replace(
        /\uE000(\d+)\uE001/g,
        (_match, number: string) =>
          `<sup class="afe-footnote-ref" id="${anchorPrefix}-fnref-${number}">`
          + `<a href="#${anchorPrefix}-fn-${number}">[${number}]</a></sup>`
      );
    }

    rendered = this.restoreMathHtml(rendered, mathSegments);

    if (hasFootnotes) {
      rendered += this.renderFootnotesHtml(footnotes, anchorPrefix);
    }

    return rendered;
  }

  protected renderFootnotesHtml(footnotes: FootnoteDocument, anchorPrefix: string): string {
    const referencedIds = new Set(footnotes.references.map(reference => reference.id));
    const seen = new Set<string>();
    const items: string[] = [];
    for (const definition of footnotes.definitions) {
      if (seen.has(definition.id)) {
        continue;
      }
      seen.add(definition.id);
      const number = footnotes.numbers.get(definition.id) ?? seen.size;
      const inner = this.markdownRenderer.renderInline(definition.text);
      const backref = referencedIds.has(definition.id)
        ? ` <a class="afe-footnote-backref" href="#${anchorPrefix}-fnref-${number}">↩</a>`
        : '';
      items.push(`<li id="${anchorPrefix}-fn-${number}">${inner}${backref}</li>`);
    }
    if (items.length === 0) {
      return '';
    }
    return `\n<section class="afe-footnotes">\n<h2>Notes</h2>\n<ol>\n${items.join('\n')}\n</ol>\n</section>`;
  }

  protected escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  protected toDisplayPath(path: string): string {
    return path.split(sep).join('/');
  }
}
