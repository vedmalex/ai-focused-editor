import { ContainerModule } from '@theia/core/shared/inversify';
import { LabelProviderContribution } from '@theia/core/lib/browser/label-provider';
import { IconThemeContribution } from '@theia/core/lib/browser/icon-theme-contribution';
import { WriterIconThemeContribution } from './writer-icon-theme-contribution';

/**
 * Registers the `afe-writer-icons` file icon theme. Bound as both an
 * {@link IconThemeContribution} (so it appears in *File Icon Theme* and can be
 * made the default) and a {@link LabelProviderContribution} (so it resolves the
 * actual icons while active), mirroring how Theia's built-in `none` theme binds.
 */
export default new ContainerModule(bind => {
  bind(WriterIconThemeContribution).toSelf().inSingletonScope();
  bind(IconThemeContribution).toService(WriterIconThemeContribution);
  bind(LabelProviderContribution).toService(WriterIconThemeContribution);
});
