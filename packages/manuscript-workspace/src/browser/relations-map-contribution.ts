import URI from '@theia/core/lib/common/uri';
import {
  Command,
  CommandContribution,
  CommandRegistry,
  MenuContribution,
  MenuModelRegistry,
  MessageService
} from '@theia/core/lib/common';
import { nls } from '@theia/core/lib/common/nls';
import { open, OpenerService, Widget } from '@theia/core/lib/browser';
import {
  TabBarToolbarContribution,
  TabBarToolbarRegistry
} from '@theia/core/lib/browser/shell/tab-bar-toolbar';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { inject, injectable } from '@theia/core/shared/inversify';
import {
  NarrativeGraphService,
  layoutRelationsMap,
  mergeRelationsMap,
  type MapElement,
  type RelationsMapEdgeSpec,
  type RelationsMapNodeSpec
} from '../common';
import { AiFocusedEditorMenus } from './ai-focused-editor-menu';
import { ExcalidrawCanvasModule, loadExcalidrawCanvasModule } from './excalidraw-editor-widget';
import { NarrativeMapWidget } from './narrative-map-widget';

/** Workspace-relative path of the generated relations-map diagram. */
const RELATIONS_MAP_PATH = 'sources/relations-map.excalidraw';

/**
 * Soft fill per entity kind, matching the tree accents (`afe-ico-*`) but lightened
 * for an Excalidraw background swatch. Unknown kinds fall back to a neutral gray.
 */
const KIND_BACKGROUND: Record<string, string> = {
  character: '#ede0f7', // purple accent
  term: '#e3f4e0',      // green accent
  artifact: '#f7ecd9',  // orange accent
  location: '#fbe0dd'   // red accent
};
const DEFAULT_BACKGROUND = '#f1f3f5';

/** How many missing-entity keys to spell out in the completion message before summarizing. */
const MAX_MISSING_LISTED = 8;

export namespace RelationsMapCommands {
  // en labels are the source of truth; ru comes from i18n/ru/excalidraw.json
  // keyed by `ai-focused-editor/excalidraw/*`.
  export const GENERATE: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.entities.generateRelationsMap',
      label: 'Generate Relations Map...'
    },
    'ai-focused-editor/excalidraw/relations-map-generate'
  );
}

/**
 * Command + menu/toolbar entry that renders the entity co-occurrence graph into
 * an `.excalidraw` diagram at {@link RELATIONS_MAP_PATH}, with clickable nodes
 * that navigate to each entity's card (handled by the Excalidraw widget's
 * `onLinkOpen`). On a first run the file is created; on later runs the generated
 * layout is MERGED in — existing elements (including manual layout and the user's
 * own drawings) are preserved and only newly-appeared entities/edges are appended
 * below the current content. Removed entities are reported, never purged.
 */
@injectable()
export class RelationsMapContribution
  implements CommandContribution, MenuContribution, TabBarToolbarContribution {
  @inject(NarrativeGraphService)
  protected readonly graphService!: NarrativeGraphService;

  @inject(FileService)
  protected readonly fileService!: FileService;

  @inject(WorkspaceService)
  protected readonly workspaceService!: WorkspaceService;

  @inject(OpenerService)
  protected readonly openerService!: OpenerService;

  @inject(MessageService)
  protected readonly messageService!: MessageService;

  registerCommands(registry: CommandRegistry): void {
    registry.registerCommand(RelationsMapCommands.GENERATE, {
      execute: () => this.generate()
    });
  }

  registerMenus(menus: MenuModelRegistry): void {
    menus.registerMenuAction(AiFocusedEditorMenus.KNOWLEDGE, {
      commandId: RelationsMapCommands.GENERATE.id
    });
  }

  registerToolbarItems(registry: TabBarToolbarRegistry): void {
    // Cheap extension of the Narrative Map view's tab toolbar: the button shows
    // only when that view is the active widget.
    registry.registerItem({
      id: 'ai-focused-editor.entities.generateRelationsMap.toolbar',
      command: RelationsMapCommands.GENERATE.id,
      icon: 'codicon codicon-type-hierarchy',
      tooltip: nls.localize('ai-focused-editor/excalidraw/relations-map-generate', 'Generate Relations Map...'),
      isVisible: (widget: Widget) => widget instanceof NarrativeMapWidget
    });
  }

  protected async generate(): Promise<void> {
    const root = await this.getWorkspaceRoot();
    if (!root) {
      await this.messageService.warn(nls.localize(
        'ai-focused-editor/excalidraw/relations-map-no-workspace',
        'Open a manuscript workspace before generating the relations map.'
      ));
      return;
    }

    const snapshot = await this.graphService.getSnapshot();
    if (snapshot.nodes.length === 0) {
      await this.messageService.info(nls.localize(
        'ai-focused-editor/excalidraw/relations-map-empty',
        'No entities found to map yet. Tag entities in your chapters first.'
      ));
      return;
    }

    const module = await loadExcalidrawCanvasModule();
    const layout = layoutRelationsMap(snapshot);
    const targetUri = root.resolve(RELATIONS_MAP_PATH);
    const existingScene = await this.readScene(targetUri);
    const merge = mergeRelationsMap(existingScene.elements, layout);

    const edgeElements = this.buildElements(module, merge.added.edges.map(edge => this.edgeSkeleton(edge)));
    const nodeElements = this.buildElements(module, merge.added.nodes.map(node => this.nodeSkeleton(node)));
    this.ensureLinks(nodeElements, merge.added.nodes);

    // New arrows first (behind the node fills), then the node containers/labels.
    const elements = [...existingScene.elements, ...edgeElements, ...nodeElements];
    await this.writeScene(targetUri, {
      ...existingScene.scene,
      type: 'excalidraw',
      version: 2,
      source: 'ai-focused-editor',
      elements
    });

    await open(this.openerService, targetUri);
    await this.reportResult(merge.added.nodes.length, merge.added.edges.length, merge.missingFromBook);
  }

  protected nodeSkeleton(node: RelationsMapNodeSpec): Record<string, unknown> {
    return {
      type: 'rectangle',
      id: node.id,
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
      backgroundColor: KIND_BACKGROUND[node.kind] ?? DEFAULT_BACKGROUND,
      fillStyle: 'solid',
      roundness: { type: 3 },
      link: node.link,
      label: { text: node.label }
    };
  }

  protected edgeSkeleton(edge: RelationsMapEdgeSpec): Record<string, unknown> {
    const dx = edge.end.x - edge.start.x;
    const dy = edge.end.y - edge.start.y;
    return {
      type: 'arrow',
      id: edge.id,
      x: edge.start.x,
      y: edge.start.y,
      width: dx,
      height: dy,
      points: [[0, 0], [dx, dy]]
    };
  }

  /** Build real elements from skeletons, keeping the stable ids we provided. */
  protected buildElements(module: ExcalidrawCanvasModule, skeletons: Record<string, unknown>[]): Record<string, unknown>[] {
    if (skeletons.length === 0) {
      return [];
    }
    return module.convertToExcalidrawElements(skeletons, { regenerateIds: false }) as Record<string, unknown>[];
  }

  /**
   * Defensively re-assert `link` on each node container after conversion (the
   * skeleton carries it, but a bound-text child element must never receive it).
   */
  protected ensureLinks(elements: Record<string, unknown>[], nodes: RelationsMapNodeSpec[]): void {
    const linkById = new Map(nodes.map(node => [node.id, node.link]));
    for (const element of elements) {
      const link = linkById.get(element.id as string);
      if (link) {
        element.link = link;
      }
    }
  }

  protected async readScene(uri: URI): Promise<{ elements: MapElement[]; scene: Record<string, unknown> }> {
    try {
      const raw = (await this.fileService.read(uri)).value.trim();
      if (!raw) {
        return { elements: [], scene: {} };
      }
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const elements = Array.isArray(parsed.elements) ? (parsed.elements as MapElement[]) : [];
      return { elements, scene: parsed };
    } catch {
      // Missing or unparseable file — start from a blank scene.
      return { elements: [], scene: {} };
    }
  }

  protected async writeScene(uri: URI, scene: Record<string, unknown>): Promise<void> {
    const content = `${JSON.stringify(scene, undefined, 2)}\n`;
    if (await this.fileService.exists(uri)) {
      await this.fileService.write(uri, content);
    } else {
      await this.fileService.createFolder(uri.parent);
      await this.fileService.create(uri, content, { overwrite: false });
    }
  }

  protected async reportResult(addedNodes: number, addedEdges: number, missing: string[]): Promise<void> {
    let message = nls.localize(
      'ai-focused-editor/excalidraw/relations-map-done',
      'Relations map updated: added {0} nodes and {1} edges.',
      addedNodes,
      addedEdges
    );
    if (missing.length > 0) {
      const list = missing
        .slice(0, MAX_MISSING_LISTED)
        .map(id => id.replace(/^afe-map-node-/, ''))
        .join(', ');
      const suffix = missing.length > MAX_MISSING_LISTED
        ? nls.localize('ai-focused-editor/excalidraw/relations-map-missing-more', '{0} and {1} more', list, missing.length - MAX_MISSING_LISTED)
        : list;
      message += ' ' + nls.localize(
        'ai-focused-editor/excalidraw/relations-map-missing',
        'These mapped entities are no longer in the book (kept, not removed): {0}',
        suffix
      );
    }
    await this.messageService.info(message);
  }

  protected async getWorkspaceRoot(): Promise<URI | undefined> {
    await this.workspaceService.ready;
    const root = this.workspaceService.tryGetRoots()[0] ?? (await this.workspaceService.roots)[0];
    return root?.resource;
  }
}
