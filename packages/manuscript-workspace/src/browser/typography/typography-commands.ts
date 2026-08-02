/**
 * Batch typography commands (TASK-019 W1b, UR-006). Two user-invoked actions —
 * "apply to active file" and "apply to selection" — that run every enabled
 * typography rule over the OPEN buffer as a single undo step, via
 * {@link TypographyBatchService}.
 *
 * These are the DELIBERATE, scope-free counterpart to the live seam: the
 * chapter/all-md scope gate is intentionally not consulted (the user asked for
 * this buffer), only the per-rule enable toggles are — sourced from
 * {@link AutoTypographyContribution.getEnabledRuleIds} so the two paths can never
 * disagree on what "enabled" means.
 *
 * Multi-file batch (`applyToFiles`, with the unopened-file preview gate) is W2.
 */

import {
  Command,
  CommandContribution,
  CommandRegistry,
  MenuContribution,
  MenuModelRegistry,
  MessageService,
  SelectionService
} from '@theia/core/lib/common';
import { UriAwareCommandHandler } from '@theia/core/lib/common/uri-command-handler';
import { nls } from '@theia/core/lib/common/nls';
import URI from '@theia/core/lib/common/uri';
import { ConfirmDialog } from '@theia/core/lib/browser';
import { inject, injectable } from '@theia/core/shared/inversify';
import { EditorManager } from '@theia/editor/lib/browser/editor-manager';
import type { EditorWidget } from '@theia/editor/lib/browser/editor-widget';
import {
  EDITOR_CONTEXT_MENU,
  EditorContextMenu
} from '@theia/editor/lib/browser/editor-menu';
import { NAVIGATOR_CONTEXT_MENU } from '@theia/navigator/lib/browser/navigator-contribution';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import type { FileStat } from '@theia/filesystem/lib/common/files';
import * as monaco from '@theia/monaco-editor-core';
import { MonacoEditor } from '@theia/monaco/lib/browser/monaco-editor';
import { isMarkdownProse } from '../../common/typography/scope-predicate';
import {
  FileGateway,
  MultiFilePlan,
  runTypographyOnFiles
} from '../../common/typography/multi-file-runner';
import { MULTI_FILE_MAX } from '../../common/typography/multi-file-limits';
import { AutoTypographyContribution } from './auto-typography-contribution';
import { TypographyBatchService } from './typography-batch-service';

/**
 * What expanding the Explorer selection produced — the Markdown files AND whether
 * the walk stopped early against {@link MULTI_FILE_MAX}. The two are reported
 * separately on purpose: once dirty buffers are filtered out of `files`, its
 * length can no longer distinguish "a complete 500-file selection" from "the
 * truncated head of a 5000-file one" (QA/ISS-260).
 */
export interface MarkdownWalkResult {
  readonly files: URI[];
  readonly truncated: boolean;
}

export namespace TypographyCommands {
  // en labels are the source of truth; ru comes from i18n/ru/typography.json
  // keyed by `ai-focused-editor/typography/*`. The product-name prefix lives in
  // the label (not a `category`), so only a label key is passed.
  //
  // The command ids use the product's KEBAB namespace `ai-focused-editor.` (not
  // the camelCase `aiFocusedEditor.` used for PREFERENCE keys). That is load
  // bearing, not cosmetic: `INVENTORY_NAMESPACES` in
  // scripts/extract-feature-inventory.mjs only admits `ai-focused-editor.` and
  // `ai-connect.`, so a camelCase command id never reaches the docs inventory
  // and the `covers` gate silently passes over it — a green docs:strict that
  // checks nothing (ISS-243). Preference keys keep their camelCase prefix
  // because they PERSIST in user settings; command ids do not.
  export const APPLY_TO_ACTIVE_FILE: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.typography.applyToActiveFile',
      label: 'AI Focused Editor: Apply Typography to Active File'
    },
    'ai-focused-editor/typography/apply-to-active-file'
  );

  export const APPLY_TO_SELECTION: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.typography.applyToSelection',
      label: 'AI Focused Editor: Apply Typography to Selection'
    },
    'ai-focused-editor/typography/apply-to-selection'
  );

  // Multi-file batch (W2): runs over files/folders picked in the Explorer. Every
  // write goes through the mandatory preview + confirm gate (ISS-219) because an
  // unopened file has no editor undo — only git can revert it.
  export const APPLY_TO_FILES: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.typography.applyToFiles',
      label: 'AI Focused Editor: Apply Typography to Selected Files'
    },
    'ai-focused-editor/typography/apply-to-files'
  );
}

@injectable()
export class TypographyCommandContribution implements CommandContribution, MenuContribution {
  @inject(EditorManager)
  protected readonly editorManager!: EditorManager;

  @inject(TypographyBatchService)
  protected readonly batch!: TypographyBatchService;

  @inject(AutoTypographyContribution)
  protected readonly auto!: AutoTypographyContribution;

  @inject(MessageService)
  protected readonly messages!: MessageService;

  @inject(SelectionService)
  protected readonly selectionService!: SelectionService;

  @inject(FileService)
  protected readonly fileService!: FileService;

  registerCommands(registry: CommandRegistry): void {
    registry.registerCommand(TypographyCommands.APPLY_TO_ACTIVE_FILE, {
      execute: () => this.applyToActiveFile(),
      isEnabled: () => this.hasMarkdownEditor(),
      isVisible: () => this.hasMarkdownEditor()
    });
    registry.registerCommand(TypographyCommands.APPLY_TO_SELECTION, {
      execute: () => this.applyToSelection(),
      isEnabled: () => this.hasNonEmptySelection(),
      isVisible: () => this.hasNonEmptySelection()
    });
    registry.registerCommand(
      TypographyCommands.APPLY_TO_FILES,
      UriAwareCommandHandler.MultiSelect(this.selectionService, {
        execute: uris => this.applyToFiles(uris),
        isEnabled: uris => this.hasFileOrFolderSelection(uris),
        isVisible: uris => this.hasFileOrFolderSelection(uris)
      })
    );
  }

  registerMenus(menus: MenuModelRegistry): void {
    const editorMenuPath = [...EDITOR_CONTEXT_MENU, ...EditorContextMenu.MODIFICATION];
    menus.registerMenuAction(editorMenuPath, { commandId: TypographyCommands.APPLY_TO_ACTIVE_FILE.id });
    menus.registerMenuAction(editorMenuPath, { commandId: TypographyCommands.APPLY_TO_SELECTION.id });
    menus.registerMenuAction([...NAVIGATOR_CONTEXT_MENU, 'z_afe'], {
      commandId: TypographyCommands.APPLY_TO_FILES.id
    });
  }

  protected applyToActiveFile(): void {
    const control = this.activeControl();
    const model = control?.getModel();
    if (!control || !model) {
      void this.messages.warn(nls.localize(
        'ai-focused-editor/typography/batch-open-editor',
        'Open a Markdown editor before running typography.'
      ));
      return;
    }
    const enabledIds = this.auto.getEnabledRuleIds();
    if (enabledIds.size === 0) {
      void this.messages.info(nls.localize(
        'ai-focused-editor/typography/batch-none-enabled',
        'No typography rules are enabled — nothing to apply.'
      ));
      return;
    }
    this.reportApplied(this.batch.applyTo(model, { enabledIds, locale: this.auto.getLocale() }));
  }

  protected applyToSelection(): void {
    const control = this.activeControl();
    const model = control?.getModel();
    if (!control || !model) {
      void this.messages.warn(nls.localize(
        'ai-focused-editor/typography/batch-open-editor',
        'Open a Markdown editor before running typography.'
      ));
      return;
    }
    const selection = control.getSelection();
    if (!selection || selection.isEmpty()) {
      void this.messages.warn(nls.localize(
        'ai-focused-editor/typography/batch-select-text',
        'Select text before running typography on a selection.'
      ));
      return;
    }
    const enabledIds = this.auto.getEnabledRuleIds();
    if (enabledIds.size === 0) {
      void this.messages.info(nls.localize(
        'ai-focused-editor/typography/batch-none-enabled',
        'No typography rules are enabled — nothing to apply.'
      ));
      return;
    }
    this.reportApplied(this.batch.applyTo(model, {
      enabledIds,
      locale: this.auto.getLocale(),
      startLine: selection.startLineNumber,
      endLine: selection.endLineNumber
    }));
  }

  /**
   * Report an open-buffer run. A run that stopped on the pass budget is NOT a
   * plain success (QA/ISS-259): the buffer holds an intermediate state with fixes
   * still pending, exactly the condition the multi-file path already refuses to
   * pass off as done (ISS-255). Both observables are reported, so "applied N"
   * followed by the warning is the honest shape of a truncated run.
   */
  protected reportApplied(result: { applied: number; converged: boolean }): void {
    if (result.applied === 0 && result.converged) {
      void this.messages.info(nls.localize(
        'ai-focused-editor/typography/batch-clean',
        'Typography: nothing to fix.'
      ));
      return;
    }
    if (result.applied > 0) {
      void this.messages.info(nls.localize(
        'ai-focused-editor/typography/batch-applied',
        'Typography: applied {0} fix(es).',
        String(result.applied)
      ));
    }
    if (!result.converged) {
      void this.messages.warn(nls.localize(
        'ai-focused-editor/typography/batch-buffer-not-converged',
        'Typography: fixes were still pending when the pass limit was reached — run the command again.'
      ));
    }
  }

  /**
   * Multi-file batch (W2, ISS-219). Expands the Explorer selection to Markdown
   * files, computes a dry-run preview, and — ONLY after the user confirms —
   * writes the changed files. An unopened file has no editor undo, so the
   * preview/confirm gate is mandatory and reversal is git-only.
   *
   * DIRTY EDITORS ARE EXCLUDED, NOT WARNED-AND-WRITTEN (ISS-246). This path
   * writes through the FileService, i.e. straight past any open editor buffer.
   * For a file with unsaved changes that means the user's in-editor work is
   * overwritten by disk content the moment we write, and the still-dirty buffer
   * will overwrite US on its next save — a coin-flip either way. Merging the two
   * is out of scope (that is the live typography seam's job), so the decision is
   * to DROP such files from the run and tell the user to save first. The
   * alternative considered — listing them in the preview and writing anyway —
   * was rejected: the preview is a confirmation, not informed consent to lose
   * unsaved text, and this command's whole contract is manuscript safety.
   */
  protected async applyToFiles(uris: URI[]): Promise<void> {
    const enabledIds = this.auto.getEnabledRuleIds();
    if (enabledIds.size === 0) {
      void this.messages.info(nls.localize(
        'ai-focused-editor/typography/batch-none-enabled',
        'No typography rules are enabled — nothing to apply.'
      ));
      return;
    }

    let collected: MarkdownWalkResult;
    try {
      collected = await this.collectMarkdownFiles(uris);
    } catch {
      void this.messages.warn(nls.localize(
        'ai-focused-editor/typography/batch-files-read-failed',
        'Could not read the selected files.'
      ));
      return;
    }

    let files = collected.files;
    if (files.length === 0) {
      void this.messages.info(nls.localize(
        'ai-focused-editor/typography/batch-files-none',
        'No Markdown files found in the selection.'
      ));
      return;
    }

    // THE CAP IS CHECKED ON THE WALK RESULT, BEFORE THE DIRTY FILTER (QA/ISS-260).
    // It used to be checked on `files.length` AFTER dirty buffers were removed,
    // so a 600-file selection containing even one unsaved buffer fell back to
    // exactly MULTI_FILE_MAX and slipped through: the walk had been TRUNCATED,
    // the user got no warning, and the run reported "wrote 500 file(s)" over a
    // silently partial traversal. `truncated` is the walk's own observation and
    // no later filtering can erase it.
    if (collected.truncated) {
      // NO CONCRETE COUNT HERE (QA/ISS-258). `collectMarkdownFiles` ABORTS the
      // walk once it is one past the cap, so the collected length is always
      // MULTI_FILE_MAX + 1 — reporting it told a user with 5000 selected files
      // that they had "501". The threshold is the only number we actually know.
      void this.messages.warn(nls.localize(
        'ai-focused-editor/typography/batch-files-too-many',
        'The selection has more than {0} Markdown files — more than one run allows. Narrow the selection.',
        String(MULTI_FILE_MAX)
      ));
      return;
    }

    // Drop files that are open with unsaved changes (see the JSDoc above).
    const dirty = this.dirtyEditorPaths();
    if (dirty.size > 0) {
      const kept = files.filter(uri => !dirty.has(uri.toString()));
      if (kept.length !== files.length) {
        void this.messages.warn(nls.localize(
          'ai-focused-editor/typography/batch-files-dirty-skipped',
          'Typography: skipped {0} file(s) with unsaved changes — save them first, then run again.',
          String(files.length - kept.length)
        ));
      }
      files = kept;
      if (files.length === 0) {
        return;
      }
    }

    const byPath = new Map<string, URI>(files.map(uri => [uri.toString(), uri]));
    const locale = this.auto.getLocale();
    const gateway: FileGateway = {
      read: async path => (await this.fileService.read(byPath.get(path)!)).value,
      write: async (path, content) => { await this.fileService.write(byPath.get(path)!, content); }
    };

    // ISS-255: a file whose rule set did not reach a fixpoint inside the pass
    // budget was left HALF-transformed. Counting them here is what keeps the
    // final report honest — otherwise those files are indistinguishable from
    // cleanly-finished ones in the "wrote N file(s)" line.
    let notConverged = 0;
    const result = await runTypographyOnFiles(
      files.map(uri => uri.toString()),
      gateway,
      text => {
        const run = this.batch.runOnText(text, { enabledIds, locale });
        if (!run.converged) {
          notConverged += 1;
        }
        return run;
      },
      plan => this.confirmMultiFile(plan, byPath)
    );

    if (result.planned === 0) {
      void this.messages.info(nls.localize(
        'ai-focused-editor/typography/batch-clean',
        'Typography: nothing to fix.'
      ));
      return;
    }
    if (result.cancelled) {
      void this.messages.info(nls.localize(
        'ai-focused-editor/typography/batch-files-cancelled',
        'Typography: cancelled — no files were changed.'
      ));
      return;
    }

    // A partial run MUST be reported as such (ISS-246). `writtenEdits`, not
    // `totalEdits`, is what actually landed once anything was skipped or failed.
    if (result.written > 0) {
      void this.messages.info(nls.localize(
        'ai-focused-editor/typography/batch-files-applied',
        'Typography: wrote {0} file(s), {1} fix(es) total.',
        String(result.written),
        String(result.writtenEdits)
      ));
    }
    if (result.skipped > 0) {
      void this.messages.warn(nls.localize(
        'ai-focused-editor/typography/batch-files-skipped-changed',
        'Typography: skipped {0} file(s) that changed on disk after the preview — nothing was overwritten. Run again to include them.',
        String(result.skipped)
      ));
    }
    if (result.failed > 0) {
      void this.messages.warn(nls.localize(
        'ai-focused-editor/typography/batch-files-failed',
        'Typography: could not write {0} file(s); the remaining files were applied.',
        String(result.failed)
      ));
    }
    if (notConverged > 0) {
      void this.messages.warn(nls.localize(
        'ai-focused-editor/typography/batch-files-not-converged',
        'Typography: {0} file(s) still had pending fixes when the pass limit was reached — run the command again on them.',
        String(notConverged)
      ));
    }
  }

  /**
   * URIs (as strings) of editors open with UNSAVED changes. `document` is a
   * `Saveable`, so `dirty` is the same flag the tab's dot renders from.
   */
  protected dirtyEditorPaths(): Set<string> {
    const dirty = new Set<string>();
    for (const widget of this.editorManager.all) {
      if (widget.editor.document.dirty) {
        dirty.add(widget.editor.uri.toString());
      }
    }
    return dirty;
  }

  /**
   * Show the mandatory dry-run preview and return the user's decision. Lists each
   * changed file with its edit count and warns that the change is reversible only
   * through git (there is no editor undo for an unopened file). Resolving `false`
   * MUST leave every file untouched (the runner never writes without a `true`).
   */
  protected async confirmMultiFile(plan: MultiFilePlan, byPath: Map<string, URI>): Promise<boolean> {
    const lines = plan.changes
      .slice(0, 40)
      .map(change => {
        const uri = byPath.get(change.path);
        const label = uri ? uri.path.base : change.path;
        return `• ${label} — ${change.editCount}`;
      });
    if (plan.changes.length > 40) {
      lines.push(nls.localize(
        'ai-focused-editor/typography/batch-files-more',
        '…and {0} more file(s).',
        String(plan.changes.length - 40)
      ));
    }
    const body = document.createElement('div');
    const summary = document.createElement('p');
    summary.textContent = nls.localize(
      'ai-focused-editor/typography/batch-files-preview',
      'Typography will change {0} file(s), {1} fix(es) total. This writes directly to disk and can be reverted only with git (Ctrl+Z will NOT undo it).',
      String(plan.totalFiles),
      String(plan.totalEdits)
    );
    const list = document.createElement('pre');
    list.style.maxHeight = '12em';
    list.style.overflow = 'auto';
    list.textContent = lines.join('\n');
    body.appendChild(summary);
    body.appendChild(list);

    const dialog = new ConfirmDialog({
      title: nls.localize('ai-focused-editor/typography/batch-files-title', 'Apply typography to selected files'),
      msg: body,
      ok: nls.localize('ai-focused-editor/typography/batch-files-write', 'Write {0} file(s)', String(plan.totalFiles)),
      cancel: nls.localizeByDefault('Cancel')
    });
    return !!(await dialog.open());
  }

  /**
   * Expand the selection (files and/or folders) into the set of Markdown files.
   * Folders are resolved recursively via the FileService; duplicates collapse.
   *
   * `truncated` is the ONLY honest signal that the walk stopped early — the
   * caller cannot re-derive it from `files.length` once anything (dirty buffers)
   * has been filtered out (QA/ISS-260).
   */
  protected async collectMarkdownFiles(uris: URI[]): Promise<MarkdownWalkResult> {
    const seen = new Map<string, URI>();
    let truncated = false;
    const visit = async (uri: URI): Promise<void> => {
      if (seen.size > MULTI_FILE_MAX) {
        truncated = true;
        return;
      }
      let stat: FileStat;
      try {
        stat = await this.fileService.resolve(uri);
      } catch {
        return;
      }
      if (stat.isDirectory) {
        for (const child of stat.children ?? []) {
          await visit(child.resource);
        }
        return;
      }
      if (isMarkdownProse(uri.path.toString())) {
        seen.set(uri.toString(), uri);
      }
    };
    for (const uri of uris) {
      await visit(uri);
    }
    // `seen.size > MULTI_FILE_MAX` is ORed in deliberately: the in-walk flag only
    // fires on a visit ATTEMPTED past the ceiling, so a selection of exactly
    // MULTI_FILE_MAX + 1 files fills the map and then simply runs out of URIs —
    // over the cap, yet never re-entering the guard.
    return { files: [...seen.values()], truncated: truncated || seen.size > MULTI_FILE_MAX };
  }

  /** True when the Explorer selection has at least one file/folder URI. */
  protected hasFileOrFolderSelection(uris: URI[]): boolean {
    return uris.some(uri => uri.scheme === 'file');
  }

  /** The active editor's Monaco control, when one is open. */
  protected activeControl(): monaco.editor.IStandaloneCodeEditor | undefined {
    const widget = this.activeWidget();
    if (!widget) {
      return undefined;
    }
    return MonacoEditor.get(widget)?.getControl();
  }

  protected activeWidget(): EditorWidget | undefined {
    return this.editorManager.currentEditor ?? this.editorManager.activeEditor;
  }

  /** True when a Markdown editor is active (batch is text/markdown-oriented). */
  protected hasMarkdownEditor(): boolean {
    const widget = this.activeWidget();
    return !!widget && isMarkdownProse(widget.editor.uri.path.toString()) && !!this.activeControl();
  }

  /** True when a Markdown editor is active with a non-empty selection. */
  protected hasNonEmptySelection(): boolean {
    if (!this.hasMarkdownEditor()) {
      return false;
    }
    const selection = this.activeControl()?.getSelection();
    return !!selection && !selection.isEmpty();
  }
}
