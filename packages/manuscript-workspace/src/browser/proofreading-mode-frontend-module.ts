import '../../src/browser/style/index.css';
import {
  CommandContribution,
  MenuContribution
} from '@theia/core/lib/common';
import { WidgetFactory } from '@theia/core/lib/browser';
import { TabBarToolbarContribution } from '@theia/core/lib/browser/shell/tab-bar-toolbar';
import { bindViewContribution } from '@theia/core/lib/browser/shell/view-contribution';
import { ContainerModule } from '@theia/core/shared/inversify';
import { ProofreadingSetsService } from './proofreading-sets-service';
import { ProofreadingViewWidget } from './proofreading-view-widget';
import { ProofreadingViewContribution } from './proofreading-view-contribution';
import { ProofreadingModeContribution } from './proofreading-mode-contribution';

/**
 * Standalone frontend module for Proofreading Mode — a focused layout for
 * scan/OCR/translation review, mirroring the Writing Mode pattern. Registered
 * as an additional `theiaExtensions` frontend entry so it stays isolated from
 * `manuscript-workspace-frontend-module.ts` (the proofreading-editor module
 * pattern).
 *
 * Wires three concerns:
 *  - the pure set-enumeration service ({@link ProofreadingSetsService});
 *  - the left-area Proofreading VIEW (widget factory + view contribution);
 *  - the Proofreading MODE toggle (command + Manuscript menu + view toolbar).
 */
export default new ContainerModule(bind => {
  // Pure set enumerator (reuses the navigator's proofset.yaml scan).
  bind(ProofreadingSetsService).toSelf().inSingletonScope();

  // The left-area Proofreading view. WidgetManager caches one per factory id.
  bind(ProofreadingViewWidget).toSelf();
  bind(WidgetFactory).toDynamicValue(ctx => ({
    id: ProofreadingViewWidget.ID,
    createWidget: () => ctx.container.get(ProofreadingViewWidget)
  })).inSingletonScope();
  bindViewContribution(bind, ProofreadingViewContribution);

  // The mode toggle: command + Manuscript-menu entry + view-toolbar button.
  bind(ProofreadingModeContribution).toSelf().inSingletonScope();
  bind(CommandContribution).toService(ProofreadingModeContribution);
  bind(MenuContribution).toService(ProofreadingModeContribution);
  bind(TabBarToolbarContribution).toService(ProofreadingModeContribution);
});
