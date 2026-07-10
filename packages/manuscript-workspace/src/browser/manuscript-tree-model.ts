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
import { buildAuthorMaterialsSections, type KnowledgeFileEntry } from '../common/author-materials';
import { ManuscriptTreeItemFactory } from './manuscript-tree-item-factory';

const AUTO_REFRESH_DELAY_MS = 300;

@injectable()
export class ManuscriptTreeModel extends TreeModelImpl {
  @inject(ManuscriptWorkspaceService)
  protected readonly manuscriptWorkspace!: ManuscriptWorkspaceService;

  @inject(NarrativeEntityService)
  protected readonly narrativeEntities!: NarrativeEntityService;

  @inject(SourceLibraryService)
  protected readonly sourceLibrary!: SourceLibraryService;

  @inject(ManuscriptTreeItemFactory)
  protected readonly itemFactory!: ManuscriptTreeItemFactory;

  @inject(FileService)
  protected readonly fileService!: FileService;

  protected currentSnapshot: ManuscriptWorkspaceSnapshot | undefined;
  protected entitySnapshot: NarrativeEntitySnapshot | undefined;
  protected sourceSnapshot: SourceLibrarySnapshot | undefined;
  protected knowledgeFiles: KnowledgeFileEntry[] = [];
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
          || path.includes('/knowledge/');
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
    this.knowledgeFiles = await this.scanKnowledge(manuscript.rootUri);
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
      knowledge: this.knowledgeFiles
    });
    this.root = this.itemFactory.createRoot(sections, manuscriptContent);
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
