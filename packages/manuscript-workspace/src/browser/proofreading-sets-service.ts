import URI from '@theia/core/lib/common/uri';
import { inject, injectable } from '@theia/core/shared/inversify';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import type { FileStat } from '@theia/filesystem/lib/common/files';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import {
  computeProgress,
  parseProofsetYaml,
  PROOFSET_FILE_NAME
} from '../common';
import type { ProofreadingSetEntry } from '../common/author-materials';

/**
 * Pure-reuse enumerator for the book's proofreading SETS. This is the same
 * `proofreading/<slug>/proofset.yaml` scan the manuscript navigator runs
 * (`ManuscriptTreeModel.scanProofreading`), extracted into a standalone,
 * injectable service so the Proofreading view (and Proofreading Mode) can list
 * sets WITHOUT pulling in the whole tree model. Enumeration stays pure: it
 * parses each sidecar with {@link parseProofsetYaml} and derives the progress
 * chip fields with {@link computeProgress} — no duplicated YAML parsing.
 */
@injectable()
export class ProofreadingSetsService {
  @inject(FileService)
  protected readonly fileService!: FileService;

  @inject(WorkspaceService)
  protected readonly workspaceService!: WorkspaceService;

  /** Absolute URI of the open book root, or undefined when no workspace is open. */
  async getRootUri(): Promise<string | undefined> {
    await this.workspaceService.ready;
    const root = this.workspaceService.tryGetRoots()[0] ?? (await this.workspaceService.roots)[0];
    return root?.resource.toString();
  }

  /**
   * List the book's proofreading sets, sorted numeric-aware by slug so
   * `chapter-2` precedes `chapter-10`. A missing/unreadable `proofreading/` area
   * or a folder without a valid `proofset.yaml` yields no entry (never throws).
   */
  async list(rootUri?: string): Promise<ProofreadingSetEntry[]> {
    const root = rootUri ?? (await this.getRootUri());
    if (!root) {
      return [];
    }
    const areaUri = new URI(root).resolve('proofreading');
    let dir: FileStat;
    try {
      dir = await this.fileService.resolve(areaUri);
    } catch {
      return [];
    }
    const entries: ProofreadingSetEntry[] = [];
    for (const child of dir.children ?? []) {
      if (!child.isDirectory) {
        continue;
      }
      const slug = child.name;
      const proofsetUri = child.resource.resolve(PROOFSET_FILE_NAME);
      let text: string;
      try {
        text = (await this.fileService.read(proofsetUri)).value;
      } catch {
        // A set folder without a proofset.yaml is not a set — skip it.
        continue;
      }
      const { set } = parseProofsetYaml(text);
      if (!set) {
        continue;
      }
      const progress = computeProgress(set);
      entries.push({
        slug,
        label: slug,
        uri: proofsetUri.toString(),
        verified: progress.verified,
        total: progress.total,
        percent: progress.percent
      });
    }
    entries.sort((left, right) => left.label.localeCompare(right.label, undefined, { numeric: true })
      || left.slug.localeCompare(right.slug));
    return entries;
  }
}
