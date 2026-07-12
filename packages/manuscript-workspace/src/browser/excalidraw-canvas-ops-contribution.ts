import {
  Command,
  CommandContribution,
  CommandRegistry,
  MenuContribution,
  MenuModelRegistry,
  MessageService
} from '@theia/core/lib/common';
import { nls } from '@theia/core/lib/common/nls';
import { ApplicationShell, QuickInputService, Widget } from '@theia/core/lib/browser';
import {
  TabBarToolbarContribution,
  TabBarToolbarRegistry
} from '@theia/core/lib/browser/shell/tab-bar-toolbar';
import { inject, injectable } from '@theia/core/shared/inversify';
import {
  ExcalidrawCanvasApi,
  ExcalidrawCanvasModule,
  ExcalidrawEditorWidget
} from './excalidraw-editor-widget';
import {
  CanvasElement,
  boundingBox,
  boxAround,
  chainArrows,
  mergeTextElements,
  splitTextByLines,
  stickyForText
} from '../common/excalidraw-canvas-ops';

/** Padding (px) around the selection when drawing the "Box Selected" rectangle. */
const BOX_PADDING = 16;

/** Padding (px) between a text element and its "Text to Sticky" wrapper. */
const STICKY_PADDING = 12;

/** Excalidraw's default sticky-note fill (its light-yellow background swatch). */
const STICKY_BACKGROUND = '#fff9db';

export namespace ExcalidrawCanvasCommands {
  // en labels are the source of truth; ru comes from i18n/ru/excalidraw.json
  // keyed by `ai-focused-editor/excalidraw/*`.
  export const SPLIT_TEXT: Command = Command.toLocalizedCommand(
    { id: 'ai-focused-editor.excalidraw.splitText', label: 'Split Text into Lines' },
    'ai-focused-editor/excalidraw/canvas-split-text'
  );
  export const MERGE_TEXT: Command = Command.toLocalizedCommand(
    { id: 'ai-focused-editor.excalidraw.mergeText', label: 'Merge Text Elements' },
    'ai-focused-editor/excalidraw/canvas-merge-text'
  );
  export const CONNECT_ARROW: Command = Command.toLocalizedCommand(
    { id: 'ai-focused-editor.excalidraw.connectArrow', label: 'Connect with Arrow' },
    'ai-focused-editor/excalidraw/canvas-connect-arrow'
  );
  export const BOX_SELECTED: Command = Command.toLocalizedCommand(
    { id: 'ai-focused-editor.excalidraw.boxSelected', label: 'Box Selected' },
    'ai-focused-editor/excalidraw/canvas-box-selected'
  );
  export const TEXT_TO_STICKY: Command = Command.toLocalizedCommand(
    { id: 'ai-focused-editor.excalidraw.textToSticky', label: 'Text to Sticky Note' },
    'ai-focused-editor/excalidraw/canvas-text-to-sticky'
  );
  /** Toolbar launcher: a quick pick of the canvas operations above. */
  export const CANVAS_ACTIONS: Command = Command.toLocalizedCommand(
    { id: 'ai-focused-editor.excalidraw.canvasActions', label: 'Canvas Actions...' },
    'ai-focused-editor/excalidraw/canvas-actions'
  );
}

/** Menu path for the "Canvas" grouping inside the Excalidraw editor context menu. */
export const EXCALIDRAW_CANVAS_MENU = ['excalidraw-editor-context-menu', 'canvas'];

/** Minimal shape of a real Excalidraw element the commands read for id + geometry. */
interface SceneElement extends CanvasElement {
  id: string;
  groupIds?: string[];
}

/**
 * "Canvas conveniences" — a small, tasteful set of selection-manipulation
 * commands for the active `.excalidraw` editor, inspired by the obsidian
 * excalidraw plugin's ea-scripts. Each command reads the widget's current
 * selection through its imperative API, computes the transform with the pure
 * helpers in `common/excalidraw-canvas-ops`, builds new elements via the module's
 * `convertToExcalidrawElements`, and pushes the result back with `updateScene`.
 */
@injectable()
export class ExcalidrawCanvasOpsContribution
  implements CommandContribution, MenuContribution, TabBarToolbarContribution {
  @inject(ApplicationShell)
  protected readonly shell!: ApplicationShell;

  @inject(MessageService)
  protected readonly messageService!: MessageService;

  @inject(QuickInputService)
  protected readonly quickInput!: QuickInputService;

  /** The ordered set of ops offered by the toolbar launcher (labels localize). */
  protected readonly ops: Array<{ command: Command; run: (w: ExcalidrawEditorWidget) => void }> = [];

  registerCommands(registry: CommandRegistry): void {
    const cmd = (command: Command, run: (widget: ExcalidrawEditorWidget) => void) =>
      registry.registerCommand(command, {
        execute: (widget?: unknown) => {
          const target = this.resolveWidget(widget);
          if (target) {
            run(target);
          }
        },
        isEnabled: (widget?: unknown) => !!this.resolveWidget(widget),
        isVisible: (widget?: unknown) => !!this.resolveWidget(widget)
      });

    this.ops.push(
      { command: ExcalidrawCanvasCommands.SPLIT_TEXT, run: w => this.splitText(w) },
      { command: ExcalidrawCanvasCommands.MERGE_TEXT, run: w => this.mergeText(w) },
      { command: ExcalidrawCanvasCommands.CONNECT_ARROW, run: w => this.connectArrow(w) },
      { command: ExcalidrawCanvasCommands.BOX_SELECTED, run: w => this.boxSelected(w) },
      { command: ExcalidrawCanvasCommands.TEXT_TO_STICKY, run: w => this.textToSticky(w) }
    );
    for (const op of this.ops) {
      cmd(op.command, op.run);
    }

    // A single toolbar launcher that offers the ops as a quick pick — the
    // Excalidraw canvas has no Theia context menu, so this is how the commands
    // reach the user without hunting the command palette.
    registry.registerCommand(ExcalidrawCanvasCommands.CANVAS_ACTIONS, {
      execute: (widget?: unknown) => {
        const target = this.resolveWidget(widget);
        if (target) {
          this.openActions(target);
        }
      },
      isEnabled: (widget?: unknown) => !!this.resolveWidget(widget),
      isVisible: (widget?: unknown) => !!this.resolveWidget(widget)
    });
  }

  registerToolbarItems(registry: TabBarToolbarRegistry): void {
    registry.registerItem({
      id: 'ai-focused-editor.excalidraw.canvasActions.toolbar',
      command: ExcalidrawCanvasCommands.CANVAS_ACTIONS.id,
      icon: 'codicon codicon-wand',
      tooltip: nls.localize('ai-focused-editor/excalidraw/canvas-actions', 'Canvas Actions...'),
      priority: 2,
      isVisible: (widget: Widget) => widget instanceof ExcalidrawEditorWidget
    });
  }

  protected async openActions(widget: ExcalidrawEditorWidget): Promise<void> {
    const picked = await this.quickInput.showQuickPick(
      this.ops.map(op => ({ label: op.command.label ?? op.command.id, op })),
      {
        placeholder: nls.localize(
          'ai-focused-editor/excalidraw/canvas-actions-placeholder',
          'Select a canvas operation for the current selection'
        )
      }
    );
    picked?.op.run(widget);
  }

  registerMenus(menus: MenuModelRegistry): void {
    menus.registerSubmenu(
      EXCALIDRAW_CANVAS_MENU,
      nls.localize('ai-focused-editor/excalidraw/canvas-menu', 'Canvas')
    );
    for (const command of [
      ExcalidrawCanvasCommands.SPLIT_TEXT,
      ExcalidrawCanvasCommands.MERGE_TEXT,
      ExcalidrawCanvasCommands.CONNECT_ARROW,
      ExcalidrawCanvasCommands.BOX_SELECTED,
      ExcalidrawCanvasCommands.TEXT_TO_STICKY
    ]) {
      menus.registerMenuAction(EXCALIDRAW_CANVAS_MENU, { commandId: command.id });
    }
  }

  /** Active/current shell widget, if it is an Excalidraw editor. */
  protected resolveWidget(candidate?: unknown): ExcalidrawEditorWidget | undefined {
    if (candidate instanceof ExcalidrawEditorWidget) {
      return candidate;
    }
    const active = this.shell.activeWidget ?? this.shell.currentWidget;
    return active instanceof ExcalidrawEditorWidget ? active : undefined;
  }

  /** Resolve the imperative API + convert helper, or warn if the scene isn't ready. */
  protected context(widget: ExcalidrawEditorWidget): { api: ExcalidrawCanvasApi; module: ExcalidrawCanvasModule } | undefined {
    const api = widget.getApi();
    const module = widget.getCanvasModule();
    if (!api || !module) {
      void this.messageService.warn(nls.localize(
        'ai-focused-editor/excalidraw/canvas-not-ready',
        'The diagram is still loading; try again in a moment.'
      ));
      return undefined;
    }
    return { api, module };
  }

  /** All scene elements paired with the subset the user has selected (in scene order). */
  protected readSelection(api: ExcalidrawCanvasApi): { all: SceneElement[]; selected: SceneElement[] } {
    const all = api.getSceneElements() as unknown as SceneElement[];
    const appState = api.getAppState();
    const selectedIds = (appState.selectedElementIds as Record<string, boolean> | undefined) ?? {};
    const selected = all.filter(el => selectedIds[el.id]);
    return { all, selected };
  }

  protected isText(el: SceneElement): boolean {
    return el.type === 'text';
  }

  protected warnSelection(message: string): void {
    void this.messageService.warn(message);
  }

  /** Build real elements from skeletons, tagging them so their ids can be reselected. */
  protected build(module: ExcalidrawCanvasModule, skeletons: Record<string, unknown>[]): SceneElement[] {
    return module.convertToExcalidrawElements(skeletons) as unknown as SceneElement[];
  }

  /** Commit a new scene and set the selection to the given element ids. */
  protected commit(api: ExcalidrawCanvasApi, elements: SceneElement[], selectIds: string[]): void {
    const selectedElementIds: Record<string, true> = {};
    for (const id of selectIds) {
      selectedElementIds[id] = true;
    }
    api.updateScene({ elements, appState: { selectedElementIds } });
  }

  protected randomGroupId(): string {
    const globalCrypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (globalCrypto?.randomUUID) {
      return `afe-group-${globalCrypto.randomUUID()}`;
    }
    return `afe-group-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  }

  // --- Commands -------------------------------------------------------------

  /** Split each selected text element into one text element per line. */
  protected splitText(widget: ExcalidrawEditorWidget): void {
    const ctx = this.context(widget);
    if (!ctx) {
      return;
    }
    const { all, selected } = this.readSelection(ctx.api);
    const texts = selected.filter(el => this.isText(el));
    if (texts.length === 0) {
      this.warnSelection(nls.localize(
        'ai-focused-editor/excalidraw/canvas-need-text',
        'Select at least one text element first.'
      ));
      return;
    }
    const skeletons: Record<string, unknown>[] = [];
    for (const el of texts) {
      for (const line of splitTextByLines(el)) {
        // Skip blank lines: an empty text element would be invisible clutter.
        if (line.text.trim() === '') {
          continue;
        }
        skeletons.push(this.textSkeleton(line.text, line.x, line.y, el));
      }
    }
    if (skeletons.length === 0) {
      return;
    }
    const removed = new Set(texts.map(el => el.id));
    const created = this.build(ctx.module, skeletons);
    const next = [...all.filter(el => !removed.has(el.id)), ...created];
    this.commit(ctx.api, next, created.map(el => el.id));
  }

  /** Merge the selected text elements into one multi-line text element. */
  protected mergeText(widget: ExcalidrawEditorWidget): void {
    const ctx = this.context(widget);
    if (!ctx) {
      return;
    }
    const { all, selected } = this.readSelection(ctx.api);
    const texts = selected.filter(el => this.isText(el));
    if (texts.length < 2) {
      this.warnSelection(nls.localize(
        'ai-focused-editor/excalidraw/canvas-need-two-text',
        'Select at least two text elements to merge.'
      ));
      return;
    }
    const merged = mergeTextElements(texts);
    if (!merged) {
      return;
    }
    const removed = new Set(texts.map(el => el.id));
    const created = this.build(ctx.module, [this.textSkeleton(merged.text, merged.x, merged.y, texts[0])]);
    const next = [...all.filter(el => !removed.has(el.id)), ...created];
    this.commit(ctx.api, next, created.map(el => el.id));
  }

  /** Chain center-to-center arrows through the selected non-arrow elements. */
  protected connectArrow(widget: ExcalidrawEditorWidget): void {
    const ctx = this.context(widget);
    if (!ctx) {
      return;
    }
    const { all, selected } = this.readSelection(ctx.api);
    const nodes = selected.filter(el => el.type !== 'arrow' && el.type !== 'line');
    if (nodes.length < 2) {
      this.warnSelection(nls.localize(
        'ai-focused-editor/excalidraw/canvas-need-two-nodes',
        'Select at least two elements to connect with arrows.'
      ));
      return;
    }
    const skeletons = chainArrows(nodes).map(({ start, end }) => ({
      type: 'arrow',
      x: start.x,
      y: start.y,
      width: end.x - start.x,
      height: end.y - start.y,
      points: [[0, 0], [end.x - start.x, end.y - start.y]]
    } as Record<string, unknown>));
    const created = this.build(ctx.module, skeletons);
    const next = [...all, ...created];
    this.commit(ctx.api, next, created.map(el => el.id));
  }

  /** Wrap the selection's bounding box in a transparent rectangle, grouped with it. */
  protected boxSelected(widget: ExcalidrawEditorWidget): void {
    const ctx = this.context(widget);
    if (!ctx) {
      return;
    }
    const { all, selected } = this.readSelection(ctx.api);
    if (selected.length === 0) {
      this.warnSelection(nls.localize(
        'ai-focused-editor/excalidraw/canvas-need-selection',
        'Select one or more elements first.'
      ));
      return;
    }
    const box = boxAround(boundingBox(selected), BOX_PADDING);
    const [rect] = this.build(ctx.module, [{
      type: 'rectangle',
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      backgroundColor: 'transparent',
      fillStyle: 'solid'
    }]);
    const groupId = this.randomGroupId();
    rect.groupIds = [...(rect.groupIds ?? []), groupId];
    const selectedIds = new Set(selected.map(el => el.id));
    // Rectangle first (bottom of z-order = behind the selection); grouped members
    // get the shared groupId appended.
    const next: SceneElement[] = [rect, ...all.map(el =>
      selectedIds.has(el.id)
        ? { ...el, groupIds: [...(el.groupIds ?? []), groupId] }
        : el
    )];
    this.commit(ctx.api, next, [rect.id, ...selected.map(el => el.id)]);
  }

  /** Wrap each selected text element in a rounded sticky-note rectangle. */
  protected textToSticky(widget: ExcalidrawEditorWidget): void {
    const ctx = this.context(widget);
    if (!ctx) {
      return;
    }
    const { all, selected } = this.readSelection(ctx.api);
    const texts = selected.filter(el => this.isText(el));
    if (texts.length === 0) {
      this.warnSelection(nls.localize(
        'ai-focused-editor/excalidraw/canvas-need-text',
        'Select at least one text element first.'
      ));
      return;
    }
    const stickies: SceneElement[] = [];
    const groupByText = new Map<string, string>();
    for (const el of texts) {
      const { rect } = stickyForText(el, STICKY_PADDING);
      const [built] = this.build(ctx.module, [{
        type: 'rectangle',
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        backgroundColor: STICKY_BACKGROUND,
        fillStyle: 'solid',
        roundness: { type: 3 }
      }]);
      const groupId = this.randomGroupId();
      built.groupIds = [...(built.groupIds ?? []), groupId];
      groupByText.set(el.id, groupId);
      stickies.push(built);
    }
    // Each sticky sits just behind its text; grouped so they move together.
    const next: SceneElement[] = [
      ...stickies,
      ...all.map(el => {
        const groupId = groupByText.get(el.id);
        return groupId ? { ...el, groupIds: [...(el.groupIds ?? []), groupId] } : el;
      })
    ];
    this.commit(ctx.api, next, [...stickies.map(el => el.id), ...texts.map(el => el.id)]);
  }

  /** Text-element skeleton carrying the styling worth preserving from a source. */
  protected textSkeleton(text: string, x: number, y: number, source: SceneElement): Record<string, unknown> {
    const skeleton: Record<string, unknown> = { type: 'text', x, y, text };
    if (typeof source.fontSize === 'number') {
      skeleton.fontSize = source.fontSize;
    }
    if (typeof source.textAlign === 'string') {
      skeleton.textAlign = source.textAlign;
    }
    if (typeof source.strokeColor === 'string') {
      skeleton.strokeColor = source.strokeColor;
    }
    return skeleton;
  }
}
