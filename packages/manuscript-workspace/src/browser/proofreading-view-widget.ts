import URI from '@theia/core/lib/common/uri';
import { nls } from '@theia/core/lib/common/nls';
import { CommandService, DisposableCollection } from '@theia/core/lib/common';
import { open, OpenerService } from '@theia/core/lib/browser';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import {
  inject,
  injectable,
  postConstruct
} from '@theia/core/shared/inversify';
import React from '@theia/core/shared/react';
import { formatProgressChip } from '../common';
import type { ProofreadingSetEntry } from '../common/author-materials';
import { ProofreadingSetsService } from './proofreading-sets-service';

/** Debounce for the vault-change → refresh path (mirrors the tree model's cadence). */
const AUTO_REFRESH_DELAY_MS = 300;

/**
 * The Proofreading side view — an activity-bar/left-area {@link ReactWidget}
 * (NOT an editor) that lists the book's proofreading SETS. Each row shows the
 * set label + its verified-progress chip (`N/M ✓`); clicking a row opens the
 * set's `proofset.yaml` through the {@link OpenerService}, which the priority-500
 * Proofreading open handler turns into the two-pane editor. The header carries a
 * "+ New Proofreading Set" button (wired to the existing
 * `ai-focused-editor.proofreading.newSet` command) and a Refresh. Set
 * enumeration is delegated to {@link ProofreadingSetsService} (the same pure
 * `proofset.yaml` scan the navigator uses), never duplicated here.
 *
 * The widget refreshes on `proofreading/**` vault changes (debounced), so
 * creating a set or verifying pages keeps the list live in Proofreading Mode.
 */
@injectable()
export class ProofreadingViewWidget extends ReactWidget {
  static readonly ID = 'ai-focused-editor.proofreading-view';
  static readonly LABEL = 'Proofreading';

  /** Command id of the existing "New Proofreading Set..." flow (reused verbatim). */
  static readonly NEW_SET_COMMAND = 'ai-focused-editor.proofreading.newSet';

  @inject(ProofreadingSetsService)
  protected readonly setsService!: ProofreadingSetsService;

  @inject(OpenerService)
  protected readonly openerService!: OpenerService;

  @inject(CommandService)
  protected readonly commands!: CommandService;

  @inject(FileService)
  protected readonly fileService!: FileService;

  protected sets: ProofreadingSetEntry[] | undefined;
  protected refreshHandle: ReturnType<typeof setTimeout> | undefined;
  protected readonly toDispose = new DisposableCollection();

  @postConstruct()
  protected init(): void {
    this.id = ProofreadingViewWidget.ID;
    this.title.label = nls.localize('ai-focused-editor/proofreading-mode/view-label', 'Proofreading');
    this.title.caption = nls.localize(
      'ai-focused-editor/proofreading-mode/view-caption',
      'Proofreading sets (scan / OCR / translation review)'
    );
    this.title.iconClass = 'codicon codicon-checklist';
    this.title.closable = true;
    this.addClass('afe-proofreading-view');
    // Refresh when the book's proofreading area changes (create set, verify page).
    this.toDispose.push(this.fileService.onDidFilesChange(event => {
      const affects = event.changes.some(change => change.resource.toString().includes('/proofreading/'));
      if (affects) {
        this.scheduleRefresh();
      }
    }));
    void this.refresh();
  }

  override dispose(): void {
    if (this.refreshHandle !== undefined) {
      clearTimeout(this.refreshHandle);
      this.refreshHandle = undefined;
    }
    this.toDispose.dispose();
    super.dispose();
  }

  /** Re-enumerate the sets and re-render. Never throws (empty list on failure). */
  async refresh(): Promise<void> {
    try {
      this.sets = await this.setsService.list();
    } catch {
      this.sets = [];
    }
    this.update();
  }

  protected scheduleRefresh(): void {
    if (this.refreshHandle !== undefined) {
      clearTimeout(this.refreshHandle);
    }
    this.refreshHandle = setTimeout(() => {
      this.refreshHandle = undefined;
      void this.refresh();
    }, AUTO_REFRESH_DELAY_MS);
  }

  protected render(): React.ReactNode {
    return React.createElement(
      'div',
      { className: 'afe-proofreading-view-body' },
      this.renderHeader(),
      this.renderContent()
    );
  }

  protected renderHeader(): React.ReactNode {
    return React.createElement(
      'div',
      { className: 'afe-proofreading-view-header' },
      React.createElement(
        'button',
        {
          className: 'theia-button afe-proofreading-view-newset',
          title: nls.localize('ai-focused-editor/proofreading-mode/new-set-tooltip', 'Create a new proofreading set'),
          onClick: () => void this.commands.executeCommand(ProofreadingViewWidget.NEW_SET_COMMAND)
        },
        nls.localize('ai-focused-editor/proofreading-mode/new-set-button', '+ New Proofreading Set')
      ),
      React.createElement(
        'button',
        {
          className: 'theia-button secondary afe-proofreading-view-refresh',
          title: nls.localize('ai-focused-editor/proofreading-mode/refresh-tooltip', 'Refresh proofreading sets'),
          onClick: () => void this.refresh()
        },
        nls.localize('ai-focused-editor/proofreading-mode/refresh-button', 'Refresh')
      )
    );
  }

  protected renderContent(): React.ReactNode {
    const sets = this.sets;
    if (sets === undefined) {
      return React.createElement(
        'p',
        { className: 'afe-proofreading-view-loading' },
        nls.localize('ai-focused-editor/proofreading-mode/loading', 'Loading proofreading sets...')
      );
    }
    if (sets.length === 0) {
      return React.createElement(
        'p',
        { className: 'afe-proofreading-view-empty' },
        nls.localize(
          'ai-focused-editor/proofreading-mode/empty',
          'No proofreading sets yet. Create a new one.'
        )
      );
    }
    return React.createElement(
      'ul',
      { className: 'afe-proofreading-view-list' },
      ...sets.map(set => this.renderSet(set))
    );
  }

  protected renderSet(set: ProofreadingSetEntry): React.ReactNode {
    return React.createElement(
      'li',
      {
        key: set.slug,
        className: 'afe-proofreading-view-item',
        title: nls.localize('ai-focused-editor/proofreading-mode/open-set', 'Open {0}', set.label),
        onClick: () => void this.openSet(set.uri)
      },
      React.createElement('span', { className: 'afe-proofreading-view-item-label' }, set.label),
      React.createElement(
        'span',
        { className: 'afe-proofreading-view-item-chip' },
        formatProgressChip({ verified: set.verified, total: set.total })
      )
    );
  }

  /** Open a set's `proofset.yaml`; the priority-500 handler shows the two-pane editor. */
  protected async openSet(uri: string): Promise<void> {
    try {
      await open(this.openerService, new URI(uri));
    } catch {
      // Opening is best-effort; a stale/removed set must not break the view.
    }
  }
}
