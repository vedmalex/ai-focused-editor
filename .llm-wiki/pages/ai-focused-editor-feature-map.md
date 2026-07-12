---
type: concept
slug: ai-focused-editor-feature-map
created_at: 2026-07-10T04:24:31Z
updated_at: 2026-07-12T12:00:00Z
---

# AI Focused Editor — Feature Map

A complete, code-accurate map of the **AI Focused Editor**, a [Theia](https://theia-ide.org)-based writing IDE for long-form Markdown manuscripts with semantic tags, project knowledge, source-aware review, office/image preview, and multi-provider AI. It builds on Theia's [[contribution-points|contribution points]], [[widgets-and-views|widgets/views]], [[dependency-injection|DI]], [[frontend-backend-separation|frontend/backend separation]], [[theia-ai|Theia AI]], [[language-models|language models]], [[prompt-fragments]], and [[context-variables]].

The product ships in one npm package: **`@ai-focused-editor/manuscript-workspace`** (`packages/manuscript-workspace`), which registers **23 Theia extension entries** via `theiaExtensions` in its `package.json` (one carries both a frontend and a backend module; the other 22 are frontend-only):

| Module | Front/back | Purpose |
|--------|-----------|---------|
| `manuscript-workspace-frontend-module` + `manuscript-workspace-backend-module` | both | Core: unified author navigator, semantic preview (+ **KaTeX math**), model-config, AI debug, sources, AI stack, chat agent, **read + write tools**, context variables, **named context sets** (`#set`), markdown grammar (+ math tokens), semantic-link/footnote navigation, git actions, writing mode, chat-context actions (+ **chapter working set**), AI profile status bar, AI-mode + **diagram-author** prompt fragments, **entity-type registry**, **Generate Relations Map**, **Excalidraw canvas ops** |
| `author-materials-create-frontend-module` | frontend | New Character/Term/Artifact/Location, **generic New Entity (any author type)**, New Citation, New Knowledge Note, Add Source File, **New Diagram**, **New Skill** — from tree section nodes and editor selection |
| `entity-editor-frontend-module` | frontend | **Schema-driven** form entity YAML editor — one control per field of the file's effective type, author types included (default opener) |
| `citation-editor-frontend-module` | frontend | Form-based `sources/citations.yaml` editor (default opener) |
| `excerpts-editor-frontend-module` | frontend | Form-based `sources/excerpts.jsonl` editor (default opener) |
| `ai-modes-editor-frontend-module` | frontend | Form editor for AI-mode YAML (book + global layers) |
| `book-config-editor-frontend-module` | frontend | Form editors for workspace-root `metadata.yaml` + `manifest.yaml` (default openers, priority 500) |
| `office-preview-frontend-module` | frontend | Read-only preview for docx/xlsx/xls/ods/pptx (+ friendly card for legacy `.doc`/`.ppt`) |
| `excalidraw-editor-frontend-module` | frontend | `.excalidraw` diagram editor (default opener, priority 500) |
| `knowledge-generation-frontend-module` | frontend | Chapter summaries / scene plans / author questions (FR-011) |
| `ai-mode-dynamic-frontend-module` | frontend | Author-defined AI modes as dynamic editor commands / context-menu entries / chat agents (see *AI Stack*) |
| `narrative-graph-frontend-module` | frontend | Narrative Map view + narrative-graph service proxy (FR-007) |
| `semantic-history-frontend-module` | frontend | Read-only semantic (git) history view (FR-017) |
| `ai-rotation-frontend-module` | frontend | Live `Switch AI Alias…` / `Switch AI Endpoint…` rotation commands (see *AI Stack*) |
| `live-validation-frontend-module` | frontend | Debounced live semantic-markdown validation while editing |
| `book-build-wizard-frontend-module` | frontend | New Book wizard + build wizard (format/output picker) |
| `book-doctor-frontend-module` | frontend | Book Doctor: scaffold check + manifest reconstruction/restore |
| `welcome-frontend-module` | frontend | Welcome page + My Books catalog |
| `chat-capability-presets-frontend-module` | frontend | Chat capability presets for the Manuscript agent |
| `mcp-controls-frontend-module` | frontend | MCP server management quick-pick (`@theia/ai-mcp`) |
| `auth-qr-frontend-module` | frontend | Browser-auth login QR command |
| `writer-icon-theme-frontend-module` | frontend | Custom writer icon theme (per-kind `afe-ico-*` accents) |
| `bundled-color-themes-frontend-module` | frontend | Bundled color themes (Dracula, Nord, One Dark Pro, Gruvbox, Solarized Light) |

Supporting packages: **`@ai-focused-editor/semantic-markdown`** (`[[kind:id|label]]` parse/validate/normalize/preview, footnote parsing, **plus `$$…$$`/`$…$` math segmentation** — `splitMathSegments`, the single detector shared by the preview and exporter so on-screen and exported math never drift), **`@ai-focused-editor/book-export`** (EPUB/PDF/HTML generators **plus KaTeX math rendering** — `renderMathToHtml`/`renderMathToMathML`/`getKatexCss`, `katex ^0.16.11`), and **`@ai-focused-editor/git`** — a temporary local fork of `@theia/git@1.60.2` rebuilt for Theia 1.73 (`packages/theia-git-fork`, see *Git & History*). The AI transport layer is the external **`@vedmalex/ai-connect` 0.9.0**.

---

## Views & Layout

Widget IDs are the `static readonly ID` on each widget class; each view is toggled by a command (`toggleCommandId`) and placed in a shell area via `defaultWidgetOptions.area`/`rank`. Factory (editor) widgets open on files instead of a fixed area.

| View (label) | Widget ID | Area / open | Toggle command | Tab icon | Renders |
|--------------|-----------|-------------|----------------|----------|---------|
| **Welcome** | `ai-focused-editor.welcome` | main | `ai-focused-editor.welcome.open` | `fa fa-book` | Landing page: **New Book** / **Open Folder**, and a **My Books** grid (scans the library folder for `manifest.yaml`, reads `metadata.yaml`, renders cover/title/author; click opens the folder). Opened on empty-workspace startup unless `aiFocusedEditor.welcome.showOnStartup=false` |
| **Manuscript** (unified author navigator) | `ai-focused-editor.manuscript-tree` | left (200) | `ai-focused-editor.manuscriptTree.open` | `fa fa-book` | Single tree — **Manuscript**, an **Entities group node** (collapsible, globe icon) nesting **Characters / Terms / Artifacts / Locations** **plus one section per author-declared entity type** (from `entities/types.yaml`, verbatim label + declared icon) and an **`entities/types.yaml` leaf** (seeds itself on first open), then **Citations**, **Sources**, **Knowledge**, **Skills** (book-local `.prompts/skills/<slug>/SKILL.md`), each header showing a live count. Manifest-backed manuscript nodes drag-reorder (MIME `application/x-afe-manuscript-path`); codicon icon theme with per-kind `afe-ico-*` accents. **View toolbar**: New Chapter, Refresh |
| **Sources** | `ai-focused-editor.sources` | left (215) | `ai-focused-editor.sources.open` | `fa fa-archive` | Detail panel with **Files**, **Citations** (`[@cite:id]` targets), **Excerpts**; per-row **Copy** buttons. Attach/Analyze/Save-as-Citation/Edit-Citations/Edit-Excerpts are commands |
| **Semantic Preview** | `ai-focused-editor.semantic-markdown.preview` | right (220) | `ai-focused-editor.semanticMarkdown.preview.open` | `fa fa-eye` | Live preview of the active `.md`; `[[kind:id\|label]]` → **label** _(kind:id)_; GFM task lists render as `☐`/`☑`; **relative/workspace images inlined to `data:` URIs** (`preview-images.ts`); optional tag-chip row (pref `aiFocusedEditor.preview.showTagChips`). **`ExtractableWidget`** — tears off to its own OS window (FR-021). View toolbar: Refresh |
| **Knowledge Cards** | `ai-focused-editor.entity-cards` | right (220) | `ai-focused-editor.entities.openCards` | `fa fa-address-card` | Entity cards grouped **Characters → Artifacts → Locations → Terms**; each card: label+kind badge, id, aliases, epithets, summary, arc, collapsible speech patterns / backstory / notes, "Open YAML" |
| **Narrative Map** | `ai-focused-editor.narrative-map` | right (230) | `ai-focused-editor.narrative.openMap` | `fa fa-project-diagram` | Timeline (artifact ownership chains + per-chapter entity chips) and a **Relations SVG graph** (ring layout, node radius ∝ appearances, edge width ∝ co-occurrence) |
| **AI Model Config** | `ai-focused-editor.model-config` | right (230) | `ai-focused-editor.modelConfig.open` | `fa fa-sliders` | **Endpoints** (channels) and **Aliases** (chains) managed lists — the two-level connection model (legacy per-provider *profiles* are gone). Endpoint editor draft has a **Verify** button and **verify-on-configure** auto-ping; per-endpoint availability windows; **two-stage verification** (stage 1 endpoint reachability + model list, stage 2 per-chain-leg connection/model-present/test-generate — `ai-verification.ts`). **Import ai-editor v1 Settings…** reads `rag-endpoints.json`/`rag-aliases.json`. Discover Models |
| **AI Debug** | `ai-focused-editor.ai-debug` | right (240) | `ai-focused-editor.aiDebug.open` | `fa fa-bug` | Provider status table, Project AI Modes, Active Editor, Manuscript Context dump, and the **AI Request Log**: kind select (`Chat requests` / `Context snapshots`), day picker, Refresh, Open JSONL; per-entry route chip + JSON |
| **Semantic History** | `ai-focused-editor.semantic-history` | right (240) | `ai-focused-editor.semantic-history.open` | `fa fa-history` | Read-only git history filtered to semantic-domain commits (`getSemanticHistory`, limit 50); per-commit entity/path change chips (add/modify/delete/rename) |
| **Entity Form Editor** | factory `ai-focused-editor.entity-editor` | main (opener 500) | `ai-focused-editor.entity.openFormEditor` | `fa fa-id-badge` | **Schema-driven** form for entity YAML: renders one control per `EntityFieldDescriptor` of the file's **effective type** (built-in OR author-declared), resolved from `EntityTypeRegistryService` and re-resolved live when `entities/types.yaml` changes; AJV validation runs only for the four built-in kinds. Default opener for any effective type's `entities/<dir>/*.yaml`; preserves comments/unknown keys (artifact `ownership`, author extras) via `parseDocument` |
| **Citation Form Editor** | factory `ai-focused-editor.citation-editor` | main (opener 500) | `ai-focused-editor.sources.editCitations` | `fa fa-quote-right` | Form for `sources/citations.yaml` (id/title/source/note rows; Add/Save/Reload; per-row Delete). Default opener; round-trips header/`version`/comments via `parseDocument` |
| **Excerpts Form Editor** | factory `ai-focused-editor.excerpts-editor` | main (opener) | `ai-focused-editor.excerpts.editExcerpts` | — | Form over `sources/excerpts.jsonl` (`excerpt-forms.ts`): per-line `SourceExcerpt` rows, add/edit/delete; default opener for the JSONL |
| **AI Modes Form Editor** | factory `ai-focused-editor.ai-modes-editor` | main (opener) | `ai-focused-editor.aiModes.editModes` / `.editGlobalModes` | — | Form over `custom-modes.yaml` (book layer) or the global `~/.ai-focused-editor/custom-modes.yaml`; enabled/disabled toggles; layered-override aware (`ai-mode-forms.ts`) |
| **Book Metadata / Manifest editors** | factories `…book-config-editor` | main (opener 500) | `ai-focused-editor.config.editMetadata` / `.editManifest` | — | Form editors for workspace-root `metadata.yaml` + `manifest.yaml` (`book-config-forms.ts`) |
| **Office Preview** | factory `ai-focused-editor.office-preview` | main (opener) | `ai-focused-editor.office.openPreview` | — | Read-only preview of docx (mammoth→HTML), xlsx/xls/ods (sheet tables, cap 1000×50), pptx (slide run lists); legacy `.doc`/`.ppt` → friendly unsupported card; all backend HTML DOMPurify-sanitized. `office.openAsText` reopens raw |
| **Excalidraw Editor** | factory `ai-focused-editor.excalidraw-editor` | main (opener 500) | (opener on `.excalidraw`) | — | Whiteboard/diagram editor for `.excalidraw` files; `onLinkOpen` navigates `afe-entity://kind/id` node links to the entity card. **Canvas ops** (`excalidraw-canvas-ops-contribution.ts` + pure `common/excalidraw-canvas-ops.ts`): Split Text into Lines · Merge Text · Connect with Arrow · Box Selected · Text to Sticky Note — reached via the tab-toolbar **Canvas Actions…** quick-pick and a **Canvas** context submenu |

**The unified author navigator** (`author-materials.ts` + `manuscript-tree-*.ts`): the **nine built-in** section kinds fixed by `AUTHOR_MATERIALS_SECTION_ORDER` (`manuscript`, `characters`, `terms`, `artifacts`, `locations`, `citations`, `sources`, `knowledge`, `skills`), with **one extra section per author-declared entity type inserted after the built-in entity sections** (`buildAuthorMaterialsSections` walks the *effective* type list — built-ins first, then valid author types in declared order). The tree item factory **nests every entity section (built-in AND author) under one collapsible "Entities" group node** (mirroring the on-disk `entities/` folder) and adds the `entities/types.yaml` leaf there; built-in section labels are localized while an author section renders its **`label` verbatim** (it is the author's own language). Each header renders `Label (count)` via `formatSectionLabel` (only **Manuscript** starts expanded). Files surface only via **`isAllowedMaterialFile`** (documents `.md .markdown .txt .pdf .doc .docx .odt .rtf .epub .html .htm`, office `.xlsx .xls .ods .pptx .ppt`, images `.png .jpg .jpeg .gif .svg .webp .tif .tiff .bmp`, diagrams `.excalidraw`, structural `.yaml .yml .json .jsonl`; dotfiles rejected; Knowledge narrows to `.yaml/.yml/.md`). Entity/Citation/Skill items are flat; **Sources and Knowledge keep nested folder structure** (`buildMaterialFileTree`, empty folders pruned). Book **Skills** are scanned from `.prompts/skills/<slug>/SKILL.md` (`scanSkills`, frontmatter `name`/`description`, folder-slug fallback) — the same files Theia's `SkillService` offers in the chat. Per-kind codicon accents in `style/index.css`.

**Status bar contributions** (`FrontendApplicationContribution`s):
- **AI profile** (`ai-focused-editor.ai-profile-status`, right, priority 120): alias mode reads `$(symbol-misc) [$(pin) ]AI: <alias> · <endpoint>` (`$(pin)` when an endpoint is pinned); `$(warning) AI: configure` when incomplete. Click opens Model Config; tooltip lists alias/endpoint, pinned endpoint, failover-chain length, transport, API-key state, and skipped endpoints with reasons.
- **Git** (`ai-focused-editor.git-status`, left, priority 100): `$(source-control) <branch> •<dirty> ↑ahead ↓behind`; polls every 15 s + 1.5 s-debounced file-change refresh; read-only.

**Focus Mode** (`ai-focused-editor.focusMode.toggle`) collapses left/right/bottom panels around the editor. **Writing Mode** (`ai-focused-editor.writingMode.toggle`, `writing-mode-contribution.ts`): a writer-focused, **mobile-friendly** layout layer (body class `afe-writing-mode` suppresses chrome; collapses side/bottom panels); on a narrow viewport (`window.innerWidth < 700`) it suggests enabling itself once per session. Available as a Manuscript-menu command and an editor-toolbar button.

**Localization**: default (source) strings are English via `nls.localize`; a Russian language pack ships as **23 per-area JSON dicts** under `node/i18n/ru/` (`manuscript-ru-localization-contribution.ts`, `languagePack: true`) — one file per area (menu, create, build, book-config, sources, entities, ai-config, ai-log, ai-modes, editor, doctor, welcome, workspace, knowledge, git, chat-capabilities, chat-context, office, excalidraw, mcp, auth, mobile, manuscript-tree) so parallel work never touches the same file.

---

## Menu & Commands

The product menu lives under `MAIN_MENU_BAR` at path `['8_ai_focused_editor']`, label **Manuscript** (`ai-focused-editor-menu.ts`). The menu tree is registered by a **single central `registerSubmenu` block** in `ManuscriptWorkspaceMenuContribution.registerMenus`: the `MAIN` menu plus submenus — `2_semantic-markdown`, `3_build`, `4_knowledge`, `5_sources`, `6_ai-modes`, `7_ai-debug`. All other contributions only add `registerMenuAction`s (repeated `registerSubmenu` for the same path would create duplicate menu-bar entries — enforced by the `AFE-02-MENU-NO-DUPLICATES` UI flow check). The one other `registerSubmenu` lives in the editor context menu: `AiModeDynamicContribution` registers the dynamic **AI Modes** submenu (see *AI Stack*).

The browser registers **≈89 static commands** (`registerCommand` calls; category `AI Focused Editor` throughout) plus **dynamic per-mode run commands** (`ai-focused-editor.mode.run.<id>`, category **AI Modes**, one per `menu: true` mode, not counted). Key commands by area:

| Command id | Label | Menu / surface |
|------------|-------|----------------|
| `ai-focused-editor.welcome.open` | Open Welcome Page | Manuscript |
| `ai-focused-editor.book.newBook` | New Book… | Welcome + Manuscript |
| `ai-focused-editor.book.doctor` | Run Book Doctor | Manuscript + view toolbar |
| `ai-focused-editor.focusMode.toggle` | Toggle Focus Mode | Manuscript · `ctrlcmd+alt+f` |
| `ai-focused-editor.writingMode.toggle` | Toggle Writing Mode | Manuscript + editor toolbar |
| `outlineView:toggle` (built-in) | Chapter Outline | Manuscript |
| `ai-focused-editor.manuscriptTree.open` | Open Manuscript View | Manuscript |
| `ai-focused-editor.manuscriptTree.newChapter` | New Chapter… | Manuscript + tree ctx + toolbar |
| `ai-focused-editor.manuscriptTree.{moveUp,moveDown,toggleBuildInclusion,refresh}` | Move Up/Down · Include-Exclude · Refresh | tree ctx / toolbar |
| `ai-focused-editor.authorMaterials.{newEntity,newCharacter,newTerm,newArtifact,newLocation,newCitation,newKnowledgeNote,addSourceFile,newDiagram,newSkill}` | New Entity (any type) · New Character/Term/Artifact/Location · New Citation/Note · Add Source File · New Diagram · New Skill | tree section ctx + Manuscript |
| `ai-focused-editor.entities.generateRelationsMap` | Generate Relations Map… | Knowledge + Narrative Map toolbar |
| `ai-focused-editor.excalidraw.{splitText,mergeText,connectArrow,boxSelected,textToSticky,canvasActions}` | Split/Merge Text · Connect Arrow · Box Selected · Text to Sticky · Canvas Actions… | Excalidraw **Canvas** ctx submenu + editor toolbar |
| `ai-focused-editor.chat.{saveContextSet,applyContextSet,chapterWorkingSet}` | Save Context as Set… · Apply Context Set… · Work with Chapter… | Manuscript (AI/Chat group) + tree ctx |
| `ai-focused-editor.workspace.validate` | Validate Manuscript Workspace | Manuscript · `ctrlcmd+alt+v` |
| `ai-focused-editor.ai.improveSelection` | Improve Selected Text | Manuscript + editor ctx · `ctrlcmd+alt+i` |
| `ai-focused-editor.ai.{checkConsistency,copyManuscriptContext,verifyProfile,suggestCoreference,reviewChapter}` | Consistency · Copy Context · Verify · Coreference · Review Chapter | Manuscript + editor ctx |
| `ai-focused-editor.ai.switchAlias` / `.switchEndpoint` | Switch AI Alias… / Endpoint… | Manuscript (rotation) |
| `ai-focused-editor.chat.{addContext,sendSelection,capabilityPreset}` | Add to Chat Context · Send to AI Chat · Chat Capability Preset… | tree/editor ctx + AI menu |
| `ai-focused-editor.mcp.manageServers` | MCP Servers… | AI menu |
| `ai-focused-editor.auth.show-login-qr` | Show Login QR… | AI menu |
| `ai-focused-editor.git.initRepository` / `.addToGitignore` | Initialize Git Repository / Add to .gitignore | Manuscript / navigator ctx |
| `reset.layout` (built-in) | Reset Workbench Layout (This Folder) | Manuscript |
| `ai-focused-editor.semanticMarkdown.preview.{open,refresh,toggleTagChips}` | Open/Refresh Preview · Toggle Tag Chips | Manuscript + `.md` editor toolbar |
| `ai-focused-editor.semanticMarkdown.wrapSelectionAs{Character,Term,Artifact,Location}` | Wrap Selection as … Tag | Semantic Markdown + editor ctx |
| `ai-focused-editor.semanticMarkdown.saveSelectionAs{Character,Term,Artifact,Location}` | Save Selection as … (create entity + tag) | Semantic Markdown + editor ctx |
| `ai-focused-editor.semanticMarkdown.{copyTagSummary,normalizeTags,insertFootnote,revealFootnote}` | Copy Summary · Normalize · Insert Footnote · Reveal Footnote | Semantic Markdown |
| `ai-focused-editor.semanticLink.openTarget` | Open Semantic/Link Target | (link-provider `command:`) |
| `ai-focused-editor.modelConfig.open` / `.refresh` | Open / Refresh AI Model Config | Manuscript |
| `ai-focused-editor.bookBuild.{buildMarkdown,buildHtml,epub,pdf,openLastBuild,copyLastBuildPath,wizard}` | Build MD/HTML/EPUB/PDF · Open Last · Copy Path · Build Wizard… | Build (+ view toolbar) |
| `ai-focused-editor.knowledge.{summarizeChapter,generateScenePlan,generateAuthorQuestions}` | Summarize · Scene Plan · Author Questions | Knowledge |
| `ai-focused-editor.entities.openCards` / `.refreshCards` | Open / Refresh Knowledge Cards | Knowledge |
| `ai-focused-editor.entity.openFormEditor` / `.openRawYaml` | Open With Form Editor / Raw YAML | Knowledge + editor ctx |
| `ai-focused-editor.narrative.openMap` / `.refreshMap` | Open / Refresh Narrative Map | Knowledge |
| `ai-focused-editor.semantic-history.open` / `.refresh` | Open / Refresh Semantic History | Knowledge |
| `ai-focused-editor.config.editMetadata` / `.editManifest` | Edit Book Metadata… / Edit Manifest… | Manuscript (book-config) |
| `ai-focused-editor.sources.{open,refresh,attach,analyze,saveSelectionAsCitation,editCitations}` | Sources view · Attach · Analyze · Save Selection as Citation… · Edit Citations… | Sources + editor ctx |
| `ai-focused-editor.excerpts.editExcerpts` | Edit Excerpts… | Sources |
| `ai-focused-editor.office.openPreview` / `.openAsText` | Open Office Preview / Open as Text | editor ctx |
| `ai-focused-editor.aiModes.{show,copySummary,openFile,editModes,editGlobalModes}` | Show/Copy/Open Modes · Edit Book/Global Modes… | AI Modes |
| `ai-focused-editor.aiDebug.{open,refresh,copySnapshot}` | Open/Refresh AI Debug · Copy Snapshot | AI Debug |

**Keybindings** (`ManuscriptWorkspaceKeybindingContribution`): `ctrlcmd+alt+i` → Improve Selected Text (`editorTextFocus`); `ctrlcmd+alt+v` → Validate Manuscript Workspace; `ctrlcmd+alt+f` → Toggle Focus Mode.

**Tab-bar toolbars** (`TabBarToolbarContribution`s): Manuscript view (New Chapter, Refresh), Semantic Preview (Refresh), editor toolbar (Preview, Writing Mode, Book properties `bookConfig.toolbar.properties`, Build wizard `bookBuild.toolbar.wizard`, Book Doctor `bookDoctor.toolbar`), Excalidraw editor (**Canvas Actions…**), Narrative Map view (**Generate Relations Map…**).

Preferences (`ai-focused-editor-preferences.ts`, scope Folder unless noted). The connection model is **endpoints + aliases only** (legacy `profiles`/`activeProfile` keys removed): **`aiFocusedEditor.ai.endpoints`** (channels), **`.aliases`** (endpoint→model chains), **`.activeAlias`** (user default), **`.pinnedEndpoint`** (id pinned to the chain front), **`.apiKeys`** (User scope, keyed by endpoint id), **`.requestLog`** (`off|metadata|full` AI-request-log mode). Also **`.preview.showTagChips`** (default `true`), **`.welcome.showOnStartup`**, **`.library.path`** (My Books library folder).

---

## Editor Features

Semantic tag syntax (`@ai-focused-editor/semantic-markdown`): `SEMANTIC_TAG_PATTERN` = `[[kind:id|label]]`. Tag kinds: `char`, `term`, `artifact`, `location`. Registered against Monaco for `markdown`/`.md`:

- **Markdown grammar** (`markdown-language-contribution.ts`): registers the `markdown` language if absent, then a Monarch tokenizer (headers, blockquotes, lists, code fences, bold/italic, GFM strikethrough `~~…~~`, links/images, embedded HTML) plus a matching `LanguageConfiguration`. **KaTeX math highlighting**: a dedicated `@mathblock` state for `$$` fenced on its own line (spans lines until a closing `$$`), and inline `$$…$$` / `$…$` runs, all tokenized `variable.math`.
- **Decorations** (`semantic-markdown-decoration-service.ts`): each tag gets `afe-semantic-tag afe-semantic-tag-<kind>`; debounced 150 ms. **Hover** shows `<label> (id)` + entity summary/aliases/epithets from a 5 s-cached `NarrativeEntityService.getSnapshot()`.
- **Completion** (`semantic-markdown-completion-provider.ts`): trigger chars `[` and `:`; entity items `kind:id` + bare kind scaffolds.
- **Outline / document symbols** (`semantic-markdown-document-symbol-provider.ts`): heading hierarchy (ATX `#`…`######` → nested `DocumentSymbol`s, `SymbolKind.String`, detail `H1`…`H6`, fenced code skipped) with each section's **unique semantic entities nested beneath their heading** (`char→Class`, `term→Key`, `artifact→Object`, `location→Namespace`). Surfaced by Manuscript ▸ Chapter Outline.
- **Semantic-link navigation** (`semantic-link-contribution.ts`): a Monaco `LinkProvider` makes `[[kind:id|label]]` tags (and bare `[[id]]` forms) and standard relative Markdown links `[text](path)` clickable — `semanticLink.openTarget` opens the entity YAML / resolves the relative path + heading (`link-navigation.ts`; rejects `..` escapes).
- **Citation links** (`source-library-view-contribution.ts`): `CITATION_LINK_PATTERN` = `[@cite:id]` via a Monaco `LinkProvider`; resolves to the citation's `path`, else opens `sources/citations.yaml`.
- **Footnote navigation** (`footnote-link-contribution.ts` + `parseFootnotes`): every `[^id]` reference links to its `[^id]:` definition and each definition marker links back to the first reference (`revealFootnote`); `insertFootnote` inserts the next free `[^n]` marker + stub (`nextFootnoteNumber`).
- **Quick actions** (`semantic-markdown-actions-contribution.ts`): `wrapSelectionAs{Character,Term,Artifact,Location}` derive an id via `createSemanticEntityId` and insert a tag; `saveSelectionAs{…}` additionally scaffold the entity YAML file; `normalizeTags` lower-cases kind/trims id/collapses label whitespace; `copyTagSummary`; `validateSemanticMarkdown` diagnostics.
- **Image preview inlining** (`preview-images.ts`): the Semantic Preview rewrites relative / workspace-root image sources to `data:` URIs so images render offline (the browser target cannot load `file:` URIs).
- **KaTeX math preview** (`semantic-markdown-preview-widget.ts`): when the rendered Markdown contains a `$`, the widget lazily imports `katex` and walks the rendered-DOM text nodes with the shared `splitMathSegments`, rendering `$$…$$` (display) / `$…$` (inline) formulas in place (skipping code/pre/`.katex` subtrees; a monotonic generation token discards a superseded async render; a parse error degrades to an `afe-katex-error` span). KaTeX's stylesheet + woff2 fonts are served **offline** from `katex-assets/` (copied at bundle time by `scripts/copy-katex-assets.mjs`, CSP-safe, no CDN).

AI writer commands surface edits as **native Change Sets** (Accept/Reject) plus an immediate diff — `Improve Selected Text` and `Suggest Coreference Tags` never auto-rewrite (coreference guards against >±60 % length drift). **`AI Review Current Chapter`** opens/creates a chat session and `chatService.sendRequest`s an editorial-review prompt appended with `#chapter #entities`. `Check Consistency` publishes to Problems (owner `ai-focused-editor.consistency`); `Validate Manuscript Workspace` publishes schema diagnostics (owner `ai-focused-editor.workspace`); **live validation** (`live-validation-contribution.ts`) re-runs semantic checks debounced while editing.

---

## AI Stack

Bridges the app to [[theia-ai]] and [[language-models]] via `@vedmalex/ai-connect`.

**Transports** (`ai-connect-config.ts`): `api`, `acp`, `cli`, `server` (`proxy` normalizes to `api` at `http://127.0.0.1:8045`). The boundary:
- **`api` runs directly in the browser** — `BrowserAiConnectionService` calls `createBrowserClient(defineConfig(...))` from `@vedmalex/ai-connect/browser`. Plain HTTP fetch, no RPC.
- **`acp`/`cli`/`server` route to the backend** over JSON-RPC to `LocalAiConnectionService` → `NodeLocalAiConnectionService` (`createLocalClient`).

**Streaming push channel**: `LocalAiConnectionServicePath` is a **duplex** RPC — the frontend registers `LocalAiStreamClientImpl`; `NodeLocalAiConnectionService.startStream` emits `{type:'delta'|'result'|'end'|'error'}` events; `cancelStream` aborts. `BrowserAiConnectionService.streamLocalTransport` drains pushes into an async iterator.

**Two-level connection model** (`common/ai-alias-resolution.ts` + `common/ai-time-windows.ts` + `common/ai-verification.ts`, resolved by `ai-profile-preference-service.ts`, bound as `ModelProviderRegistry`) — **profiles are gone**; the model is now endpoints + aliases only:

- **Endpoints** (`StoredAiEndpoint`, pref `…endpoints`) are channels: `id`, `provider`, `transportKind`/`transportId`, `endpointUrl`, `command`, `env`, `enabled`, and **`timeWindows`**. Secrets never live on the endpoint; API keys live in the `apiKeys` User-scope map keyed by endpoint id. Also accepts ai-editor v1 fallback fields (`transport`, `url`/`endpoint`, `apiKey`/`token`).
- **Availability windows** (`isWithinWindows`/`parseTimeWindows`): `"09:00-18:00"` (daily), `"1-5 09:00-18:00"` (ISO weekday range, 1=Mon..7=Sun), `"6,7 10:00-14:00"` (weekday set), `"22:00-06:00"` (overnight, wraps past midnight). Local wall-clock; empty = always on; malformed skipped with a warning; all-malformed = fail-open.
- **Aliases** (`StoredAiAlias`, pref `…aliases`) are ordered chains of `{ endpointId, model }` legs. **`activeAlias`** (default = first) is the user default; **`pinnedEndpoint`** moves its legs to the chain front.
- **Resolution** (`resolveChainFromConfig`): reorder-for-pin, then emit an `AiConnectionProfile` per leg (`resolveEndpointLeg`, v1 fallbacks + user-scope secret) **unless** the endpoint is missing / `enabled:false` / outside its time window — collected in a **`skipped`** list with a `ChainSkipReason` (`missing-endpoint`|`disabled`|`outside-time-window`) surfaced in the status bar and Model Config.
- **Two-stage verification** (`ai-verification.ts`): stage 1 per endpoint (reachability + discovered model list); stage 2 per alias chain leg (connection state, whether the leg model is present in the discovered list, and a minimal test generation through that specific leg) → per-alias overall `ok|failed|unavailable|empty`.
- **v1 import** (`parseV1Import`): normalizes `rag-endpoints.json` + `rag-aliases.json` into endpoints/aliases with the exact fallbacks (`apiKey|token`, `url|endpoint`, `transport`, provider default `openai`), pulling secrets into `apiKeys`.

**Failover**: `generateWithFailover` (`ai-failover.ts`) tries the active alias chain in order, returns first success, aggregate error if all fail; the Theia AI streaming path retries onto the next leg only while nothing has been emitted.

**Rotation commands** (`ai-rotation-contribution.ts`): **Switch AI Alias…** sets `activeAlias`; **Switch AI Endpoint…** pins/clears an endpoint at the chain front. Quick-picks badge availability-now / disabled / window / malformed state, marking the active alias (`$(check)`) and pinned endpoint (`$(pin)`).

**Theia AI integration** (`ai-connect-theia-language-model.ts`): registers `AiConnectTheiaLanguageModel` (id `ai-focused-editor.ai-connect`) as a Theia `LanguageModelProvider`. Maps Theia messages/tools ↔ ai-connect; **tools** become ai-connect `clientTools` executed in-process (api only). **Provenance**: every request logged to AI history (`kind: 'theia-ai-language-model-request'`) with `sessionId`/`requestId`/`agentId`/`route`, bounded messages (`MAX_MESSAGE_CHARS = 4000`), tool names, response text (`MAX_RESPONSE_CHARS = 12000`), `warnings`, `usage`.

**AI Request Log** (`ai-request-log-service.ts`, pref `aiFocusedEditor.ai.requestLog` = `off|metadata|full`): an `AiFailoverRecorder` that records per-leg request outcomes (messages redactable by mode) to the AI history JSONL, surfaced in the AI Debug Request Log.

**Model discovery**: `discoverModels(profile)` flattens `report.routes[*].availableModels` → `{modelId, name, contextLength}`; drives the Model Config "Discover Models" button.

**Chat agent** (`manuscript-chat-agent-contribution.ts`): registers `CustomAgent` id **`ai-focused-editor.manuscript`** ("Manuscript"), backed by the ai-connect language model, prompt referencing `{{manuscript}}` + tools. **Chat capability presets** (`chat-capability-presets-contribution.ts`): writes per-agent `genericCapabilitySelections` (via `AISettingsService`) for the Manuscript agent so a writer can pick a coarse capability preset instead of the fine-grained tree. **MCP** (`mcp-controls-contribution.ts`, `@theia/ai-mcp`): `MCP Servers…` quick-pick lists configured servers + status and links to the `@theia/ai-mcp` Add-Server dialog / preferences.

**Chat artifact context** (`chat-context-actions-contribution.ts`): **Add to Chat Context** attaches a tree/editor artifact as an `AIContextVariable` (`#source`, `#note`, `#chapter`, `#entity`); **Send to AI Chat** (`chat.sendSelection`) sends the current selection into the active chat session.

**Context variables** (`manuscript-context-variable-contribution.ts`) — **eleven** [[context-variables|AI context variables]] (plus `#set` from the context-sets contribution → **twelve** total); each arg-taking variable registers a QuickPick argument picker + an inline `#var:` completion provider:

| Reference | name | Resolves to |
|-----------|------|-------------|
| `#manuscript` | `manuscript` | Whole-project context (`ManuscriptAiContextAssembler.assemble()`; **full or compact**, see below) |
| `#chapter[:path]` | `chapter` | One chapter's Markdown (≤ `MAX_CHAPTER_CHARS = 24000`); active editor or workspace-relative path |
| `#entity:id` | `entity` | One knowledge card by id/label, all fields |
| `#entities` | `entities` | Compact roster of every card |
| `#sources` | `sources` | Source files + citations + first-50 excerpts |
| `#outline` | `outline` | Manifest structure + heading outline of every included chapter |
| `#source:path` | `source` | Extracted text of one source document by path (PDF/Word/Office extracted server-side) |
| `#note:path` | `note` | One knowledge note (markdown/YAML) under `knowledge/` or `ai/` |
| `#citation:id` | `citation` | One `sources/citations.yaml` record — title/source/note + up to `MAX_CITATION_EXCERPTS = 12` related excerpts |
| `#excerpt:id` | `excerpt` | One `sources/excerpts.jsonl` excerpt — full text (≤ 8000), note, source, manuscript back-link |
| `#diagram:path` | `diagram` | An `.excalidraw` diagram distilled to model-readable text (`summarizeExcalidrawScene`: nodes + `afe-entity://` links + `A -> B` connections) |
| `#set:id` | `set` | A saved named context set (`ai/context-sets.yaml`) expanded to all its member variables, capped at `SET_MAX_CHARS = 64000` (cycle-guarded) |

**Tools** (`manuscript-tools-contribution.ts`) — **three read + three write**: read `manuscript_find_entities`, `manuscript_list_chapters`, `manuscript_get_chapter` (Markdown by path, ≤16000 chars, rejects `..`); write `manuscript_create_entity` (an `entities/<dir>/<id>.yaml` card, kind validated against the type registry, id defaults to a transliterated slug, refuses to overwrite), `manuscript_write_note` (a `knowledge/<category>/<slug>.md` note, may embed `$$…$$` KaTeX, unique-suffixed), `manuscript_create_diagram` (a `sources/<slug>.excalidraw` scene from a structured `{nodes,edges,texts}` spec via `diagramSpecToSkeleton` → `convertToExcalidrawElements`, entity nodes carry `afe-entity://kind/id` links). Each write tool returns concise JSON and never throws (`{ ok:false, error }`).

**Prompt fragments** ([[prompt-fragments]]): each resolved AI mode becomes a built-in prompt fragment `ai-focused-editor.project-mode.<id>`, exposed as chat command `afe-<id>`; re-synced on workspace/file changes (`ai-mode-prompt-fragment-contribution.ts`). A dedicated **diagram-author fragment** (`diagram-author-prompt-fragment-contribution.ts`, id `ai-focused-editor.diagram-author`, command `/afe-diagram-author`) teaches the agent to build diagrams via `manuscript_create_diagram` (spec format, entity-link strengthening, diagram-vs-note choice) and to write formulas as `$$…$$` KaTeX (Russian instruction body).

**Named context sets** (`chat-context-sets-contribution.ts`, `common/context-sets.ts`): **Save Context as Set…** writes the active chat's context variables to `ai/context-sets.yaml` (comment-preserving `upsertContextSetInYaml`, slugified id, validated against the known variable names); **Apply Context Set…** re-attaches every member onto the chat; the **`#set:<id>`** mention expands a set inline by resolving each member through the `AIVariableService` and concatenating `## <label>` sections (self-reference cycle-guarded).

**Chapter working set** (`chat-context-actions-contribution.ts`, `common/chapter-bundle.ts`): **Work with Chapter…** builds a de-duplicated bundle from a chapter's text + the citation/excerpt index (the chapter first, then its tagged entities, `[@cite:id]` citations, and referenced source files) and offers a multi-select to attach the chosen items as `#chapter`/`#entity`/`#citation`/`#source` chips in one action.

**Compact manuscript overview** (pref `aiFocusedEditor.ai.manuscriptOverview` = `full` | `compact`, default `full`): `full` keeps the historical `#manuscript` overview (every entity + source listed); `compact` (`assembleCompact`) drops the expansions, keeping the manifest skeleton + diagnostics + entity/source/note **counts** to trim the always-on agent context for large books.

**Author-defined AI modes (dynamic)** (`common/ai-mode-protocol.ts` + `ai-mode-dynamic-contribution.ts`). An `AiMode` may declare **`context`** (`selection`|`word`|`chapter`|`chat`), **`menu`** (editor context menu), **`apply`** (`replace`|`insert`|`chat`, resolved by `resolveAiModeApply`), **`agent`** (register as chat `@agent`), **`icon`** (codicon), plus `enabled`. Lifecycle:
- **Dynamic "AI Modes" submenu** in the editor context menu: one context-aware `ai-focused-editor.mode.run.<id>` command per `menu: true` mode.
- **Delivery**: `replace`/`insert` build a native Change Set diff; `chat` modes route via `ChatService.sendRequest` (prefixed `@<agent-name>` when the mode is an agent).
- **Chat `@agents`**: `agent: true` modes registered via `CustomAgentFactory` and **hot re-registered** on change; runs logged (`kind: 'ai-mode-run'`); re-synced (300 ms debounce) on `custom-modes.yaml` change.

**Three-layer AI-mode override** (`common/ai-mode-layering.ts`, `layerModes`): modes merge by id across three layers, lowest→highest precedence — **`built-in`** (bundled `node/ai/base-modes.yaml`, **8 modes**: `gv-interpret`, `gv-proof`, `gv-hermeneutics`, `gv-opponent`, `gv-essay`, `gv-print`, `gv-practical`, `gv-prosody`), **`global`** (`~/.ai-focused-editor/custom-modes.yaml`), **`book`** (`ai/prompts/custom-modes.yaml`). A higher layer replaces the whole record by id (no field merge); origin-tagged with `overrides`; `enabled:false` hides from menus/agents/pickers but still shows (disabled) in the form editor.

**AI modes** shipped in `examples/sample-book/ai/prompts/custom-modes.yaml` (book layer, `version: 1`): `improve-selection`, `explain-semantic-tags`, `consistency-check`, `summarize-chapter`, `plan-scenes`, `author-questions`, `coreference-tags`, `analyze-source`, plus showcase `rewrite-dialogue` (`context: selection`, `apply: replace`) and `lore-keeper` (`context: chat`, `agent: true`). Command handlers fall back to built-in prompts when a mode is absent.

---

## Knowledge System

Project knowledge is filesystem-first YAML, scanned by backend services and surfaced in views.

- **Entity type registry** (`common/entity-type-registry.ts`): the single source of truth for entity types. `BASE_ENTITY_TYPES` declares the four built-ins as data (id/tagKind/directory/label/section/icons + a form-field schema), deriving every previously-scattered `NarrativeEntityKind` literal + `Record` map. **Author-defined types** load from a book's `entities/types.yaml` (`parseEntityTypesYaml` — kebab-case id, required label, per-entry `tagKind`/`directory`/`icon`/`fields` defaults, machine-coded validation problems); `mergeEntityTypes` **appends** valid author types (origin `book`) after the built-ins (origin `built-in`) into an `EffectiveEntityType[]` — a built-in is **never** overridden (an id/tagKind/directory collision is a validation problem, not a shadow). The browser-side `EntityTypeRegistryService` caches the effective list + fires `onDidChange` so the tree, creation flow, tags, completions, and the schema-driven form re-render when the author edits the file.
- **Entities** (`entities/<directory>/*.yaml`, one directory per effective type). Shared optional fields: `aliases[]`, `epithets[]`, `speechPatterns[]`, `summary`, `backstory`, `arc`, `notes`. Label field `name` (character/artifact/location) or `term` (author types default to `name`). **Artifacts** add `ownership[]` = `{owner, from?, to?, note?}`. **Discovery is type-aware**: `NodeNarrativeEntityService.scan` parses `entities/types.yaml`, walks the **effective** directory list (built-in + author dirs via `entityDirectoryConfigs`), and returns the entities alongside `effectiveEntityTypes` + `typeProblems` on the snapshot (a missing dir is an info diagnostic; a types.yaml problem a warning). Created via **New …** commands (`entity-creation.ts`: `createSemanticEntityId` **transliterates Cyrillic→Latin** so a Russian label yields a tag-safe id, `buildEntityYaml`); edited via the **Entity Form Editor**; viewed in **Knowledge Cards**.
- **Narrative graph** (`NodeNarrativeGraphService`): timeline, artifact ownership transfers, co-occurrence relation graph (nodes capped at `NARRATIVE_GRAPH_NODE_CAP = 20`). Powers **Narrative Map**.
- **Relations map** (`relations-map-contribution.ts` + pure `common/relations-map.ts`): **Generate Relations Map…** renders the co-occurrence graph into `sources/relations-map.excalidraw` — one vertical zone per entity kind (registry order), clickable `afe-entity://` node links, arrows for relations. Runs are **idempotent**: `mergeRelationsMap` only appends newly-appeared entities/edges (below the existing content, preserving manual layout + the user's own drawings) and reports removed entities without ever purging them.
- **Knowledge generation** (FR-011): AI-generated `knowledge/summaries/`, `plans/`, `questions/`. Response coercion tolerates fenced/embedded JSON; chapter slug via `slugifyChapter`. **Knowledge notes** (`knowledge-templates.ts`): `New Knowledge Note` scaffolds a note body from a template kind.
- **AI mode registry** (`NodeAiModeRegistryService`): parses/layers `base-modes.yaml` + global + book `custom-modes.yaml` (`layerModes`), dedupes by id.

---

## Sources & Citations

`NodeSourceLibraryService` scans `sources/` and drives the **Sources** view + citation links.

- `sources/documents/`, `sources/images/` — raw files/subfolders, **scanned recursively** (`collectSourceItems`; only `isAllowedMaterialFile` types, dotfiles/empty dirs pruned; index files excluded).
- `sources/citations.yaml` — `CitationEntry {id, title, source?, note?, path?}`; targets of `[@cite:id]`. Edited by the **Citation Form Editor**.
- `sources/excerpts.jsonl` — one `SourceExcerpt {id, sourceId?, sourcePath?, text, note?, targetPath?, targetAnchor?, targetLine?}` per line. Edited by the **Excerpts Form Editor** (`excerpt-forms.ts`).
- **Attach** copies a picked file into `images/`/`documents/` by extension. **Analyze** runs the `analyze-source` AI mode, appending excerpts + merging citations (`source-analysis.ts`).
- **Save Selection as Citation** (editor ctx): derives a slug id + title, prompts, appends a `SourceExcerpt` (`targetLine` from selection) and merges a `CitationEntry` (comment-preserving `parseDocument`).
- **Add Source File** (`authorMaterials.addSourceFile`) imports a file into the sources tree. The read-only Sources view adds per-row **Copy** buttons.

---

## Build & Export

`BookBuildService` → `NodeBookBuildService`. Common front end: read `metadata.yaml` (title/author/language/**cover**), walk `manifest.yaml` `content[]` (or natural-sort fallback), filter `include:false`, read each chapter, run `validateSemanticMarkdown` + fatal build diagnostics. Default outputs under `build/`:

| Format | Output | Pipeline |
|--------|--------|----------|
| Markdown | `build/book.md` | Front-matter, `# Title`, generated TOC, chapters concatenated in build order |
| HTML | `build/book.html` | `markdown-it` (`html:false, linkify, typographer`), semantic tags stripped to labels; GFM tables + strikethrough; `markdownItTaskLists` renders `- [ ]`/`- [x]` as real disabled `<input type="checkbox">`; inline `<style>`, `<nav>` TOC |
| EPUB | `build/book.epub` | `EpubGenerator`: Markdown→`TelegraphNode`→XHTML, `content.opf`/`toc.ncx`/`style.css`, optional cover, hand-rolled ZIP; strikethrough→`<del>`, tables→`<table>`, task lists→`☐`/`☑` |
| PDF | `build/book.pdf` | Reuses the HTML render → `renderHtmlToPdf` (puppeteer-core, local Chrome, A4/A5, print CSS) |

GFM **task lists render per surface**: real HTML checkboxes for HTML/PDF, `☐`/`☑` glyphs for Semantic Preview and EPUB.

**Formula export per surface** (`node-book-build-service.ts` + `book-export/mathRendering.ts`): math is detected on the **raw** Markdown with the same shared `splitMathSegments`, swapped for private-use **sentinels** that survive the markdown-it / TelegraphNode pass untouched, then restored to export-ready markup — **HTML/PDF → KaTeX HTML** (`renderMathToHtml`, block math in `displayMode`), **EPUB → MathML** (`renderMathToMathML`, standards-based, zero font payload). The KaTeX stylesheet is inlined only when the book actually contains a formula (`bookHasMath`); for headless-Chrome PDF its woff2 fonts are embedded as base64 `data:` URIs (`getKatexCss`, cached) since the render has no asset host. A malformed formula degrades in place (`throwOnError:false`), never aborting the build; the Markdown build leaves `$$…$$` as literal source.

**New Book / build wizard** (`book-build-wizard-contribution.ts`): `book.newBook` materializes the full canonical scaffold (`book-scaffold.ts` — folders + seed files, `required`/`recommended` levels); `bookBuild.wizard` picks format + output path before building.

**Headless / background builds**: `BookBuildContribution` also implements `TaskContribution`/`TaskProvider`; `NodeBookBuildTaskRunner` (task type `ai-focused-editor.book-build`) spawns `node book-build-task-cli.js --format <fmt> <rootUri> [outputPath]` as a Theia terminal task; `book-build-task-cli.ts` is a DI-free CLI that instantiates `NodeBookBuildService`, prints `[SEVERITY] uri:line:col message` diagnostics, exit 1 on errors.

---

## Git & History

Interactive SCM is not yet wired; the app's own git surface is **read-only** (commits stay manual), with two writer-setup exceptions (init repo, add-to-gitignore).

- **Local git fork** — `packages/theia-git-fork` publishes **`@ai-focused-editor/git` 0.1.0**, a *temporary* fork of the deprecated `@theia/git@1.60.2` rebuilt against Theia platform `1.73.1` (both apps depend on it). Rationale (`FORK.md`): upstream `@theia/git@1.60.2` pulls a second `@theia/core` copy, and Theia's DI relies on shared singleton symbols, so a duplicate breaks contribution bindings. Drop plan: delete the package, remove the dep from both apps, drop the two root-script entries, `bun install`.
- **`GitStatusService`** (`node-git-status-service.ts`, path `…/git-status`): `getStatus(rootUri)` → `{isRepository, branch, dirtyCount, ahead, behind}`; **`initRepository(rootUri)`** → `git init` (no-op message when already a repo — the one write); `getSemanticHistory(rootUri, limit=50)` → commits touching `entities/`, `knowledge/`, `manifest.yaml`, `metadata.yaml` with per-file `{path, status(A/M/D/R), entityKind?, entityId?}`.
- **Git actions** (`git-actions-contribution.ts`): **Initialize Git Repository** and **Add to .gitignore** (navigator ctx via `UriAwareCommandHandler`/`SelectionService`, appends the workspace-relative path, creates `.gitignore` if absent).
- **Semantic History view** renders `getSemanticHistory` as per-commit change chips; entity chips open the file.

**Browser auth** (`node/browser-auth-*`, `auth-qr-contribution.ts`): an **optional, off-by-default** password gate for remote (non-loopback) browser access. `browser-auth-gate.ts` is a pure gate (loopback detection over IPv4/`::1`/IPv4-mapped IPv6 + cookie parse + enable/allow decision) fronting `browser-auth-service.ts` (login page, crypto, config); loopback peers are never gated. `Show Login QR…` (`auth.show-login-qr`) renders a scannable login QR (`qr-encode.ts`) so a phone can join the session.

---

## Workspace Conventions

Sample at `examples/sample-book/`; optional directories are info-diagnosed (not errors) when absent. The canonical scaffold is codified in `book-scaffold.ts` (used by both the New Book wizard and the Book Doctor).

```
<root>/
  manifest.yaml            # version + content[] tree (path, title, include, children) — build/nav order
  metadata.yaml            # title, language, author, cover: <image path>
  content/                 # chapter-NN.md, nested part-NN/ folders
  entities/
    types.yaml             # OPTIONAL author-declared entity types (read when present; not seeded)
    characters/*.yaml      # id, name, + shared fields
    terms/*.yaml           # id, term, + shared fields
    artifacts/*.yaml       # id, name, + shared fields, + ownership[] {owner,from?,to?,note?}
    locations/*.yaml       # id, name, + shared fields
    <author-type>/*.yaml   # one dir per type declared in types.yaml
  knowledge/
    summaries/ plans/ questions/   # FR-011 generated YAML (also *.md), + knowledge notes
  sources/
    documents/  images/    # raw source files (recursive subfolders)
    citations.yaml         # CitationEntry list
    excerpts.jsonl         # one SourceExcerpt JSON per line
    *.excalidraw           # diagrams (New Diagram, relations-map.excalidraw, agent-built)
  ai/
    prompts/custom-modes.yaml      # book-layer AI mode registry
    context-sets.yaml              # OPTIONAL named context sets (read when present; not seeded)
    chat/<YYYY-MM-DD>.jsonl        # AI request history (AiHistoryService)
    context-snapshots/<YYYY-MM-DD>.jsonl   # assembled-context snapshots
  .prompts/
    skills/<slug>/SKILL.md         # book-local AI skills (frontmatter name/description); seeded style-guide example
  build/
    book.md  book.html  book.epub  book.pdf
  cover.png                # referenced by metadata.yaml cover:
```

Built-in base AI modes live in `node/ai/base-modes.yaml`; user-global modes at `~/.ai-focused-editor/custom-modes.yaml`. The scaffold (`book-scaffold.ts`) seeds `.prompts/skills/style-guide/SKILL.md` as a worked example; `entities/types.yaml` and `ai/context-sets.yaml` are read-when-present conventions (not seeded — the tree's types.yaml leaf seeds itself on first open).

**Book Doctor** (`book-doctor.ts` + `book-doctor-contribution.ts`): inspects an existing workspace and reports two kinds of result — **auto-fixable gaps** (`BookDoctorFix`: a missing scaffold folder/file, or a manifest-referenced chapter absent on disk) the doctor offers to **create** (never deletes), and **report-only findings** (`BookDoctorFinding`: on-disk content the manifest omits, blank metadata, an unparseable sources file). **Manifest reconstruction** (`manifest-reconstruction.ts`): for an old folder whose chapters exist but `manifest.yaml` is missing or incomplete, `reconstructManifestEntries` rebuilds the manifest tree from content (dirs→parts, `.md`→chapters, numeric-prefix natural sort), `buildManifestYaml` for a `recreate`, and `appendEntriesToManifest` merges new entries comment-preservingly (`append`) into an existing manifest. **Entity discovery** (`entityCardMissingFixes` / `entityCardOrphanFindings` / `entityUnknownKindFindings` in `book-doctor.ts`): a full-text pass over manuscript candidates folds `[[kind:id|label]]` tag occurrences — tags whose registry/author type has no card become fixable **create-card** offers (name = most frequent tag label, else humanized id; mention count + first file in the description); cards never referenced and well-formed-but-undeclared tag kinds surface as findings (declared author types from `entities/types.yaml` count as known); bare kindless `[[id]]` tags count as references but never generate fixes. Note: the composite dedup key uses a `\u0000` separator (escaped in source — a literal NUL byte briefly made these files read as binary to grep/file).

`YamlSchemaValidator` (`common/yaml-schema-validator.ts`, Ajv) validates 6 schema kinds — `metadata`, `manifest`, `character`/`term`/`location`/`artifact`. **Auxiliary text linting**: `NodeManuscriptWorkspaceService` runs `validateSemanticMarkdown` recursively over `sources/**/*.md` and `knowledge/**/*.md` alongside manuscript content.

**Viewers**: both apps bundle **`@theia/mini-browser` 1.73.1** (in-app image/PDF viewer). Office documents (docx/xlsx/pptx) use the first-party **Office Preview** editor; `.excalidraw` uses the first-party Excalidraw editor. `@theia/preview` is deliberately not used (version-stalled at 1.72, would duplicate `@theia/core`).

**AI history** (`ai-history-service.ts` + `ai-history-log.ts`): append-only JSONL under `ai/chat/` and `ai/context-snapshots/`, day-named, serialized via a write queue. `parseHistoryJsonl` returns records newest-first, capped (`DEFAULT_HISTORY_LIMIT = 100`; negative disables), skipping malformed lines. Surfaced in the AI Debug Request Log.

---

## Services & RPC Map

Backend `ConnectionHandler`s registered in `manuscript-workspace-backend-module.ts`; frontend proxies via `ServiceConnectionProvider.createProxy` (see [[frontend-backend-separation]], [[dependency-injection]]). All paths under `/services/ai-focused-editor/`.

| Service symbol | RPC path | Backend impl | Frontend impl | Responsibility |
|----------------|----------|--------------|---------------|----------------|
| `ManuscriptWorkspaceBackendService` | `…/manuscript-workspace` | `NodeManuscriptWorkspaceService` | `BrowserManuscriptWorkspaceService` | Manifest tree read + mutations; lints content + aux `sources`/`knowledge` markdown |
| `NarrativeEntityBackendService` | `…/narrative-entity` | `NodeNarrativeEntityService` | `BrowserNarrativeEntityService` | Scan `entities/*` YAML across the **effective** (built-in + author) directory list: `getSnapshot`/`refresh` return entities + `effectiveEntityTypes` + `typeProblems` (from `entities/types.yaml`) |
| `NarrativeGraphBackendService` | `…/narrative-graph` | `NodeNarrativeGraphService` | `BrowserNarrativeGraphService` | Timeline / ownership / co-occurrence (cap 20) |
| `SourceLibraryBackendService` | `…/source-library` | `NodeSourceLibraryService` | `BrowserSourceLibraryService` | Recursive `sources/`, `citations.yaml`, `excerpts.jsonl` |
| `AiModeRegistryBackendService` | `…/ai-mode-registry` | `NodeAiModeRegistryService` | `BrowserAiModeRegistry` | Parse + layer base/global/book `custom-modes.yaml` |
| `OfficePreviewService` | `…/office-preview` | `NodeOfficePreviewService` | direct proxy | Parse docx/xlsx/pptx → preview payload (mammoth/xlsx/jszip) |
| `GitStatusService` | `…/git-status` | `NodeGitStatusService` | direct proxy | `getStatus`, **`initRepository`**, `getSemanticHistory` |
| `BookBuildService` | `…/book-build` | `NodeBookBuildService` | direct proxy | `buildMarkdown/Html/Epub/Pdf` (+ `NodeBookBuildTaskRunner`) |
| `LocalAiConnectionService` (+ `LocalAiStreamClient` callback) | `…/local-ai-connection` | `NodeLocalAiConnectionService` | direct proxy + `LocalAiStreamClientImpl` | `acp`/`cli`/`server` transports server-side; `generate`, `discoverModels`, `startStream`, `cancelStream` + streaming push |

Backend-only (node, no frontend proxy surface): browser-auth service/gate (`BackendApplicationContribution`), the RU localization contribution (`LocalizationContribution`). Browser-only (no RPC): `AiConnectionService` → `BrowserAiConnectionService`; `ModelProviderRegistry` → `AiProfilePreferenceService`; `AiConnectTheiaLanguageModel`; `AiHistoryService`; `AiRequestLogService`; `ManuscriptAiContextAssembler`; **`EntityTypeRegistryService`** (a dumb cache of the effective entity types, seeded with the built-ins and refreshed from narrative-entity snapshots by the tree model, with an `onDidChange` emitter its consumers subscribe to).

---

## Test Inventory

Runner: **`bun test`** (`bun:test`); root script `"test": "bun test packages"`. **872 tests pass, 0 fail, across 45 files** (`bun test packages` → 872 pass, 2228 `expect()` calls; a few files use parameterized `test` so per-file static declarations sum slightly lower). Chrome-/git-gated suites use `test.skipIf`/`describe.skipIf`. The **8 files new since wave 30** are marked ★.

| Test file | Tests | Covers |
|-----------|:----:|--------|
| `book-export/src/epub-generator.test.ts` | 10 | EPUB: nav tree, XHTML, OPF/NCX, cover embed, ZIP, GFM del/tables/footnotes |
| `book-export/src/markdown-converter.test.ts` | 3 | Markdown→`TelegraphNode` (strikethrough/tables/task glyphs) |
| ★ `book-export/src/math-rendering.test.ts` | 7 | `renderMathToHtml`/`renderMathToMathML` (inline/display); `getKatexCss` woff2 base64 embed |
| `book-export/src/pdf-generator.test.ts` | 6 | HTML→PDF via puppeteer (Chrome-gated) |
| `browser/ai-profile-status.test.ts` | 2 | Status-bar text/tooltip assembly (alias/pin/incomplete) |
| `browser/qr-encode.test.ts` | 4 | QR encoding for the browser-auth login QR |
| `browser/themes/themes.test.ts` | 5 | Bundled color-theme JSON validity |
| `common/ai-alias-resolution.test.ts` | 15 | `resolveEndpointLeg` v1 parity; `resolveChainFromConfig` (skips, pin, fallback); `parseV1Import` |
| `common/ai-connect-config.test.ts` | 17 | Proxy defaults; URL normalization; catalog; per-transport config-input; route selector |
| `common/ai-failover.test.ts` | 6 | `generateWithFailover`: success, fail-over records, aggregate, empty |
| `common/ai-history-log.test.ts` | 16 | `parseHistoryJsonl` + request-leg history record building |
| `common/ai-mode-forms.test.ts` | 30 | AI-mode form extraction/validation/round-trip (book + global layers) |
| `common/ai-mode-layering.test.ts` | 10 | `layerModes` three-layer merge (built-in/global/book), origin/overrides, enabled |
| `common/ai-time-windows.test.ts` | 19 | daily / weekday-set / weekday-range / overnight windows; malformed-skip; fail-open |
| `common/ai-verification.test.ts` | 16 | Two-stage verification verdict assembly (endpoint reachability + per-leg gen) |
| `common/author-materials.test.ts` | 23 | `buildAuthorMaterialsSections` (order incl. skills + author-type sections, counts, expand); `isAllowedMaterialFile`; nested vs flat |
| `common/book-catalog.test.ts` | 20 | `buildBookCatalog` My-Books coercion + sort (title/author/cover fallbacks) |
| `common/book-config-forms.test.ts` | 24 | `extractMetadataFields`/`validateMetadata`; `normalizeManifestPath` + manifest rows |
| `common/book-doctor.test.ts` | 54 | Doctor fixes vs report-only findings; scaffold gaps (incl. `.prompts/skills`); manifest-reconstruction fix metadata |
| `common/book-scaffold.test.ts` | 35 | Canonical scaffold entries, required/recommended, seed shaping, New-Book options |
| ★ `common/chapter-bundle.test.ts` | 8 | `buildChapterBundle` ordering/de-dup (chapter → entities → citations → sources) |
| ★ `common/context-sets.test.ts` | 15 | `parseContextSets`/`validateContextSet`/`slugifyContextSetId`/comment-preserving `upsertContextSetInYaml` |
| ★ `common/diagram-spec.test.ts` | 24 | `validateDiagramSpec`/`diagramSpecToSkeleton` (grid layout, arrows, entity links, errors) |
| ★ `common/diagram-summary.test.ts` | 13 | `summarizeExcalidrawScene` (nodes, bindings/nearest connections, entity-link parse, caps) |
| `common/entity-creation.test.ts` | 67 | `createSemanticEntityId` (Cyrillic transliteration, hash fallback); `buildEntityYaml`; kind dirs/labels; skill folder path |
| `common/entity-mentions.test.ts` | 7 | `extractEntityMentions`: `[[kind:id\|label]]` + bare `[[id]]` |
| ★ `common/entity-type-registry.test.ts` | 41 | `BASE_ENTITY_TYPES` derivations; `parseEntityTypesYaml` validation codes; `mergeEntityTypes` (author append, no override) |
| ★ `common/excalidraw-canvas-ops.test.ts` | 22 | Split/merge geometry, bounding box, box-around, arrow chains, sticky sizing |
| `common/excerpt-forms.test.ts` | 24 | `sources/excerpts.jsonl` form parse/serialize/validate |
| `common/knowledge-generation.test.ts` | 22 | `slugifyChapter`; JSON coercion (`coerceSummary/Plan/Questions`) |
| `common/knowledge-templates.test.ts` | 5 | Knowledge-note template bodies |
| `common/link-navigation.test.ts` | 29 | Semantic-tag/relative-link range + resolution; heading find; bare-tag parse; `..` guard |
| `common/manifest-reconstruction.test.ts` | 22 | `reconstructManifestEntries`/`buildManifestYaml`/`appendEntriesToManifest` |
| `common/office-preview.test.ts` | 17 | Strategy-by-extension; sheet cap; slide/number shaping; HTML assembly |
| `common/preview-images.test.ts` | 33 | Image-target lexing/classify (relative/workspace/external/data) + `data:` rewrite |
| ★ `common/relations-map.test.ts` | 19 | `layoutRelationsMap` (kind zones, stable ids); `buildEntityLink`/`parseEntityLink`; idempotent `mergeRelationsMap` |
| `common/source-analysis.test.ts` | 24 | `coerceSourceAnalysis`; normalize/dedupe excerpts + citations; excerpt records |
| `common/word-at-offset.test.ts` | 15 | `wordAtOffset` (drives the AI-mode `word` context) |
| `node/browser-auth-gate.test.ts` | 8 | Loopback detection, cookie parse, enable/allow gate decision |
| `node/node-book-build-service.test.ts` | 30 | Slug/natural sort; TOC/anchors; `include:false`; GFM checkboxes/tables; math (KaTeX HTML / MathML); EPUB zip; PDF magic (Chrome-gated) |
| `node/node-domain-knowledge-service.test.ts` | 47 | Entity/source-library/AI-mode-registry (recursive listing, effective author-type dirs, citations/excerpts, layering, diagnostics) |
| `node/node-git-status-service.test.ts` | 8 | `getSemanticHistory` on a scratch repo (git-gated) |
| `node/node-manuscript-workspace-service.test.ts` | 17 | Manifest mutations, build-inclusion, unicode-slug chapters, duplicate-path diagnostics |
| `node/node-narrative-graph-service.test.ts` | 8 | Timeline/appearance/co-occurrence/ownership; malformed-ownership diagnostics |
| `semantic-markdown/src/semantic-markdown.test.ts` | 25 | parse/render/validate/normalize + footnote parsing + `splitMathSegments` ($$/$ block/inline, code/escape guards) |

**UI flow pack** (`scripts/ui-flows`, `bun run test:ui:flows` → `run-flow-checks.sh` boots the browser app against `examples/sample-book` and drives the `playwright-flow-scenario-builder` runner over `afe-flow-pack.mjs`): **10 scenarios** — `AFE-01-SHELL-BOOT`, `AFE-02-MENU-NO-DUPLICATES` (single Manuscript menu), `AFE-03-MANUSCRIPT-TREE` (tree + ≥5 codicon icons), `AFE-04-EDITOR-PREVIEW` (semantic preview + rendered `data:image` img), `AFE-05-MODEL-CONFIG` (Endpoints/Aliases/Provider headings), `AFE-06-BUILD-MENU` (incl. `Build Book...`), `AFE-07-TREE-CREATE-CONTEXT-MENU` (per-section create), `AFE-08-MENU-BAR-CREATE-VISIBILITY` (create commands stay in the menu bar), `AFE-09-BOOK-MENU-AND-TOOLBAR` (book menu entries + view toolbar icons), `AFE-10-LOCALE-RU` (forces ru via `localStorage['localeId']`, asserts «Рукопись»/«Новая глава…»). The runner also kills any stale process on the port before booting.

---

### Related

[[theia-ai]] · [[theia-ai-agents]] · [[language-models]] · [[prompt-fragments]] · [[context-variables]] · [[contribution-points]] · [[widgets-and-views]] · [[dependency-injection]] · [[frontend-backend-separation]] · [[preferences-system]]
