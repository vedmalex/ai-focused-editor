/**
 * The in-memory adapter of {@link NarrativeIndexStore} (TASK-022 WP-3).
 *
 * WHAT IT IS FOR, STATED BEFORE WHAT IT DOES. `bun` cannot resolve
 * `node:sqlite`, so the repository's main test run can never touch the real
 * store. This adapter exists so that the SHARED contract — the part of the
 * store's behaviour that is a decision rather than an SQLite feature — is
 * executed on every `bun test`, and so that the contract core has something to
 * run against in the fast lane. It is a second implementation of a port,
 * which is exactly the situation where two implementations drift apart; the
 * contract core in `narrative-index-store-contract.ts` is the only thing
 * standing against that, and it is run against BOTH.
 *
 * WHAT IT DOES NOT PROVE, AND THIS LIST IS THE HONEST PART:
 *
 *   - It does not prove the DDL. Every `CHECK`, every `STRICT` column, every
 *     partial index and every `ON DELETE CASCADE` is absent here; the
 *     invariants below are hand-written guards that MIRROR them. A guard that
 *     agrees with a schema it cannot see is a guard that agrees until someone
 *     edits the schema — which is why the schema teeth are node-only and assert
 *     that SQLITE did the rejecting.
 *   - It does not prove durability, WAL, the writer lock, corruption recovery,
 *     or anything about a second process. Nothing here survives the process.
 *   - It does not prove SQL semantics: collation, ordering, or the behaviour of
 *     `COALESCE` in the identity index are approximated in TypeScript.
 *
 * So a green `bun test` says the CONTRACT holds. It says nothing about SQLite.
 * That is the whole reason the node run exists and is wired into `verify`.
 */

import type {
  DocumentMoveFreshness,
  DuplicateEntityRecord,
  EntityQuery,
  IndexedDocument,
  IndexedDocumentInput,
  MentionQuery,
  NarrativeEntity,
  NarrativeIndexStore,
  NarrativeIndexStoreLifecycle,
  NarrativeIndexWriter,
  NarrativeMention,
  NarrativeRelation,
  NeighbourhoodQuery,
  RelationQuery
} from './graph';
import { NarrativeIndexStoreError, orderMentionsByChapter } from './graph';

/** Options an in-memory store accepts. Deliberately tiny — every knob here is
 *  a knob the SQLite adapter would have to grow too. */
export interface InMemoryNarrativeIndexStoreOptions {
  /** Start the instance read-only, to exercise the refusal path without a
   *  second process. This is the ONLY way this adapter can reach that state. */
  readOnly?: boolean;
}

interface RelationRow {
  relationId: number;
  relation: NarrativeRelation;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/**
 * The structural invariants, in one place.
 *
 * They MIRROR the DDL's `CHECK` constraints one-for-one, and the mirroring is
 * the point: the contract core asserts that a forbidden value is REJECTED, and
 * both adapters must therefore reject it. What the two adapters do NOT share is
 * WHO rejects — here it is this function, in SQLite it is the schema, and only
 * the latter survives a repair script or a second implementation.
 */
function assertRelationInvariants(relation: NarrativeRelation): void {
  if (relation.origin !== 'derived' && relation.ownerPath === undefined) {
    throw new NarrativeIndexStoreError(
      'constraint-violation',
      `relation ${relation.sourceId}->${relation.targetId} has origin '${relation.origin}' but no owning document; ` +
        'only derived relations may be ownerless (CHECK (origin = \'derived\' OR doc_id IS NOT NULL))'
    );
  }
  if (relation.evidence.length === 0) {
    throw new NarrativeIndexStoreError(
      'constraint-violation',
      `relation ${relation.sourceId}->${relation.targetId} carries no evidence`
    );
  }
  for (const evidence of relation.evidence) {
    const hasRange = evidence.range !== undefined;
    if ((evidence.evidenceKind === 'range') !== hasRange) {
      throw new NarrativeIndexStoreError(
        'constraint-violation',
        `relation evidence declares evidenceKind '${evidence.evidenceKind}' but ` +
          `${hasRange ? 'carries' : 'carries no'} coordinates ` +
          '(CHECK ((evidence_kind = \'range\') = (start_line IS NOT NULL)))'
      );
    }
  }
}

function assertMentionInvariants(mention: NarrativeMention): void {
  const hasRange = mention.evidence.range !== undefined;
  if ((mention.evidence.evidenceKind === 'range') !== hasRange) {
    throw new NarrativeIndexStoreError(
      'constraint-violation',
      `mention of ${mention.entityId} declares evidenceKind '${mention.evidence.evidenceKind}' but ` +
        `${hasRange ? 'carries' : 'carries no'} coordinates ` +
        '(CHECK ((evidence_kind = \'range\') = (start_line IS NOT NULL)))'
    );
  }
  if (mention.labelRange !== undefined && mention.evidence.evidenceKind !== 'range') {
    throw new NarrativeIndexStoreError(
      'constraint-violation',
      `mention of ${mention.entityId} carries a label range on a '${mention.evidence.evidenceKind}' evidence ` +
        '(CHECK (label_start_line IS NULL OR evidence_kind = \'range\'))'
    );
  }
}

/**
 * Identity of a relation: ordered ends, type, origin, owning document and
 * POSITION IN THE LIST IT CAME FROM.
 *
 * This is the TypeScript reading of `relation_identity`, the unique index over
 * `(source_id, target_id, rel_type, origin, COALESCE(doc_id, -1),
 * COALESCE(list_position, -1))`. The joiner is a NUL written AS AN ESCAPE and
 * never as a literal control byte: a literal one makes `grep` skip the file
 * silently and `git` treat it as binary, which has already happened three times
 * in this task. The absent owner and the absent position each get their own
 * sentinel, so a relation with neither cannot collide with one whose owning
 * document is literally named after the separator.
 *
 * THE POSITION TERM IS v3 (UR-031) AND IT IS NOT COSMETIC. Two `ownership:`
 * entries naming the SAME owner differ in NOTHING else this key looks at, so
 * without it the second one resolves onto the first and overwrites its
 * story-time labels and its note.
 */
const IDENTITY_SEPARATOR = '\u0000';
const NO_OWNER = '\u0001no-owner';
const NO_LIST_POSITION = '\u0001no-position';

/**
 * Order two strings the way SQLite's default `BINARY` collation does.
 *
 * NOT `localeCompare`, and the difference is not cosmetic: `localeCompare`
 * folds case and applies language rules, so `'Б' < 'а'` under BINARY and the
 * other way round under a Russian locale. Anything whose order this package
 * PROMISES has to be sorted this way, or the in-memory adapter and the SQLite
 * adapter return the same rows in different orders and only the node run
 * notices. Code-unit comparison and UTF-8 byte comparison agree for every
 * character outside the astral planes, which is every character a workspace
 * path realistically holds.
 */
function compareByCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * A relation with its evidence in a DEFINED order (TASK-022 WP-4a).
 *
 * READ-SIDE, NOT WRITE-SIDE, and deliberately: the SQLite adapter is forbidden
 * from normalizing on write (a repaired value would move enforcement out of the
 * schema), so the only place the two adapters can agree is here. SQLite reaches
 * the same order with `ORDER BY re.relation_id, d.rel_path, re.start_line,
 * re.start_char`; this adapter would otherwise return whatever order the
 * PRODUCER wrote, which is a different thing that merely LOOKS the same until a
 * producer writes out of order — and WP-4b's incremental update, which appends
 * one evidence row to an existing co-occurrence edge, is exactly such a
 * producer.
 */
function withOrderedEvidence(relation: NarrativeRelation): NarrativeRelation {
  return {
    ...relation,
    evidence: [...relation.evidence].sort(
      (left, right) =>
        compareByCodePoint(left.path, right.path) ||
        (left.range?.start.line ?? -1) - (right.range?.start.line ?? -1) ||
        (left.range?.start.character ?? -1) - (right.range?.start.character ?? -1)
    )
  };
}

function relationIdentity(relation: NarrativeRelation): string {
  return [
    relation.sourceId,
    relation.targetId,
    relation.relType,
    relation.origin,
    relation.ownerPath ?? NO_OWNER,
    // `?? `, not a truthiness test: position `0` is the FIRST entry of an
    // `ownership:` list, which is the commonest value there is, and folding it
    // onto the sentinel would make the first and the positionless case collide.
    relation.listPosition ?? NO_LIST_POSITION
  ].join(IDENTITY_SEPARATOR);
}

export class InMemoryNarrativeIndexStore implements NarrativeIndexStore {
  private generation = 0;
  private readOnly: boolean;
  private closed = false;
  private nextDocId = 1;
  private nextRelationId = 1;

  private documents = new Map<string, IndexedDocument>();
  private entities = new Map<string, NarrativeEntity>();
  private duplicates = new Map<string, Set<string>>();
  private mentions: NarrativeMention[] = [];
  private relations: RelationRow[] = [];

  constructor(options: InMemoryNarrativeIndexStoreOptions = {}) {
    this.readOnly = options.readOnly === true;
  }

  lifecycle(): NarrativeIndexStoreLifecycle {
    return {
      generation: this.generation,
      readOnly: this.readOnly,
      // Nothing in memory can be corrupt, and saying so is more honest than
      // wiring a flag that could never be set.
      corrupted: false,
      foreignWriter: false
    };
  }

  transaction<T>(body: (writer: NarrativeIndexWriter) => T): T {
    this.assertOpen();
    if (this.readOnly) {
      throw new NarrativeIndexStoreError('read-only', 'this index store instance may not write');
    }
    // A snapshot rollback, so a throwing body leaves nothing half-applied. The
    // SQLite adapter gets the same property from ROLLBACK; the contract core
    // asserts it against both, which is the only reason it is worth the copy.
    const snapshot = {
      documents: new Map(this.documents),
      entities: new Map(this.entities),
      duplicates: new Map([...this.duplicates].map(([id, paths]) => [id, new Set(paths)])),
      mentions: [...this.mentions],
      relations: [...this.relations],
      nextDocId: this.nextDocId,
      nextRelationId: this.nextRelationId
    };
    const committedGeneration = this.generation + 1;
    try {
      const result = body(this.makeWriter(committedGeneration));
      this.generation = committedGeneration;
      return result;
    } catch (error) {
      this.documents = snapshot.documents;
      this.entities = snapshot.entities;
      this.duplicates = snapshot.duplicates;
      this.mentions = snapshot.mentions;
      this.relations = snapshot.relations;
      this.nextDocId = snapshot.nextDocId;
      this.nextRelationId = snapshot.nextRelationId;
      throw error;
    }
  }

  resetForRebuild(): void {
    this.assertOpen();
    if (this.readOnly) {
      throw new NarrativeIndexStoreError('read-only', 'this index store instance may not write');
    }
    this.documents = new Map();
    this.entities = new Map();
    this.duplicates = new Map();
    this.mentions = [];
    this.relations = [];
    this.nextDocId = 1;
    this.nextRelationId = 1;
  }

  close(): void {
    this.closed = true;
  }

  // ---- reads ------------------------------------------------------------

  getDocument(relPath: string): IndexedDocument | undefined {
    const found = this.documents.get(relPath);
    return found ? clone(found) : undefined;
  }

  /**
   * Every document, ordered by `relPath`, CODE POINT ascending (ISS-349).
   *
   * It used to be `localeCompare`, which disagrees with the SQLite adapter's
   * `ORDER BY rel_path` for every mixed-case Cyrillic pair — `Ярость` before
   * `арджуна` under `BINARY`, the reverse under a Russian locale. No contract
   * case noticed, because every fixture happened to use paths the two orders
   * agree about; the `entities/Ярость.yaml` vs `entities/арджуна.yaml` pair in
   * the contract core exists so that is no longer true.
   */
  listDocuments(): IndexedDocument[] {
    return [...this.documents.values()].map(clone).sort((a, b) => compareByCodePoint(a.relPath, b.relPath));
  }

  getEntity(entityId: string): NarrativeEntity | undefined {
    const found = this.entities.get(entityId);
    return found ? clone(found) : undefined;
  }

  findEntities(query: EntityQuery = {}): NarrativeEntity[] {
    const prefix = query.namePrefix?.toLowerCase();
    const matches = [...this.entities.values()].filter(entity => {
      if (query.type !== undefined && entity.type !== query.type) {
        return false;
      }
      if (query.origin !== undefined && entity.origin !== query.origin) {
        return false;
      }
      if (prefix !== undefined && prefix.length > 0) {
        const names = [entity.name, ...entity.aliases];
        if (!names.some(name => name.toLowerCase().startsWith(prefix))) {
          return false;
        }
      }
      return true;
    });
    // Ordered by `id`, CODE POINT ascending — matching the SQLite adapter's
    // `ORDER BY e.entity_id` (ISS-349, same reason as `listDocuments`). The cap
    // is applied AFTER sorting in both adapters, so `limit` returns the same
    // rows and not merely the same number of them.
    matches.sort((a, b) => compareByCodePoint(a.id, b.id));
    const limited = query.limit === undefined ? matches : matches.slice(0, query.limit);
    return limited.map(clone);
  }

  getMentions(query: MentionQuery = {}): NarrativeMention[] {
    const matches = this.mentions.filter(mention => {
      if (query.entityId !== undefined && mention.entityId !== query.entityId) {
        return false;
      }
      if (query.relPath !== undefined && mention.evidence.path !== query.relPath) {
        return false;
      }
      if (query.brokenOnly === true && mention.resolved) {
        return false;
      }
      return true;
    });
    // gh#47. Without `orderBy` this stays insertion order — the behaviour every
    // caller before this option relied on, and changing it unasked would have
    // rewritten the meaning of results nothing here can see.
    const ordered =
      query.orderBy === 'chapter'
        ? orderMentionsByChapter(matches, query.direction ?? 'asc', relPath => this.documents.get(relPath))
        : matches;
    // AFTER ordering, per `MentionQuery.limit` — the ISS-349 rule that a cap
    // must select the same ROWS in both adapters, not merely the same count.
    const limited = query.limit === undefined ? ordered : ordered.slice(0, query.limit);
    return limited.map(clone);
  }

  getRelations(query: RelationQuery = {}): NarrativeRelation[] {
    return this.relations
      .filter(row => matchesRelationQuery(row.relation, query))
      .map(row => withOrderedEvidence(clone(row.relation)));
  }

  neighbourhood(query: NeighbourhoodQuery): NarrativeRelation[] {
    const seenEntities = new Set([query.entityId]);
    let frontier = [query.entityId];
    const collected: NarrativeRelation[] = [];
    const collectedKeys = new Set<string>();
    for (let hop = 0; hop < query.depth; hop++) {
      const nextFrontier: string[] = [];
      for (const entityId of frontier) {
        for (const row of this.relations) {
          const relation = row.relation;
          if (relation.sourceId !== entityId && relation.targetId !== entityId) {
            continue;
          }
          if (query.relTypes !== undefined && !query.relTypes.includes(relation.relType)) {
            continue;
          }
          if (query.origins !== undefined && !query.origins.includes(relation.origin)) {
            continue;
          }
          const key = `${row.relationId}`;
          if (!collectedKeys.has(key)) {
            collectedKeys.add(key);
            collected.push(withOrderedEvidence(clone(relation)));
          }
          for (const end of [relation.sourceId, relation.targetId]) {
            if (!seenEntities.has(end)) {
              seenEntities.add(end);
              nextFrontier.push(end);
            }
          }
        }
      }
      frontier = nextFrontier;
      if (frontier.length === 0) {
        break;
      }
    }
    return query.limit === undefined ? collected : collected.slice(0, query.limit);
  }

  /**
   * The collisions, each naming the definition in effect.
   *
   * THE WINNER IS LOOKED UP, NOT STORED BESIDE THE LOSERS — the entity map is
   * keyed by id, so the card that owns the entity IS the winner and there is no
   * second copy to fall out of step. This mirrors the SQLite adapter's join
   * through `entity.doc_id`.
   *
   * A COLLISION WITH NO WINNER IS A THROW HERE, NOT A SKIP, and the difference
   * is worth the words. In SQLite that state is unrepresentable — the foreign
   * key from `entity_duplicate.entity_id` refuses to create it and cascades to
   * remove it — so this adapter's only equivalent of the engine is its own
   * write path: `putDuplicateEntity` refuses an id no entity defines, and
   * `deleteDocument` drops the duplicates of an entity it deletes. If the map
   * holds one anyway, one of those two is broken. Returning the collision
   * QUIETLY MINUS its winner would hide exactly the bug the field exists to
   * expose — and it would make the cascade untestable, because a test that
   * deletes the winning card cannot tell "cascaded" from "still there but
   * filtered out of the answer".
   *
   * ORDER IS BY CODE POINT, not by locale: SQLite sorts these with its default
   * `BINARY` collation, and `localeCompare` would put Cyrillic paths in a
   * different order than the node run sees.
   */
  getDuplicateEntities(): DuplicateEntityRecord[] {
    const records: DuplicateEntityRecord[] = [];
    for (const [entityId, excluded] of this.duplicates) {
      const kept = this.entities.get(entityId);
      if (kept === undefined) {
        throw new NarrativeIndexStoreError(
          'constraint-violation',
          `entity '${entityId}' has duplicate cards recorded (${[...excluded].join(', ')}) but no card defines it; ` +
            'the entity/duplicate cascade is broken ' +
            '(FOREIGN KEY entity_duplicate.entity_id REFERENCES entity(entity_id) ON DELETE CASCADE)'
        );
      }
      records.push({
        entityId,
        keptRelPath: kept.sourcePath,
        excludedRelPaths: [...excluded].sort(compareByCodePoint)
      });
    }
    return records.sort((a, b) => compareByCodePoint(a.entityId, b.entityId));
  }

  // ---- writes -----------------------------------------------------------

  private makeWriter(committedGeneration: number): NarrativeIndexWriter {
    const requireDocument = (relPath: string, what: string): void => {
      if (!this.documents.has(relPath)) {
        throw new NarrativeIndexStoreError(
          'constraint-violation',
          `${what} refers to document '${relPath}', which is not indexed (FOREIGN KEY document(doc_id))`
        );
      }
    };
    return {
      putDocument: (input: IndexedDocumentInput): number => {
        const existing = this.documents.get(input.relPath);
        const docId = existing?.docId ?? this.nextDocId++;
        this.documents.set(input.relPath, {
          ...clone(input),
          manifestIncluded: input.manifestIncluded ?? true,
          docId,
          generation: committedGeneration
        });
        return docId;
      },
      /**
       * Re-key a document, keeping its `docId` (TASK-022 WP-4b, ОВ-3 step 5).
       *
       * IT REWRITES MORE THAN THE SQLITE ADAPTER DOES, AND THE ASYMMETRY IS
       * REAL. There, `rel_path` lives in exactly one table and every consumer
       * joins to it, so a single `UPDATE` moves the whole document. Here, paths
       * are DENORMALIZED onto every row — `mention.evidence.path`,
       * `relation.ownerPath`, each evidence ref, `entity.sourcePath`, the
       * duplicate sets — because this adapter has no joins. So the same move has
       * to touch all of them, and the contract core is what proves the two ended
       * up in the same state.
       *
       * (The SQLite side is not free of this either: `entity.payload` carries a
       * denormalized `sourcePath` inside its JSON, so it has one row to repair
       * too. tech_spec ОВ-3's "строки entity не трогаются вообще" is true of the
       * FOREIGN KEYS and not of that column.)
       */
      moveDocument: (from: string, to: string, freshness: DocumentMoveFreshness): void => {
        const document = this.documents.get(from);
        if (document === undefined) {
          throw new NarrativeIndexStoreError(
            'constraint-violation',
            `cannot move document '${from}': it is not indexed`
          );
        }
        if (this.documents.has(to)) {
          throw new NarrativeIndexStoreError(
            'constraint-violation',
            `cannot move document '${from}' onto '${to}': the destination is already indexed ` +
              '(UNIQUE(rel_path))'
          );
        }
        this.documents.delete(from);
        this.documents.set(to, {
          ...document,
          relPath: to,
          sizeBytes: freshness.sizeBytes,
          mtimeMs: freshness.mtimeMs,
          contentHash: freshness.contentHash,
          indexedAt: freshness.indexedAt,
          ...(freshness.chapterOrder !== undefined
            ? { chapterOrder: freshness.chapterOrder }
            : { chapterOrder: undefined }),
          // The SAME explicit clear as `chapterOrder`, and for the same reason:
          // both are manifest-derived and both belong to the NEW path. Spreading
          // the old row without this would leave a chapter renamed OUT of the
          // manifest still carrying the heading the manifest no longer gives it
          // — the one failure a `?? old` would look identical to.
          ...(freshness.title !== undefined
            ? { title: freshness.title }
            : { title: undefined }),
          manifestIncluded: freshness.manifestIncluded ?? true,
          generation: committedGeneration
        });
        for (const entity of this.entities.values()) {
          if (entity.sourcePath === from) {
            entity.sourcePath = to;
          }
        }
        for (const paths of this.duplicates.values()) {
          if (paths.delete(from)) {
            paths.add(to);
          }
        }
        this.mentions = this.mentions.map(mention =>
          mention.evidence.path === from
            ? { ...mention, evidence: { ...mention.evidence, path: to } }
            : mention
        );
        for (const row of this.relations) {
          const relation = row.relation;
          if (relation.ownerPath === from) {
            relation.ownerPath = to;
          }
          relation.evidence = relation.evidence.map(evidence =>
            evidence.path === from ? { ...evidence, path: to } : evidence
          );
        }
      },
      clearDocumentContent: (relPath: string): void => {
        this.mentions = this.mentions.filter(mention => mention.evidence.path !== relPath);
        this.relations = this.relations.filter(row => row.relation.ownerPath !== relPath);
      },
      clearDerivedRelations: (): void => {
        this.relations = this.relations.filter(row => row.relation.origin !== 'derived');
      },
      deleteDocument: (relPath: string): void => {
        if (!this.documents.delete(relPath)) {
          return;
        }
        for (const [entityId, entity] of [...this.entities]) {
          if (entity.sourcePath === relPath) {
            this.entities.delete(entityId);
            // MIRRORS `entity_duplicate.entity_id REFERENCES entity(entity_id)
            // ON DELETE CASCADE`. Losing the card that WON ends the collision
            // outright rather than leaving a finding whose winner is gone: a
            // losing card that is now the only definition of its id is not a
            // duplicate, it is the definition.
            this.duplicates.delete(entityId);
          }
        }
        for (const [entityId, paths] of [...this.duplicates]) {
          paths.delete(relPath);
          if (paths.size === 0) {
            this.duplicates.delete(entityId);
          }
        }
        this.mentions = this.mentions.filter(mention => mention.evidence.path !== relPath);
        this.relations = this.relations.filter(row => row.relation.ownerPath !== relPath);
      },
      putEntity: (entity: NarrativeEntity): void => {
        requireDocument(entity.sourcePath, `entity '${entity.id}'`);
        if (this.duplicates.get(entity.id)?.has(entity.sourcePath) === true) {
          throw new NarrativeIndexStoreError(
            'constraint-violation',
            `entity '${entity.id}' is owned by '${entity.sourcePath}', which is already recorded as an EXCLUDED ` +
              'definition of that id; one card cannot both win and lose the same collision ' +
              '(TRIGGER entity_insert_is_not_an_excluded_card)'
          );
        }
        this.entities.set(entity.id, clone(entity));
      },
      putDuplicateEntity: (entityId: string, excludedRelPath: string): void => {
        requireDocument(excludedRelPath, `duplicate of entity '${entityId}'`);
        // The two refusals the port names, mirrored from the schema: the first
        // is a FOREIGN KEY there, the second a TRIGGER. They are what let
        // `DuplicateEntityRecord.keptRelPath` be a required field.
        const kept = this.entities.get(entityId);
        if (kept === undefined) {
          throw new NarrativeIndexStoreError(
            'constraint-violation',
            `duplicate of entity '${entityId}' at '${excludedRelPath}' has no card to have lost TO: ` +
              'no entity row defines that id ' +
              '(FOREIGN KEY entity_duplicate.entity_id REFERENCES entity(entity_id))'
          );
        }
        if (kept.sourcePath === excludedRelPath) {
          throw new NarrativeIndexStoreError(
            'constraint-violation',
            `'${excludedRelPath}' is the card that OWNS entity '${entityId}', so it cannot also be excluded ` +
              'from that id (TRIGGER entity_duplicate_excludes_the_kept_card)'
          );
        }
        const paths = this.duplicates.get(entityId) ?? new Set<string>();
        paths.add(excludedRelPath);
        this.duplicates.set(entityId, paths);
      },
      putMention: (mention: NarrativeMention): void => {
        assertMentionInvariants(mention);
        requireDocument(mention.evidence.path, `mention of '${mention.entityId}'`);
        this.mentions.push(clone(mention));
      },
      putRelation: (relation: NarrativeRelation): number => {
        assertRelationInvariants(relation);
        if (relation.ownerPath !== undefined) {
          requireDocument(relation.ownerPath, `relation '${relation.sourceId}->${relation.targetId}'`);
        }
        const identity = relationIdentity(relation);
        const existing = this.relations.find(row => relationIdentity(row.relation) === identity);
        if (existing) {
          existing.relation = clone(relation);
          return existing.relationId;
        }
        const relationId = this.nextRelationId++;
        this.relations.push({ relationId, relation: clone(relation) });
        return relationId;
      },
      clearAll: (): void => {
        this.entities = new Map();
        this.duplicates = new Map();
        this.mentions = [];
        this.relations = [];
      }
    };
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new NarrativeIndexStoreError('storage-unavailable', 'index store is closed');
    }
  }
}

function matchesRelationQuery(relation: NarrativeRelation, query: RelationQuery): boolean {
  if (query.relType !== undefined && relation.relType !== query.relType) {
    return false;
  }
  if (query.origin !== undefined && relation.origin !== query.origin) {
    return false;
  }
  if (query.relPath !== undefined && relation.ownerPath !== query.relPath) {
    return false;
  }
  if (query.brokenOnly === true && relation.sourceResolved && relation.targetResolved) {
    return false;
  }
  if (query.entityId !== undefined) {
    const direction = query.direction ?? 'either';
    const matchesSource = relation.sourceId === query.entityId;
    const matchesTarget = relation.targetId === query.entityId;
    if (direction === 'outgoing' && !matchesSource) {
      return false;
    }
    if (direction === 'incoming' && !matchesTarget) {
      return false;
    }
    if (direction === 'either' && !matchesSource && !matchesTarget) {
      return false;
    }
  }
  return true;
}
