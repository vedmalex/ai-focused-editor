import {
  Command,
  CommandContribution,
  CommandRegistry,
  CommandService,
  MenuContribution,
  MenuModelRegistry,
  MessageService
} from '@theia/core/lib/common';
import { nls } from '@theia/core/lib/common/nls';
import { QuickInputService, QuickPickItem } from '@theia/core/lib/browser';
import { inject, injectable } from '@theia/core/shared/inversify';
import { AISettingsService, GenericCapabilitySelections } from '@theia/ai-core';
import { AiFocusedEditorMenus } from './ai-focused-editor-menu';

/**
 * The chat agent whose per-agent generic-capability selections these presets
 * write. MUST match the id the Manuscript agent registers with in
 * {@link ManuscriptChatAgentContribution} — the chat input widget keys its saved
 * `genericCapabilitySelections` by this agent id (see
 * @theia/ai-chat-ui `chat-input-widget` → `AISettingsService`).
 */
const MANUSCRIPT_AGENT_ID = 'ai-focused-editor.manuscript';

/**
 * The command that opens/focuses the chat view, so a power user can reach the
 * fine-grained «Общие возможности» capability tree. Defined by
 * @theia/ai-chat-ui (`AI_CHAT_TOGGLE_COMMAND_ID`).
 */
const AI_CHAT_TOGGLE_COMMAND_ID = 'aiChat:toggle';

export const CHAT_CAPABILITY_PRESET_COMMAND: Command = Command.toLocalizedCommand(
  {
    id: 'ai-focused-editor.chat.capabilityPreset',
    label: 'Chat Capabilities Preset...',
    category: 'AI Focused Editor'
  },
  'ai-focused-editor/chat-capabilities/command',
  'ai-focused-editor/workspace/category'
);

/**
 * A named, author-friendly bundle of generic capabilities for the Manuscript
 * chat agent. `selections` are written verbatim to the agent's saved
 * `genericCapabilitySelections`; an empty object clears all additional
 * selections (only the agent's baked-in prompt capabilities remain).
 *
 * Variable selections are keyed by variable NAME and function selections by
 * tool id — matching how @theia/ai-chat-ui's generic-capabilities service
 * enumerates them (`variable.name` and `fn.id` respectively).
 */
interface CapabilityPreset {
  id: string;
  label: string;
  detail: string;
  selections: GenericCapabilitySelections;
}

@injectable()
export class ChatCapabilityPresetsContribution implements CommandContribution, MenuContribution {
  @inject(AISettingsService)
  protected readonly aiSettings!: AISettingsService;

  @inject(QuickInputService)
  protected readonly quickInput!: QuickInputService;

  @inject(MessageService)
  protected readonly messages!: MessageService;

  @inject(CommandService)
  protected readonly commands!: CommandService;

  registerCommands(registry: CommandRegistry): void {
    registry.registerCommand(CHAT_CAPABILITY_PRESET_COMMAND, {
      execute: () => this.pickPreset()
    });
  }

  registerMenus(menus: MenuModelRegistry): void {
    menus.registerMenuAction(AiFocusedEditorMenus.AI_MODES, {
      commandId: CHAT_CAPABILITY_PRESET_COMMAND.id,
      order: '9_capability-presets'
    });
  }

  /** Author-facing presets, described in plain language (no variable tokens). */
  protected presets(): CapabilityPreset[] {
    return [
      {
        id: 'minimum',
        label: nls.localize('ai-focused-editor/chat-capabilities/preset-minimum', 'Minimum — manuscript only'),
        detail: nls.localize(
          'ai-focused-editor/chat-capabilities/preset-minimum-detail',
          'Only the agent\'s built-in manuscript capabilities. No extra project context.'
        ),
        selections: {}
      },
      {
        id: 'book-world',
        label: nls.localize('ai-focused-editor/chat-capabilities/preset-book-world', 'Book world'),
        detail: nls.localize(
          'ai-focused-editor/chat-capabilities/preset-book-world-detail',
          'Adds the entity catalogue and the current entity to the chat context.'
        ),
        selections: { variables: ['entities', 'entity'] }
      },
      {
        id: 'research',
        label: nls.localize('ai-focused-editor/chat-capabilities/preset-research', 'Research'),
        detail: nls.localize(
          'ai-focused-editor/chat-capabilities/preset-research-detail',
          'Adds research sources, the outline, and the entity catalogue.'
        ),
        selections: { variables: ['sources', 'outline', 'entities'] }
      },
      {
        id: 'everything',
        label: nls.localize('ai-focused-editor/chat-capabilities/preset-everything', 'Everything for the book'),
        detail: nls.localize(
          'ai-focused-editor/chat-capabilities/preset-everything-detail',
          'All manuscript context variables plus the entity-search, chapter-list, and chapter-read tools.'
        ),
        selections: {
          variables: ['manuscript', 'chapter', 'entity', 'entities', 'sources', 'outline'],
          functions: ['manuscript_find_entities', 'manuscript_list_chapters', 'manuscript_get_chapter']
        }
      }
    ];
  }

  protected async pickPreset(): Promise<void> {
    const presets = this.presets();
    const current = await this.currentSelections();
    const matchingId = presets.find(preset => selectionsEqual(preset.selections, current))?.id;

    const openPanelId = '__open-panel__';
    const items: (QuickPickItem & { presetId?: string })[] = presets.map(preset => ({
      presetId: preset.id,
      label: preset.label,
      detail: preset.detail,
      iconClasses: preset.id === matchingId ? ['codicon', 'codicon-check'] : undefined,
      description:
        preset.id === matchingId
          ? nls.localize('ai-focused-editor/chat-capabilities/current-selection', '(current selection)')
          : undefined
    }));
    items.push({
      presetId: openPanelId,
      label: nls.localize('ai-focused-editor/chat-capabilities/open-panel', 'Open the fine-tuning panel...'),
      detail: nls.localize(
        'ai-focused-editor/chat-capabilities/open-panel-detail',
        'Opens the chat view where you can tick individual capabilities in «Generic Capabilities».'
      ),
      iconClasses: ['codicon', 'codicon-settings-gear']
    });

    const picked = await this.quickInput.showQuickPick(items, {
      title: nls.localize('ai-focused-editor/chat-capabilities/title', 'AI Chat Capabilities'),
      placeholder: nls.localize(
        'ai-focused-editor/chat-capabilities/placeholder',
        'Pick what the Manuscript chat agent may use'
      )
    });
    if (!picked || !picked.presetId) {
      return;
    }
    if (picked.presetId === openPanelId) {
      await this.commands.executeCommand(AI_CHAT_TOGGLE_COMMAND_ID);
      return;
    }

    const preset = presets.find(candidate => candidate.id === picked.presetId);
    if (!preset) {
      return;
    }
    await this.applyPreset(preset);
  }

  protected async applyPreset(preset: CapabilityPreset): Promise<void> {
    try {
      await this.aiSettings.updateAgentSettings(MANUSCRIPT_AGENT_ID, {
        genericCapabilitySelections: GenericCapabilitySelections.hasSelections(preset.selections)
          ? preset.selections
          : undefined
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.messages.error(
        nls.localize('ai-focused-editor/chat-capabilities/apply-failed', 'Could not apply the capability preset: {0}', detail)
      );
      return;
    }
    await this.messages.info(
      nls.localize(
        'ai-focused-editor/chat-capabilities/applied',
        'Chat capabilities set to «{0}». Applies to new chat requests to the Manuscript agent.',
        preset.label
      )
    );
  }

  protected async currentSelections(): Promise<GenericCapabilitySelections> {
    const settings = await this.aiSettings.getAgentSettings(MANUSCRIPT_AGENT_ID);
    return settings?.genericCapabilitySelections ?? {};
  }
}

/** The six generic-capability arrays, so equality checks stay type-complete. */
const CAPABILITY_KEYS: (keyof GenericCapabilitySelections)[] = [
  'skills',
  'mcpFunctions',
  'functions',
  'promptFragments',
  'agentDelegation',
  'variables'
];

/**
 * Order-insensitive equality of two selection objects: an absent key and an
 * empty array are both "nothing selected", so a saved `{ variables: [] }` still
 * matches the `{}` Minimum preset.
 */
function selectionsEqual(left: GenericCapabilitySelections, right: GenericCapabilitySelections): boolean {
  return CAPABILITY_KEYS.every(key => {
    const a = [...(left[key] ?? [])].sort();
    const b = [...(right[key] ?? [])].sort();
    return a.length === b.length && a.every((value, index) => value === b[index]);
  });
}
