import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { inject, injectable } from '@theia/core/shared/inversify';
import type {
  ManuscriptMoveTarget,
  ManuscriptMutationResult,
  ManuscriptWorkspaceBackendService,
  ManuscriptWorkspaceService,
  ManuscriptWorkspaceSnapshot
} from '../common';
import { ManuscriptWorkspaceBackendService as ManuscriptWorkspaceBackendServiceSymbol } from '../common';

@injectable()
export class BrowserManuscriptWorkspaceService implements ManuscriptWorkspaceService {
  @inject(WorkspaceService)
  protected readonly workspaceService!: WorkspaceService;

  @inject(ManuscriptWorkspaceBackendServiceSymbol)
  protected readonly backendWorkspace!: ManuscriptWorkspaceBackendService;

  async getSnapshot(): Promise<ManuscriptWorkspaceSnapshot> {
    return this.backendWorkspace.getSnapshot(await this.getRootUri());
  }

  refresh(): Promise<ManuscriptWorkspaceSnapshot> {
    return this.getSnapshot();
  }

  async moveEntry(sourcePath: string, target: ManuscriptMoveTarget): Promise<ManuscriptMutationResult> {
    const rootUri = await this.requireRootUri();
    return this.backendWorkspace.moveManuscriptEntry(rootUri, sourcePath, target);
  }

  async setBuildInclusion(path: string, include: boolean): Promise<ManuscriptMutationResult> {
    const rootUri = await this.requireRootUri();
    return this.backendWorkspace.setManuscriptBuildInclusion(rootUri, path, include);
  }

  async createChapter(parentPath: string | undefined, title: string): Promise<ManuscriptMutationResult> {
    const rootUri = await this.requireRootUri();
    return this.backendWorkspace.createManuscriptChapter(rootUri, parentPath, title);
  }

  protected async getRootUri(): Promise<string | undefined> {
    await this.workspaceService.ready;
    const root = this.workspaceService.tryGetRoots()[0] ?? (await this.workspaceService.roots)[0];
    return root?.resource.toString();
  }

  protected async requireRootUri(): Promise<string> {
    const rootUri = await this.getRootUri();
    if (!rootUri) {
      throw new Error('Open a manuscript workspace folder first.');
    }
    return rootUri;
  }
}
