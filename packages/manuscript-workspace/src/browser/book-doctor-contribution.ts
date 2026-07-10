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
  QuickPickSeparator
} from '@theia/core/lib/common';
import URI from '@theia/core/lib/common/uri';
import { nls } from '@theia/core/lib/common/nls';
import type { Widget } from '@theia/core/lib/browser';
import { WidgetManager } from '@theia/core/lib/browser';
import {
  TabBarToolbarContribution,
  TabBarToolbarRegistry
} from '@theia/core/lib/browser/shell/tab-bar-toolbar';
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
}

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

    const selection = await this.pickFixes(report);
    if (selection === undefined) {
      return;
    }
    await this.applyFixes(new URI(rootUri), selection, report);
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
   * `fix`). Resolves the chosen fixes, or `undefined` when cancelled (Esc).
   */
  protected pickFixes(report: BookDoctorReport): Promise<BookDoctorFix[] | undefined> {
    const fixItems: DoctorPickItem[] = report.fixes.map(fix => ({
      label: fix.path,
      description: fix.description,
      fix
    }));
    const findingItems: DoctorPickItem[] = report.findings.map(finding => ({
      label: finding.label,
      detail: nls.localize(
        'ai-focused-editor/doctor/finding-detail',
        'Informational — selecting has no effect. {0}',
        finding.detail
      ),
      alwaysShow: true
    }));

    const items: Array<DoctorPickItem | QuickPickSeparator> = [...fixItems];
    if (findingItems.length > 0) {
      items.push({
        type: 'separator',
        label: nls.localize('ai-focused-editor/doctor/findings-separator', 'Findings (informational)')
      });
      items.push(...findingItems);
    }

    return new Promise<BookDoctorFix[] | undefined>(resolve => {
      const quickPick = this.quickInput.createQuickPick<DoctorPickItem>();
      quickPick.title = nls.localize(
        'ai-focused-editor/doctor/pick-title',
        'Book Doctor — select fixes to apply'
      );
      quickPick.canSelectMany = true;
      quickPick.matchOnDescription = true;
      quickPick.matchOnDetail = true;
      quickPick.placeholder = report.fixes.length > 0
        ? nls.localize(
            'ai-focused-editor/doctor/pick-placeholder',
            'Checked items will be created; informational findings are read-only'
          )
        : nls.localize(
            'ai-focused-editor/doctor/pick-placeholder-empty',
            'No auto-fixes available — review the informational findings, then close'
          );
      quickPick.items = items;
      quickPick.selectedItems = fixItems;

      let accepted = false;
      quickPick.onDidAccept(() => {
        accepted = true;
        const chosen = quickPick.selectedItems
          .map(item => item.fix)
          .filter((fix): fix is BookDoctorFix => fix !== undefined);
        quickPick.hide();
        resolve(chosen);
      });
      quickPick.onDidHide(() => {
        quickPick.dispose();
        if (!accepted) {
          resolve(undefined);
        }
      });
      quickPick.show();
    });
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
