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
  | 'knowledge';

/** Fixed top-level order of the navigator sections. */
export const AUTHOR_MATERIALS_SECTION_ORDER: readonly AuthorMaterialsSectionKind[] = [
  'manuscript',
  'characters',
  'terms',
  'artifacts',
  'locations',
  'citations',
  'sources',
  'knowledge'
];

const SECTION_LABELS: Record<AuthorMaterialsSectionKind, string> = {
  manuscript: 'Manuscript',
  characters: 'Characters',
  terms: 'Terms',
  artifacts: 'Artifacts',
  locations: 'Locations',
  citations: 'Citations',
  sources: 'Sources',
  knowledge: 'Knowledge'
};

const ENTITY_KIND_TO_SECTION: Record<NarrativeEntityKind, AuthorMaterialsSectionKind> = {
  character: 'characters',
  term: 'terms',
  artifact: 'artifacts',
  location: 'locations'
};

/** File extensions surfaced under the Knowledge section (spec §4.1 `knowledge/`). */
const KNOWLEDGE_EXTENSIONS = ['.yaml', '.yml', '.md'];

/** A raw file discovered under `knowledge/**`, before extension filtering. */
export interface KnowledgeFileEntry {
  /** Base file name, e.g. `world-rules.md`. */
  name: string;
  /** Workspace-relative path, e.g. `knowledge/world-rules.md`. */
  path: string;
  /** Absolute URI used to open the file. */
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
}

export interface AuthorMaterialItem {
  /** Unique id within the section; used to build a stable tree node id. */
  id: string;
  label: string;
  /** Secondary text (entity/citation id, knowledge path). */
  description?: string;
  /** URI to open on activation; items without a URI are non-openable. */
  uri?: string;
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
  const lower = name.toLowerCase();
  return KNOWLEDGE_EXTENSIONS.some(ext => lower.endsWith(ext));
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
        return makeSection('sources', items.length, items, false);
      }
      case 'knowledge': {
        const items = knowledgeItems(input.knowledge);
        return makeSection('knowledge', items.length, items, false);
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
  return items
    .filter(item => item.type === 'file')
    .map(item => ({
      id: item.path,
      label: item.name,
      description: item.path,
      uri: item.uri
    }))
    .sort(byLabel);
}

function knowledgeItems(files: KnowledgeFileEntry[]): AuthorMaterialItem[] {
  return files
    .filter(file => isKnowledgeFile(file.name))
    .map(file => ({
      id: file.path,
      label: file.name,
      description: file.path,
      uri: file.uri
    }))
    .sort(byLabel);
}

function byLabel(left: AuthorMaterialItem, right: AuthorMaterialItem): number {
  const byName = left.label.localeCompare(right.label);
  return byName !== 0 ? byName : left.id.localeCompare(right.id);
}
