/**
 * Shell wiring for the contextual card (gh#47 WP-5).
 *
 * THE TWO THINGS THAT MUST BOTH BE PRESENT, AND WERE BOTH MISSING ONCE (UR-039):
 *
 *  1. `initializeLayout` — in Theia a view reaches the side panel only after its
 *     open command has run once. Without this the panel has no icon there at
 *     all, and everything else can be perfectly built and still unreachable.
 *  2. A `FrontendApplicationContribution` BINDING for this class.
 *     `bindViewContribution` does not add one, and `createDefaultLayout()` calls
 *     `initializeLayout` only on instances bound that way — so a correctly
 *     written method silently never runs without it.
 *
 * Both were absent for Entity Cards, which is why every machine lane was green
 * while the author could not find the panel: the smokes invoked commands through
 * the registry, so they proved a panel CAN BE OPENED and never that it CAN BE
 * FOUND. The binding lives in `manuscript-workspace-frontend-module.ts`.
 */

import { Command, CommandRegistry, MenuModelRegistry } from '@theia/core/lib/common';
import { nls } from '@theia/core/lib/common/nls';
import { inject, injectable } from '@theia/core/shared/inversify';
import { AbstractViewContribution } from '@theia/core/lib/browser/shell/view-contribution';
import { StorageService } from '@theia/core/lib/browser/storage-service';
import type { FrontendApplication, FrontendApplicationContribution } from '@theia/core/lib/browser';
import { EntityCardWidget } from './entity-card-widget';
import { AiFocusedEditorMenus } from './ai-focused-editor-menu';
import { ensurePanelMigrated } from './layout-panel-migration';

export namespace EntityCardCommands {
  export const OPEN: Command = Command.toLocalizedCommand(
    { id: 'ai-focused-editor.entities.openCard', label: 'AI Focused Editor: Open Knowledge Card' },
    'ai-focused-editor/entities/open-card'
  );

  export const PIN: Command = Command.toLocalizedCommand(
    { id: 'ai-focused-editor.entities.pinCard', label: 'AI Focused Editor: Pin Current Knowledge Card' },
    'ai-focused-editor/entities/pin-card'
  );
}

@injectable()
export class EntityCardViewContribution extends AbstractViewContribution<EntityCardWidget>
  implements FrontendApplicationContribution {
  @inject(StorageService)
  protected readonly storageService!: StorageService;

  constructor() {
    super({
      widgetId: EntityCardWidget.ID,
      widgetName: EntityCardWidget.LABEL,
      // Directly above the list panel (rank 220): the contextual card is what
      // the author reads WHILE writing, the inventory is what they consult
      // deliberately.
      defaultWidgetOptions: { area: 'right', rank: 210 },
      toggleCommandId: EntityCardCommands.OPEN.id
    });
  }

  /** Present, not opened — see `EntityCardsViewContribution` for the full
   *  rationale behind `activate: false, reveal: false`. */
  async initializeLayout(_app: FrontendApplication): Promise<void> {
    await this.openView({ activate: false, reveal: false });
  }

  /**
   * UR-040 backfill. A workspace whose saved layout predates this panel restores
   * that older layout successfully, so `initializeLayout` never runs for it and
   * the panel would be invisible there forever. Gated by a persisted marker so
   * it happens at most once — a panel the author then closes stays closed.
   */
  async onDidInitializeLayout(_app: FrontendApplication): Promise<void> {
    await ensurePanelMigrated(
      this.storageService,
      'ai-focused-editor.entityCard.layoutMigrationVersion',
      () => this.openView({ activate: false, reveal: false })
    );
  }

  override registerCommands(commands: CommandRegistry): void {
    super.registerCommands(commands);
    commands.registerCommand(EntityCardCommands.PIN, {
      execute: async () => {
        const widget = await this.openView({ activate: false, reveal: true });
        widget.togglePin();
      }
    });
  }

  override registerMenus(menus: MenuModelRegistry): void {
    super.registerMenus(menus);
    menus.registerMenuAction(AiFocusedEditorMenus.KNOWLEDGE, { commandId: EntityCardCommands.OPEN.id });
    menus.registerMenuAction(AiFocusedEditorMenus.KNOWLEDGE, { commandId: EntityCardCommands.PIN.id });
  }
}

/** Exported for the shell-presence check, which reads the id BEFORE any open
 *  command runs — the only way to tell "present" from "openable". */
export const ENTITY_CARD_VIEW_ID = EntityCardWidget.ID;

/** The label the shell shows; kept beside the id for the same check. */
export const ENTITY_CARD_VIEW_LABEL = nls.localize('ai-focused-editor/entities/card-title', EntityCardWidget.LABEL);
