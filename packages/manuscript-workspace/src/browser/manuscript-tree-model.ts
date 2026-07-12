import { postConstruct, inject, injectable } from '@theia/core/shared/inversify';
import { TreeModelImpl } from '@theia/core/lib/browser/tree';
import URI from '@theia/core/lib/common/uri';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import type { FileStat } from '@theia/filesystem/lib/common/files';
import type {
  ManuscriptMoveTarget,
  ManuscriptMutationResult,
  ManuscriptWorkspaceSnapshot,
  NarrativeEntitySnapshot,
  SourceLibrarySnapshot
} from '../common';
import {
  ManuscriptWorkspaceService,
  NarrativeEntityService,
  SourceLibraryService
} from '../common';
import { parse } from 'yaml';
import { buildAuthorMaterialsSections, joinUri, type KnowledgeFileEntry, type SkillEntry } from '../common/author-materials';
import { EntityTypeRegistryService } from './entity-type-registry-service';
import { ManuscriptTreeItemFactory } from './manuscript-tree-item-factory';

const AUTO_REFRESH_DELAY_MS = 300;

/**
 * Tolerantly pull `name`/`description` from a `SKILL.md` YAML frontmatter block
 * (the leading `---` … `---` fence). Anything malformed — no fence, invalid
 * YAML, non-string fields — yields an empty result so the caller falls back to
 * the folder slug. Mirrors the Theia SkillService's frontmatter contract.
 */
function parseSkillFrontmatter(text: string): { name?: string; description?: string } {
  const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) {
    return {};
  }
  let document: unknown;
  try {
    document = parse(match[1]);
  } catch {
    return {};
  }
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    return {};
  }
  const record = document as Record<string, unknown>;
  const name = typeof record.name === 'string' ? record.name : undefined;
  const description = typeof record.description === 'string' ? record.description : undefined;
  return { name, description };
}

@injectable()
export class ManuscriptTreeModel extends TreeModelImpl {
  @inject(ManuscriptWorkspaceService)
  protected readonly manuscriptWorkspace!: ManuscriptWorkspaceService;

  @inject(NarrativeEntityService)
  protected readonly narrativeEntities!: NarrativeEntityService;

  @inject(SourceLibraryService)
  protected readonly sourceLibrary!: SourceLibraryService;

  @inject(EntityTypeRegistryService)
  protected readonly entityTypeRegistry!: EntityTypeRegistryService;

  @inject(ManuscriptTreeItemFactory)
  protected readonly itemFactory!: ManuscriptTreeItemFactory;

  @inject(FileService)
  protected readonly fileService!: FileService;

  protected currentSnapshot: ManuscriptWorkspaceSnapshot | undefined;
  protected entitySnapshot: NarrativeEntitySnapshot | undefined;
  protected sourceSnapshot: SourceLibrarySnapshot | undefined;
  protected knowledgeFiles: KnowledgeFileEntry[] = [];
  protected skillEntries: SkillEntry[] = [];
  protected autoRefreshHandle: ReturnType<typeof setTimeout> | undefined;
  protected mutationInFlight = false;

  @postConstruct()
  protected override init(): void {
    super.init();
    this.root = this.itemFactory.createRoot([], []);
    this.toDispose.push(this.fileService.onDidFilesChange(event => {
      if (this.mutationInFlight || !this.currentSnapshot?.rootUri) {
        return;
      }
      const affectsMaterials = event.changes.some(change => {
        const path = change.resource.toString();
        return path.endsWith('/manifest.yaml')
          || path.includes('/content/')
          || path.includes('/entities/')
          || path.includes('/sources/')
          || path.includes('/knowledge/')
          || path.includes('/.prompts/skills/');
      });
      if (affectsMaterials) {
        this.scheduleAutoRefresh();
      }
    }));
    void this.refreshWorkspace();
  }

  async refreshWorkspace(): Promise<ManuscriptWorkspaceSnapshot> {
    const [manuscript, entities, sources] = await Promise.all([
      this.manuscriptWorkspace.refresh(),
      this.refreshEntities(),
      this.refreshSources()
    ]);
    this.currentSnapshot = manuscript;
    this.entitySnapshot = entities;
    this.sourceSnapshot = sources;
    // Feed the dumb frontend registry from the fresh entity snapshot so
    // consumers see author-declared types (and their validation problems).
    this.entityTypeRegistry.update(entities?.effectiveEntityTypes, entities?.typeProblems);
    [this.knowledgeFiles, this.skillEntries] = await Promise.all([
      this.scanKnowledge(manuscript.rootUri),
      this.scanSkills(manuscript.rootUri)
    ]);
    this.rebuildRoot();
    return manuscript;
  }

  async moveEntry(sourcePath: string, target: ManuscriptMoveTarget): Promise<ManuscriptMutationResult> {
    return this.runMutation(() => this.manuscriptWorkspace.moveEntry(sourcePath, target));
  }

  async setBuildInclusion(path: string, include: boolean): Promise<ManuscriptMutationResult> {
    return this.runMutation(() => this.manuscriptWorkspace.setBuildInclusion(path, include));
  }

  async createChapter(parentPath: string | undefined, title: string): Promise<ManuscriptMutationResult> {
    return this.runMutation(() => this.manuscriptWorkspace.createChapter(parentPath, title));
  }

  get snapshot(): ManuscriptWorkspaceSnapshot | undefined {
    return this.currentSnapshot;
  }

  protected async runMutation(mutation: () => Promise<ManuscriptMutationResult>): Promise<ManuscriptMutationResult> {
    this.mutationInFlight = true;
    try {
      const result = await mutation();
      // Manuscript mutations only change manifest content; reuse the cached
      // entity/source/knowledge snapshots and rebuild the tree with the new nodes.
      this.currentSnapshot = result.snapshot;
      this.rebuildRoot();
      return result;
    } finally {
      this.mutationInFlight = false;
    }
  }

  protected rebuildRoot(): void {
    const manuscriptContent = this.currentSnapshot?.content ?? [];
    const sections = buildAuthorMaterialsSections({
      rootUri: this.currentSnapshot?.rootUri,
      manuscript: manuscriptContent,
      entities: this.entitySnapshot?.entities ?? [],
      citations: this.sourceSnapshot?.citations ?? [],
      citationsUri: this.citationsUri(),
      sources: this.sourceSnapshot?.items ?? [],
      knowledge: this.knowledgeFiles,
      skills: this.skillEntries,
      effectiveEntityTypes: this.entitySnapshot?.effectiveEntityTypes,
      typeProblems: this.entitySnapshot?.typeProblems
    });
    const rootUri = this.currentSnapshot?.rootUri;
    const typesYamlUri = rootUri ? joinUri(rootUri, 'entities/types.yaml') : undefined;
    this.root = this.itemFactory.createRoot(sections, manuscriptContent, { typesYamlUri });
  }

  protected async refreshEntities(): Promise<NarrativeEntitySnapshot | undefined> {
    try {
      return await this.narrativeEntities.refresh();
    } catch {
      return undefined;
    }
  }

  protected async refreshSources(): Promise<SourceLibrarySnapshot | undefined> {
    try {
      return await this.sourceLibrary.refresh();
    } catch {
      return undefined;
    }
  }

  protected citationsUri(): string | undefined {
    const sourceUri = this.sourceSnapshot?.sourceUri;
    return sourceUri ? `${sourceUri.replace(/\/+$/, '')}/citations.yaml` : undefined;
  }

  protected async scanKnowledge(rootUri: string | undefined): Promise<KnowledgeFileEntry[]> {
    if (!rootUri) {
      return [];
    }
    const root = new URI(rootUri);
    const knowledgeUri = root.resolve('knowledge');
    try {
      if (!(await this.fileService.exists(knowledgeUri))) {
        return [];
      }
      const entries: KnowledgeFileEntry[] = [];
      await this.collectKnowledge(knowledgeUri, root, entries);
      return entries;
    } catch {
      return [];
    }
  }

  protected async collectKnowledge(dirUri: URI, root: URI, out: KnowledgeFileEntry[]): Promise<void> {
    let stat: FileStat;
    try {
      stat = await this.fileService.resolve(dirUri);
    } catch {
      return;
    }
    for (const child of stat.children ?? []) {
      if (child.isDirectory) {
        await this.collectKnowledge(child.resource, root, out);
      } else {
        out.push({
          name: child.name,
          path: root.relative(child.resource)?.toString() ?? child.name,
          uri: child.resource.toString()
        });
      }
    }
  }

  /**
   * Enumerate the book's AI skills: one folder per skill under
   * `.prompts/skills/<slug>/SKILL.md`. Each `SKILL.md` frontmatter is parsed
   * (tolerantly) for `name`/`description`; the folder slug is the fallback
   * label and the stable id. A missing `.prompts/skills` directory yields an
   * empty list rather than an error, mirroring `scanKnowledge`. This is our own
   * curated scan of the same files Theia's SkillService discovers — it does not
   * go through the generic (dotfile-excluded) file tree.
   */
  protected async scanSkills(rootUri: string | undefined): Promise<SkillEntry[]> {
    if (!rootUri) {
      return [];
    }
    const root = new URI(rootUri);
    const skillsDir = root.resolve('.prompts/skills');
    let dir: FileStat;
    try {
      dir = await this.fileService.resolve(skillsDir);
    } catch {
      return [];
    }
    const entries: SkillEntry[] = [];
    for (const child of dir.children ?? []) {
      if (!child.isDirectory) {
        continue;
      }
      const slug = child.name;
      const skillFile = child.resource.resolve('SKILL.md');
      let text: string;
      try {
        text = (await this.fileService.read(skillFile)).value;
      } catch {
        // A skill folder without a SKILL.md is not a skill — skip it.
        continue;
      }
      const meta = parseSkillFrontmatter(text);
      entries.push({
        id: slug,
        label: meta.name?.trim() || slug,
        description: meta.description?.trim() || undefined,
        path: root.relative(skillFile)?.toString() ?? `.prompts/skills/${slug}/SKILL.md`,
        uri: skillFile.toString()
      });
    }
    return entries;
  }

  protected scheduleAutoRefresh(): void {
    if (this.autoRefreshHandle !== undefined) {
      clearTimeout(this.autoRefreshHandle);
    }
    this.autoRefreshHandle = setTimeout(() => {
      this.autoRefreshHandle = undefined;
      void this.refreshWorkspace();
    }, AUTO_REFRESH_DELAY_MS);
  }
}
