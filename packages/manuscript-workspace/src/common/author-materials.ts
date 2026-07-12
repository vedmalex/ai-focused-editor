import type { ManuscriptNode } from './manuscript-workspace-protocol';
import type { NarrativeEntity, NarrativeEntityKind } from './narrative-entity-protocol';
import type { CitationEntry, SourceLibraryItem } from './source-library-protocol';

/**
 * Pure grouping logic for the unified author-materials navigator. This module
 * has no Theia/Node/DOM imports so it can be exercised with plain `bun test`.
 * The frontend tree factory turns the descriptors returned here into concrete
 * Theia tree nodes.
 */

export type AuthorMaterialsSectionKind =
  | 'manuscript'
  | 'characters'
  | 'terms'
  | 'artifacts'
  | 'locations'
  | 'citations'
  | 'sources'
  | 'knowledge'
  | 'skills';

/** Fixed top-level order of the navigator sections. */
export const AUTHOR_MATERIALS_SECTION_ORDER: readonly AuthorMaterialsSectionKind[] = [
  'manuscript',
  'characters',
  'terms',
  'artifacts',
  'locations',
  'citations',
  'sources',
  'knowledge',
  'skills'
];

const SECTION_LABELS: Record<AuthorMaterialsSectionKind, string> = {
  manuscript: 'Manuscript',
  characters: 'Characters',
  terms: 'Terms',
  artifacts: 'Artifacts',
  locations: 'Locations',
  citations: 'Citations',
  sources: 'Sources',
  knowledge: 'Knowledge',
  skills: 'Skills'
};

const ENTITY_KIND_TO_SECTION: Record<NarrativeEntityKind, AuthorMaterialsSectionKind> = {
  character: 'characters',
  term: 'terms',
  artifact: 'artifacts',
  location: 'locations'
};

/** File extensions surfaced under the Knowledge section (spec §4.1 `knowledge/`). */
const KNOWLEDGE_EXTENSIONS = ['.yaml', '.yml', '.md'];

/**
 * File types an author works with (owner intake): documents, images, and
 * structural yaml/json. Everything else — dotfiles (.gitignore, .DS_Store),
 * build leftovers, binaries — stays out of the navigator and source listings.
 */
const ALLOWED_MATERIAL_EXTENSIONS = [
  // documents
  '.md', '.markdown', '.txt', '.pdf', '.doc', '.docx', '.odt', '.rtf', '.epub', '.html', '.htm',
  // office spreadsheets and presentations (previewable via the office-preview widget)
  '.xlsx', '.xls', '.ods', '.pptx', '.ppt',
  // images
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.tif', '.tiff', '.bmp',
  // diagrams (editable via the excalidraw-editor widget)
  '.excalidraw',
  // structural
  '.yaml', '.yml', '.json', '.jsonl'
];

export function isAllowedMaterialFile(name: string): boolean {
  if (!name || name.startsWith('.')) {
    return false;
  }
  const lower = name.toLowerCase();
  return ALLOWED_MATERIAL_EXTENSIONS.some(ext => lower.endsWith(ext));
}

/** A raw file discovered under `knowledge/**`, before extension filtering. */
export interface KnowledgeFileEntry {
  /** Base file name, e.g. `world-rules.md`. */
  name: string;
  /** Workspace-relative path, e.g. `knowledge/world-rules.md`. */
  path: string;
  /** Absolute URI used to open the file. */
  uri: string;
}

/**
 * A book-local AI skill discovered under `.prompts/skills/<slug>/SKILL.md`.
 * `label` is the frontmatter `name` (falling back to the folder slug); opening
 * the item opens its `SKILL.md`. Mirrors the Theia SkillService discovery so the
 * navigator lists exactly what the AI chat's Skills picker offers.
 */
export interface SkillEntry {
  /** Folder slug, e.g. `style-guide`; stable id within the section. */
  id: string;
  /** Frontmatter `name`, falling back to the folder slug. */
  label: string;
  /** Frontmatter `description`, if any (shown as secondary text). */
  description?: string;
  /** Workspace-relative path, e.g. `.prompts/skills/style-guide/SKILL.md`. */
  path: string;
  /** Absolute URI of the `SKILL.md`, opened on activation. */
  uri: string;
}

export interface AuthorMaterialsInput {
  rootUri?: string;
  /** Manifest content (manuscript section is rendered from the live nodes). */
  manuscript: ManuscriptNode[];
  entities: NarrativeEntity[];
  citations: CitationEntry[];
  /** URI of `sources/citations.yaml`, used to open citations without a path. */
  citationsUri?: string;
  sources: SourceLibraryItem[];
  knowledge: KnowledgeFileEntry[];
  /** Book-local AI skills scanned from `.prompts/skills/<slug>/SKILL.md`. */
  skills: SkillEntry[];
}

export interface AuthorMaterialItem {
  /** Unique id within the section; used to build a stable tree node id. */
  id: string;
  label: string;
  /** Secondary text (entity/citation id, knowledge path). */
  description?: string;
  /** URI to open on activation; items without a URI are non-openable. */
  uri?: string;
  /** Folders group nested files (sources/ and knowledge/ keep their layout). */
  itemType?: 'file' | 'folder';
  children?: AuthorMaterialItem[];
}

export interface AuthorMaterialsSection {
  kind: AuthorMaterialsSectionKind;
  /** Plain label without the count, e.g. `Characters`. */
  label: string;
  count: number;
  /** Manuscript starts expanded; every other section starts collapsed. */
  expandedByDefault: boolean;
  /** Leaf items; empty for `manuscript`, which is built from live nodes. */
  items: AuthorMaterialItem[];
}

/** True when the file name ends with a knowledge-surfaced extension. */
export function isKnowledgeFile(name: string): boolean {
  if (name.startsWith('.')) {
    return false;
  }
  const lower = name.toLowerCase();
  return KNOWLEDGE_EXTENSIONS.some(ext => lower.endsWith(ext));
}

/**
 * Build a folder tree from flat workspace-relative file paths. `stripPrefix`
 * (e.g. `sources/`) is removed before splitting into segments. Folders sort
 * first, then files, each alphabetically; empty folders never appear because
 * the tree is built purely from surviving files.
 */
export function buildMaterialFileTree(
  files: { path: string; uri?: string }[],
  stripPrefix: string
): AuthorMaterialItem[] {
  interface FolderAccumulator {
    item: AuthorMaterialItem;
    folders: Map<string, FolderAccumulator>;
  }
  const root: FolderAccumulator = {
    item: { id: '', label: '', itemType: 'folder', children: [] },
    folders: new Map()
  };

  for (const file of files) {
    const relative = file.path.startsWith(stripPrefix) ? file.path.slice(stripPrefix.length) : file.path;
    const segments = relative.split('/').filter(Boolean);
    if (segments.length === 0) {
      continue;
    }
    let cursor = root;
    let accumulated = stripPrefix.replace(/\/+$/, '');
    for (const segment of segments.slice(0, -1)) {
      accumulated = accumulated ? `${accumulated}/${segment}` : segment;
      let next = cursor.folders.get(segment);
      if (!next) {
        next = {
          item: {
            id: accumulated,
            label: segment,
            itemType: 'folder',
            children: []
          },
          folders: new Map()
        };
        cursor.folders.set(segment, next);
        cursor.item.children!.push(next.item);
      }
      cursor = next;
    }
    const name = segments[segments.length - 1];
    cursor.item.children!.push({
      id: file.path,
      label: name,
      description: file.path,
      uri: file.uri,
      itemType: 'file'
    });
  }

  const sortTree = (items: AuthorMaterialItem[]): AuthorMaterialItem[] => {
    items.sort((left, right) => {
      const leftFolder = left.itemType === 'folder' ? 0 : 1;
      const rightFolder = right.itemType === 'folder' ? 0 : 1;
      if (leftFolder !== rightFolder) {
        return leftFolder - rightFolder;
      }
      return left.label.localeCompare(right.label) || left.id.localeCompare(right.id);
    });
    for (const item of items) {
      if (item.children) {
        sortTree(item.children);
      }
    }
    return items;
  };
  return sortTree(root.item.children!);
}

/** Count file leaves in a material tree. */
export function countMaterialFiles(items: AuthorMaterialItem[]): number {
  let total = 0;
  for (const item of items) {
    if (item.itemType === 'folder') {
      total += countMaterialFiles(item.children ?? []);
    } else {
      total += 1;
    }
  }
  return total;
}

/** Citation label falls back to the id when no human title is present. */
export function citationLabel(entry: CitationEntry): string {
  const title = entry.title?.trim();
  return title ? title : entry.id;
}

/** Section header text, e.g. `Characters (3)`. */
export function formatSectionLabel(section: AuthorMaterialsSection): string {
  return `${section.label} (${section.count})`;
}

/**
 * Join a workspace-relative path onto a root URI, encoding each path segment so
 * the result is a valid file URI even when the path contains spaces.
 */
export function joinUri(rootUri: string | undefined, relPath: string): string | undefined {
  if (!rootUri) {
    return undefined;
  }
  const base = rootUri.replace(/\/+$/, '');
  const segments = relPath.split('/').filter(Boolean).map(segment => encodeURIComponent(segment));
  return segments.length > 0 ? `${base}/${segments.join('/')}` : base;
}

/** Recursively count leaf (file) nodes within manuscript content. */
export function countManuscriptFiles(nodes: ManuscriptNode[]): number {
  let total = 0;
  for (const node of nodes) {
    if (node.type === 'folder') {
      total += countManuscriptFiles(node.children ?? []);
    } else {
      total += 1;
    }
  }
  return total;
}

/**
 * Build the ordered section descriptors that drive the manuscript navigator.
 * Order is fixed by {@link AUTHOR_MATERIALS_SECTION_ORDER}; items within each
 * section are sorted by label (then id) for stable rendering.
 */
export function buildAuthorMaterialsSections(input: AuthorMaterialsInput): AuthorMaterialsSection[] {
  return AUTHOR_MATERIALS_SECTION_ORDER.map(kind => {
    switch (kind) {
      case 'manuscript':
        return makeSection('manuscript', countManuscriptFiles(input.manuscript), [], true);
      case 'characters':
      case 'terms':
      case 'artifacts':
      case 'locations': {
        const items = entityItems(input.entities, kind);
        return makeSection(kind, items.length, items, false);
      }
      case 'citations': {
        const items = citationItems(input.citations, input.rootUri, input.citationsUri);
        return makeSection('citations', items.length, items, false);
      }
      case 'sources': {
        const items = sourceItems(input.sources);
        return makeSection('sources', countMaterialFiles(items), items, false);
      }
      case 'knowledge': {
        const items = knowledgeItems(input.knowledge);
        return makeSection('knowledge', countMaterialFiles(items), items, false);
      }
      case 'skills': {
        const items = skillItems(input.skills);
        return makeSection('skills', items.length, items, false);
      }
    }
  });
}

function makeSection(
  kind: AuthorMaterialsSectionKind,
  count: number,
  items: AuthorMaterialItem[],
  expandedByDefault: boolean
): AuthorMaterialsSection {
  return { kind, label: SECTION_LABELS[kind], count, items, expandedByDefault };
}

function entityItems(entities: NarrativeEntity[], section: AuthorMaterialsSectionKind): AuthorMaterialItem[] {
  return entities
    .filter(entity => ENTITY_KIND_TO_SECTION[entity.kind] === section)
    .map(entity => ({
      id: entity.id,
      label: entity.label?.trim() || entity.id,
      description: entity.id,
      uri: entity.uri
    }))
    .sort(byLabel);
}

function citationItems(
  citations: CitationEntry[],
  rootUri: string | undefined,
  citationsUri: string | undefined
): AuthorMaterialItem[] {
  return citations
    .map(citation => {
      const label = citationLabel(citation);
      const uri = citation.path ? joinUri(rootUri, citation.path) : citationsUri;
      return {
        id: citation.id,
        label,
        // Show the id as secondary text only when the label is the human title.
        description: label === citation.id ? citation.source : citation.id,
        uri
      };
    })
    .sort(byLabel);
}

function sourceItems(items: SourceLibraryItem[]): AuthorMaterialItem[] {
  const files = items
    .filter(item => item.type === 'file')
    .filter(item => isAllowedMaterialFile(item.name));
  return buildMaterialFileTree(files, 'sources/');
}

function knowledgeItems(files: KnowledgeFileEntry[]): AuthorMaterialItem[] {
  const allowed = files.filter(file => isKnowledgeFile(file.name));
  return buildMaterialFileTree(allowed, 'knowledge/');
}

/**
 * One flat leaf per book skill, labelled by its frontmatter `name` (folder slug
 * fallback applied upstream by the scanner), opening its `SKILL.md`. The
 * description carries the frontmatter `description` when present, else the path.
 */
function skillItems(skills: SkillEntry[]): AuthorMaterialItem[] {
  return skills
    .map(skill => ({
      id: skill.id,
      label: skill.label?.trim() || skill.id,
      description: skill.description?.trim() || skill.path,
      uri: skill.uri
    }))
    .sort(byLabel);
}

function byLabel(left: AuthorMaterialItem, right: AuthorMaterialItem): number {
  const byName = left.label.localeCompare(right.label);
  return byName !== 0 ? byName : left.id.localeCompare(right.id);
}
