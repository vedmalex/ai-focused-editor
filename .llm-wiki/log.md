<!-- Template for llm-wiki-* family. Authored under TASK-357. Substituted by skills/llm-wiki-init/scripts/init-node.ts. -->
---
node: /Users/vedmalex/work/ai-editor-3/.llm-wiki
---

# Operation Log — .llm-wiki

Append-only. Newest entries at top. Do not edit past entries.

Entry format (spec-aligned, grep-friendly):
## [YYYY-MM-DD] type | title

<body paragraph>

Backward parser also accepts old bullet format during transition.

Types: init | ingest | query | maintain | migrate | remove

<!-- Entries appended below by llm-wiki-* skills -->
## [2026-07-10] maintain | Feature map: wave 9 (two-level connection model, rotation, dynamic AI modes)

Updated `pages/ai-focused-editor-feature-map.md` for wave 9, every fact verified against `packages/manuscript-workspace` source. Added the **two-level connection model** (`common/ai-alias-resolution.ts` + `ai-time-windows.ts`, resolved by `ai-profile-preference-service.ts`): endpoints (channels with availability windows — weekday sets/ranges, overnight, fail-open on malformed) + aliases (endpoint→model chains), `activeAlias`/`pinnedEndpoint`, resolution ladder aliases→profiles→legacy, skipped-endpoint reasons, and `parseV1Import` (rag-endpoints.json/rag-aliases.json, apiKey|token / url|endpoint fallbacks). Documented **rotation commands** (`ai-rotation-contribution.ts`: Switch AI Alias/Endpoint), the alias-mode status bar (`alias · endpoint` + `$(pin)`), Model Config endpoints/aliases lists + verify-on-configure + v1 import, and **author-defined AI modes** (`common/ai-mode-protocol.ts` + `ai-mode-dynamic-contribution.ts`: context/menu/apply/agent/icon fields, dynamic editor-context "AI Modes" submenu with context-aware enablement, Change Set delivery, ChatService `@agent` routing, hot-re-registered chat agents; sample modes rewrite-dialogue + lore-keeper → 10 modes). Refreshed counts: command table 55→57 (+dynamic per-mode note), preferences (endpoints/aliases/activeAlias/pinnedEndpoint), module table 6→9 theiaExtensions entries (added book-config-editor, ai-mode-dynamic, ai-rotation), test inventory 186→277 across 15→20 files (per-file recount). Bumped `updated_at`.

## [2026-07-10] maintain | Feature map refreshed after waves 7+

Refreshed `pages/ai-focused-editor-feature-map.md` against current source (waves 7+): unified 8-section author navigator (`author-materials.ts`, `isAllowedMaterialFile`, `afe-ico-*` icon theme); Monarch markdown grammar + per-surface GFM task lists (checkboxes HTML/PDF, glyphs preview/EPUB); citations workflow (Save Selection as Citation, Citation Form Editor, recursive sources, Copy buttons); six chat context variables (#manuscript/#chapter/#entity/#entities/#sources/#outline); bounded provenance logging; heading-hierarchy outline with per-section entities; local `@ai-focused-editor/git` fork + Initialize Git Repository / Add to .gitignore; `@theia/mini-browser` image/PDF viewers; AI Review Current Chapter; aux `sources`/`knowledge` markdown linting; UI flow pack (6 scenarios). Bumped command table to 55, tests to 186 across 15 files, added `updated_at` frontmatter. Verified every fact against `packages/manuscript-workspace`, `packages/book-export`, `packages/theia-git-fork`, and `apps/*`.

## 2026-07-10 — Feature map added

Added `pages/ai-focused-editor-feature-map.md` (type: concept) — a code-verified feature map of the Theia-based AI Focused Editor: views, menu/commands, editor features, AI stack, knowledge/sources, build/export, git/history, workspace conventions, RPC map, and test inventory.
Compiled directly from `packages/manuscript-workspace` source (commands, menus, keybindings, widgets, services/protocols) rather than PROGRESS.md; reflects the deduplicated central `registerSubmenu` menu tree. Registered in index.md via update-index.ts.

## [2026-07-09] init | node created at .llm-wiki

Node initialized at /Users/vedmalex/work/ai-editor-3/.llm-wiki. Service files: AGENTS.md, CLAUDE.md, index.md, log.md, sources.md, questions.md, health.md.
## [2026-07-09] init | intake-evidence applied (96277136-af2d-4fb4-b1a2-27a3517144fc)

Intake evidence session_id=96277136-af2d-4fb4-b1a2-27a3517144fc applied.
## [2026-07-09] ingest | composing_applications

Source: virtual (source-content mode, copy). Registered as theia-composing-applications in sources.md. Raw path: raw/theia-composing-applications.
## [2026-07-09] ingest | authoring_extensions

Source: virtual (source-content mode, copy). Registered as theia-authoring-extensions in sources.md. Raw path: raw/theia-authoring-extensions.
## [2026-07-09] ingest | theia_ai

Source: virtual (source-content mode, copy). Registered as theia-ai in sources.md. Raw path: raw/theia-ai.
## [2026-07-09] ingest | services_and_contributions

Source: virtual (source-content mode, copy). Registered as theia-services-and-contributions in sources.md. Raw path: raw/theia-services-and-contributions.
## [2026-07-09] ingest | architecture

Source: virtual (source-content mode, copy). Registered as theia-architecture-overview in sources.md. Raw path: raw/theia-architecture-overview.
## [2026-07-09] ingest | extensions

Source: virtual (source-content mode, copy). Registered as theia-extensions-vs-plugins in sources.md. Raw path: raw/theia-extensions-vs-plugins.
## [2026-07-09] ingest | preferences

Source: virtual (source-content mode, copy). Registered as theia-preferences in sources.md. Raw path: raw/theia-preferences.
## [2026-07-09] ingest | theia-platform

Source: virtual (source-content mode, copy). Registered as theia-platform-overview in sources.md. Raw path: raw/theia-platform-overview.

## 2026-07-09 — Initial Theia docs ingest
- Ingested 8 official Theia Platform docs pages (docs hub sections + platform overview) as copy-mode sources.
- Created 8 summary pages and 10 concept pages (dependency-injection, contribution-points, theia-extensions, frontend-backend-separation, theia-ai-agents, language-models, prompt-fragments, context-variables, preferences-system, widgets-and-views).
- Theia AI page re-extracted at full fidelity (priority #1 for AI Focused Editor).
- theia-docs-hub landing page failed extraction (navigation-only page); revisit if needed.

## 2026-07-11 — Feature map refreshed (waves 11–30)
- Rewrote ai-focused-editor-feature-map to current code state: form editors (entity/citation/excerpts/ai-modes/manifest/metadata), semantic-link + footnote navigation, artifact creation from tree/selection, Book Doctor + manifest reconstruction, welcome page + New Book wizard + My Books catalog, manuscript-view toolbar.
- AI stack: endpoint+alias two-level model (profiles removed) + two-stage verification, AI request log, base-modes.yaml three-layer override, chat capability presets, chat artifact context (#source/#note).
- Viewers: office preview (docx/xlsx/pptx), markdown image inlining, Excalidraw editor.
- Platform: ru/en localization (nls per-area dicts), MCP (@theia/ai-mcp + server controls), browser auth (password+QR, off by default), writing mode + mobile layer, Cyrillic transliteration in slugs, @theia/git fork, entities grouped under one tree node.
- Test Inventory updated to real numbers: 669 pass / 0 fail / 37 files (was 297/20). UI flow pack now 10 scenarios (AFE-01..AFE-10).
- Verified against source + `bun test packages`; index.md date bumped.
