import type { LanguageModelStatus } from '@theia/ai-core';
import { injectable } from '@theia/core/shared/inversify';
import { AiConnectionProfile } from '../common';
import { AiConnectLanguageModelBase } from './ai-connect-language-model-base';

/**
 * Back-compat "current alias" LanguageModel: id `ai-focused-editor.ai-connect`
 * means "route through whichever alias is currently active". The editor's modes
 * and chat target this stable id, so switching the active alias transparently
 * re-routes them. Per-alias models (id `ai-connect/<alias>`) are registered
 * alongside this one by {@link AiConnectModelSyncContribution}.
 */
@injectable()
export class AiConnectTheiaLanguageModel extends AiConnectLanguageModelBase {
  static readonly ID = 'ai-focused-editor.ai-connect';

  readonly id = AiConnectTheiaLanguageModel.ID;
  readonly name = 'AI Focused Editor ai-connect';
  readonly vendor = '@vedmalex/ai-connect';
  readonly family = 'ai-connect';
  readonly status: LanguageModelStatus = {
    status: 'ready',
    message: 'Delegates Theia AI requests to the configured AI Focused Editor ai-connect profile.'
  };

  protected resolveFailoverChain(): Promise<AiConnectionProfile[]> {
    return this.aiProfilePreferences.getFailoverChain();
  }
}
