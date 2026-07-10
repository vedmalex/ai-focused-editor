import URI from '@theia/core/lib/common/uri';
import { nls } from '@theia/core/lib/common/nls';
import {
  open,
  OpenerService
} from '@theia/core/lib/browser';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import {
  inject,
  injectable,
  postConstruct
} from '@theia/core/shared/inversify';
import React from '@theia/core/shared/react';
import type { GitStatusService } from '../common';
import { GitStatusService as GitStatusServiceSymbol } from '../common';
import type {
  SemanticHistoryChange,
  SemanticHistoryEntry,
  SemanticHistoryResult
} from '../common';

const h = React.createElement;

const HISTORY_LIMIT = 50;

/** Maps a normalised git status letter to a localizable human word + chip class. */
const STATUS_META: Record<string, { labelKey: string; label: string; className: string }> = {
  A: { labelKey: 'ai-focused-editor/git/status-added', label: 'added', className: 'added' },
  M: { labelKey: 'ai-focused-editor/git/status-modified', label: 'modified', className: 'modified' },
  D: { labelKey: 'ai-focused-editor/git/status-deleted', label: 'deleted', className: 'deleted' },
  R: { labelKey: 'ai-focused-editor/git/status-renamed', label: 'renamed', className: 'renamed' },
  C: { labelKey: 'ai-focused-editor/git/status-copied', label: 'copied', className: 'renamed' }
};

/**
 * Read-only Semantic History view (spec §5.6/§6 FR-017): how semantic entities
 * changed over time. Interactive SCM stays out of scope while @theia/git is
 * version-stalled; this mirrors the read-only git status-bar indicator.
 */
@injectable()
export class SemanticHistoryWidget extends ReactWidget {
  static readonly ID = 'ai-focused-editor.semantic-history';
  static readonly LABEL = nls.localize('ai-focused-editor/git/history-title', 'Semantic History');

  @inject(GitStatusServiceSymbol)
  protected readonly gitStatus!: GitStatusService;

  @inject(WorkspaceService)
  protected readonly workspaceService!: WorkspaceService;

  @inject(OpenerService)
  protected readonly openerService!: OpenerService;

  protected result: SemanticHistoryResult | undefined;
  protected root: URI | undefined;
  protected loading = false;

  @postConstruct()
  protected init(): void {
    this.id = SemanticHistoryWidget.ID;
    this.title.label = SemanticHistoryWidget.LABEL;
    this.title.caption = nls.localize(
      'ai-focused-editor/git/history-caption',
      'AI Focused Editor semantic entity history'
    );
    this.title.iconClass = 'fa fa-history';
    this.title.closable = true;
    this.addClass('afe-semantic-history');
    void this.refresh();
  }

  async refresh(): Promise<void> {
    this.loading = true;
    this.update();
    try {
      await this.workspaceService.ready;
      this.root = this.workspaceService.tryGetRoots()[0]?.resource;
      this.result = await this.gitStatus
        .getSemanticHistory(this.root?.toString(), HISTORY_LIMIT)
        .catch(() => ({ isRepository: false, entries: [] }));
    } finally {
      this.loading = false;
      this.update();
    }
  }

  protected render(): React.ReactNode {
    return h(
      'div',
      { className: 'afe-semantic-history-body' },
      this.renderHeader(),
      this.renderContent()
    );
  }

  protected renderHeader(): React.ReactNode {
    return h(
      'div',
      { className: 'afe-semantic-history-header' },
      h('h3', undefined, nls.localize('ai-focused-editor/git/history-title', 'Semantic History')),
      h(
        'button',
        {
          className: 'theia-button secondary',
          disabled: this.loading,
          onClick: () => this.refresh()
        },
        this.loading
          ? nls.localize('ai-focused-editor/git/refreshing', 'Refreshing...')
          : nls.localize('ai-focused-editor/git/refresh', 'Refresh')
      )
    );
  }

  protected renderContent(): React.ReactNode {
    const result = this.result;
    if (!result) {
      return h(
        'p',
        { className: 'afe-empty-state' },
        this.loading
          ? nls.localize('ai-focused-editor/git/loading', 'Loading semantic history...')
          : nls.localize('ai-focused-editor/git/no-data', 'No data yet.')
      );
    }
    if (!result.isRepository) {
      return h(
        'p',
        { className: 'afe-empty-state' },
        nls.localize('ai-focused-editor/git/init-git-hint', 'Initialize git to track semantic history.')
      );
    }
    if (result.entries.length === 0) {
      return h(
        'p',
        { className: 'afe-empty-state' },
        nls.localize(
          'ai-focused-editor/git/no-semantic-commits',
          'No commits touch semantic entities or domain files yet.'
        )
      );
    }
    return h(
      'div',
      { className: 'afe-semantic-history-list' },
      ...result.entries.map(entry => this.renderEntry(entry))
    );
  }

  protected renderEntry(entry: SemanticHistoryEntry): React.ReactNode {
    return h(
      'div',
      { key: entry.commit || entry.shortCommit, className: 'afe-semantic-history-entry' },
      h(
        'div',
        { className: 'afe-semantic-history-meta' },
        h('span', { className: 'afe-semantic-history-hash', title: entry.commit }, entry.shortCommit),
        h('span', { className: 'afe-semantic-history-date' }, this.formatDate(entry.date)),
        h('span', { className: 'afe-semantic-history-subject', title: entry.subject }, entry.subject),
        entry.author
          ? h('span', { className: 'afe-semantic-history-author' }, entry.author)
          : undefined
      ),
      entry.changes.length === 0
        ? h(
          'span',
          { className: 'afe-semantic-history-empty' },
          nls.localize('ai-focused-editor/git/no-semantic-changes', 'no semantic changes')
        )
        : h(
          'div',
          { className: 'afe-semantic-history-chip-row' },
          ...entry.changes.map((change, index) => this.renderChange(entry, change, index))
        )
    );
  }

  protected renderChange(entry: SemanticHistoryEntry, change: SemanticHistoryChange, index: number): React.ReactNode {
    const meta = STATUS_META[change.status];
    const statusLabel = meta ? nls.localize(meta.labelKey, meta.label) : change.status;
    const className = meta?.className ?? 'modified';
    const key = `${entry.commit}:${index}:${change.path}`;

    if (change.entityKind && change.entityId) {
      const openable = change.status !== 'D';
      const classNames = [
        'afe-semantic-history-chip',
        'entity',
        change.entityKind,
        className,
        openable ? 'openable' : 'disabled'
      ].join(' ');
      return h(
        'span',
        {
          key,
          className: classNames,
          title: openable
            ? nls.localize(
              'ai-focused-editor/git/change-tooltip-openable',
              '{0}: {1} (click to open)',
              statusLabel,
              change.path
            )
            : nls.localize('ai-focused-editor/git/change-tooltip', '{0}: {1}', statusLabel, change.path),
          role: openable ? 'button' : undefined,
          onClick: openable ? () => this.openChange(change) : undefined
        },
        h('span', { className: 'afe-semantic-history-chip-kind' }, change.entityKind),
        `:${change.entityId}`
      );
    }

    return h(
      'span',
      {
        key,
        className: `afe-semantic-history-chip path ${className}`,
        title: nls.localize('ai-focused-editor/git/change-tooltip', '{0}: {1}', statusLabel, change.path)
      },
      change.path
    );
  }

  protected async openChange(change: SemanticHistoryChange): Promise<void> {
    if (!this.root) {
      return;
    }
    await open(this.openerService, this.root.resolve(change.path)).catch(() => undefined);
  }

  protected formatDate(iso: string): string {
    if (!iso) {
      return '';
    }
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
      return iso;
    }
    return date.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }
}
