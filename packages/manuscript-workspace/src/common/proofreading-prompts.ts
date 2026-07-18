/**
 * Pure prompt templates + message assembly for the Proofreading AI actions.
 *
 * Ported from ScanCheck's default prompts (`appConfig.js:8-18`) — the strings are
 * Russian-authored (as in ScanCheck), whole-page oriented (v1 returns the
 * corrected FULL text, NOT ScanCheck's per-paragraph JSON). Everything here is
 * pure and DOM/Theia-free so it runs directly under `bun test`; the browser
 * service ({@link ../browser/proofreading-ai-service}) turns the assembled
 * messages into an `AiGenerateRequest`.
 */

/** Which of the four AI actions a prompt drives. */
export type ProofreadingActionKind = 'reOcr' | 'proofread' | 'translate' | 'translationQa';

/**
 * Re-recognize (OCR) the text from the attached scan. Preserves the line and
 * paragraph structure; returns ONLY the recognized text.
 */
export const REOCR_PROMPT = [
  'Ты — система оптического распознавания текста (OCR).',
  'Перечитай текст с приложенного изображения страницы-скана.',
  'Сохрани структуру строк и абзацев ровно так, как на странице.',
  'Не исправляй орфографию, не переписывай и не сокращай — только точно распознай написанное.',
  'Верни только распознанный текст, без комментариев, пояснений и разметки.'
].join('\n');

/**
 * Proofread the OCR text. v1 whole-page: returns the corrected FULL text with the
 * structure preserved (NOT per-paragraph issue JSON — that is a later wave).
 */
export const PROOFREAD_PROMPT = [
  'Ты — профессиональный корректор.',
  'Вычитай приведённый ниже распознанный текст: исправь орфографические и пунктуационные ошибки, а также очевидные опечатки, возникшие при распознавании.',
  'Сохрани структуру абзацев и строк. Не меняй авторский стиль, лексику и смысл.',
  'Верни только исправленный полный текст, без комментариев и пояснений.'
].join('\n');

/**
 * Translate the source text in full, preserving structure; returns ONLY the
 * translation.
 */
export const TRANSLATE_PROMPT = [
  'Ты — профессиональный переводчик.',
  'Полностью переведи приведённый ниже текст.',
  'Сохрани структуру абзацев и строк оригинала. Ничего не пропускай и не добавляй от себя.',
  'Верни только перевод, без комментариев и пояснений.'
].join('\n');

/**
 * Translation QA: compare the original against the translation and return a
 * corrected FULL translation (whole-page, not per-fragment JSON).
 */
export const TRANSLATION_QA_PROMPT = [
  'Ты — редактор переводов.',
  'Сравни оригинал и его перевод: найди пропуски, искажения смысла и терминологические ошибки.',
  'Исправь найденные ошибки, сохранив структуру абзацев и строк.',
  'Верни только исправленный полный перевод, без комментариев и пояснений.'
].join('\n');

/** The four default prompts, keyed by action — the authoritative system prompt per action. */
export const PROOFREADING_PROMPTS: Record<ProofreadingActionKind, string> = {
  reOcr: REOCR_PROMPT,
  proofread: PROOFREAD_PROMPT,
  translate: TRANSLATE_PROMPT,
  translationQa: TRANSLATION_QA_PROMPT
};

/** Note appended to the user message when the scan image travels as an attachment. */
export const IMAGE_ATTACHED_NOTE = '(К этому сообщению приложено изображение страницы-скана.)';

/** Inputs the message builder assembles into a system + user pair. */
export interface ProofreadingPromptInput {
  kind: ProofreadingActionKind;
  /** The current editable text (OCR text, or the translation for `translationQa`). */
  currentText: string;
  /** Translation-mode source text (required for `translate`/`translationQa`). */
  sourceText?: string;
  /** True when the scan image is attached to the request (adds the image note). */
  hasImageAttachment?: boolean;
}

/** The assembled system + user messages for one AI action. */
export interface ProofreadingPromptMessages {
  system: string;
  user: string;
}

/**
 * Assemble the system + user messages for a proofreading AI action. Pure and
 * deterministic given its inputs (the tested seam):
 *  - `reOcr` — image-only; the user message is just the image note (the text is
 *    re-recognized from the scan, not from the current OCR text).
 *  - `proofread` — text-only; the user message carries the current OCR text.
 *  - `translate` — the user message carries the source text (+ image note).
 *  - `translationQa` — the user message carries both the original and the current
 *    translation (+ image note).
 *
 * The scan image itself is NOT embedded here — it travels as an `AiGenerateRequest`
 * attachment; this only adds the textual note that it is present.
 */
export function buildProofreadingMessages(input: ProofreadingPromptInput): ProofreadingPromptMessages {
  const system = PROOFREADING_PROMPTS[input.kind];
  const parts: string[] = [];
  if (input.hasImageAttachment) {
    parts.push(IMAGE_ATTACHED_NOTE);
  }
  switch (input.kind) {
    case 'reOcr':
      // Nothing but the image note: the model re-reads the attached scan.
      break;
    case 'proofread':
      parts.push('Текст для вычитки:', '', input.currentText);
      break;
    case 'translate':
      parts.push('Текст оригинала:', '', input.sourceText ?? input.currentText);
      break;
    case 'translationQa':
      parts.push(
        'Оригинал:',
        '',
        input.sourceText ?? '',
        '',
        'Перевод:',
        '',
        input.currentText
      );
      break;
  }
  return { system, user: parts.join('\n') };
}

/** A raw base64 image payload split out of a `data:` URI. */
export interface DataUriParts {
  mimeType: string;
  base64: string;
}

/**
 * Split a `data:<mime>;base64,<payload>` URI (the exact shape the widget builds
 * for the left scan pane) into `{ mimeType, base64 }` for use as an
 * `AiConnectAttachment`. Returns undefined for a non-data URI, a non-base64 data
 * URI, or a URI missing either half — pure string derivation, no DOM.
 */
export function splitDataUri(dataUri: string): DataUriParts | undefined {
  if (!dataUri.startsWith('data:')) {
    return undefined;
  }
  const marker = ';base64,';
  const markerIndex = dataUri.indexOf(marker);
  if (markerIndex === -1) {
    return undefined;
  }
  const mimeType = dataUri.slice('data:'.length, markerIndex);
  const base64 = dataUri.slice(markerIndex + marker.length);
  if (!mimeType || !base64) {
    return undefined;
  }
  return { mimeType, base64 };
}
