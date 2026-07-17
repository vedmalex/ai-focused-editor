import type { LanguageModelStatus } from '@theia/ai-core';
import { injectable, interfaces } from '@theia/core/shared/inversify';
import { AiConnectionProfile, aliasModelId } from '../common';
import { AiConnectLanguageModelBase } from './ai-connect-language-model-base';

/** Factory symbol: builds a fully-injected per-alias model for a given alias. */
export const AiConnectAliasModelFactory = Symbol('AiConnectAliasModelFactory');
export type AiConnectAliasModelFactory = (aliasId: string, aliasLabel?: string) => AiConnectAliasLanguageModel;

/**
 * A LanguageModel PINNED to one ai-connect alias. Unlike the back-compat
 * current-alias model, every request routes through this instance's own alias
 * regardless of which alias is active — so the AI Configuration picker can list
 * one selectable model per alias. Metadata is human-friendly (name = the alias
 * label) so the picker reads well.
 *
 * Bound in transient scope and produced through {@link AiConnectAliasModelFactory}
 * so each instance is fully field-injected yet carries its own alias binding.
 */
@injectable()
export class AiConnectAliasLanguageModel extends AiConnectLanguageModelBase {
  protected aliasId = '';
  protected aliasLabel?: string;

  readonly vendor = 'ai-connect';
  readonly family = 'ai-connect';
  readonly status: LanguageModelStatus = {
    status: 'ready',
    message: 'Routes every request through this ai-connect alias (failover chain), independent of the active alias.'
  };

  /** Set the alias this model is pinned to. Called by the factory at creation. */
  init(aliasId: string, aliasLabel?: string): this {
    this.aliasId = aliasId;
    this.aliasLabel = aliasLabel;
    return this;
  }

  get id(): string {
    return aliasModelId(this.aliasId);
  }

  get name(): string {
    return this.aliasLabel && this.aliasLabel.trim().length > 0 ? this.aliasLabel : this.aliasId;
  }

  protected override aliasForLog(): string {
    return this.aliasId;
  }

  protected override emptyChainMessage(): string {
    return `AI alias "${this.aliasId}" has no usable endpoint right now (all legs are missing, disabled, out of their time window, or missing an API key).`;
  }

  protected resolveFailoverChain(): Promise<AiConnectionProfile[]> {
    return this.aiProfilePreferences.getFailoverChainForAlias(this.aliasId);
  }
}

/** Bind the transient class + its factory. */
export function bindAiConnectAliasModel(bind: interfaces.Bind): void {
  bind(AiConnectAliasLanguageModel).toSelf().inTransientScope();
  bind(AiConnectAliasModelFactory).toFactory<AiConnectAliasLanguageModel, [string, string?]>(
    ctx => (aliasId: string, aliasLabel?: string) =>
      ctx.container.get(AiConnectAliasLanguageModel).init(aliasId, aliasLabel)
  );
}
