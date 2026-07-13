import { MenuContribution, MenuModelRegistry } from '@theia/core/lib/common';
import { injectable } from '@theia/core/shared/inversify';
import {
  AiDebugCommands,
  AiRotationCommands,
  ModelConfigCommands
} from '@ai-focused-editor/ai-connect-theia/lib/browser';
import { AiFocusedEditorMenus } from './ai-focused-editor-menu';

/**
 * Places the reusable ai-connect package's commands into the product-specific
 * Manuscript menu. The package registers the commands + views but deliberately
 * ships no application-menu placement, so the host owns this mapping. The
 * placements below reproduce exactly what the moved contributions registered
 * before the extraction (same menu paths + orders).
 */
@injectable()
export class AiConnectMenuContribution implements MenuContribution {
  registerMenus(menus: MenuModelRegistry): void {
    // Live rotation (top of the AI section).
    menus.registerMenuAction(AiFocusedEditorMenus.MAIN, {
      commandId: AiRotationCommands.SWITCH_ALIAS.id,
      order: '1_rotation_a'
    });
    menus.registerMenuAction(AiFocusedEditorMenus.MAIN, {
      commandId: AiRotationCommands.SWITCH_ENDPOINT.id,
      order: '1_rotation_b'
    });
    // Model Config view.
    menus.registerMenuAction(AiFocusedEditorMenus.MAIN, {
      commandId: ModelConfigCommands.OPEN.id
    });
    menus.registerMenuAction(AiFocusedEditorMenus.MAIN, {
      commandId: ModelConfigCommands.REFRESH.id
    });
    // AI Debug view.
    menus.registerMenuAction(AiFocusedEditorMenus.AI_DEBUG, {
      commandId: AiDebugCommands.OPEN.id
    });
    menus.registerMenuAction(AiFocusedEditorMenus.AI_DEBUG, {
      commandId: AiDebugCommands.REFRESH.id
    });
    menus.registerMenuAction(AiFocusedEditorMenus.AI_DEBUG, {
      commandId: AiDebugCommands.COPY_SNAPSHOT.id
    });
  }
}
