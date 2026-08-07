import { describe, expect, test } from 'bun:test';
import { extractEntityMentions, splitEntityMentions } from './entity-mentions';

describe('extractEntityMentions', () => {
  test('parses the kind:id|label form', () => {
    expect(extractEntityMentions('On the field, [[char:krishna|Krishna]] waits.')).toEqual([
      { raw: '[[char:krishna|Krishna]]', kind: 'char', id: 'krishna', label: 'Krishna' }
    ]);
  });

  test('parses the bare [[id]] fallback form', () => {
    expect(extractEntityMentions('See [[gandiva]] for the bow.')).toEqual([
      { raw: '[[gandiva]]', id: 'gandiva' }
    ]);
  });

  test('handles kind:id without a label and mixed forms in order', () => {
    expect(extractEntityMentions('[[term:dharma]] and [[arjuna]] and [[char:krishna|Krishna]]')).toEqual([
      { raw: '[[term:dharma]]', kind: 'term', id: 'dharma' },
      { raw: '[[arjuna]]', id: 'arjuna' },
      { raw: '[[char:krishna|Krishna]]', kind: 'char', id: 'krishna', label: 'Krishna' }
    ]);
  });

  test('de-duplicates repeated mentions by kind and id', () => {
    expect(extractEntityMentions('[[char:krishna|Krishna]] ... [[char:krishna|Govinda]] ... [[krishna]]')).toEqual([
      { raw: '[[char:krishna|Krishna]]', kind: 'char', id: 'krishna', label: 'Krishna' },
      // Same kind+id collapses even with a different label; bare form has no kind, so it is distinct.
      { raw: '[[krishna]]', id: 'krishna' }
    ]);
  });

  test('returns an empty array when there are no mentions', () => {
    expect(extractEntityMentions('Just prose, no references at all.')).toEqual([]);
    expect(extractEntityMentions('')).toEqual([]);
  });
});

describe('splitEntityMentions', () => {
  test('interleaves text and mention segments in order, keeping duplicates', () => {
    expect(splitEntityMentions('Meet [[char:krishna|Krishna]] and [[krishna]] again.')).toEqual([
      { type: 'text', value: 'Meet ' },
      { type: 'mention', mention: { raw: '[[char:krishna|Krishna]]', kind: 'char', id: 'krishna', label: 'Krishna' } },
      { type: 'text', value: ' and ' },
      { type: 'mention', mention: { raw: '[[krishna]]', id: 'krishna' } },
      { type: 'text', value: ' again.' }
    ]);
  });

  test('returns a single text segment when there are no mentions', () => {
    expect(splitEntityMentions('plain text')).toEqual([{ type: 'text', value: 'plain text' }]);
    expect(splitEntityMentions('')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ISS-362 (gh#72) — code is an example, not a reference.
//
// The two scanners here were the last ones left blind after ISS-358 taught the
// diagnostic-producing parsers the same rule. Each positive below is paired
// with a case that would still pass if the guard were written as "always skip",
// so a guard that over-reaches reddens too.
// ---------------------------------------------------------------------------

describe('mentions inside code are examples, not references (ISS-362)', () => {
  test('extract: a mention inside an inline code span is not counted', () => {
    expect(extractEntityMentions('Write `[[char:krishna]]` to link him.')).toEqual([]);
  });

  test('extract: a mention inside a fenced block is not counted', () => {
    const text = ['Example:', '```', '[[char:krishna]]', '```'].join('\n');
    expect(extractEntityMentions(text)).toEqual([]);
  });

  test('extract, PAIRED POSITIVE: the same mention in prose IS counted', () => {
    // "Always skip" must fail here — this is the case that keeps the guard honest.
    expect(extractEntityMentions('Krishna is [[char:krishna]] in prose.')).toEqual([
      { raw: '[[char:krishna]]', kind: 'char', id: 'krishna' }
    ]);
  });

  test('extract: prose and code in ONE string — only the prose mention survives', () => {
    expect(extractEntityMentions('Real [[char:krishna]], example `[[char:arjuna]]`.')).toEqual([
      { raw: '[[char:krishna]]', kind: 'char', id: 'krishna' }
    ]);
  });

  test('extract: a code example does not suppress the SAME id later in prose', () => {
    // De-duplication runs on surviving matches only, so a skipped example must
    // not claim the `seen` key and hide the real reference behind it.
    expect(extractEntityMentions('`[[char:krishna]]` then really [[char:krishna]].')).toEqual([
      { raw: '[[char:krishna]]', kind: 'char', id: 'krishna' }
    ]);
  });

  test('split: a mention inside code stays plain text, it does not vanish', () => {
    expect(splitEntityMentions('Write `[[char:krishna]]` here.')).toEqual([
      { type: 'text', value: 'Write `[[char:krishna]]` here.' }
    ]);
  });

  test('split: a code example between two real mentions keeps its place in the prose', () => {
    expect(splitEntityMentions('[[a]] and `[[b]]` and [[c]]')).toEqual([
      { type: 'mention', mention: { raw: '[[a]]', id: 'a' } },
      { type: 'text', value: ' and `[[b]]` and ' },
      { type: 'mention', mention: { raw: '[[c]]', id: 'c' } }
    ]);
  });

  test('split: a FENCED-BLOCK token stays a text segment, asserted directly', () => {
    // The byte-for-byte invariant below would ALSO be satisfied by a split that
    // emitted this token as a mention segment (concatenation uses `raw`), so
    // the fenced case needs its own assertion on the segment KIND. Inline code
    // is covered above; this is its fenced twin.
    const text = ['Example:', '```', '[[char:krishna]]', '```'].join('\n');
    expect(splitEntityMentions(text).every(segment => segment.type === 'text')).toBe(true);
  });

  test('split: THE LOAD-BEARING INVARIANT — segments still reproduce the input byte for byte', () => {
    // This is the tooth for "post-filter, never mutate". A `continue` that also
    // advanced the cursor would silently DELETE the skipped token from the
    // rendered card; only this assertion catches that.
    const inputs = [
      'Write `[[char:krishna]]` here.',
      '[[a]] and `[[b]]` and [[c]]',
      ['Example:', '```', '[[char:krishna]]', '```', 'after [[real]]'].join('\n'),
      'no mentions at all',
      '`[[only]]`'
    ];
    for (const input of inputs) {
      const rebuilt = splitEntityMentions(input)
        .map(segment => (segment.type === 'text' ? segment.value : segment.mention.raw))
        .join('');
      expect(rebuilt).toBe(input);
    }
  });
});
