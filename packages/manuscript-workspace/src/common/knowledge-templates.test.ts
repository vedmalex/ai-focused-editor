import { describe, expect, it } from 'bun:test';
import {
  buildKnowledgeNoteBody,
  KNOWLEDGE_TEMPLATE_KINDS,
  KnowledgeTemplateKind
} from './knowledge-templates';

describe('buildKnowledgeNoteBody', () => {
  it('opens every template with the note title as an H1', () => {
    for (const kind of KNOWLEDGE_TEMPLATE_KINDS) {
      const body = buildKnowledgeNoteBody(kind, 'Моя книга');
      expect(body.startsWith('# Моя книга')).toBe(true);
      expect(body.endsWith('\n')).toBe(true);
    }
  });

  it('keeps the empty template minimal (H1 + blank line)', () => {
    expect(buildKnowledgeNoteBody('empty', 'Заметка')).toBe('# Заметка\n\n');
  });

  it('seeds the non-empty templates with section headings', () => {
    expect(buildKnowledgeNoteBody('book-brief', 'X')).toContain('## Идея');
    expect(buildKnowledgeNoteBody('book-plan', 'X')).toContain('## Часть I');
    expect(buildKnowledgeNoteBody('sample-contents', 'X')).toContain('## Оглавление');
  });

  it('never crashes and falls back to the empty template on an unknown kind', () => {
    const body = buildKnowledgeNoteBody('nope' as KnowledgeTemplateKind, 'Title');
    expect(body).toBe('# Title\n\n');
  });

  it('exposes empty as the first offered template', () => {
    expect(KNOWLEDGE_TEMPLATE_KINDS[0]).toBe('empty');
    expect(new Set(KNOWLEDGE_TEMPLATE_KINDS).size).toBe(KNOWLEDGE_TEMPLATE_KINDS.length);
  });
});
