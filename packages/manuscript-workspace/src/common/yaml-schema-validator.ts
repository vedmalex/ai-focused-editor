import Ajv, {
  ErrorObject,
  ValidateFunction
} from 'ajv';
import { injectable } from '@theia/core/shared/inversify';
import type { WorkspaceDiagnostic } from './manuscript-workspace-protocol';

export type DomainYamlSchemaKind =
  | 'metadata'
  | 'manifest'
  | 'character'
  | 'term'
  | 'artifact'
  | 'location';

/** Optional narrative fields shared by every entity kind (spec §5.2). */
const richEntityProperties = {
  aliases: {
    type: 'array',
    items: { type: 'string' },
    nullable: true
  },
  epithets: {
    type: 'array',
    items: { type: 'string' },
    nullable: true
  },
  speechPatterns: {
    type: 'array',
    items: { type: 'string' },
    nullable: true
  },
  summary: { type: 'string', nullable: true },
  backstory: { type: 'string', nullable: true },
  arc: { type: 'string', nullable: true },
  notes: { type: 'string', nullable: true }
} as const;

const metadataSchema = {
  type: 'object',
  required: ['title', 'language'],
  additionalProperties: true,
  properties: {
    title: { type: 'string', minLength: 1 },
    language: { type: 'string', minLength: 2 },
    author: { type: 'string', nullable: true }
  }
};

const manifestSchema = {
  type: 'object',
  required: ['version', 'content'],
  additionalProperties: true,
  properties: {
    version: { type: 'number' },
    content: {
      type: 'array',
      items: { $ref: '#/$defs/manifestEntry' }
    }
  },
  $defs: {
    manifestEntry: {
      type: 'object',
      required: ['path'],
      additionalProperties: true,
      properties: {
        path: { type: 'string', minLength: 1 },
        title: { type: 'string' },
        include: { type: 'boolean' },
        children: {
          type: 'array',
          items: { $ref: '#/$defs/manifestEntry' }
        }
      }
    }
  }
};

const characterSchema = {
  type: 'object',
  required: ['id', 'name'],
  additionalProperties: true,
  properties: {
    id: { type: 'string', minLength: 1 },
    name: { type: 'string', minLength: 1 },
    ...richEntityProperties
  }
};

const termSchema = {
  type: 'object',
  required: ['id', 'term'],
  additionalProperties: true,
  properties: {
    id: { type: 'string', minLength: 1 },
    term: { type: 'string', minLength: 1 },
    ...richEntityProperties
  }
};

/**
 * Optional artifact ownership/transfer history (FR-007, spec §5.2). Chronology
 * follows list order; from/to are freeform story-time labels, not real dates.
 */
const ownershipSchema = {
  type: 'array',
  nullable: true,
  items: {
    type: 'object',
    required: ['owner'],
    additionalProperties: true,
    properties: {
      owner: { type: 'string', minLength: 1 },
      from: { type: 'string', nullable: true },
      to: { type: 'string', nullable: true },
      note: { type: 'string', nullable: true }
    }
  }
} as const;

const artifactSchema = {
  type: 'object',
  required: ['id', 'name'],
  additionalProperties: true,
  properties: {
    id: { type: 'string', minLength: 1 },
    name: { type: 'string', minLength: 1 },
    ownership: ownershipSchema,
    ...richEntityProperties
  }
};

const locationSchema = {
  type: 'object',
  required: ['id', 'name'],
  additionalProperties: true,
  properties: {
    id: { type: 'string', minLength: 1 },
    name: { type: 'string', minLength: 1 },
    ...richEntityProperties
  }
};

@injectable()
export class YamlSchemaValidator {
  protected readonly ajv = new Ajv({
    allErrors: true,
    allowUnionTypes: true
  });

  protected readonly validators: Record<DomainYamlSchemaKind, ValidateFunction> = {
    metadata: this.ajv.compile(metadataSchema),
    manifest: this.ajv.compile(manifestSchema),
    character: this.ajv.compile(characterSchema),
    term: this.ajv.compile(termSchema),
    artifact: this.ajv.compile(artifactSchema),
    location: this.ajv.compile(locationSchema)
  };

  validate(kind: DomainYamlSchemaKind, uri: string, value: unknown): WorkspaceDiagnostic[] {
    const validator = this.validators[kind];
    if (validator(value)) {
      return [];
    }

    return (validator.errors ?? []).map(error => ({
      severity: 'error',
      source: 'yaml-schema',
      uri,
      message: `${this.getSchemaLabel(kind)}${this.formatPath(error)} ${error.message ?? 'is invalid'}`
    }));
  }

  protected getSchemaLabel(kind: DomainYamlSchemaKind): string {
    switch (kind) {
      case 'metadata':
        return 'metadata.yaml';
      case 'manifest':
        return 'manifest.yaml';
      case 'character':
        return 'character entity';
      case 'term':
        return 'term entity';
      case 'artifact':
        return 'artifact entity';
      case 'location':
        return 'location entity';
    }
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
