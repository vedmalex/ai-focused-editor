---
type: concept
slug: theia-ai-agents
created_at: 2026-07-09T21:19:22Z
---
# Theia AI Agents

Theia AI is Theia's native, framework-level subsystem for building tailored AI capabilities into a tool or IDE. An **Agent** is the unit that mediates between the UI and an LLM: it collects context, produces prompts, handles LLM communication, and either invokes tool actions or returns output to the UI. A **Chat Agent** plugs into Theia AI's default chat UI. Everything wires through the same [[contribution-points|contribution]] + [[dependency-injection]] pattern as the rest of Theia (`bind(Agent).toService(...)`, `rebind(...).toConstantValue(...)`).

## Anatomy of a chat agent

The documented path is to extend `AbstractStreamParsingChatAgent` (from `@theia/ai-chat`). Key fields: `id`, `name`, `description`, `languageModelRequirements: LanguageModelRequirement[]` (each with a `purpose` such as `'chat'` and an `identifier` such as `'default/universal'`), `prompts` (array of `{ id, defaultVariant }`), and `systemPromptId`. The system prompt is authored as a reusable [[prompt-fragments|prompt fragment]]. Registration binds one class to two tokens:

```typescript
bind(Agent).toService(CommandChatAgent);
bind(ChatAgent).toService(CommandChatAgent);
```

An agent draws dynamic data through [[context-variables|Variables]] (`{{variableName}}`) and **Tool Functions** (`~{functionId}`). Related capabilities documented on the same source:

- **Agent Modes** — declare `modes = [{ id, name }]`; the chosen mode is read via `request.request.modeId`.
- **Capabilities** — toggleable chips declared in a prompt template with `{{capability:fragment-id [default on|off]}}`.
- **Tool Functions** — a `ToolProvider` whose `getTool()` returns a `ToolRequest` (`id`, `name`, `description`, JSON-schema `parameters`, `handler`). Bound `bind(ToolProvider).to(...)`.
- **Custom response rendering** — a `ChatResponsePartRenderer` (`canHandle` returns a priority number, `render` returns a React node) turns structured LLM output into custom chat UI; `contentMatchers` split responses into typed segments.
- **Response state** — `isComplete` / `isWaitingForInput` / `isError`, progress messages, and `waitForInput()`.
- **Change Sets** — the built-in accept/refine/decline review workflow (`ChangeSetImpl` / `ChangeSetElement` / `fileChangeFactory`) for agent-proposed edits. Directly relevant to the AI Focused Editor: manuscript edits could be surfaced as custom `ChangeSetElement`s to reuse this review flow.

## In This Project

`packages/manuscript-workspace/src/browser/manuscript-chat-agent-contribution.ts` registers the **Manuscript** agent. Rather than subclassing `AbstractStreamParsingChatAgent`, it uses the higher-level `CustomAgentFactory` (from `@theia/ai-chat`), invoked from a `FrontendApplicationContribution.onStart()` hook. It supplies:

- id `ai-focused-editor.manuscript`, name `Manuscript`;
- a system prompt that references the `{{manuscript}}` context variable (resolved by `ManuscriptContextVariableContribution` — see [[context-variables]]);
- the language-model id `AiConnectTheiaLanguageModel.ID` (`ai-focused-editor.ai-connect`) — see [[language-models]].

The agent is bound `toSelf()` and aliased onto `FrontendApplicationContribution` in `manuscript-workspace-frontend-module.ts`. Prompt fragments for the project's AI modes are supplied separately by `AiModePromptFragmentContribution` (see [[prompt-fragments]]).

## Sources

- [theia-ai](./theia-ai.md)
- [theia-platform-overview](./theia-platform-overview.md)
