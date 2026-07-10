import {
  Command,
  CommandContribution,
  CommandRegistry,
  MenuContribution,
  MenuModelRegistry,
  MessageService,
  QuickInputService,
  QuickPickItem
} from '@theia/core/lib/common';
import { nls } from '@theia/core/lib/common/nls';
import { inject, injectable } from '@theia/core/shared/inversify';
import { AiProfilePreferenceService } from './ai-profile-preference-service';
import { AiFocusedEditorMenus } from './ai-focused-editor-menu';

export namespace AiRotationCommands {
  const CATEGORY_KEY = 'ai-focused-editor/ai-config/category';

  export const SWITCH_ALIAS: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.ai.switchAlias',
      category: 'AI Focused Editor',
      label: 'Switch AI Alias...'
    },
    'ai-focused-editor/ai-config/switch-alias',
    CATEGORY_KEY
  );

  export const SWITCH_ENDPOINT: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.ai.switchEndpoint',
      category: 'AI Focused Editor',
      label: 'Switch AI Endpoint...'
    },
    'ai-focused-editor/ai-config/switch-endpoint',
    CATEGORY_KEY
  );
}

const UNPIN_ITEM_ID = '__afe_unpin__';

interface AliasPickItem extends QuickPickItem {
  aliasId: string;
}

interface EndpointPickItem extends QuickPickItem {
  endpointId: string;
}

/**
 * Live rotation of the two-level AI connection model:
 *   - Switch AI Alias...    sets the active alias (the user default chain).
 *   - Switch AI Endpoint...  pins an endpoint to the front of the active chain.
 *
 * Kept in a standalone module (bound via its own theiaExtensions entry) so it
 * never touches the main manuscript-workspace frontend module.
 */
@injectable()
export class AiRotationContribution implements CommandContribution, MenuContribution {
  @inject(AiProfilePreferenceService)
  protected readonly aiProfilePreferences!: AiProfilePreferenceService;

  @inject(QuickInputService)
  protected readonly quickInput!: QuickInputService;

  @inject(MessageService)
  protected readonly messages!: MessageService;

  registerCommands(commands: CommandRegistry): void {
    commands.registerCommand(AiRotationCommands.SWITCH_ALIAS, {
      execute: () => this.switchAlias()
    });
    commands.registerCommand(AiRotationCommands.SWITCH_ENDPOINT, {
      execute: () => this.switchEndpoint()
    });
  }

  registerMenus(menus: MenuModelRegistry): void {
    menus.registerMenuAction(AiFocusedEditorMenus.MAIN, {
      commandId: AiRotationCommands.SWITCH_ALIAS.id,
      order: '1_rotation_a'
    });
    menus.registerMenuAction(AiFocusedEditorMenus.MAIN, {
      commandId: AiRotationCommands.SWITCH_ENDPOINT.id,
      order: '1_rotation_b'
    });
  }

  protected async switchAlias(): Promise<void> {
    const aliases = await this.aiProfilePreferences.listAliases();
    if (aliases.length === 0) {
      await this.messages.warn(nls.localize('ai-focused-editor/ai-config/no-aliases', 'No AI aliases configured yet. Open AI Model Config to create one.'));
      return;
    }

    const items: AliasPickItem[] = aliases.map(alias => ({
      label: `${alias.active ? '$(check) ' : ''}${alias.label}`,
      description: alias.enabled === false ? nls.localize('ai-focused-editor/ai-config/disabled-desc', 'disabled') : undefined,
      detail: this.describeAliasChain(alias.chain.length, alias.availableLegs),
      aliasId: alias.id
    }));

    const picked = await this.quickInput.showQuickPick(items, {
      title: nls.localize('ai-focused-editor/ai-config/switch-alias-title', 'Switch AI Alias'),
      placeholder: nls.localize('ai-focused-editor/ai-config/switch-alias-placeholder', 'Select the active AI alias (default chain)')
    });
    if (!picked) {
      return;
    }
    await this.aiProfilePreferences.setActiveAlias(picked.aliasId);
    await this.messages.info(nls.localize('ai-focused-editor/ai-config/active-alias', 'Active AI alias: {0}.', picked.aliasId));
  }

  protected async switchEndpoint(): Promise<void> {
    const endpoints = await this.aiProfilePreferences.listEndpoints();
    if (endpoints.length === 0) {
      await this.messages.warn(nls.localize('ai-focused-editor/ai-config/no-endpoints', 'No AI endpoints configured yet. Open AI Model Config to create one.'));
      return;
    }

    const pinned = this.aiProfilePreferences.getPinnedEndpointId();
    const items: EndpointPickItem[] = endpoints.map(endpoint => {
      const badges: string[] = [];
      badges.push(endpoint.availableNow
        ? nls.localize('ai-focused-editor/ai-config/badge-available-now', 'available now')
        : nls.localize('ai-focused-editor/ai-config/badge-unavailable-now', 'unavailable now'));
      if (!endpoint.enabled) {
        badges.push(nls.localize('ai-focused-editor/ai-config/badge-disabled', 'disabled'));
      }
      if (endpoint.timeWindows.length > 0) {
        badges.push(nls.localize('ai-focused-editor/ai-config/badge-windows', 'windows: {0}', endpoint.timeWindows.join(', ')));
      }
      if (endpoint.windowWarning) {
        badges.push(nls.localize('ai-focused-editor/ai-config/badge-malformed-windows', 'malformed window(s)'));
      }
      return {
        label: `${endpoint.id === pinned ? '$(pin) ' : ''}${endpoint.availableNow ? '$(pass) ' : '$(circle-slash) '}${endpoint.label}`,
        description: `${endpoint.provider}/${endpoint.transportKind}`,
        detail: badges.join(' · '),
        endpointId: endpoint.id
      };
    });

    if (pinned) {
      items.unshift({
        label: nls.localize('ai-focused-editor/ai-config/clear-pin', '$(close) Clear pin'),
        description: nls.localize('ai-focused-editor/ai-config/currently-pinned', 'currently pinned: {0}', pinned),
        endpointId: UNPIN_ITEM_ID
      });
    }

    const picked = await this.quickInput.showQuickPick(items, {
      title: nls.localize('ai-focused-editor/ai-config/switch-endpoint-title', 'Switch AI Endpoint'),
      placeholder: nls.localize('ai-focused-editor/ai-config/switch-endpoint-placeholder', 'Pin an endpoint to the front of the active alias chain')
    });
    if (!picked) {
      return;
    }
    if (picked.endpointId === UNPIN_ITEM_ID) {
      await this.aiProfilePreferences.setPinnedEndpoint('');
      await this.messages.info(nls.localize('ai-focused-editor/ai-config/pin-cleared', 'Cleared the pinned AI endpoint.'));
      return;
    }
    await this.aiProfilePreferences.setPinnedEndpoint(picked.endpointId);
    await this.messages.info(nls.localize('ai-focused-editor/ai-config/endpoint-pinned', 'Pinned AI endpoint: {0}.', picked.endpointId));
  }

  protected describeAliasChain(total: number, available: number): string {
    if (total === 0) {
      return nls.localize('ai-focused-editor/ai-config/empty-chain', 'empty chain');
    }
    return nls.localize('ai-focused-editor/ai-config/chain-available', '{0}/{1} endpoint(s) available now', available, total);
  }
}
