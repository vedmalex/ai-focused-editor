import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { inject, injectable } from '@theia/core/shared/inversify';
import type {
  SourceLibraryBackendService,
  SourceLibraryService,
  SourceLibrarySnapshot
} from '../common';
import { SourceLibraryBackendService as SourceLibraryBackendServiceSymbol } from '../common';

@injectable()
export class BrowserSourceLibraryService implements SourceLibraryService {
  @inject(WorkspaceService)
  protected readonly workspaceService!: WorkspaceService;

  @inject(SourceLibraryBackendServiceSymbol)
  protected readonly backend!: SourceLibraryBackendService;

  async getSnapshot(): Promise<SourceLibrarySnapshot> {
    return this.backend.getSnapshot(await this.getRootUri());
  }

  refresh(): Promise<SourceLibrarySnapshot> {
    return this.getSnapshot();
  }

  protected async getRootUri(): Promise<string | undefined> {
    await this.workspaceService.ready;
    const root = this.workspaceService.tryGetRoots()[0] ?? (await this.workspaceService.roots)[0];
    return root?.resource.toString();
  }
}
