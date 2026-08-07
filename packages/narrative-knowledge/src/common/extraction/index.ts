/**
 * Deterministic extraction — the pure half of the index (TASK-022 WP-2).
 *
 * Everything under this folder is a function from TEXT to DOMAIN VALUES. No
 * filesystem, no URI construction, no Theia, no clock. It sits in `src/common`
 * and NOT in `src/common/graph/`, because the graph core may import nothing
 * outward (prohibition (e)) while extraction reads `yaml`, the entity-type
 * registry, the front-matter parser and the two prose parsers — every one of
 * which is a neighbour the core is not allowed to have.
 */

export * from './text-position';
export * from './yaml-values';
export * from './entity-catalog';
export * from './extracted-relation';
export * from './document-classification';
export * from './entity-card-extraction';
export * from './chapter-extraction';
export * from './manifest-extraction';
export * from './narrative-extraction';
