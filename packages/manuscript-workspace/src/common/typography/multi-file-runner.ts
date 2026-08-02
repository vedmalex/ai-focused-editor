/**
 * Pure orchestration for the MULTI-FILE typography batch (TASK-019 W2, §2 /
 * ISS-219). This is the manuscript-safety core: writing typography into an
 * UNOPENED file is reversible ONLY through git (no editor undo), so EVERY write
 * is gated behind an explicit user confirmation shown a dry-run preview.
 *
 * The guarantee this module enforces — and the reason it is pure and unit-tested
 * — is: {@link FileGateway.write} is NEVER called before `confirm` resolves
 * `true`. Reads happen first (to compute the preview), the user sees the
 * per-file edit counts, and only on an explicit yes does any byte get written.
 *
 * TOCTOU (ISS-246). The confirmation dialog is a HUMAN pause between the read
 * that produced `newText` and the write that lands it — seconds or minutes in
 * which an autosave, a git checkout or another tool can rewrite the file. A
 * blind write would then silently clobber those edits with a stale snapshot, and
 * an unopened file has no editor undo to recover them. So every write is
 * preceded by a RE-READ compared against the exact original snapshot the plan
 * was computed from; a mismatch SKIPS the file (never a merge, never a
 * force-write) and is reported back as {@link MultiFileResult.skippedPaths}.
 *
 * PARTIAL FAILURE (ISS-246). A throw mid-loop used to abort the run with N files
 * already on disk and no way for the user to know which. The write loop is now
 * fault-isolated per file: a failing read/write records the path and the run
 * CONTINUES, so the caller can always report the true triple (written, skipped,
 * failed). Fail-fast was rejected deliberately — a batch that stops at file 2 of
 * 40 leaves the manuscript half-typographed with the same "which ones?" problem,
 * whereas continuing produces one complete, reportable outcome.
 *
 * The SAME fault isolation applies to the phase-1 preview read (F-D5-3 DA
 * finding): one unreadable file among many must not deny the user a preview of
 * the rest. A file that fails to read here is recorded in {@link
 * MultiFileResult.failedPaths} and skipped — never counted into the plan, never
 * blocking it — so the confirmation dialog still forms over every readable
 * file and the problem file is named rather than hidden.
 *
 * The browser command wires a real FileService, a ConfirmDialog, and a progress
 * reporter into these ports; the ports are duck-typed so this module pulls in no
 * Theia/DOM dependency and stays DST-testable with plain fakes.
 */

/** The file I/O port: read current text, write new text. Paths are opaque keys. */
export interface FileGateway {
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
}

/** One planned file change (computed WITHOUT writing). */
export interface PlannedFileChange {
  readonly path: string;
  readonly editCount: number;
}

/** The dry-run preview handed to `confirm` before any write. */
export interface MultiFilePlan {
  /** Only files that actually change (editCount > 0), in input order. */
  readonly changes: readonly PlannedFileChange[];
  readonly totalFiles: number;
  readonly totalEdits: number;
}

/** Outcome of a multi-file run. */
export interface MultiFileResult {
  /** Files inspected (read + run). */
  readonly inspected: number;
  /** Files that would change. */
  readonly planned: number;
  /** Files actually written (0 when cancelled or nothing changed). */
  readonly written: number;
  /** Edits PLANNED across the whole plan — the number the preview showed. */
  readonly totalEdits: number;
  /**
   * Edits actually landed on disk: the planned counts of the WRITTEN files only.
   * Differs from {@link totalEdits} as soon as a file is skipped or fails, and is
   * the honest number to report to the user (ISS-246).
   */
  readonly writtenEdits: number;
  /** True when a plan existed and the user confirmed it. */
  readonly confirmed: boolean;
  /** True when a plan existed but the user declined — NOTHING was written. */
  readonly cancelled: boolean;
  /** Files left UNTOUCHED because they changed on disk after the preview (TOCTOU). */
  readonly skipped: number;
  readonly skippedPaths: readonly string[];
  /**
   * Files whose read (preview-phase or write-time re-read) or write threw; the
   * run continued past them (F-D5-3: this includes files that were never
   * readable enough to even enter the plan/preview).
   */
  readonly failed: number;
  readonly failedPaths: readonly string[];
}

/** Progress callback invoked once per WRITTEN file (never during the read phase). */
export type ProgressReporter = (done: number, total: number, path: string) => void;

/**
 * Run typography over `paths` with a mandatory preview/confirm gate.
 *
 * 1. READ + compute every file's transformed text and edit count (no writes).
 *    The original text is KEPT — it is the TOCTOU baseline for step 4. A file
 *    that fails to read is recorded in `failedPaths` and skipped — it never
 *    blocks the preview for the rest (F-D5-3).
 * 2. Keep only the files that change; if none change, return early (no prompt).
 * 3. Ask `confirm(plan)`. If it resolves falsy, return WITHOUT writing anything.
 * 4. Only then, per file: RE-READ, compare against the step-1 snapshot, and write
 *    only on an exact match. A drifted file is skipped; a throwing read/write is
 *    recorded and the loop continues. Progress fires per WRITTEN file.
 */
export async function runTypographyOnFiles(
  paths: readonly string[],
  gateway: FileGateway,
  runText: (text: string) => { text: string; editCount: number },
  confirm: (plan: MultiFilePlan) => Promise<boolean>,
  onProgress?: ProgressReporter
): Promise<MultiFileResult> {
  // Phase 1: read + compute. No write happens in this loop. Fault-isolated
  // (F-D5-3): a file that fails to read is recorded and skipped, never
  // aborting the preview for the rest.
  const pending: Array<{ path: string; original: string; newText: string; editCount: number }> = [];
  const readFailedPaths: string[] = [];
  for (const path of paths) {
    let original: string;
    try {
      original = await gateway.read(path);
    } catch {
      readFailedPaths.push(path);
      continue;
    }
    const { text, editCount } = runText(original);
    if (editCount > 0 && text !== original) {
      pending.push({ path, original, newText: text, editCount });
    }
  }

  const totalEdits = pending.reduce((sum, entry) => sum + entry.editCount, 0);

  if (pending.length === 0) {
    // Nothing to change → no prompt, no write.
    return {
      inspected: paths.length,
      planned: 0,
      written: 0,
      totalEdits: 0,
      writtenEdits: 0,
      confirmed: false,
      cancelled: false,
      skipped: 0,
      skippedPaths: [],
      failed: readFailedPaths.length,
      failedPaths: readFailedPaths
    };
  }

  const plan: MultiFilePlan = {
    changes: pending.map(entry => ({ path: entry.path, editCount: entry.editCount })),
    totalFiles: pending.length,
    totalEdits
  };

  // Phase 2: the gate. A falsy confirmation means NOT ONE write.
  const approved = await confirm(plan);
  if (!approved) {
    return {
      inspected: paths.length,
      planned: pending.length,
      written: 0,
      totalEdits,
      writtenEdits: 0,
      confirmed: false,
      cancelled: true,
      skipped: 0,
      skippedPaths: [],
      failed: readFailedPaths.length,
      failedPaths: readFailedPaths
    };
  }

  // Phase 3: write, only after approval. Each file is re-validated against its
  // step-1 snapshot (TOCTOU) and isolated from its neighbours' failures.
  // `failedPaths` starts from the phase-1 read failures so both failure sources
  // are reported through one honest list (F-D5-3).
  let written = 0;
  let writtenEdits = 0;
  const skippedPaths: string[] = [];
  const failedPaths: string[] = [...readFailedPaths];
  for (const entry of pending) {
    let current: string;
    try {
      current = await gateway.read(entry.path);
    } catch {
      failedPaths.push(entry.path);
      continue;
    }
    if (current !== entry.original) {
      // The file moved under us while the dialog was open. `entry.newText` is a
      // stale whole-file snapshot, so writing it would DELETE whatever changed.
      skippedPaths.push(entry.path);
      continue;
    }
    try {
      await gateway.write(entry.path, entry.newText);
    } catch {
      failedPaths.push(entry.path);
      continue;
    }
    written += 1;
    writtenEdits += entry.editCount;
    onProgress?.(written, pending.length, entry.path);
  }

  return {
    inspected: paths.length,
    planned: pending.length,
    written,
    totalEdits,
    writtenEdits,
    confirmed: true,
    cancelled: false,
    skipped: skippedPaths.length,
    skippedPaths,
    failed: failedPaths.length,
    failedPaths
  };
}
