---
type: concept
slug: ai-focused-editor-feature-map
created_at: 2026-07-10T04:24:31Z
---

# AI Focused Editor — Feature Map

A complete, code-accurate map of the **AI Focused Editor**, a [Theia](https://theia-ide.org)-based writing IDE for long-form Markdown manuscripts with semantic tags, project knowledge, source-aware review, and multi-provider AI. It builds on Theia's [[contribution-points|contribution points]], [[widgets-and-views|widgets/views]], [[dependency-injection|DI]], [[frontend-backend-separation|frontend/backend separation]], [[theia-ai|Theia AI]], [[language-models|language models]], [[prompt-fragments]], and [[context-variables]].

Everything ships in one npm package: **`@ai-focused-editor/manuscript-workspace`** (`packages/manuscript-workspace`), which registers **five** Theia extension modules via `theiaExtensions` in its `package.json`:

| Module | Front/back | Purpose |
|--------|-----------|---------|
| `manuscript-workspace-frontend-module` + `manuscript-workspace-backend-module` | both | Core: tree, preview, model-config, AI debug, sources, AI stack, chat agent, tools |
| `entity-editor-frontend-module` | frontend | Form-based entity YAML editor (FR-025) |
| `knowledge-generation-frontend-module` | frontend | Chapter summaries / scene plans / author questions (FR-011) |
| `narrative-graph-frontend-module` | frontend | Narrative Map view + narrative-graph service proxy (FR-007) |
| `semantic-history-frontend-module` | frontend | Read-only semantic (git) history view (FR-017) |

Supporting packages: **`@ai-focused-editor/semantic-markdown`** (`[[kind:id|label]]` parse/validate/normalize/preview) and **`@ai-focused-editor/book-export`** (EPUB/PDF/HTML generators). The AI transport layer is the external **`@vedmalex/ai-connect`** library.

---

## Views & Layout

Widget IDs are the `static readonly ID` on each widget class; every view is toggled by a command (`toggleCommandId`) and placed in a shell area via `defaultWidgetOptions.area`.

| View (label) | Widget ID | Area | Toggle command | Icon | Renders |
|--------------|-----------|------|----------------|------|---------|
| **Manuscript** | `ai-focused-editor.manuscript-tree` | left | `ai-focused-editor.manuscriptTree.open` | `fa fa-book` | Manifest-backed file/folder tree; drag-reorder (MIME `application/x-afe-manuscript-path`); "excluded from build" badge on `buildIncluded:false` nodes |
| **Semantic Preview** | `ai-focused-editor.semantic-markdown.preview` | right | `ai-focused-editor.semanticMarkdown.preview.open` | `fa fa-eye` | Live preview of the active `.md`; `[[kind:id\|label]]` → **label** _(kind:id)_ via `renderSemanticMarkdownPreview`; tag-chip summary (≤24). **`ExtractableWidget`** — tears off to its own OS window (FR-021) |
| **Knowledge Cards** | `ai-focused-editor.entity-cards` | right | `ai-focused-editor.entities.openCards` | `fa fa-address-card` | Entity cards grouped **Characters → Artifacts → Locations → Terms**; each card: label+kind badge, id, aliases, epithets, summary, arc, collapsible speech patterns / backstory / notes, "Open YAML" |
| **Sources** | `ai-focused-editor.sources` | left | `ai-focused-editor.sources.open` | `fa fa-archive` | Three sections: **Files** (open), **Citations** (`[@cite:id]` targets), **Excerpts** (links to manuscript `targetPath`/`targetLine`). Attach/Analyze are commands, not in-widget buttons |
| **AI Model Config** | `ai-focused-editor.model-config` | right | `ai-focused-editor.modelConfig.open` | `fa fa-sliders` | Multi-profile list (drag-reorder, radio=active, clone/delete), edit form (label/provider/model/transport/account/endpoint/allowed-models/API key), buttons: Save, Verify Active, Use Local Proxy, Discover Models |
| **AI Debug** | `ai-focused-editor.ai-debug` | right | `ai-focused-editor.aiDebug.open` | `fa fa-bug` | Provider/Profile status table, Project AI Modes, Active Editor, Manuscript Context dump, and a **Request Log** (`renderRequestLog`): kind select (chat / context-snapshots), day picker, Refresh, Open JSONL; per-entry route chip + JSON |
| **Narrative Map** | `ai-focused-editor.narrative-map` | right | `ai-focused-editor.narrative.openMap` | `fa fa-project-diagram` | Timeline (artifact ownership chains + per-chapter entity chips) and a **Relations SVG graph** (ring layout, node radius ∝ appearances, edge width ∝ co-occurrence) |
| **Semantic History** | `ai-focused-editor.semantic-history` | right | `ai-focused-editor.semantic-history.open` | `fa fa-history` | Read-only git history filtered to semantic-domain commits (`getSemanticHistory`, limit 50); per-commit entity/path change chips (add/modify/delete/rename) |
| **Entity Form Editor** | factory `ai-focused-editor.entity-editor` (`FACTORY_ID`; widget id is `FACTORY_ID:<uri>`) | main | opener (priority 500) + `ai-focused-editor.entity.openFormEditor` | `fa fa-id-badge` | Structured form for entity YAML (per-file). Default opener for `entities/{characters,artifacts,locations,terms}/*.yaml`; preserves comments/unknown keys via `yaml` `parseDocument` |

**Status bar contributions** (`FrontendApplicationContribution`s):
- **AI profile** (`ai-focused-editor.ai-profile-status`, right, priority 120): `AI: <label> · provider/model` or `⚠ AI: configure`; click opens Model Config; tooltip shows failover-chain length, transport, API-key state.
- **Git** (`ai-focused-editor.git-status`, left, priority 100): `<branch> •<dirty> ↑ahead ↓behind`; polls every 15 s + debounced file-change refresh; read-only (commits stay manual).

**Focus Mode** (`ai-focused-editor.focusMode.toggle`): collapses left/right/bottom panels around the editor and restores them on toggle.

---

## Menu & Commands

The product menu lives under `MAIN_MENU_BAR` at path `['8_ai_focused_editor']`, label **Manuscript** (`ai-focused-editor-menu.ts`). All six submenus are registered **exactly once, centrally** in `ManuscriptWorkspaceMenuContribution.registerMenus` (`manuscript-workspace-contribution.ts`) to avoid duplicate menu-bar entries — individual contributions only add `registerMenuAction`s. Submenus: `2_semantic-markdown` (Semantic Markdown), `3_build` (Build), `4_knowledge` (Knowledge), `5_sources` (Sources), `6_ai-modes` (AI Modes), `7_ai-debug` (AI Debug).

Command table (id | menu placement | keybinding). Category is `AI Focused Editor` throughout; view open/refresh commands carry their label as `AI Focused Editor: …`.

| Command id | Label | Menu | Keybinding |
|------------|-------|------|-----------|
| `ai-focused-editor.focusMode.toggle` | Toggle Focus Mode | Manuscript (order 0) | `ctrlcmd+alt+f` |
| `ai-focused-editor.manuscriptTree.open` | Open Manuscript View | Manuscript (order 1) | — |
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
| `ai-focused-editor.semanticMarkdown.preview.open` / `.refresh` | Open / Refresh Semantic Markdown Preview | Manuscript | — |
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
| `ai-focused-editor.aiModes.show` | Show Project AI Modes | AI Modes | — |
| `ai-focused-editor.aiModes.copySummary` | Copy Project AI Mode Summary | AI Modes | — |
| `ai-focused-editor.aiModes.openFile` | Open Project AI Modes File | AI Modes | — |
| `ai-focused-editor.aiDebug.open` / `.refresh` | Open / Refresh AI Debug View | AI Debug | — |
| `ai-focused-editor.aiDebug.copySnapshot` | Copy AI Debug Snapshot | AI Debug | — |

Preferences are defined in `ai-focused-editor-preferences.ts` (see [[preferences-system]]), key namespace `aiFocusedEditor.ai.*`, scope Folder: `provider`, `model`, `apiKey`, `endpointUrl`, `transportKind` (`api|proxy|acp|cli|server`), `transportId`, `profileId`, plus the multi-profile keys **`profiles`** (array), **`activeProfile`** (id), **`apiKeys`** (object, per-profile, User scope). Legacy single keys apply only when `profiles` is empty.

---

## Editor Features

Semantic tag syntax (`@ai-focused-editor/semantic-markdown`): `SEMANTIC_TAG_PATTERN = /\[\[([a-z][\w-]*):([A-Za-z0-9_.:-]+)\|([^\]\n]+?)\]\]/g` — i.e. `[[kind:id|label]]`. Tag kinds: `char`, `term`, `artifact`, `location`. Registered against Monaco for `markdown`/`.md`:

- **Decorations** (`semantic-markdown-decoration-service.ts`): each tag gets CSS `afe-semantic-tag afe-semantic-tag-<kind>`; debounced 150 ms. **Hover**: `<TagLabel>: <entity.label|label> (id)` plus entity summary, `Also known as:` aliases, `Epithets:`, resolved from a 5 s-cached `NarrativeEntityService.getSnapshot()` index.
- **Completion** (`semantic-markdown-completion-provider.ts`): trigger chars `[` and `:`; `TAG_PREFIX_PATTERN = /\[\[([a-z]*)(?::([^\s|\]]*))?$/i`. Offers entity items `kind:id` (detail=label, doc=summary, snippet `kind:id|${1:label}]]`) filtered by kind- and id-prefix, plus bare kind scaffolds for `char/term/artifact/location`.
- **Outline / document symbols** (`semantic-markdown-document-symbol-provider.ts`): emits **one symbol per semantic tag** (not headings); SymbolKind map `char→Class`, `term→Key`, `artifact→Object`, `location→Namespace`.
- **Citation links** (in `source-library-view-contribution.ts`): `CITATION_LINK_PATTERN = /\[@cite:([^\]\s]+)\]/g` via a Monaco `LinkProvider`. Resolves to the citation's `path` (from `citations.yaml`), else opens `sources/citations.yaml`. Cmd/Ctrl-click navigation, no decoration.
- **Quick actions** (`semantic-markdown-actions-contribution.ts`): `wrapSelectionAs{Character,Term,Artifact}` sanitizes the selection, derives an id via `createSemanticId` (NFKD, diacritic-strip, slug, ≤48 chars), inserts `[[kind:id|label]]`. `normalizeTags` lower-cases kind, trims id, collapses label whitespace (no dedupe/sort). `copyTagSummary` copies a Markdown list of all tags with line numbers. `validateSemanticMarkdown` flags unclosed/invalid tags as diagnostics.

AI writer commands surface edits as **native Change Sets** in the chat view (Accept/Reject) plus an immediate diff — `Improve Selected Text` and `Suggest Coreference Tags` never auto-rewrite. `Check Consistency` publishes findings to the Problems view (owner `ai-focused-editor.consistency`); `Validate Manuscript Workspace` publishes schema diagnostics (owner `ai-focused-editor.workspace`).

---

## AI Stack

Bridges the app to [[theia-ai]] and [[language-models]] via `@vedmalex/ai-connect`.

**Transports** (`ai-connect-config.ts`, resolved from the ai-connect provider catalog): `api`, `acp`, `cli`, `server` (`proxy` is normalized to `api`, pointing at a local proxy `http://127.0.0.1:8045`). The boundary:
- **`api` runs directly in the browser** — `BrowserAiConnectionService` (`AiConnectionService` impl) calls `createBrowserClient(defineConfig(buildAiConnectConfigInput(profile)))` from `@vedmalex/ai-connect/browser`. Plain HTTP fetch, no RPC.
- **`acp`/`cli`/`server` route to the backend** — delegated over JSON-RPC to `LocalAiConnectionService` → `NodeLocalAiConnectionService`, which uses `createLocalClient` from `@vedmalex/ai-connect/local` (the only side able to spawn CLIs / run ACP agents / hit `server` endpoints).

**Streaming push channel**: `LocalAiConnectionServicePath` is a **duplex** RPC — the frontend registers `LocalAiStreamClientImpl` (`onLocalAiStreamEvent(streamId, event)`) as the callback client; the backend's `RpcConnectionHandler<LocalAiStreamClient>` calls back into it. `NodeLocalAiConnectionService.startStream` iterates the local client stream, `emit`s `{type:'delta'|'result'|'end'|'error'}` wire events to all connected clients; `cancelStream` aborts. `BrowserAiConnectionService.streamLocalTransport` drains those pushes into an async iterator.

**Multi-profile registry** (`ai-profile-preference-service.ts`, bound as `ModelProviderRegistry`): named `profiles` in Folder scope; `apiKeys` (per-profile) in User scope — secrets never in the profile list. `getStatus`/`getConfiguredProfile` compute `missing` fields (API key required only for `api` transport). **Failover chain** = active profile first, then remaining `enabled` profiles in list order, with incomplete profiles filtered out.

**Failover**: `generateWithFailover` (`ai-failover.ts`) tries the chain in order, returns first success (with `profileUsed`/`failedAttempts`), throws an aggregate error if all fail. The Theia AI streaming path (`AiConnectTheiaLanguageModel.streamResponseParts`) hand-rolls the same failover but retries onto the next profile only while nothing has been emitted (never restarts a half-streamed answer).

**Theia AI integration** (`ai-connect-theia-language-model.ts`): registers `AiConnectTheiaLanguageModel` (id `ai-focused-editor.ai-connect`) as a Theia `LanguageModelProvider`. Maps Theia messages/tools ↔ ai-connect; **tools** (`toClientTools`) become ai-connect `clientTools` executed in-process — effective only on `api` transport (stripped before crossing RPC). Logs each request to AI history.

**Model discovery**: `discoverModels(profile)` on both services (browser-direct for `api`, RPC for the rest) flattens `report.routes[*].availableModels` into `{modelId, name, contextLength}` — surfaced by the Model Config "Discover Models" button.

**Chat agent** (`manuscript-chat-agent-contribution.ts`): registers a `CustomAgent` id **`ai-focused-editor.manuscript`** ("Manuscript"), backed by the ai-connect language model, prompt referencing `{{manuscript}}` and the three tools. See [[theia-ai-agents]].

**Context variable** (`manuscript-context-variable-contribution.ts`): one [[context-variables|AI context variable]] `#manuscript` (id `ai-focused-editor.manuscript-context`, name `manuscript`) resolving to `ManuscriptAiContextAssembler.assemble()` — manifest tree, diagnostics, `entities/characters` + `entities/terms` summaries, and a `sources/` listing.

**Tools** (`manuscript-tools-contribution.ts`, Theia `ToolProvider`s): `manuscript_find_entities` (query/kind → matching entity cards), `manuscript_list_chapters` (manifest-order flatten with paths/inclusion), `manuscript_get_chapter` (read Markdown by path, ≤16000 chars, rejects `..`).

**Prompt fragments** ([[prompt-fragments]], `ai-mode-prompt-fragment-contribution.ts`): each project **AI mode** becomes a built-in prompt fragment `ai-focused-editor.project-mode.<id>`, exposed as chat command `afe-<id>`; re-synced on workspace/file changes.

**AI modes** shipped in `examples/sample-book/ai/prompts/custom-modes.yaml` (`version: 1`, 9 modes; each: `id`, `label`, `description`, `systemPrompt`, optional `userPrompt`, `parameters.temperature`):

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

(Command handlers also fall back to built-in prompts when a mode is absent.)

---

## Knowledge System

Project knowledge is filesystem-first YAML, scanned by backend services and surfaced in views.

- **Entities** (`entities/{characters,terms,artifacts,locations}/*.yaml`, `NarrativeEntityKind = character|term|artifact|location`). Shared optional fields: `aliases[]`, `epithets[]`, `speechPatterns[]`, `summary`, `backstory`, `arc`, `notes`. Label field is `name` (character/artifact/location) or `term` (term). **Artifacts** add `ownership[]` = `{owner, from?, to?, note?}` (chronological, story-time labels) — validated and rendered as ownership chains in Narrative Map, but only editable via raw YAML (no form field). Served by `NarrativeEntityBackendService`; edited via the **Entity Form Editor**, viewed in **Knowledge Cards**.
- **Narrative graph** (`NarrativeGraphBackendService`): builds the timeline (chapters in manifest order with per-chapter entity appearance counts), artifact ownership transfers, and a co-occurrence relation graph (nodes ranked by appearances, capped at `NARRATIVE_GRAPH_NODE_CAP = 20`). Powers **Narrative Map**.
- **Knowledge generation** (FR-011, `knowledge-generation-contribution.ts` + `knowledge-generation.ts`): AI-generated chapter `summaries/`, scene `plans/`, author `questions/` under `knowledge/`. Response coercion (`coerceSummary`/`coercePlan`/`coerceQuestions`) tolerates fenced/embedded JSON with raw-text fallback; chapter slug via `slugifyChapter` (unicode-aware).
- **AI mode registry** (`AiModeRegistryBackendService`): parses `ai/prompts/custom-modes.yaml`; dedupes by id; legacy `prompt` maps to `systemPrompt`.

---

## Sources & Citations

`SourceLibraryBackendService` scans `sources/` and drives the **Sources** view + citation links.

- `sources/documents/`, `sources/images/` — raw source files/subfolders surface as generic `SourceLibraryItem`s (file/directory).
- `sources/citations.yaml` — `CitationEntry {id, title, source?, note?, path?}` (`path` derived when `source` resolves to an in-workspace file); accepts `{citations:[…]}` or a bare array. Targets of `[@cite:id]` links.
- `sources/excerpts.jsonl` — one `SourceExcerpt {id, sourceId?, sourcePath?, text, note?, targetPath?, targetAnchor?, targetLine?}` per line; can link a source fragment back to a manuscript paragraph.
- **Attach** (`sources.attach`) copies a picked file into `sources/images/` or `sources/documents/` by extension. **Analyze** (`sources.analyze`) runs the `analyze-source` AI mode, appending extracted excerpts to `excerpts.jsonl` and merging citations into `citations.yaml` (`source-analysis.ts`: `normalizeExcerpts`/`normalizeCitations`/`buildExcerptRecords`/`dedupeCitations`).

---

## Build & Export

`BookBuildService` → `NodeBookBuildService` (`node-book-build-service.ts`) exports the manuscript. Common front end: read `metadata.yaml` (title/author/language/**cover**), walk `manifest.yaml` `content[]` (or natural-sort fallback scan of `content/**/*.md`), filter `include:false` nodes, read each chapter, run `validateSemanticMarkdown` (warnings) + fatal build diagnostics. Default outputs under `build/`:

| Format | Output | Pipeline |
|--------|--------|----------|
| Markdown | `build/book.md` | Hand-built string: front-matter, `# Title`, generated TOC (anchor slugs via `createSlugger`), chapters concatenated in build order |
| HTML | `build/book.html` | `markdown-it` render (semantic tags stripped to labels via `renderSemanticLabels`), inline `<style>`, `<nav>` TOC, per-chapter `<section>` |
| EPUB | `build/book.epub` | `EpubGenerator` (`@ai-focused-editor/book-export`): nested nav tree, Markdown→`TelegraphNode`→XHTML, `content.opf`/`toc.ncx`/`style.css`, optional **cover** embed, hand-rolled ZIP (Bun `zip` fast path) |
| PDF | `build/book.pdf` | Reuses the HTML render → `renderHtmlToPdf` (puppeteer-core, local Chrome via `findChromePath`/`CHROME_PATH`, A4/A5, print CSS) |

Only **EPUB** embeds `metadata.yaml`'s `cover:` (`.png/.jpg/.jpeg`, in-workspace). Cross-chapter links are rewritten in EPUB; links to excluded chapters degrade to plain text.

**Headless / background builds**: `BookBuildContribution` also registers a Theia `TaskContribution`. `NodeBookBuildTaskRunner` (task type `ai-focused-editor.book-build`) spawns `node book-build-task-cli.js --format <fmt> <rootUri> [outputPath]` as a Theia terminal task; `book-build-task-cli.ts` is a DI-free CLI that instantiates `NodeBookBuildService` directly, prints `[SEVERITY] uri:line:col message` diagnostics, and sets `exitCode=1` on errors.

---

## Git & History

Read-only only — the app never mutates the repo (interactive SCM waits on a platform-compatible `@theia/git`).

- **`GitStatusService`** (`node-git-status-service.ts`, shells out to `git`): `getStatus(rootUri)` → `{isRepository, branch, dirtyCount, ahead, behind}` for the status bar; `getSemanticHistory(rootUri, limit=50)` → recent commits touching semantic-domain paths (`entities/`, `knowledge/`, `manifest.yaml`, `metadata.yaml`) with per-file `{path, status(A/M/D/R), entityKind?, entityId?}`.
- **Semantic History view** renders that history as per-commit change chips; entity chips are clickable to open the file.

---

## Workspace Conventions

Sample at `examples/sample-book/`; directories are info-diagnosed (not errors) when absent.

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
    summaries/ plans/ questions/   # FR-011 generated YAML
  sources/
    documents/  images/    # raw source files
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

`YamlSchemaValidator` (`yaml-schema-validator.ts`, Ajv) validates 6 schema kinds — `metadata` (title/language required), `manifest` (version/content required, recursive entries), and `character`/`term`/`location`/`artifact` (kind-specific required + shared optional fields; artifact adds `ownership`) — emitting `WorkspaceDiagnostic`s like `manifest.yaml/content/0: must have required property 'path'`.

**AI history** (`ai-history-service.ts` + `ai-history-log.ts`): append-only JSONL under `ai/chat/` and `ai/context-snapshots/`, day-named, serialized via a write queue. `parseHistoryJsonl` returns records newest-first, capped (default 100), skipping malformed lines. Surfaced in the AI Debug Request Log.

---

## Services & RPC Map

Backend `ConnectionHandler`s are registered in `manuscript-workspace-backend-module.ts`; frontend proxies in the frontend modules via `ServiceConnectionProvider.createProxy` (see [[frontend-backend-separation]], [[dependency-injection]]). All paths under `/services/ai-focused-editor/`.

| Service symbol | RPC path | Backend impl | Frontend impl | Responsibility |
|----------------|----------|--------------|---------------|----------------|
| `ManuscriptWorkspaceBackendService` | `…/manuscript-workspace` | `NodeManuscriptWorkspaceService` | `BrowserManuscriptWorkspaceService` | Manifest tree read + mutations: `getSnapshot`, `refresh`, `moveManuscriptEntry`, `setManuscriptBuildInclusion`, `createManuscriptChapter` |
| `NarrativeEntityBackendService` | `…/narrative-entity` | `NodeNarrativeEntityService` | `BrowserNarrativeEntityService` | Scan `entities/*` YAML cards: `getSnapshot`, `refresh` |
| `NarrativeGraphBackendService` | `…/narrative-graph` | `NodeNarrativeGraphService` | `BrowserNarrativeGraphService` | Timeline / ownership / co-occurrence graph (cap 20) |
| `SourceLibraryBackendService` | `…/source-library` | `NodeSourceLibraryService` | `BrowserSourceLibraryService` | `sources/` items, `citations.yaml`, `excerpts.jsonl` |
| `AiModeRegistryBackendService` | `…/ai-mode-registry` | `NodeAiModeRegistryService` | `BrowserAiModeRegistry` | Parse `ai/prompts/custom-modes.yaml`: `getSnapshot`, `refresh`, `listModes`, `getMode` |
| `GitStatusService` | `…/git-status` | `NodeGitStatusService` | direct proxy | `getStatus`, `getSemanticHistory` (read-only) |
| `BookBuildService` | `…/book-build` | `NodeBookBuildService` | direct proxy | `buildMarkdown/buildHtml/buildEpub/buildPdf` |
| `LocalAiConnectionService` (+ `LocalAiStreamClient` callback) | `…/local-ai-connection` | `NodeLocalAiConnectionService` | direct proxy + `LocalAiStreamClientImpl` | Run `acp`/`cli`/`server` transports server-side; `generate`, `discoverModels`, `startStream`, `cancelStream` + streaming push |

Browser-only (no RPC): `AiConnectionService` → `BrowserAiConnectionService`; `ModelProviderRegistry` → `AiProfilePreferenceService`; `AiConnectTheiaLanguageModel` (bound as Theia `LanguageModelProvider`); `AiHistoryService`; `ManuscriptAiContextAssembler`.

---

## Test Inventory

Runner: **`bun test`** (`bun:test`); root script `"test": "bun test packages"`. ~136 `test()` cases across 10 files (plus `semantic-markdown.test.ts`).

| Test file | Covers |
|-----------|--------|
| `common/ai-connect-config.test.ts` | Local-proxy defaults; model-probe/endpoint URL normalization (anthropic `/messages`, gemini `:generateContent`); catalog exposure; config-input build per transport (api/proxy/acp/cli), non-catalog CLI fallback, route-selector composition |
| `common/ai-failover.test.ts` | `generateWithFailover`: first success returned; fail-over records `{profileId,error}` and uses next profile; aggregate error when all fail; empty-chain throws |
| `common/ai-history-log.test.ts` | `parseHistoryJsonl`: parse valid JSONL; skip malformed/blank lines; newest-first order; `limit` and default-100; empty → `[]`; defensive field defaults |
| `common/knowledge-generation.test.ts` | `slugifyChapter` (unicode); `extractJsonValue` (bare/fenced/embedded); `coerceSummary`/`coercePlan`/`coerceQuestions` with raw-text fallbacks |
| `common/source-analysis.test.ts` | `coerceSourceAnalysis`; `normalizeExcerpts`/`normalizeCitations`; `buildExcerptRecords` (sequential slug-prefixed ids); `countSlugOccurrences`; `dedupeCitations` (added/skipped) |
| `node/node-book-build-service.test.ts` | `slugifyBase`/`createSlugger`/`naturalCompare`; nested manifest → MD/HTML TOC + anchors; `include:false` folder exclusion; no-manifest natural-order fallback; tag-error warnings; EPUB zip (NCX navPoints, tag stripping, link rewriting, fatal-diagnostic abort, cover embed); PDF magic-header (Chrome-gated `skipIf`) |
| `node/node-domain-knowledge-service.test.ts` | `NodeNarrativeEntityService` (rich fields, all 4 dirs, malformed-YAML diagnostics); `NodeSourceLibraryService` (citations/excerpts parsing, target links, auto-ids, diagnostics); `NodeAiModeRegistryService` (parse, duplicate/missing-id warnings, legacy `prompt`) |
| `node/node-git-status-service.test.ts` | `getSemanticHistory` on a real scratch repo (`describe.skipIf(!git)`): newest-first, commit metadata, entity kind/id derivation, rename→`R`, non-entity files, `limit`, non-repo cases |
| `node/node-manuscript-workspace-service.test.ts` | Manifest mutations: reorder; comment-preserving rewrite; move into folder (relocates file); reject self/unknown/overwrite moves; build-inclusion toggle; unicode-slug chapter creation (root + nested); duplicate-path diagnostics with unique ids |
| `node/node-narrative-graph-service.test.ts` | `getSnapshot`: timeline follows nested manifest order + `include` propagation; per-chapter appearance counts + label resolution; co-occurrence edge weights; node ranking; artifact ownership chain + owner-label resolution; malformed-ownership diagnostics; missing-manifest warning |
| `packages/semantic-markdown/src/semantic-markdown.test.ts` | `parseSemanticMarkdown`/`renderSemanticMarkdownPreview`/`validateSemanticMarkdown`/`normalizeSemanticMarkdownTags` |

---

### Related

[[theia-ai]] · [[theia-ai-agents]] · [[language-models]] · [[prompt-fragments]] · [[context-variables]] · [[contribution-points]] · [[widgets-and-views]] · [[dependency-injection]] · [[frontend-backend-separation]] · [[preferences-system]]
