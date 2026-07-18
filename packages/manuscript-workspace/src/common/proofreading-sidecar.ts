/**
 * The per-set Proofreading YAML sidecar (`proofreading/<set-slug>/proofset.yaml`).
 *
 * This owns (de)serialization of a {@link ProofreadingSet} to/from a
 * comment-preserving YAML document. It deliberately mirrors two established repo
 * patterns:
 *  - {@link parseProofsetYaml} reports machine-readable problem CODES exactly like
 *    `entity-type-registry.ts`'s `parseEntityTypesYaml`; and
 *  - {@link ProofsetSchemaValidator} is the AJV schema-of-record modeled on
 *    `yaml-schema-validator.ts` (kept a plain class — no `@injectable` — so this
 *    module stays Theia-free and runs under `bun test`).
 *  - {@link writeProofsetYaml} round-trips through the `yaml` `Document` API
 *    (`parseDocument` / `document.set` / `document.delete`) exactly like
 *    `entity-editor-widget.ts`, so hand-written comments and unknown keys survive.
 *
 * Persistence is PER-SET (in the sidecar), never a global file-states store —
 * verified state is keyed by page base name (ScanCheck `WorkflowManager.js:527-581`).
 */

import Ajv, { ErrorObject, ValidateFunction } from 'ajv';
import { Document, parse, parseDocument } from 'yaml';
import {
  DEFAULT_IMAGE_EXTENSIONS,
  DEFAULT_TEXT_EXTENSIONS,
  ProofreadingMode,
  ProofreadingPage,
  ProofreadingSet
} from './proofreading-model';

/** Machine-readable code for each kind of `proofset.yaml` validation problem. */
export type ProofreadingSidecarProblemCode =
  /** The file was empty, unparseable, or the root was not a mapping. */
  | 'invalid-shape'
  /** No `mode` key (or it was blank). */
  | 'missing-mode'
  /** `mode` was neither `ocr` nor `translation`. */
  | 'invalid-mode'
  /** No `imagesFolder` (or it was blank). */
  | 'missing-images-folder'
  /** No `textFolder` (or it was blank). */
  | 'missing-text-folder'
  /** `mode: translation` but no `sourceTextFolder` was supplied. */
  | 'missing-source-text-folder'
  /** `imageExtensions` / `textExtensions` was present but not a list of strings. */
  | 'invalid-extensions'
  /** A `pages` entry was malformed (not an object, no base, or a non-boolean flag). */
  | 'invalid-page';

/** One validation problem found while parsing `proofset.yaml`. */
export interface ProofreadingSidecarProblem {
  code: ProofreadingSidecarProblemCode;
  /** Human-readable, English message (i18n happens at the presentation layer). */
  message: string;
  /** Zero-based index of the offending `pages` entry, for `invalid-page`. */
  index?: number;
}

/** Problem codes that prevent building a usable set (no `set` is returned). */
const BLOCKING_CODES: ReadonlySet<ProofreadingSidecarProblemCode> = new Set<ProofreadingSidecarProblemCode>([
  'invalid-shape',
  'missing-mode',
  'invalid-mode',
  'missing-images-folder',
  'missing-text-folder',
  'missing-source-text-folder'
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Parse `imageExtensions` / `textExtensions`. Defaults to `fallback` when absent
 * OR empty (an empty list matches nothing, so it is treated as "use defaults");
 * a present-but-non-string-list value is an `invalid-extensions` problem and also
 * falls back to the defaults.
 */
function parseExtensions(
  value: unknown,
  fallback: readonly string[],
  key: string,
  problems: ProofreadingSidecarProblem[]
): string[] {
  if (value === undefined || value === null) {
    return [...fallback];
  }
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
    problems.push({ code: 'invalid-extensions', message: `"${key}" must be a list of strings.` });
    return [...fallback];
  }
  return value.length > 0 ? value.slice() : [...fallback];
}

/** Parse `pages`, dropping (and reporting) any malformed entry. Defaults to `[]`. */
function parsePages(value: unknown, problems: ProofreadingSidecarProblem[]): ProofreadingPage[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    problems.push({ code: 'invalid-page', message: '"pages" must be a list.' });
    return [];
  }
  const pages: ProofreadingPage[] = [];
  value.forEach((raw, index) => {
    if (!isPlainRecord(raw)) {
      problems.push({ code: 'invalid-page', index, message: `Page ${index + 1}: expected an object.` });
      return;
    }
    const base = asTrimmedString(raw.base);
    if (!base) {
      problems.push({ code: 'invalid-page', index, message: `Page ${index + 1}: a "base" is required.` });
      return;
    }
    if (raw.verified !== undefined && typeof raw.verified !== 'boolean') {
      problems.push({ code: 'invalid-page', index, message: `Page "${base}": "verified" must be a boolean.` });
      return;
    }
    if (raw.needsRework !== undefined && typeof raw.needsRework !== 'boolean') {
      problems.push({ code: 'invalid-page', index, message: `Page "${base}": "needsRework" must be a boolean.` });
      return;
    }
    pages.push({ base, verified: raw.verified === true, needsRework: raw.needsRework === true });
  });
  return pages;
}

/**
 * Parse the text of a `proofset.yaml` into a {@link ProofreadingSet} plus coded
 * {@link ProofreadingSidecarProblem}s. A BLOCKING problem (bad shape / mode /
 * required folder) yields no `set`; non-blocking problems (`invalid-extensions`,
 * `invalid-page`) still yield a `set` with the bad parts dropped/defaulted.
 * Defaults: `imageExtensions`/`textExtensions` fall back to the `DEFAULT_*`
 * lists, `pages` defaults to `[]`.
 */
export function parseProofsetYaml(text: string): { set?: ProofreadingSet; problems: ProofreadingSidecarProblem[] } {
  const problems: ProofreadingSidecarProblem[] = [];

  if (typeof text !== 'string' || text.trim().length === 0) {
    problems.push({ code: 'invalid-shape', message: 'proofset.yaml is empty.' });
    return { problems };
  }

  let document: unknown;
  try {
    document = parse(text);
  } catch (error) {
    problems.push({
      code: 'invalid-shape',
      message: `Invalid proofset.yaml: ${error instanceof Error ? error.message : String(error)}`
    });
    return { problems };
  }

  if (!isPlainRecord(document)) {
    problems.push({ code: 'invalid-shape', message: 'proofset.yaml must be a mapping of proofreading-set fields.' });
    return { problems };
  }

  const rawMode = asTrimmedString(document.mode);
  if (!rawMode) {
    problems.push({ code: 'missing-mode', message: 'A "mode" is required (ocr or translation).' });
  } else if (rawMode !== 'ocr' && rawMode !== 'translation') {
    problems.push({ code: 'invalid-mode', message: `Unknown mode "${rawMode}"; expected "ocr" or "translation".` });
  }

  const imagesFolder = asTrimmedString(document.imagesFolder);
  if (!imagesFolder) {
    problems.push({ code: 'missing-images-folder', message: 'An "imagesFolder" is required.' });
  }

  const textFolder = asTrimmedString(document.textFolder);
  if (!textFolder) {
    problems.push({ code: 'missing-text-folder', message: 'A "textFolder" is required.' });
  }

  const sourceTextFolder = asTrimmedString(document.sourceTextFolder) || undefined;
  if (rawMode === 'translation' && !sourceTextFolder) {
    problems.push({ code: 'missing-source-text-folder', message: 'Translation mode requires a "sourceTextFolder".' });
  }

  const imageExtensions = parseExtensions(document.imageExtensions, DEFAULT_IMAGE_EXTENSIONS, 'imageExtensions', problems);
  const textExtensions = parseExtensions(document.textExtensions, DEFAULT_TEXT_EXTENSIONS, 'textExtensions', problems);
  const pages = parsePages(document.pages, problems);

  if (problems.some(problem => BLOCKING_CODES.has(problem.code))) {
    return { problems };
  }

  const set: ProofreadingSet = {
    mode: rawMode as ProofreadingMode,
    imagesFolder,
    textFolder,
    ...(sourceTextFolder ? { sourceTextFolder } : {}),
    imageExtensions,
    textExtensions,
    pages
  };
  return { set, problems };
}

/**
 * Serialize a {@link ProofreadingSet} into `proofset.yaml` text, PRESERVING the
 * comments and any unknown keys of `existingText`. Only the derived keys this
 * module owns (`mode`, folders, extensions, `pages`) are (re)written via the
 * `yaml` `Document` API — unknown top-level keys and standalone comments are
 * never touched (the `entity-editor-widget.ts` round-trip contract).
 */
export function writeProofsetYaml(existingText: string | undefined, set: ProofreadingSet): string {
  const parsed = existingText ? parseDocument(existingText) : undefined;
  const document = parsed && parsed.contents != null ? parsed : new Document({});

  document.set('mode', set.mode);
  document.set('imagesFolder', set.imagesFolder);
  document.set('textFolder', set.textFolder);
  if (set.sourceTextFolder) {
    document.set('sourceTextFolder', set.sourceTextFolder);
  } else {
    document.delete('sourceTextFolder');
  }
  document.set('imageExtensions', [...set.imageExtensions]);
  document.set('textExtensions', [...set.textExtensions]);
  document.set(
    'pages',
    set.pages.map(page => ({ base: page.base, verified: page.verified, needsRework: page.needsRework }))
  );

  return document.toString();
}

/** Immutable helpers keyed by page BASE name (never index). */
function upsertPage(
  set: ProofreadingSet,
  base: string,
  patch: Partial<Pick<ProofreadingPage, 'verified' | 'needsRework'>>
): ProofreadingSet {
  let found = false;
  const pages = set.pages.map(page => {
    if (page.base === base) {
      found = true;
      return { ...page, ...patch };
    }
    return page;
  });
  if (!found) {
    pages.push({ base, verified: false, needsRework: false, ...patch });
  }
  return { ...set, pages };
}

/** Return a new set with `base`'s `verified` flag set, adding the page if absent. */
export function setPageVerified(set: ProofreadingSet, base: string, verified: boolean): ProofreadingSet {
  return upsertPage(set, base, { verified });
}

/** Return a new set with `base`'s `needsRework` flag set, adding the page if absent. */
export function setPageNeedsRework(set: ProofreadingSet, base: string, needsRework: boolean): ProofreadingSet {
  return upsertPage(set, base, { needsRework });
}

/** AJV schema-of-record for a `proofset.yaml` object (mirrors {@link parseProofsetYaml}). */
const proofsetSchema = {
  type: 'object',
  required: ['mode', 'imagesFolder', 'textFolder'],
  additionalProperties: true,
  properties: {
    mode: { type: 'string', enum: ['ocr', 'translation'] },
    imagesFolder: { type: 'string', minLength: 1 },
    textFolder: { type: 'string', minLength: 1 },
    sourceTextFolder: { type: 'string', minLength: 1, nullable: true },
    imageExtensions: { type: 'array', items: { type: 'string' }, nullable: true },
    textExtensions: { type: 'array', items: { type: 'string' }, nullable: true },
    pages: {
      type: 'array',
      nullable: true,
      items: {
        type: 'object',
        required: ['base'],
        additionalProperties: true,
        properties: {
          base: { type: 'string', minLength: 1 },
          verified: { type: 'boolean', nullable: true },
          needsRework: { type: 'boolean', nullable: true }
        }
      }
    }
  }
} as const;

/**
 * AJV validator for `proofset.yaml`, modeled on `yaml-schema-validator.ts`
 * (`YamlSchemaValidator`). Kept a plain class (no `@theia` / `@injectable`
 * imports) so the module stays bun-testable; the browser layer can wrap or bind
 * it as needed. Returns simple `{ severity, source, uri, message }` diagnostics.
 */
export class ProofsetSchemaValidator {
  protected readonly ajv = new Ajv({ allErrors: true, allowUnionTypes: true });
  protected readonly validator: ValidateFunction = this.ajv.compile(proofsetSchema);

  validate(uri: string, value: unknown): { severity: 'error'; source: 'proofset-schema'; uri: string; message: string }[] {
    if (this.validator(value)) {
      return [];
    }
    return (this.validator.errors ?? []).map(error => ({
      severity: 'error' as const,
      source: 'proofset-schema' as const,
      uri,
      message: `proofset.yaml${this.formatPath(error)} ${error.message ?? 'is invalid'}`
    }));
  }

  protected formatPath(error: ErrorObject): string {
    const path = error.instancePath || this.getMissingPropertyPath(error);
    return path ? ` ${path}:` : ':';
  }

  protected getMissingPropertyPath(error: ErrorObject): string {
    if (error.keyword !== 'required') {
      return '';
    }
    const missingProperty = (error.params as { missingProperty?: string }).missingProperty;
    return missingProperty ? `${error.instancePath || ''}/${missingProperty}` : error.instancePath;
  }
}
