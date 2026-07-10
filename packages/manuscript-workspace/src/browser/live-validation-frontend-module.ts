import { ContainerModule } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import {
  PreferenceContribution,
  PreferenceSchema,
  PreferenceScope
} from '@theia/core/lib/common/preferences';
import {
  LIVE_VALIDATION_PREFERENCE,
  LiveValidationContribution
} from './live-validation-contribution';

/**
 * Standalone frontend module for live incremental validation.
 *
 * Kept as an additional `theiaExtensions` frontend entry (and owning its own
 * PreferenceContribution) so it stays isolated from the main
 * manuscript-workspace module while parallel work evolves both. The backend
 * proxy `ManuscriptWorkspaceBackendService` it depends on is bound by the main
 * frontend module into the shared container.
 */
const liveValidationPreferenceSchema: PreferenceSchema = {
  title: 'AI Focused Editor',
  scope: PreferenceScope.Folder,
  properties: {
    [LIVE_VALIDATION_PREFERENCE]: {
      type: 'boolean',
      default: true,
      description: 'Validate the active document live as you type (semantic Markdown lint and entity/manifest/metadata YAML schema checks) and publish results to the Problems view. The manual "Validate Manuscript Workspace" command still covers the whole workspace.'
    }
  }
};

export default new ContainerModule(bind => {
  bind(PreferenceContribution).toConstantValue({ schema: liveValidationPreferenceSchema });
  bind(LiveValidationContribution).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(LiveValidationContribution);
});
