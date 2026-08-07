// The NODE half of the narrative-index test scheme (TASK-022 WP-3).
//
// WHY THIS SCRIPT EXISTS AT ALL. The repository tests with `bun`, and `bun`
// cannot resolve `node:sqlite` — the import fails outright. So the production
// index store is unreachable from `bun test packages`, and every assertion made
// there is an assertion about the in-memory double. This run is the other half:
// the same contract core plus the behaviours only a real file, a real schema
// and a second process can exhibit.
//
// AND IT IS WIRED INTO THE ROOT `test` SCRIPT, WHICH IS THE POINT (R-3). There
// is no CI in this repository — `.github/workflows` does not exist — so the
// only gate is a local `bun run verify`. A test mode that is not woven into it
// will never run, and is therefore indistinguishable from a test mode that does
// not exist.
//
// THE FLAGS ARE SET HERE, DELIBERATELY:
//   --expose-gc                         required by the plan; the budget checks
//                                       in later work packages need it, and a
//                                       test asserts it is really available.
//   --disable-warning=ExperimentalWarning  ONLY in this run, never in the
//                                       product. `node:sqlite` prints one line
//                                       per process; leaving it in a green test
//                                       run teaches people to ignore stderr,
//                                       and stderr is where the rebuild
//                                       diagnostics live. Silencing it in the
//                                       PRODUCT would gag every future warning
//                                       Theia might raise, which is the class
//                                       of behaviour this epic exists to remove.
//   --experimental-test-isolation=none  measured, not assumed: with the default
//                                       process isolation Node does NOT pass
//                                       `--expose-gc` to the child, and
//                                       `globalThis.gc` comes back undefined.
//                                       The tests that need a second PROCESS
//                                       spawn one explicitly.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageRoot = join(repoRoot, 'packages/narrative-knowledge');
const builtEntry = join(packageRoot, 'lib/node/sqlite-narrative-index-store.js');

// These tests import the BUILT output rather than the sources: Node's type
// stripping follows ESM rules, where a relative import needs its extension, and
// this package's sources use extensionless specifiers throughout. Importing
// `lib/` is also the better test — it is the artefact every other package
// consumes — but it means the build has to have happened. `verify` builds
// first; a bare `bun run test` on a clean tree does not, so say so plainly
// instead of failing with a module-resolution error nobody can read.
if (!existsSync(builtEntry)) {
  console.error(
    `[narrative-index] the built package is missing (${builtEntry}).\n` +
      '[narrative-index] run `bun run build:packages` first — `bun run verify` does it for you.'
  );
  process.exit(1);
}

// JUnit alongside the human-readable run, never instead of it (REQ-014).
//
// `node --test` accepts reporters in pairs, so `spec` keeps going to the
// terminal while `junit` writes the machine-readable artifact. The XML is what
// carries PER-CASE durations: a summary line reports only the total, and on this
// repository that difference was load-bearing — a flake diagnosed as "the tree
// grew" turned out to be process-spawn cost, and only the per-case times showed
// it (the suspect case was 0.69 s against a 5000 ms limit while all 43 others sat
// at ~0.155 s each).
const junitOut = join(repoRoot, '.test-reports', 'narrative-index.junit.xml');
mkdirSync(dirname(junitOut), { recursive: true });

const result = spawnSync(
  process.execPath,
  [
    '--expose-gc',
    '--disable-warning=ExperimentalWarning',
    '--test',
    '--experimental-test-isolation=none',
    '--test-reporter=spec',
    '--test-reporter-destination=stdout',
    '--test-reporter=junit',
    `--test-reporter-destination=${junitOut}`,
    'packages/narrative-knowledge/test/node/*.test.mts'
  ],
  { cwd: repoRoot, stdio: 'inherit' }
);

if (result.error) {
  console.error(`[narrative-index] could not start the node test run: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
