/**
 * Pure (Theia-free) row/field models for the AI Modes form editor
 * (`ai/prompts/custom-modes.yaml`).
 *
 * These helpers only translate between plain parsed objects (the output of
 * `yaml`'s `Document.toJS()`) and the flat rows the React widget renders, plus
 * the validation and the YAML-patch semantics (which keys are written vs.
 * omitted because they equal a default). The on-disk rewrite is done by the
 * widget through the `yaml` Document API so the document header, the `version`
 * key, and comments survive a round-trip — only the `modes` sequence is rebuilt.
 *
 * Keeping the coercion/validation/patch logic here (with no Theia imports) makes
 * it unit-testable under `bun test`.
 */

import {
  AI_MODE_APPLY_KINDS,
  AI_MODE_CONTEXTS,
  type AiMode,
  type AiModeApply,
  type AiModeContext
} from './ai-mode-protocol';

/** A validation problem surfaced in the form (an `error` blocks Save). */
export interface AiModeProblem {
  message: string;
  severity: 'error' | 'warning';
  /** Zero-based index of the offending mode row, when applicable. */
  index?: number;
}

/**
 * A single editable mode row. Every field is a string/boolean so the React
 * widget can bind directly to inputs; `temperature`/`maxTokens` stay strings
 * (empty means "unset") so an absent parameter is distinguishable from `0`.
 */
export interface AiModeRow {
  id: string;
  label: string;
  description: string;
  systemPrompt: string;
  userPrompt: string;
  context: AiModeContext;
  apply: AiModeApply;
  menu: boolean;
  agent: boolean;
  icon: string;
  /** Whether the mode is active. `false` writes `enabled: false`; `true` is the omitted default. */
  enabled: boolean;
  temperature: string;
  maxTokens: string;
}

/** The YAML patch for one mode: keys to write, plus keys deliberately omitted. */
export interface AiModeYamlPatch {
  /** Ordered keys to write for this mode (input to `Document.createNode`). */
  write: Record<string, unknown>;
  /** Keys deliberately dropped because they equal a default ("delete"). */
  omit: string[];
}

export const DEFAULT_AI_MODE_CONTEXT: AiModeContext = 'chat';

/** An empty row seeded by "Add Mode". */
export const EMPTY_AI_MODE_ROW: AiModeRow = {
  id: '',
  label: '',
  description: '',
  systemPrompt: '',
  userPrompt: '',
  context: 'chat',
  apply: 'chat',
  menu: false,
  agent: false,
  icon: '',
  enabled: true,
  temperature: '',
  maxTokens: ''
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return '';
}

function normalizeContext(value: unknown): AiModeContext {
  return typeof value === 'string' && (AI_MODE_CONTEXTS as readonly string[]).includes(value)
    ? (value as AiModeContext)
    : DEFAULT_AI_MODE_CONTEXT;
}

function normalizeApply(value: unknown): AiModeApply | undefined {
  return typeof value === 'string' && (AI_MODE_APPLY_KINDS as readonly string[]).includes(value)
    ? (value as AiModeApply)
    : undefined;
}

function numberToInputString(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
}

/**
 * The `apply` a mode falls back to when none is authored: `replace` for a
 * `selection` context, `chat` for everything else. Mirrors
 * `resolveAiModeApply` in `ai-mode-protocol.ts`.
 */
export function defaultApplyForContext(context: AiModeContext): AiModeApply {
  return context === 'selection' ? 'replace' : 'chat';
}

/** `replace`/`insert` only make sense for `selection`/`word` contexts. */
export function isApplyValidForContext(apply: AiModeApply, context: AiModeContext): boolean {
  if (apply === 'replace' || apply === 'insert') {
    return context === 'selection' || context === 'word';
  }
  return true;
}

/** The apply options the form offers for a context (used to build the select). */
export function applyOptionsForContext(context: AiModeContext): AiModeApply[] {
  return context === 'selection' || context === 'word'
    ? ['replace', 'insert', 'chat']
    : ['chat'];
}

/** kebab-case check for mode ids: `improve-selection`, `fix-grammar`, `a1`. */
export function isKebabCase(id: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id);
}

function toRow(record: Record<string, unknown>): AiModeRow {
  const context = normalizeContext(record.context);
  const authoredApply = normalizeApply(record.apply);
  let apply = authoredApply ?? defaultApplyForContext(context);
  if (!isApplyValidForContext(apply, context)) {
    apply = defaultApplyForContext(context);
  }
  const parameters = isRecord(record.parameters) ? record.parameters : {};
  return {
    id: asString(record.id),
    // The loader falls back to the id for a blank label; keep the authored value
    // (blank) so the form does not silently invent a label to write back.
    label: asString(record.label),
    description: asString(record.description),
    // `prompt` is the legacy alias the loader accepts for `systemPrompt`.
    systemPrompt: asString(record.systemPrompt) || asString(record.prompt),
    userPrompt: asString(record.userPrompt),
    context,
    apply,
    menu: record.menu === true,
    agent: record.agent === true,
    icon: asString(record.icon),
    // Only an explicit `false` disables; absence means enabled.
    enabled: record.enabled !== false,
    temperature: numberToInputString(parameters.temperature),
    maxTokens: numberToInputString(parameters.maxTokens)
  };
}

/**
 * Seed an editable row from a resolved mode — used by the form editor's
 * "override in book" action when copying a built-in/global mode into the book
 * file. `origin`/`overrides` are intentionally dropped: they are never written.
 */
export function aiModeToRow(mode: AiMode): AiModeRow {
  return toRow(mode as unknown as Record<string, unknown>);
}

/**
 * Flatten a parsed modes file (`{ version?, modes: [...] }` or a bare list)
 * into editable rows with defaults applied. Non-object entries are skipped.
 */
export function flattenModes(value: unknown): AiModeRow[] {
  const records = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.modes)
      ? value.modes
      : [];
  return records.filter(isRecord).map(toRow);
}

function parseTemperature(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseMaxTokens(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : undefined;
}

/**
 * Build the YAML patch for one mode. Only meaningful keys are written; keys at
 * their default are omitted so a plain mode stays terse on disk:
 * `menu: false`, `agent: false`, `context: 'chat'`, the default `apply`, blank
 * text, and empty `parameters` are all dropped rather than written as noise.
 */
export function modeToYamlPatch(row: AiModeRow): AiModeYamlPatch {
  const write: Record<string, unknown> = {};
  const omit: string[] = [];
  const put = (key: string, value: unknown, keep: boolean): void => {
    if (keep) {
      write[key] = value;
    } else {
      omit.push(key);
    }
  };

  // id is required and always written.
  write.id = row.id.trim();

  const label = row.label.trim();
  put('label', label, label.length > 0);

  const description = row.description.trim();
  put('description', description, description.length > 0);

  put('systemPrompt', row.systemPrompt, row.systemPrompt.trim().length > 0);
  put('userPrompt', row.userPrompt, row.userPrompt.trim().length > 0);

  const context = row.context;
  put('context', context, context !== DEFAULT_AI_MODE_CONTEXT);

  const apply = isApplyValidForContext(row.apply, context) ? row.apply : defaultApplyForContext(context);
  put('apply', apply, apply !== defaultApplyForContext(context));

  put('menu', true, row.menu === true);
  put('agent', true, row.agent === true);
  // enabled is written ONLY when disabling (false); `true` is the omitted default.
  put('enabled', false, row.enabled === false);

  const icon = row.icon.trim();
  put('icon', icon, icon.length > 0);

  const parameters: Record<string, number> = {};
  const temperature = parseTemperature(row.temperature);
  if (temperature !== undefined) {
    parameters.temperature = temperature;
  }
  const maxTokens = parseMaxTokens(row.maxTokens);
  if (maxTokens !== undefined) {
    parameters.maxTokens = maxTokens;
  }
  put('parameters', parameters, Object.keys(parameters).length > 0);

  return { write, omit };
}

/**
 * Validate the rows before a save: ids must be present, unique, and (softly)
 * kebab-case; a system prompt is required; the apply must be valid for the
 * context; parameter ranges are checked as warnings.
 */
export function validateModes(rows: AiModeRow[]): AiModeProblem[] {
  const problems: AiModeProblem[] = [];
  const seen = new Set<string>();
  rows.forEach((row, index) => {
    const where = `Mode ${index + 1}`;
    const id = row.id.trim();
    if (!id) {
      problems.push({ severity: 'error', index, message: `${where}: id is required.` });
    } else {
      if (seen.has(id)) {
        problems.push({ severity: 'error', index, message: `${where}: duplicate id "${id}".` });
      } else {
        seen.add(id);
      }
      if (!isKebabCase(id)) {
        problems.push({
          severity: 'warning',
          index,
          message: `${where}: id "${id}" should be kebab-case (lowercase letters, digits, dashes).`
        });
      }
    }

    if (!row.systemPrompt.trim()) {
      problems.push({
        severity: 'error',
        index,
        message: `${where}: a system prompt is required (modes without one are dropped when loaded).`
      });
    }

    if (!isApplyValidForContext(row.apply, row.context)) {
      problems.push({
        severity: 'error',
        index,
        message: `${where}: apply "${row.apply}" is only valid for a selection or word context.`
      });
    }

    const temperature = parseTemperature(row.temperature);
    if (row.temperature.trim() && temperature === undefined) {
      problems.push({ severity: 'warning', index, message: `${where}: temperature must be a number.` });
    } else if (temperature !== undefined && (temperature < 0 || temperature > 2)) {
      problems.push({ severity: 'warning', index, message: `${where}: temperature is usually between 0 and 2.` });
    }

    const maxTokens = parseMaxTokens(row.maxTokens);
    if (row.maxTokens.trim() && maxTokens === undefined) {
      problems.push({ severity: 'warning', index, message: `${where}: maxTokens must be a whole number.` });
    } else if (maxTokens !== undefined && maxTokens <= 0) {
      problems.push({ severity: 'warning', index, message: `${where}: maxTokens must be greater than 0.` });
    }
  });
  return problems;
}

/** Whether the rows are safe to save (no error-severity problems). */
export function hasBlockingProblems(problems: AiModeProblem[]): boolean {
  return problems.some(problem => problem.severity === 'error');
}
