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
import { inject, injectable } from '@theia/core/shared/inversify';
import { AiProfilePreferenceService } from './ai-profile-preference-service';
import { AiFocusedEditorMenus } from './ai-focused-editor-menu';

export namespace AiRotationCommands {
  export const SWITCH_ALIAS: Command = {
    id: 'ai-focused-editor.ai.switchAlias',
    category: 'AI Focused Editor',
    label: 'Switch AI Alias...'
  };

  export const SWITCH_ENDPOINT: Command = {
    id: 'ai-focused-editor.ai.switchEndpoint',
    category: 'AI Focused Editor',
    label: 'Switch AI Endpoint...'
  };
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
      await this.messages.warn('No AI aliases configured yet. Open AI Model Config to create one.');
      return;
    }

    const items: AliasPickItem[] = aliases.map(alias => ({
      label: `${alias.active ? '$(check) ' : ''}${alias.label}`,
      description: alias.enabled === false ? 'disabled' : undefined,
      detail: this.describeAliasChain(alias.chain.length, alias.availableLegs),
      aliasId: alias.id
    }));

    const picked = await this.quickInput.showQuickPick(items, {
      title: 'Switch AI Alias',
      placeholder: 'Select the active AI alias (default chain)'
    });
    if (!picked) {
      return;
    }
    await this.aiProfilePreferences.setActiveAlias(picked.aliasId);
    await this.messages.info(`Active AI alias: ${picked.aliasId}.`);
  }

  protected async switchEndpoint(): Promise<void> {
    const endpoints = await this.aiProfilePreferences.listEndpoints();
    if (endpoints.length === 0) {
      await this.messages.warn('No AI endpoints configured yet. Open AI Model Config to create one.');
      return;
    }

    const pinned = this.aiProfilePreferences.getPinnedEndpointId();
    const items: EndpointPickItem[] = endpoints.map(endpoint => {
      const badges: string[] = [];
      badges.push(endpoint.availableNow ? 'available now' : 'unavailable now');
      if (!endpoint.enabled) {
        badges.push('disabled');
      }
      if (endpoint.timeWindows.length > 0) {
        badges.push(`windows: ${endpoint.timeWindows.join(', ')}`);
      }
      if (endpoint.windowWarning) {
        badges.push('malformed window(s)');
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
        label: '$(close) Clear pin',
        description: `currently pinned: ${pinned}`,
        endpointId: UNPIN_ITEM_ID
      });
    }

    const picked = await this.quickInput.showQuickPick(items, {
      title: 'Switch AI Endpoint',
      placeholder: 'Pin an endpoint to the front of the active alias chain'
    });
    if (!picked) {
      return;
    }
    if (picked.endpointId === UNPIN_ITEM_ID) {
      await this.aiProfilePreferences.setPinnedEndpoint('');
      await this.messages.info('Cleared the pinned AI endpoint.');
      return;
    }
    await this.aiProfilePreferences.setPinnedEndpoint(picked.endpointId);
    await this.messages.info(`Pinned AI endpoint: ${picked.endpointId}.`);
  }

  protected describeAliasChain(total: number, available: number): string {
    if (total === 0) {
      return 'empty chain';
    }
    return `${available}/${total} endpoint(s) available now`;
  }
}
