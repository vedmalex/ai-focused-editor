import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { inject, injectable } from '@theia/core/shared/inversify';
import type {
  NarrativeEntityBackendService,
  NarrativeEntityService,
  NarrativeEntitySnapshot
} from '../common';
import { NarrativeEntityBackendService as NarrativeEntityBackendServiceSymbol } from '../common';

@injectable()
export class BrowserNarrativeEntityService implements NarrativeEntityService {
  @inject(WorkspaceService)
  protected readonly workspaceService!: WorkspaceService;

  @inject(NarrativeEntityBackendServiceSymbol)
  protected readonly backend!: NarrativeEntityBackendService;

  async getSnapshot(): Promise<NarrativeEntitySnapshot> {
    return this.backend.getSnapshot(await this.getRootUri());
  }

  refresh(): Promise<NarrativeEntitySnapshot> {
    return this.getSnapshot();
  }

  protected async getRootUri(): Promise<string | undefined> {
    await this.workspaceService.ready;
    const root = this.workspaceService.tryGetRoots()[0] ?? (await this.workspaceService.roots)[0];
    return root?.resource.toString();
  }
}
