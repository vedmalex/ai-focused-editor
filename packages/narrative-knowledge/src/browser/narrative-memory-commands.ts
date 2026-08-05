import { Command } from '@theia/core/lib/common/command';
import { NARRATIVE_MEMORY_NLS_PREFIX } from '../common';

/**
 * The commands of WP-5, plus "Check for Changes Now" (TASK-022 UR-036/UR-037).
 *
 * THE IDS ARE IN THE `ai-focused-editor.` NAMESPACE, and that is not cosmetic:
 * `extract-feature-inventory.mjs` filters every harvested `id:` literal through
 * `INVENTORY_NAMESPACES` (`ai-focused-editor.`, `ai-connect.`) and silently
 * drops everything else. A `narrativeMemory.rebuildIndex` id would never enter
 * the inventory, so `docs:drift` would report full coverage of a documentation
 * set that omits both commands — green because it is looking away, which is
 * exactly the gate-vacuity failure plan R-9 is about.
 *
 * ALL THREE ARE `toLocalizedCommand`, so the palette shows Russian. The keys
 * resolve through this package's own bundle (WP-5), not the manuscript
 * workspace's — prohibition (f) forbids importing that package at all.
 */
export namespace NarrativeMemoryCommands {
  export const REBUILD_INDEX: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.narrativeMemory.rebuildIndex',
      category: 'Narrative Memory',
      label: 'Rebuild Index'
    },
    `${NARRATIVE_MEMORY_NLS_PREFIX}/command-rebuild`,
    `${NARRATIVE_MEMORY_NLS_PREFIX}/command-category`
  );

  export const SHOW_INDEX_STATUS: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.narrativeMemory.showIndexStatus',
      category: 'Narrative Memory',
      label: 'Show Index Status'
    },
    `${NARRATIVE_MEMORY_NLS_PREFIX}/command-show-status`,
    `${NARRATIVE_MEMORY_NLS_PREFIX}/command-category`
  );

  /**
   * The cheap, on-demand sweep (UR-036 part 1) — NOT a synonym for
   * `REBUILD_INDEX`. See {@link NarrativeKnowledgeService.checkForChanges}'s
   * doc comment for why the two commands stay separate.
   */
  export const CHECK_FOR_CHANGES: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.narrativeMemory.checkNow',
      category: 'Narrative Memory',
      label: 'Check for Changes Now'
    },
    `${NARRATIVE_MEMORY_NLS_PREFIX}/command-check-now`,
    `${NARRATIVE_MEMORY_NLS_PREFIX}/command-category`
  );
}
