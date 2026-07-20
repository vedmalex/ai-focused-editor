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
export * from './entity-mentions';
export * from './entity-type-registry';
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
export * from './source-library-protocol';
export * from './word-at-offset';
export * from './yaml-schema-validator';
