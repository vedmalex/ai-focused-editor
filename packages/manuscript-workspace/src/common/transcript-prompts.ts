/**
 * Pure prompt templates + response parsing for the Transcript Check AI actions
 * — the transcript analogue of `proofreading-prompts.ts`.
 *
 * Ported from audio_transcript_check's aiConnect glue:
 *  - the proofread SYSTEM prompt + `{correctedText, summary, issues[]}` JSON
 *    contract (`src/lib/aiConnectProfiles.js:9-10`);
 *  - {@link extractJsonFromContent}, the tolerant JSON extractor that falls
 *    back to the outermost `{...}` slice when the model wraps its JSON in
 *    prose (`src/lib/aiConnectBrowser.js:9-24`);
 *  - {@link normalizeProofreadPayload}, the field-by-field normalization of a
 *    parsed payload (`aiConnectBrowser.js:26-39` minus the provider/model
 *    stamping, which is the service layer's job).
 *
 * Everything here is pure and DOM/Theia-free — runs under `bun test`; the
 * browser service turns the assembled messages into an `AiGenerateRequest`.
 */

/**
 * The transcript proofread system prompt — the source app's default
 * (`aiConnectProfiles.js:9-10`), verbatim: the model must return the JSON
 * contract `{correctedText, summary, issues[]}`.
 */
export const TRANSCRIPT_PROOFREAD_SYSTEM_PROMPT =
  'You are a transcript proofreader. Return JSON with correctedText, summary, issues[]. ' +
  'Each issue must include type, severity, message, excerpt, suggestion. Preserve speaker meaning and style.';

/** The assembled system + user messages for one transcript AI action. */
export interface TranscriptPromptMessages {
  system: string;
  user: string;
}

/**
 * Assemble the system + user messages for proofreading ONE segment's text.
 * Pure and deterministic: the user message is the segment text verbatim (the
 * source app sends the raw segment text as the user turn,
 * `aiConnectBrowser.js:140-144`).
 */
export function buildTranscriptProofreadMessages(segmentText: string, systemPrompt?: string): TranscriptPromptMessages {
  const system = systemPrompt && systemPrompt.trim() ? systemPrompt : TRANSCRIPT_PROOFREAD_SYSTEM_PROMPT;
  return { system, user: segmentText };
}

/**
 * Extract a JSON payload from a model response. Tolerant fallback parser
 * (port of `aiConnectBrowser.js:9-24`): tries a strict `JSON.parse` first,
 * then the outermost `{...}` slice (models often wrap JSON in prose or code
 * fences). Throws on an empty response or when no valid JSON can be found.
 */
export function extractJsonFromContent(content: string): unknown {
  const normalized = String(content || '').trim();
  if (!normalized) {
    throw new Error('Empty response from AI client.');
  }
  try {
    return JSON.parse(normalized);
  } catch {
    const start = normalized.indexOf('{');
    const end = normalized.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      try {
        return JSON.parse(normalized.slice(start, end + 1));
      } catch {
        throw new Error('AI client did not return valid JSON.');
      }
    }
    throw new Error('AI client did not return valid JSON.');
  }
}

/**
 * The normalized proofread payload — the pure part of the JSON contract
 * (provider/model/updatedAt stamping happens in the service layer before
 * `setSegmentProofreadResult` stores it).
 */
export interface TranscriptProofreadPayload {
  summary: string;
  correctedText: string;
  /** The segment text the proofread ran against. */
  sourceText: string;
  /** Raw issue objects — `setSegmentProofreadResult` normalizes them on store. */
  issues: unknown[];
}

/**
 * Normalize a parsed (unknown-shaped) payload against the JSON contract:
 * `correctedText` falls back to the source text, `summary` to '', `issues` to
 * `[]` (port of `aiConnectBrowser.js` `normalizeProofreadResult`, minus the
 * provider/model stamping).
 */
export function normalizeProofreadPayload(payload: unknown, fallbackText: string): TranscriptProofreadPayload {
  const record = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  return {
    summary: typeof record.summary === 'string' ? record.summary : '',
    correctedText: typeof record.correctedText === 'string' ? record.correctedText : fallbackText,
    sourceText: fallbackText,
    issues: Array.isArray(record.issues) ? record.issues : []
  };
}
