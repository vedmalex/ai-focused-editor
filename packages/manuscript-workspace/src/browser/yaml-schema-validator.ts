import Ajv, {
  ErrorObject,
  ValidateFunction
} from 'ajv';
import { injectable } from '@theia/core/shared/inversify';
import type { WorkspaceDiagnostic } from '../common';

export type DomainYamlSchemaKind = 'metadata' | 'manifest' | 'character' | 'term';

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
    aliases: {
      type: 'array',
      items: { type: 'string' },
      nullable: true
    },
    summary: { type: 'string', nullable: true }
  }
};

const termSchema = {
  type: 'object',
  required: ['id', 'term'],
  additionalProperties: true,
  properties: {
    id: { type: 'string', minLength: 1 },
    term: { type: 'string', minLength: 1 },
    summary: { type: 'string', nullable: true }
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
    term: this.ajv.compile(termSchema)
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
