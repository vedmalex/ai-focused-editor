import { nls } from '@theia/core/lib/common/nls';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import React from '@theia/core/shared/react';
import {
  UsageBreakdownEntry,
  UsageRollup,
  UsageTotals,
  rollupUsage
} from '../common';
import { AiRequestLogRecord } from '../common/ai-history-log';
import { AiRequestLogMode, AiRequestLogService } from './ai-request-log-service';

/** No per-day cap: a usage report must aggregate every logged leg. */
const READ_ALL = -1;

interface AiUsageState {
  loading: boolean;
  mode: AiRequestLogMode;
  dayCount: number;
  rollup: UsageRollup;
}

/**
 * Read-only token-usage report over the per-leg AI request log. Reads back the
 * `requests-<date>.jsonl` records the package already writes (via
 * `AiRequestLogService`), aggregates them with the pure `rollupUsage`, and
 * renders grand totals plus breakdowns by alias and by day. Book-agnostic: the
 * host application places the `ai-connect.openUsage` command into its own menu.
 */
@injectable()
export class AiUsageWidget extends ReactWidget {
  static readonly ID = 'ai-connect.ai-usage';
  static readonly LABEL = nls.localize('ai-focused-editor/ai-usage/label', 'AI Token Usage');

  @inject(AiRequestLogService)
  protected readonly requestLog!: AiRequestLogService;

  protected state: AiUsageState = {
    loading: false,
    mode: 'off',
    dayCount: 0,
    rollup: rollupUsage([])
  };

  @postConstruct()
  protected init(): void {
    this.id = AiUsageWidget.ID;
    this.title.label = AiUsageWidget.LABEL;
    this.title.caption = nls.localize('ai-focused-editor/ai-usage/caption', 'Aggregated AI token usage from the request log');
    this.title.iconClass = 'fa fa-coins';
    this.title.closable = true;
    this.addClass('afe-ai-usage');
    void this.refresh();
  }

  async refresh(): Promise<void> {
    this.state = { ...this.state, loading: true, mode: this.requestLog.getMode() };
    this.update();
    const days = await this.requestLog.listDays();
    const records: AiRequestLogRecord[] = [];
    for (const day of days) {
      records.push(...await this.requestLog.readDay(day, READ_ALL));
    }
    this.state = {
      loading: false,
      mode: this.requestLog.getMode(),
      dayCount: days.length,
      rollup: rollupUsage(records)
    };
    this.update();
  }

  protected render(): React.ReactNode {
    const { loading, dayCount, rollup } = this.state;
    return React.createElement(
      'div',
      { className: 'afe-ai-usage-body' },
      this.renderHeader(),
      loading && dayCount === 0
        ? React.createElement('p', { className: 'afe-ai-usage-empty' }, nls.localize('ai-focused-editor/ai-usage/loading', 'Loading token usage…'))
        : dayCount === 0
          ? this.renderEmptyHint()
          : React.createElement(
            React.Fragment,
            undefined,
            this.renderTotals(rollup.totals),
            this.renderBreakdown(
              nls.localize('ai-focused-editor/ai-usage/by-alias', 'By alias'),
              nls.localize('ai-focused-editor/ai-usage/col-alias', 'Alias'),
              rollup.byAlias
            ),
            this.renderBreakdown(
              nls.localize('ai-focused-editor/ai-usage/by-day', 'By day'),
              nls.localize('ai-focused-editor/ai-usage/col-day', 'Day'),
              rollup.byDay
            )
          )
    );
  }

  protected renderHeader(): React.ReactNode {
    return React.createElement(
      'div',
      { className: 'afe-ai-usage-actions' },
      React.createElement('h3', undefined, AiUsageWidget.LABEL),
      React.createElement('span', { className: 'afe-ai-debug-log-badge' }, this.state.mode),
      React.createElement(
        'button',
        { className: 'theia-button', onClick: () => this.refresh() },
        nls.localize('ai-focused-editor/ai-usage/refresh', 'Refresh')
      )
    );
  }

  protected renderEmptyHint(): React.ReactNode {
    return React.createElement(
      'p',
      { className: 'afe-ai-usage-empty' },
      nls.localize(
        'ai-focused-editor/ai-usage/empty-hint',
        'AI request log is off or empty — enable aiConnect.requestLog to record per-request token usage.'
      )
    );
  }

  protected renderTotals(totals: UsageTotals): React.ReactNode {
    const cells: Array<[string, number]> = [
      [nls.localize('ai-focused-editor/ai-usage/col-input', 'Input'), totals.inputTokens],
      [nls.localize('ai-focused-editor/ai-usage/col-output', 'Output'), totals.outputTokens],
      [nls.localize('ai-focused-editor/ai-usage/col-total', 'Total'), totals.totalTokens],
      [nls.localize('ai-focused-editor/ai-usage/col-requests', 'Requests'), totals.requests]
    ];
    return React.createElement(
      'section',
      { className: 'afe-ai-usage-section afe-ai-usage-totals' },
      React.createElement('h4', undefined, nls.localize('ai-focused-editor/ai-usage/totals-heading', 'Totals')),
      React.createElement(
        'div',
        { className: 'afe-ai-usage-total-cards' },
        ...cells.map(([label, value]) => React.createElement(
          'div',
          { className: 'afe-ai-usage-card', key: label },
          React.createElement('span', { className: 'afe-ai-usage-card-value' }, formatNumber(value)),
          React.createElement('span', { className: 'afe-ai-usage-card-label' }, label)
        ))
      )
    );
  }

  protected renderBreakdown(heading: string, keyLabel: string, entries: UsageBreakdownEntry[]): React.ReactNode {
    return React.createElement(
      'section',
      { className: 'afe-ai-usage-section' },
      React.createElement('h4', undefined, `${heading} (${entries.length})`),
      entries.length === 0
        ? React.createElement('p', { className: 'afe-ai-usage-empty' }, nls.localize('ai-focused-editor/ai-usage/no-rows', 'No usage recorded.'))
        : React.createElement(
          'table',
          { className: 'afe-ai-usage-table' },
          React.createElement(
            'thead',
            undefined,
            React.createElement(
              'tr',
              undefined,
              React.createElement('th', undefined, keyLabel),
              React.createElement('th', { className: 'afe-ai-usage-num' }, nls.localize('ai-focused-editor/ai-usage/col-input', 'Input')),
              React.createElement('th', { className: 'afe-ai-usage-num' }, nls.localize('ai-focused-editor/ai-usage/col-output', 'Output')),
              React.createElement('th', { className: 'afe-ai-usage-num' }, nls.localize('ai-focused-editor/ai-usage/col-total', 'Total')),
              React.createElement('th', { className: 'afe-ai-usage-num' }, nls.localize('ai-focused-editor/ai-usage/col-requests', 'Requests'))
            )
          ),
          React.createElement(
            'tbody',
            undefined,
            ...entries.map(entry => React.createElement(
              'tr',
              { key: entry.key },
              React.createElement('td', undefined, entry.key),
              React.createElement('td', { className: 'afe-ai-usage-num' }, formatNumber(entry.inputTokens)),
              React.createElement('td', { className: 'afe-ai-usage-num' }, formatNumber(entry.outputTokens)),
              React.createElement('td', { className: 'afe-ai-usage-num' }, formatNumber(entry.totalTokens)),
              React.createElement('td', { className: 'afe-ai-usage-num' }, formatNumber(entry.requests))
            ))
          )
        )
    );
  }
}

function formatNumber(value: number): string {
  return value.toLocaleString('en-US');
}
