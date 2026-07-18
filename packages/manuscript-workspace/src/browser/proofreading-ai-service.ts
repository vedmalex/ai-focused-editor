import { inject, injectable } from '@theia/core/shared/inversify';
import { nls } from '@theia/core/lib/common/nls';
import {
  AiConnectAttachment,
  AiConnectionService,
  AiGenerateRequest,
  ProofreadingActionKind,
  buildProofreadingMessages,
  generateWithFailover
} from '../common';
import {
  AiProfilePreferenceService,
  AiRequestLogService
} from '@ai-focused-editor/ai-connect-theia/lib/browser';

/** Command-id prefix used for the request-log recorder of each proofreading action. */
const COMMAND_ID_PREFIX = 'ai-focused-editor.proofreading';

/** The scan image, split out of the widget's data URI, ready to attach to a request. */
export interface ProofreadingImageAttachment {
  base64: string;
  mimeType: string;
}

/** Inputs one AI action runs against (profile resolution is done inside the service). */
export interface ProofreadingAiContext {
  /** The current editable text (OCR text, or the translation for `translationQa`). */
  currentText: string;
  /** Translation-mode source text (for `translate`/`translationQa`). */
  sourceText?: string;
  /** The scan image bytes for the image-input actions (reOcr/translate/translationQa). */
  imageAttachment?: ProofreadingImageAttachment;
}

/**
 * The outcome of one AI action. Never throws to the UI: a failure is reported as
 * `{ error }` so the widget can surface it without a crash.
 */
export interface ProofreadingAiResult {
  /** The AI-produced whole-page text, when the call succeeded. */
  text?: string;
  /** Non-fatal warnings collected from the failover walk. */
  warnings: string[];
  /** A human-readable error when the call could not run/complete. */
  error?: string;
}

/**
 * Runs the four Proofreading AI actions through the EXISTING ai-connect stack —
 * the exact shape used by `manuscript-workspace-contribution.ts` (resolve
 * profile + failover chain, then `generateWithFailover(..., createRecorder(id))`).
 *
 * The three image-input actions (reOcr / translate / translationQa) attach the
 * scan as an `AiConnectAttachment` (base64 + mimeType); `proofread` works on text
 * only. All whole-page (v1): each returns the corrected FULL text, applied as a
 * single ChangeProposal diff by the widget — NOT inline per-paragraph edits.
 */
@injectable()
export class ProofreadingAiService {

  @inject(AiConnectionService)
  protected readonly aiConnection!: AiConnectionService;

  @inject(AiProfilePreferenceService)
  protected readonly aiProfilePreferences!: AiProfilePreferenceService;

  @inject(AiRequestLogService)
  protected readonly requestLog!: AiRequestLogService;

  /** Re-recognize the page text from the attached scan image (OCR mode). */
  reOcr(ctx: ProofreadingAiContext): Promise<ProofreadingAiResult> {
    return this.run('reOcr', ctx, true);
  }

  /** Proofread the current OCR text — text only, no image (OCR mode). */
  proofread(ctx: ProofreadingAiContext): Promise<ProofreadingAiResult> {
    return this.run('proofread', ctx, false);
  }

  /** Translate the source text into the translation file (translation mode). */
  translate(ctx: ProofreadingAiContext): Promise<ProofreadingAiResult> {
    return this.run('translate', ctx, true);
  }

  /** Compare original vs translation and return a corrected translation (translation mode). */
  translationQa(ctx: ProofreadingAiContext): Promise<ProofreadingAiResult> {
    return this.run('translationQa', ctx, true);
  }

  /**
   * Shared action runner: resolve profile + chain, assemble the messages, attach
   * the scan image when `useImage`, and drive `generateWithFailover` with a
   * request-log recorder. Errors become a `{ error }` result (never thrown).
   */
  protected async run(
    kind: ProofreadingActionKind,
    ctx: ProofreadingAiContext,
    useImage: boolean
  ): Promise<ProofreadingAiResult> {
    try {
      const profile = await this.aiProfilePreferences.getConfiguredProfile();
      if (!profile) {
        return {
          warnings: [],
          error: nls.localize(
            'ai-focused-editor/proofreading/ai-needs-profile',
            'Configure an AI connection (add an endpoint and alias in the Model Config view) before running proofreading AI actions.'
          )
        };
      }

      const attachImage = useImage && !!ctx.imageAttachment;
      const { system, user } = buildProofreadingMessages({
        kind,
        currentText: ctx.currentText,
        sourceText: ctx.sourceText,
        hasImageAttachment: attachImage
      });

      const commandId = `${COMMAND_ID_PREFIX}.${kind}`;
      const request: AiGenerateRequest = {
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ],
        parameters: { temperature: 0 },
        logContext: { command: commandId }
      };
      if (attachImage && ctx.imageAttachment) {
        const attachment: AiConnectAttachment = {
          base64: ctx.imageAttachment.base64,
          mimeType: ctx.imageAttachment.mimeType,
          name: 'scan'
        };
        request.attachments = [attachment];
      }

      const chain = await this.aiProfilePreferences.getFailoverChain();
      const result = await generateWithFailover(
        this.aiConnection,
        chain.length > 0 ? chain : [profile],
        request,
        this.requestLog.createRecorder(commandId)
      );
      return { text: result.text, warnings: result.warnings ?? [] };
    } catch (error) {
      return {
        warnings: [],
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
}
