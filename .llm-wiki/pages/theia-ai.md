---
type: summary
slug: theia-ai
source: raw/theia-ai
created_at: 2026-07-09T21:16:39Z
---
# Summary: Building Custom AI Assistants and AI Support with Theia AI

Theia AI is a framework for integrating tailored AI capabilities into Theia-based tools and IDEs. It is the layer we build on for the AI Focused Editor: it defines how **Agents** mediate between UI and LLM, how prompts are authored as reusable fragments, how dynamic data flows in via **Variables** and **Tool Functions**, how LLM output is rendered as custom UI, how proposed edits are surfaced as reviewable **Change Sets**, and how LLM providers are pluggable. Everything is wired through Inversify DI contribution bindings, consistent with core Theia (`bind(...).to(...)`, `rebind(...).toConstantValue(...)`).

## Creating Agents

An **Agent** collects context, produces prompts, handles LLM communication, and invokes tool actions or returns output to the UI. A **Chat Agent** plugs into Theia AI's default chat UI.

**Prompt fragment** — the system prompt is authored as a `BasePromptFragment` (from `@theia/ai-core`) with an `id` and a `template` string.

**Agent class** — extend `AbstractStreamParsingChatAgent` (from `@theia/ai-chat`). Key fields: `id`, `name`, `description`, `languageModelRequirements: LanguageModelRequirement[]` (each with `purpose` e.g. `'chat'` and an `identifier` e.g. `'default/universal'`), `defaultLanguageModelPurpose`, `prompts` (array of `{ id, defaultVariant }`), and `systemPromptId`.

**Registration** — bind the same class to two service tokens:
```typescript
bind(Agent).toService(CommandChatAgent);
bind(ChatAgent).toService(CommandChatAgent);
```

**Runtime prompt tuning** — prompt fragments can be edited at runtime in the running IDE to test scenarios without rebuilding. Important for prompt-evaluation workflows.

**Agent Modes** — an agent can declare `modes = [{ id, name }, ...]`; the chosen mode is read in `invoke()` via `request.request.modeId`, letting users control response style (e.g. concise vs. detailed).

**Capabilities** — toggleable behaviors shown as chips in the chat input, declared inside a prompt template with `{{capability:fragment-id [default on|off]}}`. Name/description come from the fragment's YAML frontmatter (`name:`, `description:`).

## Variables and Tool Functions

Agents fetch dynamic data through **Variables** and **Tool Functions**.

**Variables** are referenced in prompt templates via double braces `{{variableName}}`. Two kinds:
- **Agent-specific** — declared on `this.agentSpecificVariables = [{ name, description, usedInPrompt }]`, resolved by passing values to `this.promptService.getPrompt(templateId, { 'var-name': value })`.
- **Global** — available to all agents. Defined as an `AIVariable` (with `id`, `name`, `description`, optional `args`). Resolved by a contribution implementing `AIVariableContribution` + `AIVariableResolver`; `registerVariables(service: AIVariableService)` calls `service.registerResolver(VAR, this)`, and `resolve(request, context)` returns a `ResolvedAIVariable`. Bound with `bind(AIVariableContribution).to(...).inSingletonScope()`.

Built-in `productName` global variable resolves to the configured `applicationName`.

**Chat Context Variables** provide both a `value` (into the prompt) and a `contextValue` (added to `ChatRequestModel.context`); set `isContextVariable: true` on the `AIVariable`. A resolver implements `canResolve` (returns a numeric priority) and `resolve` returning `ResolvedAIContextVariable`. The file example injects `FileService` and `WorkspaceService`. Context UI can be toggled via `rebind(AIChatInputConfiguration).toConstantValue({ showContext, showPinnedAgent })`.

**Reasoning support** — models declare `reasoningSupport` listing levels `off | minimal | low | medium | high | auto`; defaults set via preference `ai-features.reasoning.defaults`.

**Tool Functions** let the LLM retrieve info or trigger actions. Referenced in prompts with tilde-brace syntax `~{functionId}`. Implemented as a `ToolProvider` whose `getTool()` returns a `ToolRequest` (`id`, `name`, `description`, JSON-schema `parameters`, and a `handler(arg_string)`). Bound with `bind(ToolProvider).to(FileContentFunction)`.

**Slash Commands** — invoke prompt templates via `/commandname arguments`. Metadata via `CommandPromptFragmentMetadata` (`isCommand: true`, `commandName`, `commandDescription`, `commandArgumentHint?`, `commandAgents?`). Registered programmatically through `PromptService.addBuiltInPromptFragment(...)`. Argument substitution: `$ARGUMENTS` (all), `$1 $2 $3` (positional).

## Custom Response Part Rendering

Turns LLM output into custom chat UI controls (React nodes):
1. **Reliable prompt** — instruct the model to emit structured output (e.g. stringified JSON `{ "type": "theia-command", "commandId": ... }`).
2. **Parse into response content** — e.g. `new CommandChatResponseContentImpl(theiaCommand)`; or register **content matchers** in a `@postConstruct` via `this.contentMatchers.push({ start, end, contentFactory })` (regex-delimited segments become distinct response contents like `QuestionResponseContentImpl`).
3. **Renderer** — implement a `ChatResponsePartRenderer` with `canHandle(response): number` (priority; `-1` = decline) and `render(response): ReactNode`. Bound with `bind(ChatResponsePartRenderer).to(...).inSingletonScope()`.

## Managing Chat Response State

A response carries `isComplete`, `isWaitingForInput`, `isError` (booleans). Progress via `request.response.addProgressMessage({ content, show: 'whileIncomplete' })` and `updateProgressMessage({ ..., status: 'completed' })`. To pause for user input, override `onResponseComplete(request)` and call `request.response.waitForInput()`.

## Custom LLM Provider

Out of the box: OpenAI-compatible services, Hugging Face, Ollama, Llamafile. To add one, implement the `LanguageModel` interface and register it: `this.languageModelRegistry.addLanguageModels([new OllamaModel()])` against the `LanguageModelRegistry`.

## GitHub Copilot Integration

`@theia/ai-copilot` provides Copilot support. Downstream products must register their own GitHub OAuth App — override with `rebind(CopilotOAuthConfig).toConstantValue({ clientId, ... })` and `rebind(CopilotAuthDialogMessages).toConstantValue({...})`. Preferences: `ai-features.copilot.enterpriseUrl`, `ai-features.copilot.enabled`.

## Change Sets

Change sets let agents propose file changes for user review/accept/refine/decline. In `invoke()`, build a `new ChangeSetImpl(label)`, add elements via `this.fileChangeFactory({ uri, type: 'add'|'modify'|'delete', state: 'pending', targetState, changeSet, chatSessionId })`, then `request.session.setChangeSet(changeSet)` and `request.response.complete()`. For domain-specific changes, implement the `ChangeSetElement` interface to reuse the existing review workflow. **Directly relevant to the AI Focused Editor / manuscript-workspace**: manuscript edits could be surfaced as custom `ChangeSetElement`s.

## Chat Suggestions

Guide users with contextual chips via `model.setSuggestions([...])`. Two kinds: **callback** (`{ kind: 'callback', callback, content }`, content is markdown with a `_callback` link) and **command-based** (`MarkdownStringImpl` with `command:${COMMAND.id}` links, e.g. `AI_CHAT_NEW_CHAT_WINDOW_COMMAND`).

## Key Entities

- `@theia/ai-core` — core AI package: prompt fragments, variables, tool providers, language-model registry.
- `@theia/ai-chat` — chat-agent base classes and chat response model.
- `@theia/ai-copilot` — GitHub Copilot integration package.
- `Agent` / `ChatAgent` — DI service tokens an agent is bound to.
- `AbstractStreamParsingChatAgent` — base class for chat agents; provides `invoke`, `onResponseComplete`, content matchers.
- `BasePromptFragment` — `{ id, template }` prompt fragment shape.
- `PromptService` — resolves prompts (`getPrompt`) and registers built-in fragments/slash commands (`addBuiltInPromptFragment`).
- `LanguageModelRequirement` — declares an agent's model need (`purpose`, `identifier`).
- `LanguageModel` / `LanguageModelRegistry` — interface + registry for pluggable LLM providers.
- `AIVariable` — descriptor for a variable (`id`, `name`, `description`, `args`, `isContextVariable`).
- `AIVariableContribution` / `AIVariableResolver` / `AIVariableService` — variable registration and resolution.
- `ResolvedAIVariable` / `ResolvedAIContextVariable` — resolver return types (context adds `contextValue`).
- `ToolProvider` / `ToolRequest` — tool-function contribution and its schema+handler.
- `CommandPromptFragmentMetadata` — slash-command metadata on a prompt fragment.
- `ChatResponsePartRenderer` — renders a response content to a React node.
- `contentMatchers` — regex-based splitters that map response segments to content types.
- `ChangeSetImpl` / `ChangeSetElement` / `fileChangeFactory` — proposed-edit review model.
- `AIChatInputConfiguration` — rebindable config for chat input (context/pinned-agent visibility).
- `MutableChatRequestModel` / `ChatRequestModelImpl` — the request object passed to `invoke`.
- `AIVariableContext` / `AIVariableResolutionRequest` — resolution inputs.
- `CopilotOAuthConfig` / `CopilotAuthDialogMessages` — rebindable Copilot auth config.

## Key Claims

- Theia AI components are wired via the same Inversify DI contribution pattern as core Theia; a chat agent is registered by binding one class to both `Agent` and `ChatAgent`.
- Prompt fragments can be modified at runtime in the running IDE, so prompt iteration does not require a rebuild.
- Prompt templates use `{{variable}}` for variables/capabilities and `~{functionId}` for tool functions; slash-command args substitute via `$ARGUMENTS` / `$1`, `$2`.
- Variables come in global (all agents) and agent-specific flavors; context variables additionally push a `contextValue` onto `ChatRequestModel.context`.
- Renderer selection is priority-based: `ChatResponsePartRenderer.canHandle` returns a number and the highest wins (`-1` declines).
- Response lifecycle is state-driven (`isComplete` / `isWaitingForInput` / `isError`) with progress messages and an explicit `waitForInput()` pause.
- LLM providers are pluggable by implementing `LanguageModel` and registering with `LanguageModelRegistry`; OpenAI-compatible, Hugging Face, Ollama, and Llamafile ship built-in.
- Change Sets provide a built-in accept/refine/decline review workflow that custom `ChangeSetElement`s can reuse for domain-specific edits.
- Several behaviors are configured through `ai-features.*` preferences (reasoning defaults, Copilot enterprise URL/enabled) and `rebind(...).toConstantValue(...)` overrides.

## Open Questions

- Exact package/version alignment: which `@theia/ai-*` package versions our manuscript-workspace should depend on, and API stability (`ChatRequestModelImpl` vs `MutableChatRequestModel` appear in different examples).
- How to model manuscript-domain edits as `ChangeSetElement`s (non-file, semantic-markdown changes) rather than plain file add/modify/delete.
- How agent-specific variables and tool functions should surface manuscript-workspace data (book structure, semantic symbols) — the doc only shows file/command examples.
- Where `default/universal` model identifiers come from and how to configure the actual provider/credentials for a domain IDE deployment.
- How prompt-fragment frontmatter/capabilities interact with our existing `ai-mode-prompt-fragment-contribution.ts` and `ai-profile-status-bar-contribution.ts` (present in the repo, not covered here).
- Whether Change Sets, Tool Functions, and Variables run in the frontend (browser) or need backend (node) services — DI examples don't state the module boundary.
