import { describe, expect, test } from 'bun:test';
import { buildNoteCompletionSuggestions, type NoteCompletionEntry } from './note-completion';

describe('buildNoteCompletionSuggestions', () => {
  test('a unique basename inserts bare, per UR-005(3)', () => {
    const entries: NoteCompletionEntry[] = [
      { basename: 'Recipe Ideas', relativePath: 'notes/Recipe Ideas' }
    ];
    const suggestions = buildNoteCompletionSuggestions(entries);
    expect(suggestions).toEqual([
      { insertText: 'Recipe Ideas', label: 'Recipe Ideas', relativePath: 'notes/Recipe Ideas' }
    ]);
  });

  test('a basename shared by two files inserts each occurrence as its vault-relative path', () => {
    const entries: NoteCompletionEntry[] = [
      { basename: 'Duplicate', relativePath: 'a/Duplicate' },
      { basename: 'Duplicate', relativePath: 'b/Duplicate' }
    ];
    const suggestions = buildNoteCompletionSuggestions(entries);
    expect(suggestions).toEqual([
      { insertText: 'a/Duplicate', label: 'Duplicate', relativePath: 'a/Duplicate' },
      { insertText: 'b/Duplicate', label: 'Duplicate', relativePath: 'b/Duplicate' }
    ]);
  });

  test('basename collision is case-insensitive (matches NoteIndex byBasename bucketing)', () => {
    const entries: NoteCompletionEntry[] = [
      { basename: 'Chapter', relativePath: 'drafts/Chapter' },
      { basename: 'chapter', relativePath: 'archive/chapter' }
    ];
    const suggestions = buildNoteCompletionSuggestions(entries);
    expect(suggestions.map(suggestion => suggestion.insertText)).toEqual([
      'archive/chapter',
      'drafts/Chapter'
    ]);
  });

  test('a note whose basename is unique among 2+ vault entries with OTHER duplicate basenames still inserts bare', () => {
    const entries: NoteCompletionEntry[] = [
      { basename: 'Solo', relativePath: 'x/Solo' },
      { basename: 'Pair', relativePath: 'a/Pair' },
      { basename: 'Pair', relativePath: 'b/Pair' }
    ];
    const suggestions = buildNoteCompletionSuggestions(entries);
    const solo = suggestions.find(suggestion => suggestion.label === 'Solo');
    expect(solo?.insertText).toBe('Solo');
    const pairs = suggestions.filter(suggestion => suggestion.label === 'Pair');
    expect(pairs.map(suggestion => suggestion.insertText)).toEqual(['a/Pair', 'b/Pair']);
  });

  test('filters by a case-insensitive ASCII prefix', () => {
    const entries: NoteCompletionEntry[] = [
      { basename: 'Recipe Ideas', relativePath: 'notes/Recipe Ideas' },
      { basename: 'Research Notes', relativePath: 'notes/Research Notes' },
      { basename: 'Travel Log', relativePath: 'notes/Travel Log' }
    ];
    const suggestions = buildNoteCompletionSuggestions(entries, 'rec');
    expect(suggestions.map(suggestion => suggestion.label)).toEqual(['Recipe Ideas']);
  });

  test('filters by a Cyrillic prefix, case-insensitively', () => {
    const entries: NoteCompletionEntry[] = [
      { basename: 'Моя заметка', relativePath: 'notes/Моя заметка' },
      { basename: 'Мой дневник', relativePath: 'notes/Мой дневник' },
      { basename: 'Другая заметка', relativePath: 'notes/Другая заметка' }
    ];
    const suggestions = buildNoteCompletionSuggestions(entries, 'мо');
    expect(suggestions.map(suggestion => suggestion.label).sort()).toEqual(['Мой дневник', 'Моя заметка']);
  });

  test('an empty/undefined prefix matches every entry', () => {
    const entries: NoteCompletionEntry[] = [
      { basename: 'Alpha', relativePath: 'Alpha' },
      { basename: 'Beta', relativePath: 'Beta' }
    ];
    expect(buildNoteCompletionSuggestions(entries, '').map(suggestion => suggestion.label)).toEqual(['Alpha', 'Beta']);
    expect(buildNoteCompletionSuggestions(entries).map(suggestion => suggestion.label)).toEqual(['Alpha', 'Beta']);
  });

  test('a prefix matching nothing yields an empty list', () => {
    const entries: NoteCompletionEntry[] = [
      { basename: 'Alpha', relativePath: 'Alpha' }
    ];
    expect(buildNoteCompletionSuggestions(entries, 'zzz')).toEqual([]);
  });

  test('an unrelated duplicate basename excluded by the prefix filter never leaks into another entry\'s uniqueness', () => {
    const entries: NoteCompletionEntry[] = [
      { basename: 'Draft', relativePath: 'a/Draft' },
      { basename: 'Draft', relativePath: 'b/Draft' },
      { basename: 'Other', relativePath: 'c/Other' }
    ];
    const suggestions = buildNoteCompletionSuggestions(entries, 'oth');
    expect(suggestions).toEqual([
      { insertText: 'Other', label: 'Other', relativePath: 'c/Other' }
    ]);
  });

  test('results are sorted by label (locale-aware) then by relativePath', () => {
    const entries: NoteCompletionEntry[] = [
      { basename: 'beta', relativePath: 'z/beta' },
      { basename: 'Alpha', relativePath: 'y/Alpha' },
      { basename: 'alpha', relativePath: 'x/alpha' }
    ];
    const suggestions = buildNoteCompletionSuggestions(entries);
    expect(suggestions.map(suggestion => suggestion.relativePath)).toEqual(['x/alpha', 'y/Alpha', 'z/beta']);
  });
});
