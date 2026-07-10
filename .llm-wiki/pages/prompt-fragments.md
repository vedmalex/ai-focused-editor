---
type: concept
slug: prompt-fragments
created_at: 2026-07-09T21:19:22Z
---
# Prompt Fragments

In Theia AI, prompts are not hard-coded strings but reusable **prompt fragments**. A `BasePromptFragment` (from `@theia/ai-core`) has an `id` and a `template` string; an [[theia-ai-agents|agent]] references fragments by id through its `prompts` array and `systemPromptId`. Fragments are the composable unit of prompt engineering, and a key documented property is that they can be **edited at runtime in the running IDE** — so prompt iteration does not require a rebuild, which matters for prompt-evaluation workflows.

## Template syntax

A fragment's `template` supports several substitution forms:

- `{{variableName}}` — a [[context-variables|variable]] (agent-specific or global) or a capability.
- `{{capability:fragment-id [default on|off]}}` — a toggleable capability chip; name/description come from the referenced fragment's YAML frontmatter.
- `~{functionId}` — a tool function the LLM may call.
- Slash-command arguments substitute via `$ARGUMENTS` (all), `$1 $2 $3` (positional).

The `PromptService` is the runtime API: `getPrompt(templateId, { 'var-name': value })` resolves a fragment with variable values, and `addBuiltInPromptFragment(...)` registers fragments programmatically. **Slash commands** are fragments carrying `CommandPromptFragmentMetadata` (`isCommand: true`, `commandName`, `commandDescription`, `commandArgumentHint?`, `commandAgents?`).

## In This Project

`packages/manuscript-workspace/src/browser/ai-mode-prompt-fragment-contribution.ts` (`AiModePromptFragmentContribution`) is a `FrontendApplicationContribution` that turns the project's **AI modes** into prompt fragments. On `onStart()` it reads the mode registry (`AiModeRegistry`) and, whenever the workspace or the source file changes (watched via `WorkspaceService.onWorkspaceChanged` and `FileService.onDidFilesChange`), it synchronises the set of registered fragments through the injected `PromptService`. Fragment ids use the prefix `ai-focused-editor.project-mode.` and command names the prefix `afe-`. It carefully adds/removes fragments to match the current mode snapshot (tracking `registeredFragmentIds`) so runtime edits to the manuscript's AI-mode definitions immediately re-shape the available prompts.

The [[theia-ai-agents|Manuscript agent]]'s own system prompt (in `manuscript-chat-agent-contribution.ts`) is a template string that embeds the `{{manuscript}}` context variable, tying prompt fragments to [[context-variables]].

## Sources

- [theia-ai](./theia-ai.md)
