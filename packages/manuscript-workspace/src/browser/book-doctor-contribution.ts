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
  type BookDoctorFinding,
  type BookDoctorFix,
  type BookDoctorReport
} from '../common/book-doctor';
import {
  appendEntriesToManifest,
  extractFirstHeading,
  isExcludedDiscoveryDir,
  type DiscoveredManuscriptFile
} from '../common/manifest-reconstruction';
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

    // Discover every manuscript candidate across the workspace (not only
    // content/), so an old folder with chapters at the root or in arbitrary
    // folders is fully picked up.
    const manuscriptCandidates = await this.collectManuscriptCandidates(root);
    const contentHasMarkdown = manuscriptCandidates.some(candidate =>
      normalizeManifestPath(candidate.path).startsWith('content/')
    );
    const folderName = root.path.base;

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
      manuscriptCandidates,
      folderName,
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

  /**
   * Recursively collect workspace-relative `.md` candidates, pruning the excluded
   * and hidden directories (build/, knowledge/, sources/, entities/, ai/, .git/,
   * …). Each candidate carries the first ATX heading extracted from the file's
   * leading bytes (~2 KB) so a restored chapter's real title becomes its manifest
   * title. Sorted by path for a stable report.
   */
  protected async collectManuscriptCandidates(root: URI): Promise<DiscoveredManuscriptFile[]> {
    const results: DiscoveredManuscriptFile[] = [];
    await this.walkCandidates(root, root, results);
    results.sort((a, b) => a.path.localeCompare(b.path));
    return results;
  }

  protected async walkCandidates(root: URI, dir: URI, out: DiscoveredManuscriptFile[]): Promise<void> {
    const stat = await this.fileService.resolve(dir).catch(() => undefined);
    for (const child of stat?.children ?? []) {
      if (child.isDirectory) {
        if (isExcludedDiscoveryDir(child.resource.path.base)) {
          continue;
        }
        await this.walkCandidates(root, child.resource, out);
      } else if (child.isFile) {
        const relative = root.relative(child.resource)?.toString();
        if (relative && relative.toLowerCase().endsWith('.md')) {
          out.push({ path: relative, firstHeading: await this.readFirstHeading(child.resource) });
        }
      }
    }
  }

  /** Read the file's leading bytes and extract the first ATX heading, if any. */
  protected async readFirstHeading(uri: URI): Promise<string | undefined> {
    const text = await this.readTextIfExists(uri);
    return text === undefined ? undefined : extractFirstHeading(text.slice(0, 2048));
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
  /**
   * QuickPick/report label for a fix: plain fixes show their path; the manifest
   * reconstruction/append fix shows a localized label carrying the file count so
   * ru/en both read naturally (the pure module's English `description` stays the
   * fallback tooltip).
   */
  protected fixLabel(fix: BookDoctorFix): string {
    if (fix.manifest) {
      return fix.manifest.mode === 'recreate'
        ? nls.localize(
            'ai-focused-editor/doctor/reconstruct-fix',
            'Recreate the manifest from content ({0} file(s))',
            fix.manifest.fileCount
          )
        : nls.localize(
            'ai-focused-editor/doctor/append-fix',
            'Add to the manifest ({0} file(s))',
            fix.manifest.fileCount
          );
    }
    return fix.path;
  }

  /**
   * Localize a fix's description by its stable `code` (falling back to the raw
   * English `description` for an absent/unknown code). Manifest recreate/append
   * fixes are rendered via {@link fixLabel}, so their description stays the
   * English fallback here.
   */
  protected localizeFixDescription(fix: BookDoctorFix): string {
    const params = fix.params ?? [];
    switch (fix.code) {
      case 'create-folder':
        return nls.localize('ai-focused-editor/doctor/problem-create-folder', 'Create folder — {0}', ...params);
      case 'create-file':
        return nls.localize('ai-focused-editor/doctor/problem-create-file', 'Create file — {0}', ...params);
      case 'create-missing-chapter':
        return nls.localize('ai-focused-editor/doctor/problem-create-missing-chapter', 'Create the missing chapter file referenced by the manifest.', ...params);
      default:
        return fix.description;
    }
  }

  /**
   * Localize a finding's short label by its stable `code` (falling back to the
   * raw English `label`). The labels carry no placeholders.
   */
  protected localizeFindingLabel(finding: BookDoctorFinding): string {
    switch (finding.code) {
      case 'metadata-title-blank':
        return nls.localize('ai-focused-editor/doctor/problem-metadata-title-blank-label', 'metadata.yaml: title is blank');
      case 'metadata-author-blank':
        return nls.localize('ai-focused-editor/doctor/problem-metadata-author-blank-label', 'metadata.yaml: author is blank');
      case 'citations-parse-error':
        return nls.localize('ai-focused-editor/doctor/problem-citations-parse-error-label', 'sources/citations.yaml could not be parsed');
      case 'excerpts-parse-error':
        return nls.localize('ai-focused-editor/doctor/problem-excerpts-parse-error-label', 'sources/excerpts.jsonl has an invalid line');
      default:
        return finding.label;
    }
  }

  /**
   * Localize a finding's longer detail by its stable `code`, filling `{0}`, `{1}`…
   * from `finding.params` in order (falling back to the raw English `detail`).
   */
  protected localizeFindingDetail(finding: BookDoctorFinding): string {
    const params = finding.params ?? [];
    switch (finding.code) {
      case 'metadata-title-blank':
        return nls.localize('ai-focused-editor/doctor/problem-metadata-title-blank-detail', 'The book title in metadata.yaml is missing or blank. Set it in the Book Metadata editor.', ...params);
      case 'metadata-author-blank':
        return nls.localize('ai-focused-editor/doctor/problem-metadata-author-blank-detail', 'The book author in metadata.yaml is missing or blank. Set it in the Book Metadata editor.', ...params);
      case 'citations-parse-error':
        return nls.localize('ai-focused-editor/doctor/problem-citations-parse-error-detail', 'YAML parse error in sources/citations.yaml: {0}', ...params);
      case 'excerpts-parse-error':
        return nls.localize('ai-focused-editor/doctor/problem-excerpts-parse-error-detail', 'Line {0} of sources/excerpts.jsonl is not valid JSON: {1}', ...params);
      default:
        return finding.detail;
    }
  }

  protected pickFixes(report: BookDoctorReport): Promise<DoctorPickOutcome> {
    const fixItems: DoctorPickItem[] = report.fixes.map(fix => ({
      label: this.fixLabel(fix),
      description: fix.manifest ? fix.manifest.samplePaths.join(', ') : this.localizeFixDescription(fix),
      fix
    }));
    const findingItems: DoctorPickItem[] = report.findings.map(finding => ({
      label: this.localizeFindingLabel(finding),
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
        if (fix.manifest) {
          // Reconstruction/append: show the localized label, the file count, and
          // the first few discovered paths so the report is self-explanatory.
          lines.push(`- **${this.fixLabel(fix)}** — \`${fix.path}\``);
          for (const sample of fix.manifest.samplePaths) {
            lines.push(`  - \`${sample}\``);
          }
          if (fix.manifest.fileCount > fix.manifest.samplePaths.length) {
            lines.push(`  - ${nls.localize(
              'ai-focused-editor/doctor/report-more-files',
              '…and {0} more',
              fix.manifest.fileCount - fix.manifest.samplePaths.length
            )}`);
          }
        } else {
          lines.push(`- \`${fix.path}\` — ${this.localizeFixDescription(fix)}`);
        }
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
        lines.push(`### ${this.localizeFindingLabel(finding)}`);
        lines.push('');
        lines.push(this.localizeFindingDetail(finding));
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
        if (fix.manifest?.mode === 'append') {
          // Append-only: merge the new entries into the EXISTING manifest,
          // preserving its comments/format — never a wholesale rewrite.
          const existing = await this.readTextIfExists(uri);
          if (existing === undefined) {
            skipped += 1;
            continue;
          }
          await this.fileService.write(uri, appendEntriesToManifest(existing, fix.manifest.entries));
        } else if (fix.kind === 'folder') {
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
