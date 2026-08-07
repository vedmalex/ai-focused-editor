import { injectable } from '@theia/core/shared/inversify';
import { nls } from '@theia/core/lib/common/nls';
import { ConfirmDialog } from '@theia/core/lib/browser/dialogs';
import type { AiWriteProvenance, AiWriteProvenanceRecord } from '../common/ai-write-provenance';
import { provenanceRecord, provenanceYamlBlock } from '../common/ai-write-provenance';

/**
 * The author's confirmation gate in front of every AI write (TASK-022 WP-8,
 * UR-008).
 *
 * WHY A SERVICE AND NOT A `ConfirmDialog` INLINE IN EACH TOOL. UR-008 requires
 * EXPLICIT author confirmation, which means the tools must be provably unable to
 * write without one. As a bound collaborator the gate is a single object that
 * can be observed: a test can watch exactly what the author was shown and
 * compare it to what reached the disk, and a tool with no gate resolved refuses
 * instead of writing. Three inline dialogs would give three chances to skip one
 * and no way to check.
 *
 * WHAT THE AUTHOR IS SHOWN IS WHAT IS WRITTEN. The request carries the STAMP
 * ITSELF ({@link AiWriteConfirmationRequest.provenance}) and the rendered
 * message embeds {@link provenanceYamlBlock} of that same stamp — the very
 * string the writers splice into the file. The dialog cannot describe one thing
 * while a different thing lands.
 */

/** What the author is asked to approve before an AI tool creates a file. */
export interface AiWriteConfirmationRequest {
  /** Tool id doing the writing, e.g. `manuscript_create_entity`. */
  toolId: string;
  /** Localized name of the artifact kind, for the dialog title. */
  artifactLabel: string;
  /** Workspace-relative path that will be CREATED (never overwritten). */
  path: string;
  /** The stamp, exactly as it will be recorded in the file. */
  provenance: AiWriteProvenance;
}

export const AiWriteConfirmationService = Symbol('AiWriteConfirmationService');

export interface AiWriteConfirmationService {
  /**
   * Ask the author to approve one write.
   *
   * Resolves `true` ONLY on an explicit approval. Anything else — dismissal,
   * cancellation, an error inside the dialog — is `false`, because "the author
   * did not say yes" and "the author said no" have the same consequence here
   * and collapsing them the other way would turn a closed dialog into consent.
   */
  confirm(request: AiWriteConfirmationRequest): Promise<boolean>;
}

/**
 * The message the author reads.
 *
 * Exported so the writers and the tests can name it without reaching into the
 * dialog. The provenance block appears VERBATIM: an author approving an
 * `ai-candidate` mark should see the literal line that will be in the file.
 */
export function aiWriteConfirmationMessage(request: AiWriteConfirmationRequest): string {
  const block = provenanceYamlBlock(request.provenance);
  return request.provenance.origin === 'ai-candidate'
    ? nls.localize(
      'ai-focused-editor/workspace/ai-write-confirm-candidate',
      'The AI assistant wants to create {0} and cited no source for it. '
        + 'It will be recorded as an UNCONFIRMED CANDIDATE, with this stamp written into the file:\n\n{1}\nCreate it?',
      request.path,
      block
    )
    : nls.localize(
      'ai-focused-editor/workspace/ai-write-confirm-evidenced',
      'The AI assistant wants to create {0}, citing a source in your manuscript. '
        + 'This stamp will be written into the file:\n\n{1}\nCreate it?',
      request.path,
      block
    );
}

/** The stamp a caller can compare against what it finds on disk. */
export function confirmationProvenanceRecord(request: AiWriteConfirmationRequest): AiWriteProvenanceRecord {
  return provenanceRecord(request.provenance);
}

/**
 * The shipped gate: a modal confirmation dialog.
 *
 * Modal on purpose. A toast the author can miss is not "explicit confirmation";
 * the whole point of UR-008 is that a permanent file appears in the manuscript
 * only because a human said so.
 */
@injectable()
export class DialogAiWriteConfirmationService implements AiWriteConfirmationService {
  async confirm(request: AiWriteConfirmationRequest): Promise<boolean> {
    const dialog = new ConfirmDialog({
      title: nls.localize(
        'ai-focused-editor/workspace/ai-write-confirm-title',
        'AI wants to create {0}',
        request.artifactLabel
      ),
      msg: aiWriteConfirmationMessage(request),
      ok: nls.localize('ai-focused-editor/workspace/ai-write-confirm-ok', 'Create'),
      cancel: nls.localize('ai-focused-editor/workspace/ai-write-confirm-cancel', 'Cancel')
    });
    // `open()` resolves `undefined` when the dialog is dismissed rather than
    // answered; only a literal `true` is consent.
    return (await dialog.open()) === true;
  }
}
