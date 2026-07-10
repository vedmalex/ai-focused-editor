import { DisposableCollection } from '@theia/core/lib/common';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { PreferenceService } from '@theia/core/lib/common/preferences';
import URI from '@theia/core/lib/common/uri';
import {
  Diagnostic,
  DiagnosticSeverity
} from '@theia/core/shared/vscode-languageserver-protocol';
import { inject, injectable } from '@theia/core/shared/inversify';
import { EditorManager } from '@theia/editor/lib/browser/editor-manager';
import type { EditorWidget } from '@theia/editor/lib/browser/editor-widget';
import type { TextEditor } from '@theia/editor/lib/browser/editor';
import { ProblemManager } from '@theia/markers/lib/browser/problem/problem-manager';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { ManuscriptWorkspaceBackendService, WorkspaceDiagnostic } from '../common';

/** Distinct marker owner so live markers never collide with the manual
 *  workspace-validate command (`ai-focused-editor.workspace`); an active file
 *  may briefly carry both until the next manual run, which is acceptable. */
export const LIVE_VALIDATION_OWNER = 'ai-focused-editor.live';

/** Boolean preference gating the whole live-validation feature. */
export const LIVE_VALIDATION_PREFERENCE = 'aiFocusedEditor.validation.live';

/** Coalesce keystroke bursts into one backend round-trip per window. */
const LIVE_VALIDATION_DELAY_MS = 400;

/**
 * Live incremental validation for the active document (backlog item: the
 * practical value of the deferred LSP work without monaco-languageclient).
 *
 * Tracks the editors the writer visits and, on each debounced content change,
 * asks the backend to validate the current (possibly unsaved) buffer text.
 * Results are published to the Problems view under a dedicated owner for the
 * document's own uri. Mirrors the editor-tracking + debounce shape of
 * `SemanticMarkdownDecorationService`; the manual whole-workspace command is
 * untouched and complementary.
 */
@injectable()
export class LiveValidationContribution implements FrontendApplicationContribution {
  @inject(EditorManager)
  protected readonly editorManager!: EditorManager;

  @inject(ManuscriptWorkspaceBackendService)
  protected readonly backendWorkspace!: ManuscriptWorkspaceBackendService;

  @inject(ProblemManager)
  protected readonly problemManager!: ProblemManager;

  @inject(WorkspaceService)
  protected readonly workspaceService!: WorkspaceService;

  @inject(PreferenceService)
  protected readonly preferenceService!: PreferenceService;

  protected readonly toDispose = new DisposableCollection();
  protected readonly editorDisposables = new Map<TextEditor, DisposableCollection>();
  protected readonly pendingUpdates = new Map<TextEditor, ReturnType<typeof setTimeout>>();
  /** Uris that currently hold live markers, for wholesale cleanup. */
  protected readonly markedUris = new Set<string>();

  onStart(): void {
    this.toDispose.push(this.editorManager.onCurrentEditorChanged(widget => this.trackEditor(widget)));
    this.toDispose.push(this.preferenceService.onPreferenceChanged(change => {
      if (change.preferenceName === LIVE_VALIDATION_PREFERENCE) {
        this.onToggle();
      }
    }));
    this.trackEditor(this.editorManager.currentEditor ?? this.editorManager.activeEditor);
  }

  onStop(): void {
    this.toDispose.dispose();
    for (const editor of this.editorDisposables.keys()) {
      this.cancelScheduledUpdate(editor);
    }
    this.editorDisposables.clear();
    this.clearAllMarkers();
  }

  protected trackEditor(widget: EditorWidget | undefined): void {
    const editor = widget?.editor;
    if (!editor || this.editorDisposables.has(editor)) {
      return;
    }

    const disposables = new DisposableCollection();
    this.editorDisposables.set(editor, disposables);
    disposables.push(editor.onDocumentContentChanged(() => this.scheduleUpdate(editor)));
    disposables.push(widget.onDispose(() => {
      this.cancelScheduledUpdate(editor);
      this.clearMarkers(editor.uri);
      this.editorDisposables.get(editor)?.dispose();
      this.editorDisposables.delete(editor);
    }));

    void this.validate(editor);
  }

  protected scheduleUpdate(editor: TextEditor): void {
    this.cancelScheduledUpdate(editor);
    this.pendingUpdates.set(editor, setTimeout(() => {
      this.pendingUpdates.delete(editor);
      void this.validate(editor);
    }, LIVE_VALIDATION_DELAY_MS));
  }

  protected cancelScheduledUpdate(editor: TextEditor): void {
    const pending = this.pendingUpdates.get(editor);
    if (pending !== undefined) {
      clearTimeout(pending);
      this.pendingUpdates.delete(editor);
    }
  }

  /** Preference flipped: re-lint the current buffer, or wipe live markers. */
  protected onToggle(): void {
    if (!this.isEnabled()) {
      this.clearAllMarkers();
      return;
    }
    const editor = (this.editorManager.currentEditor ?? this.editorManager.activeEditor)?.editor;
    if (editor) {
      void this.validate(editor);
    }
  }

  protected async validate(editor: TextEditor): Promise<void> {
    if (!this.isEnabled() || !this.isValidatable(editor.uri)) {
      return;
    }

    const rootUri = await this.getRootUri();
    if (!rootUri) {
      return;
    }
    const relative = new URI(rootUri).relative(editor.uri);
    if (!relative) {
      // Outside the workspace root: leave it to nothing (never our markers).
      return;
    }

    const text = editor.document.getText();
    let diagnostics: WorkspaceDiagnostic[];
    try {
      diagnostics = await this.backendWorkspace.validateDocumentText(rootUri, relative.toString(), text);
    } catch {
      // Transient backend error: keep the last published markers rather than
      // flashing them away mid-edit.
      return;
    }

    this.publish(editor.uri, diagnostics);
  }

  protected publish(uri: URI, diagnostics: WorkspaceDiagnostic[]): void {
    const markers: Diagnostic[] = diagnostics.map(diagnostic => ({
      message: diagnostic.message,
      source: diagnostic.source,
      severity: this.toDiagnosticSeverity(diagnostic.severity),
      range: diagnostic.range ?? {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 1 }
      }
    }));

    this.problemManager.setMarkers(uri, LIVE_VALIDATION_OWNER, markers);
    if (markers.length > 0) {
      this.markedUris.add(uri.toString());
    } else {
      this.markedUris.delete(uri.toString());
    }
  }

  protected clearMarkers(uri: URI): void {
    if (this.markedUris.delete(uri.toString())) {
      this.problemManager.setMarkers(uri, LIVE_VALIDATION_OWNER, []);
    }
  }

  protected clearAllMarkers(): void {
    for (const uri of this.markedUris) {
      this.problemManager.setMarkers(new URI(uri), LIVE_VALIDATION_OWNER, []);
    }
    this.markedUris.clear();
  }

  /** Coarse client-side filter so non-schema files skip the RPC entirely;
   *  the backend remains the authority on routing. */
  protected isValidatable(uri: URI): boolean {
    const ext = uri.path.ext.toLowerCase();
    return ext === '.md' || ext === '.markdown' || ext === '.yaml' || ext === '.yml';
  }

  protected isEnabled(): boolean {
    return this.preferenceService.get<boolean>(LIVE_VALIDATION_PREFERENCE, true) !== false;
  }

  protected async getRootUri(): Promise<string | undefined> {
    await this.workspaceService.ready;
    const root = this.workspaceService.tryGetRoots()[0] ?? (await this.workspaceService.roots)[0];
    return root?.resource.toString();
  }

  protected toDiagnosticSeverity(severity: WorkspaceDiagnostic['severity']): DiagnosticSeverity {
    switch (severity) {
      case 'error':
        return DiagnosticSeverity.Error;
      case 'warning':
        return DiagnosticSeverity.Warning;
      case 'info':
        return DiagnosticSeverity.Information;
    }
  }
}
