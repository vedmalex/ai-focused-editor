import URI from '@theia/core/lib/common/uri';
import { MessageService } from '@theia/core/lib/common';
import { nls } from '@theia/core/lib/common/nls';
import { Navigatable } from '@theia/core/lib/browser';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import {
  inject,
  injectable,
  optional
} from '@theia/core/shared/inversify';
import React from '@theia/core/shared/react';
import type { SourceLibraryService as SourceLibraryServiceType } from '../common';
import { SourceLibraryService } from '../common';
import {
  EMPTY_EXCERPT_ROW,
  hasBlockingExcerptProblems,
  parseExcerptsJsonl,
  serializeExcerptsJsonl,
  validateExcerpts,
  type ExcerptFormRow,
  type ExcerptProblem,
  type UnparsedExcerptLine
} from '../common/excerpt-forms';

const NONE_OPTION = '';

function truncate(value: string, max = 64): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

/**
 * Form-based editor for `sources/excerpts.jsonl` (spec §5.4). The file is a
 * JSON-lines index: one JSON object per line. The widget parses through the pure
 * {@link parseExcerptsJsonl} helper, so every unknown key round-trips and any
 * line that is not a JSON object is preserved verbatim rather than destroyed —
 * only the recognized fields are surfaced as editable form controls.
 *
 * Expandable cards mirror the AI-modes editor: a collapsed card shows the id, a
 * text preview, and source/ref/target badges; the expanded body edits every
 * field. `source` is bound to a citation-id `<select>` populated from the
 * Sources snapshot (falling back to a free-text input when no citations exist).
 */
@injectable()
export class ExcerptsEditorWidget extends ReactWidget implements Navigatable {
  static readonly FACTORY_ID = 'ai-focused-editor.excerpts-editor';
  static readonly LABEL = 'Excerpts';

  @inject(FileService)
  protected readonly fileService!: FileService;

  @inject(MessageService)
  protected readonly messageService!: MessageService;

  @inject(SourceLibraryService) @optional()
  protected readonly sourceLibrary?: SourceLibraryServiceType;

  protected uri!: URI;
  protected rows: ExcerptFormRow[] = [];
  protected unparsed: UnparsedExcerptLine[] = [];
  protected citationIds: string[] = [];
  protected selectedIndex: number | undefined;
  protected loading = false;
  protected dirty = false;
  protected watcherInstalled = false;

  configure(uri: URI): void {
    this.uri = uri;
    this.id = `${ExcerptsEditorWidget.FACTORY_ID}:${uri.toString()}`;
    this.title.label = nls.localize('ai-focused-editor/sources/excerpts-label', 'Excerpts');
    this.title.caption = nls.localize('ai-focused-editor/sources/excerpts-caption', 'Excerpts form: {0}', uri.path.fsPath());
    this.title.iconClass = 'fa fa-list-alt';
    this.title.closable = true;
    this.addClass('afe-excerpts-editor-widget');
    if (!this.watcherInstalled) {
      this.watcherInstalled = true;
      // Save Selection as Citation and source analysis append to this file on
      // disk; reflect those live while the form has no unsaved edits.
      this.toDispose.push(this.fileService.onDidFilesChange(event => {
        if (!this.dirty && event.changes.some(change => change.resource.toString() === this.uri.toString())) {
          void this.load();
        }
      }));
    }
    void this.load();
  }

  getResourceUri(): URI | undefined {
    return this.uri;
  }

  createMoveToUri(resourceUri: URI): URI | undefined {
    return resourceUri;
  }

  protected async load(): Promise<void> {
    this.loading = true;
    this.update();
    try {
      const content = await this.readTextIfExists(this.uri);
      const { rows, unparsed } = parseExcerptsJsonl(content ?? '');
      this.rows = rows;
      this.unparsed = unparsed;
    } catch {
      this.rows = [];
      this.unparsed = [];
    }
    this.citationIds = await this.loadCitationIds();
    this.loading = false;
    this.dirty = false;
    this.selectedIndex = this.rows.length > 0 ? 0 : undefined;
    this.update();
  }

  /** Citation ids from the Sources snapshot, for the `source` select. */
  protected async loadCitationIds(): Promise<string[]> {
    if (!this.sourceLibrary) {
      return [];
    }
    try {
      const snapshot = await this.sourceLibrary.getSnapshot();
      const ids = snapshot.citations
        .map(citation => citation.id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
      return Array.from(new Set(ids)).sort((a, b) => a.localeCompare(b));
    } catch {
      return [];
    }
  }

  protected updateRow<K extends keyof ExcerptFormRow>(index: number, field: K, value: ExcerptFormRow[K]): void {
    this.rows = this.rows.map((row, rowIndex) => rowIndex === index ? { ...row, [field]: value } : row);
    this.dirty = true;
    this.update();
  }

  protected addRow(): void {
    this.rows = [...this.rows, { ...EMPTY_EXCERPT_ROW }];
    this.selectedIndex = this.rows.length - 1;
    this.dirty = true;
    this.update();
  }

  protected deleteRow(index: number): void {
    this.rows = this.rows.filter((_, rowIndex) => rowIndex !== index);
    if (this.selectedIndex !== undefined) {
      if (this.selectedIndex === index) {
        this.selectedIndex = this.rows.length > 0 ? Math.min(index, this.rows.length - 1) : undefined;
      } else if (this.selectedIndex > index) {
        this.selectedIndex -= 1;
      }
    }
    this.dirty = true;
    this.update();
  }

  protected toggleSelected(index: number): void {
    this.selectedIndex = this.selectedIndex === index ? undefined : index;
    this.update();
  }

  protected async save(): Promise<void> {
    const problems = validateExcerpts(this.rows);
    if (hasBlockingExcerptProblems(problems)) {
      await this.messageService.error(nls.localize(
        'ai-focused-editor/sources/excerpts-save-error',
        'Fix the highlighted excerpt problems before saving (ids must be present and unique, and each excerpt needs text).'
      ));
      return;
    }
    try {
      const content = serializeExcerptsJsonl(this.rows, this.unparsed);
      await this.fileService.write(this.uri, content);
      // Re-read so the in-memory rows reflect exactly what was written.
      await this.load();
      await this.messageService.info(nls.localize('ai-focused-editor/sources/saved-file', 'Saved {0}.', this.uri.path.base));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.messageService.error(nls.localize('ai-focused-editor/sources/excerpts-save-failed', 'Could not save excerpts: {0}', detail));
    }
  }

  protected async readTextIfExists(resource: URI): Promise<string | undefined> {
    try {
      return (await this.fileService.read(resource)).value;
    } catch {
      return undefined;
    }
  }

  protected render(): React.ReactNode {
    if (this.loading || !this.uri) {
      return React.createElement(
        'div',
        { className: 'afe-excerpts-editor' },
        nls.localize('ai-focused-editor/sources/excerpts-loading', 'Loading excerpts...')
      );
    }

    const problems = validateExcerpts(this.rows);
    return React.createElement(
      'div',
      { className: 'afe-excerpts-editor' },
      React.createElement(
        'div',
        { className: 'afe-excerpts-editor-header' },
        React.createElement('h3', undefined, nls.localize('ai-focused-editor/sources/excerpts-label', 'Excerpts')),
        React.createElement('span', { className: 'afe-excerpts-editor-count' }, `${this.rows.length}`)
      ),
      React.createElement(
        'p',
        { className: 'afe-excerpts-editor-help' },
        nls.localize(
          'ai-focused-editor/sources/excerpts-help-top',
          'Source passages indexed in sources/excerpts.jsonl. Each excerpt can link back to a manuscript file (targetPath + targetLine) that the Sources view reveals on click.'
        )
      ),
      this.renderUnparsed(),
      this.renderProblems(problems),
      this.rows.length === 0
        ? React.createElement('p', { className: 'afe-excerpts-editor-empty' }, nls.localize('ai-focused-editor/sources/excerpts-empty', 'No excerpts yet. Add one below, or save a citation from the editor.'))
        : React.createElement(
          'ul',
          { className: 'afe-excerpts-editor-cards' },
          ...this.rows.map((row, index) => this.renderCard(row, index, problems))
        ),
      React.createElement(
        'div',
        { className: 'afe-excerpts-editor-actions' },
        React.createElement(
          'button',
          { className: 'theia-button secondary', type: 'button', onClick: () => this.addRow() },
          nls.localize('ai-focused-editor/sources/add-excerpt', 'Add Excerpt')
        ),
        React.createElement(
          'button',
          {
            className: 'theia-button main',
            type: 'button',
            disabled: hasBlockingExcerptProblems(problems),
            title: hasBlockingExcerptProblems(problems)
              ? nls.localize('ai-focused-editor/sources/save-blocked-title', 'Fix the highlighted problems before saving.')
              : undefined,
            onClick: () => { void this.save(); }
          },
          this.dirty
            ? nls.localize('ai-focused-editor/sources/save-dirty', 'Save*')
            : nls.localize('ai-focused-editor/sources/save', 'Save')
        ),
        React.createElement(
          'button',
          { className: 'theia-button secondary', type: 'button', onClick: () => { void this.load(); } },
          nls.localize('ai-focused-editor/sources/reload-from-disk', 'Reload from disk')
        )
      ),
      React.createElement(
        'p',
        { className: 'afe-excerpts-editor-help' },
        nls.localize(
          'ai-focused-editor/sources/excerpts-help-bottom',
          'Saving rewrites one JSON object per line with a stable key order; unknown keys and unparsable lines are preserved. Use "Open With..." to edit the raw JSONL.'
        )
      )
    );
  }

  protected renderUnparsed(): React.ReactNode {
    if (this.unparsed.length === 0) {
      return undefined;
    }
    const count = this.unparsed.length;
    return React.createElement(
      'div',
      { className: 'afe-excerpts-editor-unparsed' },
      React.createElement(
        'span',
        { className: 'afe-excerpts-editor-unparsed-title' },
        count === 1
          ? nls.localize('ai-focused-editor/sources/unparsed-line-singular', '{0} unparsable line preserved verbatim', count)
          : nls.localize('ai-focused-editor/sources/unparsed-line-plural', '{0} unparsable lines preserved verbatim', count)
      ),
      React.createElement(
        'ul',
        { className: 'afe-excerpts-editor-unparsed-list' },
        ...this.unparsed.map((entry, index) => React.createElement(
          'li',
          { key: index, className: 'afe-excerpts-editor-unparsed-line' },
          nls.localize('ai-focused-editor/sources/unparsed-line-detail', 'line {0}: {1}', entry.line, truncate(entry.raw, 120))
        ))
      )
    );
  }

  protected renderProblems(problems: ExcerptProblem[]): React.ReactNode {
    if (problems.length === 0) {
      return undefined;
    }
    return React.createElement(
      'ul',
      { className: 'afe-excerpts-editor-problems' },
      ...problems.map((problem, index) => React.createElement(
        'li',
        { key: index, className: `afe-excerpts-editor-problem ${problem.severity}` },
        problem.message
      ))
    );
  }

  protected renderCard(row: ExcerptFormRow, index: number, problems: ExcerptProblem[]): React.ReactNode {
    const selected = this.selectedIndex === index;
    const rowHasError = problems.some(problem => problem.index === index && problem.severity === 'error');
    return React.createElement(
      'li',
      { key: index, className: `afe-excerpts-editor-card${selected ? ' selected' : ''}${rowHasError ? ' has-error' : ''}` },
      React.createElement(
        'div',
        { className: 'afe-excerpts-editor-card-head' },
        React.createElement(
          'button',
          {
            className: 'afe-excerpts-editor-card-toggle',
            type: 'button',
            onClick: () => this.toggleSelected(index)
          },
          React.createElement('span', { className: `codicon codicon-chevron-${selected ? 'down' : 'right'}` }),
          React.createElement('span', { className: 'afe-excerpts-editor-card-id' }, row.id.trim() || nls.localize('ai-focused-editor/sources/card-new-excerpt', '(new excerpt)')),
          row.text.trim()
            ? React.createElement('span', { className: 'afe-excerpts-editor-card-preview' }, truncate(row.text, 60))
            : undefined,
          ...this.renderBadges(row)
        ),
        React.createElement(
          'button',
          {
            className: 'theia-button secondary afe-excerpts-editor-delete',
            type: 'button',
            title: nls.localize('ai-focused-editor/sources/delete-excerpt-title', 'Delete this excerpt'),
            onClick: () => this.deleteRow(index)
          },
          nls.localize('ai-focused-editor/sources/delete-button', 'Delete')
        )
      ),
      selected ? this.renderCardBody(row, index) : undefined
    );
  }

  protected renderBadges(row: ExcerptFormRow): React.ReactNode[] {
    const badges: React.ReactNode[] = [];
    if ((row.source ?? '').trim()) {
      badges.push(React.createElement('span', { key: 'source', className: 'afe-excerpts-editor-badge source' }, truncate(row.source!, 24)));
    }
    if ((row.ref ?? '').trim()) {
      badges.push(React.createElement('span', { key: 'ref', className: 'afe-excerpts-editor-badge ref' }, 'ref'));
    }
    if ((row.targetPath ?? '').trim()) {
      badges.push(React.createElement('span', { key: 'target', className: 'afe-excerpts-editor-badge target' }, 'target'));
    }
    return badges;
  }

  protected renderCardBody(row: ExcerptFormRow, index: number): React.ReactNode {
    return React.createElement(
      'div',
      { className: 'afe-excerpts-editor-card-body' },
      this.renderInput(
        nls.localize('ai-focused-editor/sources/field-id-label', 'Id'),
        row, index, 'id',
        nls.localize('ai-focused-editor/sources/field-id-placeholder', 'stable slug, e.g. bg-2-47'),
        true
      ),
      this.renderTextarea(
        nls.localize('ai-focused-editor/sources/field-text-label', 'Text'),
        row, index, 'text',
        nls.localize('ai-focused-editor/sources/field-text-placeholder', 'the quoted passage'),
        4, true
      ),
      this.renderSourceField(row, index),
      this.renderInput(
        nls.localize('ai-focused-editor/sources/field-ref-label', 'Ref'),
        row, index, 'ref',
        nls.localize('ai-focused-editor/sources/field-ref-placeholder', 'free-form reference, e.g. Bhagavad-gita 2.47')
      ),
      this.renderTextarea(
        nls.localize('ai-focused-editor/sources/field-note-label', 'Note'),
        row, index, 'note',
        nls.localize('ai-focused-editor/sources/excerpt-note-placeholder', 'author note'),
        2, false
      ),
      this.renderInput(
        nls.localize('ai-focused-editor/sources/field-source-path-label', 'Source path'),
        row, index, 'sourcePath',
        nls.localize('ai-focused-editor/sources/field-source-path-placeholder', 'workspace-relative source document path')
      ),
      React.createElement(
        'fieldset',
        { className: 'afe-excerpts-editor-target' },
        React.createElement('legend', undefined, nls.localize('ai-focused-editor/sources/manuscript-link-legend', 'Manuscript link')),
        this.renderInput(
          nls.localize('ai-focused-editor/sources/field-target-path-label', 'Target path'),
          row, index, 'targetPath',
          nls.localize('ai-focused-editor/sources/field-target-path-placeholder', 'workspace-relative manuscript file to link back to')
        ),
        this.renderInput(
          nls.localize('ai-focused-editor/sources/field-target-anchor-label', 'Target anchor'),
          row, index, 'targetAnchor',
          nls.localize('ai-focused-editor/sources/field-target-anchor-placeholder', 'heading slug within the target file')
        ),
        this.renderTargetLine(row, index)
      )
    );
  }

  protected renderInput(
    label: string,
    row: ExcerptFormRow,
    index: number,
    field: 'id' | 'text' | 'source' | 'ref' | 'note' | 'sourcePath' | 'targetPath' | 'targetAnchor',
    placeholder: string,
    required = false
  ): React.ReactNode {
    return React.createElement(
      'label',
      { className: 'afe-excerpts-editor-field' },
      React.createElement(
        'span',
        undefined,
        label,
        required ? React.createElement('span', { className: 'afe-excerpts-editor-required' }, ' *') : undefined
      ),
      React.createElement('input', {
        value: (row[field] as string | undefined) ?? '',
        placeholder,
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => this.updateRow(index, field, event.currentTarget.value)
      })
    );
  }

  protected renderTextarea(
    label: string,
    row: ExcerptFormRow,
    index: number,
    field: 'text' | 'note',
    placeholder: string,
    rows: number,
    required: boolean
  ): React.ReactNode {
    return React.createElement(
      'label',
      { className: 'afe-excerpts-editor-field' },
      React.createElement(
        'span',
        undefined,
        label,
        required ? React.createElement('span', { className: 'afe-excerpts-editor-required' }, ' *') : undefined
      ),
      React.createElement('textarea', {
        value: (row[field] as string | undefined) ?? '',
        placeholder,
        rows,
        onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => this.updateRow(index, field, event.currentTarget.value)
      })
    );
  }

  /**
   * The `source` control: a citation-id `<select>` when the Sources snapshot has
   * citations (with a "(none)" option and the current value kept visible even if
   * it is not a known citation id), or a plain text input as a fallback.
   */
  protected renderSourceField(row: ExcerptFormRow, index: number): React.ReactNode {
    const current = (row.source ?? '').trim();
    if (this.citationIds.length === 0) {
      return this.renderInput(
        nls.localize('ai-focused-editor/sources/field-source-citation-label', 'Source (citation id)'),
        row, index, 'source',
        nls.localize('ai-focused-editor/sources/field-source-citation-placeholder', 'citation id this excerpt came from')
      );
    }
    const options = [...this.citationIds];
    if (current && !options.includes(current)) {
      options.push(current);
    }
    return React.createElement(
      'label',
      { className: 'afe-excerpts-editor-field' },
      React.createElement('span', undefined, nls.localize('ai-focused-editor/sources/field-source-citation-label', 'Source (citation id)')),
      React.createElement(
        'select',
        {
          value: row.source ?? NONE_OPTION,
          onChange: (event: React.ChangeEvent<HTMLSelectElement>) => this.updateRow(index, 'source', event.currentTarget.value)
        },
        React.createElement('option', { key: '__none__', value: NONE_OPTION }, nls.localize('ai-focused-editor/sources/source-none-option', '(none)')),
        ...options.map(id => React.createElement(
          'option',
          { key: id, value: id },
          this.citationIds.includes(id) ? id : nls.localize('ai-focused-editor/sources/source-unknown-option', '{0} (unknown)', id)
        ))
      )
    );
  }

  protected renderTargetLine(row: ExcerptFormRow, index: number): React.ReactNode {
    return React.createElement(
      'label',
      { className: 'afe-excerpts-editor-field' },
      React.createElement('span', undefined, nls.localize('ai-focused-editor/sources/field-target-line-label', 'Target line')),
      React.createElement('input', {
        type: 'number',
        min: 1,
        step: 1,
        value: row.targetLine === undefined ? '' : String(row.targetLine),
        placeholder: nls.localize('ai-focused-editor/sources/field-target-line-placeholder', '1-based line to reveal'),
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
          const raw = event.currentTarget.value.trim();
          if (raw === '') {
            this.updateRow(index, 'targetLine', undefined);
            return;
          }
          const parsed = Number(raw);
          this.updateRow(index, 'targetLine', Number.isFinite(parsed) ? parsed : undefined);
        }
      })
    );
  }
}
