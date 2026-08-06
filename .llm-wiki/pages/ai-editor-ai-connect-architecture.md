---
title: Архитектура ИИ-коннектора к Theia Platform в ai-editor-3
type: concept
tags: [ai-editor-3, ai, integration, language-model, telemetry]
created_at: 2026-07-21
updated_at: 2026-07-21
source: packages/ai-connect-theia/src/browser/ai-connect-frontend-module.ts
---

# Архитектура ИИ-коннектора к Theia Platform в ai-editor-3

Пакет `@ai-focused-editor/ai-connect-theia` осуществляет интеграцию внешних и локальных языковых моделей (LLM) с платформой Theia через стандартное расширение `@theia/ai-core`.

```mermaid
graph TD
    subgraph Theia UI [Theia UI & Commands]
        Chat[AI Chat Panel]
        Suggest[Inline Code Completion]
    end

    subgraph Registry [Theia AI Registry]
        LMR[LanguageModelRegistry]
        LMP[LanguageModelProvider]
    end

    subgraph Conn [ai-connect-theia]
        LangModel[AiConnectTheiaLanguageModel]
        AliasModel[AiConnectAliasLanguageModel]
        Prefs[AiConnectPreferenceContribution]
    end

    subgraph ExtService [External/Local Models API]
        Ollama[Local Ollama / Llama.cpp]
        Cloud[OpenAI / Anthropic API]
    end

    Theia UI -->|requests model from| LMR
    LMR -->|queries| LMP
    LMP -->|resolves to| LangModel & AliasModel
    LangModel -->|communicates with| ExtService
    AliasModel -->|communicates with| ExtService
```

## Ключевые интеграционные механизмы

### 1. Регистрация моделей в `LanguageModelProvider`
В `ai-connect-frontend-module` регистрируется кастомный провайдер `LanguageModelProvider`, который поставляет реализации `LanguageModel` для реестра Theia:

```typescript
bind(AiConnectTheiaLanguageModel).toSelf().inSingletonScope();
bind(LanguageModelProvider).toDynamicValue(ctx => async () => [
  ctx.container.get(AiConnectTheiaLanguageModel)
]).inSingletonScope();
```

Провайдер `LanguageModel` реализует методы `provideCompletion`, `streamCompletion` и управляет статусами доступности ИИ-ассистентов.

### 2. Поддержка псевдонимов моделей (`Aliases`)
Через `bindAiConnectAliasModel(bind)` динамически регистрируются прокси-классы моделей для каждого псевдонима модели, настроенного пользователем в настройках. Это позволяет динамически подменять провайдера "по умолчанию" на лету без необходимости перезагрузки IDE.

### 3. Логгирование и телеметрия использования ИИ
- **`AiRequestLogService`**: Логгирует все входящие/исходящие сетевые запросы к языковым моделям, фиксируя заголовки, параметры генерации, тайминги и ошибки.
- **`AiUsageWidget`**: Графическая панель, отображающая агрегированную статистику использования ИИ-токенов пользователем, помогая контролировать расходы и производительность моделей.

## Связанные концепции

- [[ai-editor-theia-integration]] — Общая карта интеграции Theia в редакторе
- [[language-models]] — Документация по работе с ИИ в Theia
- [[theia-ai]] — Общее описание Theia AI возможностей
