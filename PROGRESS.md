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

## Backlog (queued)

1. Full LSP transport if live validation ever needs cross-file incremental analysis (current backend-RPC path covers the active-document case).
2. Drop the git fork when a platform-compatible `@theia/git` ships.
