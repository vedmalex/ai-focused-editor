---
type: concept
slug: ai-focused-editor-feature-map
created_at: 2026-07-10T04:24:31Z
updated_at: 2026-07-10T06:38:03Z
---

# AI Focused Editor — Feature Map

A complete, code-accurate map of the **AI Focused Editor**, a [Theia](https://theia-ide.org)-based writing IDE for long-form Markdown manuscripts with semantic tags, project knowledge, source-aware review, and multi-provider AI. It builds on Theia's [[contribution-points|contribution points]], [[widgets-and-views|widgets/views]], [[dependency-injection|DI]], [[frontend-backend-separation|frontend/backend separation]], [[theia-ai|Theia AI]], [[language-models|language models]], [[prompt-fragments]], and [[context-variables]].

The product ships in one npm package: **`@ai-focused-editor/manuscript-workspace`** (`packages/manuscript-workspace`), which registers **six** Theia extension modules via `theiaExtensions` in its `package.json`:

| Module | Front/back | Purpose |
|--------|-----------|---------|
| `manuscript-workspace-frontend-module` + `manuscript-workspace-backend-module` | both | Core: unified author navigator, preview, model-config, AI debug, sources, AI stack, chat agent, tools, markdown grammar, git actions |
| `entity-editor-frontend-module` | frontend | Form-based entity YAML editor (FR-025) |
| `citation-editor-frontend-module` | frontend | Form-based `sources/citations.yaml` editor (default opener) |
| `knowledge-generation-frontend-module` | frontend | Chapter summaries / scene plans / author questions (FR-011) |
| `narrative-graph-frontend-module` | frontend | Narrative Map view + narrative-graph service proxy (FR-007) |
| `semantic-history-frontend-module` | frontend | Read-only semantic (git) history view (FR-017) |

Supporting packages: **`@ai-focused-editor/semantic-markdown`** (`[[kind:id|label]]` parse/validate/normalize/preview), **`@ai-focused-editor/book-export`** (EPUB/PDF/HTML generators), and **`@ai-focused-editor/git`** — a temporary local fork of `@theia/git@1.60.2` rebuilt for Theia 1.73 (`packages/theia-git-fork`, see *Git & History*). The AI transport layer is the external **`@vedmalex/ai-connect`** library.

---

## Views & Layout

Widget IDs are the `static readonly ID` on each widget class; every view is toggled by a command (`toggleCommandId`) and placed in a shell area via `defaultWidgetOptions.area`/`rank`.

| View (label) | Widget ID | Area (rank) | Toggle command | Tab icon | Renders |
|--------------|-----------|-------------|----------------|----------|---------|
| **Manuscript** (unified author navigator) | `ai-focused-editor.manuscript-tree` | left (200) | `ai-focused-editor.manuscriptTree.open` | `fa fa-book` | Single tree with **8 sections** — Manuscript, Characters, Terms, Artifacts, Locations, Citations, Sources, Knowledge — each header showing a live count (see below). Manifest-backed manuscript nodes drag-reorder (MIME `application/x-afe-manuscript-path`); codicon icon theme with per-kind `afe-ico-*` accent colors |
| **Sources** | `ai-focused-editor.sources` | left (215) | `ai-focused-editor.sources.open` | `fa fa-archive` | Detail panel with three sections: **Files**, **Citations** (`[@cite:id]` targets), **Excerpts**. Per-row **Copy** buttons (`Copy citation title` / `Copy excerpt text`). Attach/Analyze/Save-as-Citation are commands |
| **Semantic Preview** | `ai-focused-editor.semantic-markdown.preview` | right (220) | `ai-focused-editor.semanticMarkdown.preview.open` | `fa fa-eye` | Live preview of the active `.md`; `[[kind:id\|label]]` → **label** _(kind:id)_; GFM task lists render as `☐`/`☑` glyphs; optional tag-chip row (pref `aiFocusedEditor.preview.showTagChips`). **`ExtractableWidget`** (`isExtractable = true`) — tears off to its own OS window (FR-021) |
| **Knowledge Cards** | `ai-focused-editor.entity-cards` | right (220) | `ai-focused-editor.entities.openCards` | `fa fa-address-card` | Entity cards grouped **Characters → Artifacts → Locations → Terms**; each card: label+kind badge, id, aliases, epithets, summary, arc, collapsible speech patterns / backstory / notes, "Open YAML" |
| **Narrative Map** | `ai-focused-editor.narrative-map` | right (230) | `ai-focused-editor.narrative.openMap` | `fa fa-project-diagram` | Timeline (artifact ownership chains + per-chapter entity chips) and a **Relations SVG graph** (ring layout, node radius ∝ appearances, edge width ∝ co-occurrence) |
| **AI Model Config** | `ai-focused-editor.model-config` | right (230) | `ai-focused-editor.modelConfig.open` | `fa fa-sliders` | Multi-profile list (drag-reorder, radio=active, clone/delete), edit form (label/provider/model/transport/account/endpoint/allowed-models/API key), buttons: Save, Verify Active, Use Local Proxy, Discover Models |
| **AI Debug** | `ai-focused-editor.ai-debug` | right (240) | `ai-focused-editor.aiDebug.open` | `fa fa-bug` | Provider/Profile status table, Project AI Modes, Active Editor, Manuscript Context dump, and a **Request Log**: kind select (`Chat requests` / `Context snapshots`), day picker (`listHistoryDays`), Refresh, Open JSONL; per-entry route chip + JSON |
| **Semantic History** | `ai-focused-editor.semantic-history` | right (240) | `ai-focused-editor.semantic-history.open` | `fa fa-history` | Read-only git history filtered to semantic-domain commits (`getSemanticHistory`, limit 50); per-commit entity/path change chips (add/modify/delete/rename) |
| **Entity Form Editor** | factory `ai-focused-editor.entity-editor` (widget id `FACTORY_ID:<uri>`) | main | opener (priority 500) + `ai-focused-editor.entity.openFormEditor` | `fa fa-id-badge` | Structured form for entity YAML. Default opener for `entities/{characters,artifacts,locations,terms}/*.yaml`; preserves comments/unknown keys via `yaml` `parseDocument` |
| **Citation Form Editor** | factory `ai-focused-editor.citation-editor` (widget id `FACTORY_ID:<uri>`) | main | opener (priority 500) + `ai-focused-editor.sources.editCitations` | `fa fa-quote-right` | Form for `sources/citations.yaml` (`id`/`title`/`source`/`note` rows; Add / Save / Reload; per-row Delete). Default opener for `sources/citations.yaml` (priority 500 > editor's 100; raw YAML via "Open With…"); round-trips header/`version`/comments via `parseDocument` |

**The unified author navigator** (`author-materials.ts` + `manuscript-tree-*.ts`) replaces the old manuscript-only tree. Section order and labels are fixed by `AUTHOR_MATERIALS_SECTION_ORDER`; each header renders as `Label (count)` via `formatSectionLabel` (only **Manuscript** starts expanded). Counts: manuscript = recursive leaf-file count; entity sections = filtered entity-list length; Citations = citation count; Sources/Knowledge = recursive material-file count. Files surface only via **`isAllowedMaterialFile`** (documents `.md .markdown .txt .pdf .doc .docx .odt .rtf .epub .html .htm`, images `.png .jpg .jpeg .gif .svg .webp .tif .tiff .bmp`, structural `.yaml .yml .json .jsonl`; dotfiles rejected; Knowledge further narrows to `.yaml/.yml/.md`). Characters/Terms/Artifacts/Locations/Citations are flat; **Sources and Knowledge keep nested folder structure** (`buildMaterialFileTree`, empty folders pruned). Icons are codicons with per-kind accents (`.afe-ico-manuscript` blue, `.afe-ico-characters` purple, `.afe-ico-terms` green, `.afe-ico-artifacts` orange, `.afe-ico-locations` red, `.afe-ico-citations`/`.afe-ico-knowledge` yellow, `.afe-ico-sources` description-foreground — `style/index.css`). On a fresh layout the navigator opens revealed (not the developer file explorer).

**Status bar contributions** (`FrontendApplicationContribution`s):
- **AI profile** (`ai-focused-editor.ai-profile-status`, right, priority 120): `AI: <label> · provider/model` or `⚠ AI: configure`; click opens Model Config; tooltip shows failover-chain length, transport, API-key state.
- **Git** (`ai-focused-editor.git-status`, left, priority 100): `$(source-control) <branch> •<dirty> ↑ahead ↓behind`; polls every 15 s (`REFRESH_INTERVAL_MS`) + 1.5 s-debounced file-change refresh; read-only (commits stay manual).

**Focus Mode** (`ai-focused-editor.focusMode.toggle`): collapses left/right/bottom panels around the editor and restores them on toggle.

---

## Menu & Commands

The product menu lives under `MAIN_MENU_BAR` at path `['8_ai_focused_editor']`, label **Manuscript** (`ai-focused-editor-menu.ts`). The menu tree is registered by a **single central `registerSubmenu` block** in `ManuscriptWorkspaceMenuContribution.registerMenus` (`manuscript-workspace-contribution.ts`): the `MAIN` menu plus six submenus — `2_semantic-markdown` (Semantic Markdown), `3_build` (Build), `4_knowledge` (Knowledge), `5_sources` (Sources), `6_ai-modes` (AI Modes), `7_ai-debug` (AI Debug). All other contributions only add `registerMenuAction`s (repeated `registerSubmenu` for the same path would create duplicate menu-bar entries — enforced by the `AFE-02-MENU-NO-DUPLICATES` UI flow check).

Command table (**55 commands**, `id | label | menu | keybinding`). Category is `AI Focused Editor` throughout.

| Command id | Label | Menu | Keybinding |
|------------|-------|------|-----------|
| `ai-focused-editor.focusMode.toggle` | Toggle Focus Mode | Manuscript (order 0) | `ctrlcmd+alt+f` |
| `outlineView:toggle` (built-in) | **Chapter Outline** | Manuscript (0a) | — |
| `ai-focused-editor.manuscriptTree.open` | Open Manuscript View | Manuscript (1) | — |
| `ai-focused-editor.manuscriptTree.newChapter` | New Chapter… | Manuscript (1a) + tree ctx | — |
| `ai-focused-editor.manuscriptTree.moveUp` | Move Chapter Up | tree context menu | — |
| `ai-focused-editor.manuscriptTree.moveDown` | Move Chapter Down | tree context menu | — |
| `ai-focused-editor.manuscriptTree.toggleBuildInclusion` | Include/Exclude in Book Build | tree context menu | — |
| `ai-focused-editor.manuscriptTree.refresh` | Refresh Manuscript View | tree context menu | — |
| `ai-focused-editor.workspace.validate` | Validate Manuscript Workspace | Manuscript | `ctrlcmd+alt+v` |
| `ai-focused-editor.ai.improveSelection` | Improve Selected Text | Manuscript + editor ctx (z1) | `ctrlcmd+alt+i` (`editorTextFocus`) |
| `ai-focused-editor.ai.checkConsistency` | Check Manuscript Consistency | Manuscript | — |
| `ai-focused-editor.ai.copyManuscriptContext` | Copy Manuscript AI Context | Manuscript | — |
| `ai-focused-editor.ai.verifyProfile` | Verify AI Profile | Manuscript | — |
| `ai-focused-editor.ai.suggestCoreference` | Suggest Coreference Tags | Manuscript + editor ctx (z2) | — |
| `ai-focused-editor.ai.reviewChapter` | **AI Review Current Chapter** | Manuscript + editor ctx (z3) | — |
| `ai-focused-editor.git.initRepository` | **Initialize Git Repository** | Manuscript (z8) | — |
| `reset.layout` (built-in) | **Reset Workbench Layout (This Folder)** | Manuscript (z9) | — |
| `ai-focused-editor.git.addToGitignore` | **Add to .gitignore** | navigator context (z_afe) | — |
| `ai-focused-editor.semanticMarkdown.preview.open` / `.refresh` | Open / Refresh Semantic Markdown Preview | Manuscript (+ `.md` editor toolbar button) | — |
| `ai-focused-editor.semanticMarkdown.preview.toggleTagChips` | **Toggle Semantic Tag Chips in Preview** | Manuscript | — |
| `ai-focused-editor.modelConfig.open` / `.refresh` | Open / Refresh AI Model Config | Manuscript | — |
| `ai-focused-editor.semanticMarkdown.wrapSelectionAsCharacter` | Wrap Selection as Character Tag | Semantic Markdown + editor ctx | — |
| `ai-focused-editor.semanticMarkdown.wrapSelectionAsTerm` | Wrap Selection as Term Tag | Semantic Markdown + editor ctx | — |
| `ai-focused-editor.semanticMarkdown.wrapSelectionAsArtifact` | Wrap Selection as Artifact Tag | Semantic Markdown + editor ctx | — |
| `ai-focused-editor.semanticMarkdown.copyTagSummary` | Copy Semantic Tag Summary | Semantic Markdown | — |
| `ai-focused-editor.semanticMarkdown.normalizeTags` | Normalize Semantic Markdown Tags | Semantic Markdown + editor ctx | — |
| `ai-focused-editor.bookBuild.buildMarkdown` | Build Manuscript Markdown | Build | — |
| `ai-focused-editor.bookBuild.buildHtml` | Build Manuscript HTML | Build | — |
| `ai-focused-editor.bookBuild.epub` | Build Manuscript EPUB | Build | — |
| `ai-focused-editor.bookBuild.pdf` | Build Manuscript PDF | Build | — |
| `ai-focused-editor.bookBuild.openLastBuild` | Open Last Manuscript Build | Build | — |
| `ai-focused-editor.bookBuild.copyLastBuildPath` | Copy Last Build Path | Build | — |
| `ai-focused-editor.knowledge.summarizeChapter` | Summarize Current Chapter | Knowledge | — |
| `ai-focused-editor.knowledge.generateScenePlan` | Generate Scene Plan for Current Chapter | Knowledge | — |
| `ai-focused-editor.knowledge.generateAuthorQuestions` | Generate Author Questions for Current Chapter | Knowledge | — |
| `ai-focused-editor.entities.openCards` / `.refreshCards` | Open / Refresh Knowledge Cards | Knowledge | — |
| `ai-focused-editor.entity.openFormEditor` | Open With Form Editor | Knowledge + editor ctx (navigation) | — |
| `ai-focused-editor.entity.openRawYaml` | Open Entity YAML (Raw) | Knowledge | — |
| `ai-focused-editor.narrative.openMap` / `.refreshMap` | Open / Refresh Narrative Map | Knowledge | — |
| `ai-focused-editor.semantic-history.open` / `.refresh` | Open / Refresh Semantic History | Knowledge | — |
| `ai-focused-editor.sources.open` / `.refresh` | Open / Refresh Sources | Sources | — |
| `ai-focused-editor.sources.attach` | Attach Source File… | Sources | — |
| `ai-focused-editor.sources.analyze` | Analyze Source Document… | Sources | — |
| `ai-focused-editor.sources.saveSelectionAsCitation` | **Save Selection as Citation…** | Sources + editor ctx (z3) | — |
| `ai-focused-editor.sources.editCitations` | **Edit Citations…** | Sources | — |
| `ai-focused-editor.aiModes.show` | Show Project AI Modes | AI Modes | — |
| `ai-focused-editor.aiModes.copySummary` | Copy Project AI Mode Summary | AI Modes | — |
| `ai-focused-editor.aiModes.openFile` | Open Project AI Modes File | AI Modes | — |
| `ai-focused-editor.aiDebug.open` / `.refresh` | Open / Refresh AI Debug View | AI Debug | — |
| `ai-focused-editor.aiDebug.copySnapshot` | Copy AI Debug Snapshot | AI Debug | — |

**Keybindings** (`ManuscriptWorkspaceKeybindingContribution`): `ctrlcmd+alt+i` → Improve Selected Text (when `editorTextFocus`); `ctrlcmd+alt+v` → Validate Manuscript Workspace; `ctrlcmd+alt+f` → Toggle Focus Mode.

The editor context menu (`EDITOR_CONTEXT_MENU` + `MODIFICATION`) carries the writer AI actions — Improve Selected (z1), Suggest Coreference (z2), AI Review Current Chapter (z3) — plus Save Selection as Citation (z3, from the source-library contribution) and the Semantic Markdown wrap/normalize actions.

Preferences are defined in `ai-focused-editor-preferences.ts` (see [[preferences-system]]), scope Folder. AI keys under `aiFocusedEditor.ai.*`: `provider`, `model`, `apiKey`, `endpointUrl`, `transportKind` (`api|proxy|acp|cli|server`), `transportId`, `profileId`, plus the multi-profile keys **`profiles`** (array), **`activeProfile`** (id), **`apiKeys`** (object, per-profile, User scope). Legacy single keys apply only when `profiles` is empty. New: **`aiFocusedEditor.preview.showTagChips`** (boolean, default `true`) — shows/hides the tag-chip row atop Semantic Preview; toggled by `…preview.toggleTagChips` (written to User scope).

---

## Editor Features

Semantic tag syntax (`@ai-focused-editor/semantic-markdown`): `SEMANTIC_TAG_PATTERN = /\[\[([a-z][\w-]*):([A-Za-z0-9_.:-]+)\|([^\]\n]+?)\]\]/g` — i.e. `[[kind:id|label]]`. Tag kinds: `char`, `term`, `artifact`, `location`. Registered against Monaco for `markdown`/`.md`:

- **Markdown grammar** (`markdown-language-contribution.ts`, `FrontendApplicationContribution`): registers the `markdown` language (extensions `.md .markdown .mdown .mkdn .mkd .mdwn`) if absent, then applies a Monarch tokenizer (`setMonarchTokensProvider`, ported/trimmed from monaco-editor's basic markdown grammar — headers, blockquotes, lists, code fences, bold/italic, **GFM strikethrough `~~…~~`**, links/images, embedded HTML) plus a matching `LanguageConfiguration` (block comment `<!-- -->`, brackets, auto-closing/surrounding pairs).
- **Decorations** (`semantic-markdown-decoration-service.ts`): each tag gets CSS `afe-semantic-tag afe-semantic-tag-<kind>`; debounced 150 ms. **Hover**: `<TagLabel>: <entity.label|label> (id)` plus entity summary, aliases, epithets, from a 5 s-cached `NarrativeEntityService.getSnapshot()` index.
- **Completion** (`semantic-markdown-completion-provider.ts`): trigger chars `[` and `:`; offers entity items `kind:id` (snippet `kind:id|${1:label}]]`) filtered by kind- and id-prefix, plus bare kind scaffolds.
- **Outline / document symbols** (`semantic-markdown-document-symbol-provider.ts`): now emits the chapter's **heading hierarchy** (ATX `#`…`######` → nested `DocumentSymbol`s, all `SymbolKind.String` with `detail` `H1`…`H6`, fenced code skipped), with each section's **unique semantic entities nested beneath their heading** (one node per unique `kind:id` at first occurrence, deduped per owning heading; SymbolKind `char→Class`, `term→Key`, `artifact→Object`, `location→Namespace`). Surfaced by Manuscript ▸ **Chapter Outline** (`outlineView:toggle`).
- **Citation links** (in `source-library-view-contribution.ts`): `CITATION_LINK_PATTERN = /\[@cite:([^\]\s]+)\]/g` via a Monaco `LinkProvider`. Resolves to the citation's `path` (from `citations.yaml`), else opens `sources/citations.yaml`. Cmd/Ctrl-click navigation.
- **Quick actions** (`semantic-markdown-actions-contribution.ts`): `wrapSelectionAs{Character,Term,Artifact}` derive an id via `createSemanticId` and insert `[[kind:id|label]]`. `normalizeTags` lower-cases kind, trims id, collapses label whitespace. `copyTagSummary` copies a Markdown list of all tags with line numbers. `validateSemanticMarkdown` flags unclosed/invalid tags as diagnostics.

AI writer commands surface edits as **native Change Sets** in the chat view (Accept/Reject) plus an immediate diff — `Improve Selected Text` and `Suggest Coreference Tags` never auto-rewrite (coreference also guards against >±60 % length drift). **`AI Review Current Chapter`** takes a different route: it opens/creates a chat session and `chatService.sendRequest`s an editorial-review prompt appended with the `#chapter #entities` context variables, so the review streams into the chat view with full provenance and tool access. `Check Consistency` publishes findings to the Problems view (owner `ai-focused-editor.consistency`); `Validate Manuscript Workspace` publishes schema diagnostics (owner `ai-focused-editor.workspace`).

---

## AI Stack

Bridges the app to [[theia-ai]] and [[language-models]] via `@vedmalex/ai-connect`.

**Transports** (`ai-connect-config.ts`): `api`, `acp`, `cli`, `server` (`proxy` normalizes to `api`, pointing at a local proxy `http://127.0.0.1:8045`). The boundary:
- **`api` runs directly in the browser** — `BrowserAiConnectionService` calls `createBrowserClient(defineConfig(buildAiConnectConfigInput(profile)))` from `@vedmalex/ai-connect/browser`. Plain HTTP fetch, no RPC.
- **`acp`/`cli`/`server` route to the backend** — delegated over JSON-RPC to `LocalAiConnectionService` → `NodeLocalAiConnectionService`, which uses `createLocalClient` from `@vedmalex/ai-connect/local`.

**Streaming push channel**: `LocalAiConnectionServicePath` is a **duplex** RPC — the frontend registers `LocalAiStreamClientImpl` as the callback client; `NodeLocalAiConnectionService.startStream` `emit`s `{type:'delta'|'result'|'end'|'error'}` wire events to all connected clients; `cancelStream` aborts. `BrowserAiConnectionService.streamLocalTransport` drains those pushes into an async iterator.

**Multi-profile registry** (`ai-profile-preference-service.ts`, bound as `ModelProviderRegistry`): named `profiles` in Folder scope; `apiKeys` (per-profile) in User scope. **Failover chain** = active profile first, then remaining `enabled` profiles in list order, incomplete profiles filtered out.

**Failover**: `generateWithFailover` (`ai-failover.ts`) tries the chain in order, returns first success, throws an aggregate error if all fail. The Theia AI streaming path retries onto the next profile only while nothing has been emitted.

**Theia AI integration** (`ai-connect-theia-language-model.ts`): registers `AiConnectTheiaLanguageModel` (id `ai-focused-editor.ai-connect`) as a Theia `LanguageModelProvider`. Maps Theia messages/tools ↔ ai-connect; **tools** become ai-connect `clientTools` executed in-process (effective only on `api`). **Provenance**: every request is logged to AI history (`kind: 'theia-ai-language-model-request'`) with `sessionId`/`requestId`/`agentId`/`promptVariantId`/`route`, the **bounded outgoing messages** (`toLoggedMessages`, each truncated at `MAX_MESSAGE_CHARS = 4000`), the **tool names** (`clientTools[].function.name`), the **response text** (truncated at `MAX_RESPONSE_CHARS = 12000`), `warnings`, and `usage`.

**Model discovery**: `discoverModels(profile)` flattens `report.routes[*].availableModels` into `{modelId, name, contextLength}` — surfaced by the Model Config "Discover Models" button.

**Chat agent** (`manuscript-chat-agent-contribution.ts`): registers a `CustomAgent` id **`ai-focused-editor.manuscript`** ("Manuscript"), backed by the ai-connect language model, prompt referencing `{{manuscript}}` and the tools. See [[theia-ai-agents]].

**Context variables** (`manuscript-context-variable-contribution.ts`, an `AIVariableContribution` that is also its own resolver) — **six** [[context-variables|AI context variables]] so writers can address project context granularly:

| Reference | id / name | Resolves to |
|-----------|-----------|-------------|
| `#manuscript` | `ai-focused-editor.manuscript-context` / `manuscript` | Whole-project context via `ManuscriptAiContextAssembler.assemble()` (manifest tree, diagnostics, entity + source summaries) |
| `#chapter[:path]` | `ai-focused-editor.chapter-context` / `chapter` | One chapter's Markdown (≤ `MAX_CHAPTER_CHARS = 24000`). Defaults to the active editor; optional workspace-relative path arg (`#chapter:content/chapter-01.md`, rejects `..`) |
| `#entity:id` | `ai-focused-editor.entity-context` / `entity` | One knowledge card by exact id (or case-insensitive label), all fields; lists known ids when not found |
| `#entities` | `ai-focused-editor.entities-context` / `entities` | Compact roster of every character/term/artifact/location card |
| `#sources` | `ai-focused-editor.sources-context` / `sources` | Source files list + citations + first-50 excerpts |
| `#outline` | `ai-focused-editor.outline-context` / `outline` | Manifest structure plus the heading outline of every included chapter |

(No argument picker/completion UI — arguments are free-text after a colon, validated at resolve time.)

**Tools** (`manuscript-tools-contribution.ts`, Theia `ToolProvider`s): `manuscript_find_entities`, `manuscript_list_chapters`, `manuscript_get_chapter` (read Markdown by path, ≤16000 chars, rejects `..`).

**Prompt fragments** ([[prompt-fragments]], `ai-mode-prompt-fragment-contribution.ts`): each project **AI mode** becomes a built-in prompt fragment `ai-focused-editor.project-mode.<id>`, exposed as chat command `afe-<id>`; re-synced on workspace/file changes.

**AI modes** shipped in `examples/sample-book/ai/prompts/custom-modes.yaml` (`version: 1`, **8 modes**; each: `id`, `label`, `description`, `systemPrompt`, optional `userPrompt`, `parameters.temperature`):

| id | Purpose |
|----|---------|
| `improve-selection` | Tighten selected prose, preserve semantics/tags |
| `explain-semantic-tags` | Explain what a `[[kind:id\|label]]` tag means |
| `consistency-check` | Cross-chapter contradictions → JSON `{path,line,severity,message}[]` |
| `summarize-chapter` | Chapter synopsis → JSON `{summary}` |
| `plan-scenes` | Scene breakdown → JSON `{scenes:[{title,purpose,beats[]}]}` |
| `author-questions` | Developmental questions → JSON `{questions:[]}` |
| `coreference-tags` | Wrap untagged references as `[[kind:id\|surface]]`, return full Markdown |
| `analyze-source` | Extract `{excerpts[], citations[]}` from a source doc |

(Command handlers fall back to built-in prompts when a mode is absent.)

---

## Knowledge System

Project knowledge is filesystem-first YAML, scanned by backend services and surfaced in views.

- **Entities** (`entities/{characters,terms,artifacts,locations}/*.yaml`, `NarrativeEntityKind = character|term|artifact|location`). Shared optional fields: `aliases[]`, `epithets[]`, `speechPatterns[]`, `summary`, `backstory`, `arc`, `notes`. Label field is `name` (character/artifact/location) or `term` (term). **Artifacts** add `ownership[]` = `{owner, from?, to?, note?}` — rendered as ownership chains in Narrative Map, editable only via raw YAML. Served by `NarrativeEntityBackendService`; edited via the **Entity Form Editor**, viewed in **Knowledge Cards**.
- **Narrative graph** (`NarrativeGraphBackendService`): timeline (chapters in manifest order with per-chapter appearance counts), artifact ownership transfers, and a co-occurrence relation graph (nodes capped at `NARRATIVE_GRAPH_NODE_CAP = 20`). Powers **Narrative Map**.
- **Knowledge generation** (FR-011): AI-generated chapter `summaries/`, scene `plans/`, author `questions/` under `knowledge/`. Response coercion tolerates fenced/embedded JSON with raw-text fallback; chapter slug via `slugifyChapter` (unicode-aware).
- **AI mode registry** (`AiModeRegistryBackendService`): parses `ai/prompts/custom-modes.yaml`; dedupes by id; legacy `prompt` maps to `systemPrompt`.

---

## Sources & Citations

`SourceLibraryBackendService` scans `sources/` and drives the **Sources** view + citation links.

- `sources/documents/`, `sources/images/` — raw source files/subfolders. **Now scanned recursively** (`collectSourceItems`): any subfolder is walked, only `isAllowedMaterialFile` types survive, dotfiles/dot-dirs skipped, empty directories pruned; only the root `citations.yaml`/`excerpts.jsonl` index files are excluded.
- `sources/citations.yaml` — `CitationEntry {id, title, source?, note?, path?}`; accepts `{citations:[…]}` or a bare array. Targets of `[@cite:id]` links. Edited by the **Citation Form Editor** (default opener).
- `sources/excerpts.jsonl` — one `SourceExcerpt {id, sourceId?, sourcePath?, text, note?, targetPath?, targetAnchor?, targetLine?}` per line.
- **Attach** (`sources.attach`) copies a picked file into `sources/images/` or `sources/documents/` by extension. **Analyze** (`sources.analyze`) runs the `analyze-source` AI mode, appending excerpts and merging citations (`source-analysis.ts`).
- **Save Selection as Citation** (`sources.saveSelectionAsCitation`, editor context menu): from the active editor selection, derives a slug id (`citationSlugFromText` + `dedupeCitationId`) and title (`citationTitleFromText`), prompts for the id (validated non-empty/unique) and an optional note, then appends a `SourceExcerpt` to `excerpts.jsonl` (`targetLine` from the selection) and merges a `CitationEntry` into `citations.yaml` (comment-preserving `parseDocument` write).
- **Edit Citations** (`sources.editCitations`) seeds `sources/citations.yaml` with `version: 1\ncitations: []\n` if missing, then opens the form editor. The read-only Sources view adds per-row **Copy** buttons (citation title / excerpt text).

---

## Build & Export

`BookBuildService` → `NodeBookBuildService` exports the manuscript. Common front end: read `metadata.yaml` (title/author/language/**cover**), walk `manifest.yaml` `content[]` (or natural-sort fallback), filter `include:false` nodes, read each chapter, run `validateSemanticMarkdown` + fatal build diagnostics. Default outputs under `build/`:

| Format | Output | Pipeline |
|--------|--------|----------|
| Markdown | `build/book.md` | Hand-built string: front-matter, `# Title`, generated TOC, chapters concatenated in build order |
| HTML | `build/book.html` | `markdown-it` (`html:false, linkify, typographer`) with semantic tags stripped to labels; **default preset gives GFM tables + strikethrough**, and the custom `markdownItTaskLists` plugin renders `- [ ]`/`- [x]` as real disabled `<input type="checkbox">`; inline `<style>`, `<nav>` TOC |
| EPUB | `build/book.epub` | `EpubGenerator`: Markdown→`TelegraphNode`→XHTML, `content.opf`/`toc.ncx`/`style.css`, optional **cover** embed, hand-rolled ZIP. GFM strikethrough → `<del>`, tables → real `<table>`, task lists → `☐`/`☑` glyphs (no bare `<input>`) |
| PDF | `build/book.pdf` | Reuses the HTML render (same real checkboxes) → `renderHtmlToPdf` (puppeteer-core, local Chrome, A4/A5, print CSS) |

GFM **task lists render per surface**: real HTML checkboxes for HTML/PDF, `☐`/`☑` ballot-box glyphs for Semantic Preview and EPUB (Theia's `html:false` renderer / non-void-tag EPUB serializer can't emit a bare `<input>`).

**Headless / background builds**: `BookBuildContribution` (frontend) also implements `TaskContribution`/`TaskProvider`; `NodeBookBuildTaskRunner` (backend `TaskRunnerContribution`, task type `BookBuildTaskType = 'ai-focused-editor.book-build'`) spawns `node book-build-task-cli.js --format <fmt> <rootUri> [outputPath]` as a Theia terminal task; `book-build-task-cli.ts` is a DI-free CLI that instantiates `NodeBookBuildService` directly, prints `[SEVERITY] uri:line:col message` diagnostics, and sets `exitCode=1` on errors.

---

## Git & History

Interactive SCM is not yet wired; the app's own git surface is **read-only** (commits stay manual, spec §5.6), with two writer-setup exceptions (init repo, add-to-gitignore).

- **Local git fork** — `packages/theia-git-fork` publishes **`@ai-focused-editor/git`** `0.1.0`, a *temporary* fork of the deprecated `@theia/git@1.60.2` rebuilt against Theia platform `1.73.1` (both apps depend on it). Rationale (`FORK.md`): installing upstream `@theia/git@1.60.2` alongside the 1.73 platform pulls a **second `@theia/core`** copy, and Theia's DI relies on shared singleton symbols from `@theia/core`, so a duplicate breaks contribution bindings at runtime. Upstream has stalled (deprecated, no 1.73 release), so the 1.60.2 sources are rebuilt against the single platform-1.73.1 core. **Drop-when-upstream-ships plan**: delete the package, remove the dep from both apps' `package.json`, drop the two root-script (`build:packages`/`clean`) entries, `bun install` — deliberately self-contained (one package, three `package.json` touch-points, two script edits).
- **`GitStatusService`** (`node-git-status-service.ts`, `GitStatusServicePath = '/services/ai-focused-editor/git-status'`): `getStatus(rootUri)` → `{isRepository, branch, dirtyCount, ahead, behind}` for the status bar; **`initRepository(rootUri)`** → runs `git init` (no-op with a message when already a repo — the one write); `getSemanticHistory(rootUri, limit=50)` → recent commits touching semantic-domain paths (`entities/`, `knowledge/`, `manifest.yaml`, `metadata.yaml`) with per-file `{path, status(A/M/D/R), entityKind?, entityId?}`.
- **Git actions** (`git-actions-contribution.ts`): **Initialize Git Repository** (`git.initRepository`, in the product menu) calls `GitStatusService.initRepository` for the workspace root; **Add to .gitignore** (`git.addToGitignore`, navigator context menu via `UriAwareCommandHandler`/`SelectionService`) appends the selected file's workspace-relative path to `.gitignore` (creating it if absent).
- **Semantic History view** renders `getSemanticHistory` as per-commit change chips; entity chips open the file.

---

## Workspace Conventions

Sample at `examples/sample-book/`; optional directories are info-diagnosed (not errors) when absent.

```
<root>/
  manifest.yaml            # version + content[] tree (path, title, include, children) — build/nav order
  metadata.yaml            # title, language, author, cover: <image path>
  content/                 # chapter-NN.md, nested part-NN/ folders
  entities/
    characters/*.yaml      # id, name, + shared fields
    terms/*.yaml           # id, term, + shared fields
    artifacts/*.yaml       # id, name, + shared fields, + ownership[] {owner,from?,to?,note?}
    locations/*.yaml       # id, name, + shared fields
  knowledge/
    summaries/ plans/ questions/   # FR-011 generated YAML (also *.md)
  sources/
    documents/  images/    # raw source files (recursive subfolders)
    citations.yaml         # CitationEntry list
    excerpts.jsonl         # one SourceExcerpt JSON per line
  ai/
    prompts/custom-modes.yaml      # AI mode registry
    chat/<YYYY-MM-DD>.jsonl        # AI request history (written by AiHistoryService)
    context-snapshots/<YYYY-MM-DD>.jsonl   # assembled-context snapshots
  build/
    book.md  book.html  book.epub  book.pdf
  cover.png                # referenced by metadata.yaml cover:
```

`YamlSchemaValidator` (`yaml-schema-validator.ts`, Ajv) validates 6 schema kinds — `metadata`, `manifest`, and `character`/`term`/`location`/`artifact`. **Auxiliary text linting**: `NodeManuscriptWorkspaceService` runs the same `validateSemanticMarkdown` checks recursively over `sources/**/*.md` and `knowledge/**/*.md` (`validateAuxiliaryMarkdown`, source `semantic-markdown`) alongside manuscript content — supplementary materials are texts too.

**Viewers**: both apps bundle **`@theia/mini-browser` 1.73.1**, which supplies the in-app image/PDF viewer. `@theia/preview` is deliberately **not** used — it is version-stalled at 1.72 and would duplicate `@theia/core` (the same DI-breaking double-core problem as the git fork).

**AI history** (`ai-history-service.ts` + `ai-history-log.ts`): append-only JSONL under `ai/chat/` and `ai/context-snapshots/`, day-named, serialized via a write queue. `parseHistoryJsonl` returns records newest-first, capped (`DEFAULT_HISTORY_LIMIT = 100`; negative disables the cap), skipping malformed lines. Surfaced in the AI Debug Request Log.

---

## Services & RPC Map

Backend `ConnectionHandler`s are registered in `manuscript-workspace-backend-module.ts`; frontend proxies via `ServiceConnectionProvider.createProxy` (see [[frontend-backend-separation]], [[dependency-injection]]). All paths under `/services/ai-focused-editor/`.

| Service symbol | RPC path | Backend impl | Frontend impl | Responsibility |
|----------------|----------|--------------|---------------|----------------|
| `ManuscriptWorkspaceBackendService` | `…/manuscript-workspace` | `NodeManuscriptWorkspaceService` | `BrowserManuscriptWorkspaceService` | Manifest tree read + mutations; also lints content + aux `sources`/`knowledge` markdown |
| `NarrativeEntityBackendService` | `…/narrative-entity` | `NodeNarrativeEntityService` | `BrowserNarrativeEntityService` | Scan `entities/*` YAML cards: `getSnapshot`, `refresh` |
| `NarrativeGraphBackendService` | `…/narrative-graph` | `NodeNarrativeGraphService` | `BrowserNarrativeGraphService` | Timeline / ownership / co-occurrence graph (cap 20) |
| `SourceLibraryBackendService` | `…/source-library` | `NodeSourceLibraryService` | `BrowserSourceLibraryService` | Recursive `sources/` items, `citations.yaml`, `excerpts.jsonl` |
| `AiModeRegistryBackendService` | `…/ai-mode-registry` | `NodeAiModeRegistryService` | `BrowserAiModeRegistry` | Parse `ai/prompts/custom-modes.yaml` |
| `GitStatusService` | `…/git-status` | `NodeGitStatusService` | direct proxy | `getStatus`, **`initRepository`**, `getSemanticHistory` (read-only except `git init`) |
| `BookBuildService` | `…/book-build` | `NodeBookBuildService` | direct proxy | `buildMarkdown/buildHtml/buildEpub/buildPdf` (+ `NodeBookBuildTaskRunner` for terminal-task builds) |
| `LocalAiConnectionService` (+ `LocalAiStreamClient` callback) | `…/local-ai-connection` | `NodeLocalAiConnectionService` | direct proxy + `LocalAiStreamClientImpl` | Run `acp`/`cli`/`server` transports server-side; `generate`, `discoverModels`, `startStream`, `cancelStream` + streaming push |

Browser-only (no RPC): `AiConnectionService` → `BrowserAiConnectionService`; `ModelProviderRegistry` → `AiProfilePreferenceService`; `AiConnectTheiaLanguageModel` (bound as Theia `LanguageModelProvider`); `AiHistoryService`; `ManuscriptAiContextAssembler`.

---

## Test Inventory

Runner: **`bun test`** (`bun:test`); root script `"test": "bun test packages"`. **186 `test()` cases across 15 files.**

| Test file | Tests | Covers |
|-----------|:----:|--------|
| `packages/book-export/src/epub-generator.test.ts` | 7 | EPUB generation: nav tree, XHTML conversion, OPF/NCX, cover embed, ZIP structure |
| `packages/book-export/src/markdown-converter.test.ts` | 3 | Markdown→`TelegraphNode` conversion (incl. GFM strikethrough/tables/task-list glyphs) |
| `packages/book-export/src/pdf-generator.test.ts` | 6 | HTML→PDF via puppeteer (Chrome-gated `test.skipIf`) |
| `common/ai-connect-config.test.ts` | 17 | Local-proxy defaults; endpoint/model-probe URL normalization; catalog exposure; config-input build per transport; route-selector composition |
| `common/ai-failover.test.ts` | 4 | `generateWithFailover`: first success, fail-over records, aggregate error, empty chain |
| `common/ai-history-log.test.ts` | 7 | `parseHistoryJsonl`: valid/malformed/blank lines, newest-first, limit/default-100, field defaults |
| `common/author-materials.test.ts` | 16 | `buildAuthorMaterialsSections` (8-section order, counts, expand default); `isAllowedMaterialFile`/`isKnowledgeFile` (dotfile/extension rules); nested vs flat trees |
| `common/knowledge-generation.test.ts` | 22 | `slugifyChapter`; `extractJsonValue`; `coerceSummary`/`coercePlan`/`coerceQuestions` |
| `common/source-analysis.test.ts` | 24 | `coerceSourceAnalysis`; `normalizeExcerpts`/`normalizeCitations`; `buildExcerptRecords`; `dedupeCitations` |
| `node/node-book-build-service.test.ts` | 23 | `slugifyBase`/`createSlugger`/`naturalCompare`; TOC + anchors; `include:false` exclusion; GFM task-list checkboxes/tables; EPUB zip; PDF magic-header (Chrome-gated) |
| `node/node-domain-knowledge-service.test.ts` | 25 | `NodeNarrativeEntityService`; `NodeSourceLibraryService` (recursive listing, citations/excerpts, diagnostics); `NodeAiModeRegistryService` |
| `node/node-git-status-service.test.ts` | 8 | `getSemanticHistory` on a real scratch repo (`describe.skipIf(!git)`): ordering, metadata, entity kind/id, rename, limit, non-repo cases |
| `node/node-manuscript-workspace-service.test.ts` | 9 | Manifest mutations (reorder, comment-preserving rewrite, move-into-folder, rejects); build-inclusion toggle; unicode-slug chapter creation; duplicate-path diagnostics |
| `node/node-narrative-graph-service.test.ts` | 8 | `getSnapshot`: timeline/`include` propagation; appearance counts; co-occurrence weights; node ranking; ownership chains; malformed-ownership diagnostics |
| `packages/semantic-markdown/src/semantic-markdown.test.ts` | 7 | `parseSemanticMarkdown`/`renderSemanticMarkdownPreview`/`validateSemanticMarkdown`/`normalizeSemanticMarkdownTags` |

**UI flow pack** (`scripts/ui-flows`, `bun run test:ui:flows` → `run-flow-checks.sh` boots the browser app against `examples/sample-book` and drives the `playwright-flow-scenario-builder` runner over `afe-flow-pack.mjs`): **6 scenarios** — `AFE-01-SHELL-BOOT` (workbench boot), `AFE-02-MENU-NO-DUPLICATES` (single Manuscript/Knowledge/Build menu), `AFE-03-MANUSCRIPT-TREE` (tree nodes incl. excluded), `AFE-04-EDITOR-PREVIEW` (open chapter + semantic preview), `AFE-05-MODEL-CONFIG` (AI Profiles panel), `AFE-06-BUILD-MENU` (all four build entries present).

---

### Related

[[theia-ai]] · [[theia-ai-agents]] · [[language-models]] · [[prompt-fragments]] · [[context-variables]] · [[contribution-points]] · [[widgets-and-views]] · [[dependency-injection]] · [[frontend-backend-separation]] · [[preferences-system]]
