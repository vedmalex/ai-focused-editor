import { describe, expect, test } from 'bun:test';
import type { NarrativeEntity } from '../common';
import { buildNoteIndex } from '../common/note-index';
import { classifyWikiLinkDecorations } from './semantic-markdown-decoration-classifier';

/**
 * Teeth over `classifyWikiLinkDecorations` — the pure token→decoration-class
 * classifier the browser `SemanticMarkdownDecorationService` calls on every
 * debounced editor update (TASK-013 U5, plan §9 ISS-139). Imported from the
 * dedicated `semantic-markdown-decoration-classifier` module rather than the
 * DI service file itself: importing the service file (even just for this
 * function) drags in `@theia/core/lib/browser`'s `ApplicationShell`, which
 * touches `document` at module-load time and crashes under `bun test`'s
 * DOM-less environment — see that module's file header for the full
 * explanation. Kept Monaco/DI-free on purpose: these cases assert the
 * resolution CHAIN (entity kind+id/bare-id FIRST, then note basename/title,
 * then unresolved — plan §3), not any editor-rendering mechanics.
 */

function entity(overrides: Partial<NarrativeEntity> & { id: string; kind: NarrativeEntity['kind'] }): NarrativeEntity {
  return {
    label: overrides.id,
    path: `entities/${overrides.kind}/${overrides.id}.yaml`,
    uri: `file:///vault/entities/${overrides.kind}/${overrides.id}.yaml`,
    aliases: [],
    ...overrides
  };
}

describe('classifyWikiLinkDecorations', () => {
  test('a labeled kind:id entity tag decorates as entity, by its explicit kind', () => {
    const tokens = classifyWikiLinkDecorations(
      '[[char:krishna|Кришна]]',
      'file:///vault/chapters/ch1.md',
      [],
      buildNoteIndex([])
    );
    expect(tokens).toEqual([
      { range: { start: 0, end: 23 }, variant: 'entity', kind: 'char' }
    ]);
  });

  test('a bare kind:id entity tag decorates as entity even when no matching entity exists (syntax-only, matches pre-TASK-013 behavior)', () => {
    const tokens = classifyWikiLinkDecorations(
      '[[char:unknown-hero]]',
      'file:///vault/chapters/ch1.md',
      [],
      buildNoteIndex([])
    );
    expect(tokens).toHaveLength(1);
    expect(tokens[0].variant).toBe('entity');
    expect(tokens[0].kind).toBe('char');
  });

  test('a colon-less bare id matching a known entity decorates as entity (corpus like [[sharan-108]] must not regress to a note class)', () => {
    const entities = [entity({ id: 'sharan-108', kind: 'term' })];
    const tokens = classifyWikiLinkDecorations(
      '[[sharan-108]]',
      'file:///vault/chapters/ch1.md',
      entities,
      buildNoteIndex([])
    );
    expect(tokens).toEqual([
      { range: { start: 0, end: 14 }, variant: 'entity', kind: 'term' }
    ]);
  });

  test('a colon-less bare id matching neither an entity nor an indexed note is note-unresolved', () => {
    const tokens = classifyWikiLinkDecorations(
      '[[Nonexistent Note]]',
      'file:///vault/chapters/ch1.md',
      [],
      buildNoteIndex([])
    );
    expect(tokens).toEqual([
      { range: { start: 0, end: 20 }, variant: 'note-unresolved' }
    ]);
  });

  test('a bare id resolving to exactly one indexed note is note-resolved', () => {
    const index = buildNoteIndex(['file:///vault/notes/My Note.md']);
    const tokens = classifyWikiLinkDecorations(
      '[[My Note]]',
      'file:///vault/chapters/ch1.md',
      [],
      index
    );
    expect(tokens).toEqual([
      { range: { start: 0, end: 11 }, variant: 'note-resolved' }
    ]);
  });

  test('an equal-distance duplicate basename is note-ambiguous, carrying the diagnostic hoverMessage', () => {
    const index = buildNoteIndex([
      'file:///vault/a/dup.md',
      'file:///vault/b/dup.md'
    ]);
    const tokens = classifyWikiLinkDecorations(
      '[[dup]]',
      'file:///vault/root.md',
      [],
      index
    );
    expect(tokens).toHaveLength(1);
    expect(tokens[0].variant).toBe('note-ambiguous');
    expect(tokens[0].hoverMessage).toBeDefined();
    expect(tokens[0].hoverMessage).toMatch(/неоднозначн/i);
  });

  test('an entity match wins over an equally-named note-index candidate (entity resolution is first in the chain)', () => {
    const entities = [entity({ id: 'krishna', kind: 'char' })];
    const index = buildNoteIndex(['file:///vault/notes/krishna.md']);
    const tokens = classifyWikiLinkDecorations(
      '[[krishna]]',
      'file:///vault/chapters/ch1.md',
      entities,
      index
    );
    expect(tokens).toEqual([
      { range: { start: 0, end: 11 }, variant: 'entity', kind: 'char' }
    ]);
  });

  test('an invalid token (kind-shaped prefix with a whitespace-broken id) is skipped — no decoration', () => {
    const tokens = classifyWikiLinkDecorations(
      '[[char:krishna Krishna]]',
      'file:///vault/chapters/ch1.md',
      [],
      buildNoteIndex([])
    );
    expect(tokens).toEqual([]);
  });

  test('multiple tokens in one document classify independently, preserving source order', () => {
    const entities = [entity({ id: 'frodo', kind: 'char' })];
    const index = buildNoteIndex(['file:///vault/notes/Shire.md']);
    const text = 'See [[char:frodo]] and [[Shire]] and [[Missing]].';
    const tokens = classifyWikiLinkDecorations(text, 'file:///vault/chapters/ch1.md', entities, index);
    expect(tokens.map(token => token.variant)).toEqual(['entity', 'note-resolved', 'note-unresolved']);
  });
});
