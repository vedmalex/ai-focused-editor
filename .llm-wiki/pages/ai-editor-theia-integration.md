---
title: Карта интеграции Eclipse Theia API в ai-editor-3
type: concept
tags: [ai-editor-3, internal, architecture, theia-packages]
created_at: 2026-07-21
updated_at: 2026-07-21
source: package.json, packages/ai-connect-theia, packages/manuscript-workspace, packages/document-preview-theia
---

# Карта интеграции Eclipse Theia API в ai-editor-3

В кодовой базе `ai-editor-3` используется Eclipse Theia платформы **1.73.1**. Интеграция реализована через набор нативных расширений (Theia Native Extensions), расположенных в директории `packages/`.

```mermaid
graph TD
    subgraph Core Theia [Core Theia Platform 1.73.1]
        T_Core[@theia/core]
        T_Editor[@theia/editor]
        T_AI[@theia/ai-core]
        T_FS[@theia/filesystem]
        T_WS[@theia/workspace]
    end

    subgraph Custom Ext [Custom Extensions in ai-editor-3]
        AI_Conn[@ai-focused-editor/ai-connect-theia]
        MS_WS[@ai-focused-editor/manuscript-workspace]
        Doc_Prev[@ai-focused-editor/document-preview-theia]
        Git_Fork[@ai-focused-editor/git]
    end

    AI_Conn -->|implements| T_AI
    AI_Conn -->|implements| T_Core
    MS_WS -->|implements| T_Editor
    MS_WS -->|implements| T_Core
    MS_WS -->|implements| T_FS
    Doc_Prev -->|implements| T_Editor
    Git_Fork -->|fork of| T_Core
```

## Используемые модули Theia

### 1. `@theia/core` (Ядро платформы)
Предоставляет базовый интерфейс внедрения зависимостей (DI via `InversifyJS`), управление командами, меню, горячими клавишами и базовыми жизненными циклами приложения.
- **Используемые API**: `ContainerModule`, `CommandContribution`, `MenuContribution`, `KeybindingContribution`, `FrontendApplicationContribution`, `nls` (локализация), `URI`, `BinaryBuffer`.

### 2. `@theia/editor` (Управление Monaco Editor)
Отвечает за работу с текстовыми редакторами, отслеживание открытых файлов, интеграцию кастомных визуальных декораций.
- **Используемые API**: `EditorManager`, `EditorWidget`, `TextEditor`, `EditorDecoration`.
- **Где применяется**: Рендеринг разметки семантического Markdown в [`@ai-focused-editor/manuscript-workspace`]([[ai-editor-theia-integration]]).

### 3. `@theia/ai-core` и ИИ-пакеты
Набор расширений Theia AI для встраивания языковых моделей, MCP-клиентов и контекстных чатов.
- **Используемые API**: `LanguageModelProvider`, `LanguageModelRegistry`, `PromptService`, `LanguageModelAliasRegistry`.
- **Где применяется**: Загрузка провайдеров и проксирование запросов к локальным ИИ-моделям в [`@ai-focused-editor/ai-connect-theia`]([[ai-editor-ai-connect-architecture]]).

### 4. `@theia/filesystem` и `@theia/workspace`
- **Используемые API**: `FileService`, `WorkspaceService`, `FileDialogService`.
- **Применение**: Управление файлами рукописей, сохранение истории работы ИИ и конфигурационных файлов проекта.

## Связанные концепции

- [[ai-editor-ai-connect-architecture]] — Как устроена архитектура коннектора ИИ к Theia
- [[ai-editor-monaco-decorations]] — Отрисовка декораций семантической разметки в Monaco Editor
- [[dependency-injection]] — DI фреймворк InversifyJS в приложении
