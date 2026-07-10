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
