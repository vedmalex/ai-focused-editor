import URI from '@theia/core/lib/common/uri';
import { MessageService } from '@theia/core/lib/common';
import { nls } from '@theia/core/lib/common/nls';
import { Navigatable } from '@theia/core/lib/browser';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import {
  inject,
  injectable
} from '@theia/core/shared/inversify';
import React from '@theia/core/shared/react';
import { Document, isSeq, parseDocument, YAMLSeq } from 'yaml';
import {
  AI_MODE_CONTEXTS,
  AiModeRegistry,
  type AiModeApply,
  type AiModeContext,
  type AiModeOrigin,
  type ResolvedAiMode
} from '../common';
import {
  aiModeToRow,
  applyOptionsForContext,
  EMPTY_AI_MODE_ROW,
  flattenModes,
  hasBlockingProblems,
  modeToYamlPatch,
  validateModes,
  type AiModeProblem,
  type AiModeRow
} from '../common/ai-mode-forms';

/** Precedence rank of a layer origin; a higher rank overrides a lower one. */
const ORIGIN_RANK: Record<AiModeOrigin, number> = { 'built-in': 0, global: 1, book: 2 };

const CONTEXT_LABELS: Record<AiModeContext, string> = {
  selection: nls.localize('ai-focused-editor/ai-modes/context-selection', 'Selection'),
  word: nls.localize('ai-focused-editor/ai-modes/context-word', 'Word under cursor'),
  chapter: nls.localize('ai-focused-editor/ai-modes/context-chapter', 'Whole chapter'),
  chat: nls.localize('ai-focused-editor/ai-modes/context-chat', 'Chat (no editor input)')
};

const APPLY_LABELS: Record<AiModeApply, string> = {
  replace: nls.localize('ai-focused-editor/ai-modes/apply-replace', 'Replace input'),
  insert: nls.localize('ai-focused-editor/ai-modes/apply-insert', 'Insert after input'),
  chat: nls.localize('ai-focused-editor/ai-modes/apply-chat', 'Send to chat')
};

function originLabel(origin: AiModeOrigin): string {
  switch (origin) {
    case 'built-in':
      return nls.localize('ai-focused-editor/ai-modes/origin-built-in', 'built-in');
    case 'global':
      return nls.localize('ai-focused-editor/ai-modes/origin-global', 'global');
    default:
      return nls.localize('ai-focused-editor/ai-modes/origin-book', 'book');
  }
}

/**
 * Form-based editor for the project's `ai/prompts/custom-modes.yaml` (author
 * AI prompts/agents). The file on disk stays pure YAML: the widget parses
 * through the `yaml` Document API so the document header, the `version` key,
 * and comments survive a round-trip — only the `modes` sequence is rebuilt
 * from the form rows.
 *
 * Saved changes take effect immediately: the dynamic AI-modes contribution
 * watches this file and re-registers menu commands and chat `@agents` on save.
 */
@injectable()
export class AiModesEditorWidget extends ReactWidget implements Navigatable {
  static readonly FACTORY_ID = 'ai-focused-editor.ai-modes-editor';
  static readonly LABEL = nls.localize('ai-focused-editor/ai-modes/editor-label', 'AI Modes');

  @inject(FileService)
  protected readonly fileService!: FileService;

  @inject(MessageService)
  protected readonly messageService!: MessageService;

  @inject(AiModeRegistry)
  protected readonly aiModes!: AiModeRegistry;

  protected uri!: URI;
  protected document: Document | undefined;
  protected rows: AiModeRow[] = [];
  protected selectedIndex: number | undefined;
  protected loading = false;
  protected dirty = false;
  protected parseError: string | undefined;

  /** Which layer this file edits (`book` or `global`), inferred from the URI. */
  protected currentLayer: AiModeOrigin = 'book';
  /** Full layered resolution across all layers, for read-only lower-layer cards + badges. */
  protected resolved: ResolvedAiMode[] = [];

  configure(uri: URI): void {
    this.uri = uri;
    this.id = `${AiModesEditorWidget.FACTORY_ID}:${uri.toString()}`;
    this.title.label = AiModesEditorWidget.LABEL;
    this.title.caption = nls.localize('ai-focused-editor/ai-modes/editor-caption', 'AI modes form: {0}', uri.path.fsPath());
    this.title.iconClass = 'fa fa-magic';
    this.title.closable = true;
    this.addClass('afe-ai-modes-editor-widget');
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
    this.parseError = undefined;
    this.update();
    try {
      const content = await this.readTextIfExists(this.uri);
      const document = content !== undefined && content.trim().length > 0
        ? parseDocument(content)
        : new Document({ version: 1, modes: [] });
      this.parseError = document.errors.length > 0
        ? document.errors.map(error => error.message).join('; ')
        : undefined;
      this.document = document;
      this.rows = flattenModes(document.toJS() ?? {});
      await this.loadResolvedLayers();
    } catch (error) {
      this.document = undefined;
      this.rows = [];
      this.parseError = error instanceof Error ? error.message : String(error);
    } finally {
      this.loading = false;
      this.dirty = false;
      this.selectedIndex = this.rows.length > 0 ? 0 : undefined;
      this.update();
    }
  }

  /**
   * Fetch the layered resolution (bundled/global/book) so the editor can show
   * lower-layer modes read-only and badge book overrides. Infers which layer
   * this file edits by matching the URI against the reported global file.
   */
  protected async loadResolvedLayers(): Promise<void> {
    try {
      const snapshot = await this.aiModes.getSnapshot();
      this.resolved = snapshot.resolved ?? [];
      this.currentLayer = snapshot.globalUri && this.uri.toString() === snapshot.globalUri
        ? 'global'
        : 'book';
    } catch {
      // A missing registry/workspace just means no read-only layers to show.
      this.resolved = [];
      this.currentLayer = 'book';
    }
  }

  /** Ids currently present as editable rows (this layer's own modes). */
  protected editableRowIds(): Set<string> {
    return new Set(this.rows.map(row => row.id.trim()).filter(id => id.length > 0));
  }

  /**
   * Lower-precedence modes to render read-only: modes resolved from a layer below
   * the one being edited that this file does not already override. Sorted by
   * origin then id for a stable display.
   */
  protected readOnlyLowerModes(): ResolvedAiMode[] {
    const rowIds = this.editableRowIds();
    return this.resolved
      .filter(mode => ORIGIN_RANK[mode.origin] < ORIGIN_RANK[this.currentLayer] && !rowIds.has(mode.id))
      .sort((left, right) =>
        ORIGIN_RANK[left.origin] - ORIGIN_RANK[right.origin] || left.id.localeCompare(right.id));
  }

  /** Ids of this layer's rows that shadow a lower layer (badge «переопределяет базовый»). */
  protected overridingRowIds(): Set<string> {
    return new Set(
      this.resolved
        .filter(mode => mode.origin === this.currentLayer && mode.overrides)
        .map(mode => mode.id)
    );
  }

  /**
   * Copy a lower-layer (built-in/global) mode into this file as an editable row.
   * Origin/overrides are dropped — they are never written. The new row is
   * selected and marked dirty, and the read-only card disappears on re-render.
   */
  protected overrideInThisLayer(mode: ResolvedAiMode): void {
    if (this.editableRowIds().has(mode.id)) {
      return;
    }
    this.rows = [...this.rows, aiModeToRow(mode)];
    this.selectedIndex = this.rows.length - 1;
    this.dirty = true;
    this.update();
  }

  protected updateRow<K extends keyof AiModeRow>(index: number, field: K, value: AiModeRow[K]): void {
    this.rows = this.rows.map((row, rowIndex) => {
      if (rowIndex !== index) {
        return row;
      }
      const next = { ...row, [field]: value };
      // When the context changes, an apply that is no longer valid falls back
      // to the first option the new context allows.
      if (field === 'context') {
        const options = applyOptionsForContext(next.context);
        if (!options.includes(next.apply)) {
          next.apply = options[0];
        }
      }
      return next;
    });
    this.dirty = true;
    this.update();
  }

  protected addRow(): void {
    this.rows = [...this.rows, { ...EMPTY_AI_MODE_ROW }];
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

  /**
   * Rewrite the `modes` sequence from the current rows while keeping the
   * document header, the `version` key, and any sibling keys/comments intact.
   */
  protected serialize(): string {
    const document = this.document && this.document.contents != null
      ? this.document
      : new Document({ version: 1, modes: [] });

    let seq: YAMLSeq;
    if (isSeq(document.contents)) {
      seq = document.contents;
    } else {
      const current = document.get('modes');
      if (isSeq(current)) {
        seq = current;
      } else {
        seq = new YAMLSeq();
        document.set('modes', seq);
      }
    }

    seq.items = [];
    for (const row of this.rows) {
      seq.add(document.createNode(modeToYamlPatch(row).write));
    }
    return document.toString();
  }

  protected async save(): Promise<void> {
    const problems = validateModes(this.rows);
    if (hasBlockingProblems(problems)) {
      await this.messageService.error(nls.localize('ai-focused-editor/ai-modes/fix-problems', 'Fix the highlighted mode problems before saving (ids must be present, unique, and each mode needs a system prompt).'));
      return;
    }
    try {
      const content = this.serialize();
      await this.fileService.write(this.uri, content);
      // Re-read so the in-memory document (and comments) reflect what was written.
      await this.load();
      await this.messageService.info(nls.localize('ai-focused-editor/ai-modes/saved', 'Saved {0}.', this.uri.path.base));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.messageService.error(nls.localize('ai-focused-editor/ai-modes/save-failed', 'Could not save AI modes: {0}', detail));
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
      return React.createElement('div', { className: 'afe-ai-modes-editor' }, nls.localize('ai-focused-editor/ai-modes/loading', 'Loading AI modes...'));
    }

    const problems = validateModes(this.rows);
    return React.createElement(
      'div',
      { className: 'afe-ai-modes-editor' },
      React.createElement(
        'div',
        { className: 'afe-ai-modes-editor-header' },
        React.createElement('h3', undefined, nls.localize('ai-focused-editor/ai-modes/heading', 'AI Modes')),
        React.createElement('span', { className: 'afe-ai-modes-editor-count' }, `${this.rows.length}`)
      ),
      React.createElement(
        'p',
        { className: 'afe-ai-modes-editor-help' },
        nls.localize('ai-focused-editor/ai-modes/help-1', 'Author-defined AI prompts and agents. Changes apply immediately: menu entries and @agents re-register on save.')
      ),
      this.parseError
        ? React.createElement(
          'div',
          { className: 'afe-ai-modes-editor-problem error' },
          nls.localize('ai-focused-editor/ai-modes/parse-warning', 'YAML parse warning: {0}', this.parseError)
        )
        : undefined,
      this.renderProblems(problems),
      this.rows.length === 0
        ? React.createElement('p', { className: 'afe-ai-modes-editor-empty' }, nls.localize('ai-focused-editor/ai-modes/empty', 'No AI modes yet. Add one below.'))
        : React.createElement(
          'ul',
          { className: 'afe-ai-modes-editor-cards' },
          ...this.rows.map((row, index) => this.renderCard(row, index, problems))
        ),
      this.renderReadOnlyModes(),
      React.createElement(
        'div',
        { className: 'afe-ai-modes-editor-actions' },
        React.createElement(
          'button',
          { className: 'theia-button secondary', type: 'button', onClick: () => this.addRow() },
          nls.localize('ai-focused-editor/ai-modes/add-mode', 'Add Mode')
        ),
        React.createElement(
          'button',
          {
            className: 'theia-button main',
            type: 'button',
            disabled: hasBlockingProblems(problems),
            title: hasBlockingProblems(problems) ? nls.localize('ai-focused-editor/ai-modes/fix-before-save-title', 'Fix the highlighted problems before saving.') : undefined,
            onClick: () => { void this.save(); }
          },
          this.dirty ? nls.localize('ai-focused-editor/ai-modes/save-dirty', 'Save*') : nls.localize('ai-focused-editor/ai-modes/save', 'Save')
        ),
        React.createElement(
          'button',
          { className: 'theia-button secondary', type: 'button', onClick: () => { void this.load(); } },
          nls.localize('ai-focused-editor/ai-modes/reload', 'Reload from disk')
        )
      ),
      React.createElement(
        'p',
        { className: 'afe-ai-modes-editor-help' },
        nls.localize('ai-focused-editor/ai-modes/help-2', 'Saving writes pure YAML and preserves the file header, the version key, and comments. Use "Open With..." to edit the raw file.')
      )
    );
  }

  protected renderProblems(problems: AiModeProblem[]): React.ReactNode {
    if (problems.length === 0) {
      return undefined;
    }
    return React.createElement(
      'ul',
      { className: 'afe-ai-modes-editor-problems' },
      ...problems.map((problem, index) => React.createElement(
        'li',
        { key: index, className: `afe-ai-modes-editor-problem ${problem.severity}` },
        problem.message
      ))
    );
  }

  protected renderCard(row: AiModeRow, index: number, problems: AiModeProblem[]): React.ReactNode {
    const selected = this.selectedIndex === index;
    const rowHasError = problems.some(problem => problem.index === index && problem.severity === 'error');
    return React.createElement(
      'li',
      { key: index, className: `afe-ai-modes-editor-card${selected ? ' selected' : ''}${rowHasError ? ' has-error' : ''}` },
      React.createElement(
        'div',
        { className: 'afe-ai-modes-editor-card-head' },
        React.createElement(
          'button',
          {
            className: 'afe-ai-modes-editor-card-toggle',
            type: 'button',
            onClick: () => this.toggleSelected(index)
          },
          React.createElement(
            'span',
            { className: `codicon codicon-chevron-${selected ? 'down' : 'right'}` }
          ),
          React.createElement(
            'span',
            { className: 'afe-ai-modes-editor-card-id' },
            row.id.trim() || nls.localize('ai-focused-editor/ai-modes/new-mode', '(new mode)')
          ),
          row.label.trim()
            ? React.createElement('span', { className: 'afe-ai-modes-editor-card-label' }, row.label.trim())
            : undefined,
          ...this.renderBadges(row)
        ),
        React.createElement(
          'button',
          {
            className: 'theia-button secondary afe-ai-modes-editor-delete',
            type: 'button',
            title: nls.localize('ai-focused-editor/ai-modes/delete-mode-title', 'Delete this mode'),
            onClick: () => this.deleteRow(index)
          },
          nls.localize('ai-focused-editor/ai-modes/delete', 'Delete')
        )
      ),
      selected ? this.renderCardBody(row, index) : undefined
    );
  }

  protected renderBadges(row: AiModeRow): React.ReactNode[] {
    const badges: React.ReactNode[] = [
      React.createElement('span', { key: 'ctx', className: 'afe-ai-modes-editor-badge' }, row.context)
    ];
    if (row.menu) {
      badges.push(React.createElement('span', { key: 'menu', className: 'afe-ai-modes-editor-badge menu' }, nls.localize('ai-focused-editor/ai-modes/badge-menu', 'menu')));
    }
    if (row.agent) {
      badges.push(React.createElement('span', { key: 'agent', className: 'afe-ai-modes-editor-badge agent' }, nls.localize('ai-focused-editor/ai-modes/badge-agent', '@agent')));
    }
    if (!row.enabled) {
      badges.push(React.createElement('span', { key: 'disabled', className: 'afe-ai-modes-editor-badge disabled' }, nls.localize('ai-focused-editor/ai-modes/badge-disabled', 'disabled')));
    }
    if (this.overridingRowIds().has(row.id.trim())) {
      badges.push(React.createElement('span', { key: 'override', className: 'afe-ai-modes-editor-badge override' }, nls.localize('ai-focused-editor/ai-modes/badge-overrides-base', 'overrides base')));
    }
    return badges;
  }

  /**
   * Render the lower-layer (built-in/global) modes as read-only cards with an
   * origin badge and an "override" button that copies the record into this file.
   */
  protected renderReadOnlyModes(): React.ReactNode {
    const modes = this.readOnlyLowerModes();
    if (modes.length === 0) {
      return undefined;
    }
    return React.createElement(
      'div',
      { className: 'afe-ai-modes-editor-readonly' },
      React.createElement('h4', undefined, nls.localize('ai-focused-editor/ai-modes/inherited-heading', 'Inherited modes (read-only)')),
      React.createElement(
        'p',
        { className: 'afe-ai-modes-editor-help' },
        nls.localize('ai-focused-editor/ai-modes/inherited-help', 'Base and global modes are read-only here. Override one to copy it into this file and edit it.')
      ),
      React.createElement(
        'ul',
        { className: 'afe-ai-modes-editor-cards' },
        ...modes.map(mode => this.renderReadOnlyCard(mode))
      )
    );
  }

  protected renderReadOnlyCard(mode: ResolvedAiMode): React.ReactNode {
    const overrideLabel = this.currentLayer === 'global'
      ? nls.localize('ai-focused-editor/ai-modes/override-globally', 'Override globally')
      : nls.localize('ai-focused-editor/ai-modes/override-in-book', 'Override in book');
    return React.createElement(
      'li',
      { key: `${mode.origin}:${mode.id}`, className: 'afe-ai-modes-editor-card readonly' },
      React.createElement(
        'div',
        { className: 'afe-ai-modes-editor-card-head' },
        React.createElement('span', { className: 'afe-ai-modes-editor-card-id' }, mode.id),
        mode.label?.trim() && mode.label.trim() !== mode.id
          ? React.createElement('span', { className: 'afe-ai-modes-editor-card-label' }, mode.label.trim())
          : undefined,
        React.createElement('span', { className: `afe-ai-modes-editor-badge origin ${mode.origin}` }, originLabel(mode.origin)),
        !mode.enabled
          ? React.createElement('span', { className: 'afe-ai-modes-editor-badge disabled' }, nls.localize('ai-focused-editor/ai-modes/badge-disabled', 'disabled'))
          : undefined,
        React.createElement(
          'button',
          {
            className: 'theia-button secondary afe-ai-modes-editor-override',
            type: 'button',
            onClick: () => this.overrideInThisLayer(mode)
          },
          overrideLabel
        )
      ),
      mode.description?.trim()
        ? React.createElement('p', { className: 'afe-ai-modes-editor-readonly-desc' }, mode.description.trim())
        : undefined
    );
  }

  protected renderCardBody(row: AiModeRow, index: number): React.ReactNode {
    return React.createElement(
      'div',
      { className: 'afe-ai-modes-editor-card-body' },
      this.renderInput(nls.localize('ai-focused-editor/ai-modes/field-id', 'Id'), row, index, 'id', nls.localize('ai-focused-editor/ai-modes/field-id-ph', 'kebab-case slug, e.g. improve-selection'), true),
      this.renderInput(nls.localize('ai-focused-editor/ai-modes/field-label', 'Label'), row, index, 'label', nls.localize('ai-focused-editor/ai-modes/field-label-ph', 'menu/agent display name')),
      this.renderInput(nls.localize('ai-focused-editor/ai-modes/field-description', 'Description'), row, index, 'description', nls.localize('ai-focused-editor/ai-modes/field-description-ph', 'short summary')),
      this.renderContextSelect(row, index),
      this.renderApplySelect(row, index),
      this.renderCheckbox(nls.localize('ai-focused-editor/ai-modes/field-enabled', 'Enabled (uncheck to hide from menus, agents and pickers)'), row, index, 'enabled'),
      this.renderCheckbox(nls.localize('ai-focused-editor/ai-modes/field-show-in-menu', 'Show in editor context menu'), row, index, 'menu'),
      this.renderCheckbox(nls.localize('ai-focused-editor/ai-modes/field-register-agent', 'Register as chat @agent'), row, index, 'agent'),
      this.renderInput(nls.localize('ai-focused-editor/ai-modes/field-icon', 'Icon'), row, index, 'icon', nls.localize('ai-focused-editor/ai-modes/field-icon-ph', 'codicon name without the codicon- prefix, e.g. sparkle')),
      this.renderTextarea(nls.localize('ai-focused-editor/ai-modes/field-system-prompt', 'System prompt'), row, index, 'systemPrompt', nls.localize('ai-focused-editor/ai-modes/field-system-prompt-ph', 'instructions sent as the system message'), 5),
      this.renderTextarea(nls.localize('ai-focused-editor/ai-modes/field-user-prompt', 'User prompt'), row, index, 'userPrompt', nls.localize('ai-focused-editor/ai-modes/field-user-prompt-ph', 'optional user message prefix'), 3),
      React.createElement(
        'div',
        { className: 'afe-ai-modes-editor-params' },
        this.renderNumber(nls.localize('ai-focused-editor/ai-modes/field-temperature', 'Temperature'), row, index, 'temperature', '0.2', 0, 2, 0.1),
        this.renderNumber(nls.localize('ai-focused-editor/ai-modes/field-max-tokens', 'Max tokens'), row, index, 'maxTokens', nls.localize('ai-focused-editor/ai-modes/field-max-tokens-ph', 'e.g. 800'), 1, undefined, 1)
      )
    );
  }

  protected renderInput(
    label: string,
    row: AiModeRow,
    index: number,
    field: 'id' | 'label' | 'description' | 'icon',
    placeholder: string,
    required = false
  ): React.ReactNode {
    return React.createElement(
      'label',
      { className: 'afe-ai-modes-editor-field' },
      React.createElement(
        'span',
        undefined,
        label,
        required ? React.createElement('span', { className: 'afe-ai-modes-editor-required' }, ' *') : undefined
      ),
      React.createElement('input', {
        value: row[field],
        placeholder,
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => this.updateRow(index, field, event.currentTarget.value)
      })
    );
  }

  protected renderTextarea(
    label: string,
    row: AiModeRow,
    index: number,
    field: 'systemPrompt' | 'userPrompt',
    placeholder: string,
    rows: number
  ): React.ReactNode {
    return React.createElement(
      'label',
      { className: 'afe-ai-modes-editor-field' },
      React.createElement('span', undefined, label),
      React.createElement('textarea', {
        className: 'afe-ai-modes-editor-monospace',
        value: row[field],
        placeholder,
        rows,
        onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => this.updateRow(index, field, event.currentTarget.value)
      })
    );
  }

  protected renderContextSelect(row: AiModeRow, index: number): React.ReactNode {
    return React.createElement(
      'label',
      { className: 'afe-ai-modes-editor-field' },
      React.createElement('span', undefined, nls.localize('ai-focused-editor/ai-modes/field-context', 'Context')),
      React.createElement(
        'select',
        {
          value: row.context,
          onChange: (event: React.ChangeEvent<HTMLSelectElement>) =>
            this.updateRow(index, 'context', event.currentTarget.value as AiModeContext)
        },
        ...AI_MODE_CONTEXTS.map(context =>
          React.createElement('option', { key: context, value: context }, CONTEXT_LABELS[context]))
      )
    );
  }

  protected renderApplySelect(row: AiModeRow, index: number): React.ReactNode {
    const options = applyOptionsForContext(row.context);
    return React.createElement(
      'label',
      { className: 'afe-ai-modes-editor-field' },
      React.createElement('span', undefined, nls.localize('ai-focused-editor/ai-modes/field-apply-result', 'Apply result')),
      React.createElement(
        'select',
        {
          value: options.includes(row.apply) ? row.apply : options[0],
          onChange: (event: React.ChangeEvent<HTMLSelectElement>) =>
            this.updateRow(index, 'apply', event.currentTarget.value as AiModeApply)
        },
        ...options.map(apply =>
          React.createElement('option', { key: apply, value: apply }, APPLY_LABELS[apply]))
      )
    );
  }

  protected renderCheckbox(
    label: string,
    row: AiModeRow,
    index: number,
    field: 'menu' | 'agent' | 'enabled'
  ): React.ReactNode {
    return React.createElement(
      'label',
      { className: 'afe-ai-modes-editor-field afe-ai-modes-editor-checkbox' },
      React.createElement('input', {
        type: 'checkbox',
        checked: row[field],
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => this.updateRow(index, field, event.currentTarget.checked)
      }),
      React.createElement('span', undefined, label)
    );
  }

  protected renderNumber(
    label: string,
    row: AiModeRow,
    index: number,
    field: 'temperature' | 'maxTokens',
    placeholder: string,
    min: number,
    max: number | undefined,
    step: number
  ): React.ReactNode {
    return React.createElement(
      'label',
      { className: 'afe-ai-modes-editor-field' },
      React.createElement('span', undefined, label),
      React.createElement('input', {
        type: 'number',
        value: row[field],
        placeholder,
        min,
        max,
        step,
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => this.updateRow(index, field, event.currentTarget.value)
      })
    );
  }
}
