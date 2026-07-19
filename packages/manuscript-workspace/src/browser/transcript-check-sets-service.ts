import URI from '@theia/core/lib/common/uri';
import { inject, injectable } from '@theia/core/shared/inversify';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import type { FileStat } from '@theia/filesystem/lib/common/files';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import {
  TRANSCRIPTION_AREA,
  TRANSCRIPTSET_FILE_NAME,
  computeTranscriptProgress,
  parseTranscriptsetYaml
} from '../common';

/** One enumerated transcript set (the transcript analogue of `ProofreadingSetEntry`). */
export interface TranscriptCheckSetEntry {
  slug: string;
  label: string;
  /** Absolute URI string of the set's `transcriptset.yaml`. */
  uri: string;
  verified: number;
  total: number;
  percent: number;
}

/**
 * Pure-reuse enumerator for the book's transcript SETS — the exact structural
 * clone of `ProofreadingSetsService` over `transcription/<slug>/transcriptset.yaml`.
 * Enumeration stays pure: each sidecar is parsed with {@link parseTranscriptsetYaml}
 * and the progress chip fields derive from {@link computeTranscriptProgress} —
 * no duplicated YAML parsing.
 */
@injectable()
export class TranscriptCheckSetsService {
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
   * List the book's transcript sets, sorted numeric-aware by slug so
   * `lecture-2` precedes `lecture-10`. A missing/unreadable `transcription/`
   * area or a folder without a valid `transcriptset.yaml` yields no entry
   * (never throws).
   */
  async list(rootUri?: string): Promise<TranscriptCheckSetEntry[]> {
    const root = rootUri ?? (await this.getRootUri());
    if (!root) {
      return [];
    }
    const areaUri = new URI(root).resolve(TRANSCRIPTION_AREA);
    let dir: FileStat;
    try {
      dir = await this.fileService.resolve(areaUri);
    } catch {
      return [];
    }
    const entries: TranscriptCheckSetEntry[] = [];
    for (const child of dir.children ?? []) {
      if (!child.isDirectory) {
        continue;
      }
      const slug = child.name;
      const sidecarUri = child.resource.resolve(TRANSCRIPTSET_FILE_NAME);
      let text: string;
      try {
        text = (await this.fileService.read(sidecarUri)).value;
      } catch {
        // A set folder without a transcriptset.yaml is not a set — skip it.
        continue;
      }
      const { set } = parseTranscriptsetYaml(text);
      if (!set) {
        continue;
      }
      const progress = computeTranscriptProgress(set.files);
      entries.push({
        slug,
        label: slug,
        uri: sidecarUri.toString(),
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
