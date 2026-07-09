Да, **обязательно нужно внести исправления в код и актуализировать `PROGRESS.md`**.

Поскольку мы изменили архитектурную парадигму со «свои кастомные сервисы для всего» на «Theia-native интеграция (LSP, Change Sets, Tasks, Built-in SCM)», некоторые задачи, которые в `PROGRESS.md` сейчас числятся как **Completed (Завершенные)**, по факту превратились в **Технический долг** или требуют глубокого рефакторинга. Их статус нужно откатить, а код — вычистить или переписать.

Ниже приведен подробный план: что именно удалить из кода, что переписать, и как актуализировать файл `PROGRESS.md`.

---

### Шаг 1. Актуализация `PROGRESS.md`

Вам нужно перенести ряд пунктов из раздела `## Completed` в раздел `## In Progress` (или создать новый подраздел `## Refactoring to Theia-native`), чтобы отразить реальное положение дел.

**Удалить из `## Completed` (или пометить как требующие переделки):**
*   ~~Safe AI replacement uses Theia editor `replaceText` with the original captured selection range.~~ *(Будет заменено на Change Sets)*
*   ~~YAML schema validation for metadata.yaml, manifest.yaml, character entities, and term entities.~~ *(Сделано в UI-потоке, нужно вынести в LSP/Backend)*
*   ~~Backend `GitHistoryService` exposed through Theia JSON-RPC and implemented over the Git CLI.~~ *(Нужно удалить, использовать штатный `@theia/scm`)*
*   ~~Git branch/dirty state surfaced through a Theia status bar contribution.~~ *(Делегировать Theia)*
*   ~~`AI Focused Editor: Open Current File Diff` command using Theia diff opener infrastructure.~~ *(Уже есть в Theia)*
*   ~~Read-only `HEAD` file content resolver for working-tree vs Git `HEAD` diffs.~~ *(Уже есть в Theia)*

**Добавить в `## In Progress` (План работ по рефакторингу):**
```markdown
## In Progress / Theia-Native Refactoring

- **[Refactor]** Port `Improve Selected` to use Theia AI **Change Sets** instead of manual `editor.replaceText` and clipboard injection.
- **[Refactor]** Remove custom `NodeGitHistoryService` and UI contributions. Enable and configure built-in `@theia/git` and `@theia/scm` for workspace branch/diff capabilities.
- **[Refactor]** Move YAML and Semantic Markdown parsing/validation (`YamlSchemaValidator`) out of the UI thread (Frontend) into a Backend service or dedicated LSP (Language Server).
- **[Refactor]** Integrate `BookBuildService` with Theia's Task API (`@theia/task`) to run background builds and output logs to the native Output panel.
- **[Feature]** Register key project AI modes from `custom-modes.yaml` as Theia AI `PromptFragment`s.
- **[Feature]** Implement `DocumentSymbolProvider` so semantic tags automatically populate the Theia Outline View.
```

---

### Шаг 2. Что нужно ИСПРАВИТЬ и УДАЛИТЬ в коде прямо сейчас

Чтобы кодовая база соответствовала новой спецификации, вам нужно провести "чистку".

#### 1. Выпилить собственный Git (FR-017)
Самописный Git-клиент на основе `execFile` больше не нужен. Theia умеет это лучше.

*   **Удалить файлы:**
    *   `packages/manuscript-workspace/src/browser/git-history-contribution.ts`
    *   `packages/manuscript-workspace/src/browser/git-history-resource.ts`
    *   `packages/manuscript-workspace/src/node/node-git-history-service.ts`
    *   Удалить `git-history-protocol.ts` из `src/common/`.
*   **Очистить модули:**
    *   Удалить биндинги Git из `manuscript-workspace-frontend-module.ts` и `manuscript-workspace-backend-module.ts`.
*   **Что добавить:** В `apps/browser/package.json` и `apps/electron/package.json` убедитесь, что добавлены расширения Theia для Git (обычно это использование стандартного плагина `vscode.git` через механизм плагинов Open VSX, либо встроенного `@theia/git`, если он используется в вашей версии платформы).

#### 2. Рефакторинг "Improve Selected" (FR-009)
Работа с буфером обмена и ручная замена текста (clipboard + `editor.replaceText`) — это плохой UX для AI в 2026 году.

*   **Где менять:** `packages/manuscript-workspace/src/browser/manuscript-workspace-contribution.ts`
*   **Что менять:** Внутри функции `improveSelectedText()`.
*   **Как делать по-новому:** Вместо вызова `this.aiConnection.generate(...)` и ручного `editor.replaceText(...)`, вам нужно взаимодействовать с `@theia/ai-core`. Нужно сгенерировать объект **Change Set** (Предложение изменений) и передать его в Theia. Theia сама откроет Diff-редактор: слева старый текст, справа — предложенный AI, и кнопки "Accept" (Принять) / "Discard" (Отклонить).

*Примерный концепт изменения (псевдокод):*
```typescript
// ВМЕСТО ЭТОГО:
// const replaced = await editor.replaceText({ ...text: improvedText });

// НУЖНО СДЕЛАТЬ ТАК:
// import { ChangeSetService, ChangeSet } from '@theia/ai-core';
const changeSet = this.changeSetService.createChangeSet('AI Improvement');
changeSet.addTextEdit(editor.uri, {
    range: selection,
    newText: improvedText
});
await this.changeSetService.preview(changeSet); // Откроет нативный Diff-UI
```

#### 3. Вынос валидатора из UI-потока (FR-018)
Сейчас `YamlSchemaValidator` инжектится во Frontend (`BrowserManuscriptWorkspaceService`). При открытии большой рукописи парсинг YAML и Markdown заморозит вкладку браузера.

*   **Где менять:** `packages/manuscript-workspace/src/browser/browser-manuscript-workspace-service.ts` и `packages/manuscript-workspace/src/browser/yaml-schema-validator.ts`.
*   **Что сделать сейчас:** В рамках текущей фазы (Phase 1 spike) перенесите `YamlSchemaValidator` в `packages/manuscript-workspace/src/node/` (на бэкенд).
*   Создайте RPC-метод (в `ManuscriptWorkspaceService` или отдельном сервисе), чтобы Frontend просто запрашивал: `backendValidator.validateWorkspace()`, а Backend возвращал список `Diagnostic[]`.
*   *В будущем (Post-MVP):* Это будет заменено на полноценный LSP-сервер.

#### 4. Рефакторинг Book Build (FR-016)
Сборка не должна блокироваться или висеть как простой `messages.showProgress`.

*   **Где менять:** `packages/manuscript-workspace/src/browser/book-build-contribution.ts`
*   **Что сделать:** Зарегистрировать сборку как Theia Task.
*   Имплементировать интерфейс `TaskProvider` из `@theia/task/lib/browser/task-provider`. Это позволит пользователю запускать сборку через "Terminal -> Run Task...", а все логи `console.log` из `NodeBookBuildService` будут красиво стримиться в панель Output / Terminal внутри Theia.

#### 5. Outline View для семантических тегов (Новая фича, быстрая победа)
Чтобы слева в дереве (или справа в панели Outline) появились персонажи:

*   Создайте файл `semantic-markdown-document-symbol-provider.ts` во Frontend.
*   Реализуйте интерфейс `DocumentSymbolProvider` из `@theia/editor/lib/browser/language/document-symbol-provider`.
*   Парсите Markdown, находите `[[char:...]]` и возвращайте их как `DocumentSymbol`.
*   Theia автоматически нарисует красивое дерево сущностей в текущей главе в стандартной панели `Outline`.

---

### Итог для вас

На данном этапе вам нужно:
1.  **Принять изменения в `spec.md`**, как мы обсудили ранее.
2.  **Обновить `PROGRESS.md`**, сбросив статус "Completed" для Git, Валидации и Improve Selected.
3.  **Удалить (Delete)** файлы кастомного Git.
4.  Сделать заглушки/комментарии `TODO: Refactor to Theia AI ChangeSets` в коде команд.

Такой "шаг назад" в коде — это абсолютно нормальная практика при разработке архитектурного спайка. Вы написали рабочий концепт, увидели, как он ложится на платформу, и теперь "срезаете" избыточный код, делегируя его ядру Theia. Это сделает ваш продукт легче, быстрее и дешевле в поддержке.
