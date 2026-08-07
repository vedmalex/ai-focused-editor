# @ai-focused-editor/narrative-knowledge

A deterministic, inspectable index of a manuscript's narrative knowledge — who is
mentioned where, what relates to what, and where each claim came from. No entry
in this index is ever produced by calling a language model; extraction is pure
functions over Markdown and YAML the author already wrote. Built for
[AI Focused Editor](../../README.md) (TASK-022), consumed by
`@ai-focused-editor/manuscript-workspace`, never the other way round.

If you are looking for the author-facing explanation of the index — the six
status-bar states, what a diagnostic means, why a Rebuild button is sometimes
greyed out — that lives in the product's own docs, not here: see
`packages/manuscript-workspace/src/browser/docs/content/ru/writing/narrative-index.md`
(narrative guide) and `.../writing/narrative-memory.md` (command/preference
reference). This file is for whoever opens this package next.

## What the index holds, and what it doesn't

Three kinds of record, each carrying **navigable evidence** — a file path plus
either a text range or an explicit whole-file marker (`EvidenceRef`,
`src/common/graph/evidence.ts`):

- **Entities** (`NarrativeEntity`) — one per author-written card under
  `entities/**`.
- **Mentions** (`NarrativeMention`) — one per occurrence of a reference to an
  entity inside manuscript prose.
- **Relations** (`NarrativeRelation`) — directed, typed links between two
  entities. One relation source, co-occurrence, is *derived* rather than
  extracted (`src/common/graph/derived-relations.ts`); the rest come from the
  author's own `ownership` fields and future authored links (issue #57/#58).

Every entity and relation also carries an **origin** —
`'explicit' | 'derived' | 'ai-candidate'` (`src/common/graph/narrative-origin.ts`)
— naming who is answerable for the claim: the author wrote it, the index
computed it, or an agent proposed it. A write with no evidence can only ever
land as `'ai-candidate'`, never as a fact; that rule is enforced above this
package, in `manuscript-workspace`'s write-tool confirmation flow
(`ai-write-confirmation.ts`), not here — this package only records and never
mints an unconfirmed write on its own.

The index is a **cache, not a second copy of the truth**. Everything in it is
rebuildable from the manuscript's files from a clean slate; a value that could
only ever live in the database is forbidden by the schema's own constraints.
Delete the SQLite file and the next read rebuilds it.

## Why this is its own package (AD-1)

`manuscript-workspace` already carries 30+ frontend modules; putting a
deterministic index engine inside it would make that problem worse, and the
epic's first acceptance box (issue #46) required a package/extension boundary.
So `narrative-knowledge` is a sibling package, structured `src/common | src/node
| src/browser` like `ai-connect-theia` and `document-preview-theia`, wired into
`apps/browser` and `apps/electron`, and built as its own step in the root
`build:packages` (`package.json:15`) — before `manuscript-workspace`, which
consumes it.

**The dependency only goes one way.** `narrative-knowledge` imports nothing from
`manuscript-workspace` — not through the package export, not through a deep
source path. The reverse is true and expected: `manuscript-workspace` now
imports the extracted parsers, the graph assembler input types, and the
`NarrativeKnowledgeService` proxy from here. A cycle in that direction would be
fatal in a very literal sense: `build:packages` is a hand-written **sequential**
chain with no cycle-breaking step, and it builds this package before
`manuscript-workspace`.

Three modules that used to live in `manuscript-workspace/src/common` moved here
whole rather than being re-exported, because their old home was on the
forbidden side of that dependency direction: `entity-mentions.ts`,
`entity-type-registry.ts`, `chapter-front-matter.ts`. A fourth module,
`link-navigation.ts`, was split rather than moved — the wiki-link *parsing*
half came here as `src/common/wiki-links.ts`; the editor-navigation half
(resolving a note reference to a file, relative-link arithmetic, heading
anchors) stayed in `manuscript-workspace`, because that half has nothing to do
with what the index knows and everything to do with the editor UI.

**Known, currently-live gap: three mention parsers, two grammars (gh#66).**
`wiki-links.ts` and the sibling `semantic-markdown` package's tag pattern are
Unicode-aware on the `kind:` prefix; `entity-mentions.ts` — used inside entity
cards via `entity-card-extraction.ts` — is **ASCII-only** on the same prefix
(`entity-mentions.ts:21`). A tag such as `[[персонаж:krishna|Кришна]]` is
therefore a mention in chapter prose and invisible inside an entity card. This
is deliberately not repaired here (`entity-card-extraction.ts:28-35` names it
explicitly, and `extraction/narrative-extraction.test.ts:529-561` pins both
directions) — swapping `entity-mentions.ts`'s grammar for the Unicode one
would silently change what already-shipped entity cards mean, and the actual
fix belongs to the linked issue, not to a WP-10 documentation pass.

## Layers, and the rule that keeps them honest

```
src/common/graph/   the separable GRAPH CORE (AD-6, UR-029): node/edge/subgraph
                     types, the relation-type registry, PLUS the domain types the
                     core consumes (NarrativeEntity/Mention/Relation, EvidenceRef)
                     and the NarrativeIndexStore port — the whole folder is meant
                     to be liftable out as one module
src/common/          extraction (pure functions), the in-memory port adapter, the
                     runner-agnostic contract cores, and the service-lifecycle
                     types the core does NOT see: IndexState, IndexFailureReason,
                     NarrativeMemoryConfig, the NarrativeFileWatcher port
                     → all of it runs under `bun test`
src/node/            the SQLite adapter, file/workspace scanning, the RPC service
                     implementation, the CLI contribution, the ru i18n bundle
                     → the only layer that mentions `node:sqlite`
                     → tested under real `node`, not `bun` (see below)
src/browser/         the frontend module, commands, status bar, diagnostics
                     markers, preferences, and the four read-only AI tool
                     providers
```

This is enforced, not aspirational: `packages/narrative-knowledge/test/import-graph.test.ts`
walks the real module graph **transitively** and asserts it clean against six
prohibitions, each with its own rejecting case fed to the same checker (so the
same run that asserts the real package green also proves each prohibition can
actually go red):

| | Prohibition | Where it applies | Why |
|---|---|---|---|
| a | no `node:*` import | `src/common` | `bun` cannot resolve `node:sqlite` (or any other Node builtin) — tests would fail with an opaque resolve error |
| b | no import of `src/node` | `src/common` | the same failure, reached through an intermediary |
| c | no `@theia/*/lib/browser` import | `src/common` | the core has to run without a DOM or a Theia frontend; `@theia/core/lib/common` stays legal |
| d | no `ai-connect-theia`, `@theia/ai-*`, or any LLM client, anywhere on the index-build path | `src/common` + `src/node` (`src/browser` is deliberately **outside** this one — WP-6's tool providers *read* the index, they don't build it) | the machine form of "the index needs no AI call" |
| e | **two halves.** Half 1: `src/common/graph/` imports nothing outside itself except type-only stdlib types — stated by complement, so an unenumerated future package is red too, not silently allowed. Half 2: `src/common/graph/` imports nothing from its own siblings in `src/common/` (e.g. `IndexState`) | `src/common/graph/` | AD-6/UR-029: the core has to be liftable as a folder, and half 1 alone leaves it free to accumulate sibling imports while staying green |
| f | no import of `@ai-focused-editor/manuscript-workspace`, **neither via the package export nor via a deep source path** (e.g. `@ai-focused-editor/manuscript-workspace/src/common/entity-type-registry` — the exact form `obsidian-plugin` used before this relocation) | all four layers | after `manuscript-workspace` started depending on this package, an import in the other direction would close a package cycle the manual `build:packages` chain cannot order |

Prohibition (e)'s asymmetry is intentional and stricter than (c): (c) leaves
`@theia/core/lib/common` legal for `src/common` at large (`URI` included), but
the graph core does not even accept `URI` — it takes `string` and lets the
caller convert at the boundary, because a module that pulls in `@theia/core`
cannot be published standalone.

A companion test in the same file asserts the literal string
`"manuscript-workspace"` does not appear anywhere under `src/` — imports and
stray doc-comments are different failure modes, and a stale comment pointing at
the old home is how the next relocation gets planned against a fiction.

## Pulling the graph core out

Everything under `src/common/graph/` is meant to survive being lifted into its
own package with no edits beyond a `package.json`. That is the entire point of
prohibition (e): nothing outside the folder is a dependency of anything inside
it (reading `IndexState`, `NarrativeMemoryConfig`, `NarrativeFileWatcher`, or
any `@theia/*`/`node:*` symbol from in here is enforced-red), and everything
inside the folder that the core actually needs — the `NarrativeIndexStore`
port, the domain types (`NarrativeEntity`/`Mention`/`Relation`, `EvidenceRef`),
the relation-type registry — was moved *into* the folder rather than left as a
neighbouring import, specifically so the folder doesn't secretly depend on
things outside it while staying green. The public surface for that lift is the
one barrel, `src/common/graph/index.ts`.

The price, paid on purpose: the core may not formulate SQL, so any traversal
that needs to be fast has to be **named on the `NarrativeIndexStore` interface**
(`neighbourhood` is the first one) rather than composed ad hoc by a caller —
adding a second such query is a visible interface edit, not a query string
somewhere in `src/node`.

## The port: `NarrativeIndexStore`

`src/common/graph/narrative-index-store.ts` is what every reader and writer of
the index goes through — never SQL directly, never the file format. It never
speaks in `IndexState` or `IndexFailureReason` (those are neighbours of the
core, forbidden by (e) half 2): lifecycle comes back as plain primitives
(`NarrativeIndexStoreLifecycle` — generation number, `readOnly`, a corruption
flag), and failure is a small closed `NarrativeIndexStoreError.kind`; the
service assembles the richer `IndexState` envelope from those primitives one
layer up, in `src/node`.

- `NarrativeIndexReader` — `getDocument`, `listDocuments`, `getEntity`,
  `findEntities`, `getMentions`, `getRelations`, `neighbourhood` (bounded graph
  walk), `getDuplicateEntities`.
- `NarrativeIndexWriter` (transaction-scoped) — `putDocument`, `deleteDocument`,
  `moveDocument`, `clearDocumentContent`, `clearDerivedRelations`, `putEntity`,
  `putDuplicateEntity`, `putMention`, `putRelation`, `clearAll`.
- `NarrativeIndexStore` itself adds `lifecycle()`, `transaction(body)` (the
  single-writer generation compare-and-set), `resetForRebuild()` (refused while
  a foreign writer's lock is live), and `close()`.

Two adapters implement it: `src/common/in-memory-narrative-index-store.ts`
(exercised under `bun test`, code-point ordered to match SQLite's default
collation — see below) and the real one, next.

**Known, currently-live gap: `moveDocument` repairs `sourcePath`, not
`sourceUri`/`evidence.path`.** On a rename, both adapters update every
entity's `sourcePath` field, but neither updates `entity.sourceUri` (SQLite:
`sqlite-narrative-index-store.ts:1038-1093`, repair loop at 1088-1092; the
in-memory adapter has the identical asymmetry) or `entity.evidence.path` —
those stay pointed at the pre-rename location until the next full rebuild.
This is pinned, not accidental: `test/node/index-invariants.test.mts:614-657`
characterizes it explicitly ("sourceUri does NOT follow a paired move; a
rebuild repairs it"). Every consumer that reads a card by URI works around it
by deriving the path from `sourcePath` instead of trusting `sourceUri` or
`evidence.path` directly (`entity-cards-widget.ts:321-336`,
`narrative-memory-tool-answers.ts:41-53`, `narrative-memory-markers.ts:46-47`)
— a new consumer of this port should do the same rather than assume
`sourceUri` is live.

## The SQLite adapter, and why `bun test` cannot touch it

`src/node/sqlite-narrative-index-store.ts` is **the only file in this package
that mentions `node:sqlite`** — that placement is the layer rule (a), not a
style choice. `node:sqlite` was chosen empirically: it works in both the
browser-backend and Electron targets with zero build changes, where
`better-sqlite3` needed native-module edits and crashed `bun` outright. The
cost is that `bun` cannot resolve `node:sqlite` at all, so `bun test packages`
can never reach the production store — every assertion made under `bun` is an
assertion about the in-memory double instead.

That's why this package's Node-only tests (`test/node/*.test.mts`) run under a
**real, second `node` process**, spawned by `scripts/narrative-index-node-run.mjs`
at the repo root, wired into the root `test` script as `test:narrative-index`
(`package.json:20,27`) — there is no CI in this repository, so anything not
woven into `bun run verify` effectively does not exist. That script:

- requires the package already built (`bun run build:packages` first — `verify`
  does this for you; the tests import `lib/`, the built output, not `src/`,
  because Node's ESM type-stripping needs extensioned relative imports that
  this package's sources don't use);
- runs with `--expose-gc` (later work packages' budget checks need it) and
  `--experimental-test-isolation=none` (measured, not assumed — the default
  isolation mode does not forward `--expose-gc` to a spawned child process);
- runs with `--disable-warning=ExperimentalWarning` **only in this test
  process, never in product code** — `node:sqlite` prints one warning line per
  process, and silencing it in the product would gag every future Node warning
  along with it, which is exactly the failure mode this epic exists to remove;
- writes a JUnit report to `.test-reports/narrative-index.junit.xml` (REQ-014),
  alongside the human-readable `spec` output, never instead of it.

The SQLite adapter also pins its own API surface (ОВ-7): only the constructor
options and methods the intersection of Node's stable `node:sqlite` versions
actually supports, checked against the *live* prototype so a future Node
addition doesn't silently expand what the adapter is allowed to use.

**Ordering note.** The adapter orders results under SQLite's default `BINARY`
collation — code-point order, not locale order — because locale-aware
`ORDER BY` is not something the adapter formulates (see the graph-core boundary
above: the core doesn't compose SQL). The in-memory adapter matches this with
an explicit code-unit comparator rather than `localeCompare`, on purpose, so
the two adapters agree. Surfaces that show a list to a *reader* apply their own
locale-aware sort on top (e.g. `manuscript-workspace`'s narrative-graph
assembler uses `Intl.Collator` with an explicit locale) — the index itself
makes no such promise.

## Configuration

Resolved per workspace root by `NarrativeMemoryConfigResolver`
(`src/node/narrative-memory-config-resolver.ts`), lazily, on first access to
that root — never eagerly at boot. Five sources, strongest first:

1. `configure(patch)` from the frontend — live for `debounceMs`,
   `fallbackTtlMs`, `maxOpenWorkspaces`; **advisory only** for `databasePath`.
2. CLI flags — `--narrative-index-db`, `--narrative-index-debounce`,
   `--narrative-index-fallback-ttl` (`NarrativeKnowledgeCliContribution`; three
   flags, not five — `maxOpenWorkspaces` and the diagnostics toggle are live
   tunables, not launch decisions, so they stay off the CLI surface).
3. Environment — `AI_EDITOR_NARRATIVE_INDEX_DB`,
   `AI_EDITOR_NARRATIVE_INDEX_DEBOUNCE_MS`,
   `AI_EDITOR_NARRATIVE_INDEX_FALLBACK_TTL_MS`.
4. `<root>/.theia/narrative-memory.json` (per-workspace, outside git).
5. Built-in defaults.

CLI outranks env deliberately — a flag is per-launch and explicit, while an
environment variable leaks into every child process this repository spawns
(`node-book-build-task-runner.ts` forwards `process.env` wholesale into the
book-build task runner, for one).

**`databasePath` is the one exception to the ladder.** A CLI-supplied
`--narrative-index-db` *locks* the key for the whole process: a later
`configure({databasePath})` is rejected with `reason: 'locked-by-cli'`. That
asymmetry exists for the read-only-workspace / test-harness / lockless-network-
volume cases an operator needs to pin without a setting quietly overriding
them. Independently of the ladder, `databasePath` never takes effect at
runtime at all — the file is already open, and retargeting it live would race
the single-writer lock — so a patch that changes it is accepted, validated,
and reported back as `deferred: [{ key: 'databasePath', until:
'next-backend-start' }]` rather than silently ignored.

## Building, type-checking, testing

From the repo root:

```sh
bun run --cwd packages/narrative-knowledge build       # tsc, plus copying src/node/i18n/ru
bun run --cwd packages/narrative-knowledge typecheck    # tsc -p tsconfig.typecheck.json
bun test packages/narrative-knowledge --path-ignore-patterns='**/narrative-knowledge/test/node/**'
bun run test:narrative-index                             # the node/*.test.mts half, real node
```

`bun run verify` runs all of the above (plus everything else in the
repository) in the right order, including the `node:sqlite` half.
