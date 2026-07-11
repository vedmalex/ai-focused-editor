import { ContainerModule } from '@theia/core/shared/inversify';
import { CommandContribution } from '@theia/core/lib/common';
import { AuthQrContribution } from './auth-qr-contribution';

/**
 * Standalone frontend module for the "Show Login QR" command. Registered as its
 * own `theiaExtensions` frontend entry so it stays isolated from the main
 * manuscript-workspace frontend module. Only the command contribution is bound
 * here; the QR image + dialog are self-contained (no extra services).
 */
export default new ContainerModule(bind => {
  bind(AuthQrContribution).toSelf().inSingletonScope();
  bind(CommandContribution).toService(AuthQrContribution);
});
