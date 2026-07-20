/**
 * The per-set Transcript Check YAML sidecar
 * (`transcription/<set-slug>/transcriptset.yaml`) — the exact structural clone
 * of `proofreading-sidecar.ts` for {@link TranscriptSet}:
 *  - {@link parseTranscriptsetYaml} reports machine-readable problem CODES;
 *  - {@link TranscriptsetSchemaValidator} is the AJV schema-of-record (plain
 *    class, no `@injectable`, so the module stays Theia-free and bun-testable);
 *  - {@link writeTranscriptsetYaml} round-trips through the `yaml` `Document`
 *    API so hand-written comments and unknown keys survive.
 *
 * Persistence is PER-SET; verified state is keyed by media base name.
 */

import Ajv, { ErrorObject, ValidateFunction } from 'ajv';
import { Document, parse, parseDocument } from 'yaml';
import { DEFAULT_MEDIA_EXTENSIONS, TranscriptFileState, TranscriptSet } from './transcript-set-model';

/** Machine-readable code for each kind of `transcriptset.yaml` validation problem. */
export type TranscriptSidecarProblemCode =
  /** The file was empty, unparseable, or the root was not a mapping. */
  | 'invalid-shape'
  /** No `audioFolder` (or it was blank). */
  | 'missing-audio-folder'
  /** No `transcriptFolder` (or it was blank). */
  | 'missing-transcript-folder'
  /** `mediaExtensions` was present but not a list of strings. */
  | 'invalid-extensions'
  /** `language` was present but not a string. */
  | 'invalid-language'
  /** `sourceMedia` was present but not a string. */
  | 'invalid-source-media'
  /** A `files` entry was malformed (not an object, no base, or a non-boolean flag). */
  | 'invalid-file';

/** One validation problem found while parsing `transcriptset.yaml`. */
export interface TranscriptSidecarProblem {
  code: TranscriptSidecarProblemCode;
  /** Human-readable, English message (i18n happens at the presentation layer). */
  message: string;
  /** Zero-based index of the offending `files` entry, for `invalid-file`. */
  index?: number;
}

/** Problem codes that prevent building a usable set (no `set` is returned). */
const BLOCKING_CODES: ReadonlySet<TranscriptSidecarProblemCode> = new Set<TranscriptSidecarProblemCode>([
  'invalid-shape',
  'missing-audio-folder',
  'missing-transcript-folder'
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Parse `mediaExtensions`. Defaults to {@link DEFAULT_MEDIA_EXTENSIONS} when
 * absent OR empty; a present-but-non-string-list value is an
 * `invalid-extensions` problem and also falls back to the defaults.
 */
function parseExtensions(value: unknown, problems: TranscriptSidecarProblem[]): string[] {
  if (value === undefined || value === null) {
    return [...DEFAULT_MEDIA_EXTENSIONS];
  }
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
    problems.push({ code: 'invalid-extensions', message: '"mediaExtensions" must be a list of strings.' });
    return [...DEFAULT_MEDIA_EXTENSIONS];
  }
  return value.length > 0 ? value.slice() : [...DEFAULT_MEDIA_EXTENSIONS];
}

/** Parse `files`, dropping (and reporting) any malformed entry. Defaults to `[]`. */
function parseFiles(value: unknown, problems: TranscriptSidecarProblem[]): TranscriptFileState[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    problems.push({ code: 'invalid-file', message: '"files" must be a list.' });
    return [];
  }
  const files: TranscriptFileState[] = [];
  value.forEach((raw, index) => {
    if (!isPlainRecord(raw)) {
      problems.push({ code: 'invalid-file', index, message: `File ${index + 1}: expected an object.` });
      return;
    }
    const base = asTrimmedString(raw.base);
    if (!base) {
      problems.push({ code: 'invalid-file', index, message: `File ${index + 1}: a "base" is required.` });
      return;
    }
    if (raw.verified !== undefined && typeof raw.verified !== 'boolean') {
      problems.push({ code: 'invalid-file', index, message: `File "${base}": "verified" must be a boolean.` });
      return;
    }
    if (raw.needsRework !== undefined && typeof raw.needsRework !== 'boolean') {
      problems.push({ code: 'invalid-file', index, message: `File "${base}": "needsRework" must be a boolean.` });
      return;
    }
    files.push({ base, verified: raw.verified === true, needsRework: raw.needsRework === true });
  });
  return files;
}

/**
 * Parse the text of a `transcriptset.yaml` into a {@link TranscriptSet} plus
 * coded {@link TranscriptSidecarProblem}s. A BLOCKING problem (bad shape /
 * required folder) yields no `set`; non-blocking problems
 * (`invalid-extensions`, `invalid-language`, `invalid-source-media`,
 * `invalid-file`) still yield a
 * `set` with the bad parts dropped/defaulted. Defaults: `mediaExtensions`
 * falls back to {@link DEFAULT_MEDIA_EXTENSIONS}, `language` to absent,
 * `files` to `[]`.
 */
export function parseTranscriptsetYaml(text: string): { set?: TranscriptSet; problems: TranscriptSidecarProblem[] } {
  const problems: TranscriptSidecarProblem[] = [];

  if (typeof text !== 'string' || text.trim().length === 0) {
    problems.push({ code: 'invalid-shape', message: 'transcriptset.yaml is empty.' });
    return { problems };
  }

  let document: unknown;
  try {
    document = parse(text);
  } catch (error) {
    problems.push({
      code: 'invalid-shape',
      message: `Invalid transcriptset.yaml: ${error instanceof Error ? error.message : String(error)}`
    });
    return { problems };
  }

  if (!isPlainRecord(document)) {
    problems.push({ code: 'invalid-shape', message: 'transcriptset.yaml must be a mapping of transcript-set fields.' });
    return { problems };
  }

  const audioFolder = asTrimmedString(document.audioFolder);
  if (!audioFolder) {
    problems.push({ code: 'missing-audio-folder', message: 'An "audioFolder" is required.' });
  }

  const transcriptFolder = asTrimmedString(document.transcriptFolder);
  if (!transcriptFolder) {
    problems.push({ code: 'missing-transcript-folder', message: 'A "transcriptFolder" is required.' });
  }

  let language: string | undefined;
  if (document.language !== undefined && document.language !== null) {
    if (typeof document.language !== 'string') {
      problems.push({ code: 'invalid-language', message: '"language" must be a string.' });
    } else {
      language = document.language.trim() || undefined;
    }
  }

  let sourceMedia: string | undefined;
  if (document.sourceMedia !== undefined && document.sourceMedia !== null) {
    if (typeof document.sourceMedia !== 'string') {
      problems.push({ code: 'invalid-source-media', message: '"sourceMedia" must be a string.' });
    } else {
      sourceMedia = document.sourceMedia.trim() || undefined;
    }
  }

  const mediaExtensions = parseExtensions(document.mediaExtensions, problems);
  const files = parseFiles(document.files, problems);

  if (problems.some(problem => BLOCKING_CODES.has(problem.code))) {
    return { problems };
  }

  const set: TranscriptSet = {
    audioFolder,
    transcriptFolder,
    mediaExtensions,
    ...(language ? { language } : {}),
    ...(sourceMedia ? { sourceMedia } : {}),
    files
  };
  return { set, problems };
}

/**
 * Serialize a {@link TranscriptSet} into `transcriptset.yaml` text, PRESERVING
 * the comments and any unknown keys of `existingText`. Only the keys this
 * module owns (`audioFolder`, `transcriptFolder`, `mediaExtensions`,
 * `language`, `sourceMedia`, `files`) are (re)written via the `yaml`
 * `Document` API.
 */
export function writeTranscriptsetYaml(existingText: string | undefined, set: TranscriptSet): string {
  const parsed = existingText ? parseDocument(existingText) : undefined;
  const document = parsed && parsed.contents != null ? parsed : new Document({});

  document.set('audioFolder', set.audioFolder);
  document.set('transcriptFolder', set.transcriptFolder);
  document.set('mediaExtensions', [...set.mediaExtensions]);
  if (set.language) {
    document.set('language', set.language);
  } else {
    document.delete('language');
  }
  if (set.sourceMedia) {
    document.set('sourceMedia', set.sourceMedia);
  } else {
    document.delete('sourceMedia');
  }
  document.set(
    'files',
    set.files.map(file => ({ base: file.base, verified: file.verified, needsRework: file.needsRework }))
  );

  return document.toString();
}

/** Immutable helpers keyed by file BASE name (never index). */
function upsertFile(
  set: TranscriptSet,
  base: string,
  patch: Partial<Pick<TranscriptFileState, 'verified' | 'needsRework'>>
): TranscriptSet {
  let found = false;
  const files = set.files.map(file => {
    if (file.base === base) {
      found = true;
      return { ...file, ...patch };
    }
    return file;
  });
  if (!found) {
    files.push({ base, verified: false, needsRework: false, ...patch });
  }
  return { ...set, files };
}

/** Return a new set with `base`'s `verified` flag set, adding the file if absent. */
export function setTranscriptFileVerified(set: TranscriptSet, base: string, verified: boolean): TranscriptSet {
  return upsertFile(set, base, { verified });
}

/** Return a new set with `base`'s `needsRework` flag set, adding the file if absent. */
export function setTranscriptFileNeedsRework(set: TranscriptSet, base: string, needsRework: boolean): TranscriptSet {
  return upsertFile(set, base, { needsRework });
}

/** AJV schema-of-record for a `transcriptset.yaml` object (mirrors {@link parseTranscriptsetYaml}). */
const transcriptsetSchema = {
  type: 'object',
  required: ['audioFolder', 'transcriptFolder'],
  additionalProperties: true,
  properties: {
    audioFolder: { type: 'string', minLength: 1 },
    transcriptFolder: { type: 'string', minLength: 1 },
    mediaExtensions: { type: 'array', items: { type: 'string' }, nullable: true },
    language: { type: 'string', nullable: true },
    sourceMedia: { type: 'string', nullable: true },
    files: {
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
 * AJV validator for `transcriptset.yaml`, modeled on `ProofsetSchemaValidator`.
 * Plain class (no `@theia` / `@injectable` imports) so the module stays
 * bun-testable; the browser layer can wrap or bind it as needed.
 */
export class TranscriptsetSchemaValidator {
  protected readonly ajv = new Ajv({ allErrors: true, allowUnionTypes: true });
  protected readonly validator: ValidateFunction = this.ajv.compile(transcriptsetSchema);

  validate(uri: string, value: unknown): { severity: 'error'; source: 'transcriptset-schema'; uri: string; message: string }[] {
    if (this.validator(value)) {
      return [];
    }
    return (this.validator.errors ?? []).map(error => ({
      severity: 'error' as const,
      source: 'transcriptset-schema' as const,
      uri,
      message: `transcriptset.yaml${this.formatPath(error)} ${error.message ?? 'is invalid'}`
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
