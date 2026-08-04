import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  InMemoryNarrativeIndexStore,
  NarrativeIndexSession,
  OWNERSHIP_REL_TYPE,
  envelope,
  extractManifestChapters,
  type EntityQuery,
  type MentionQuery,
  type NarrativeDocumentSummary,
  type RelationQuery
} from '@ai-focused-editor/narrative-knowledge';
import { scanWorkspaceFiles } from '@ai-focused-editor/narrative-knowledge/lib/node/narrative-workspace-scan';
import { NARRATIVE_INDEX_SCHEMA_VERSION } from '@ai-focused-editor/narrative-knowledge/lib/node/narrative-index-schema';
import type {
  NarrativeGraphSnapshot,
  NarrativeRelationEdge
} from '../common';
import { NodeNarrativeGraphService } from './node-narrative-graph-service';

/**
 * TASK-022 WP-7: `NodeNarrativeGraphService` no longer scans `entities/**` and
 * `manifest.yaml` itself — it delegates to `NarrativeKnowledgeService`
 * (tech_spec TECH_SPEC WP-7 §1/§7). The fixture below writes REAL files to disk
 * (unchanged from before this migration) but feeds them through
 * `NarrativeIndexSession.rebuild()` over `InMemoryNarrativeIndexStore` — the
 * same in-memory-index technique `narrative-consumer-baseline.test.ts` uses for
 * the three already-migrated consumers, reused rather than inventing a third
 * approach (this file's own obstacle #3).
 */

const SCRATCH_BASE = process.env.CLAUDE_SCRATCHPAD_DIR
  || '/private/tmp/claude-501/-Users-vedmalex-work-ai-editor-3/8a15f000-cd38-4649-8fe4-b479e61f41c1/scratchpad/narrative-graph-test';

async function makeRoot(): Promise<string> {
  const base = SCRATCH_BASE.startsWith('/') ? SCRATCH_BASE : tmpdir();
  await fs.mkdir(base, { recursive: true });
  return fs.mkdtemp(join(base, 'afe-narrative-'));
}

async function write(root: string, relative: string, content: string): Promise<void> {
  const path = join(root, relative);
  await fs.mkdir(join(path, '..'), { recursive: true });
  await fs.writeFile(path, content);
}

/** Build a small but exercised workspace: nested manifest, tagged chapters, entity cards. */
async function seedWorkspace(root: string): Promise<void> {
  await write(root, 'manifest.yaml', [
    'version: 1',
    'content:',
    '  - path: content/ch1.md',
    '    title: Chapter One',
    '  - path: content/part-1',
    '    title: Part One',
    '    children:',
    '      - path: content/part-1/ch2.md',
    '        title: Chapter Two',
    '      - path: content/part-1/ch3.md',
    '        title: Chapter Three',
    '  - path: content/notes.md',
    '    title: Draft Notes',
    '    include: false',
    ''
  ].join('\n'));

  await write(root, 'content/ch1.md', [
    '# Chapter One',
    '[[char:krishna|Krishna]] and [[char:arjuna|Arjuna]] stand together.',
    '[[char:krishna|Krishna]] lifts [[artifact:gandiva|Gandiva]].',
    ''
  ].join('\n'));
  await write(root, 'content/part-1/ch2.md', [
    '# Chapter Two',
    '[[char:krishna|Krishna]] teaches [[char:arjuna|Arjuna]] about [[term:dharma|dharma]].',
    ''
  ].join('\n'));
  await write(root, 'content/part-1/ch3.md', [
    '# Chapter Three',
    '[[char:arjuna|Arjuna]] raises [[artifact:gandiva|Gandiva]] again.',
    ''
  ].join('\n'));
  await write(root, 'content/notes.md', [
    '# Notes',
    'Check [[char:krishna|Krishna]] epithets.',
    ''
  ].join('\n'));

  await write(root, 'entities/characters/krishna.yaml', 'id: krishna\nname: Krishna\n');
  await write(root, 'entities/characters/arjuna.yaml', 'id: arjuna\nname: Arjuna\n');
  await write(root, 'entities/terms/dharma.yaml', 'term: Dharma\n');
  await write(root, 'entities/artifacts/gandiva.yaml', [
    'id: gandiva',
    'name: Gandiva',
    'ownership:',
    '  - owner: varuna',
    '    to: the age of gods',
    '    note: guards the bow',
    '  - owner: arjuna',
    '    from: the great war',
    '    note: wields it in battle',
    ''
  ].join('\n'));
}

function edge(relations: NarrativeRelationEdge[], a: string, b: string): NarrativeRelationEdge | undefined {
  return relations.find(item =>
    (item.source === a && item.target === b) || (item.source === b && item.target === a));
}

/**
 * Minimal `NarrativeKnowledgeService` double covering exactly the five methods
 * `NodeNarrativeGraphService` calls — the same technique
 * `narrative-consumer-baseline.test.ts`'s `buildFixtureKnowledgeService` uses,
 * kept local because this file's fixture (`seedWorkspace`) is independent of
 * that one's.
 */
function buildFixtureKnowledgeService(rootPath: string) {
  const store = new InMemoryNarrativeIndexStore();
  const session = new NarrativeIndexSession({ store, schemaVersion: NARRATIVE_INDEX_SCHEMA_VERSION });
  session.rebuild(scanWorkspaceFiles(rootPath));

  return {
    async getManifestChapters() {
      let text: string | undefined;
      try {
        text = await fs.readFile(join(rootPath, 'manifest.yaml'), 'utf8');
      } catch {
        text = undefined;
      }
      return envelope(session.state(), extractManifestChapters(text));
    },
    async listDocuments() {
      return envelope(
        session.state(),
        session.documents().map((document): NarrativeDocumentSummary => document)
      );
    },
    async findEntities(_rootUri: string, query?: EntityQuery) {
      return session.findEntities(query);
    },
    async getMentions(_rootUri: string, query?: MentionQuery) {
      return session.getMentions(query);
    },
    async getRelations(_rootUri: string, query?: RelationQuery) {
      return session.getRelations(query);
    }
  };
}

/** Wire a `NodeNarrativeGraphService` to the fixture double by field assignment
 *  — `@inject` fields are plain instance properties, and this bypasses Inversify
 *  entirely (the same pattern `narrative-consumer-baseline.test.ts` uses for
 *  `EntityCardsWidget`/`ManuscriptFindEntitiesTool`). */
function buildService(rootPath: string): NodeNarrativeGraphService {
  const service = Object.create(NodeNarrativeGraphService.prototype) as NodeNarrativeGraphService;
  (service as unknown as { knowledge: unknown }).knowledge = buildFixtureKnowledgeService(rootPath);
  return service;
}

describe('NodeNarrativeGraphService', () => {
  let root: string;
  let service: NodeNarrativeGraphService;

  beforeEach(async () => {
    root = await makeRoot();
    service = buildService(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  test('returns an info diagnostic when no workspace is open', async () => {
    const snapshot = await service.getSnapshot(undefined);
    expect(snapshot.timeline).toEqual([]);
    expect(snapshot.relations).toEqual([]);
    expect(snapshot.diagnostics[0]).toEqual({
      severity: 'info',
      source: 'narrative-graph',
      message: 'Open a manuscript workspace to view the narrative map.'
    });
  });

  test('timeline order follows manifest content order (incl. nested children)', async () => {
    await seedWorkspace(root);
    service = buildService(root);
    const snapshot = await service.getSnapshot(root);

    expect(snapshot.timeline.map(chapter => chapter.path)).toEqual([
      'content/ch1.md',
      'content/part-1/ch2.md',
      'content/part-1/ch3.md',
      'content/notes.md'
    ]);
    expect(snapshot.timeline.map(chapter => chapter.order)).toEqual([0, 1, 2, 3]);
    expect(snapshot.timeline.map(chapter => chapter.title)).toEqual([
      'Chapter One',
      'Chapter Two',
      'Chapter Three',
      'Draft Notes'
    ]);
    // include: false propagates to buildIncluded.
    expect(snapshot.timeline[3].buildIncluded).toBe(false);
    expect(snapshot.timeline[0].buildIncluded).toBe(true);
  });

  test('counts per-chapter appearances and resolves labels from entity cards', async () => {
    await seedWorkspace(root);
    service = buildService(root);
    const snapshot = await service.getSnapshot(root);

    const ch1 = snapshot.timeline[0];
    // Sorted by count desc, then label (all three labels are Latin-script here,
    // so the `ru` collator tie-break agrees with plain code-point order and
    // this assertion is unaffected by the WP-7 collator change).
    expect(ch1.entities).toEqual([
      { kind: 'character', id: 'krishna', label: 'Krishna', count: 2 },
      { kind: 'character', id: 'arjuna', label: 'Arjuna', count: 1 },
      { kind: 'artifact', id: 'gandiva', label: 'Gandiva', count: 1 }
    ]);

    const ch2 = snapshot.timeline[1];
    const dharma = ch2.entities.find(entity => entity.id === 'dharma');
    expect(dharma).toEqual({ kind: 'term', id: 'dharma', label: 'Dharma', count: 1 });
  });

  test('computes co-occurrence edges weighted by shared chapters', async () => {
    await seedWorkspace(root);
    service = buildService(root);
    const snapshot = await service.getSnapshot(root);

    // krishna+arjuna share ch1 and ch2 -> weight 2.
    expect(edge(snapshot.relations, 'character:krishna', 'character:arjuna')?.weight).toBe(2);
    // arjuna+gandiva share ch1 and ch3 -> weight 2.
    expect(edge(snapshot.relations, 'character:arjuna', 'artifact:gandiva')?.weight).toBe(2);
    // krishna+gandiva share only ch1 -> weight 1.
    expect(edge(snapshot.relations, 'character:krishna', 'artifact:gandiva')?.weight).toBe(1);
    // gandiva+dharma never co-occur.
    expect(edge(snapshot.relations, 'artifact:gandiva', 'term:dharma')).toBeUndefined();

    const shared = edge(snapshot.relations, 'character:krishna', 'character:arjuna');
    expect(shared?.sourceLabel && shared?.targetLabel).toBeTruthy();
    expect(shared?.sharedChapters.length).toBe(2);
  });

  test('ranks nodes by total appearances', async () => {
    await seedWorkspace(root);
    service = buildService(root);
    const snapshot = await service.getSnapshot(root);

    expect(snapshot.totalEntities).toBe(4);
    expect(snapshot.truncated).toBe(false);
    const byId = new Map(snapshot.nodes.map(node => [node.entityId, node.appearances]));
    // krishna: 2+1+1, arjuna: 1+1+1, gandiva: 1+1, dharma: 1.
    expect(byId.get('krishna')).toBe(4);
    expect(byId.get('arjuna')).toBe(3);
    expect(byId.get('gandiva')).toBe(2);
    expect(byId.get('dharma')).toBe(1);
    expect(snapshot.nodes[0].entityId).toBe('krishna');
  });

  test('parses artifact ownership chains and resolves owner labels', async () => {
    await seedWorkspace(root);
    service = buildService(root);
    const snapshot = await service.getSnapshot(root);

    expect(snapshot.ownership).toHaveLength(1);
    const gandiva = snapshot.ownership[0];
    expect(gandiva.artifactId).toBe('gandiva');
    expect(gandiva.artifactLabel).toBe('Gandiva');
    expect(gandiva.entries.map(entry => entry.owner)).toEqual(['varuna', 'arjuna']);
    // varuna is not an entity -> falls back to raw id; arjuna resolves to its card label.
    expect(gandiva.entries.map(entry => entry.ownerLabel)).toEqual(['varuna', 'Arjuna']);
    expect(gandiva.entries[0].to).toBe('the age of gods');
    expect(gandiva.entries[0].note).toBe('guards the bow');
    expect(gandiva.entries[1].from).toBe('the great war');
  });

  /**
   * ПРАВКА WP-7, ПРИЧИНА — ДИАГНОСТИКА СТАЛА НЕДОСТИЖИМОЙ, А НЕ ИЗМЕНИВШЕЕСЯ
   * ПОВЕДЕНИЕ ХРАНЕНИЯ. `Ignoring ownership for X: …` / `Ignoring ownership
   * entry N for X: …` were emitted by the pre-migration reader's OWN YAML parse
   * of `entities/artifacts/*.yaml`. `NodeNarrativeGraphService` no longer reads
   * that YAML — malformed ownership is now caught by
   * `entity-card-extraction.ts`'s `collectOwnership`, which reports an
   * `EntityCardProblem`. That problem is forwarded only through
   * `NarrativeRebuildReport.problems.cards` (`rebuild()`'s report), which this
   * class deliberately does not call (a full, write-guarded pass to answer a
   * read). This is the SAME reachability gap as `getManifestChapters` closes for
   * "missing chapter file" — recorded rather than silently dropped, following
   * the precedent `entity-cards-widget.ts:26-34` sets for per-card diagnostics
   * this package does not yet have a cheap query for.
   *
   * What survives unchanged: `collectOwnership` still drops the malformed
   * ENTRY (or the whole non-list value) before a relation is ever built for it,
   * so `broken` still contributes no transfer and `shield` still contributes
   * only its one valid hop — verified by running, not assumed.
   */
  test('malformed ownership entries are dropped from the graph, without a diagnostic (recorded gap)', async () => {
    await seedWorkspace(root);
    await write(root, 'entities/artifacts/broken.yaml', [
      'id: broken',
      'name: Broken Relic',
      'ownership: not-a-list',
      ''
    ].join('\n'));
    await write(root, 'entities/artifacts/shield.yaml', [
      'id: shield',
      'name: Shield',
      'ownership:',
      '  - owner: bhima',
      '    note: carries it',
      '  - note: entry without an owner',
      ''
    ].join('\n'));
    service = buildService(root);

    const snapshot: NarrativeGraphSnapshot = await service.getSnapshot(root);

    // `broken` produced no transfer; `shield` kept only its valid hop.
    expect(snapshot.ownership.find(transfer => transfer.artifactId === 'broken')).toBeUndefined();
    const shield = snapshot.ownership.find(transfer => transfer.artifactId === 'shield');
    expect(shield?.entries.map(entry => entry.owner)).toEqual(['bhima']);

    // Recorded gap: no `narrative-graph` diagnostic reports either malformation
    // (see the test's doc comment above for why, and what would close it).
    const ownershipWarnings = snapshot.diagnostics.filter(diagnostic =>
      diagnostic.message.toLowerCase().includes('ownership'));
    expect(ownershipWarnings).toEqual([]);
  });

  test('warns when the manifest is missing', async () => {
    const snapshot = await service.getSnapshot(root);
    expect(snapshot.timeline).toEqual([]);
    const warning = snapshot.diagnostics.find(diagnostic =>
      diagnostic.message.includes('Missing manifest.yaml'));
    expect(warning?.severity).toBe('warning');
  });
});
