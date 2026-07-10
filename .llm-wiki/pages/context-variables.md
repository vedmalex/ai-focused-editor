---
type: concept
slug: context-variables
created_at: 2026-07-09T21:19:22Z
---
# Context Variables

Variables are how a Theia AI [[theia-ai-agents|agent]] injects dynamic data into a [[prompt-fragments|prompt]]. They are referenced in templates with double braces `{{variableName}}`. The docs distinguish two axes.

**Scope:**
- **Agent-specific** — declared on `this.agentSpecificVariables = [{ name, description, usedInPrompt }]` and resolved by passing values to `promptService.getPrompt(templateId, { 'var-name': value })`.
- **Global** — available to all agents. Defined as an `AIVariable` (`id`, `name`, `description`, optional `args`) and resolved by a contribution implementing `AIVariableContribution` + resolver. The built-in `productName` global variable resolves to the configured `applicationName`.

**Context variables** are a special global kind: set `isContextVariable: true` and the resolver provides both a `value` (spliced into the prompt) and a `contextValue` (added to `ChatRequestModel.context`, so the datum becomes part of the request's structured context, not just its prompt text).

## Registration and resolution

Bind an `AIVariableContribution` (`bind(AIVariableContribution).to(...).inSingletonScope()`). Its `registerVariables(service: AIVariableService)` calls `service.registerVariable(...)` and `service.registerResolver(VAR, this)`. A resolver implements `canResolve(request, context): number` (a numeric priority) and `resolve(request, context)` returning a `ResolvedAIVariable` — or `ResolvedAIContextVariable` (which carries the extra `contextValue`) for context variables.

## In This Project

`packages/manuscript-workspace/src/browser/manuscript-context-variable-contribution.ts` defines the `{{manuscript}}` context variable end-to-end. `MANUSCRIPT_CONTEXT_VARIABLE` is an `AIContextVariable` (id `ai-focused-editor.manuscript-context`, name `manuscript`, `isContextVariable: true`, with a book icon). `ManuscriptContextVariableContribution` implements `AIVariableContribution`:

- `registerVariables` registers both the variable and itself as resolver;
- `canResolve` returns priority `100` when the variable name matches;
- `resolve` asks the injected `ManuscriptAiContextAssembler` to `assemble()` the current manuscript manifest/diagnostics/entities/source summary and returns it as both `value` and `contextValue`.

It is wired in `manuscript-workspace-frontend-module.ts` via `bind(AIVariableContribution).toService(ManuscriptContextVariableContribution)`. The [[theia-ai-agents|Manuscript agent]]'s system prompt references `{{manuscript}}`, so every chat turn receives fresh manuscript context. Because the assembler reads workspace state (a browser concern), this resolver runs frontend-side — see [[frontend-backend-separation]].

## Sources

- [theia-ai](./theia-ai.md)
