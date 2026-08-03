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

// The schema layer, and the seam to the pre-rename entity shape. Both sit here
// rather than in `graph/` — one needs `ajv`, the other needs the entity-type
// registry, and the core may import neither.
export * from './narrative-schema';
export * from './legacy-narrative-entity';

// Deterministic parsers relocated in TASK-022 WP-0 (plan AD-1). They are the
// inputs the index is extracted from, which is why they live on this side of
// the package boundary — the dependency direction only ever runs INTO this
// package, never out of it (prohibition (f)).
export * from './entity-mentions';
export * from './entity-type-registry';
export * from './chapter-front-matter';
export * from './wiki-links';
