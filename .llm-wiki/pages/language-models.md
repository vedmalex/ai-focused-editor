---
type: concept
slug: language-models
created_at: 2026-07-09T21:19:22Z
---
# Language Models

Theia AI treats LLM providers as **pluggable**. An [[theia-ai-agents|agent]] never talks to a vendor SDK directly; it declares a `LanguageModelRequirement` (a `purpose` such as `'chat'` and an `identifier` such as `'default/universal'`), and Theia AI routes the request to a registered model. Out of the box Theia AI ships providers for OpenAI-compatible services, Hugging Face, Ollama, and Llamafile, plus GitHub Copilot via `@theia/ai-copilot`. AI-powered tooling is a first-class, framework-level concern of the Theia platform, not a bolt-on.

## Adding a provider

Implement the `LanguageModel` interface (fields like `id`, `name`, `vendor`, `family`, `status`, and a `request(request: UserRequest): Promise<LanguageModelResponse>` method) and register it with the `LanguageModelRegistry`:

```typescript
this.languageModelRegistry.addLanguageModels([new OllamaModel()]);
```

Models may declare `reasoningSupport` (levels `off | minimal | low | medium | high | auto`), with defaults set via the `ai-features.reasoning.defaults` [[preferences-system|preference]].

## In This Project

`packages/manuscript-workspace/src/browser/ai-connect-theia-language-model.ts` defines `AiConnectTheiaLanguageModel`, an `@injectable()` class implementing Theia AI's `LanguageModel` interface. Its `id` is `ai-focused-editor.ai-connect`; it is the model the [[theia-ai-agents|Manuscript agent]] requests by id. Instead of a built-in vendor, it **delegates** every `request(...)` to the `@vedmalex/ai-connect` library through the project's own `AiConnectionService`, using the provider/model/API-key resolved from the configured AI profile (`AiProfilePreferenceService`) and logging turns to `AiHistoryService`. It converts between Theia AI's `LanguageModelMessage` / usage types and ai-connect's `MessageInput` / `UsageInfo`.

Registration in `manuscript-workspace-frontend-module.ts` uses the `LanguageModelProvider` [[contribution-points|contribution point]]:

```typescript
bind(AiConnectTheiaLanguageModel).toSelf().inSingletonScope();
bind(LanguageModelProvider).toDynamicValue(ctx => async () => [
  ctx.container.get(AiConnectTheiaLanguageModel)
]).inSingletonScope();
```

Because ai-connect supports several transport kinds (`api`, `proxy`, `acp`, `cli`, `server`) and can run against a Node-side `LocalAiConnectionService` over RPC, the actual model call may cross the [[frontend-backend-separation|frontend/backend boundary]] depending on the configured transport.

## Sources

- [theia-ai](./theia-ai.md)
- [theia-platform-overview](./theia-platform-overview.md)
