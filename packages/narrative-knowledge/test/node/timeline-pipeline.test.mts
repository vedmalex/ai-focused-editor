/**
 * A timeline file, edited on disk, reaching the SERVICE (gh#48 WP-3).
 *
 * WHY THIS FILE EXISTS AND WHY IT LOOKS EXPENSIVE. Every piece below is covered
 * one layer down already: `classifyDocument` by its own unit teeth,
 * `extractEvents` by WP-1's, `putEvent`/`listEvents`/the ordering by WP-2's
 * contract suite against both adapters. What NONE of them can see is the thing
 * WP-3 actually delivers — that an author who saves `knowledge/timeline/main.yaml`
 * gets an event back out of `NarrativeKnowledgeService`. Between the parser and
 * that answer sit the disk walk, classification, the catalog the resolution flag
 * is computed from, the escalation decision, the increment's write branch and
 * the store. gh#46 shipped seven defects that every green test missed by
 * asserting the layer BESIDE the goal; the ninth was in this very package, where
 * a test reimplemented a service method and asserted against its own copy.
 *
 * So: a real temp workspace on a real disk, the real walk, the real
 * `NodeNarrativeKnowledgeService`, the real SQLite store, and the answer read
 * back through the service's own methods.
 *
 * THE NEGATIVE TWINS ARE SHAPED LIKE THE POSITIVE ONE, deliberately.
 * `knowledge/plans/act-1.yaml` and `knowledge/timeline/nested/dir/events.yaml`
 * carry VALID `events:` lists with parsable entries, so a rule that keyed on
 * CONTENT rather than on path — or on the word "timeline" appearing anywhere in
 * it, or on an arbitrary depth under the directory — produces events from them
 * and fails here. Fixtures holding empty or malformed files would have let all
 * three of those implementations pass.
 *
 * WHAT THESE TWINS DO NOT PROVE, STATED SO NOBODY READS MORE INTO THEM. Under
 * F-12 the walk skips unreadable files under `knowledge/` outright, so within
 * that directory "the walk refused it" and "classification refused it" are ONE
 * rule with one spelling (`narrativeIndexMayReadUnder` is derived from
 * `isTimelineDocumentPath`) — and a pipeline test cannot separate them, because
 * in production they are not separate. That the two cannot DISAGREE is asserted
 * where it belongs, in `document-classification.test.ts`; the depth rule itself
 * is owned by that file's unit teeth. This file owns the end-to-end claim.
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NarrativeIndexStoreRegistry } from '../../lib/node/narrative-index-store-registry.js';
import { NodeNarrativeKnowledgeService } from '../../lib/node/node-narrative-knowledge-service.js';
import { NarrativeMemoryConfigResolver } from '../../lib/node/narrative-memory-config-resolver.js';
import { disposeAll, makeWorkspace, must } from './harness.mts';

after(() => {
  disposeAll();
});

const TIMELINE = 'knowledge/timeline/main.yaml';
const NESTED_TIMELINE = 'knowledge/timeline/nested/dir/events.yaml';
const PLAN = 'knowledge/plans/act-1.yaml';

/** Two events: one placed in story order, one the author has not placed yet. */
const TIMELINE_TEXT = [
  'events:',
  '  - id: arrival',
  '    title: Иван приезжает',
  '    sequence: 10',
  '    chapter: content/ch-01.md',
  '    participants:',
  '      - char:ivan',
  '      - char:nobody',
  '  - id: unplaced',
  '    title: Что-то без номера',
  '    chapter: content/ch-02.md'
].join('\n');

/** The SAME shape, in a directory the index must not read. */
const DECOY_TEXT = (id: string) =>
  ['events:', `  - id: ${id}`, `    title: Не должно попасть в индекс`, '    sequence: 1'].join('\n');

function writeFile(root: string, relPath: string, text: string): void {
  const absolute = join(root, relPath);
  mkdirSync(join(absolute, '..'), { recursive: true });
  writeFileSync(absolute, text, 'utf8');
}

/**
 * The real service over a real manuscript on disk.
 *
 * NO `createWatcher`, on purpose: this file drives `updateDocument` and
 * `checkForChanges` itself, so that what is being asserted is the INDEX PATH and
 * not whether a filesystem watcher fired. The class documents that shape as
 * supported ("left unset the index still works — every write path goes through
 * the maintainer either way").
 */
function manuscriptService(name: string) {
  const workspace = makeWorkspace(name);
  writeFile(workspace.root, 'manifest.yaml', [
    'content:',
    '  - path: content/ch-01.md',
    '    title: Первая',
    '  - path: content/ch-02.md',
    '    title: Вторая'
  ].join('\n'));
  writeFile(workspace.root, 'entities/characters/ivan.yaml', ['id: ivan', 'name: Иван'].join('\n'));
  writeFile(workspace.root, 'content/ch-01.md', 'Приезд [[char:ivan|Ивана]].');
  writeFile(workspace.root, 'content/ch-02.md', 'Позже.');
  writeFile(workspace.root, TIMELINE, TIMELINE_TEXT);
  // The two decoys, both VALID timeline files by content.
  writeFile(workspace.root, PLAN, DECOY_TEXT('from-plans'));
  writeFile(workspace.root, NESTED_TIMELINE, DECOY_TEXT('from-nested'));

  const resolver = new NarrativeMemoryConfigResolver();
  const registry = new NarrativeIndexStoreRegistry({ resolver });
  const service = new NodeNarrativeKnowledgeService();
  // Field injection, the DI-free shape `maintainer-wiring.test.mts` established.
  (service as any).registry = registry;
  (service as any).resolver = resolver;
  return { service, root: workspace.root, canonicalRoot: realpathSync(workspace.root) };
}

/** Event ids the SERVICE reports, in story order. */
async function storyOrderIds(service: any, root: string): Promise<string[]> {
  const answer = await service.listEvents(root, { orderBy: 'story', direction: 'asc' });
  assert.equal(answer.state.state, 'ready', 'the fixture must produce a ready index');
  return answer.data.map((row: any) => row.event.id);
}

test('a rebuild puts the timeline file, and ONLY it, on the service', async () => {
  const { service, root } = manuscriptService('timeline-rebuild');
  await service.rebuild(root);

  const ids = await storyOrderIds(service, root);

  // POSITIVE and NEGATIVE in one assertion, so neither half can pass alone: an
  // implementation that reads nothing fails the first element, and one that
  // reads all of `knowledge/**` fails by carrying `from-plans`/`from-nested`.
  assert.deepEqual(ids, ['arrival', 'unplaced']);

  // The unplaced one TRAILS rather than disappearing, and says why.
  const answer = await service.listEvents(root, { orderBy: 'story', direction: 'asc' });
  assert.equal(answer.data[0].orderExclusion, undefined);
  assert.equal(answer.data[1].orderExclusion, 'no-sequence');
  assert.equal(answer.data[0].relPath, TIMELINE);
});

test('resolution really ran against the manuscript, both ways', async () => {
  const { service, root } = manuscriptService('timeline-resolution');
  await service.rebuild(root);

  const event = must(await service.getEvent(root, 'arrival'), 'the arrival event').data;
  const refs = new Map(must(event, 'event data').event.refs.map((ref: any) => [ref.raw, ref.resolved]));

  // A card defines `ivan`, so the reference resolves...
  assert.equal(refs.get('char:ivan'), true);
  // ...and nothing defines `nobody`, so it is KEPT with the flag rather than
  // dropped. Without the paired positive above, an extractor that marked
  // everything unresolved would pass this line.
  assert.equal(refs.get('char:nobody'), false);
});

test('editing the timeline file reaches the service, WITHOUT escalating to a rebuild', async () => {
  const { service, root } = manuscriptService('timeline-increment');
  await service.rebuild(root);
  assert.deepEqual(await storyOrderIds(service, root), ['arrival', 'unplaced']);

  // The author adds an event and saves.
  writeFile(root, TIMELINE, `${TIMELINE_TEXT}\n  - id: departure\n    title: Отъезд\n    sequence: 20\n`);
  const report = await service.updateDocument(join(root, TIMELINE));

  // THE STATE THE AUTHOR SEES, read through the service.
  assert.deepEqual(await storyOrderIds(service, root), ['arrival', 'departure', 'unplaced']);

  // AND it stayed an increment. This half is what stops the tooth from being
  // satisfied by a pipeline that silently rebuilds the whole manuscript on every
  // timeline save — the answer would be right and the cost would be a defect no
  // assertion about the answer could see.
  assert.equal(report.data.mode, 'incremental');
  assert.deepEqual(report.data.documentsReindexed, [TIMELINE]);
  assert.equal(report.data.eventsWritten, 3, 'the file was re-read, so all three of its events were written');
});

test('a removed event disappears — the increment replaces, it does not append', async () => {
  const { service, root } = manuscriptService('timeline-shrink');
  await service.rebuild(root);
  assert.deepEqual(await storyOrderIds(service, root), ['arrival', 'unplaced']);

  writeFile(root, TIMELINE, ['events:', '  - id: arrival', '    title: Иван приезжает', '    sequence: 10'].join('\n'));
  await service.updateDocument(join(root, TIMELINE));

  // The paired negative of the test above: without `clearDocumentContent`
  // dropping the file's previous events, `unplaced` survives its own deletion
  // and the timeline grows forever.
  assert.deepEqual(await storyOrderIds(service, root), ['arrival']);
  assert.equal((await service.getEvent(root, 'unplaced')).data, undefined);
});

test('a change delivered by the SWEEP reaches the service too', async () => {
  const { service, root } = manuscriptService('timeline-sweep');
  await service.rebuild(root);

  // Nobody tells the index anything: no watcher event, no `updateDocument`.
  // This is the path an external edit takes (`git checkout`, another editor),
  // and ISS-371 makes it the path an in-IDE edit takes too whenever the watcher
  // has gone quiet.
  writeFile(root, TIMELINE, `${TIMELINE_TEXT}\n  - id: swept-in\n    title: Через обход\n    sequence: 30\n`);
  const report = await service.checkForChanges(root);

  assert.deepEqual(await storyOrderIds(service, root), ['arrival', 'swept-in', 'unplaced']);
  assert.equal(report.data.mode, 'incremental', 'a sweep over a timeline edit must not escalate either');
});

test('a decoy under knowledge/ stays invisible even when it is the ONLY thing edited', async () => {
  const { service, root } = manuscriptService('timeline-decoy-edit');
  await service.rebuild(root);

  // Edit both decoys and ask the index to catch up by every route it has.
  writeFile(root, PLAN, DECOY_TEXT('plans-edited'));
  writeFile(root, NESTED_TIMELINE, DECOY_TEXT('nested-edited'));
  await service.updateDocument(join(root, PLAN));
  await service.updateDocument(join(root, NESTED_TIMELINE));
  await service.checkForChanges(root);

  // Still exactly the real timeline's events — and the PAIRED POSITIVE is that
  // there are two of them rather than none, so "invisible" cannot be satisfied
  // by an index that reads no timeline at all.
  assert.deepEqual(await storyOrderIds(service, root), ['arrival', 'unplaced']);

  const documents = await service.listDocuments(root);
  const paths = documents.data.map((row: any) => row.relPath);
  assert.ok(paths.includes(TIMELINE), 'the timeline file IS a document');
  assert.ok(!paths.includes(PLAN), 'a scene plan is not');
  assert.ok(!paths.includes(NESTED_TIMELINE), 'and neither is a nested file under the timeline directory');
});

test('manuscript order and story order really differ, and each excludes for its own reason', async () => {
  const { service, root } = manuscriptService('timeline-two-orders');
  // A flashback: the LOW sequence sits in the LATE chapter, so the two orders
  // are each other's reverse. A fixture where they agreed would let one
  // implementation serve both.
  writeFile(root, TIMELINE, [
    'events:',
    '  - id: flashback',
    '    title: Воспоминание',
    '    sequence: 1',
    '    chapter: content/ch-02.md',
    '  - id: present',
    '    title: Настоящее',
    '    sequence: 2',
    '    chapter: content/ch-01.md',
    '  - id: homeless',
    '    title: Без главы',
    '    sequence: 3'
  ].join('\n'));
  await service.rebuild(root);

  const story = await service.listEvents(root, { orderBy: 'story', direction: 'asc' });
  assert.deepEqual(story.data.map((row: any) => row.event.id), ['flashback', 'present', 'homeless']);
  // Placeable in story order: it has a sequence, chapter or no chapter.
  assert.equal(story.data[2].orderExclusion, undefined);

  const manuscript = await service.listEvents(root, { orderBy: 'manuscript', direction: 'asc' });
  assert.deepEqual(manuscript.data.map((row: any) => row.event.id), ['present', 'flashback', 'homeless']);
  // The SAME event is unplaceable here, and for a reason belonging to THIS
  // order. One shared exclusion flag could not say both things.
  assert.equal(manuscript.data[2].orderExclusion, 'no-chapter');
});

test('an event naming a chapter that does not exist is stored, and says which kind of missing', async () => {
  const { service, root } = manuscriptService('timeline-missing-chapter');
  writeFile(root, TIMELINE, [
    'events:',
    '  - id: real-chapter',
    '    title: В настоящей главе',
    '    sequence: 1',
    '    chapter: content/ch-01.md',
    '  - id: ghost-chapter',
    '    title: В несуществующей главе',
    '    sequence: 2',
    '    chapter: content/ch-99.md',
    '  - id: no-chapter-at-all',
    '    title: Без главы',
    '    sequence: 3'
  ].join('\n'));

  // FIRST: the write must not blow up. An implementation that insisted on
  // resolving the named chapter before storing the event would fail the whole
  // rebuild on one typo in one timeline entry — taking the entire index down
  // with it.
  const rebuild = await service.rebuild(root);
  assert.equal(rebuild.state.state, 'ready');

  const manuscript = await service.listEvents(root, { orderBy: 'manuscript', direction: 'asc' });
  const reasons = new Map(manuscript.data.map((row: any) => [row.event.id, row.orderExclusion]));

  // THREE OUTCOMES, AND THE MIDDLE ONE IS THE POINT. "The author named a
  // chapter that does not exist" is a fixable authoring mistake; "the author
  // named no chapter" is not a mistake at all. An implementation that dropped
  // `chapterPath` when it failed to resolve would report both as `no-chapter`
  // and send the author looking for the wrong problem.
  assert.equal(reasons.get('real-chapter'), undefined);
  assert.equal(reasons.get('ghost-chapter'), 'chapter-not-indexed');
  assert.equal(reasons.get('no-chapter-at-all'), 'no-chapter');

  // The named path survives the round trip, so a diagnostic can quote it.
  const ghost = must((await service.getEvent(root, 'ghost-chapter')).data, 'the ghost event');
  assert.equal(ghost.event.chapterPath, 'content/ch-99.md');
});

test('a second file claiming an indexed event id is recorded, not silently overwritten', async () => {
  const { service, root } = manuscriptService('timeline-collision-increment');
  const SIDE = 'knowledge/timeline/zz-side.yaml';
  await service.rebuild(root);
  assert.equal(
    must((await service.getEvent(root, 'arrival')).data, 'the arrival event').event.title,
    'Иван приезжает',
    'the id belongs to the main timeline to begin with'
  );

  // The author writes a SECOND timeline file and reuses an id already taken.
  // This is an increment: creating a timeline file does not escalate.
  writeFile(root, SIDE, [
    'events:',
    '  - id: arrival',
    '    title: Тот же id, другой файл',
    '    sequence: 99',
    '  - id: side-only',
    '    title: Собственное событие',
    '    sequence: 100'
  ].join('\n'));
  const report = await service.updateDocument(join(root, SIDE));
  assert.equal(report.data.mode, 'incremental', 'a new timeline file is still an increment');

  // THE INCUMBENT KEEPS THE ID. Having read ONE file, this pass cannot know
  // where the other sorts, so it must not overwrite a claim it cannot compare
  // against — and the assertion is on the TITLE, because a check on the path
  // alone would pass against an implementation that overwrote the payload.
  const winner = must((await service.getEvent(root, 'arrival')).data, 'the contested event');
  assert.equal(winner.relPath, TIMELINE);
  assert.equal(winner.event.title, 'Иван приезжает', 'the incumbent’s payload survived');

  // AND THE LOSING CLAIM IS REPORTED. Without this the collision is destroyed
  // by the write that resolved it, and gh#50 has nothing to make a verdict from.
  const duplicates = await service.getDuplicateEvents(root);
  assert.deepEqual(duplicates.data.map((row: any) => row.eventId), ['arrival']);
  assert.equal(duplicates.data[0].keptRelPath, TIMELINE);
  assert.deepEqual(duplicates.data[0].excludedRelPaths, [SIDE]);

  // PAIRED POSITIVE: the losing file is not disqualified wholesale — its own,
  // uncontested event is indexed normally. A pass that simply dropped every
  // event of a colliding file would satisfy everything above.
  assert.equal(must((await service.getEvent(root, 'side-only')).data, 'the side event').relPath, SIDE);

  // AND THE COLLISION ENDS WHEN THE AUTHOR FIXES IT. The loser renames its id;
  // the ordinary increment must clear the record, or the diagnostic outlives
  // the defect it describes.
  writeFile(root, SIDE, [
    'events:',
    '  - id: arrival-side',
    '    title: Переименовано',
    '    sequence: 99',
    '  - id: side-only',
    '    title: Собственное событие',
    '    sequence: 100'
  ].join('\n'));
  await service.updateDocument(join(root, SIDE));
  assert.deepEqual((await service.getDuplicateEvents(root)).data, [], 'the fixed collision is gone');
  assert.equal(must((await service.getEvent(root, 'arrival-side')).data, 'the renamed event').relPath, SIDE);
});

test('writing the chapter afterwards places the event — through the service, incrementally', async () => {
  const { service, root } = manuscriptService('timeline-chapter-arrives-later');
  // The ordinary way an author works: the manifest already promises a third
  // chapter, the event is written first, the prose comes later.
  writeFile(root, 'manifest.yaml', [
    'content:',
    '  - path: content/ch-01.md',
    '    title: Первая',
    '  - path: content/ch-02.md',
    '    title: Вторая',
    '  - path: content/ch-03.md',
    '    title: Третья'
  ].join('\n'));
  writeFile(root, TIMELINE, [
    'events:',
    '  - id: in-first',
    '    title: В первой',
    '    sequence: 1',
    '    chapter: content/ch-01.md',
    '  - id: awaiting-chapter',
    '    title: Ждёт своей главы',
    '    sequence: 2',
    '    chapter: content/ch-03.md'
  ].join('\n'));
  await service.rebuild(root);

  const before = await service.listEvents(root, { orderBy: 'manuscript', direction: 'asc' });
  const awaiting = must(
    before.data.find((row: any) => row.event.id === 'awaiting-chapter'),
    'the event awaiting its chapter'
  );
  assert.equal(
    awaiting.orderExclusion,
    'chapter-not-indexed',
    'while the chapter file does not exist, the honest answer is that it is not indexed'
  );

  // The author writes the chapter. Creating a chapter is an INCREMENT — nothing
  // re-writes the event — which is precisely why an index that resolved the
  // chapter once, at the moment the event was stored, would never recover.
  writeFile(root, 'content/ch-03.md', 'Третья глава.');
  const report = await service.updateDocument(join(root, 'content/ch-03.md'));
  assert.equal(report.data.mode, 'incremental', 'and it really was an increment, not a hidden rebuild');

  // THE STATE THE AUTHOR SEES. The same service that now lists the chapter as a
  // document must place the event that names it; answering `chapter-not-indexed`
  // about a chapter its own `listDocuments` reports is the index contradicting
  // itself, and no assertion about the chapter alone would catch it.
  const documents = await service.listDocuments(root);
  assert.ok(documents.data.some((row: any) => row.relPath === 'content/ch-03.md'));

  const after = await service.listEvents(root, { orderBy: 'manuscript', direction: 'asc' });
  assert.deepEqual(after.data.map((row: any) => row.event.id), ['in-first', 'awaiting-chapter']);
  assert.equal(after.data[1].orderExclusion, undefined, 'the event is placed, not merely present');
});
