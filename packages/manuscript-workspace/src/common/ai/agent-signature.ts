import type { AiMode } from '../ai-mode-protocol';

/**
 * Human-readable agent name shown in the chat `@mention` completion and the AI
 * capabilities/settings panels; falls back to the mode id when a label is
 * missing. This is display text only — mentions resolve by the stable agent
 * id, never by this label.
 *
 * Single source of truth for both the browser-runtime chat-agent registration
 * (`AiModeDynamicContribution.agentDisplayName`) and the docs-tooling mode
 * hasher (`hashSourceRef` for `{path,mode}` refs) — see TASK-018 tech_spec §1
 * (F-D1.1-3).
 */
export function computeAgentDisplayName(mode: Pick<AiMode, 'label' | 'id'>): string {
  return mode.label?.trim() || mode.id;
}

/**
 * Stable signature of an agent-eligible mode's user-visible identity, used to
 * detect whether a live chat agent needs to be re-registered when the modes
 * file changes.
 *
 * Single source of truth for both the browser-runtime chat-agent registration
 * (`AiModeDynamicContribution.agentSignature`) and the docs-tooling mode
 * hasher (`hashSourceRef` for `{path,mode}` refs) — see TASK-018 tech_spec §1
 * (F-D1.1-3).
 */
export function computeAgentSignature(
  mode: Pick<AiMode, 'label' | 'id' | 'description' | 'systemPrompt'>
): string {
  return JSON.stringify([computeAgentDisplayName(mode), mode.description ?? '', mode.systemPrompt]);
}
