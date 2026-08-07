import { describe, expect, test } from 'bun:test';
import { findEntityTokenAt, shouldReindexOnSave } from './entity-token-at';

/** The predicate the hover backs with a snapshot and the card backs with the
 *  index. Here it is explicit, which is the point of injecting it. */
const KNOWN = (ids: string[]) => (id: string) => ids.includes(id);
const NONE = () => false;

describe('findEntityTokenAt — explicit tags', () => {
  const text = 'Вместе: [[char:krishna|Кришна]] и [[location:kurukshetra]].';

  test('the caret inside a tag resolves it, kind and id', () => {
    const token = findEntityTokenAt(text, text.indexOf('krishna') + 2, NONE);
    expect(token?.id).toBe('krishna');
    expect(token?.kind).toBe('char');
  });

  test('the caret in prose between two tags resolves nothing', () => {
    // PAIRED NEGATIVE: without it, a resolver that returns the first tag in the
    // document regardless of offset passes every positive case above.
    const token = findEntityTokenAt(text, text.indexOf(' и ') + 1, NONE);
    expect(token).toBeUndefined();
  });

  test('the second tag is found, not the first', () => {
    const token = findEntityTokenAt(text, text.indexOf('kurukshetra') + 2, NONE);
    expect(token?.id).toBe('kurukshetra');
  });

  test('offsets are computed across lines, not within one', () => {
    const multiline = `Первая строка.\n\nВторая: [[char:krishna|Кришна]].`;
    const token = findEntityTokenAt(multiline, multiline.indexOf('krishna') + 1, NONE);
    expect(token?.id).toBe('krishna');
    expect(multiline.slice(token!.startOffset, token!.endOffset)).toContain('krishna');
  });
});

describe('findEntityTokenAt — the note-first branch (ISS-151)', () => {
  /**
   * THE REGRESSION THIS GUARDS. Narrowing resolution to colon-shaped tokens once
   * made a bare `[[krishna]]` stop resolving as an entity, while a separate
   * chain elsewhere still resolved it — the product disagreeing with itself
   * about one token. The branch survives extraction only if it is asserted.
   */
  const text = 'Он вспомнил про [[krishna]] снова.';

  test('a bare token resolves as an entity WHEN the id is known', () => {
    const token = findEntityTokenAt(text, text.indexOf('krishna') + 1, KNOWN(['krishna']));
    expect(token?.id).toBe('krishna');
    expect(token?.kind).toBeUndefined();
  });

  test('PAIRED NEGATIVE: the same token declines when the id is unknown', () => {
    // A genuine note link. Declining is correct — and this pair is what tells a
    // working entity-first chain apart from one that resolves everything.
    expect(findEntityTokenAt(text, text.indexOf('krishna') + 1, NONE)).toBeUndefined();
  });

  test('the predicate is consulted with the bare id, not the raw token', () => {
    const seen: string[] = [];
    findEntityTokenAt(text, text.indexOf('krishna') + 1, id => {
      seen.push(id);
      return false;
    });
    expect(seen).toContain('krishna');
    expect(seen.some(id => id.includes('['))).toBe(false);
  });

  test('the predicate is NOT consulted for a caret in plain prose', () => {
    // The cost rule: cursor tracking calls this on every caret move, and an
    // entity lookup per keystroke over ordinary text is what makes that
    // unaffordable.
    let calls = 0;
    findEntityTokenAt('Обычная проза без ссылок.', 5, () => {
      calls++;
      return true;
    });
    expect(calls).toBe(0);
  });
});

describe('shouldReindexOnSave — the one question this side can answer', () => {
  const ROOTS = ['file:///w/book'];

  test('a file under the root is handed on', () => {
    expect(shouldReindexOnSave('file:///w/book/content/ch-01.md', ROOTS)).toBe(true);
  });

  test('a file outside every root is not', () => {
    expect(shouldReindexOnSave('file:///elsewhere/notes.md', ROOTS)).toBe(false);
  });

  test('a SIBLING sharing the root name prefix is not the root', () => {
    // The case the trailing slash exists for. Without it `file:///w/book-notes`
    // is claimed by the root `file:///w/book`, and saves from a different
    // manuscript are re-indexed into this one — a defect that would surface as
    // occasional phantom index churn and be very hard to attribute.
    expect(shouldReindexOnSave('file:///w/book-notes/ch-01.md', ROOTS)).toBe(false);
  });

  test('the root itself, with no path below it, is not a file', () => {
    expect(shouldReindexOnSave('file:///w/book', ROOTS)).toBe(false);
  });

  test('with several roots open, any of them counts', () => {
    expect(shouldReindexOnSave('file:///w/second/x.md', [...ROOTS, 'file:///w/second'])).toBe(true);
  });
});
