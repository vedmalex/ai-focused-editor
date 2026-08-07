/**
 * The excerpt rule (gh#47 WP-2, architecture §5.4).
 *
 * WHY THIS RUNS IN THE NODE LANE AND NOT UNDER `bun`: the whole rule is about
 * what is on DISK versus what the index remembers, so a fake filesystem would
 * test the fake. Every case below writes real bytes and reads them back.
 *
 * THE FAILURE THIS EXISTS TO REFUSE is not "no excerpt" — it is a CONFIDENTLY
 * WRONG one. The index stores a line and a column; if the file gained lines
 * above the mention, those coordinates still resolve, and the reader would
 * return real text from the wrong place, shown to the author as this entity's
 * evidence. So the assertions below are not merely "text is absent"; where the
 * document changed they check that the text is absent AND that the passage that
 * WOULD have been returned by an unchecked reader is not what came back.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { rangeEvidence, wholeFileEvidence } from '../../lib/common/index.js';
import { hashContent } from '../../lib/node/narrative-workspace-scan.js';
import { readEvidenceExcerpt } from '../../lib/node/evidence-excerpt.js';
import { makeWorkspace } from './harness.mts';

const CHAPTER = 'content/ch-01.md';
/** The quoted span sits on line 2 (0-based), columns 9..33. */
const ORIGINAL = ['# Глава', '', 'Вместе: [[char:krishna|Кришна]] идёт.', '', 'Конец.'].join('\n');
const QUOTED = '[[char:krishna|Кришна]]';

function workspaceWith(text: string): { root: string; hash: string } {
  const workspace = makeWorkspace('excerpt');
  mkdirSync(join(workspace.root, 'content'), { recursive: true });
  writeFileSync(join(workspace.root, CHAPTER), text, 'utf8');
  return { root: workspace.root, hash: hashContent(text) };
}

const span = rangeEvidence(CHAPTER, {
  start: { line: 2, character: 8 },
  end: { line: 2, character: 8 + QUOTED.length }
});

test('an untouched document is quoted exactly — the paired positive', async () => {
  const { root, hash } = workspaceWith(ORIGINAL);
  const excerpt = await readEvidenceExcerpt(root, span, hash);
  assert.equal(excerpt.text, QUOTED);
  assert.equal(excerpt.unavailable, undefined);
});

test('lines inserted ABOVE the mention: no excerpt, a stated reason, and never the wrong passage', async () => {
  const { root, hash } = workspaceWith(ORIGINAL);
  // Two lines added at the top. The stored coordinates now land on the blank
  // line and then on the heading's tail — text that exists, reads plausibly and
  // is not this mention.
  const shifted = ['Новый заголовок', '', ...ORIGINAL.split('\n')].join('\n');
  writeFileSync(join(root, CHAPTER), shifted, 'utf8');

  const excerpt = await readEvidenceExcerpt(root, span, hash);
  assert.equal(excerpt.text, undefined, 'a shifted document must not be quoted at all');
  assert.equal(excerpt.unavailable, 'document-changed');

  // AND THE PART THAT MAKES THIS A TOOTH RATHER THAN A RESTATEMENT: prove that
  // an unchecked reader WOULD have returned something, so the assertion above
  // is refusing a real wrong answer and not an empty one. Passing the CURRENT
  // hash is exactly what "skip the check" amounts to.
  const unchecked = await readEvidenceExcerpt(root, span, hashContent(shifted));
  assert.notEqual(unchecked.text, undefined, 'the fixture must actually shift the coordinates');
  assert.notEqual(unchecked.text, QUOTED, 'and it must land on different text');
});

test('after the index catches up, the same span is quoted from the new text', async () => {
  const { root } = workspaceWith(ORIGINAL);
  const shifted = ['Новый заголовок', '', ...ORIGINAL.split('\n')].join('\n');
  writeFileSync(join(root, CHAPTER), shifted, 'utf8');
  // Re-indexing moves the mention down by two lines and records the new hash.
  const reindexed = rangeEvidence(CHAPTER, {
    start: { line: 4, character: 8 },
    end: { line: 4, character: 8 + QUOTED.length }
  });
  const excerpt = await readEvidenceExcerpt(root, reindexed, hashContent(shifted));
  assert.equal(excerpt.text, QUOTED, 'the state self-heals — no special case, just a fresh hash and range');
});

test('whole-file evidence is not an error and not an empty quote', async () => {
  const { root, hash } = workspaceWith(ORIGINAL);
  const excerpt = await readEvidenceExcerpt(root, wholeFileEvidence(CHAPTER), hash);
  assert.equal(excerpt.text, undefined);
  assert.equal(excerpt.unavailable, 'no-position');
});

test('a deleted document says so, and does not blame the author for changing it', async () => {
  const { root, hash } = workspaceWith(ORIGINAL);
  const missing = rangeEvidence('content/gone.md', {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 3 }
  });
  const excerpt = await readEvidenceExcerpt(root, missing, hash);
  assert.equal(excerpt.unavailable, 'unreadable');
});

test('a long span is cut with a visible ellipsis rather than silently', async () => {
  const long = `${'а'.repeat(1000)}`;
  const { root, hash } = workspaceWith(long);
  const whole = rangeEvidence(CHAPTER, { start: { line: 0, character: 0 }, end: { line: 0, character: 1000 } });
  const excerpt = await readEvidenceExcerpt(root, whole, hash, { maxChars: 10 });
  assert.equal(excerpt.text, `${'а'.repeat(10)}…`);
});
