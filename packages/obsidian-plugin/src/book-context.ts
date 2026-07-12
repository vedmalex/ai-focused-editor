/**
 * Impure bridge between Obsidian's Vault API and the pure `core/book-model`
 * helpers. Scans the vault for AFE books (`manifest.yaml` folders), reads their
 * manifest / `entities/types.yaml` / entity cards, and holds the resolved
 * {@link LoadedBook} list the panel, autocomplete, navigation, and search read.
 * All parsing/model logic lives in `core/*` (unit-tested); this file only does
 * I/O and caching.
 */

import type { App, TFile } from 'obsidian';
import { parse } from 'yaml';
import { extractBookMeta } from '@ai-focused-editor/manuscript-workspace/src/common/book-catalog';
import type { EffectiveEntityType, EntityTypeProblem } from '@ai-focused-editor/manuscript-workspace/src/common/entity-type-registry';
import {
  buildEntityIndex,
  detectBookRoots,
  parseManifest,
  resolveEntityTypes,
  humanizeFilename,
  type ChapterNode,
  type EntityIndexEntry,
  type RawEntityFile
} from './core/book-model';
import { parseCitations, parseExcerpts, type Citation, type Excerpt } from './core/citations';
import { buildMentionIndex, type MentionIndex, type ScannedFile } from './core/entity-mentions';

export interface AfeSettings {
  /** Register the custom entity-card view for `.yaml`/`.yml` (vault-wide). */
  yamlCardView: boolean;
  /** Vault-relative folder that contains the books; empty = scan whole vault. */
  booksFolder: string;
  /** Plugin UI language: `auto` derives from the Obsidian locale. */
  lang: 'auto' | 'ru' | 'en';
}

export const DEFAULT_SETTINGS: AfeSettings = {
  yamlCardView: true,
  booksFolder: '',
  lang: 'auto'
};

export interface LoadedBook {
  /** Vault-relative book-root folder (`''` for the vault root). */
  root: string;
  /** Display title (metadata.yaml title, else the folder name). */
  title: string;
  chapters: ChapterNode[];
  types: EffectiveEntityType[];
  typeProblems: EntityTypeProblem[];
  entities: EntityIndexEntry[];
  /** Citations indexed from `sources/citations.yaml`. */
  citations: Citation[];
  /** Excerpts indexed from `sources/excerpts.jsonl`. */
  excerpts: Excerpt[];
  /** Mention index over `content/**` prose, cached per reload. */
  mentions: MentionIndex;
}

function joinRoot(root: string, relative: string): string {
  return root ? `${root}/${relative}` : relative;
}

function dirname(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

export class BookContext {
  private books: LoadedBook[] = [];

  constructor(private readonly app: App, private readonly getSettings: () => AfeSettings) {}

  getBooks(): readonly LoadedBook[] {
    return this.books;
  }

  /** Re-scan the vault and rebuild every book model. */
  async reload(): Promise<void> {
    const files = this.app.vault.getFiles();
    const manifests = files.filter(file => file.name === 'manifest.yaml');
    const roots = this.resolveRoots(manifests.map(file => file.path));

    const loaded: LoadedBook[] = [];
    for (const root of roots) {
      loaded.push(await this.loadBook(root, files));
    }
    // Longest root first so `bookForPath` prefix matching prefers the nested book.
    loaded.sort((a, b) => b.root.length - a.root.length || a.title.localeCompare(b.title));
    this.books = loaded;
  }

  private resolveRoots(manifestPaths: string[]): string[] {
    const booksFolder = this.getSettings().booksFolder.trim().replace(/^\/+|\/+$/g, '');
    if (booksFolder) {
      // Override: any manifest at or under the configured folder marks a book root.
      const roots = new Set<string>();
      for (const path of manifestPaths) {
        const dir = dirname(path);
        if (dir === booksFolder || dir.startsWith(`${booksFolder}/`)) {
          roots.add(dir);
        }
      }
      return [...roots];
    }
    // Default: vault-root or first-level subfolder books (core-detected).
    return detectBookRoots(manifestPaths);
  }

  private async loadBook(root: string, files: readonly TFile[]): Promise<LoadedBook> {
    const manifestText = await this.readRelative(root, 'manifest.yaml');
    const chapters = manifestText ? parseManifest(manifestText) : [];

    const typesText = await this.readRelative(root, 'entities/types.yaml');
    const { types, problems } = resolveEntityTypes(typesText);

    const entitiesPrefix = joinRoot(root, 'entities/');
    const rawEntities: RawEntityFile[] = [];
    for (const file of files) {
      if ((file.extension !== 'yaml' && file.extension !== 'yml') || !file.path.startsWith(entitiesPrefix)) {
        continue;
      }
      if (file.name === 'types.yaml') {
        continue;
      }
      const relative = file.path.slice(entitiesPrefix.length); // `<dir>/<file>.yaml` (or deeper)
      const directory = relative.split('/')[0];
      if (!directory || !relative.includes('/')) {
        continue; // skip files sitting directly in entities/ (no type directory)
      }
      const text = await this.read(file);
      rawEntities.push({ path: file.path, directory, text });
    }

    const metaText = await this.readRelative(root, 'metadata.yaml');
    const meta = metaText ? extractBookMeta(safeYaml(metaText)) : {};
    const title = meta.title ?? (root ? humanizeFilename(root) : 'Book');

    const citations = parseCitations(await this.readRelative(root, 'sources/citations.yaml'));
    const excerpts = parseExcerpts(await this.readRelative(root, 'sources/excerpts.jsonl'));

    // Scan `content/**/*.md` prose once per reload to build the mention index the
    // panel + cloud read; this is the only per-reload full-text pass.
    const contentPrefix = joinRoot(root, 'content/');
    const scanned: ScannedFile[] = [];
    for (const file of files) {
      if ((file.extension !== 'md' && file.extension !== 'markdown') || !file.path.startsWith(contentPrefix)) {
        continue;
      }
      scanned.push({ path: file.path, text: await this.read(file) });
    }

    return {
      root,
      title,
      chapters,
      types,
      typeProblems: problems,
      entities: buildEntityIndex(rawEntities, types),
      citations,
      excerpts,
      mentions: buildMentionIndex(scanned)
    };
  }

  private async readRelative(root: string, relative: string): Promise<string | undefined> {
    const file = this.app.vault.getAbstractFileByPath(joinRoot(root, relative));
    if (file && 'extension' in file) {
      return this.read(file as TFile);
    }
    return undefined;
  }

  private async read(file: TFile): Promise<string> {
    try {
      return await this.app.vault.cachedRead(file);
    } catch {
      return '';
    }
  }

  /** The book whose root is the longest prefix of `path`, or undefined. */
  bookForPath(path: string): LoadedBook | undefined {
    for (const book of this.books) {
      if (book.root === '' || path === book.root || path.startsWith(`${book.root}/`)) {
        return book;
      }
    }
    return undefined;
  }

  /** Effective tag kinds available for a book (built-ins + author types). */
  tagKindsFor(book: LoadedBook): string[] {
    return book.types.map(type => type.tagKind);
  }

  /** Resolve a `[[kind:id]]` reference to its card, scoped to the book for `fromPath`. */
  findEntity(fromPath: string, kind: string | undefined, id: string): EntityIndexEntry | undefined {
    const book = this.bookForPath(fromPath) ?? this.books[0];
    if (!book) {
      return undefined;
    }
    const wantKind = kind?.toLowerCase();
    const byKind = book.entities.filter(entry =>
      !wantKind || entry.tagKind.toLowerCase() === wantKind || entry.kind.toLowerCase() === wantKind
    );
    return byKind.find(entry => entry.id === id) ?? book.entities.find(entry => entry.id === id);
  }

  /** All entities across every book (for global search), de-duplicated by path. */
  allEntities(): EntityIndexEntry[] {
    const seen = new Set<string>();
    const all: EntityIndexEntry[] = [];
    for (const book of this.books) {
      for (const entry of book.entities) {
        if (!seen.has(entry.path)) {
          seen.add(entry.path);
          all.push(entry);
        }
      }
    }
    return all;
  }
}

function safeYaml(text: string): unknown {
  try {
    return parse(text);
  } catch {
    return undefined;
  }
}
