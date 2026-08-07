# Разведка REQ-005: mermaid-рендеринг в markdown (2026-07-22, advisory)

Итог разведочного агента (sonnet, read-only + web). Полный текст — ниже; для интейка будущей задачи.

## Вывод в одну строку

Плагинный путь мёртв (нет VS Code plugin host в сборке; bierner.markdown-mermaid документированно не работает под Theia — eclipse-theia/theia#14654). Рекомендация: **npm `mermaid` + lazy `import()` + DOM-постобработка по готовому прецеденту KaTeX** — работает поверх обеих markdown-поверхностей без форка Theia. Оценка **T2** (T3 при проблемах CSP).

## Текущее состояние (проверено по коду)

- `@theia/preview`/`@theia/markdown` в сборке НЕТ; `@theia/editor-preview` — не markdown-preview.
- Markdown рендерится в ДВУХ местах: (1) превью главы рукописи — `semantic-markdown-preview-widget.ts:12,201-202` через Theia `MarkdownRendererImpl` (markdown-it внутри, БЕЗ публичной точки расширения); (2) путеводитель Welcome — собственный markdown-it в `welcome-docs-renderer.ts:98-102` (полностью наш, расширяем).
- `document-preview-theia` — офисные форматы, к mermaid отношения не имеет.
- **Готовый прецедент для тяжёлых офлайн-библиотек — KaTeX**: lazy `import('katex')` (`semantic-markdown-preview-widget.ts:100-108`), запуск по наличию `$` в тексте (:445), ассеты копируются committed-скриптом `scripts/copy-katex-assets.mjs` (без CDN), рендер — ПОСТОБРАБОТКОЙ ГОТОВОГО DOM (:430-457), поэтому работает поверх любого markdown-движка. Тот же паттерн — Excalidraw (`copy-excalidraw-assets.mjs`, lazy import в `excalidraw-editor-widget.ts:130`).

## Варианты

| # | Вариант | Вердикт |
|---|---|---|
| A | VS Code-расширение через plugin host | НЕЖИЗНЕСПОСОБЕН: host отсутствует (нужен @theia/plugin-ext + open-vsx с нуля), и даже при нём расширение не рендерит под Theia (#14654) |
| B | npm mermaid, lazy import + DOM-постобработка (паттерн KaTeX), ОБЕ поверхности | РЕКОМЕНДОВАН: офлайн, оба таргета, без форка MarkdownRendererImpl, code-split бесплатно из динамического import (без правки gitignored esbuild.mjs — ISS-130 не задевается) |
| C | То же, но только welcome-путеводитель | Меньше периметр, но несогласованность: ```mermaid в главе рукописи не отрендерится |

## Риски и открытые вопросы (на VAN/CREATIVE будущей задачи)

1. **CSP/unsafe-eval**: ядро mermaid (bundled import, без CDN-загрузчика) вероятно чисто, но формально НЕ подтверждено — нужен тест с текущей CSP обоих таргетов. При неблагоприятном ответе объём смещается к T3.
2. **Вес ≥1 MB min** (v11 активно ужимается апстримом; проверить актуальную tree-shaken конфигурацию под нужные типы диаграмм). Лечится lazy-чанком.
3. **Единая утилита для двух поверхностей** (по аналогии с общим `splitMathSegments` между preview и PdfGenerator) — решить на CREATIVE/PLAN.
4. Ассет-скрипт по образцу `copy-katex-assets.mjs` (mermaid шрифты извне не тянет — SVG через D3; вероятно, скрипт не нужен вовсе — проверить).

## Затронутые файлы (справочно)

`welcome-docs-renderer.ts`, `semantic-markdown-preview-widget.ts`, `packages/manuscript-workspace/package.json`, `scripts/copy-katex-assets.mjs`, `scripts/copy-excalidraw-assets.mjs`, `apps/*/esbuild.mjs` (gitignored — ISS-130).

---

# Часть 2: дорасследование (вопросы пользователя + наводка theia-website)

## Главный факт (наводка подтвердилась)

**Theia 1.73.0 (наша версия 1.73.1 — совпадение день-в-день) ШТАТНО рендерит mermaid** в AI-чате: CHANGELOG «[ai-chat-ui] rendered mermaid diagrams in the ai chat #17686»; docs theia-website user_ai.md:1005-1009 (тулбар, collapse, source-toggle, zoom/pan, тема воркбенча). Реализация в `@theia/ai-chat-ui/lib/browser/chat-response-renderer/mermaid-rendering.*`: lazy `import('mermaid')`, `securityLevel:'strict'`, DOMPurify-санитизация SVG с закрытием сетевых утечек, синхронизация темы. **Уже физически в нашем node_modules** (мы держим @theia/ai-chat-ui 1.73.1; mermaid@11.16.0 в bun.lock транзитивом) — переиспользование добавляет ноль нового веса.

Экспортируется как переиспользуемое: `splitMermaidSegments` (regex-сегментация сырого markdown ДО любого движка), `MermaidViewer`/`MermaidDiagram` (React), `sanitizeDiagram`, `MarkdownWithMermaid` (компонент ровно для «сырой markdown вне чат-конвейера» — наш случай).

## Ответ на вопрос «а у markdown-it нет механизма?»

Механизм есть — `md.renderer.rules.fence` по infostring `mermaid`, но ВСЕ живые плагины лишь эмитят `<pre class="mermaid">` под клиентский `mermaid.run()` (синхронный рендер невозможен — mermaid асинхронный и требует DOM). npm-плагины: @markslides/markdown-it-mermaid (жив, но mermaid hard-dep без lazy), agoose77/liradb2000/markdown-it-mermaid (мертвы 3+ года), mermaid-it-markdown (это Vue-редактор, не плагин). Fence-путь НЕПРИМЕНИМ к превью главы: оно идёт через Theia MarkdownRenderer (Monaco-обёртка, «strips all html», без точки расширения) — сам Theia AI Chat по этой же причине завёл отдельный markdown-it.

## Ответ на вопрос «~/work/theia packages/preview?»

`@theia/preview` DEPRECATED с 1.73.0 (README + npm registry), в нашей сборке не подключён; его PreviewHandler-механизм есть, но точки расширения markdown-it внутри нет (только субклассирование) — не даёт экономии. Отклонён.

## Итоговая рекомендация: вариант B-новый (reuse вместо reinvent)

Переиспользовать экспорты `@theia/ai-chat-ui`: превью главы (SemanticMarkdownPreviewWidget — уже ReactWidget) → сегментированный рендер по образцу `MarkdownWithMermaid` (`splitMermaidSegments` + `<MermaidViewer>` — тулбар/zoom/pan «даром», UX согласован с AI-чатом); welcome-путеводитель (не-React) → low-level `sanitizeDiagram` + ручной `mermaid.render` в DOM-постобработке (KaTeX-паттерн). Оценка: **T2** (риск выродиться в T3 снизился — санитизация/lazy уже сделаны апстримом; остаточный CSP-вопрос неизменен). Новые риски: deep-import из недокументированного модуля (фиксировать версию + unit-тест на существование экспортов); DI-сервисы для MermaidViewer.
