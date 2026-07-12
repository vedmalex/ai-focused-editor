import { promises as fs } from 'fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'path';
import { FileUri } from '@theia/core/lib/common/file-uri';
import { injectable } from '@theia/core/shared/inversify';
import { parseSemanticMarkdown } from '@ai-focused-editor/semantic-markdown';
import { parse } from 'yaml';
import {
  BASE_ENTITY_TYPES,
  NARRATIVE_GRAPH_NODE_CAP,
  NarrativeEntityAppearance,
  NarrativeGraphBackendService,
  NarrativeGraphSnapshot,
  NarrativeOwnershipEntry,
  NarrativeOwnershipTransfer,
  NarrativeRelationEdge,
  NarrativeRelationNode,
  NarrativeTimelineChapter,
  WorkspaceDiagnostic
} from '../common';

interface EntityLabelConfig {
  kind: string;
  directory: string;
  labelField: string;
}

// Derived from the single-source entity-type registry (kind id, `entities/<dir>`
// scan path, YAML label key). Byte-identical to the previous inline table.
const ENTITY_LABEL_DIRECTORIES: EntityLabelConfig[] = BASE_ENTITY_TYPES.map(type => ({
  kind: type.id,
  directory: `entities/${type.directory}`,
  labelField: type.fields.find(field => field.role === 'label')?.name ?? 'name'
}));

/** Semantic-tag kinds collapse onto the four canonical entity kinds. */
const TAG_KIND_TO_ENTITY_KIND: Record<string, string> = {
  char: 'character',
  character: 'character',
  characters: 'character',
  term: 'term',
  terms: 'term',
  artifact: 'artifact',
  artifacts: 'artifact',
  location: 'location',
  locations: 'location',
  loc: 'location'
};

interface ManifestChapter {
  path: string;
  title: string;
  buildIncluded: boolean;
}

interface EntityLabelIndex {
  /** `${kind}:${id}` → label from the entity YAML card. */
  byKindId: Map<string, string>;
  /** `${id}` → label (first card wins), used to resolve ownership owners. */
  byId: Map<string, string>;
}

@injectable()
export class NodeNarrativeGraphService implements NarrativeGraphBackendService {
  getSnapshot(rootUri?: string): Promise<NarrativeGraphSnapshot> {
    if (!rootUri) {
      return Promise.resolve({
        timeline: [],
        ownership: [],
        nodes: [],
        relations: [],
        truncated: false,
        totalEntities: 0,
        diagnostics: [{
          severity: 'info',
          source: 'narrative-graph',
          message: 'Open a manuscript workspace to view the narrative map.'
        }]
      });
    }

    return this.compute(toRootPath(rootUri));
  }

  refresh(rootUri?: string): Promise<NarrativeGraphSnapshot> {
    return this.getSnapshot(rootUri);
  }

  protected async compute(rootPath: string): Promise<NarrativeGraphSnapshot> {
    const diagnostics: WorkspaceDiagnostic[] = [];
    const labels = await this.readEntityLabels(rootPath);
    const chapters = await this.readManifestChapters(rootPath, diagnostics);

    const timeline: NarrativeTimelineChapter[] = [];
    // Per-chapter entity key sets drive the co-occurrence graph.
    const chapterEntitySets: Set<string>[] = [];
    // Composite key `${kind}:${id}` → running totals for graph nodes.
    const nodeTotals = new Map<string, NarrativeRelationNode>();

    for (const [order, chapter] of chapters.entries()) {
      const filePath = resolve(rootPath, chapter.path);
      const text = await readTextIfExists(filePath);
      if (text === undefined) {
        diagnostics.push({
          severity: 'warning',
          source: 'narrative-graph',
          uri: FileUri.create(filePath).toString(),
          message: `Skipping missing chapter file: ${chapter.path}`
        });
        continue;
      }

      const counts = new Map<string, NarrativeEntityAppearance>();
      for (const tag of parseSemanticMarkdown(text).tags) {
        const kind = TAG_KIND_TO_ENTITY_KIND[tag.kind] ?? tag.kind;
        const key = `${kind}:${tag.id}`;
        const existing = counts.get(key);
        if (existing) {
          existing.count += 1;
        } else {
          counts.set(key, {
            kind,
            id: tag.id,
            label: labels.byKindId.get(key) ?? tag.label ?? tag.id,
            count: 1
          });
        }
      }

      const entities = [...counts.values()].sort((left, right) =>
        right.count - left.count || left.label.localeCompare(right.label));
      timeline.push({
        path: chapter.path,
        title: chapter.title,
        order,
        buildIncluded: chapter.buildIncluded,
        entities
      });

      chapterEntitySets.push(new Set(counts.keys()));
      for (const [key, appearance] of counts) {
        const node = nodeTotals.get(key);
        if (node) {
          node.appearances += appearance.count;
        } else {
          nodeTotals.set(key, {
            id: key,
            kind: appearance.kind,
            entityId: appearance.id,
            label: appearance.label,
            appearances: appearance.count
          });
        }
      }
    }

    const ownership = await this.readOwnership(rootPath, labels, diagnostics);
    const { nodes, relations, truncated, totalEntities } =
      this.buildRelations(nodeTotals, chapterEntitySets);

    return {
      rootUri: FileUri.create(rootPath).toString(),
      timeline,
      ownership,
      nodes,
      relations,
      truncated,
      totalEntities,
      diagnostics
    };
  }

  /** Parse manifest.yaml and collect leaf `.md` chapters in content order. */
  protected async readManifestChapters(
    rootPath: string,
    diagnostics: WorkspaceDiagnostic[]
  ): Promise<ManifestChapter[]> {
    const manifestPath = join(rootPath, 'manifest.yaml');
    const manifestUri = FileUri.create(manifestPath).toString();
    const text = await readTextIfExists(manifestPath);
    if (text === undefined) {
      diagnostics.push({
        severity: 'warning',
        source: 'narrative-graph',
        uri: manifestUri,
        message: 'Missing manifest.yaml; the timeline needs a manifest to order chapters.'
      });
      return [];
    }

    let document: unknown;
    try {
      document = parse(text);
    } catch (error) {
      diagnostics.push({
        severity: 'error',
        source: 'narrative-graph',
        uri: manifestUri,
        message: `Invalid manifest.yaml: ${error instanceof Error ? error.message : String(error)}`
      });
      return [];
    }

    if (!isRecord(document) || !Array.isArray(document.content)) {
      diagnostics.push({
        severity: 'warning',
        source: 'narrative-graph',
        uri: manifestUri,
        message: 'manifest.yaml has no content list to walk.'
      });
      return [];
    }

    const chapters: ManifestChapter[] = [];
    this.collectChapters(document.content, true, chapters);
    return chapters;
  }

  protected collectChapters(entries: unknown[], parentIncluded: boolean, chapters: ManifestChapter[]): void {
    for (const entry of entries) {
      if (!isRecord(entry)) {
        continue;
      }
      const path = asString(entry.path);
      if (!path) {
        continue;
      }
      const included = parentIncluded && entry.include !== false;
      if (/\.mdx?$/i.test(path)) {
        chapters.push({
          path: normalizePath(path),
          title: asString(entry.title) || basename(path),
          buildIncluded: included
        });
      }
      if (Array.isArray(entry.children)) {
        this.collectChapters(entry.children, included, chapters);
      }
    }
  }

  /** Minimal id/label parsing across the four entity directories (self-contained). */
  protected async readEntityLabels(rootPath: string): Promise<EntityLabelIndex> {
    const byKindId = new Map<string, string>();
    const byId = new Map<string, string>();

    for (const config of ENTITY_LABEL_DIRECTORIES) {
      const directoryPath = join(rootPath, config.directory);
      const stat = await statIfExists(directoryPath);
      if (!stat?.isDirectory()) {
        continue;
      }

      const files = (await fs.readdir(directoryPath, { withFileTypes: true }))
        .filter(child => child.isFile() && (child.name.endsWith('.yaml') || child.name.endsWith('.yml')))
        .sort((left, right) => left.name.localeCompare(right.name));

      for (const file of files) {
        const text = await readTextIfExists(join(directoryPath, file.name));
        if (text === undefined) {
          continue;
        }
        let document: unknown;
        try {
          document = parse(text);
        } catch {
          continue; // Malformed entity YAML is surfaced by the manuscript workspace service.
        }
        if (!isRecord(document)) {
          continue;
        }
        const id = asString(document.id) || file.name.replace(/\.(ya?ml)$/i, '');
        const label = asString(document[config.labelField]) || id;
        byKindId.set(`${config.kind}:${id}`, label);
        if (!byId.has(id)) {
          byId.set(id, label);
        }
      }
    }

    return { byKindId, byId };
  }

  /** Read artifact cards and extract ownership chains, diagnosing malformed entries. */
  protected async readOwnership(
    rootPath: string,
    labels: EntityLabelIndex,
    diagnostics: WorkspaceDiagnostic[]
  ): Promise<NarrativeOwnershipTransfer[]> {
    const directoryPath = join(rootPath, 'entities/artifacts');
    const stat = await statIfExists(directoryPath);
    if (!stat?.isDirectory()) {
      return [];
    }

    const files = (await fs.readdir(directoryPath, { withFileTypes: true }))
      .filter(child => child.isFile() && (child.name.endsWith('.yaml') || child.name.endsWith('.yml')))
      .sort((left, right) => left.name.localeCompare(right.name));

    const transfers: NarrativeOwnershipTransfer[] = [];
    for (const file of files) {
      const filePath = join(directoryPath, file.name);
      const uri = FileUri.create(filePath).toString();
      const text = await readTextIfExists(filePath);
      if (text === undefined) {
        continue;
      }
      let document: unknown;
      try {
        document = parse(text);
      } catch {
        continue; // Parse errors are reported by the manuscript workspace validation pass.
      }
      if (!isRecord(document) || document.ownership === undefined) {
        continue;
      }

      const artifactId = asString(document.id) || file.name.replace(/\.(ya?ml)$/i, '');
      const artifactLabel = asString(document.name) || artifactId;

      if (!Array.isArray(document.ownership)) {
        diagnostics.push({
          severity: 'warning',
          source: 'narrative-graph',
          uri,
          message: `Ignoring ownership for ${artifactId}: expected a list.`
        });
        continue;
      }

      const entries: NarrativeOwnershipEntry[] = [];
      for (const [index, raw] of document.ownership.entries()) {
        if (!isRecord(raw)) {
          diagnostics.push({
            severity: 'warning',
            source: 'narrative-graph',
            uri,
            message: `Ignoring ownership entry ${index + 1} for ${artifactId}: expected an object.`
          });
          continue;
        }
        const owner = asString(raw.owner);
        if (!owner) {
          diagnostics.push({
            severity: 'warning',
            source: 'narrative-graph',
            uri,
            message: `Ignoring ownership entry ${index + 1} for ${artifactId}: missing owner.`
          });
          continue;
        }
        entries.push({
          owner,
          ownerLabel: labels.byId.get(owner) ?? owner,
          from: asString(raw.from) || undefined,
          to: asString(raw.to) || undefined,
          note: asString(raw.note) || undefined
        });
      }

      if (entries.length > 0) {
        transfers.push({
          artifactId,
          artifactLabel,
          path: toWorkspacePath(rootPath, filePath),
          entries
        });
      }
    }

    return transfers;
  }

  /** Build co-occurrence nodes/edges, capped at the top NARRATIVE_GRAPH_NODE_CAP by appearances. */
  protected buildRelations(
    nodeTotals: Map<string, NarrativeRelationNode>,
    chapterEntitySets: Set<string>[]
  ): {
    nodes: NarrativeRelationNode[];
    relations: NarrativeRelationEdge[];
    truncated: boolean;
    totalEntities: number;
  } {
    const ranked = [...nodeTotals.values()].sort((left, right) =>
      right.appearances - left.appearances || left.label.localeCompare(right.label));
    const totalEntities = ranked.length;
    const truncated = totalEntities > NARRATIVE_GRAPH_NODE_CAP;
    const nodes = ranked.slice(0, NARRATIVE_GRAPH_NODE_CAP);
    const kept = new Set(nodes.map(node => node.id));

    // Accumulate shared chapters per unordered entity pair.
    const edges = new Map<string, NarrativeRelationEdge>();
    for (const [chapterIndex, entitySet] of chapterEntitySets.entries()) {
      const keys = [...entitySet].filter(key => kept.has(key)).sort();
      for (let i = 0; i < keys.length; i++) {
        for (let j = i + 1; j < keys.length; j++) {
          const source = keys[i];
          const target = keys[j];
          const edgeKey = `${source}|${target}`;
          const edge = edges.get(edgeKey);
          if (edge) {
            edge.weight += 1;
            edge.sharedChapters.push(String(chapterIndex));
          } else {
            edges.set(edgeKey, {
              source,
              target,
              sourceLabel: nodeTotals.get(source)!.label,
              targetLabel: nodeTotals.get(target)!.label,
              weight: 1,
              sharedChapters: [String(chapterIndex)]
            });
          }
        }
      }
    }

    const relations = [...edges.values()].sort((left, right) =>
      right.weight - left.weight
      || left.sourceLabel.localeCompare(right.sourceLabel)
      || left.targetLabel.localeCompare(right.targetLabel));

    return { nodes, relations, truncated, totalEntities };
  }
}

function toRootPath(rootUri: string): string {
  if (rootUri.startsWith('file:')) {
    return FileUri.fsPath(rootUri);
  }
  return isAbsolute(rootUri) ? rootUri : resolve(process.cwd(), rootUri);
}

function toWorkspacePath(rootPath: string, path: string): string {
  return relative(rootPath, path).split(sep).join('/');
}

function normalizePath(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

async function readTextIfExists(path: string): Promise<string | undefined> {
  try {
    return await fs.readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

async function statIfExists(path: string): Promise<import('fs').Stats | undefined> {
  try {
    return await fs.stat(path);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
