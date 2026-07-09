Оба мнения (и мое предыдущее, и второго агента) сходятся в одном: **архитектура вашего проекта уже сейчас является образцовой для предметно-ориентированной IDE на базе Theia**. Вы великолепно использовали внедрение зависимостей (DI), разделение на frontend/backend и интеграцию современных модулей Theia AI (`@theia/ai-core`, `@theia/ai-chat`).

Оба обзора дополняют друг друга:
1.  **Первый фокус (Core IDE):** Избавление от "изобретения велосипеда" в базовых вещах (свой Git-клиент, синхронная валидация в UI-потоке, кастомный раннер сборок).
2.  **Второй фокус (Theia AI):** Более глубокая, "нативная" интеграция с механизмами Theia AI (использование **Change Sets** вместо буфера обмена для предложений AI, регистрация промптов как **PromptFragments**, использование **ToolProviders**).

Ниже представлены **конкретные блоки изменений для файла `spec.md`**, которые синтезируют обе экспертизы и делают спецификацию идеальным планом развития "Theia-native" продукта.

---

### Обновления для `spec.md` (Готовые блоки для замены/вставки)

#### 1. Обновить и расширить раздел 3.4 и добавить 3.5
*Замените раздел 3.4 и добавьте 3.5, чтобы зафиксировать использование правильных базовых API и API искусственного интеллекта Theia:*

```markdown
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
```

#### 2. Обновить раздел 5.3 (AI assistance)
*Замените блок `5.3. AI assistance` на этот, чтобы отразить нативный UX:*

```markdown
### 5.3. AI assistance
- Contextual AI chat with manuscript/entity/source memory via `#manuscript` variable.
- `Improve selected` action generates **Theia AI Change Sets** providing inline diff previews and explicit Accept/Reject user controls.
- Coreference suggestions with explicit confirmation via Change Sets.
- Consistency checks with paragraph/file/source links (exposed via Theia markers/problems).
- Chapter summaries, plans and author questions.
- User-defined AI modes stored in project prompts and registered as Theia `PromptFragments`.
- AI transparency: All AI calls go through the registered `LanguageModel`, appending history under `ai/chat/` for provenance.
- Custom AI Debug view complements Theia's built-in AI configuration to inspect assembled manuscript context.
```

#### 3. Обновить 6. Feature Request Matrix
*Обновите статусы и описание для существующих FR и добавьте новый FR-025:*

| ID | Theia-platform feature request | User/business requirement | Theia Platform surface | MVP decision |
|---|---|---|---|---|
| FR-009 | `Improve selected` via Change Sets | Users need quick actions on selected text. The UX must provide native diff views to review, accept, or reject AI proposals. | Theia AI **Change Sets**, Editor context-menu contribution. | MVP-Thin |
| FR-012 | User-defined AI modes & Prompts | Power users need project-level custom AI checks/prompts that are versioned and reused across the IDE. | Preference contribution, prompt file service, **Theia `PromptService` (`PromptFragment`)**. | MVP-Thin |
| FR-016 | Task-driven Book build/export | Users need manifest-driven compilation. Builds should run in the background without blocking the UI, showing detailed logs. | **`@theia/task` (TaskProvider)**, `@theia/output`, backend export service. | Post-MVP |
| FR-017 | Git status and semantic history | Users need standard SCM features + the ability to see how semantic entities changed over time. | **Built-in `@theia/scm`** for basics. Custom Timeline/History view for semantic entity diffs. | Post-MVP |
| FR-018 | LSP-based Validation & Linting | Users need YAML validation and Markdown linting with semantic syntax support *without blocking the editor UI thread*. | **Language Server Protocol (LSP)**, `@theia/markers`, JSON Schema contributions. | MVP-Thin |
| FR-025 | Form-based Entity Editors (Custom Editors) | Writers should edit Character/Term files via a beautiful form UI rather than raw YAML, keeping the file format pure. | Theia `WidgetFactory`, `OpenHandler` (Custom Editors API), React-based bindings. | Backlog |

#### 4. Обновить 9. Architectural Rules
*Добавьте следующие правила в конец списка:*

```markdown
- **Don't reinvent standard tooling:** Прежде чем писать свой сервис (Git, поиск по файлам, сборка), используйте штатное API Theia (`@theia/scm`, `@theia/file-search`, `@theia/task`).
- **Offload heavy lifting to LSP/Backend:** Парсинг больших файлов, валидация YAML и семантического Markdown не должны выполняться синхронно во Frontend-модуле. Используйте Language Servers или RPC.
- **Theia AI extension points first:** Пользовательские модели, агенты, переменные контекста и тулы интегрируются через официальные интерфейсы Theia AI. Доменная логика наслаивается поверх, а не заменяет их.
- **Change Sets over Clipboard:** Любые мутации текста, предлагаемые AI (Improve, Translate, Fix), должны возвращаться как Theia AI Change Sets для обеспечения предпросмотра (diff) и явного контроля автором.
```

---

### Как это меняет ваш код (План на ближайшие итерации)

1.  **FR-009 (Improve Selected):**
    *   *Сейчас:* Код в `manuscript-workspace-contribution.ts` вызывает `editor.replaceText` или пишет в буфер обмена.
    *   *Нужно сделать:* Изучите API `@theia/ai-core` для работы с `ChangeSet`. Ваша команда "Improve Selected" должна создавать `ChangeSet` (набор предложенных правок) и передавать его в Theia. Theia сама откроет красивое окно Diff, где писатель нажмет галочку (Принять) или крестик (Отклонить).
2.  **FR-017 (Git):**
    *   Удалите папку `packages/manuscript-workspace/src/node/node-git-history-service.ts`.
    *   Убедитесь, что в `apps/browser/package.json` и `apps/electron/package.json` включены встроенные плагины (например, поддержка встроенного SCM уже идет через `@theia/scm`, убедитесь, что расширение Git от VS Code или нативное `@theia/git` подключено в конфигурации сборок). Статус-бар и диффы заработают сами.
3.  **FR-018 (Линтинг):**
    *   `YamlSchemaValidator` нужно вынести из UI-потока. В идеале создать простой `SemanticMarkdownLanguageServer` (на базе `vscode-languageserver`), который слушает изменения текста и отсылает `Diagnostic[]`. Theia подключит его через `LanguageClientContribution`.

Внесение этих обновлений в `spec.md` продемонстрирует глубочайшее понимание архитектуры Theia и сделает дальнейшую разработку максимально элегантной. Вы перестанете бороться с платформой и начнете использовать ее на 100%.
