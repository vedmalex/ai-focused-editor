/**
 * Public surface of `@ai-focused-editor/narrative-knowledge`.
 *
 * The package `main`/`typings` point here, so this barrel is what every other
 * package sees. It is Theia-free and filesystem-free by construction — the
 * layer rule (plan.md, "Слои пакета и правило импортов") keeps `src/common`
 * runnable under plain `bun test`, and the import-graph test in `test/` proves
 * it transitively rather than by convention.
 */

// The separable graph core (AD-6 / UR-029). Importing FROM `graph/` is the
// allowed direction; the folder itself imports nothing outward.
export * from './graph';

// Service lifecycle + RPC contract. These types are deliberately OUTSIDE
// `graph/`: the core does not see the lifecycle of the service that maintains
// the index, which is what makes half 2 of prohibition (e) checkable at all.
export * from './index-state';
export * from './index-failure';
export * from './narrative-memory-config';
export * from './narrative-knowledge-protocol';

// What the user-facing surfaces SHOW, decided as a pure function of what the
// index reports (WP-5). Theia-free so every row of the six-state table, the
// ownership-based Rebuild refusal and the diagnostics rule are assertable in
// the ordinary `bun` lane rather than behind a DOM bootstrap.
export * from './narrative-memory-presentation';
export * from './narrative-memory-preference-contract';

// The schema layer, and the seam to the pre-rename entity shape. Both sit here
// rather than in `graph/` — one needs `ajv`, the other needs the entity-type
// registry, and the core may import neither.
export * from './narrative-schema';
export * from './legacy-narrative-entity';

// Reading and full rebuild over the store (WP-4a). `IndexState` is ASSEMBLED
// here, outside `graph/`, from the four lifecycle primitives the port returns —
// the port may not name the type at all (prohibition (e) half 2).
export * from './narrative-envelope';
export * from './index-state-assembly';
export * from './narrative-context';
export * from './narrative-index-session';

// Incrementality, the watcher and the single guard (WP-4b). The ports live here
// rather than in `src/node` for the same reason the session does: everything
// this work package decides is a function of a change list, a clock and a set of
// already-read files, so one body of assertions runs against BOTH store
// adapters. Their production implementations — a Theia watcher, a filesystem
// walk, `setTimeout` — are the only parts that need a backend.
export * from './narrative-file-watcher';
export * from './narrative-timer';
export * from './narrative-workspace-source';
export * from './narrative-index-update';
export * from './narrative-index-maintainer';
export * from './narrative-memory-configure';

// The in-memory store adapter and the runner-agnostic contract core (WP-3).
// They live in `src/common` because `bun` must be able to run them: the whole
// reason they exist is that `bun` cannot reach the SQLite adapter in `src/node`.
export * from './in-memory-narrative-index-store';
export * from './narrative-index-store-contract';
export * from './narrative-index-read-contract';
export * from './narrative-index-maintenance-contract';

// Deterministic parsers relocated in TASK-022 WP-0 (plan AD-1). They are the
// inputs the index is extracted from, which is why they live on this side of
// the package boundary — the dependency direction only ever runs INTO this
// package, never out of it (prohibition (f)).
export * from './entity-mentions';
export * from './entity-type-registry';
export * from './chapter-front-matter';
export * from './wiki-links';

// The deterministic extraction built on top of those parsers (TASK-022 WP-2).
// Pure by construction — text in, domain values out — which is what the layer
// rule's prohibitions (a) and (c) enforce over this whole directory.
export * from './extraction';
