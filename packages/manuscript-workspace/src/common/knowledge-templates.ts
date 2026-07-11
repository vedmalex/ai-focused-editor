/**
 * Pure (Theia-free) body templates for new knowledge notes.
 *
 * The "New Knowledge Note..." flow lets an author pick a template after the
 * category; each template seeds a structured Russian markdown skeleton (the
 * product is Russian-first, so the CONTENT stays Russian here while the picker
 * LABELS are localized in the browser contribution via `nls`). Kept Theia-free
 * so the body shaping is unit-testable under `bun test`.
 *
 * Placeholder hints are written as *italic* prompts the author overwrites; they
 * are real prose (not UI strings), so they live in this content module rather
 * than the i18n dictionaries.
 */

/** The knowledge-note templates offered after the category step. */
export type KnowledgeTemplateKind = 'empty' | 'book-brief' | 'book-plan' | 'sample-contents';

/** All template kinds, in a stable display/iteration order (empty first). */
export const KNOWLEDGE_TEMPLATE_KINDS: readonly KnowledgeTemplateKind[] = [
  'empty',
  'book-brief',
  'book-plan',
  'sample-contents'
];

/**
 * Render the markdown body for a new knowledge note. Every template opens with
 * an H1 carrying the note `title`; the non-empty templates add Russian section
 * skeletons with *italic* placeholder hints. An unknown kind degrades to the
 * empty template so a caller can never crash on a bad value.
 */
export function buildKnowledgeNoteBody(kind: KnowledgeTemplateKind, title: string): string {
  const heading = `# ${title}`;
  switch (kind) {
    case 'book-brief':
      return join([
        heading,
        '## Идея',
        '_Кратко опишите главную идею книги._',
        '## Целевая аудитория',
        '_Для кого написана эта книга._',
        '## Жанр и тон',
        '_Жанр, стиль и настроение повествования._',
        '## Конфликт',
        '_Основной конфликт или вопрос, вокруг которого строится сюжет._',
        '## Развязка',
        '_Куда движется история и к чему приходит._'
      ]);
    case 'book-plan':
      return join([
        heading,
        '## Часть I',
        '- _Глава 1 — краткое описание._\n- _Глава 2 — краткое описание._',
        '## Часть II',
        '- _Глава 3 — краткое описание._',
        '## Заметки',
        '_Свободные заметки по структуре книги._'
      ]);
    case 'sample-contents':
      return join([
        heading,
        '## Оглавление',
        '1. _Введение_\n2. _Глава первая_\n3. _Глава вторая_\n4. _Заключение_'
      ]);
    case 'empty':
    default:
      // Mirrors the historical `buildKnowledgeNoteMarkdown`: an H1 and a blank line.
      return `${heading}\n\n`;
  }
}

/** Join skeleton blocks with a blank line between them and a trailing newline. */
function join(blocks: string[]): string {
  return `${blocks.join('\n\n')}\n`;
}
