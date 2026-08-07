/**
 * Co-occurrence — relation source 6, the one source that is DERIVED rather than
 * read (TASK-022 WP-4a, plan WP-2 route table row 6, tech_spec ОВ-1
 * "Derived-связи").
 *
 * WHY IT IS HERE AND NOT IN `extraction/`. The other five sources are functions
 * of ONE file's text; this one is a function of the whole set of mentions the
 * index already holds. WP-2's route table assigns it `relation` /
 * `origin='derived'` / no owning document, and WP-2's own header says its
 * modules go from TEXT to DOMAIN VALUES — a fold over extraction OUTPUT is a
 * different animal, which is why the plan left it to index assembly.
 *
 * WHY IT IS INSIDE `graph/`. tech_spec Architecture point 3 splits this
 * deliberately in two: "ПРАВИЛО свёртки (кто с кем совстречается и что
 * считается ребром) — чистая функция в ядре; МАТЕРИАЛИЗАЦИЯ через GROUP BY — в
 * адаптере", and requires the first half to be runnable under `bun` with no
 * database. The rule is that first half. It imports nothing outward, so
 * prohibition (e) half 2 is satisfied and the folder stays liftable.
 *
 * WHERE THIS DEVIATES FROM THAT SPLIT, STATED RATHER THAN HIDDEN. The
 * materialization is NOT a `GROUP BY` inside the SQLite adapter: the caller
 * writes the folded relations through {@link NarrativeIndexWriter.putRelation}
 * inside the same transaction. A `GROUP BY` in the adapter would need a new
 * method on the store port — a change to WP-3's surface that WP-4a's readiness
 * block does not ask for — and it would exist ONLY in the SQLite adapter, so
 * the in-memory adapter would have to grow a hand-written twin and the
 * behaviour would be untestable in the fast lane. Going through `putRelation`
 * makes both adapters produce byte-identical rows from one body of code, which
 * is the property the two-adapter scheme exists to protect. The cost is that
 * the fold materializes the mention list in memory; it is already materialized
 * — a rebuild holds every extracted mention anyway — so this adds no new class
 * of allocation.
 *
 * THE NODE CAP DOES NOT LIVE HERE. `NARRATIVE_GRAPH_NODE_CAP = 20` trims what
 * Narrative Map DRAWS; tech_spec ОВ-1 keeps it out of the index because it is a
 * property of the presentation. So this fold emits every pair it finds, and the
 * widget adapter (WP-7) does the trimming.
 */

import { wholeFileEvidence, type EvidenceRef } from './evidence';
import type { NarrativeMention } from './narrative-mention';
import type { NarrativeRelation } from './narrative-relation';

/**
 * Relation type of a co-occurrence edge.
 *
 * An opaque string like every `relType` — nothing validates it against a
 * vocabulary, and the registry that eventually will is gh#57's.
 */
export const CO_OCCURRENCE_REL_TYPE = 'co-occurrence';

/** Code-point (SQLite `BINARY`) order — the one order both adapters can hold.
 *  See {@link foldCoOccurrenceRelations} on why order is asserted at all. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Joiner for the pair key.
 *
 * A NUL, because an entity id may legitimately contain a space or a colon and
 * a printable separator would let two different pairs collide into one key. It
 * is written AS AN ESCAPE and never as a literal control byte: a literal one
 * makes `grep` skip the file and `git` treat it as binary, and
 * `bun run check:control-bytes` refuses it outright.
 */
const PAIR_SEPARATOR = '\u0000';

/**
 * Fold mentions into co-occurrence relations.
 *
 * THE RULE, STATED SO IT CAN BE DISAGREED WITH:
 *
 *   1. Only RESOLVED mentions take part. tech_spec ОВ-1 fixes this as a
 *      property of the result — "у derived-рёбер `source_resolved`/
 *      `target_resolved` всегда 1: они строятся из УЖЕ СОПОСТАВЛЕННЫХ
 *      упоминаний". A broken reference names an entity that does not exist, so
 *      an edge to it would be a claim about a thing the manuscript never
 *      defined, and it would light up `relation_broken` — the mechanism built
 *      to surface REAL defects — on data that has no defect of that kind.
 *   2. The grouping unit is the DOCUMENT the mention was found in, which for
 *      mentions is always a chapter. Two entities co-occur when some chapter
 *      references both.
 *   3. The pair is UNORDERED, and is stored with its ends in code-point order.
 *      Co-occurrence has no direction; the port stores an ORDERED pair, so a
 *      convention is needed and an arbitrary one would make the same manuscript
 *      produce two different rows depending on which mention was read first.
 *   4. An entity does not co-occur with itself.
 *   5. Evidence is one `whole-file` ref PER SHARED DOCUMENT. That is what the
 *      edge is actually supported by: the fact is "these two appear in this
 *      chapter", which is a property of the chapter, not of any one span — and
 *      it means the WEIGHT of the edge is `evidence.length` rather than a bare
 *      counter beside it. A counter with no evidence behind it is the exact gap
 *      this epic exists to close.
 *
 * ORDER IS PART OF THE RESULT, and by code point rather than by locale. The
 * package promises that the same query over an unchanged manuscript returns the
 * same rows in the same order, and the SQLite adapter can only deliver that
 * with its default `BINARY` collation: `PRAGMA`-level ICU collations are not
 * available (`no such collation sequence: ru_RU`, measured on Node 24.9.0 /
 * SQLite 3.50.4) and registering one would need `DatabaseSync.function`, which
 * tech_spec ОВ-7 forbids by name.
 */
export function foldCoOccurrenceRelations(
  mentions: readonly NarrativeMention[]
): NarrativeRelation[] {
  /** entityId -> the documents that mention it. */
  const documentsByEntity = new Map<string, Set<string>>();
  /** documentPath -> the entities it mentions, so pairing is per document. */
  const entitiesByDocument = new Map<string, Set<string>>();

  for (const mention of mentions) {
    if (!mention.resolved) {
      continue;
    }
    const path = mention.evidence.path;
    const entities = entitiesByDocument.get(path) ?? new Set<string>();
    entities.add(mention.entityId);
    entitiesByDocument.set(path, entities);

    const documents = documentsByEntity.get(mention.entityId) ?? new Set<string>();
    documents.add(path);
    documentsByEntity.set(mention.entityId, documents);
  }

  /** `${source}\u0000${target}` -> the documents both appear in. */
  const sharedDocuments = new Map<string, Set<string>>();
  for (const [path, entities] of entitiesByDocument) {
    const ids = [...entities].sort(byCodePoint);
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const key = `${ids[i]}${PAIR_SEPARATOR}${ids[j]}`;
        const documents = sharedDocuments.get(key) ?? new Set<string>();
        documents.add(path);
        sharedDocuments.set(key, documents);
      }
    }
  }

  const relations: NarrativeRelation[] = [];
  for (const [key, documents] of sharedDocuments) {
    const [sourceId, targetId] = key.split(PAIR_SEPARATOR) as [string, string];
    const evidence: EvidenceRef[] = [...documents]
      .sort(byCodePoint)
      .map(path => wholeFileEvidence(path));
    relations.push({
      sourceId,
      targetId,
      relType: CO_OCCURRENCE_REL_TYPE,
      origin: 'derived',
      // No `ownerPath`: a derived edge belongs to no card, which is the ONE
      // case `CHECK (origin = 'derived' OR doc_id IS NOT NULL)` permits.
      sourceResolved: true,
      targetResolved: true,
      evidence
    });
  }

  return relations.sort(
    (left, right) =>
      byCodePoint(left.sourceId, right.sourceId) || byCodePoint(left.targetId, right.targetId)
  );
}
