/**
 * Where a piece of narrative knowledge CAME FROM (TASK-022 WP-1, UR-012 /
 * UR-026).
 *
 * The same three values apply to entity cards and to relations. That is not a
 * convenience: UR-026 says the agent proposes the BULK of the relations and the
 * author edits them, so `ai-candidate` is a NORMAL operating mode, not an edge
 * case, and an entity and a relation proposed by the same pass must be
 * describable by the same word.
 *
 * THE UNION IS CLOSED, AND THAT IS THE POINT. A fourth member is not a member
 * anyone may add locally: `origin` is the column the SQLite schema guards with
 * `CHECK (origin = 'derived' OR doc_id IS NOT NULL)` (tech_spec ОВ-1), so a new
 * value is a schema decision with a `user_version` bump behind it. Code that
 * finds itself needing a value this union does not have has found a FINDING,
 * not a missing member.
 */

/**
 * Provenance of an entity card or a relation.
 *
 * - `explicit`     — the author wrote it. The manuscript files are the truth.
 * - `derived`      — computed from other indexed facts (co-occurrence edges are
 *                    the standing example) and reproducible by a rebuild. It is
 *                    the ONLY origin allowed to have no owning document.
 * - `ai-candidate` — proposed by an agent and not yet accepted by the author.
 *                    It still lives in the SOURCE FILES, never only in the
 *                    database: the database is a fully rebuildable cache, so a
 *                    decision recorded solely there would be erased by the
 *                    first rebuild.
 */
export type NarrativeOrigin = 'explicit' | 'derived' | 'ai-candidate';

/**
 * Every member of {@link NarrativeOrigin}, as data.
 *
 * A test that walks the union needs it at runtime; the `satisfies` below keeps
 * this array and the type from drifting in EITHER direction — a member added to
 * the type but not here fails to satisfy, and a value here that is not in the
 * type fails to assign.
 */
export const NARRATIVE_ORIGINS = ['explicit', 'derived', 'ai-candidate'] as const satisfies readonly NarrativeOrigin[];

/**
 * What a card with no `origin` field means.
 *
 * Every entity card written before this feature existed is such a card, and
 * every one of them is something the author wrote. Reading them as anything
 * else would relabel the entire existing corpus as machine-proposed.
 */
export const DEFAULT_NARRATIVE_ORIGIN: NarrativeOrigin = 'explicit';
