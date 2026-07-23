/**
 * Pure (Theia-free) legacy-transcript decoration MAP-BUILDING logic + a
 * minimal explicit debounce utility — the testable half of TASK-016 U2b
 * (UR-003, UR-007 item 2, UR-008 O2). See
 * `../browser/legacy-transcript-decoration-provider.ts` for the Theia-facing
 * `DecorationsProvider` that consumes this module (FileService bridging,
 * `DecorationsService` registration, the `onDidChange` trigger mechanism —
 * ISS-159 / plan §8c).
 *
 * Kept Theia-import-free on purpose: `@theia/core/lib/browser`'s barrel pulls
 * in `@lumino/widgets` (DOM-dependent at import time), so anything importing
 * it cannot be `bun test`-ed without a DOM shim. This module mirrors the
 * shape of `@theia/core`'s `Decoration` interface structurally (no import
 * needed — TypeScript's structural typing assigns it straight through) so it
 * stays plainly unit-testable, like `legacy-transcript-import.ts` before it.
 */

import { ScannedDirectory, detectLegacyTranscriptSets } from './legacy-transcript-import';
import { AUDIO_SOURCES_AREA, TRANSCRIPTION_AREA } from './transcript-set-scaffold';

/* ------------------------------------------------------------------------- *
 * Decoration shape (structurally compatible with `@theia/core`'s
 * `Decoration` — see `decorations-service.d.ts`).
 * ------------------------------------------------------------------------- */

export interface LegacyDecoration {
  readonly weight?: number;
  readonly colorId?: string;
  readonly letter?: string;
  readonly tooltip?: string;
  readonly bubble?: boolean;
}

/** Visible letter badge for a detected legacy-transcript folder (UR-008 O2). */
export const LEGACY_TRANSCRIPT_DECORATION_LETTER = '⭳';

/** Tooltip shown on hover (UR-008 O2). */
export const LEGACY_TRANSCRIPT_DECORATION_TOOLTIP = 'Похоже на легаси-транскрипты — импортировать?';

/**
 * An existing, unobtrusive Theia color id (registered by
 * `packages/theia-git-fork/src/browser/git-contribution.ts` for the git
 * "untracked" decoration — an informational, non-alarming hue; reused rather
 * than inventing a new theme color for one badge).
 */
export const LEGACY_TRANSCRIPT_DECORATION_COLOR_ID = 'gitDecoration.untrackedResourceForeground';

/**
 * One shared, frozen decoration instance — every legacy folder gets the
 * exact same styling, so re-detecting the same folder never looks like a
 * "changed" decoration (reference equality short-circuits redundant
 * `onDidChange` churn on repeated (re)scans).
 */
export const LEGACY_TRANSCRIPT_DECORATION: LegacyDecoration = Object.freeze({
  letter: LEGACY_TRANSCRIPT_DECORATION_LETTER,
  tooltip: LEGACY_TRANSCRIPT_DECORATION_TOOLTIP,
  bubble: true,
  colorId: LEGACY_TRANSCRIPT_DECORATION_COLOR_ID
});

/** One directory the badge should be attached to. */
export interface LegacyDecorationEntry {
  /** Absolute path of the legacy chunk directory (`ScannedDirectory#path` shape — reconstitute via `someUri.withPath(path)`). */
  path: string;
  decoration: LegacyDecoration;
}

/** The book-native areas that are ALREADY migrated content, never legacy input (plan §8c/§3). */
const SKIPPED_AREAS: readonly (readonly string[])[] = [
  [TRANSCRIPTION_AREA],
  AUDIO_SOURCES_AREA.split('/')
];

/** True when `segments` (path from the owning workspace root) names one of {@link SKIPPED_AREAS} exactly. */
function isLegacySkippedArea(segments: readonly string[]): boolean {
  return SKIPPED_AREAS.some(
    area => area.length === segments.length && area.every((segment, index) => segment === segments[index])
  );
}

function collectWithinNode(
  node: ScannedDirectory,
  segments: readonly string[],
  mediaExtensions: readonly string[] | undefined,
  seen: Set<string>,
  out: LegacyDecorationEntry[]
): void {
  if (isLegacySkippedArea(segments)) {
    return;
  }
  const plans = detectLegacyTranscriptSets(node, mediaExtensions ? { mediaExtensions } : {});
  for (const plan of plans) {
    if (seen.has(plan.chunkDir)) {
      continue;
    }
    seen.add(plan.chunkDir);
    out.push({ path: plan.chunkDir, decoration: LEGACY_TRANSCRIPT_DECORATION });
  }
  for (const child of node.directories) {
    collectWithinNode(child, [...segments, child.name], mediaExtensions, seen, out);
  }
}

export interface CollectLegacyDecorationEntriesOptions {
  mediaExtensions?: readonly string[];
  /**
   * Path segments from the owning workspace root down to `root` — drives the
   * `transcription/` / `sources/audio/` skip when `root` is itself a
   * sub-directory rescan (incremental/fallback layers), not the workspace
   * root. Default `[]` (root IS the workspace root).
   */
  startSegments?: readonly string[];
}

/**
 * Walk a {@link ScannedDirectory} tree (any depth actually materialized by the
 * caller's I/O scan) and collect one {@link LegacyDecorationEntry} per
 * detected legacy chunk directory — applying {@link detectLegacyTranscriptSets}
 * at EVERY node (so a legacy folder is found regardless of how deep it sits
 * within the scanned subtree), de-duplicated by chunk-dir path, skipping the
 * `transcription/` and `sources/audio/` areas entirely. Pure — no Theia
 * services involved.
 */
export function collectLegacyDecorationEntries(
  root: ScannedDirectory,
  options: CollectLegacyDecorationEntriesOptions = {}
): LegacyDecorationEntry[] {
  const out: LegacyDecorationEntry[] = [];
  collectWithinNode(root, options.startSegments ?? [], options.mediaExtensions, new Set<string>(), out);
  return out;
}

/**
 * A minimal, EXPLICIT debounce wrapper (F-PLAN-2-2 — the incremental layer
 * must never rely on an assumed built-in debounce/batching of
 * `FileService.onDidFilesChange`; a bulk git checkout or import can fire many
 * events in quick succession).
 */
export class DebouncedTrigger<T> {
  private readonly pending = new Set<T>();
  private handle: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly delayMs: number, private readonly flush: (items: T[]) => void) {}

  schedule(item: T): void {
    this.pending.add(item);
    if (this.handle !== undefined) {
      clearTimeout(this.handle);
    }
    this.handle = setTimeout(() => {
      this.handle = undefined;
      const items = Array.from(this.pending);
      this.pending.clear();
      this.flush(items);
    }, this.delayMs);
  }

  dispose(): void {
    if (this.handle !== undefined) {
      clearTimeout(this.handle);
      this.handle = undefined;
    }
    this.pending.clear();
  }
}
