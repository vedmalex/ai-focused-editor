import {
  Command,
  CommandContribution,
  CommandRegistry,
  MenuContribution,
  MenuModelRegistry,
  MenuPath,
  MessageService,
  ProgressService,
  QuickInputService,
  QuickPickItem,
  QuickPickSeparator,
  UntitledResourceResolver
} from '@theia/core/lib/common';
import URI from '@theia/core/lib/common/uri';
import { nls } from '@theia/core/lib/common/nls';
import type { Widget } from '@theia/core/lib/browser';
import { WidgetManager } from '@theia/core/lib/browser';
import {
  TabBarToolbarContribution,
  TabBarToolbarRegistry
} from '@theia/core/lib/browser/shell/tab-bar-toolbar';
import { EditorManager } from '@theia/editor/lib/browser/editor-manager';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { inject, injectable } from '@theia/core/shared/inversify';
import { parse } from 'yaml';
import { ManuscriptWorkspaceService } from '../common';
import {
  extractMetadataFields,
  flattenManifestRows,
  normalizeManifestPath,
  type ManifestRow
} from '../common/book-config-forms';
import { bookScaffoldEntries } from '../common/book-scaffold';
import {
  assembleBookDoctorReport,
  type BookDoctorFix,
  type BookDoctorReport
} from '../common/book-doctor';
import { AiFocusedEditorMenus } from './ai-focused-editor-menu';
import { ManuscriptTreeWidget } from './manuscript-tree-widget';
import { AFE_MANUSCRIPT_SECTION_CONTEXT_KEY } from './manuscript-tree';

export namespace BookDoctorCommands {
  // en label/category stay inline as the source of truth; ru comes from
  // i18n/ru/doctor.json keyed by `ai-focused-editor/doctor/*`.
  export const DOCTOR: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.book.doctor',
      category: 'AI Focused Editor',
      label: 'Book Doctor...'
    },
    'ai-focused-editor/doctor/doctor',
    'ai-focused-editor/doctor/category'
  );
}

/** Book-properties group in the manuscript tree context menu (shared with book-config/build). */
const TREE_BOOK_MENU: MenuPath = [...ManuscriptTreeWidget.CONTEXT_MENU, '2_book'];

/** Manuscript-scoped: show only for the Manuscript section (or an empty selection). */
const TREE_BOOK_MENU_WHEN =
  `${AFE_MANUSCRIPT_SECTION_CONTEXT_KEY} == 'none' || ${AFE_MANUSCRIPT_SECTION_CONTEXT_KEY} == 'manuscript'`;

interface DoctorPickItem extends QuickPickItem {
  /** Present on fixable rows; absent on informational finding rows. */
  fix?: BookDoctorFix;
  /** Marks the sentinel row that opens the full Markdown report. */
  openReport?: boolean;
}

/** Outcome of the fix picker: apply the chosen fixes, open the report, or cancel. */
type DoctorPickOutcome =
  | { kind: 'apply'; fixes: BookDoctorFix[] }
  | { kind: 'report' }
  | { kind: 'cancel' };

/**
 * "Book Doctor" — inspects the open manuscript workspace, reports what is
 * missing or inconsistent, and offers to create the missing scaffold folders,
 * seed files, and manifest-referenced chapter files. It NEVER deletes anything;
 * report-only findings (orphan content, blank metadata, unparseable sources) are
 * surfaced but left for the author to resolve.
 *
 * Ships in its own standalone frontend module so it stays isolated from the main
 * manuscript-workspace frontend module, reusing the container-scoped services
 * (ManuscriptWorkspaceService, FileService, …) bound there.
 */
@injectable()
export class BookDoctorContribution
  implements CommandContribution, MenuContribution, TabBarToolbarContribution {
  @inject(ManuscriptWorkspaceService)
  protected readonly manuscriptWorkspace!: ManuscriptWorkspaceService;

  @inject(WorkspaceService)
  protected readonly workspaceService!: WorkspaceService;

  @inject(FileService)
  protected readonly fileService!: FileService;

  @inject(QuickInputService)
  protected readonly quickInput!: QuickInputService;

  @inject(ProgressService)
  protected readonly progressService!: ProgressService;

  @inject(MessageService)
  protected readonly messages!: MessageService;

  @inject(WidgetManager)
  protected readonly widgetManager!: WidgetManager;

  @inject(EditorManager)
  protected readonly editorManager!: EditorManager;

  @inject(UntitledResourceResolver)
  protected readonly untitledResources!: UntitledResourceResolver;

  registerCommands(registry: CommandRegistry): void {
    registry.registerCommand(BookDoctorCommands.DOCTOR, {
      execute: () => this.runDoctor(),
      isEnabled: () => this.workspaceService.opened
    });
  }

  registerMenus(menus: MenuModelRegistry): void {
    // Product menu bar, after the create/build book-level commands.
    menus.registerMenuAction(AiFocusedEditorMenus.MAIN, {
      commandId: BookDoctorCommands.DOCTOR.id,
      order: '1b'
    });
    // Manuscript tree context menu, after Build Book... (order '3').
    menus.registerMenuAction(TREE_BOOK_MENU, {
      commandId: BookDoctorCommands.DOCTOR.id,
      when: TREE_BOOK_MENU_WHEN,
      order: '4'
    });
  }

  registerToolbarItems(registry: TabBarToolbarRegistry): void {
    registry.registerItem({
      id: 'ai-focused-editor.bookDoctor.toolbar',
      command: BookDoctorCommands.DOCTOR.id,
      icon: 'codicon codicon-pulse',
      tooltip: nls.localize('ai-focused-editor/doctor/toolbar-tooltip', 'Book Doctor'),
      priority: 4,
      isVisible: (widget: Widget) => widget instanceof ManuscriptTreeWidget
    });
  }

  protected async runDoctor(): Promise<void> {
    const snapshot = await this.manuscriptWorkspace.getSnapshot();
    const rootUri = snapshot.rootUri;
    if (!rootUri) {
      await this.messages.warn(nls.localize(
        'ai-focused-editor/doctor/no-workspace',
        'Open a manuscript workspace before running the Book Doctor.'
      ));
      return;
    }

    const report = await this.progressService.withProgress(
      nls.localize('ai-focused-editor/doctor/checking', 'Checking book structure...'),
      'notification',
      () => this.gather(rootUri)
    );

    if (report.fixes.length === 0 && report.findings.length === 0) {
      await this.messages.info(nls.localize(
        'ai-focused-editor/doctor/healthy',
        'Book structure is healthy — nothing to fix.'
      ));
      return;
    }

    // No auto-fixes: skip the (empty) picker entirely and go straight to the
    // full report so the complete, untruncated findings are readable.
    if (report.fixes.length === 0) {
      await this.openReport(report);
      await this.messages.info(nls.localize(
        'ai-focused-editor/doctor/findings-only',
        'No auto-fixes available. Opened the full report with {0} informational finding(s).',
        report.findings.length
      ));
      return;
    }

    const outcome = await this.pickFixes(report);
    if (outcome.kind === 'cancel') {
      return;
    }
    if (outcome.kind === 'report') {
      await this.openReport(report);
      return;
    }
    await this.applyFixes(new URI(rootUri), outcome.fixes, report);
  }

  /* ----------------------------------------------------------------------- */
  /* Gather (all I/O; delegates check-assembly to the pure book-doctor module) */
  /* ----------------------------------------------------------------------- */

  protected async gather(rootUri: string): Promise<BookDoctorReport> {
    const root = new URI(rootUri);
    const scaffoldEntries = bookScaffoldEntries();

    const contentMarkdownPaths = await this.collectContentMarkdown(root);
    const contentHasMarkdown = contentMarkdownPaths.length > 0;

    // Manifest (gates the coverage checks).
    const manifestUri = root.resolve('manifest.yaml');
    const manifestExists = await this.fileService.exists(manifestUri);
    const manifestRows = manifestExists ? await this.readManifestRows(manifestUri) : [];

    // Existence set covering every path the checks probe (scaffold + manifest rows).
    const candidatePaths = new Set<string>();
    for (const entry of scaffoldEntries) {
      candidatePaths.add(normalizeManifestPath(entry.path));
    }
    for (const row of manifestRows) {
      candidatePaths.add(normalizeManifestPath(row.path));
    }
    const existsSet = await this.buildExistsSet(root, candidatePaths);
    const exists = (path: string): boolean => existsSet.has(normalizeManifestPath(path));

    // Metadata sanity (only when metadata.yaml exists).
    let metadata: { title: string; author: string } | undefined;
    const metadataUri = root.resolve('metadata.yaml');
    if (await this.fileService.exists(metadataUri)) {
      const fields = extractMetadataFields(this.parseYamlSafe(await this.readText(metadataUri)));
      metadata = { title: fields.title, author: fields.author };
    }

    // Sources parse checks (only when the files exist).
    const citationsContent = await this.readTextIfExists(root.resolve('sources/citations.yaml'));
    const excerptsContent = await this.readTextIfExists(root.resolve('sources/excerpts.jsonl'));

    return assembleBookDoctorReport({
      scaffoldEntries,
      exists,
      contentHasMarkdown,
      manifestExists,
      manifestRows,
      contentMarkdownPaths,
      metadata,
      citationsContent,
      excerptsContent
    });
  }

  /** Probe every candidate path in parallel; return the normalized subset that exists. */
  protected async buildExistsSet(root: URI, candidatePaths: Set<string>): Promise<Set<string>> {
    const existing = new Set<string>();
    await Promise.all(
      [...candidatePaths].map(async path => {
        if (!path) {
          return;
        }
        if (await this.fileService.exists(root.resolve(path))) {
          existing.add(path);
        }
      })
    );
    return existing;
  }

  /** Recursively collect workspace-relative `content/**` Markdown paths (sorted). */
  protected async collectContentMarkdown(root: URI): Promise<string[]> {
    const results: string[] = [];
    await this.walkMarkdown(root, root.resolve('content'), results);
    results.sort();
    return results;
  }

  protected async walkMarkdown(root: URI, dir: URI, out: string[]): Promise<void> {
    const stat = await this.fileService.resolve(dir).catch(() => undefined);
    for (const child of stat?.children ?? []) {
      if (child.isDirectory) {
        await this.walkMarkdown(root, child.resource, out);
      } else if (child.isFile) {
        const relative = root.relative(child.resource)?.toString();
        if (relative && relative.toLowerCase().endsWith('.md')) {
          out.push(relative);
        }
      }
    }
  }

  protected async readManifestRows(uri: URI): Promise<ManifestRow[]> {
    const parsed = this.parseYamlSafe(await this.readText(uri));
    return flattenManifestRows(parsed);
  }

  protected parseYamlSafe(text: string): unknown {
    try {
      return parse(text);
    } catch {
      return undefined;
    }
  }

  protected async readText(uri: URI): Promise<string> {
    return (await this.fileService.read(uri)).value;
  }

  protected async readTextIfExists(uri: URI): Promise<string | undefined> {
    try {
      return (await this.fileService.read(uri)).value;
    } catch {
      return undefined;
    }
  }

  /* ----------------------------------------------------------------------- */
  /* Present + apply                                                          */
  /* ----------------------------------------------------------------------- */

  /**
   * Multi-select QuickPick: fixable problems are preselected creation rows;
   * informational findings are appended under a separator and are read-only
   * (picking them is a no-op — the accept handler keeps only rows carrying a
   * `fix`). A trailing sentinel row (`openReport`) opens the full Markdown
   * report where the complete, untruncated findings are readable. Resolves the
   * chosen outcome: apply the fixes, open the report, or cancel (Esc).
   */
  protected pickFixes(report: BookDoctorReport): Promise<DoctorPickOutcome> {
    const fixItems: DoctorPickItem[] = report.fixes.map(fix => ({
      label: fix.path,
      description: fix.description,
      fix
    }));
    const findingItems: DoctorPickItem[] = report.findings.map(finding => ({
      label: finding.label,
      detail: nls.localize(
        'ai-focused-editor/doctor/finding-detail',
        'Informational — selecting has no effect. Open the full report to read the complete message.'
      ),
      alwaysShow: true
    }));
    // Sentinel action row (mirrors the switchAlias pattern): opens the full
    // report instead of applying a fix. It carries no `fix`, so the accept
    // handler never counts it as a creation.
    const reportItem: DoctorPickItem = {
      label: nls.localize('ai-focused-editor/doctor/open-report-item', '$(file-text) Open full report...'),
      openReport: true,
      alwaysShow: true
    };

    const items: Array<DoctorPickItem | QuickPickSeparator> = [...fixItems];
    if (findingItems.length > 0) {
      items.push({
        type: 'separator',
        label: nls.localize('ai-focused-editor/doctor/findings-separator', 'Findings (informational)')
      });
      items.push(...findingItems);
    }
    items.push({ type: 'separator', label: '' });
    items.push(reportItem);

    return new Promise<DoctorPickOutcome>(resolve => {
      const quickPick = this.quickInput.createQuickPick<DoctorPickItem>();
      quickPick.title = nls.localize(
        'ai-focused-editor/doctor/pick-title',
        'Book Doctor — select fixes to apply'
      );
      quickPick.canSelectMany = true;
      quickPick.matchOnDescription = true;
      quickPick.matchOnDetail = true;
      quickPick.placeholder = nls.localize(
        'ai-focused-editor/doctor/pick-placeholder',
        'Checked items will be created; informational findings are read-only'
      );
      quickPick.items = items;
      quickPick.selectedItems = fixItems;

      let outcome: DoctorPickOutcome = { kind: 'cancel' };
      // Selecting the sentinel row acts like a button: open the report and
      // dismiss the picker (multi-select toggles selection on click, so this
      // fires before any accept).
      quickPick.onDidChangeSelection(selection => {
        if (selection.some(item => item.openReport)) {
          outcome = { kind: 'report' };
          quickPick.hide();
        }
      });
      quickPick.onDidAccept(() => {
        const chosen = quickPick.selectedItems
          .map(item => item.fix)
          .filter((fix): fix is BookDoctorFix => fix !== undefined);
        outcome = { kind: 'apply', fixes: chosen };
        quickPick.hide();
      });
      quickPick.onDidHide(() => {
        quickPick.dispose();
        resolve(outcome);
      });
      quickPick.show();
    });
  }

  /* ----------------------------------------------------------------------- */
  /* Full report (untitled Markdown, preview-friendly)                       */
  /* ----------------------------------------------------------------------- */

  /**
   * Render the report as Markdown and open it in an in-memory (untitled)
   * editor. Untitled keeps it non-intrusive — nothing is written to the
   * workspace — while giving every finding its complete, untruncated message.
   */
  protected async openReport(report: BookDoctorReport): Promise<void> {
    const markdown = this.buildReportMarkdown(report);
    const resource = await this.untitledResources.createUntitledResource(markdown, '.md');
    await this.editorManager.open(resource.uri, { mode: 'activate' });
  }

  /**
   * Compose the full Markdown report. Section headers and the summary line are
   * localized (the display wrapper); each finding's own message/path text is
   * rendered verbatim from `common/book-doctor.ts` so it stays complete and
   * untruncated.
   */
  protected buildReportMarkdown(report: BookDoctorReport): string {
    const lines: string[] = [];
    lines.push(`# ${nls.localize('ai-focused-editor/doctor/report-title', 'Book Doctor — full report')}`);
    lines.push('');
    lines.push(nls.localize(
      'ai-focused-editor/doctor/report-summary',
      'Health: {0} fixable, {1} informational finding(s).',
      report.fixes.length,
      report.findings.length
    ));
    lines.push('');

    lines.push(`## ${nls.localize(
      'ai-focused-editor/doctor/report-section-fixes',
      'Fixable ({0})',
      report.fixes.length
    )}`);
    lines.push('');
    if (report.fixes.length === 0) {
      lines.push(nls.localize(
        'ai-focused-editor/doctor/report-no-fixes',
        'No auto-fixes available.'
      ));
    } else {
      lines.push(nls.localize(
        'ai-focused-editor/doctor/report-fixes-intro',
        'The following will be created — nothing is ever deleted or overwritten:'
      ));
      lines.push('');
      for (const fix of report.fixes) {
        lines.push(`- \`${fix.path}\` — ${fix.description}`);
      }
    }
    lines.push('');

    lines.push(`## ${nls.localize(
      'ai-focused-editor/doctor/report-section-findings',
      'Findings ({0})',
      report.findings.length
    )}`);
    lines.push('');
    if (report.findings.length === 0) {
      lines.push(nls.localize(
        'ai-focused-editor/doctor/report-no-findings',
        'No informational findings.'
      ));
    } else {
      lines.push(nls.localize(
        'ai-focused-editor/doctor/report-findings-intro',
        'Informational only — the doctor never changes these automatically:'
      ));
      lines.push('');
      for (const finding of report.findings) {
        lines.push(`### ${finding.label}`);
        lines.push('');
        lines.push(finding.detail);
        lines.push('');
      }
    }
    lines.push('');

    return lines.join('\n');
  }

  /**
   * Apply the selected creations parents-first (the scaffold order already
   * guarantees it; file fixes additionally ensure their parent folder). Never
   * overwrites an existing file. Summarizes created/skipped counts plus any
   * remaining informational findings.
   */
  protected async applyFixes(
    root: URI,
    fixes: readonly BookDoctorFix[],
    report: BookDoctorReport
  ): Promise<void> {
    let created = 0;
    let skipped = 0;

    for (const fix of fixes) {
      const uri = root.resolve(fix.path);
      try {
        if (fix.kind === 'folder') {
          await this.fileService.createFolder(uri);
        } else {
          if (await this.fileService.exists(uri)) {
            skipped += 1;
            continue;
          }
          // createFolder is recursive (mkdirp); ensures the parent even if its
          // scaffold folder fix was deselected.
          await this.fileService.createFolder(uri.parent).catch(() => undefined);
          await this.fileService.create(uri, fix.seed ?? '', { overwrite: false });
        }
        created += 1;
      } catch {
        skipped += 1;
      }
    }

    await this.refreshTree();

    const parts = [nls.localize(
      'ai-focused-editor/doctor/applied-created',
      'Book Doctor: created {0} item(s)',
      created
    )];
    if (skipped > 0) {
      parts.push(nls.localize('ai-focused-editor/doctor/applied-skipped', 'skipped {0}', skipped));
    }
    if (report.findings.length > 0) {
      parts.push(nls.localize(
        'ai-focused-editor/doctor/applied-findings-remain',
        '{0} informational finding(s) remain',
        report.findings.length
      ));
    }
    await this.messages.info(`${parts.join(', ')}.`);
  }

  /** Refresh the manuscript navigator so new files/folders appear; missing widget is a no-op. */
  protected async refreshTree(): Promise<void> {
    const widget = this.widgetManager.tryGetWidget<ManuscriptTreeWidget>(ManuscriptTreeWidget.ID);
    if (widget) {
      await widget.refreshWorkspace();
    }
  }
}
