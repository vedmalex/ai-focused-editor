/**
 * Public surface of the separable graph core (AD-6 / UR-029).
 *
 * Everything the core needs lives under this folder, and this barrel is what
 * the rest of `src/common` reads. The reverse direction (`src/common/*`
 * importing from here) is EXPECTED and allowed; the forbidden direction is
 * this folder reaching outward — prohibition (e), half 2.
 */
export * from './graph-node';
export * from './graph-edge';

// The domain the core consumes (TASK-022 WP-1). These live INSIDE the folder
// rather than beside it because half 2 of prohibition (e) forbids the core from
// importing its neighbours: anything the core reads has to travel with it, or
// the folder is not liftable and the boundary is a word.
export * from './narrative-origin';
export * from './evidence';
export * from './narrative-entity';
export * from './narrative-mention';
export * from './narrative-relation';

// Relation source 6, the DERIVED one (TASK-022 WP-4a). The RULE of the fold is
// core business and imports nothing outward; the materialization is the
// caller's, in one write transaction — see the module note.
export * from './derived-relations';

// The storage port (TASK-022 WP-3). It lives INSIDE the folder for the same
// reason the domain types do: the core reads and writes the index through it,
// so a core lifted out without it would not run. It speaks in lifecycle
// PRIMITIVES rather than `IndexState` precisely so that staying inside is
// possible — see the module note there.
export * from './narrative-index-store';
// The ONE spelling of manuscript order (gh#47), exported because both adapters
// and the contract suite consume it — see the module note on why it is shared
// rather than implemented twice.
export * from './mention-ordering';
