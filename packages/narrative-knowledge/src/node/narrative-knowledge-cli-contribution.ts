/**
 * CLI contribution for the narrative index (TASK-022 WP-3, tech_spec ОВ-9а
 * rung 2).
 *
 * Modelled directly on `BrowserAuthCliContribution` in the manuscript
 * workspace package's `src/node`, including the property that makes the whole
 * ladder work: `setArguments` runs BEFORE the backend application's
 * `initialize()`, so the flags are recorded on the shared resolver before
 * anything could ask it for a value.
 *
 * THREE FLAGS, NOT FIVE. `maxOpenWorkspaces` and `diagnostics.enabled` are not
 * launch decisions — the first is a memory bound the frontend tunes live, the
 * second is a user preference — and a flag for each would be a surface nobody
 * asked for. They remain settable through the per-workspace file and, for the
 * live ones, through the frontend patch.
 */

import * as yargs from '@theia/core/shared/yargs';
import { inject, injectable } from '@theia/core/shared/inversify';
import { CliContribution } from '@theia/core/lib/node';
import { NarrativeMemoryConfigResolver } from './narrative-memory-config-resolver';

/** Flag names, exported so the test that pins the ladder does not re-spell them. */
export const NARRATIVE_INDEX_CLI_FLAGS = {
  databasePath: 'narrative-index-db',
  debounceMs: 'narrative-index-debounce',
  fallbackTtlMs: 'narrative-index-fallback-ttl'
} as const;

@injectable()
export class NarrativeKnowledgeCliContribution implements CliContribution {
  @inject(NarrativeMemoryConfigResolver)
  protected readonly resolver!: NarrativeMemoryConfigResolver;

  configure(conf: yargs.Argv): void {
    conf.option(NARRATIVE_INDEX_CLI_FLAGS.databasePath, {
      description:
        'Path of the narrative index database, relative to the workspace root. ' +
        'Setting it LOCKS the value for the whole process: a settings change cannot override it.',
      type: 'string'
    });
    conf.option(NARRATIVE_INDEX_CLI_FLAGS.debounceMs, {
      description: 'Milliseconds the narrative index waits before re-indexing after a file change.',
      type: 'number'
    });
    conf.option(NARRATIVE_INDEX_CLI_FLAGS.fallbackTtlMs, {
      description: 'Milliseconds between fallback sweeps for changes the file watcher may have missed.',
      type: 'number'
    });
  }

  setArguments(args: yargs.Arguments): void {
    this.resolver.setCliOptions(readCliOptions(args));
  }
}

/**
 * Read the three flags out of a parsed argument object.
 *
 * SPLIT OUT OF THE CLASS so the ladder test can exercise rung 2 without
 * standing up an Inversify container and a yargs parser — the value under test
 * is the PRIORITY, not Theia's plumbing.
 */
export function readCliOptions(args: Record<string, unknown>): {
  databasePath?: string;
  debounceMs?: number;
  fallbackTtlMs?: number;
} {
  const options: { databasePath?: string; debounceMs?: number; fallbackTtlMs?: number } = {};
  const databasePath = args[NARRATIVE_INDEX_CLI_FLAGS.databasePath];
  if (typeof databasePath === 'string' && databasePath !== '') {
    options.databasePath = databasePath;
  }
  const debounce = args[NARRATIVE_INDEX_CLI_FLAGS.debounceMs];
  if (typeof debounce === 'number' && Number.isFinite(debounce)) {
    options.debounceMs = debounce;
  }
  const ttl = args[NARRATIVE_INDEX_CLI_FLAGS.fallbackTtlMs];
  if (typeof ttl === 'number' && Number.isFinite(ttl)) {
    options.fallbackTtlMs = ttl;
  }
  return options;
}
