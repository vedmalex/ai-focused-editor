import { ContainerModule } from '@theia/core/shared/inversify';
import { WidgetFactory, bindViewContribution } from '@theia/core/lib/browser';
import { TranscriptionSettingsWidget } from './transcription-settings-widget';
import { TranscriptionSettingsViewContribution } from './transcription-settings-contribution';

/**
 * Standalone frontend module for the Transcription Settings panel (the
 * local/remote speech-recognition settings view). Registered as its own
 * `theiaExtensions` frontend entry, mirroring the other standalone modules.
 *
 * The `AudioConversionService` proxy the widget injects for its "Check" action
 * is already bound (container-wide singleton) by
 * `transcript-check-frontend-module.ts`, so it is NOT re-bound here.
 */
export default new ContainerModule(bind => {
  // Transient (the ModelConfigWidget pattern): the WidgetManager caches the
  // live instance; after a close+dispose the factory must build a fresh one.
  bind(TranscriptionSettingsWidget).toSelf();
  bind(WidgetFactory).toDynamicValue(ctx => ({
    id: TranscriptionSettingsWidget.ID,
    createWidget: () => ctx.container.get(TranscriptionSettingsWidget)
  })).inSingletonScope();
  bindViewContribution(bind, TranscriptionSettingsViewContribution);
});
