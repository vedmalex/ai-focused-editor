/**
 * Prefix for the stable chat `@agent` id derived from an `agent: true` AI
 * mode's id. Shared between the browser-runtime chat-agent registration
 * (`AiModeDynamicContribution.agentId`) and the docs-tooling `agents[]`
 * inventory reader — see TASK-018 tech_spec §1/§3 (R1).
 */
export const MODE_AGENT_ID_PREFIX = 'ai-focused-editor.mode.';

/**
 * Prefix for the per-project prompt-fragment id derived from a `menu: true`
 * AI mode's id. Shared between the browser-runtime prompt-fragment
 * registration (`AiModePromptFragmentContribution.getFragmentId`) and the
 * docs-tooling dynamic-prefix coverage exception — see TASK-018 tech_spec §1/§3
 * (R1).
 */
export const PROJECT_AI_MODE_FRAGMENT_PREFIX = 'ai-focused-editor.project-mode.';
