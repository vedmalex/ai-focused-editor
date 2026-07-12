import URI from '@theia/core/lib/common/uri';
import { MessageService } from '@theia/core/lib/common';
import {
  inject,
  injectable,
  postConstruct
} from '@theia/core/shared/inversify';
import {
  ContextMenuRenderer,
  open,
  OpenerService
} from '@theia/core/lib/browser';
import {
  NodeProps,
  TreeModel,
  TreeProps,
  TreeWidget
} from '@theia/core/lib/browser/tree';
import type { TreeNode } from '@theia/core/lib/browser/tree';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { BinaryBuffer } from '@theia/core/lib/common/buffer';
import React from '@theia/core/shared/react';
import type {
  ManuscriptMoveTarget,
  ManuscriptWorkspaceSnapshot
} from '../common';
import {
  AuthorMaterialsSectionGroupTreeNode,
  AuthorMaterialsSectionTreeNode,
  AuthorMaterialTreeNode,
  ManuscriptTreeNode
} from './manuscript-tree';
import { ManuscriptTreeModel } from './manuscript-tree-model';

const MANUSCRIPT_PATH_DATA_KEY = 'application/x-afe-manuscript-path';

@injectable()
export class ManuscriptTreeWidget extends TreeWidget {
  static readonly ID = 'ai-focused-editor.manuscript-tree';
  static readonly LABEL = 'Manuscript';
  static readonly CONTEXT_MENU = ['ai-focused-editor-manuscript-tree'];

  @inject(OpenerService)
  protected readonly openerService!: OpenerService;

  @inject(MessageService)
  protected readonly messages!: MessageService;

  @inject(FileService)
  protected readonly fileService!: FileService;

  protected dropTargetElement: HTMLElement | undefined;

  constructor(
    @inject(TreeProps) props: TreeProps,
    @inject(TreeModel) model: ManuscriptTreeModel,
    @inject(ContextMenuRenderer) contextMenuRenderer: ContextMenuRenderer
  ) {
    super(props, model, contextMenuRenderer);
  }

  @postConstruct()
  protected override init(): void {
    super.init();
    this.id = ManuscriptTreeWidget.ID;
    this.title.label = ManuscriptTreeWidget.LABEL;
    this.title.caption = 'Manifest-backed manuscript content';
    this.title.iconClass = 'fa fa-book';
    this.title.closable = true;
    this.toDispose.push(this.model.onOpenNode(node => this.openManuscriptNode(node)));
  }

  protected async openManuscriptNode(node: Readonly<TreeNode>): Promise<void> {
    if (ManuscriptTreeNode.isFile(node) && node.manuscript.uri) {
      await open(this.openerService, new URI(node.manuscript.uri));
      return;
    }
    if (AuthorMaterialTreeNode.is(node) && node.materialUri) {
      const uri = new URI(node.materialUri);
      // The entities/types.yaml leaf seeds the file on first open so clicking it
      // always lands in a real editor (rather than failing on a missing file).
      if (node.createSeed !== undefined) {
        await this.ensureFileExists(uri, node.createSeed);
      }
      await open(this.openerService, uri);
    }
  }

  /** Create `uri` with `seed` content when it does not yet exist (best effort). */
  protected async ensureFileExists(uri: URI, seed: string): Promise<void> {
    try {
      if (await this.fileService.exists(uri)) {
        return;
      }
      await this.fileService.createFile(uri, BinaryBuffer.fromString(seed), { overwrite: false });
    } catch {
      // A racing create or a permission error: fall through and let `open` report.
    }
  }

  refreshWorkspace(): Promise<ManuscriptWorkspaceSnapshot> {
    return this.manuscriptModel.refreshWorkspace();
  }

  get manuscriptModel(): ManuscriptTreeModel {
    return this.model as ManuscriptTreeModel;
  }

  /**
   * The base TreeWidget renders NO icon; surface the label-provider icons
   * (codicons with per-kind accents) like FileTreeWidget does.
   */
  protected override renderIcon(node: TreeNode, _props: NodeProps): React.ReactNode {
    const icon = this.toNodeIcon(node);
    if (icon) {
      return React.createElement('div', { className: `${icon} afe-tree-icon` });
    }
    // eslint-disable-next-line no-null/no-null
    return null;
  }

  protected override createNodeClassNames(node: TreeNode, props: NodeProps): string[] {
    const classNames = super.createNodeClassNames(node, props);
    if (ManuscriptTreeNode.is(node) && !node.manuscript.buildIncluded) {
      classNames.push('afe-manuscript-excluded');
    }
    if (AuthorMaterialsSectionTreeNode.is(node) || AuthorMaterialsSectionGroupTreeNode.is(node)) {
      classNames.push('afe-tree-section');
    }
    return classNames;
  }

  /**
   * Render the material item's secondary text (entity/citation id, source or
   * knowledge path) as a muted suffix after the label.
   */
  protected override renderTailDecorations(node: TreeNode, props: NodeProps): React.ReactNode {
    const tail = super.renderTailDecorations(node, props);
    const description = AuthorMaterialTreeNode.is(node) ? node.description : undefined;
    if (!description) {
      return tail;
    }
    return React.createElement(
      React.Fragment,
      undefined,
      tail,
      React.createElement('span', { className: 'afe-tree-item-description' }, description)
    );
  }

  protected override createNodeAttributes(node: TreeNode, props: NodeProps): React.Attributes & React.HTMLAttributes<HTMLElement> {
    return {
      ...super.createNodeAttributes(node, props),
      draggable: ManuscriptTreeNode.is(node),
      onDragStart: (event: React.DragEvent) => this.handleDragStartEvent(node, event),
      onDragEnter: (event: React.DragEvent) => this.handleDragEnterEvent(node, event),
      onDragOver: (event: React.DragEvent) => this.handleDragOverEvent(node, event),
      onDragLeave: (event: React.DragEvent) => this.handleDragLeaveEvent(event),
      onDrop: (event: React.DragEvent) => { void this.handleDropEvent(node, event); }
    };
  }

  protected override createContainerAttributes(): React.HTMLAttributes<HTMLElement> {
    const attrs = super.createContainerAttributes();
    return {
      ...attrs,
      onDragEnter: (event: React.DragEvent) => this.handleDragEnterEvent(undefined, event),
      onDragOver: (event: React.DragEvent) => this.handleDragOverEvent(undefined, event),
      onDragLeave: (event: React.DragEvent) => this.handleDragLeaveEvent(event),
      onDrop: (event: React.DragEvent) => { void this.handleDropEvent(undefined, event); }
    };
  }

  protected handleDragStartEvent(node: TreeNode, event: React.DragEvent): void {
    event.stopPropagation();
    if (!ManuscriptTreeNode.is(node) || !event.dataTransfer) {
      return;
    }
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(MANUSCRIPT_PATH_DATA_KEY, node.manuscript.path);
    event.dataTransfer.setData('text/plain', node.manuscript.path);
  }

  protected handleDragEnterEvent(node: TreeNode | undefined, event: React.DragEvent): void {
    if (!event.dataTransfer?.types.includes(MANUSCRIPT_PATH_DATA_KEY)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.markDropTarget(event.currentTarget as HTMLElement, node);
  }

  protected handleDragOverEvent(node: TreeNode | undefined, event: React.DragEvent): void {
    if (!event.dataTransfer?.types.includes(MANUSCRIPT_PATH_DATA_KEY)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
  }

  protected handleDragLeaveEvent(event: React.DragEvent): void {
    if ((event.currentTarget as HTMLElement) === this.dropTargetElement) {
      this.clearDropTarget();
    }
  }

  protected async handleDropEvent(node: TreeNode | undefined, event: React.DragEvent): Promise<void> {
    const sourcePath = event.dataTransfer?.getData(MANUSCRIPT_PATH_DATA_KEY);
    this.clearDropTarget();
    if (!sourcePath) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();

    const target = this.resolveDropTarget(node, sourcePath);
    if (!target) {
      return;
    }

    const result = await this.manuscriptModel.moveEntry(sourcePath, target);
    if (!result.ok) {
      this.messages.warn(`Move failed: ${result.message ?? 'unknown error'}`);
    }
  }

  /**
   * Drop on a folder appends inside it; drop on a file inserts before that file
   * within its parent; drop on the Manuscript section header or empty space
   * appends to the manifest root list. Non-manuscript sections and material
   * leaves reject drops so author-materials nodes are never move targets.
   */
  protected resolveDropTarget(node: TreeNode | undefined, sourcePath: string): ManuscriptMoveTarget | undefined {
    if (ManuscriptTreeNode.isFolder(node)) {
      if (node.manuscript.path === sourcePath) {
        return undefined;
      }
      return {
        parentPath: node.manuscript.path,
        index: node.children.length
      };
    }

    if (ManuscriptTreeNode.isFile(node)) {
      if (node.manuscript.path === sourcePath) {
        return undefined;
      }
      const parent = node.parent;
      const parentPath = ManuscriptTreeNode.isFolder(parent) ? parent.manuscript.path : undefined;
      return {
        parentPath,
        index: node.manuscript.order
      };
    }

    // Reject drops onto the entities group, non-manuscript sections and material
    // leaves — only the Manuscript section/tree accepts manuscript moves.
    if (AuthorMaterialTreeNode.is(node)
      || AuthorMaterialsSectionGroupTreeNode.is(node)
      || (AuthorMaterialsSectionTreeNode.is(node) && !AuthorMaterialsSectionTreeNode.isManuscript(node))) {
      return undefined;
    }

    // Manuscript section header or empty container space appends to root.
    const rootChildren = this.manuscriptModel.snapshot?.content.length ?? 0;
    return {
      parentPath: undefined,
      index: rootChildren
    };
  }

  protected markDropTarget(element: HTMLElement, node: TreeNode | undefined): void {
    this.clearDropTarget();
    if (node === undefined || ManuscriptTreeNode.is(node) || AuthorMaterialsSectionTreeNode.isManuscript(node)) {
      this.dropTargetElement = element;
      element.classList.add('afe-drop-target');
    }
  }

  protected clearDropTarget(): void {
    if (this.dropTargetElement) {
      this.dropTargetElement.classList.remove('afe-drop-target');
      this.dropTargetElement = undefined;
    }
  }
}
