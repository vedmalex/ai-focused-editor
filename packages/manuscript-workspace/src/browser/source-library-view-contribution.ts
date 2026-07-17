import {
  Command,
  CommandRegistry,
  DisposableCollection,
  MenuModelRegistry,
  MessageService,
  QuickInputService,
  QuickPickItem
} from '@theia/core/lib/common';
import URI from '@theia/core/lib/common/uri';
import { nls } from '@theia/core/lib/common/nls';
import { inject, injectable } from '@theia/core/shared/inversify';
import { AbstractViewContribution } from '@theia/core/lib/browser/shell/view-contribution';
import { FileDialogService } from '@theia/filesystem/lib/browser';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { EditorManager } from '@theia/editor/lib/browser/editor-manager';
import { EDITOR_CONTEXT_MENU, EditorContextMenu } from '@theia/editor/lib/browser/editor-menu';
import * as monaco from '@theia/monaco-editor-core';
import { Document, isSeq, parseDocument, YAMLSeq } from 'yaml';
import { SourceLibraryWidget } from './source-library-widget';
import {
  AiFocusedEditorMenus
} from './ai-focused-editor-menu';
import {
  AiConnectionService,
  AiModeRegistry,
  generateWithFailover,
  SourceLibraryBackendService,
  SourceLibraryService,
  SourceLibrarySnapshot,
  SourceTextExtraction,
  normalizeRange
} from '../common';
import { slugifyChapter } from '../common/knowledge-generation';
import {
  AnalyzedCitation,
  buildExcerptRecords,
  buildSelectionExcerptRecord,
  citationSlugFromText,
  citationTitleFromText,
  coerceSourceAnalysis,
  countSlugOccurrences,
  dedupeCitationId,
  dedupeCitations,
  ExcerptRecord
} from '../common/source-analysis';
import { AiProfilePreferenceService } from '@ai-focused-editor/ai-connect-theia/lib/browser';
import { AiRequestLogService } from '@ai-focused-editor/ai-connect-theia/lib/browser';
import {
  AiHistoryRecord,
  AiHistoryService
} from '@ai-focused-editor/ai-connect-theia/lib/browser';

export namespace SourceLibraryCommands {
  // en labels/category stay inline as the source of truth; ru comes from
  // i18n/ru/sources.json keyed by `ai-focused-editor/sources/*`.
  const CATEGORY_KEY = 'ai-focused-editor/sources/category';

  export const OPEN: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.sources.open',
      label: 'AI Focused Editor: Open Sources'
    },
    'ai-focused-editor/sources/open'
  );

  export const REFRESH: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.sources.refresh',
      label: 'AI Focused Editor: Refresh Sources'
    },
    'ai-focused-editor/sources/refresh'
  );

  export const ATTACH: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.sources.attach',
      label: 'AI Focused Editor: Attach Source File...'
    },
    'ai-focused-editor/sources/attach'
  );

  export const ANALYZE: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.sources.analyze',
      label: 'AI Focused Editor: Analyze Source Document...'
    },
    'ai-focused-editor/sources/analyze'
  );

  export const SAVE_SELECTION_AS_CITATION: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.sources.saveSelectionAsCitation',
      category: 'AI Focused Editor',
      label: 'Save Selection as Citation...'
    },
    'ai-focused-editor/sources/save-selection-as-citation',
    CATEGORY_KEY
  );
}

const IMAGE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'tif', 'tiff', 'ico', 'avif'
]);

/** Text-like source documents the "Analyze Source Document" command can read directly (spec §5.4). */
const TEXT_SOURCE_EXTENSIONS = new Set(['md', 'txt', 'markdown']);

/** Binary documents the analyzer extracts text from server-side before analysis (spec §5.4). */
const PDF_SOURCE_EXTENSIONS = new Set(['pdf']);

/** AiMode id looked up in the project's `custom-modes.yaml` for source analysis. */
const ANALYZE_SOURCE_MODE_ID = 'analyze-source';
/** logContext id used when no project mode overrides the builtin prompt. */
const BUILTIN_ANALYZE_SOURCE_MODE_ID = 'builtin-analyze-source';
/** Character cap on the source text sent to the model. */
const ANALYZE_SOURCE_CHAR_LIMIT = 24000;

/** STRICT-JSON fallback prompt used when the project defines no `analyze-source` mode. */
const BUILTIN_ANALYZE_SOURCE_PROMPT = [
  'You are a research assistant indexing a source document for a manuscript.',
  'Read the source document and extract two things:',
  '1. "excerpts": the 5-12 most quotable/citable passages, quoted faithfully from the text.',
  '2. "citations": bibliographic-style entries the document supports (works, sections, or references it cites or embodies).',
  'Respond ONLY with a JSON object of the exact shape',
  '{"excerpts": [{"text": string, "note"?: string, "ref"?: string}],',
  ' "citations": [{"id": string, "title"?: string, "source"?: string, "note"?: string}]}.',
  'Each citation "id" is a short, url-safe slug (lowercase, hyphenated). No text outside the JSON.'
].join('\n');

const CITATION_LINK_PATTERN = /\[@cite:([^\]\s]+)\]/g;
const SNAPSHOT_CACHE_TTL_MS = 5000;

/** An analyzable source document discovered under `sources/`. */
interface TextSourceFile {
  /** Last path segment, e.g. `gita-notes.md`. */
  name: string;
  /** Workspace-relative path, e.g. `sources/documents/gita-notes.md`. */
  path: string;
  /** Absolute file URI string. */
  uri: string;
  /** True for `.pdf` sources whose text is extracted server-side before analysis. */
  isPdf: boolean;
}

interface SourceQuickPickItem extends QuickPickItem {
  source: TextSourceFile;
}

@injectable()
export class SourceLibraryViewContribution extends AbstractViewContribution<SourceLibraryWidget> {
  @inject(FileDialogService)
  protected readonly fileDialogService!: FileDialogService;

  @inject(FileService)
  protected readonly fileService!: FileService;

  @inject(WorkspaceService)
  protected readonly workspaceService!: WorkspaceService;

  @inject(MessageService)
  protected readonly messageService!: MessageService;

  @inject(SourceLibraryService)
  protected readonly sourceLibrary!: SourceLibraryService;

  @inject(SourceLibraryBackendService)
  protected readonly sourceLibraryBackend!: SourceLibraryBackendService;

  @inject(QuickInputService)
  protected readonly quickInput!: QuickInputService;

  @inject(AiConnectionService)
  protected readonly aiConnection!: AiConnectionService;

  @inject(AiProfilePreferenceService)
  protected readonly aiProfilePreferences!: AiProfilePreferenceService;

  @inject(AiRequestLogService)
  protected readonly requestLog!: AiRequestLogService;

  @inject(AiModeRegistry)
  protected readonly aiModes!: AiModeRegistry;

  @inject(AiHistoryService)
  protected readonly aiHistory!: AiHistoryService;

  @inject(EditorManager)
  protected readonly editorManager!: EditorManager;

  protected readonly toDispose = new DisposableCollection();
  protected linkProviderRegistered = false;
  protected cachedSnapshot: SourceLibrarySnapshot | undefined;
  protected snapshotExpiresAt = 0;

  constructor() {
    super({
      widgetId: SourceLibraryWidget.ID,
      widgetName: SourceLibraryWidget.LABEL,
      defaultWidgetOptions: {
        area: 'left',
        rank: 215
      },
      toggleCommandId: SourceLibraryCommands.OPEN.id
    });
  }

  override registerCommands(commands: CommandRegistry): void {
    super.registerCommands(commands);
    commands.registerCommand(SourceLibraryCommands.REFRESH, {
      execute: async () => {
        const widget = await this.openView({ activate: false, reveal: true });
        await widget.refresh();
      }
    });
    commands.registerCommand(SourceLibraryCommands.ATTACH, {
      execute: () => this.attachSource()
    });
    commands.registerCommand(SourceLibraryCommands.ANALYZE, {
      execute: () => this.analyzeSource()
    });
    commands.registerCommand(SourceLibraryCommands.SAVE_SELECTION_AS_CITATION, {
      execute: () => this.saveSelectionAsCitation()
    });
    // `registerCommands` runs once at frontend startup, so it is a conflict-free
    // place to wire the citation link provider without touching the module.
    this.registerCitationLinkProvider();
  }

  override registerMenus(menus: MenuModelRegistry): void {
    super.registerMenus(menus);
    const menuPath = AiFocusedEditorMenus.SOURCES;
    menus.registerMenuAction(menuPath, {
      commandId: SourceLibraryCommands.OPEN.id
    });
    menus.registerMenuAction(menuPath, {
      commandId: SourceLibraryCommands.REFRESH.id
    });
    menus.registerMenuAction(menuPath, {
      commandId: SourceLibraryCommands.ATTACH.id
    });
    menus.registerMenuAction(menuPath, {
      commandId: SourceLibraryCommands.ANALYZE.id
    });
    menus.registerMenuAction(menuPath, {
      commandId: SourceLibraryCommands.SAVE_SELECTION_AS_CITATION.id
    });
    // Writer-facing action: offer "Save Selection as Citation" right where the
    // text lives, grouped with the other editor AI modification actions (spec
    // FR-009 placement mirrored from the manuscript workspace contribution).
    const editorMenuPath = [...EDITOR_CONTEXT_MENU, ...EditorContextMenu.MODIFICATION];
    menus.registerMenuAction(editorMenuPath, {
      commandId: SourceLibraryCommands.SAVE_SELECTION_AS_CITATION.id,
      order: 'z3'
    });
  }

  /**
   * Attach a local file to the workspace: copy it into `sources/images/` or
   * `sources/documents/` (by extension) and refresh the Sources view (FR-015).
   */
  protected async attachSource(): Promise<void> {
    const root = await this.getRoot();
    if (!root) {
      this.messageService.warn(nls.localize(
        'ai-focused-editor/sources/attach-needs-workspace',
        'Open a manuscript workspace before attaching a source.'
      ));
      return;
    }

    const selected = await this.fileDialogService.showOpenDialog({
      title: nls.localize('ai-focused-editor/sources/attach-dialog-title', 'Attach Source File'),
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false
    });
    const source = Array.isArray(selected) ? selected[0] : selected;
    if (!source) {
      return;
    }

    const fileName = source.path.base;
    const subdir = this.isImage(fileName) ? 'images' : 'documents';
    const sourcesDir = root.resolve('sources');
    const targetDir = sourcesDir.resolve(subdir);
    await this.ensureFolder(sourcesDir);
    await this.ensureFolder(targetDir);

    const target = await this.resolveUniqueTarget(targetDir, fileName);
    try {
      await this.fileService.copy(source, target, { overwrite: false });
    } catch (error) {
      this.messageService.error(nls.localize(
        'ai-focused-editor/sources/attach-failed',
        'Could not attach source: {0}',
        error instanceof Error ? error.message : String(error)
      ));
      return;
    }

    this.invalidateSnapshot();
    const widget = await this.openView({ activate: false, reveal: true });
    await widget.refresh();
    this.messageService.info(nls.localize(
      'ai-focused-editor/sources/attach-success',
      'Attached {0} to sources/{1}/.',
      target.path.base,
      subdir
    ));
  }

  /**
   * Spec §5.4: read a text source document, ask the AI (via the failover chain)
   * for quotable excerpts and citation candidates, then append the excerpts to
   * `sources/excerpts.jsonl` and merge new citations into `sources/citations.yaml`.
   */
  protected async analyzeSource(): Promise<void> {
    const root = await this.getRoot();
    if (!root) {
      this.messageService.warn(nls.localize(
        'ai-focused-editor/sources/analyze-needs-workspace',
        'Open a manuscript workspace before analyzing a source.'
      ));
      return;
    }

    const sourcesDir = root.resolve('sources');
    const candidates = await this.collectTextSources(sourcesDir, root);
    if (candidates.length === 0) {
      this.messageService.warn(nls.localize(
        'ai-focused-editor/sources/analyze-no-documents',
        'No analyzable source documents (.md, .txt, .markdown, .pdf) found under sources/.'
      ));
      return;
    }

    const picked = await this.quickInput.showQuickPick<SourceQuickPickItem>(
      candidates.map(source => ({
        label: source.path,
        description: source.isPdf
          ? nls.localize('ai-focused-editor/sources/analyze-pick-pdf-description', '{0} (PDF)', source.name)
          : source.name,
        source
      })),
      {
        title: nls.localize('ai-focused-editor/sources/analyze-pick-title', 'Analyze Source Document'),
        placeholder: nls.localize(
          'ai-focused-editor/sources/analyze-pick-placeholder',
          'Select a source document to extract excerpts and citations from'
        )
      }
    );
    if (!picked) {
      return;
    }
    const sourceFile = picked.source;
    const documentUri = sourceFile.uri;

    const profile = await this.aiProfilePreferences.getConfiguredProfile(documentUri);
    if (!profile) {
      this.messageService.warn(nls.localize(
        'ai-focused-editor/sources/analyze-needs-profile',
        'Configure an AI connection (add an endpoint and alias in the Model Config view) before analyzing sources.'
      ));
      return;
    }

    let content: string;
    if (sourceFile.isPdf) {
      // PDFs cannot be read as text in the browser; extract server-side (spec §5.4).
      let extraction: SourceTextExtraction;
      try {
        extraction = await this.sourceLibraryBackend.extractSourceText(root.toString(), sourceFile.path);
      } catch (error) {
        extraction = { ok: false, detail: error instanceof Error ? error.message : String(error) };
      }
      if (!extraction.ok || extraction.text === undefined) {
        this.messageService.warn(nls.localize(
          'ai-focused-editor/sources/analyze-extract-failed',
          'Could not extract text from {0}: {1}',
          sourceFile.path,
          extraction.detail ?? nls.localize('ai-focused-editor/sources/analyze-no-extractable-text', 'no extractable text found.')
        ));
        return;
      }
      content = extraction.text;
    } else {
      try {
        content = (await this.fileService.read(new URI(sourceFile.uri))).value;
      } catch (error) {
        this.messageService.error(nls.localize(
          'ai-focused-editor/sources/analyze-read-failed',
          'Could not read {0}: {1}',
          sourceFile.path,
          error instanceof Error ? error.message : String(error)
        ));
        return;
      }
    }

    const truncated = content.length > ANALYZE_SOURCE_CHAR_LIMIT;
    const body = truncated ? content.slice(0, ANALYZE_SOURCE_CHAR_LIMIT) : content;
    const truncationNote = truncated
      ? `\n\n[Note: only the first ${ANALYZE_SOURCE_CHAR_LIMIT} characters of the source were included for analysis.]`
      : '';

    const mode = await this.aiModes.getMode(ANALYZE_SOURCE_MODE_ID);
    const progress = await this.messageService.showProgress({
      text: nls.localize('ai-focused-editor/sources/analyze-progress', 'AI Focused Editor: analyzing source document...')
    });
    try {
      const chain = await this.aiProfilePreferences.getFailoverChain(documentUri);
      const result = await generateWithFailover(this.aiConnection, chain.length > 0 ? chain : [profile], {
        messages: [
          {
            role: 'system',
            content: mode?.systemPrompt || BUILTIN_ANALYZE_SOURCE_PROMPT
          },
          {
            role: 'user',
            content: [
              mode?.userPrompt,
              `Source document path: ${sourceFile.path}`,
              '',
              'Source document text:',
              `${body}${truncationNote}`
            ].filter((line): line is string => line !== undefined).join('\n')
          }
        ],
        parameters: mode?.parameters ?? { temperature: 0.2 },
        logContext: {
          command: SourceLibraryCommands.ANALYZE.id,
          aiModeId: mode?.id ?? BUILTIN_ANALYZE_SOURCE_MODE_ID,
          documentUri,
          workspaceRootUri: root.toString()
        }
      }, this.requestLog.createRecorder(SourceLibraryCommands.ANALYZE.id, documentUri));

      const analysis = coerceSourceAnalysis(result.text);
      // Read a fresh snapshot for id continuation and citation dedupe.
      const snapshot = await this.sourceLibrary.getSnapshot();
      const slug = slugifyChapter(this.stripExtension(sourceFile.name));

      const startIndex = countSlugOccurrences(snapshot.excerpts.map(excerpt => excerpt.id), slug);
      const excerptRecords = buildExcerptRecords(analysis.excerpts, {
        sourceSlug: slug,
        sourcePath: sourceFile.path,
        startIndex
      });
      await this.appendExcerpts(sourcesDir, excerptRecords);

      const dedupe = dedupeCitations(analysis.citations, snapshot.citations.map(citation => citation.id));
      await this.mergeCitations(sourcesDir, dedupe.added);

      this.invalidateSnapshot();
      const widget = await this.openView({ activate: false, reveal: true });
      await widget.refresh();

      const skippedClause = dedupe.skipped.length > 0
        ? nls.localize(
          'ai-focused-editor/sources/analyze-summary-skipped',
          ', skipped {0} existing citation(s)',
          dedupe.skipped.length
        )
        : '';
      const summary = nls.localize(
        'ai-focused-editor/sources/analyze-summary',
        'Analyzed {0}: added {1} excerpt(s) and {2} citation(s){3}.',
        sourceFile.path,
        excerptRecords.length,
        dedupe.added.length,
        skippedClause
      );
      if (analysis.excerpts.length === 0 && analysis.citations.length === 0) {
        this.messageService.warn(nls.localize(
          'ai-focused-editor/sources/analyze-nothing-extracted',
          'No excerpts or citations could be extracted from {0}.',
          sourceFile.path
        ));
      } else {
        this.messageService.info(summary);
      }

      await this.tryAppendChatEvent({
        kind: 'ai-source-analysis',
        command: SourceLibraryCommands.ANALYZE.id,
        documentUri,
        data: {
          sourcePath: sourceFile.path,
          excerptsAdded: excerptRecords.length,
          citationsAdded: dedupe.added.length,
          citationsSkipped: dedupe.skipped,
          truncated,
          aiModeId: mode?.id ?? BUILTIN_ANALYZE_SOURCE_MODE_ID,
          route: result.route,
          warnings: result.warnings,
          usage: result.usage
        }
      });
    } catch (error) {
      await this.tryAppendChatEvent({
        kind: 'ai-command-error',
        command: SourceLibraryCommands.ANALYZE.id,
        documentUri,
        data: {
          sourcePath: sourceFile.path,
          error: error instanceof Error ? error.message : String(error)
        }
      });
      this.messageService.error(nls.localize(
        'ai-focused-editor/sources/analyze-failed',
        'Source analysis failed: {0}',
        error instanceof Error ? error.message : String(error)
      ));
    } finally {
      progress.cancel();
    }
  }

  /**
   * "Выбрать текст и сказать сохрани в цитату": take the active editor's
   * selection, ask for a citation id (prefilled from the leading words and
   * auto-deduped) plus an optional note, then persist BOTH an excerpt line to
   * `sources/excerpts.jsonl` (linked back to the manuscript line) and a citation
   * entry merged into `sources/citations.yaml`. The excerpt/citation then surface
   * in the Sources view with click-to-open so they can be "извлечь потом".
   */
  protected async saveSelectionAsCitation(): Promise<void> {
    const root = await this.getRoot();
    if (!root) {
      this.messageService.warn(nls.localize(
        'ai-focused-editor/sources/save-citation-needs-workspace',
        'Open a manuscript workspace before saving a citation.'
      ));
      return;
    }

    const editor = (this.editorManager.currentEditor ?? this.editorManager.activeEditor)?.editor;
    if (!editor) {
      this.messageService.warn(nls.localize(
        'ai-focused-editor/sources/save-citation-needs-editor',
        'Open a text editor and select text before saving a citation.'
      ));
      return;
    }

    const selection = normalizeRange(editor.selection);
    const selectedText = editor.document.getText(selection);
    if (!selectedText.trim()) {
      this.messageService.warn(nls.localize(
        'ai-focused-editor/sources/save-citation-needs-selection',
        'Select text in the active editor before saving a citation.'
      ));
      return;
    }

    const documentUri = editor.uri.toString();
    const relative = root.relative(editor.uri);
    const sourcePath = relative ? relative.toString() : editor.uri.path.toString();

    // Fresh snapshot so the suggested id and dedupe reflect what is on disk.
    const snapshot = await this.sourceLibrary.getSnapshot();
    const existingIds = snapshot.citations.map(citation => citation.id);
    const suggestedId = dedupeCitationId(citationSlugFromText(selectedText), existingIds);

    const rawId = await this.quickInput.input({
      title: nls.localize('ai-focused-editor/sources/save-citation-dialog-title', 'Save Selection as Citation'),
      prompt: nls.localize('ai-focused-editor/sources/save-citation-id-prompt', 'Citation id (url-safe slug)'),
      value: suggestedId,
      validateInput: async value => {
        const trimmed = value.trim();
        if (!trimmed) {
          return nls.localize('ai-focused-editor/sources/save-citation-id-empty', 'Citation id cannot be empty.');
        }
        if (existingIds.includes(trimmed)) {
          return nls.localize(
            'ai-focused-editor/sources/save-citation-id-exists',
            'A citation with id "{0}" already exists.',
            trimmed
          );
        }
        return undefined;
      }
    });
    if (rawId === undefined) {
      return;
    }
    const citationId = dedupeCitationId(rawId.trim(), existingIds);

    const rawNote = await this.quickInput.input({
      title: nls.localize('ai-focused-editor/sources/save-citation-dialog-title', 'Save Selection as Citation'),
      prompt: nls.localize(
        'ai-focused-editor/sources/save-citation-note-prompt',
        'Optional note (press Enter to skip, Esc to cancel)'
      ),
      placeHolder: nls.localize('ai-focused-editor/sources/save-citation-note-placeholder', 'why this passage matters')
    });
    if (rawNote === undefined) {
      return;
    }
    const note = rawNote.trim() || undefined;

    const sourcesDir = root.resolve('sources');
    await this.ensureFolder(sourcesDir);

    try {
      const excerptRecord = buildSelectionExcerptRecord({
        citationId,
        sourcePath,
        text: selectedText,
        note,
        targetLine: selection.start.line + 1
      });
      await this.appendExcerpts(sourcesDir, [excerptRecord]);

      const citation: AnalyzedCitation = {
        id: citationId,
        title: citationTitleFromText(selectedText),
        source: sourcePath
      };
      if (note) {
        citation.note = note;
      }
      await this.mergeCitations(sourcesDir, [citation]);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.messageService.error(nls.localize(
        'ai-focused-editor/sources/save-citation-failed',
        'Could not save citation: {0}',
        detail
      ));
      await this.tryAppendChatEvent({
        kind: 'ai-command-error',
        command: SourceLibraryCommands.SAVE_SELECTION_AS_CITATION.id,
        documentUri,
        data: { citationId, sourcePath, error: detail }
      });
      return;
    }

    this.invalidateSnapshot();
    const widget = await this.openView({ activate: false, reveal: true });
    await widget.refresh();
    this.messageService.info(nls.localize(
      'ai-focused-editor/sources/save-citation-success',
      'Saved citation "{0}".',
      citationId
    ));

    await this.tryAppendChatEvent({
      kind: 'citation-saved',
      command: SourceLibraryCommands.SAVE_SELECTION_AS_CITATION.id,
      documentUri,
      data: {
        citationId,
        sourcePath,
        targetLine: selection.start.line + 1,
        hasNote: Boolean(note),
        textLength: selectedText.length
      }
    });
  }

  /**
   * Recursively collect text-like source documents under `sources/`. Binaries
   * (images, PDFs, etc.) are skipped by extension; `citations.yaml` and
   * `excerpts.jsonl` are index files, not analyzable sources.
   */
  protected async collectTextSources(sourcesDir: URI, root: URI): Promise<TextSourceFile[]> {
    const results: TextSourceFile[] = [];
    await this.walkTextSources(sourcesDir, root, results, 0);
    results.sort((left, right) => left.path.localeCompare(right.path));
    return results;
  }

  protected async walkTextSources(dir: URI, root: URI, results: TextSourceFile[], depth: number): Promise<void> {
    if (depth > 6) {
      return;
    }
    const stat = await this.fileService.resolve(dir).catch(() => undefined);
    if (!stat) {
      return;
    }
    for (const child of stat.children ?? []) {
      if (child.isDirectory) {
        await this.walkTextSources(child.resource, root, results, depth + 1);
      } else if (this.isTextSource(child.name) || this.isPdfSource(child.name)) {
        const relative = root.relative(child.resource);
        results.push({
          name: child.name,
          path: relative ? relative.toString() : child.resource.path.toString(),
          uri: child.resource.toString(),
          isPdf: this.isPdfSource(child.name)
        });
      }
    }
  }

  protected isTextSource(fileName: string): boolean {
    const dot = fileName.lastIndexOf('.');
    return dot >= 0 && TEXT_SOURCE_EXTENSIONS.has(fileName.slice(dot + 1).toLowerCase());
  }

  protected isPdfSource(fileName: string): boolean {
    const dot = fileName.lastIndexOf('.');
    return dot >= 0 && PDF_SOURCE_EXTENSIONS.has(fileName.slice(dot + 1).toLowerCase());
  }

  protected stripExtension(fileName: string): string {
    const dot = fileName.lastIndexOf('.');
    return dot > 0 ? fileName.slice(0, dot) : fileName;
  }

  /** Append excerpt records as JSON lines to `sources/excerpts.jsonl`. */
  protected async appendExcerpts(sourcesDir: URI, records: ExcerptRecord[]): Promise<void> {
    if (records.length === 0) {
      return;
    }
    const fileUri = sourcesDir.resolve('excerpts.jsonl');
    const lines = records.map(record => JSON.stringify(record)).join('\n');
    const existing = await this.readTextIfExists(fileUri);
    if (existing === undefined || existing.length === 0) {
      await this.fileService.create(fileUri, `${lines}\n`, { overwrite: true });
      return;
    }
    const separator = existing.endsWith('\n') ? '' : '\n';
    await this.fileService.create(fileUri, `${existing}${separator}${lines}\n`, { overwrite: true });
  }

  /**
   * Merge new citations into `sources/citations.yaml` via the YAML Document API,
   * preserving existing comments and entries. Callers pass only deduped entries.
   */
  protected async mergeCitations(sourcesDir: URI, citations: AnalyzedCitation[]): Promise<void> {
    if (citations.length === 0) {
      return;
    }
    const fileUri = sourcesDir.resolve('citations.yaml');
    const existing = await this.readTextIfExists(fileUri);
    const document = existing !== undefined && existing.trim().length > 0
      ? parseDocument(existing)
      : new Document({ version: 1, citations: [] });

    let seq: YAMLSeq;
    if (isSeq(document.contents)) {
      seq = document.contents;
    } else {
      const current = document.get('citations');
      if (isSeq(current)) {
        seq = current;
      } else {
        seq = new YAMLSeq();
        document.set('citations', seq);
      }
    }

    for (const citation of citations) {
      seq.add(document.createNode(this.toCitationEntry(citation)));
    }

    await this.fileService.create(fileUri, document.toString(), { overwrite: true });
  }

  /** Build an ordered `{ id, title?, source?, note? }` entry with only defined fields. */
  protected toCitationEntry(citation: AnalyzedCitation): Record<string, string> {
    const entry: Record<string, string> = { id: citation.id };
    if (citation.title) {
      entry.title = citation.title;
    }
    if (citation.source) {
      entry.source = citation.source;
    }
    if (citation.note) {
      entry.note = citation.note;
    }
    return entry;
  }

  protected async readTextIfExists(resource: URI): Promise<string | undefined> {
    try {
      return (await this.fileService.read(resource)).value;
    } catch {
      return undefined;
    }
  }

  protected async tryAppendChatEvent(record: AiHistoryRecord): Promise<void> {
    try {
      await this.aiHistory.appendChatEvent(record);
    } catch {
      // History is best-effort observability; command UX must not fail on logging.
    }
  }

  protected async resolveUniqueTarget(targetDir: URI, fileName: string): Promise<URI> {
    let candidate = targetDir.resolve(fileName);
    if (!(await this.fileService.exists(candidate))) {
      return candidate;
    }
    const dot = fileName.lastIndexOf('.');
    const base = dot > 0 ? fileName.slice(0, dot) : fileName;
    const ext = dot > 0 ? fileName.slice(dot) : '';
    for (let counter = 1; counter < 1000; counter++) {
      candidate = targetDir.resolve(`${base}-${counter}${ext}`);
      if (!(await this.fileService.exists(candidate))) {
        return candidate;
      }
    }
    return targetDir.resolve(`${base}-${Date.now()}${ext}`);
  }

  protected isImage(fileName: string): boolean {
    const dot = fileName.lastIndexOf('.');
    return dot >= 0 && IMAGE_EXTENSIONS.has(fileName.slice(dot + 1).toLowerCase());
  }

  protected async ensureFolder(uri: URI): Promise<void> {
    try {
      await this.fileService.createFolder(uri);
    } catch {
      // Folder already exists — expected.
    }
  }

  protected async getRoot(): Promise<URI | undefined> {
    await this.workspaceService.ready;
    const root = this.workspaceService.tryGetRoots()[0] ?? (await this.workspaceService.roots)[0];
    return root?.resource;
  }

  /**
   * Register a Monaco link provider that turns `[@cite:id]` references in
   * Markdown into clickable links opening the cited source file (when the
   * citation carries a path) or `sources/citations.yaml` otherwise (FR-015).
   */
  protected registerCitationLinkProvider(): void {
    if (this.linkProviderRegistered) {
      return;
    }
    this.linkProviderRegistered = true;
    this.toDispose.push(monaco.languages.registerLinkProvider(
      { language: 'markdown' },
      {
        provideLinks: model => this.provideCitationLinks(model)
      }
    ));
  }

  protected async provideCitationLinks(model: monaco.editor.ITextModel): Promise<monaco.languages.ILinksList> {
    const snapshot = await this.getSnapshot();
    if (!snapshot || (!snapshot.rootUri && !snapshot.sourceUri)) {
      return { links: [] };
    }

    const text = model.getValue();
    const links: monaco.languages.ILink[] = [];
    CITATION_LINK_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = CITATION_LINK_PATTERN.exec(text)) !== null) {
      const id = match[1];
      const url = this.resolveCitationUrl(snapshot, id);
      if (!url) {
        continue;
      }
      const start = model.getPositionAt(match.index);
      const end = model.getPositionAt(match.index + match[0].length);
      links.push({
        range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
        url,
        tooltip: nls.localize('ai-focused-editor/sources/open-citation-tooltip', 'Open citation {0}', id)
      });
    }
    return { links };
  }

  protected resolveCitationUrl(snapshot: SourceLibrarySnapshot, id: string): string | undefined {
    const citation = snapshot.citations.find(entry => entry.id === id);
    if (citation?.path && snapshot.rootUri) {
      return new URI(snapshot.rootUri).resolve(citation.path).toString();
    }
    if (snapshot.sourceUri) {
      return new URI(snapshot.sourceUri).resolve('citations.yaml').toString();
    }
    return undefined;
  }

  protected async getSnapshot(): Promise<SourceLibrarySnapshot | undefined> {
    const now = Date.now();
    if (this.cachedSnapshot && now < this.snapshotExpiresAt) {
      return this.cachedSnapshot;
    }
    try {
      this.cachedSnapshot = await this.sourceLibrary.getSnapshot();
    } catch {
      // Leave the previous snapshot in place if the RPC fails.
    }
    this.snapshotExpiresAt = now + SNAPSHOT_CACHE_TTL_MS;
    return this.cachedSnapshot;
  }

  protected invalidateSnapshot(): void {
    this.snapshotExpiresAt = 0;
  }
}
