import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { inject, injectable } from '@theia/core/shared/inversify';
import type {
  AiMode,
  AiModeRegistry,
  AiModeRegistryBackendService,
  AiModeRegistrySnapshot
} from '../common';
import { AiModeRegistryBackendService as AiModeRegistryBackendServiceSymbol } from '../common';

@injectable()
export class BrowserAiModeRegistry implements AiModeRegistry {
  @inject(WorkspaceService)
  protected readonly workspaceService!: WorkspaceService;

  @inject(AiModeRegistryBackendServiceSymbol)
  protected readonly backend!: AiModeRegistryBackendService;

  async getSnapshot(): Promise<AiModeRegistrySnapshot> {
    return this.backend.getSnapshot(await this.getRootUri());
  }

  refresh(): Promise<AiModeRegistrySnapshot> {
    return this.getSnapshot();
  }

  async listModes(): Promise<AiMode[]> {
    return (await this.getSnapshot()).modes;
  }

  async getMode(id: string): Promise<AiMode | undefined> {
    return (await this.listModes()).find(mode => mode.id === id);
  }

  protected async getRootUri(): Promise<string | undefined> {
    await this.workspaceService.ready;
    const root = this.workspaceService.tryGetRoots()[0] ?? (await this.workspaceService.roots)[0];
    return root?.resource.toString();
  }
}
