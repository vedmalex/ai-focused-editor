import { ContainerModule } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { CommandContribution, MenuContribution } from '@theia/core/lib/common';
import {
  ContributionProvider,
  bindRootContributionProvider
} from '@theia/core/lib/common/contribution-provider';
import {
  PreferenceContribution,
  PreferenceSchema,
  PreferenceScope
} from '@theia/core/lib/common/preferences';
import { TypographyRule } from '../../common/typography/typography-types';
import { buildTypographySchema } from '../../common/typography/typography-rule-contribution';
import {
  DefaultTypographyEngine,
  TypographyEngine
} from '../../common/typography/typography-engine';
import { TYPOGRAPHY_RULES } from '../../common/typography/typography-rules';
import { TypographyMonacoAdapter } from './typography-monaco-adapter';
import { AutoTypographyContribution } from './auto-typography-contribution';
import { TypographyBatchService } from './typography-batch-service';
import { TypographyCommandContribution } from './typography-commands';

/**
 * Standalone frontend module for auto-typography (TASK-019). A separate
 * `theiaExtensions` frontend entry so it stays isolated from the main module
 * while wave work evolves both (same pattern as `live-validation-frontend-module`).
 *
 * The Q2 spike lives here: `PreferenceContribution` is bound via
 * `toDynamicValue`, so its factory runs when `PreferenceSchemaProvider` is
 * constructed — AFTER every `ContainerModule` has registered its
 * `TypographyRule` bindings. Reading the `ContributionProvider` at that point
 * yields a POPULATED rule list, so the per-rule
 * `aiFocusedEditor.typography.<id>.enabled` keys (including #38's
 * `collapse-multiple-spaces`) are present in Settings — the acceptance signal
 * that the runtime schema generation works.
 *
 * `bindRootContributionProvider` (NOT `bindContributionProvider`) resolves
 * contributions from the ROOT container, avoiding the child-container leak
 * called out in the Theia docs.
 */
/**
 * THE RULE REGISTRY NO LONGER LIVES HERE (F-CR-1). It moved to
 * `common/typography/typography-rules.ts` so the Node test lane — which cannot
 * import this module, because it pulls in monaco and `@theia/core/lib/browser` —
 * can run the whole-document and front-matter suites against the REAL rule set
 * instead of a hand-maintained copy that nothing checked for completeness.
 *
 * This module is now only the DI wiring: the binding loop below reads the
 * canonical array, so the bindings and the registry still cannot drift.
 *
 * NOT re-exported on purpose: a `export { TYPOGRAPHY_RULES }` here would create a
 * second import path for the same data, which is exactly the dead re-export
 * TASK-020 already removed once. Import it from `common/typography/typography-rules`.
 */
export default new ContainerModule(bind => {
  bindRootContributionProvider(bind, TypographyRule);
  for (const rule of TYPOGRAPHY_RULES) {
    bind(TypographyRule).toConstantValue(rule);
  }

  bind(PreferenceContribution).toDynamicValue(ctx => {
    const provider = ctx.container.getNamed<ContributionProvider<TypographyRule>>(ContributionProvider, TypographyRule);
    const schema: PreferenceSchema = {
      title: 'AI Focused Editor',
      scope: PreferenceScope.Folder,
      properties: buildTypographySchema(provider.getContributions())
    };
    return { schema };
  }).inSingletonScope();

  bind(TypographyEngine).toDynamicValue(ctx => {
    const provider = ctx.container.getNamed<ContributionProvider<TypographyRule>>(ContributionProvider, TypographyRule);
    return new DefaultTypographyEngine(provider.getContributions());
  }).inSingletonScope();

  bind(TypographyMonacoAdapter).toSelf().inSingletonScope();
  bind(AutoTypographyContribution).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(AutoTypographyContribution);

  // Batch commands (UR-006): apply the enabled rules to the active file /
  // selection as one undo step. The command contribution reuses the live
  // contribution's enabled-id resolution, so bind it as a self singleton and
  // expose it as both a Command and a Menu contribution.
  bind(TypographyBatchService).toSelf().inSingletonScope();
  bind(TypographyCommandContribution).toSelf().inSingletonScope();
  bind(CommandContribution).toService(TypographyCommandContribution);
  bind(MenuContribution).toService(TypographyCommandContribution);
});
