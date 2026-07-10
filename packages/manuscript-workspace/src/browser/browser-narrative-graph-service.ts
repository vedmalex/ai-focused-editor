import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { inject, injectable } from '@theia/core/shared/inversify';
import type {
  NarrativeGraphBackendService,
  NarrativeGraphService,
  NarrativeGraphSnapshot
} from '../common';
import { NarrativeGraphBackendService as NarrativeGraphBackendServiceSymbol } from '../common';

@injectable()
export class BrowserNarrativeGraphService implements NarrativeGraphService {
  @inject(WorkspaceService)
  protected readonly workspaceService!: WorkspaceService;

  @inject(NarrativeGraphBackendServiceSymbol)
  protected readonly backend!: NarrativeGraphBackendService;

  async getSnapshot(): Promise<NarrativeGraphSnapshot> {
    return this.backend.getSnapshot(await this.getRootUri());
  }

  refresh(): Promise<NarrativeGraphSnapshot> {
    return this.getSnapshot();
  }

  protected async getRootUri(): Promise<string | undefined> {
    await this.workspaceService.ready;
    const root = this.workspaceService.tryGetRoots()[0] ?? (await this.workspaceService.roots)[0];
    return root?.resource.toString();
  }
}
