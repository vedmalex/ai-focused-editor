import { MenuContribution, MenuModelRegistry } from '@theia/core/lib/common';
import { nls } from '@theia/core/lib/common/nls';
import type { Widget } from '@theia/core/lib/browser';
import {
  TabBarToolbarContribution,
  TabBarToolbarRegistry
} from '@theia/core/lib/browser/shell/tab-bar-toolbar';
import { injectable } from '@theia/core/shared/inversify';
import { AiFocusedEditorMenus } from './ai-focused-editor-menu';
import { EntityCardsWidget } from './entity-cards-widget';
import { NarrativeMapWidget } from './narrative-map-widget';

/**
 * Two of "Check for Changes Now"'s four required entry points (TASK-022
 * UR-036 part 1, UR-037): the title-bar icon on Entity Cards and on the
 * Narrative Map, and the main-menu item. The other two — the status-bar
 * dialog's button and the command palette — are the command's OWN doing
 * (`@ai-focused-editor/narrative-knowledge`'s `NarrativeMemoryContribution`
 * registers the command itself; the palette follows from that registration
 * alone, no wiring needed here).
 *
 * WHY THIS LIVES HERE AND NOT IN `narrative-knowledge`. That package is
 * deliberately Theia-widget-agnostic below `src/browser` — it does not know
 * `EntityCardsWidget` or `NarrativeMapWidget` exist, and importing either
 * would mean `narrative-knowledge` depending on `manuscript-workspace`, the
 * exact reverse of the existing dependency (`manuscript-workspace` already
 * depends on `narrative-knowledge`, see `package.json`) — a cycle. So this
 * file references the command BY ITS STRING ID, never by importing the
 * `Command` object: `MenuModelRegistry.registerMenuAction` and
 * `TabBarToolbarRegistry.registerItem` both take a bare `commandId: string`,
 * and the command itself is already registered by the other package's own
 * `CommandContribution` by the time either fires. `nls.localize` needs no
 * import either — it resolves the SAME bundle key the command's own label
 * uses, so the button's tooltip and the palette entry read identically
 * without a second copy of the phrase.
 */
export namespace NarrativeMemoryCheckEntryPoints {
  export const CHECK_NOW_COMMAND_ID = 'ai-focused-editor.narrativeMemory.checkNow';
  export const CHECK_NOW_LABEL_KEY = 'ai-focused-editor/narrative-memory/command-check-now';
}

@injectable()
export class NarrativeMemoryCheckEntryPointsContribution
  implements MenuContribution, TabBarToolbarContribution {
  registerMenus(menus: MenuModelRegistry): void {
    menus.registerMenuAction(AiFocusedEditorMenus.KNOWLEDGE, {
      commandId: NarrativeMemoryCheckEntryPoints.CHECK_NOW_COMMAND_ID
    });
  }

  registerToolbarItems(registry: TabBarToolbarRegistry): void {
    const tooltip = nls.localize(NarrativeMemoryCheckEntryPoints.CHECK_NOW_LABEL_KEY, 'Check for Changes Now');
    // ONE COMMAND, TWO TOOLBAR REGISTRATIONS — one per widget it should show
    // on, following `RelationsMapContribution.registerToolbarItems`'s own
    // precedent of an `isVisible: widget instanceof X` guard rather than a
    // single item with an `instanceof` union, so each registration reads as
    // "this button belongs to this widget" on its own.
    registry.registerItem({
      id: `${NarrativeMemoryCheckEntryPoints.CHECK_NOW_COMMAND_ID}.entityCards.toolbar`,
      command: NarrativeMemoryCheckEntryPoints.CHECK_NOW_COMMAND_ID,
      icon: 'codicon codicon-sync',
      tooltip,
      isVisible: (widget: Widget) => widget instanceof EntityCardsWidget
    });
    registry.registerItem({
      id: `${NarrativeMemoryCheckEntryPoints.CHECK_NOW_COMMAND_ID}.narrativeMap.toolbar`,
      command: NarrativeMemoryCheckEntryPoints.CHECK_NOW_COMMAND_ID,
      icon: 'codicon codicon-sync',
      tooltip,
      isVisible: (widget: Widget) => widget instanceof NarrativeMapWidget
    });
  }
}
