# AI Focused Editor Progress

Updated: 2026-07-09

This file tracks implementation progress against `spec.md`. It records verified repository state, not planned intent.

## Current Implementation Level

- Overall product vision: 10-14%.
- First Theia MVP: 94-97% architecture foundation, 90-93% user-facing workflow.
- Current phase: Phase 1 architecture spike.

## Completed

- Bun workspace root with `bun.lock` and `@types/bun`.
- Browser Theia application under `apps/browser`.
- First-party Theia extension package under `packages/manuscript-workspace`.
- Theia infrastructure packages wired for editor, Monaco, navigator, preferences, markers, file search, and Theia AI chat.
- Domain command contribution points:
  - `AI Focused Editor: Validate Manuscript Workspace`
  - `AI Focused Editor: Improve Selected Text`
  - `AI Focused Editor: Check Manuscript Consistency`
- `@vedmalex/ai-connect` service boundary for browser-safe `api` transport.
- Browser-safe `api` transport through `createBrowserClient`.
- Backend/local adapter for `acp` / `cli` / `server` transports through Theia JSON-RPC and `createLocalClient`.
- Shared ai-connect config builder used by browser and backend adapters.
- Preference-backed MVP AI profile settings under `aiFocusedEditor.ai.*`.
- AI profile preference service shared by AI commands and model config UI.
- AI Model Config view showing provider/model/transport/endpoint/API-key readiness without exposing secrets.
- `AI Focused Editor: Verify AI Profile` command using `AiConnectionService`.
- `AI Focused Editor: Improve Selected Text` wired to Theia editor selection and `AiConnectionService`.
- Improved selection output copied to clipboard first, then offered as an explicit `Replace Selection` action.
- Safe AI replacement uses Theia editor `replaceText` with the original captured selection range.
- `ManuscriptWorkspaceService` domain scanner using Theia `WorkspaceService` and `FileService`.
- `manifest.yaml` content order mapped into a service-level snapshot.
- Manifest-backed manuscript tree view using Theia Tree infrastructure.
- Manuscript tree nodes open files through Theia `OpenerService`.
- Standalone `@ai-focused-editor/semantic-markdown` parser package for semantic inline tags.
- Parser coverage for `[[char:id|label]]`, `[[term:id|label]]`, and other extensible tag kinds with LSP-compatible ranges.
- Minimal editor decorations for semantic Markdown tags through Theia editor `deltaDecorations`.
- Semantic tag hover text through Theia editor decoration hover messages.
- Semantic Markdown preview widget using Theia `MarkdownRenderer`.
- Preview refreshes from the current Markdown editor and document change events.
- Preview transform renders semantic tags as readable Markdown labels while preserving the source file format.
- YAML schema validation for `metadata.yaml`, `manifest.yaml`, character entities, and term entities.
- YAML/schema findings are surfaced through the existing workspace diagnostics path and Theia Problems/markers.
- Manuscript AI context assembler for manifest content, diagnostics, character/term entities, and source directory summary.
- Theia AI variable contribution for `#manuscript` as a context variable in the existing Theia AI pipeline.
- `AI Focused Editor: Copy Manuscript AI Context` command for inspecting the assembled chat context.
- Append-only AI history service writing JSONL under `ai/chat/`.
- Append-only context snapshot logging under `ai/context-snapshots/`.
- `Improve Selected`, AI profile verification, and copy-context flows record best-effort history without blocking command UX.
- `AI Focused Editor: Validate Manuscript Workspace` command connected to the scanner and Theia messages.
- Workspace validation findings published to Theia Problems/markers.
- Sample colocated manuscript workspace under `examples/sample-book`.
- Electron Theia application under `apps/electron`.
- Electron target reuses Theia editor/Monaco/workbench infrastructure instead of duplicating desktop shell code.
- Electron native module rebuild wired through Bun scripts with explicit Theia native module list.
- Electron build-time `@theia/ffmpeg` native addon build wired through `node-gyp`.
- Bun patch recorded for `electron-rebuild@3.2.9` so Electron 39 native rebuilds use C++20.
- Theia SCM surface packages wired through `@theia/scm` and `@theia/scm-extra`.
- Backend `GitHistoryService` exposed through Theia JSON-RPC and implemented over the Git CLI.
- Git branch/dirty state surfaced through a Theia status bar contribution.
- `AI Focused Editor: Show Git Status` and `AI Focused Editor: Copy Git Status Summary` commands.
- `AI Focused Editor: Open Current File Diff` command using Theia diff opener infrastructure.
- Read-only `HEAD` file content resolver for working-tree vs Git `HEAD` diffs.
- Backend `BookBuildService` exposed through Theia JSON-RPC.
- Manifest-driven Markdown export that reads `metadata.yaml`, respects `manifest.yaml` order and `include: false`, generates a TOC, and writes `build/book.md`.
- Build diagnostics prevent export writes when fatal manifest/content errors are present.
- `AI Focused Editor: Build Manuscript Markdown`, `Open Last Manuscript Build`, and `Copy Last Build Path` commands.
- Sample workspace build output path ignored as generated artifact via `.gitignore`.
- `NarrativeEntityService` boundary for YAML-backed character and term entities.
- Knowledge Cards Theia view showing character/term cards with labels, summaries, aliases, YAML paths, and open-file actions.
- Knowledge menu commands for opening and refreshing entity cards.
- Sample character entity data expanded with summaries and an Arjuna card.
- Semantic Markdown quick actions for wrapping selected text as character, term, or artifact tags.
- Semantic Markdown tag summary copy command for the active editor.
- Semantic Markdown quick actions contributed to the AI Focused Editor menu and editor context menu.
- Semantic Preview now shows detected semantic tags as a compact chip summary before rendered Markdown.
- `AiModeRegistry` boundary for project AI modes stored in `ai/prompts/custom-modes.yaml`.
- Project AI mode commands for showing, copying, and opening workspace AI mode definitions.
- `Improve Selected` now uses project AI mode `improve-selection` when present, with builtin fallback when absent.
- Sample workspace includes `ai/prompts/custom-modes.yaml` with `improve-selection` and semantic-tag explanation modes.
- Semantic Markdown parser exposes diagnostics for malformed/unclosed `[[kind:id|label]]` tags.
- Workspace validation now scans Markdown files from the manifest and publishes semantic Markdown diagnostics through Theia Problems/markers with source ranges.
- Semantic Markdown normalization command for domain-specific tag formatting without replacing Theia's generic formatter.
- Parser tests cover semantic diagnostics and normalization.
- Theia `@theia/ai-chat-ui` wired into browser and Electron app targets.
- `AiConnectTheiaLanguageModel` registers `@vedmalex/ai-connect` as a Theia `LanguageModel`.
- Theia AI requests map through the existing `AiConnectionService` and preference-backed ai-connect profile.
- Theia AI language model requests record best-effort append-only chat history.
- `Manuscript` custom chat agent registered through Theia `CustomAgentFactory` and backed by the ai-connect language model.
- AI Model Config view now includes an editable form for provider, model, transport, transport/profile IDs, endpoint, and API key.
- AI profile edits are saved through Theia preferences in folder scope when a workspace root is available.
- Existing API keys are not echoed into the UI; blank API key input keeps the configured secret.
- AI Debug Theia view for inspecting configured provider/model/transport, project AI modes, active editor selection, and assembled manuscript context.
- AI Debug commands for opening, refreshing, and copying a prompt/context/provider snapshot.
- Verified:
  - `bun install`
  - `bun test packages/semantic-markdown/src/semantic-markdown.test.ts`
  - `bun run build`
  - `bun run start` smoke startup
  - `bun run build:electron`
  - Direct `BookBuildService` Node smoke against `examples/sample-book`

## In Progress

- Source library/citations post-MVP feature slice.

## Not Implemented Yet

- Source library/citations as post-MVP feature slice.

## Next MVP Slice

1. **Миграция на нативные механизмы Theia AI и Core IDE (согласно spec.md v2.0):**
   - Перевод `Improve Selected` и замены текста от AI на **Theia AI Change Sets** (FR-009) для отображения нативного diff-предпросмотра.
   - Вынос валидации YAML и линтинга Markdown в выделенный **LSP-сервер** (Language Server Protocol) для разгрузки UI-потока (FR-018).
   - Перевод процесса сборки и экспорта книги на Theia Task System (`@theia/task`) через `TaskProvider` (FR-016).
   - Замена кастомного `GitHistoryService` (`node-git-history-service.ts`) на встроенные механизмы `@theia/git` и `@theia/scm` (FR-017).
   - Регистрация проектных AI-промптов из `custom-modes.yaml` как `PromptFragments` через `PromptService` (FR-012).
2. Add source library/citations as post-MVP feature slice.
3. Add packaging/startup polish for desktop/cloud variants.
4. Add deterministic UI flow tests for core commands.
5. Add deeper build/export targets beyond Markdown.
6. Form-based Entity Editors (Custom Editors API) для визуального редактирования карточек сущностей (FR-025, Backlog).
