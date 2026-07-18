import type { ManuscriptNode } from './manuscript-workspace-protocol';
import type { NarrativeEntity } from './narrative-entity-protocol';
import { BASE_ENTITY_TYPES, mergeEntityTypes } from './entity-type-registry';
import type { EffectiveEntityType, EntityTypeProblem } from './entity-type-registry';
import type { CitationEntry, SourceLibraryItem } from './source-library-protocol';
import { formatProgressChip } from './proofreading-model';

/**
 * Pure grouping logic for the unified author-materials navigator. This module
 * has no Theia/Node/DOM imports so it can be exercised with plain `bun test`.
 * The frontend tree factory turns the descriptors returned here into concrete
 * Theia tree nodes.
 */

/**
 * The nine built-in navigator sections. Manuscript + the four built-in entity
 * sections + citations/sources/knowledge/skills. Author-declared entity types
 * contribute additional section kinds (their descriptor `sectionKind`) at
 * runtime, which is why {@link AuthorMaterialsSectionKind} widens this union.
 */
export type BaseAuthorMaterialsSectionKind =
  | 'manuscript'
  | 'characters'
  | 'terms'
  | 'artifacts'
  | 'locations'
  | 'citations'
  | 'sources'
  | 'knowledge'
  | 'skills'
  | 'proofreading';

/**
 * Navigator section kind. The nine built-in sections stay literals (so switch/
 * equality consumers keep exhaustiveness + autocomplete); the open `(string & {})`
 * arm admits any author-declared entity type's `sectionKind` at runtime without
 * widening the literal ergonomics away.
 */
export type AuthorMaterialsSectionKind = BaseAuthorMaterialsSectionKind | (string & {});

/**
 * Fixed top-level order of the BUILT-IN navigator sections. Author entity
 * sections are inserted after the built-in entity sections (before citations)
 * by {@link buildAuthorMaterialsSections}, following the effective type order.
 */
export const AUTHOR_MATERIALS_SECTION_ORDER: readonly BaseAuthorMaterialsSectionKind[] = [
  'manuscript',
  'characters',
  'terms',
  'artifacts',
  'locations',
  'citations',
  'sources',
  'knowledge',
  'skills',
  'proofreading'
];

const SECTION_LABELS: Record<BaseAuthorMaterialsSectionKind, string> = {
  manuscript: 'Manuscript',
  characters: 'Characters',
  terms: 'Terms',
  artifacts: 'Artifacts',
  locations: 'Locations',
  citations: 'Citations',
  sources: 'Sources',
  knowledge: 'Knowledge',
  skills: 'Skills',
  proofreading: 'Proofreading'
};

/** True for one of the nine built-in section kinds (has a static English label). */
function isBaseSectionKind(kind: string): kind is BaseAuthorMaterialsSectionKind {
  return Object.prototype.hasOwnProperty.call(SECTION_LABELS, kind);
}

/** The built-in-only effective type list, reused when no author types are supplied. */
const BUILT_IN_EFFECTIVE: EffectiveEntityType[] = mergeEntityTypes(BASE_ENTITY_TYPES, []);

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

/**
 * A proofreading "set" discovered under `proofreading/<slug>/proofset.yaml`.
 * `verified`/`total`/`percent` come from `computeProgress` over the sidecar's
 * pages (computed by the browser scanner), rendered as a progress chip on the
 * set's tree node; opening the item opens the sidecar (the priority-500
 * Proofreading editor takes over).
 */
export interface ProofreadingSetEntry {
  /** Set folder slug, e.g. `chapter-1`; stable id within the section. */
  slug: string;
  /** Display label for the set (the folder slug). */
  label: string;
  /** Absolute URI of the set's `proofset.yaml`, opened on activation. */
  uri: string;
  /** Verified page count. */
  verified: number;
  /** Total page count. */
  total: number;
  /** Verified percent (0 when the set has no pages yet). */
  percent: number;
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
  /** Proofreading sets scanned from `proofreading/<slug>/proofset.yaml` (defaults to none). */
  proofreadingSets?: ProofreadingSetEntry[];
  /**
   * The EFFECTIVE entity types (built-in + author-declared) for the open root,
   * carried through so downstream consumers (dynamic sections, the type
   * registry) can pick up author types. Undefined falls back to the built-in
   * set. The base section builder below only uses the fixed built-in sections
   * this stage; author-type sections are a later consumer concern.
   */
  effectiveEntityTypes?: EffectiveEntityType[];
  /** Validation problems from parsing `entities/types.yaml`, if any. */
  typeProblems?: EntityTypeProblem[];
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
  /**
   * Set on the entity sections (built-in AND author-declared) — the descriptor
   * whose `sectionKind` names this section. Drives the entities-group nesting in
   * the tree factory and carries the icon/accent/origin so the factory can
   * localize built-in labels but render author labels verbatim (the author label
   * IS the author's language). Absent on manuscript/citations/sources/knowledge/
   * skills, which keep their static icons and localized labels.
   */
  entityType?: EffectiveEntityType;
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
  // The EFFECTIVE type list drives the entity sections: built-in types first,
  // then valid author types (their order preserved). Undefined/empty falls back
  // to the built-in set, so a no-workspace snapshot yields exactly the nine base
  // sections in the fixed navigator order.
  const effective = input.effectiveEntityTypes && input.effectiveEntityTypes.length > 0
    ? input.effectiveEntityTypes
    : BUILT_IN_EFFECTIVE;

  const sections: AuthorMaterialsSection[] = [];
  sections.push(makeSection('manuscript', countManuscriptFiles(input.manuscript), [], true));

  // One section per effective entity type, in effective order (built-in
  // characters/terms/artifacts/locations, then author types). They nest under
  // the entities group in the tree; author sections carry their verbatim label.
  for (const type of effective) {
    const items = entityItemsForType(input.entities, type.id);
    sections.push(makeEntitySection(type, items));
  }

  const citations = citationItems(input.citations, input.rootUri, input.citationsUri);
  sections.push(makeSection('citations', citations.length, citations, false));
  const sources = sourceItems(input.sources);
  sections.push(makeSection('sources', countMaterialFiles(sources), sources, false));
  const knowledge = knowledgeItems(input.knowledge);
  sections.push(makeSection('knowledge', countMaterialFiles(knowledge), knowledge, false));
  const skills = skillItems(input.skills);
  sections.push(makeSection('skills', skills.length, skills, false));
  // Proofreading is an OPT-IN mode: the section appears ONLY when the book
  // actually has proofreading sets, so it never clutters the navigator of a
  // book that does no scan/OCR/translation review (owner request 2026-07-18).
  const proofreading = proofreadingItems(input.proofreadingSets ?? []);
  if (proofreading.length > 0) {
    sections.push(makeSection('proofreading', proofreading.length, proofreading, false));
  }

  return sections;
}

function makeSection(
  kind: BaseAuthorMaterialsSectionKind,
  count: number,
  items: AuthorMaterialItem[],
  expandedByDefault: boolean
): AuthorMaterialsSection {
  return { kind, label: SECTION_LABELS[kind], count, items, expandedByDefault };
}

/**
 * Build the section for one effective entity type. The section `kind` is the
 * descriptor's `sectionKind`; built-in sections keep their plural English label
 * (`Characters`, localized downstream by the tree), while author sections use
 * the author-declared `label` VERBATIM — it is the author's own language and is
 * never sent through the i18n path. The descriptor rides along on `entityType`
 * so the tree factory nests + icons the section without re-deriving anything.
 */
function makeEntitySection(type: EffectiveEntityType, items: AuthorMaterialItem[]): AuthorMaterialsSection {
  const label = type.origin === 'built-in' && isBaseSectionKind(type.sectionKind)
    ? SECTION_LABELS[type.sectionKind]
    : type.label;
  return {
    kind: type.sectionKind,
    label,
    count: items.length,
    items,
    expandedByDefault: false,
    entityType: type
  };
}

/** Items for the entity section of `typeId`, sorted by label (then id). */
function entityItemsForType(entities: NarrativeEntity[], typeId: string): AuthorMaterialItem[] {
  return entities
    .filter(entity => entity.kind === typeId)
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

/**
 * One flat leaf per proofreading set, labelled by its folder slug, opening its
 * `proofset.yaml`. The description carries the verified-progress chip
 * (`N/M ✓`); sets are sorted numeric-aware by slug so `chapter-2` precedes
 * `chapter-10`.
 */
function proofreadingItems(sets: ProofreadingSetEntry[]): AuthorMaterialItem[] {
  return sets
    .map(set => ({
      id: set.slug,
      label: set.label?.trim() || set.slug,
      description: formatProgressChip({ verified: set.verified, total: set.total }),
      uri: set.uri
    }))
    .sort((left, right) => left.label.localeCompare(right.label, undefined, { numeric: true })
      || left.id.localeCompare(right.id));
}

function byLabel(left: AuthorMaterialItem, right: AuthorMaterialItem): number {
  const byName = left.label.localeCompare(right.label);
  return byName !== 0 ? byName : left.id.localeCompare(right.id);
}
