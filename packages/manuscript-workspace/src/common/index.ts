// Connection/alias module extracted into the reusable ai-connect Theia
// extension; re-exported here so existing `../common` imports keep resolving.
export * from '@ai-focused-editor/ai-connect-theia/lib/common';
export * from './ai-mode-protocol';
export * from './ai-mode-layering';
export * from './attachable-source';
export * from './book-build-protocol';
export * from './browser-auth-protocol';
export * from './chapter-bundle';
export * from './context-sets';
export * from './diagram-spec';
export * from './entity-hover';
export * from './generated-image';
export * from './image-crop';
export * from './image-mime';
export * from './media-mime';
// Entity mentions, the entity-type registry, chapter front-matter and the
// wiki-link parser were relocated into the narrative-knowledge package in
// TASK-022 WP-0 (plan AD-1); re-exported here — as with the two extractions
// above — so existing `../common` imports keep resolving.
//
// THE FOUR RELOCATED MODULES, NOT THE WHOLE PACKAGE (TASK-022 WP-1). A wildcard
// over the package barrel also drags in the new domain contracts, and one of
// them is called `NarrativeEntity` — the same name this barrel already exports
// from `./narrative-entity-protocol` for the PRE-RENAME shape. `export *`
// resolves that collision by making the name ambiguous and dropping it, which
// `tsc` reports as TS2308 and which, until it did, would have silently changed
// which type dozens of consumers were compiled against. The two shapes coexist
// on purpose until WP-7 migrates the consumers; keeping this re-export narrow
// is what lets them.
export * from '@ai-focused-editor/narrative-knowledge/lib/common/entity-mentions';
export * from '@ai-focused-editor/narrative-knowledge/lib/common/entity-type-registry';
export * from '@ai-focused-editor/narrative-knowledge/lib/common/chapter-front-matter';
export * from '@ai-focused-editor/narrative-knowledge/lib/common/wiki-links';
export * from './text-range';
export * from './entity-type-forms';
export * from './excalidraw-canvas-ops';
export * from './git-status-protocol';
export * from './gitignore-utils';
export * from './knowledge-templates';
export * from './legacy-transcript-import';
export * from './book-build-task-protocol';
export * from './manuscript-workspace-protocol';
export * from './narrative-entity-protocol';
export * from './narrative-graph-protocol';
export * from './obsidian-plugin-protocol';
// Office/document preview extracted into the reusable document-preview Theia
// extension; re-exported here (incl. the historical Office* aliases) so
// existing `../common` imports keep resolving.
export * from '@ai-focused-editor/document-preview-theia/lib/common';
export * from './audio-conversion-protocol';
export * from './audio-segment-wav';
export * from './audio-transcription-protocol';
export * from './media-transcription-model';
export * from './proofreading-model';
export * from './proofreading-prompts';
export * from './proofreading-scaffold';
export * from './proofreading-scope';
export * from './proofreading-sidecar';
export * from './raw-md';
export * from './relations-map';
export * from './source-attach-routing';
export * from './transcript-metadata';
export * from './transcript-prompts';
export * from './transcript-set-model';
export * from './transcript-set-scaffold';
export * from './transcript-sidecar';
export * from './transcript-speakers';
export * from './transcription-settings';
export * from './source-library-protocol';
export * from './word-at-offset';
export * from './yaml-schema-validator';
