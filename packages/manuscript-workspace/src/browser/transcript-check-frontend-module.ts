import '../../src/browser/style/index.css';
import URI from '@theia/core/lib/common/uri';
import {
  CommandContribution,
  MenuContribution
} from '@theia/core/lib/common';
import {
  FrontendApplicationContribution,
  KeybindingContribution,
  NavigatableWidgetOptions,
  OpenHandler,
  WidgetFactory
} from '@theia/core/lib/browser';
import { ServiceConnectionProvider } from '@theia/core/lib/browser/messaging/service-connection-provider';
import { ContainerModule } from '@theia/core/shared/inversify';
import { AudioConversionService, AudioConversionServicePath } from '../common';
import { TranscriptCheckWidget } from './transcript-check-widget';
import { TranscriptCheckSetsService } from './transcript-check-sets-service';
import { TranscriptSpeakersService } from './transcript-speakers-service';
import { TranscriptCheckAiService } from './transcript-check-ai-service';
import {
  TranscriptCheckCommandContribution,
  TranscriptCheckOpenHandler
} from './transcript-check-open-handler';
import { TranscriptIngestContribution } from './transcript-ingest-contribution';
import { LegacyTranscriptDecorationProvider } from './legacy-transcript-decoration-provider';
import { TranscriptNavigatorContribution } from './transcript-navigator-contribution';
import { RawMdWidget } from './raw-md-widget';
import { RawMdCommandContribution, RawMdOpenHandler } from './raw-md-open-handler';

/**
 * Standalone frontend module for the Transcript Check editor (audio transcript
 * proof-listening over `transcription/<set>/transcriptset.yaml`).
 *
 * Registered as an additional `theiaExtensions` frontend entry (the
 * proofreading / excalidraw pattern) so it stays isolated from
 * `manuscript-workspace-frontend-module.ts` while the two evolve in parallel.
 */
export default new ContainerModule(bind => {
  bind(TranscriptCheckSetsService).toSelf().inSingletonScope();
  bind(TranscriptSpeakersService).toSelf().inSingletonScope();
  // Backend STT pipeline proxy (Phase-5 per-segment re-recognition).
  bind(AudioConversionService).toDynamicValue(ctx =>
    ServiceConnectionProvider.createProxy(ctx.container, AudioConversionServicePath)
  ).inSingletonScope();
  // AI lanes: Phase 4 (ai-connect proofread) + Phase 5 (backend STT).
  bind(TranscriptCheckAiService).toSelf().inSingletonScope();

  // Transient: the WidgetManager caches one widget per transcriptset URI.
  bind(TranscriptCheckWidget).toSelf().inTransientScope();
  bind(WidgetFactory).toDynamicValue(ctx => ({
    id: TranscriptCheckWidget.FACTORY_ID,
    createWidget: (options: NavigatableWidgetOptions) => {
      const widget = ctx.container.get(TranscriptCheckWidget);
      widget.configure(new URI(options.uri));
      return widget;
    }
  })).inSingletonScope();

  bind(TranscriptCheckOpenHandler).toSelf().inSingletonScope();
  bind(OpenHandler).toService(TranscriptCheckOpenHandler);

  bind(TranscriptCheckCommandContribution).toSelf().inSingletonScope();
  bind(CommandContribution).toService(TranscriptCheckCommandContribution);
  bind(MenuContribution).toService(TranscriptCheckCommandContribution);
  bind(KeybindingContribution).toService(TranscriptCheckCommandContribution);
  bind(FrontendApplicationContribution).toService(TranscriptCheckCommandContribution);

  // The "Transcribe..." ingest wizard (legacy import + new-transcription pipeline).
  bind(TranscriptIngestContribution).toSelf().inSingletonScope();
  bind(CommandContribution).toService(TranscriptIngestContribution);
  bind(MenuContribution).toService(TranscriptIngestContribution);

  // Read-only raw.md structural viewer (TASK-016 U4b).
  bind(RawMdWidget).toSelf().inTransientScope();
  bind(WidgetFactory).toDynamicValue(ctx => ({
    id: RawMdWidget.FACTORY_ID,
    createWidget: (options: NavigatableWidgetOptions) => {
      const widget = ctx.container.get(RawMdWidget);
      widget.configure(new URI(options.uri));
      return widget;
    }
  })).inSingletonScope();
  bind(RawMdOpenHandler).toSelf().inSingletonScope();
  bind(OpenHandler).toService(RawMdOpenHandler);
  bind(RawMdCommandContribution).toSelf().inSingletonScope();
  bind(CommandContribution).toService(RawMdCommandContribution);
  bind(MenuContribution).toService(RawMdCommandContribution);

  // Standard file Explorer folder context-menu entry into the wizard above (TASK-016 U3a).
  bind(TranscriptNavigatorContribution).toSelf().inSingletonScope();
  bind(CommandContribution).toService(TranscriptNavigatorContribution);
  bind(MenuContribution).toService(TranscriptNavigatorContribution);

  // Passive legacy-transcript folder badge in the standard Explorer (TASK-016 U2b).
  bind(LegacyTranscriptDecorationProvider).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(LegacyTranscriptDecorationProvider);
});
