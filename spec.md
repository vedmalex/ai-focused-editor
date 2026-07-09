# AI Focused Editor on Theia Framework

**AI-native domain IDE for writers, translators, and long-form text engineers**
**Версия документа:** 2.0
**Дата:** 2026-07-09

---

## 1. Product Vision

### Слоган
**«Текст — в центре. Theia — как платформа. AI — как прозрачный ассистент.»**

### Для кого строится продукт
- Писатели художественной литературы (длинные формы)
- Переводчики художественной и философско-религиозной литературы (включая ведическую традицию)
- Авторы нон-фикшн и исторической прозы
- Редакторы, работающие с большими корпусами, источниками, персонажами, терминами и версионностью
- Команды, которым нужен одинаковый editor в desktop и cloud без fork UI/business-логики

### Главная идея
AI Focused Editor должен стать не отдельной Tauri-формой и не набором кастомных web components, а **domain-specific IDE на базе Theia Framework**: редактором для больших нарративных проектов, где рабочее пространство, команды, панели, файловая модель, AI-инструменты и расширения строятся на Theia extension architecture.

Theia дает нам готовую IDE-платформу: desktop/cloud shell, Monaco-based editing, workbench layout, командную систему, меню, keybindings, contribution points, dependency injection, workspace/file abstractions, extension модель и путь к AI-native tooling. Наш продукт должен использовать эти возможности как фундамент, а не воспроизводить их вручную.

### Почему Theia
- **Custom product, not generic editor:** Theia Platform предназначена для сборки собственных cloud/desktop IDE и domain tools.
- **Desktop + cloud:** один продуктовый слой должен запускаться как desktop-приложение и web/cloud IDE.
- **Extension-first архитектура:** manuscript, semantic model, AI chat, sources, export, git/history, review tools должны быть Theia extensions, а не монолитный `main.js`.
- **Contribution points вместо ручной UI-проводки:** команды, контекстные меню, side panels, toolbar, status bar, keybindings и views должны подключаться через Theia mechanisms.
- **DI/service boundaries:** внешняя среда, AI-провайдеры, индексаторы, файловая система, git, preview и export должны быть сервисами с интерфейсами и заменяемыми реализациями.
- **Theia AI как стратегический слой:** AI должен быть прозрачным, настраиваемым, multi-model и agent-friendly, с контролем данных и prompts.
- **VS Code/Open VSX ecosystem:** Markdown/YAML/Git tooling можно частично брать из экосистемы, не переписывая базовую IDE-функциональность.

### Основная философия
- **Authorial control first:** AI предлагает, анализирует и объясняет; пользователь подтверждает любые изменения текста.
- **Theia workbench, focused by default:** Theia дает мощность IDE, но продуктовый UX должен открываться в writer-first layout, а не в developer IDE clutter.
- **Project as knowledge workspace:** рукопись, персонажи, термины, источники, промпты, история, сборка и отчеты живут в одном workspace.
- **Semantic text, not just Markdown:** Markdown остается читаемым форматом, но поверх него строится слой сущностей, ссылок, coreference, consistency, timeline и provenance.
- **Everything is inspectable:** prompts, context, AI responses, source references, diffs and decisions должны быть доступны пользователю.
- **Extensible product core:** новые entity types, AI modes, проверочные агенты, источники и exporters добавляются как extensions/services.

---

## 2. Product Shape

### Не «режим внутри приложения», а Theia-based product
Целевой продукт: **AI Focused Editor IDE**, собранный как Theia application с набором first-party Theia extensions:

- `@ai-focused-editor/manuscript-workspace`
- `@ai-focused-editor/semantic-markdown`
- `@ai-focused-editor/narrative-knowledge`
- `@ai-focused-editor/ai-assistant`
- `@ai-focused-editor/sources`
- `@ai-focused-editor/book-build`
- `@ai-focused-editor/git-history`
- `@ai-focused-editor/model-config`

### Primary Workbench Modes
- **Focus Mode:** distraction-free manuscript editor, minimal chrome, optional preview.
- **Review Mode:** consistency findings, diffs, comments, AI review results, source-linked issues.
- **Knowledge Mode:** characters, artifacts, terms, locations, timeline, relationship graph.
- **Sources Mode:** images, PDFs, references, citations, excerpts, source provenance.
- **Build Mode:** manifest, chapter order, compilation, TOC, export targets.
- **AI Debug Mode:** complete context inspection: system prompt, memory, selected artifacts, provider, model, tokens, request/response history.

### UX north star
Пользователь должен ощущать не «IDE для программиста», а **writing cockpit**:

- слева управляемое дерево рукописи и источников;
- в центре Markdown/semantic editor;
- справа контекстные knowledge/AI panels;
- снизу status bar с git, AI-provider, branch, diagnostics, indexing state;
- commands доступны через palette/keybindings/context menu;
- layout сохраняется per workspace;
- preview может быть рядом, отдельной вкладкой, отдельным Theia widget или отдельным окном/route.

---

## 3. Theia Architecture Vision

### 3.1. Application shell
Собираем кастомное Theia application, а не пытаемся встроить текущий UI как monolithic page.

Target packages:

```text
apps/
  browser/                  # Cloud/web Theia app
  electron/                 # Desktop Theia app if Electron route is chosen
packages/
  manuscript-workspace/
  semantic-markdown/
  narrative-knowledge/
  ai-assistant/
  sources/
  book-build/
  git-history/
  model-config/
```

### 3.2. Extension boundaries
Каждая крупная область продукта должна быть extension with frontend/backend modules.

Frontend responsibilities:
- widgets/views;
- commands/menus/keybindings;
- editor decorations;
- preview rendering;
- quick-pick/palette workflows;
- status bar items;
- drag-and-drop UI state.

Backend responsibilities:
- workspace scanning;
- metadata/manifest updates;
- AI request orchestration;
- source parsing/indexing;
- git status/diff integration;
- export/compile jobs;
- append-only history.

### 3.3. Services and dependency injection
Theia DI is the primary boundary mechanism. Product code should depend on interfaces, not concrete environment APIs.

Core services:
- `ManuscriptWorkspaceService`
- `ContentTreeService`
- `SemanticMarkdownService`
- `NarrativeEntityService`
- `ArtifactTimelineService`
- `SourceLibraryService`
- `AIAssistantService`
- `AIContextAssembler`
- `ModelProviderRegistry`
- `BookManifestService`
- `BookBuildService`
- `HistoryService`
- `DiagnosticsService`

Rule: no UI component directly calls filesystem, git, provider APIs, global window, Tauri/Electron APIs, or DOM-order-as-state. All side effects go through services.

### 3.4. Theia contribution points and systems to use
- **LSP (Language Server Protocol):** Линтинг Markdown, валидация YAML-схем сущностей, автодополнение семантических тегов (`[[char:...]]`) должны реализовываться через выделенный LSP-сервер для разгрузки UI-потока.
- **Task System (`@theia/task`):** Процесс сборки и экспорта книги (Build/Export) должен регистрироваться через `TaskProvider`, чтобы использовать нативные панели вывода (Output), управление фоновыми задачами и логирование.
- **Outline / Document Symbol Provider:** Семантические теги внутри текста должны поставляться в Theia как `DocumentSymbol`, чтобы штатная панель Outline автоматически показывала структуру сущностей в текущей главе.
- **Built-in SCM (`@theia/scm`, `@theia/git`):** Базовые операции контроля версий делегируются встроенным механизмам Theia. Собственный код требуется только для семантической истории (story-level provenance).
- Стандартные точки расширения: Command contributions, Menu/Keybinding contributions, View/widget contributions, Status bar, Editor decorations.

### 3.5. Theia AI Framework Integration
Продукт интегрируется с **Theia AI**, используя ее официальные точки расширения, а не выстраивая параллельный слой:
- **Language Models:** Провайдеры реализуют интерфейс `LanguageModel` из `@theia/ai-core` и регистрируются через `LanguageModelRegistry`. Это позволяет кастомному `ai-connect` транспорту бесшовно участвовать в системном выборе моделей.
- **Agents:** Доменные агенты (например, `Manuscript`) регистрируются как `ChatAgent` / `Agent`, поддерживая как диалоговый режим (`@Manuscript`), так и вызовы через slash-команды.
- **Context Variables:** Использование `AIVariableContribution` для переменной `#manuscript`. Theia AI автоматически обрабатывает прикрепление, суммаризацию и контекст.
- **Change Sets (Наборы изменений):** Команды вроде "Improve Selected" генерируют *Change Sets* Theia AI, предоставляя пользователю нативный UI сравнения (diff) и кнопки Accept/Reject вместо работы через буфер обмена.
- **Prompt Fragments:** Ключевые режимы из `custom-modes.yaml` регистрируются как `PromptFragment` через `PromptService` для видимости в системе управления промптами Theia.
- **Tools / Function Calling:** Поиск сущностей, цитирование и проверки консистентности (в будущем) должны предоставляться агенту через реализацию `ToolProvider`.

---

## 4. Domain Workspace Model

### 4.1. Colocated manuscript workspace
Theia workspace root remains the user project folder. The product owns a domain convention inside it:

```text
MyBook/
  content/
    chapter-01.md
    part-01/chapter-02.md
  entities/
    characters/*.yaml
    artifacts/*.yaml
    terms/*.yaml
    locations/*.yaml
  knowledge/
    summaries/*.yaml
    plans/*.yaml
    consistency/*.jsonl
    timeline/*.yaml
  sources/
    images/
    documents/
    citations.yaml
    excerpts.jsonl
  ai/
    prompts/custom-modes.yaml
    chat/*.jsonl
    context-snapshots/*.jsonl
  metadata.yaml
  manifest.yaml
  .editorconfig
```

### 4.2. Manifest and content tree
`metadata.yaml` / `manifest.yaml` must represent hierarchical content order, build inclusion, book metadata, export settings, and source-of-truth state for manuscript tree ordering. UI drag-and-drop must never persist by reading mutated DOM order.

### 4.3. Semantic markup
Primary syntax stays explicit and portable:

```markdown
[[char:krishna|Кришна]] сказал: «Тот, кто стоит передо мной...»
[[char:krishna|Он]] повернулся к [[char:arjuna|Арджуне]].
[[artifact:gandiva|Гандива]] была передана Арджуне.
[[term:dharma|дхарма]] раскрывается в контексте сцены.
```

The Theia editor layer renders this through decorations, hover providers, preview widgets and quick actions, while the markdown file remains human-readable.

---

## 5. Core Product Capabilities

### 5.1. Manuscript editing
- Monaco/Theia editor for Markdown and semantic Markdown.
- Focus layout with minimal chrome.
- Live preview as a Theia widget.
- Separate preview tab/window route.
- File tree with stable state-driven ordering, folder nesting, manifest sync, conflict-safe moves.
- Formatting and linting for Markdown/YAML with semantic tag awareness.

### 5.2. Narrative knowledge system
- Character cards with alternative names, epithets, backstory, arc, speech patterns.
- Artifact cards with ownership, transfer history and timeline relevance.
- Terms/glossary with tooltip rendering.
- Locations and scene metadata as first-class extensible entity types.
- Relationship graph and timeline views.

### 5.3. AI assistance
- Contextual AI chat with manuscript/entity/source memory via `#manuscript` variable.
- `Improve selected` action generates **Theia AI Change Sets** providing inline diff previews and explicit Accept/Reject user controls.
- Coreference suggestions with explicit confirmation via Change Sets.
- Consistency checks with paragraph/file/source links (exposed via Theia markers/problems).
- Chapter summaries, plans and author questions.
- User-defined AI modes stored in project prompts and registered as Theia `PromptFragments`.
- AI transparency: All AI calls go through the registered `LanguageModel`, appending history under `ai/chat/` for provenance.
- Custom AI Debug view complements Theia's built-in AI configuration to inspect assembled manuscript context.

### 5.4. Sources and citations
- Attach images, maps, PDFs and external documents.
- Extract and re-analyze source documents.
- Maintain `citations.yaml` and source excerpts.
- Link source fragments to manuscript paragraphs and entity facts.

### 5.5. Build and export
- Manifest-driven book compilation.
- Include/exclude chapters and sections.
- Generate TOC.
- Export Markdown first; HTML/EPUB/PDF later.
- Build diagnostics before export.

### 5.6. Git and history
- Git branch/status in status bar.
- Changed files in sidebar.
- Diff view integration.
- User controls commits manually.
- Append-only chat/history/context snapshots for AI provenance.
- Per-file state restoration between navigation events.

---

## 6. Feature Request Matrix

### Purpose
This matrix is the public product backlog for the Theia-based editor. It is not a dump of internal task notes.

Each row is expressed as a business/user feature request and mapped to a Theia Platform implementation surface. Internal task history remains in the repository workflow system; this vision document deliberately omits current task names, task numbers, and request numbering.

The MVP must select from this matrix; it must not inherit the whole accumulated product backlog.

### MVP decision legend
- **MVP-Core:** required to prove the Theia product architecture and first useful writing workflow.
- **MVP-Thin:** allowed only as a minimal slice; deeper UX/data model work moves to post-MVP.
- **Post-MVP:** validated product feature, not part of the first Theia MVP.
- **Backlog:** useful feature request, lower priority or dependent on later product maturity.
- **Spike/Review:** investigation, architecture review, or risk-reduction work rather than a shipped user feature.
- **Superseded:** captured for provenance, not a direct implementation target.

| ID | Theia-platform feature request | User/business requirement | Theia Platform surface | MVP decision |
|---|---|---|---|---|
| FR-001 | Theia-based domain IDE shell | Users need a dedicated writing IDE that runs on Theia rather than a standalone prototype, so the product can reuse workbench, commands, widgets, desktop/cloud targets, and extension architecture. | Custom Theia application package, workbench shell, browser/desktop targets, first-party extension dependencies. | MVP-Core |
| FR-002 | Extension/service architecture | The product must be built from Theia extensions and injectable services so features can evolve without a monolithic browser entrypoint or direct environment coupling. | Theia extension modules, frontend/backend contribution modules, dependency-injected domain services, replaceable service interfaces. | MVP-Core |
| FR-003 | Colocated manuscript workspace | Users need one portable project folder containing manuscript, entities, sources, prompts, metadata, and generated knowledge. | Theia workspace APIs, file service, backend workspace service, workspace preferences, schema contributions. | MVP-Core |
| FR-004 | Manuscript tree and manifest ordering | Users need reliable chapter/folder navigation, nested structure, drag/drop moves, build inclusion, and manifest-backed ordering without phantom/duplicate file entries. | Custom tree view widget, navigator contribution, commands/menus, backend manifest service, controlled drag/drop controller. | MVP-Core |
| FR-005 | Semantic Markdown editor and preview | Users need Markdown editing with live preview and visible semantic markup for characters, terms, artifacts, and annotations. | Monaco/editor contribution, language decorations, hovers, preview widget, opener and command contributions. | MVP-Core |
| FR-006 | Character and glossary knowledge base | Writers and translators need editable character and term cards with alternate names, epithets, backstory, speech traits, and tooltips. | Custom entity views/widgets, YAML-backed entity service, quick-input commands, editor hover providers. | MVP-Thin |
| FR-007 | Artifact ownership and timeline model | Users working with complex narratives need artifacts/items tracked by ownership, transfer history, and timeline relevance. | Domain graph/timeline widget, backend artifact service, entity relation index, command contributions. | Post-MVP |
| FR-008 | Contextual AI chat with project memory | Users need AI chat that understands the manuscript, glossary, characters, sources, and selected context without losing author control. | Theia AI/chat view, backend AI service, context assembler service, chat history store, command contributions. | MVP-Thin |
| FR-009 | `Improve selected` via Change Sets | Users need quick actions on selected text. The UX must provide native diff views to review, accept, or reject AI proposals. | Theia AI **Change Sets**, Editor context-menu contribution. | MVP-Thin |
| FR-010 | AI consistency and coreference analysis | Users need AI assistance to identify pronoun/entity references and find story/logical contradictions with paragraph-level evidence. | Diagnostics provider, problems/review view, editor decorations, backend analysis jobs. | Post-MVP |
| FR-011 | Summaries, plans, and author questions | Users need generated chapter summaries, scene plans, and developmental questions to support long-form editing. | Backend generation service, command contribution, generated artifact view, workspace file writer. | Post-MVP |
| FR-012 | User-defined AI modes & Prompts | Power users need project-level custom AI checks/prompts that are versioned and reused across the IDE. | Preference contribution, prompt file service, **Theia `PromptService` (`PromptFragment`)**. | MVP-Thin |
| FR-013 | Provider/model configuration and verification | Users need configurable AI endpoints, aliases, failover chains, transport-aware settings, model loading, API-key UX, and allowed model lists. | Preferences/settings widget, model provider registry service, secure-secret adapter, status bar item, validation commands. | MVP-Core |
| FR-014 | AI transparency and debug mode | Users need to inspect the complete AI request context, system prompts, memory, provider/model choice, and response history for trust and debugging. | AI debug widget, request-log service, status bar contribution, command contribution. | Post-MVP |
| FR-015 | Sources and citations library | Users need to attach images, PDFs, maps, references, citations, excerpts, and link source facts back to text/entities. | Source library view, backend parser/indexer service, resource opener integration, link provider. | Post-MVP |
| FR-016 | Task-driven Book build/export | Users need manifest-driven compilation. Builds should run in the background without blocking the UI, showing detailed logs. | **`@theia/task` (TaskProvider)**, `@theia/output`, backend export service. | Post-MVP |
| FR-017 | Git status and semantic history | Users need standard SCM features + the ability to see how semantic entities changed over time. | **Built-in `@theia/scm`** for basics. Custom Timeline/History view for semantic entity diffs. | Post-MVP |
| FR-018 | LSP-based Validation & Linting | Users need YAML validation and Markdown linting with semantic syntax support *without blocking the editor UI thread*. | **Language Server Protocol (LSP)**, `@theia/markers`, JSON Schema contributions. | MVP-Thin |
| FR-019 | Settings and modal UX quality | Users need reliable theme persistence, provider/alias creation/cancel/clone workflows, custom modal dialogs, and unambiguous selected-state behavior. | Preferences UI, custom settings widgets, command/menu contributions, notification/dialog service. | Backlog |
| FR-020 | AI config list ordering | Users need manual drag/drop ordering for alias chains and stable provider/alias list behavior. | Settings tree/list widget, controlled drag/drop behavior, preference-backed ordering service. | Backlog |
| FR-021 | Separate preview surface | Users need live HTML preview in a separate independent tab/window/surface for focused writing and review. | Preview widget factory, opener service, layout/workbench contribution. | Backlog |
| FR-022 | Drag/drop architecture review | The team needs an evidence-backed architecture review of drag/drop and file-panel state integrity to avoid repeating phantom-entry bugs. | Architecture spike artifact, UI interaction test harness, deterministic drag/drop simulation scenarios. | Spike/Review |
| FR-023 | Theia migration decomposition | The team needs a migration path from current prototype code into Theia packages, focused modules, deterministic seams, and service boundaries. | Theia package topology, extension migration plan, service-boundary work units, test fixture strategy. | MVP-Core |
| FR-024 | Superseded intake seeds | Initial seed requests and superseded implementation directions should stay traceable internally but should not become product backlog items. | No runtime platform surface; retained only in internal workflow traceability. | Superseded |
| FR-025 | Form-based Entity Editors (Custom Editors) | Writers should edit Character/Term files via a beautiful form UI rather than raw YAML, keeping the file format pure. | Theia `WidgetFactory`, `OpenHandler` (Custom Editors API), React-based bindings. | Backlog |

### Recommended Theia MVP cut
The first MVP should carry only enough user-visible functionality to prove the Theia product direction:

| MVP lane | Included feature requests | What ships in the first MVP |
|---|---|---|
| Platform foundation | FR-001, FR-002, FR-023 | Custom Theia app, first-party extension skeleton, DI/service boundaries, browser target, migration seams. |
| Manuscript workspace | FR-003, FR-004 | Open colocated manuscript folder, show manuscript tree, edit files, persist manifest/content order through services. |
| Editor proof | FR-005 | Semantic Markdown editing plus live preview/decorations for a small tag subset. |
| AI proof | FR-008, FR-009, FR-012, FR-013 | Minimal provider config, one AI chat surface, one `Improve selected` command, project prompt loading. |
| Quality gates | FR-018 | Minimal YAML/Markdown validation path and deterministic test seams for MVP flows. |

Everything else remains a valid feature request, but belongs to post-MVP planning unless it becomes necessary to prove a core Theia architecture assumption.

---

## 7. MVP Definition for Theia-Based Build

### MVP must prove
The MVP is successful only if it proves that Theia is the right product platform, not merely that the current prototype can be embedded in a webview.

### MVP scope
- Custom Theia application boots in browser mode.
- At least one first-party extension contributes:
  - manuscript tree view;
  - semantic Markdown editor behavior;
  - live preview widget;
  - AI chat widget;
  - model/provider settings view;
  - status bar provider/model/git indicators.
- Workspace opens a colocated manuscript folder.
- Files, folders and manifest order are edited through services, not DOM state.
- The editor supports semantic tags and preview decorations.
- AI requests use provider/alias configuration through a service boundary.
- `Improve selected`, chat and consistency check exist as Theia commands.
- Project settings, prompts and metadata are persisted in workspace files.
- The same domain services can run in desktop and browser app targets.

### MVP feature request scope
- In scope: FR-001, FR-002, FR-003, FR-004, FR-005, FR-008, FR-009, FR-012, FR-013, FR-018, FR-023.
- Explicitly out of first MVP unless needed as a technical proof: FR-006, FR-007, FR-010, FR-011, FR-014, FR-015, FR-016, FR-017, FR-019, FR-020, FR-021, FR-022, FR-025.
- Superseded/provenance-only: FR-024.

### Explicit non-goals for first Theia MVP
- No full Theia plugin marketplace UX.
- No complete clone of VS Code behavior.
- No opaque AI-autowrite mode.
- No migration of every current prototype screen before the Theia extension skeleton proves the architecture.
- No direct dependency from UI widgets to global browser/Tauri/Electron APIs.

---

## 8. Migration Strategy From Current Prototype

### Phase 1 — Architecture spike
- Create minimal Theia app.
- Create one `manuscript-workspace` extension.
- Port project loading/scanning behind `ManuscriptWorkspaceService`.
- Open Markdown files through Theia editor/workspace APIs.
- Render manuscript tree as Theia view.

### Phase 2 — Semantic editing
- Move semantic markdown parser into standalone package.
- Add editor decorations, hovers and preview rendering.
- Add entity card views as Theia widgets.
- Add YAML schema/validation path for entity files.

### Phase 3 — AI service layer
- Port provider/alias model into `ModelProviderRegistry`.
- Add AI commands and chat view.
- Implement context assembler with prompt caching order.
- Add AI debug view.

### Phase 4 — Build, sources and history
- Port manifest/build/export.
- Add source library view and citations.
- Add append-only chat history and context snapshots.
- Add git/diff integration.

### Phase 5 — Product hardening
- Stabilize drag-and-drop on Theia tree/view model.
- Add deterministic simulation seams for workspace actions.
- Add code review and architecture gates for extension boundaries.
- Package desktop/cloud variants.

---

## 9. Architectural Rules

- **Theia extension first:** every product area must be packaged as an extension with explicit frontend/backend modules.
- **Service interfaces first:** UI widgets consume services; services own filesystem, git, AI, indexing and export.
- **State source of truth:** workspace files, manifest and services own state; DOM never owns persisted order.
- **Command-driven workflows:** user operations must be addressable as commands for menus, keybindings, palette and tests.
- **Inspectable AI:** every AI action must expose prompt, context, provider, model, source refs and resulting diff.
- **Human-confirmed writes:** AI never mutates manuscript text without explicit user acceptance.
- **Desktop/cloud parity:** environment-specific behavior must sit behind adapters or Theia platform services.
- **Deterministic seams:** every behavior that can be simulated must have a pure command/service path and testable fixtures.
- **Don't reinvent standard tooling:** Прежде чем писать свой сервис (Git, поиск по файлам, сборка), используйте штатное API Theia (`@theia/scm`, `@theia/file-search`, `@theia/task`).
- **Offload heavy lifting to LSP/Backend:** Парсинг больших файлов, валидация YAML и семантического Markdown не должны выполняться синхронно во Frontend-модуле. Используйте Language Servers или RPC.
- **Theia AI extension points first:** Пользовательские модели, агенты, переменные контекста и тулы интегрируются через официальные интерфейсы Theia AI. Доменная логика наслаивается поверх, а не заменяет их.
- **Change Sets over Clipboard:** Любые мутации текста, предлагаемые AI (Improve, Translate, Fix), должны возвращаться как Theia AI Change Sets для обеспечения предпросмотра (diff) и явного контроля автором.

---

## 10. Source Notes

This vision uses current official Theia positioning:
- Theia Platform is a framework for custom cloud/desktop IDEs and tools: https://theia-ide.org/theia-platform/
- Theia supports AI-native tooling through Theia AI: https://theia-ide.org/docs/
- Theia applications are composed from Theia extensions and contribution points: https://theia-ide.org/docs/extensions/
- Theia services use dependency injection and can be replaced/overridden through DI bindings: https://theia-ide.org/docs/services_and_contributions/
- Theia IDE can serve as a starting/template product, but AI Focused Editor should be its own domain product: https://theia-ide.org/

---

## Appendix A. Requirement Intake Digest

This appendix records the product themes consolidated into the feature matrix without exposing internal workflow task names, task numbers, or request numbering. Detailed provenance stays in the repository workflow system, not in this product-facing vision.

- Manuscript authoring: focused Markdown editing, live preview, semantic tags, preview spacing quality, independent preview surfaces, and reusable editor components.
- Domain knowledge model: character cards, glossary terms, artifact ownership, sources, citations, manual artifact editing, colocated project files, and YAML-backed metadata.
- AI authoring assistance: contextual chat, project memory, selected-text actions, consistency review, coreference suggestions, summaries, plans, custom AI modes, prompt caching order, and transparent AI debug context.
- Provider and model configuration: endpoint/alias configuration, failover chains, transport-aware forms, API-key handling, model discovery, allowed-model lists, clone/cancel flows, and stable ordering.
- Workspace navigation and manifest control: chapter tree navigation, nested manuscript structure, manifest-backed ordering, final-build inclusion, file/folder moves, visible drop targets, collision handling, and state-consistent drag/drop.
- Platform architecture: Theia-first extension boundaries, dependency-injected services, environment adapters, deterministic command/service seams, frontend/backend separation, and clean module decomposition.
- Quality and verification: linting, formatting, YAML validation, Markdown validation with semantic syntax, rendered UI verification for visible state bugs, interaction simulation, and architecture review for high-risk UI state.
- Versioning and history: git branch/status visibility, changed-file surfacing, diff views, per-file state restoration, append-only chat history, and context snapshots.
- MVP control: the first Theia MVP should prove the platform architecture and one useful writing loop; advanced AI analysis, citations, export, deep history, and secondary settings polish remain valid but post-MVP unless they unblock the platform proof.
