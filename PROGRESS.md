# AI Focused Editor Progress

Updated: 2026-07-10 (wave 10 — live validation, EPUB footnotes, PDF analysis)

This file tracks implementation progress against `spec.md`. It records verified repository state, not planned intent.

## Current Implementation Level

- Overall product vision: 18-22%.
- First Theia MVP: architecture foundation complete; user-facing writing loop functional (tree editing, semantic editing, AI actions, build/export) with known gaps listed under "In Progress".
- Current phase: Phase 2-3 (semantic editing + AI service layer), Phase 1 spike complete.
- Audit trail: multi-agent spec-compliance audit findings live in `.plan/audit-findings.json`; export reuse plan in `.plan/telegraph-publisher-reuse.md`.

## Completed

### Platform foundation
- Bun workspace root with `bun.lock`, `@types/bun`, and a root `tsconfig.json` so `bun test` emits legacy decorators for Theia/inversify code.
- Browser Theia application under `apps/browser`; Electron application under `apps/electron` (shared Theia editor/Monaco/workbench infrastructure, native module rebuild via Bun scripts, `@theia/ffmpeg` build, `electron-rebuild` C++20 patch).
- First-party extension `packages/manuscript-workspace` plus standalone parser package `packages/semantic-markdown`.
- Theia infrastructure packages wired: editor, Monaco, navigator, preferences, markers, file search, tasks/terminal, SCM surfaces (`@theia/scm`, `@theia/scm-extra` — note: no git provider package is wired yet, so SCM views are present but not functional), Theia AI chat + chat UI.
- Writer-friendly app defaults in both targets: autosave (`files.autoSave: afterDelay`), `files.exclude` for `build/`, `.llm-wiki/`, `.git/`.
- Extension stylesheet (`src/browser/style/index.css`) covers all custom widgets and semantic tag decorations; no imperative `document.head` style injection remains.

### Product menu, commands, UX shell
- Top-level product menu **Manuscript** registered under `MAIN_MENU_BAR` (shared `AiFocusedEditorMenus` paths; the previous detached `['ai-focused-editor']` root never rendered). **The whole submenu tree is registered exactly once** in `ManuscriptWorkspaceMenuContribution` — repeated `registerSubmenu` calls for the same path create duplicate menu-bar entries in the current Theia menu model (this bug shipped briefly as 5× "Manuscript"); all other contributions only add `registerMenuAction`s. Guarded by the AFE-02 UI flow scenario.
- All product commands use `category: 'AI Focused Editor'` with human labels.
- Keybindings: Improve Selected (`ctrlcmd+alt+i`), Validate Workspace (`ctrlcmd+alt+v`), Toggle Focus Mode (`ctrlcmd+alt+f`).
- **Focus Mode** command collapses/restores left/right/bottom panels around the editor (spec §2 Primary Workbench Modes).
- Writer-first default layout: manuscript tree view opens on fresh layout initialization.

### Manuscript workspace and tree (FR-003, FR-004)
- Backend `NodeManuscriptWorkspaceService` (JSON-RPC) scans the workspace, maps `manifest.yaml` order to the service snapshot, validates YAML schemas and semantic Markdown off the UI thread.
- **Manifest write path**: `moveManuscriptEntry` (reorder within/between folder entries, physical file relocation on parent change, conflict-safe: refuses overwrite), `setManuscriptBuildInclusion` (`include: false` round-trip), `createManuscriptChapter` (unicode-aware slug filenames, `# Title` seed content). Manifest edits go through the YAML document API, preserving comments/formatting of untouched entries.
- Manuscript tree widget: **drag & drop** (drop on folder = append inside, drop on file = insert before, drop on empty = append to root; visual drop-target highlight), context menu commands (New Chapter, Move Up/Down, Include/Exclude in Book Build, Refresh), excluded nodes render dimmed with an "excluded from build" detail.
- Tree auto-refreshes (debounced) on `manifest.yaml`/`content/` file change events.
- Duplicate manifest paths produce a workspace warning diagnostic and unique tree-node ids (no silent node collisions).
- Manuscript tree nodes open files through Theia `OpenerService`.
- Sample workspace `examples/sample-book` exercises nested parts (`content/part-01/`), an `include: false` draft, semantic tags in all chapters, character/term/artifact usage.

### Semantic Markdown (FR-005, FR-018)
- Parser package with LSP-compatible ranges, diagnostics for malformed/unclosed tags, normalization; covered by bun tests.
- Editor decorations with per-kind styling and hover text; decoration re-parse is **debounced** (150ms) instead of running on every keystroke.
- **Semantic tag autocompletion** (`[[` / `[[kind:` triggers): suggests entities from the YAML knowledge base with label snippets, plus bare-kind scaffolds (char/term/artifact/location).
- Semantic Markdown preview widget (Theia `MarkdownRenderer`), tag chip summary, live refresh from the active editor; **extractable to a secondary window** (FR-021) via the standard Theia control on the view.
- Quick actions (wrap selection as char/term/artifact, copy tag summary, normalize tags) in the product menu and editor context menu.
- `DocumentSymbolProvider` populates Theia Outline with semantic tags.
- Workspace validation publishes manifest/entity/semantic diagnostics to Problems/markers with source ranges (runs in backend).

### AI integration (FR-008, FR-009, FR-012, FR-013)
- `@vedmalex/ai-connect` service boundary: browser-safe `api` transport via `createBrowserClient`; backend adapter for `acp`/`cli`/`server` transports via JSON-RPC + `createLocalClient`; shared config builder in `common/ai-connect-config.ts` (v1 `aiConnect.js` parity, incl. `getLocalProxyEndpointDefaults` for 127.0.0.1:8045 and `getAiConnectEndpointModelProbeUrl`).
- **Model discovery** through the service boundary (`discoverModels` on both browser and backend clients).
- AI Model Config view: provider **catalog dropdown** (from `listTextProviderCatalog`) with custom-provider fallback, transport dropdown per provider, "Use Local Proxy" defaults button, "Discover Models" button with click-to-use model list and model datalist.
- API key handling: required only for the `api` transport (acp/cli/server authorize через OAuth/CLI, как в v1); keys are saved to **User scope** so they never land in workspace files; existing keys are never echoed back into the form.
- **Multi-profile registry (FR-013 full)**: named profiles ("aliases") in `aiFocusedEditor.ai.profiles` (workspace scope, no secrets), active-profile selection, ordered **failover chain** (active first, then enabled profiles in list order), per-profile `allowedModels` shortlist fed into the ai-connect account config, per-profile API keys in a user-scope map. Legacy single-profile keys keep working and migrate on first save. `ModelProviderRegistry` symbol is bound to the implementation.
- **Failover in action**: chat requests (Theia `LanguageModel`) retry the next profile in the chain when a profile fails before emitting any output; `Improve Selected` and `Check Manuscript Consistency` run through `generateWithFailover` with an aggregate error when every profile fails (covered by bun tests).
- **Streaming on every transport**: api-transport profiles stream in-browser; acp/cli/server profiles stream through a backend JSON-RPC push channel (`startStream`/`cancelStream` + client callbacks keyed by streamId) with cancellation propagated to the backend AbortController.
- **Tools / Function Calling (spec §3.5)**: Theia AI `ToolRequest`s map to ai-connect `clientTools` — the ai-connect client runs the tool loop and invokes Theia tool handlers in-process (api transport; tools are stripped before crossing the RPC boundary since functions cannot serialize).
- **Manuscript agent tools**: `manuscript_find_entities`, `manuscript_list_chapters`, `manuscript_get_chapter` registered as `ToolProvider`s and referenced from the agent prompt (`~{tool_id}`), so the chat agent inspects the project instead of guessing.
- **FR-010 — coreference suggestions**: `Suggest Coreference Tags` (main + editor context menu) sends the entity roster (ids, labels, aliases, epithets) with the chapter, receives a fully tagged document, and delivers it as a **Change Set** diff for accept/reject; deviation guard discards responses that shrink/grow the text too much; `coreference-tags` project AI mode in the sample.
- Model Config view manages profiles: list with active-profile radio, **drag-and-drop reordering** (FR-020) plus ↑/↓ buttons for the failover order, clone/delete/new, label + allowed-models fields, discovery results with one-click "use" and "+allow"; the status bar shows the active profile label and chain size.
- `AiConnectTheiaLanguageModel` registered through `LanguageModelProvider`; `Manuscript` chat agent via `CustomAgentFactory`; `#manuscript` context variable via `AIVariableContribution`; project AI modes sync to Theia `PromptService` as prompt fragments/slash commands.
- **Improve Selected**: creates a Change Set file element, attaches it to the active chat session's **native Change Set review UI** (Accept/Reject in the chat view), opens the diff preview, and is available from the editor context menu.
- **Check Manuscript Consistency**: real AI-backed check — assembles manuscript context, requests structured JSON findings (project AI mode `consistency-check` when present), publishes them to Problems/markers per file with its own marker owner.
- AI Debug view (provider/transport/modes/selection/context inspection) and copy-context command.
- **FR-014 deep — Request Log browser** in AI Debug: day/kind selectors over the append-only JSONL history (`ai/chat/`, `ai/context-snapshots/`), entries newest-first with kind badges + provider/model, expandable pretty-printed payloads, per-entry Copy, Open JSONL; defensive pure JSONL parser with tests.
- **Source document AI analysis (§5.4)**: `Analyze Source Document...` picks a text source under `sources/`, extracts excerpts + citation candidates through the failover chain (project mode `analyze-source` or strict-JSON fallback), appends excerpts to `sources/excerpts.jsonl` (id continuation per file slug) and merges citations into `citations.yaml` (comment-preserving, id dedupe with skip report), refreshes the view, logs history.
- Append-only JSONL history under `ai/chat/` and `ai/context-snapshots/`; appends are serialized through a queue to avoid interleaved read-modify-write within the session.

### Knowledge and sources (FR-006, FR-025, FR-015 thin)
- **Rich entity model**: characters/terms plus first-class **artifacts and locations** (`entities/artifacts/`, `entities/locations/`), with `epithets`, `backstory`, `arc`, `speechPatterns`, `notes` fields, YAML schemas for all four kinds, richer Knowledge Cards rendering (collapsible backstory/speech/notes), enriched sample entities (Krishna/Arjuna cards, Gandiva, Kurukshetra).
- Entity knowledge flows into the editor: tag hovers show summary/aliases/epithets; `[[` autocompletion offers all four entity kinds with distinct icons.
- **Form-based entity editor (FR-025)**: entity YAML files open in a React form editor by default (id, label, aliases, epithets, summary, backstory, arc, speech patterns, notes) that rewrites only its own keys via the YAML document API — comments and unknown keys survive; inline schema validation; raw YAML stays reachable via "Open With..." and an explicit command. Shipped as a second `theiaExtensions` frontend module.
- **FR-015 deep — sources**: `sources/excerpts.jsonl` is indexed (defensive per-line parsing with warning diagnostics); the Sources view groups Files/Citations/Excerpts with counts; citations carrying a resolvable `path` and excerpts with `targetPath`/`targetLine` are clickable and reveal the exact line; `[@cite:id]` references in chapters are editor links to the cited source; `Attach Source File...` copies a picked file into `sources/documents|images/`.
- **FR-007 — Narrative Map view**: chapter timeline (entity chips × counts per chapter in manifest order, excluded chapters dimmed), artifact ownership chains (`ownership:` list in artifact YAML with schema validation, e.g. varuna → agni → arjuna), and a dependency-free SVG relations graph (co-occurrence edges weighted by shared chapters, top-20 cap with truncation note).
- Entity/source/ai-mode YAML parsing runs in the **backend** (`node-domain-knowledge-service.ts` behind three JSON-RPC services); browser services are thin RPC delegates with identical snapshot/diagnostic shapes (spec §9 backend-offload rule).
- **FR-011 — summaries, plans, author questions**: `Summarize Current Chapter`, `Generate Scene Plan for Current Chapter`, `Generate Author Questions for Current Chapter` (Knowledge submenu) run through the AI failover chain with strict-JSON prompts (project AI modes `summarize-chapter`/`plan-scenes`/`author-questions` or builtin fallbacks), write provenance-carrying YAML to `knowledge/summaries|plans|questions/<slug>.yaml`, open the result, and log history. Tolerant JSON coercion (fenced/prose-wrapped JSON accepted; unparseable → `raw:` + warning) is a pure tested helper.

### Build and export (FR-016 slice)
- Backend `BookBuildService` (JSON-RPC): manifest-driven Markdown, HTML, and **EPUB** export (`build/book.md` / `build/book.html` / `build/book.epub`), metadata title page, TOC, `include: false` gating, diagnostics gate for fatal errors.
- **`packages/book-export`**: self-contained EPUB 3 core extracted from the owner's `telegraph-publisher` library (EpubGenerator with nested NCX TOC, markdown AST converter, AnchorGenerator, dependency-free ZIP writer with Node fallback; provenance headers in extracted files). Anchor convention unified: `slugifyBase`/`createSlugger` live in `book-export` and drive Markdown/HTML/EPUB anchors identically (Cyrillic-safe). Nested manifest folders become nested NCX navPoints; semantic tags are stripped to labels before conversion.
- **Cross-chapter links in EPUB**: local `.md` links resolve to `chapter-N.html#slug` anchors (shared slug convention); links to excluded/unknown files degrade to plain text (no dead hrefs); external/mailto/data links untouched. **Cover image** via `cover:` in metadata.yaml (manifest `cover-image` property, cover page first in spine, EPUB2 meta; missing cover → non-blocking warning). CLI reports EPUB size in bytes.
- **PDF export**: `build/book.pdf` renders the canonical `book.html` through puppeteer-core + a system Chrome/Chromium (probed paths + `CHROME_PATH` override; single clear diagnostic when absent, no stack traces). a4/a5 page presets with book print CSS. `Build Manuscript PDF` command, Build menu entry, task-provider entry, CLI `--format pdf`. puppeteer-core is lazy-required so the backend bundle stays clean; known note: direct RPC `buildPdf` in a packaged app depends on puppeteer-core resolvability (the shipped task/CLI path resolves it correctly).
- `Build Manuscript EPUB` command, Build menu entry, task-provider entry, and CLI `--format epub`.
- **Unicode-aware anchors** (`slugifyBase`/`createSlugger`: Cyrillic/CJK preserved, dedupe `-2/-3`), **nested part hierarchy** in both outputs (folder headings, indented Markdown TOC, nested HTML TOC/sections), semantic-Markdown syntax warnings included in build diagnostics (non-blocking), natural numeric ordering for the no-manifest fallback scan.
- Theia Task integration: contributed task type, frontend `TaskProvider` (Markdown is the single default build task), backend task runner, compiled Node CLI that prints real per-file diagnostics on failure; task lifecycle mirrored to the Output channel.
- Build commands: Build Manuscript Markdown/HTML, Open Last Build, Copy Last Build Path.

### Tests and verification
- Test suites (153 tests): semantic-markdown parser; knowledge-generation JSON coercion + unicode slugs; PDF generator (chrome discovery, diagnostic message, real render when Chrome present); narrative graph (timeline order, co-occurrence, ownership incl. malformed → diagnostic); semantic history (git log parsing, renames, entity derivation, limits); source excerpts (valid/malformed/missing); AI history JSONL parsing (ordering, limits, malformed lines); source-analysis coercion (fenced JSON, id continuation, citation dedupe); `ai-connect-config`; **`ai-failover`** (success/failover/aggregate error/empty chain); book-build (unicode slugs, nested TOC, include gating, numeric ordering, semantic diagnostics, EPUB pipeline incl. NCX nesting, tag stripping, link rewriting, cover); EPUB generator (zip structure both strategies, nested NCX, unicode anchors, link classification); manuscript manifest mutations; domain-knowledge backend services (entity/citation/ai-mode parsing incl. rich fields and artifact/location kinds).
- `bun run test` / `bun run verify` (tests + browser build + electron build) and `bun run test:ui` (Playwright browser smoke: workbench boot, command registration, view refresh, validation notification) — all passing as of this update.
- **UI flow pack** (`bun run test:ui:flows`, playwright-cli via the flow-scenario-builder collector): `scripts/ui-flows/afe-flow-pack.mjs` — 6 scenarios (shell boot; menu integrity incl. no duplicate Manuscript/Knowledge/Build entries; manuscript tree contents; open chapter + semantic preview; Model Config view; Build menu entries), artifacts (screenshots, assert.json, report.md) in `output/playwright/flow-scenarios/`. 6/6 passing. Interactions use pointer events (Lumino 2).
- Verified in this update:
  - `bun test packages` (153 pass)
  - `bun run verify` (tests + browser/node/electron builds, 0 errors)
  - `bun run test:ui` (Playwright browser smoke)
  - CLI smoke: `--format epub` → valid `build/book.epub` with cover and rewritten cross-chapter links (`unzip -t` clean); `--format pdf` → valid `%PDF-1.4` (150 KB) via system Chrome

### Knowledge base
- Project llm-wiki at `.llm-wiki/` with official Theia Platform docs (8 sources: composing apps, authoring extensions, Theia AI, services/contributions, architecture, extensions vs plugins, preferences, platform overview) and 10 cross-source concept pages mapped to this codebase.
- **Application feature map** at `.llm-wiki/pages/ai-focused-editor-feature-map.md`: code-verified reference of all 42 commands (menus/keybindings), 9 widgets, the menu tree, 8 JSON-RPC service pairs, AI stack, workspace conventions, export pipelines, and the test inventory.

### Git indicator and semantic history
- **Git status-bar indicator**: read-only branch + dirty count + ahead/behind, refreshed on file events (debounced) and a 15s poll, via a backend `GitStatusService` (execFile `git`, no repo mutations — commits stay manual per spec §5.6). Note: `@theia/git` is version-stalled at 1.60.x and incompatible with platform 1.73, so the interactive SCM provider remains deferred until upstream catches up.
- **FR-017 — Semantic History view**: recent commits touching `entities/`, `knowledge/`, `manifest.yaml`, `metadata.yaml` (single `git log --name-status --find-renames` call, defensive parsing, rename-aware) rendered as commit rows with per-entity change chips (`kind:id`, add/modify/delete/rename accents; clicking opens the current entity file). Knowledge submenu entry; empty states for non-repo/no-history.

## In Progress / Known Gaps

- **LanguageModel**: `response_format`/reasoning parts still unmapped; tool calls run inside the ai-connect loop rather than surfacing as Theia tool-call UI parts.
- **Context assembler**: `ManuscriptAiContextAssembler` still assembles context in the frontend (entity/source/ai-mode parsing itself now runs in the backend); moving assembly server-side is optional polish.
- **History durability**: JSONL append is session-serialized but still a frontend read-modify-write; a backend atomic append is the target.
- **SCM**: `@theia/scm` surfaces are wired without a git provider; status-bar git indicator absent.
- **[Review]** Whether backend workspace diagnostics should become a dedicated LSP for incremental validation.

## Not Implemented Yet

- Interactive git SCM provider (blocked on upstream `@theia/git` catching up with the platform 1.73).
- PDF analysis of attached sources (the §5.4 analyzer handles text-like documents; PDFs need an extraction step first).
- LSP extraction of workspace diagnostics (current backend-RPC validation is functionally equivalent; an LSP would add incremental validation — still a [Review] item).

## Feature Request Matrix coverage

All MVP-Core/MVP-Thin requests shipped; post-MVP and backlog requests implemented: FR-001–018, FR-020, FR-021, FR-023, FR-025 (+ EPUB/PDF export beyond the matrix). FR-019 is covered in substance (settings widget, clone/cancel flows, stable ordering) without a dedicated modal-UX pass. FR-017's interactive-SCM half waits on upstream `@theia/git`; FR-024 is provenance-only.

## Wave 7 — Writer UX (owner intake 2026-07-10, shipped)

- **Unified author navigation**: the Manuscript tree now holds eight sections — Manuscript (manifest, DnD kept), Characters, Terms, Artifacts, Locations, Citations, Sources, Knowledge — with live counts, kind icons, and correct openers (entity form editor, citations form, files); auto-refresh watches entities/sources/knowledge too.
- **Markdown editor & GFM**: the app shipped NO markdown grammar — a Monarch tokenizer now highlights .md (embedded-language switching deliberately stripped: unregistered languages made the tokenizer throw); markdown-it renders tables/strikethrough out of the box, task lists added everywhere (real checkboxes in HTML/PDF export, ☐/☑ glyphs in preview/EPUB); `aiFocusedEditor.preview.showTagChips` toggles the chip row for plain-markdown reading; GFM showcase in the sample book.
- **Citations workflow**: `Save Selection as Citation...` (editor context menu + Sources menu) stores an excerpt (`sources/excerpts.jsonl`, back-reference with exact line) and a citation (`citations.yaml`, comment-preserving, id dedupe); citations form editor is the default opener for citations.yaml; Copy buttons on citation/excerpt rows.
- **Chat mentions beyond `#manuscript`** (the manuscript.md-era single variable): `#chapter[:path]`, `#entity:id`, `#entities`, `#sources`, `#outline` context variables shape the AI context precisely.
- **Full provenance log**: chat history records now include the outgoing messages (bounded), attached tool names, and the response text; inspect via AI Debug → Request Log or `ai/chat/*.jsonl`.
- **Outline for writers**: the Outline view shows the chapter's heading hierarchy (fence-aware) with each section's unique entities nested beneath; `Manuscript → Chapter Outline` opens it.
- **Supplementary texts are linted**: semantic/Markdown validation covers `sources/**/*.md` and `knowledge/**/*.md`; entity YAML validated by schemas.
- **Layout reset**: `Manuscript → Reset Workbench Layout (This Folder)` — per-folder layout restoration is why a stale folder could hide the AI Chat icon.
- **Interactive git via local fork**: `packages/theia-git-fork` (`@ai-focused-editor/git`) — @theia/git@1.60.2 sources rebuilt against platform 1.73 (preference/toolbar/scm API drift fixed, in-process repository locator, native `find-git-repositories` compiled by an idempotent build step, octicon inlined). SCM view, changes, stage/commit, branches work with system git from PATH. FORK.md documents provenance (EPL-2.0/GPL-2.0 w/ CPE) and the exact steps to DROP the fork when upstream catches up. Caveat: electron target not yet exercised with the fork's native addon.

## Wave 7.1–8 — Owner feedback and forms (shipped)

- **Allowed material types only**: navigator and source listings filter to documents/images/structural yaml-json (`isAllowedMaterialFile`); dotfiles excluded; `sources/` listing is recursive and both Sources/Knowledge sections keep nested folder structure; codicon icon theme with per-kind accent colors.
- **Git setup actions**: `Initialize Git Repository` (Manuscript menu; no-op with message when already a repo) and `Add to .gitignore` (file navigator context menu; creates/dedupes).
- **Viewers**: `@theia/mini-browser` opens images/PDF in both targets (`@theia/preview` deliberately skipped — version-stalled at 1.72, would duplicate `@theia/core`); the live Markdown preview gained an **open-preview toolbar button** on every `.md` editor tab.
- **AI Review Current Chapter**: routed through the Theia AI chat pipeline (`ChatService.sendRequest` + `#chapter #entities`), streaming into the chat view with agent tool access.
- **Form editors for book config**: `Edit Book Metadata...` (title/author/language/cover + free scalar keys) and `Edit Manifest...` (titles + include flags; ordering stays with the navigator tree) — default openers for the root `metadata.yaml`/`manifest.yaml`, comment-preserving yaml writes, raw YAML via Open With.
- **Footnotes**: `Insert Footnote` command (auto-numbered `[^N]` + definition scaffold, caret jump), bidirectional `[^N]` ⇄ definition links in the editor, superscript+Notes rendering in preview and HTML export (EPUB/markdown keep the GFM source — documented limitation).
- **Entity mention links**: `[[kind:id|label]]`/`[[id]]` inside card text fields are clickable in Knowledge Cards and shown as "Mentions" chips in the entity form editor.
- **Chat mentions & provenance & outline** (wave 7 finale): `#chapter/#entity/#entities/#sources/#outline` variables; history records carry bounded messages/tools/response; Outline shows heading hierarchy with per-section entities.
- Tests: 221 across 18 files; feature map in `.llm-wiki` refreshed (55 commands, 6 modules).

## Wave 9 — Connection model & author AI (owner intake, shipped)

- **Endpoints + aliases (v1 parity, deeper)**: `aiFocusedEditor.ai.endpoints` (channels: provider/transport/URL/command/env + **timeWindows** availability like `1-5 09:00-18:00`, overnight ranges supported, malformed → fail-open with warning) and `aiFocusedEditor.ai.aliases` (chains of `endpoint → model` legs, exactly the v1 `chain` semantics). `activeAlias` is the user default (v1 never shipped one). Resolution ladder: aliases → profiles → legacy keys, unchanged consumer APIs; unavailable/disabled endpoints are skipped with reasons surfaced.
- **Live rotation**: `Switch AI Alias...` and `Switch AI Endpoint...` QuickPicks (availability badges); picking an endpoint pins it (`pinnedEndpoint`) and reorders chains to prefer it; status bar shows `alias · endpoint` with a pin marker.
- **Verify-on-configure**: the endpoint edit form test-connects the DRAFT (no save/activation needed); saving a new endpoint auto-verifies non-blocking.
- **v1 JSON import**: `Import ai-editor v1 Settings...` reads `rag-endpoints.json`/`rag-aliases.json` with exact field fallbacks (`apiKey|token`, `url|endpoint`, `provider||'openai'`); keys land in the user-scope map.
- **Author-defined prompts & agents**: `custom-modes.yaml` gains `context: selection|word|chapter|chat`, `menu`, `apply: replace|insert|chat`, `agent`, `icon`. `menu:true` modes appear as dynamic entries in an "AI Modes" editor context submenu with context-aware enablement (selection/word-under-cursor/chapter); replace/insert deliver Change Set diffs; chat modes route via ChatService (prefixed `@agent` when applicable). `agent:true` modes register as chat @agents with hot re-registration on yaml edits (add/edit/remove — no reload). Sample gains `rewrite-dialogue` and `lore-keeper`.
- Tests: 277 across 21 files (time windows, alias resolution incl. v1 parity, mode field parsing, word-at-offset).

## Wave 10 — Live validation, EPUB footnotes, PDF analysis (shipped)

- **Live incremental validation** (the practical value of the LSP item): the active document lints as the author types (400ms debounce, unsaved buffer) — semantic Markdown, entity YAML schemas, manifest/metadata; markers under a dedicated `ai-focused-editor.live` owner; gated by `aiFocusedEditor.validation.live` (default on). The manual whole-workspace command stays complementary.
- **EPUB footnotes**: `[^N]` references render as sup anchors with per-chapter unique ids and an end-of-chapter Notes section with back-links (sentinel-through-AST technique; generic `transformNodes` hook added to EpubGenerator so book-export stays footnote-agnostic).
- **PDF source analysis**: `Analyze Source Document...` now accepts PDFs — backend `extractSourceText` extracts text via lazy-required `unpdf` (zero hard deps, stays out of the esbuild bundle), with graceful failure paths; feeds the existing 24k-capped AI flow.
- Feature map in `.llm-wiki` refreshed for waves 9–10 (9 modules, 57 commands, connection-model + dynamic-modes sections).
- Tests: 297 across 20 files.

## Wave 10.1 — Electron exercised (shipped)

- **Electron runtime smoke** (`bun run test:electron`, Playwright Electron driver): workbench render, manuscript tree, no native-module/DI console errors — the git fork runs clean on the Electron target; soft git status-bar branch check. Conflicting `find-git-repositories@0.2.2` app dep removed (the fork brings its own 0.1.x).
- Unified scripts: `build:all` (packages + browser + electron), `verify:full` (verify + browser smoke + electron smoke).

## Wave 11 — Visual polish (shipped)

- **Writer Icons file icon theme** (`afe-writer-icons`, the app default on both targets): codicon-based icons with `afe-ico-*` accent colours for manuscript sections, materials, and file types; LabelProvider active only while the theme is selected.
- **Five bundled MIT color themes** registered via `MonacoThemingService.registerParsedTheme` (JSON vendored under `src/browser/themes/`, copied to `lib/` at build time).
- **Manifest editor drag-and-drop** reordering routed through the same `moveEntry` backend mutation as the tree — both surfaces stay in sync.
- **Pure-JS git repository locator** in the fork: the `find-git-repositories` native addon flipped ABIs between browser/electron rebuilds; replaced with a depth-6 `.git`-folder walk matching the native contract.

## Wave 12 — Click navigation, AI modes editor, UX fixes (shipped)

- **Clickable navigation in the editor**: semantic tags `[[kind:id|label]]` / `[[id]]` open the entity card (form editor wins via priority 500); relative markdown links `[text](chapter.md#anchor)` open the file and reveal the matching ATX heading by slug. One Monaco link provider coexisting with the cite/footnote providers; workspace-escape guard; only the `[[kind:id` portion is linkified so labels stay editable.
- **AI modes form editor** for `ai/prompts/custom-modes.yaml`: expandable mode cards (id/label/description/context/apply/menu/agent/icon/prompts/temperature/maxTokens), validation (duplicate ids, missing systemPrompt, invalid apply/context combos), comment-preserving yaml patches that omit default values; `Edit AI Modes...` command seeds the file when missing; opens as the default editor (priority 500), raw YAML via Open With. Saves hot-apply through the existing dynamic-mode watcher.
- **Manuscript tree icons fixed**: the base `TreeWidget.renderIcon` returns `null`, so LabelProvider icons never rendered — added a `renderIcon` override (FileTreeWidget pattern) + codicon sizing CSS. Flow AFE-03 now asserts ≥5 rendered codicons in the tree.
- **Duplicate git indicator removed**: our read-only status-bar contribution retired in favour of the fork's richer SCM status bar (Semantic History, Initialize Git Repository, Add to .gitignore untouched).
- Tests: 357 across 22 files; `verify:full` green (browser + electron smokes, 6/6 UI flows).

## Wave 13 — Artifact creation everywhere (shipped)

- **Per-section create commands in the manuscript navigator**: right-clicking a section (or its items) offers exactly its own artifact — `New Character/Term/Artifact/Location...` (name prompt → YAML card → the form editor opens), `New Citation...` (comment-preserving append into `sources/citations.yaml`), `New Knowledge Note...` (category quick-pick), `Add Source File...` (multi-select file dialog copying into `sources/`). All are also discoverable from the Manuscript menu; `New Chapter...` no longer leaks into non-manuscript sections.
- **Create entities from text**: editor selection context menu gains `Save Selection as New Character/Term/Artifact/Location...` — name prefilled from the selection, long selections become the card summary, short single-line selections are wrapped as the semantic tag with the new id; the card opens in the form editor. Missing `Wrap Selection as Location Tag` added (decorations/completion already knew the kind).
- **Shared id contract** in `common/entity-creation.ts`: one slug/hash generator for tag ids and file names (mirrors the semantic-tag id algorithm), yaml scaffolds, unique-path suffixing, selection→name/summary heuristics; 28 tests.
- Flow AFE-07 guards the section context menus (right-click via pointer events; asserts `New Character...`/`New Location...` present and `New Chapter...` absent); `closeMenus` hardened to actually dismiss Lumino context menus.
- Tests: 410 across 24 files; `verify:full` green (browser + electron smokes, 7/7 UI flows).
- **Follow-up (context keys)**: section gating moved from command `isVisible` (which the menu bar honors too) to `when` clauses on the context-menu actions, driven by the `afeManuscriptSection` context key tracking tree selection — the menu bar never hides create commands / `New Chapter...` regardless of tree selection; flow AFE-08 guards it.

## Wave 14 — Excerpts form editor (shipped)

- **Excerpts form editor** for `sources/excerpts.jsonl` (the excerpt store behind Save Selection as Citation / source analysis): expandable cards with id, text, citation link (select fed by `citations.yaml` ids), ref, note, source path, and the manuscript back-link (targetPath/targetAnchor/targetLine). Opens as the default editor (priority 500, raw JSONL via Open With); `Edit Excerpts...` command next to `Edit Citations...` seeds the file when missing.
- **Data safety**: unparsable JSONL lines are preserved verbatim (rendered as a warning block), unknown record keys survive round-trips, empty fields are omitted on save; validation flags empty/duplicate ids, empty text, and broken line targets. Pure helpers in `common/excerpt-forms.ts` (23 tests incl. a byte-for-byte round-trip of the sample book file).
- **Electron smoke de-flaked**: the stale-instance sweep now waits until the old process is really gone (pgrep poll, up to 5s) and the launch retries once — the single-instance lock race killed the first window when the smoke ran right after other Playwright/Theia activity.
- Tests: 433 across 25 files; `verify:full` green (browser + electron smokes, 8/8 UI flows).

## Wave 15 — Book at hand: properties, publish wizard (shipped)

- **Book properties from the manuscript view**: `Edit Book Metadata...`/`Edit Manifest...` in the tree context menu (manuscript scope) + a Book Properties toolbar button on the view title bar.
- **`Build Book...` publish wizard**: two-step QuickInput flow (multi-select formats EPUB/PDF/HTML/Markdown with output paths → confirm step showing the book title/author with Back), sequential builds through the BookBuildService RPC with per-format progress; failures don't stop remaining formats; completion notification offers `Open <format>` / `Copy Paths`. Rocket toolbar button; first item of the Build menu and the tree `2_book` context group; AFE-06 guards the menu entry.
- **`common/book-scaffold.ts`**: the canonical workspace structure as data — 19 required/recommended entries with yaml seeds compatible with the form editors, `NewBookOptions` threading title/author/language into manifest/metadata/chapter seeds (34 tests).

## Wave 16 — Doctor, welcome page, toolbar (shipped)

- **Book Doctor** (`Book Doctor...`, pulse toolbar button, menu + tree context entries): checks the scaffold against disk, manifest entries pointing at missing chapter files (fixable — seeded creation), content files absent from the manifest (informational), blank metadata title/author, citations.yaml/excerpts.jsonl parse errors. Multi-select fix picker (fixables preselected, findings shown as an informational section); creates parents-first, never deletes or overwrites. Pure check assembly in `common/book-doctor.ts` (19 tests).
- **Welcome start page**: auto-opens when no files are open (once per session, `aiFocusedEditor.welcome.showOnStartup` preference, default on; `Welcome` command/menu entry any time). Start actions (Create New Book / Open Folder / Book Doctor), recent workspaces, footer checkbox bound to the preference.
- **`New Book...` wizard**: title → author → language (ru/en/other) → parent folder + validated folder name (slug prefill) → creates the full scaffold via `book-scaffold` and opens the new workspace.
- **Manuscript view toolbar** now: New Chapter (+), Refresh, Build Book (rocket), Book Properties (book), Book Doctor (pulse).
- Flow AFE-09 guards the Manuscript menu entries and toolbar icons; suite: 486 tests across 27 files; `verify:full` green (browser + electron smokes, 9/9 UI flows).

## Wave 17 — Images in the preview (shipped)

- **Relative images render in the Semantic Preview**: targets resolve against the document dir (workspace-escape guard shared with link navigation), files inline as `data:` URIs with an mtime-keyed cache and 10MB/40MB caps; async swap-in guarded by a generation token (no flicker loops). Root-cause note: DOMPurify was never the blocker — markdown-it's `validateLink` whitelists only raster `data:image/*`, so raster goes through the string pipeline while SVG uses a sentinel + post-render DOM patch. Pure helpers in `common/preview-images.ts` (33 tests); sample chapter shows the cover; AFE-04 asserts a real `data:image/` img in the preview.

## Wave 18 — MVP cleanup: no legacy AI profiles, Cyrillic slugs (shipped)

- **Legacy single-profile AI mode removed** (owner: «мы на MVP, легаси нет»): the flat `aiFocusedEditor.ai.*` keys (provider/model/transport/profileId/endpointUrl/apiKey) are gone along with the synthetic `default` profile and the `Legacy AI Profiles` section. Empty profiles now mean an explicit not-configured state: status bar shows `AI: not configured` (click opens Model Config), the widget offers a friendly empty state. The v1 endpoints/aliases JSON import stays — that compatibility is a feature, not legacy.
- **Cyrillic transliteration in the canonical slug generator** (`createSemanticEntityId`): «проверка» → `proverka`, «Война и мир» → `voina-i-mir` for entity files, knowledge notes, citation ids, semantic tags and new-book folder names; hash fallback remains for uncovered scripts (CJK). Heading anchors intentionally untouched (their generator keeps Cyrillic, existing `#глава-1` links keep matching).
- Electron smoke: launch retries with main-process output capture + backoff; `verify:full` runs the electron smoke before the Playwright browser chain (back-to-back launches after a heavy Playwright run were the observed flake).
- Tests: 533 across 29 files; browser smoke + 9/9 UI flows green.

## Wave 19 — Localization ru/en (shipped)

- **Mechanism** (contract wave): node-side `LocalizationContribution` registers per-area ru dictionaries (`src/node/i18n/ru/<area>.json`) with `languagePack: true` — mandatory for the preloader to apply translations, and it also unlocks Theia core's partial ru (`nls.ru.json`; vscode-derived workbench strings like File/Edit stay English — honest partial). Keys `ai-focused-editor/<area>/<slug>`, en defaults inline in code; locale in `localStorage['localeId']`, applied on reload via Configure Display Language.
- **Coverage** (fan-out wave, 9 parallel area agents): all user-facing strings across ~44 browser files — commands (`Command.toLocalizedCommand`), widget texts, wizards, QuickPick/QuickInput prompts, messages, tooltips, preference descriptions — ~700 strings in 15 dictionaries, natural literary Russian («ёлочки», «…»). User content (mode labels from yaml) intentionally not wrapped; `common/` validation strings stay English this wave (bun tests assert them; queued as a follow-up).
- Flow AFE-10 forces ru via localStorage and asserts «Рукопись»/«Новая глава…» live; the other nine scenarios pin the English defaults byte-identical.
- Infra find: flow runs had been served for ~12h by a zombie backend on port 3311 (fresh frontend from disk masked it) — `run-flow-checks.sh` now kills whatever holds the port before starting.
- Tests: 533; `verify:full` green (browser + electron smokes, 10/10 UI flows).

## Wave 20 — Tree: localized sections, Entities group (shipped)

- Section headers localize at the display point (Рукопись, Персонажи, …); the four entity sections nest under one expanded «Мир книги»/Entities group (globe icon, summed count) mirroring `entities/` and cutting top-level noise; right-click on the group offers all four create commands. 533 tests, 10/10 flows.

## Wave 21 — Two-concept AI model + real verification (shipped)

- **Profiles layer removed** (owner: «перемудрили; алиас указывает соединение и модель — профиль зачем?»). Research confirmed v1 never had profiles (the word was an internal variable name) and our alias mode already won whenever ≥1 alias existed. Gone: `ai.profiles`/`activeProfile` preferences, ~180 lines of service CRUD, the widget's AI Profiles section (~330 lines), the status-bar profile branch, dead `ModelProviderRegistry`. The model is exactly ENDPOINT (соединение) + ALIAS (endpoint+model legs, failover); empty aliases → «не настроено». `allowedModels` moved onto the endpoint (v1 parity); alias-leg model inputs suggest the endpoint's models. UI vocabulary: «подключение»/«алиас».
- **Two-stage verification** (better than v1, which only had a GET /models alert): per-endpoint `Check Connection` (reachability + model list; discovered models merge into the form as chips), per-alias check with PER-LEG verdicts — connection ✓/✗, model in catalog ✓/✗/?, 1–8-token test generation through that specific leg; time-window skips render as «пропущен», overall verdict follows failover semantics. Pure verdict assembly in `common/ai-verification.ts` (16 tests), RPC isolated in a browser service.
- Tests: 549 across 30 files; `verify:full` green (both smokes in-pipeline, 10/10 UI flows incl. reworked AFE-05).

## Wave 22 — Doctor report, base prompts, chat presets (shipped)

- **Doctor**: полный markdown-отчёт (untitled, разделы Исправимо/Замечания без обрезаний); при нуле фиксов отчёт открывается сразу, пикер не показывается.
- **Базовые промпты**: 8 режимов, дистиллированных из kavi/gv-скилов (толкование терминов с IAST, корректура, герменевтика Шад-линга, вада-оппонент, эссе, подготовка к печати, практические уроки, просодия) — поставляются с приложением; трёхслойные переопределения built-in → `~/.ai-focused-editor` → книга (origin-бейджи, Override, `Edit Global AI Modes…`, `enabled: false`).
- **Чат по-человечески**: команда «Возможности AI-чата…» с пресетами на понятном языке (Минимум / Мир книги / Исследование / Всё для книги) поверх сохраняемых per-agent выборов панели возможностей; функции с человеческими именами; каркас новой книги сеет `.prompts/skills/style-guide/SKILL.md` — Theia 1.73 сама находит книжные скилы для `{{skill:…}}`.
- Chat naming fix: @mention показывает label режима, промпт-фрагменты несут имя/описание.
- Tests: 568 across 31 files; 10/10 flows.

## Wave 23 — AI request journal (shipped)

- **`aiFocusedEditor.ai.requestLog`** (off/metadata/full): per-leg JSONL records in `ai/chat/requests-<date>.jsonl` — source, alias, endpoint, model, duration, tokens, outcome (incl. skipped-window/disabled); `full` adds 64KB-capped request/response bodies. Hooks in the failover walk and the streaming chat path, best-effort (never fails a request), 5MB/day cap. AI Debug gains a «Запросы» section with per-leg chips, alias/endpoint filters, open/clear journal actions and a one-click enable hint. 579 tests.

## Wave 24 — Doctor restores old folders (shipped)

- A deleted manifest is reconstructed from every discovered manuscript markdown (workspace-wide, service dirs excluded; folders → parts, titles from first headings, natural sort); unreferenced files become one atomic «Добавить в манифест» append fix; restored metadata takes the folder name as the book title. 22 reconstruction tests.

## Wave 25 — Office document preview (shipped)

- `.docx` (mammoth → DOMPurify-sanitized HTML with images), `.xlsx/.xls/.ods` (worksheet tabs, 1000×50-capped tables), `.pptx` (numbered text-card slides); legacy `.doc/.ppt` get a friendly unsupported view. Office files list in SOURCES with fitting icons; `Analyze Source Document...` reads `.docx`. Lazy-required parsers keep bundles lean; 50MB guard; 33 helper tests.

## Wave 26 — Chat context: any artifact (shipped)

- `#chapter`/`#entity` gained argument completion + pickers; new `#source:` (extracted text even from PDF/docx, 24K cap, graceful degrade) and `#note:` (hand-authored briefs/plans from `knowledge/`); «Добавить в контекст чата…» category picker; «Send to AI Chat» in the tree and Sources rows; knowledge note templates (бриф/план/содержание). 629 tests; 10/10 flows.

## Wave 27 — MCP enabled (shipped)

- `@theia/ai-mcp@1.73.1` in both targets: servers via `ai-features.mcp.mcpServers` (command/args/env, autostart-after-restart), tools surface as `mcp_<server>_<tool>` functions + a prompt fragment per server + an MCP group in the capabilities panel. `docs/mcp.md` carries a paste-ready **bs-search** recipe (11 search/RAG tools; `bash -lc` cwd workaround). The Start/Stop management widget would need `@theia/ai-ide` — flagged as a separate decision.

## Wave 28 — MCP controls, writing mode, i18n completion (shipped)

- **«Серверы MCP…»**: список настроенных серверов с состоянием и autostart, ручной старт/стоп по клику (интерактивный путь — OAuth-серверы открывают вход), отчёт о числе инструментов; «Добавить сервер…»/«Открыть настройки MCP…». Работает без `@theia/ai-ide`.
- **Режим письма**: команда + тумблер на вкладке редактора (панели сворачиваются с восстановлением раскладки); viewport-мета для телефонов, разовая подсказка на узких экранах, крупные тач-цели под `max-width:900px + pointer:coarse`.
- **i18n добит**: валидаторы `common/` шлют стабильные коды проблем с параметрами (английские сообщения байт-в-байт — тесты нетронуты), формы и отчёт доктора рендерят русский по кодам; AI Debug дочищен.
- Tests: 637 across 34 files; build + browser smoke + 10/10 flows on the final tree.

## Wave 29 — Browser auth + My Books catalog (shipped)

- **Optional shared-secret auth** (off by default; `--auth`/env, scrypt salted hash in `~/.ai-focused-editor/auth.json`, never in project folders). Rides Theia's own hook points: `EarlyExpressMiddleware` for HTTP (login page / 401) and `WsRequestValidatorContribution.allowWsUpgrade` for the RPC socket — the websocket hole is closed. Signed HttpOnly SameSite=Lax session cookie, Secure behind TLS; loopback and the electron target never gate. **Show Login QR** command: one-time 2-min single-use token → dependency-free QR (verified against a reference encoder) for phone login. `docs/auth.md` covers Caddy TLS. No user database — Theia backend is single-user; multi-user/permissions is a deliberate cloud-layer deferral.
- **My Books catalog**: `aiFocusedEditor.library.path` → the welcome page scans two levels for `manifest.yaml`, reads title/author/cover, shows a responsive card grid above Recent; cards open the workspace. 20 catalog tests.
- Tests: 669 across 37 files; build + browser smoke + 10/10 flows; auth confirmed off by default (localhost unblocked).

## Wave 50 — Агенты Theia AI работают с ai-connect из коробки (shipped)

- **Полевой отчёт владельца** (@Code Reviewer в форке: «Couldn't find a ready language model») вскрыл устройство дефолтов Theia AI: агенты резолвят модели через модельные алиасы `default/*` (`LanguageModelAliasRegistry`), которые захардкожены на официальные id (`anthropic/claude-opus-4-8`, `openai/gpt-5.5`, `google/gemini-3.1-pro-preview`) — без их ключей ни один агент не находит ready-модель.
- **Пакет теперь встаёт в дефолты сам**: `AiConnectDefaultModelsContribution` ставит always-ready модель «активный алиас» первой в каждом `default/*` (чистый `planDefaultAliasUpdates`, 5 тестов: идемпотентность, move-to-front, очистка при выключении, `selectedModelId` не трогается — явный выбор пользователя в AI Configuration всегда приоритетнее). Преференс `aiConnect.provideDefaultModels` (default on).
- Попутно: **пакет возит свой CSS** (75 правил Model Config/AI Debug переехали из стилей редактора — в чужом приложении виджет рендерился голым HTML; урок: Theia-расширение должно нести стили с собой).
- Live-доказательства в форке: Model Config отрисован как у нас; `default/universal`/`default/code` → наша модель; чат `@Universal ping` через mock вернул маркер (isError false). 1063 теста / 58 файлов.

## Wave 49 — Перевёрнутое выделение: нормализация диапазонов (shipped)

- **Полевой отчёт владельца** («не заменил, просто дописал» + скриншот диффа с дублированной секцией) вскрыл класс багов: Theia кладёт в `selection.start` ЯКОРЬ, а в `end` — курсор (`asSelection` в monaco-to-protocol-converter), так что выделение **снизу вверх** приходит с `start` ПОСЛЕ `end` (`direction: 'rtl'`), и Theia его не нормализует. Наша офсетная склейка `slice(0,start)+improved+slice(end)` при start>end **дублировала выделенный кусок** и вставляла улучшение между копиями; а `getText` на таком диапазоне даёт пусто — это же объясняет и предыдущий отчёт «Select text…» при живом выделении.
- **Фикс системный**: чистый `common/text-range.ts` (`normalizeRange`, тесты) применён во ВСЕХ потребителях `editor.selection` — улучшить выделенное, кореференции, AI-режимы, создание сущности из выделения, выдержки библиотеки источников. Плюс подсказка «выделение в предпросмотре» для промаха выделения не в редакторе.
- Live-проба: детерминированное rtl-выделение (monaco ISelection, якорь ниже курсора) → improve → Apply → маркер один, дублей нет, direction подтверждён. 1058 тестов / 57 файлов.

## Wave 48 — Показ AI-результата: честный diff + «Применить» (shipped)

- **Полевой отчёт владельца** («применил улучшить выделенное, но не понял где посмотреть результат») вскрыл настоящий баг: в `@theia/ai-chat` 1.73 change set сессии — это **агрегат по change set'ам реальных запросов** (`computeChangeSetElements` ходит только по `requests[]`), поэтому наши элементы с фиктивным `requestId` добавлялись «в никуда» (spy-проба: `addElements` вызван, `afterAddCount: 0`), а diff открывался fire-and-forget и молча не открывался. Вся связка improve/coref/режимов с чатом была мёртвым кодом.
- **Новый `ChangeProposalService`**: предложение = полный исходный текст ↔ полный целевой текст; diff через `InMemoryResources` (`afe-proposal:` схема, повторный запуск обновляет содержимое), открытие **await**'ится (ошибки не глотаются); `apply()` идёт через Monaco-модель (undo-стек сохраняется) c **guard от дрейфа** — если документ изменился после генерации, ничего не пишется; уведомление с кнопками «Применить» / «Открыть сравнение». Improve/coref/AI-режимы переведены на него; мёртвый change-set-код удалён.
- Live-проба полного цикла: diff-вкладка открывается, «Apply» из уведомления записывает улучшение в главу (маркер mock'а в файле). Попутно: `ai/context-snapshots/` в gitignore (рантайм-артефакт flows). 1053 теста; 10/10 flows.

## Wave 47 — AI Configuration GUI, completion для письма, чистый срез настроек (shipped)

- **@theia/ai-ide + @theia/ai-code-completion в обоих приложениях** (плюс 5 транзитивных пакетов, без которых генератор не собирает бандл: ai-terminal/console/debug/search-in-workspace/test). Маппинг «агент → алиас-модель» теперь кликается в AI Configuration и у нас. Ловушка поймана: ai-ide подменяет always-on активацию AI преференс-гейтом `ai-features.AiEnable.enableAI` (default FALSE) — выставлен app-default true, иначе весь AI (включая существующий чат) молча выключился бы. Completion: провайдер **универсальный** (селектор `{scheme:'file'}` без языков) — markdown/yaml/plaintext получают дополнения без нашей контрибуции; автотриггер по умолчанию **выключен** (писатель включает `ai-features.codeCompletion.automaticCodeCompletion` сам). Меню целы (наш Manuscript один, AFE-02). Побочный след ai-ide: в редакторе появились Debug-меню и Test-вью (его агентам нужны) — кандидат на будущий трим.
- **Полная миграция на `aiConnect.*`** (пользователей нет — легаси-поверхность срезана): 6 легаси-ключей удалены из схемы редактора, `aiFocusedEditor.ai.manuscriptOverview` → `aiConnect.manuscriptOverview`; одноразовая автомиграция user-scope при старте (пишет новое → удаляет старое → одно уведомление; чистый модуль с тестами); **доктор** получил находку `legacy-ai-settings` + фикс: комментарий-сохраняющая миграция `.theia/settings.json` книги через jsonc-parser; sample-book, docs, CONTRIBUTING, wiki-страницы мигрированы. Хелпер `resolveWithLegacy` остался в переиспользуемом пакете для чужих приложений.
- **«Зависание» browser-транспорта опровергнуто**: тревога агента оказалась артефактом его пробы — вся стрим-цепочка ленивая, fetch уходит при первом чтении потока, а его проба поток не читала. Проба с честным потреблением: `ai-connect/fast` в реестре нашего редактора, запрос дошёл до mock, маркер вернулся. Попутный настоящий фикс: конвертер сообщений больше не падает `undefined.trim()` на text-сообщении без `text`. 1053 теста / 56 файлов; 10/10 flows.

## Wave 46 — ai-connect module extracted to a reusable Theia package (shipped)

- **`packages/ai-connect-theia`** (@ai-focused-editor/ai-connect-theia) — connection/alias-слой вынесен из manuscript-workspace в самостоятельное Theia-расширение: конфиг endpoint+alias, резолюция алиасов, failover/ротация, двухступенчатая верификация, Model Config, статус-бар алиаса, журнал запросов, debug-вью, LanguageModel-регистрация (@theia/ai-core), node-сервис стриминга. Любое Theia-приложение подключает его записью зависимости; manuscript-workspace — теперь просто потребитель публичного API (книжный слой AI-режимов остался в редакторе).
- **Ключи нейтральные `aiConnect.*`** с мягкой миграцией: чистый `resolveWithLegacy` (новый ключ выигрывает, если задан; иначе легаси `aiFocusedEditor.ai.*`; с тестами) — существующие настройки продолжают работать; легаси-схема в редакторе помечена deprecated. Ограничение «API-ключи только user-scope» сохранено.
- **Развязки**: пакет регистрирует команды/вью, но не меню — размещение в меню Manuscript осталось тонкой контрибуцией редактора; собственная ru LocalizationContribution пакета (ключи строк не менялись, двойной регистрации нет).
- Заход пережил два падения агентов (лимит сессии, затем отказ структурного отчёта) — состояние оба раза оценивалось по дереву и продолжалось с частичного. Проверка: 1015 тестов / 54 файла, оба typecheck, полная сборка, **10/10 UI-flow** (включая AFE-05-MODEL-CONFIG и AFE-10-LOCALE-RU). Первая волна по новому регламенту ветка→PR.
- **Модель на каждый алиас + агенты чужого приложения** (запрос владельца: completion и чат через разные подключения/подписки): каждый алиас теперь регистрируется отдельной моделью `ai-connect/<alias>` (encodeURIComponent-кодирование id, diff-реконсиляция при изменении списка через `LanguageModelRegistry.add/removeLanguageModels`; чистый `diffAliasModels` с 12 тестами); запрос каждой модели жёстко пришпилен к её алиасу через `getFailoverChainForAlias` — независим от активного; журнал пишет, какая алиас-модель обслужила запрос; модель «текущий алиас» сохранена для обратной совместимости. **Доказано в форке насквозь**: mock OpenAI-endpoint, в AI Configuration форка Code Completion-агент → `ai-connect/fast`, Universal chat → `ai-connect/smart`; чат вернул маркер mock'а через smart, настоящий inline-completion в .ts пришёл через fast (лог mock'а различает форму запросов и алиасы; скриншоты в scratchpad). Точные ключи маппинга: `ai-features.agentSettings` {agentId → languageModelRequirements[{purpose, identifier}]}, включение AI — `ai-features.AiEnable.enableAI`. Архитектурная заметка: api-transport ходит через браузерный клиент ai-connect (by design, ради in-process tools), node-сервис — путь для локальных транспортов (acp/cli/server). 1027 тестов.
- **Переносимость доказана в чужой среде**: `@theia/*` пины ослаблены до `^1.73.0` (точный пин тащил бы второй `@theia/core` и ломал DI); пакет встроен в форк владельца `~/work/theia` (Theia **1.73.0**, npm-workspaces — Theia ушла с yarn) как обычное extension через `file:`-зависимость в examples/browser + `npm install --install-links` (пакует копию: обычный symlink-file: через webpack протаскивал бы bun-store 1.73.1 из нашего монорепо). Дедуп: `npm ls @theia/core` — 82 ссылки, все на workspace 1.73.0, один экземпляр. Live-проба в форке: все 7 наших команд в CommandRegistry (Model Config/переключение алиаса/эндпоинта/AI Debug), три frontend-модуля + backend-модуль автообнаружены из theiaExtensions, ноль ошибок консоли. Сборка примера ~2 мин на 90 проектов.

## Wave 45 — Obsidian plugin tier 2 + doctor installs the plugin (shipped)

- **Live Preview** (остаток яруса 1 закрыт): CM6-декорации — теги подсвечены акцентами видов прямо при письме, cmd/ctrl+клик открывает карточку (неизвестный id → модалка создания); тег под курсором не декорируется, чтобы не мешать правке.
- **Hover-превью карточки**: переиспользован чистый `buildEntityHoverMarkdown` из студии (волна 42) — полная карточка по схеме типа в поповере, единый механизм для чтения и Live Preview; на мобильном не активен.
- **Цитаты**: `core/citations.ts` (citations.yaml + excerpts.jsonl, чистый, с тестами), автодополнение `[@` → `[@cite:id]`, команда «Вставить выдержку…» блок-цитатой со ссылкой.
- **Панель сущностей**: секция по видам с количествами; бейдж упоминаний раскрывает список файл:строка с превью (клик — к месту); **облако** — имена сущностей в 4 размерных ярусах по частоте упоминаний, цвета видов, cap 40. Разведка «облака тегов» задокументирована: наши теги не нативные `#tags`, встроенная панель тегов и community tag-cloud их не видят — облако своё.
- **Доктор ставит плагин в папку книги** (идея владельца): `scripts/copy-obsidian-plugin-assets.mjs` везёт dist плагина в `apps/<target>/lib/obsidian-plugin/` (backend-читаемо, dev-fallback на packages/…/dist); чистые проверки `obsidianPluginFindings` (hint «не установлен» / warning «устарел», сравнение версий-троек); node-сервис install() пишет три файла в `<книга>/.obsidian/plugins/afe-companion/` и аккуратно мёржит id в `community-plugins.json` (кривой JSON не трогает — partial с сообщением). E2E-проба: getStatus → install → файлы на диске, community-plugins = ["afe-companion"], версия 0.1.0 — зелёная. 1008 тестов / 53 файла; бандл 280KB, ноль `@theia/`.

## Wave 44 — Obsidian companion plugin, tier 1 (shipped)

- **`packages/obsidian-plugin`** (id `afe-companion`) — «полевой блокнот» для книг AFE в Obsidian: панель «Рукопись» (книги → части → главы по manifest.yaml, клик открывает файл, дебаунс-обновление по изменениям vault), автодополнение тегов `[[kind:prefix` по сущностям книги (id/label/алиасы, prefix+fuzzy), reading-mode навигация (Obsidian превращает `[[kind:id|label]]` в анкоры ДО пост-процессоров — плагин перезаписывает анкоры в кликабельные спаны с акцентами видов; неизвестный id предлагает создать карточку по скелету полей типа), «Поиск сущностей» (fuzzy-модалка), YAML-карточки открываются собственным видом (шапка по схеме типа + редактируемый текст; настройка, действует на весь vault). ru/en локализация, мобильный Obsidian поддержан (isDesktopOnly false).
- **Переиспользование ядра**: реестр типов сущностей (BASE_ENTITY_TYPES + parseEntityTypesYaml + mergeEntityTypes) импортируется из manuscript-workspace напрямую — авторские типы работают в Obsidian ровно как встроенные. Осознанное отступление (задокументировано): parseSemanticMarkdown ASCII-only и парсит исходник, а reading mode даёт анкоры — в плагине свой Unicode-aware сканер (кириллические tagKind работают).
- Чистое ядро `src/core/*` без obsidian-импортов — 51 bun-тест; бандл 250KB (obsidian/CM6 external, ноль `@theia/`), смоук: dist/main.js исполняется со стабом API и экспортирует Plugin. `scripts/install-obsidian-plugin.sh <vault>` собирает и ставит плагин (проверено на копии sample-book). docs/obsidian.md обновлён: ярус 1 — shipped. 976 тестов / 51 файл.

## Wave 43 — Per-device theme override + iCloud sync recipe (shipped)

- **Оверрайд темы на устройство** (запрос владельца с телефона): телефон и десктоп делят один backend, поэтому `workbench.colorTheme` — ОБЩАЯ настройка; смена темы на телефоне перекрасила бы и десктоп. Оверрайд живёт в localStorage конкретного браузера и применяется через `ThemeService.setCurrentTheme(id, false)` — общие настройки не трогаются. Три входа: `?theme=<id|dark|light>` в URL (применился, запомнился, параметр вычищается из адреса), автоследование `prefers-color-scheme: dark` (только если тема не выбрана явно в общих настройках), команда «Тема на этом устройстве…» в меню Manuscript (QuickPick всех тем + «Как в настройках (сбросить)»). Оверрайд ре-ассертится, если общая настройка пытается его перебить (guard от циклов по id).
- **Тайминг-ловушка поймана live-пробой**: бандл-темы регистрируются в onStart другого контрибьютора — параметр читается синхронно (до перезаписи URL), а резолв откладывается до `started_contributions`. Проба: dracula по параметру + персистентность + изоляция контекстов (второе «устройство» осталось на solarized-light) — зелёная.
- `common/device-theme.ts` resolveDeviceTheme (18 тестов): param > stored > system; stale-id чистится; тёмная система не перебивает явный выбор пользователя.
- **docs/obsidian.md: вариант iCloud Drive** — vault в контейнере Obsidian (`iCloud Drive/Obsidian`), на Mac та же папка `~/Library/Mobile Documents/iCloud~md~obsidian/Documents/<книга>` открывается студией напрямую; git — опциональный слой версий на Mac с честной оговоркой про конфликт-копии `.git` в iCloud. 925 тестов / 48 файлов.

## Wave 42 — Full entity card preview on hover (shipped)

- **Hover над тегом `[[kind:id|label]]` показывает карточку целиком**: заголовок «Название — Тип · id», затем ВСЕ поля по схеме типа (списки через запятую, длинные тексты абзацем с обрезкой ~280 знаков по границе слова), неизвестные yaml-ключи карточки тоже видны; внизу — кликабельная ссылка «Открыть карточку» (через существующий openTarget → открывается форм-редактор). Работает на всём диапазоне тега, включая ярлык (раньше кликабельной была только часть `[[kind:id`), и для авторских типов (проверено на sloka: русские Summary/Notes рендерятся).
- Реализация: чистый `common/entity-hover.ts` (buildEntityHoverMarkdown, i18n-агностичен через localize-хуки, экранирует `[]<>` в значениях; 16 тестов) + Monaco HoverProvider `semantic-entity-hover-contribution.ts` (isTrusted markdown, TTL-кэш сущностей 5с, чтение YAML карточки через FileService, никогда не бросает). Старый трёхполевый hoverMessage из декораций удалён (декорации теперь только красят) — дублирующих блоков нет.
- Live-проба: полная карточка Кришны (Aliases/Epithets/Summary/Backstory/Arc/Speech patterns/Notes) при наведении на ярлык, карточка шлоки для авторского типа, клик «Open card» из hover открыл форму bg-2-47. 907 тестов / 47 файлов; build 0 ошибок.

## Wave 41 — Entity types form editor (shipped)

- **Форма для `entities/types.yaml`**: клик по «Типы сущностей» в дереве открывает форм-редактор (opener priority 500, сырой YAML — через Open With). Встроенные четыре типа показаны read-only карточками с бейджем «встроенный» (справка, переопределить нельзя); авторские типы — раскрывающиеся карточки: id (kebab-подсказка)/название/вид тега/каталог/значок/акцент + суб-редактор схемы полей (имя/вид text|textarea|list/подпись; добавление/удаление/порядок; служебные id и label закреплены сверху и не удаляются).
- **Один мозг валидации**: форма не дублирует правила — `validateTypeRows` сериализует строки и прогоняет через тот же `parseEntityTypesYaml`, что и рантайм; все коды проблем блокируют сохранение (тип с проблемой молча выпал бы из книги). Запись comment-preserving через yaml Document; дефолты (tagKind==id, directory==id, дефолтные поля/значок) в файл не пишутся.
- Команда «Изменить типы сущностей…» в меню Manuscript сеет `version: 1, types: []` при отсутствии файла. Новая i18n-область `entity-types`; `common/entity-type-forms.ts` (+19 тестов).
- Live-проба: форма перехватывает открытие из дерева, 4 встроенные карточки, карточка «Шлока» с полным набором инпутов, dirty-гейтинг, сохранение пишет YAML на диск с сохранением комментариев, дерево подхватывает секцию сразу, внешнее изменение перезагружает форму. 891 тест / 46 файлов; build 0 ошибок.

## Wave 40 — Formulas in exported books (shipped)

- Общий сегментатор `splitMathSegments` в `semantic-markdown` (превью переведено на него с дифф-доказательством 12/12 — экран и экспорт не могут разойтись); HTML/PDF — KaTeX HTML через сентинельный проход (прецедент сносок), CSS со встроенными woff2 (~359КБ, только если в книге есть формулы); EPUB — MathML (без шрифтов, EPUB3; компромисс по читалкам задокументирован). Доказательство реальной сборкой sample-book. 872 tests. Идея «формулы как сутры» доведена от превью до готовой книги.

## Wave 39 — Author-defined entity types (C stages 2–4, shipped)

- **`entities/types.yaml`**: книга объявляет свои типы сущностей (id/label/папка/тег/поля с дефолтами); валидация с кодами, коллизии с базовыми отклоняются; node-скан ходит по всем эффективным папкам, снапшоты несут список типов + проблемы; фронтенд-сервис с событием изменения.
- **Один компонент формы**: entity-редактор рендерится из схемы полей дескриптора — базовые четыре пиксельно прежние, авторские открываются той же формой; неизвестные yaml-поля переживают сохранение.
- **Дерево/создание**: секции авторских типов под «Миром книги», generic «Новая сущность…» по всем типам, «Типы сущностей» открывает yaml.
- **Теги/навигация/доктор**: автодополнение и клик-переход для авторских тегов, доктор считает объявленные типы известными, показывает проблемы types.yaml и создаёт карточки авторских типов.
- Демонстрация: тип «Шлока» в sample-book — живая проверка: секция «Шлока (1)» с карточкой в дереве. 849 tests (+100); build green. Идея владельца «настраиваемые entity: базовый набор + набор автора, один компонент, меняем теги» реализована целиком.

## Wave 38 — Chat context management (shipped)

- **«Работать с главой…»** (меню + правый клик): автосборка набора — глава + сущности её тегов + цитаты `[@cite:]` + их исходники — мультиселект с предвыбором, докидываемые источники/заметки, всё прикрепляется chips-ами одним движением. Чистые правила сборки в `common/chapter-bundle.ts`.
- **Компактный обзор**: `aiFocusedEditor.ai.manuscriptOverview: full|compact` — компактный режим сжимает всегда-включённый `{{manuscript}}` до скелета манифеста + счётчиков (full — побайтно прежний).
- **Именованные наборы** в `ai/context-sets.yaml` (под git, comment-preserving): «Сохранить контекст как набор…» / «Применить набор…».
- **`#set:<id>`** — набор прикладывается упоминанием: разворачивается в один chip с заголовками по элементам (резолв через variable service, лимит 64K, защита от циклов).
- 812 tests; build green.

## Wave 37 — Addressability, agent write tools, formulas (shipped)

- **Правило (постоянное): каждый артефакт книги индивидуально адресуем в ai-chat** — переменная с пикером, категория универсального пикера, «Отправить в AI-чат», текстовое представление для бинарных форматов. Закрыты пробелы: `#citation:<id>` (карточка + её выдержки), `#excerpt:<id>`, `#diagram:<path>` (диаграмма приходит модели текстом: подписи узлов с entity-ссылками, связи «A → B», счётчики фигур; чистый суммаризатор, 13 тестов); категории Цитаты/Выдержки/Диаграммы/Книга.
- **Агент создаёт файлы (блок A)**: write-инструменты `manuscript_create_entity` / `manuscript_write_note` / `manuscript_create_diagram` (структурный spec → детерминированная сетка, узлы с `afe-entity://`, 24 теста; невалидный spec падает до записи; никогда не бросают исключений); промпт-фрагмент diagram-author учит агента формату.
- **Формулы (идея «сутры»)**: KaTeX в превью через существующий onRender-проход (ленивая загрузка, деградация на битой формуле), self-host css/шрифтов в обеих сборках — живая проверка: 4 формулы отрендерены, 0 CDN; подсветка `$...$` в Monarch; пример в sample-book. Экспорт формул в EPUB/PDF — follow-up.
- 789 tests; build + smokes green.

## Wave 36 — Doctor: entity discovery (shipped)

- Доктор восстанавливает базу сущностей по тексту: теги `[[kind:id]]` без карточки → исправление «создать карточку» (имя из самой частой метки тегов, счётчик упоминаний и первый файл в описании); карточки-сироты и неизвестные типы тегов (`[[spell:…]]` — задел под авторские типы) — справочные находки; «голые» `[[id]]` считаются ссылками, но фиксов не порождают. Полнотекстовый однопроходный скан с лимитом 1 МБ/файл. 752 tests.

## Wave 35 — Excalidraw relations map with click navigation (shipped)

- «Карта связей → Excalidraw»: из графа со-встречаемости строится `sources/relations-map.excalidraw` (кластеры по типам из реестра, подписи, стрелки); каждый узел несёт `afe-entity://kind/id`, и `onLinkOpen` редактора открывает карточку — работает в любой диаграмме (аналог element-links obsidian-плагина). Перегенерация append-only по стабильным id: ручная раскладка неприкосновенна, идемпотентно, удалённые сущности докладываются. 19 тестов билдера.

## Wave 34 — Entity type registry, stage 1 (shipped)

- `BASE_ENTITY_TYPES` как данные (id, тег, папка, метка, секция, иконки, схема полей формы); все хардкоды типов — протокол, карты создания, секции, навигация `char→character`, автодополнение/декорации, иконки дерева, сканы node-сервисов — деривируются из реестра. Ноль изменений поведения доказан нетронутым тестовым набором (только +21 тест реестра). Фундамент этапов 2–4: schema-форма, авторские типы (`entities/types.yaml`), obsidian-совместимые ссылки.

## Wave 33 — Book skills UI (shipped)

- Theia's @theia/ai-core already discovers `<book>/.prompts/skills/<slug>/SKILL.md` (verified live: `getSkills()` → `[style-guide]`, and `{{skill:…}}` resolves in chat). This wave adds the authoring UI so skills are as first-class as other artifacts: a **Skills** section in the manuscript tree (own curated scan of `.prompts/skills`, label from frontmatter name, opens `SKILL.md`; verified live «Skills (1)» → style-guide) and a **New Skill…** command (name + optional description → seeded `SKILL.md` with a `{{skill:slug}}` starter). 696 tests.

## Wave 32 — Excalidraw canvas conveniences (shipped)

- Selection-manipulation commands inspired by the obsidian excalidraw plugin's ea-scripts: **Split Text into Lines** (owner-requested), Merge Text Elements, Connect with Arrow, Box Selected, Text to Sticky Note. Each reads the active editor's selection via the imperative API, transforms it with pure helpers (`common/excalidraw-canvas-ops.ts`, 22 tests), builds elements with `convertToExcalidrawElements`, and pushes `updateScene`.
- A **Canvas Actions…** toolbar button (wand) opens a quick pick of the ops — reachable from the canvas since the Excalidraw canvas has no Theia context menu (verified the button renders live). 691 tests.

## Wave 31 — Excalidraw completion (shipped)

- **Dirty guard**: opening a diagram no longer marks it dirty (scene-version baseline via `getSceneVersion`; dirty only on real divergence) — autoSave stops rewriting the file on open (verified live: DIRTY-ON-OPEN no).
- **Export to the manuscript**: Export Diagram as PNG / SVG (toolbar + commands) writes `<name>.excalidraw.png/.svg` beside the source and offers «Вставить в главу» → `![name](relative)` at the caret of the active markdown editor.
- **New Diagram…** creates a blank `.excalidraw` in `sources/` (transliterated slug) and opens it.
- **Electron assets**: `copy-excalidraw-assets.mjs` is target-aware and wired into both bundle scripts (electron serves `lib/frontend`).
- **Code-splitting declined** (documented): esbuild splitting needs `format=esm`, but Theia's shell loads `bundle.js` as a classic script and regenerates the config/HTML — keep the lazy import inlined, rely on production minification.
- Tests: 669; build + render smoke green.

## Wave 30 — Excalidraw diagram editor (spike → feature, shipped)

- De-risking spike succeeded and became the feature: `@excalidraw/excalidraw` 0.18.1 bundles under `theia build` (which is **esbuild** here, not webpack), rendered in a `ReactWidget` + Navigatable + Saveable opening `.excalidraw` at priority 500 (lazy component load, theme-synced, save via `serializeAsJSON`). Offline-safe assets: `scripts/copy-excalidraw-assets.mjs` (a committed build step, since `apps/*/esbuild.mjs` is regenerated/gitignored) copies fonts + css into the served root and the widget sets `EXCALIDRAW_ASSET_PATH` — **live-verified**: canvas mounts, 0 CDN hits, 0 asset 404. `.excalidraw` lists in SOURCES; `scripts/excalidraw-smoke.mjs` renders a fixture on demand. Use: hand-drawn world maps, character graphs, plot timelines in the book folder under git.
- **Follow-ups**: esbuild code-splitting so the lazy import leaves the startup bundle (currently inlined, dev bundle large; prod minified ~1.5MB gz); guard the mount-time `onChange` so opening a diagram doesn't mark it dirty (autoSave rewrites `source` on open); electron asset-copy + verification (spike covered the browser target).

## Backlog (queued)

9. **Mobile layout polish** (скриншоты владельца с iPhone, 2026-07-12): welcome-страница не responsive (горизонтальный скролл, обрезанные кнопки), AI-chat инпут плавает поверх контента, файл-пикер обрезается слева, мелкие тач-мишени. Viewport meta уже есть; Writing Mode помогает частично. Основной мобильный путь — Obsidian (см. docs/obsidian.md, iCloud-вариант); полноценная адаптация Theia-шелла под телефон — большая работа, делать по запросу.



8. **Формулы в markdown (KaTeX)** (owner intake 2026-07-12; идея: философские мысли, выраженные формулами — как сутры). Не в спеке GFM, но стандартная надстройка: `$...$`/`$$...$$` через KaTeX. План (разведан): (а) превью — KaTeX auto-render через существующий onRender DOM-хук (тот же паттерн, что SVG-патчинг) + self-host шрифтов KaTeX (как excalidraw-assets, офлайн); альтернатива — сабкласс Theia `MarkdownRendererImpl` через штатный `markdownItPlugin()` хук; (б) редактор — подсветка `$...$` в Monarch-токенизаторе (мелочь); (в) экспорт — настоящая цена: PDF через Chrome возьмёт KaTeX HTML+CSS, EPUB лучше с MathML-выводом KaTeX (средняя работа). Obsidian-спутник рендерит `$...$` из коробки (MathJax) — офлайн-цикл совместим сразу.

0. **Electron smoke pipeline flake — largely solved**: dev-mode backend fork collided with Playwright's debug argv → the smoke runs `NODE_ENV=production` and is green standalone, after builds, and via `bun run`. A residual in-pipeline-only failure (window dies with ZERO main output, only inside the full `verify:full` chain) still appears sporadically; retries + output capture stay in place to characterize it.

1. Full LSP transport if live validation ever needs cross-file incremental analysis (current backend-RPC path covers the active-document case).
2. Drop the git fork when a platform-compatible `@theia/git` ships.
3. **Preview: images inside markdown** (owner intake 2026-07-10). Scouting result: the preview renders through Theia `MarkdownRenderer` with no document base URI, so relative `![alt](images/pic.png)` sources almost certainly do not resolve (and the browser target cannot load `file:` URIs at all). Plan: verify with a sample image, then rewrite relative `img src` against the document dir to a servable form (data URI via FileService read, or a backend file endpoint), both targets; add a flow assert.
4. **Localization ru/en** (owner intake 2026-07-10). Two layers: (a) our extension strings (commands, menus, forms, welcome, doctor) via Theia `nls.localize` + a LocalizationContribution with ru dictionary, en as source of truth; (b) Theia workbench ru language pack. Cross-cutting refactor of all hardcoded UI strings — the sooner started, the fewer strings accumulate; needs a string-extraction pass and a convention for new code.
5. **Browser auth for non-localhost access** (owner intake 2026-07-10). Today the browser target serves the workspace unauthenticated; anyone reaching the port owns the files. Plan: backend auth middleware (shared-secret token → session cookie; login page), cover HTTP + websocket upgrade, opt-in via env/CLI flag so localhost stays frictionless; document reverse-proxy (HTTPS) setup.
6. **Pluggable workspace storage** (owner intake 2026-07-10). One architectural key: all four modes are Theia `FileSystemProvider` implementations behind a scheme + workspace root: (a) browser-only storage — IndexedDB/OPFS provider, no disk, works offline; (b) remote over SSH — likely a sync model (local working copy + push/pull) rather than live sshfs; (c) database-backed — REST/blob provider against a simple documents API; (d) WebDAV — standard protocol provider (Nextcloud/ownCloud etc. for free). Order of attack: design the provider seam once, ship browser-storage first (self-contained), then WebDAV (cheapest remote win), then SSH-sync, then DB.
7. **bs-search library integration** (owner intake 2026-07-10; `~/work/bs-search` — sacred-scriptures search backend: SQLite FTS + vectors, RAG layer, Reader-UI). It already exposes an **MCP server** and a browser index export, so three integration routes: (a) MCP tools for our AI agents (search/answer available to chat + review modes); (b) a Library search view in the editor (backend service calling bs-search's index directly) with "insert citation with `ref`" flowing into `sources/citations.yaml` + excerpts; (c) RAG-повышение контекста для переводческих/справочных AI-режимов. Start with (a)+(b): the citation-with-ref flow matches the writer workflow this editor is built for.
